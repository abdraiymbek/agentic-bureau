//! The workspace lock is released while an agent's render runs: the person's
//! reads are answered meanwhile, the job is visible, and every event and the
//! agent's call record reach the interface once.
//!
//! A test binary of its own, because stopping a host stops every engine
//! process in the process, and other host tests stop theirs.
#![cfg(unix)]

use omenflow_agent_host::{EventSink, Host, HostEvent, HostPaths, ResearchSurface, Shell};
use omenflow_contracts::{read_frame, write_frame, ContractError, ResponseEnvelope};
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Recorder(Mutex<Vec<HostEvent>>);

impl EventSink for Recorder {
    fn emit(&self, event: HostEvent) {
        self.0.lock().unwrap().push(event);
    }
}

impl Recorder {
    fn named(&self, name: &str) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.name() == name)
            .map(|event| event.payload().clone())
            .collect()
    }
}

struct Nothing;

impl Shell for Nothing {
    fn reveal_path(&self, _path: &Path) -> Result<(), ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No file manager here"))
    }
    fn open_external(&self, _url: &str) -> Result<(), ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
}

impl ResearchSurface for Nothing {
    fn load(&self, _url: &str) -> Result<Value, ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
    fn read(&self) -> Result<Value, ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
    fn link(&self, _selector: &str) -> Result<Option<String>, ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
    fn screenshot(&self) -> Result<Value, ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
    fn toggle(&self) -> Result<Value, ContractError> {
        Err(ContractError::new("TOOL_MISSING", "No browser here"))
    }
}

/// Binary STL of a closed 20 × 10 × 2 mm box with outward normals.
fn box_stl() -> Vec<u8> {
    let (x, y, z) = (20.0_f32, 10.0_f32, 2.0_f32);
    let triangles: [([f32; 3], [[f32; 3]; 3]); 12] = [
        ([0., 0., -1.], [[0., 0., 0.], [0., y, 0.], [x, y, 0.]]),
        ([0., 0., -1.], [[0., 0., 0.], [x, y, 0.], [x, 0., 0.]]),
        ([0., 0., 1.], [[0., 0., z], [x, 0., z], [x, y, z]]),
        ([0., 0., 1.], [[0., 0., z], [x, y, z], [0., y, z]]),
        ([0., -1., 0.], [[0., 0., 0.], [x, 0., 0.], [x, 0., z]]),
        ([0., -1., 0.], [[0., 0., 0.], [x, 0., z], [0., 0., z]]),
        ([0., 1., 0.], [[0., y, 0.], [0., y, z], [x, y, z]]),
        ([0., 1., 0.], [[0., y, 0.], [x, y, z], [x, y, 0.]]),
        ([-1., 0., 0.], [[0., 0., 0.], [0., 0., z], [0., y, z]]),
        ([-1., 0., 0.], [[0., 0., 0.], [0., y, z], [0., y, 0.]]),
        ([1., 0., 0.], [[x, 0., 0.], [x, y, 0.], [x, y, z]]),
        ([1., 0., 0.], [[x, 0., 0.], [x, y, z], [x, 0., z]]),
    ];
    let mut bytes = vec![0_u8; 80];
    bytes.extend((triangles.len() as u32).to_le_bytes());
    for (normal, corners) in triangles {
        for value in normal.iter().chain(corners.iter().flatten()) {
            bytes.extend(value.to_le_bytes());
        }
        bytes.extend([0, 0]);
    }
    bytes
}

/// Stands in for OpenSCAD: answers `--version`, and holds each render until
/// the gate file exists, then writes the box. Not OpenSCAD; this test is
/// about locking and delivery, never about geometry.
struct StandIn {
    executable: PathBuf,
    gate: PathBuf,
    invocations: PathBuf,
}

impl StandIn {
    fn new(dir: &Path) -> Self {
        let stl = dir.join("box.stl");
        fs::write(&stl, box_stl()).unwrap();
        let (gate, invocations) = (dir.join("gate"), dir.join("invocations"));
        let script = format!(
            "#!/bin/sh\necho \"$1\" >> '{}'\nif [ \"$1\" = \"--version\" ]; then\n  echo 'OpenSCAD version 0.0.0-standin'\n  exit 0\nfi\nwhile [ ! -f '{}' ]; do sleep 0.02; done\ncp '{}' \"$2\"\n",
            invocations.display(),
            gate.display(),
            stl.display()
        );
        let executable = dir.join("stand-in-engine");
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            executable,
            gate,
            invocations,
        }
    }

    fn renders(&self) -> usize {
        fs::read_to_string(&self.invocations)
            .map(|text| text.lines().filter(|line| *line == "-o").count())
            .unwrap_or(0)
    }

    fn release(&self) {
        fs::write(&self.gate, "").unwrap();
    }
}

fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn ok(envelope: ResponseEnvelope) -> Value {
    assert!(envelope.ok, "{:?}", envelope.error);
    envelope.result.unwrap()
}

/// One agent session on the bridge in call mode, as the `omenflow` helper
/// connects.
struct Agent(UnixStream);

