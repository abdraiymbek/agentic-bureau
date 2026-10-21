//! The agent CLIs Omen Flow can host, as data: one definition per CLI saying
//! how to find it, how to hand it the Omen Flow MCP server, how its tools are
//! pre-approved, which channels carry guidance, and which models it offers.
//! Adding a CLI that uses an existing injection method is one more record.

use crate::profile::{profile_for_model, resolve_profile, ProfileSetting};
use omenflow_contracts::Profile;
use serde_json::{json, Value};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

/// Name of the MCP server in every CLI's configuration.
pub const SERVER_NAME: &str = "omenflow";

/// The four variables that carry a session's bridge credentials.
pub const BRIDGE_ENV: [&str; 4] = [
    "OMENFLOW_BRIDGE_SOCK",
    "OMENFLOW_BRIDGE_TOKEN",
    "OMENFLOW_PROJECT_ID",
    "OMENFLOW_SESSION_ID",
];

/// How a CLI is told about the Omen Flow MCP server for one session, without
/// touching the person's own configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpInjection {
    /// Codex: repeated `-c mcp_servers.omenflow.<key>=<toml>` overrides. The
    /// credentials are forwarded by name, never placed in arguments.
    CodexOverrides,
    /// Claude Code: `--mcp-config <file>` naming a JSON file in the session's
    /// work folder.
    ClaudeConfigFile,
    /// Gemini CLI lineage: an environment variable names a settings file
    /// that is layered under the person's own settings.
    SettingsFile {
        variable: &'static str,
        file: &'static str,
        /// Context file names the settings ask the CLI to load.
        context_files: &'static [&'static str],
    },
    /// OpenCode: the whole configuration inline in one environment variable.
    InlineConfig { variable: &'static str },
    /// No injection: the CLI inherits the bridge variables and finds the
    /// `omenflow` helper on its PATH.
    EnvironmentOnly,
}

/// A channel through which guidance reaches the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuideChannel {
    /// MCP `initialize.instructions`.
    McpInstructions,
    /// A flag naming a file appended to the system prompt.
    SystemPromptFile(&'static str),
    /// A flag carrying text appended to the system prompt.
    SystemPromptText(&'static str),
    /// Codex `-c developer_instructions=<toml string>`.
    DeveloperInstructions,
    /// A configuration key listing instruction files.
    InstructionsFile,
    /// A bounded block in the project's `AGENTS.md`.
    AgentsMd,
}

impl GuideChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::McpInstructions => "mcp-instructions",
            Self::SystemPromptFile(_) => "append-system-prompt-file",
            Self::SystemPromptText(_) => "append-system-prompt",
            Self::DeveloperInstructions => "developer-instructions",
            Self::InstructionsFile => "instructions-file",
            Self::AgentsMd => "agents-md",
        }
    }
}

/// How a CLI continues an earlier conversation: it is started with a
/// conversation id Omen Flow chooses, and resumed later by that id. A CLI
/// that only offers "the most recent conversation in this folder" is not
/// resumable here, because that may be a conversation Omen Flow never saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resume {
    /// Flag that assigns the id on a fresh start.
    pub assign: &'static str,
    /// Flag that resumes the conversation with that id.
    pub resume: &'static str,
}

/// How a CLI runs one prompt without a terminal. The prompt is always given
/// on standard input, so no flag that takes several values can swallow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Headless {
    /// Arguments placed before the session wiring.
    pub leading: &'static [&'static str],
    /// Arguments placed after it.
    pub trailing: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuggestedModel {
    pub id: &'static str,
    pub label: &'static str,
}

impl SuggestedModel {
    /// The profile `auto` resolves to when this model is launched.
    pub fn tier(&self) -> Profile {
        profile_for_model(self.id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// The first `major.minor[.patch]` in a CLI's version output, such as
    /// `codex-cli 0.156.1` or `2.1.287 (Claude Code)`.
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        (0..bytes.len())
            .filter(|&index| {
                bytes[index].is_ascii_digit() && (index == 0 || !bytes[index - 1].is_ascii_digit())
            })
            .find_map(|index| Self::parse_at(&text[index..]))
    }

    fn parse_at(text: &str) -> Option<Self> {
        let mut rest = text;
        let mut parts = [0_u64; 3];
        let mut found = 0;
        for (index, part) in parts.iter_mut().enumerate() {
            if index > 0 {
                match rest.strip_prefix('.') {
                    Some(after) if after.starts_with(|c: char| c.is_ascii_digit()) => rest = after,
                    _ => break,
                }
            }
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            *part = rest[..digits].parse().ok()?;
            rest = &rest[digits..];
            found += 1;
        }
        (found >= 2).then_some(Self::new(parts[0], parts[1], parts[2]))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// One hosted CLI.
#[derive(Debug)]
pub struct AdapterSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// Names looked up on the search path; empty when the person must give
    /// the path.
    pub executables: &'static [&'static str],
    pub version_args: &'static [&'static str],
    /// Oldest version whose launch flags this build relies on, and the
    /// version the launch line was checked against. `None` for a CLI that
    /// was never installed on a build machine.
    pub versions: Option<(Version, Version)>,
    pub install_hint: &'static str,
    pub docs_url: Option<&'static str>,
    /// True only when this build's launch line was checked against the
    /// installed CLI. Every other definition follows the CLI's documentation.
    pub verified: bool,
    pub mcp: McpInjection,
    /// Fixed arguments after the MCP wiring: tool pre-approval and sandbox.
    pub launch_args: &'static [&'static str],
    pub guidance: &'static [GuideChannel],
    pub model_flag: Option<&'static str>,
    /// Model id prefixes that select a local provider, with the arguments
    /// that do so; the prefix is removed from the id passed to the CLI.
    pub local_providers: &'static [(&'static str, &'static [&'static str])],
    pub default_profile: Profile,
    pub models: &'static [SuggestedModel],
    /// The CLI's limit for one tool call, set through its own configuration.
    pub tool_timeout: Duration,
    pub startup_timeout: Duration,
    pub resume: Option<Resume>,
    pub headless: Option<Headless>,
}

