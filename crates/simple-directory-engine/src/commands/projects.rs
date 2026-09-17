use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use simple_directory_core::{refresh_frontmatter, unix_now_secs, Vault};

use crate::commands::frontmatter_edit::{patch_source, valid_iso_date};
use crate::commands::open::open_vault_cloned;
use crate::commands::paths;
use crate::commands::vault;
use crate::error::SimpleDirectoryError;
use crate::state::AppState;

pub const PROJECTS_ROOT: &str = "Projects";
pub const PROJECT_DOC: &str = "project.md";
const MAX_OVERVIEW_FILES: u32 = 400;
const MAX_TASKS: usize = 2_000;
const VALID_STATUSES: &[&str] = &["active", "paused", "done", "archived"];

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectsListRequest {
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub name: String,
    pub path: String,
    pub status: String,
    pub deadline: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectsListResponse {
    pub projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectOverviewRequest {
    pub vault_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectTaskDto {
    pub file: String,
    pub line: u32,
    pub text: String,
    pub done: bool,
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectFileDto {
    pub path: String,
    pub type_id: String,
    pub mtime_unix: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectEventDto {
    pub path: String,
    pub title: String,
    pub date: String,
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectOverviewResponse {
    pub name: String,
    pub path: String,
    pub status: String,
    pub deadline: Option<String>,
    pub description: String,
    pub project_file: Option<String>,
    pub tasks: Vec<ProjectTaskDto>,
    pub files: Vec<ProjectFileDto>,
    pub events: Vec<ProjectEventDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectCreateRequest {
    pub vault_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectCreateResponse {
    pub path: String,
    pub project_file: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectUpdateRequest {
    pub vault_id: String,
    pub path: String,
    pub patch: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectUpdateResponse {}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectSetTaskRequest {
    pub vault_id: String,
    pub file: String,
    pub offset: u32,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSetTaskResponse {}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectAddTaskRequest {
    pub vault_id: String,
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectAddTaskResponse {
    pub file: String,
    pub offset: u32,
}

fn validate_name(raw: &str) -> Result<String, SimpleDirectoryError> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(SimpleDirectoryError::InvalidRequest(
            "project name must be 1–100 characters".into(),
        ));
    }
    if name.starts_with('.') || name == ".." {
        return Err(SimpleDirectoryError::InvalidRequest(
            "project name may not start with '.'".into(),
        ));
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "project name '{name}' contains a character that is not safe in a path",
        )));
    }
    Ok(name.to_string())
}

pub(crate) fn validate_event_project(raw: &str) -> Result<String, SimpleDirectoryError> {
    let trimmed = raw.trim();
    let bare = trimmed
        .strip_prefix(&format!("{PROJECTS_ROOT}/"))
        .unwrap_or(trimmed);
    validate_name(bare)
}

fn project_name_of(rel: &str) -> Option<&str> {
    let mut parts = rel.split('/');
    if parts.next()? != PROJECTS_ROOT {
        return None;
    }
    let name = parts.next()?;
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn is_project_dir(rel: &str) -> bool {
    project_name_of(rel).is_some_and(|_| rel.matches('/').count() == 1)
}

fn doc_rel(dir_rel: &str) -> String {
    format!("{dir_rel}/{PROJECT_DOC}")
}

async fn frontmatter_map(
    vault: &Vault,
    rel: &str,
) -> Result<Map<String, Value>, SimpleDirectoryError> {
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT key, value FROM frontmatter WHERE file_path = ?1",
            libsql::params![rel.to_string()],
        )
        .await?;
    let mut map = Map::new();
    while let Some(row) = rows.next().await? {
        let key: String = row.get(0)?;
        let raw: String = row.get(1)?;
        map.insert(
            key,
            serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
        );
    }
    Ok(map)
}

fn fm_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn normalize_status(map: &Map<String, Value>) -> String {
    fm_string(map, "status")
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| VALID_STATUSES.contains(&s.as_str()))
        .unwrap_or_else(|| "active".to_string())
}

async fn project_names(vault: &Vault) -> Result<Vec<String>, SimpleDirectoryError> {
    let conn = vault.index().connection();
    let mut names = std::collections::BTreeSet::new();

    for folder in simple_directory_index::list_folders(vault.index()).await? {
        if is_project_dir(&folder) {
            if let Some(name) = project_name_of(&folder) {
                names.insert(name.to_string());
            }
        }
    }

    let prefix = format!("{PROJECTS_ROOT}/");
    let mut rows = conn
        .query(
            "SELECT path FROM files WHERE substr(path, 1, ?1) = ?2",
            libsql::params![prefix.len() as i64, prefix],
        )
        .await?;
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        if let Some(name) = project_name_of(&path) {
            names.insert(name.to_string());
        }
    }
    Ok(names.into_iter().collect())
}

fn summary_from(dir_rel: &str, name: &str, fm: &Map<String, Value>) -> ProjectSummary {
    ProjectSummary {
        name: name.to_string(),
        path: dir_rel.to_string(),
        status: normalize_status(fm),
        deadline: fm_string(fm, "deadline"),
        description: fm_string(fm, "description").unwrap_or_default(),
    }
}

pub async fn projects_list(
    state: &AppState,
    req: ProjectsListRequest,
) -> Result<ProjectsListResponse, SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let names = project_names(&vault).await?;

    let mut projects = Vec::with_capacity(names.len());
    for name in names {
        let dir_rel = format!("{PROJECTS_ROOT}/{name}");
        let fm = frontmatter_map(&vault, &doc_rel(&dir_rel)).await?;
        projects.push(summary_from(&dir_rel, &name, &fm));
    }
    projects.sort_by_key(|p| p.name.to_lowercase());
    Ok(ProjectsListResponse { projects })
}

fn scan_tasks(rel: &str, content: &str, out: &mut Vec<ProjectTaskDto>) {
    let mut offset = 0usize;
    for (line_no, line) in content.split('\n').enumerate() {
        if out.len() >= MAX_TASKS {
            return;
        }
        let trimmed = line.trim_start();
        let rest = trimmed
            .strip_prefix('-')
            .or_else(|| trimmed.strip_prefix('*'))
            .or_else(|| trimmed.strip_prefix('+'))
            .and_then(|r| r.strip_prefix(' '));
        if let Some(after_dash) = rest {
            let bytes = after_dash.as_bytes();
            if bytes.len() >= 3
                && bytes[0] == b'['
                && bytes[2] == b']'
                && matches!(bytes[1], b' ' | b'x' | b'X')
            {
                let marker = offset + (line.len() - after_dash.len()) + 1;
                let done = bytes[1] != b' ';
                let text = after_dash[3..].trim().to_string();
                out.push(ProjectTaskDto {
                    file: rel.to_string(),
                    line: u32::try_from(line_no + 1).unwrap_or(u32::MAX),
                    text,
                    done,
                    offset: u32::try_from(marker).unwrap_or(u32::MAX),
                });
            }
        }
        offset += line.len() + 1;
    }
}

async fn read_text_at(vault: &Vault, rel: &str) -> Result<String, SimpleDirectoryError> {
    let (_, abs) = paths::vault_file(vault, rel)?;
    tokio::task::spawn_blocking(move || std::fs::read_to_string(abs))
        .await
        .map_err(|e| SimpleDirectoryError::Io(format!("read task join error: {e}")))?
        .map_err(|e| SimpleDirectoryError::Io(e.to_string()))
}

pub async fn project_overview(
    state: &AppState,
    req: ProjectOverviewRequest,
) -> Result<ProjectOverviewResponse, SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let (dir_rel, dir_abs) = paths::vault_dir(&vault, &req.path)?;
    if !is_project_dir(&dir_rel) || !dir_abs.is_dir() {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "not a project folder: {dir_rel}"
        )));
    }
    let name = project_name_of(&dir_rel).unwrap_or_default().to_string();
    let conn = vault.index().connection();
    let prefix = format!("{dir_rel}/");

    let mut rows = conn
        .query(
            "SELECT path, type_id, mtime_unix FROM files
             WHERE substr(path, 1, ?1) = ?2 ORDER BY path LIMIT ?3",
            libsql::params![
                prefix.len() as i64,
                prefix.clone(),
                i64::from(MAX_OVERVIEW_FILES)
            ],
        )
        .await?;
    let mut files: Vec<ProjectFileDto> = Vec::new();
    let mut md_paths: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        let type_id: String = row.get(1)?;
        let mtime_unix: i64 = row.get(2)?;
        if type_id == "markdown" {
            md_paths.push(path.clone());
        }
        files.push(ProjectFileDto {
            path,
            type_id,
            mtime_unix,
        });
    }

    let doc = doc_rel(&dir_rel);
    let project_file = files.iter().any(|f| f.path == doc).then_some(doc.clone());
    let fm = frontmatter_map(&vault, &doc).await?;

    let mut tasks: Vec<ProjectTaskDto> = Vec::new();
    for rel in md_paths {
        if tasks.len() >= MAX_TASKS {
            break;
        }
        match read_text_at(&vault, &rel).await {
            Ok(content) => scan_tasks(&rel, &content, &mut tasks),
            Err(e) => {
                tracing::warn!(path = %rel, error = %e, "project_overview: task scan skipped")
            }
        }
    }

    let mut rows = conn
        .query(
            "SELECT file_path, key, value FROM frontmatter
             WHERE substr(file_path, 1, 9) = 'Calendar/'",
            (),
        )
        .await?;
    let mut by_file: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    while let Some(row) = rows.next().await? {
        let file_path: String = row.get(0)?;
        let key: String = row.get(1)?;
        let raw: String = row.get(2)?;
        by_file.entry(file_path).or_default().insert(
            key,
            serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
        );
    }
    let mut events: Vec<ProjectEventDto> = Vec::new();
    for (path, fm) in by_file {
        if fm_string(&fm, "type").as_deref() != Some("event") {
            continue;
        }
        let owner = fm_string(&fm, "project").unwrap_or_default();
        if owner != name && owner != dir_rel {
            continue;
        }
        events.push(ProjectEventDto {
            path,
            title: fm_string(&fm, "title").unwrap_or_else(|| "Untitled".to_string()),
            date: fm_string(&fm, "date").unwrap_or_default(),
            start: fm_string(&fm, "start"),
            end: fm_string(&fm, "end"),
        });
    }
    events.sort_by(|a, b| a.date.cmp(&b.date).then(a.start.cmp(&b.start)));

    Ok(ProjectOverviewResponse {
        name: name.clone(),
        path: dir_rel.clone(),
        status: normalize_status(&fm),
        deadline: fm_string(&fm, "deadline"),
        description: fm_string(&fm, "description").unwrap_or_default(),
        project_file,
        tasks,
        files,
        events,
    })
}

