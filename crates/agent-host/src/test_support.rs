//! Shared fixtures for tests that drive the real bridge: a project in a
//! temporary folder, and a client that speaks the helper's wire protocol.

use crate::{socket_name, BridgeServer, Grant};
use base64::Engine;
use interprocess::local_socket::{prelude::*, Stream};
use omenflow_contracts::{read_frame, write_frame, Profile};
use omenflow_core::{CoreApp, Origin};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub(crate) struct Workspace {
    pub core: Arc<Mutex<CoreApp>>,
    pub bridge: Arc<BridgeServer>,
    pub project_id: String,
    /// Declared last so it is dropped last: the bridge's socket lives in it.
    pub temp: tempfile::TempDir,
}

impl Workspace {
    pub fn new(name: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path": temp.path().join("project"), "name": name, "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        let core = Arc::new(Mutex::new(core));
        let bridge =
            Arc::new(BridgeServer::start(Arc::clone(&core), &temp.path().join("app")).unwrap());
        Self {
            core,
            bridge,
            project_id,
            temp,
        }
    }

    /// The project folder as the core names it (symlinks resolved).
    pub fn root(&self) -> PathBuf {
        self.temp.path().join("project").canonicalize().unwrap()
    }

    /// Run an operation as the person at the desk.
    pub fn user(&self, op: &str, payload: Value) -> Value {
        self.core
            .lock()
            .unwrap()
            .dispatch(op, payload, Origin::User, Some(&self.project_id))
            .unwrap_or_else(|error| panic!("{op} failed: {error}"))
    }

    /// A token for a session of the given profile, with its session id.
    pub fn grant(&self, profile: Profile) -> (String, String) {
        self.grant_for(profile, "codex")
    }

    /// A token for a session of the given profile run by `adapter_id`.
    pub fn grant_for(&self, profile: Profile, adapter_id: &str) -> (String, String) {
        let session_id = uuid::Uuid::new_v4().to_string();
        let token = self.bridge.issue_grant(Grant {
            project_id: self.project_id.clone(),
            session_id: session_id.clone(),
            profile,
            adapter_id: adapter_id.into(),
            model: Some("gpt-6-luna".into()),
        });
        (token, session_id)
    }

    /// An initialised MCP client for a new session of the given profile.
    pub fn mcp(&self, profile: Profile) -> McpClient {
        self.mcp_for(profile, "codex")
    }

    /// As [`Workspace::mcp`], for a session run by `adapter_id`.
    pub fn mcp_for(&self, profile: Profile, adapter_id: &str) -> McpClient {
        let (token, session_id) = self.grant_for(profile, adapter_id);
        let mut client = McpClient::connect(&self.bridge, &token, "mcp");
        client.session_id = session_id;
        let reply = client.request(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "weak-client", "version": "0"}}),
        );
        assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
        client.notify("notifications/initialized");
        client
    }

    /// Every call the ledger holds for the project, oldest first.
    pub fn recorded(&self) -> Vec<Value> {
        self.bridge
            .agent_activity(&self.project_id, &json!({"limit": 500}))
            .unwrap()["calls"]
            .as_array()
            .unwrap()
            .clone()
    }

    pub fn last_recorded(&self) -> Value {
        self.recorded().pop().expect("a recorded call")
    }
}

/// The reply to one `tools/call`.
#[derive(Debug)]
pub(crate) struct ToolReply {
    pub is_error: bool,
    /// The text block, parsed.
    pub body: Value,
    /// The text block as sent.
    pub text: String,
    /// The image blocks after it: media type and decoded bytes.
    pub images: Vec<(String, Vec<u8>)>,
    /// Whether the result carried structured content.
    pub structured: bool,
}

pub(crate) struct McpClient {
    stream: Stream,
    next_id: u64,
    pub session_id: String,
}

impl McpClient {
    /// Connect the way the `omenflow` helper does and complete the bridge
    /// handshake. `mode` is `mcp` or `call`.
    pub fn connect(bridge: &BridgeServer, token: &str, mode: &str) -> Self {
        let (stream, welcome) = Self::hello(bridge, token, mode);
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        Self {
            stream,
            next_id: 0,
            session_id: welcome["sessionId"].as_str().unwrap().to_owned(),
        }
    }

    /// Send the bridge hello and return the bridge's answer, whatever it is.
    pub fn hello(bridge: &BridgeServer, token: &str, mode: &str) -> (Stream, Value) {
        let mut stream = Stream::connect(socket_name(bridge.socket_path()).unwrap()).unwrap();
        write_frame(
            &mut stream,
            &json!({"type": "hello", "protocolVersion": 1, "mode": mode, "token": token}),
        )
        .unwrap();
        let answer = read_frame(&mut stream).unwrap().unwrap();
        (stream, answer)
    }

    /// Send a JSON-RPC request and return the whole reply.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        self.send(
            json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}),
        );
        let reply = self.receive();
        assert_eq!(reply["id"], self.next_id, "{reply}");
        reply
    }

    pub fn notify(&mut self, method: &str) {
        self.send(json!({"jsonrpc": "2.0", "method": method}));
    }

    pub fn send(&mut self, frame: Value) {
        write_frame(&mut self.stream, &frame).unwrap();
    }

    pub fn receive(&mut self) -> Value {
        read_frame(&mut self.stream)
            .unwrap()
            .expect("a reply frame")
    }

    /// Call a tool and return its result, which must be a tool result and
    /// never a protocol error.
    pub fn call(&mut self, tool: &str, arguments: Value) -> ToolReply {
        let reply = self.request("tools/call", json!({"name": tool, "arguments": arguments}));
        let result = &reply["result"];
        assert!(
            result.is_object(),
            "{tool} answered with a protocol error: {reply}"
        );
        let content = result["content"].as_array().unwrap();
        let text = content[0]["text"].as_str().unwrap().to_owned();
        assert_eq!(content[0]["type"], "text");
        assert!(!text.contains('\n'), "{tool} result is pretty-printed");
        let body: Value = serde_json::from_str(&text).unwrap();
        // Every block after the text is a picture in valid base64.
        let images = content[1..]
            .iter()
            .map(|block| {
                assert_eq!(block["type"], "image", "{tool}: {block}");
                let mime = block["mimeType"].as_str().unwrap();
                assert_eq!(mime, "image/png", "{tool}: every picture is a PNG");
                let data = block["data"].as_str().unwrap();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .expect("image data is base64");
                (mime.to_owned(), bytes)
            })
            .collect::<Vec<_>>();
        let structured = match result.get("structuredContent") {
            Some(structured) => {
                assert_eq!(structured, &body);
                true
            }
            None => {
                assert!(!images.is_empty(), "{tool} has no structured content");
                false
            }
        };
        ToolReply {
            is_error: result["isError"].as_bool().unwrap(),
            body,
            text,
            images,
            structured,
        }
    }

    /// One `omenflow call` request; returns the response envelope.
    pub fn call_op(&mut self, op: &str, payload: Value) -> Value {
        self.next_id += 1;
        let id = format!("r{}", self.next_id);
        self.send(json!({"requestId": id, "op": op, "payload": payload}));
        let reply = self.receive();
        assert_eq!(reply["requestId"], json!(id));
        reply
    }
}