impl Agent {
    fn connect(host: &Host, project_id: &str, session_id: &str) -> Self {
        let token = host.bridge().issue_token(project_id, session_id);
        let mut stream = UnixStream::connect(host.bridge().socket_path()).unwrap();
        write_frame(
            &mut stream,
            &json!({"type": "hello", "protocolVersion": 1, "mode": "call", "token": token}),
        )
        .unwrap();
        assert_eq!(read_frame(&mut stream).unwrap().unwrap()["type"], "welcome");
        Self(stream)
    }

    fn call(&mut self, op: &str, payload: Value) -> Value {
        write_frame(
            &mut self.0,
            &json!({"requestId": op, "op": op, "payload": payload}),
        )
        .unwrap();
        read_frame(&mut self.0).unwrap().unwrap()
    }
}

#[test]
fn the_person_reads_while_an_agent_render_runs_and_each_event_arrives_once() {
    let temp = tempfile::tempdir().unwrap();
    let engine = StandIn::new(temp.path());
    let events = Arc::new(Recorder::default());
    let host = Host::start(
        HostPaths {
            app_data_dir: temp.path().join("app"),
            cli_path: PathBuf::from("/bin/echo"),
        },
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::new(Nothing),
        Arc::new(Nothing),
    )
    .unwrap();
    ok(host.command(
        "settings.set",
        json!({"key": "toolPaths.openscad", "value": engine.executable}),
        None,
        None,
    ));
    let created = ok(host.command(
        "project.create",
        json!({"path": temp.path().join("project"), "name": "Lock", "intent": "test"}),
        None,
        None,
    ));
    let project_id = created["projectId"].as_str().unwrap().to_owned();
    let session_id = "6f1d2c3b-4a59-4e8f-9b0a-1c2d3e4f5a6b";
    let mut agent = Agent::connect(&host, &project_id, session_id);

    let reply = std::thread::scope(|scope| {
        let render = scope.spawn(|| {
            agent.call(
                "cad_write_source",
                json!({"title": "Held tray", "source": "w = 20;\ncube([w, 10, 2]);\n"}),
            )
        });
        wait_until("the agent's render to start", || engine.renders() == 1);

        // The render is held open. The person's commands are answered
        // meanwhile; if they waited for the lock, the engine is let go so
        // the test fails instead of hanging.
        let (answered, answers) = mpsc::channel();
        let (person, project) = (&host, project_id.as_str());
        scope.spawn(move || {
            let jobs = person.command("job.list", json!({}), Some(project), None);
            let listed = person.command("artifact.list", json!({}), Some(project), None);
            let summary = person.command("project.summary", json!({}), Some(project), None);
            let _ = answered.send((ok(jobs), ok(listed), ok(summary)));
        });
        let (jobs, listed, _summary) = answers
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| {
                engine.release();
                panic!("the person's reads waited for the agent's render to finish");
            });
        let running = jobs["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|job| job["kind"] == "cad_render" && job["status"] == "running")
            .count();
        assert_eq!(running, 1, "the agent's render is visible as running");
        assert!(listed["artifacts"].as_array().unwrap().is_empty());
        assert!(!render.is_finished(), "the render is still in progress");
        let announced = events.named("event");
        assert!(
            announced.iter().any(|event| event["type"] == "job.updated"
                && event["data"]["status"] == "running"
                && event["data"]["sessionId"] == session_id),
            "the start of the agent's job reached the interface before the render ended: {announced:?}"
        );

        engine.release();
        render.join().unwrap()
    });
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["result"]["render"]["ok"], true, "{reply}");
    assert_eq!(
        reply["result"]["geometry"]["bounds"]["size"],
        json!([20.0, 10.0, 2.0])
    );

    // Every event of the call reached the interface once, with its project.
    let delivered = events.named("event");
    let seqs = delivered
        .iter()
        .map(|event| event["seq"].as_i64().unwrap())
        .collect::<Vec<_>>();
    let mut unique = seqs.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(seqs.len(), unique.len(), "an event was delivered twice");
    assert!(delivered
        .iter()
        .all(|event| event["projectId"] == project_id.as_str()));
    let kinds = delivered
        .iter()
        .filter(|event| event["origin"] == "agent")
        .map(|event| match event["data"]["status"].as_str() {
            Some(status) => format!("{} {status}", event["type"].as_str().unwrap()),
            None => event["type"].as_str().unwrap().to_owned(),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        [
            "job.updated running",
            "revision.committed",
            "job.updated succeeded"
        ]
    );

    // The agent's call is on record, live and through agent.activity.
    let calls = events.named("agent-call");
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["tool"], "cad_write_source");
    assert_eq!(calls[0]["op"], "cad.write_source");
    assert_eq!(calls[0]["ok"], true);
    assert_eq!(calls[0]["projectId"], project_id.as_str());
    let activity = ok(host.command("agent.activity", json!({}), Some(&project_id), None));
    assert_eq!(activity["calls"], json!(calls));
    host.shutdown();
}