pub async fn project_create(
    state: &AppState,
    req: ProjectCreateRequest,
) -> Result<ProjectCreateResponse, SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let name = validate_name(&req.name)?;

    for existing in project_names(&vault).await? {
        if simple_directory_index::names_eq_folded(&existing, &name) {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "a project named '{existing}' already exists",
            )));
        }
    }

    let dir_rel = format!("{PROJECTS_ROOT}/{name}");
    let (_, dir_abs) = paths::vault_dir(&vault, &dir_rel)?;
    let root_rel = PROJECTS_ROOT.to_string();
    let now = unix_now_secs();
    tokio::task::spawn_blocking({
        let abs = dir_abs.clone();
        move || std::fs::create_dir_all(abs)
    })
    .await
    .map_err(|e| SimpleDirectoryError::Io(format!("project_create task join error: {e}")))?
    .map_err(|e| SimpleDirectoryError::Io(e.to_string()))?;
    simple_directory_index::upsert_folder(vault.index(), &root_rel, now).await?;
    simple_directory_index::upsert_folder(vault.index(), &dir_rel, now).await?;

    let doc = doc_rel(&dir_rel);
    let description = req.description.trim();
    let mut content = format!("---\ntype: project\nstatus: active\n---\n\n# {name}\n");
    if !description.is_empty() {
        content.push_str(&format!("\n{description}\n"));
    }
    vault::create_empty_markdown(&vault, &doc).await?;
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id.clone(),
            path: doc.clone(),
            content: content.clone(),
            expected_seen_hash: None,
        },
    )
    .await?;
    if let Err(e) = refresh_frontmatter(&vault, &doc, &content).await {
        tracing::warn!(error = %e, "project_create: frontmatter refresh failed");
    }

    Ok(ProjectCreateResponse {
        path: dir_rel,
        project_file: doc,
    })
}

