//! Native close policy. A renderer decision and agent consent must both finish
//! before the window is destroyed. Internal failure/signal exits stay direct.

use std::sync::{Mutex, PoisonError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Close,
    Quit,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Quit => "quit",
        }
    }

    pub fn question(self) -> &'static str {
        match self {
            Self::Close => "Close this window?",
            Self::Quit => "Quit Omen Flow?",
        }
    }

    pub fn agree(self) -> &'static str {
        match self {
            Self::Close => "Stop agent and close",
            Self::Quit => "Stop agent and quit",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Request {
    pub id: String,
    pub action: Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    WaitingForRenderer,
    AskingAboutEdits,
    AskingAboutAgent,
}

struct Pending {
    request: Request,
    phase: Phase,
}

#[derive(Default)]
struct State {
    /// Monotonic: after a renderer has been ready, an absent one must fail closed.
    renderer_ready: bool,
    pending: Option<Pending>,
    allow_exit: bool,
}

#[derive(Default)]
pub struct Coordinator(Mutex<State>);

impl Coordinator {
    pub fn ready(&self) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .renderer_ready = true;
    }

    /// `bool` says whether the renderer must answer. Before it first mounts,
    /// there can be no editor state; startup failures must remain closable.
    pub fn begin(&self, action: Action) -> Option<(Request, bool)> {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.pending.is_some() || state.allow_exit {
            return None;
        }
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            action,
        };
        let ask_renderer = state.renderer_ready;
        state.pending = Some(Pending {
            request: request.clone(),
            phase: if ask_renderer {
                Phase::WaitingForRenderer
            } else {
                Phase::AskingAboutAgent
            },
        });
        Some((request, ask_renderer))
    }

    pub fn received(&self, id: &str) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(pending) = state.pending.as_mut().filter(|p| p.request.id == id) else {
            return false;
        };
        if pending.phase != Phase::WaitingForRenderer {
            return false;
        }
        pending.phase = Phase::AskingAboutEdits;
        true
    }

    pub fn discard(&self, id: &str) -> Option<Request> {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = state.pending.as_mut().filter(|p| p.request.id == id)?;
        if pending.phase != Phase::AskingAboutEdits {
            return None;
        }
        pending.phase = Phase::AskingAboutAgent;
        Some(pending.request.clone())
    }

    pub fn cancel(&self, id: &str) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.pending.as_ref().is_some_and(|p| p.request.id == id) {
            state.pending = None;
        }
    }

    /// Time out only delivery, never a human's deliberation or the agent dialog.
    pub fn expire_unreceived(&self, id: &str) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let waiting = state
            .pending
            .as_ref()
            .is_some_and(|p| p.request.id == id && p.phase == Phase::WaitingForRenderer);
        if waiting {
            state.pending = None;
        }
        waiting
    }

    pub fn approve(&self, id: &str) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let agreed = state
            .pending
            .as_ref()
            .is_some_and(|p| p.request.id == id && p.phase == Phase::AskingAboutAgent);
        if agreed {
            state.pending = None;
            state.allow_exit = true;
        }
        agreed
    }

    pub fn force_exit(&self) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .allow_exit = true;
    }

    /// Consume one approved exit so `app.exit` does not loop through the guard.
    pub fn take_exit_permission(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut state.allow_exit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_close_is_direct_but_still_coalesces() {
        let gate = Coordinator::default();
        let (request, ask) = gate.begin(Action::Close).unwrap();
        assert!(!ask);
        assert!(gate.begin(Action::Quit).is_none());
        assert!(gate.approve(&request.id));
        assert!(gate.take_exit_permission());
        assert!(!gate.take_exit_permission());
    }

    #[test]
    fn close_requires_renderer_discard_and_agent_consent() {
        let gate = Coordinator::default();
        gate.ready();
        let (request, ask) = gate.begin(Action::Quit).unwrap();
        assert!(ask);
        assert!(!gate.take_exit_permission());
        assert!(!gate.approve(&request.id));
        assert!(gate.discard(&request.id).is_none());
        assert!(gate.received(&request.id));
        assert!(!gate.expire_unreceived(&request.id));
        assert!(!gate.approve(&request.id));
        assert!(gate.discard(&request.id).is_some());
        assert!(gate.begin(Action::Close).is_none());
        assert!(!gate.expire_unreceived(&request.id));
        assert!(gate.approve(&request.id));
        assert!(gate.take_exit_permission());
        assert!(!gate.take_exit_permission());
    }

    #[test]
    fn cancelled_or_missing_renderer_never_grants_exit() {
        let gate = Coordinator::default();
        gate.ready();
        let (first, _) = gate.begin(Action::Close).unwrap();
        assert!(gate.expire_unreceived(&first.id));
        assert!(!gate.take_exit_permission());
        let (second, ask) = gate.begin(Action::Quit).unwrap();
        assert!(ask, "a renderer that disappeared must never be bypassed");
        assert!(!gate.received(&first.id));
        assert!(gate.received(&second.id));
        gate.cancel(&second.id);
        assert!(gate.discard(&second.id).is_none());
        assert!(!gate.take_exit_permission());
        let (third, _) = gate.begin(Action::Quit).unwrap();
        assert!(gate.received(&third.id));
        assert!(gate.discard(&third.id).is_some());
        gate.cancel(&third.id); // Agent consent was declined.
        assert!(!gate.approve(&third.id));
        assert!(!gate.take_exit_permission());
    }

    #[test]
    fn signals_and_startup_failures_can_exit_without_a_renderer_answer() {
        let gate = Coordinator::default();
        gate.ready();
        gate.begin(Action::Quit).unwrap();
        gate.force_exit();
        assert!(gate.take_exit_permission());
    }
}
