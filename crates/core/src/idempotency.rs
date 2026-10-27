//! Replay of mutating calls sent with an idempotency key. A key answers a
//! retry of the same call with the first successful result. It never keeps a
//! failure, never stays blocked after an interruption, and is forgotten once
//! no retry can still be on its way.

use crate::{
    clear_result_journal, internal, now, read_result_journal, with_replay_marker,
    write_result_journal, CoreResult,
};
use bureau_contracts::ContractError;
use bureau_storage::ProjectHandle;
use chrono::{SecondsFormat, TimeDelta, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;

/// A key guards the retries of one call, which arrive within seconds or
/// minutes. A day keeps every realistic retry answerable.
const RETENTION_HOURS: i64 = 24;
/// Upper bound on stored results whatever their age.
const MAX_ROWS: i64 = 2_000;

pub(crate) fn request_hash(op: &str, payload: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(json!({"op":op,"payload":payload}).to_string().as_bytes())
    )
}

/// The recorded result for a retried call, or `None` when the call should
/// run. `instance` identifies this process: a reservation it made is still in
/// flight, one made by an earlier process was interrupted.
pub(crate) fn replay(
    handle: &ProjectHandle,
    key: &str,
    hash: &str,
    instance: &str,
) -> CoreResult<Option<Value>> {
    let Some((prior_hash, response)) = handle
        .db
        .query_row(
            "SELECT request_hash,response FROM idempotency WHERE key=?1",
            [key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(internal)?
    else {
        return Ok(None);
    };
    if prior_hash != hash {
        return Err(
            ContractError::validation("Idempotency key reused with different payload")
                .with_repair("Send a new idempotencyKey with a call that differs from the first."),
        );
    }
    let prior: Value = serde_json::from_str(&response).map_err(internal)?;
    if prior["operationPending"] == true {
        if let Some(journal) = read_result_journal(&handle.root, key, hash) {
            store(handle, key, &journal)?;
            clear_result_journal(&handle.root, key);
            return Ok(Some(with_replay_marker(journal, true)));
        }
        if prior["instance"] == instance {
            return Err(ContractError::new(
                "BUSY",
                "The first call with this key is still running",
            )
            .with_repair("Wait for that call to return instead of sending it again."));
        }
        release(handle, key);
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "An earlier attempt of this call was interrupted before its result was recorded",
        )
        .with_repair(
            "Read the affected artifact or job to see whether the attempt took effect, then send the call again if it did not. The key is free to reuse.",
        ));
    }
    if prior.get("operationFailure").is_some() {
        // Written by a build that kept failures. A failure is not a result.
        release(handle, key);
        return Ok(None);
    }
    Ok(Some(with_replay_marker(prior, false)))
}

/// Marks the call as running under `key` and drops results too old to be
/// retried.
pub(crate) fn reserve(
    handle: &ProjectHandle,
    key: &str,
    hash: &str,
    instance: &str,
) -> CoreResult<()> {
    prune(handle)?;
    handle
        .db
        .execute(
            "INSERT INTO idempotency(key,request_hash,response,created_at) VALUES(?1,?2,?3,?4)",
            params![
                key,
                hash,
                json!({"operationPending":true,"instance":instance}).to_string(),
                now()
            ],
        )
        .map_err(internal)?;
    Ok(())
}

/// Records the successful result. The call has already committed, so nothing
/// here may turn it into a failure: the fsynced journal keeps the result
/// recoverable when the row cannot be written, and is removed once it can.
pub(crate) fn complete(handle: &ProjectHandle, key: &str, hash: &str, result: &Value) {
    let _ = write_result_journal(&handle.root, key, hash, result);
    if store(handle, key, result).is_ok() {
        clear_result_journal(&handle.root, key);
    }
}

/// Frees `key` after a failed or abandoned attempt so the same call can run
/// again.
pub(crate) fn release(handle: &ProjectHandle, key: &str) {
    let _ = handle
        .db
        .execute("DELETE FROM idempotency WHERE key=?1", [key]);
    clear_result_journal(&handle.root, key);
}

/// Closes a reservation with what the call did: a result is recorded for
/// replay, a failure or a panic frees the key. `handle` is `None` when the
/// call closed its own project. A panic continues to unwind afterwards.
pub(crate) fn settle(
    handle: Option<&ProjectHandle>,
    key: &str,
    hash: &str,
    outcome: std::thread::Result<CoreResult<Value>>,
) -> CoreResult<Value> {
    match outcome {
        Ok(Ok(result)) => {
            if let Some(handle) = handle {
                complete(handle, key, hash, &result);
            }
            Ok(result)
        }
        Ok(Err(error)) => {
            if let Some(handle) = handle {
                release(handle, key);
            }
            Err(error)
        }
        Err(panic) => {
            if let Some(handle) = handle {
                release(handle, key);
            }
            std::panic::resume_unwind(panic)
        }
    }
}

