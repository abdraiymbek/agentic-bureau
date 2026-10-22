//! Pictures an agent asks for, to see what it made and what it was given.
//! `cad.view` draws a part from its mesh as a drawing sheet; `image.view`
//! shows an image file in the project with a grid, whole or enlarged. Both
//! are diagnostic: a picture binds and verifies nothing.
//!
//! The picture itself is not in the result. It is written under
//! `.omenflow/cache/views-v1/` (see [`pictures`]) and the result names it by
//! path and hash; the agent host reads it back and sends it beside the
//! result, and an `omenflow call` caller opens the file.
use super::*;

mod font;
mod picture;
pub mod pictures;
mod raster;
mod sheet;
#[cfg(test)]
mod tests;

use raster::{cross, normalize, Canvas, Placement, Topology, PALETTE};

type P3 = mesh::Point;

/// Smallest picture drawn, and the defaults, in pixels along the long edge.
const MIN_SIZE: u32 = 256;
const SHEET_SIZE: u32 = 1024;
const IMAGE_SIZE: u32 = 1024;
/// A to-scale panel whose content is smaller than this both ways is noted.
const SMALL_PANEL_PX: f64 = 16.0;
/// Section outlines listed per section; `cad_inspect` lists them all.
const LISTED_LOOPS: usize = 8;

/// The standard views, named as the part viewport names them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ViewName {
    Front,
    Back,
    Left,
    Right,
    Top,
    Bottom,
    Iso,
}

impl ViewName {
    const ALL: [Self; 7] = [
        Self::Front,
        Self::Back,
        Self::Left,
        Self::Right,
        Self::Top,
        Self::Bottom,
        Self::Iso,
    ];
    const DEFAULT: [Self; 4] = [Self::Front, Self::Top, Self::Right, Self::Iso];

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|view| view.as_str() == name)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Front => "front",
            Self::Back => "back",
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::Iso => "iso",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Front => "FRONT",
            Self::Back => "BACK",
            Self::Left => "LEFT",
            Self::Right => "RIGHT",
            Self::Top => "TOP",
            Self::Bottom => "BOTTOM",
            Self::Iso => "ISO",
        }
    }

    /// Where the viewer stands and which way is up, as the part viewport's
    /// standard views (renderer `STANDARD_VIEWS`) have them.
    fn frame(self) -> Frame {
        let iso = 1.0 / 3f64.sqrt();
        let z = [0.0, 0.0, 1.0];
        let (from, up) = match self {
            Self::Front => ([0.0, -1.0, 0.0], z),
            Self::Back => ([0.0, 1.0, 0.0], z),
            Self::Left => ([-1.0, 0.0, 0.0], z),
            Self::Right => ([1.0, 0.0, 0.0], z),
            Self::Top => ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            Self::Bottom => ([0.0, 0.0, -1.0], [0.0, -1.0, 0.0]),
            Self::Iso => ([iso, -iso, iso], z),
        };
        Frame::looking_from(from, up)
    }

    /// Third-angle place on the sheet: (column, row). Top above front, right
    /// beside it, left and back further out, bottom below, iso top right.
    fn cell(self) -> (usize, usize) {
        match self {
            Self::Top => (1, 0),
            Self::Iso => (2, 0),
            Self::Left => (0, 1),
            Self::Front => (1, 1),
            Self::Right => (2, 1),
            Self::Back => (3, 1),
            Self::Bottom => (1, 2),
        }
    }
}

/// A view direction: `from` points from the part toward the viewer; `right`
/// and `up` span the picture.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    right: P3,
    up: P3,
    from: P3,
}

impl Frame {
    fn looking_from(from: P3, up: P3) -> Self {
        let right = normalize(cross(up, from));
        Self {
            right,
            up: cross(from, right),
            from,
        }
    }
}

