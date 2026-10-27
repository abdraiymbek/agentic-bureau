//! Review lifecycle rules shared by drafts and proposals: which candidate may
//! replace a baseline, which drafts are still open, and which proposals a
//! newer one retires.

use crate::{
    emit, internal, models, now, record_decision, required_str, CoreResult, Decision, Origin,
    ProjectHandle,
};
use bureau_contracts::ContractError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Whether `ancestor_id` is `revision_id` itself or one of the revisions it
/// was built from.
fn descends_from(db: &Connection, revision_id: &str, ancestor_id: &str) -> CoreResult<bool> {
    db.query_row(
        "WITH RECURSIVE lineage(id) AS (
            SELECT ?1
            UNION
            SELECT r.parent_id FROM revision r JOIN lineage l ON r.id=l.id
            WHERE r.parent_id IS NOT NULL)
         SELECT EXISTS(SELECT 1 FROM lineage WHERE id=?2)",
        [revision_id, ancestor_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found != 0)
    .map_err(internal)
}

/// True when making `revision_id` the baseline would discard work: the
/// artifact's current baseline is not part of the candidate's lineage, so the
/// candidate was prepared without it.
pub(crate) fn overwrites_baseline(
    db: &Connection,
    artifact: &Value,
    revision_id: &str,
) -> CoreResult<bool> {
    match artifact["selectedRevisionId"].as_str() {
        Some(selected) => Ok(!descends_from(db, revision_id, selected)?),
        None => Ok(false),
    }
}

/// Whether `revision_id` is already part of the artifact's baseline: the
/// baseline itself or a revision it was built from. A person who accepted a
/// draft built on a proposed revision accepted that revision with it.
pub(crate) fn in_baseline(
    db: &Connection,
    artifact: &Value,
    revision_id: &str,
) -> CoreResult<bool> {
    match artifact["selectedRevisionId"].as_str() {
        Some(selected) => descends_from(db, selected, revision_id),
        None => Ok(false),
    }
}

/// Whether approving `change` now would act on a baseline the proposal was
/// not prepared against. A change whose candidate was built on top of the
/// newer baseline has not moved, whatever base it names, and neither has one
/// the baseline already contains.
pub(crate) fn base_moved(db: &Connection, artifact: &Value, change: &Value) -> CoreResult<bool> {
    if change["kind"] == "archive" {
        return Ok(artifact["selectedRevisionId"].as_str() != change["baseRevisionId"].as_str());
    }
    match change["newRevisionId"].as_str() {
        Some(revision_id) => Ok(!in_baseline(db, artifact, revision_id)?
            && overwrites_baseline(db, artifact, revision_id)?),
        None => Ok(false),
    }
}

/// Adds `baseMoved` to every change of a proposal. Only an open proposal can
/// have a moved base; a resolved one is history.
pub(crate) fn annotate_base_moved(handle: &ProjectHandle, proposal: &mut Value) -> CoreResult<()> {
    let open = is_open(&proposal["state"]);
    for change in proposal["changes"].as_array_mut().into_iter().flatten() {
        let moved = match (open, change["artifactId"].as_str()) {
            (true, Some(artifact_id)) => match artifact_by_id(&handle.db, artifact_id)? {
                Some(artifact) => base_moved(&handle.db, &artifact, change)?,
                None => false,
            },
            _ => false,
        };
        change["baseMoved"] = json!(moved);
    }
    Ok(())
}

pub(crate) fn is_open(state: &Value) -> bool {
    matches!(state.as_str(), Some("pending" | "changes_requested"))
}

fn artifact_by_id(db: &Connection, id: &str) -> CoreResult<Option<Value>> {
    db.query_row(
        "SELECT * FROM artifact WHERE id=?1",
        [id],
        models::artifact_from_row,
    )
    .optional()
    .map_err(internal)
}

/// `REVISION_CONFLICT` for a candidate that does not include the artifact's
/// current baseline. `repair` says what the caller should do about it.
pub(crate) fn baseline_conflict(
    message: impl Into<String>,
    artifact: &Value,
    change: &Value,
    repair: impl Into<String>,
) -> ContractError {
    let current = artifact["selectedRevisionId"].as_str().unwrap_or("");
    ContractError::revision_conflict(message, current)
        .with_repair(repair)
        .with_details(json!({
            "artifactId": artifact["id"],
            "currentRevisionId": artifact["selectedRevisionId"],
            "baseRevisionId": change["baseRevisionId"],
            "newRevisionId": change["newRevisionId"],
        }))
}