/// Run when a project opens: results journaled by a process that stopped
/// before recording them become replayable, and expired rows are dropped.
pub(crate) fn recover(handle: &ProjectHandle) -> CoreResult<()> {
    let dir = handle.root.join(".bureau/recovery/idempotency");
    if dir.is_dir() {
        for entry in fs::read_dir(&dir).map_err(internal)? {
            let path = entry.map_err(internal)?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let journal = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|journal| {
                    journal["key"].is_string()
                        && journal["requestHash"].is_string()
                        && !journal["response"].is_null()
                        && journal["response"]["operationPending"] != true
                });
            let Some(journal) = journal else {
                // Unreadable: set aside so it is not parsed again on every open.
                let _ = fs::rename(&path, path.with_extension("json.corrupt"));
                continue;
            };
            handle
                .db
                .execute(
                    "INSERT INTO idempotency(key,request_hash,response,created_at) VALUES(?1,?2,?3,?4)
                     ON CONFLICT(key) DO UPDATE SET request_hash=excluded.request_hash,response=excluded.response",
                    params![
                        journal["key"].as_str(),
                        journal["requestHash"].as_str(),
                        journal["response"].to_string(),
                        journal["writtenAt"].as_str().map(str::to_owned).unwrap_or_else(now)
                    ],
                )
                .map_err(internal)?;
            let _ = fs::remove_file(&path);
        }
    }
    prune(handle)
}

fn store(handle: &ProjectHandle, key: &str, result: &Value) -> CoreResult<()> {
    handle
        .db
        .execute(
            "UPDATE idempotency SET response=?1 WHERE key=?2",
            params![result.to_string(), key],
        )
        .map_err(internal)?;
    Ok(())
}