const fn model(id: &'static str, label: &'static str) -> SuggestedModel {
    SuggestedModel { id, label }
}

/// Every adapter, in the order Settings lists them.
pub static ADAPTERS: [AdapterSpec; 6] = [
    AdapterSpec {
        id: "codex",
        label: "Codex CLI",
        executables: &["codex"],
        version_args: &["--version"],
        versions: Some((Version::new(0, 150, 0), Version::new(0, 156, 1))),
        install_hint: "Install Codex CLI or set an executable path.",
        docs_url: Some("https://learn.chatgpt.com/docs/extend/mcp?surface=cli"),
        verified: true,
        mcp: McpInjection::CodexOverrides,
        launch_args: &[
            "-c",
            "sandbox_mode=\"workspace-write\"",
            "-c",
            "sandbox_workspace_write.network_access=true",
        ],
        guidance: &[
            GuideChannel::McpInstructions,
            GuideChannel::DeveloperInstructions,
        ],
        model_flag: Some("-m"),
        local_providers: &[
            ("ollama/", &["--oss", "--local-provider", "ollama"]),
            ("lmstudio/", &["--oss", "--local-provider", "lmstudio"]),
        ],
        default_profile: Profile::Standard,
        models: &[
            model("gpt-6-astra", "GPT-6 Astra"),
            model("gpt-6-sol", "GPT-6 Sol"),
            model("gpt-6-luna", "GPT-6 Luna"),
            model("gpt-5.6-sol", "GPT-5.6 Sol"),
            model("gpt-5.6-terra", "GPT-5.6 Terra"),
            model("gpt-5.6-luna", "GPT-5.6 Luna"),
            model("gpt-5.5", "GPT-5.5"),
        ],
        // Codex stops a tool call after 60 s unless told otherwise; a render
        // may take 300 s.
        tool_timeout: Duration::from_secs(330),
        startup_timeout: Duration::from_secs(20),
        resume: None,
        headless: Some(Headless {
            leading: &["exec", "--json", "--skip-git-repo-check"],
            trailing: &["-"],
        }),
    },
    AdapterSpec {
        id: "claude-code",
        label: "Claude Code",
        executables: &["claude"],
        version_args: &["--version"],
        versions: Some((Version::new(2, 1, 0), Version::new(2, 1, 287))),
        install_hint: "Install Claude Code or set an executable path.",
        docs_url: Some("https://code.claude.com/docs/en/mcp"),
        verified: true,
        mcp: McpInjection::ClaudeConfigFile,
        launch_args: &["--allowedTools", "mcp__omenflow"],
        guidance: &[
            GuideChannel::McpInstructions,
            GuideChannel::SystemPromptFile("--append-system-prompt-file"),
        ],
        model_flag: Some("--model"),
        local_providers: &[],
        default_profile: Profile::Standard,
        models: &[
            model("fable", "Fable"),
            model("opus", "Opus"),
            model("sonnet", "Sonnet"),
            model("haiku", "Haiku"),
        ],
        tool_timeout: Duration::from_secs(600),
        startup_timeout: Duration::from_secs(30),
        resume: Some(Resume {
            assign: "--session-id",
            resume: "--resume",
        }),
        headless: Some(Headless {
            leading: &["-p"],
            trailing: &[
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-mode",
                "dontAsk",
            ],
        }),
    },
    AdapterSpec {
        id: "opencode",
        label: "OpenCode",
        executables: &["opencode"],
        version_args: &["--version"],
        versions: None,
        install_hint: "Install OpenCode or set an executable path.",
        docs_url: Some("https://opencode.ai/docs/mcp-servers/"),
        verified: false,
        mcp: McpInjection::InlineConfig {
            variable: "OPENCODE_CONFIG_CONTENT",
        },
        launch_args: &[],
        guidance: &[
            GuideChannel::McpInstructions,
            GuideChannel::InstructionsFile,
        ],
        model_flag: Some("-m"),
        local_providers: &[],
        default_profile: Profile::Standard,
        models: &[model("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5")],
        tool_timeout: Duration::from_secs(330),
        startup_timeout: Duration::from_secs(20),
        resume: None,
        headless: None,
    },
    AdapterSpec {
        id: "gemini",
        label: "Gemini CLI",
        executables: &["gemini"],
        version_args: &["--version"],
        versions: None,
        install_hint: "Install Gemini CLI or set an executable path.",
        docs_url: Some("https://geminicli.com/docs/reference/configuration/"),
        verified: false,
        mcp: McpInjection::SettingsFile {
            variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
            file: "gemini.json",
            context_files: &["GEMINI.md", "AGENTS.md"],
        },
        launch_args: &["--allowed-mcp-server-names", SERVER_NAME],
        guidance: &[GuideChannel::McpInstructions],
        model_flag: Some("-m"),
        local_providers: &[],
        default_profile: Profile::Standard,
        models: &[
            model("pro", "Pro"),
            model("flash", "Flash"),
            model("flash-lite", "Flash Lite"),
        ],
        tool_timeout: Duration::from_secs(600),
        startup_timeout: Duration::from_secs(20),
        resume: None,
        headless: None,
    },
    AdapterSpec {
        id: "qwen",
        label: "Qwen Code",
        executables: &["qwen"],
        version_args: &["--version"],
        versions: None,
        install_hint: "Install Qwen Code or set an executable path.",
        docs_url: Some("https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/"),
        verified: false,
        mcp: McpInjection::SettingsFile {
            variable: "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
            file: "qwen.json",
            context_files: &[],
        },
        launch_args: &[],
        guidance: &[
            GuideChannel::McpInstructions,
            GuideChannel::SystemPromptText("--append-system-prompt"),
        ],
        model_flag: Some("-m"),
        local_providers: &[],
        default_profile: Profile::Standard,
        models: &[],
        tool_timeout: Duration::from_secs(600),
        startup_timeout: Duration::from_secs(20),
        resume: None,
        headless: None,
    },
    AdapterSpec {
        id: "custom",
        label: "Custom CLI",
        executables: &[],
        version_args: &["--version"],
        versions: None,
        install_hint: "Set an executable path via connection.configure.",
        docs_url: None,
        verified: false,
        mcp: McpInjection::EnvironmentOnly,
        launch_args: &[],
        guidance: &[GuideChannel::AgentsMd],
        model_flag: None,
        local_providers: &[],
        // The CLI most likely to carry a small local model.
        default_profile: Profile::Compact,
        models: &[],
        tool_timeout: Duration::from_secs(330),
        startup_timeout: Duration::from_secs(20),
        resume: None,
        headless: None,
    },
];

