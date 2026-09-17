use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use simple_directory_core::{refresh_frontmatter, unix_now_secs, Vault};

use crate::commands::frontmatter_edit::{patch_source, valid_iso_date, valid_time};
use crate::commands::open::open_vault_cloned;
use crate::commands::paths;
use crate::commands::{projects, rename, vault};
use crate::error::SimpleDirectoryError;
use crate::events::EventSink;
use crate::state::AppState;

pub const CALENDAR_ROOT: &str = "Calendar";

#[derive(Debug, Clone, Deserialize)]
pub struct CalendarItemsRequest {
    pub vault_id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarEventDto {
    pub path: String,
    pub title: String,
    pub date: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarDeadlineDto {
    pub project: String,
    pub project_path: String,
    pub date: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarItemsResponse {
    pub events: Vec<CalendarEventDto>,
    pub deadlines: Vec<CalendarDeadlineDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventCreateRequest {
    pub vault_id: String,
    pub title: String,
    pub date: String,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventCreateResponse {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventUpdateRequest {
    pub vault_id: String,
    pub path: String,
    pub patch: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventUpdateResponse {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventDeleteRequest {
    pub vault_id: String,
    pub path: String,
}

fn fm_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

async fn frontmatter_by_file(
    vault: &Vault,
    prefix: &str,
) -> Result<BTreeMap<String, Map<String, Value>>, SimpleDirectoryError> {
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT file_path, key, value FROM frontmatter
             WHERE substr(file_path, 1, ?1) = ?2",
            libsql::params![prefix.len() as i64, prefix.to_string()],
        )
        .await?;
    let mut by_file: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    while let Some(row) = rows.next().await? {
        let file_path: String = row.get(0)?;
        let key: String = row.get(1)?;
        let raw: String = row.get(2)?;
        by_file
            .entry(file_path)
            .or_default()
            .insert(key, serde_json::from_str(&raw).unwrap_or(Value::String(raw)));
    }
    Ok(by_file)
}

fn validate_patch(patch: &mut Map<String, Value>) -> Result<(), SimpleDirectoryError> {
    const ALLOWED: &[&str] = &["title", "date", "start", "end", "project"];
    for (key, value) in patch.iter_mut() {
        if !ALLOWED.contains(&key.as_str()) {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "event_update may only set {ALLOWED:?}, not '{key}'",
            )));
        }
        if !value.is_null() && !value.is_string() {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "event field '{key}' must be a string or null",
            )));
        }
        match (key.as_str(), value.as_str()) {
            ("date", Some(v)) if !valid_iso_date(v) => {
                return Err(SimpleDirectoryError::InvalidRequest(format!(
                    "date '{v}' is not an ISO date (YYYY-MM-DD)",
                )));
            }
            ("start" | "end", Some(v)) if !valid_time(v) => {
                return Err(SimpleDirectoryError::InvalidRequest(format!(
                    "time '{v}' is not HH:MM",
                )));
            }
            ("project", Some(v)) => {
                *value = Value::String(projects::validate_event_project(v)?);
            }
            _ => {}
        }
    }
    Ok(())
}

fn slugify(title: &str) -> String {
    let slug: String = title
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let slug = slug.trim_matches('.');
    let mut out = slug.chars().take(60).collect::<String>();
    while out.ends_with(' ') || out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        "event".to_string()
    } else {
        out
    }
}

fn event_filename(date: &str, slug: &str) -> String {
    format!("{date} {slug}.md")
}

fn slug_of_path(rel: &str) -> Option<String> {
    let file = rel.rsplit('/').next()?;
    let stem = file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD"))?;
    if stem.len() > 11 && valid_iso_date(&stem[..10]) && stem.as_bytes()[10] == b' ' {
        Some(stem[11..].to_string())
    } else {
        Some(stem.to_string())
    }
}

fn event_dto(path: &str, fm: &Map<String, Value>) -> Option<CalendarEventDto> {
    if fm_string(fm, "type").as_deref() != Some("event") {
        return None;
    }
    let date = fm_string(fm, "date")?;
    if !valid_iso_date(&date) {
        return None;
    }
    Some(CalendarEventDto {
        path: path.to_string(),
        title: fm_string(fm, "title").unwrap_or_else(|| "Untitled".to_string()),
        date,
        start: fm_string(fm, "start").filter(|t| valid_time(t)),
        end: fm_string(fm, "end").filter(|t| valid_time(t)),
        project: fm_string(fm, "project"),
    })
}

