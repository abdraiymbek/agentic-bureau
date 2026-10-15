//! Preparing an agent session: everything needed to start a CLI for one
//! project, adapter, model and profile, computed without touching the disk
//! or the process table. The terminal host spawns the plan in a PTY; a
//! headless host can spawn the same plan with pipes.

use crate::adapters::{
    AdapterConfig, AdapterSpec, GuideChannel, McpInjection, BRIDGE_ENV, SERVER_NAME,
};
use crate::guide;
use omenflow_contracts::{ContractError, Profile};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// How the CLI is run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode<'a> {
    /// In a terminal, for a person to talk to.
    Interactive,
    /// In a terminal, continuing the conversation an earlier session of the
    /// same adapter started under `conversation_id`.
    Resume { conversation_id: &'a str },
    /// One prompt and no terminal. The caller writes the prompt to the
    /// process's standard input and closes it.
    Headless,
}

/// Everything a launch depends on.
#[derive(Debug, Clone, Copy)]
pub struct LaunchRequest<'a> {
    pub adapter: &'a AdapterSpec,
    pub config: &'a AdapterConfig,
    /// The CLI to run.
    pub executable: &'a Path,
    /// The `omenflow` helper the CLI starts as its MCP server.
    pub helper: &'a Path,
    pub project_id: &'a str,
    pub project_name: &'a str,
    pub project_root: &'a Path,
    pub session_id: &'a str,
    pub socket_path: &'a str,
    pub token: &'a str,
    pub profile: Profile,
    /// PATH for the CLI, with the helper's folder first.
    pub path: &'a str,
    pub mode: LaunchMode<'a>,
}

/// A file the session needs on disk before the CLI starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub path: PathBuf,
    pub contents: String,
}

/// A complete launch: run `executable` with `args` in `cwd`, after writing
/// `files` and applying the environment with `apply_environment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub executable: PathBuf,
    pub args: Vec<String>,
    /// Variables to set, in order; later entries win.
    pub env: Vec<(String, String)>,
    /// Variables to set only when the inherited environment lacks them.
    pub env_defaults: Vec<(String, String)>,
    pub cwd: PathBuf,
    /// Written with owner-only permissions and removed when the session ends.
    pub files: Vec<PlannedFile>,
    /// The guidance this launch delivers through the CLI's own channel.
    pub guidance: String,
    /// Whether the project's `AGENTS.md` carries the bounded block for this
    /// session, because the CLI has no other guidance channel.
    pub agents_md: bool,
    /// The id under which the CLI keeps this conversation, when it can be
    /// resumed by id later.
    pub conversation_id: Option<String>,
}

/// Inherited variables with this prefix belong to another Omen Flow session
/// and must not leak into this one.
pub const SCRUBBED_PREFIX: &str = "OMENFLOW_";

/// The session's work folder inside the project.
pub fn work_dir(project_root: &Path, session_id: &str) -> PathBuf {
    project_root.join(".omenflow/work").join(session_id)
}

