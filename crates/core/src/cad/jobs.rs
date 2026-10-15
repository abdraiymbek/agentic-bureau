//! Job rows for CAD work. A job is `running` from the moment the work is
//! planned until its result is committed, and every transition is announced
//! with `job.updated`, so the interface can show that a render or a check is
//! in progress and cancel it.
use super::*;
use rusqlite::Connection;

/// Longest log kept on a job row. The engine log is already bounded; this
/// keeps `job.list` small.
const MAX_LOG_CHARS: usize = 24_000;

#[derive(Default)]
pub(crate) struct Finish {
    pub tool_version: Option<String>,
    pub command: Option<String>,
    pub log: String,
    pub output_hashes: Value,
    pub error: Option<ContractError>,
    /// Replaces the recorded inputs when the finished work knows more than the request did.
    pub inputs: Option<Value>,
}

fn announce(handle: &ProjectHandle, job_id: &str, origin: &Origin) -> CoreResult<()> {
    let (status, kind, tool, inputs) = handle
        .db
        .query_row(
            "SELECT status,kind,tool,inputs FROM job WHERE id=?1",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(internal)?;
    let inputs: Value = serde_json::from_str(&inputs).unwrap_or(Value::Null);
    emit(
        handle,
        "job.updated",
        origin,
        json!({"jobId": job_id, "status": status, "kind": kind, "tool": tool,
            "artifactId": inputs["artifactId"], "revisionId": inputs["revisionId"]}),
    )?;
    Ok(())
}

fn insert(
    handle: &ProjectHandle,
    kind: &str,
    tool: &str,
    status: &str,
    inputs: &Value,
    input_hashes: &Value,
    origin: &Origin,
) -> CoreResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,'','{}',NULL,?7,?8,?9,NULL)",
        params![id, kind, tool, inputs.to_string(), input_hashes.to_string(), status, origin.session_id(), timestamp,
            (status == "running").then_some(&timestamp)]).map_err(internal)?;
    announce(handle, &id, origin)?;
    Ok(id)
}

/// Record work that starts now.
pub(crate) fn start(
    handle: &ProjectHandle,
    kind: &str,
    tool: &str,
    inputs: &Value,
    input_hashes: &Value,
    origin: &Origin,
) -> CoreResult<String> {
    insert(handle, kind, tool, "running", inputs, input_hashes, origin)
}

/// Record work that a background worker will pick up.
pub(crate) fn queue(
    handle: &ProjectHandle,
    kind: &str,
    tool: &str,
    inputs: &Value,
    input_hashes: &Value,
    origin: &Origin,
) -> CoreResult<String> {
    insert(handle, kind, tool, "queued", inputs, input_hashes, origin)
}

/// A worker takes a queued job. Fails when the job was cancelled first.
pub(crate) fn claim(handle: &ProjectHandle, job_id: &str, origin: &Origin) -> CoreResult<()> {
    let updated = handle
        .db
        .execute(
            "UPDATE job SET status='running',started_at=?1 WHERE id=?2 AND status='queued'",
            params![now(), job_id],
        )
        .map_err(internal)?;
    if updated != 1 {
        return Err(ContractError::new("CANCELLED", "Render was cancelled"));
    }
    announce(handle, job_id, origin)
}

/// Close a job that is still open. A job someone already cancelled or that a
/// restart marked interrupted keeps that status; the return value says
/// whether this call closed it.
pub(crate) fn finish(
    handle: &ProjectHandle,
    job_id: &str,
    status: &str,
    finish: Finish,
    origin: &Origin,
) -> CoreResult<bool> {
    let log = if finish.log.chars().count() > MAX_LOG_CHARS {
        let tail = finish
            .log
            .chars()
            .rev()
            .take(MAX_LOG_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        format!("… earlier output omitted …\n{tail}")
    } else {
        finish.log
    };
    let outputs = if finish.output_hashes.is_object() {
        finish.output_hashes
    } else {
        json!({})
    };
    let updated = handle.db.execute(
        "UPDATE job SET status=?1,log=?2,output_hashes=?3,error=?4,command=COALESCE(?5,command),tool_version=COALESCE(?6,tool_version),inputs=COALESCE(?7,inputs),finished_at=?8 WHERE id=?9 AND status IN ('queued','running')",
        params![status, log, outputs.to_string(),
            finish.error.as_ref().map(|error| json!({"code": error.code, "message": error.message}).to_string()),
            finish.command, finish.tool_version, finish.inputs.map(|inputs| inputs.to_string()), now(), job_id],
    ).map_err(internal)?;
    if updated == 1 {
        announce(handle, job_id, origin)?;
    }
    Ok(updated == 1)
}

/// Close a job because the work ended with `error`.
pub(crate) fn fail(
    handle: &ProjectHandle,
    job_id: &str,
    error: &ContractError,
    origin: &Origin,
) -> CoreResult<bool> {
    finish(
        handle,
        job_id,
        if error.code == "CANCELLED" {
            "cancelled"
        } else {
            "failed"
        },
        Finish {
            error: Some(error.clone()),
            ..Finish::default()
        },
        origin,
    )
}

/// Has any of these jobs been cancelled, or interrupted by a restart or a
/// closed project? A job that no longer exists counts as cancelled.
pub(crate) fn cancelled(db: &Connection, job_ids: &[String]) -> bool {
    job_ids.iter().any(|id| {
        db.query_row("SELECT status FROM job WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .is_ok_and(|status| {
            status.is_none_or(|status| matches!(status.as_str(), "cancelled" | "interrupted"))
        })
    })
}