pub async fn calendar_items(
    state: &AppState,
    req: CalendarItemsRequest,
) -> Result<CalendarItemsResponse, SimpleDirectoryError> {
    if !valid_iso_date(&req.from) || !valid_iso_date(&req.to) || req.from > req.to {
        return Err(SimpleDirectoryError::InvalidRequest(
            "calendar_items expects ISO dates with from <= to".into(),
        ));
    }
    let vault = open_vault_cloned(state, &req.vault_id).await?;

    let mut events = Vec::new();
    for (path, fm) in frontmatter_by_file(&vault, "Calendar/").await? {
        if let Some(dto) = event_dto(&path, &fm) {
            if dto.date >= req.from && dto.date <= req.to {
                events.push(dto);
            }
        }
    }
    events.sort_by(|a, b| a.date.cmp(&b.date).then(a.start.cmp(&b.start)));

    let mut deadlines = Vec::new();
    for (path, fm) in frontmatter_by_file(&vault, "Projects/").await? {
        if !path.ends_with(&format!("/{}", projects::PROJECT_DOC)) {
            continue;
        }
        let Some(date) = fm_string(&fm, "deadline") else {
            continue;
        };
        if !valid_iso_date(&date) || date < req.from || date > req.to {
            continue;
        }
        let project_path = path.trim_end_matches(&format!("/{}", projects::PROJECT_DOC));
        let project = project_path
            .rsplit('/')
            .next()
            .unwrap_or(project_path)
            .to_string();
        deadlines.push(CalendarDeadlineDto {
            project,
            project_path: project_path.to_string(),
            date,
            status: fm_string(&fm, "status").unwrap_or_else(|| "active".to_string()),
        });
    }
    deadlines.sort_by(|a, b| a.date.cmp(&b.date).then(a.project.cmp(&b.project)));

    Ok(CalendarItemsResponse { events, deadlines })
}

pub async fn event_create(
    state: &AppState,
    req: EventCreateRequest,
) -> Result<EventCreateResponse, SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let title = req.title.trim();
    if title.is_empty() {
        return Err(SimpleDirectoryError::InvalidRequest(
            "event title may not be empty".into(),
        ));
    }
    if !valid_iso_date(&req.date) {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "date '{}' is not an ISO date (YYYY-MM-DD)",
            req.date,
        )));
    }
    for t in [&req.start, &req.end].into_iter().flatten() {
        if !valid_time(t) {
            return Err(SimpleDirectoryError::InvalidRequest(format!(
                "time '{t}' is not HH:MM",
            )));
        }
    }
    let project = match &req.project {
        Some(p) => Some(projects::validate_event_project(p)?),
        None => None,
    };
    if let (Some(s), Some(e)) = (&req.start, &req.end) {
        if s >= e {
            return Err(SimpleDirectoryError::InvalidRequest(
                "event end must be after start".into(),
            ));
        }
    }

    let root_rel = CALENDAR_ROOT.to_string();
    let (_, root_abs) = paths::vault_dir(&vault, &root_rel)?;
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(&root_abs))
        .await
        .map_err(|e| SimpleDirectoryError::Io(format!("event_create task join error: {e}")))?
        .map_err(|e| SimpleDirectoryError::Io(e.to_string()))?;
    simple_directory_index::upsert_folder(vault.index(), &root_rel, unix_now_secs()).await?;

    let slug = slugify(title);
    let rel = vault::first_free_path(
        &root_rel,
        &vault.root().join(&root_rel),
        &format!("{} {}", req.date, slug),
        Some("md"),
    )?;

    let mut fm_lines = format!("type: event\ntitle: {}\ndate: {}", yaml_scalar(title), req.date);
    if let Some(s) = &req.start {
        fm_lines.push_str(&format!("\nstart: {s}"));
    }
    if let Some(e) = &req.end {
        fm_lines.push_str(&format!("\nend: {e}"));
    }
    if let Some(p) = &project {
        fm_lines.push_str(&format!("\nproject: {}", yaml_scalar(p)));
    }
    let notes = req.notes.as_deref().unwrap_or("").trim();
    let content = if notes.is_empty() {
        format!("---\n{fm_lines}\n---\n")
    } else {
        format!("---\n{fm_lines}\n---\n\n{notes}\n")
    };

    vault::create_empty_markdown(&vault, &rel).await?;
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id.clone(),
            path: rel.clone(),
            content: content.clone(),
            expected_seen_hash: None,
        },
    )
    .await?;
    if let Err(e) = refresh_frontmatter(&vault, &rel, &content).await {
        tracing::warn!(error = %e, "event_create: frontmatter refresh failed");
    }
    Ok(EventCreateResponse { path: rel })
}

