//! OpenSCAD and STL handling. Source and mesh bytes live in the same immutable
//! object store as the original application; working files remain materialized.
use super::*;
use regex::Regex;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod checks;
mod mesh;
mod section;
mod verification;

const NEXT_SOURCE: &str = "Edit the source as needed and save it with cad.write_source({ artifactId, source }) — this creates a new draft revision on the same part; the baseline is untouched until a human approves.";

thread_local! {
    static CONFIGURED_EXECUTABLE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

// Each app dispatch (including its render worker) uses its own saved tool path.
// Keep the override scoped so concurrent apps/tests cannot change one another's engine.
pub(super) fn with_executable<T>(path: Option<PathBuf>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CONFIGURED_EXECUTABLE.with(|value| {
                value.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(CONFIGURED_EXECUTABLE.with(|value| value.replace(path)));
    work()
}

pub(super) fn configured_executable() -> Option<PathBuf> {
    CONFIGURED_EXECUTABLE.with(|value| value.borrow().clone())
}

fn executable() -> Option<PathBuf> {
    if let Some(path) = configured_executable() {
        return Some(path);
    }
    if let Ok(path) = std::env::var("OPENSCAD_PATH") {
        if Path::new(&path).is_file() {
            return Some(PathBuf::from(path));
        }
    }
    let candidates = if cfg!(target_os = "macos") {
        vec![
            "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
            "/opt/homebrew/bin/openscad",
            "/usr/local/bin/openscad",
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            r"C:\Program Files\OpenSCAD\openscad.exe",
            r"C:\Program Files (x86)\OpenSCAD\openscad.exe",
        ]
    } else {
        vec![
            "/usr/bin/openscad",
            "/usr/local/bin/openscad",
            "/snap/bin/openscad",
        ]
    };
    for candidate in candidates {
        if Path::new(candidate).is_file() {
            return Some(PathBuf::from(candidate));
        }
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| {
            dir.join(if cfg!(target_os = "windows") {
                "openscad.exe"
            } else {
                "openscad"
            })
        })
        .find(|p| p.is_file())
}

fn run_tool(
    exe: &Path,
    args: &[String],
    timeout_ms: u64,
    cwd: &Path,
) -> CoreResult<(bool, String, bool)> {
    let (ok, log, timed_out, _) = run_tool_interruptible(exe, args, timeout_ms, cwd, || false)?;
    Ok((ok, log, timed_out))
}

fn run_tool_interruptible(
    exe: &Path,
    args: &[String],
    timeout_ms: u64,
    cwd: &Path,
    cancelled: impl Fn() -> bool,
) -> CoreResult<(bool, String, bool, bool)> {
    let log_path = cwd.join(format!("tool-{}.log", uuid::Uuid::new_v4()));
    let output = fs::File::create(&log_path).map_err(internal)?;
    let mut command = Command::new(exe);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::from(output.try_clone().map_err(internal)?))
        .stderr(Stdio::from(output))
        .spawn()
        .map_err(internal)?;
    let start = Instant::now();
    let (ok, timed_out, was_cancelled) = loop {
        if let Some(status) = child.try_wait().map_err(internal)? {
            break (status.success(), false, false);
        }
        if cancelled() {
            terminate_tool(&mut child);
            break (false, false, true);
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            terminate_tool(&mut child);
            break (false, true, false);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = fs::read(&log_path).map_err(internal)?;
    let _ = fs::remove_file(log_path);
    Ok((
        ok,
        String::from_utf8_lossy(&bytes[..bytes.len().min(1_048_576)]).into_owned(),
        timed_out,
        was_cancelled,
    ))
}

fn terminate_tool(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn probe() -> CoreResult<Value> {
    let Some(exe) = executable() else {
        return Ok(
            json!({"available":false,"executablePath":null,"version":null,"error":"OpenSCAD not found"}),
        );
    };
    let temp = tempfile::tempdir().map_err(internal)?;
    let (ok, log, timed_out) = run_tool(&exe, &["--version".into()], 10_000, temp.path())?;
    let version = Regex::new(r"(?i)OpenSCAD version\s+([0-9][\w.\-]*)")
        .unwrap()
        .captures(&log)
        .map(|m| m[1].to_owned());
    if !ok || timed_out || version.is_none() {
        return Ok(
            json!({"available":false,"executablePath":exe,"version":version,"error":format!("Unrecognized --version output: {}",log.trim())}),
        );
    }
    let source = temp.path().join("probe.scad");
    let stl = temp.path().join("probe.stl");
    fs::write(&source, "cube(1);\n").map_err(internal)?;
    let (rendered, render_log, _) = run_tool(
        &exe,
        &[
            "-o".into(),
            stl.to_string_lossy().into(),
            source.to_string_lossy().into(),
        ],
        30_000,
        temp.path(),
    )?;
    let available = rendered && stl.metadata().is_ok_and(|m| m.len() > 84);
    Ok(
        json!({"available":available,"executablePath":exe,"version":version,
        "error": if available { Value::Null } else { json!(format!("probe render failed: {}",render_log.trim())) }}),
    )
}

fn require_mechanical(handle: &ProjectHandle, id: &str) -> CoreResult<Value> {
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "mechanical" {
        return Err(ContractError::validation(format!(
            "Artifact \"{}\" is a {}, not a mechanical part",
            artifact["title"].as_str().unwrap_or(""),
            artifact["type"]
        )));
    }
    Ok(artifact)
}

fn pick_revision(handle: &ProjectHandle, artifact: &Value, id: Option<&str>) -> CoreResult<Value> {
    let artifact_id = required_str(artifact, "id")?;
    let revision = if let Some(id) = id {
        require_revision(handle, id)?
    } else {
        handle.db.query_row("SELECT * FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1", [artifact_id], revision_from_row)
            .optional().map_err(internal)?.ok_or_else(|| ContractError::validation("Mechanical artifact has no revision"))?
    };
    if revision["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    Ok(revision)
}

fn scad_ref(revision: &Value) -> Option<&Value> {
    let path = revision["payload"]["scad"]["path"].as_str();
    revision["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|file| file["path"].as_str() == path)
        .or_else(|| {
            revision["files"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|file| file["path"].as_str().is_some_and(|p| p.ends_with(".scad")))
        })
        .or_else(|| revision["payload"].get("scad"))
}

fn source_of(handle: &ProjectHandle, revision: &Value) -> CoreResult<(String, String)> {
    let source_ref = scad_ref(revision)
        .ok_or_else(|| ContractError::new("NOT_FOUND", "This revision has no OpenSCAD source"))?;
    let path = required_str(source_ref, "path")?.to_owned();
    let bytes = if let Some(hash) = source_ref["sha256"].as_str() {
        handle
            .object_store()
            .map_err(storage_error)?
            .read(hash)
            .map_err(storage_error)?
    } else {
        fs::read(resolve_materialization_path(&handle.root, &path).map_err(storage_error)?)
            .map_err(internal)?
    };
    let source = String::from_utf8(bytes)
        .map_err(|_| ContractError::validation("OpenSCAD source is not UTF-8"))?;
    Ok((path, source))
}

fn safe_scad(source: &str) -> CoreResult<()> {
    let stripped_blocks = Regex::new(r"(?s)/\*.*?\*/")
        .unwrap()
        .replace_all(source, " ");
    let code = Regex::new(r"//[^\n]*")
        .unwrap()
        .replace_all(&stripped_blocks, " ");
    if Regex::new(r"\b(?:include|use)\s*<|\b(?:import|surface|text|rands)\s*\(")
        .unwrap()
        .is_match(&code)
    {
        return Err(ContractError::validation("V0.1 CAD source must be self-contained; include/use/import/surface, host-font text() and random rands() dependencies are not yet reproducibly pinned."));
    }
    Ok(())
}

#[derive(Clone)]
struct ScadParam {
    name: String,
    value: Value,
    derived: bool,
    expr: Option<String>,
    comment: Option<String>,
    line: usize,
}

fn parameters(source: &str) -> Vec<ScadParam> {
    let pattern = Regex::new(r"^\s*([A-Za-z_$][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$").unwrap();
    let mut result = Vec::new();
    let mut depth = 0i32;
    let mut block = false;
    for (line_index, line) in source.lines().enumerate() {
        let mut clean = String::new();
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if block {
                if ch == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    block = false;
                }
                continue;
            }
            if ch == '/' && chars.peek() == Some(&'*') {
                chars.next();
                block = true;
                continue;
            }
            clean.push(ch);
        }
        let (code, comment) = clean
            .split_once("//")
            .map(|(a, b)| (a, Some(b.trim().to_owned())))
            .unwrap_or((&clean, None));
        if depth == 0 {
            for statement in code.split(';') {
                if let Some(captures) = pattern.captures(statement) {
                    let name = captures[1].to_owned();
                    let expr = captures[2].trim().to_owned();
                    let value = if expr == "true" {
                        json!(true)
                    } else if expr == "false" {
                        json!(false)
                    } else if let Ok(number) = expr.parse::<f64>() {
                        json!(number)
                    } else if expr.starts_with('"') && expr.ends_with('"') {
                        json!(expr.trim_matches('"'))
                    } else {
                        Value::Null
                    };
                    result.push(ScadParam {
                        name,
                        value,
                        derived: !matches!(expr.as_str(), "true" | "false")
                            && expr.parse::<f64>().is_err()
                            && !(expr.starts_with('"') && expr.ends_with('"')),
                        expr: Some(expr),
                        comment: comment.clone(),
                        line: line_index,
                    });
                }
            }
        }
        for ch in code.chars() {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth = (depth - 1).max(0);
            }
        }
    }
    result
}

fn param_json(param: &ScadParam) -> Value {
    let mut item = json!({"name":param.name,"value":param.value,"derived":param.derived});
    if param.derived {
        item["expr"] = json!(param.expr);
    }
    if let Some(comment) = &param.comment {
        item["comment"] = json!(comment);
    }
    item
}

pub(super) fn read_source(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (path, source) = source_of(handle, &revision)?;
    let params = parameters(&source)
        .into_iter()
        .map(|p| param_json(&p))
        .collect::<Vec<_>>();
    let has_render = render_matches(&revision);
    Ok(
        json!({"artifactId":artifact["id"],"revisionId":revision["id"],"title":artifact["title"],
        "revisionSeq":revision["seq"],"reviewState":revision["reviewState"],
        "isBaseline":artifact["selectedRevisionId"]==revision["id"],"sourcePath":path,"source":source,
        "parameters":params,"recordedParams":revision["payload"]["params"],
        "unit":revision["payload"]["modelUnit"].as_str().unwrap_or("mm"),"hasRender":has_render,"next":NEXT_SOURCE}),
    )
}

fn render_matches(revision: &Value) -> bool {
    let Some(source) = scad_ref(revision) else {
        return false;
    };
    let identity = &revision["payload"]["renderIdentity"];
    let stl = &revision["payload"]["stl"];
    identity["version"] == 1
        && identity["sourceHash"] == source["sha256"]
        && identity["outputHash"] == stl["sha256"]
        && identity["modelUnit"] == revision["payload"]["modelUnit"]
        && identity["params"] == revision["payload"]["params"]
}

struct Render {
    ok: bool,
    ms: u128,
    tool: String,
    log: String,
    warnings: Vec<String>,
    errors: Vec<String>,
    stl: Option<Vec<u8>>,
    mesh: Option<mesh::Mesh>,
    identity: Option<Value>,
    job_id: String,
}

fn source_with_facets(source: &str) -> String {
    let stripped = Regex::new(r"(?s)/\*.*?\*/|//[^\n]*")
        .unwrap()
        .replace_all(source, " ");
    if !stripped.contains("$fn =")
        && Regex::new(r"\b(cylinder|sphere|circle|rotate_extrude)\s*\(")
            .unwrap()
            .is_match(&stripped)
    {
        format!("$fn = 64;\n{source}")
    } else {
        source.to_owned()
    }
}

fn override_params(input: &Value, declared: &[ScadParam]) -> CoreResult<Value> {
    let mut out = serde_json::Map::new();
    for (name, value) in input.as_object().into_iter().flat_map(|m| m.iter()) {
        if !declared.iter().any(|p| p.name == *name) {
            return Err(ContractError::validation(format!(
                "Unknown parameter: {name}"
            )));
        }
        if !(value.is_number() || value.is_boolean() || value.is_string()) {
            return Err(ContractError::validation(format!(
                "Unsupported CAD parameter value: {name}"
            )));
        }
        out.insert(name.clone(), value.clone());
    }
    Ok(Value::Object(out))
}

fn engine_version(exe: &Path) -> CoreResult<String> {
    let temp = tempfile::tempdir().map_err(internal)?;
    let (ok, log, _) = run_tool(exe, &["--version".into()], 10_000, temp.path())?;
    let version = Regex::new(r"(?i)OpenSCAD version\s+([0-9][\w.\-]*)")
        .unwrap()
        .captures(&log)
        .map(|m| m[1].to_owned());
    if !ok || version.is_none() {
        return Err(ContractError::new(
            "TOOL_MISSING",
            format!("OpenSCAD version probe failed: {}", log.trim()),
        ));
    }
    Ok(version.unwrap())
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn job_cancelled(handle: &ProjectHandle, id: &str) -> bool {
    handle
        .db
        .query_row("SELECT status FROM job WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .is_ok_and(|status| matches!(status.as_str(), "cancelled" | "interrupted"))
}

#[allow(clippy::too_many_arguments)]
fn render_source(
    handle: &ProjectHandle,
    source: &str,
    params: &Value,
    timeout_ms: u64,
    origin: &Origin,
    artifact_id: &str,
    parent_id: Option<&str>,
    existing_job_id: Option<&str>,
) -> CoreResult<Render> {
    safe_scad(source)?;
    if existing_job_id.is_some_and(|id| job_cancelled(handle, id)) {
        return Err(ContractError::new("CANCELLED", "Render was cancelled"));
    }
    let exe =
        executable().ok_or_else(|| ContractError::new("TOOL_MISSING", "OpenSCAD not found"))?;
    let version = engine_version(&exe)?;
    if existing_job_id.is_some_and(|id| job_cancelled(handle, id)) {
        return Err(ContractError::new("CANCELLED", "Render was cancelled"));
    }
    let source_hash = handle
        .object_store()
        .map_err(storage_error)?
        .put(source.as_bytes())
        .map_err(storage_error)?;
    let job_id = existing_job_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timestamp = now();
    if existing_job_id.is_some() {
        let updated=handle.db.execute("UPDATE job SET status='running',tool_version=?1,input_hashes=?2,started_at=?3 WHERE id=?4 AND status='queued'",
            params![version,json!({"source":source_hash}).to_string(),timestamp,job_id]).map_err(internal)?;
        if updated != 1 {
            return Err(ContractError::new("CANCELLED", "Render was cancelled"));
        }
    } else {
        handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,'cad_render','openscad',?2,?3,?4,NULL,'running','','{}',NULL,?5,?6,?6,NULL)",
            params![job_id,version,json!({"artifactId":artifact_id,"revisionId":parent_id,"params":params}).to_string(),json!({"source":source_hash}).to_string(),origin.session_id(),timestamp]).map_err(internal)?;
    }
    let temp = tempfile::tempdir().map_err(internal)?;
    let scad = temp.path().join("input.scad");
    let stl = temp.path().join("output.stl");
    fs::write(&scad, source).map_err(internal)?;
    let mut args = vec![
        "-o".to_owned(),
        stl.to_string_lossy().into_owned(),
        "--export-format".into(),
        "binstl".into(),
    ];
    for (name, value) in params.as_object().into_iter().flat_map(|m| m.iter()) {
        let formatted = value.to_string();
        args.push("-D".into());
        args.push(format!("{name}={formatted}"));
    }
    args.push(scad.to_string_lossy().into_owned());
    let start = Instant::now();
    let (ok, log, timed_out, was_cancelled) =
        run_tool_interruptible(&exe, &args, timeout_ms, temp.path(), || {
            job_cancelled(handle, &job_id)
        })?;
    if was_cancelled || job_cancelled(handle, &job_id) {
        return Err(ContractError::new("CANCELLED", "Render was cancelled"));
    }
    let ms = start.elapsed().as_millis();
    let warnings = log
        .lines()
        .filter(|line| {
            line.trim_start().starts_with("WARNING:")
                || line.trim_start().starts_with("DEPRECATED:")
        })
        .take(12)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut errors = log
        .lines()
        .filter(|line| {
            line.trim_start().starts_with("ERROR:")
                || line.contains("Parser error")
                || line.contains("top level object is empty")
        })
        .take(12)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if timed_out {
        errors.push(format!("Render exceeded {timeout_ms} ms"));
    }
    let mut result = Render {
        ok: false,
        ms,
        tool: format!("openscad {version}"),
        log: log.clone(),
        warnings,
        errors,
        stl: None,
        mesh: None,
        identity: None,
        job_id: job_id.clone(),
    };
    if ok && result.errors.is_empty() && stl.is_file() {
        let bytes = fs::read(&stl).map_err(internal)?;
        match mesh::Mesh::read(&bytes) {
            Ok(mesh) => {
                let hash = handle
                    .object_store()
                    .map_err(storage_error)?
                    .put(&bytes)
                    .map_err(storage_error)?;
                let mut sorted = params
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.iter())
                    .map(|(k, v)| json!([k, v]))
                    .collect::<Vec<_>>();
                sorted.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
                let base = json!({"version":1,"sourceHash":source_hash,"params":sorted,"modelUnit":"mm","frame":"right-handed-z-up",
                    "engine":"openscad","engineVersion":version,"options":format!("stl;orientation-v1;exe={}",exe.display())});
                let fingerprint = hash_text(&base.to_string());
                let identity = json!({"version":1,"sourceHash":source_hash,"params":params,"modelUnit":"mm","frame":"right-handed-z-up",
                    "engine":"openscad","engineVersion":version,"options":format!("stl;orientation-v1;exe={}",exe.display()),
                    "inputFingerprint":fingerprint,"outputHash":hash,"sourceOrientationCorrected":mesh.inverted});
                result.ok = true;
                result.stl = Some(bytes);
                result.mesh = Some(mesh);
                result.identity = Some(identity);
            }
            Err(error) => result.errors.push(error.message),
        }
    } else if result.errors.is_empty() {
        result.errors.push(
            if timed_out {
                "render timed out"
            } else {
                "OpenSCAD produced no geometry"
            }
            .into(),
        );
    }
    let updated=handle.db.execute("UPDATE job SET status=?1,log=?2,output_hashes=?3,error=?4,command=?5,finished_at=?6 WHERE id=?7 AND status='running'",
        params![if result.ok && existing_job_id.is_some() {"running"} else if result.ok {"succeeded"} else {"failed"},result.log,json!(result.identity.as_ref().map(|i|json!({"stl":i["outputHash"]})).unwrap_or(json!({}))).to_string(),
            if result.ok {None} else {Some(json!({"code":"VALIDATION","message":result.errors.first()}).to_string())},
            format!("{} -o output.stl input.scad",exe.display()),if result.ok && existing_job_id.is_some(){None}else{Some(now())},job_id]).map_err(internal)?;
    if updated != 1 {
        return Err(ContractError::new("CANCELLED", "Render was cancelled"));
    }
    Ok(result)
}

fn slug(title: &str) -> String {
    let lower = title.to_lowercase();
    let clean = Regex::new(r"[^a-z0-9]+").unwrap().replace_all(&lower, "-");
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        "artifact".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn auto_sections(mesh: &mesh::Mesh) -> Vec<Value> {
    let mut reports = Vec::new();
    for axis in [2, 1, 0] {
        let span = mesh.bounds_max[axis] - mesh.bounds_min[axis];
        if span > 0.0 {
            reports.push(
                section::Section::from_mesh(mesh, axis, mesh.bounds_min[axis] + span * 0.5 + 1e-3)
                    .report(Some("mid")),
            );
        }
    }
    let span = mesh.bounds_max[2] - mesh.bounds_min[2];
    if span > 0.0 {
        reports.push(
            section::Section::from_mesh(mesh, 2, mesh.bounds_min[2] + span * 0.1 + 1e-3)
                .report(Some("near bottom")),
        );
        reports.push(
            section::Section::from_mesh(mesh, 2, mesh.bounds_min[2] + span * 0.9 + 1e-3)
                .report(Some("near top")),
        );
    }
    reports
}

fn source_path(
    handle: &ProjectHandle,
    title: &str,
    artifact_id: &str,
    parent: Option<&Value>,
) -> CoreResult<String> {
    if let Some(parent) = parent {
        if let Some(path) = scad_ref(parent).and_then(|f| f["path"].as_str()) {
            return Ok(path.to_owned());
        }
    }
    let candidate = format!("artifacts/mechanical/{}.scad", slug(title));
    let existing: Option<String> = handle
        .db
        .query_row(
            "SELECT id FROM artifact WHERE type='mechanical' AND title=?1 AND id!=?2",
            params![title, artifact_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    Ok(if existing.is_some() {
        format!(
            "artifacts/mechanical/{}-{}.scad",
            slug(title),
            &artifact_id[..8]
        )
    } else {
        candidate
    })
}

#[allow(clippy::too_many_arguments)]
fn commit_cad(
    handle: &mut ProjectHandle,
    artifact_id: &str,
    artifact: Option<&Value>,
    parent: Option<&Value>,
    title: &str,
    source_path: &str,
    source_hash: &str,
    render: &Render,
    params_value: &Value,
    manifest: &Value,
    inputs: &Value,
    rationale: &str,
    subsystem: Option<&str>,
    origin: &Origin,
    queued_job_id: Option<&str>,
) -> CoreResult<(Value, Value)> {
    let source_ref = json!({"path":source_path,"sha256":source_hash,"role":"source"});
    let mut files = vec![source_ref.clone()];
    let mut body =
        json!({"scad":source_ref,"params":params_value,"paramManifest":manifest,"modelUnit":"mm"});
    if let Some(existing) = parent {
        for key in ["material", "manufacturing"] {
            if let Some(v) = existing["payload"].get(key) {
                body[key] = v.clone();
            }
        }
    }
    if let Some(identity) = &render.identity {
        let stl_hash = identity["outputHash"].as_str().unwrap();
        let stl_path = source_path
            .strip_suffix(".scad")
            .map(|p| format!("{p}.stl"))
            .unwrap_or(format!("{source_path}.stl"));
        let stl_ref = json!({"path":stl_path,"sha256":stl_hash,"role":"output"});
        files.push(stl_ref.clone());
        body["stl"] = stl_ref;
        body["renderJobId"] = json!(render.job_id);
        body["renderIdentity"] = identity.clone();
        if let Some(mesh) = &render.mesh {
            body["bounds"] = json!({"min":mesh.bounds_min,"max":mesh.bounds_max});
        }
    }
    let body = parse_artifact_payload("mechanical", body)?;
    let normalized = normalize_inputs(handle, artifact_id, inputs)?;
    graph::validate_revision_inputs(handle, artifact_id, &normalized)?;
    let digest = models::content_hash(
        &body,
        &files
            .iter()
            .filter_map(|f| f["sha256"].as_str().map(str::to_owned))
            .collect::<Vec<_>>(),
    );
    let revision_id = uuid::Uuid::new_v4().to_string();
    let seq: i64 = handle
        .db
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM revision WHERE artifact_id=?1",
            [&artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let timestamp = now();
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    if let Some(job_id) = queued_job_id {
        let updated = tx
            .execute(
                "UPDATE job SET status='succeeded',finished_at=?1 WHERE id=?2 AND status='running'",
                params![timestamp, job_id],
            )
            .map_err(internal)?;
        if updated != 1 {
            return Err(ContractError::new(
                "CANCELLED",
                "Render was cancelled before commit",
            ));
        }
    }
    if artifact.is_none() {
        tx.execute("INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) VALUES(?1,'mechanical',?2,?3,NULL,0,?4)",params![artifact_id,title,subsystem,timestamp]).map_err(internal)?;
    }
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft')",
        params![revision_id,artifact_id,parent.and_then(|p|p["id"].as_str()),seq,origin.kind(),origin.session_id(),timestamp,body.to_string(),digest,json!(files).to_string(),json!(normalized).to_string(),rationale]).map_err(internal)?;
    tx.execute(
        "DELETE FROM artifact_fts WHERE artifact_id=?1",
        [&artifact_id],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?1,?2,?3,?4)",
        params![artifact_id, revision_id, title, body.to_string()],
    )
    .map_err(internal)?;
    tx_event(
        &tx,
        "revision.committed",
        origin.kind(),
        json!({"artifactId":artifact_id,"revisionId":revision_id,"reviewState":"draft"}),
    )?;
    tx.commit().map_err(internal)?;
    materialize_files(handle, &files, parent)?;
    Ok((
        require_artifact(handle, artifact_id)?,
        require_revision(handle, &revision_id)?,
    ))
}

pub(super) fn write_source(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let source = source_with_facets(required_str(input, "source")?);
    safe_scad(&source)?;
    let declared = parameters(&source);
    let mut overrides = override_params(&input["params"], &declared)?;
    let artifact = input["artifactId"]
        .as_str()
        .map(|id| require_mechanical(handle, id))
        .transpose()?;
    let parent = artifact
        .as_ref()
        .map(|a| pick_revision(handle, a, None))
        .transpose()?;
    if let (Some(expected), Some(parent)) = (input["expectedRevisionId"].as_str(), parent.as_ref())
    {
        if parent["id"] != expected {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "CAD input revision changed; read the current source before retrying.",
            ));
        }
    }
    let title = input["title"]
        .as_str()
        .or_else(|| artifact.as_ref().and_then(|a| a["title"].as_str()))
        .ok_or_else(|| ContractError::validation("title is required when creating a new part"))?;
    if let Some(parent) = &parent {
        let old_params = &parent["payload"]["params"];
        let old_source = source_of(handle, parent)
            .ok()
            .map(|(_, s)| s)
            .unwrap_or_default();
        let old_declared = parameters(&old_source);
        for (name, value) in old_params.as_object().into_iter().flat_map(|m| m.iter()) {
            if overrides.get(name).is_some() {
                continue;
            }
            let before = old_declared.iter().find(|p| p.name == *name);
            let after = declared.iter().find(|p| p.name == *name);
            if before.is_some() && after.is_some() && before.unwrap().expr == after.unwrap().expr {
                overrides[name] = value.clone();
            }
        }
    }
    let artifact_id = artifact
        .as_ref()
        .and_then(|a| a["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let path = source_path(handle, title, &artifact_id, parent.as_ref())?;
    let working_hash = resolve_materialization_path(&handle.root, &path).map_err(storage_error)?;
    let working_hash = fs::read(&working_hash)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    let source_hash = handle
        .object_store()
        .map_err(storage_error)?
        .put(source.as_bytes())
        .map_err(storage_error)?;
    let render = render_source(
        handle,
        &source,
        &overrides,
        input["timeoutMs"].as_u64().unwrap_or(90_000),
        origin,
        &artifact_id,
        parent.as_ref().and_then(|p| p["id"].as_str()),
        None,
    )?;
    let after = resolve_materialization_path(&handle.root, &path).map_err(storage_error)?;
    let after_hash = fs::read(&after)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    if working_hash != after_hash {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Source changed during render; reread before retrying",
        ));
    }
    let manifest=declared.iter().map(|p|json!({"name":p.name,"dimension":if p.value.is_boolean(){"boolean"}else if p.value.is_string(){"text"}else if p.name=="$fn"{"count"}else{"number"}})).collect::<Vec<_>>();
    let rationale = input["rationale"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(if parent.is_some() {
            "source revised"
        } else {
            "initial source"
        });
    let parent_inputs = input
        .get("inputs")
        .cloned()
        .or_else(|| parent.as_ref().map(|p| p["inputs"].clone()))
        .unwrap_or(json!([]));
    let (_, revision) = commit_cad(
        handle,
        &artifact_id,
        artifact.as_ref(),
        parent.as_ref(),
        title,
        &path,
        &source_hash,
        &render,
        &overrides,
        &json!(manifest),
        &parent_inputs,
        rationale,
        input["subsystem"].as_str(),
        origin,
        None,
    )?;
    let mut notes = Vec::new();
    if !render.ok {
        notes.push("Render failed — fix the source and call cad.write_source again.".to_owned());
    }
    if render.mesh.as_ref().is_some_and(|m| m.inverted) {
        notes.push(
            "NOT VERIFIED: source winding is inverted; repair the source before checking."
                .to_owned(),
        );
    }
    if declared.is_empty() {
        notes.push("No top-level parameters found. Exposing key dimensions as name = value; at file scope makes the part re-sizable via params.".to_owned());
    }
    let mut report = json!({"artifactId":artifact_id,"revisionId":revision["id"],"title":title,"sourcePath":path,
        "render":{"ok":render.ok,"tool":render.tool,"ms":render.ms,"warnings":render.warnings,"errors":render.errors},
        "parameters":declared.iter().map(param_json).collect::<Vec<_>>(),"notes":notes,
        "next":"Compare these measurements with the request. Then call cad.check with explicit expectations (envelope, hole positions and diameters in cross-sections, solid/empty points) and fix any failure. Report done only when all checks pass."});
    if let Some(mesh) = &render.mesh {
        report["geometry"] = mesh.summary();
        report["sections"] = json!(auto_sections(mesh));
        report["probes"] = json!([]);
    }
    Ok(report)
}

fn load_render(
    handle: &ProjectHandle,
    artifact: &Value,
    revision: &Value,
    source: &str,
    overrides: &Value,
    origin: &Origin,
) -> CoreResult<Render> {
    if overrides.as_object().is_none_or(|m| m.is_empty()) && render_matches(revision) {
        if let Some(hash) = revision["payload"]["stl"]["sha256"].as_str() {
            if let Ok(bytes) = handle.object_store().map_err(storage_error)?.read(hash) {
                let mesh = mesh::Mesh::read(&bytes)?;
                return Ok(Render {
                    ok: true,
                    ms: 0,
                    tool: "stored render".into(),
                    log: String::new(),
                    warnings: vec![],
                    errors: vec![],
                    stl: Some(bytes),
                    mesh: Some(mesh),
                    identity: Some(revision["payload"]["renderIdentity"].clone()),
                    job_id: String::new(),
                });
            }
        }
    }
    let mut params = revision["payload"]["params"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    params.extend(
        overrides
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    render_source(
        handle,
        source,
        &Value::Object(params),
        90_000,
        origin,
        required_str(artifact, "id")?,
        revision["id"].as_str(),
        None,
    )
}

pub(super) fn inspect(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (source_path, source) = source_of(handle, &revision)?;
    let declared = parameters(&source);
    let overrides = override_params(&input["params"], &declared)?;
    let render = load_render(handle, &artifact, &revision, &source, &overrides, origin)?;
    if !render.ok {
        return Err(ContractError::validation(format!(
            "Cannot inspect: {}",
            render
                .errors
                .first()
                .map(String::as_str)
                .unwrap_or("render failed")
        )));
    }
    let mesh = render
        .mesh
        .as_ref()
        .ok_or_else(|| ContractError::validation("Cannot inspect: no mesh"))?;
    let probes_requested = input["probes"].as_array().map(Vec::len).unwrap_or(0);
    let sections_requested = input["sections"].as_array().map(Vec::len).unwrap_or(0);
    if probes_requested + sections_requested > 512
        || mesh.triangles.len() * (probes_requested + (sections_requested + 5) * 2) > 10_000_000
    {
        return Err(ContractError::validation(
            "CAD inspection exceeds the supported V0.1 work limit",
        ));
    }
    let mut probes = Vec::new();
    for point in input["probes"].as_array().into_iter().flatten() {
        let xyz = [
            point[0].as_f64().unwrap_or(0.0),
            point[1].as_f64().unwrap_or(0.0),
            point[2].as_f64().unwrap_or(0.0),
        ];
        probes.push(json!({"point":point,"result":if mesh.contains(xyz){"solid"}else{"empty"}}));
    }
    let sizes = &mesh.summary()["bounds"]["size"].clone();
    let mut sections = auto_sections(mesh);
    for request in input["sections"].as_array().into_iter().flatten() {
        if let (Some(axis), Some(at)) = (request["axis"].as_str(), request["at"].as_f64()) {
            let index = match axis {
                "x" => 0,
                "y" => 1,
                "z" => 2,
                _ => return Err(ContractError::validation("Unknown section axis")),
            };
            sections.push(section::Section::from_mesh(mesh, index, at).report(None));
        } else if let (Some(origin), Some(normal)) =
            (request["origin"].as_array(), request["normal"].as_array())
        {
            let point = |values: &[Value]| -> CoreResult<[f64; 3]> {
                if values.len() != 3 {
                    return Err(ContractError::validation(
                        "Section plane needs three coordinates",
                    ));
                }
                Ok([0, 1, 2].map(|i| values[i].as_f64().unwrap_or(f64::NAN)))
            };
            let origin = point(origin)?;
            let normal = point(normal)?;
            sections.push(
                section::Section::from_plane(mesh, origin, normal)?.report_plane(origin, normal),
            );
        } else {
            return Err(ContractError::validation(
                "Section needs axis and at, or origin and normal",
            ));
        }
    }
    let formatted = |v: &Value| format!("{} mm", v.as_f64().unwrap_or(0.0));
    Ok(
        json!({"artifactId":artifact["id"],"revisionId":revision["id"],"title":artifact["title"],
        "sourcePath":source_path,"render":{"ok":true,"tool":render.tool,"ms":render.ms,"warnings":render.warnings,"errors":render.errors},
        "geometry":mesh.summary(),"sections":sections,"probes":probes,"parameters":declared.iter().map(param_json).collect::<Vec<_>>(),"notes":[],
        "next":"Inspect is diagnostic only and does not bind request assertions. Use the sections/probes to confirm each requested feature; then cad.check (exploratory false) with explicit expectations from the request.",
        "inspect":{"plausible":true,"triangles":mesh.triangles.len()},"modelUnit":"mm",
        "dimensions":{"x":formatted(&sizes[0]),"y":formatted(&sizes[1]),"z":formatted(&sizes[2])}}),
    )
}

pub(super) use verification::{check, latest_verification, validate_scope_accept};

pub(super) fn patch_source(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, None)?;
    let (_, source) = source_of(handle, &revision)?;
    let old = required_str(input, "oldString")?;
    let hits = source.matches(old).count();
    if hits != 1 {
        return Err(ContractError::validation(if hits == 0 {
            "oldString was not found in the current source — read the source and copy the snippet exactly.".into()
        } else {
            format!("oldString occurs {hits} times; it must be unique so the patch cannot hit the wrong site.")
        }));
    }
    let mut args = json!({"artifactId":artifact["id"],"expectedRevisionId":input["expectedRevisionId"].as_str().unwrap_or(revision["id"].as_str().unwrap()),
        "source":source.replacen(old,required_str(input,"newString")?,1),"rationale":input["rationale"],"timeoutMs":input["timeoutMs"]});
    if args["rationale"].as_str().is_none_or(str::is_empty) {
        args["rationale"] = json!("source patched");
    }
    write_source(handle, &args, origin)
}

fn set_param_source(source: &str, name: &str, value: &Value) -> CoreResult<String> {
    let param = parameters(source)
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| ContractError::validation(format!("No file-scope parameter \"{name}\".")))?;
    let mut lines = source.split('\n').map(str::to_owned).collect::<Vec<_>>();
    let pattern =
        Regex::new(&format!(r"({}\s*=\s*)([^;]+)", regex::escape(name))).map_err(internal)?;
    let replacement = value.to_string();
    let line = &mut lines[param.line];
    if !pattern.is_match(line) {
        return Err(ContractError::validation(format!(
            "No file-scope parameter \"{name}\"."
        )));
    }
    *line = pattern
        .replace(line.as_str(), |captures: &regex::Captures<'_>| {
            format!("{}{replacement}", &captures[1])
        })
        .to_string();
    Ok(lines.join("\n"))
}

pub(super) fn set_param(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, None)?;
    let (_, source) = source_of(handle, &revision)?;
    let name = required_str(input, "name")?;
    let updated = set_param_source(&source, name, &input["value"])?;
    let mut params = revision["payload"]["params"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    params.insert(name.to_owned(), input["value"].clone());
    let mut args = json!({"artifactId":artifact["id"],"expectedRevisionId":input["expectedRevisionId"].as_str().unwrap_or(revision["id"].as_str().unwrap()),
        "source":updated,"params":params,"rationale":input["rationale"],"timeoutMs":input["timeoutMs"]});
    if args["rationale"].as_str().is_none_or(str::is_empty) {
        args["rationale"] = json!(format!("set {name}"));
    }
    write_source(handle, &args, origin)
}

pub(super) fn compose(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let mut blocks = vec![
        "// composed assembly — module-wrapped instances, transform only (no mates / STEP)"
            .to_owned(),
    ];
    let mut inputs = Vec::<Value>::new();
    for (index, instance) in input["instances"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let artifact = require_mechanical(handle, required_str(instance, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, instance["revisionId"].as_str())?;
        let (_, mut source) = source_of(handle, &revision)?;
        for (key, value) in revision["payload"]["params"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
        {
            source = set_param_source(&source, key, value)?;
        }
        let translation = instance["translate"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!(0), json!(0), json!(0)]);
        let rotation = instance["rotate"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!(0), json!(0), json!(0)]);
        let format_vec = |values: &[Value]| {
            values
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        };
        let transform = if rotation
            .iter()
            .all(|v| v.as_f64() == Some(0.0) || v.as_i64() == Some(0))
        {
            format!("translate([{}]) _inst_{index}();", format_vec(&translation))
        } else {
            format!(
                "translate([{}]) rotate([{}]) _inst_{index}();",
                format_vec(&translation),
                format_vec(&rotation)
            )
        };
        blocks.push(format!(
            "module _inst_{index}() {{\n{}\n}}\n{transform}",
            source.trim_end()
        ));
        if !inputs.iter().any(|item| {
            item["artifactId"] == artifact["id"] && item["revisionId"] == revision["id"]
        }) {
            inputs.push(json!({"artifactId":artifact["id"],"revisionId":revision["id"],"relationship":"depends_on","label":"composition snapshot"}));
        }
    }
    let source = format!("{}\n", blocks.join("\n\n"));
    let mut args = json!({"title":input["title"],"source":source,"inputs":inputs,"rationale":input["rationale"],"timeoutMs":input["timeoutMs"]});
    if args["rationale"].as_str().is_none_or(str::is_empty) {
        args["rationale"] = json!("composed from existing parts");
    }
    write_source(handle, &args, origin)
}

fn render_inputs(
    handle: &ProjectHandle,
    input: &Value,
) -> CoreResult<(Value, Value, String, Value)> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (_, source) = source_of(handle, &revision)?;
    let mut params = revision["payload"]["params"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    params.extend(
        input["params"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    let params = override_params(&json!(params), &parameters(&source))?;
    Ok((artifact, revision, source, params))
}

pub(super) fn queue_render(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let (artifact, revision, source, params) = render_inputs(handle, input)?;
    safe_scad(&source)?;
    let id = uuid::Uuid::new_v4().to_string();
    let source_hash = required_str(
        scad_ref(&revision).ok_or_else(|| ContractError::validation("CAD source missing"))?,
        "sha256",
    )?;
    handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,'cad_render','openscad',NULL,?2,?3,NULL,'queued','','{}',NULL,?4,?5,NULL,NULL)",
        params![id,json!({"artifactId":artifact["id"],"revisionId":revision["id"],"params":params}).to_string(),json!({"source":source_hash}).to_string(),origin.session_id(),now()]).map_err(internal)?;
    emit(
        handle,
        "job.updated",
        origin,
        json!({"jobId":id,"status":"queued"}),
    )?;
    simple::job_read(handle, &json!({"jobId":id}))
}

pub(super) fn render(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    render_with_job(handle, input, origin, None)
}

pub(super) fn finish_queued_render(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
    job_id: &str,
) -> CoreResult<Value> {
    let result = render_with_job(handle, input, origin, Some(job_id));
    if let Err(error) = &result {
        handle.db.execute("UPDATE job SET status='failed',error=?1,finished_at=?2 WHERE id=?3 AND status IN ('queued','running','succeeded')",
            params![json!({"code":error.code,"message":error.message}).to_string(),now(),job_id]).map_err(internal)?;
    }
    let status = handle
        .db
        .query_row("SELECT status FROM job WHERE id=?1", [job_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(internal)?;
    emit(
        handle,
        "job.updated",
        origin,
        json!({"jobId":job_id,"status":status}),
    )?;
    result
}

fn render_with_job(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
    existing_job_id: Option<&str>,
) -> CoreResult<Value> {
    let (artifact, revision, source, params) = render_inputs(handle, input)?;
    let (path, _) = source_of(handle, &revision)?;
    let materialized = resolve_materialization_path(&handle.root, &path).map_err(storage_error)?;
    let before = fs::read(&materialized)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    let result = render_source(
        handle,
        &source,
        &params,
        input["timeoutMs"].as_u64().unwrap_or(120_000),
        origin,
        required_str(&artifact, "id")?,
        revision["id"].as_str(),
        existing_job_id,
    )?;
    if result.ok {
        if existing_job_id.is_some_and(|id| job_cancelled(handle, id)) {
            return Err(ContractError::new("CANCELLED", "Render was cancelled"));
        }
        let latest = handle
            .db
            .query_row(
                "SELECT id FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                [required_str(&artifact, "id")?],
                |row| row.get::<_, String>(0),
            )
            .map_err(internal)?;
        if latest != required_str(&revision, "id")?
            || fs::read(&materialized)
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                != before
        {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "CAD source changed during render; reread before retrying",
            ));
        }
        let hash = required_str(scad_ref(&revision).unwrap(), "sha256")?;
        let _ = commit_cad(
            handle,
            required_str(&artifact, "id")?,
            Some(&artifact),
            Some(&revision),
            required_str(&artifact, "title")?,
            &path,
            hash,
            &result,
            &params,
            &revision["payload"]["paramManifest"],
            &revision["inputs"],
            "rendered source",
            artifact["subsystem"].as_str(),
            origin,
            existing_job_id,
        )?;
    }
    let job = handle
        .db
        .query_row(
            "SELECT * FROM job WHERE id=?1",
            [&result.job_id],
            models::job_from_row,
        )
        .map_err(internal)?;
    Ok(json!({"job":job}))
}

pub(super) fn validate_source(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (_, source) = source_of(handle, &revision)?;
    safe_scad(&source)?;
    let exe =
        executable().ok_or_else(|| ContractError::new("TOOL_MISSING", "OpenSCAD not found"))?;
    let temp = tempfile::tempdir().map_err(internal)?;
    let scad = temp.path().join("source.scad");
    let csg = temp.path().join("output.csg");
    fs::write(&scad, source).map_err(internal)?;
    let (ok, log, _) = run_tool(
        &exe,
        &[
            "-o".into(),
            csg.to_string_lossy().into(),
            scad.to_string_lossy().into(),
        ],
        30_000,
        temp.path(),
    )?;
    let errors = log
        .lines()
        .filter(|line| line.contains("ERROR:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(
        json!({"ok":ok&&errors.is_empty(),"errors":if errors.is_empty()&&!ok {log.lines().map(str::to_owned).collect::<Vec<_>>()} else {errors}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn cancelled_openscad_process_group_cannot_leave_a_child_running() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("child-survived");
        let script = format!("(sleep 1; touch '{}') & wait", marker.display());
        let start = Instant::now();
        let result = run_tool_interruptible(
            Path::new("/bin/sh"),
            &["-c".into(), script],
            5_000,
            temp.path(),
            || start.elapsed() > Duration::from_millis(100),
        )
        .unwrap();
        assert!(result.3, "expected cancellation");
        std::thread::sleep(Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "OpenSCAD subprocess survived cancellation"
        );
    }

    #[test]
    fn openscad_render_keeps_source_and_mesh_in_schema_one_project() {
        if executable().is_none() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let mut handle = ProjectHandle::create(temp.path().join("cad"), "CAD", "test").unwrap();
        let report=write_source(&mut handle,&json!({"title":"Plate","source":"width = 20;\ncube([width, 10, 2]);\n","timeoutMs":30000}),&Origin::User).unwrap();
        assert_eq!(report["render"]["ok"], true);
        assert_eq!(
            report["geometry"]["bounds"]["size"],
            json!([20.0, 10.0, 2.0])
        );
        assert!(report["sections"][0]["loops"][0]
            .as_str()
            .unwrap()
            .contains("material rectangle"));
        let source = read_source(&handle, &json!({"artifactId":report["artifactId"]})).unwrap();
        assert_eq!(source["hasRender"], true);
        assert!(source["source"].as_str().unwrap().contains("cube"));
        let revision = require_revision(&handle, report["revisionId"].as_str().unwrap()).unwrap();
        assert_eq!(revision["files"].as_array().unwrap().len(), 2);
        assert!(handle
            .object_store()
            .unwrap()
            .read(revision["payload"]["stl"]["sha256"].as_str().unwrap())
            .is_ok());
        let details = inspect(
            &handle,
            &json!({"artifactId":report["artifactId"],"probes":[[10,5,1],[30,5,1]]}),
            &Origin::User,
        )
        .unwrap();
        assert_eq!(details["probes"][0]["result"], "solid");
        assert_eq!(details["probes"][1]["result"], "empty");
        let plane = inspect(
            &handle,
            &json!({"artifactId":report["artifactId"],"sections":[{"origin":[10,5,1],"normal":[0,0,1]},{"origin":[10,5,1],"normal":[1,0,1]}]}),
            &Origin::User,
        ).unwrap();
        assert!(plane["sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["plane"].as_str().unwrap_or("").starts_with("origin=(10")));
        assert!(plane["sections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["plane"].as_str().unwrap_or("").starts_with("origin=(10"))
            .all(|s| !s["loops"].as_array().unwrap().is_empty()));
        let request = json!({"artifactId":report["artifactId"],"expect":{
            "bbox":{"min":[0,0,0],"max":[20,10,2]},"volume":{"value":400},
            "solid":[[10,5,1]],"empty":[[30,5,1]],
            "maxSelfIntersections":0,
            "sections":[{"axis":"z","at":1,"outerCount":1,"holeCount":0,"outer":{"size":[20,10]}}]
        }});
        let verified = check(&handle, &request, &Origin::User).unwrap();
        assert_eq!(verified["verificationStatus"], "passed", "{verified}");
        assert_eq!(
            latest_verification(&handle, &revision).unwrap()["status"],
            "passed"
        );
        let proposal = proposal_submit(
            &mut handle,
            &json!({"changes":[{"artifactId":report["artifactId"],
            "baseRevisionId":null,"newRevisionId":report["revisionId"],"kind":"new_artifact"}],
            "reason":"reviewed plate"}),
            &Origin::User,
        )
        .unwrap();
        let mut evidence = serde_json::Map::new();
        evidence.insert(
            report["artifactId"].as_str().unwrap().to_owned(),
            verified["evidenceHash"].clone(),
        );
        let accepted = proposal_resolve(
            &mut handle,
            &json!({"proposalId":proposal["id"],
            "rationale":"dimensions reviewed","verificationEvidence":evidence}),
            "accepted",
        )
        .unwrap();
        assert_eq!(accepted["state"], "accepted");
        assert_eq!(
            latest_verification(&handle, &revision).unwrap()["status"],
            "passed"
        );
        assert_eq!(
            build::preview(&handle, false).unwrap()["counts"]["ready"],
            1
        );
        let weakened=check(&handle,&json!({"artifactId":report["artifactId"],"expect":{"bbox":{"min":[0,0,0],"max":[20,10,2]}}}),&Origin::User).unwrap();
        assert_eq!(weakened["verificationStatus"], "scope_changed");
        let without_reference = check(
            &handle,
            &json!({"artifactId":report["artifactId"],
            "expect":{"preserve":{"changeRegions":[]}}}),
            &Origin::User,
        )
        .unwrap();
        assert_eq!(without_reference["verificationStatus"], "failed");
        let queued = queue_render(
            &handle,
            &json!({"artifactId":report["artifactId"],"revisionId":report["revisionId"]}),
            &Origin::User,
        )
        .unwrap();
        let job_id = queued["job"]["id"].as_str().unwrap();
        simple::job_cancel(&handle, &json!({"jobId":job_id}), &Origin::User).unwrap();
        assert_eq!(
            finish_queued_render(
                &mut handle,
                &json!({"artifactId":report["artifactId"],"revisionId":report["revisionId"]}),
                &Origin::User,
                job_id
            )
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        assert_eq!(
            simple::job_read(&handle, &json!({"jobId":job_id})).unwrap()["job"]["status"],
            "cancelled"
        );
        let orphan = queue_render(
            &handle,
            &json!({"artifactId":report["artifactId"],"revisionId":report["revisionId"]}),
            &Origin::User,
        )
        .unwrap();
        let reopened = CoreApp::new(temp.path().join("appdata"))
            .unwrap()
            .dispatch(
                "project.open",
                json!({"path":handle.root}),
                Origin::User,
                None,
            )
            .unwrap();
        assert_eq!(reopened["projectId"], handle.file.id);
        assert_eq!(
            simple::job_read(&handle, &json!({"jobId":orphan["job"]["id"]})).unwrap()["job"]
                ["status"],
            "interrupted"
        );
    }
}