/// A cutting plane normal to `axis` (0 x, 1 y, 2 z) at `at` mm.
#[derive(Clone, Copy, Debug)]
struct Cut {
    axis: usize,
    at: f64,
    /// Chosen by the drawing because the request named no section.
    auto: bool,
}

impl Cut {
    /// A cut is drawn as seen along its axis: x from the right, y from the
    /// front, z from the top. The section's in-plane coordinates are then
    /// exactly that view's right and up.
    fn frame(&self) -> Frame {
        [ViewName::Right, ViewName::Front, ViewName::Top][self.axis].frame()
    }

    /// Through the middle of the part normal to y, just off the exact middle
    /// as the automatic planes of a report are.
    fn automatic(mesh: &mesh::Mesh) -> Option<Self> {
        let size = mesh.size();
        (size[1] > 0.0).then(|| Self {
            axis: 1,
            at: mesh.bounds_min[1] + size[1] * 0.5 + 1e-3,
            auto: true,
        })
    }
}

struct Spec {
    views: Vec<ViewName>,
    sections: Vec<Cut>,
    /// Longest edge of the sheet, pixels.
    size: usize,
}

/// What the footer says the picture is.
struct Footer {
    revision_seq: i64,
    mesh_hash: String,
    variant: bool,
}

enum PanelKind {
    View(ViewName),
    Section {
        cut: Cut,
        measured: section::Section,
    },
}

/// One view or section on the sheet: `rect` is [x, y, width, height] in
/// sheet pixels.
struct Panel {
    kind: PanelKind,
    rect: [usize; 4],
    frame: Frame,
    placement: Placement,
    to_scale: bool,
}

struct Drawing {
    canvas: Canvas,
    panels: Vec<Panel>,
    /// The shared scale of the orthographic views and sections, mm per pixel.
    scale: Option<f64>,
}

/// An encoded picture: always PNG, so line work and small text stay sharp.
struct Encoded {
    bytes: Vec<u8>,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

impl Encoded {
    fn png(bytes: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            bytes,
            mime_type: pictures::MIME_TYPE,
            width,
            height,
        }
    }
}

/// A PNG with no text or time chunks, so equal pixels give equal bytes.
fn encode_png(
    width: u32,
    height: u32,
    colour: png::ColorType,
    palette: Option<Vec<u8>>,
    data: &[u8],
) -> CoreResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(colour);
    encoder.set_depth(png::BitDepth::Eight);
    if let Some(palette) = palette {
        encoder.set_palette(palette);
    }
    encoder.set_compression(png::Compression::High);
    encoder.set_filter(png::Filter::Adaptive);
    let mut writer = encoder.write_header().map_err(internal)?;
    writer.write_image_data(data).map_err(internal)?;
    writer.finish().map_err(internal)?;
    Ok(out)
}

fn encode_sheet(canvas: &Canvas) -> CoreResult<Encoded> {
    let palette = PALETTE.iter().flatten().copied().collect();
    let (width, height) = (canvas.width as u32, canvas.height as u32);
    let bytes = encode_png(
        width,
        height,
        png::ColorType::Indexed,
        Some(palette),
        &canvas.pixels,
    )?;
    Ok(Encoded::png(bytes, width, height))
}