fn yaml_scalar(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ' '))
        && !s.is_empty()
        && s.chars().any(|c| c.is_ascii_alphabetic())
    {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
    }
}

async fn read_text_at(vault: &Vault, rel: &str) -> Result<String, SimpleDirectoryError> {
    let (_, abs) = paths::vault_file(vault, rel)?;
    tokio::task::spawn_blocking(move || std::fs::read_to_string(abs))
        .await
        .map_err(|e| SimpleDirectoryError::Io(format!("read task join error: {e}")))?
        .map_err(|e| SimpleDirectoryError::Io(e.to_string()))
}

fn ensure_event_path(vault: &Vault, path: &str) -> Result<String, SimpleDirectoryError> {
    let (rel, abs) = paths::vault_file(vault, path)?;
    if !rel.starts_with("Calendar/") || !abs.is_file() {
        return Err(SimpleDirectoryError::InvalidRequest(format!(
            "not an event file: {rel}"
        )));
    }
    Ok(rel)
}

pub async fn event_update(
    state: &AppState,
    sink: &dyn EventSink,
    req: EventUpdateRequest,
) -> Result<EventUpdateResponse, SimpleDirectoryError> {
    let mut patch = req.patch.clone();
    validate_patch(&mut patch)?;
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let rel = ensure_event_path(&vault, &req.path)?;

    let mut target = rel.clone();
    if let Some(new_date) = patch.get("date").and_then(|v| v.as_str()) {
        let file = rel.rsplit('/').next().unwrap_or_default();
        let already_dated = file.len() > 10 && file.starts_with(new_date);
        if !already_dated {
            let slug = slug_of_path(&rel).unwrap_or_else(|| "event".to_string());
            let to = format!("{CALENDAR_ROOT}/{}", event_filename(new_date, &slug));
            if !vault.root().join(&to).exists() {
                rename::rename_file(
                    state,
                    sink,
                    crate::api::types::RenameFileRequest {
                        vault_id: req.vault_id.clone(),
                        from_path: rel.clone(),
                        to_path: to.clone(),
                    },
                )
                .await?;
                target = to;
            }
        }
    }

    let current = read_text_at(&vault, &target).await?;
    let patched = patch_source(&current, &patch);
    vault::write_file_text(
        state,
        crate::api::types::WriteFileTextRequest {
            vault_id: req.vault_id.clone(),
            path: target.clone(),
            content: patched.clone(),
            expected_seen_hash: None,
        },
    )
    .await?;
    if let Err(e) = refresh_frontmatter(&vault, &target, &patched).await {
        tracing::warn!(error = %e, "event_update: frontmatter refresh failed");
    }
    Ok(EventUpdateResponse { path: target })
}

