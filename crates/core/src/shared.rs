//! The entry point every host uses to reach a shared `CoreApp`.
//!
//! An ordinary operation locks, dispatches and returns. An operation that
//! runs OpenSCAD or analyses a mesh holds the lock only to plan and to
//! commit: the engine and the mesh work run with the lock released, so reads,
//! other writes and `job.cancel` are served while a render is in progress.
//! When the work is done the lock is taken again, the inputs are confirmed
//! unchanged and the result is committed, or the call fails with
//! `INPUT_CHANGED` and nothing is written.
//!
//! Project events are handed out exactly once, as soon as the lock is
//! released after the step that recorded them, and each carries `projectId`.
//! A panic inside a dispatch is caught: the caller gets an `INTERNAL` error
//! and the application stays usable.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

/// Operations whose engine or mesh work runs outside the lock.
const STAGED: [&str; 8] = [
    "cad.write_source",
    "cad.patch_source",
    "cad.set_param",
    "cad.compose",
    "cad.inspect",
    "cad.check",
    "cad.validate_source",
    "cad.export",
];

/// Is this call's work staged? A STL or SCAD export is a quick copy that takes
/// the ordinary, idempotent path; only a STEP export runs the engine.
fn staged(op: &str, payload: &Value) -> bool {
    STAGED.contains(&op) && (op != "cad.export" || payload["format"] == "step")
}

/// Dispatch `op` on the shared application. Events recorded by the call go
/// to the hook installed with [`CoreApp::set_event_hook`], each once.
pub fn dispatch_shared(
    core: &Arc<Mutex<CoreApp>>,
    op: &str,
    payload: Value,
    origin: Origin,
    project_id: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<Value, ContractError> {
    let hook = lock(core).event_hook.clone();
    dispatch_shared_with_events(
        core,
        op,
        payload,
        origin,
        project_id,
        idempotency_key,
        &mut |event| {
            if let Some(hook) = &hook {
                hook(event);
            }
        },
    )
}

/// As [`dispatch_shared`], with the events of this call handed to
/// `on_event` instead of the application's hook. `on_event` is called on the
/// calling thread, outside the lock, in the order the events were recorded;
/// no event is given to any other call. Work that outlives the call (a
/// queued `cad.render`) reports through the application's hook.
pub fn dispatch_shared_with_events(
    core: &Arc<Mutex<CoreApp>>,
    op: &str,
    payload: Value,
    origin: Origin,
    project_id: Option<&str>,
    idempotency_key: Option<&str>,
    on_event: &mut dyn FnMut(Value),
) -> Result<Value, ContractError> {
    let mut deliver = |events: Vec<Value>| events.into_iter().for_each(&mut *on_event);
    let ordinary = |payload: Value, deliver: &mut dyn FnMut(Vec<Value>)| {
        let (result, events) = locked(core, project_id, |app| {
            app.dispatch_idempotent(op, payload, origin.clone(), project_id, idempotency_key)
        });
        deliver(events);
        result
    };
    if op == "cad.probe" || op == "tool.doctor" {
        // The two tools are probed side by side; neither waits for the other.
        let (openscad, python) = std::thread::scope(|scope| {
            let python = scope.spawn(|| python_probe_off_lock(core, op, &payload));
            let openscad = probe_off_lock(core, op, &payload);
            (
                openscad,
                python.join().unwrap_or_else(|_| Some(probe_stopped())),
            )
        });
        if openscad.is_none() && python.is_none() {
            return ordinary(payload, &mut deliver);
        }
        let (result, events) = locked(core, project_id, |app| {
            cad::with_probes(openscad, python, || {
                app.dispatch_idempotent(op, payload, origin.clone(), project_id, idempotency_key)
            })
        });
        deliver(events);
        return result;
    }
    if op == "cad.render" {
        let (queued, events) = locked(core, project_id, |app| {
            let (result, pipeline) = cad::planning(|| {
                app.dispatch_idempotent(op, payload, origin.clone(), project_id, idempotency_key)
            });
            let root = project_id.and_then(|id| app.project_root(id).ok());
            Ok((result?, pipeline, root, app.event_hook.clone()))
        });
        deliver(events);
        let (queued, pipeline, root, hook) = queued?;
        if let (Some(pipeline), Some(root), Some(project_id)) = (pipeline, root, project_id) {
            let (core, project_id) = (core.clone(), project_id.to_owned());
            std::thread::spawn(move || {
                background(
                    &core,
                    &project_id,
                    &root,
                    pipeline,
                    &origin,
                    hook.as_deref(),
                )
            });
        }
        return Ok(queued);
    }
    if !staged(op, &payload) {
        return ordinary(payload, &mut deliver);
    }

    // Plan under the lock. An idempotent replay needs no work at all.
    let (planned, events) = locked(core, project_id, |app| {
        if already_answered(app, op, &origin, project_id, idempotency_key) {
            return Ok(Planned::Replay);
        }
        let (result, pipeline) =
            cad::planning(|| app.dispatch(op, payload.clone(), origin.clone(), project_id));
        let answer = result?;
        Ok(match (pipeline, project_id) {
            (Some(pipeline), Some(id)) => Planned::Staged(pipeline, app.project_root(id)?),
            _ => Planned::Answered(answer),
        })
    });
    deliver(events);
    let (mut pipeline, root) = match planned? {
        Planned::Replay => return ordinary(payload, &mut deliver),
        Planned::Answered(answer) => return Ok(answer),
        Planned::Staged(pipeline, root) => (pipeline, root),
    };
    let job_ids = pipeline.job_ids();

    // Engine and mesh work, lock released.
    let computed = compute(&root, pipeline.as_mut());

    // Commit under the lock, through the ordinary idempotent path.
    let result = computed.and_then(|()| {
        let (result, events) = locked(core, project_id, |app| {
            let (result, unused) = cad::committing(pipeline, || {
                app.dispatch_idempotent(op, payload, origin.clone(), project_id, idempotency_key)
            });
            // A replay answered before the operation was reached.
            if let (Some(unused), Ok(_), Some((_, handle))) =
                (unused, &result, project(app, project_id))
            {
                let replayed = ContractError::new(
                    "CANCELLED",
                    "Not committed: an earlier call with this idempotency key already answered",
                );
                cad::abandon(handle, &unused.job_ids(), &replayed, &origin);
            }
            result
        });
        deliver(events);
        result
    });
    if let Err(error) = &result {
        deliver(close_jobs(core, project_id, &job_ids, error, &origin));
    }
    result
}

/// What planning a staged operation came to.
enum Planned {
    /// The idempotency key was used before; the stored answer will be replayed.
    Replay,
    /// The operation answered without staging; that answer stands.
    Answered(Value),
    Staged(Box<dyn cad::Pipeline>, PathBuf),
}

fn project<'a>(
    app: &'a CoreApp,
    project_id: Option<&'a str>,
) -> Option<(&'a str, &'a ProjectHandle)> {
    let id = project_id?;
    app.projects.get(id).map(|handle| (id, handle))
}