/// Plan a launch. Pure: the same request always gives the same plan.
pub fn plan_launch(request: &LaunchRequest<'_>) -> Result<LaunchPlan, ContractError> {
    let adapter = request.adapter;
    let work = work_dir(request.project_root, request.session_id);
    let helper = request.helper.to_string_lossy().into_owned();
    let guidance =
        guide::launch_guidance(request.profile, request.project_name, request.project_root);
    let bridge = [
        request.socket_path,
        request.token,
        request.project_id,
        request.session_id,
    ];
    let mut args = Vec::new();
    let mut env = vec![
        ("PATH".to_owned(), request.path.to_owned()),
        ("TERM".to_owned(), "xterm-256color".to_owned()),
        ("COLORTERM".to_owned(), "truecolor".to_owned()),
    ];
    // What the person configured, except the session's own credentials.
    env.extend(
        request
            .config
            .env
            .iter()
            .filter(|(key, _)| {
                !BRIDGE_ENV.contains(&key.as_str()) && !key.starts_with("OMENFLOW_BRIDGE_")
            })
            .cloned(),
    );
    let mut files = Vec::new();
    let guide_file = work.join("guide.md");

    let headless = match (request.mode, adapter.headless) {
        (LaunchMode::Headless, Some(headless)) => Some(headless),
        (LaunchMode::Headless, None) => return Err(no_headless_mode(adapter)),
        _ => None,
    };
    if let Some(headless) = headless {
        args.extend(headless.leading.iter().map(|arg| arg.to_string()));
    }

    match adapter.mcp {
        McpInjection::CodexOverrides => {
            let server = format!("mcp_servers.{SERVER_NAME}");
            for value in [
                format!("{server}.command={}", toml_string(&helper)),
                format!("{server}.args=[\"mcp\"]"),
                format!(
                    "{server}.env_vars=[{}]",
                    BRIDGE_ENV.map(|name| format!("\"{name}\"")).join(",")
                ),
                format!("{server}.default_tools_approval_mode=\"approve\""),
                format!(
                    "{server}.startup_timeout_sec={}",
                    adapter.startup_timeout.as_secs()
                ),
                format!(
                    "{server}.tool_timeout_sec={}",
                    adapter.tool_timeout.as_secs()
                ),
            ] {
                args.extend(["-c".to_owned(), value]);
            }
        }
        McpInjection::ClaudeConfigFile => {
            let config = work.join("mcp.json");
            files.push(PlannedFile {
                path: config.clone(),
                contents: json!({"mcpServers": {SERVER_NAME: {
                    "type": "stdio",
                    "command": helper,
                    "args": ["mcp"],
                    "env": bridge_object(|index| bridge[index].to_owned()),
                    "timeout": adapter.tool_timeout.as_millis() as u64,
                    "alwaysLoad": true,
                }}})
                .to_string(),
            });
            args.extend(["--mcp-config".to_owned(), path_text(&config)]);
        }
        McpInjection::SettingsFile {
            variable,
            file,
            context_files,
        } => {
            let settings = work.join(file);
            let mut document = json!({"mcpServers": {SERVER_NAME: {
                "command": helper,
                "args": ["mcp"],
                // These CLIs redact variables that look like secrets unless
                // the server entry names them.
                "env": bridge_object(|index| format!("${}", BRIDGE_ENV[index])),
                "timeout": adapter.tool_timeout.as_millis() as u64,
                "trust": true,
            }}});
            if !context_files.is_empty() {
                document["context"] = json!({"fileName": context_files});
            }
            files.push(PlannedFile {
                path: settings.clone(),
                contents: document.to_string(),
            });
            env.push((variable.to_owned(), path_text(&settings)));
        }
        McpInjection::InlineConfig { variable } => {
            let document = json!({
                "$schema": "https://opencode.ai/config.json",
                "mcp": {SERVER_NAME: {
                    "type": "local",
                    "command": [helper, "mcp"],
                    "environment": bridge_object(|index| format!("{{env:{}}}", BRIDGE_ENV[index])),
                    "enabled": true,
                    "timeout": adapter.tool_timeout.as_millis() as u64,
                }},
                "instructions": [path_text(&guide_file)],
                "permission": {format!("{SERVER_NAME}_*"): "allow"},
            });
            env.push((variable.to_owned(), document.to_string()));
        }
        McpInjection::EnvironmentOnly => {}
    }
    args.extend(adapter.launch_args.iter().map(|arg| arg.to_string()));

    for channel in adapter.guidance {
        match channel {
            GuideChannel::SystemPromptFile(flag) => {
                args.extend([flag.to_string(), path_text(&guide_file)]);
            }
            GuideChannel::SystemPromptText(flag) => {
                args.extend([flag.to_string(), guidance.clone()]);
            }
            GuideChannel::DeveloperInstructions => {
                args.extend([
                    "-c".to_owned(),
                    format!("developer_instructions={}", toml_string(&guidance)),
                ]);
            }
            GuideChannel::McpInstructions
            | GuideChannel::InstructionsFile
            | GuideChannel::AgentsMd => {}
        }
    }
    let needs_guide_file = adapter.guidance.iter().any(|channel| {
        matches!(
            channel,
            GuideChannel::SystemPromptFile(_) | GuideChannel::InstructionsFile
        )
    });
    if needs_guide_file {
        files.push(PlannedFile {
            path: guide_file,
            contents: guidance.clone(),
        });
    }

    if let (Some(flag), Some(model)) = (adapter.model_flag, request.config.model.as_deref()) {
        let local = adapter
            .local_providers
            .iter()
            .find_map(|(prefix, provider)| Some((model.strip_prefix(prefix)?, provider)));
        match local {
            Some((name, provider)) => {
                args.extend(provider.iter().map(|arg| arg.to_string()));
                args.extend([flag.to_owned(), name.to_owned()]);
            }
            None => args.extend([flag.to_owned(), model.to_owned()]),
        }
    }

    let conversation_id = match (adapter.resume, request.mode) {
        (Some(resume), LaunchMode::Resume { conversation_id }) => {
            args.extend([resume.resume.to_owned(), conversation_id.to_owned()]);
            Some(conversation_id.to_owned())
        }
        (Some(resume), _) => {
            args.extend([resume.assign.to_owned(), request.session_id.to_owned()]);
            Some(request.session_id.to_owned())
        }
        (None, LaunchMode::Resume { .. }) => {
            return Err(ContractError::validation(format!(
                "{} cannot resume a conversation",
                adapter.label
            ))
            .with_repair("Start a new session instead."))
        }
        (None, _) => None,
    };

    args.extend(request.config.args.iter().cloned());
    if let Some(headless) = headless {
        args.extend(headless.trailing.iter().map(|arg| arg.to_string()));
    }
    env.extend(
        BRIDGE_ENV
            .iter()
            .zip(bridge)
            .map(|(name, value)| (name.to_string(), value.to_owned())),
    );

    Ok(LaunchPlan {
        executable: request.executable.to_owned(),
        args,
        env,
        env_defaults: vec![("LANG".to_owned(), "en_US.UTF-8".to_owned())],
        cwd: request.project_root.to_owned(),
        files,
        guidance,
        agents_md: adapter.writes_agents_md(request.config),
        conversation_id,
    })
}

