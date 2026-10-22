//! One render of (source, parameters): cache lookup, the engine run, the mesh
//! and its identity. Nothing here touches the project database, so it runs
//! with the application lock released.
//!
//! Results are cached by input fingerprint under `.omenflow/cache/`. A failed
//! render is cached too, so a revision that cannot render does not cost an
//! engine run on every check. The cache holds a small manifest; mesh bytes
//! live in the content-addressed object store.
use super::*;
use std::collections::{HashSet, VecDeque};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Default and ceiling for one engine run. Every operation that can render
/// uses these: the request's `timeoutMs` when it has one, else the default.
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 90_000;
pub(crate) const MAX_TIMEOUT_MS: u64 = 600_000;

const CACHE_DIR: &str = ".omenflow/cache/render-rust-v1";
/// A timeout or a crash depends on the machine's load, so such an entry is
/// trusted only briefly.
const TRANSIENT_FAILURE_TTL: Duration = Duration::from_secs(600);
const MESH_CACHE_TRIANGLES: usize = 1_200_000;

pub(crate) fn timeout_ms(input: &Value) -> u64 {
    input["timeoutMs"]
        .as_u64()
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS)
}

pub(crate) struct Request {
    pub source: String,
    pub source_hash: String,
    /// Plain `-D` overrides by name.
    pub params: Value,
    pub timeout_ms: u64,
}

impl Request {
    pub fn new(source: &str, params: &Value, timeout_ms: u64) -> Self {
        Self {
            source: source.to_owned(),
            source_hash: omenflow_storage::sha256_hex(source.as_bytes()),
            params: params.clone(),
            timeout_ms,
        }
    }
}

pub(crate) struct Rendered {
    pub ok: bool,
    /// Served from the cache; the engine did not run for this call.
    pub cached: bool,
    pub ms: u128,
    pub tool: String,
    pub engine_version: String,
    pub command: String,
    pub log: String,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub hints: Vec<String>,
    pub timed_out: bool,
    pub mesh: Option<Arc<mesh::Mesh>>,
    pub identity: Option<Value>,
    /// The source winds its faces inward; the stored mesh was turned outward
    /// for display, which does not repair the source.
    pub source_inverted: bool,
    /// Job that ran the engine for this result.
    pub job_id: String,
}

impl Rendered {
    pub fn first_error(&self) -> &str {
        self.errors
            .first()
            .map(String::as_str)
            .unwrap_or("render failed")
    }

    pub fn summary(&self) -> Value {
        let mut value = json!({"ok": self.ok, "tool": self.tool, "ms": self.ms, "warnings": self.warnings, "errors": self.errors});
        if self.cached {
            value["cached"] = json!(true);
        }
        if !self.hints.is_empty() {
            value["hints"] = json!(self.hints);
        }
        value
    }

    /// A stored render read back for a revision: no engine run, no log.
    pub fn stored(mesh: Arc<mesh::Mesh>, identity: &Value) -> Self {
        Self {
            ok: true,
            cached: false,
            ms: 0,
            tool: "stored render".into(),
            engine_version: identity["engineVersion"].as_str().unwrap_or("").to_owned(),
            command: String::new(),
            log: String::new(),
            warnings: vec![],
            errors: vec![],
            hints: vec![],
            timed_out: false,
            source_inverted: identity["sourceOrientationCorrected"] == true || mesh.inverted,
            mesh: Some(mesh),
            identity: Some(identity.clone()),
            job_id: String::new(),
        }
    }
}

fn cancelled_error() -> ContractError {
    ContractError::new("CANCELLED", "Render was cancelled")
}

fn fingerprint(request: &Request, engine: &engine::Engine) -> (Value, String) {
    let mut sorted = request
        .params
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| json!([k, v]))
        .collect::<Vec<_>>();
    sorted.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
    let options = format!("stl;orientation-v1;exe={}", engine.exe.display());
    let base = json!({"version":1,"sourceHash":request.source_hash,"params":sorted,"modelUnit":"mm","frame":"right-handed-z-up",
        "engine":"openscad","engineVersion":engine.version,"options":options});
    let fingerprint = hash_text(&base.to_string());
    let identity = json!({"version":1,"sourceHash":request.source_hash,"params":request.params,"modelUnit":"mm","frame":"right-handed-z-up",
        "engine":"openscad","engineVersion":engine.version,"options":options,"inputFingerprint":fingerprint});
    (identity, fingerprint)
}