pub fn adapter(id: &str) -> Option<&'static AdapterSpec> {
    ADAPTERS.iter().find(|spec| spec.id == id)
}

/// The variable a custom adapter's configured environment sets to `off` to
/// keep Omen Flow from writing its block into the project's `AGENTS.md`.
pub const AGENTS_MD_SWITCH: &str = "OMENFLOW_AGENTS_MD";

impl AdapterSpec {
    /// Whether the session writes the bounded `AGENTS.md` block: only for a
    /// CLI with no other guidance channel, and not when the person turned it
    /// off for that adapter.
    pub fn writes_agents_md(&self, config: &AdapterConfig) -> bool {
        let switched_off = config.env.iter().any(|(key, value)| {
            key == AGENTS_MD_SWITCH
                && matches!(
                    value.trim().to_lowercase().as_str(),
                    "off" | "0" | "false" | "no"
                )
        });
        self.guidance.contains(&GuideChannel::AgentsMd) && !switched_off
    }

    /// Whether the CLI is told about the MCP server by Omen Flow.
    pub fn injects_mcp(&self) -> bool {
        self.mcp != McpInjection::EnvironmentOnly
    }

    /// Whether a probed version is one this build's launch line is known to
    /// suit: at least the oldest supported, and not a later major release.
    /// A CLI with no recorded versions is never recognised.
    pub fn recognises(&self, version: Option<Version>) -> bool {
        match (self.versions, version) {
            (Some((oldest, tested)), Some(found)) => found >= oldest && found.major <= tested.major,
            _ => false,
        }
    }

    pub fn tested_range(&self) -> Option<String> {
        self.versions
            .map(|(oldest, tested)| format!(">= {oldest}, checked with {tested}"))
    }