/// A length as drawn and reported: at most three decimals, no trailing zeros.
fn number(value: f64) -> String {
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

fn rounded(value: f64, decimals: i32) -> f64 {
    let scale = 10f64.powi(decimals);
    let value = (value * scale).round() / scale;
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

/// The `index`-th round value: `mantissas` (in hundredths) times a power of
/// ten, counted from 10^-11. Built from exact powers of ten, so a value
/// prints as the decimal it is.
fn round_value(mantissas: &[f64], index: i64) -> f64 {
    const POWERS: [f64; 23] = [
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
        1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
    ];
    let count = mantissas.len() as i64;
    let exponent = (index.div_euclid(count) - 11).clamp(-20, 20) - 2;
    let mantissa = mantissas[index.rem_euclid(count) as usize];
    if exponent >= 0 {
        mantissa * POWERS[exponent as usize]
    } else {
        mantissa / POWERS[(-exponent) as usize]
    }
}

/// The index of the smallest round value at least `value`.
fn first_round_index(mantissas: &[f64], value: f64) -> i64 {
    let last = 22 * mantissas.len() as i64;
    (0..last)
        .find(|&index| round_value(mantissas, index) >= value)
        .unwrap_or(last - 1)
}

fn round_at_least(mantissas: &[f64], value: f64) -> f64 {
    round_value(mantissas, first_round_index(mantissas, value))
}

/// The sheet as drawn and encoded, with notes on how it was drawn.
struct Sheet {
    panels: Vec<Panel>,
    scale: Option<f64>,
    picture: Encoded,
    notes: Vec<String>,
}

/// Draw `mesh` as `spec` asks, at the largest size up to `spec.size` whose
/// picture is within the byte cap. Pure: no files, no database; the same
/// mesh and spec give the same bytes.
fn draw(mesh: &mesh::Mesh, spec: &Spec, footer: &Footer) -> CoreResult<Sheet> {
    let topology = Topology::new(mesh);
    let mut size = spec.size;
    loop {
        let sized = Spec {
            views: spec.views.clone(),
            sections: spec.sections.clone(),
            size,
        };
        let drawing = sheet::draw(mesh, &topology, &sized, footer);
        let picture = encode_sheet(&drawing.canvas)?;
        if picture.bytes.len() > pictures::PICTURE_BYTES && size > MIN_SIZE as usize {
            size = (size * 3 / 4).max(MIN_SIZE as usize);
            continue;
        }
        if picture.bytes.len() > pictures::PICTURE_BYTES {
            return Err(ContractError::validation(format!(
                "The drawing exceeds {} bytes even at {MIN_SIZE} px",
                pictures::PICTURE_BYTES
            ))
            .with_repair("Ask for fewer views or sections."));
        }
        let mut notes = Vec::new();
        if size < spec.size {
            notes.push(format!(
                "Drawn at {size} px: a larger picture exceeded {} bytes.",
                pictures::PICTURE_BYTES
            ));
        }
        if !topology.closed() {
            notes.push(
                "The mesh is open: pink areas are back faces seen through gaps in the surface."
                    .to_owned(),
            );
        }
        if let Some(scale) = drawing.scale {
            for panel in drawing.panels.iter().filter(|panel| panel.to_scale) {
                let e = panel.placement.extent;
                let content = [(e[1] - e[0]) / scale, (e[3] - e[2]) / scale];
                if content[0] < SMALL_PANEL_PX && content[1] < SMALL_PANEL_PX {
                    notes.push(format!(
                        "{} is {} px at this scale; ask for it alone or at a larger size.",
                        panel_name(panel),
                        number(content[0].max(content[1]))
                    ));
                }
            }
        }
        return Ok(Sheet {
            panels: drawing.panels,
            scale: drawing.scale,
            picture,
            notes,
        });
    }
}

fn section_letter(index: usize) -> char {
    ['A', 'B', 'C', 'D'][index.min(3)]
}

fn panel_name(panel: &Panel) -> String {
    match &panel.kind {
        PanelKind::View(view) => view.as_str().to_owned(),
        PanelKind::Section { cut, .. } => format!(
            "The section {}={}",
            ["x", "y", "z"][cut.axis],
            number(cut.at)
        ),
    }
}

fn vector(value: P3) -> Value {
    json!(value.map(|component| rounded(component, 6)))
}

/// What a panel shows and how its pixels map to the model.
fn panel_json(panel: &Panel) -> Value {
    let placement = &panel.placement;
    let mut out = json!({
        "panel": panel.rect,
        "from": vector(panel.frame.from),
        "right": vector(panel.frame.right),
        "up": vector(panel.frame.up),
        "mmPerPx": rounded(placement.scale, 6),
        "origin": placement.origin().map(|value| rounded(value, 4)),
    });
    if !panel.to_scale {
        out["toScale"] = json!(false);
    }
    out
}

fn sections_json(panels: &[Panel]) -> Vec<Value> {
    panels
        .iter()
        .filter_map(|panel| match &panel.kind {
            PanelKind::Section { cut, measured } => Some((panel, cut, measured)),
            PanelKind::View(_) => None,
        })
        .enumerate()
        .map(|(index, (panel, cut, measured))| {
            let letter = section_letter(index);
            let report = measured.report(None);
            let mut loops = report["loops"].as_array().cloned().unwrap_or_default();
            if loops.len() > LISTED_LOOPS {
                let more = loops.len() - LISTED_LOOPS;
                loops.truncate(LISTED_LOOPS);
                loops.push(json!(format!(
                    "…and {more} more (cad_inspect lists them all)"
                )));
            }
            let mut out = json!({"label": format!("{letter}-{letter}"), "plane": report["plane"]});
            if cut.auto {
                out["auto"] = json!(true);
            }
            out.as_object_mut()
                .unwrap()
                .extend(panel_json(panel).as_object().cloned().unwrap_or_default());
            out["loops"] = json!(loops);
            out["openChains"] = json!(measured.open_chains);
            out
        })
        .collect()
}

fn image_json(stored: &pictures::Stored, picture: &Encoded) -> Value {
    json!({"path": stored.path, "sha256": stored.sha256, "mimeType": picture.mime_type,
        "widthPx": picture.width, "heightPx": picture.height, "bytes": stored.bytes})
}

const READ: &str = "Each panel is [x, y, width, height] in image pixels. A pixel x from a panel's left edge and y down from its top is the model point origin[0] + x*mmPerPx along right and origin[1] - y*mmPerPx along up.";

fn nothing_to_draw() -> ContractError {
    ContractError::validation("Nothing to draw")
        .with_repair(
            "Ask for at least one view, for example {\"views\":[\"front\"]}, or a section.",
        )
        .with_details(json!({"reason": "NOTHING_TO_DRAW"}))
}

/// A sheet drawn and written.
struct Drawn {
    sheet: Sheet,
    stored: pictures::Stored,
}

struct ViewPipeline {
    artifact: Value,
    revision: Value,
    /// The parameter overrides of a variant; none for the revision itself.
    variant: Option<Value>,
    mesh: MeshSource,
    views: Vec<ViewName>,
    /// None: one automatic section.
    sections: Option<Vec<Cut>>,
    size: usize,
    executable: Option<PathBuf>,
    outcome: Option<CoreResult<(render::Rendered, Option<Drawn>)>>,
}

impl ViewPipeline {
    fn draw(
        &self,
        workspace: &Workspace<'_>,
        rendered: &render::Rendered,
    ) -> CoreResult<Option<Drawn>> {
        let Some(mesh) = &rendered.mesh else {
            return Ok(None);
        };
        let sections = match &self.sections {
            Some(sections) => sections.clone(),
            None => Cut::automatic(mesh).into_iter().collect(),
        };
        if self.views.is_empty() && sections.is_empty() {
            return Err(nothing_to_draw());
        }
        let spec = Spec {
            views: self.views.clone(),
            sections,
            size: self.size,
        };
        let footer = Footer {
            revision_seq: self.revision["seq"].as_i64().unwrap_or(0),
            mesh_hash: rendered
                .identity
                .as_ref()
                .and_then(|identity| identity["outputHash"].as_str())
                .unwrap_or("")
                .to_owned(),
            variant: self.variant.is_some(),
        };
        let sheet = draw(mesh, &spec, &footer)?;
        let stored = pictures::store(workspace.root, &sheet.picture.bytes)?;
        Ok(Some(Drawn { sheet, stored }))
    }

    fn response(&self, rendered: &render::Rendered, drawn: Drawn) -> Value {
        let mesh = rendered.mesh.as_deref().expect("a drawn part has a mesh");
        let seq = &self.revision["seq"];
        let output = rendered
            .identity
            .as_ref()
            .map(|identity| identity["outputHash"].clone())
            .unwrap_or(Value::Null);
        // Provenance from what was actually drawn: a stored mesh that could
        // not be read is rendered again, and says so.
        let stored = rendered.tool == "stored render";
        let mut mesh_json = json!({"source": if stored { "stored" } else { "rendered" },
            "outputHash": output, "triangles": mesh.triangles.len(),
            "watertight": mesh.watertight && !mesh.inverted});
        let mut notes = Vec::new();
        if let Some(params) = &self.variant {
            mesh_json["params"] = params.clone();
            notes.push(format!("Drawn from a variant of revision {seq} with params {params}; it was rendered under a job and nothing was committed."));
        } else if stored {
            let short = output
                .as_str()
                .unwrap_or("")
                .chars()
                .take(8)
                .collect::<String>();
            notes.push(format!(
                "Drawn from revision {seq}'s stored mesh (output {short})."
            ));
        } else if matches!(self.mesh, MeshSource::Stored { .. }) {
            notes.push(
                "The stored mesh could not be read; the part was rendered again for this picture."
                    .to_owned(),
            );
        } else {
            notes.push(format!("Revision {seq} had no current render; the part was rendered for this picture under a job and nothing was committed."));
        }
        notes.push("A picture is diagnostic: it binds and verifies nothing.".to_owned());
        if rendered.source_inverted {
            notes.push("NOT VERIFIED: the source produces inside-out geometry; the mesh was turned outward for display only.".to_owned());
        }
        notes.extend(drawn.sheet.notes.iter().cloned());
        let views = drawn
            .sheet
            .panels
            .iter()
            .filter_map(|panel| match panel.kind {
                PanelKind::View(view) => {
                    let mut out = json!({"name": view.as_str()});
                    out.as_object_mut()
                        .unwrap()
                        .extend(panel_json(panel).as_object().cloned().unwrap_or_default());
                    Some(out)
                }
                PanelKind::Section { .. } => None,
            })
            .collect::<Vec<_>>();
        json!({"artifactId": self.artifact["id"], "revisionId": self.revision["id"],
            "revisionSeq": seq, "title": self.artifact["title"],
            "mesh": mesh_json, "modelUnit": "mm", "bounds": mesh.summary()["bounds"],
            "mmPerPx": drawn.sheet.scale.map(|scale| rounded(scale, 6)),
            "views": views, "sections": sections_json(&drawn.sheet.panels),
            "images": [image_json(&drawn.stored, &drawn.sheet.picture)],
            "read": READ, "notes": notes,
            "next": "Compare every view and section with the request or drawing. Fix what differs with cad_write_source, then assert the requested dimensions, sections included, with cad_check."})
    }
}

impl Pipeline for ViewPipeline {
    fn op(&self) -> &'static str {
        "cad.view"
    }

    fn executable(&self) -> Option<PathBuf> {
        self.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        self.mesh.job_id().map(str::to_owned).into_iter().collect()
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some((|| {
            let rendered = self.mesh.resolve(workspace)?;
            // Only a render can be cancelled; drawing takes well under a second.
            if (workspace.cancelled)() {
                return Err(ContractError::new("CANCELLED", "Drawing was cancelled"));
            }
            let drawn = self.draw(workspace, &rendered)?;
            Ok((rendered, drawn))
        })());
    }

    fn commit(mut self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value> {
        let (rendered, drawn) = match self.outcome.take() {
            Some(Ok(outcome)) => outcome,
            Some(Err(error)) => {
                abandon(handle, &self.job_ids(), &error, origin);
                return Err(error);
            }
            None => return Err(internal_stage()),
        };
        self.mesh.close(handle, &rendered, origin)?;
        let Some(drawn) = drawn else {
            return Err(render_failed("draw the part", &rendered));
        };
        Ok(self.response(&rendered, drawn))
    }
}

/// The views asked for, each once in the order given; the default when none
/// were named.
fn requested_views(input: &Value) -> Vec<ViewName> {
    let Some(names) = input["views"].as_array() else {
        return ViewName::DEFAULT.to_vec();
    };
    let mut views = Vec::new();
    for view in names
        .iter()
        .filter_map(|name| name.as_str().and_then(ViewName::parse))
    {
        if !views.contains(&view) {
            views.push(view);
        }
    }
    views
}

fn requested_sections(input: &Value) -> CoreResult<Option<Vec<Cut>>> {
    let Some(requests) = input["sections"].as_array() else {
        return Ok(None);
    };
    requests
        .iter()
        .map(|request| {
            let axis = match request["axis"].as_str() {
                Some("x") => 0,
                Some("y") => 1,
                Some("z") => 2,
                _ => {
                    return Err(ContractError::validation("Section needs axis and at")
                        .with_repair("Send {\"axis\": \"y\", \"at\": 15}: the axis normal to the cut and the plane's position on it, mm."))
                }
            };
            let at = request["at"]
                .as_f64()
                .filter(|at| at.is_finite())
                .ok_or_else(|| {
                    ContractError::validation("Section needs axis and at").with_repair(
                        "Send {\"axis\": \"y\", \"at\": 15}: the axis normal to the cut and the plane's position on it, mm.",
                    )
                })?;
            Ok(Cut {
                axis,
                at,
                auto: false,
            })
        })
        .collect::<CoreResult<Vec<_>>>()
        .map(Some)
}

pub(crate) fn view_part(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.view", || {
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
        let (_, source) = source_of(handle, &revision)?;
        let declared = params::parameters(&source);
        let overrides = params::override_params(&input["params"], &declared)?;
        let views = requested_views(input);
        let sections = requested_sections(input)?;
        if views.is_empty() && sections.as_ref().is_some_and(Vec::is_empty) {
            return Err(nothing_to_draw());
        }
        let variant = overrides
            .as_object()
            .is_some_and(|map| !map.is_empty())
            .then(|| overrides.clone());
        // Validated before the job opens, so a refusal leaves nothing behind.
        let mut mesh = MeshSource::plan(&revision, &source, &overrides, render::timeout_ms(input))?;
        mesh.open(handle, &revision, origin, "cad.view")?;
        let size = input["size"]
            .as_u64()
            .map_or(SHEET_SIZE, |size| size as u32)
            .clamp(MIN_SIZE, 2000) as usize;
        Ok(Box::new(ViewPipeline {
            artifact,
            revision,
            variant,
            mesh,
            views,
            sections,
            size,
            executable: configured_executable(),
            outcome: None,
        }))
    })
}