/// Parsed meshes by content hash, newest first, bounded by triangle count:
/// a check that follows a write does not parse the same STL again.
type MeshCache = Mutex<VecDeque<(String, Arc<mesh::Mesh>)>>;

fn mesh_cache() -> &'static MeshCache {
    static MESHES: OnceLock<MeshCache> = OnceLock::new();
    MESHES.get_or_init(Default::default)
}

fn remember_mesh(hash: &str, mesh: &Arc<mesh::Mesh>) {
    let mut cache = mesh_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.retain(|(known, _)| known != hash);
    cache.push_front((hash.to_owned(), mesh.clone()));
    let mut held = 0;
    cache.retain(|(_, mesh)| {
        held += mesh.triangles.len();
        held <= MESH_CACHE_TRIANGLES.max(mesh.triangles.len())
    });
}

/// The mesh stored under `hash`, parsed once.
pub(crate) fn stored_mesh(workspace: &Workspace<'_>, hash: &str) -> CoreResult<Arc<mesh::Mesh>> {
    let known = mesh_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find(|(known, _)| known == hash)
        .map(|(_, mesh)| mesh.clone());
    if let Some(mesh) = known {
        return Ok(mesh);
    }
    let bytes = workspace.objects.read(hash).map_err(storage_error)?;
    let mesh = Arc::new(mesh::Mesh::read(&bytes)?);
    remember_mesh(hash, &mesh);
    Ok(mesh)
}

fn manifest_path(root: &Path, fingerprint: &str) -> PathBuf {
    root.join(CACHE_DIR).join(format!("{fingerprint}.json"))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn load_cached(
    workspace: &Workspace<'_>,
    request: &Request,
    identity: &Value,
    fingerprint: &str,
) -> Option<Rendered> {
    let path = manifest_path(workspace.root, fingerprint);
    let entry: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    let usable = (|| {
        if entry["version"] != 1 || entry["fingerprint"] != fingerprint {
            return None;
        }
        let ok = entry["ok"].as_bool()?;
        let timed_out = entry["timedOut"] == true;
        if entry["transient"] == true {
            let age = chrono::DateTime::parse_from_rfc3339(entry["createdAt"].as_str()?)
                .ok()
                .map(|at| Utc::now().signed_duration_since(at))?;
            if age.to_std().ok()? > TRANSIENT_FAILURE_TTL
                || (timed_out && request.timeout_ms > entry["timeoutMs"].as_u64()?)
            {
                return None;
            }
        }
        let version = entry["engineVersion"].as_str()?.to_owned();
        let mut rendered = Rendered {
            ok,
            cached: true,
            ms: 0,
            tool: format!("openscad {version} (cached)"),
            engine_version: version,
            command: entry["command"].as_str().unwrap_or("").to_owned(),
            log: entry["log"].as_str().unwrap_or("").to_owned(),
            warnings: strings(&entry["warnings"]),
            errors: strings(&entry["errors"]),
            hints: vec![],
            timed_out,
            mesh: None,
            identity: None,
            source_inverted: entry["sourceOrientationCorrected"] == true,
            job_id: entry["jobId"].as_str().unwrap_or("").to_owned(),
        };
        if ok {
            let hash = entry["outputHash"].as_str()?;
            rendered.mesh = Some(stored_mesh(workspace, hash).ok()?);
            let mut identity = identity.clone();
            identity["outputHash"] = json!(hash);
            identity["sourceOrientationCorrected"] = json!(rendered.source_inverted);
            rendered.identity = Some(identity);
        }
        rendered.hints = diagnose(&rendered, request);
        Some(rendered)
    })();
    if usable.is_none() {
        // A corrupt or expired entry is disposable, never evidence.
        let _ = fs::remove_file(path);
    }
    usable
}

fn store(
    workspace: &Workspace<'_>,
    fingerprint: &str,
    rendered: &Rendered,
    request: &Request,
    transient: bool,
) {
    let entry = json!({"version":1,"fingerprint":fingerprint,"ok":rendered.ok,
        "outputHash":rendered.identity.as_ref().map(|identity| identity["outputHash"].clone()),
        "sourceOrientationCorrected":rendered.source_inverted,
        "warnings":rendered.warnings,"errors":rendered.errors,"log":rendered.log,
        "engineVersion":rendered.engine_version,"command":rendered.command,"jobId":rendered.job_id,
        "timedOut":rendered.timed_out,"timeoutMs":request.timeout_ms,"transient":transient,"createdAt":now()});
    let path = manifest_path(workspace.root, fingerprint);
    let Some(dir) = path.parent() else { return };
    // The cache is an optimisation: failing to write it must not fail the render.
    let temp = dir.join(format!("{fingerprint}.tmp-{}", uuid::Uuid::new_v4()));
    if fs::create_dir_all(dir).is_ok() && fs::write(&temp, entry.to_string()).is_ok() {
        let _ = fs::rename(&temp, &path);
    }
    let _ = fs::remove_file(temp);
}

fn diagnose(rendered: &Rendered, request: &Request) -> Vec<String> {
    let mut hints = engine::hints(&rendered.warnings, &rendered.errors, &request.source);
    if rendered.timed_out {
        hints.insert(0, format!("The render hit its {} ms limit: lower $fn, reduce boolean operations (minkowski and hull over many facets are slow), or raise timeoutMs.", request.timeout_ms));
    }
    hints
}

/// Renders of the same inputs in the same project, one at a time: a second
/// caller waits for the first and then reads its cached result.
struct Turn(PathBuf, String);

type InFlight = (Mutex<HashSet<(PathBuf, String)>>, Condvar);

fn in_flight() -> &'static InFlight {
    static IN_FLIGHT: OnceLock<InFlight> = OnceLock::new();
    IN_FLIGHT.get_or_init(Default::default)
}