    /// The status line of this adapter for `connection.list`.
    pub fn status(&self, config: &AdapterConfig, probe: &Probe) -> Value {
        let available = probe.executable.is_some();
        let resolved = resolve_profile(
            config.profile,
            config.model.as_deref(),
            &config.args,
            self.default_profile,
        );
        let last_error = match (&probe.executable, &config.executable_path) {
            (Some(_), _) => Value::Null,
            (None, Some(path)) => json!(format!("Not found: {path}")),
            (None, None) if self.executables.is_empty() => json!("No executable path is set"),
            (None, None) => json!(format!("{} not found on PATH", self.executables[0])),
        };
        json!({
            "adapterId": self.id,
            "label": self.label,
            "available": available,
            "executablePath": probe.executable,
            "version": probe.version,
            "testedVersionRange": self.tested_range(),
            // A custom CLI has no version to recognise; it is usable as found.
            "recognizedVersion": if self.executables.is_empty() {
                available
            } else {
                self.recognises(probe.version.as_deref().and_then(Version::parse))
            },
            "capabilities": {
                "mcp": self.injects_mcp(),
                "cli": true,
                "resume": self.resume.is_some(),
            },
            "lastTestAt": config.raw["lastTestAt"],
            "lastTestOk": config.raw["lastTestOk"],
            "lastError": last_error,
            "installHint": self.install_hint,
            "model": config.model,
            "profile": config.profile.as_str(),
            // What a session starts with, so Settings can show it. The saved
            // environment is not listed: it may hold credentials.
            "args": config.args,
            "resolvedProfile": resolved.profile,
            "models": self
                .models
                .iter()
                .map(|model| json!({"id": model.id, "label": model.label, "tier": model.tier()}))
                .collect::<Vec<_>>(),
            "verified": self.verified,
            "docsUrl": self.docs_url,
            "guideChannels": self
                .guidance
                .iter()
                .map(|channel| channel.as_str())
                .collect::<Vec<_>>(),
        })
    }
}

/// What a person configured for an adapter (`settings.json → adapters[id]`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AdapterConfig {
    pub executable_path: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub model: Option<String>,
    pub profile: ProfileSetting,
    raw: Value,
}

impl AdapterConfig {
    /// Read a stored configuration. Anything malformed is treated as unset,
    /// so a damaged settings file never blocks a session.
    pub fn from_value(raw: &Value) -> Self {
        let text = |key: &str| {
            raw[key]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            executable_path: text("executablePath"),
            args: raw["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|arg| arg.as_str().map(str::to_owned))
                .collect(),
            env: raw["env"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect(),
            model: text("model"),
            profile: raw["profile"]
                .as_str()
                .and_then(|profile| profile.parse().ok())
                .unwrap_or_default(),
            raw: raw.clone(),
        }
    }

    /// The configuration for one session: what `terminal.start` passes
    /// overrides what is stored.
    pub fn for_start(mut self, input: &Value) -> Self {
        let start = Self::from_value(input);
        if input.get("executablePath").is_some() {
            self.executable_path = start.executable_path;
        }
        if input.get("args").is_some() {
            self.args = start.args;
        }
        if input.get("model").is_some() {
            self.model = start.model;
        }
        if input.get("profile").is_some() {
            self.profile = start.profile;
        }
        self
    }
}

/// What looking for an adapter's executable found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    pub executable: Option<PathBuf>,
    /// First line of the version output, when the CLI answered in time.
    pub version: Option<String>,
}

/// Where executables are looked for.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchPath {
    dirs: Vec<PathBuf>,
}

impl SearchPath {
    /// The person's real search path. A desktop app started from the Dock
    /// inherits a minimal PATH, so the login shell's PATH comes first, then
    /// the inherited one, then the folders CLI installers use. Folders inside
    /// a running AppImage are left out: they hold the app's own tools and
    /// vanish when it quits.
    pub fn system() -> Self {
        let mut found = Self::system_unfiltered();
        if let Some(bundle) = omenflow_core::child_env::appimage_dir() {
            found
                .dirs
                .retain(|dir| !omenflow_core::child_env::is_inside(dir, &bundle));
        }
        found
    }

    fn system_unfiltered() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let mut dirs = Vec::new();
        for source in [
            login_shell_path().map(str::to_owned),
            std::env::var("PATH").ok(),
        ]
        .into_iter()
        .flatten()
        {
            dirs.extend(std::env::split_paths(&source));
        }
        if let Some(home) = &home {
            for folder in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".opencode/bin",
                ".volta/bin",
            ] {
                dirs.push(home.join(folder));
            }
        }
        for folder in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            dirs.push(PathBuf::from(folder));
        }
        dirs.extend(linux_install_dirs(home.as_deref()));
        Self::from_dirs(dirs)
    }

    pub fn from_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut unique = Vec::new();
        for dir in dirs {
            if !dir.as_os_str().is_empty() && !unique.contains(&dir) {
                unique.push(dir);
            }
        }
        Self { dirs: unique }
    }

    /// The first executable file with one of `names`.
    pub fn find(&self, names: &[&str]) -> Option<PathBuf> {
        let suffixes: &[&str] = if cfg!(windows) {
            &[".exe", ".cmd", ".bat", ""]
        } else {
            &[""]
        };
        self.dirs.iter().find_map(|dir| {
            names.iter().find_map(|name| {
                suffixes
                    .iter()
                    .map(|suffix| dir.join(format!("{name}{suffix}")))
                    .find(|candidate| is_executable(candidate))
            })
        })
    }

    /// The PATH for an agent process: `first` (the folder of the `omenflow`
    /// helper), then every search folder.
    pub fn child_path(&self, first: &Path) -> String {
        let dirs = std::iter::once(first.to_owned()).chain(self.dirs.iter().cloned());
        std::env::join_paths(Self::from_dirs(dirs).dirs)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// The executable a session of this adapter would run: the configured
    /// path when there is one (never replaced by something on the PATH),
    /// else the first match on the search path.
    pub fn locate(&self, spec: &AdapterSpec, config: &AdapterConfig) -> Option<PathBuf> {
        match &config.executable_path {
            Some(path) => Some(PathBuf::from(path)).filter(|path| is_executable(path)),
            None => self.find(spec.executables),
        }
    }

    /// Find an adapter's executable and ask it for its version.
    pub fn probe(&self, spec: &AdapterSpec, config: &AdapterConfig) -> Probe {
        let executable = self.locate(spec, config);
        let version = executable
            .as_deref()
            .and_then(|path| probe_version(path, spec.version_args, Duration::from_secs(2)));
        Probe {
            executable,
            version,
        }
    }
}