/// The project file an `image.view` call names, relative to the project and
/// on disk. An absolute path must lead into the project.
fn image_file(handle: &ProjectHandle, path: &str) -> CoreResult<(String, PathBuf)> {
    let given = Path::new(path.trim());
    let relative = if given.is_absolute() {
        let root = omenflow_storage::canonicalize(&handle.root).map_err(storage_error)?;
        let canonical = omenflow_storage::canonicalize(given).map_err(storage_error)?;
        canonical
            .strip_prefix(&root)
            .map_err(|_| {
                ContractError::new("PATH_OUTSIDE_PROJECT", "Image path is outside the project")
                    .with_repair("Copy the image into the project folder and pass its project-relative path, e.g. inputs/drawing.png.")
            })?
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        let mut relative = path.trim();
        while let Some(rest) = relative.strip_prefix("./") {
            relative = rest;
        }
        relative.to_owned()
    };
    if relative == pictures::DIR || relative.starts_with(&format!("{}/", pictures::DIR)) {
        return Err(ContractError::new(
            "PATH_OUTSIDE_PROJECT",
            format!("Reserved project path: {relative}"),
        )
        .with_repair("That is a cad_view picture; call cad_view again with fewer views, a section, or a larger size."));
    }
    let file = resolve_materialization_path(&handle.root, &relative).map_err(storage_error)?;
    let meta = fs::metadata(&file)
        .ok()
        .filter(fs::Metadata::is_file)
        .ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("Image file not found: {relative}"))
                .with_repair("Paths are relative to the project folder, e.g. inputs/drawing.png.")
        })?;
    if meta.len() > picture::MAX_FILE_BYTES {
        return Err(picture::too_large(format!("{} bytes", meta.len())));
    }
    Ok((relative, file))
}

