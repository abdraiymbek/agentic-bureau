//! Shared helpers for CAD tests: a project behind a shared `CoreApp`, the
//! real engine guard, and a stand-in engine whose renders can be held open.
use super::*;
use std::sync::Mutex;

/// Is OpenSCAD available? An engine test must not pass by doing nothing:
/// without the engine it fails, unless `BUREAU_ALLOW_MISSING_OPENSCAD=1`
/// states that this machine is known not to have one.
pub(crate) fn engine_available() -> bool {
    match engine::engine(None) {
        Ok(_) => true,
        Err(error) => {
            let allowed =
                std::env::var_os("BUREAU_ALLOW_MISSING_OPENSCAD").is_some_and(|value| value == "1");
            assert!(
                allowed,
                "OpenSCAD is required for this test ({}). Install it, set OPENSCAD_PATH, or set BUREAU_ALLOW_MISSING_OPENSCAD=1 to skip engine tests explicitly.",
                error.message
            );
            eprintln!(
                "SKIPPED engine test: OpenSCAD is not available and BUREAU_ALLOW_MISSING_OPENSCAD=1 is set"
            );
            false
        }
    }
}

/// One project open in a shared application, as a host holds it.
pub(crate) struct Sandbox {
    _temp: tempfile::TempDir,
    pub core: Arc<Mutex<CoreApp>>,
    pub project_id: String,
    pub root: PathBuf,
}

impl Sandbox {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name": "CAD", "path": temp.path().join("project"), "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = created["projectId"].as_str().unwrap().to_owned();
        let root = app.project_root(&project_id).unwrap();
        Self {
            _temp: temp,
            core: Arc::new(Mutex::new(app)),
            project_id,
            root,
        }
    }

    /// A project whose engine setting points at `executable`.
    pub fn with_engine(executable: &Path) -> Self {
        let sandbox = Self::new();
        sandbox
            .core
            .lock()
            .unwrap()
            .dispatch(
                "settings.set",
                json!({"key": "toolPaths.openscad", "value": executable}),
                Origin::User,
                None,
            )
            .unwrap();
        sandbox
    }

    pub fn call(&self, op: &str, payload: Value) -> CoreResult<Value> {
        self.call_as(Origin::User, op, payload)
    }

    pub fn call_as(&self, origin: Origin, op: &str, payload: Value) -> CoreResult<Value> {
        dispatch_shared(
            &self.core,
            op,
            payload,
            origin,
            Some(&self.project_id),
            None,
        )
    }

    /// Call and return the events this call recorded.
    pub fn call_with_events(&self, op: &str, payload: Value) -> (CoreResult<Value>, Vec<Value>) {
        let mut events = Vec::new();
        let result = dispatch_shared_with_events(
            &self.core,
            op,
            payload,
            Origin::User,
            Some(&self.project_id),
            None,
            &mut |event| events.push(event),
        );
        (result, events)
    }

    /// Run `work` on the project handle, as code inside the core would.
    pub fn with_handle<T>(&self, work: impl FnOnce(&ProjectHandle) -> T) -> T {
        work(&self.core.lock().unwrap().projects[&self.project_id])
    }

    pub fn revision(&self, id: &Value) -> Value {
        self.with_handle(|handle| require_revision(handle, id.as_str().unwrap()).unwrap())
    }

    pub fn jobs(&self, kind: &str) -> Vec<Value> {
        self.call("job.list", json!({"limit": 200})).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|job| job["kind"] == kind)
            .cloned()
            .collect()
    }

    pub fn revisions(&self, artifact_id: &Value) -> Vec<Value> {
        self.call("artifact.history", json!({"artifactId": artifact_id}))
            .unwrap()["revisions"]
            .as_array()
            .unwrap()
            .clone()
    }
}

/// A 40 × 30 × 4 mm plate with four ⌀3.2 through holes 5 mm in from each corner.
pub(crate) const PLATE: &str = "plate = [40, 30, 4];\nhole_d = 3.2;\ninset = 5;\ndifference() {\n  cube(plate);\n  for (x = [inset, plate[0] - inset], y = [inset, plate[1] - inset])\n    translate([x, y, -1]) cylinder(d = hole_d, h = plate[2] + 2);\n}\n";

pub(crate) fn plate_expectation() -> Value {
    json!({"size": [40, 30, 4], "bodies": 1, "holes": [
        {"at": [5, 5, 2], "d": 3.2}, {"at": [35, 5, 2], "d": 3.2},
        {"at": [5, 25, 2], "d": 3.2}, {"at": [35, 25, 2], "d": 3.2}]})
}

/// A stand-in for the engine: it answers `--version`, and for a render it
/// waits until the gate file exists and then writes a fixed mesh. It lets a
/// test hold a render open for as long as it needs. Not OpenSCAD: tests that
/// use it are about locking, jobs and events, never about geometry.
#[cfg(unix)]
pub(crate) struct StandIn {
    pub executable: PathBuf,
    gate: PathBuf,
    renders: PathBuf,
}

#[cfg(unix)]
impl StandIn {
    pub fn new(dir: &Path) -> Self {
        Self::build(dir, false)
    }

    /// A stand-in that also holds its `--version` answer behind the gate.
    pub fn gated_version(dir: &Path) -> Self {
        Self::build(dir, true)
    }

    fn build(dir: &Path, gate_version: bool) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let stl = dir.join("stand-in.stl");
        let mesh =
            mesh::Mesh::from_triangles(mesh::fixtures::cuboid([0.0; 3], [20.0, 10.0, 2.0], false))
                .unwrap();
        fs::write(&stl, mesh.to_binary_stl()).unwrap();
        let (gate, renders) = (dir.join("gate"), dir.join("invocations"));
        let wait = format!("while [ ! -f '{}' ]; do sleep 0.02; done", gate.display());
        let script = format!(
            "#!/bin/sh\necho \"$1\" >> '{}'\nif [ \"$1\" = \"--version\" ]; then\n  {}\n  echo 'OpenSCAD version 0.0.0-standin'\n  exit 0\nfi\n{wait}\ncp '{}' \"$2\"\n",
            renders.display(),
            if gate_version { wait.as_str() } else { ":" },
            stl.display()
        );
        let executable = dir.join("stand-in-engine");
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            executable,
            gate,
            renders,
        }
    }

    /// Let held invocations finish, and later ones run straight through.
    pub fn release(&self) {
        fs::write(&self.gate, "").unwrap();
    }

    /// Hold invocations again until the next `release`.
    pub fn hold(&self) {
        fs::remove_file(&self.gate).unwrap();
    }

    fn invocations(&self, first_argument: &str) -> usize {
        fs::read_to_string(&self.renders)
            .map(|text| text.lines().filter(|line| *line == first_argument).count())
            .unwrap_or(0)
    }

    /// How many times the stand-in was asked to render.
    pub fn renders(&self) -> usize {
        self.invocations("-o")
    }

    /// How many times the stand-in was asked for its version.
    pub fn version_probes(&self) -> usize {
        self.invocations("--version")
    }
}

/// Wait until `ready` holds, failing the test after thirty seconds.
pub(crate) fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !ready() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
