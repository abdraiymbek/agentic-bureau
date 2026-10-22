//! The loopback server: routes, the checks every request passes, and the
//! lifetime of the [`Host`] behind them.

use crate::events::EventHub;
use crate::http::{self, Rejected, Request};
use omenflow_agent_host::{EventSink, Grant, Host, HostPaths, ResearchSurface, Shell};
use omenflow_contracts::{registry, ContractError, Profile, ResponseEnvelope};
use serde_json::{json, Value};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// A peer gets this long to send a request it has started.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A reader that accepts no bytes for this long is disconnected.
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// An event stream with nothing to say still proves it is alive this often.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// How long a refused request may keep sending before the connection closes.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CONNECTIONS: usize = 128;
const MIN_TOKEN_CHARS: usize = 16;

pub struct Config {
    pub app_data_dir: PathBuf,
    /// The `omenflow` helper agent sessions call back through.
    pub cli_path: PathBuf,
    /// `0` asks the system for a free port.
    pub port: u16,
    /// Generated when absent.
    pub token: Option<String>,
}

pub struct Server {
    listener: TcpListener,
    shared: Arc<Shared>,
}

struct Shared {
    host: Host,
    hub: Arc<EventHub>,
    token: String,
    port: u16,
    app_data_dir: PathBuf,
    stopping: AtomicBool,
    connections: AtomicUsize,
}

/// Ends [`Server::serve`] from another thread.
#[derive(Clone)]
pub struct Stopper(Arc<Shared>);

impl Stopper {
    pub fn stop(&self) {
        if !self.0.stopping.swap(true, Ordering::SeqCst) {
            // Wake the accept loop; it sees the flag and leaves.
            let _ = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, self.0.port)));
        }
    }
}

/// The surfaces a host without a window does not have.
struct Headless;

impl Headless {
    fn unavailable(what: &str, instead: &str) -> ContractError {
        ContractError::new(
            "TOOL_MISSING",
            format!("{what} is unavailable in the headless host"),
        )
        .with_repair(instead)
        .with_details(json!({ "host": "headless", "unavailable": what }))
    }

    fn research() -> ContractError {
        Self::unavailable(
            "Research browsing",
            "Use the Omen Flow desktop app to browse and read pages. A source that is already known can be recorded with source_capture.",
        )
    }
}

impl ResearchSurface for Headless {
    fn load(&self, _url: &str) -> Result<Value, ContractError> {
        Err(Self::research())
    }
    fn read(&self) -> Result<Value, ContractError> {
        Err(Self::research())
    }
    fn link(&self, _selector: &str) -> Result<Option<String>, ContractError> {
        Err(Self::research())
    }
    fn screenshot(&self) -> Result<Value, ContractError> {
        Err(Self::research())
    }
    fn toggle(&self) -> Result<Value, ContractError> {
        Err(Self::research())
    }
}

impl Shell for Headless {
    fn reveal_path(&self, path: &Path) -> Result<(), ContractError> {
        Err(Self::unavailable(
            "Revealing a file",
            &format!("Open {} yourself.", path.display()),
        ))
    }
    fn open_external(&self, url: &str) -> Result<(), ContractError> {
        Err(Self::unavailable(
            "Opening a link",
            &format!("Open {url} in a browser yourself."),
        ))
    }
}

