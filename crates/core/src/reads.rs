//! The read paths the interface and agents call most: artifact views, the
//! artifact list, one artifact, and the dependency edges. Each runs a fixed
//! number of statements however large the project is.
use super::*;
use rusqlite::types::Type;
use rusqlite::{CachedStatement, Row};
use std::collections::{HashMap, HashSet};

/// Newest revision still in play (not rejected, not superseded) of artifact
/// `a`, as a scalar subquery.
pub(super) const HEAD_REVISION: &str = "(SELECT l.id FROM revision l WHERE l.artifact_id=a.id \
     AND l.review_state NOT IN ('rejected','superseded') ORDER BY l.seq DESC LIMIT 1)";

/// The revision that says what artifact `a` currently states: the approved
/// baseline, else the newest revision still in play, else the newest of any
/// state.
pub(super) fn current_revision_sql() -> String {
    format!(
        "COALESCE(a.selected_revision_id, {HEAD_REVISION}, \
         (SELECT l.id FROM revision l WHERE l.artifact_id=a.id ORDER BY l.seq DESC LIMIT 1))"
    )
}

/// Text longer than this is shortened in a brief `artifact.read`.
const LONG_TEXT_CHARS: usize = 4_000;
const LONG_TEXT_PREVIEW_CHARS: usize = 400;

#[cfg(test)]
thread_local! {
    static STATEMENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Prepare through the connection's statement cache. The read side prepares
/// every statement here, which is also where tests count them.
pub(super) fn statement<'a>(
    handle: &'a ProjectHandle,
    sql: &str,
) -> CoreResult<CachedStatement<'a>> {
    #[cfg(test)]
    STATEMENTS.with(|count| count.set(count.get() + 1));
    handle.db.prepare_cached(sql).map_err(internal)
}

/// How many statements `work` prepared on this thread.
#[cfg(test)]
pub(super) fn statements_during<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let before = STATEMENTS.with(std::cell::Cell::get);
    let result = work();
    (result, STATEMENTS.with(std::cell::Cell::get) - before)
}

fn json_column(row: &Row<'_>, index: usize) -> rusqlite::Result<Value> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

/// A quantity with its unit as people read it: four significant digits, the
/// range when one is recorded, and `unknown (reason)` for a value nobody has.
/// `None` when the value is not a quantity at all.
pub(super) fn format_quantity(quantity: &Value) -> Option<String> {
    if quantity["unknown"] == true {
        return Some(match quantity["reason"].as_str() {
            Some(reason) if !reason.is_empty() => format!("unknown ({reason})"),
            _ => "unknown".to_owned(),
        });
    }
    let value = quantity["value"].as_f64()?;
    let unit = quantity["unit"].as_str()?;
    let range = match (quantity["min"].as_f64(), quantity["max"].as_f64()) {
        (Some(min), Some(max)) => format!(" [{}–{}]", significant(min), significant(max)),
        _ => String::new(),
    };
    Some(format!("{}{range} {unit}", significant(value)))
}

/// Four significant digits without trailing zeros: 0.41237 → 0.4124, 300 → 300.
fn significant(value: f64) -> String {
    format!("{value:.3e}")
        .parse::<f64>()
        .map_or_else(|_| value.to_string(), |rounded| rounded.to_string())
}

/// `text` cut to `limit` characters on a character boundary, with an ellipsis
/// when something was cut.
pub(super) fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", text[..end].trim_end()),
        None => text.to_owned(),
    }
}

/// Whether a list or read returns whole revisions or headers only.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    Full,
    Summary,
}

impl Shape {
    /// What the caller asked for, else whole records for the interface and
    /// bounded ones for an agent.
    fn requested(asked: Option<&str>, lean: &str, origin: &Origin) -> Self {
        match asked {
            Some(value) if value == lean => Self::Summary,
            Some(_) => Self::Full,
            None if matches!(origin, Origin::Agent { .. }) => Self::Summary,
            None => Self::Full,
        }
    }
}

/// State every view needs beyond the artifact row itself, loaded once.
struct ViewState {
    drafts: HashMap<String, i64>,
    pending: HashSet<String>,
    stale: HashMap<String, Vec<Value>>,
}