/// The refusal for a headless run of a CLI that has no headless mode.
pub(crate) fn no_headless_mode(adapter: &AdapterSpec) -> ContractError {
    ContractError::validation(format!(
        "{} has no headless mode in this build",
        adapter.label
    ))
    .with_repair("Run it in a terminal session, or use Codex CLI or Claude Code.")
}

fn bridge_object(value: impl Fn(usize) -> String) -> Value {
    Value::Object(
        BRIDGE_ENV
            .iter()
            .enumerate()
            .map(|(index, name)| (name.to_string(), json!(value(index))))
            .collect::<Map<_, _>>(),
    )
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A TOML basic string. JSON string escapes are a subset of TOML's, so the
/// JSON encoding is the TOML encoding.
fn toml_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

impl LaunchPlan {
    /// Write the session's files, readable by the owner only: one of them
    /// can hold the session token.
    pub fn write_files(&self) -> io::Result<()> {
        for file in &self.files {
            if let Some(parent) = file.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut handle = options.open(&file.path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // `mode` only applies to a file this call created.
                handle.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            handle.write_all(file.contents.as_bytes())?;
        }
        Ok(())
    }

    /// Remove the session's files. Called when the session ends, however it
    /// ends; a file that is already gone is not an error.
    pub fn remove_files(&self) {
        for file in &self.files {
            let _ = fs::remove_file(&file.path);
        }
    }

    /// Apply the plan's environment to a process about to be spawned.
    /// `inherited` is the environment the process would otherwise get. When
    /// the app runs from an AppImage, the launcher's changes to it (its
    /// libraries, Python, GTK and data paths) are undone first, so the agent
    /// works in the person's environment; see `omenflow_core::child_env`.
    pub fn apply_environment(
        &self,
        inherited: impl IntoIterator<Item = (String, String)>,
        mut set: impl FnMut(&str, &str),
        mut remove: impl FnMut(&str),
    ) {
        let inherited: Vec<(String, String)> = inherited.into_iter().collect();
        let outside_appimage = omenflow_core::child_env::edits_in(&inherited);
        let mut present = Vec::new();
        for (key, _) in inherited {
            if key.starts_with(SCRUBBED_PREFIX) {
                remove(&key);
                continue;
            }
            match outside_appimage.iter().find(|(name, _)| *name == key) {
                Some((_, None)) => remove(&key),
                Some((_, Some(value))) => {
                    set(&key, value);
                    present.push(key);
                }
                None => present.push(key),
            }
        }
        for (key, value) in &self.env_defaults {
            if !present.contains(key) {
                set(key, value);
            }
        }
        for (key, value) in &self.env {
            set(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::adapter;

    const SESSION: &str = "6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b";
    const WORK: &str = "/projects/rover/.omenflow/work/6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b";

    fn plan(id: &str, config: Value, profile: Profile, mode: LaunchMode<'_>) -> LaunchPlan {
        try_plan(id, config, profile, mode).unwrap()
    }

    fn try_plan(
        id: &str,
        config: Value,
        profile: Profile,
        mode: LaunchMode<'_>,
    ) -> Result<LaunchPlan, ContractError> {
        plan_launch(&LaunchRequest {
            adapter: adapter(id).unwrap(),
            config: &AdapterConfig::from_value(&config),
            executable: Path::new("/usr/local/bin/agent"),
            helper: Path::new("/Applications/Omen Flow.app/Contents/Resources/omenflow"),
            project_id: "project-1",
            project_name: "Sable rover",
            project_root: Path::new("/projects/rover"),
            session_id: SESSION,
            socket_path: "/data/run/bridge.sock",
            token: "secret-token",
            profile,
            path: "/Applications/Omen Flow.app/Contents/Resources:/usr/bin",
            mode,
        })
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const BRIDGE_VALUES: [(&str, &str); 4] = [
        ("OMENFLOW_BRIDGE_SOCK", "/data/run/bridge.sock"),
        ("OMENFLOW_BRIDGE_TOKEN", "secret-token"),
        ("OMENFLOW_PROJECT_ID", "project-1"),
        ("OMENFLOW_SESSION_ID", SESSION),
    ];

    fn env_of(plan: &LaunchPlan) -> Vec<(&str, &str)> {
        plan.env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    fn base_env() -> Vec<(&'static str, &'static str)> {
        vec![
            (
                "PATH",
                "/Applications/Omen Flow.app/Contents/Resources:/usr/bin",
            ),
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
        ]
    }

    #[test]
    fn codex_plan_matches_the_verified_launch_line() {
        let plan = plan(
            "codex",
            json!({"model": "gpt-6-luna", "args": ["--no-daemon"]}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        let guidance = guide::launch_guidance(
            Profile::Compact,
            "Sable rover",
            Path::new("/projects/rover"),
        );
        assert_eq!(plan.guidance, guidance);
        assert_eq!(
            plan.args,
            strings(&[
                "-c",
                "mcp_servers.omenflow.command=\"/Applications/Omen Flow.app/Contents/Resources/omenflow\"",
                "-c",
                "mcp_servers.omenflow.args=[\"mcp\"]",
                "-c",
                "mcp_servers.omenflow.env_vars=[\"OMENFLOW_BRIDGE_SOCK\",\"OMENFLOW_BRIDGE_TOKEN\",\"OMENFLOW_PROJECT_ID\",\"OMENFLOW_SESSION_ID\"]",
                "-c",
                "mcp_servers.omenflow.default_tools_approval_mode=\"approve\"",
                "-c",
                "mcp_servers.omenflow.startup_timeout_sec=20",
                "-c",
                "mcp_servers.omenflow.tool_timeout_sec=330",
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "-c",
                &format!("developer_instructions={}", serde_json::to_string(&guidance).unwrap()),
                "-m",
                "gpt-6-luna",
                "--no-daemon",
            ])
        );
        let mut env = base_env();
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&plan), env);
        assert!(
            plan.files.is_empty(),
            "Codex needs no file: nothing secret reaches disk or argv"
        );
        assert!(plan.args.iter().all(|arg| !arg.contains("secret-token")));
        assert_eq!(plan.executable, Path::new("/usr/local/bin/agent"));
        assert_eq!(plan.cwd, Path::new("/projects/rover"));
        assert!(!plan.agents_md);
        assert_eq!(plan.conversation_id, None);
        assert_eq!(
            plan.env_defaults,
            [("LANG".to_owned(), "en_US.UTF-8".to_owned())]
        );
        // The instructions survive the TOML round trip as one basic string.
        let encoded = plan.args[17]
            .strip_prefix("developer_instructions=")
            .unwrap();
        assert!(!encoded.contains('\n'));
        assert_eq!(serde_json::from_str::<String>(encoded).unwrap(), guidance);
    }

    #[test]
    fn codex_local_models_select_the_provider() {
        let plan = plan(
            "codex",
            json!({"model": "ollama/qwen3:14b"}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        assert_eq!(
            plan.args[plan.args.len() - 5..],
            strings(&["--oss", "--local-provider", "ollama", "-m", "qwen3:14b"])
        );
        let none = plan_without_model("codex");
        assert!(!none.args.contains(&"-m".to_owned()));
    }

    fn plan_without_model(id: &str) -> LaunchPlan {
        plan(id, json!({}), Profile::Standard, LaunchMode::Interactive)
    }

    #[test]
    fn claude_plan_matches_the_verified_launch_line() {
        let plan = plan(
            "claude-code",
            json!({"model": "haiku", "env": {"ANTHROPIC_BASE_URL": "http://localhost:4000"}}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        assert_eq!(
            plan.args,
            strings(&[
                "--mcp-config",
                &format!("{WORK}/mcp.json"),
                "--allowedTools",
                "mcp__omenflow",
                "--append-system-prompt-file",
                &format!("{WORK}/guide.md"),
                "--model",
                "haiku",
                "--session-id",
                SESSION,
            ])
        );
        assert_eq!(plan.conversation_id.as_deref(), Some(SESSION));
        let mut env = base_env();
        env.push(("ANTHROPIC_BASE_URL", "http://localhost:4000"));
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&plan), env);
        assert_eq!(plan.files.len(), 2);
        assert_eq!(plan.files[0].path, Path::new(WORK).join("mcp.json"));
        assert_eq!(
            plan.files[0].contents,
            "{\"mcpServers\":{\"omenflow\":{\"type\":\"stdio\",\"command\":\"/Applications/Omen Flow.app/Contents/Resources/omenflow\",\"args\":[\"mcp\"],\"env\":{\"OMENFLOW_BRIDGE_SOCK\":\"/data/run/bridge.sock\",\"OMENFLOW_BRIDGE_TOKEN\":\"secret-token\",\"OMENFLOW_PROJECT_ID\":\"project-1\",\"OMENFLOW_SESSION_ID\":\"6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b\"},\"timeout\":600000,\"alwaysLoad\":true}}}"
        );
        assert_eq!(plan.files[1].path, Path::new(WORK).join("guide.md"));
        assert_eq!(plan.files[1].contents, plan.guidance);
        assert!(plan.args.iter().all(|arg| !arg.contains("secret-token")));
        assert!(!plan.agents_md);
    }

    #[test]
    fn claude_resumes_by_the_id_it_was_given() {
        let earlier = "11111111-2222-4333-8444-555555555555";
        let plan = plan(
            "claude-code",
            json!({}),
            Profile::Standard,
            LaunchMode::Resume {
                conversation_id: earlier,
            },
        );
        assert_eq!(
            plan.args[plan.args.len() - 2..],
            strings(&["--resume", earlier])
        );
        assert!(!plan.args.contains(&"--session-id".to_owned()));
        assert_eq!(plan.conversation_id.as_deref(), Some(earlier));
        // The new session still gets its own token, files and guidance.
        assert_eq!(plan.files[0].path, Path::new(WORK).join("mcp.json"));

        for id in ["codex", "opencode", "gemini", "qwen", "custom"] {
            let error = try_plan(
                id,
                json!({}),
                Profile::Standard,
                LaunchMode::Resume {
                    conversation_id: earlier,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, "VALIDATION", "{id}");
            assert!(error.message.ends_with("cannot resume a conversation"));
        }
    }

    #[test]
    fn headless_plans_carry_the_same_wiring_and_read_the_prompt_from_stdin() {
        let interactive = plan(
            "codex",
            json!({"model": "gpt-6-luna"}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        let headless = plan(
            "codex",
            json!({"model": "gpt-6-luna"}),
            Profile::Compact,
            LaunchMode::Headless,
        );
        assert_eq!(
            headless.args[..3],
            strings(&["exec", "--json", "--skip-git-repo-check"])
        );
        assert_eq!(
            headless.args[3..headless.args.len() - 1],
            interactive.args[..]
        );
        assert_eq!(headless.args.last().map(String::as_str), Some("-"));
        assert_eq!(headless.env, interactive.env);

        let interactive = plan(
            "claude-code",
            json!({"model": "opus"}),
            Profile::Full,
            LaunchMode::Interactive,
        );
        let headless = plan(
            "claude-code",
            json!({"model": "opus"}),
            Profile::Full,
            LaunchMode::Headless,
        );
        assert_eq!(headless.args[0], "-p");
        assert_eq!(
            headless.args[1..headless.args.len() - 5],
            interactive.args[..]
        );
        assert_eq!(
            headless.args[headless.args.len() - 5..],
            strings(&[
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "dontAsk"
            ])
        );
        assert_eq!(headless.files, interactive.files);

        for id in ["opencode", "gemini", "qwen", "custom"] {
            let error =
                try_plan(id, json!({}), Profile::Standard, LaunchMode::Headless).unwrap_err();
            assert!(
                error
                    .message
                    .ends_with("has no headless mode in this build"),
                "{id}"
            );
        }
    }

    #[test]
    fn opencode_plan_follows_its_documentation() {
        let plan = plan(
            "opencode",
            json!({"model": "ollama/qwen2.5-coder:14b"}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        assert_eq!(plan.args, strings(&["-m", "ollama/qwen2.5-coder:14b"]));
        let mut env = base_env();
        env.push((
            "OPENCODE_CONFIG_CONTENT",
            "{\"$schema\":\"https://opencode.ai/config.json\",\"mcp\":{\"omenflow\":{\"type\":\"local\",\"command\":[\"/Applications/Omen Flow.app/Contents/Resources/omenflow\",\"mcp\"],\"environment\":{\"OMENFLOW_BRIDGE_SOCK\":\"{env:OMENFLOW_BRIDGE_SOCK}\",\"OMENFLOW_BRIDGE_TOKEN\":\"{env:OMENFLOW_BRIDGE_TOKEN}\",\"OMENFLOW_PROJECT_ID\":\"{env:OMENFLOW_PROJECT_ID}\",\"OMENFLOW_SESSION_ID\":\"{env:OMENFLOW_SESSION_ID}\"},\"enabled\":true,\"timeout\":330000}},\"instructions\":[\"/projects/rover/.omenflow/work/6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b/guide.md\"],\"permission\":{\"omenflow_*\":\"allow\"}}",
        ));
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&plan), env);
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].path, Path::new(WORK).join("guide.md"));
        assert!(!plan.files[0].contents.contains("secret-token"));
    }

    #[test]
    fn gemini_and_qwen_plans_follow_their_documentation() {
        let gemini = plan(
            "gemini",
            json!({"model": "flash-lite"}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        assert_eq!(
            gemini.args,
            strings(&["--allowed-mcp-server-names", "omenflow", "-m", "flash-lite"])
        );
        let mut env = base_env();
        let settings = format!("{WORK}/gemini.json");
        env.push(("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", &settings));
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&gemini), env);
        assert_eq!(gemini.files.len(), 1);
        assert_eq!(
            gemini.files[0].contents,
            "{\"mcpServers\":{\"omenflow\":{\"command\":\"/Applications/Omen Flow.app/Contents/Resources/omenflow\",\"args\":[\"mcp\"],\"env\":{\"OMENFLOW_BRIDGE_SOCK\":\"$OMENFLOW_BRIDGE_SOCK\",\"OMENFLOW_BRIDGE_TOKEN\":\"$OMENFLOW_BRIDGE_TOKEN\",\"OMENFLOW_PROJECT_ID\":\"$OMENFLOW_PROJECT_ID\",\"OMENFLOW_SESSION_ID\":\"$OMENFLOW_SESSION_ID\"},\"timeout\":600000,\"trust\":true}},\"context\":{\"fileName\":[\"GEMINI.md\",\"AGENTS.md\"]}}"
        );

        let qwen = plan(
            "qwen",
            json!({"model": "qwen3-coder"}),
            Profile::Standard,
            LaunchMode::Interactive,
        );
        assert_eq!(
            qwen.args,
            strings(&[
                "--append-system-prompt",
                &qwen.guidance,
                "-m",
                "qwen3-coder"
            ])
        );
        assert_eq!(qwen.files.len(), 1);
        assert_eq!(qwen.files[0].path, Path::new(WORK).join("qwen.json"));
        assert!(!qwen.files[0].contents.contains("context"));
        assert!(qwen.env.contains(&(
            "QWEN_CODE_SYSTEM_DEFAULTS_PATH".to_owned(),
            format!("{WORK}/qwen.json")
        )));
        for plan in [&gemini, &qwen] {
            assert!(!plan.files[0].contents.contains("secret-token"));
            assert!(!plan.agents_md);
        }
    }

    #[test]
    fn a_custom_cli_gets_only_the_environment_and_the_optional_block() {
        let plan = plan(
            "custom",
            json!({"args": ["--flag"], "model": "local-model", "env": {
                "MY_KEY": "1",
                "OMENFLOW_BRIDGE_TOKEN": "forged",
                "OMENFLOW_BRIDGE_EXTRA": "forged",
                "OMENFLOW_SESSION_ID": "forged"
            }}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        assert_eq!(plan.args, strings(&["--flag"]));
        let mut env = base_env();
        env.push(("MY_KEY", "1"));
        env.extend(BRIDGE_VALUES);
        assert_eq!(
            env_of(&plan),
            env,
            "configured env cannot replace the session's credentials"
        );
        assert!(plan.files.is_empty());
        assert!(plan.agents_md);
        assert!(plan.guidance.contains("Profile: compact (13 tools listed)"));

        let off = plan_with_env("custom", json!({"OMENFLOW_AGENTS_MD": "off"}));
        assert!(!off.agents_md);
        assert!(off
            .env
            .contains(&("OMENFLOW_AGENTS_MD".to_owned(), "off".to_owned())));
    }

    fn plan_with_env(id: &str, env: Value) -> LaunchPlan {
        plan(
            id,
            json!({"env": env}),
            Profile::Compact,
            LaunchMode::Interactive,
        )
    }

    #[test]
    fn guidance_follows_the_profile_in_every_channel() {
        for profile in Profile::ALL {
            let expected =
                guide::launch_guidance(profile, "Sable rover", Path::new("/projects/rover"));
            for id in [
                "codex",
                "claude-code",
                "opencode",
                "gemini",
                "qwen",
                "custom",
            ] {
                assert_eq!(
                    plan(id, json!({}), profile, LaunchMode::Interactive).guidance,
                    expected
                );
            }
        }
    }

    #[test]
    fn the_environment_is_scrubbed_defaulted_and_applied_in_order() {
        let plan = plan(
            "custom",
            json!({"env": {"LANG": "de_DE.UTF-8"}}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        let inherited = vec![
            ("HOME".to_owned(), "/Users/me".to_owned()),
            ("OMENFLOW_BRIDGE_TOKEN".to_owned(), "stale".to_owned()),
            ("OMENFLOW_APP_DATA_DIR".to_owned(), "/elsewhere".to_owned()),
        ];
        let mut set = Vec::new();
        let mut removed = Vec::new();
        plan.apply_environment(
            inherited,
            |key, value| set.push((key.to_owned(), value.to_owned())),
            |key| removed.push(key.to_owned()),
        );
        assert_eq!(removed, ["OMENFLOW_BRIDGE_TOKEN", "OMENFLOW_APP_DATA_DIR"]);
        assert_eq!(set[0], ("LANG".to_owned(), "en_US.UTF-8".to_owned()));
        let last_lang = set.iter().rev().find(|(key, _)| key == "LANG").unwrap();
        assert_eq!(
            last_lang.1, "de_DE.UTF-8",
            "configured values win over the default"
        );
        assert_eq!(set.last().unwrap().0, "OMENFLOW_SESSION_ID");

        let mut set = Vec::new();
        plan.apply_environment(
            vec![("LANG".to_owned(), "fr_FR.UTF-8".to_owned())],
            |key, _| set.push(key.to_owned()),
            |_| {},
        );
        assert_eq!(
            set.iter().filter(|key| *key == "LANG").count(),
            1,
            "an inherited LANG needs no default"
        );
    }

    #[test]
    fn an_agent_started_from_an_appimage_gets_the_session_environment() {
        let plan = plan(
            "custom",
            json!({}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        let image = "/tmp/.mount_OmenFlq3xK2b";
        let inherited = vec![
            ("APPDIR".to_owned(), image.to_owned()),
            (
                "APPIMAGE".to_owned(),
                "/home/me/Omen Flow.AppImage".to_owned(),
            ),
            ("HOME".to_owned(), "/home/me".to_owned()),
            ("LD_LIBRARY_PATH".to_owned(), format!("{image}/usr/lib/:")),
            ("PYTHONHOME".to_owned(), format!("{image}/usr/")),
            ("GDK_BACKEND".to_owned(), "x11".to_owned()),
            (
                "XDG_DATA_DIRS".to_owned(),
                format!("{image}/usr/share:/usr/share"),
            ),
            ("PATH".to_owned(), format!("{image}/usr/bin/:/usr/bin")),
        ];
        let mut set = Vec::new();
        let mut removed = Vec::new();
        plan.apply_environment(
            inherited,
            |key, value| set.push((key.to_owned(), value.to_owned())),
            |key| removed.push(key.to_owned()),
        );
        assert_eq!(
            removed,
            [
                "APPDIR",
                "APPIMAGE",
                "LD_LIBRARY_PATH",
                "PYTHONHOME",
                "GDK_BACKEND"
            ]
        );
        assert!(set.contains(&("XDG_DATA_DIRS".to_owned(), "/usr/share".to_owned())));
        assert!(set.contains(&("PATH".to_owned(), "/usr/bin".to_owned())));
        let path = set.iter().rev().find(|(key, _)| key == "PATH").unwrap();
        assert_eq!(
            path.1, "/Applications/Omen Flow.app/Contents/Resources:/usr/bin",
            "the plan's own PATH still wins"
        );
        assert!(!set.iter().any(|(key, _)| key == "HOME"));
    }

    #[cfg(unix)]
    #[test]
    fn session_files_are_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let mut plan = plan(
            "claude-code",
            json!({}),
            Profile::Compact,
            LaunchMode::Interactive,
        );
        for file in &mut plan.files {
            file.path = temp
                .path()
                .join("work/s")
                .join(file.path.file_name().unwrap());
        }
        // A file left world-readable by an earlier build is tightened too.
        fs::create_dir_all(temp.path().join("work/s")).unwrap();
        fs::write(&plan.files[0].path, "old").unwrap();
        fs::set_permissions(&plan.files[0].path, fs::Permissions::from_mode(0o644)).unwrap();
        plan.write_files().unwrap();
        for file in &plan.files {
            let mode = fs::metadata(&file.path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", file.path.display());
            assert_eq!(fs::read_to_string(&file.path).unwrap(), file.contents);
        }
        plan.remove_files();
        assert!(plan.files.iter().all(|file| !file.path.exists()));
        plan.remove_files();
    }
}