/// Where Linux installers put CLIs that a session started from the desktop
/// may not have on its PATH: Homebrew on Linux (system-wide and per user)
/// and snaps. Nothing elsewhere.
fn linux_install_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let mut dirs = vec![PathBuf::from("/home/linuxbrew/.linuxbrew/bin")];
    dirs.extend(home.map(|home| home.join(".linuxbrew/bin")));
    dirs.push(PathBuf::from("/snap/bin"));
    dirs
}

pub fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

/// The PATH of the person's login shell, resolved once per process. The
/// first caller waits for the shell (at most three seconds); `warm` runs
/// that on its own thread so no request does.
pub fn login_shell_path() -> Option<&'static str> {
    static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            // Tests must not depend on the developer's shell start-up files;
            // `shell_path` is tested directly with stand-in shells.
            if cfg!(any(test, windows)) {
                return None;
            }
            let shell = std::env::var_os("SHELL")
                .map(PathBuf::from)
                .filter(|shell| shell.is_file())
                .unwrap_or_else(|| PathBuf::from("/bin/sh"));
            shell_path(&shell, Duration::from_secs(3))
        })
        .as_deref()
}

/// Resolve the login-shell PATH away from any request thread.
pub fn warm() {
    thread::spawn(login_shell_path);
}

const PATH_BEGIN: &str = "__OMENFLOW_PATH_BEGIN__";
const PATH_END: &str = "__OMENFLOW_PATH_END__";

/// Ask an interactive login shell for its PATH. Start-up files may print
/// anything, so the value is read from between two markers.
fn shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    let script = format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'");
    let output = run_bounded(shell, &["-ilc", &script], timeout, 64 * 1024)?;
    let start = output.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = output[start..].find(PATH_END)? + start;
    let path = output[start..end].trim();
    (!path.is_empty()).then(|| path.to_owned())
}

/// The first line a CLI prints for its version arguments, or `None` when it
/// fails, prints nothing or does not answer in time.
pub fn probe_version(path: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let output = run_bounded(path, args, timeout, 4096)?;
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.chars().take(120).collect())
}

