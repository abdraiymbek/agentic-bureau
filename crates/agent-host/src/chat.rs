//! Durable project conversations over adapter-native JSON streams, never terminal redraws.
//! Acceptance is journaled before spawn. Request IDs stay deduplicated across host restarts.
//! When a run ends the host reads the completion gate for the turn's agent sessions and records
//! it on the turn. With the setting on, it continues unfinished work once per message the
//! person sent, as its own labelled request.
use crate::session::plain_id;
use crate::{BridgeServer, EventSink, HostEvent};
use omenflow_contracts::ContractError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// The response text of one turn. The record file may hold 32 times this.
const OUTPUT_LIMIT: usize = 1024 * 1024;
/// The stream of one run other than tool results: text, tool inputs and events.
const STREAM_LIMIT: usize = 16 * 1024 * 1024;
/// The tool results of one run. They can carry pictures and nothing keeps them, so they are
/// counted apart and dropped.
const TOOL_RESULT_LIMIT: usize = 256 * 1024 * 1024;
/// One stream line held in memory to learn what it is.
const LINE_LIMIT: usize = 64 * 1024 * 1024;
const PROMPT_LIMIT: usize = 256 * 1024;
const DIAGNOSTIC_LIMIT: usize = 2000;
const STDERR_LIMIT: usize = 16 * 1024;
/// Outstanding items a turn records; work_status lists them all.
const GATE_ITEMS: usize = 5;
/// What Continue sends, and Omen Flow's one automatic continuation. Kept equal to
/// `CHAT_CONTINUE_TEXT` in packages/contracts/src/chat.ts.
pub(crate) const CONTINUE_TEXT: &str = "Continue the unfinished work that work_status reported, through tool calls, using only facts you can observe or that the project records. Leave any item that needs information you do not have and name it. Finish when work_status, or the workStatus digest in a tool reply, reports ready, or name every remaining blocker.";
const TOO_LONG: &str = "This conversation is too long for a new request";
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continues: Option<Continues>,
    /// What work_status reported when the run ended, as the host recorded it ([`Gate`]). Kept
    /// as JSON, so a later build's shape survives a save here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gate: Option<Value>,
    /// The model id passed to the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// The model the CLI reported it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolved_model: Option<String>,
    /// Tokens the CLI reported ([`Usage`]). Never a cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<Value>,
    /// The id the CLI keeps the conversation under, when it can be resumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cli_conversation_id: Option<String>,
    /// Fields a later build recorded, kept as they are.
    #[serde(flatten)]
    extra: Map<String, Value>,
}
/// The turn a request continues.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Continues {
    #[serde(default)]
    request_id: String,
    /// True only when Omen Flow sent it. The transport cannot set it.
    #[serde(default)]
    automatic: bool,
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
/// What a conversation run needs from the host it runs in. The host takes its agent-start lock
/// before the conversation state, and the conversation state before the core.
pub(crate) trait ChatHooks: Send + Sync {
    /// The completion gate over these agent sessions as one scope.
    fn work_status(&self, project: &str, sessions: &[String]) -> Result<Value, ContractError>;
    /// Whether Settings asks for one automatic continuation of unfinished work.
    fn auto_continue(&self) -> bool;
    /// Held from the check to the start of an agent: one agent works in a project at a time.
    fn start_lock(&self) -> MutexGuard<'_, ()>;
    /// Check that a run may start, and prepare its headless plan (`PtyHost::prepare_headless`).
    fn prepare(
        &self,
        project: &str,
        input: &Value,
        resume: Option<&str>,
    ) -> Result<Value, ContractError>;
}
/// What the host and its run threads share.
#[derive(Clone)]
struct Context {
    state: Arc<Mutex<State>>,
    bridge: Arc<BridgeServer>,
    hooks: Arc<dyn ChatHooks>,
}
pub(crate) struct ChatHost {
    cx: Context,
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
    pub fn new(
        bridge: Arc<BridgeServer>,
        state: Arc<Mutex<State>>,
        hooks: Arc<dyn ChatHooks>,
    ) -> Self {
        Self {
            cx: Context {
                state,
                bridge,
                hooks,
            },
        }
    }
    pub fn command(
        &self,
        op: &str,
        project: &str,
        root: &Path,
        input: &Value,
        read_only: bool,
    ) -> Result<Value, ContractError> {
        if op == "chat.cancel" {
            self.cancel(root, input["conversationId"].as_str())?;
        }
        let mut state = self.cx.state.lock().map_err(failure)?;
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
        if op == "chat.send" {
            accept(
                &mut state,
                &self.cx,
                project,
                root,
                &Request::from_send(input),
            )?;
        }
        serde_json::to_value(&state.books[root]).map_err(failure)
    }
    fn cancel(&self, root: &Path, conversation: Option<&str>) -> Result<(), ContractError> {
        let process = {
            let state = self.cx.state.lock().map_err(failure)?;
            let owns = conversation.is_none()
                || state.books.get(root).is_some_and(|b| {
                    b.conversations.iter().any(|c| {
                        Some(c.id.as_str()) == conversation
                            && c.turns.iter().any(|t| t.state == "running")
                    })
                });
            let found = if owns {
                state.active.get(root).cloned()
            } else {
                None
            };
            // Under the lock: a run settling now either sees this Stop, or has already handed
            // the project to its continuation, which this Stop then reaches.
            if let Some(process) = &found {
                process.cancelled.store(true, Ordering::SeqCst);
            }
            found
        };
        if let Some(p) = process {
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
        self.cx.state.lock().is_ok_and(|s| !s.active.is_empty())
    }
    /// True while a conversation run is active in this project.
    pub fn running_in(&self, root: &Path) -> bool {
        self.cx
            .state
            .lock()
            .is_ok_and(|s| s.active.contains_key(root))
    }
    pub fn shutdown(&self) {
        let roots = self
            .cx
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

/// A request to run the agent in a conversation: one the person sent, or Omen Flow's one
/// continuation.
struct Request {
    conversation_id: String,
    request_id: String,
    adapter_id: String,
    text: String,
    input: Option<Value>,
    continues: Option<Continues>,
}
impl Request {
    /// A `chat.send` input, checked against its contract. The transport keeps only
    /// `continues.requestId`, so a request it carries is never automatic.
    fn from_send(input: &Value) -> Self {
        let text = |key: &str| input[key].as_str().unwrap_or_default().to_owned();
        Self {
            conversation_id: text("conversationId"),
            request_id: text("requestId"),
            adapter_id: text("adapterId"),
            text: text("text"),
            input: input.get("input").cloned(),
            continues: input["continues"]["requestId"]
                .as_str()
                .map(|id| Continues {
                    request_id: id.to_owned(),
                    automatic: false,
                }),
        }
    }
}
impl Turn {
    /// A request as it is accepted: running, with no response yet.
    fn accepted(request: &Request, session_id: Option<String>, plan: &Value) -> Self {
        let text = |key: &str| plan[key].as_str().map(str::to_owned);
        Self {
            request_id: request.request_id.clone(),
            text: request.text.clone(),
            response: String::new(),
            parts: Vec::new(),
            input: request.input.clone(),
            adapter_id: request.adapter_id.clone(),
            session_id,
            state: "running".into(),
            error: None,
            created_at: crate::now(),
            continues: request.continues.clone(),
            gate: None,
            model: text("model"),
            resolved_model: None,
            usage: None,
            cli_conversation_id: text("conversationId"),
            extra: Map::new(),
        }
    }
}
fn same_continues(a: Option<&Continues>, b: Option<&Continues>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.request_id == b.request_id && a.automatic == b.automatic,
        _ => false,
    }
}
enum Accepted {
    Started,
    /// The request ID was accepted before with the same contents; nothing ran.
    Replayed,
}
/// Accept a request durably and start its run. Called with the chat lock held, from a
/// command or from a run that continues itself.
fn accept(
    state: &mut State,
    cx: &Context,
    project: &str,
    root: &Path,
    request: &Request,
) -> Result<Accepted, ContractError> {
    if request.text.trim().is_empty() {
        return Err(ContractError::validation(
            "Message text must contain something other than whitespace",
        ));
    }
    if let Some(fields) = request.input.as_ref().and_then(|i| i["fields"].as_array()) {
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
    let book = &state.books[root];
    if let Some((conversation, turn)) = book.conversations.iter().find_map(|c| {
        c.turns
            .iter()
            .find(|t| t.request_id == request.request_id)
            .map(|t| (c, t))
    }) {
        if conversation.id != request.conversation_id
            || turn.text != request.text
            || turn.adapter_id != request.adapter_id
            || turn.input != request.input
            || !same_continues(turn.continues.as_ref(), request.continues.as_ref())
        {
            return Err(ContractError::validation(
                "This request ID was already accepted with different contents",
            ));
        }
        return Ok(Accepted::Replayed);
    }
    if state.active.contains_key(root) {
        return Err(
            ContractError::new("BUSY", "An agent is already working in this project")
                .with_repair("Stop that response or wait until it finishes, then send."),
        );
    }
    let conversation = book
        .conversations
        .iter()
        .find(|c| c.id == request.conversation_id);
    if book.conversations.len() >= 200 && conversation.is_none() {
        return Err(failure(
            "The project has reached its 200 conversation limit",
        ));
    }
    let continued = match &request.continues {
        Some(continues) => Some(
            conversation
                .and_then(|c| c.turns.last())
                .filter(|t| t.request_id == continues.request_id)
                .ok_or_else(|| {
                    ContractError::validation(
                        "Only the latest turn of a conversation can be continued",
                    )
                    .with_repair("Send a new message instead.")
                })?,
        ),
        None => None,
    };
    // Claude Code continues its own conversation of a turn that completed; anything else
    // replays the conversation as text. The id comes from the record file, which anything that
    // writes the project folder can change, and it becomes an argument: an id the CLI would not
    // give replays too.
    let resume = continued
        .filter(|t| {
            t.adapter_id == "claude-code"
                && request.adapter_id == "claude-code"
                && t.state == "completed"
        })
        .and_then(|t| t.cli_conversation_id.clone())
        .filter(|id| plain_id(id));
    let gate = continued.and_then(|t| t.gate.clone());
    let replay = replay_prompt(conversation, request, gate.as_ref());
    let too_long = || {
        ContractError::validation(TOO_LONG)
            .with_repair("Start a new conversation; the engineering record remains available.")
    };
    if resume.is_none() && replay.len() > PROMPT_LIMIT {
        return Err(too_long());
    }
    let mut prepare_input = json!({"adapterId": request.adapter_id});
    if let Some(input) = &request.input {
        prepare_input["input"] = input.clone();
    }
    // Validation and adapter probes happen before durable acceptance, without starting a PTY.
    let plan = cx
        .hooks
        .prepare(project, &prepare_input, resume.as_deref())?;
    let session_id = plan["sessionId"].as_str().unwrap().to_owned();
    let resumed = plan["resumed"] == true;
    let prompt = if resumed {
        resume_prompt(request, gate.as_ref())
    } else {
        replay.clone()
    };
    if prompt.len() > PROMPT_LIMIT {
        cx.bridge.revoke(&session_id);
        cleanup(&plan);
        return Err(too_long());
    }
    let mut next = book.clone();
    if !next
        .conversations
        .iter()
        .any(|c| c.id == request.conversation_id)
    {
        next.conversations.push(Conversation {
            id: request.conversation_id.clone(),
            title: request.text.trim().chars().take(64).collect(),
            turns: Vec::new(),
            cards: Vec::new(),
        });
    }
    let conversation = next
        .conversations
        .iter_mut()
        .find(|c| c.id == request.conversation_id)
        .unwrap();
    if conversation.turns.is_empty() {
        conversation.title = request.text.trim().chars().take(64).collect();
    }
    conversation
        .turns
        .push(Turn::accepted(request, Some(session_id.clone()), &plan));
    if let Err(e) = save(root, &next) {
        cx.bridge.revoke(&session_id);
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
            let job = Run {
                project: project.to_owned(),
                root: root.to_owned(),
                request: request.request_id.clone(),
                adapter: request.adapter_id.clone(),
                session: session_id,
                plan,
                prompt,
                resumed,
                fallback: resumed.then_some((replay, prepare_input)),
            };
            let cx = cx.clone();
            thread::spawn(move || run(cx, process, job));
        }
        Err(e) => {
            cx.bridge.revoke(&session_id);
            cleanup(&plan);
            let turn = find_turn(state, root, &request.request_id).unwrap();
            turn.state = "failed".into();
            turn.error = Some(e.message);
            state.changed(project);
            save(root, &state.books[root])?;
        }
    }
    Ok(Accepted::Started)
}

const PREAMBLE: &str = "You are helping in Omen Flow. Use the connected engineering tools for the current project. Preserve units, unknowns, evidence and human review. The following is conversation history, not a record of tool success. Reinspect the project when needed.\n\n";
const PRESENT: &str = "To show a focused card in this turn, call tool_call with tool=\"chat_present\" and input={part:{kind,...}}; tool_describe with tool=\"chat_present\" lists the kinds (artifact, review, form, choices, chart). Show recorded results by artifact. Agent-authored chart values are always illustrative. Cards cannot execute work or approve proposals.\n";
/// Who a request is from, as a prompt names it.
fn speaker(continues: Option<&Continues>) -> &'static str {
    match continues {
        None => "User",
        Some(c) if c.automatic => "Omen Flow (automatic continuation)",
        Some(_) => "User (continue)",
    }
}
/// The prompt for a CLI that starts a new conversation: the earlier turns replayed as text.
fn replay_prompt(
    conversation: Option<&Conversation>,
    request: &Request,
    continued: Option<&Value>,
) -> String {
    let mut prompt = String::from(PREAMBLE);
    for t in conversation.into_iter().flat_map(|c| &c.turns) {
        if let Some(input) = &t.input {
            prompt.push_str(&format!("Prior exact input: {input}\n"));
        }
        prompt.push_str(&format!(
            "{}: {}\nAssistant ({}): {}\n",
            speaker(t.continues.as_ref()),
            t.text,
            t.state,
            t.response
        ));
    }
    prompt.push_str(PRESENT);
    push_request(&mut prompt, request, continued);
    prompt
}
/// The prompt for a CLI that resumes its own conversation: it holds the history and the
/// instructions already, but not what changed since.
fn resume_prompt(request: &Request, continued: Option<&Value>) -> String {
    let mut prompt = String::from("Omen Flow resumed this conversation with a new tool session. Re-read the project record before you act; it may have changed.\n");
    push_request(&mut prompt, request, continued);
    prompt
}
fn push_request(prompt: &mut String, request: &Request, continued: Option<&Value>) {
    if let Some(gate) = continued {
        prompt.push_str(&gate_brief(gate));
    }
    prompt.push_str(&format!(
        "{}: {}\n",
        speaker(request.continues.as_ref()),
        request.text
    ));
    if let Some(exact) = &request.input {
        prompt.push_str(&format!("Exact user-approved input attachment (preserve the original text, units, unknowns and revision identity): {exact}\nRe-read this artifact and refuse stale revisions. If intent is render, use cad_read_source and cad_write_source with expectedRevisionId from the attachment, exact values converted only by recorded units, then real cad_check with the recorded scope and autoCommit true and proposal_submit. Present the resulting artifact and proposal with tool_call tool=\"chat_present\". Never claim a failed/unrun check passed. Unknown fields need clarification.\n"));
    }
}
/// What the host read from work_status after the reply being continued. Only a continuation's
/// prompt carries it: a history replay names no earlier gate.
fn gate_brief(gate: &Value) -> String {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let mut brief = format!(
        "Omen Flow ran work_status after the previous reply (recorded by the host, not by the agent): {}\n",
        text(&gate["summary"])
    );
    if gate["calls"] == 0 {
        brief.push_str("No Omen Flow tool was called in that reply.\n");
    }
    let items = gate["outstanding"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !items.is_empty() {
        brief.push_str("Outstanding:\n");
    }
    for item in items {
        let next = match item["tool"].as_str() {
            Some(tool) => format!("Next: {tool}."),
            None => "Needs the person.".to_owned(),
        };
        brief.push_str(&format!(
            "- {} ({}): {} {next}\n",
            text(&item["title"]),
            text(&item["kind"]),
            text(&item["detail"])
        ));
    }
    let more = gate["more"].as_u64().unwrap_or(0);
    if more > 0 {
        brief.push_str(&format!(
            "- {more} more: call work_status for the full list.\n"
        ));
    }
    brief
}

/// The completion gate when a turn ended, as recorded on the turn (`ChatGate`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Gate {
    ready: bool,
    summary: String,
    blockers: u64,
    advice: u64,
    waiting: u64,
    outstanding: Vec<Value>,
    more: u64,
    session_ids: Vec<String>,
    calls: u64,
    in_scope: u64,
    jobs_running: u64,
    checked_at: String,
}
/// What Omen Flow did about unfinished work when a turn ended (`gate.auto`).
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum Auto {
    Off,
    Started {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Skipped {
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}
impl Auto {
    fn skipped(reason: &'static str) -> Self {
        Self::Skipped {
            reason,
            detail: None,
        }
    }
}
/// Why a continuation that was due did not start.
fn skip_reason(error: &ContractError) -> Auto {
    match error.code.as_str() {
        "BUSY" => Auto::skipped("busy"),
        "VALIDATION" if error.message.starts_with(TOO_LONG) => Auto::skipped("prompt_limit"),
        "NOT_FOUND" => Auto::skipped("project_closed"),
        "READ_ONLY" => Auto::skipped("read_only"),
        _ => Auto::Skipped {
            reason: "agent_unavailable",
            detail: Some(clip(&error.message, 240)),
        },
    }
}
fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
/// Kinds an agent can resolve from the project record alone. Sourcing a component and
/// recording a seller offer need facts from outside the project, and a reviewer's request
/// is the person's conversation: none of them starts an automatic continuation.
fn resolvable(kind: &str) -> bool {
    kind.starts_with("cad_")
        || kind.starts_with("wiring_")
        || matches!(kind, "calculation_not_run" | "empty_payload")
}
/// The gate read when a run ended.
struct Assessed {
    /// The record for the turn, without `auto`.
    gate: Value,
    ready: bool,
    /// Some blocker is for the agent to resolve.
    actionable: bool,
    jobs_running: u64,
}
impl Assessed {
    fn from_report(report: &Value, sessions: Vec<String>, calls: u64) -> Self {
        let items = report["outstanding"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let count = |key: &str| report["counts"][key].as_u64().unwrap_or(0);
        let ready = report["ready"] == true;
        let jobs_running = report["jobsRunning"].as_u64().unwrap_or(0);
        let gate = Gate {
            ready,
            summary: clip(report["summary"].as_str().unwrap_or_default(), 400),
            blockers: count("blockers"),
            advice: count("advice"),
            waiting: report["waitingOnHuman"].as_array().map_or(0, Vec::len) as u64,
            outstanding: items
                .iter()
                .take(GATE_ITEMS)
                .map(|item| {
                    json!({
                        "kind": item["kind"],
                        "severity": item["severity"],
                        "artifactId": item["artifactId"],
                        "title": clip(item["title"].as_str().unwrap_or_default(), 120),
                        "detail": clip(item["detail"].as_str().unwrap_or_default(), 240),
                        "tool": item["next"]["tool"],
                    })
                })
                .collect(),
            more: (items.len().saturating_sub(GATE_ITEMS)) as u64
                + report["omitted"].as_u64().unwrap_or(0),
            session_ids: sessions,
            calls,
            in_scope: report["inScope"].as_u64().unwrap_or(0),
            jobs_running,
            checked_at: crate::now(),
        };
        Self {
            gate: serde_json::to_value(gate).unwrap_or_default(),
            ready,
            actionable: items.iter().any(|item| {
                item["severity"] == "blocker"
                    && item["next"]["tool"].is_string()
                    && resolvable(item["kind"].as_str().unwrap_or_default())
            }),
            jobs_running,
        }
    }
}
/// The agent sessions of a turn and of the turns it continues, oldest first.
fn chain_sessions(book: &Book, request: &str) -> Vec<String> {
    let Some(conversation) = book
        .conversations
        .iter()
        .find(|c| c.turns.iter().any(|t| t.request_id == request))
    else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    let mut next = Some(request.to_owned());
    for _ in 0..32 {
        let Some(turn) = next
            .take()
            .and_then(|id| conversation.turns.iter().find(|t| t.request_id == id))
        else {
            break;
        };
        sessions.extend(turn.session_id.clone());
        next = turn.continues.as_ref().map(|c| c.request_id.clone());
    }
    sessions.reverse();
    sessions
}
/// The request ID of the one continuation of `request`: the same on every attempt, so it is
/// deduplicated like any other, and within the transport's 128 characters.
fn auto_request_id(request: &str) -> String {
    format!("{}-auto", request.chars().take(123).collect::<String>())
}
enum Decision {
    /// Record this as `gate.auto`, or nothing when the work is finished.
    Record(Option<Auto>),
    Continue(Request),
}
/// What to do about a completed turn's unfinished work: once per message the person sent, and
/// only with the setting on. A continuation never continues itself.
fn auto_decision(
    conversation: &Conversation,
    ended: &Turn,
    assessed: &Assessed,
    setting: bool,
) -> Decision {
    if assessed.ready {
        return Decision::Record(None);
    }
    if !setting {
        return Decision::Record(Some(Auto::Off));
    }
    if !assessed.actionable {
        return Decision::Record(Some(Auto::skipped("needs_person")));
    }
    if assessed.jobs_running > 0 {
        return Decision::Record(Some(Auto::skipped("jobs_running")));
    }
    let automatic = |t: &Turn| t.continues.as_ref().is_some_and(|c| c.automatic);
    if automatic(ended)
        || conversation.turns.iter().any(|t| {
            automatic(t)
                && t.continues
                    .as_ref()
                    .is_some_and(|c| c.request_id == ended.request_id)
        })
    {
        return Decision::Record(Some(Auto::skipped("already_continued")));
    }
    Decision::Continue(Request {
        conversation_id: conversation.id.clone(),
        request_id: auto_request_id(&ended.request_id),
        adapter_id: ended.adapter_id.clone(),
        text: CONTINUE_TEXT.into(),
        input: None,
        continues: Some(Continues {
            request_id: ended.request_id.clone(),
            automatic: true,
        }),
    })
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
/// Tokens the CLI reported for a run (`ChatUsage`). Never a cost: a CLI prices models it does
/// not know at another model's rates.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    models: Vec<String>,
}
#[derive(Default)]
struct Output {
    complete: bool,
    error: Option<String>,
    /// Stream bytes other than tool results.
    bytes: usize,
    tool_result_bytes: usize,
    claude_start: Option<usize>,
    claude_text_block: bool,
    codex_item: Option<(String, usize)>,
    /// The run resumes the CLI's conversation, so its tools must connect again.
    resumed: bool,
    usage: Usage,
}
impl Output {
    fn count_tool_results(&mut self, bytes: usize) {
        self.tool_result_bytes += bytes;
        if self.tool_result_bytes > TOOL_RESULT_LIMIT {
            self.error = Some("Agent tool results exceeded 256 MiB. Response stopped.".into());
        }
    }
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
/// One record of an agent's stream.
enum Record {
    Line(Vec<u8>),
    /// A tool result too long to hold, read to its end and dropped: its length.
    Skipped(usize),
    Eof,
    Failed(String),
}
/// The next record of the agent's stream. A record longer than `OUTPUT_LIMIT` that starts as a
/// tool result is read to its end without being held; any other is held up to `LINE_LIMIT`,
/// so what it is can be read.
fn next_record(reader: &mut impl BufRead, adapter: &str) -> Record {
    read_record(reader, adapter, LINE_LIMIT)
}
fn read_record(reader: &mut impl BufRead, adapter: &str, line_limit: usize) -> Record {
    let unreadable = |error: std::io::Error| {
        Record::Failed(format!("Could not read the agent response: {error}"))
    };
    let mut bytes = Vec::new();
    match reader
        .by_ref()
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_until(b'\n', &mut bytes)
    {
        Ok(0) => return Record::Eof,
        Err(error) => return unreadable(error),
        Ok(_) => {}
    }
    if bytes.ends_with(b"\n") || bytes.len() <= OUTPUT_LIMIT {
        return Record::Line(bytes);
    }
    if tool_result_prefix(adapter, &bytes) {
        let mut skipped = bytes.len();
        loop {
            let available = match reader.fill_buf() {
                Ok(available) => available,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return unreadable(error),
            };
            if available.is_empty() {
                return Record::Skipped(skipped);
            }
            let (used, end) = match available.iter().position(|&byte| byte == b'\n') {
                Some(at) => (at + 1, true),
                None => (available.len(), false),
            };
            reader.consume(used);
            skipped += used;
            if end {
                return Record::Skipped(skipped);
            }
        }
    }
    let held = bytes.len();
    match reader
        .by_ref()
        .take((line_limit + 1).saturating_sub(held) as u64)
        .read_until(b'\n', &mut bytes)
    {
        Err(error) => unreadable(error),
        Ok(_) if bytes.ends_with(b"\n") || bytes.len() <= line_limit => Record::Line(bytes),
        Ok(_) => Record::Failed(format!(
            "An agent output line exceeded {} MiB. Response stopped.",
            line_limit / (1024 * 1024)
        )),
    }
}
/// Whether a record starts as a tool result, from its first bytes: Claude Code's `user`
/// records and Codex's `mcp_tool_call` items repeat what a tool returned, pictures included.
fn tool_result_prefix(adapter: &str, bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let head = &bytes[start..bytes.len().min(start + 512)];
    let item = br#""type":"mcp_tool_call""#;
    match adapter {
        "claude-code" => head.starts_with(br#"{"type":"user""#),
        "codex" => {
            head.starts_with(br#"{"type":"item."#)
                && head.windows(item.len()).any(|window| window == item)
        }
        _ => false,
    }
}
/// Whether a parsed record carries tool results (see [`tool_result_prefix`]). They are not
/// shown and do not count toward the stream limit.
fn carries_tool_results(adapter: &str, value: &Value) -> bool {
    match adapter {
        "claude-code" => value["type"] == "user",
        "codex" => {
            matches!(
                value["type"].as_str(),
                Some("item.started" | "item.updated" | "item.completed")
            ) && value["item"]["type"] == "mcp_tool_call"
        }
        _ => false,
    }
}
/// Apply one record to its turn. True when the response text changed.
fn apply_record(turn: &mut Turn, output: &mut Output, adapter: &str, record: Record) -> bool {
    match record {
        Record::Line(bytes) => match std::str::from_utf8(&bytes) {
            Ok(line) => ingest(turn, output, adapter, line.trim()),
            Err(_) => {
                output.error = Some("Agent output was not UTF-8".into());
                false
            }
        },
        Record::Skipped(bytes) => {
            output.count_tool_results(bytes);
            false
        }
        Record::Failed(error) => {
            output.error = Some(error);
            false
        }
        Record::Eof => false,
    }
}
/// Apply one line of the agent's stream to its turn. True when the response text changed.
fn ingest(turn: &mut Turn, output: &mut Output, adapter: &str, line: &str) -> bool {
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
    if carries_tool_results(adapter, &value) {
        output.count_tool_results(line.len());
        return false;
    }
    output.bytes += line.len();
    if output.bytes > STREAM_LIMIT {
        output.error = Some("Agent output exceeded 16 MiB. Response stopped.".into());
        return false;
    }
    // Claude emits subagent records on the same stdout stream. They have their own
    // reconciliation/completion owner and must not reset or finish the parent response.
    if adapter == "claude-code"
        && value
            .get("parent_tool_use_id")
            .is_some_and(|id| !id.is_null())
    {
        return false;
    }
    let tokens = |value: &Value| value.as_u64().unwrap_or(0);
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
        ("codex", "turn.completed") => {
            output.complete = true;
            let usage = &value["usage"];
            output.usage.input_tokens += tokens(&usage["input_tokens"]);
            output.usage.cached_input_tokens += tokens(&usage["cached_input_tokens"]);
            output.usage.output_tokens += tokens(&usage["output_tokens"]);
            turn.usage = serde_json::to_value(&output.usage).ok();
        }
        ("codex", "error" | "turn.failed") => {
            output.error = Some(normalize_diagnostic(
                value["error"]["message"]
                    .as_str()
                    .or(value["message"].as_str())
                    .unwrap_or("The agent reported an error"),
            ))
        }
        ("claude-code", "system") if value["subtype"] == "init" => {
            if let Some(model) = value["model"].as_str() {
                turn.resolved_model = Some(clip(model, 200));
            }
            // Only for a run whose conversation can be resumed, and only a plain id.
            if let Some(id) = value["session_id"].as_str().filter(|id| plain_id(id)) {
                if turn.cli_conversation_id.is_some() {
                    turn.cli_conversation_id = Some(id.to_owned());
                }
            }
            let connected = value["mcp_servers"].as_array().is_some_and(|servers| {
                servers.iter().any(|server| {
                    server["name"] == crate::adapters::SERVER_NAME
                        && server["status"] == "connected"
                })
            });
            // Without its tools a resumed conversation can only talk, and its answer would read
            // as the agent choosing not to act.
            if output.resumed && !connected {
                output.error = Some("Claude Code resumed the conversation, but the Omen Flow tools did not connect, so the agent could not act. Send a new message to start afresh.".into());
            }
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
            // Tokens only: the CLI's cost fields are never read.
            let usage = &value["usage"];
            let cached = tokens(&usage["cache_read_input_tokens"]);
            let mut models = value["modelUsage"]
                .as_object()
                .into_iter()
                .flat_map(|models| models.keys())
                .map(|model| clip(model, 100))
                .collect::<Vec<_>>();
            models.sort();
            models.truncate(8);
            output.usage = Usage {
                input_tokens: tokens(&usage["input_tokens"])
                    + tokens(&usage["cache_creation_input_tokens"])
                    + cached,
                cached_input_tokens: cached,
                output_tokens: tokens(&usage["output_tokens"]),
                models,
            };
            turn.usage = serde_json::to_value(&output.usage).ok();
        }
        _ => {}
    }
    if turn.response.len() > OUTPUT_LIMIT {
        output.error = Some("Agent output exceeded 1 MiB. Response stopped.".into());
    }
    rewritten || turn.response.len() != before
}

/// One accepted run, as its thread needs it.
struct Run {
    project: String,
    root: PathBuf,
    request: String,
    adapter: String,
    session: String,
    plan: Value,
    prompt: String,
    /// The plan resumes the CLI's own conversation.
    resumed: bool,
    /// For a resumed run: the replayed prompt and the launch input to start afresh with, once,
    /// when the CLI no longer has the conversation.
    fallback: Option<(String, Value)>,
}
/// What one CLI process did.
struct Execution {
    status: std::io::Result<ExitStatus>,
    output: Output,
    stderr: String,
    wrote: bool,
}
impl Execution {
    /// The CLI had no conversation to resume: it was cleaned up, or kept for another folder.
    fn conversation_missing(&self) -> bool {
        let says = |text: &str| text.contains("No conversation found");
        says(&self.stderr) || self.output.error.as_deref().is_some_and(says)
    }
}
/// Settles a run however its thread ends, a panic included: the turn is never left running,
/// the project is free for the next agent and Stop returns.
struct Settle {
    state: Arc<Mutex<State>>,
    process: Arc<Process>,
    project: String,
    root: PathBuf,
    request: String,
}
impl Drop for Settle {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        self.state.clear_poison();
        if let Some(turn) =
            find_turn(&mut state, &self.root, &self.request).filter(|t| t.state == "running")
        {
            turn.state = "failed".into();
            turn.error = Some(
                "The response stopped unexpectedly. Review any engineering changes already recorded."
                    .into(),
            );
            if let Some(book) = state.books.get(&self.root) {
                let _ = save(&self.root, book);
            }
            state.changed(&self.project);
        }
        if state
            .active
            .get(&self.root)
            .is_some_and(|active| Arc::ptr_eq(active, &self.process))
        {
            state.active.remove(&self.root);
        }
        drop(state);
        *self
            .process
            .done
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = true;
        self.process.settled.notify_all();
    }
}
fn run(cx: Context, process: Arc<Process>, mut job: Run) {
    let _settle = Settle {
        state: Arc::clone(&cx.state),
        process: Arc::clone(&process),
        project: job.project.clone(),
        root: job.root.clone(),
        request: job.request.clone(),
    };
    let mut execution = execute(&cx, &process, &job);
    cx.bridge.revoke(&job.session);
    cleanup(&job.plan);
    if job.resumed && execution.conversation_missing() && !process.cancelled.load(Ordering::SeqCst)
    {
        if let Some((prompt, input)) = job.fallback.take() {
            match restart(&cx, &process, &mut job, prompt, &input) {
                Ok(true) => {
                    execution = execute(&cx, &process, &job);
                    cx.bridge.revoke(&job.session);
                    cleanup(&job.plan);
                }
                Ok(false) => {}
                Err(error) => execution.output.error = Some(error),
            }
        }
    }
    settle(&cx, &process, &job, execution);
}
/// Run the started process with the prompt on its standard input until it exits.
fn execute(cx: &Context, process: &Arc<Process>, job: &Run) -> Execution {
    let (stdin, stdout, stderr) = {
        let mut guard = process.child.lock().unwrap();
        let child = guard.as_mut().unwrap();
        (
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            child.stderr.take().unwrap(),
        )
    };
    let prompt = job.prompt.clone();
    let writer = thread::spawn(move || {
        let mut stdin = stdin;
        stdin.write_all(prompt.as_bytes())
    });
    let stderr_reader = thread::spawn(move || read_stderr(stderr));
    let stream_state = Arc::clone(&cx.state);
    let stream_process = Arc::clone(process);
    let stream_project = job.project.clone();
    let stream_root = job.root.clone();
    let stream_request = job.request.clone();
    let adapter = job.adapter.clone();
    let resumed = job.resumed;
    let reader = thread::spawn(move || {
        let mut out = Output {
            resumed,
            ..Output::default()
        };
        let mut reader = BufReader::new(stdout);
        let mut saved = Instant::now();
        loop {
            let record = next_record(&mut reader, &adapter);
            if matches!(record, Record::Eof) {
                break;
            }
            if let Ok(mut state) = stream_state.lock() {
                let changed = find_turn(&mut state, &stream_root, &stream_request)
                    .is_some_and(|t| apply_record(t, &mut out, &adapter, record));
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
    Execution {
        status,
        output,
        stderr,
        wrote,
    }
}
/// Start the run again, once, as a new CLI conversation with the history replayed, because the
/// conversation it resumed is gone. False when the person stopped it meanwhile.
fn restart(
    cx: &Context,
    process: &Arc<Process>,
    job: &mut Run,
    prompt: String,
    input: &Value,
) -> Result<bool, String> {
    let gone = "The earlier Claude Code conversation is no longer available";
    if prompt.len() > PROMPT_LIMIT {
        return Err(format!("{gone}, and this conversation is too long to send again. Start a new conversation; the engineering record remains available."));
    }
    let plan = cx
        .hooks
        .prepare(&job.project, input, None)
        .map_err(|error| format!("{gone}, and a new run could not start: {}", error.message))?;
    let session = plan["sessionId"].as_str().unwrap_or_default().to_owned();
    let mut state = cx.state.lock().unwrap_or_else(PoisonError::into_inner);
    // Under the lock, as Stop sets it: a Stop before this point is seen, one after reaches
    // the new process.
    if process.cancelled.load(Ordering::SeqCst) {
        cx.bridge.revoke(&session);
        return Ok(false);
    }
    let child = spawn(&plan).map_err(|error| {
        cx.bridge.revoke(&session);
        cleanup(&plan);
        format!("{gone}, and a new run could not start: {}", error.message)
    })?;
    *process.child.lock().unwrap_or_else(PoisonError::into_inner) = Some(child);
    if let Some(turn) = find_turn(&mut state, &job.root, &job.request) {
        turn.session_id = Some(session.clone());
        turn.model = plan["model"].as_str().map(str::to_owned);
        turn.cli_conversation_id = plan["conversationId"].as_str().map(str::to_owned);
    }
    state.changed(&job.project);
    drop(state);
    job.session = session;
    job.plan = plan;
    job.prompt = prompt;
    job.resumed = false;
    Ok(true)
}
/// The gate over the turn's sessions and those of the turns it continues, with the calls they
/// made. None when it cannot be read: then nothing is recorded and nothing continues.
fn assess(cx: &Context, job: &Run) -> Option<Assessed> {
    let sessions = {
        let state = cx.state.lock().ok()?;
        chain_sessions(state.books.get(&job.root)?, &job.request)
    };
    let calls = sessions
        .iter()
        .map(|session| cx.bridge.session_activity(session).calls)
        .sum();
    let report = cx.hooks.work_status(&job.project, &sessions).ok()?;
    Some(Assessed::from_report(&report, sessions, calls))
}
fn set_auto(state: &mut State, job: &Run, auto: Auto) {
    if let Some(gate) = find_turn(state, &job.root, &job.request).and_then(|t| t.gate.as_mut()) {
        gate["auto"] = serde_json::to_value(auto).unwrap_or_default();
    }
}
/// Record how the run ended, with the gate read for its sessions, and continue it once when
/// the setting asks for that. One save and one change event, or the continuation's.
fn settle(cx: &Context, process: &Arc<Process>, job: &Run, execution: Execution) {
    let Execution {
        status,
        output,
        stderr,
        wrote,
    } = execution;
    let completed = status.as_ref().is_ok_and(ExitStatus::success)
        && wrote
        && output.complete
        && output.error.is_none();
    // Read with no chat lock held: it takes the core's. Stop is read again under the chat lock.
    let assessed = if process.cancelled.load(Ordering::SeqCst) {
        None
    } else {
        assess(cx, job)
    };
    let setting =
        completed && assessed.as_ref().is_some_and(|a| !a.ready) && cx.hooks.auto_continue();
    // Taken before the chat lock, as a command takes it, and only when a continuation may start.
    let _start = (setting
        && assessed
            .as_ref()
            .is_some_and(|a| a.actionable && a.jobs_running == 0)
        && !process.cancelled.load(Ordering::SeqCst))
    .then(|| cx.hooks.start_lock());
    let mut state = cx.state.lock().unwrap_or_else(PoisonError::into_inner);
    // A Stop that arrived before this point wins, as it did before the gate was read.
    let cancelled = process.cancelled.load(Ordering::SeqCst);
    if let Some(t) = find_turn(&mut state, &job.root, &job.request) {
        if cancelled {
            t.state = "cancelled".into();
            t.error = Some(
                "You stopped this response. Review any engineering changes already recorded."
                    .into(),
            );
        } else if completed {
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
        if !cancelled {
            t.gate = assessed.as_ref().map(|a| a.gate.clone());
        }
    }
    let decision = match (&assessed, completed && !cancelled) {
        (Some(assessed), true) => state
            .books
            .get(&job.root)
            .and_then(|book| {
                book.conversations.iter().find_map(|c| {
                    c.turns
                        .iter()
                        .find(|t| t.request_id == job.request)
                        .map(|ended| auto_decision(c, ended, assessed, setting))
                })
            })
            .unwrap_or(Decision::Record(None)),
        _ => Decision::Record(None),
    };
    if state
        .active
        .get(&job.root)
        .is_some_and(|active| Arc::ptr_eq(active, process))
    {
        state.active.remove(&job.root);
    }
    let auto = match decision {
        Decision::Record(auto) => auto,
        Decision::Continue(request) => {
            set_auto(
                &mut state,
                job,
                Auto::Started {
                    request_id: request.request_id.clone(),
                },
            );
            let accepted = catch_unwind(AssertUnwindSafe(|| {
                accept(&mut state, cx, &job.project, &job.root, &request)
            }));
            match accepted {
                // Saved and announced with the continuation's own turn.
                Ok(Ok(Accepted::Started)) => return,
                Ok(Ok(Accepted::Replayed)) => Some(Auto::skipped("already_continued")),
                Ok(Err(error)) => Some(skip_reason(&error)),
                Err(_) => Some(Auto::Skipped {
                    reason: "agent_unavailable",
                    detail: Some("The continuation stopped unexpectedly.".into()),
                }),
            }
        }
    };
    if let Some(auto) = auto {
        set_auto(&mut state, job, auto);
    }
    if let Err(error) = save(&job.root, &state.books[&job.root]) {
        if let Some(turn) = find_turn(&mut state, &job.root, &job.request) {
            turn.state = "failed".into();
            turn.error = Some(format!(
                "Could not save the final response: {}",
                error.message
            ));
        }
    }
    state.changed(&job.project);
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn request(id: &str, continues: Option<(&str, bool)>) -> Request {
        Request {
            conversation_id: "c".into(),
            request_id: id.into(),
            adapter_id: "codex".into(),
            text: "question".into(),
            input: None,
            continues: continues.map(|(request_id, automatic)| Continues {
                request_id: request_id.into(),
                automatic,
            }),
        }
    }
    fn turn() -> Turn {
        Turn::accepted(&request("r", None), None, &Value::Null)
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

    #[test]
    fn init_and_result_record_the_model_and_tokens_never_the_cost() {
        let init = |session_id: &str| {
            json!({"type": "system", "subtype": "init", "cwd": "/projects/rover", "session_id": session_id,
                "tools": [], "mcp_servers": [{"name": "omenflow", "status": "connected"}], "model": "claude-haiku-5-5"})
            .to_string()
        };
        let mut t = turn();
        // The plan names the id a resumable run keeps its conversation under.
        t.cli_conversation_id = Some("planned".into());
        let mut out = Output::default();
        assert!(!ingest(&mut t, &mut out, "claude-code", &init("abc-1")));
        assert_eq!(t.resolved_model.as_deref(), Some("claude-haiku-5-5"));
        assert_eq!(t.cli_conversation_id.as_deref(), Some("abc-1"));
        // Tokens as a recorded Claude Code 2.1.287 run reported them, with its own cost figure.
        let result = json!({"type": "result", "subtype": "success", "is_error": false, "result": "Done.",
            "session_id": "abc-1", "total_cost_usd": 0.5332844,
            "usage": {"input_tokens": 14, "cache_creation_input_tokens": 30971, "cache_read_input_tokens": 266002,
                "output_tokens": 11613, "cache_creation": {"ephemeral_1h_input_tokens": 30971, "ephemeral_5m_input_tokens": 0}},
            "modelUsage": {"claude-haiku-5-5": {"inputTokens": 14, "outputTokens": 11613, "cacheReadInputTokens": 266002,
                "cacheCreationInputTokens": 30971, "costUSD": 0.5332844, "contextWindow": 200000}}});
        assert!(ingest(&mut t, &mut out, "claude-code", &result.to_string()));
        assert!(out.complete);
        assert_eq!(
            t.usage,
            Some(
                json!({"inputTokens": 296987, "cachedInputTokens": 266002, "outputTokens": 11613, "models": ["claude-haiku-5-5"]})
            )
        );
        let saved = serde_json::to_string(&t).unwrap();
        assert!(
            !saved.to_lowercase().contains("cost") && !saved.contains("0.533"),
            "{saved}"
        );

        // The id becomes an argument of --resume: anything but a plain id is ignored.
        let long = "x".repeat(129);
        for bad in [
            "--dangerously-skip-permissions",
            "",
            "a b",
            "a;b",
            long.as_str(),
        ] {
            let mut t = turn();
            t.cli_conversation_id = Some("planned".into());
            ingest(&mut t, &mut Output::default(), "claude-code", &init(bad));
            assert_eq!(t.cli_conversation_id.as_deref(), Some("planned"), "{bad:?}");
        }
        // A run that cannot be resumed (no persistence) records none.
        let mut fresh = turn();
        ingest(
            &mut fresh,
            &mut Output::default(),
            "claude-code",
            &init("abc-2"),
        );
        assert_eq!(fresh.cli_conversation_id, None);
        // A resumed run whose tools did not connect stops before the agent acts.
        let mut resumed = Output {
            resumed: true,
            ..Output::default()
        };
        let unconnected = json!({"type": "system", "subtype": "init", "session_id": "abc-1",
            "mcp_servers": [{"name": "omenflow", "status": "failed"}], "model": "claude-haiku-5-5"});
        ingest(
            &mut turn(),
            &mut resumed,
            "claude-code",
            &unconnected.to_string(),
        );
        assert!(resumed
            .error
            .as_deref()
            .unwrap()
            .contains("the Omen Flow tools did not connect"));
        let mut resumed = Output {
            resumed: true,
            ..Output::default()
        };
        ingest(&mut turn(), &mut resumed, "claude-code", &init("abc-1"));
        assert!(resumed.error.is_none());
    }

    #[test]
    fn codex_turn_usage_is_summed() {
        let mut t = turn();
        let mut out = Output::default();
        for usage in [
            json!({"input_tokens": 1200, "cached_input_tokens": 1000, "output_tokens": 30}),
            json!({"input_tokens": 800, "cached_input_tokens": 0, "output_tokens": 20}),
        ] {
            ingest(
                &mut t,
                &mut out,
                "codex",
                &json!({"type": "turn.completed", "usage": usage}).to_string(),
            );
        }
        assert!(out.complete);
        assert_eq!(
            t.usage,
            Some(json!({"inputTokens": 2000, "cachedInputTokens": 1000, "outputTokens": 50}))
        );
    }

    #[test]
    fn tool_results_do_not_count_toward_the_output_limit() {
        let mut t = turn();
        let mut out = Output::default();
        let picture = "A".repeat(900 * 1024);
        for index in 0..3 {
            let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result",
                "tool_use_id": format!("t{index}"), "content": [{"type": "image", "source": {"type": "base64",
                "media_type": "image/png", "data": picture}}]}]}, "parent_tool_use_id": null, "session_id": "s"});
            assert!(!ingest(
                &mut t,
                &mut out,
                "claude-code",
                &result.to_string()
            ));
            let delta = json!({"type": "stream_event", "event": {"type": "content_block_delta",
                "delta": {"type": "text_delta", "text": format!("Part {index}. ")}}});
            ingest(&mut t, &mut out, "claude-code", &delta.to_string());
        }
        assert!(out.error.is_none(), "{:?}", out.error);
        assert_eq!(t.response, "Part 0. Part 1. Part 2. ");
        assert!(out.tool_result_bytes > 3 * 900 * 1024);
        assert!(out.bytes < 4096);

        let mut t = turn();
        let mut out = Output::default();
        let call = json!({"type": "item.completed", "item": {"id": "i", "type": "mcp_tool_call", "server": "omenflow",
            "tool": "image_view", "result": {"content": [{"type": "image", "data": "A".repeat(2 * 1024 * 1024)}]}}});
        ingest(&mut t, &mut out, "codex", &call.to_string());
        assert!(out.error.is_none());
        assert!(out.tool_result_bytes > 2 * 1024 * 1024 && out.bytes == 0);

        // The response text itself is still capped at 1 MiB.
        let mut t = turn();
        let mut out = Output::default();
        let message = json!({"type": "item.completed", "item": {"id": "m", "type": "agent_message",
            "text": "a".repeat(OUTPUT_LIMIT + 1)}});
        ingest(&mut t, &mut out, "codex", &message.to_string());
        assert_eq!(
            out.error.as_deref(),
            Some("Agent output exceeded 1 MiB. Response stopped.")
        );

        // The rest of the stream (tool inputs, events) has 16 MiB.
        let mut t = turn();
        let mut out = Output::default();
        let command =
            json!({"type": "item.started", "item": {"id": "x", "type": "command_execution",
            "command": "x".repeat(4 * 1024 * 1024)}})
            .to_string();
        for _ in 0..3 {
            ingest(&mut t, &mut out, "codex", &command);
        }
        assert!(out.error.is_none());
        ingest(&mut t, &mut out, "codex", &command);
        ingest(&mut t, &mut out, "codex", &command);
        assert_eq!(
            out.error.as_deref(),
            Some("Agent output exceeded 16 MiB. Response stopped.")
        );
    }

    #[test]
    fn an_oversized_tool_result_is_drained_without_being_held() {
        let big = format!(
            "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n",
            "A".repeat(3 * 1024 * 1024)
        );
        let tail = "{\"type\":\"result\",\"subtype\":\"success\"}\n";
        let mut cursor = Cursor::new(format!("{big}{tail}").into_bytes());
        assert!(
            matches!(next_record(&mut cursor, "claude-code"), Record::Skipped(n) if n == big.len())
        );
        assert!(
            matches!(next_record(&mut cursor, "claude-code"), Record::Line(line) if line == tail.as_bytes())
        );
        assert!(matches!(
            next_record(&mut cursor, "claude-code"),
            Record::Eof
        ));
        // One without a final newline ends at the end of the stream.
        let unterminated = big.trim_end();
        let mut cursor = Cursor::new(unterminated.as_bytes().to_vec());
        assert!(
            matches!(next_record(&mut cursor, "claude-code"), Record::Skipped(n) if n == unterminated.len())
        );
        let codex = format!(
            "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"i\",\"type\":\"mcp_tool_call\",\"result\":\"{}\"}}}}\n",
            "A".repeat(3 * 1024 * 1024)
        );
        let mut cursor = Cursor::new(codex.clone().into_bytes());
        assert!(
            matches!(next_record(&mut cursor, "codex"), Record::Skipped(n) if n == codex.len())
        );
        // The same bytes are no tool result for the other CLI, so they are held to be read.
        let mut cursor = Cursor::new(codex.clone().into_bytes());
        assert!(
            matches!(next_record(&mut cursor, "claude-code"), Record::Line(line) if line.len() == codex.len())
        );

        // A long line of another kind is held up to the line limit, then refused.
        let line = |megabytes: f64| {
            format!(
                "{{\"type\":\"assistant\",\"text\":\"{}\"}}\n",
                "B".repeat((megabytes * 1024.0 * 1024.0) as usize)
            )
        };
        let held = line(1.5);
        let mut cursor = Cursor::new(held.clone().into_bytes());
        assert!(
            matches!(read_record(&mut cursor, "claude-code", 2 * 1024 * 1024), Record::Line(bytes) if bytes.len() == held.len())
        );
        let mut cursor = Cursor::new(line(3.0).into_bytes());
        assert!(matches!(
            read_record(&mut cursor, "claude-code", 2 * 1024 * 1024),
            Record::Failed(error) if error == "An agent output line exceeded 2 MiB. Response stopped."
        ));
    }

    /// Read a whole stream as the run's reader does.
    fn read_stream(adapter: &str, stream: &[u8]) -> (Turn, Output) {
        let mut t = turn();
        let mut out = Output::default();
        let mut reader = BufReader::new(stream);
        loop {
            let record = next_record(&mut reader, adapter);
            if matches!(record, Record::Eof) {
                break;
            }
            apply_record(&mut t, &mut out, adapter, record);
            if out.error.is_some() {
                break;
            }
        }
        (t, out)
    }

    /// A drawing check replies with pictures, and Claude Code repeats a tool's content in
    /// `tool_use_result`: one `user` line of about 6 MB with two pictures, each twice.
    #[test]
    fn a_six_megabyte_tool_result_with_two_pictures_leaves_the_response_intact() {
        let picture = |seed: u8| {
            (0..1_500_000)
                .map(|index| (b'A' + ((index as u8).wrapping_add(seed) % 26)) as char)
                .collect::<String>()
        };
        let content = json!([
            {"type": "text", "text": "{\"images\":[{\"path\":\".omenflow/cache/views-v1/a.png\"}]}"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": picture(1)}},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": picture(2)}},
        ]);
        let user = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result",
            "tool_use_id": "toolu_1", "content": content}]}, "parent_tool_use_id": null, "session_id": "s",
            "uuid": "u", "timestamp": "2026-10-21T00:00:00.000Z", "tool_use_result": content})
        .to_string();
        assert!(user.len() > 6_000_000, "{}", user.len());
        let stream = [
            json!({"type": "system", "subtype": "init", "session_id": "s", "model": "claude-haiku-5-5", "mcp_servers": []}).to_string(),
            json!({"type": "stream_event", "event": {"type": "message_start"}}).to_string(),
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Viewing the part."}}}).to_string(),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Viewing the part."}, {"type": "tool_use", "name": "mcp__omenflow__cad_view"}]}}).to_string(),
            user,
            json!({"type": "stream_event", "event": {"type": "message_start"}}).to_string(),
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "The groove is 4 mm deep."}}}).to_string(),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "The groove is 4 mm deep."}]}}).to_string(),
            json!({"type": "result", "subtype": "success", "is_error": false, "result": "The groove is 4 mm deep."}).to_string(),
        ]
        .join("\n");
        let (t, out) = read_stream("claude-code", stream.as_bytes());
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.complete);
        assert_eq!(t.response, "Viewing the part.\n\nThe groove is 4 mm deep.");
        assert!(out.tool_result_bytes > 6_000_000);
        assert!(out.bytes < 4096, "{}", out.bytes);
    }

    fn gate(ready: bool, calls: u64, outstanding: Value, more: u64) -> Value {
        json!({"ready": ready, "summary": "1 draft is empty. 1 component has no source.", "blockers": 2, "advice": 0,
            "waiting": 0, "outstanding": outstanding, "more": more, "sessionIds": ["s1"], "calls": calls,
            "inScope": 2, "jobsRunning": 0, "checkedAt": "2026-10-21T00:00:00.000Z"})
    }

    #[test]
    fn history_labels_continuations_and_carries_the_gate() {
        let items = json!([
            {"kind": "empty_payload", "severity": "blocker", "artifactId": "a", "title": "Notes",
                "detail": "Draft r1 has no content yet.", "tool": "artifact_update_draft"},
            {"kind": "changes_requested", "severity": "blocker", "artifactId": "b", "title": "Bracket",
                "detail": "The reviewer asked for changes.", "tool": null},
        ]);
        let recorded = gate(false, 3, items.clone(), 2);
        let mut first = Turn::accepted(&request("r1", None), Some("s1".into()), &Value::Null);
        first.text = "Draft the notes".into();
        first.response = "Drafted.".into();
        first.state = "completed".into();
        first.gate = Some(recorded.clone());
        let mut second = Turn::accepted(
            &request("r2", Some(("r1", false))),
            Some("s2".into()),
            &Value::Null,
        );
        second.text = CONTINUE_TEXT.into();
        second.response = "Continued.".into();
        second.state = "completed".into();
        second.gate = Some(recorded.clone());
        let mut third = Turn::accepted(
            &request("r3", Some(("r2", true))),
            Some("s3".into()),
            &Value::Null,
        );
        third.text = CONTINUE_TEXT.into();
        third.response = "Still open.".into();
        third.state = "completed".into();
        third.gate = Some(gate(false, 0, json!([]), 0));
        let conversation = Conversation {
            id: "c".into(),
            title: "Notes".into(),
            turns: vec![first, second, third],
            cards: vec![],
        };
        let mut next = request("r4", Some(("r3", false)));
        next.text = CONTINUE_TEXT.into();
        let last = conversation.turns[2].gate.clone();
        let prompt = replay_prompt(Some(&conversation), &next, last.as_ref());
        assert!(prompt.starts_with(PREAMBLE));
        assert!(prompt.contains(&format!(
            "User: Draft the notes\nAssistant (completed): Drafted.\nUser (continue): {CONTINUE_TEXT}\nAssistant (completed): Continued.\nOmen Flow (automatic continuation): {CONTINUE_TEXT}\nAssistant (completed): Still open.\n{PRESENT}"
        )));
        // The gate goes with the turn being continued only, never with the history.
        assert_eq!(prompt.matches("Omen Flow ran work_status").count(), 1);
        assert!(prompt.ends_with(&format!(
            "{PRESENT}Omen Flow ran work_status after the previous reply (recorded by the host, not by the agent): 1 draft is empty. 1 component has no source.\nNo Omen Flow tool was called in that reply.\nUser (continue): {CONTINUE_TEXT}\n"
        )));

        assert_eq!(
            gate_brief(&recorded),
            "Omen Flow ran work_status after the previous reply (recorded by the host, not by the agent): 1 draft is empty. 1 component has no source.\n\
             Outstanding:\n\
             - Notes (empty_payload): Draft r1 has no content yet. Next: artifact_update_draft.\n\
             - Bracket (changes_requested): The reviewer asked for changes. Needs the person.\n\
             - 2 more: call work_status for the full list.\n"
        );
        assert_eq!(
            resume_prompt(&next, Some(&recorded)),
            format!(
                "Omen Flow resumed this conversation with a new tool session. Re-read the project record before you act; it may have changed.\n{}User (continue): {CONTINUE_TEXT}\n",
                gate_brief(&recorded)
            )
        );
        // An ordinary message carries no gate.
        let plain = replay_prompt(Some(&conversation), &request("r5", None), None);
        assert!(!plain.contains("Omen Flow ran work_status"));
        assert!(plain.ends_with(&format!("{PRESENT}User: question\n")));
    }

    #[test]
    fn continuation_ids_are_deterministic_and_valid() {
        assert_eq!(auto_request_id("r"), "r-auto");
        let longest = "a".repeat(128);
        let id = auto_request_id(&longest);
        assert_eq!(id.len(), 128);
        assert!(id.ends_with("-auto") && plain_id(&id));
        assert_eq!(auto_request_id(&longest), id);
    }

    fn assessed(ready: bool, actionable: bool, jobs_running: u64) -> Assessed {
        Assessed {
            gate: json!({}),
            ready,
            actionable,
            jobs_running,
        }
    }

    #[test]
    fn auto_decision_continues_once_per_user_turn() {
        let ended = |continues: Option<(&str, bool)>| {
            let mut turn = Turn::accepted(&request("r2", continues), None, &Value::Null);
            turn.state = "completed".into();
            turn
        };
        let conversation = |turns: Vec<Turn>| Conversation {
            id: "c".into(),
            title: "t".into(),
            turns,
            cards: vec![],
        };
        let decide = |turns: Vec<Turn>, assessed: Assessed, setting: bool| {
            let conversation = conversation(turns);
            let ended = conversation.turns.last().unwrap();
            match auto_decision(&conversation, ended, &assessed, setting) {
                Decision::Record(auto) => auto.map(|auto| serde_json::to_value(auto).unwrap()),
                Decision::Continue(request) => Some(json!({"continue": request.request_id,
                    "continues": request.continues.map(|c| (c.request_id, c.automatic)), "text": request.text,
                    "input": request.input, "adapter": request.adapter_id, "conversation": request.conversation_id})),
            }
        };
        assert_eq!(
            decide(vec![ended(None)], assessed(true, false, 0), true),
            None
        );
        assert_eq!(
            decide(vec![ended(None)], assessed(false, true, 0), false),
            Some(json!({"state": "off"}))
        );
        assert_eq!(
            decide(vec![ended(None)], assessed(false, false, 0), true),
            Some(json!({"state": "skipped", "reason": "needs_person"}))
        );
        assert_eq!(
            decide(vec![ended(None)], assessed(false, true, 1), true),
            Some(json!({"state": "skipped", "reason": "jobs_running"}))
        );
        assert_eq!(
            decide(
                vec![ended(Some(("r1", true)))],
                assessed(false, true, 0),
                true
            ),
            Some(json!({"state": "skipped", "reason": "already_continued"})),
            "a continuation never continues itself"
        );
        let mut continued = ended(Some(("r2", true)));
        continued.request_id = "r2-auto".into();
        let conversation = conversation(vec![ended(None), continued]);
        let first = conversation
            .turns
            .iter()
            .find(|t| t.request_id == "r2")
            .unwrap();
        assert!(matches!(
            auto_decision(&conversation, first, &assessed(false, true, 0), true),
            Decision::Record(Some(Auto::Skipped {
                reason: "already_continued",
                ..
            }))
        ));
        // A person's Continue counts as a message they sent: it may be continued once.
        assert_eq!(
            decide(
                vec![ended(Some(("r1", false)))],
                assessed(false, true, 0),
                true
            ),
            Some(
                json!({"continue": "r2-auto", "continues": ["r2", true], "text": CONTINUE_TEXT,
                "input": null, "adapter": "codex", "conversation": "c"})
            )
        );
    }

    #[test]
    fn skip_reasons_follow_the_error() {
        let reason = |error: ContractError| serde_json::to_value(skip_reason(&error)).unwrap();
        assert_eq!(
            reason(ContractError::new("BUSY", "A terminal session is running")),
            json!({"state": "skipped", "reason": "busy"})
        );
        assert_eq!(
            reason(ContractError::validation(TOO_LONG)),
            json!({"state": "skipped", "reason": "prompt_limit"})
        );
        assert_eq!(
            reason(ContractError::new("NOT_FOUND", "Project not open")),
            json!({"state": "skipped", "reason": "project_closed"})
        );
        assert_eq!(
            reason(ContractError::new("READ_ONLY", "The project is read-only")),
            json!({"state": "skipped", "reason": "read_only"})
        );
        let long = "Executable not found: /nowhere/codex ".repeat(20);
        let missing = reason(ContractError::new("TOOL_MISSING", long.clone()));
        assert_eq!(missing["reason"], "agent_unavailable");
        assert_eq!(missing["detail"], clip(&long, 240));
    }

    #[test]
    fn gate_keeps_five_items_blockers_first_and_counts_the_rest() {
        let item = |kind: &str, severity: &str, tool: Option<&str>| {
            json!({"kind": kind, "severity": severity, "artifactId": "a", "revisionId": "r", "type": "component",
                "title": "T".repeat(200), "detail": "D".repeat(300),
                "next": tool.map(|tool| json!({"tool": tool, "why": "", "args": {}}))})
        };
        let mut outstanding = vec![
            item("component_unsourced", "blocker", Some("source_capture")),
            item("component_no_offer", "blocker", Some("component_add_offer")),
            item("changes_requested", "blocker", Some("proposal_read")),
            item("cad_unverified", "blocker", None),
            item("component_unsourced", "blocker", Some("source_capture")),
            item("draft_unproposed", "advice", Some("proposal_submit")),
        ];
        let report = |outstanding: &[Value]| {
            json!({"ready": false, "summary": "S".repeat(500), "outstanding": outstanding,
                "waitingOnHuman": [{"proposalId": "p"}], "counts": {"blockers": 5, "advice": 2, "verifiedParts": 0},
                "omitted": 3, "inScope": 4, "jobsRunning": 1})
        };
        let facts = Assessed::from_report(&report(&outstanding), vec!["s1".into(), "s2".into()], 7);
        assert!(!facts.ready);
        assert!(
            !facts.actionable,
            "sourcing, offers, a reviewer's request and a person's approval are not the agent's"
        );
        assert_eq!(facts.jobs_running, 1);
        let gate = &facts.gate;
        assert_eq!(gate["outstanding"].as_array().unwrap().len(), 5);
        assert_eq!(gate["more"], 1 + 3);
        assert_eq!(
            (&gate["blockers"], &gate["advice"], &gate["waiting"]),
            (&json!(5), &json!(2), &json!(1))
        );
        assert_eq!((&gate["calls"], &gate["inScope"]), (&json!(7), &json!(4)));
        assert_eq!(gate["sessionIds"], json!(["s1", "s2"]));
        assert_eq!(gate["summary"].as_str().unwrap().len(), 400);
        let first = &gate["outstanding"][0];
        assert_eq!(first["title"].as_str().unwrap().len(), 120);
        assert_eq!(first["detail"].as_str().unwrap().len(), 240);
        assert_eq!(first["tool"], "source_capture");
        assert_eq!(gate["outstanding"][3]["tool"], Value::Null);
        assert!(gate.get("auto").is_none());
        // An item beyond the five recorded still makes the gate actionable.
        outstanding.push(item(
            "empty_payload",
            "blocker",
            Some("artifact_update_draft"),
        ));
        assert!(Assessed::from_report(&report(&outstanding), vec![], 0).actionable);
        let wiring = [item("wiring_findings", "blocker", Some("wiring_validate"))];
        assert!(Assessed::from_report(&report(&wiring), vec![], 0).actionable);
        let advice = [item("cad_unverified", "advice", Some("cad_check"))];
        assert!(!Assessed::from_report(&report(&advice), vec![], 0).actionable);
    }

    #[test]
    fn records_from_0_2_3_still_load_and_keep_later_fields() {
        let dir = tempfile::tempdir().unwrap();
        let book = json!({"version": 1, "conversations": [{"id": "c", "title": "Plate", "turns": [
            // As 0.2.3 wrote it.
            {"requestId": "r1", "text": "Make a plate", "response": "Done.", "adapterId": "codex",
                "sessionId": "s1", "state": "completed", "error": null, "createdAt": "2026-10-20T00:00:00.000Z"},
            // As a later build might: a new auto state, a gate field gone, a field 0.2.4 does not know.
            {"requestId": "r2", "text": "Go on", "response": "", "adapterId": "codex", "sessionId": "s2",
                "state": "completed", "error": null, "createdAt": "2026-10-20T00:01:00.000Z",
                "continues": {"requestId": "r1"}, "futureField": {"kept": [1, 2]},
                "gate": {"ready": false, "summary": "1 part is not verified.", "auto": {"state": "queued", "at": 3},
                    "outstanding": [], "newer": true}}
        ]}]});
        fs::create_dir_all(file(dir.path()).parent().unwrap()).unwrap();
        fs::write(file(dir.path()), book.to_string()).unwrap();
        let mut state = State::default();
        load(&mut state, dir.path(), true).unwrap();
        let loaded = &state.books[dir.path()].conversations[0].turns;
        assert!(loaded[0].gate.is_none() && loaded[0].continues.is_none());
        let continues = loaded[1].continues.as_ref().unwrap();
        assert_eq!(
            (continues.request_id.as_str(), continues.automatic),
            ("r1", false)
        );
        save(dir.path(), &state.books[dir.path()]).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(file(dir.path())).unwrap()).unwrap();
        let turns = &saved["conversations"][0]["turns"];
        assert_eq!(turns[0], book["conversations"][0]["turns"][0]);
        assert_eq!(turns[1]["futureField"], json!({"kept": [1, 2]}));
        assert_eq!(
            turns[1]["gate"],
            book["conversations"][0]["turns"][1]["gate"]
        );
        assert_eq!(
            turns[1]["continues"],
            json!({"requestId": "r1", "automatic": false})
        );
    }

    #[test]
    fn a_continuation_left_running_by_a_restart_is_interrupted_and_never_retriggered() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = Turn::accepted(&request("r1", None), Some("s1".into()), &Value::Null);
        first.state = "completed".into();
        let mut recorded = gate(false, 2, json!([]), 0);
        recorded["auto"] = json!({"state": "started", "requestId": "r1-auto"});
        first.gate = Some(recorded);
        let mut second = Turn::accepted(
            &request("r1-auto", Some(("r1", true))),
            Some("s2".into()),
            &Value::Null,
        );
        second.text = CONTINUE_TEXT.into();
        let book = Book {
            version: 1,
            conversations: vec![Conversation {
                id: "c".into(),
                title: "Notes".into(),
                turns: vec![first, second],
                cards: vec![],
            }],
        };
        save(dir.path(), &book).unwrap();
        let mut state = State::default();
        load(&mut state, dir.path(), true).unwrap();
        let turns = &state.books[dir.path()].conversations[0].turns;
        assert_eq!(turns.len(), 2, "loading starts nothing");
        assert_eq!(turns[1].state, "interrupted");
        assert!(turns[1].gate.is_none());
        assert!(state.active.is_empty());
        let saved: Value = serde_json::from_slice(&fs::read(file(dir.path())).unwrap()).unwrap();
        assert_eq!(
            saved["conversations"][0]["turns"][1]["state"],
            "interrupted"
        );
    }

    #[test]
    fn the_continuation_text_is_the_contract_s() {
        let contract = include_str!("../../../packages/contracts/src/chat.ts");
        assert!(
            contract.contains(&format!("'{CONTINUE_TEXT}'")),
            "CHAT_CONTINUE_TEXT and CONTINUE_TEXT differ"
        );
    }

    /// Hooks whose gate read waits until the test lets it go.
    #[cfg(unix)]
    struct Blocking {
        root: PathBuf,
        entered: Mutex<std::sync::mpsc::Sender<()>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        prepared: std::sync::atomic::AtomicUsize,
        start: Mutex<()>,
    }
    #[cfg(unix)]
    impl ChatHooks for Blocking {
        fn work_status(&self, _: &str, _: &[String]) -> Result<Value, ContractError> {
            let _ = self.entered.lock().unwrap().send(());
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10));
            Ok(
                json!({"ready": false, "summary": "1 draft is empty.", "waitingOnHuman": [],
                "outstanding": [{"kind": "empty_payload", "severity": "blocker", "artifactId": "a", "title": "Notes",
                    "detail": "Draft r1 has no content yet.", "next": {"tool": "artifact_update_draft", "why": "", "args": {}}}],
                "counts": {"blockers": 1, "advice": 0}, "inScope": 1, "jobsRunning": 0}),
            )
        }
        fn auto_continue(&self) -> bool {
            true
        }
        fn start_lock(&self) -> MutexGuard<'_, ()> {
            self.start.lock().unwrap()
        }
        fn prepare(&self, _: &str, _: &Value, _: Option<&str>) -> Result<Value, ContractError> {
            self.prepared.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"sessionId": uuid::Uuid::new_v4().to_string(), "executable": "/bin/sh",
                "args": ["-c", "cat >/dev/null; printf '%s\\n' '{\"type\":\"turn.completed\"}'"],
                "cwd": self.root, "env": {}, "envDefaults": {}, "files": []}),
            )
        }
    }

    /// A Stop that lands while the gate is read ends the turn stopped, and nothing continues it.
    #[cfg(unix)]
    #[test]
    fn stop_during_the_gate_read_prevents_the_continuation() {
        let workspace = crate::test_support::Workspace::new("Gate window");
        let root = workspace.root();
        let (entered_sender, entered) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let hooks = Arc::new(Blocking {
            root: root.clone(),
            entered: Mutex::new(entered_sender),
            release: Mutex::new(released),
            prepared: Default::default(),
            start: Mutex::new(()),
        });
        let host = ChatHost::new(
            Arc::clone(&workspace.bridge),
            Arc::new(Mutex::new(State::default())),
            Arc::clone(&hooks) as Arc<dyn ChatHooks>,
        );
        let send = json!({"conversationId": "c", "requestId": "r", "adapterId": "codex", "text": "Write the notes"});
        host.command("chat.send", "p", &root, &send, false).unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        thread::scope(|scope| {
            let stop = scope.spawn(|| host.stop_project(&root));
            let until = Instant::now() + Duration::from_secs(10);
            while !host
                .cx
                .state
                .lock()
                .unwrap()
                .active
                .get(&root)
                .is_some_and(|process| process.cancelled.load(Ordering::SeqCst))
            {
                assert!(Instant::now() < until, "Stop never reached the run");
                thread::sleep(Duration::from_millis(10));
            }
            release.send(()).unwrap();
            stop.join().unwrap().unwrap();
        });
        let book = host
            .command("chat.read", "p", &root, &json!({}), false)
            .unwrap();
        let turns = book["conversations"][0]["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 1, "{book}");
        assert_eq!(turns[0]["state"], "cancelled");
        assert!(turns[0].get("gate").is_none());
        assert_eq!(hooks.prepared.load(Ordering::SeqCst), 1);
        assert!(!host.running());
    }

    /// Hooks that note what each run was asked to resume, and whose run keeps its prompt.
    #[cfg(unix)]
    struct Recording {
        root: PathBuf,
        prompt: PathBuf,
        resumes: Mutex<Vec<Option<String>>>,
        start: Mutex<()>,
    }
    #[cfg(unix)]
    impl ChatHooks for Recording {
        fn work_status(&self, _: &str, _: &[String]) -> Result<Value, ContractError> {
            Ok(
                json!({"ready": true, "summary": "Ready.", "waitingOnHuman": [], "outstanding": [],
                "counts": {"blockers": 0, "advice": 0}, "inScope": 0, "jobsRunning": 0}),
            )
        }
        fn auto_continue(&self) -> bool {
            false
        }
        fn start_lock(&self) -> MutexGuard<'_, ()> {
            self.start.lock().unwrap()
        }
        fn prepare(
            &self,
            _: &str,
            _: &Value,
            resume: Option<&str>,
        ) -> Result<Value, ContractError> {
            self.resumes.lock().unwrap().push(resume.map(str::to_owned));
            Ok(
                json!({"sessionId": uuid::Uuid::new_v4().to_string(), "executable": "/bin/sh",
                "args": ["-c", "cat >\"$0\"; printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"Done.\"}'", self.prompt],
                "cwd": self.root, "env": {}, "envDefaults": {}, "files": [], "resumed": resume.is_some()}),
            )
        }
    }

    /// The resume id is read from the record file and becomes an argument after --resume. One
    /// that a CLI would not give, planted in the file, replays the conversation instead.
    #[cfg(unix)]
    #[test]
    fn a_planted_resume_id_replays_and_never_reaches_the_cli() {
        let workspace = crate::test_support::Workspace::new("Planted id");
        let root = workspace.root();
        let completed = |conversation: &str, id: &str| {
            let mut first = Turn::accepted(&request("r1", None), Some("s1".into()), &Value::Null);
            first.adapter_id = "claude-code".into();
            first.text = "Make the bracket".into();
            first.response = "Made.".into();
            first.state = "completed".into();
            first.gate = Some(gate(true, 0, json!([]), 0));
            first.cli_conversation_id = Some(id.into());
            first.request_id = format!("{conversation}-r1");
            Conversation {
                id: conversation.into(),
                title: "Bracket".into(),
                turns: vec![first],
                cards: vec![],
            }
        };
        let planted = "--settings={\"env\":{\"INJECTED\":\"1\"}}";
        save(
            &root,
            &Book {
                version: 1,
                conversations: vec![completed("c", planted), completed("d", "abc-1")],
            },
        )
        .unwrap();
        let hooks = Arc::new(Recording {
            root: root.clone(),
            prompt: workspace.temp.path().join("prompt.txt"),
            resumes: Mutex::new(Vec::new()),
            start: Mutex::new(()),
        });
        let host = ChatHost::new(
            Arc::clone(&workspace.bridge),
            Arc::new(Mutex::new(State::default())),
            Arc::clone(&hooks) as Arc<dyn ChatHooks>,
        );
        let send = |conversation: &str| {
            let input = json!({"conversationId": conversation, "requestId": format!("{conversation}-r2"),
                "adapterId": "claude-code", "text": CONTINUE_TEXT, "continues": {"requestId": format!("{conversation}-r1")}});
            host.command("chat.send", "p", &root, &input, false)
                .unwrap();
            let until = Instant::now() + Duration::from_secs(10);
            while host.running() {
                assert!(Instant::now() < until, "The run never ended");
                thread::sleep(Duration::from_millis(10));
            }
            fs::read_to_string(&hooks.prompt).unwrap()
        };

        let replayed = send("c");
        assert_eq!(*hooks.resumes.lock().unwrap(), vec![None]);
        assert!(replayed.starts_with(PREAMBLE), "{replayed}");
        assert!(replayed.contains("User: Make the bracket\nAssistant (completed): Made.\n"));
        assert!(!replayed.contains("INJECTED"));

        // A plain id still resumes.
        let resumed = send("d");
        assert_eq!(
            *hooks.resumes.lock().unwrap(),
            vec![None, Some("abc-1".to_owned())]
        );
        assert!(resumed.starts_with("Omen Flow resumed this conversation"));
    }
}