/// The lock, recovered if an earlier holder panicked. `CoreApp` keeps its
/// durable state in SQLite, where an interrupted transaction rolls back, so
/// the in-memory state behind a poisoned lock is still consistent.
fn lock(core: &Mutex<CoreApp>) -> MutexGuard<'_, CoreApp> {
    core.lock().unwrap_or_else(|poisoned| {
        core.clear_poison();
        poisoned.into_inner()
    })
}

fn panic_error(what: &str, panic: Box<dyn std::any::Any + Send>) -> ContractError {
    let detail = panic
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_owned());
    ContractError::new("INTERNAL", format!("{what} stopped unexpectedly: {detail}")).with_repair(
        "Nothing was committed by this call. Retry it; if it fails again, report the message.",
    )
}

/// Run `work` under the lock and return its result with the project events
/// it recorded. Only one thread holds the lock, so every event written
/// between taking and releasing it belongs to this call. The events are
/// taken through the project's delivery cursor, which also hands over
/// anything recorded outside a dispatch since the last delivery (a terminal
/// session's state, say), so no event is delivered twice or never.
fn locked<T>(
    core: &Mutex<CoreApp>,
    project_id: Option<&str>,
    work: impl FnOnce(&mut CoreApp) -> CoreResult<T>,
) -> (CoreResult<T>, Vec<Value>) {
    let mut app = lock(core);
    let result = catch_unwind(AssertUnwindSafe(|| work(&mut app)))
        .unwrap_or_else(|panic| Err(panic_error("The operation", panic)));
    let events = project_id
        .and_then(|id| app.events_since(id, 0).ok())
        .unwrap_or_default();
    (result, events)
}

/// Has this idempotency key already been used for this operation? Mirrors
/// the replay key of `dispatch_idempotent`; a mismatch only costs the
/// shortcut, because the commit step goes through `dispatch_idempotent`.
fn already_answered(
    app: &CoreApp,
    op: &str,
    origin: &Origin,
    project_id: Option<&str>,
    idempotency_key: Option<&str>,
) -> bool {
    let (Some(key), Some((_, handle))) = (
        idempotency_key.filter(|key| !key.is_empty()),
        project(app, project_id),
    ) else {
        return false;
    };
    let replay_key = format!("{}:{op}:{key}", origin.session_id().unwrap_or("user"));
    handle
        .db
        .query_row(
            "SELECT 1 FROM idempotency WHERE key=?1",
            [replay_key],
            |_| Ok(()),
        )
        .optional()
        .is_ok_and(|found| found.is_some())
}