impl Server {
    /// Open the application state and bind the loopback port. Nothing is
    /// served until [`Server::serve`].
    pub fn bind(config: Config) -> Result<Self, ContractError> {
        let token = match config.token {
            Some(token) => {
                if token.len() < MIN_TOKEN_CHARS
                    || !token
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
                {
                    return Err(ContractError::validation(format!(
                        "The host token needs at least {MIN_TOKEN_CHARS} characters from A-Z, a-z, 0-9, '-', '.', '_' and '~'"
                    )));
                }
                token
            }
            None => format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        };
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, config.port)))
            .and_then(|listener| Ok((listener.local_addr()?.port(), listener)))
            .map_err(|error| {
                ContractError::new(
                    "INTERNAL",
                    format!("Could not listen on 127.0.0.1:{}: {error}", config.port),
                )
            })?;
        let (port, listener) = listener;
        let hub = Arc::new(EventHub::new());
        let host = Host::start(
            HostPaths {
                app_data_dir: config.app_data_dir.clone(),
                cli_path: config.cli_path,
            },
            Arc::clone(&hub) as Arc<dyn EventSink>,
            Arc::new(Headless),
            Arc::new(Headless),
        )?;
        Ok(Self {
            listener,
            shared: Arc::new(Shared {
                host,
                hub,
                token,
                port,
                app_data_dir: config.app_data_dir,
                stopping: AtomicBool::new(false),
                connections: AtomicUsize::new(0),
            }),
        })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    pub fn token(&self) -> &str {
        &self.shared.token
    }

    pub fn socket_path(&self) -> &str {
        self.shared.host.bridge().socket_path()
    }

    /// The line a parent process reads to find and authenticate to this host.
    pub fn announcement(&self) -> Value {
        json!({
            "port": self.port(),
            "token": self.token(),
            "socketPath": self.socket_path(),
        })
    }

    /// Replace how the host reads a CLI's model routing, so a test's result never depends on
    /// the developer's own variables and Claude settings.
    #[doc(hidden)]
    pub fn set_routing(&self, routing: omenflow_agent_host::RoutingLookup) {
        self.shared.host.pty().set_routing(routing);
    }

    pub fn stopper(&self) -> Stopper {
        Stopper(Arc::clone(&self.shared))
    }

    /// Answer requests until stopped, then end event streams and terminate
    /// every agent terminal before returning.
    pub fn serve(self) -> io::Result<()> {
        for incoming in self.listener.incoming() {
            if self.shared.stopping.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else { continue };
            let shared = Arc::clone(&self.shared);
            if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                shared.connections.fetch_sub(1, Ordering::SeqCst);
                let _ = refuse_busy(stream);
                continue;
            }
            thread::spawn(move || {
                let _ = connection(&shared, stream);
                shared.connections.fetch_sub(1, Ordering::SeqCst);
            });
        }
        self.shared.hub.close();
        self.shared.host.shutdown();
        Ok(())
    }
}

fn refuse_busy(stream: TcpStream) -> io::Result<()> {
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut writer = BufWriter::new(&stream);
    http::respond_json(
        &mut writer,
        503,
        &http::refusal("BUSY", "Too many open connections to this host"),
        false,
    )
}

/// Buffered reading and writing over one socket.
struct Connection<'a> {
    reader: BufReader<&'a TcpStream>,
    writer: BufWriter<&'a TcpStream>,
}

impl Read for Connection<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer)
    }
}

impl io::BufRead for Connection<'_> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        self.reader.fill_buf()
    }
    fn consume(&mut self, amount: usize) {
        self.reader.consume(amount)
    }
}

impl Write for Connection<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writer.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

const ROUTES: [(&str, &str); 7] = [
    ("/api/health", "GET"),
    ("/api/events", "GET"),
    ("/api/command", "POST"),
    ("/api/agent/session", "POST"),
    ("/api/agent/launch", "POST"),
    ("/api/agent/revoke", "POST"),
    ("/api/shutdown", "POST"),
];

enum Reply {
    Json(u16, Value),
    Events(crate::events::Subscription),
    /// Answer, then stop the server.
    Stop,
}