pub async fn project_update(
    state: &AppState,
    req: ProjectUpdateRequest,
) -> Result<ProjectUpdateResponse, SimpleDirectoryError> {
    const ALLOWED: &[&str] = &["status", "deadline", "description"];
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let (dir_rel, dir_abs) = paths::vault_dir(&vault, &req.path)?;
    if !is_project_dir(&dir_rel) || !dir_abs.is_dir() {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "not a project folder: {dir_rel}"
        )));
    }

    for (key, value) in &req.patch {
        if !ALLOWED.contains(&key.as_str()) {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "project_update may only set {ALLOWED:?}, not '{key}'",
            )));
        }
        if !value.is_null() && !value.is_string() {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "project field '{key}' must be a string or null",
            )));
        }
        match key.as_str() {
            "status" => {
                if let Some(s) = value.as_str() {
                    if !VALID_STATUSES.contains(&s) {
                        return Err(SimpleDirectoryError::InvalidRequest(format!(
                            "unknown status '{s}' (expected one of {VALID_STATUSES:?})",
                        )));
                    }
                }
            }
            "deadline" => {
                if let Some(d) = value.as_str() {
                    if !valid_iso_date(d) {
                        return Err(SimpleDirectoryError::InvalidRequest(format!(
                            "deadline '{d}' is not an ISO date (YYYY-MM-DD)",
                        )));
                    }
                }
            }
            _ => {}
        }
    }

    let doc = doc_rel(&dir_rel);
    if !vault.root().join(&doc).exists() {
        let name = project_name_of(&dir_rel).unwrap_or("Project");
        let content = format!("---\ntype: project\nstatus: active\n---\n\n# {name}\n");
        vault::create_empty_markdown(&vault, &doc).await?;
        vault::write_file_text(
            state,
            crate::api::types::WriteFileTextRequest {
                vault_id: req.vault_id.clone(),
                path: doc.clone(),
                content,
                expected_seen_hash: None,
            },
        )
        .await?;
    }

    let current = read_text_at(&vault, &doc).await?;
    let patched = patch_source(&current, &req.patch);
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id.clone(),
            path: doc.clone(),
            content: patched.clone(),
            expected_seen_hash: None,
        },
    )
    .await?;
    if let Err(e) = refresh_frontmatter(&vault, &doc, &patched).await {
        tracing::warn!(error = %e, "project_update: frontmatter refresh failed");
    }
    Ok(ProjectUpdateResponse {})
}