impl ViewState {
    /// `only` narrows the lookups to one artifact.
    fn load(handle: &ProjectHandle, only: Option<&str>) -> CoreResult<Self> {
        // The whole project is counted through the review-state index, which
        // reads no payload pages; one artifact through its own revisions. Only
        // open drafts count: a draft another revision was built on is history.
        let drafts = match only {
            Some(id) => draft_counts(
                handle,
                &format!(
                    "SELECT artifact_id, COUNT(*) FROM revision \
                     WHERE artifact_id=?1 AND {} GROUP BY artifact_id",
                    super::review::OPEN_DRAFT
                ),
                [id],
            )?,
            None => draft_counts(
                handle,
                &format!(
                    "SELECT artifact_id, COUNT(*) FROM revision WHERE {} GROUP BY artifact_id",
                    super::review::OPEN_DRAFT
                ),
                [],
            )?,
        };
        let mut stmt = statement(
            handle,
            "SELECT artifact_id, upstream_artifact_id, expected_revision_id, actual_revision_id, \
             path, reason, since_event_seq FROM stale WHERE ?1 IS NULL OR artifact_id=?1 \
             ORDER BY artifact_id, rowid",
        )?;
        let mut stale = HashMap::<String, Vec<Value>>::new();
        let rows = stmt
            .query_map([only], |row| {
                let path: String = row.get(4)?;
                Ok(json!({
                    "artifactId": row.get::<_, String>(0)?,
                    "upstreamArtifactId": row.get::<_, String>(1)?,
                    "expectedRevisionId": row.get::<_, Option<String>>(2)?,
                    "actualRevisionId": row.get::<_, Option<String>>(3)?,
                    "path": serde_json::from_str::<Value>(&path).unwrap_or_else(|_| json!([])),
                    "reason": row.get::<_, String>(5)?,
                    "sinceEventSeq": row.get::<_, i64>(6)?,
                }))
            })
            .map_err(internal)?;
        for row in rows {
            let record = row.map_err(internal)?;
            let id = record["artifactId"].as_str().unwrap_or_default().to_owned();
            stale.entry(id).or_default().push(record);
        }
        Ok(Self {
            drafts,
            pending: pending_artifacts(handle)?,
            stale,
        })
    }
}

fn draft_counts(
    handle: &ProjectHandle,
    sql: &str,
    params: impl rusqlite::Params,
) -> CoreResult<HashMap<String, i64>> {
    statement(handle, sql)?
        .query_map(params, |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(internal)?
        .collect::<rusqlite::Result<_>>()
        .map_err(internal)
}

/// Artifacts named by a proposal the human has not resolved yet.
fn pending_artifacts(handle: &ProjectHandle) -> CoreResult<HashSet<String>> {
    let mut stmt = statement(handle, "SELECT changes FROM proposal WHERE state='pending'")?;
    let mut pending = HashSet::new();
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    for row in rows {
        let changes: Value = serde_json::from_str(&row.map_err(internal)?).unwrap_or(Value::Null);
        pending.extend(
            changes
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|change| change["artifactId"].as_str().map(str::to_owned)),
        );
    }
    Ok(pending)
}

/// Columns of one view row: the artifact (0-6), its approved revision
/// (7-19), and the newest revision still in play (20-22).
fn view_columns(shape: Shape) -> String {
    let body = match shape {
        Shape::Full => "s.payload, s.content_hash, s.files, s.inputs",
        Shape::Summary => "NULL, NULL, NULL, NULL",
    };
    format!(
        "a.id, a.type, a.title, a.subsystem, a.selected_revision_id, a.archived, a.created_at, \
         s.id, s.artifact_id, s.parent_id, s.seq, s.origin, s.origin_detail, s.created_at, \
         {body}, s.rationale, s.review_state, h.id, h.seq, h.review_state"
    )
}

fn view_joins() -> String {
    format!(
        "LEFT JOIN revision s ON s.id=a.selected_revision_id \
         LEFT JOIN revision h ON h.id={HEAD_REVISION}"
    )
}