/// Serve one connection until the peer closes it, asks to close, or opens
/// the event stream.
fn connection(shared: &Arc<Shared>, stream: TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut connection = Connection {
        reader: BufReader::new(&stream),
        writer: BufWriter::new(&stream),
    };
    loop {
        let request = match http::read_request(&mut connection) {
            Ok(request) => request,
            Err(Rejected::Closed) => return Ok(()),
            Err(Rejected::Status(status, message)) => {
                let code = if matches!(status, 413 | 431) {
                    "VALIDATION"
                } else {
                    "PROTOCOL_MISMATCH"
                };
                http::respond_json(
                    &mut connection,
                    status,
                    &http::refusal(code, message),
                    false,
                )?;
                // Closing over unread request bytes resets the connection and
                // can lose the answer, so give the peer a moment to finish.
                stream.shutdown(Shutdown::Write)?;
                stream.set_read_timeout(Some(DRAIN_TIMEOUT))?;
                let mut unread = connection.reader.by_ref().take(http::MAX_BODY_BYTES as u64);
                let _ = io::copy(&mut unread, &mut io::sink());
                return Ok(());
            }
        };
        let keep_alive = !request.wants_close() && !shared.stopping.load(Ordering::SeqCst);
        match shared.answer(&request) {
            Reply::Json(status, body) => {
                let keep_alive = keep_alive && status == 200;
                http::respond_json(&mut connection, status, &body, keep_alive)?;
                if !keep_alive {
                    return Ok(());
                }
            }
            Reply::Stop => {
                http::respond_json(&mut connection, 200, &json!({ "ok": true }), false)?;
                Stopper(Arc::clone(shared)).stop();
                return Ok(());
            }
            Reply::Events(subscription) => {
                return shared.stream_events(&mut connection, &stream, subscription)
            }
        }
    }
}

impl Shared {
    fn stream_events(
        &self,
        connection: &mut Connection<'_>,
        stream: &TcpStream,
        subscription: crate::events::Subscription,
    ) -> io::Result<()> {
        http::begin_event_stream(connection)?;
        connection.write_all(b": connected\n\n")?;
        for frame in &subscription.replay {
            connection.write_all(frame.as_bytes())?;
        }
        connection.flush()?;
        // The request is complete; from here the peer only ever closes.
        stream.set_read_timeout(None)?;
        loop {
            match subscription.live.recv_timeout(HEARTBEAT) {
                Ok(frame) => {
                    connection.write_all(frame.as_bytes())?;
                    for more in subscription.live.try_iter().take(256) {
                        connection.write_all(more.as_bytes())?;
                    }
                }
                Err(RecvTimeoutError::Timeout) => connection.write_all(b": keep-alive\n\n")?,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
            connection.flush()?;
        }
    }

    fn answer(&self, request: &Request) -> Reply {
        if let Err(reply) = self.admit(request) {
            return reply;
        }
        let Some((_, method)) = ROUTES.iter().find(|(path, _)| *path == request.path) else {
            return Reply::Json(404, http::refusal("NOT_FOUND", "No such route"));
        };
        if request.method != *method {
            return Reply::Json(
                405,
                http::refusal(
                    "VALIDATION",
                    &format!("{} is called with {method}", request.path),
                ),
            );
        }
        match request.path.as_str() {
            "/api/health" => Reply::Json(
                200,
                json!({
                    "ok": true,
                    "service": "omenflow-host",
                    "version": env!("CARGO_PKG_VERSION"),
                    "protocolVersion": registry().protocol_version,
                    "appDataDir": self.app_data_dir,
                    "socketPath": self.host.bridge().socket_path(),
                }),
            ),
            "/api/events" => Reply::Events(self.hub.subscribe(request.header("last-event-id"))),
            "/api/command" => self.with_body(request, |body| self.command(body)),
            "/api/agent/session" => self.with_body(request, |body| self.agent_session(body)),
            "/api/agent/launch" => self.with_body(request, |body| self.agent_launch(body)),
            "/api/agent/revoke" => self.with_body(request, |body| self.agent_revoke(body)),
            _ => Reply::Stop,
        }
    }

    /// The checks every request passes before it reaches a route. A web page
    /// fails all three: its `Host` is not this loopback address when it
    /// reached us through a rebinding name, its requests are marked by the
    /// browser, and it does not have the token.
    fn admit(&self, request: &Request) -> Result<(), Reply> {
        let denied = |status, message| {
            Err(Reply::Json(
                status,
                http::refusal("CONNECTION_DENIED", message),
            ))
        };
        let host_ok = request.header("host").is_some_and(|host| {
            host.strip_suffix(&format!(":{}", self.port))
                .is_some_and(|name| name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost"))
        });
        if !host_ok {
            return denied(
                403,
                "This host answers only as 127.0.0.1 or localhost on its own port",
            );
        }
        let marked_cross_site = match request.header("sec-fetch-site") {
            Some(site) => !site.eq_ignore_ascii_case("none"),
            None => request.has_header("sec-fetch-site"),
        };
        if request.has_header("origin") || marked_cross_site {
            return denied(403, "Requests made by web pages are refused");
        }
        let bearer = request
            .header("authorization")
            .and_then(|value| value.strip_prefix("Bearer "));
        let presented = match (bearer, request.path.as_str(), request.method.as_str()) {
            (Some(token), _, _) => Some(token),
            // EventSource cannot set headers, so the stream also takes the token as a parameter.
            (None, "/api/events", "GET") => request.query("token"),
            _ => None,
        };
        if !presented.is_some_and(|token| constant_time_eq(token, &self.token)) {
            return denied(401, "Missing or wrong host token");
        }
        Ok(())
    }

    fn with_body(&self, request: &Request, run: impl FnOnce(Value) -> Reply) -> Reply {
        let json_type = request.header("content-type").is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
        });
        if !json_type {
            return Reply::Json(
                415,
                http::refusal("VALIDATION", "Send the body as application/json"),
            );
        }
        match serde_json::from_slice::<Value>(&request.body) {
            Ok(body) if body.is_object() => run(body),
            Ok(_) => Reply::Json(
                400,
                http::refusal("VALIDATION", "The body must be a JSON object"),
            ),
            Err(error) => Reply::Json(
                400,
                http::refusal(
                    "VALIDATION",
                    &format!("The body is not valid JSON: {error}"),
                ),
            ),
        }
    }