impl Turn {
    fn take(root: &Path, fingerprint: &str, cancelled: &dyn Fn() -> bool) -> CoreResult<Self> {
        let (running, changed) = in_flight();
        let key = (root.to_path_buf(), fingerprint.to_owned());
        let mut held = running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while held.contains(&key) {
            if cancelled() {
                return Err(cancelled_error());
            }
            held = changed
                .wait_timeout(held, Duration::from_millis(50))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        held.insert(key.clone());
        Ok(Self(key.0, key.1))
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        let (running, changed) = in_flight();
        running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(self.0.clone(), self.1.clone()));
        changed.notify_all();
    }
}

/// What one engine run writes.
pub(crate) enum Output<'a> {
    /// The render: a binary STL.
    BinaryStl(&'a Path),
    /// The evaluated CSG tree, which the STEP converter rebuilds. Its `.csg`
    /// suffix selects the format: `--export-format` would apply to every
    /// output of the run.
    Csg(&'a Path),
}

/// OpenSCAD arguments that evaluate `request` (its source already written to
/// `scad`) into `output`, and the "-D a=1 -D b=2 " text for the recorded
/// command. Renders and CSG exports of a revision both come through here, so
/// both evaluate the same `-D` values.
pub(crate) fn engine_args(
    request: &Request,
    scad: &Path,
    output: Output<'_>,
) -> CoreResult<(Vec<String>, String)> {
    let mut args = match output {
        Output::BinaryStl(stl) => vec![
            "-o".to_owned(),
            stl.to_string_lossy().into_owned(),
            "--export-format".into(),
            "binstl".into(),
        ],
        Output::Csg(csg) => vec!["-o".to_owned(), csg.to_string_lossy().into_owned()],
    };
    let mut defines = String::new();
    for (name, value) in request.params.as_object().into_iter().flatten() {
        let define = format!("{name}={}", params::format_value(name, value)?);
        defines.push_str(&format!("-D {define} "));
        args.push("-D".into());
        args.push(define);
    }
    args.push(scad.to_string_lossy().into_owned());
    Ok((args, defines))
}

/// Render `request`, from the cache when the same inputs were rendered
/// before. A render that fails is a result (`ok: false`); only a missing
/// engine, a cancellation or an I/O fault is an error.
pub(crate) fn render(
    workspace: &Workspace<'_>,
    request: &Request,
    job_id: &str,
) -> CoreResult<Rendered> {
    params::assert_self_contained(&request.source)?;
    let engine = engine::engine(workspace.executable.as_deref())?;
    if (workspace.cancelled)() {
        return Err(cancelled_error());
    }
    let (identity, fingerprint) = fingerprint(request, &engine);
    if let Some(hit) = load_cached(workspace, request, &identity, &fingerprint) {
        return Ok(hit);
    }
    let _turn = Turn::take(workspace.root, &fingerprint, workspace.cancelled)?;
    if let Some(hit) = load_cached(workspace, request, &identity, &fingerprint) {
        return Ok(hit);
    }
    let temp = tempfile::tempdir().map_err(internal)?;
    let scad = temp.path().join("input.scad");
    let stl = temp.path().join("output.stl");
    fs::write(&scad, &request.source).map_err(internal)?;
    let (args, defines) = engine_args(request, &scad, Output::BinaryStl(&stl))?;
    let start = Instant::now();
    let run = engine::run(
        &engine.exe,
        &args,
        Duration::from_millis(request.timeout_ms),
        temp.path(),
        workspace.cancelled,
    )?;
    if run.cancelled {
        return Err(cancelled_error());
    }
    let (warnings, mut errors) = engine::classify(&run.log);
    let reported = !errors.is_empty();
    if run.timed_out {
        errors.push(format!("Render exceeded {} ms", request.timeout_ms));
    }
    let mut rendered = Rendered {
        ok: false,
        cached: false,
        ms: start.elapsed().as_millis(),
        tool: format!("openscad {}", engine.version),
        engine_version: engine.version.clone(),
        command: format!(
            "{} -o output.stl --export-format binstl {defines}input.scad",
            engine.exe.display(),
        ),
        log: run.log,
        warnings,
        errors,
        hints: vec![],
        timed_out: run.timed_out,
        mesh: None,
        identity: None,
        source_inverted: false,
        job_id: job_id.to_owned(),
    };
    let mut transient = run.timed_out;
    let size = stl.metadata().map(|m| m.len() as usize).unwrap_or(0);
    if run.ok && rendered.errors.is_empty() && size > 0 {
        let parsed = if size > mesh::MAX_MESH_BYTES {
            Err(mesh::work_limit(
                "STL byte size",
                size,
                mesh::MAX_MESH_BYTES,
            ))
        } else {
            fs::read(&stl)
                .map_err(internal)
                .and_then(|bytes| mesh::Mesh::read(&bytes).map(|mesh| (mesh, bytes)))
        };
        match parsed {
            Ok((mesh, bytes)) => {
                let (mesh, corrected) = mesh.outward();
                let hash = workspace
                    .objects
                    .put(&if corrected {
                        mesh.to_binary_stl()
                    } else {
                        bytes
                    })
                    .map_err(storage_error)?;
                let mesh = Arc::new(mesh);
                remember_mesh(&hash, &mesh);
                let mut identity = identity;
                identity["outputHash"] = json!(hash);
                identity["sourceOrientationCorrected"] = json!(corrected);
                rendered.ok = true;
                rendered.source_inverted = corrected || mesh.inverted;
                rendered.mesh = Some(mesh);
                rendered.identity = Some(identity);
            }
            Err(error) => rendered.errors.push(error.message),
        }
    } else if rendered.errors.is_empty() {
        transient = !reported;
        rendered.errors.push(
            rendered
                .warnings
                .first()
                .map(|warning| format!("OpenSCAD produced no geometry ({warning})"))
                .unwrap_or_else(|| "OpenSCAD produced no geometry".into()),
        );
    }
    rendered.hints = diagnose(&rendered, request);
    store(workspace, &fingerprint, &rendered, request, transient);
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_timeout_policy_applies_to_every_request() {
        assert_eq!(timeout_ms(&json!({})), DEFAULT_TIMEOUT_MS);
        assert_eq!(timeout_ms(&json!({"timeoutMs": 30_000})), 30_000);
        assert_eq!(timeout_ms(&json!({"timeoutMs": 9_000_000})), MAX_TIMEOUT_MS);
        assert_eq!(timeout_ms(&json!({"timeoutMs": 0})), 1);
    }

    #[test]
    fn the_fingerprint_follows_source_parameters_and_engine_not_their_order() {
        let engine = engine::Engine {
            exe: PathBuf::from("/opt/openscad"),
            version: "2026.09.18".into(),
        };
        let print = |source: &str, params: Value| {
            fingerprint(&Request::new(source, &params, 1_000), &engine).1
        };
        let base = print("cube(1);", json!({"a": 1, "b": 2}));
        assert_eq!(base, print("cube(1);", json!({"b": 2, "a": 1})));
        assert_ne!(base, print("cube(2);", json!({"a": 1, "b": 2})));
        assert_ne!(base, print("cube(1);", json!({"a": 1, "b": 3})));
        let other = engine::Engine {
            exe: PathBuf::from("/opt/openscad"),
            version: "2021.01".into(),
        };
        assert_ne!(
            base,
            fingerprint(
                &Request::new("cube(1);", &json!({"a": 1, "b": 2}), 1_000),
                &other
            )
            .1
        );
        let (identity, _) =
            fingerprint(&Request::new("cube(1);", &json!({"a": 1}), 1_000), &engine);
        assert_eq!(identity["version"], 1);
        assert_eq!(identity["params"], json!({"a": 1}));
        assert_eq!(identity["options"], "stl;orientation-v1;exe=/opt/openscad");
    }

    #[test]
    fn csg_and_render_arguments_share_their_defines() {
        let request = Request::new(
            "hole_d = 3;\ncube(1);",
            &json!({"hole_d": 5, "label": "M5"}),
            1_000,
        );
        let scad = Path::new("/w/input.scad");
        let (render, defines) = engine_args(
            &request,
            scad,
            Output::BinaryStl(Path::new("/w/output.stl")),
        )
        .unwrap();
        let (csg, same) =
            engine_args(&request, scad, Output::Csg(Path::new("/w/output.csg"))).unwrap();
        assert_eq!(defines, same);
        assert_eq!(defines, "-D hole_d=5 -D label=\"M5\" ");
        assert_eq!(
            render,
            [
                "-o",
                "/w/output.stl",
                "--export-format",
                "binstl",
                "-D",
                "hole_d=5",
                "-D",
                "label=\"M5\"",
                "/w/input.scad"
            ]
        );
        // The CSG run never names an export format: it would apply to every output.
        assert_eq!(
            csg,
            [
                "-o",
                "/w/output.csg",
                "-D",
                "hole_d=5",
                "-D",
                "label=\"M5\"",
                "/w/input.scad"
            ]
        );
    }

    #[test]
    fn a_second_caller_waits_for_the_first_render_of_the_same_inputs() {
        let root = PathBuf::from("/tmp/omenflow-turn-test");
        let first = Turn::take(&root, "print", &|| false).unwrap();
        let waited = std::thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                let start = Instant::now();
                let _second = Turn::take(&root, "print", &|| false).unwrap();
                start.elapsed()
            });
            std::thread::sleep(Duration::from_millis(120));
            drop(first);
            waiter.join().unwrap()
        });
        assert!(waited >= Duration::from_millis(100), "{waited:?}");
        let held = Turn::take(&root, "print", &|| false).unwrap();
        let other = Turn::take(&root, "another", &|| false).unwrap();
        assert_eq!(
            Turn::take(&root, "print", &|| true).err().unwrap().code,
            "CANCELLED"
        );
        drop((held, other));
    }
}