fn view_from_row(row: &Row<'_>, shape: Shape, state: &ViewState) -> rusqlite::Result<Value> {
    let id: String = row.get(0)?;
    let artifact = json!({
        "id": id,
        "type": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
        "subsystem": row.get::<_, Option<String>>(3)?,
        "selectedRevisionId": row.get::<_, Option<String>>(4)?,
        "archived": row.get::<_, i64>(5)? != 0,
        "createdAt": row.get::<_, String>(6)?,
    });
    let revision = match (row.get::<_, Option<String>>(7)?, shape) {
        (None, _) => Value::Null,
        (Some(revision_id), Shape::Full) => json!({
            "id": revision_id,
            "artifactId": row.get::<_, String>(8)?,
            "parentId": row.get::<_, Option<String>>(9)?,
            "seq": row.get::<_, i64>(10)?,
            "origin": row.get::<_, String>(11)?,
            "originDetail": row.get::<_, Option<String>>(12)?,
            "createdAt": row.get::<_, String>(13)?,
            "payload": json_column(row, 14)?,
            "contentHash": row.get::<_, String>(15)?,
            "files": json_column(row, 16)?,
            "inputs": json_column(row, 17)?,
            "rationale": row.get::<_, String>(18)?,
            "reviewState": row.get::<_, String>(19)?,
        }),
        // The header: which revision, who wrote it, when, and its review state.
        (Some(revision_id), Shape::Summary) => json!({
            "id": revision_id,
            "seq": row.get::<_, i64>(10)?,
            "origin": row.get::<_, String>(11)?,
            "createdAt": row.get::<_, String>(13)?,
            "reviewState": row.get::<_, String>(19)?,
        }),
    };
    let stale = state.stale.get(&id).cloned().unwrap_or_default();
    let freshness = if stale
        .iter()
        .any(|record| record["reason"] == "missing_input")
    {
        "missing_input"
    } else if stale.is_empty() {
        "current"
    } else {
        "stale"
    };
    let head = match row.get::<_, Option<String>>(20)? {
        Some(head) => json!({
            "id": head,
            "seq": row.get::<_, i64>(21)?,
            "reviewState": row.get::<_, String>(22)?,
        }),
        None => Value::Null,
    };
    let view = json!({
        "artifact": artifact,
        "revision": revision,
        "freshness": freshness,
        "staleReasons": stale,
        "draftCount": state.drafts.get(&id).copied().unwrap_or(0),
        "pendingProposal": state.pending.contains(&id),
        "head": head,
    });
    Ok(view)
}

fn one_view(handle: &ProjectHandle, id: &str, shape: Shape) -> CoreResult<Value> {
    let state = ViewState::load(handle, Some(id))?;
    let mut stmt = statement(
        handle,
        &format!(
            "SELECT {} FROM artifact a {} WHERE a.id=?1",
            view_columns(shape),
            view_joins()
        ),
    )?;
    stmt.query_row([id], |row| view_from_row(row, shape, &state))
        .optional()
        .map_err(internal)?
        .ok_or_else(|| ContractError::not_found("artifact", id, "artifact_list"))
}

/// The view of one artifact: header, approved revision, freshness, draft
/// count and whether a proposal is pending.
pub(super) fn artifact_view(handle: &ProjectHandle, artifact: &Value) -> CoreResult<Value> {
    one_view(handle, required_str(artifact, "id")?, Shape::Full)
}

/// Where a listing continues: the creation time and id of the last artifact
/// already returned. The id places the cursor among artifacts created in the
/// same millisecond.
fn parse_cursor(cursor: &str) -> CoreResult<(&str, &str)> {
    cursor
        .split_once('|')
        .filter(|(created_at, id)| !created_at.is_empty() && !id.is_empty())
        .ok_or_else(|| {
            ContractError::validation(format!("Unknown cursor: {cursor}")).with_repair(
                "Pass nextCursor exactly as the previous artifact_list result returned it, or omit cursor to start from the first artifact.",
            )
        })
}

/// One page of artifact views in creation order, with the total, whether
/// more follow, and the cursor and offset that continue the listing.
///
/// Creation order is `created_at`, then the row's insertion order (`rowid`):
/// artifacts created in the same millisecond keep the order they were
/// created in, on every call and across pages. (Their ids are random, so
/// ordering ties by id made the order change from run to run.) A cursor still
/// names the last artifact returned as `createdAt|id`; an id that names no
/// artifact created at that time continues with every artifact created at
/// that time, so a page is never skipped.
pub(super) fn artifact_list(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let shape = Shape::requested(input["fields"].as_str(), "summary", origin);
    let kind = input["type"].as_str();
    let subsystem = input["subsystem"].as_str();
    let archived = input["includeArchived"].as_bool().unwrap_or(false) as i64;
    let limit = input["limit"].as_i64().unwrap_or(200).max(1);
    let after = input["cursor"].as_str().map(parse_cursor).transpose()?;
    let offset = if after.is_some() {
        0
    } else {
        input["offset"].as_i64().unwrap_or(0)
    };
    let filter =
        "(?1 IS NULL OR type=?1) AND (?2 IS NULL OR subsystem=?2) AND (?3=1 OR archived=0)";
    let total: i64 = statement(
        handle,
        &format!("SELECT COUNT(*) FROM artifact WHERE {filter}"),
    )?
    .query_row(params![kind, subsystem, archived], |row| row.get(0))
    .map_err(internal)?;
    let state = ViewState::load(handle, None)?;
    // One row beyond the page tells whether the listing continues.
    let mut stmt = statement(
        handle,
        &format!(
            "SELECT {} FROM (SELECT *, rowid AS position FROM artifact WHERE {filter} \
             AND (?4 IS NULL OR (created_at, rowid) > (?4, \
               IFNULL((SELECT rowid FROM artifact WHERE id=?5 AND created_at=?4), -1))) \
             ORDER BY created_at, rowid LIMIT ?6 OFFSET ?7) a {} ORDER BY a.created_at, a.position",
            view_columns(shape),
            view_joins()
        ),
    )?;
    let mut artifacts = stmt
        .query_map(
            params![
                kind,
                subsystem,
                archived,
                after.map(|cursor| cursor.0),
                after.map(|cursor| cursor.1),
                limit + 1,
                offset
            ],
            |row| view_from_row(row, shape, &state),
        )
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let has_more = artifacts.len() as i64 > limit;
    artifacts.truncate(limit as usize);
    let next_cursor = artifacts.last().filter(|_| has_more).map(|last| {
        format!(
            "{}|{}",
            last["artifact"]["createdAt"].as_str().unwrap_or_default(),
            last["artifact"]["id"].as_str().unwrap_or_default()
        )
    });
    let next_offset = (has_more && after.is_none()).then(|| offset + artifacts.len() as i64);
    Ok(json!({
        "artifacts": artifacts,
        "total": total,
        "fields": if shape == Shape::Full { "full" } else { "summary" },
        "hasMore": has_more,
        "truncated": has_more,
        "nextCursor": next_cursor,
        "nextOffset": next_offset,
    }))
}

