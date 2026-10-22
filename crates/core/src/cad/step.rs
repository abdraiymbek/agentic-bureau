//! `cad_export`: a part to a file the person asked for.
//!
//! STL and SCAD copy the revision's stored file. STEP is always made from the
//! revision's own checked render, the mesh `cad_check` measures, in one of two
//! ways:
//!
//! - brep: OpenSCAD evaluates the stored source with the recorded parameters
//!   into its CSG tree, and an external Python with OCP (OpenCASCADE) rebuilds
//!   that tree with exact surfaces (`csg_to_step.py`). The file it writes is
//!   read back and compared with the render: validity, closed shells, volume,
//!   bounding box, points through the box, probe pairs just inside and
//!   outside every surface of the render, which find a hole or boss the
//!   rebuild lost, and pairs at the exact solid's own faces, which find
//!   material it has and the render has not. It is used only when every
//!   comparison passes and every surface of the render was compared.
//! - faceted: the render's own triangles as planar faces (`faceted.rs`),
//!   always available and the fallback, with the reason exact was not used.
//!
//! The lock is held to plan and to commit only; the engine, the converter and
//! the writer run between, under one deadline, in a `cad_export` job that can
//! be cancelled. Agents write only under `exports/` and never over a file an
//! earlier export did not write.
use super::*;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

mod csg;
use csg::csg_sagitta;

/// The converter, written to a private temporary folder for each run.
pub(super) const CONVERTER: &str = include_str!("csg_to_step.py");
pub(super) static CONVERTER_VERSION: LazyLock<String> =
    LazyLock::new(|| format!("1+{}", &hash_text(CONVERTER)[..12]));

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_STEP_BYTES: u64 = 256 * 1024 * 1024;
const CANCELLED: &str = "STEP export was cancelled; nothing was written.";

/// Points through the render's bounding box.
const VOLUME_SAMPLES: usize = 512;
/// Probe pairs at the render's faces, spread over its smooth patches, at
/// least four on each while the budget allows and never fewer than two; the
/// converter probes the exact solid's own faces the same way.
const SURFACE_PAIRS: usize = 2048;
const MAX_SURFACE_PAIRS: usize = 8192;
const PAIRS_PER_PATCH: usize = 4;
/// Places tried on a patch for each pair it asks for.
const POSITION_TRIES: usize = 4;
/// Triangles meeting at a smaller angle belong to one smooth patch (a planar
/// face, a cylinder wall of 12 or more facets, a sphere).
const SMOOTH_DEGREES: f64 = 30.0;
/// A probe pair this many times as far from the face as a facet can lie from
/// the exact surface counts whether it agrees or not.
const TRUSTED_BOUNDS: f64 = 1.5;
/// Rounding beside the single-precision corners, mm (`rounding`).
const ROUNDING_MM: f64 = 1e-5;

/// Agreement an exact solid needs with the render. On the 49-part
/// CADGenBench corpus (OCP 7.9.3) the 46 accepted parts differed by at most
/// 0.075 % in volume and 0.016 mm in bounding box, with at most one point
/// through the box, no probe pair at the render's faces and one at a
/// solid's own faces disagreeing. Copies of their trees missing one cutter
/// were refused, except one whose cutter cut nothing.
const MAX_VOLUME_ERROR: f64 = 0.005;
const MIN_BBOX_TOLERANCE_MM: f64 = 0.05;
const BBOX_TOLERANCE: f64 = 0.005;
const MAX_SAMPLE_MISMATCHES: usize = 3;
/// Counted probe pairs that may disagree on either side; at the render's
/// faces, and at the solid's own on a tree of flat faces, only where a face of
/// the render lies within `Sampling::explained` of the point that disagrees.
const MAX_SURFACE_MISMATCHES: usize = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Auto,
    Faceted,
}

/// Where the file goes.
enum Destination {
    /// Inside the project, relative to its root.
    Project(String),
    /// A person's own choice of path, anywhere.
    Absolute(PathBuf),
}