pub(crate) fn read(handle: &ProjectHandle, job_id: &str) -> CoreResult<Value> {
    handle
        .db
        .query_row(
            "SELECT * FROM job WHERE id=?1",
            [job_id],
            models::job_from_row,
        )
        .map_err(internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("jobs"), "Jobs", "test").unwrap();
        (temp, handle)
    }

    fn events(handle: &ProjectHandle) -> Vec<Value> {
        let mut statement = handle
            .db
            .prepare("SELECT * FROM event WHERE type='job.updated' ORDER BY seq")
            .unwrap();
        let rows = statement.query_map([], event_from_row).unwrap();
        rows.map(|row| row.unwrap()["data"].clone()).collect()
    }

    #[test]
    fn a_job_announces_its_start_and_its_finish_with_what_it_is() {
        let (_temp, handle) = project();
        let origin = Origin::Agent {
            session_id: "s1".into(),
        };
        let id = start(
            &handle,
            "cad_render",
            "openscad",
            &json!({"artifactId": "a1", "revisionId": "r1", "params": {}}),
            &json!({"source": "abc"}),
            &origin,
        )
        .unwrap();
        let running = read(&handle, &id).unwrap();
        assert_eq!(running["status"], "running");
        assert_eq!(running["sessionId"], "s1");
        assert!(running["startedAt"].is_string() && running["finishedAt"].is_null());
        assert!(finish(
            &handle,
            &id,
            "succeeded",
            Finish {
                tool_version: Some("2026.09.18".into()),
                command: Some("openscad -o output.stl input.scad".into()),
                log: "rendered".into(),
                output_hashes: json!({"stl": "def"}),
                ..Finish::default()
            },
            &origin
        )
        .unwrap());
        let done = read(&handle, &id).unwrap();
        assert_eq!(done["status"], "succeeded");
        assert_eq!(done["toolVersion"], "2026.09.18");
        assert_eq!(done["outputHashes"], json!({"stl": "def"}));
        assert!(done["finishedAt"].is_string());
        // Agent-origin events also name the session that caused them.
        assert_eq!(
            events(&handle),
            vec![
                json!({"jobId": id, "status": "running", "kind": "cad_render", "tool": "openscad", "artifactId": "a1", "revisionId": "r1", "sessionId": "s1"}),
                json!({"jobId": id, "status": "succeeded", "kind": "cad_render", "tool": "openscad", "artifactId": "a1", "revisionId": "r1", "sessionId": "s1"}),
            ]
        );
    }

    #[test]
    fn a_cancelled_job_is_seen_by_the_worker_and_never_relabelled() {
        let (_temp, handle) = project();
        let id = start(
            &handle,
            "cad_check",
            "omenflow-geometry",
            &json!({}),
            &json!({}),
            &Origin::User,
        )
        .unwrap();
        assert!(!cancelled(&handle.db, std::slice::from_ref(&id)));
        simple::job_cancel(&handle, &json!({"jobId": id}), &Origin::User).unwrap();
        assert!(cancelled(&handle.db, std::slice::from_ref(&id)));
        let error = ContractError::new("CANCELLED", "Render was cancelled");
        assert!(!fail(&handle, &id, &error, &Origin::User).unwrap());
        assert_eq!(read(&handle, &id).unwrap()["status"], "cancelled");
        assert_eq!(events(&handle).len(), 2);
        assert!(cancelled(&handle.db, &["no-such-job".to_owned()]));
    }

    #[test]
    fn a_queued_job_runs_once_claimed_and_cannot_be_claimed_after_cancellation() {
        let (_temp, handle) = project();
        let id = queue(
            &handle,
            "cad_render",
            "openscad",
            &json!({}),
            &json!({}),
            &Origin::User,
        )
        .unwrap();
        assert!(read(&handle, &id).unwrap()["startedAt"].is_null());
        claim(&handle, &id, &Origin::User).unwrap();
        assert_eq!(read(&handle, &id).unwrap()["status"], "running");
        let error = ContractError::validation("Parser error");
        assert!(fail(&handle, &id, &error, &Origin::User).unwrap());
        let failed = read(&handle, &id).unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(
            failed["error"],
            json!({"code": "VALIDATION", "message": "Parser error"})
        );
        let other = queue(
            &handle,
            "cad_render",
            "openscad",
            &json!({}),
            &json!({}),
            &Origin::User,
        )
        .unwrap();
        simple::job_cancel(&handle, &json!({"jobId": other}), &Origin::User).unwrap();
        assert_eq!(
            claim(&handle, &other, &Origin::User).err().unwrap().code,
            "CANCELLED"
        );
    }

    #[test]
    fn a_long_log_keeps_its_end() {
        let (_temp, handle) = project();
        let id = start(
            &handle,
            "cad_render",
            "openscad",
            &json!({}),
            &json!({}),
            &Origin::User,
        )
        .unwrap();
        let log = format!("{}ERROR: last", "x".repeat(MAX_LOG_CHARS * 2));
        finish(
            &handle,
            &id,
            "failed",
            Finish {
                log,
                ..Finish::default()
            },
            &Origin::User,
        )
        .unwrap();
        let stored = read(&handle, &id).unwrap()["log"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(stored.starts_with("… earlier output omitted …"));
        assert!(stored.ends_with("ERROR: last"));
        assert!(stored.chars().count() < MAX_LOG_CHARS + 40);
    }
}