/// Replace text too long for a bounded read with its length and opening
/// lines. The stand-in is an object, so it can never be written back as the
/// text it replaced.
fn shorten_long_text(value: &mut Value, path: &str, shortened: &mut Vec<String>) {
    match value {
        Value::String(text) if text.chars().nth(LONG_TEXT_CHARS).is_some() => {
            let stand_in = json!({
                "omitted": "long text",
                "chars": text.chars().count(),
                "preview": clip(text, LONG_TEXT_PREVIEW_CHARS),
            });
            shortened.push(path.to_owned());
            *value = stand_in;
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                shorten_long_text(item, &format!("{path}[{index}]"), shortened);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                shorten_long_text(item, &format!("{path}.{key}"), shortened);
            }
        }
        _ => {}
    }
}

fn revision_header(revision: &Value) -> Value {
    let mut header = revision.clone();
    if let Some(map) = header.as_object_mut() {
        for key in ["payload", "files", "inputs"] {
            map.remove(key);
        }
    }
    header
}

/// One artifact: its view, the revision asked for (else what it currently
/// states) and its open drafts. Brief reads shorten long text, do not repeat
/// the revision shown, and say what they shortened.
pub(super) fn artifact_read(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let id = required_str(input, "artifactId")?;
    let shape = Shape::requested(input["detail"].as_str(), "brief", origin);
    let view = one_view(handle, id, shape)?;
    let revision = match input["revisionId"].as_str() {
        Some(revision_id) => {
            let revision = require_revision(handle, revision_id)?;
            if revision["artifactId"] != id {
                return Err(
                    ContractError::validation("Revision does not belong to artifact").with_repair(
                        "Call artifact_history for this artifact to see its revision ids.",
                    ),
                );
            }
            Some(revision)
        }
        None => statement(
            handle,
            &format!(
                "SELECT r.* FROM artifact a JOIN revision r ON r.id={} WHERE a.id=?1",
                current_revision_sql()
            ),
        )?
        .query_row([id], revision_from_row)
        .optional()
        .map_err(internal)?,
    };
    // A draft another revision was built on is history, not open work.
    let mut drafts = statement(
        handle,
        &format!(
            "SELECT * FROM revision WHERE artifact_id=?1 AND {} ORDER BY seq",
            super::review::OPEN_DRAFT
        ),
    )?
    .query_map([id], revision_from_row)
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;
    if shape == Shape::Full {
        return Ok(json!({"view": view, "revision": revision, "drafts": drafts}));
    }
    let mut shortened = Vec::new();
    let mut revision = revision;
    if let Some(payload) = revision.as_mut().and_then(|r| r.get_mut("payload")) {
        shorten_long_text(payload, "revision.payload", &mut shortened);
    }
    let shown = revision.as_ref().map(|r| r["id"].clone());
    for (index, draft) in drafts.iter_mut().enumerate() {
        if Some(&draft["id"]) == shown.as_ref() {
            *draft = revision_header(draft);
        } else if let Some(payload) = draft.get_mut("payload") {
            shorten_long_text(payload, &format!("drafts[{index}].payload"), &mut shortened);
        }
    }
    let more = !shortened.is_empty();
    let mut result = json!({
        "view": view,
        "revision": revision,
        "drafts": drafts,
        "detail": "brief",
        "shortened": shortened,
    });
    if more {
        result["next"] = json!({
            "tool": "artifact_read",
            "why": "Pass detail \"full\" for the complete text",
            "args": {"artifactId": id, "detail": "full"},
        });
    }
    Ok(result)
}