struct ImagePipeline {
    path: String,
    file: PathBuf,
    request: picture::Request,
    outcome: Option<CoreResult<Value>>,
}

impl ImagePipeline {
    fn show(&self, workspace: &Workspace<'_>) -> CoreResult<Value> {
        let mut bytes = Vec::new();
        fs::File::open(&self.file)
            .and_then(|file| {
                std::io::Read::read_to_end(
                    &mut std::io::Read::take(file, picture::MAX_FILE_BYTES + 1),
                    &mut bytes,
                )
            })
            .map_err(|_| {
                ContractError::new("NOT_FOUND", format!("Image file not found: {}", self.path))
                    .with_repair(
                        "Paths are relative to the project folder, e.g. inputs/drawing.png.",
                    )
            })?;
        if bytes.len() as u64 > picture::MAX_FILE_BYTES {
            return Err(picture::too_large(format!(
                "more than {} bytes",
                picture::MAX_FILE_BYTES
            )));
        }
        let shown = picture::show(&bytes, &self.request)?;
        let stored = pictures::store(workspace.root, &shown.picture.bytes)?;
        let [x, y, width, height] = shown.content;
        let mut result = json!({"path": self.path, "format": shown.format,
            "sha256": omenflow_storage::sha256_hex(&bytes),
            "widthPx": shown.width, "heightPx": shown.height,
            "region": shown.region.map(|value| rounded(value, 4)), "regionPx": shown.region_px,
            "scale": rounded(shown.scale, 3),
            "shown": {"x": x, "y": y, "widthPx": width, "heightPx": height},
            "images": [image_json(&stored, &shown.picture)],
            "notes": shown.notes,
            "next": "To read a dimension or callout, call image_view again with a region around it; 0.1 to 0.25 of the drawing usually makes text legible."});
        if let Some([x_ticks, y_ticks]) = shown.grid {
            result["grid"] = json!({"x": x_ticks, "y": y_ticks});
        }
        Ok(result)
    }
}

