use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use simple_directory_core::vault::relpath;
use simple_directory_engine::state::AppState;
use tauri::ipc::Channel;

use crate::terminal::spawn::{shell_program, OpenSpec};
use crate::terminal::{self, TerminalChunk, TerminalRegistry};

const MAX_SNAP_FILE_BYTES: i64 = 256 * 1024;
const MAX_SNAP_TOTAL_BYTES: i64 = 8 * 1024 * 1024;
const MAX_DIFF_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy)]
enum PromptStyle {
    Positional,
    Flag(&'static str),
}

struct Provider {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    prompt: PromptStyle,
}

const PROVIDERS: &[Provider] = &[
    Provider {
        id: "codex",
        name: "Codex",
        command: "codex",
        prompt: PromptStyle::Positional,
    },
    Provider {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        prompt: PromptStyle::Positional,
    },
    Provider {
        id: "grok",
        name: "Grok",
        command: "grok",
        prompt: PromptStyle::Positional,
    },
    Provider {
        id: "antigravity",
        name: "Antigravity",
        command: "antigravity",
        prompt: PromptStyle::Positional,
    },
    Provider {
        id: "aider",
        name: "Aider",
        command: "aider",
        prompt: PromptStyle::Flag("--message"),
    },
    Provider {
        id: "gemini",
        name: "Gemini",
        command: "gemini",
        prompt: PromptStyle::Flag("-i"),
    },
];

fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProviderDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub available: bool,
    pub path: Option<String>,
    pub prompt_style: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentsDetectResponse {
    pub providers: Vec<AgentProviderDto>,
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(windows)]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(|s| s.trim().trim_start_matches('.').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut out = vec![dir.join(name)];
    for ext in exts {
        out.push(dir.join(format!("{name}.{ext}")));
    }
    out
}

#[cfg(not(windows))]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for cand in candidates(&dir, name) {
            if executable(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

#[tauri::command]
pub fn agents_detect() -> AgentsDetectResponse {
    let providers = PROVIDERS
        .iter()
        .map(|p| {
            let found = find_on_path(p.command);
            AgentProviderDto {
                id: p.id.to_string(),
                name: p.name.to_string(),
                command: p.command.to_string(),
                available: found.is_some(),
                path: found.map(|p| p.to_string_lossy().into_owned()),
                prompt_style: match p.prompt {
                    PromptStyle::Positional => "positional",
                    PromptStyle::Flag(_) => "flag",
                }
                .to_string(),
            }
        })
        .collect();
    AgentsDetectResponse { providers }
}

struct FileSnap {
    hash: String,
    content: Option<String>,
}

struct AgentMeta {
    vault_id: String,
    cwd_rel: String,
    provider: String,
    started_at: i64,
    snapshot: HashMap<String, FileSnap>,
}

#[derive(Default)]
pub struct AgentRegistry {
    metas: Mutex<HashMap<String, AgentMeta>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl AgentRegistry {
    fn register(&self, agent_id: &str, meta: AgentMeta) {
        lock(&self.metas).insert(agent_id.to_string(), meta);
    }

    fn meta<T>(&self, agent_id: &str, take: impl FnOnce(&AgentMeta) -> T) -> Result<T, String> {
        lock(&self.metas)
            .get(agent_id)
            .map(take)
            .ok_or_else(|| format!("no agent session '{agent_id}'"))
    }

    pub fn remove(&self, agent_id: &str) {
        lock(&self.metas).remove(agent_id);
    }

    pub fn drain_vault(&self, vault_id: &str) {
        lock(&self.metas).retain(|_, m| m.vault_id != vault_id);
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentOpenRequest {
    pub vault_id: String,
    pub provider: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentOpenResponse {
    pub agent_id: String,
    pub cwd: String,
}

fn shell_quote(value: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn project_of(cwd_rel: &str) -> Option<String> {
    let rest = cwd_rel.strip_prefix("Projects/")?;
    let name = rest.split('/').next()?;
    (!name.is_empty()).then(|| name.to_string())
}

fn build_agent_spec(
    req: &AgentOpenRequest,
    vault_root: PathBuf,
    cwd_rel: String,
    cwd_abs: PathBuf,
) -> Result<OpenSpec, String> {
    let prompt = req
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("SIMPLE_DIRECTORY_CWD".to_string(), cwd_rel.clone()),
    ];
    if let Some(task) = prompt {
        env.push(("SIMPLE_DIRECTORY_TASK".to_string(), task.to_string()));
    }
    if let Some(project) = project_of(&cwd_rel) {
        env.push(("SIMPLE_DIRECTORY_PROJECT".to_string(), project));
    }

    if req.provider == "custom" || provider(&req.provider).is_none() {
        let line = req
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "a custom agent needs a command".to_string())?;
        let line = match prompt {
            Some(p) if line.contains("{prompt}") => line.replace("{prompt}", &shell_quote(p)),
            _ => line.to_string(),
        };
        return Ok(OpenSpec::agent(
            vault_root,
            cwd_abs,
            shell_program(),
            vec!["-lc".to_string(), line],
            env,
            req.cols,
            req.rows,
        ));
    }

    let p = provider(&req.provider).expect("checked above");
    let mut args: Vec<String> = Vec::new();
    if let Some(task) = prompt {
        match p.prompt {
            PromptStyle::Positional => args.push(task.to_string()),
            PromptStyle::Flag(flag) => {
                args.push(flag.to_string());
                args.push(task.to_string());
            }
        }
    }
    Ok(OpenSpec::agent(
        vault_root,
        cwd_abs,
        PathBuf::from(p.command),
        args,
        env,
        req.cols,
        req.rows,
    ))
}

async fn snapshot_tree(
    state: &AppState,
    vault_id: &str,
    prefix: &str,
) -> Result<HashMap<String, FileSnap>, String> {
    let vault = {
        let guard = state.vaults().read().await;
        guard
            .get(vault_id)
            .map(|open| open.vault.clone())
            .ok_or_else(|| format!("vault '{vault_id}' is not open"))?
    };
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT path, content_hash, size_bytes FROM files
             WHERE (?1 = 0 OR substr(path, 1, ?1) = ?2)",
            libsql_params(prefix),
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut entries: Vec<(String, String, i64)> = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        entries.push((
            row.get(0).map_err(|e| e.to_string())?,
            row.get(1).map_err(|e| e.to_string())?,
            row.get(2).map_err(|e| e.to_string())?,
        ));
    }

    let root = vault.root().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut out = HashMap::with_capacity(entries.len());
        let mut budget = MAX_SNAP_TOTAL_BYTES;
        for (path, hash, size) in entries {
            let content = if size <= MAX_SNAP_FILE_BYTES && budget > 0 {
                budget -= size;
                std::fs::read(root.join(&path))
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
            } else {
                None
            };
            out.insert(path, FileSnap { hash, content });
        }
        out
    })
    .await
    .map_err(|e| format!("snapshot task join error: {e}"))
}

fn libsql_params(prefix: &str) -> Vec<libsql::Value> {
    let len = if prefix.is_empty() {
        0
    } else {
        prefix.len() + 1
    };
    let pat = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    vec![libsql::Value::from(len as i64), libsql::Value::from(pat)]
}

#[tauri::command]
pub async fn agent_open(
    state: tauri::State<'_, AppState>,
    terminals: tauri::State<'_, TerminalRegistry>,
    agents: tauri::State<'_, AgentRegistry>,
    req: AgentOpenRequest,
    on_output: Channel<TerminalChunk>,
) -> Result<AgentOpenResponse, String> {
    let shell = terminal::prepare_open(state.inner(), &req.vault_id, req.cols, req.rows).await?;
    let root = shell.vault_root.clone();

    let (cwd_rel, cwd_abs) = if req.cwd.trim().is_empty() {
        (String::new(), root.clone())
    } else {
        relpath::contained_join(&root, req.cwd.trim())
            .map_err(|e| format!("invalid working directory: {e}"))?
    };
    if !cwd_abs.is_dir() {
        return Err(format!("working directory does not exist: {cwd_rel}"));
    }

    let spec = build_agent_spec(&req, root, cwd_rel.clone(), cwd_abs)?;
    let snapshot = snapshot_tree(state.inner(), &req.vault_id, &cwd_rel).await?;

    let sink = Box::new(move |chunk| on_output.send(chunk).is_ok());
    let agent_id = terminals.open(&req.vault_id, spec, sink)?;
    agents.register(
        &agent_id,
        AgentMeta {
            vault_id: req.vault_id.clone(),
            cwd_rel: cwd_rel.clone(),
            provider: req.provider.clone(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            snapshot,
        },
    );
    Ok(AgentOpenResponse {
        agent_id,
        cwd: cwd_rel,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentChangeDto {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentChangesResponse {
    pub changes: Vec<AgentChangeDto>,
    pub provider: String,
    pub cwd: String,
    pub started_at: i64,
}

async fn current_tree(
    state: &AppState,
    vault_id: &str,
    prefix: &str,
) -> Result<HashMap<String, String>, String> {
    let vault = {
        let guard = state.vaults().read().await;
        guard
            .get(vault_id)
            .map(|open| open.vault.clone())
            .ok_or_else(|| format!("vault '{vault_id}' is not open"))?
    };
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT path, content_hash FROM files
             WHERE (?1 = 0 OR substr(path, 1, ?1) = ?2)",
            libsql_params(prefix),
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.insert(
            row.get::<String>(0).map_err(|e| e.to_string())?,
            row.get::<String>(1).map_err(|e| e.to_string())?,
        );
    }
    Ok(out)
}

#[tauri::command]
pub async fn agent_changes(
    state: tauri::State<'_, AppState>,
    agents: tauri::State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<AgentChangesResponse, String> {
    let (vault_id, prefix, provider, started_at, snapshot_hashes) =
        agents.meta(&agent_id, |m| {
            (
                m.vault_id.clone(),
                m.cwd_rel.clone(),
                m.provider.clone(),
                m.started_at,
                m.snapshot
                    .iter()
                    .map(|(p, s)| (p.clone(), s.hash.clone()))
                    .collect::<HashMap<_, _>>(),
            )
        })?;
    let now = current_tree(state.inner(), &vault_id, &prefix).await?;

    let mut changes = Vec::new();
    for (path, hash) in &now {
        match snapshot_hashes.get(path) {
            None => changes.push(AgentChangeDto {
                path: path.clone(),
                status: "added".into(),
            }),
            Some(old) if old != hash => changes.push(AgentChangeDto {
                path: path.clone(),
                status: "modified".into(),
            }),
            _ => {}
        }
    }
    for path in snapshot_hashes.keys() {
        if !now.contains_key(path) {
            changes.push(AgentChangeDto {
                path: path.clone(),
                status: "deleted".into(),
            });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(AgentChangesResponse {
        changes,
        provider,
        cwd: prefix,
        started_at,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDiffResponse {
    pub path: String,
    pub status: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

#[tauri::command]
pub async fn agent_diff(
    state: tauri::State<'_, AppState>,
    agents: tauri::State<'_, AgentRegistry>,
    agent_id: String,
    path: String,
) -> Result<AgentDiffResponse, String> {
    let (vault_id, old_content, old_hash) = agents.meta(&agent_id, |m| {
        (
            m.vault_id.clone(),
            m.snapshot.get(&path).and_then(|s| s.content.clone()),
            m.snapshot.get(&path).map(|s| s.hash.clone()),
        )
    })?;
    let vault = {
        let guard = state.vaults().read().await;
        guard
            .get(&vault_id)
            .map(|open| open.vault.clone())
            .ok_or_else(|| format!("vault '{vault_id}' is not open"))?
    };
    let (rel, abs) =
        relpath::contained_join(vault.root(), &path).map_err(|e| format!("invalid path: {e}"))?;

    let abs_for = abs.clone();
    let on_disk = tokio::task::spawn_blocking(move || {
        std::fs::metadata(&abs_for).ok().and_then(|m| {
            if m.is_file() && m.len() <= MAX_DIFF_BYTES {
                std::fs::read(&abs_for).ok()
            } else {
                None
            }
        })
    })
    .await
    .map_err(|e| format!("read task join error: {e}"))?;
    let new = on_disk.and_then(|b| String::from_utf8(b).ok());

    let status = match (&old_hash, new.is_some() || abs.exists()) {
        (None, true) => "added",
        (Some(_), false) => "deleted",
        _ => "modified",
    };
    Ok(AgentDiffResponse {
        path: rel,
        status: status.to_string(),
        old: old_content,
        new,
    })
}

#[tauri::command]
pub async fn agent_close(
    terminals: tauri::State<'_, TerminalRegistry>,
    agents: tauri::State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<(), String> {
    agents.remove(&agent_id);
    terminal::reap(terminals.take(&agent_id).into_iter().collect()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positional_prompt_appends_the_task_as_one_arg() {
        let req = AgentOpenRequest {
            vault_id: "v".into(),
            provider: "codex".into(),
            cwd: String::new(),
            command: None,
            prompt: Some("fix the tests".into()),
            cols: 80,
            rows: 24,
        };
        let spec = build_agent_spec(
            &req,
            PathBuf::from("/vault"),
            String::new(),
            PathBuf::from("/vault"),
        )
        .unwrap();
        assert_eq!(spec.program, PathBuf::from("codex"));
        assert_eq!(spec.args, vec!["fix the tests"]);
        assert!(spec
            .env
            .iter()
            .any(|(k, v)| k == "SIMPLE_DIRECTORY_TASK" && v == "fix the tests"));
    }

    #[test]
    fn flag_prompt_uses_the_provider_flag() {
        let req = AgentOpenRequest {
            vault_id: "v".into(),
            provider: "aider".into(),
            cwd: String::new(),
            command: None,
            prompt: Some("add a test".into()),
            cols: 80,
            rows: 24,
        };
        let spec = build_agent_spec(
            &req,
            PathBuf::from("/vault"),
            String::new(),
            PathBuf::from("/vault"),
        )
        .unwrap();
        assert_eq!(spec.args, vec!["--message", "add a test"]);
    }

    #[test]
    fn custom_commands_run_through_the_shell_with_prompt_substitution() {
        let req = AgentOpenRequest {
            vault_id: "v".into(),
            provider: "custom".into(),
            cwd: "Projects/Kineon".into(),
            command: Some("my-agent --task {prompt} --fast".into()),
            prompt: Some("it's broke".into()),
            cols: 80,
            rows: 24,
        };
        let spec = build_agent_spec(
            &req,
            PathBuf::from("/vault"),
            "Projects/Kineon".into(),
            PathBuf::from("/vault/Projects/Kineon"),
        )
        .unwrap();
        assert_eq!(spec.cwd, PathBuf::from("/vault/Projects/Kineon"));
        assert_eq!(spec.args.len(), 2);
        assert_eq!(spec.args[0], "-lc");
        assert!(spec.args[1].contains("my-agent --task 'it'\\''s broke' --fast"));
        assert!(spec
            .env
            .iter()
            .any(|(k, v)| k == "SIMPLE_DIRECTORY_PROJECT" && v == "Kineon"));
    }

    #[test]
    fn custom_without_placeholder_still_exports_the_task_env() {
        let req = AgentOpenRequest {
            vault_id: "v".into(),
            provider: "custom".into(),
            cwd: String::new(),
            command: Some("my-agent".into()),
            prompt: Some("do things".into()),
            cols: 80,
            rows: 24,
        };
        let spec = build_agent_spec(
            &req,
            PathBuf::from("/vault"),
            String::new(),
            PathBuf::from("/vault"),
        )
        .unwrap();
        assert_eq!(spec.args[1], "my-agent");
        assert!(spec
            .env
            .iter()
            .any(|(k, v)| k == "SIMPLE_DIRECTORY_TASK" && v == "do things"));
    }
}
