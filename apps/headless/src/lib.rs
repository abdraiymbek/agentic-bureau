//! Bureau without a window. `bureau-host` runs the same [`Host`] the
//! desktop app runs and exposes its command surface on a loopback port, for
//! the browser preview, conformance tests and evaluations.
//!
//! | Route | | |
//! | --- | --- | --- |
//! | `GET /api/health` | | liveness and where the agent bridge listens |
//! | `POST /api/command` | `{ op, payload?, projectId?, idempotencyKey? }` | the desktop command, same response envelope |
//! | `GET /api/events` | `?token=` or the header | server-sent events: `event`, `terminal-data`, `terminal-state`, `agent-call`, `chat`, and `resync` after a gap |
//! | `POST /api/agent/session` | `{ projectId, sessionId? }` | bridge credentials for an agent process |
//! | `POST /api/agent/revoke` | `{ sessionId }` | end those credentials |
//! | `POST /api/shutdown` | | stop agent terminals and exit |
//!
//! Every request needs `Authorization: Bearer <token>`, a `Host` of
//! `127.0.0.1:<port>` or `localhost:<port>`, and must not be marked by a
//! browser as coming from a page (`Origin`, `Sec-Fetch-Site`). No response
//! grants cross-origin access.
//!
//! [`Host`]: bureau_agent_host::Host

mod events;
mod http;
mod server;

pub use server::{Config, Server, Stopper};