impl Destination {
    /// What a job records: no path of this machine.
    fn recorded(&self) -> String {
        match self {
            Self::Project(relative) => relative.clone(),
            Self::Absolute(path) => file_name(path),
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn extensions(format: &str) -> &'static [&'static str] {
    match format {
        "step" => &["step", "stp"],
        "scad" => &["scad"],
        _ => &["stl"],
    }
}

pub(crate) fn export(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    match input["format"].as_str().unwrap_or("stl") {
        "step" => stage::drive(handle, origin, "cad.export", || {
            Ok(Box::new(plan(handle, input, origin)?))
        }),
        // A copy of a stored file is quick: no job, no stage.
        format => export_file(handle, input, origin, format),
    }
}

/// The revision to export: the one named, else a person's baseline, else an
/// agent's newest revision, as every agent CAD tool defaults.
fn export_revision(
    handle: &ProjectHandle,
    artifact: &Value,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    if let Some(id) = input["revisionId"].as_str() {
        return pick_revision(handle, artifact, Some(id));
    }
    if matches!(origin, Origin::Agent { .. }) {
        return pick_revision(handle, artifact, None);
    }
    let title = artifact["title"].as_str().unwrap_or("The part");
    let baseline = artifact["selectedRevisionId"].as_str().ok_or_else(|| {
        ContractError::new(
            "NOT_FOUND",
            format!("\"{title}\" has no baseline to export."),
        )
        .with_repair("Pass revisionId to export a draft, or approve a revision first.")
    })?;
    require_revision(handle, baseline)
}

fn destination_issue(message: String, repair: String) -> ContractError {
    ContractError::validation(message.clone())
        .with_repair(repair)
        .with_details(json!({"issues": [{"path": "destPath", "message": message}]}))
}

/// Where `dest` writes, by who asks: a person anywhere, an agent only under
/// `exports/` (checked on the resolved path) with the format's extension.
fn destination(
    handle: &ProjectHandle,
    dest: &str,
    origin: &Origin,
    format: &str,
    example: &str,
) -> CoreResult<Destination> {
    let Some(relative) = components::export_target(handle, dest, origin, example)? else {
        return Ok(Destination::Absolute(PathBuf::from(dest)));
    };
    let resolved = resolve_materialization_path(&handle.root, &relative).map_err(storage_error)?;
    if !matches!(origin, Origin::Agent { .. }) {
        return Ok(Destination::Project(relative));
    }
    let actual = project_relative(handle, &resolved);
    let under_exports = |path: &str| {
        Path::new(path)
            .components()
            .next()
            .is_some_and(|first| first.as_os_str().eq_ignore_ascii_case("exports"))
    };
    let extension = Path::new(&relative)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase());
    let allowed = extensions(format);
    if !under_exports(&relative)
        || !actual.as_deref().is_some_and(under_exports)
        || !extension.is_some_and(|ext| allowed.contains(&ext.as_str()))
    {
        let names = allowed
            .iter()
            .map(|ext| format!(".{ext}"))
            .collect::<Vec<_>>()
            .join(" or ");
        return Err(destination_issue(
            format!("An agent writes exports only under exports/, as a {names} file"),
            format!("Give destPath under exports/, for example {example}."),
        ));
    }
    Ok(Destination::Project(relative))
}

/// A path inside the project as the project names it, after links.
fn project_relative(handle: &ProjectHandle, path: &Path) -> Option<String> {
    let root = omenflow_storage::canonicalize(&handle.root).ok()?;
    let actual = omenflow_storage::canonicalize(path).ok()?;
    let relative = actual.strip_prefix(&root).ok()?;
    Some(
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// An agent never overwrites a file that no earlier export wrote: it may be
/// the person's own work, which nothing versions.
fn assert_agent_may_write(
    handle: &ProjectHandle,
    origin: &Origin,
    path: &Path,
    example: &str,
) -> CoreResult<()> {
    if !matches!(origin, Origin::Agent { .. }) || fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let recorded = project_relative(handle, path).is_some_and(|relative| {
        handle
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM event WHERE type='cad.exported' AND json_extract(data,'$.projectPath')=?1)",
                [&relative],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false)
    });
    if recorded {
        return Ok(());
    }
    Err(destination_issue(
        format!(
            "{} already exists and no earlier export wrote it, so an agent does not overwrite it",
            project_relative(handle, path).unwrap_or_else(|| file_name(path))
        ),
        format!("Give destPath a new name under exports/, e.g. {example}."),
    ))
}

/// Write `bytes` where `destination` says, atomically. Returns the absolute path.
fn write_destination(
    handle: &ProjectHandle,
    destination: &Destination,
    bytes: &[u8],
) -> CoreResult<PathBuf> {
    let failed = |path: &Path, error: &dyn std::fmt::Display| {
        ContractError::validation(format!("Could not write {}: {error}", path.display()))
            .with_repair("Choose a folder you can write to, then export again.")
    };
    match destination {
        Destination::Project(relative) => {
            let path =
                resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
            write_materialized_file(&handle.root, relative, bytes)
                .map_err(|error| failed(&path, &error))?;
            Ok(path)
        }
        Destination::Absolute(dest) => {
            let parent = dest
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .ok_or_else(|| ContractError::validation("Destination has no parent folder"))?;
            fs::create_dir_all(parent).map_err(|error| failed(dest, &error))?;
            let temp = dest.with_extension(format!("omenflow-{}.tmp", uuid::Uuid::new_v4()));
            let written = fs::write(&temp, bytes).and_then(|()| fs::rename(&temp, dest));
            if let Err(error) = written {
                let _ = fs::remove_file(&temp);
                return Err(failed(dest, &error));
            }
            Ok(dest.clone())
        }
    }
}

fn recorded_example(slug: &str, seq: i64, format: &str) -> String {
    let slug = if slug.is_empty() { "part" } else { slug };
    format!("exports/{slug}-r{seq}.{}", extensions(format)[0])
}

/// What a revision's review state means for a file made from it.
fn review_notes(
    revision: &Value,
    artifact: &Value,
    verification: Option<&str>,
    notes: &mut Vec<String>,
) {
    let seq = revision["seq"].as_i64().unwrap_or(0);
    let baseline = artifact["selectedRevisionId"] == revision["id"];
    match revision["reviewState"].as_str().unwrap_or("draft") {
        "rejected" => notes.push(format!("r{seq} was rejected in review.")),
        "superseded" => notes.push(format!(
            "r{seq} has been superseded; it is not the baseline."
        )),
        "proposed" if !baseline => {
            notes.push(format!("r{seq} is proposed for review: not approved yet."))
        }
        "draft" if !baseline => notes.push(format!("r{seq} is a draft: not reviewed or approved.")),
        _ => {}
    }
    if let Some(status) = verification.filter(|status| *status != "passed") {
        notes.push(format!("r{seq} has no passing cad_check ({status})."));
    }
}

/* ------------------------------------------------------------------ */
/* STL and SCAD                                                         */
/* ------------------------------------------------------------------ */

/// Copy a revision's stored `.stl` or `.scad`. Any artifact type, as before.
fn export_file(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
    format: &str,
) -> CoreResult<Value> {
    let artifact = require_artifact(handle, required_str(input, "artifactId")?)?;
    let revision = export_revision(handle, &artifact, input, origin)?;
    let seq = revision["seq"].as_i64().unwrap_or(0);
    let title = artifact["title"].as_str().unwrap_or("");
    let file = revision["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|file| {
            file["path"]
                .as_str()
                .is_some_and(|path| path.to_ascii_lowercase().ends_with(&format!(".{format}")))
        })
        .ok_or_else(|| {
            ContractError::new(
                "NOT_FOUND",
                format!("r{seq} of \"{title}\" has no .{format} file"),
            )
            .with_repair("Pass revisionId of a revision that has one, or export format \"step\".")
        })?;
    let bytes = handle
        .object_store()
        .map_err(storage_error)?
        .read(required_str(file, "sha256")?)
        .map_err(storage_error)?;
    let example = recorded_example(&slug(title), seq, format);
    let destination = destination(
        handle,
        required_str(input, "destPath")?,
        origin,
        format,
        &example,
    )?;
    let target = match &destination {
        Destination::Project(relative) => {
            resolve_materialization_path(&handle.root, relative).map_err(storage_error)?
        }
        Destination::Absolute(path) => path.clone(),
    };
    assert_agent_may_write(handle, origin, &target, &example)?;
    let path = write_destination(handle, &destination, &bytes)?;
    let mut event = json!({"artifactId": artifact["id"], "revisionId": revision["id"],
        "format": format, "destPath": path, "bytes": bytes.len()});
    if let Some(relative) = project_relative(handle, &path) {
        event["projectPath"] = json!(relative);
    }
    emit(handle, "cad.exported", origin, event)?;
    let rendered = render_matches(&revision);
    let mut notes = Vec::new();
    review_notes(&revision, &artifact, None, &mut notes);
    if format == "stl" && !rendered {
        notes.push(format!(
            "This STL is not the recorded render of r{seq}'s own source and parameters."
        ));
    }
    Ok(
        json!({"path": path, "format": format, "artifactId": artifact["id"],
        "revisionId": revision["id"], "revisionSeq": seq, "reviewState": revision["reviewState"],
        "isBaseline": artifact["selectedRevisionId"] == revision["id"], "bytes": bytes.len(),
        "rendered": rendered, "notes": notes}),
    )
}

/* ------------------------------------------------------------------ */
/* STEP: plan                                                           */
/* ------------------------------------------------------------------ */

struct ExportPlan {
    artifact_id: String,
    revision_id: String,
    seq: i64,
    title: String,
    slug: String,
    created_at: String,
    source: String,
    params: Value,
    identity: Value,
    mesh_hash: String,
    destination: Destination,
    example: String,
    method: Method,
    timeout_ms: u64,
    executable: Option<PathBuf>,
    python: Option<PathBuf>,
    job_id: String,
}

pub(super) struct ExportPipeline {
    plan: ExportPlan,
    outcome: Option<CoreResult<Exported>>,
}

/// A STEP file made in compute, waiting to be written at commit.
struct Exported {
    bytes: Vec<u8>,
    method: &'static str,
    exact: bool,
    faces: usize,
    solids: usize,
    checks: Value,
    converter: Value,
    engine: Option<String>,
    approximations: Vec<String>,
    reason: Option<String>,
    notes: Vec<String>,
    log: Vec<String>,
    commands: Vec<String>,
    tool_version: String,
}