fn prune(handle: &ProjectHandle) -> CoreResult<()> {
    let cutoff = (Utc::now() - TimeDelta::hours(RETENTION_HOURS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    handle
        .db
        .execute("DELETE FROM idempotency WHERE created_at<?1", [cutoff])
        .map_err(internal)?;
    handle
        .db
        .execute(
            "DELETE FROM idempotency WHERE rowid IN (
                SELECT rowid FROM idempotency ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?1)",
            [MAX_ROWS],
        )
        .map_err(internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("project"), "Keys", "test").unwrap();
        (temp, handle)
    }

    fn rows(handle: &ProjectHandle) -> i64 {
        handle
            .db
            .query_row("SELECT COUNT(*) FROM idempotency", [], |row| row.get(0))
            .unwrap()
    }

    fn insert_aged(handle: &ProjectHandle, key: &str, response: Value, age_hours: i64) {
        let created =
            (Utc::now() - TimeDelta::hours(age_hours)).to_rfc3339_opts(SecondsFormat::Millis, true);
        handle
            .db
            .execute(
                "INSERT INTO idempotency(key,request_hash,response,created_at) VALUES(?1,'h',?2,?3)",
                params![key, response.to_string(), created],
            )
            .unwrap();
    }

    #[test]
    fn a_completed_call_replays_and_a_different_payload_is_refused() {
        let (_temp, handle) = project();
        assert_eq!(replay(&handle, "k", "h", "me").unwrap(), None);
        reserve(&handle, "k", "h", "me").unwrap();
        complete(&handle, "k", "h", &json!({"ok": true}));
        assert_eq!(
            replay(&handle, "k", "h", "me").unwrap(),
            Some(json!({"ok": true, "idempotent": true}))
        );
        let error = replay(&handle, "k", "other", "me").unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(error.repair.is_some());
    }

    #[test]
    fn a_call_still_running_in_this_process_is_busy_not_run_twice() {
        let (_temp, handle) = project();
        reserve(&handle, "k", "h", "me").unwrap();
        let error = replay(&handle, "k", "h", "me").unwrap_err();
        assert_eq!(error.code, "BUSY");
        assert_eq!(rows(&handle), 1);
    }

    #[test]
    fn an_interrupted_attempt_is_reported_once_and_then_the_key_is_free() {
        let (_temp, handle) = project();
        reserve(&handle, "k", "h", "previous process").unwrap();
        let error = replay(&handle, "k", "h", "me").unwrap_err();
        assert_eq!(error.code, "REVISION_CONFLICT");
        assert!(error.repair.unwrap().contains("free to reuse"));
        assert_eq!(replay(&handle, "k", "h", "me").unwrap(), None);
        // A reservation written by an older build carries no instance.
        insert_aged(&handle, "old", json!({"operationPending": true}), 0);
        assert_eq!(
            replay(&handle, "old", "h", "me").unwrap_err().code,
            "REVISION_CONFLICT"
        );
        assert_eq!(rows(&handle), 0);
    }

    #[test]
    fn an_interrupted_attempt_with_a_journaled_result_is_recovered() {
        let (_temp, handle) = project();
        reserve(&handle, "k", "h", "previous process").unwrap();
        write_result_journal(&handle.root, "k", "h", &json!({"revisionId": "r"})).unwrap();
        assert_eq!(
            replay(&handle, "k", "h", "me").unwrap(),
            Some(json!({"revisionId": "r", "idempotent": true, "recovered": true}))
        );
        assert_eq!(
            replay(&handle, "k", "h", "me").unwrap(),
            Some(json!({"revisionId": "r", "idempotent": true}))
        );
        assert!(read_result_journal(&handle.root, "k", "h").is_none());
    }

    #[test]
    fn a_failure_kept_by_an_older_build_is_not_replayed() {
        let (_temp, handle) = project();
        insert_aged(
            &handle,
            "k",
            json!({"operationFailure": {"code": "TOOL_MISSING", "message": "OpenSCAD not found"}}),
            0,
        );
        assert_eq!(replay(&handle, "k", "h", "me").unwrap(), None);
        assert_eq!(rows(&handle), 0);
    }

    #[test]
    fn release_frees_the_key_and_reserving_drops_expired_and_excess_rows() {
        let (_temp, handle) = project();
        reserve(&handle, "failed", "h", "me").unwrap();
        release(&handle, "failed");
        assert_eq!(rows(&handle), 0);
        insert_aged(&handle, "expired", json!({"ok": true}), RETENTION_HOURS + 1);
        insert_aged(&handle, "recent", json!({"ok": true}), 1);
        reserve(&handle, "new", "h", "me").unwrap();
        assert_eq!(replay(&handle, "expired", "h", "me").unwrap(), None);
        assert!(replay(&handle, "recent", "h", "me").unwrap().is_some());
        let tx = handle.db.unchecked_transaction().unwrap();
        for index in 0..MAX_ROWS + 50 {
            tx.execute(
                "INSERT INTO idempotency(key,request_hash,response,created_at) VALUES(?1,'h','{}',?2)",
                params![format!("bulk-{index}"), now()],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        reserve(&handle, "after bulk", "h", "me").unwrap();
        assert_eq!(rows(&handle), MAX_ROWS + 1);
        assert_eq!(
            replay(&handle, "after bulk", "h", "me").unwrap_err().code,
            "BUSY"
        );
    }

    #[test]
    fn a_call_that_fails_or_panics_frees_its_key_and_one_that_succeeds_keeps_its_result() {
        let (_temp, handle) = project();
        reserve(&handle, "failed", "h", "me").unwrap();
        let failed = settle(
            Some(&handle),
            "failed",
            "h",
            Ok(Err(ContractError::new(
                "TOOL_MISSING",
                "OpenSCAD not found",
            ))),
        );
        assert_eq!(failed.unwrap_err().code, "TOOL_MISSING");
        assert_eq!(replay(&handle, "failed", "h", "me").unwrap(), None);

        reserve(&handle, "panicked", "h", "me").unwrap();
        let panic = std::panic::catch_unwind(|| -> CoreResult<Value> { panic!("mid-call") });
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            settle(Some(&handle), "panicked", "h", panic)
        }));
        assert!(unwound.is_err(), "the panic keeps unwinding");
        assert_eq!(replay(&handle, "panicked", "h", "me").unwrap(), None);

        reserve(&handle, "done", "h", "me").unwrap();
        let done = settle(Some(&handle), "done", "h", Ok(Ok(json!({"ok": true}))));
        assert_eq!(done.unwrap(), json!({"ok": true}));
        assert_eq!(
            replay(&handle, "done", "h", "me").unwrap(),
            Some(json!({"ok": true, "idempotent": true}))
        );
        assert_eq!(rows(&handle), 1);
    }

    #[test]
    fn opening_folds_journaled_results_in_and_sets_unreadable_ones_aside() {
        let (_temp, handle) = project();
        write_result_journal(&handle.root, "k", "h", &json!({"ok": true})).unwrap();
        let dir = handle.root.join(".bureau/recovery/idempotency");
        fs::write(dir.join("broken.json"), b"{not json").unwrap();
        recover(&handle).unwrap();
        assert_eq!(
            replay(&handle, "k", "h", "me").unwrap(),
            Some(json!({"ok": true, "idempotent": true}))
        );
        assert!(dir.join("broken.json.corrupt").is_file());
        assert_eq!(
            fs::read_dir(&dir)
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().path().extension().unwrap() == "json")
                .count(),
            0
        );
    }
}
