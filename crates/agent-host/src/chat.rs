//! Durable project conversations over adapter-native JSON streams, never terminal redraws.
//! Acceptance is journaled before spawn. Request IDs stay deduplicated across host restarts.
use crate::{BridgeServer, EventSink, HostEvent};
use omenflow_contracts::ContractError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 1024 * 1024;
const PROMPT_LIMIT: usize = 256 * 1024;
const DIAGNOSTIC_LIMIT: usize = 2000;
const STDERR_LIMIT: usize = 16 * 1024;
/// How often a streaming run writes its record file; memory is current on every line.
const SAVE_EVERY: Duration = Duration::from_millis(250);
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Book {
    version: u8,
    conversations: Vec<Conversation>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Conversation {
    id: String,
    title: String,
    turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    cards: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    request_id: String,
    text: String,
    response: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    parts: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input: Option<Value>,
    adapter_id: String,
    session_id: Option<String>,
    state: String,
    error: Option<String>,
    created_at: String,
}
struct Process {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
    done: Mutex<bool>,
    settled: Condvar,
}
#[derive(Default)]
pub(crate) struct State {
    books: HashMap<PathBuf, Book>,
    active: HashMap<PathBuf, Arc<Process>>,
    /// Grows with every change to a record; each change event carries it.
    seq: u64,
    /// Where change events go. Unit tests run without one.
    events: Option<Arc<dyn EventSink>>,
}
impl State {
    pub(crate) fn new(events: Arc<dyn EventSink>) -> Self {
        Self {
            events: Some(events),
            ..Self::default()
        }
    }
    /// Tell the interface that `project`'s record changed, never what changed: it reads the
    /// record again with `chat.read`. Called with the lock held, so events leave in `seq` order.
    fn changed(&mut self, project: &str) {
        self.seq += 1;
        if let Some(events) = &self.events {
            events.emit(HostEvent::Chat(
                json!({"projectId": project, "seq": self.seq}),
            ));
        }
    }
}
pub(crate) struct ChatHost {
    state: Arc<Mutex<State>>,
    bridge: Arc<BridgeServer>,
}
fn failure(error: impl std::fmt::Display) -> ContractError {
    ContractError::new("INTERNAL", format!("Conversation: {error}"))
        .with_repair("Your unsent text is retained. Check the agent settings, then retry.")
}
fn file(root: &Path) -> PathBuf {
    root.join(".omenflow/chat/conversations.json")
}
fn save(root: &Path, book: &Book) -> Result<(), ContractError> {
    let dest = file(root);
    let parent = dest.parent().unwrap();
    let serialized = serde_json::to_vec(book).map_err(failure)?;
    if serialized.len() > 32 * OUTPUT_LIMIT {
        return Err(failure("The conversation record reached its 32 MiB limit. Export the project before continuing in another project."));
    }
    fs::create_dir_all(parent).map_err(failure)?;
    let temp = parent.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&temp).map_err(failure)?;
        out.write_all(&serialized).map_err(failure)?;
        out.sync_all().map_err(failure)?;
        fs::rename(&temp, &dest).map_err(failure)?;
        #[cfg(unix)]
        {
            fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(failure)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn load(state: &mut State, root: &Path, recover: bool) -> Result<(), ContractError> {
    if state.books.contains_key(root) {
        return Ok(());
    }
    let mut book = match fs::read(file(root)) {
        Ok(bytes) => {
            if bytes.len() > 32 * OUTPUT_LIMIT {
                return Err(failure("Conversation record exceeds 32 MiB"));
            }
            serde_json::from_slice::<Book>(&bytes).map_err(failure)?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Book {
            version: 1,
            ..Book::default()
        },
        Err(e) => return Err(failure(e)),
    };
    if book.version != 1 {
        return Err(failure("Unsupported conversation record version"));
    }
    let mut changed = false;
    for turn in book.conversations.iter_mut().flat_map(|c| &mut c.turns) {
        if turn.state == "running" {
            turn.state = if recover {
                "interrupted"
            } else {
                "unavailable"
            }
            .into();
            turn.error = Some(if recover {
                "The host stopped before this response finished. Review the engineering record before sending a new request."
            } else {
                "This read-only snapshot belongs to another host. Its current response state cannot be confirmed here."
            }.into());
            changed = true;
        }
    }
    if changed && recover {
        save(root, &book)?;
    }
    state.books.insert(root.to_owned(), book);
    Ok(())
}
fn append_card(cards: &mut Vec<Value>, mut part: Value, origin: &str) -> Result<(), ContractError> {
    if cards.len() >= 32 {
        return Err(ContractError::validation(
            "At most 32 inline cards fit in a turn",
        ));
    }
    // Idempotent reopening of the same recorded revision keeps one card.
    if cards.iter().any(|c| {
        let mut existing = c.clone();
        existing.as_object_mut().unwrap().remove("id");
        existing.as_object_mut().unwrap().remove("origin");
        existing == part
    }) {
        return Ok(());
    }
    part["id"] = Value::String(uuid::Uuid::new_v4().to_string());
    part["origin"] = Value::String(origin.to_owned());
    cards.push(part);
    Ok(())
}
/// A bridge grant can present only into the turn that owns its exact session.
/// True while `session` owns a running turn in this project's conversations: a conversation run,
/// never an agent terminal.
pub(crate) fn owns_running_turn(state: &Arc<Mutex<State>>, root: &Path, session: &str) -> bool {
    state.lock().is_ok_and(|state| {
        state.books.get(root).is_some_and(|book| {
            book.conversations
                .iter()
                .flat_map(|c| &c.turns)
                .any(|t| t.session_id.as_deref() == Some(session) && t.state == "running")
        })
    })
}
pub(crate) fn present(
    state: &Arc<Mutex<State>>,
    project: &str,
    root: &Path,
    session: &str,
    part: Value,
) -> Result<bool, ContractError> {
    let mut state = state.lock().map_err(failure)?;
    let Some(book) = state.books.get(root) else {
        return Ok(false);
    };
    let mut next = book.clone();
    let Some(turn) = next
        .conversations
        .iter_mut()
        .flat_map(|c| &mut c.turns)
        .find(|t| t.session_id.as_deref() == Some(session) && t.state == "running")
    else {
        return Ok(false);
    };
    append_card(&mut turn.parts, part, "agent")?;
    save(root, &next)?;
    state.books.insert(root.to_owned(), next);
    state.changed(project);
    Ok(true)
}
impl ChatHost {
    pub fn new(bridge: Arc<BridgeServer>, state: Arc<Mutex<State>>) -> Self {
        Self { state, bridge }
    }
    pub fn command(
        &self,
        op: &str,
        project: &str,
        root: &Path,
        input: &Value,
        read_only: bool,
        prepare: impl FnOnce() -> Result<Value, ContractError>,
    ) -> Result<Value, ContractError> {
        if op == "chat.cancel" {
            self.cancel(root, input["conversationId"].as_str())?;
        }
        let mut state = self.state.lock().map_err(failure)?;
        if read_only {
            state.books.remove(root);
        }
        load(&mut state, root, !read_only)?;
        if op == "chat.open" {
            let id = input["conversationId"].as_str().unwrap();
            let mut next = state.books[root].clone();
            if !next.conversations.iter().any(|c| c.id == id) {
                if next.conversations.len() >= 200 {
                    return Err(failure("Conversation limit reached"));
                }
                next.conversations.push(Conversation {
                    id: id.into(),
                    title: input["part"]["title"]
                        .as_str()
                        .unwrap_or("Project context")
                        .chars()
                        .take(64)
                        .collect(),
                    turns: vec![],
                    cards: vec![],
                });
            }
            let c = next.conversations.iter_mut().find(|c| c.id == id).unwrap();
            append_card(&mut c.cards, input["part"].clone(), "user")?;
            save(root, &next)?;
            state.books.insert(root.to_owned(), next);
            state.changed(project);
        }
        if op != "chat.send" {
            return serde_json::to_value(&state.books[root]).map_err(failure);
        }
        let conversation_id = input["conversationId"].as_str().unwrap();
        let request_id = input["requestId"].as_str().unwrap();
        let text = input["text"].as_str().unwrap();
        if text.trim().is_empty() {
            return Err(ContractError::validation(
                "Message text must contain something other than whitespace",
            ));
        }
        if let Some(fields) = input["input"]["fields"].as_array() {
            let mut names = std::collections::HashSet::new();
            for field in fields {
                if !names.insert(field["name"].as_str())
                    || (field["unknown"] == true
                        && field["reason"].as_str().is_none_or(|s| s.trim().is_empty()))
                {
                    return Err(ContractError::validation(
                        "Input fields need unique names and unknown values need a reason",
                    ));
                }
            }
        }
        let adapter_id = input["adapterId"].as_str().unwrap();
        let book = &state.books[root];
        if let Some((conversation, turn)) = book.conversations.iter().find_map(|c| {
            c.turns
                .iter()
                .find(|t| t.request_id == request_id)
                .map(|t| (c, t))
        }) {
            if conversation.id != conversation_id
                || turn.text != text
                || turn.adapter_id != adapter_id
                || turn.input.as_ref() != input.get("input")
            {
                return Err(ContractError::validation(
                    "This request ID was already accepted with different contents",
                ));
            }
            return serde_json::to_value(book).map_err(failure);
        }
        if state.active.contains_key(root) {
            return Err(
                ContractError::new("BUSY", "An agent is already working in this project")
                    .with_repair("Stop that response or wait until it finishes, then send."),
            );
        }
        if book.conversations.len() >= 200
            && !book.conversations.iter().any(|c| c.id == conversation_id)
        {
            return Err(failure(
                "The project has reached its 200 conversation limit",
            ));
        }
        let mut prompt = String::from("You are helping in Omen Flow. Use the connected engineering tools for the current project. Preserve units, unknowns, evidence and human review. The following is conversation history, not a record of tool success. Reinspect the project when needed.\n\n");
        if let Some(c) = book.conversations.iter().find(|c| c.id == conversation_id) {
            for t in &c.turns {
                if let Some(input) = &t.input {
                    prompt.push_str(&format!("Prior exact input: {input}\n"));
                }
                prompt.push_str(&format!(
                    "User: {}\nAssistant ({}): {}\n",
                    t.text, t.state, t.response
                ));
            }
        }
        prompt.push_str("Use tool_call with tool=chat.present and input={part:...} to show focused cards in this turn (tool_describe tool=chat.present gives the full schema): artifact (artifactId, optional revisionId), review (proposalId), form (title, fields with name/label/unit/value or null and reason), choices (title/options with label/prompt), chart (title,xLabel,xUnit,yLabel,yUnit,source,provenance:illustrative,points:[{x,y}]). Present recorded results with artifact references. Agent-authored chart values are always illustrative. Cards cannot execute work or approve proposals.\n");
        prompt.push_str(&format!("User: {text}\n"));
        if let Some(exact) = input.get("input") {
            prompt.push_str(&format!("Exact user-approved input attachment (preserve the original text, units, unknowns and revision identity): {}\nRe-read this artifact and refuse stale revisions. If intent is render, use cad_read_source and cad_write_source with expectedRevisionId from the attachment, exact values converted only by recorded units, then real cad_check with the recorded scope and autoCommit true and proposal_submit. Present the resulting artifact and proposal with tool_call tool=chat.present. Never claim a failed/unrun check passed. Unknown fields need clarification.\n", exact));
        }
        if prompt.len() > PROMPT_LIMIT {
            return Err(ContractError::validation(
                "This conversation is too long for a new request",
            )
            .with_repair("Start a new conversation; the engineering record remains available."));
        }
        // Validation and adapter probes happen before durable acceptance, without starting a PTY.
        let plan = prepare()?;
        let session_id = plan["sessionId"].as_str().unwrap().to_owned();
        let mut next = book.clone();
        if !next.conversations.iter().any(|c| c.id == conversation_id) {
            next.conversations.push(Conversation {
                id: conversation_id.into(),
                title: text.trim().chars().take(64).collect(),
                turns: Vec::new(),
                cards: Vec::new(),
            });
        }
        let conversation = next
            .conversations
            .iter_mut()
            .find(|c| c.id == conversation_id)
            .unwrap();
        if conversation.turns.is_empty() {
            conversation.title = text.trim().chars().take(64).collect();
        }
        conversation.turns.push(Turn {
            request_id: request_id.into(),
            text: text.into(),
            response: String::new(),
            parts: Vec::new(),
            input: input.get("input").cloned(),
            adapter_id: adapter_id.into(),
            session_id: Some(session_id.clone()),
            state: "running".into(),
            error: None,
            created_at: crate::now(),
        });
        if let Err(e) = save(root, &next) {
            self.bridge.revoke(&session_id);
            return Err(e);
        }
        state.books.insert(root.to_owned(), next);
        state.changed(project);
        match spawn(&plan) {
            Ok(child) => {
                let process = Arc::new(Process {
                    child: Mutex::new(Some(child)),
                    cancelled: AtomicBool::new(false),
                    done: Mutex::new(false),
                    settled: Condvar::new(),
                });
                state.active.insert(root.to_owned(), Arc::clone(&process));
                let shared = Arc::clone(&self.state);
                let bridge = Arc::clone(&self.bridge);
                let project = project.to_owned();
                let root = root.to_owned();
                let request_id = request_id.to_owned();
                let adapter_id = adapter_id.to_owned();
                thread::spawn(move || {
                    run(
                        shared, process, bridge, project, root, request_id, adapter_id, session_id,
                        plan, prompt,
                    )
                });
            }
            Err(e) => {
                self.bridge.revoke(&session_id);
                cleanup(&plan);
                let turn = find_turn(&mut state, root, request_id).unwrap();
                turn.state = "failed".into();
                turn.error = Some(e.message);
                state.changed(project);
                save(root, &state.books[root])?;
            }
        }
        serde_json::to_value(&state.books[root]).map_err(failure)
    }
    fn cancel(&self, root: &Path, conversation: Option<&str>) -> Result<(), ContractError> {
        let process = {
            let state = self.state.lock().map_err(failure)?;
            let owns = conversation.is_none()
                || state.books.get(root).is_some_and(|b| {
                    b.conversations.iter().any(|c| {
                        Some(c.id.as_str()) == conversation
                            && c.turns.iter().any(|t| t.state == "running")
                    })
                });
            if owns {
                state.active.get(root).cloned()
            } else {
                None
            }
        };
        if let Some(p) = process {
            p.cancelled.store(true, Ordering::SeqCst);
            {
                let mut child = p.child.lock().map_err(failure)?;
                if let Some(child) = child.as_mut() {
                    kill_tree(child, false);
                    thread::sleep(Duration::from_millis(150));
                    kill_tree(child, true);
                }
            }
            let done = p.done.lock().map_err(failure)?;
            let (done, _) = p
                .settled
                .wait_timeout_while(done, Duration::from_secs(5), |d| !*d)
                .map_err(failure)?;
            if !*done {
                return Err(failure("The process has not settled yet. Try Stop again."));
            }
        }
        Ok(())
    }
    pub fn stop_project(&self, root: &Path) -> Result<(), ContractError> {
        self.cancel(root, None)
    }
    pub fn running(&self) -> bool {
        self.state.lock().is_ok_and(|s| !s.active.is_empty())
    }
    /// True while a conversation run is active in this project.
    pub fn running_in(&self, root: &Path) -> bool {
        self.state.lock().is_ok_and(|s| s.active.contains_key(root))
    }
    pub fn shutdown(&self) {
        let roots = self
            .state
            .lock()
            .map(|s| s.active.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for root in roots {
            let _ = self.stop_project(&root);
        }
    }
}
impl Drop for ChatHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn find_turn<'a>(state: &'a mut State, root: &Path, request: &str) -> Option<&'a mut Turn> {
    state
        .books
        .get_mut(root)?
        .conversations
        .iter_mut()
        .flat_map(|c| &mut c.turns)
        .find(|t| t.request_id == request)
}
fn spawn(plan: &Value) -> Result<Child, ContractError> {
    for file in plan["files"].as_array().into_iter().flatten() {
        let path = Path::new(file["path"].as_str().unwrap());
        fs::create_dir_all(path.parent().unwrap()).map_err(failure)?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(path)
            .and_then(|mut out| out.write_all(file["contents"].as_str().unwrap().as_bytes()))
            .map_err(failure)?;
    }
    let mut command = Command::new(plan["executable"].as_str().unwrap());
    command.args(
        plan["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap()),
    );
    command
        .current_dir(plan["cwd"].as_str().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("OMENFLOW_") {
            command.env_remove(key);
        }
    }
    for (key, value) in plan["env"].as_object().unwrap() {
        command.env(key, value.as_str().unwrap());
    }
    for (key, value) in plan["envDefaults"].as_object().unwrap() {
        if std::env::var_os(key).is_none() {
            command.env(key, value.as_str().unwrap());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map_err(failure)
}
fn kill_tree(child: &mut Child, force: bool) {
    #[cfg(unix)]
    unsafe {
        libc::kill(
            -(child.id() as i32),
            if force { libc::SIGKILL } else { libc::SIGTERM },
        );
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = force;
        let _ = child.kill();
    }
}
/// Reserve the leader's PID until all remaining group members have been stopped.
/// Stop and this waiter share the Child mutex, so neither can signal a reaped ID.
#[cfg(unix)]
fn finish_if_exited(child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
    // SAFETY: zeroed siginfo is valid for waitid. WNOHANG leaves si_pid at zero
    // when the owned child has not exited; WNOWAIT deliberately does not reap it.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    kill_tree(child, true);
    child.wait().map(Some)
}
#[cfg(not(unix))]
fn finish_if_exited(child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
    let status = child.try_wait()?;
    if status.is_some() {
        kill_tree(child, true);
    }
    Ok(status)
}

fn cleanup(plan: &Value) {
    for f in plan["files"].as_array().into_iter().flatten() {
        if let Some(p) = f["path"].as_str() {
            let _ = fs::remove_file(p);
        }
    }
}
#[derive(Default)]
struct Output {
    complete: bool,
    error: Option<String>,
    bytes: usize,
    claude_start: Option<usize>,
    claude_text_block: bool,
    codex_item: Option<(String, usize)>,
}
fn normalize_diagnostic(text: &str) -> String {
    fn extract(value: &Value, depth: usize) -> Option<String> {
        if depth == 0 {
            return None;
        }
        match value {
            Value::String(text) => {
                let text = text.trim();
                serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|nested| extract(&nested, depth - 1))
                    .or_else(|| (!text.is_empty()).then(|| text.to_owned()))
            }
            Value::Object(_) => [
                value.pointer("/error/message"),
                value.get("message"),
                value.get("result"),
                value.get("error"),
            ]
            .into_iter()
            .flatten()
            .find_map(|nested| extract(nested, depth - 1)),
            _ => None,
        }
    }
    let text = text.trim();
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| extract(&value, 8))
        .unwrap_or_else(|| text.to_owned())
        .chars()
        .take(DIAGNOSTIC_LIMIT)
        .collect()
}
fn read_stderr(mut stderr: impl Read) -> String {
    // Keep a bounded diagnostic, but drain the pipe so a noisy CLI cannot block.
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let keep = count.min(STDERR_LIMIT - retained.len());
                retained.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    normalize_diagnostic(&String::from_utf8_lossy(&retained))
}
/// Replace the response from `start` on with `text`. False when it already reads so.
fn replace_from(response: &mut String, start: usize, text: &str) -> bool {
    if response.get(start..) == Some(text) {
        return false;
    }
    response.truncate(start);
    response.push_str(text);
    true
}
/// Apply one line of the agent's stream to its turn. True when the response text changed.
fn ingest(turn: &mut Turn, output: &mut Output, adapter: &str, line: &str) -> bool {
    output.bytes += line.len();
    if output.bytes > OUTPUT_LIMIT {
        output.error = Some("Agent output exceeded 1 MiB. Response stopped.".into());
        return false;
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            output.error = Some(
                "The agent returned invalid structured output. Check the CLI version in Settings."
                    .into(),
            );
            return false;
        }
    };
    // Claude emits subagent records on the same stdout stream. They have their own
    // reconciliation/completion owner and must not reset or finish the parent response.
    if adapter == "claude-code"
        && value
            .get("parent_tool_use_id")
            .is_some_and(|id| !id.is_null())
    {
        return false;
    }
    // Every other edit appends, so a rewrite in place is the only change the length can miss.
    let before = turn.response.len();
    let mut rewritten = false;
    match (adapter, value["type"].as_str().unwrap_or("")) {
        ("codex", "item.updated" | "item.completed")
            if value["item"]["type"] == "agent_message" =>
        {
            if let Some(text) = value["item"]["text"].as_str() {
                let id = value["item"]["id"].as_str();
                if let Some((_, start)) = output
                    .codex_item
                    .as_ref()
                    .filter(|(old, _)| Some(old.as_str()) == id)
                {
                    rewritten = replace_from(&mut turn.response, *start, text);
                } else {
                    if !turn.response.is_empty() {
                        turn.response.push_str("\n\n");
                    }
                    output.codex_item = id.map(|id| (id.to_owned(), turn.response.len()));
                    turn.response.push_str(text);
                }
            }
        }
        ("codex", "turn.completed") => output.complete = true,
        ("codex", "error" | "turn.failed") => {
            output.error = Some(normalize_diagnostic(
                value["error"]["message"]
                    .as_str()
                    .or(value["message"].as_str())
                    .unwrap_or("The agent reported an error"),
            ))
        }
        ("claude-code", "stream_event") => {
            let event = &value["event"];
            if event["type"] == "message_start" {
                output.claude_start = None;
                output.claude_text_block = false;
            }
            if event["type"] == "content_block_start" && event["content_block"]["type"] == "text" {
                if output.claude_text_block {
                    turn.response.push_str("\n\n");
                }
                output.claude_text_block = true;
            }
            if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                if let Some(text) = event["delta"]["text"].as_str() {
                    if output.claude_start.is_none() {
                        if !turn.response.is_empty() {
                            turn.response.push_str("\n\n");
                        }
                        output.claude_start = Some(turn.response.len());
                    }
                    turn.response.push_str(text);
                }
            }
        }
        ("claude-code", "assistant") => {
            let aggregate = value["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !aggregate.is_empty() {
                if let Some(start) = output.claude_start.take() {
                    rewritten = replace_from(&mut turn.response, start, &aggregate);
                } else {
                    if !turn.response.is_empty() {
                        turn.response.push_str("\n\n");
                    }
                    turn.response.push_str(&aggregate);
                }
            }
        }
        ("claude-code", "result") => {
            output.complete = value["subtype"] == "success" && value["is_error"] != true;
            if !output.complete {
                output.error = Some(normalize_diagnostic(
                    value["result"]
                        .as_str()
                        .unwrap_or("Claude reported an unsuccessful result"),
                ));
            }
            if turn.response.is_empty() {
                if let Some(text) = value["result"].as_str() {
                    turn.response = text.into();
                }
            }
        }
        _ => {}
    }
    rewritten || turn.response.len() != before
}
#[allow(clippy::too_many_arguments)]
fn run(
    state: Arc<Mutex<State>>,
    process: Arc<Process>,
    bridge: Arc<BridgeServer>,
    project: String,
    root: PathBuf,
    request: String,
    adapter: String,
    session: String,
    plan: Value,
    prompt: String,
) {
    let (stdin, stdout, stderr) = {
        let mut guard = process.child.lock().unwrap();
        let child = guard.as_mut().unwrap();
        (
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            child.stderr.take().unwrap(),
        )
    };
    let writer = thread::spawn(move || {
        let mut stdin = stdin;
        stdin.write_all(prompt.as_bytes())
    });
    let stderr_reader = thread::spawn(move || read_stderr(stderr));
    let stream_state = Arc::clone(&state);
    let stream_process = Arc::clone(&process);
    let stream_project = project.clone();
    let stream_root = root.clone();
    let stream_request = request.clone();
    let reader = thread::spawn(move || {
        let mut out = Output::default();
        let mut reader = BufReader::new(stdout);
        let mut saved = Instant::now();
        loop {
            let mut bytes = Vec::new();
            let read = reader
                .by_ref()
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes);
            match read {
                Ok(0) => break,
                Err(e) => {
                    out.error = Some(format!("Could not read the agent response: {e}"));
                    break;
                }
                _ => {}
            }
            if let Ok(mut state) = stream_state.lock() {
                let changed =
                    find_turn(&mut state, &stream_root, &stream_request).is_some_and(|t| {
                        match std::str::from_utf8(&bytes) {
                            Ok(line) => ingest(t, &mut out, &adapter, line.trim()),
                            Err(_) => {
                                out.error = Some("Agent output was not UTF-8".into());
                                false
                            }
                        }
                    });
                if changed {
                    state.changed(&stream_project);
                }
                // Readers see each line from memory; the record file follows a few times a second
                // and is written once more when the run settles.
                if saved.elapsed() >= SAVE_EVERY {
                    if let Err(e) = save(&stream_root, &state.books[&stream_root]) {
                        out.error = Some(e.message);
                    }
                    saved = Instant::now();
                }
            }
            if out.error.is_some() {
                if let Ok(mut child) = stream_process.child.lock() {
                    if let Some(c) = child.as_mut() {
                        kill_tree(c, true);
                    }
                }
                break;
            }
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        let mut guard = process.child.lock().unwrap();
        let child = guard.as_mut().unwrap();
        if started.elapsed() > Duration::from_secs(1800) {
            kill_tree(child, true);
        }
        match finish_if_exited(child) {
            Ok(Some(status)) => {
                *guard = None;
                break Ok(status);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                // An observation failure gives no safe basis to signal a numeric PID.
                *guard = None;
                break Err(e);
            }
            _ => {}
        }
        drop(guard);
        thread::sleep(Duration::from_millis(25));
    };
    let output = reader.join().unwrap_or_else(|_| Output {
        error: Some("The response reader stopped unexpectedly".into()),
        ..Output::default()
    });
    let stderr = stderr_reader.join().unwrap_or_default();
    let wrote = writer.join().is_ok_and(|r| r.is_ok());
    bridge.revoke(&session);
    cleanup(&plan);
    if let Ok(mut state) = state.lock() {
        if let Some(t) = find_turn(&mut state, &root, &request) {
            if process.cancelled.load(Ordering::SeqCst) {
                t.state = "cancelled".into();
                t.error = Some(
                    "You stopped this response. Review any engineering changes already recorded."
                        .into(),
                );
            } else if status.is_ok_and(|s| s.success())
                && wrote
                && output.complete
                && output.error.is_none()
            {
                t.state = "completed".into();
            } else {
                t.state = "failed".into();
                t.error = Some(output.error.unwrap_or_else(|| {
                    if stderr.is_empty() {
                        "The agent exited without a successful completion event. Check its sign-in and configuration in Settings.".into()
                    } else {
                        stderr
                    }
                }));
            }
        }
        if let Err(error) = save(&root, &state.books[&root]) {
            if let Some(turn) = find_turn(&mut state, &root, &request) {
                turn.state = "failed".into();
                turn.error = Some(format!(
                    "Could not save the final response: {}",
                    error.message
                ));
            }
        }
        state.active.remove(&root);
        state.changed(&project);
    }
    *process.done.lock().unwrap() = true;
    process.settled.notify_all();
}
#[cfg(test)]
mod tests {
    use super::*;
    fn turn() -> Turn {
        Turn {
            request_id: "r".into(),
            text: "question".into(),
            response: String::new(),
            parts: vec![],
            input: None,
            adapter_id: "codex".into(),
            session_id: None,
            state: "running".into(),
            error: None,
            created_at: crate::now(),
        }
    }
    #[test]
    fn nested_claude_records_cannot_reset_append_complete_or_fail_the_parent_response() {
        let mut t = turn();
        let mut out = Output::default();
        let mut feed = |value: Value| ingest(&mut t, &mut out, "claude-code", &value.to_string());
        feed(
            serde_json::json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}),
        );
        feed(
            serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Parent partial: 12.40 mm Ω"}}}),
        );
        for child in [
            serde_json::json!({"type":"stream_event","event":{"type":"message_start"}}),
            serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"INTERNAL CHILD PARTIAL"}}}),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"INTERNAL CHILD RESULT"}]}}),
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"result":"child complete"}),
            serde_json::json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":"child failed"}),
        ] {
            let mut child = child;
            child["parent_tool_use_id"] = serde_json::json!("child-tool");
            feed(child);
        }
        assert_eq!(t.response, "Parent partial: 12.40 mm Ω");
        assert!(!out.complete);
        assert!(out.error.is_none());
        assert_eq!(out.claude_start, Some(0));
        assert!(ingest(&mut t, &mut out, "claude-code", &serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Parent corrected: 12.40 mm Ω"}]}}).to_string()));
        assert_eq!(t.response, "Parent corrected: 12.40 mm Ω");
        ingest(
            &mut t,
            &mut out,
            "claude-code",
            r#"{"type":"result","subtype":"success","result":"Parent corrected: 12.40 mm Ω"}"#,
        );
        assert!(out.complete);
    }
    #[test]
    fn genuine_claude_deltas_preserve_unicode_and_text_block_boundaries_without_duplicate_aggregate(
    ) {
        let mut t = turn();
        let mut out = Output::default();
        for event in [
            serde_json::json!({"type":"message_start"}),
            serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Width 12.40 mm; Ω"}}),
            serde_json::json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            serde_json::json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Load unknown — 机"}}),
        ] {
            ingest(
                &mut t,
                &mut out,
                "claude-code",
                &serde_json::json!({"type":"stream_event","event":event}).to_string(),
            );
        }
        assert_eq!(t.response, "Width 12.40 mm; Ω\n\nLoad unknown — 机");
        assert!(!out.complete, "Partial EOF must not imply completion");
        assert!(
            !ingest(&mut t, &mut out, "claude-code", &serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Width 12.40 mm; Ω"},{"type":"text","text":"Load unknown — 机"}]}}).to_string()),
            "an aggregate that repeats the streamed text changes nothing"
        );
        assert_eq!(t.response, "Width 12.40 mm; Ω\n\nLoad unknown — 机");
        assert!(!out.complete);
        ingest(
            &mut t,
            &mut out,
            "claude-code",
            r#"{"type":"result","subtype":"success","result":"Width 12.40 mm; Ω"}"#,
        );
        assert!(out.complete);
    }
    #[test]
    fn cumulative_codex_items_replace_only_their_owned_item() {
        let mut t = turn();
        let mut out = Output::default();
        for (kind, id, text) in [
            ("item.updated", "one", "12"),
            ("item.updated", "one", "12.40 mm"),
            ("item.completed", "one", "12.40 mm"),
            ("item.completed", "two", "Check pending."),
        ] {
            ingest(&mut t, &mut out, "codex", &serde_json::json!({"type":kind,"item":{"id":id,"type":"agent_message","text":text}}).to_string());
        }
        assert_eq!(t.response, "12.40 mm\n\nCheck pending.");
        assert!(!out.complete);
    }
    #[test]
    fn provider_diagnostics_unwrap_nested_json_messages() {
        let message =
            "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
        let provider_error = serde_json::json!({
            "type": "error",
            "status": 400,
            "error": {"type": "invalid_request_error", "message": message}
        })
        .to_string();
        assert_eq!(normalize_diagnostic(&provider_error), message);
        assert_eq!(read_stderr(provider_error.as_bytes()), message);
        let event =
            serde_json::json!({"type": "turn.failed", "error": {"message": provider_error}});
        assert_eq!(normalize_diagnostic(&event.to_string()), message);
        let mut t = turn();
        let mut out = Output::default();
        ingest(&mut t, &mut out, "codex", &event.to_string());
        assert_eq!(out.error.as_deref(), Some(message));
        assert!(!out.complete);
        assert!(t.response.is_empty());

        let result = serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": serde_json::json!({"message": serde_json::json!({"result": message}).to_string()}).to_string()
        });
        ingest(&mut t, &mut out, "claude-code", &result.to_string());
        assert_eq!(out.error.as_deref(), Some(message));
        assert!(!out.complete);
    }

    #[test]
    fn plain_stderr_and_malformed_json_remain_readable() {
        let plain = "Sign-in required.\nRun the CLI login command, then retry.";
        assert_eq!(read_stderr(format!("\n{plain}\n").as_bytes()), plain);
        let malformed = r#"{"error":{"message":"Sign-in required"}"#;
        assert_eq!(normalize_diagnostic(malformed), malformed);
        assert_eq!(read_stderr(malformed.as_bytes()), malformed);
        assert_eq!(normalize_diagnostic(" \n\t "), "");
    }

    #[test]
    fn diagnostics_are_unicode_safe_bounded_and_stderr_is_fully_drained() {
        let long = "測".repeat(DIAGNOSTIC_LIMIT + 100);
        let encoded = serde_json::json!({"error": {"message": long}}).to_string();
        assert_eq!(
            normalize_diagnostic(&encoded),
            "測".repeat(DIAGNOSTIC_LIMIT)
        );
        let mut pipe = std::io::Cursor::new(vec![b'x'; STDERR_LIMIT * 3]);
        assert_eq!(read_stderr(&mut pipe), "x".repeat(DIAGNOSTIC_LIMIT));
        assert_eq!(pipe.position(), (STDERR_LIMIT * 3) as u64);
        let deeply_nested = (0..32).fold(
            Value::String("original message".into()),
            |message, _| serde_json::json!({"message": message}),
        );
        assert!(
            normalize_diagnostic(&deeply_nested.to_string())
                .chars()
                .count()
                <= DIAGNOSTIC_LIMIT
        );
    }

    #[test]
    fn structured_streams_require_explicit_completion_and_keep_units() {
        let mut t = turn();
        let mut out = Output::default();
        ingest(
            &mut t,
            &mut out,
            "codex",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Width: 20 mm. Unknown load: not measured."}}"#,
        );
        assert!(!out.complete);
        assert!(t.response.contains("20 mm"));
        ingest(&mut t, &mut out, "codex", r#"{"type":"turn.completed"}"#);
        assert!(out.complete);
        let mut t = turn();
        let mut out = Output::default();
        ingest(
            &mut t,
            &mut out,
            "claude-code",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"A draft."},{"type":"tool_use","name":"proposal_approve"}]}}"#,
        );
        assert_eq!(t.response, "A draft.");
        assert!(!out.complete);
        ingest(
            &mut t,
            &mut out,
            "claude-code",
            r#"{"type":"result","subtype":"success","result":"A draft."}"#,
        );
        assert!(out.complete);
    }
    #[test]
    fn read_only_snapshot_never_rewrites_a_foreign_running_record() {
        let dir = tempfile::tempdir().unwrap();
        let book = Book {
            version: 1,
            conversations: vec![Conversation {
                id: "foreign".into(),
                title: "Snapshot".into(),
                turns: vec![turn()],
                cards: vec![],
            }],
        };
        save(dir.path(), &book).unwrap();
        let before = fs::read(file(dir.path())).unwrap();
        let mut state = State::default();
        load(&mut state, dir.path(), false).unwrap();
        assert_eq!(
            state.books[dir.path()].conversations[0].turns[0].state,
            "unavailable"
        );
        assert_eq!(fs::read(file(dir.path())).unwrap(), before);
    }

    #[test]
    fn terminal_redraws_are_rejected_and_restart_does_not_invent_completion() {
        let mut t = turn();
        let mut out = Output::default();
        ingest(&mut t, &mut out, "codex", "\x1b[2JNot chat");
        assert!(out.error.is_some());
        assert!(t.response.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let book = Book {
            version: 1,
            conversations: vec![Conversation {
                id: "c".into(),
                title: "Title".into(),
                turns: vec![turn()],
                cards: vec![],
            }],
        };
        save(dir.path(), &book).unwrap();
        let mut state = State::default();
        load(&mut state, dir.path(), true).unwrap();
        assert_eq!(
            state.books[dir.path()].conversations[0].turns[0].state,
            "interrupted"
        );
        assert_eq!(
            state.books[dir.path()].conversations[0].turns[0].request_id,
            "r"
        );
    }
}