pub async fn project_set_task(
    state: &AppState,
    req: ProjectSetTaskRequest,
) -> Result<ProjectSetTaskResponse, SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let (rel, _) = paths::vault_file(&vault, &req.file)?;
    if project_name_of(&rel).is_none() || !rel.to_ascii_lowercase().ends_with(".md") {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "tasks live in markdown files under {PROJECTS_ROOT}/, not '{rel}'",
        )));
    }
    let content = read_text_at(&vault, &rel).await?;
    let offset = usize::try_from(req.offset).unwrap_or(usize::MAX);
    let marker = content.as_bytes().get(offset).copied();
    if !matches!(marker, Some(b' ' | b'x' | b'X')) {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "no checkbox at byte {offset} in '{rel}' — the file changed; reload the project",
        )));
    }
    let mut bytes = content.into_bytes();
    bytes[offset] = if req.done { b'x' } else { b' ' };
    let new_content = String::from_utf8(bytes).map_err(|_| {
        SimpleDirectoryError::InvalidRequest("task edit produced invalid UTF-8".into())
    })?;
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id,
            path: rel,
            content: new_content,
            expected_seen_hash: None,
        },
    )
    .await?;
    Ok(ProjectSetTaskResponse {})
}

pub async fn project_add_task(
    state: &AppState,
    req: ProjectAddTaskRequest,
) -> Result<ProjectAddTaskResponse, SimpleDirectoryError> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err(SimpleDirectoryError::InvalidRequest(
            "task text may not be empty".into(),
        ));
    }
    if text.contains('\n') || text.contains('\r') {
        return Err(SimpleDirectoryError::InvalidRequest(
            "task text must be a single line".into(),
        ));
    }
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let (dir_rel, dir_abs) = paths::vault_dir(&vault, &req.path)?;
    if !is_project_dir(&dir_rel) || !dir_abs.is_dir() {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "not a project folder: {dir_rel}"
        )));
    }

    let doc = doc_rel(&dir_rel);
    if !vault.root().join(&doc).exists() {
        let name = project_name_of(&dir_rel).unwrap_or("Project");
        let content = format!("---\ntype: project\nstatus: active\n---\n\n# {name}\n");
        vault::create_empty_markdown(&vault, &doc).await?;
        vault::write_file_text(
            state,
            crate::api::types::WriteFileTextRequest {
                vault_id: req.vault_id.clone(),
                path: doc.clone(),
                content: content.clone(),
                expected_seen_hash: None,
            },
        )
        .await?;
        if let Err(e) = refresh_frontmatter(&vault, &doc, &content).await {
            tracing::warn!(error = %e, "project_add_task: frontmatter refresh failed");
        }
    }

    let current = read_text_at(&vault, &doc).await?;
    let mut next = current;
    if !next.ends_with('\n') {
        next.push('\n');
    }
    let offset = next.len() + 3;
    next.push_str("- [ ] ");
    next.push_str(text);
    next.push('\n');
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id,
            path: doc.clone(),
            content: next,
            expected_seen_hash: None,
        },
    )
    .await?;
    Ok(ProjectAddTaskResponse {
        file: doc,
        offset: u32::try_from(offset).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ScanStatusBackend;
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault(vault_id: &str) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            crate::state::OpenVault::new(
                vault.clone(),
                crate::search_handle::SearchHandle::open(&vault).await,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                simple_directory_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, state)
    }

    async fn scan(state: &AppState, vault_id: &str) {
        let vault = open_vault_cloned(state, vault_id).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        simple_directory_core::scan(
            vault,
            CancellationToken::new(),
            tx,
            simple_directory_core::NoScanSink,
        )
        .await
        .expect("scan");
        drain.await.unwrap();
    }

    #[tokio::test]
    async fn create_makes_folder_doc_and_listing() {
        let (dir, state) = state_with_vault("v1").await;
        let resp = project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "Kineon".into(),
                description: "gait analysis".into(),
            },
        )
        .await
        .expect("create");
        assert_eq!(resp.path, "Projects/Kineon");
        assert_eq!(resp.project_file, "Projects/Kineon/project.md");
        assert!(dir.path().join("Projects/Kineon/project.md").is_file());

        let list = projects_list(
            &state,
            ProjectsListRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .expect("list");
        assert_eq!(list.projects.len(), 1);
        assert_eq!(list.projects[0].name, "Kineon");
        assert_eq!(list.projects[0].status, "active");
    }

    #[tokio::test]
    async fn create_rejects_folded_and_invalid_names() {
        let (_dir, state) = state_with_vault("v1").await;
        project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "Omen".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();
        let err = project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "omen".into(),
                description: String::new(),
            },
        )
        .await
        .expect_err("folded duplicate");
        assert!(matches!(err, SimpleDirectoryError::InvalidRequest(_)));
        for bad in ["a/b", "a:b", ".hidden", "  ", ".."] {
            assert!(
                project_create(
                    &state,
                    ProjectCreateRequest {
                        vault_id: "v1".into(),
                        name: bad.into(),
                        description: String::new()
                    },
                )
                .await
                .is_err(),
                "name {bad:?} must be rejected",
            );
        }
    }

    #[tokio::test]
    async fn update_patches_frontmatter_and_overview_sees_it() {
        let (_dir, state) = state_with_vault("v1").await;
        project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "Omen".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();

        project_update(
            &state,
            ProjectUpdateRequest {
                vault_id: "v1".into(),
                path: "Projects/Omen".into(),
                patch: [
                    ("status".to_string(), Value::String("done".into())),
                    ("deadline".to_string(), Value::String("2026-04-01".into())),
                ]
                .into_iter()
                .collect(),
            },
        )
        .await
        .expect("update");

        let over = project_overview(
            &state,
            ProjectOverviewRequest {
                vault_id: "v1".into(),
                path: "Projects/Omen".into(),
            },
        )
        .await
        .expect("overview");
        assert_eq!(over.status, "done");
        assert_eq!(over.deadline.as_deref(), Some("2026-04-01"));

        let list = projects_list(
            &state,
            ProjectsListRequest {
                vault_id: "v1".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(list.projects[0].deadline.as_deref(), Some("2026-04-01"));
    }

    #[tokio::test]
    async fn update_rejects_bad_status_bad_date_and_foreign_keys() {
        let (_dir, state) = state_with_vault("v1").await;
        project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "P".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();
        for patch in [
            [("status".to_string(), json("nope"))],
            [("deadline".to_string(), json("April"))],
            [("evil".to_string(), json("x"))],
        ] {
            assert!(project_update(
                &state,
                ProjectUpdateRequest {
                    vault_id: "v1".into(),
                    path: "Projects/P".into(),
                    patch: patch.into_iter().collect(),
                },
            )
            .await
            .is_err());
        }
    }

    fn json(s: &str) -> Value {
        Value::String(s.to_string())
    }

    #[tokio::test]
    async fn tasks_are_scanned_and_toggled() {
        let (dir, state) = state_with_vault("v1").await;
        project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "Omen".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();
        std::fs::write(
            dir.path().join("Projects/Omen/plan.md"),
            "# Plan\n\n- [ ] first task\n- [x] done task\nplain - [ ] not a task\n",
        )
        .unwrap();
        scan(&state, "v1").await;

        let over = project_overview(
            &state,
            ProjectOverviewRequest {
                vault_id: "v1".into(),
                path: "Projects/Omen".into(),
            },
        )
        .await
        .expect("overview");
        assert_eq!(over.tasks.len(), 2, "mid-line checkboxes are not tasks");
        let first = over.tasks.iter().find(|t| t.text == "first task").unwrap();
        assert!(!first.done);

        project_set_task(
            &state,
            ProjectSetTaskRequest {
                vault_id: "v1".into(),
                file: first.file.clone(),
                offset: first.offset,
                done: true,
            },
        )
        .await
        .expect("toggle");
        let content = std::fs::read_to_string(dir.path().join("Projects/Omen/plan.md")).unwrap();
        assert!(content.contains("- [x] first task"));
    }

    #[tokio::test]
    async fn set_task_rejects_stale_offset_and_foreign_files() {
        let (dir, state) = state_with_vault("v1").await;
        project_create(
            &state,
            ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "O".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();
        std::fs::write(dir.path().join("Projects/O/a.md"), "- [ ] t\n").unwrap();
        std::fs::write(dir.path().join("outside.md"), "- [ ] t\n").unwrap();
        scan(&state, "v1").await;

        assert!(
            project_set_task(
                &state,
                ProjectSetTaskRequest {
                    vault_id: "v1".into(),
                    file: "outside.md".into(),
                    offset: 2,
                    done: true
                },
            )
            .await
            .is_err(),
            "tasks outside Projects/ are not project tasks",
        );
        assert!(
            project_set_task(
                &state,
                ProjectSetTaskRequest {
                    vault_id: "v1".into(),
                    file: "Projects/O/a.md".into(),
                    offset: 999,
                    done: true
                },
            )
            .await
            .is_err(),
            "a stale offset must not write",
        );
    }
}