/// The newest revision of the artifact that is still a candidate, if any.
fn open_candidate(db: &Connection, artifact_id: &str) -> CoreResult<Option<String>> {
    db.query_row(
        "SELECT id FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed')
         ORDER BY seq DESC LIMIT 1",
        [artifact_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(internal)
}

/// Where work on an artifact continues when the caller names no revision:
/// the newest draft or revision under review that includes the current
/// baseline, else the baseline itself, else the newest revision in play.
/// Continuing from the baseline while such a draft is open would start a
/// second line and retire the first.
pub(crate) fn continuation(db: &Connection, artifact: &Value) -> CoreResult<Option<String>> {
    let artifact_id = required_str(artifact, "id")?;
    let mut stmt = db
        .prepare(
            "SELECT id FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed')
             ORDER BY seq DESC",
        )
        .map_err(internal)?;
    let candidates = stmt
        .query_map([artifact_id], |row| row.get::<_, String>(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let Some(selected) = artifact["selectedRevisionId"].as_str() else {
        return Ok(candidates.into_iter().next());
    };
    for candidate in candidates {
        if descends_from(db, &candidate, selected)? {
            return Ok(Some(candidate));
        }
    }
    Ok(Some(selected.to_owned()))
}

/// The open drafts of an artifact (see `OPEN_DRAFT`), as `(revision id, seq)`.
pub(crate) fn open_drafts(db: &Connection, artifact_id: &str) -> CoreResult<Vec<(String, i64)>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT id, seq FROM revision WHERE artifact_id=?1 AND {OPEN_DRAFT} ORDER BY seq"
        ))
        .map_err(internal)?;
    let rows = stmt
        .query_map([artifact_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(internal)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)
}

/// The drafts of `open` (taken before a new revision was written) that the
/// new revision retired, each as a sentence the caller can repeat.
pub(crate) fn retired_since(
    db: &Connection,
    open: &[(String, i64)],
    built_on: Option<i64>,
) -> CoreResult<Vec<String>> {
    let mut retired = Vec::new();
    for (id, seq) in open {
        let state: String = db
            .query_row(
                "SELECT review_state FROM revision WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(internal)?;
        if state == "superseded" {
            let base = built_on.map_or_else(|| "a new line".to_owned(), |seq| format!("r{seq}"));
            retired.push(format!(
                "Draft r{seq} ({id}) was retired: this revision was built on {base}, not on it. It stays in artifact_history."
            ));
        }
    }
    Ok(retired)
}

/// Whether a revision is still a draft or under review.
pub(crate) fn is_candidate(revision: &Value) -> bool {
    matches!(revision["reviewState"].as_str(), Some("draft" | "proposed"))
}

/// A revision can be proposed or accepted only while it is a candidate. The
/// error names the draft that replaced it when there is one.
pub(crate) fn assert_candidate(
    db: &Connection,
    artifact: &Value,
    revision: &Value,
) -> CoreResult<()> {
    if revision["artifactId"] != artifact["id"] {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    if is_candidate(revision) {
        return Ok(());
    }
    let state = revision["reviewState"].as_str().unwrap_or("unknown");
    let newest = open_candidate(db, required_str(artifact, "id")?)?;
    let repair = match &newest {
        Some(id) => format!("Use revision {id}, the newest open draft of this artifact."),
        None => "Save a new draft of the artifact and use that revision.".to_owned(),
    };
    Err(ContractError::validation(format!(
        "Only an active draft can be accepted; revision {} is {state}",
        revision["seq"]
    ))
    .with_repair(repair)
    .with_details(json!({
        "artifactId": artifact["id"],
        "revisionId": revision["id"],
        "reviewState": state,
        "openRevisionId": newest,
    })))
}

/// The open drafts of an artifact, as a condition on `revision`: drafts that
/// no later work continues from. Earlier steps of the same line stay in the
/// history but are not what a reader is asked to look at.
pub(crate) const OPEN_DRAFT: &str = "review_state='draft' AND NOT EXISTS (
    SELECT 1 FROM revision later WHERE later.parent_id=revision.id
      AND later.review_state IN ('draft','proposed','approved'))";

/// A new draft ends the other lines of draft work on its artifact: every
/// older draft it was not built from is retired, unless a revision still
/// under review was built from it. The steps a live candidate was built from
/// keep their state, because CAD verification follows that chain back to the
/// baseline it compares against and reads `superseded` as a former baseline.
pub(crate) fn retire_abandoned_drafts(
    db: &Connection,
    artifact_id: &str,
    revision_id: &str,
) -> CoreResult<()> {
    db.execute(
        "WITH RECURSIVE lineage(id) AS (
            SELECT ?2
            UNION
            SELECT id FROM revision WHERE artifact_id=?1 AND review_state='proposed'
            UNION
            SELECT r.parent_id FROM revision r JOIN lineage l ON r.id=l.id
            WHERE r.parent_id IS NOT NULL)
         UPDATE revision SET review_state='superseded'
         WHERE artifact_id=?1 AND review_state='draft'
           AND seq<(SELECT seq FROM revision WHERE id=?2)
           AND id NOT IN (SELECT id FROM lineage)",
        [artifact_id, revision_id],
    )
    .map_err(internal)?;
    Ok(())
}

/// A new baseline closes all draft work that came before it: the drafts it
/// was built from are part of it now, and the others were prepared against
/// the baseline it replaces.
pub(crate) fn retire_drafts_before(
    db: &Connection,
    artifact_id: &str,
    revision_id: &str,
) -> CoreResult<()> {
    db.execute(
        "UPDATE revision SET review_state='superseded'
         WHERE artifact_id=?1 AND review_state='draft' AND id!=?2
           AND seq<(SELECT seq FROM revision WHERE id=?2)",
        [artifact_id, revision_id],
    )
    .map_err(internal)?;
    Ok(())
}

/// The candidate of a proposal that has been replaced is no longer under
/// review. When live work was built on top of it, it becomes an earlier draft
/// of that work; otherwise it is retired.
fn release_from_review(db: &Connection, artifact_id: &str, revision_id: &str) -> CoreResult<()> {
    db.execute(
        "WITH RECURSIVE lineage(id) AS (
            SELECT id FROM revision
            WHERE artifact_id=?1 AND review_state IN ('draft','proposed') AND id!=?2
            UNION
            SELECT r.parent_id FROM revision r JOIN lineage l ON r.id=l.id
            WHERE r.parent_id IS NOT NULL)
         UPDATE revision
         SET review_state=CASE WHEN id IN (SELECT id FROM lineage) THEN 'draft' ELSE 'superseded' END
         WHERE id=?2 AND review_state='proposed'",
        [artifact_id, revision_id],
    )
    .map_err(internal)?;
    Ok(())
}

/// Lifecycle rules that follow from a recorded event. They run in the
/// recorder's transaction, so every module that commits a draft revision gets
/// them without calling anything else.
pub(crate) fn on_event(db: &Connection, event_type: &str, data: &Value) -> CoreResult<()> {
    if event_type == "revision.committed" && data["reviewState"] == "draft" {
        if let (Some(artifact_id), Some(revision_id)) =
            (data["artifactId"].as_str(), data["revisionId"].as_str())
        {
            retire_abandoned_drafts(db, artifact_id, revision_id)?;
        }
    }
    Ok(())
}

/// Open proposals that a change set over `artifact_ids` fully replaces: every
/// artifact they touch is in the set. With `older_than`, only proposals
/// submitted before that one count.
pub(crate) fn replaced_by(
    db: &Connection,
    artifact_ids: &HashSet<&str>,
    older_than: Option<&str>,
) -> CoreResult<Vec<Value>> {
    let mut stmt = db
        .prepare(
            "SELECT id,changes,reason,impact,state,created_by,created_by_session,created_at,resolved_at,resolution_rationale
             FROM proposal WHERE state IN ('pending','changes_requested')
               AND (?1 IS NULL OR (created_at,rowid)<(SELECT created_at,rowid FROM proposal WHERE id=?1))
             ORDER BY created_at,rowid",
        )
        .map_err(internal)?;
    let open = stmt
        .query_map([older_than], models::proposal_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(open
        .into_iter()
        .filter(|proposal| {
            proposal["changes"].as_array().is_some_and(|changes| {
                !changes.is_empty()
                    && changes.iter().all(|change| {
                        change["artifactId"]
                            .as_str()
                            .is_some_and(|id| artifact_ids.contains(id))
                    })
            })
        })
        .collect())
}

/// Open proposals that change only `artifact_id` and whose candidates the
/// new baseline `baseline_id` already contains. Accepting that baseline
/// answered them, so they leave the queue with the decision instead of
/// waiting as stale; their candidates are earlier steps of the baseline now.
/// Returns the ids of the proposals retired.
pub(crate) fn retire_answered(
    handle: &ProjectHandle,
    artifact_id: &str,
    baseline_id: &str,
) -> CoreResult<Vec<String>> {
    let mut retired = Vec::new();
    for proposal in replaced_by(&handle.db, &HashSet::from([artifact_id]), None)? {
        let changes = proposal["changes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut contained = true;
        for change in changes {
            contained &= change["kind"] != "archive"
                && match change["newRevisionId"].as_str() {
                    Some(id) => descends_from(&handle.db, baseline_id, id)?,
                    None => false,
                };
        }
        if !contained {
            continue;
        }
        let proposal_id = required_str(&proposal, "id")?;
        let rationale = format!(
            "Answered when revision {baseline_id}, which contains it, was accepted as the baseline"
        );
        let mut impact = if proposal["impact"].is_object() {
            proposal["impact"].clone()
        } else {
            json!({"affectedArtifactIds": [], "summary": proposal["reason"]})
        };
        impact["answeredByRevisionId"] = json!(baseline_id);
        handle
            .db
            .execute(
                "UPDATE proposal SET state='superseded',resolved_at=?1,impact=?2,
                 resolution_rationale=COALESCE(NULLIF(resolution_rationale,''),?3) WHERE id=?4",
                params![now(), impact.to_string(), rationale, proposal_id],
            )
            .map_err(internal)?;
        for change in changes {
            handle
                .db
                .execute(
                    "UPDATE revision SET review_state='superseded' WHERE id=?1 AND review_state='proposed'",
                    [required_str(change, "newRevisionId")?],
                )
                .map_err(internal)?;
        }
        let seq = emit(
            handle,
            "proposal.resolved",
            &Origin::User,
            json!({"proposalId": proposal_id, "state": "superseded", "answeredByRevisionId": baseline_id}),
        )?;
        record_decision(
            &handle.db,
            &Decision {
                proposal_id: Some(proposal_id),
                action: "superseded",
                actor: "user",
                rationale: &rationale,
                prior: &[],
                next: &[],
                event_seq: seq,
            },
        )?;
        retired.push(proposal_id.to_owned());
    }
    Ok(retired)
}

/// Retires `replaced` in favour of `replacement_id`. Their candidates leave
/// review unless the replacement proposes the same revision again. A
/// reviewer's requested-changes text stays on the retired proposal.
pub(crate) fn retire_replaced(
    handle: &ProjectHandle,
    replacement_id: &str,
    replaced: &[Value],
    kept_revision_ids: &HashSet<&str>,
    origin: &Origin,
) -> CoreResult<()> {
    for previous in replaced {
        let previous_id = required_str(previous, "id")?;
        let rationale = format!("Superseded by replacement proposal {replacement_id}");
        let mut impact = if previous["impact"].is_object() {
            previous["impact"].clone()
        } else {
            json!({"affectedArtifactIds": [], "summary": previous["reason"]})
        };
        impact["supersededByProposalId"] = json!(replacement_id);
        handle
            .db
            .execute(
                "UPDATE proposal SET state='superseded',resolved_at=?1,impact=?2,
                 resolution_rationale=COALESCE(NULLIF(resolution_rationale,''),?3) WHERE id=?4",
                params![now(), impact.to_string(), rationale, previous_id],
            )
            .map_err(internal)?;
        for change in previous["changes"].as_array().into_iter().flatten() {
            let revision_id = required_str(change, "newRevisionId")?;
            if !kept_revision_ids.contains(revision_id) {
                release_from_review(&handle.db, required_str(change, "artifactId")?, revision_id)?;
            }
        }
        let seq = emit(
            handle,
            "proposal.resolved",
            origin,
            json!({"proposalId": previous_id, "state": "superseded", "supersededByProposalId": replacement_id}),
        )?;
        record_decision(
            &handle.db,
            &Decision {
                proposal_id: Some(previous_id),
                action: "superseded",
                actor: origin.kind(),
                rationale: &rationale,
                prior: &[],
                next: &[],
                event_seq: seq,
            },
        )?;
    }
    Ok(())
}