/// A saved tool path, read under the lock for a moment.
fn tool_path(core: &Mutex<CoreApp>, tool: &str) -> Option<PathBuf> {
    lock(core)
        .dispatch(
            "settings.get",
            json!({"key": format!("toolPaths.{tool}")}),
            Origin::System,
            None,
        )
        .ok()
        .and_then(|setting| setting["value"].as_str().map(str::trim).map(PathBuf::from))
        .filter(|path| !path.as_os_str().is_empty())
}

/// Probe the engine before the lock is taken, when this call will ask for it.
fn probe_off_lock(core: &Mutex<CoreApp>, op: &str, payload: &Value) -> Option<Value> {
    if op == "tool.doctor"
        && payload["toolId"]
            .as_str()
            .is_some_and(|id| id != "openscad")
    {
        return None;
    }
    let configured = tool_path(core, "openscad");
    catch_unwind(|| cad::engine_probe(configured.as_deref()))
        .ok()?
        .ok()
}

fn probe_stopped() -> Value {
    json!({"available": false, "error": "The probe stopped unexpectedly"})
}

/// Probe the STEP converter before the lock is taken, when `tool.doctor` asks
/// for it. It is never probed under the lock: a cold `import OCP` takes seconds.
fn python_probe_off_lock(core: &Mutex<CoreApp>, op: &str, payload: &Value) -> Option<Value> {
    if op != "tool.doctor" || payload["toolId"].as_str().is_some_and(|id| id != "python") {
        return None;
    }
    let configured = tool_path(core, "python");
    Some(
        catch_unwind(|| cad::python_probe_for(configured.as_deref()))
            .unwrap_or_else(|_| probe_stopped()),
    )
}

/// The unlocked step. Cancellation is read through a second connection, so
/// `job.cancel` served by another thread stops the engine.
fn compute(root: &Path, pipeline: &mut dyn cad::Pipeline) -> CoreResult<()> {
    let job_ids = pipeline.job_ids();
    let watch = if job_ids.is_empty() {
        None
    } else {
        ProjectHandle::open_worker(root).ok()
    };
    let cancelled = || {
        watch
            .as_ref()
            .is_some_and(|watch| cad::jobs_cancelled(&watch.db, &job_ids))
    };
    catch_unwind(AssertUnwindSafe(|| {
        let workspace = cad::Workspace::new(root, pipeline.executable(), &cancelled)?;
        pipeline.compute(&workspace);
        Ok(())
    }))
    .unwrap_or_else(|panic| Err(panic_error("CAD work", panic)))
}

/// Close jobs left open by a call that failed, and return the events.
fn close_jobs(
    core: &Mutex<CoreApp>,
    project_id: Option<&str>,
    job_ids: &[String],
    error: &ContractError,
    origin: &Origin,
) -> Vec<Value> {
    if job_ids.is_empty() {
        return vec![];
    }
    locked(core, project_id, |app| {
        if let Some((_, handle)) = project(app, project_id) {
            cad::abandon(handle, job_ids, error, origin);
        }
        Ok(())
    })
    .1
}

/// A queued render: start the job, render with the lock released, commit,
/// and report every step through the application's event hook. It runs for
/// the session that queued it, as a dispatch does, so every event it records
/// names that session.
fn background(
    core: &Mutex<CoreApp>,
    project_id: &str,
    root: &Path,
    pipeline: Box<dyn cad::Pipeline>,
    origin: &Origin,
    hook: Option<&(dyn Fn(Value) + Send + Sync)>,
) {
    events::with_session(origin.session_id(), || {
        run_queued(core, project_id, root, pipeline, origin, hook)
    })
}