fn plan(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<ExportPipeline> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = export_revision(handle, &artifact, input, origin)?;
    let title = required_str(&artifact, "title")?.to_owned();
    let seq = revision["seq"].as_i64().unwrap_or(0);
    let slug = slug(&title);
    let example = recorded_example(&slug, seq, "step");
    let destination = destination(
        handle,
        required_str(input, "destPath")?,
        origin,
        "step",
        &example,
    )?;
    if !render_matches(&revision) {
        return Err(ContractError::validation(format!(
            "r{seq} of \"{title}\" has no render of its own source and parameters, so there is nothing checked to export."
        ))
        .with_repair(if matches!(origin, Origin::Agent { .. }) {
            "Render it with cad_write_source, check it with cad_check, then export again.".to_owned()
        } else {
            format!("Render it with Render r{seq} in the part view, then export again.")
        })
        .with_details(json!({"reason": "NO_RENDER", "revisionId": revision["id"]})));
    }
    if let Destination::Project(relative) = &destination {
        let target = resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
        assert_agent_may_write(handle, origin, &target, &example)?;
    }
    let (_, source) = source_of(handle, &revision)?;
    params::assert_self_contained(&source)?;
    let identity = revision["payload"]["renderIdentity"].clone();
    let params = Value::Object(params::effective_params(&identity["params"])?);
    let mesh_hash = required_str(&revision["payload"]["stl"], "sha256")?.to_owned();
    let method = if input["method"] == "faceted" {
        Method::Faceted
    } else {
        Method::Auto
    };
    let job_id = jobs::start(
        handle,
        "cad_export",
        "omenflow-step",
        &json!({"artifactId": artifact["id"], "revisionId": revision["id"], "format": "step",
            "method": if method == Method::Faceted { "faceted" } else { "auto" },
            "destPath": destination.recorded()}),
        &json!({"stl": mesh_hash, "source": identity["sourceHash"]}),
        origin,
    )?;
    Ok(ExportPipeline {
        plan: ExportPlan {
            artifact_id: required_str(&artifact, "id")?.to_owned(),
            revision_id: required_str(&revision, "id")?.to_owned(),
            seq,
            created_at: revision["createdAt"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(19)
                .collect(),
            title,
            slug,
            source,
            params,
            identity,
            mesh_hash,
            destination,
            example,
            method,
            timeout_ms: input["timeoutMs"]
                .as_u64()
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(1, MAX_TIMEOUT_MS),
            executable: configured_executable(),
            python: configured_python(),
            job_id,
        },
        outcome: None,
    })
}

/* ------------------------------------------------------------------ */
/* STEP: what the render says                                           */
/* ------------------------------------------------------------------ */

fn halton(mut index: usize, base: usize) -> f64 {
    let (mut fraction, mut result) = (1.0, 0.0);
    while index > 0 {
        fraction /= base as f64;
        result += fraction * (index % base) as f64;
        index /= base;
    }
    result
}

/// The points sent for classification and the render's own answer for each:
/// first `volume` points through the bounding box, then probe pairs at the
/// render's faces, the inner point of each pair inside the render and the
/// outer one outside.
pub(super) struct Sampling {
    pub points: Vec<mesh::Point>,
    pub render: Vec<bool>,
    pub volume: usize,
    /// The smooth patch of the render each probe pair sits on.
    pub patches: Vec<usize>,
    /// How far each pair's points are from the face, mm.
    pub pair_offsets: Vec<f64>,
    /// The probe offsets tried, mm, largest first; the converter probes the
    /// exact solid's own faces with the same.
    pub offsets: Vec<f64>,
    /// Pairs nearer the faces than this, mm, lie within reach of the facets'
    /// deviation from the exact surfaces: they count when the two agree, and
    /// are set aside when not. Zero for a tree of flat faces, whose facets are
    /// its exact faces.
    pub trusted: f64,
    /// How far the render's faces can lie from the surfaces OpenSCAD rendered
    /// by rounding alone, mm (`rounding`).
    pub rounding: f64,
    /// How many smooth patches of the render are compared, and those with
    /// fewer than two probe pairs: nothing there is compared.
    pub patch_count: usize,
    pub unprobed: Vec<usize>,
    /// Slivers a boolean left, narrower across than the smallest offset.
    pub slivers: usize,
}

impl Sampling {
    pub fn pairs(&self) -> usize {
        (self.points.len() - self.volume) / 2
    }

    /// How far a pair's guards lie beyond its points, mm: the facets' reach
    /// with its margin, at least the smallest offset.
    pub fn reach(&self) -> f64 {
        self.trusted.max(*self.offsets.last().unwrap_or(&0.0))
    }

    /// How far from the render's faces an exact solid that is the render can
    /// classify a point differently, mm: the facets' reach with its margin,
    /// plus the rounding. On a tree of flat faces it is the rounding alone,
    /// far below the smallest offset.
    pub fn explained(&self) -> f64 {
        self.trusted + self.rounding
    }

    /// Why the comparison cannot vouch for the whole render, if it cannot: a
    /// feature on a surface no probe reaches could be lost unseen.
    pub fn unprobed_reason(&self) -> Option<String> {
        (!self.unprobed.is_empty()).then(|| {
            format!(
                "{} of the render's {} surfaces could not be probed, even {} mm from their faces, so a feature lost there would go unseen",
                self.unprobed.len(),
                self.patch_count,
                round(*self.offsets.last().unwrap_or(&0.0), 4)
            )
        })
    }
}

/// Halton points (bases 2, 3, 5) in the bounding box grown by 2 % of each
/// extent, so some fall outside the part.
fn volume_samples(mesh: &mesh::Mesh, count: usize) -> Vec<mesh::Point> {
    let size = mesh.size();
    let grow = size.map(|extent| if extent > 0.0 { 0.02 * extent } else { 1.0 });
    (1..=count)
        .map(|index| {
            let unit = [halton(index, 2), halton(index, 3), halton(index, 5)];
            std::array::from_fn(|axis| {
                mesh.bounds_min[axis] - grow[axis] + unit[axis] * (size[axis] + 2.0 * grow[axis])
            })
        })
        .collect()
}

fn root_of(parent: &mut [u32], start: u32) -> u32 {
    let mut at = start;
    while parent[at as usize] != at {
        parent[at as usize] = parent[parent[at as usize] as usize];
        at = parent[at as usize];
    }
    at
}

/// How many bodies the render has: its connected shells that enclose
/// material (a cavity's shell faces inward).
pub(super) fn bodies(mesh: &mesh::Mesh) -> usize {
    use std::collections::HashMap;
    let mut ids = HashMap::<[i64; 3], u32>::new();
    let corners = mesh
        .triangles
        .iter()
        .map(|t| {
            t.map(|p| {
                let next = ids.len() as u32;
                *ids.entry(p.map(|v| (v / 1e-5).round() as i64))
                    .or_insert(next)
            })
        })
        .collect::<Vec<_>>();
    let mut parent = (0..ids.len() as u32).collect::<Vec<_>>();
    for c in &corners {
        for v in &c[1..] {
            let (x, y) = (root_of(&mut parent, c[0]), root_of(&mut parent, *v));
            parent[x as usize] = y;
        }
    }
    let mut volumes = HashMap::<u32, f64>::new();
    for (t, c) in mesh.triangles.iter().zip(&corners) {
        let [a, b, d] = *t;
        let signed = a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0])
            + a[2] * (b[0] * d[1] - b[1] * d[0]);
        *volumes.entry(root_of(&mut parent, c[0])).or_default() += signed / 6.0;
    }
    volumes.values().filter(|volume| **volume > 0.0).count()
}

/// How far the render's faces can lie from the surfaces OpenSCAD rendered by
/// rounding alone, mm, with room to spare: the render's corners are stored in
/// single precision (a step of `f32::EPSILON` of the largest coordinate at
/// most), and OpenSCAD's grid and the converter's classification (a point
/// within 1e-6 mm of the exact surface is on it) are within `ROUNDING_MM`.
fn rounding(mesh: &mesh::Mesh) -> f64 {
    let largest = mesh
        .bounds_min
        .iter()
        .chain(&mesh.bounds_max)
        .fold(0.0, |largest: f64, v| largest.max(v.abs()));
    ROUNDING_MM + f64::from(f32::EPSILON) * largest
}

/// The probe offsets to try, largest first: three times `bound`, how far a
/// facet can lie from the exact surface (`csg_sagitta`), then halves of it
/// down to the smallest worth classifying, 0.001 mm or 1e-5 of the part's
/// size. A pair that crosses a thin wall or gap at one offset is tried at
/// the next; a smaller offset only makes the comparison stricter.
fn probe_offsets(mesh: &mesh::Mesh, bound: f64) -> Vec<f64> {
    let diagonal = mesh.size().iter().map(|v| v * v).sum::<f64>().sqrt();
    let floor = (1e-5 * diagonal).max(1e-3);
    let mut offset = floor.max(3.0 * bound);
    let mut offsets = vec![offset];
    while offset > 2.0 * floor {
        offset /= 2.0;
        offsets.push(offset);
    }
    if offset > floor {
        offsets.push(floor);
    }
    offsets
}

/// A smooth patch of the render: a planar face, a cylinder wall, a sphere.
struct Patch {
    triangles: Vec<u32>,
    /// Running total of the triangles' areas, to pick a triangle by area.
    cumulative: Vec<f64>,
    area: f64,
    /// The length of its edges that no other triangle of it shares.
    perimeter: f64,
}

impl Patch {
    /// A sliver a boolean left between faces, narrower than `width` across
    /// (twice its area over its perimeter): no feature is that thin, and no
    /// probe fits on it.
    fn sliver(&self, width: f64) -> bool {
        2.0 * self.area < width * self.perimeter
    }
}