pub async fn event_delete(
    state: &AppState,
    req: EventDeleteRequest,
) -> Result<(), SimpleDirectoryError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let rel = ensure_event_path(&vault, &req.path)?;
    vault::delete_path(
        state,
        crate::api::types::DeletePathRequest {
            vault_id: req.vault_id,
            path: rel,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::NoopEventSink;
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

    #[tokio::test]
    async fn create_writes_an_event_file_that_items_can_read_back() {
        let (dir, state) = state_with_vault("v1").await;
        let resp = event_create(
            &state,
            EventCreateRequest {
                vault_id: "v1".into(),
                title: "Design review".into(),
                date: "2026-03-04".into(),
                start: Some("09:30".into()),
                end: Some("10:30".into()),
                project: Some("Kineon".into()),
                notes: Some("bring sketches".into()),
            },
        )
        .await
        .expect("create");
        assert_eq!(resp.path, "Calendar/2026-03-04 Design review.md");
        assert!(dir.path().join(&resp.path).is_file());

        let items = calendar_items(
            &state,
            CalendarItemsRequest {
                vault_id: "v1".into(),
                from: "2026-03-01".into(),
                to: "2026-03-31".into(),
            },
        )
        .await
        .expect("items");
        assert_eq!(items.events.len(), 1);
        let ev = &items.events[0];
        assert_eq!(ev.title, "Design review");
        assert_eq!(ev.start.as_deref(), Some("09:30"));
        assert_eq!(ev.project.as_deref(), Some("Kineon"));

        let empty = calendar_items(
            &state,
            CalendarItemsRequest {
                vault_id: "v1".into(),
                from: "2026-04-01".into(),
                to: "2026-04-30".into(),
            },
        )
        .await
        .unwrap();
        assert!(empty.events.is_empty());
    }

    #[tokio::test]
    async fn create_validates_dates_times_and_ranges() {
        let (_dir, state) = state_with_vault("v1").await;
        let base = EventCreateRequest {
            vault_id: "v1".into(),
            title: "x".into(),
            date: "2026-01-01".into(),
            start: None,
            end: None,
            project: None,
            notes: None,
        };
        for (date, start, end) in [
            ("01-01-2026", None, None),
            ("2026-01-01", Some("9am"), None),
            ("2026-01-01", Some("10:00"), Some("09:00")),
        ] {
            let mut req = EventCreateRequest { ..base.clone() };
            req.date = date.into();
            req.start = start.map(str::to_string);
            req.end = end.map(str::to_string);
            assert!(event_create(&state, req).await.is_err(), "{date} {start:?} {end:?}");
        }
    }

    #[tokio::test]
    async fn update_renames_the_file_when_the_date_moves() {
        let (dir, state) = state_with_vault("v1").await;
        let created = event_create(
            &state,
            EventCreateRequest {
                vault_id: "v1".into(),
                title: "Review".into(),
                date: "2026-03-04".into(),
                start: None,
                end: None,
                project: None,
                notes: None,
            },
        )
        .await
        .unwrap();

        let mut patch = Map::new();
        patch.insert("date".to_string(), Value::String("2026-03-10".into()));
        patch.insert("title".to_string(), Value::String("Big review".into()));
        let resp = event_update(
            &state,
            &NoopEventSink,
            EventUpdateRequest {
                vault_id: "v1".into(),
                path: created.path.clone(),
                patch,
            },
        )
        .await
        .expect("update");
        assert_eq!(resp.path, "Calendar/2026-03-10 Review.md");
        assert!(!dir.path().join(&created.path).exists());
        assert!(dir.path().join(&resp.path).is_file());

        let items = calendar_items(
            &state,
            CalendarItemsRequest {
                vault_id: "v1".into(),
                from: "2026-03-09".into(),
                to: "2026-03-11".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(items.events.len(), 1);
        assert_eq!(items.events[0].title, "Big review");
    }

    #[tokio::test]
    async fn deadlines_from_projects_appear_as_items() {
        let (_dir, state) = state_with_vault("v1").await;
        projects::project_create(
            &state,
            projects::ProjectCreateRequest {
                vault_id: "v1".into(),
                name: "Kineon".into(),
                description: String::new(),
            },
        )
        .await
        .unwrap();
        projects::project_update(
            &state,
            projects::ProjectUpdateRequest {
                vault_id: "v1".into(),
                path: "Projects/Kineon".into(),
                patch: [("deadline".to_string(), Value::String("2026-03-15".into()))]
                    .into_iter()
                    .collect(),
            },
        )
        .await
        .unwrap();

        let items = calendar_items(
            &state,
            CalendarItemsRequest {
                vault_id: "v1".into(),
                from: "2026-03-01".into(),
                to: "2026-03-31".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(items.deadlines.len(), 1);
        assert_eq!(items.deadlines[0].project, "Kineon");
        assert_eq!(items.deadlines[0].date, "2026-03-15");
        assert_eq!(items.deadlines[0].project_path, "Projects/Kineon");
    }

    #[tokio::test]
    async fn delete_removes_the_event_file() {
        let (dir, state) = state_with_vault("v1").await;
        let created = event_create(
            &state,
            EventCreateRequest {
                vault_id: "v1".into(),
                title: "Gone".into(),
                date: "2026-03-04".into(),
                start: None,
                end: None,
                project: None,
                notes: None,
            },
        )
        .await
        .unwrap();
        event_delete(
            &state,
            EventDeleteRequest {
                vault_id: "v1".into(),
                path: created.path.clone(),
            },
        )
        .await
        .expect("delete");
        assert!(!dir.path().join(&created.path).exists());
    }
}