impl Pipeline for ImagePipeline {
    fn op(&self) -> &'static str {
        "image.view"
    }

    fn executable(&self) -> Option<PathBuf> {
        None
    }

    fn job_ids(&self) -> Vec<String> {
        Vec::new()
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some(self.show(workspace));
    }

    fn commit(mut self: Box<Self>, _handle: &ProjectHandle, _origin: &Origin) -> CoreResult<Value> {
        self.outcome.take().unwrap_or_else(|| Err(internal_stage()))
    }
}

pub(crate) fn view_image(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "image.view", || {
        // Not a project change, but it writes a picture into the project folder.
        handle.assert_writable().map_err(storage_error)?;
        let (path, file) = image_file(handle, required_str(input, "path")?)?;
        let region = input["region"].as_array().map(|values| {
            [0, 1, 2, 3].map(|i| values.get(i).and_then(Value::as_f64).unwrap_or(f64::NAN))
        });
        let size = input["size"]
            .as_u64()
            .map_or(IMAGE_SIZE, |size| size as u32)
            .clamp(MIN_SIZE, 2000);
        Ok(Box::new(ImagePipeline {
            path,
            file,
            request: picture::Request {
                region,
                grid: input["grid"].as_bool().unwrap_or(true),
                size,
            },
            outcome: None,
        }))
    })
}