    fn command(&self, mut body: Value) -> Reply {
        let Some(op) = body["op"].as_str().map(str::to_owned) else {
            return bad_field("op", "a string naming the operation");
        };
        let project_id = match optional_text(&body, "projectId") {
            Ok(value) => value,
            Err(reply) => return reply,
        };
        let idempotency_key = match optional_text(&body, "idempotencyKey") {
            Ok(value) => value,
            Err(reply) => return reply,
        };
        let payload = body
            .get_mut("payload")
            .map(Value::take)
            .unwrap_or_else(|| json!({}));
        let envelope = self.host.command(
            &op,
            payload,
            project_id.as_deref(),
            idempotency_key.as_deref(),
        );
        envelope_reply(envelope)
    }

    /// Issue the bridge credentials an agent process needs to act on an open
    /// project, exactly as a terminal session would receive them. `profile`
    /// (`compact`, `standard` or `full`, default `standard`) fixes how the
    /// session's results are shaped.
    fn agent_session(&self, body: Value) -> Reply {
        let Some(project_id) = body["projectId"].as_str() else {
            return bad_field("projectId", "the id of an open project");
        };
        let session_id = match optional_text(&body, "sessionId") {
            Ok(Some(id)) if uuid::Uuid::parse_str(&id).is_err() => {
                return bad_field("sessionId", "a UUID")
            }
            Ok(Some(id)) => id,
            Ok(None) => uuid::Uuid::new_v4().to_string(),
            Err(reply) => return reply,
        };
        let profile = match optional_text(&body, "profile") {
            Ok(None) => Profile::default(),
            Ok(Some(text)) => match text.parse::<Profile>() {
                Ok(profile) => profile,
                Err(_) => return bad_field("profile", "compact, standard or full"),
            },
            Err(reply) => return reply,
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let open = self
            .host
            .core()
            .lock()
            .map_err(|_| ContractError::new("INTERNAL", "Application state is unavailable"))
            .and_then(|core| core.project_root(project_id));
        if let Err(error) = open {
            return envelope_reply(ResponseEnvelope::failure(request_id, error));
        }
        let bridge = self.host.bridge();
        let token = bridge.issue_grant(Grant {
            profile,
            ..Grant::new(project_id, &session_id)
        });
        let keys = &registry().env_keys;
        let env = [
            ("socketPath", bridge.socket_path()),
            ("token", token.as_str()),
            ("projectId", project_id),
            ("sessionId", session_id.as_str()),
        ]
        .into_iter()
        .filter_map(|(key, value)| Some((keys.get(key)?.clone(), json!(value))))
        .collect::<serde_json::Map<_, _>>();
        envelope_reply(ResponseEnvelope::success(
            request_id,
            json!({
                "projectId": project_id,
                "sessionId": session_id,
                "token": token,
                "socketPath": bridge.socket_path(),
                "profile": profile,
                "env": env,
            }),
        ))
    }

    /// Prepare a non-interactive agent CLI run on an open project, wired as
    /// the desktop wires a terminal session: the plan names the executable,
    /// its arguments, environment and working folder, and the files to
    /// write first. The caller spawns the CLI, writes the prompt to its
    /// standard input, and afterwards removes the files and revokes the
    /// session with `/api/agent/revoke`.
    fn agent_launch(&self, mut body: Value) -> Reply {
        let Some(project_id) = body["projectId"].as_str().map(str::to_owned) else {
            return bad_field("projectId", "the id of an open project");
        };
        if let Some(fields) = body.as_object_mut() {
            fields.remove("projectId");
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        envelope_reply(match self.host.prepare_agent_run(&project_id, body) {
            Ok(plan) => ResponseEnvelope::success(request_id, plan),
            Err(error) => ResponseEnvelope::failure(request_id, error),
        })
    }

    fn agent_revoke(&self, body: Value) -> Reply {
        let Some(session_id) = body["sessionId"].as_str() else {
            return bad_field("sessionId", "the session to revoke");
        };
        self.host.bridge().revoke(session_id);
        envelope_reply(ResponseEnvelope::success(
            uuid::Uuid::new_v4().to_string(),
            json!({ "ok": true }),
        ))
    }
}

fn envelope_reply(envelope: ResponseEnvelope) -> Reply {
    match serde_json::to_value(envelope) {
        Ok(body) => Reply::Json(200, body),
        Err(error) => Reply::Json(
            200,
            http::refusal(
                "INTERNAL",
                &format!("The result could not be encoded: {error}"),
            ),
        ),
    }
}

fn bad_field(name: &str, expected: &str) -> Reply {
    Reply::Json(
        400,
        http::refusal("VALIDATION", &format!("{name} must be {expected}")),
    )
}

fn optional_text(body: &Value, key: &str) -> Result<Option<String>, Reply> {
    match &body[key] {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(bad_field(key, "a string when present")),
    }
}

/// Compare without stopping at the first difference, so response time does
/// not reveal how much of a guessed token was right.
fn constant_time_eq(presented: &str, expected: &str) -> bool {
    let (presented, expected) = (presented.as_bytes(), expected.as_bytes());
    let mut difference = presented.len() ^ expected.len();
    for (index, byte) in expected.iter().enumerate() {
        difference |= (presented.get(index).copied().unwrap_or(0) ^ byte) as usize;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn tokens_match_only_when_identical() {
        assert!(constant_time_eq("abcdef0123456789", "abcdef0123456789"));
        for wrong in [
            "",
            "abcdef012345678",
            "abcdef01234567890",
            "abcdef0123456780",
        ] {
            assert!(!constant_time_eq(wrong, "abcdef0123456789"), "{wrong:?}");
        }
    }
}
