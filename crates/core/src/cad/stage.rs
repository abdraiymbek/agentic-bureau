//! How a slow CAD operation is split across the application lock.
//!
//! `dispatch_shared` drives one operation through the ordinary dispatch path
//! twice: first to plan (validate, read inputs, open jobs), then, after the
//! engine and mesh work ran with the lock released, to commit. The stage in
//! force for the current thread tells an operation's entry point which of the
//! two it is being asked for. With no stage set, the entry point does all
//! three steps in place, which is what a direct `CoreApp::dispatch` gets.
use super::*;
use std::cell::RefCell;

enum Stage {
    /// Plan, compute and commit in place.
    Inline,
    /// Plan only and hand the pipeline back.
    Plan,
    Planned(Box<dyn Pipeline>),
    /// Commit this already computed pipeline.
    Commit(Box<dyn Pipeline>),
}

thread_local! {
    static STAGE: RefCell<Stage> = const { RefCell::new(Stage::Inline) };
    static PROBE: RefCell<Option<Value>> = const { RefCell::new(None) };
}

fn replace(stage: Stage) -> Stage {
    STAGE.with(|current| current.replace(stage))
}

/// Puts the thread back to in-place operation even when the work panics.
struct Reset;

impl Drop for Reset {
    fn drop(&mut self) {
        replace(Stage::Inline);
        PROBE.with(|probe| probe.replace(None));
    }
}

/// Run `work` so that a slow CAD operation inside it only plans. Returns the
/// planned pipeline, if the operation got that far.
pub(crate) fn planning<T>(work: impl FnOnce() -> T) -> (T, Option<Box<dyn Pipeline>>) {
    let _reset = Reset;
    replace(Stage::Plan);
    let result = work();
    match replace(Stage::Inline) {
        Stage::Planned(pipeline) => (result, Some(pipeline)),
        _ => (result, None),
    }
}

/// Run `work` so that the CAD operation inside it commits `pipeline`. The
/// pipeline comes back when the operation was never reached, for example
/// because an idempotent replay answered first.
pub(crate) fn committing<T>(
    pipeline: Box<dyn Pipeline>,
    work: impl FnOnce() -> T,
) -> (T, Option<Box<dyn Pipeline>>) {
    let _reset = Reset;
    replace(Stage::Commit(pipeline));
    let result = work();
    match replace(Stage::Inline) {
        Stage::Commit(pipeline) => (result, Some(pipeline)),
        _ => (result, None),
    }
}

/// Run `work` with an engine probe that was already made off the lock.
pub(crate) fn with_probe<T>(probe: Value, work: impl FnOnce() -> T) -> T {
    let _reset = Reset;
    PROBE.with(|slot| slot.replace(Some(probe)));
    work()
}

pub(super) fn staged_probe() -> Option<Value> {
    PROBE.with(|slot| slot.borrow_mut().take())
}

pub(super) fn is_planning() -> bool {
    STAGE.with(|stage| matches!(*stage.borrow(), Stage::Plan))
}

pub(super) fn is_planned() -> bool {
    STAGE.with(|stage| matches!(*stage.borrow(), Stage::Planned(_)))
}

pub(super) fn hand_back(pipeline: Box<dyn Pipeline>) {
    replace(Stage::Planned(pipeline));
}

/// Entry point of every staged operation: do what the current stage asks.
pub(super) fn drive(
    handle: &ProjectHandle,
    origin: &Origin,
    op: &'static str,
    plan: impl FnOnce() -> CoreResult<Box<dyn Pipeline>>,
) -> CoreResult<Value> {
    match replace(Stage::Inline) {
        Stage::Plan => {
            hand_back(plan()?);
            Ok(Value::Null)
        }
        Stage::Commit(pipeline) if pipeline.op() == op => pipeline.commit(handle, origin),
        other => {
            // Not this operation's stage: leave it for its owner and work in place.
            replace(other);
            run_inline(handle, origin, plan()?)
        }
    }
}