/// Run a program with no input, return what it printed, and never wait
/// longer than `timeout`: the program and anything it started are killed.
fn run_bounded(program: &Path, args: &[&str], timeout: Duration, limit: u64) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(program);
    omenflow_core::child_env::apply(&mut command);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // An executable that is still open for writing somewhere refuses to start
    // with ETXTBSY for a moment: a CLI replacing itself during an update, or a
    // file written while another thread of this process was forking. Retry
    // briefly instead of reporting the CLI as missing.
    let mut busy = 0;
    let mut child = loop {
        match command.spawn() {
            Ok(child) => break child,
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && busy < 20 => {
                busy += 1;
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    };
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(limit).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    let output = receiver.recv_timeout(timeout).ok();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => break false,
        }
    };
    #[cfg(unix)]
    // SAFETY: `kill` takes plain integers; the child was started as the
    // leader of its own process group, so the negative id names that group.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    if !success {
        return None;
    }
    Some(String::from_utf8_lossy(&output?).into_owned())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn versions_are_parsed_from_real_outputs_and_compared_numerically() {
        for (text, expected) in [
            ("codex-cli 0.156.1", Some(Version::new(0, 156, 1))),
            ("2.1.287 (Claude Code)", Some(Version::new(2, 1, 287))),
            ("2026.09.10-fd3934a", Some(Version::new(2026, 9, 10))),
            ("opencode v1.4", Some(Version::new(1, 4, 0))),
            (
                "gemini 0.11.0-nightly.20261001",
                Some(Version::new(0, 11, 0)),
            ),
            ("version 3", None),
            ("no digits here", None),
            ("", None),
            ("build 7 of 2.0.1", Some(Version::new(2, 0, 1))),
            ("1..2", None),
        ] {
            assert_eq!(Version::parse(text), expected, "{text:?}");
        }
        assert!(Version::new(0, 156, 1) > Version::new(0, 15, 9));
        assert!(Version::new(0, 160, 0) > Version::new(0, 156, 1));
        assert_eq!(Version::new(2, 1, 287).to_string(), "2.1.287");
    }

    /// The cases substring matching got wrong: `0.156` is not `0.15`, `0.160`
    /// is newer than the tested build, `3.1.0` is not a `1.` release.
    #[test]
    fn recognition_is_a_version_comparison() {
        let codex = adapter("codex").unwrap();
        let recognises = |spec: &AdapterSpec, text: &str| spec.recognises(Version::parse(text));
        assert!(recognises(codex, "codex-cli 0.156.1"));
        assert!(recognises(codex, "codex-cli 0.160.0"));
        assert!(recognises(codex, "codex-cli 0.150.0"));
        assert!(!recognises(codex, "codex-cli 0.15.0"));
        assert!(!recognises(codex, "codex-cli 0.149.9"));
        assert!(!recognises(codex, "codex-cli 1.0.0"));
        let claude = adapter("claude-code").unwrap();
        assert!(recognises(claude, "2.1.287 (Claude Code)"));
        assert!(recognises(claude, "2.4.0 (Claude Code)"));
        assert!(!recognises(claude, "1.0.128 (Claude Code)"));
        assert!(!recognises(claude, "3.1.0 (Claude Code)"));
        assert!(!recognises(claude, "11.0.2"));
        assert!(!claude.recognises(None));
        assert_eq!(
            codex.tested_range().as_deref(),
            Some(">= 0.150.0, checked with 0.156.1")
        );
        // Never installed on a build machine: nothing is claimed.
        let gemini = adapter("gemini").unwrap();
        assert!(!recognises(gemini, "0.11.0"));
        assert_eq!(gemini.tested_range(), None);
    }

    #[test]
    fn the_registry_is_complete_and_truthful_about_verification() {
        let ids = ADAPTERS.iter().map(|spec| spec.id).collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "codex",
                "claude-code",
                "opencode",
                "gemini",
                "qwen",
                "custom"
            ]
        );
        for spec in &ADAPTERS {
            assert_eq!(
                spec.verified,
                matches!(spec.id, "codex" | "claude-code"),
                "{}",
                spec.id
            );
            assert_eq!(spec.verified, spec.versions.is_some(), "{}", spec.id);
            assert!(
                !spec.guidance.is_empty(),
                "{} has no guidance channel",
                spec.id
            );
            assert_eq!(
                spec.guidance.contains(&GuideChannel::AgentsMd),
                spec.guidance.len() == 1 && !spec.injects_mcp(),
                "{}: AGENTS.md is only for a CLI with no other channel",
                spec.id
            );
            assert_eq!(
                spec.guidance.contains(&GuideChannel::McpInstructions),
                spec.injects_mcp(),
                "{}",
                spec.id
            );
            assert_eq!(spec.executables.is_empty(), spec.id == "custom");
            assert!(spec.tool_timeout >= Duration::from_secs(330), "{}", spec.id);
            if let Some((oldest, tested)) = spec.versions {
                assert!(oldest <= tested);
            }
        }
        assert!(adapter("cursor").is_none());
    }

    #[test]
    fn suggested_models_carry_the_tier_auto_resolves_to() {
        let tiers = |id: &str| {
            adapter(id)
                .unwrap()
                .models
                .iter()
                .map(|model| (model.id, model.tier()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            tiers("claude-code"),
            [
                ("fable", Profile::Full),
                ("opus", Profile::Full),
                ("sonnet", Profile::Standard),
                ("haiku", Profile::Compact)
            ]
        );
        assert_eq!(
            tiers("codex"),
            [
                ("gpt-6-astra", Profile::Full),
                ("gpt-6-sol", Profile::Full),
                ("gpt-6-luna", Profile::Compact),
                ("gpt-5.6-sol", Profile::Full),
                ("gpt-5.6-terra", Profile::Standard),
                ("gpt-5.6-luna", Profile::Compact),
                ("gpt-5.5", Profile::Standard)
            ]
        );
        assert_eq!(
            tiers("gemini"),
            [
                ("pro", Profile::Full),
                ("flash", Profile::Standard),
                ("flash-lite", Profile::Compact)
            ]
        );
        assert!(tiers("custom").is_empty());
    }

    #[test]
    fn configuration_is_read_leniently_and_start_input_overrides_it() {
        let stored = AdapterConfig::from_value(&json!({
            "executablePath": "  /opt/bin/codex ",
            "args": ["--no-daemon", 7, "-v"],
            "env": {"FOO": "bar", "BAD": 3},
            "model": "gpt-6-luna",
            "profile": "full",
            "lastTestOk": true
        }));
        assert_eq!(stored.executable_path.as_deref(), Some("/opt/bin/codex"));
        assert_eq!(stored.args, ["--no-daemon", "-v"]);
        assert_eq!(stored.env, [("FOO".to_owned(), "bar".to_owned())]);
        assert_eq!(stored.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(stored.profile, ProfileSetting::Fixed(Profile::Full));

        let empty = AdapterConfig::from_value(&Value::Null);
        assert_eq!(empty.profile, ProfileSetting::Auto);
        assert!(empty.model.is_none() && empty.args.is_empty());
        let odd = AdapterConfig::from_value(&json!({"model": "", "profile": "huge", "args": "x"}));
        assert_eq!((odd.model, odd.profile), (None, ProfileSetting::Auto));

        let started = stored.clone().for_start(
            &json!({"adapterId": "codex", "model": "gpt-6-astra", "profile": "auto", "args": []}),
        );
        assert_eq!(started.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(started.profile, ProfileSetting::Auto);
        assert!(started.args.is_empty());
        assert_eq!(started.executable_path.as_deref(), Some("/opt/bin/codex"));
        assert_eq!(started.env, stored.env, "start input never carries env");
        assert_eq!(
            stored.clone().for_start(&json!({"adapterId": "codex"})),
            stored
        );
    }

    #[test]
    fn executables_are_found_in_order_and_must_be_executable() {
        let temp = tempfile::tempdir().unwrap();
        let (first, second) = (temp.path().join("a"), temp.path().join("b"));
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("claude"), "not executable").unwrap();
        let real = script(&second, "claude", "echo '2.1.287 (Claude Code)'");
        let search = SearchPath::from_dirs([first.clone(), second.clone(), first.clone()]);
        assert_eq!(search.find(&["claude"]), Some(real.clone()));
        assert_eq!(search.find(&["codex"]), None);
        assert_eq!(search.find(&[]), None);
        assert_eq!(
            search.child_path(Path::new("/helper")),
            format!("/helper:{}:{}", first.display(), second.display())
        );
        assert_eq!(
            search.child_path(&second),
            format!("{}:{}", second.display(), first.display())
        );

        let claude = adapter("claude-code").unwrap();
        let found = search.probe(claude, &AdapterConfig::default());
        assert_eq!(found.executable, Some(real));
        assert_eq!(found.version.as_deref(), Some("2.1.287 (Claude Code)"));

        let missing = AdapterConfig::from_value(&json!({"executablePath": "/nowhere/claude"}));
        assert_eq!(search.probe(claude, &missing), Probe::default());
        // A configured path is used as given, never replaced by a PATH hit.
        let status = claude.status(&missing, &search.probe(claude, &missing));
        assert_eq!(status["available"], false);
        assert_eq!(status["lastError"], "Not found: /nowhere/claude");
    }

    #[test]
    fn linux_looks_where_linux_installers_put_clis() {
        let dirs = linux_install_dirs(Some(Path::new("/home/ana")));
        if cfg!(target_os = "linux") {
            assert_eq!(
                dirs,
                [
                    PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
                    PathBuf::from("/home/ana/.linuxbrew/bin"),
                    PathBuf::from("/snap/bin"),
                ]
            );
            let system = SearchPath::system();
            assert!(system.dirs.contains(&PathBuf::from("/snap/bin")));
            assert!(system
                .dirs
                .contains(&PathBuf::from("/home/linuxbrew/.linuxbrew/bin")));
        } else {
            assert!(dirs.is_empty(), "macOS keeps its own list");
        }
    }

    #[test]
    fn status_reports_the_v1_fields() {
        let temp = tempfile::tempdir().unwrap();
        let codex_path = script(temp.path(), "codex", "echo 'codex-cli 0.156.1'");
        let search = SearchPath::from_dirs([temp.path().to_owned()]);
        let codex = adapter("codex").unwrap();
        let config = AdapterConfig::from_value(
            &json!({"model": "gpt-6-luna", "lastTestOk": true, "lastTestAt": "2026-10-13T00:00:00.000Z"}),
        );
        let status = codex.status(&config, &search.probe(codex, &config));
        assert_eq!(
            status,
            json!({
                "adapterId": "codex",
                "label": "Codex CLI",
                "available": true,
                "executablePath": codex_path,
                "version": "codex-cli 0.156.1",
                "testedVersionRange": ">= 0.150.0, checked with 0.156.1",
                "recognizedVersion": true,
                "capabilities": {"mcp": true, "cli": true, "resume": false},
                "lastTestAt": "2026-10-13T00:00:00.000Z",
                "lastTestOk": true,
                "lastError": null,
                "installHint": "Install Codex CLI or set an executable path.",
                "model": "gpt-6-luna",
                "profile": "auto",
                "args": [],
                "resolvedProfile": "compact",
                "models": [
                    {"id": "gpt-6-astra", "label": "GPT-6 Astra", "tier": "full"},
                    {"id": "gpt-6-sol", "label": "GPT-6 Sol", "tier": "full"},
                    {"id": "gpt-6-luna", "label": "GPT-6 Luna", "tier": "compact"},
                    {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "tier": "full"},
                    {"id": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "tier": "standard"},
                    {"id": "gpt-5.6-luna", "label": "GPT-5.6 Luna", "tier": "compact"},
                    {"id": "gpt-5.5", "label": "GPT-5.5", "tier": "standard"}
                ],
                "verified": true,
                "docsUrl": "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
                "guideChannels": ["mcp-instructions", "developer-instructions"]
            })
        );

        let gemini = adapter("gemini").unwrap();
        let absent = gemini.status(&AdapterConfig::default(), &Probe::default());
        assert_eq!(absent["available"], false);
        assert_eq!(absent["lastError"], "gemini not found on PATH");
        assert_eq!(absent["verified"], false);
        assert_eq!(absent["recognizedVersion"], false);
        assert_eq!(absent["testedVersionRange"], Value::Null);
        assert_eq!(absent["resolvedProfile"], "standard");
        assert_eq!(absent["guideChannels"], json!(["mcp-instructions"]));
        assert_eq!(absent["capabilities"]["resume"], false);

        let custom = adapter("custom").unwrap();
        let saved = AdapterConfig::from_value(
            &json!({"executablePath": "/bin/sh", "args": ["-c", "my-agent"], "env": {"API_KEY": "secret"}}),
        );
        let configured = custom.status(&saved, &Probe::default());
        assert_eq!(configured["args"], json!(["-c", "my-agent"]));
        assert!(!configured.to_string().contains("secret"));
        let unset = custom.status(&AdapterConfig::default(), &Probe::default());
        assert_eq!(unset["args"], json!([]));
        assert_eq!(unset["lastError"], "No executable path is set");
        assert_eq!(unset["resolvedProfile"], "compact");
        assert_eq!(
            unset["capabilities"],
            json!({"mcp": false, "cli": true, "resume": false})
        );
        assert_eq!(unset["guideChannels"], json!(["agents-md"]));
        assert_eq!(unset["docsUrl"], Value::Null);
        let cat = AdapterConfig::from_value(
            &json!({"executablePath": "/bin/cat", "profile": "standard"}),
        );
        let set = custom.status(
            &cat,
            &Probe {
                executable: Some("/bin/cat".into()),
                version: None,
            },
        );
        assert_eq!(set["recognizedVersion"], true);
        assert_eq!(
            (&set["profile"], &set["resolvedProfile"]),
            (&json!("standard"), &json!("standard"))
        );
    }

    #[test]
    fn the_agents_md_block_is_only_for_custom_and_can_be_switched_off() {
        let custom = adapter("custom").unwrap();
        assert!(custom.writes_agents_md(&AdapterConfig::default()));
        for value in ["off", "0", "False", " no "] {
            let config = AdapterConfig::from_value(&json!({"env": {AGENTS_MD_SWITCH: value}}));
            assert!(!custom.writes_agents_md(&config), "{value:?}");
        }
        let on = AdapterConfig::from_value(&json!({"env": {AGENTS_MD_SWITCH: "on"}}));
        assert!(custom.writes_agents_md(&on));
        for id in ["codex", "claude-code", "opencode", "gemini", "qwen"] {
            assert!(
                !adapter(id)
                    .unwrap()
                    .writes_agents_md(&AdapterConfig::default()),
                "{id}"
            );
        }
    }

    #[test]
    fn version_probe_is_bounded_and_accepts_normal_output() {
        let temp = tempfile::tempdir().unwrap();
        let cli = script(
            temp.path(),
            "agent",
            "echo; echo 'agent 1.2.3'; echo 'second line'",
        );
        assert_eq!(
            probe_version(&cli, &["--version"], Duration::from_secs(5)).as_deref(),
            Some("agent 1.2.3")
        );
        let failing = script(temp.path(), "failing", "echo 'agent 9.9.9'; exit 3");
        assert_eq!(
            probe_version(&failing, &["--version"], Duration::from_secs(5)),
            None
        );
        let silent = script(temp.path(), "silent", "exit 0");
        assert_eq!(
            probe_version(&silent, &["--version"], Duration::from_secs(5)),
            None
        );
        let hanging = script(temp.path(), "hanging", "sleep 30");
        let start = Instant::now();
        assert!(probe_version(&hanging, &["--version"], Duration::from_millis(100)).is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_login_shell_path_is_read_from_between_its_markers() {
        let temp = tempfile::tempdir().unwrap();
        // A shell whose start-up files print a banner around the answer.
        let noisy = script(
            temp.path(),
            "noisy",
            "echo 'Welcome back!'; PATH=/custom/bin:/usr/bin; shift; eval \"$1\"; echo; echo 'bye'",
        );
        assert_eq!(
            shell_path(&noisy, Duration::from_secs(5)).as_deref(),
            Some("/custom/bin:/usr/bin")
        );
        let mute = script(temp.path(), "mute", "echo 'no markers here'");
        assert_eq!(shell_path(&mute, Duration::from_secs(5)), None);
        let stuck = script(temp.path(), "stuck", "sleep 30");
        let start = Instant::now();
        assert_eq!(shell_path(&stuck, Duration::from_millis(100)), None);
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(
            shell_path(Path::new("/nowhere/sh"), Duration::from_secs(1)),
            None
        );
        assert_eq!(
            login_shell_path(),
            None,
            "tests never run the developer's shell"
        );
    }
}
