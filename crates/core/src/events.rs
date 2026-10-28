//! Project events: each row records who caused it, and each row reaches the
//! interface exactly once however many threads forward events.

use crate::{event_from_row, internal, now, CoreResult};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::{Arc, Mutex, PoisonError};

thread_local! {
    static SESSION: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Runs `work` on behalf of an agent session, or of nobody when `session_id`
/// is `None`. Code that only passes the origin kind (`"agent"`) to the event
/// recorder still gets the session written into the event.
pub(crate) fn with_session<T>(session_id: Option<&str>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            SESSION.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(SESSION.with(|slot| slot.replace(session_id.map(str::to_owned))));
    work()
}

/// Appends one event and returns its sequence number. An agent-origin event
/// records its session in `data.sessionId`: the one given, else the session
/// the current call runs for.
pub(crate) fn record(
    db: &Connection,
    event_type: &str,
    origin: &str,
    session_id: Option<&str>,
    mut data: Value,
) -> CoreResult<i64> {
    if origin == "agent" {
        let session = session_id
            .map(str::to_owned)
            .or_else(|| SESSION.with(|slot| slot.borrow().clone()));
        if let (Some(session), Some(fields)) = (session, data.as_object_mut()) {
            fields.entry("sessionId").or_insert(json!(session));
        }
    }
    db.execute(
        "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,?2,?3,?4,?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            event_type,
            origin,
            now(),
            data.to_string()
        ],
    )
    .map_err(internal)?;
    Ok(db.last_insert_rowid())
}

/// An event as the interface receives it: the stored row plus its project.
pub(crate) fn tagged(mut event: Value, project_id: &str) -> Value {
    event["projectId"] = json!(project_id);
    event
}

/// How far one open project's events have been handed out. Every dispatch and
/// every background worker forwards through the same cursor, so an event that
/// was recorded during somebody else's call is still delivered once, and
/// never twice.
#[derive(Clone)]
pub(crate) struct Delivery(Arc<Mutex<i64>>);

impl Delivery {
    pub(crate) fn after(seq: i64) -> Self {
        Self(Arc::new(Mutex::new(seq)))
    }

    /// The events nobody has been handed yet, oldest first. They count as
    /// delivered once returned.
    pub(crate) fn take(&self, db: &Connection, project_id: &str) -> CoreResult<Vec<Value>> {
        let mut delivered = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let events = undelivered(db, project_id, *delivered)?;
        if let Some(last) = events.last().and_then(|event| event["seq"].as_i64()) {
            *delivered = last;
        }
        Ok(events)
    }

    /// `take`, passing each event to `sink` before another forwarder can
    /// overtake it. Used by workers that have no caller to return events to.
    pub(crate) fn forward(
        &self,
        db: &Connection,
        project_id: &str,
        sink: &dyn Fn(Value),
    ) -> CoreResult<()> {
        let mut delivered = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        for event in undelivered(db, project_id, *delivered)? {
            if let Some(seq) = event["seq"].as_i64() {
                *delivered = seq;
            }
            sink(event);
        }
        Ok(())
    }
}

fn undelivered(db: &Connection, project_id: &str, after: i64) -> CoreResult<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT * FROM event WHERE seq>?1 ORDER BY seq")
        .map_err(internal)?;
    let events = stmt
        .query_map([after], event_from_row)
        .map_err(internal)?
        .map(|event| event.map(|event| tagged(event, project_id)))
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bureau_storage::ProjectHandle;

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("project"), "Events", "test").unwrap();
        (temp, handle)
    }

    fn data_of(handle: &ProjectHandle, seq: i64) -> Value {
        let raw: String = handle
            .db
            .query_row("SELECT data FROM event WHERE seq=?1", [seq], |row| {
                row.get(0)
            })
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn agent_events_record_the_session_and_other_origins_do_not() {
        let (_temp, handle) = project();
        let explicit = record(&handle.db, "t", "agent", Some("s-1"), json!({"a": 1})).unwrap();
        assert_eq!(
            data_of(&handle, explicit),
            json!({"a": 1, "sessionId": "s-1"})
        );
        let scoped = with_session(Some("s-2"), || {
            record(&handle.db, "t", "agent", None, json!({})).unwrap()
        });
        assert_eq!(data_of(&handle, scoped)["sessionId"], "s-2");
        let user = with_session(Some("s-2"), || {
            record(&handle.db, "t", "user", None, json!({})).unwrap()
        });
        assert_eq!(data_of(&handle, user), json!({}));
        let unscoped = record(&handle.db, "t", "agent", None, json!({})).unwrap();
        assert_eq!(data_of(&handle, unscoped), json!({}));
        let kept = record(
            &handle.db,
            "t",
            "agent",
            Some("s-3"),
            json!({"sessionId": "recorded"}),
        )
        .unwrap();
        assert_eq!(data_of(&handle, kept)["sessionId"], "recorded");
    }

    #[test]
    fn the_session_scope_ends_with_the_call_even_when_nested() {
        with_session(Some("outer"), || {
            with_session(None, || {
                assert_eq!(SESSION.with(|slot| slot.borrow().clone()), None);
            });
            assert_eq!(
                SESSION.with(|slot| slot.borrow().clone()).as_deref(),
                Some("outer")
            );
        });
        assert_eq!(SESSION.with(|slot| slot.borrow().clone()), None);
    }

    #[test]
    fn two_forwarders_sharing_a_cursor_deliver_each_event_once_in_order() {
        let (_temp, handle) = project();
        let start: i64 = handle
            .db
            .query_row("SELECT COALESCE(MAX(seq),0) FROM event", [], |row| {
                row.get(0)
            })
            .unwrap();
        let delivery = Delivery::after(start);
        let worker = delivery.clone();
        let first = record(&handle.db, "a", "user", None, json!({})).unwrap();
        let second = record(&handle.db, "b", "user", None, json!({})).unwrap();
        let taken = delivery.take(&handle.db, "p-1").unwrap();
        assert_eq!(
            taken
                .iter()
                .map(|e| e["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![first, second]
        );
        assert!(taken.iter().all(|e| e["projectId"] == "p-1"));
        let third = record(&handle.db, "c", "user", None, json!({})).unwrap();
        let seen = std::cell::RefCell::new(Vec::new());
        worker
            .forward(&handle.db, "p-1", &|event| seen.borrow_mut().push(event))
            .unwrap();
        assert_eq!(seen.borrow().len(), 1);
        assert_eq!(seen.borrow()[0]["seq"], third);
        assert_eq!(seen.borrow()[0]["projectId"], "p-1");
        assert!(delivery.take(&handle.db, "p-1").unwrap().is_empty());
    }
}
