//! Preparing an agent session: everything needed to start a CLI for one
//! project, adapter, model and profile, computed without touching the disk
//! or the process table. The terminal host spawns the plan in a PTY; a
//! headless host can spawn the same plan with pipes.

use crate::adapters::{
    AdapterConfig, AdapterSpec, GuideChannel, McpInjection, BRIDGE_ENV, SERVER_NAME,
};
use crate::guide;
use bureau_contracts::{ContractError, Profile};
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
    /// One prompt and no terminal, continuing the conversation an earlier
    /// headless run of the same adapter left under `conversation_id`.
    HeadlessResume { conversation_id: &'a str },
}

impl LaunchMode<'_> {
    /// Whether the CLI runs one prompt without a terminal.
    pub fn headless(self) -> bool {
        matches!(self, Self::Headless | Self::HeadlessResume { .. })
    }
}

/// Everything a launch depends on.
#[derive(Debug, Clone, Copy)]
pub struct LaunchRequest<'a> {
    pub adapter: &'a AdapterSpec,
    pub config: &'a AdapterConfig,
    /// The CLI to run.
    pub executable: &'a Path,
    /// The `bureau` helper the CLI starts as its MCP server.
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
    /// What the project held when the launch was prepared, for the brief.
    /// `None` when it was not read: the brief then says nothing about the
    /// project, and the agent starts with project_summary. Its `resumed`
    /// is set here, from whether the plan resumes a conversation.
    pub snapshot: Option<&'a guide::Snapshot>,
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
    /// True when the plan continues an earlier conversation of the CLI.
    pub resumed: bool,
}

/// Inherited variables with this prefix belong to another Bureau session
/// and must not leak into this one.
pub const SCRUBBED_PREFIX: &str = "BUREAU_";

/// The session's work folder inside the project.
pub fn work_dir(project_root: &Path, session_id: &str) -> PathBuf {
    project_root.join(".bureau/work").join(session_id)
}

/// Plan a launch. Pure: the same request always gives the same plan.
pub fn plan_launch(request: &LaunchRequest<'_>) -> Result<LaunchPlan, ContractError> {
    let adapter = request.adapter;
    let work = work_dir(request.project_root, request.session_id);
    let helper = request.helper.to_string_lossy().into_owned();
    // A headless CLI told not to keep its sessions has none to resume later, and none of its
    // earlier runs left one: it starts fresh.
    let persists = !(request.mode.headless()
        && request
            .config
            .args
            .iter()
            .any(|arg| arg == "--no-session-persistence"));
    let wanted = match request.mode {
        LaunchMode::Resume { conversation_id } => Some(conversation_id),
        LaunchMode::HeadlessResume { conversation_id } if persists => Some(conversation_id),
        _ => None,
    };
    // The brief says what the agent read before may be out of date only when the CLI really
    // continues a conversation: a terminal "Start again" or a conversation turn's resume.
    let snapshot = request.snapshot.map(|snapshot| guide::Snapshot {
        resumed: adapter.resume.is_some() && wanted.is_some(),
        ..snapshot.clone()
    });
    let guidance = guide::launch_guidance(
        request.profile,
        request.project_name,
        request.project_root,
        snapshot.as_ref(),
    );
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
                !BRIDGE_ENV.contains(&key.as_str()) && !key.starts_with("BUREAU_BRIDGE_")
            })
            .cloned(),
    );
    let mut files = Vec::new();
    let guide_file = work.join("guide.md");

    let headless = match (request.mode.headless(), adapter.headless) {
        (true, Some(headless)) => Some(headless),
        (true, None) => return Err(no_headless_mode(adapter)),
        (false, _) => None,
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

    let (conversation_id, resumed) = match (adapter.resume, wanted, request.mode) {
        (Some(_), Some(id), _) if !plain_id(id) => {
            return Err(ContractError::validation(
                "The conversation to resume has an id no CLI would give",
            )
            .with_repair("Start a new session instead."))
        }
        (Some(resume), Some(id), _) => {
            args.extend([resume.resume.to_owned(), id.to_owned()]);
            (Some(id.to_owned()), true)
        }
        (None, _, LaunchMode::Resume { .. } | LaunchMode::HeadlessResume { .. }) => {
            return Err(ContractError::validation(format!(
                "{} cannot resume a conversation",
                adapter.label
            ))
            .with_repair("Start a new session instead."))
        }
        (Some(resume), None, _) => {
            args.extend([resume.assign.to_owned(), request.session_id.to_owned()]);
            (persists.then(|| request.session_id.to_owned()), false)
        }
        (None, _, _) => (None, false),
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
        resumed,
    })
}