/// The render's triangles grouped into smooth patches, in order of their
/// first triangle, with each triangle's outward unit normal (none for a
/// degenerate one).
fn smooth_patches(mesh: &mesh::Mesh) -> (Vec<Patch>, Vec<Option<mesh::Point>>) {
    use std::collections::HashMap;
    let triangles = &mesh.triangles;
    let diagonal = mesh.size().iter().map(|v| v * v).sum::<f64>().sqrt();
    let cross = |a: mesh::Point, b: mesh::Point| -> mesh::Point {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let sub =
        |a: mesh::Point, b: mesh::Point| -> mesh::Point { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] };
    let length = |a: mesh::Point| (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    let mut ids = HashMap::<[i64; 3], u32>::new();
    let corners = triangles
        .iter()
        .map(|t| {
            t.map(|p| {
                let next = ids.len() as u32;
                *ids.entry(p.map(|v| (v / 1e-5).round() as i64))
                    .or_insert(next)
            })
        })
        .collect::<Vec<_>>();
    let areas = triangles
        .iter()
        .map(|t| length(cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2.0)
        .collect::<Vec<_>>();
    let degenerate = 1e-14 * diagonal * diagonal;
    let normals = triangles
        .iter()
        .zip(&areas)
        .map(|(t, area)| {
            let n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
            (*area > degenerate).then(|| n.map(|v| v / (2.0 * area)))
        })
        .collect::<Vec<_>>();
    // Triangles meet at a vertex, not only at an edge: a boolean leaves zero-area slivers
    // between facets, which have no normal and must not cut a surface in two.
    let mut incident = HashMap::<u32, Vec<u32>>::new();
    for (index, c) in corners.iter().enumerate() {
        if normals[index].is_some() && c[0] != c[1] && c[1] != c[2] && c[0] != c[2] {
            for v in c {
                incident.entry(*v).or_default().push(index as u32);
            }
        }
    }
    let smooth = SMOOTH_DEGREES.to_radians().cos();
    let mut parent = (0..triangles.len() as u32).collect::<Vec<_>>();
    let mut vertices = incident.keys().copied().collect::<Vec<_>>();
    vertices.sort_unstable();
    for v in vertices {
        let around = &incident[&v];
        for (i, &first) in around.iter().enumerate() {
            for &second in &around[i + 1..] {
                let (Some(n1), Some(n2)) = (normals[first as usize], normals[second as usize])
                else {
                    continue;
                };
                if n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] >= smooth {
                    let (x, y) = (root_of(&mut parent, first), root_of(&mut parent, second));
                    parent[x as usize] = y;
                }
            }
        }
    }
    let mut patch_of = HashMap::<u32, usize>::new();
    let mut patches = Vec::<Patch>::new();
    for index in 0..triangles.len() as u32 {
        if normals[index as usize].is_none() {
            continue;
        }
        let root = root_of(&mut parent, index);
        let slot = *patch_of.entry(root).or_insert_with(|| {
            patches.push(Patch {
                triangles: Vec::new(),
                cumulative: Vec::new(),
                area: 0.0,
                perimeter: 0.0,
            });
            patches.len() - 1
        });
        let patch = &mut patches[slot];
        patch.area += areas[index as usize];
        patch.triangles.push(index);
        patch.cumulative.push(patch.area);
    }
    for patch in &mut patches {
        let mut edges = HashMap::<(u32, u32), f64>::new();
        for &t in &patch.triangles {
            let (c, p) = (corners[t as usize], triangles[t as usize]);
            for (i, j) in [(0, 1), (1, 2), (2, 0)] {
                let key = (c[i].min(c[j]), c[i].max(c[j]));
                let span = length(sub(p[i], p[j]));
                // A shared edge is inside the patch; NaN marks it.
                edges
                    .entry(key)
                    .and_modify(|seen| *seen = f64::NAN)
                    .or_insert(span);
            }
        }
        patch.perimeter = edges.values().filter(|span| !span.is_nan()).sum();
    }
    (patches, normals)
}

/// Probe pairs each patch of `areas` asks for: four, or as many as the
/// budget allows, with the rest of the budget by area. The budget grows to
/// two for every patch, up to `MAX_SURFACE_PAIRS`; beyond that the largest
/// patches get two each and the rest none, and are reported as unprobed.
fn pair_counts(areas: &[f64]) -> Vec<usize> {
    let budget = SURFACE_PAIRS.max(2 * areas.len()).min(MAX_SURFACE_PAIRS);
    let each = PAIRS_PER_PATCH.min(budget / areas.len().max(1));
    if each >= 2 {
        let spare = (budget - each * areas.len()) as f64;
        let total = areas.iter().sum::<f64>();
        return areas
            .iter()
            .map(|area| each + (spare * area / total.max(f64::MIN_POSITIVE)).floor() as usize)
            .collect();
    }
    let mut order = (0..areas.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| areas[*b].total_cmp(&areas[*a]).then(a.cmp(b)));
    let mut counts = vec![0; areas.len()];
    for index in order.into_iter().take(budget / 2) {
        counts[index] = 2;
    }
    counts
}

/// The `sequence`th point on a triangle, kept away from its edges, where
/// another face is near.
fn point_on(triangle: &mesh::Triangle, sequence: usize) -> mesh::Point {
    let [a, b, c] = *triangle;
    let (mut r, mut s) = (halton(sequence, 3), halton(sequence, 5));
    if r + s > 1.0 {
        (r, s) = (1.0 - r, 1.0 - s);
    }
    std::array::from_fn(|axis| {
        let q = a[axis] + r * (b[axis] - a[axis]) + s * (c[axis] - a[axis]);
        let centre = (a[axis] + b[axis] + c[axis]) / 3.0;
        centre + 0.8 * (q - centre)
    })
}

/// The points to classify, with the render's own answers. `bound` is how far
/// a facet can lie from the exact surface (`csg_sagitta`). Every smooth patch
/// gets probe pairs `c − δn` and `c + δn`, the first spread evenly over it by
/// area, so a small hole is probed however large the part. A pair the render
/// itself does not see as inside then outside, also a margin further out
/// (it crossed a wall or a gap thinner than that, or came near the face
/// across it), is tried at smaller offsets, first those beyond the facets'
/// reach at every place on the patch, then nearer ones; a patch left with
/// fewer than two pairs is unprobed.
pub(super) fn sampling(mesh: &mesh::Mesh, bound: f64) -> Sampling {
    let mut points = volume_samples(mesh, VOLUME_SAMPLES);
    let mut render = points.iter().map(|p| mesh.contains(*p)).collect::<Vec<_>>();
    let offsets = probe_offsets(mesh, bound);
    let trusted = TRUSTED_BOUNDS * bound;
    let (far, near) = offsets.split_at(offsets.partition_point(|&offset| offset >= trusted));
    let (surfaces, normals) = smooth_patches(mesh);
    let floor = *offsets.last().expect("there is an offset");
    let margin = trusted.max(floor);
    let compared = (0..surfaces.len())
        .filter(|&index| !surfaces[index].sliver(floor))
        .collect::<Vec<_>>();
    let mut counts = vec![0; surfaces.len()];
    let areas = compared
        .iter()
        .map(|&index| surfaces[index].area)
        .collect::<Vec<_>>();
    for (&index, count) in compared.iter().zip(pair_counts(&areas)) {
        counts[index] = count;
    }
    let mut patches = Vec::new();
    let mut pair_offsets = Vec::new();
    let mut unprobed = Vec::new();
    let mut sequence = 0;
    for &index in &compared {
        let (patch, wanted) = (&surfaces[index], counts[index]);
        // Places on the patch, the first evenly by area, the others between them.
        let places = (0..wanted * POSITION_TRIES)
            .map(|attempt| {
                sequence += 1;
                let fraction = if attempt < wanted {
                    (attempt as f64 + 0.5) / wanted as f64
                } else {
                    halton(attempt - wanted + 1, 2)
                };
                let at = patch
                    .cumulative
                    .partition_point(|&c| c < fraction * patch.area)
                    .min(patch.triangles.len() - 1);
                let t = patch.triangles[at] as usize;
                let n = normals[t].expect("patches hold no degenerate triangle");
                (point_on(&mesh.triangles[t], sequence), n)
            })
            .collect::<Vec<_>>();
        let mut used = vec![false; places.len()];
        let mut found = 0;
        for group in [far, near] {
            for ((point, n), used) in places.iter().zip(used.iter_mut()) {
                if found == wanted {
                    break;
                }
                if *used {
                    continue;
                }
                for &offset in group {
                    let along = |distance: f64| -> mesh::Point {
                        std::array::from_fn(|axis| point[axis] + distance * n[axis])
                    };
                    let (inner, outer) = (along(-offset), along(offset));
                    // Guards a margin further out keep both points clear of any other
                    // face, which the facets might move across them.
                    if mesh.contains(inner)
                        && !mesh.contains(outer)
                        && mesh.contains(along(-offset - margin))
                        && !mesh.contains(along(offset + margin))
                    {
                        points.extend([inner, outer]);
                        render.extend([true, false]);
                        patches.push(index);
                        pair_offsets.push(offset);
                        *used = true;
                        found += 1;
                        break;
                    }
                }
            }
        }
        if found < 2 {
            unprobed.push(index);
        }
    }
    Sampling {
        points,
        render,
        volume: VOLUME_SAMPLES,
        patches,
        pair_offsets,
        offsets,
        trusted,
        rounding: rounding(mesh),
        patch_count: compared.len(),
        slivers: surfaces.len() - compared.len(),
        unprobed,
    }
}

/* ------------------------------------------------------------------ */
/* STEP: the converter's answer                                         */
/* ------------------------------------------------------------------ */

fn number(answer: &Value, key: &str) -> f64 {
    answer[key].as_f64().unwrap_or(f64::NAN)
}

fn round(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

/// A positive distance to two significant figures, rounded down so that
/// "farther than" it stays true: 0.030006 is 0.03, 0.0000219 is 0.000021.
fn significant(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return value;
    }
    let digits = 1 - value.log10().floor() as i32;
    let factor = 10f64.powi(digits);
    (value * factor * (1.0 + 1e-12)).floor() / factor
}

/// Is the exact solid the render? The first comparison it fails, or the
/// checks as the result reports them.
pub(super) fn accept(
    answer: &Value,
    mesh: &mesh::Mesh,
    sampling: &Sampling,
) -> Result<Value, String> {
    if let Some(reason) = sampling.unprobed_reason() {
        return Err(reason);
    }
    let count = |key: &str| answer[key].as_u64().unwrap_or(u64::MAX);
    if answer["valid"] != true {
        return Err("OpenCASCADE reports it invalid".into());
    }
    if count("openShells") != 0 {
        return Err(format!("{} of its shells are open", count("openShells")));
    }
    if count("freeEdges") != 0 {
        return Err(format!("it has {} free edges", count("freeEdges")));
    }
    if count("unmeshedFaces") != 0 {
        return Err(format!(
            "{} of its faces do not tessellate",
            count("unmeshedFaces")
        ));
    }
    let bodies = bodies(mesh) as u64;
    if count("solids") != bodies {
        return Err(format!(
            "it is {} where the render is {}",
            plural(count("solids"), "solid"),
            if bodies == 1 {
                "1 body".to_owned()
            } else {
                format!("{bodies} bodies")
            }
        ));
    }
    let classified = answer["inside"].as_str().unwrap_or("").as_bytes();
    if classified.len() != sampling.points.len() {
        return Err(format!(
            "it classified {} of the {} sample points",
            classified.len(),
            sampling.points.len()
        ));
    }
    let volume = number(answer, "volume");
    let reference = mesh.volume;
    let error = (volume - reference).abs() / reference.max(f64::MIN_POSITIVE);
    // A volume that is not a number fails too.
    if error.is_nan() || error > MAX_VOLUME_ERROR {
        return Err(format!(
            "its volume is {} mm³ against the render's {} mm³ ({} % apart)",
            round(volume, 3),
            round(reference, 3),
            round(100.0 * error, 3)
        ));
    }
    let corner = |key: &str, axis: usize| answer[key][axis].as_f64().unwrap_or(f64::INFINITY);
    let box_error = (0..3)
        .map(|axis| {
            (corner("bboxMin", axis) - mesh.bounds_min[axis])
                .abs()
                .max((corner("bboxMax", axis) - mesh.bounds_max[axis]).abs())
        })
        .fold(0.0, f64::max);
    let largest = mesh.size().into_iter().fold(0.0, f64::max);
    let box_tolerance = MIN_BBOX_TOLERANCE_MM.max(BBOX_TOLERANCE * largest);
    if box_error.is_nan() || box_error > box_tolerance {
        return Err(format!(
            "its bounding box differs from the render's by {} mm",
            round(box_error, 4)
        ));
    }
    let pairs = sampling.pairs();
    // Per patch of the render: do the exact solid's classifications of its pairs agree?
    let render = tally((0..pairs).map(|pair| {
        let at = sampling.volume + 2 * pair;
        (
            sampling.patches[pair] as u64,
            classified[at] == b'1' && classified[at + 1] == b'0',
            sampling.pair_offsets[pair] >= sampling.trusted,
        )
    }));
    if render.missed > MAX_SURFACE_MISMATCHES || render.lost > 0 {
        return Err(format!(
            "{} of {pairs} probe pairs at the render's faces classify differently, so a feature of the render is missing or moved",
            render.missed
        ));
    }
    // A counted pair that disagrees where no face of the render lies within the facets' reach
    // and the rounding cannot be the facets' doing, however few such pairs there are: a dimple
    // or groove that blends into its face (and so shares its patch and its pairs) is lost this
    // way. On a tree of flat faces that reach is the rounding alone.
    let explained = sampling.explained();
    let unexplained = (0..pairs)
        .filter(|&pair| {
            let at = sampling.volume + 2 * pair;
            sampling.pair_offsets[pair] >= sampling.trusted
                && [(at, b'1'), (at + 1, b'0')]
                    .into_iter()
                    .any(|(point, expected)| {
                        classified[point] != expected
                            && !face_within(mesh, sampling.points[point], explained)
                    })
        })
        .count();
    if unexplained > 0 {
        return Err(format!(
            "{unexplained} of {pairs} probe pairs at the render's faces classify differently farther than {} mm from every face of the render, more than its facets and rounding explain, so a feature of the render is missing or moved",
            significant(explained)
        ));
    }
    if render.uncounted > 0 {
        return Err(format!(
            "on {} of the render's {} surfaces the only probe pairs that fit lie nearer the faces than the facets can lie from the exact surfaces ({} mm), and disagree, so a feature there may be missing",
            render.uncounted,
            sampling.patch_count,
            round(sampling.trusted, 4)
        ));
    }
    // Pairs the converter placed at the exact solid's own faces, inside then outside it:
    // the render must see them so too, or the solid has material the render has not.
    let own = answer["solidProbes"]
        .as_array()
        .ok_or("it returned no probes of its own faces")?
        .iter()
        .map(|pair| {
            pair.as_array()
                .filter(|values| values.len() == 7)
                .and_then(|values| values.iter().map(Value::as_f64).collect::<Option<Vec<_>>>())
                .ok_or("its probes of its own faces are not points")
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Each pair's points with the render's answers for them.
    let seen = own
        .iter()
        .map(|pair| {
            let (inner, outer) = ([pair[0], pair[1], pair[2]], [pair[3], pair[4], pair[5]]);
            (inner, outer, mesh.contains(inner), mesh.contains(outer))
        })
        .collect::<Vec<_>>();
    let solid = tally(own.iter().zip(&seen).map(|(pair, &(inner, outer, a, b))| {
        let offset = (0..3)
            .map(|k| (outer[k] - inner[k]).powi(2))
            .sum::<f64>()
            .sqrt()
            / 2.0;
        (
            pair[6] as u64,
            a && !b,
            // A rounding margin: the converter's offsets are the core's.
            offset >= sampling.trusted * (1.0 - 1e-9),
        )
    }));
    if solid.missed > MAX_SURFACE_MISMATCHES || solid.lost > 0 {
        return Err(format!(
            "{} of {} probe pairs at its own faces classify differently in the render, so it has material or a face the render does not",
            solid.missed,
            own.len()
        ));
    }
    // On a tree of flat faces the render's facets are the exact faces, so a pair here that the
    // render classifies differently farther than the rounding from every face of the render is
    // material the rebuild added, however few such pairs there are. Not on a curved tree: on
    // the corpus a correct rebuild had one pair at its own faces disagreeing 0.117 mm from
    // every face of the render (0.108 mm reach), where the render's facets lie farther from the
    // exact surface than the facet bound says.
    if sampling.trusted == 0.0 {
        let unexplained = seen
            .iter()
            .filter(|&&(inner, outer, a, b)| {
                [(inner, a, true), (outer, b, false)].into_iter().any(
                    |(point, inside, expected)| {
                        inside != expected && !face_within(mesh, point, explained)
                    },
                )
            })
            .count();
        if unexplained > 0 {
            return Err(format!(
                "{unexplained} of {} probe pairs at its own faces classify differently in the render farther than {} mm from every face of the render, whose flat facets are its exact faces, so it has material or a face the render does not",
                own.len(),
                significant(explained)
            ));
        }
    }
    if solid.uncounted > 0 {
        return Err(format!(
            "on {} of its faces the only probe pairs that fit lie nearer the faces than the render's facets can lie from them ({} mm), and disagree, so it may have material the render does not",
            solid.uncounted,
            round(sampling.trusted, 4)
        ));
    }
    // A point on the exact solid's surface (2) is not compared: it says neither way.
    let on_surface = classified[..sampling.volume]
        .iter()
        .filter(|&&state| state == b'2')
        .count();
    let samples = (0..sampling.volume)
        .filter(|&at| match classified[at] {
            b'2' => false,
            b'0' | b'1' => (classified[at] == b'1') != sampling.render[at],
            _ => true,
        })
        .count();
    if samples > MAX_SAMPLE_MISMATCHES {
        return Err(format!(
            "{samples} of {} points through its bounding box classify differently from the render",
            sampling.volume
        ));
    }
    Ok(json!({"unit": "mm",
        "basis": format!("opencascade read-back (OCP {})", answer["ocp"].as_str().unwrap_or("unknown")),
        "volume": round(volume, 3), "refVolume": round(reference, 3),
        "volumeErrorPct": round(100.0 * error, 4), "bboxErrorMm": round(box_error, 4),
        "samples": sampling.volume, "sampleMismatches": samples, "sampleOnSurface": on_surface,
        "surfaceProbes": pairs, "surfaceMismatches": render.missed,
        "surfaceSetAside": render.set_aside, "surfacePatches": render.surfaces,
        "surfaceSlivers": sampling.slivers,
        "solidProbes": own.len(), "solidMismatches": solid.missed,
        "solidSetAside": solid.set_aside, "solidFaces": answer["solidFaces"].as_u64().unwrap_or(0),
        "solidUnprobedFaces": answer["solidUnprobed"].as_u64().unwrap_or(0),
        "solidSlivers": answer["solidSlivers"].as_u64().unwrap_or(0),
        "probeOffsetMm": round(sampling.offsets[0], 4),
        "probeOffsetMinMm": round(sampling.pair_offsets.iter().copied().fold(sampling.offsets[0], f64::min), 4),
        "probeOffsetTrustedMm": round(sampling.trusted, 4),
        "valid": true, "openShells": 0, "freeEdges": 0, "unmeshedFaces": 0}))
}

/// How probe pairs on a set of surfaces compare.
struct Tally {
    /// Surfaces with pairs.
    surfaces: usize,
    /// Counted pairs that disagree.
    missed: usize,
    /// Surfaces that lost most of their counted pairs, as a lost hole, boss or
    /// other feature with faces of its own takes them with it however small it
    /// is. A feature that blends into a face at under `SMOOTH_DEGREES` shares
    /// that face's pairs instead, and gets them only by its area.
    lost: usize,
    /// Pairs set aside: nearer the faces than the facets' reach, and disagreeing.
    set_aside: usize,
    /// Surfaces left with fewer than two counted pairs.
    uncounted: usize,
}

/// Pairs as (surface, agrees, trusted). A pair counts when it agrees or lies
/// beyond the facets' reach; a nearer one that disagrees says nothing either
/// way and is set aside.
fn tally(pairs: impl Iterator<Item = (u64, bool, bool)>) -> Tally {
    // Per surface: counted pairs and of them those that disagree.
    let mut by_surface = std::collections::BTreeMap::<u64, (usize, usize)>::new();
    let mut set_aside = 0;
    for (surface, agrees, trusted) in pairs {
        let entry = by_surface.entry(surface).or_default();
        if agrees || trusted {
            entry.0 += 1;
            entry.1 += usize::from(!agrees);
        } else {
            set_aside += 1;
        }
    }
    Tally {
        surfaces: by_surface.len(),
        missed: by_surface.values().map(|(_, missed)| missed).sum(),
        lost: by_surface
            .values()
            .filter(|(counted, missed)| *counted >= 2 && 2 * missed > *counted)
            .count(),
        set_aside,
        uncounted: by_surface
            .values()
            .filter(|(counted, _)| *counted < 2)
            .count(),
    }
}

/// The point of `triangle` nearest `p` (Ericson, Real-Time Collision
/// Detection, 5.1.5), by the region of the triangle `p` projects into.
fn nearest_on(p: mesh::Point, [a, b, c]: mesh::Triangle) -> mesh::Point {
    let sub =
        |u: mesh::Point, v: mesh::Point| -> mesh::Point { [u[0] - v[0], u[1] - v[1], u[2] - v[2]] };
    let dot = |u: mesh::Point, v: mesh::Point| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let along = |from: mesh::Point, to: mesh::Point, t: f64| -> mesh::Point {
        std::array::from_fn(|k| from[k] + t * (to[k] - from[k]))
    };
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return along(a, b, d1 / (d1 - d3));
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return along(a, c, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return along(b, c, (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let total = va + vb + vc;
    if total.abs() < f64::MIN_POSITIVE {
        // A degenerate triangle: its edges are other triangles' edges.
        return a;
    }
    let (v, w) = (vb / total, vc / total);
    std::array::from_fn(|k| a[k] + v * ab[k] + w * ac[k])
}

/// Does a face of the render lie within `reach` of `point`? Asked of the
/// few pairs that disagree, so a plain pass over the triangles will do.
fn face_within(mesh: &mesh::Mesh, point: mesh::Point, reach: f64) -> bool {
    // A rounding margin: a pair's own face lies exactly its offset away.
    let reach = reach * (1.0 + 1e-6);
    mesh.triangles.iter().any(|triangle| {
        let outside_box = (0..3).any(|k| {
            let (low, high) = triangle
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), v| {
                    (low.min(v[k]), high.max(v[k]))
                });
            point[k] < low - reach || point[k] > high + reach
        });
        if outside_box {
            return false;
        }
        let nearest = nearest_on(point, *triangle);
        (0..3).map(|k| (nearest[k] - point[k]).powi(2)).sum::<f64>() <= reach * reach
    })
}

/// A converter failure in words, by the stage it stopped at.
fn converter_failure(answer: &Value, python: &Path) -> String {
    let reason = answer["reason"].as_str().unwrap_or("no reason given");
    let unsupported = reason.strip_prefix("Unsupported: ").filter(|name| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    match (answer["stage"].as_str().unwrap_or(""), unsupported) {
        ("import", _) => format!("Python {} cannot import OCP: {reason}", python.display()),
        ("parse" | "build", Some(name)) => {
            format!("The exact converter does not rebuild {name}() yet.")
        }
        ("parse" | "build", None) => {
            format!("OpenCASCADE could not rebuild the CSG tree: {reason}")
        }
        _ => format!("OpenCASCADE could not write or read back the STEP file: {reason}"),
    }
}

/// What Rust can see in the file itself, so a converter that wrote one file
/// and measured another is caught.
fn step_file_problem(bytes: &[u8], reported: Option<u64>) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    if reported != Some(bytes.len() as u64) {
        return Some(format!(
            "is {} bytes, not the {} it measured",
            bytes.len(),
            reported
                .map(|n| n.to_string())
                .unwrap_or_else(|| "unknown number".into())
        ));
    }
    if !text.starts_with("ISO-10303-21;") || !text.trim_end().ends_with("END-ISO-10303-21;") {
        return Some("is not an ISO 10303-21 file".into());
    }
    if !text.contains("AUTOMOTIVE_DESIGN") {
        return Some("does not declare the AP214 schema".into());
    }
    if !text.contains("MANIFOLD_SOLID_BREP") && !text.contains("BREP_WITH_VOIDS") {
        return Some("holds no solid".into());
    }
    None
}

fn plural(count: u64, word: &str) -> String {
    if count == 1 {
        format!("1 {word}")
    } else {
        format!("{count} {word}s")
    }
}

/// Primitives OpenSCAD rendered with few facets that the converter rebuilt as
/// true circles, spheres or revolutions.
fn interpretation_notes(answer: &Value) -> Vec<String> {
    answer["interpretations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let kind = entry["kind"].as_str()?;
            let facets = entry["facets"].as_u64()?;
            let count = entry["count"].as_u64().unwrap_or(1);
            let (noun, shape) = match kind {
                "sphere" => ("sphere", "true spheres"),
                "rotate_extrude" => ("rotate_extrude", "true revolutions"),
                "circle" => ("circle", "true circles"),
                _ => ("cylinder", "true circles"),
            };
            Some(format!(
                "{} rendered with {facets} facets {} exported as {shape}.",
                plural(count, noun),
                if count == 1 { "was" } else { "were" }
            ))
        })
        .collect()
}

/* ------------------------------------------------------------------ */
/* STEP: compute                                                        */
/* ------------------------------------------------------------------ */

/// Why the exact path ended: fall back to faceted, or stop altogether.
enum Attempt {
    Fallback(String),
    Stop(ContractError),
}

fn cancelled_error() -> ContractError {
    ContractError::new("CANCELLED", CANCELLED)
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn limit_reached(what: &str, limit_ms: u64) -> Attempt {
    Attempt::Fallback(format!(
        "{what} stopped at the export's {limit_ms} ms limit."
    ))
}

/// The converter's work on the CSG tree at `dir/output.csg`: its answer,
/// compared with the render, and the file it wrote.
pub(super) struct Rebuilt {
    pub answer: Value,
    pub checks: Value,
    pub bytes: Vec<u8>,
}

/// Rebuild the CSG tree at `dir/output.csg` with the converter and compare
/// the file it writes, as read back, with the render.
#[allow(clippy::too_many_arguments)]
fn rebuild(
    python: &python::Python,
    dir: &Path,
    mesh: &mesh::Mesh,
    product: &str,
    deadline: Instant,
    limit_ms: u64,
    cancelled: &dyn Fn() -> bool,
    trail: &mut Trail,
) -> Result<Rebuilt, Attempt> {
    let (csg, step, answer_path) = (
        dir.join("output.csg"),
        dir.join("output.step"),
        dir.join("answer.json"),
    );
    let tree = fs::read(&csg).map_err(|error| Attempt::Stop(internal(error)))?;
    let sampling = sampling(mesh, csg_sagitta(&String::from_utf8_lossy(&tree), mesh));
    // A render the probes cannot cover is never vouched for; the converter need not run.
    if let Some(reason) = sampling.unprobed_reason() {
        return Err(Attempt::Fallback(format!(
            "The exact solid could not be compared with the render: {reason}."
        )));
    }
    let request = json!({"protocol": 1, "csg": csg, "step": step, "answer": answer_path,
        "product": product, "samples": sampling.points,
        "probes": {"offsets": sampling.offsets, "trusted": sampling.trusted,
            "margin": sampling.reach(),
            "pairs": SURFACE_PAIRS, "maxPairs": MAX_SURFACE_PAIRS, "perFace": PAIRS_PER_PATCH,
            "tries": POSITION_TRIES}});
    fs::write(dir.join("csg_to_step.py"), CONVERTER)
        .and_then(|()| fs::write(dir.join("request.json"), request.to_string()))
        .map_err(|error| Attempt::Stop(internal(error)))?;
    if remaining(deadline).is_zero() {
        return Err(limit_reached("The export", limit_ms));
    }
    let converted = engine::run(
        &python.exe,
        &["-E".into(), "csg_to_step.py".into(), "request.json".into()],
        remaining(deadline),
        dir,
        cancelled,
    )
    .map_err(|error| {
        Attempt::Fallback(format!(
            "The exact converter could not start: {}",
            error.message
        ))
    })?;
    trail.commands.push(format!(
        "{} -E csg_to_step.py request.json",
        file_name(&python.exe)
    ));
    trail.log.push(converted.log.trim_end().to_owned());
    if converted.cancelled {
        return Err(Attempt::Stop(cancelled_error()));
    }
    if converted.timed_out {
        return Err(limit_reached("The exact converter", limit_ms));
    }
    let answer = fs::read(&answer_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .ok_or_else(|| {
            Attempt::Fallback(format!(
                "The exact converter ended without an answer: {}",
                converted
                    .log
                    .lines()
                    .map(str::trim)
                    .rfind(|line| !line.is_empty())
                    .unwrap_or("no output")
            ))
        })?;
    if answer["protocol"] != 1 {
        return Err(Attempt::Fallback(
            "The exact converter answered in a protocol this build does not read.".into(),
        ));
    }
    // The versions that did the work, which may have changed since the Python was checked.
    if let Some(ocp) = answer["ocp"].as_str() {
        trail.converter["ocp"] = json!(ocp);
    }
    if let Some(version) = answer["python"].as_str() {
        trail.converter["pythonVersion"] = json!(version);
    }
    if answer["ok"] != true {
        if answer["stage"] == "import" {
            // The check that found OCP there is out of date.
            python::forget(&python.exe);
            trail.converter["ocp"] = Value::Null;
        }
        return Err(Attempt::Fallback(converter_failure(&answer, &python.exe)));
    }
    let checks = accept(&answer, mesh, &sampling).map_err(|failure| {
        Attempt::Fallback(format!("The exact solid was not used: {failure}."))
    })?;
    let size = step.metadata().map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_STEP_BYTES {
        return Err(Attempt::Fallback(format!(
            "The exact solid was not used: its file is {size} bytes, over the {MAX_STEP_BYTES} byte limit."
        )));
    }
    let bytes = fs::read(&step).map_err(|error| {
        Attempt::Fallback(format!(
            "The exact converter's file cannot be read: {error}"
        ))
    })?;
    if let Some(problem) = step_file_problem(&bytes, answer["bytes"].as_u64()) {
        return Err(Attempt::Fallback(format!(
            "The exact solid was not used: the converter's file {problem}."
        )));
    }
    Ok(Rebuilt {
        answer,
        checks,
        bytes,
    })
}

impl ExportPipeline {
    fn compute_export(&self, workspace: &Workspace<'_>) -> CoreResult<Exported> {
        let plan = &self.plan;
        let deadline = Instant::now() + Duration::from_millis(plan.timeout_ms);
        let mesh = render::stored_mesh(workspace, &plan.mesh_hash).map_err(|error| {
            ContractError::validation(format!(
                "The stored render of r{} cannot be read: {}",
                plan.seq, error.message
            ))
            .with_repair("Render the revision again, then export.")
        })?;
        if !mesh.watertight || mesh.inverted {
            return Err(ContractError::validation(format!(
                "r{} of \"{}\" renders to {} open edges and {} edges shared by more than two faces; a STEP solid needs one closed solid.",
                plan.seq, plan.title, mesh.boundary_edges, mesh.non_manifold_edges
            ))
            .with_repair("Make the part one closed solid (overlap unioned volumes, let cutters pass through every face), render it again, then export.")
            .with_details(json!({"reason": "NOT_A_SOLID", "boundaryEdges": mesh.boundary_edges, "nonManifoldEdges": mesh.non_manifold_edges})));
        }
        let mut trail = Trail::default();
        let reason = match plan.method {
            Method::Faceted => None,
            Method::Auto => match self.exact(workspace, &mesh, deadline, &mut trail) {
                Ok(exported) => return Ok(exported),
                Err(Attempt::Stop(error)) => return Err(error),
                Err(Attempt::Fallback(reason)) => Some(reason),
            },
        };
        if (workspace.cancelled)() {
            return Err(cancelled_error());
        }
        let description = format!(
            "Faceted solid of the OpenSCAD render of {} r{}; planar faces, not exact surfaces",
            plan.title, plan.seq
        );
        let file_name = format!(
            "{}-r{}.step",
            if plan.slug.is_empty() {
                "part"
            } else {
                &plan.slug
            },
            plan.seq
        );
        let faceted = faceted::write(
            &mesh,
            &faceted::Header {
                product: &plan.title,
                description: &description,
                file_name: &file_name,
                timestamp: &plan.created_at,
            },
        )
        .map_err(|error| faceted_refused(error, reason.as_deref()))?;
        let error = (faceted.volume - mesh.volume).abs() / mesh.volume.max(f64::MIN_POSITIVE);
        trail.log.push(format!(
            "{}: {} faces with {} inner loops, {} edges, {} vertices, {} solids, {} voids; {} pinched regions written as triangles; plane tolerance {} mm",
            faceted::WRITER,
            faceted.faces,
            faceted.inner_loops,
            faceted.edges,
            faceted.vertices,
            faceted.solids,
            faceted.voids,
            faceted.traced_by_triangle,
            faceted::real(faceted.tolerance)
        ));
        trail
            .commands
            .push(format!("{} (in process)", faceted::WRITER));
        if let Some(reason) = &reason {
            trail.log.insert(0, format!("Not exact: {reason}"));
        }
        Ok(Exported {
            bytes: faceted.text.into_bytes(),
            method: "faceted",
            exact: false,
            faces: faceted.faces,
            solids: faceted.solids,
            checks: json!({"unit": "mm", "basis": "construction", "volume": round(faceted.volume, 3),
                "refVolume": round(mesh.volume, 3), "volumeErrorPct": round(100.0 * error, 6),
                "bboxErrorMm": 0, "closed": true}),
            converter: trail.converter,
            engine: trail.engine,
            approximations: vec![],
            reason,
            notes: trail.notes,
            log: trail.log,
            commands: trail.commands,
            tool_version: faceted::WRITER.to_owned(),
        })
    }

    /// The exact path: CSG tree, converter, comparison.
    fn exact(
        &self,
        workspace: &Workspace<'_>,
        mesh: &mesh::Mesh,
        deadline: Instant,
        trail: &mut Trail,
    ) -> Result<Exported, Attempt> {
        let plan = &self.plan;
        let cancelled = workspace.cancelled;
        let search = python::find(plan.python.as_deref(), cancelled, Some(deadline), false)
            .map_err(Attempt::Stop)?;
        trail.notes.extend(search.note.clone());
        for (path, error) in &search.tried {
            trail
                .log
                .push(format!("Python {}: {error}", path.display()));
        }
        let Some(python) = search.found else {
            if remaining(deadline).is_zero() {
                return Err(limit_reached(
                    "The search for a Python with OCP",
                    plan.timeout_ms,
                ));
            }
            return Err(Attempt::Fallback(format!(
                "{}; exact surfaces need the optional converter (Settings → Engineering tools).",
                python::MISSING
            )));
        };
        trail.converter = json!({"name": "omenflow-csg-to-step", "version": *CONVERTER_VERSION,
            "python": python.exe, "pythonVersion": python.version, "ocp": python.ocp});
        let engine = engine::engine(workspace.executable.as_deref()).map_err(|error| {
            Attempt::Fallback(format!(
                "OpenSCAD is not available to export the CSG tree: {}",
                error.message
            ))
        })?;
        trail.engine = Some(format!("openscad {}", engine.version));
        let rendered_by = plan.identity["engineVersion"].as_str().unwrap_or("");
        if !rendered_by.is_empty() && rendered_by != engine.version {
            trail.notes.push(format!(
                "The render was made by OpenSCAD {rendered_by}; the CSG tree came from {}.",
                engine.version
            ));
        }
        let temp = tempfile::tempdir().map_err(|error| Attempt::Stop(internal(error)))?;
        let dir = temp.path();
        let (scad, csg) = (dir.join("input.scad"), dir.join("output.csg"));
        let request = render::Request::new(&plan.source, &plan.params, plan.timeout_ms);
        fs::write(&scad, &request.source).map_err(|error| Attempt::Stop(internal(error)))?;
        let (args, defines) = render::engine_args(&request, &scad, render::Output::Csg(&csg))
            .map_err(Attempt::Stop)?;
        if remaining(deadline).is_zero() {
            return Err(limit_reached("The export", plan.timeout_ms));
        }
        let run = engine::run(&engine.exe, &args, remaining(deadline), dir, cancelled).map_err(
            |error| {
                Attempt::Fallback(format!(
                    "OpenSCAD could not export the CSG tree: {}",
                    error.message
                ))
            },
        )?;
        trail.commands.push(format!(
            "{} -o output.csg {defines}input.scad",
            file_name(&engine.exe)
        ));
        if run.cancelled {
            return Err(Attempt::Stop(cancelled_error()));
        }
        if run.timed_out {
            return Err(limit_reached("OpenSCAD's CSG export", plan.timeout_ms));
        }
        let (_, errors) = engine::classify(&run.log);
        let written = csg.metadata().is_ok_and(|meta| meta.len() > 0);
        if !run.ok || !errors.is_empty() || !written {
            return Err(Attempt::Fallback(format!(
                "OpenSCAD could not export the CSG tree: {}",
                errors
                    .first()
                    .map(String::as_str)
                    .or_else(|| run
                        .log
                        .lines()
                        .map(str::trim)
                        .rfind(|line| !line.is_empty()))
                    .unwrap_or("it wrote no CSG file")
            )));
        }
        let rebuilt = rebuild(
            &python,
            dir,
            mesh,
            &plan.title,
            deadline,
            plan.timeout_ms,
            cancelled,
            trail,
        )?;
        let (answer, checks, bytes) = (rebuilt.answer, rebuilt.checks, rebuilt.bytes);
        let approximations = answer["approximations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|text| text.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        trail.notes.extend(
            approximations
                .iter()
                .map(|text| format!("Approximated, not exact: {text}.")),
        );
        trail.notes.extend(interpretation_notes(&answer));
        let as_count = |key: &str| answer[key].as_u64().unwrap_or(0) as usize;
        let tool_version = format!(
            "OCP {}, Python {}, OpenSCAD {}",
            answer["ocp"].as_str().unwrap_or(&python.ocp),
            answer["python"].as_str().unwrap_or(&python.version),
            engine.version
        );
        Ok(Exported {
            bytes,
            method: "brep",
            exact: approximations.is_empty(),
            faces: as_count("faces"),
            solids: as_count("solids"),
            checks,
            converter: std::mem::take(&mut trail.converter),
            engine: trail.engine.take(),
            approximations,
            reason: None,
            notes: std::mem::take(&mut trail.notes),
            log: std::mem::take(&mut trail.log),
            commands: std::mem::take(&mut trail.commands),
            tool_version,
        })
    }

    fn commit_outcome(
        &self,
        handle: &ProjectHandle,
        exported: Exported,
        origin: &Origin,
    ) -> CoreResult<Value> {
        let plan = &self.plan;
        if jobs::cancelled(&handle.db, std::slice::from_ref(&plan.job_id)) {
            return Err(cancelled_error());
        }
        // Review state and baseline as they are now, not as they were planned.
        let artifact = require_artifact(handle, &plan.artifact_id)?;
        let revision = require_revision(handle, &plan.revision_id)?;
        if let Destination::Project(relative) = &plan.destination {
            let target =
                resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
            assert_agent_may_write(handle, origin, &target, &plan.example)?;
        }
        let path = write_destination(handle, &plan.destination, &exported.bytes)?;
        let mut event = json!({"artifactId": plan.artifact_id, "revisionId": plan.revision_id,
            "format": "step", "method": exported.method, "exact": exported.exact,
            "destPath": path, "bytes": exported.bytes.len()});
        if let Some(relative) = project_relative(handle, &path) {
            event["projectPath"] = json!(relative);
        }
        emit(handle, "cad.exported", origin, event)?;
        let digest = omenflow_storage::sha256_hex(&exported.bytes);
        jobs::finish(
            handle,
            &plan.job_id,
            "succeeded",
            jobs::Finish {
                tool_version: Some(exported.tool_version.clone()),
                command: Some(exported.commands.join("; ")),
                log: exported.log.join("\n"),
                output_hashes: json!({"step": digest}),
                error: None,
                inputs: None,
            },
            origin,
        )?;
        let verification = verification::latest_verification(handle, &revision)?["status"]
            .as_str()
            .unwrap_or("unverified")
            .to_owned();
        let mut notes = exported.notes;
        review_notes(&revision, &artifact, Some(&verification), &mut notes);
        if exported.solids > 1 {
            notes.push(format!(
                "The STEP holds {} solids, as the render has {} bodies.",
                exported.solids, exported.solids
            ));
        }
        let mut checks = exported.checks;
        checks["outputHash"] = json!(plan.mesh_hash);
        let mut result = json!({"path": path, "format": "step", "artifactId": plan.artifact_id,
            "revisionId": plan.revision_id, "revisionSeq": plan.seq,
            "reviewState": revision["reviewState"],
            "isBaseline": artifact["selectedRevisionId"] == revision["id"],
            "verification": verification, "method": exported.method, "exact": exported.exact,
            "faces": exported.faces, "solids": exported.solids, "bytes": exported.bytes.len(),
            "checks": checks, "converter": exported.converter, "engine": exported.engine,
            "approximations": exported.approximations, "notes": notes});
        if let Some(reason) = exported.reason {
            result["reason"] = json!(reason);
        }
        Ok(result)
    }
}

/// What the exact attempt left behind for the result and the job, whether or
/// not it was used.
#[derive(Default)]
struct Trail {
    notes: Vec<String>,
    log: Vec<String>,
    commands: Vec<String>,
    converter: Value,
    engine: Option<String>,
}

/// The faceted writer refused: say so for an export, with why exact was not used.
fn faceted_refused(mut error: ContractError, exact_reason: Option<&str>) -> ContractError {
    if !mesh::is_work_limit(&error) {
        return error;
    }
    error.repair = Some(format!(
        "Lower $fn so the render has at most {} triangles, or set up the STEP converter for an exact export.",
        faceted::MAX_TRIANGLES
    ));
    if let Some(reason) = exact_reason {
        error.message = format!("{} The exact path was not used: {reason}", error.message);
        if let Some(details) = error.details.as_deref_mut() {
            details["exactReason"] = json!(reason);
        }
    }
    error
}

impl Pipeline for ExportPipeline {
    fn op(&self) -> &'static str {
        "cad.export"
    }

    fn executable(&self) -> Option<PathBuf> {
        self.plan.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        vec![self.plan.job_id.clone()]
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some(self.compute_export(workspace));
    }

    fn commit(mut self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value> {
        let result = match self.outcome.take() {
            Some(Ok(exported)) => self.commit_outcome(handle, exported, origin),
            Some(Err(error)) => Err(error),
            None => Err(internal_stage()),
        };
        if let Err(error) = &result {
            // The caller is told where; the job, which archives carry, names a person's
            // destination outside the project by its file name, as its inputs do.
            let mut recorded = error.clone();
            if let Destination::Absolute(path) = &self.plan.destination {
                recorded.message = recorded
                    .message
                    .replace(&path.display().to_string(), &file_name(path));
            }
            abandon(handle, &self.job_ids(), &recorded, origin);
        }
        result
    }
}

#[cfg(test)]
mod tests;