/// Every dependency edge: the inputs each approved revision records, then the
/// links people or agents added by hand. Reads only the `inputs` column.
pub(super) fn graph_list(handle: &ProjectHandle) -> CoreResult<Value> {
    let mut edges = Vec::new();
    let mut stmt = statement(
        handle,
        "SELECT a.id, a.created_at, r.id, r.inputs FROM artifact a \
         JOIN revision r ON r.id=a.selected_revision_id AND r.artifact_id=a.id \
         ORDER BY a.created_at, a.id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                json!({"id": row.get::<_, String>(0)?, "createdAt": row.get::<_, String>(1)?}),
                json!({"id": row.get::<_, String>(2)?}),
                json_column(row, 3)?,
            ))
        })
        .map_err(internal)?;
    for row in rows {
        let (artifact, revision, inputs) = row.map_err(internal)?;
        for (index, input) in inputs.as_array().into_iter().flatten().enumerate() {
            edges.push(graph::input_edge(&artifact, &revision, input, index));
        }
    }
    let mut stmt = statement(
        handle,
        "SELECT * FROM edge WHERE required_upstream_revision_id IS NULL ORDER BY created_at, id",
    )?;
    let manual = stmt
        .query_map([], models::edge_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    edges.extend(manual);
    Ok(json!({"edges": edges}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{agent, requirement, seed, TestProject};

    fn listed(result: &Value) -> Vec<String> {
        result["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view["artifact"]["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn list_runs_the_same_five_statements_for_three_or_six_hundred_artifacts() {
        let mut small = TestProject::new();
        seed(small.handle(), 3);
        let mut large = TestProject::new();
        let expected = seed(large.handle(), 650);
        for input in [
            json!({"limit": 500}),
            json!({"limit": 500, "fields": "summary"}),
        ] {
            let (_, few) = statements_during(|| small.user("artifact.list", input.clone()));
            let (page, many) = statements_during(|| large.user("artifact.list", input.clone()));
            assert_eq!(few, 5);
            assert_eq!(many, 5, "statements must not grow with the project");
            assert_eq!(listed(&page), expected[..500]);
        }
    }

    #[test]
    fn full_views_identify_consecutive_drafts_when_the_baseline_and_count_stay_the_same() {
        let mut project = TestProject::new();
        let (artifact, baseline) = project.approved(
            "note",
            "Working note",
            json!({"markdown": "approved"}),
            json!([]),
        );
        let first = project.redraft(
            Origin::User,
            &artifact,
            json!({"payload": {"markdown": "first"}}),
        );
        let before = project.user("artifact.list", json!({}))["artifacts"][0].clone();
        let second = project.redraft(
            Origin::User,
            &artifact,
            json!({"payload": {"markdown": "second"}}),
        );
        let after = project.user("artifact.list", json!({}))["artifacts"][0].clone();
        assert_eq!(before["revision"]["id"], baseline);
        assert_eq!(after["revision"], before["revision"]);
        assert_eq!(before["draftCount"], 1);
        assert_eq!(after["draftCount"], 1);
        assert_eq!(before["head"]["id"], first);
        assert_eq!(after["head"]["id"], second);
        assert_ne!(before, after);
    }

    #[test]
    fn list_pages_through_every_artifact_in_a_stable_order() {
        let mut project = TestProject::new();
        let expected = seed(project.handle(), 650);

        let first = project.user("artifact.list", json!({"limit": 500}));
        assert_eq!(first["total"], 650);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["truncated"], true);
        assert_eq!(first["nextOffset"], 500);
        let rest = project.user("artifact.list", json!({"limit": 500, "offset": 500}));
        assert_eq!(rest["hasMore"], false);
        assert_eq!(rest["truncated"], false);
        assert!(rest["nextCursor"].is_null() && rest["nextOffset"].is_null());
        assert_eq!([listed(&first), listed(&rest)].concat(), expected);

        // By cursor, with a page size that splits artifacts created together.
        let mut seen = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let mut input = json!({"limit": 97, "fields": "summary"});
            if !cursor.is_null() {
                input["cursor"] = cursor.clone();
            }
            let page = project.user("artifact.list", input);
            seen.extend(listed(&page));
            cursor = page["nextCursor"].clone();
            assert_eq!(page["hasMore"], !cursor.is_null());
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(seen, expected);

        let filtered = project.user("artifact.list", json!({"type": "note", "limit": 500}));
        assert_eq!(filtered["total"], 162);
        assert_eq!(listed(&filtered).len(), 162);
        assert!(filtered["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|view| view["artifact"]["type"] == "note"));

        let bad = project
            .call(Origin::User, "artifact.list", json!({"cursor": "nonsense"}))
            .unwrap_err();
        assert_eq!(bad.code, "VALIDATION");
        assert!(bad.repair.unwrap().contains("nextCursor"));
    }

    /// Artifacts created within one millisecond list in the order they were
    /// created, on every call, by offset and by cursor, with page breaks
    /// inside the group. Their ids are random, so ordering them by id would
    /// change from project to project.
    #[test]
    fn artifacts_created_in_the_same_millisecond_keep_their_creation_order() {
        let mut project = TestProject::new();
        let created = (0..8)
            .map(|index| {
                let view = project.user(
                    "artifact.create_draft",
                    json!({"type": "note", "title": format!("Note {index}"), "payload": {"markdown": "text"}}),
                );
                view["artifact"]["id"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>();
        // As on a fast machine: one creation time for all eight.
        project
            .handle()
            .db
            .execute(
                "UPDATE artifact SET created_at='2026-10-14T12:00:00.123Z'",
                [],
            )
            .unwrap();

        for _ in 0..3 {
            let whole = project.user("artifact.list", json!({}));
            assert_eq!(listed(&whole), created);
            for limit in [1, 2, 3, 5] {
                let mut by_offset = Vec::new();
                let mut offset = Value::from(0);
                while !offset.is_null() {
                    let page =
                        project.user("artifact.list", json!({"limit": limit, "offset": offset}));
                    by_offset.extend(listed(&page));
                    offset = page["nextOffset"].clone();
                }
                assert_eq!(by_offset, created, "pages of {limit} by offset");

                let mut by_cursor = Vec::new();
                let mut cursor = Value::Null;
                loop {
                    let mut input = json!({"limit": limit});
                    if !cursor.is_null() {
                        input["cursor"] = cursor.clone();
                    }
                    let page = project.user("artifact.list", input);
                    by_cursor.extend(listed(&page));
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() {
                        break;
                    }
                    assert!(cursor
                        .as_str()
                        .unwrap()
                        .starts_with("2026-10-14T12:00:00.123Z|"));
                }
                assert_eq!(by_cursor, created, "pages of {limit} by cursor");
            }
        }

        // A cursor whose id names no artifact of that time repeats the
        // group rather than skipping it.
        let unknown = project.user(
            "artifact.list",
            json!({"cursor": "2026-10-14T12:00:00.123Z|00000000-0000-4000-8000-000000000000"}),
        );
        assert_eq!(listed(&unknown), created);
        let later = project.user(
            "artifact.list",
            json!({"cursor": "2026-10-14T12:00:00.124Z|00000000-0000-4000-8000-000000000000"}),
        );
        assert!(listed(&later).is_empty());
    }

    #[test]
    fn list_views_carry_drafts_proposals_and_freshness() {
        let mut project = TestProject::new();
        let expected = seed(project.handle(), 12);
        let page = project.user("artifact.list", json!({}));
        assert_eq!(page["fields"], "full");
        assert_eq!(listed(&page), expected);
        let titled = |title: &str| {
            page["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|view| view["artifact"]["title"] == title)
                .unwrap()
                .clone()
        };
        // The first seeded artifact has no baseline, a proposal and a stale input.
        let pending = titled("Seeded 0");
        assert!(pending["revision"].is_null());
        assert_eq!(pending["draftCount"], 4);
        assert_eq!(pending["pendingProposal"], true);
        assert_eq!(pending["freshness"], "stale");
        assert_eq!(pending["staleReasons"][0]["reason"], "input_changed");
        // The second has a baseline with three drafts on top.
        let approved = titled("Seeded 1");
        assert_eq!(approved["revision"]["reviewState"], "approved");
        assert_eq!(approved["revision"]["payload"]["seq"], 1);
        assert_eq!(approved["draftCount"], 3);
        assert_eq!(approved["pendingProposal"], false);
        assert_eq!(approved["freshness"], "current");

        // The list row and the single view are the same record.
        let read = project.user(
            "artifact.read",
            json!({"artifactId": approved["artifact"]["id"]}),
        );
        assert_eq!(read["view"], approved);
    }

    #[test]
    fn summary_fields_leave_out_payloads_and_are_what_an_agent_gets_by_default() {
        let mut project = TestProject::new();
        let (id, revision) = project.approved(
            "requirement",
            "Payload",
            requirement("Carry a 300 g camera"),
            json!([]),
        );
        let draft = project.redraft(
            agent("s1"),
            &id,
            json!({"payload": requirement("Carry a 500 g camera")}),
        );

        let full = project.user("artifact.list", json!({}));
        assert_eq!(
            full["artifacts"][0]["revision"]["payload"]["statement"],
            "Carry a 300 g camera"
        );
        // Full views also identify work beyond their baseline so two saves
        // with the same open-draft count still invalidate renderer caches.
        assert_eq!(full["artifacts"][0]["head"]["id"], draft);

        for summary in [
            project.user("artifact.list", json!({"fields": "summary"})),
            project.agent("s1", "artifact.list", json!({})),
        ] {
            assert_eq!(summary["fields"], "summary");
            let view = &summary["artifacts"][0];
            assert_eq!(view["artifact"]["id"], id.as_str());
            assert_eq!(view["revision"]["id"], revision.as_str());
            assert_eq!(view["revision"]["reviewState"], "approved");
            assert_eq!(
                view["revision"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
                ["id", "seq", "origin", "createdAt", "reviewState"]
            );
            assert_eq!(
                view["head"],
                json!({"id": draft, "seq": 2, "reviewState": "draft"})
            );
            assert_eq!(view["draftCount"], 1);
            assert_eq!(view["freshness"], "current");
        }
        let asked = project.agent("s1", "artifact.list", json!({"fields": "full"}));
        assert_eq!(asked["fields"], "full");
        assert!(asked["artifacts"][0]["revision"]["payload"].is_object());
    }

    #[test]
    fn read_names_the_listing_tool_for_ids_that_do_not_exist() {
        let mut project = TestProject::new();
        let (id, _) = project.draft(
            Origin::User,
            "note",
            "Note",
            json!({"markdown": "text"}),
            json!([]),
        );
        let (other, other_revision) = project.draft(
            Origin::User,
            "note",
            "Other",
            json!({"markdown": "text"}),
            json!([]),
        );
        let missing = uuid::Uuid::new_v4().to_string();

        let error = project
            .call(agent("s1"), "artifact.read", json!({"artifactId": missing}))
            .unwrap_err();
        assert_eq!(error.code, "NOT_FOUND");
        assert_eq!(error.message, format!("Artifact not found: {missing}"));
        assert!(error.repair.unwrap().contains("artifact_list"));
        assert_eq!(error.details.unwrap()["listingTool"], "artifact_list");

        let error = project
            .call(
                Origin::User,
                "artifact.read",
                json!({"artifactId": id, "revisionId": missing}),
            )
            .unwrap_err();
        assert_eq!(error.code, "NOT_FOUND");
        assert!(error.repair.unwrap().contains("artifact_history"));

        let error = project
            .call(
                Origin::User,
                "artifact.read",
                json!({"artifactId": id, "revisionId": other_revision}),
            )
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(other != id);
    }

    #[test]
    fn brief_read_keeps_open_drafts_and_shortens_long_text() {
        let mut project = TestProject::new();
        let long = "Design rationale. ".repeat(400);
        let (id, baseline) =
            project.approved("note", "Rationale", json!({"markdown": long}), json!([]));
        let second = project.redraft(
            agent("s1"),
            &id,
            json!({"baseRevisionId": baseline, "payload": {"markdown": "Second"}}),
        );
        let third = project.redraft(
            agent("s1"),
            &id,
            json!({"draftRevisionId": second, "payload": {"markdown": "Third"}}),
        );

        let full = project.user("artifact.read", json!({"artifactId": id}));
        assert_eq!(full["revision"]["payload"]["markdown"], long.as_str());
        assert_eq!(
            full["view"]["revision"]["payload"]["markdown"],
            long.as_str()
        );
        // The draft another draft was built on is history, in either shape.
        assert_eq!(full["drafts"].as_array().unwrap().len(), 1);
        assert_eq!(full["drafts"][0]["id"], third.as_str());
        assert_eq!(full["view"]["draftCount"], 1);
        assert!(full.get("detail").is_none());

        let brief = project.agent("s1", "artifact.read", json!({"artifactId": id}));
        assert_eq!(brief["detail"], "brief");
        assert_eq!(brief["drafts"].as_array().unwrap().len(), 1);
        assert_eq!(brief["drafts"][0]["id"], third.as_str());
        assert_eq!(brief["drafts"][0]["payload"]["markdown"], "Third");
        assert!(brief["view"]["revision"].get("payload").is_none());
        // Long text is replaced by something that cannot be saved back as text.
        let shortened = &brief["revision"]["payload"]["markdown"];
        assert_eq!(shortened["omitted"], "long text");
        assert_eq!(shortened["chars"], long.chars().count());
        assert!(shortened["preview"]
            .as_str()
            .unwrap()
            .starts_with("Design rationale."));
        assert_eq!(brief["shortened"], json!(["revision.payload.markdown"]));
        assert_eq!(brief["next"]["tool"], "artifact_read");
        assert_eq!(brief["next"]["args"]["detail"], "full");
        let rejected = project
            .call(
                agent("s1"),
                "artifact.update_draft",
                json!({"artifactId": id, "payload": brief["revision"]["payload"]}),
            )
            .unwrap_err();
        assert_eq!(rejected.code, "VALIDATION");

        let asked = project.agent(
            "s1",
            "artifact.read",
            json!({"artifactId": id, "detail": "full"}),
        );
        assert_eq!(asked["revision"]["payload"]["markdown"], long.as_str());
        assert_eq!(asked["drafts"], full["drafts"]);

        // With nothing approved, the newest draft is the content and is not
        // repeated in full under drafts.
        let (fresh, fresh_revision) = project.draft(
            agent("s1"),
            "note",
            "Fresh",
            json!({"markdown": "Only draft"}),
            json!([]),
        );
        let brief = project.agent("s1", "artifact.read", json!({"artifactId": fresh}));
        assert_eq!(brief["revision"]["payload"]["markdown"], "Only draft");
        assert_eq!(brief["drafts"][0]["id"], fresh_revision.as_str());
        assert!(brief["drafts"][0].get("payload").is_none());
        assert!(brief.get("next").is_none());
    }

    #[test]
    fn graph_list_matches_the_graph_the_staleness_engine_uses() {
        let mut project = TestProject::new();
        let (need, need_revision) = project.approved(
            "requirement",
            "Payload",
            requirement("Carry a 300 g camera"),
            json!([]),
        );
        let (budget, _) = project.approved(
            "note",
            "Mass budget",
            json!({"markdown": "Budget"}),
            json!([{"artifactId": need, "revisionId": need_revision, "relationship": "derived_from", "label": "from need"}]),
        );
        let (plan, _) = project.approved(
            "note",
            "Test plan",
            json!({"markdown": "Plan"}),
            json!([
                {"artifactId": need, "relationship": "validates"},
                {"artifactId": budget, "relationship": "depends_on"}
            ]),
        );
        // A draft's inputs are not edges until the draft is approved.
        project.draft(
            Origin::User,
            "note",
            "Draft",
            json!({"markdown": "Draft"}),
            json!([{"artifactId": need, "relationship": "depends_on"}]),
        );
        project.user(
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": budget, "downstreamArtifactId": plan, "relationship": "connects_to", "label": "by hand"}]}),
        );

        let (listed, statements) = statements_during(|| project.user("graph.list", json!({})));
        assert_eq!(statements, 2);
        let edges = listed["edges"].as_array().unwrap().clone();
        assert_eq!(edges.len(), 4);
        assert_eq!(edges[0]["label"], "from need");
        assert_eq!(
            edges[0]["requiredUpstreamRevisionId"],
            need_revision.as_str()
        );
        assert_eq!(edges[3]["createdBy"], "user");
        assert_eq!(project.user("graph.list", json!({}))["edges"], json!(edges));

        let by_id = |edges: &[Value]| {
            let mut sorted = edges.to_vec();
            sorted.sort_by_key(|edge| edge["id"].as_str().unwrap().to_owned());
            sorted
        };
        let snapshot = graph::GraphSnapshot::load(project.handle(), &[]).unwrap();
        assert_eq!(by_id(&edges), by_id(&snapshot.edges));
    }

    #[test]
    fn quantities_keep_their_unit_range_and_unknown_reason() {
        for (quantity, text) in [
            (json!({"value": 0.3, "unit": "kg"}), Some("0.3 kg")),
            (json!({"value": 300, "unit": "g"}), Some("300 g")),
            (json!({"value": 0.412_37, "unit": "kg"}), Some("0.4124 kg")),
            (json!({"value": 1234.5678, "unit": "mm"}), Some("1235 mm")),
            (
                json!({"value": 5, "unit": "V", "min": 4.75, "max": 5.25}),
                Some("5 [4.75–5.25] V"),
            ),
            (
                json!({"unknown": true, "reason": "not measured"}),
                Some("unknown (not measured)"),
            ),
            (json!({"unknown": true, "reason": ""}), Some("unknown")),
            (json!({"value": 3}), None),
            (Value::Null, None),
        ] {
            assert_eq!(format_quantity(&quantity).as_deref(), text, "{quantity}");
        }
        assert_eq!(clip("naïve café", 5), "naïve…");
        assert_eq!(clip("short", 5), "short");
    }
}