fn run_queued(
    core: &Mutex<CoreApp>,
    project_id: &str,
    root: &Path,
    mut pipeline: Box<dyn cad::Pipeline>,
    origin: &Origin,
    hook: Option<&(dyn Fn(Value) + Send + Sync)>,
) {
    let deliver = |events: Vec<Value>| {
        if let Some(hook) = hook {
            events.into_iter().for_each(hook);
        }
    };
    let job_ids = pipeline.job_ids();
    let on_project = |app: &mut CoreApp, work: &mut dyn FnMut(&ProjectHandle) -> CoreResult<()>| {
        let handle = app
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        work(handle)
    };
    let (begun, events) = locked(core, Some(project_id), |app| {
        on_project(app, &mut |handle| pipeline.begin(handle, origin))
    });
    deliver(events);
    let result = begun
        .and_then(|()| compute(root, pipeline.as_mut()))
        .and_then(|()| {
            let mut pipeline = Some(pipeline);
            let (committed, events) = locked(core, Some(project_id), |app| {
                on_project(app, &mut |handle| match pipeline.take() {
                    Some(pipeline) => pipeline.commit(handle, origin).map(|_| ()),
                    None => Ok(()),
                })
            });
            deliver(events);
            committed
        });
    if let Err(error) = &result {
        deliver(close_jobs(core, Some(project_id), &job_ids, error, origin));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::testing::*;
    use std::time::{Duration, Instant};

    const BOX: &str = "w = 20;\ncube([w, 10, 2]);\n";

    fn running(sandbox: &Sandbox, kind: &str) -> Vec<Value> {
        sandbox
            .jobs(kind)
            .into_iter()
            .filter(|job| job["status"] == "running")
            .collect()
    }

    fn kinds(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event["data"]["status"].as_str() {
                Some(status) => format!("{} {status}", event["type"].as_str().unwrap()),
                None => event["type"].as_str().unwrap().to_owned(),
            })
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn reads_and_writes_complete_while_a_render_is_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        let sandbox = Sandbox::with_engine(&engine.executable);
        let seen = Mutex::new(Vec::<Value>::new());
        let before = sandbox
            .core
            .lock()
            .unwrap()
            .latest_event_seq(&sandbox.project_id)
            .unwrap();
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                dispatch_shared_with_events(
                    &sandbox.core,
                    "cad.write_source",
                    json!({"title": "Held", "source": BOX}),
                    Origin::User,
                    Some(&sandbox.project_id),
                    None,
                    &mut |event| seen.lock().unwrap().push(event),
                )
            });
            wait_until("the engine to be running", || engine.renders() == 1);
            // The render is held open. Everything below is served meanwhile.
            let jobs = running(&sandbox, "cad_render");
            assert_eq!(jobs.len(), 1, "the interface can see the render running");
            assert_eq!(
                kinds(&seen.lock().unwrap()),
                vec!["job.updated running"],
                "the start of the job is announced before the render ends"
            );
            let listed = sandbox.call("artifact.list", json!({})).unwrap();
            assert!(listed["artifacts"].as_array().unwrap().is_empty());
            assert!(sandbox.call("project.summary", json!({})).is_ok());
            let (updated, others) =
                sandbox.call_with_events("project.update_intent", json!({"intent": "meanwhile"}));
            assert_eq!(updated.unwrap()["project"]["intent"], "meanwhile");
            assert_eq!(kinds(&others), vec!["project.intent_changed"]);
            assert!(!writer.is_finished(), "the render is still in progress");
            engine.release();
            let report = writer.join().unwrap().unwrap();
            assert_eq!(report["render"]["ok"], true, "{report}");
            assert_eq!(
                report["geometry"]["bounds"]["size"],
                json!([20.0, 10.0, 2.0])
            );
        });
        // The writer was given its own events, each once, and nobody else's.
        let seen = seen.into_inner().unwrap();
        assert_eq!(
            kinds(&seen),
            vec![
                "job.updated running",
                "revision.committed",
                "job.updated succeeded"
            ]
        );
        assert!(seen
            .iter()
            .all(|event| event["projectId"] == sandbox.project_id));
        let recorded = sandbox
            .call("project.changes_since", json!({"seq": before}))
            .unwrap()["events"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(recorded, seen.len() + 1);
    }

    #[test]
    fn a_real_render_does_not_block_reads() {
        if !engine_available() {
            return;
        }
        let sandbox = Sandbox::new();
        let slow = "$fn = 96;\nminkowski() {\n  cube([20, 20, 4]);\n  sphere(2);\n}\n";
        let mut reads_during_render = 0;
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                sandbox.call(
                    "cad.write_source",
                    json!({"title": "Rounded", "source": slow, "timeoutMs": 120_000}),
                )
            });
            while !writer.is_finished() {
                let started = Instant::now();
                let in_progress = !running(&sandbox, "cad_render").is_empty();
                sandbox.call("artifact.list", json!({})).unwrap();
                if in_progress && !writer.is_finished() {
                    reads_during_render += 1;
                    assert!(started.elapsed() < Duration::from_secs(5));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            let report = writer.join().unwrap().unwrap();
            assert_eq!(report["render"]["ok"], true, "{report}");
            assert!(report["geometry"]["triangles"].as_u64().unwrap() > 5_000);
        });
        assert!(
            reads_during_render > 0,
            "no read completed while OpenSCAD was rendering"
        );
    }

    #[cfg(unix)]
    #[test]
    fn job_cancel_stops_a_render_that_is_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        let sandbox = Sandbox::with_engine(&engine.executable);
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                sandbox.call_with_events(
                    "cad.write_source",
                    json!({"title": "Cancelled", "source": BOX}),
                )
            });
            wait_until("the engine to be running", || engine.renders() == 1);
            let job_id = running(&sandbox, "cad_render")[0]["id"].clone();
            let cancelled = sandbox
                .call("job.cancel", json!({"jobId": job_id}))
                .unwrap();
            assert_eq!(cancelled["job"]["status"], "cancelled");
            let started = Instant::now();
            let (result, events) = writer.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(10));
            let error = result.err().unwrap();
            assert_eq!(error.code, "CANCELLED");
            assert_eq!(kinds(&events), vec!["job.updated running"]);
        });
        let job = &sandbox.jobs("cad_render")[0];
        assert_eq!(job["status"], "cancelled");
        assert!(
            sandbox.call("artifact.list", json!({})).unwrap()["artifacts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        // The engine was stopped, not left to finish: nothing is rendered after release.
        engine.release();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!sandbox
            .root
            .join("artifacts/mechanical/cancelled.scad")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_part_that_changes_during_a_render_fails_with_input_changed_and_commits_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let part = sandbox
            .call(
                "cad.write_source",
                json!({"title": "Moving", "source": BOX}),
            )
            .unwrap();
        engine.hold();
        let newer = std::thread::scope(|scope| {
            let editor = scope.spawn(|| {
                sandbox.call(
                    "cad.set_param",
                    json!({"artifactId": part["artifactId"], "name": "w", "value": 30}),
                )
            });
            wait_until("the second render", || engine.renders() == 2);
            let newer = sandbox
                .call(
                    "artifact.update_draft",
                    json!({"artifactId": part["artifactId"], "rationale": "edited meanwhile"}),
                )
                .unwrap()["revision"]["id"]
                .clone();
            engine.release();
            let error = editor.join().unwrap().err().unwrap();
            assert_eq!(error.code, "INPUT_CHANGED");
            assert!(error
                .message
                .contains("\"Moving\" changed while this call was running"));
            assert!(error.repair.as_deref().unwrap().contains("cad_read_source"));
            let details = error.details.unwrap();
            assert_eq!(details["plannedRevisionId"], part["revisionId"]);
            assert_eq!(details["currentRevisionId"], newer);
            newer
        });
        let revisions = sandbox.revisions(&part["artifactId"]);
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[1]["id"], newer);
        let jobs = sandbox.jobs("cad_render");
        assert_eq!(jobs[0]["status"], "failed");
        assert_eq!(jobs[0]["error"]["code"], "INPUT_CHANGED");
        assert!(running(&sandbox, "cad_render").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_same_inputs_are_rendered_once_and_an_idempotent_retry_does_no_work() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        let sandbox = Sandbox::with_engine(&engine.executable);
        let write = |title: &str, key: Option<&str>| {
            dispatch_shared(
                &sandbox.core,
                "cad.write_source",
                json!({"title": title, "source": BOX}),
                Origin::User,
                Some(&sandbox.project_id),
                key,
            )
        };
        // Two callers ask for the same render at once: one engine run serves both.
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| write("One", None));
            wait_until("the engine to be running", || engine.renders() == 1);
            let second = scope.spawn(|| write("Two", None));
            wait_until("both jobs", || running(&sandbox, "cad_render").len() == 2);
            std::thread::sleep(Duration::from_millis(150));
            assert_eq!(engine.renders(), 1);
            engine.release();
            (
                first.join().unwrap().unwrap(),
                second.join().unwrap().unwrap(),
            )
        });
        assert_eq!(engine.renders(), 1);
        assert!(first["render"].get("cached").is_none());
        assert_eq!(second["render"]["cached"], true);
        // A retry with the same key replays the answer: no job, no render, no revision.
        let keyed = write("Three", Some("retry-1")).unwrap();
        let jobs = sandbox.jobs("cad_render").len();
        let replayed = write("Three", Some("retry-1")).unwrap();
        assert_eq!(replayed["revisionId"], keyed["revisionId"]);
        assert_eq!(replayed["idempotent"], true);
        assert_eq!(sandbox.jobs("cad_render").len(), jobs);
        assert_eq!(engine.renders(), 1);
        assert_eq!(
            engine.version_probes(),
            1,
            "the version is probed once per executable"
        );
        assert_eq!(
            sandbox.call("artifact.list", json!({})).unwrap()["artifacts"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_queued_render_reports_through_the_event_hook_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let hooked = Arc::new(Mutex::new(Vec::<Value>::new()));
        sandbox.core.lock().unwrap().set_event_hook(Arc::new({
            let hooked = hooked.clone();
            move |event| hooked.lock().unwrap().push(event)
        }));
        let part = sandbox
            .call(
                "cad.write_source",
                json!({"title": "Rendered", "source": BOX}),
            )
            .unwrap();
        assert_eq!(
            kinds(&hooked.lock().unwrap()),
            vec![
                "job.updated running",
                "revision.committed",
                "job.updated succeeded"
            ],
            "without a per-call sink, events go to the hook"
        );
        hooked.lock().unwrap().clear();
        engine.hold();
        let (queued, events) = sandbox.call_with_events(
            "cad.render",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "params": {"w": 30}}),
        );
        let queued = queued.unwrap();
        assert_eq!(queued["job"]["status"], "queued");
        assert_eq!(kinds(&events), vec!["job.updated queued"]);
        wait_until("the worker to start", || engine.renders() == 2);
        assert_eq!(kinds(&hooked.lock().unwrap()), vec!["job.updated running"]);
        engine.release();
        wait_until("the queued render", || {
            sandbox
                .call("job.read", json!({"jobId": queued["job"]["id"]}))
                .unwrap()["job"]["status"]
                == "succeeded"
        });
        wait_until("the last event", || hooked.lock().unwrap().len() == 3);
        std::thread::sleep(Duration::from_millis(100));
        let hooked = hooked.lock().unwrap();
        assert_eq!(
            kinds(&hooked),
            vec![
                "job.updated running",
                "revision.committed",
                "job.updated succeeded"
            ]
        );
        assert!(hooked
            .iter()
            .all(|event| event["projectId"] == sandbox.project_id));
        let revisions = sandbox.revisions(&part["artifactId"]);
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[1]["rationale"], "rendered source");
        assert_eq!(revisions[1]["payload"]["params"], json!({"w": 30}));
        assert_eq!(revisions[1]["payload"]["renderJobId"], queued["job"]["id"]);
    }

    /// Two new parts with one title render at the same time: the second
    /// takes a path of its own instead of reporting a conflict with a file it
    /// never read.
    #[cfg(unix)]
    #[test]
    fn two_new_parts_with_one_title_written_at_once_are_both_saved() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        let sandbox = Sandbox::with_engine(&engine.executable);
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                sandbox.call(
                    "cad.write_source",
                    json!({"title": "Bracket", "source": BOX}),
                )
            });
            wait_until("the first render", || engine.renders() == 1);
            let second = scope.spawn(|| {
                sandbox.call(
                    "cad.write_source",
                    json!({"title": "Bracket", "source": "w = 21;\ncube([w, 10, 2]);\n"}),
                )
            });
            wait_until("the second render", || engine.renders() == 2);
            engine.release();
            (first.join().unwrap(), second.join().unwrap())
        });
        let (first, second) = (first.unwrap(), second.unwrap());
        assert_ne!(first["artifactId"], second["artifactId"]);
        let paths = [&first["sourcePath"], &second["sourcePath"]];
        assert!(paths.contains(&&json!("artifacts/mechanical/bracket.scad")));
        assert_ne!(paths[0], paths[1]);
        for written in [&first, &second] {
            let path = sandbox.root.join(written["sourcePath"].as_str().unwrap());
            let source = fs::read_to_string(path).unwrap();
            let revision = sandbox.revision(&written["revisionId"]);
            assert_eq!(
                omenflow_storage::sha256_hex(source.as_bytes()),
                revision["payload"]["scad"]["sha256"].as_str().unwrap()
            );
        }
    }

    /// Two checks of one revision compute at the same time and commit in the
    /// opposite order to the one they were asked in. The result recorded last
    /// is the revision's state.
    #[cfg(unix)]
    #[test]
    fn the_check_committed_last_decides_whatever_order_checks_were_asked_in() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let part = sandbox
            .call("cad.write_source", json!({"title": "Race", "source": BOX}))
            .unwrap();
        let project_id = sandbox.project_id.as_str();
        let check = |size: Value| json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "expect": {"size": size}});
        let plan = |input: &Value| {
            locked(&sandbox.core, Some(project_id), |app| {
                let (result, pipeline) = cad::planning(|| {
                    app.dispatch("cad.check", input.clone(), Origin::User, Some(project_id))
                });
                result?;
                Ok(pipeline.expect("a check is staged"))
            })
            .0
            .unwrap()
        };
        let commit = |pipeline: Box<dyn cad::Pipeline>, input: &Value| {
            locked(&sandbox.core, Some(project_id), |app| {
                cad::committing(pipeline, || {
                    app.dispatch("cad.check", input.clone(), Origin::User, Some(project_id))
                })
                .0
            })
            .0
            .unwrap()
        };
        // The stand-in mesh is 20 × 10 × 2 mm.
        let wrong = check(json!([20, 10, 3]));
        let right = check(json!([20, 10, 2]));
        let mut asked_first = plan(&wrong);
        let mut asked_second = plan(&right);
        compute(&sandbox.root, asked_first.as_mut()).unwrap();
        compute(&sandbox.root, asked_second.as_mut()).unwrap();
        assert_eq!(commit(asked_second, &right)["verificationStatus"], "passed");
        assert_eq!(commit(asked_first, &wrong)["verificationStatus"], "failed");
        let revision = sandbox.revision(&part["revisionId"]);
        let readiness = sandbox.with_handle(|handle| cad::readiness(handle, &revision).unwrap());
        assert_eq!(readiness["status"], "failed", "{readiness}");
        assert_eq!(readiness["ready"], false);
        let status = sandbox
            .call("work.status", json!({"scope": "project"}))
            .unwrap();
        assert_eq!(status["outstanding"][0]["kind"], "cad_check_failed");
        assert_eq!(status["counts"]["verifiedParts"], 0);
    }

    /// A check that stopped before it measured (here at the work limit)
    /// recorded no evidence, so its expectation does not bind the next one.
    #[cfg(unix)]
    #[test]
    fn a_check_that_errored_before_measuring_binds_no_scope() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let part = sandbox
            .call("cad.write_source", json!({"title": "Plate", "source": BOX}))
            .unwrap();
        let probes = (0..513)
            .map(|index| json!([f64::from(index) * 0.01, 1, 1]))
            .collect::<Vec<_>>();
        let errored = sandbox
            .call(
                "cad.check",
                json!({"artifactId": part["artifactId"], "autoCommit": true, "expect": {"size": [20, 10, 2], "solid": probes}}),
            )
            .unwrap_err();
        assert_eq!(errored.code, "VALIDATION", "{}", errored.message);
        assert_eq!(sandbox.jobs("cad_check")[0]["status"], "failed");
        let next = sandbox
            .call(
                "cad.check",
                json!({"artifactId": part["artifactId"], "autoCommit": true, "expect": {"size": [20, 10, 2]}}),
            )
            .unwrap();
        assert_eq!(next["verificationStatus"], "passed", "{next}");
        assert_eq!(next["committed"], true);
        assert_eq!(next["scopeChanges"], json!([]));
    }

    /// A render an agent queued commits on another thread; every event it
    /// records still names the session that asked for it.
    #[cfg(unix)]
    #[test]
    fn a_queued_render_records_its_events_for_the_session_that_asked() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let agent = Origin::Agent {
            session_id: "sess-7".into(),
        };
        let part = sandbox
            .call_as(
                agent.clone(),
                "cad.write_source",
                json!({"title": "Plate", "source": BOX}),
            )
            .unwrap();
        let before = sandbox
            .core
            .lock()
            .unwrap()
            .latest_event_seq(&sandbox.project_id)
            .unwrap();
        let queued = sandbox
            .call_as(
                agent,
                "cad.render",
                json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "params": {"w": 30}}),
            )
            .unwrap();
        wait_until("the queued render", || {
            sandbox
                .call("job.read", json!({"jobId": queued["job"]["id"]}))
                .unwrap()["job"]["status"]
                == "succeeded"
        });
        let events = sandbox
            .call("project.changes_since", json!({"seq": before}))
            .unwrap()["events"]
            .as_array()
            .unwrap()
            .clone();
        let committed = events
            .iter()
            .find(|event| event["type"] == "revision.committed")
            .expect("the rendered revision was committed");
        assert_eq!(committed["origin"], "agent");
        assert_eq!(committed["data"]["sessionId"], "sess-7", "{committed}");
        assert!(
            events
                .iter()
                .all(|event| event["data"]["sessionId"] == "sess-7"),
            "{events:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_working_file_that_cannot_be_written_is_a_warning_on_the_saved_part() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        // Something that is not a file already sits where the mesh goes.
        fs::create_dir_all(sandbox.root.join("artifacts/mechanical/blocked.stl/inside")).unwrap();
        let report = sandbox
            .call(
                "cad.write_source",
                json!({"title": "Blocked", "source": BOX}),
            )
            .unwrap();
        let warnings = report["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "{report}");
        assert!(warnings[0].as_str().unwrap().starts_with(
            "The revision is saved, but artifacts/mechanical/blocked.stl could not be written"
        ));
        assert_eq!(report["render"]["ok"], true);
        let revision = sandbox.revision(&report["revisionId"]);
        assert_eq!(revision["reviewState"], "draft");
        assert_eq!(
            revision["payload"]["stl"]["path"],
            "artifacts/mechanical/blocked.stl"
        );
        assert!(sandbox
            .root
            .join("artifacts/mechanical/blocked.scad")
            .is_file());
        assert_eq!(sandbox.jobs("cad_render")[0]["status"], "succeeded");
        // A compact session's brief result says so too.
        assert_eq!(
            cad::brief("cad.write_source", &report)["warnings"],
            report["warnings"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_engine_probe_runs_outside_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::gated_version(dir.path());
        let sandbox = Sandbox::with_engine(&engine.executable);
        std::thread::scope(|scope| {
            let doctor = scope.spawn(|| sandbox.call("tool.doctor", json!({})));
            wait_until("the probe to start", || engine.version_probes() == 1);
            assert!(sandbox.call("project.summary", json!({})).is_ok());
            assert!(
                !doctor.is_finished(),
                "the probe is still waiting on the engine"
            );
            engine.release();
            let result = doctor.join().unwrap().unwrap();
            assert_eq!(result["results"]["openscad"]["available"], true, "{result}");
            assert_eq!(result["results"]["openscad"]["version"], "0.0.0-standin");
        });
        let other = sandbox
            .call("tool.doctor", json!({"toolId": "kicad"}))
            .unwrap();
        assert_eq!(other, json!({"results": {}}));
    }

    #[cfg(unix)]
    #[test]
    fn the_step_converter_is_probed_outside_the_lock_beside_the_engine() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let engine = StandIn::new(dir.path());
        engine.release();
        let sandbox = Sandbox::with_engine(&engine.executable);
        let gate = dir.path().join("python-gate");
        let python = dir.path().join("python3");
        fs::write(
            &python,
            format!(
                "#!/bin/sh\nwhile [ ! -f '{}' ]; do sleep 0.02; done\necho 'OMENFLOW-OCP 7.9.3.1 3.12.14'\n",
                gate.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        sandbox
            .call(
                "settings.set",
                json!({"key": "toolPaths.python", "value": python}),
            )
            .unwrap();
        std::thread::scope(|scope| {
            let doctor = scope.spawn(|| sandbox.call("tool.doctor", json!({})));
            std::thread::sleep(Duration::from_millis(300));
            let started = Instant::now();
            assert!(sandbox.call("project.summary", json!({})).is_ok());
            assert!(started.elapsed() < Duration::from_secs(5));
            assert!(
                !doctor.is_finished(),
                "the converter probe is still waiting"
            );
            fs::write(&gate, "").unwrap();
            let result = doctor.join().unwrap().unwrap();
            assert_eq!(result["results"]["openscad"]["available"], true, "{result}");
            assert_eq!(result["results"]["python"]["available"], true, "{result}");
            assert_eq!(result["results"]["python"]["ocp"], "7.9.3.1");
        });
        // Each tool can be asked alone.
        let alone = sandbox
            .call("tool.doctor", json!({"toolId": "python"}))
            .unwrap();
        assert_eq!(alone["results"].as_object().unwrap().len(), 1);
        assert_eq!(alone["results"]["python"]["version"], "3.12.14");
    }

    #[test]
    fn a_panic_inside_a_dispatch_is_an_internal_error_and_the_application_survives() {
        let sandbox = Sandbox::new();
        let (result, events) = locked(&sandbox.core, Some(&sandbox.project_id), |app| {
            let handle = &app.projects[&sandbox.project_id];
            emit(handle, "ui.focus_terminal", &Origin::User, json!({}))?;
            if handle.root.exists() {
                panic!("boom");
            }
            Ok(())
        });
        let error = result.err().unwrap();
        assert_eq!(error.code, "INTERNAL");
        assert_eq!(error.message, "The operation stopped unexpectedly: boom");
        assert_eq!(kinds(&events), vec!["ui.focus_terminal"]);
        assert!(!sandbox.core.is_poisoned());
        assert!(sandbox.call("project.summary", json!({})).is_ok());

        // A lock poisoned by code that bypassed dispatch_shared is recovered too.
        let core = sandbox.core.clone();
        let _ = std::thread::spawn(move || {
            let _guard = core.lock().unwrap();
            panic!("poisoned on purpose");
        })
        .join();
        assert!(sandbox.core.is_poisoned());
        let summary = sandbox.call("project.summary", json!({})).unwrap();
        assert_eq!(summary["project"]["name"], "CAD");
        assert!(!sandbox.core.is_poisoned());
        let diagnostics = dispatch_shared(
            &sandbox.core,
            "app.diagnostics",
            json!({}),
            Origin::User,
            None,
            None,
        )
        .unwrap();
        assert_eq!(diagnostics["openProjects"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn ordinary_operations_validate_and_fail_as_a_direct_dispatch_does() {
        let sandbox = Sandbox::new();
        let unknown = sandbox.call("no.such_op", json!({})).err().unwrap();
        assert_eq!(unknown.code, "VALIDATION");
        let agent = Origin::Agent {
            session_id: "s1".into(),
        };
        let denied = sandbox
            .call_as(agent.clone(), "artifact.apply_edit", json!({}))
            .err()
            .unwrap();
        assert_eq!(denied.code, "APPROVAL_REQUIRED");
        let missing = sandbox
            .call_as(
                agent,
                "cad.check",
                json!({"artifactId": "00000000-0000-4000-8000-000000000009", "expect": {}}),
            )
            .err()
            .unwrap();
        assert_eq!(missing.code, "NOT_FOUND");
        assert!(sandbox.jobs("cad_check").is_empty());
        let closed = dispatch_shared(
            &sandbox.core,
            "cad.write_source",
            json!({"title": "Nowhere", "source": BOX}),
            Origin::User,
            Some("not-open"),
            None,
        )
        .err()
        .unwrap();
        assert_eq!(closed.code, "NOT_FOUND");
    }
}