/// An id a CLI may be resumed by. It becomes the argument after `--resume`, and a record file
/// that holds it can be written by anything that writes the project folder, so it is checked
/// where it is read and again here, where it is used.
pub(crate) fn plain_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Whether the CLI receives the launch guidance (the session brief) through
/// one of its channels. A CLI reached only through MCP instructions or the
/// project's `AGENTS.md` gets no brief, so nothing is read for one.
pub(crate) fn carries_brief(adapter: &AdapterSpec) -> bool {
    adapter.guidance.iter().any(|channel| {
        matches!(
            channel,
            GuideChannel::SystemPromptFile(_)
                | GuideChannel::SystemPromptText(_)
                | GuideChannel::DeveloperInstructions
                | GuideChannel::InstructionsFile
        )
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
    /// works in the person's environment; see `bureau_core::child_env`.
    pub fn apply_environment(
        &self,
        inherited: impl IntoIterator<Item = (String, String)>,
        mut set: impl FnMut(&str, &str),
        mut remove: impl FnMut(&str),
    ) {
        let inherited: Vec<(String, String)> = inherited.into_iter().collect();
        let outside_appimage = bureau_core::child_env::edits_in(&inherited);
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
    const WORK: &str = "/projects/rover/.bureau/work/6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b";

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
            helper: Path::new("/Applications/Bureau.app/Contents/Resources/bureau"),
            project_id: "project-1",
            project_name: "Sable rover",
            project_root: Path::new("/projects/rover"),
            session_id: SESSION,
            socket_path: "/data/run/bridge.sock",
            token: "secret-token",
            profile,
            path: "/Applications/Bureau.app/Contents/Resources:/usr/bin",
            mode,
            snapshot: None,
        })
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const BRIDGE_VALUES: [(&str, &str); 4] = [
        ("BUREAU_BRIDGE_SOCK", "/data/run/bridge.sock"),
        ("BUREAU_BRIDGE_TOKEN", "secret-token"),
        ("BUREAU_PROJECT_ID", "project-1"),
        ("BUREAU_SESSION_ID", SESSION),
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
                "/Applications/Bureau.app/Contents/Resources:/usr/bin",
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
            None,
        );
        assert_eq!(plan.guidance, guidance);
        assert_eq!(
            plan.args,
            strings(&[
                "-c",
                "mcp_servers.bureau.command=\"/Applications/Bureau.app/Contents/Resources/bureau\"",
                "-c",
                "mcp_servers.bureau.args=[\"mcp\"]",
                "-c",
                "mcp_servers.bureau.env_vars=[\"BUREAU_BRIDGE_SOCK\",\"BUREAU_BRIDGE_TOKEN\",\"BUREAU_PROJECT_ID\",\"BUREAU_SESSION_ID\"]",
                "-c",
                "mcp_servers.bureau.default_tools_approval_mode=\"approve\"",
                "-c",
                "mcp_servers.bureau.startup_timeout_sec=20",
                "-c",
                "mcp_servers.bureau.tool_timeout_sec=330",
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
                "mcp__bureau",
                "--append-system-prompt-file",
                &format!("{WORK}/guide.md"),
                "--model",
                "haiku",
                "--session-id",
                SESSION,
            ])
        );
        assert_eq!(plan.conversation_id.as_deref(), Some(SESSION));
        assert!(!plan.resumed);
        let mut env = base_env();
        env.push(("ANTHROPIC_BASE_URL", "http://localhost:4000"));
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&plan), env);
        assert_eq!(plan.files.len(), 2);
        assert_eq!(plan.files[0].path, Path::new(WORK).join("mcp.json"));
        assert_eq!(
            plan.files[0].contents,
            "{\"mcpServers\":{\"bureau\":{\"type\":\"stdio\",\"command\":\"/Applications/Bureau.app/Contents/Resources/bureau\",\"args\":[\"mcp\"],\"env\":{\"BUREAU_BRIDGE_SOCK\":\"/data/run/bridge.sock\",\"BUREAU_BRIDGE_TOKEN\":\"secret-token\",\"BUREAU_PROJECT_ID\":\"project-1\",\"BUREAU_SESSION_ID\":\"6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b\"},\"timeout\":600000,\"alwaysLoad\":true}}}"
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
        assert!(plan.resumed);
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
    fn claude_headless_resume_continues_by_id_without_a_new_session_id() {
        let earlier = "11111111-2222-4333-8444-555555555555";
        let resume = LaunchMode::HeadlessResume {
            conversation_id: earlier,
        };
        let resumed = plan(
            "claude-code",
            json!({"model": "claude-haiku-5-5"}),
            Profile::Compact,
            resume,
        );
        assert_eq!(resumed.args[0], "-p");
        let at = resumed
            .args
            .iter()
            .position(|arg| arg == "--resume")
            .unwrap();
        assert_eq!(resumed.args[at + 1], earlier);
        // The CLI refuses --session-id with --resume unless it forks the conversation.
        assert!(!resumed.args.contains(&"--session-id".to_owned()));
        assert_eq!(
            resumed.args[resumed.args.len() - 6..],
            strings(&[
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-mode",
                "dontAsk"
            ])
        );
        assert_eq!(resumed.conversation_id.as_deref(), Some(earlier));
        assert!(resumed.resumed);
        assert!(LaunchMode::Headless.headless() && resume.headless());
        assert!(!LaunchMode::Interactive.headless());

        let error = try_plan("codex", json!({}), Profile::Standard, resume).unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(error.message.ends_with("cannot resume a conversation"));
        for id in ["opencode", "gemini", "qwen", "custom"] {
            let error = try_plan(id, json!({}), Profile::Standard, resume).unwrap_err();
            assert!(
                error
                    .message
                    .ends_with("has no headless mode in this build"),
                "{id}"
            );
        }

        // A CLI told not to keep sessions has none to resume: it starts fresh, and its run
        // leaves nothing to resume later either.
        let fresh = plan(
            "claude-code",
            json!({"args": ["--no-session-persistence"]}),
            Profile::Compact,
            resume,
        );
        let at = fresh
            .args
            .iter()
            .position(|arg| arg == "--session-id")
            .unwrap();
        assert_eq!(fresh.args[at + 1], SESSION);
        assert!(!fresh.args.contains(&"--resume".to_owned()));
        assert!(!fresh.resumed);
        assert_eq!(fresh.conversation_id, None);
        let headless = plan(
            "claude-code",
            json!({"args": ["--no-session-persistence"]}),
            Profile::Compact,
            LaunchMode::Headless,
        );
        assert_eq!(headless.conversation_id, None);
    }

    #[test]
    fn a_resume_id_that_could_be_read_as_a_flag_is_refused() {
        let long = "a".repeat(129);
        for bad in [
            "--settings={\"env\":{\"INJECTED\":\"1\"}}",
            "--dangerously-skip-permissions",
            "-x",
            "",
            "a b",
            "a=b",
            long.as_str(),
        ] {
            for mode in [
                LaunchMode::Resume {
                    conversation_id: bad,
                },
                LaunchMode::HeadlessResume {
                    conversation_id: bad,
                },
            ] {
                let error =
                    try_plan("claude-code", json!({}), Profile::Standard, mode).expect_err(bad);
                assert_eq!(error.code, "VALIDATION", "{bad:?}");
                assert_eq!(
                    error.message,
                    "The conversation to resume has an id no CLI would give"
                );
            }
        }
        assert!(plain_id("11111111-2222-4333-8444-555555555555"));
        assert!(plain_id(&"a".repeat(128)));
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
            headless.args[1..headless.args.len() - 6],
            interactive.args[..]
        );
        assert_eq!(
            headless.args[headless.args.len() - 6..],
            strings(&[
                "--output-format",
                "stream-json",
                "--include-partial-messages",
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
            "{\"$schema\":\"https://opencode.ai/config.json\",\"mcp\":{\"bureau\":{\"type\":\"local\",\"command\":[\"/Applications/Bureau.app/Contents/Resources/bureau\",\"mcp\"],\"environment\":{\"BUREAU_BRIDGE_SOCK\":\"{env:BUREAU_BRIDGE_SOCK}\",\"BUREAU_BRIDGE_TOKEN\":\"{env:BUREAU_BRIDGE_TOKEN}\",\"BUREAU_PROJECT_ID\":\"{env:BUREAU_PROJECT_ID}\",\"BUREAU_SESSION_ID\":\"{env:BUREAU_SESSION_ID}\"},\"enabled\":true,\"timeout\":330000}},\"instructions\":[\"/projects/rover/.bureau/work/6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b/guide.md\"],\"permission\":{\"bureau_*\":\"allow\"}}",
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
            strings(&["--allowed-mcp-server-names", "bureau", "-m", "flash-lite"])
        );
        let mut env = base_env();
        let settings = format!("{WORK}/gemini.json");
        env.push(("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", &settings));
        env.extend(BRIDGE_VALUES);
        assert_eq!(env_of(&gemini), env);
        assert_eq!(gemini.files.len(), 1);
        assert_eq!(
            gemini.files[0].contents,
            "{\"mcpServers\":{\"bureau\":{\"command\":\"/Applications/Bureau.app/Contents/Resources/bureau\",\"args\":[\"mcp\"],\"env\":{\"BUREAU_BRIDGE_SOCK\":\"$BUREAU_BRIDGE_SOCK\",\"BUREAU_BRIDGE_TOKEN\":\"$BUREAU_BRIDGE_TOKEN\",\"BUREAU_PROJECT_ID\":\"$BUREAU_PROJECT_ID\",\"BUREAU_SESSION_ID\":\"$BUREAU_SESSION_ID\"},\"timeout\":600000,\"trust\":true}},\"context\":{\"fileName\":[\"GEMINI.md\",\"AGENTS.md\"]}}"
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
                "BUREAU_BRIDGE_TOKEN": "forged",
                "BUREAU_BRIDGE_EXTRA": "forged",
                "BUREAU_SESSION_ID": "forged"
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
        assert!(plan.guidance.contains("Profile: compact (15 tools listed)"));

        let off = plan_with_env("custom", json!({"BUREAU_AGENTS_MD": "off"}));
        assert!(!off.agents_md);
        assert!(off
            .env
            .contains(&("BUREAU_AGENTS_MD".to_owned(), "off".to_owned())));
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
                guide::launch_guidance(profile, "Sable rover", Path::new("/projects/rover"), None);
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

    /// A brief says what the agent read before may be out of date exactly
    /// when the CLI continues a conversation: a terminal resume, or a
    /// conversation turn that resumes Claude Code's conversation. A run that
    /// starts fresh, kept sessions or not, says when it started.
    #[test]
    fn a_resumed_conversation_s_brief_says_it_continues_one() {
        let earlier = "11111111-2222-4333-8444-555555555555";
        let snapshot = guide::Snapshot {
            intent: Some("Rover parts".into()),
            ..guide::Snapshot::default()
        };
        let continues = "This session continues an earlier conversation; what you read then may be out of date.";
        let brief = |args: Value, mode: LaunchMode<'_>| {
            let plan = plan_launch(&LaunchRequest {
                adapter: adapter("claude-code").unwrap(),
                config: &AdapterConfig::from_value(&json!({"args": args})),
                executable: Path::new("/usr/local/bin/claude"),
                helper: Path::new("/Applications/Bureau.app/Contents/Resources/bureau"),
                project_id: "project-1",
                project_name: "Sable rover",
                project_root: Path::new("/projects/rover"),
                session_id: SESSION,
                socket_path: "/data/run/bridge.sock",
                token: "secret-token",
                profile: Profile::Compact,
                path: "/usr/bin",
                mode,
                snapshot: Some(&snapshot),
            })
            .unwrap();
            let file = plan
                .files
                .iter()
                .find(|file| file.path.ends_with("guide.md"))
                .unwrap();
            assert_eq!(file.contents, plan.guidance);
            (plan.resumed, plan.guidance)
        };
        for mode in [
            LaunchMode::Resume {
                conversation_id: earlier,
            },
            LaunchMode::HeadlessResume {
                conversation_id: earlier,
            },
        ] {
            let (resumed, guidance) = brief(json!([]), mode);
            assert!(resumed, "{mode:?}");
            assert!(guidance.contains(continues), "{mode:?}");
        }
        for (args, mode) in [
            (json!([]), LaunchMode::Interactive),
            (json!([]), LaunchMode::Headless),
            (
                json!(["--no-session-persistence"]),
                LaunchMode::HeadlessResume {
                    conversation_id: earlier,
                },
            ),
        ] {
            let (resumed, guidance) = brief(args, mode);
            assert!(!resumed, "{mode:?}");
            assert!(!guidance.contains(continues), "{mode:?}");
            assert!(guidance.contains("When this session started the project was empty"));
        }
    }

    /// The snapshot rides in the brief, and only CLIs that are given the
    /// brief are said to carry it, so the host reads it only for them.
    #[test]
    fn a_snapshot_reaches_the_brief_in_every_channel_that_carries_one() {
        let snapshot = guide::Snapshot {
            intent: Some("Rover parts".into()),
            ..guide::Snapshot::default()
        };
        for spec in &crate::adapters::ADAPTERS {
            let plan = plan_launch(&LaunchRequest {
                adapter: spec,
                config: &AdapterConfig::default(),
                executable: Path::new("/usr/local/bin/agent"),
                helper: Path::new("/Applications/Bureau.app/Contents/Resources/bureau"),
                project_id: "project-1",
                project_name: "Sable rover",
                project_root: Path::new("/projects/rover"),
                session_id: SESSION,
                socket_path: "/data/run/bridge.sock",
                token: "secret-token",
                profile: Profile::Compact,
                path: "/usr/bin",
                mode: LaunchMode::Interactive,
                snapshot: Some(&snapshot),
            })
            .unwrap();
            assert!(plan.guidance.contains(&snapshot.text()), "{}", spec.id);
            let delivered = plan
                .args
                .iter()
                .any(|arg| arg.contains("## Project at launch"))
                || plan
                    .files
                    .iter()
                    .any(|file| file.contents.contains("## Project at launch"));
            assert_eq!(carries_brief(spec), delivered, "{}", spec.id);
        }
        for (id, carries) in [
            ("codex", true),
            ("claude-code", true),
            ("opencode", true),
            ("qwen", true),
            ("gemini", false),
            ("custom", false),
        ] {
            assert_eq!(carries_brief(adapter(id).unwrap()), carries, "{id}");
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
            ("BUREAU_BRIDGE_TOKEN".to_owned(), "stale".to_owned()),
            ("BUREAU_APP_DATA_DIR".to_owned(), "/elsewhere".to_owned()),
        ];
        let mut set = Vec::new();
        let mut removed = Vec::new();
        plan.apply_environment(
            inherited,
            |key, value| set.push((key.to_owned(), value.to_owned())),
            |key| removed.push(key.to_owned()),
        );
        assert_eq!(removed, ["BUREAU_BRIDGE_TOKEN", "BUREAU_APP_DATA_DIR"]);
        assert_eq!(set[0], ("LANG".to_owned(), "en_US.UTF-8".to_owned()));
        let last_lang = set.iter().rev().find(|(key, _)| key == "LANG").unwrap();
        assert_eq!(
            last_lang.1, "de_DE.UTF-8",
            "configured values win over the default"
        );
        assert_eq!(set.last().unwrap().0, "BUREAU_SESSION_ID");

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
        let image = "/tmp/.mount_Bureauq3xK2b";
        let inherited = vec![
            ("APPDIR".to_owned(), image.to_owned()),
            ("APPIMAGE".to_owned(), "/home/me/Bureau.AppImage".to_owned()),
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
            path.1, "/Applications/Bureau.app/Contents/Resources:/usr/bin",
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
