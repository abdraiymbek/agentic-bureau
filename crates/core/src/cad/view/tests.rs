//! Drawings and pictures without the engine: fixture meshes and images made
//! in the test.
use super::raster::{BACK, BG, DASH, FILL, HIDDEN, INK};
use super::*;
use crate::cad::mesh::fixtures::{cuboid, merged, mesh, plate_with_hole};

fn plate() -> mesh::Mesh {
    mesh(plate_with_hole([40.0, 30.0, 6.0], [20.0, 15.0], 8.0, 64))
}

fn footer() -> Footer {
    Footer {
        revision_seq: 3,
        mesh_hash: "1a2b3c4d5e6f".to_owned(),
        variant: false,
    }
}

fn spec(views: &[ViewName], sections: &[(usize, f64)], size: usize) -> Spec {
    Spec {
        views: views.to_vec(),
        sections: sections
            .iter()
            .map(|&(axis, at)| Cut {
                axis,
                at,
                auto: false,
            })
            .collect(),
        size,
    }
}

fn sheet_of(mesh: &mesh::Mesh, spec: &Spec) -> Drawing {
    sheet::draw(mesh, &Topology::new(mesh), spec, &footer())
}

fn panel(drawing: &Drawing, view: ViewName) -> &Panel {
    drawing
        .panels
        .iter()
        .find(|panel| matches!(panel.kind, PanelKind::View(name) if name == view))
        .expect("the view is drawn")
}

fn section_panel(drawing: &Drawing, index: usize) -> &Panel {
    drawing
        .panels
        .iter()
        .filter(|panel| matches!(panel.kind, PanelKind::Section { .. }))
        .nth(index)
        .expect("the section is drawn")
}

/// Colours of the pixels inside a panel, row by row.
fn pixels(drawing: &Drawing, panel: &Panel) -> Vec<u8> {
    let [x, y, w, h] = panel.rect;
    (y..y + h)
        .flat_map(|row| (x..x + w).map(move |column| (column, row)))
        .map(|(column, row)| drawing.canvas.get(column, row))
        .collect()
}

/// The colour at model point (u, v) of a panel.
fn at(drawing: &Drawing, panel: &Panel, u: f64, v: f64) -> u8 {
    let (x, y) = panel.placement.map(u, v);
    drawing
        .canvas
        .get(panel.rect[0] + x as usize, panel.rect[1] + y as usize)
}

fn count(pixels: &[u8], colours: &[u8]) -> usize {
    pixels.iter().filter(|p| colours.contains(p)).count()
}

#[test]
fn the_standard_views_match_the_part_viewport() {
    let k = 1.0 / 3f64.sqrt();
    let expected: [(ViewName, P3, P3, P3); 7] = [
        (
            ViewName::Front,
            [0.0, -1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
        ),
        (
            ViewName::Back,
            [0.0, 1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
        ),
        (
            ViewName::Left,
            [-1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 1.0],
        ),
        (
            ViewName::Right,
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ),
        (
            ViewName::Top,
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        ),
        (
            ViewName::Bottom,
            [0.0, 0.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
        ),
        (
            ViewName::Iso,
            [k, -k, k],
            [1.0 / 2f64.sqrt(), 1.0 / 2f64.sqrt(), 0.0],
            [-1.0 / 6f64.sqrt(), 1.0 / 6f64.sqrt(), 2.0 / 6f64.sqrt()],
        ),
    ];
    for (view, from, right, up) in expected {
        let frame = view.frame();
        let close = |a: P3, b: P3| (0..3).all(|i| (a[i] - b[i]).abs() < 1e-12);
        assert!(close(frame.from, from), "{view:?} from {:?}", frame.from);
        assert!(
            close(frame.right, right),
            "{view:?} right {:?}",
            frame.right
        );
        assert!(close(frame.up, up), "{view:?} up {:?}", frame.up);
        assert_eq!(ViewName::parse(view.as_str()), Some(view));
    }
}

#[test]
fn orthographic_views_share_one_round_scale_and_fit_the_long_edge() {
    let part = plate();
    let topology = Topology::new(&part);
    for size in [256, 512, 1024, 2000] {
        let request = spec(&ViewName::DEFAULT, &[(1, 15.0)], size);
        let drawing = sheet::draw(&part, &topology, &request, &footer());
        let scale = drawing.scale.unwrap();
        for panel in &drawing.panels {
            if panel.to_scale {
                assert_eq!(panel.placement.scale, scale, "size {size}");
            }
        }
        assert!(!panel(&drawing, ViewName::Iso).to_scale);
        let round = sheet::round_scales(scale / 2.0, 12);
        assert!(round.contains(&scale), "{scale} is not a round scale");
        assert!(drawing.canvas.width.max(drawing.canvas.height) <= size);
        // The next smaller round scale would not fit.
        let smaller = round[round.iter().position(|value| *value == scale).unwrap() - 1];
        let [w, h] = sheet::size_at(&topology, &request, &footer(), smaller);
        assert!(
            w.max(h) > size,
            "size {size}: {smaller} fits too ({w} x {h})"
        );
        // Views are aligned by projection: top above front, right beside it.
        let (front, top, right) = (
            panel(&drawing, ViewName::Front),
            panel(&drawing, ViewName::Top),
            panel(&drawing, ViewName::Right),
        );
        assert_eq!((front.rect[0], front.rect[2]), (top.rect[0], top.rect[2]));
        assert_eq!(
            (front.rect[1], front.rect[3]),
            (right.rect[1], right.rect[3])
        );
        assert!(top.rect[1] < front.rect[1] && front.rect[0] < right.rect[0]);
    }
    // Round scales print as the decimals they are.
    assert_eq!(
        sheet::round_scales(0.1, 4)
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>(),
        ["0.1", "0.125", "0.15", "0.2"]
    );
}

#[test]
fn a_through_hole_is_empty_in_the_top_view() {
    let part = plate();
    let drawing = sheet_of(&part, &spec(&[ViewName::Top], &[], 1024));
    let top = panel(&drawing, ViewName::Top);
    assert_eq!(at(&drawing, top, 20.0, 15.0), BG, "the hole centre is open");
    assert_ne!(at(&drawing, top, 5.0, 5.0), BG, "the plate is drawn");
    let s = drawing.scale.unwrap();
    let hole = 64.0 * 0.5 * 16.0 * (std::f64::consts::TAU / 64.0).sin();
    let expected = (40.0 * 30.0 - hole) / (s * s);
    let drawn = (pixels(&drawing, top).len() - count(&pixels(&drawing, top), &[BG])) as f64;
    assert!(
        (drawn - expected).abs() / expected < 0.02,
        "{drawn} drawn pixels for {expected}"
    );
}

/// The colour at pixel (x, y) of a panel, counted from its top left.
fn local(drawing: &Drawing, panel: &Panel, x: usize, y: usize) -> u8 {
    drawing.canvas.get(panel.rect[0] + x, panel.rect[1] + y)
}

#[test]
fn hidden_hole_walls_are_dashed_in_the_front_view_and_never_in_iso() {
    let part = plate();
    let drawing = sheet_of(&part, &spec(&[ViewName::Front, ViewName::Iso], &[], 1024));
    let front = panel(&drawing, ViewName::Front);
    let dashes = count(&pixels(&drawing, front), &[HIDDEN]);
    assert!(dashes > 20, "{dashes} hidden pixels in the front view");
    // Down the left hole wall (x = 16, behind the front face): dashes of
    // DASH pixels and gaps as long, in phase with the panel's rows.
    let (x, top) = front.placement.map(16.0, 6.0);
    let (_, bottom) = front.placement.map(16.0, 0.0);
    let rows = top.ceil() as usize + 2..bottom.floor() as usize - 2;
    assert!(rows.len() > 50, "{rows:?}");
    let column = (x.floor() as usize - 1..=x.floor() as usize + 1)
        .max_by_key(|&column| {
            rows.clone()
                .filter(|&row| local(&drawing, front, column, row) == HIDDEN)
                .count()
        })
        .unwrap();
    for row in rows {
        assert_eq!(
            local(&drawing, front, column, row) == HIDDEN,
            (row as i64).div_euclid(DASH) % 2 == 0,
            "row {row} of the hidden wall"
        );
    }
    let iso = pixels(&drawing, panel(&drawing, ViewName::Iso));
    assert_eq!(count(&iso, &[HIDDEN]), 0);
    assert!(count(&iso, &[INK]) > 0);
    // A solid block hides nothing.
    let block = mesh(cuboid([0.0; 3], [40.0, 30.0, 6.0], false));
    let drawing = sheet_of(&block, &spec(&[ViewName::Front], &[], 1024));
    assert_eq!(
        count(
            &pixels(&drawing, panel(&drawing, ViewName::Front)),
            &[HIDDEN]
        ),
        0
    );
}

#[test]
fn a_hidden_circle_is_dashed_too() {
    // A closed box around a cavity with a round pillar through it: in the
    // top view the pillar's rims are circles behind the lid. With 256 facets
    // each edge of the circle is shorter than a dash, so a dash phase per
    // edge would draw it solid.
    let mut triangles = cuboid([-5.0, -5.0, -5.0], [45.0, 35.0, 11.0], false);
    triangles.extend(
        plate_with_hole([40.0, 30.0, 6.0], [20.0, 15.0], 8.0, 256)
            .into_iter()
            .map(|[a, b, c]| [a, c, b]),
    );
    let part = mesh(triangles);
    let drawing = sheet_of(&part, &spec(&[ViewName::Top], &[], 1024));
    let top = panel(&drawing, ViewName::Top);
    let (cx, cy) = top.placement.map(20.0, 15.0);
    let radius = 4.0 / drawing.scale.unwrap();
    let [_, _, width, height] = top.rect;
    let mut dashed = 0u32;
    for y in 0..height {
        for x in 0..width {
            let from_centre = (x as f64 + 0.5 - cx).hypot(y as f64 + 0.5 - cy);
            if (from_centre - radius).abs() < 1.5 && local(&drawing, top, x, y) == HIDDEN {
                dashed += 1;
            }
        }
    }
    // A solid circle drawn a pixel per step along its longer axis inks
    // about 4√2 r pixels; a dashed one about half of them.
    let solid = 4.0 * std::f64::consts::SQRT_2 * radius;
    let share = f64::from(dashed) / solid;
    assert!(
        (0.3..0.7).contains(&share),
        "{dashed} hidden pixels on a circle of about {solid:.0}"
    );
}

#[test]
fn a_section_fills_material_even_odd_and_leaves_holes_empty() {
    let part = plate();
    let drawing = sheet_of(&part, &spec(&[], &[(2, 3.0)], 1024));
    let cut = section_panel(&drawing, 0);
    assert_eq!(at(&drawing, cut, 20.0, 15.0), BG, "the hole is empty");
    assert_eq!(at(&drawing, cut, 5.0, 5.0), FILL);
    let s = drawing.scale.unwrap();
    let PanelKind::Section { measured, .. } = &cut.kind else {
        unreachable!()
    };
    let expected = measured.material_area / (s * s);
    let filled = count(&pixels(&drawing, cut), &[FILL]) as f64;
    assert!(
        (filled - expected).abs() / expected < 0.02,
        "{filled} filled pixels for {expected}"
    );
}

#[test]
fn nested_islands_are_material_again() {
    let nested = merged(&[
        cuboid([0.0; 3], [20.0; 3], false),
        cuboid([2.0; 3], [18.0; 3], true),
        cuboid([8.0; 3], [12.0; 3], false),
    ]);
    let drawing = sheet_of(&nested, &spec(&[], &[(2, 10.0)], 512));
    let cut = section_panel(&drawing, 0);
    assert_eq!(at(&drawing, cut, 1.0, 1.0), FILL, "outer wall");
    assert_eq!(at(&drawing, cut, 5.0, 5.0), BG, "cavity");
    assert_eq!(at(&drawing, cut, 10.0, 10.0), FILL, "island");
}

#[test]
fn a_cut_through_vertices_still_fills_by_parity() {
    // y = 15 runs through the hole's axis and through two of its vertices.
    let part = plate();
    let drawing = sheet_of(&part, &spec(&[], &[(1, 15.0)], 1024));
    let cut = section_panel(&drawing, 0);
    assert_eq!(at(&drawing, cut, 10.0, 3.0), FILL);
    assert_eq!(at(&drawing, cut, 20.0, 3.0), BG);
    assert_eq!(at(&drawing, cut, 30.0, 3.0), FILL);
}

#[test]
fn an_open_mesh_shows_its_back_faces_and_says_so() {
    let mut open = cuboid([0.0; 3], [20.0, 10.0, 4.0], false);
    open.remove(2);
    let part = mesh(open);
    let request = spec(&[ViewName::Top], &[], 512);
    let drawing = sheet_of(&part, &request);
    assert!(count(&pixels(&drawing, panel(&drawing, ViewName::Top)), &[BACK]) > 100);
    let drawn = draw(&part, &request, &footer()).unwrap();
    assert!(drawn
        .notes
        .iter()
        .any(|note| note.starts_with("The mesh is open")));
    let closed = draw(&plate(), &request, &footer()).unwrap();
    assert!(closed.notes.is_empty(), "{:?}", closed.notes);
}

#[test]
fn output_is_byte_identical_and_independent_of_view_order() {
    let part = plate();
    let one = draw(
        &part,
        &spec(&ViewName::DEFAULT, &[(1, 15.0)], 1024),
        &footer(),
    )
    .unwrap();
    let two = draw(
        &part,
        &spec(&ViewName::DEFAULT, &[(1, 15.0)], 1024),
        &footer(),
    )
    .unwrap();
    assert_eq!(one.picture.bytes, two.picture.bytes);
    let reordered = [
        ViewName::Iso,
        ViewName::Right,
        ViewName::Top,
        ViewName::Front,
    ];
    let three = draw(&part, &spec(&reordered, &[(1, 15.0)], 1024), &footer()).unwrap();
    assert_eq!(one.picture.bytes, three.picture.bytes);
}

#[test]
fn labels_fit_their_columns_and_the_footer_fits_the_sheet() {
    let bar = mesh(cuboid([0.0; 3], [200.0, 10.0, 2.0], false));
    let everything = [
        ViewName::Front,
        ViewName::Back,
        ViewName::Left,
        ViewName::Right,
        ViewName::Top,
        ViewName::Bottom,
        ViewName::Iso,
    ];
    for request in [
        spec(&ViewName::DEFAULT, &[(1, 5.0)], 256),
        spec(
            &everything,
            &[(0, 100.0), (1, 5.0), (2, 1.0), (2, 1.5)],
            256,
        ),
        spec(&everything, &[(0, 100.0), (1, 5.0)], 1024),
    ] {
        let mut footer = footer();
        footer.variant = true;
        let drawing = sheet::draw(&bar, &Topology::new(&bar), &request, &footer);
        let (w, h) = (drawing.canvas.width, drawing.canvas.height);
        assert!(w.max(h) <= request.size, "{w} x {h}");
        // Frames sit one pixel outside each panel; no two panels overlap and
        // every frame is inside the sheet.
        let frames = drawing
            .panels
            .iter()
            .map(|panel| {
                let [x, y, pw, ph] = panel.rect;
                [x - 1, y - 1, x + pw + 1, y + ph + 1]
            })
            .collect::<Vec<_>>();
        for (i, a) in frames.iter().enumerate() {
            assert!(a[2] <= w && a[3] <= h, "{a:?} outside {w} x {h}");
            for b in &frames[i + 1..] {
                let apart = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
                assert!(apart, "{a:?} overlaps {b:?}");
            }
        }
        // Nothing is drawn in the outer margin.
        for x in 0..w {
            for y in (0..3).chain(h - 3..h) {
                assert_eq!(drawing.canvas.get(x, y), BG, "({x}, {y})");
            }
        }
    }
}

#[test]
fn the_font_covers_every_character_the_drawing_writes() {
    for text in [
        "FRONT  X 40  Z 6",
        "BOTTOM  X 0.125  Y 30",
        "ISO  NOT TO SCALE",
        "SECTION A-A  Y=15.001  AUTO",
        "SECTION D-D  X=-2.5",
        "10 MM   SCALE 0.15 MM/PX",
        "DIAGNOSTIC VIEW  REV 3  VARIANT  MESH 1A2B3C4D",
        "NO MATERIAL",
        "0.35",
    ] {
        assert!(text.chars().all(font::covers), "{text}");
    }
    assert!(!font::covers('#'));
    let shape = |text: &str| {
        let mut on = Vec::new();
        font::draw(text, 0, 0, 1, &mut |x, y| on.push((x, y)));
        on
    };
    assert_eq!(shape("#"), shape("?"), "anything else is drawn as ?");
    assert_eq!(shape("a"), shape("A"));
    assert_eq!(font::clip("FRONT  X 40", 30, 1), "FRONT");
}

#[test]
fn pictures_decode_back_to_their_reported_size() {
    let drawn = draw(
        &plate(),
        &spec(&ViewName::DEFAULT, &[(1, 15.0)], 1024),
        &footer(),
    )
    .unwrap();
    let decoder = png::Decoder::new(std::io::Cursor::new(drawn.picture.bytes.as_slice()));
    let reader = decoder.read_info().unwrap();
    let info = reader.info();
    assert_eq!(
        (info.width, info.height),
        (drawn.picture.width, drawn.picture.height)
    );
    assert_eq!(info.color_type, png::ColorType::Indexed);
    assert_eq!(info.palette.as_ref().unwrap().len(), 14 * 3);
    assert!(drawn.picture.width.max(drawn.picture.height) <= 1024);
    assert!(
        drawn.picture.bytes.len() < 100_000,
        "{}",
        drawn.picture.bytes.len()
    );
}

#[test]
fn a_large_mesh_is_drawn_within_the_work_limits() {
    // About 20,000 triangles: a sphere of 100 rings by 100 segments.
    let (rings, segments) = (100, 100);
    let point = |i: usize, j: usize| {
        let theta = std::f64::consts::PI * i as f64 / rings as f64;
        let phi = std::f64::consts::TAU * j as f64 / segments as f64;
        [
            20.0 * theta.sin() * phi.cos(),
            20.0 * theta.sin() * phi.sin(),
            20.0 * theta.cos(),
        ]
    };
    let mut triangles = Vec::new();
    for i in 0..rings {
        for j in 0..segments {
            let (a, b, c, d) = (
                point(i, j),
                point(i + 1, j),
                point(i + 1, j + 1),
                point(i, j + 1),
            );
            if i != 0 {
                triangles.push([a, b, d]);
            }
            if i != rings - 1 {
                triangles.push([b, c, d]);
            }
        }
    }
    let sphere = mesh(triangles);
    let everything = ViewName::ALL;
    let drawn = draw(
        &sphere,
        &spec(
            &everything,
            &[(0, 0.5), (1, 0.5), (2, 0.5), (2, 10.0)],
            2000,
        ),
        &footer(),
    )
    .unwrap();
    assert_eq!(drawn.panels.len(), 11);
    assert!(drawn.picture.bytes.len() <= pictures::PICTURE_BYTES);
}

/* ------------------------------- image.view ------------------------------ */

fn png_of(width: u32, height: u32, colour: png::ColorType, data: &[u8]) -> Vec<u8> {
    encode_png(width, height, colour, None, data).unwrap()
}

/// A white RGB image with a red square from (x0, y0) to (x1, y1), exclusive.
fn red_square(width: u32, height: u32, square: [u32; 4]) -> Vec<u8> {
    let mut data = vec![255u8; (width * height * 3) as usize];
    for y in square[1]..square[3] {
        for x in square[0]..square[2] {
            let at = ((y * width + x) * 3) as usize;
            data[at..at + 3].copy_from_slice(&[255, 0, 0]);
        }
    }
    png_of(width, height, png::ColorType::Rgb, &data)
}

fn shown(
    bytes: &[u8],
    region: Option<[f64; 4]>,
    grid: bool,
    size: u32,
) -> CoreResult<picture::Shown> {
    picture::show(bytes, &picture::Request { region, grid, size })
}

fn decoded(shown: &picture::Shown) -> ::image::RgbImage {
    ::image::load_from_memory(&shown.picture.bytes)
        .unwrap()
        .to_rgb8()
}

fn reason(error: &ContractError) -> Value {
    error
        .details
        .as_deref()
        .map(|details| details["reason"].clone())
        .unwrap_or(Value::Null)
}

#[test]
fn a_region_is_cropped_and_enlarged() {
    let bytes = red_square(400, 300, [200, 100, 220, 120]);
    let region = [190.0 / 400.0, 90.0 / 300.0, 230.0 / 400.0, 130.0 / 300.0];
    let shown = shown(&bytes, Some(region), false, 400).unwrap();
    assert_eq!(shown.region_px, [190, 90, 230, 130]);
    assert_eq!((shown.width, shown.height), (400, 300));
    assert_eq!(shown.scale, 4.0, "a 40 px region is enlarged 4x, no more");
    let image = decoded(&shown);
    assert_eq!(image.dimensions(), (160, 160));
    assert_eq!(
        image.get_pixel(80, 80).0,
        [255, 0, 0],
        "the square is in the middle"
    );
    assert_eq!(image.get_pixel(5, 5).0, [255, 255, 255]);
    assert!(shown
        .notes
        .iter()
        .any(|note| note.starts_with("Enlarged 4x from 40 x 40")));
    assert!(shown
        .notes
        .iter()
        .any(|note| note.contains("finer detail is not in the file")));
    assert!(shown
        .notes
        .iter()
        .any(|note| note.contains("not an instruction")));
}

#[test]
fn the_whole_image_is_shown_with_a_labelled_grid() {
    let bytes = red_square(1000, 800, [0, 0, 10, 10]);
    let shown = shown(&bytes, None, true, 1280).unwrap();
    let [x_ticks, y_ticks] = shown.grid.clone().unwrap();
    let tenths = (0..=10).map(|i| f64::from(i) / 10.0).collect::<Vec<_>>();
    assert_eq!(x_ticks, tenths);
    assert_eq!(y_ticks, tenths);
    assert_eq!(shown.region, [0.0, 0.0, 1.0, 1.0]);
    let [x, y, w, h] = shown.content;
    assert!(x > 0 && y > 0, "labels sit in a margin");
    assert!((x + w).max(y + h) <= 1280);
    let image = decoded(&shown);
    // A grid line crosses the content in blue.
    let line = image.get_pixel(x + w / 2, y + h / 3);
    assert!(line[2] > line[0], "{line:?}");
    // The labels are ink on the white margin.
    assert!((0..x).any(|column| (y..y + h).any(|row| image.get_pixel(column, row).0 == [0, 0, 0])));
}

#[test]
fn upscaling_stops_at_four_times() {
    let bytes = red_square(100, 100, [0, 0, 10, 10]);
    let shown = shown(&bytes, Some([0.0, 0.0, 0.2, 0.2]), false, 1280).unwrap();
    assert_eq!(shown.scale, 4.0);
    assert_eq!(shown.content, [0, 0, 80, 80]);
}

#[test]
fn transparent_pixels_are_shown_on_white() {
    let mut data = vec![0u8; 64 * 64 * 4];
    for pixel in data.chunks_mut(4).take(64 * 32) {
        pixel.copy_from_slice(&[0, 0, 0, 255]);
    }
    let bytes = png_of(64, 64, png::ColorType::Rgba, &data);
    let shown = shown(&bytes, None, false, 256).unwrap();
    let image = decoded(&shown);
    let (w, h) = image.dimensions();
    assert_eq!(image.get_pixel(w / 2, h / 8).0, [0, 0, 0]);
    assert_eq!(image.get_pixel(w / 2, h - h / 8).0, [255, 255, 255]);
    // Black and white only: sent as greyscale.
    assert_eq!(shown.picture.mime_type, "image/png");
    let reader = png::Decoder::new(std::io::Cursor::new(shown.picture.bytes.as_slice()))
        .read_info()
        .unwrap();
    assert_eq!(reader.info().color_type, png::ColorType::Grayscale);
}

#[test]
fn jpeg_is_read_and_other_formats_are_refused() {
    let mut jpeg = Vec::new();
    ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&::image::RgbImage::from_pixel(
            120,
            80,
            ::image::Rgb([30, 60, 90]),
        ))
        .unwrap();
    let shown = shown(&jpeg, None, true, 512).unwrap();
    assert_eq!(shown.format, "jpeg");
    assert_eq!((shown.width, shown.height), (120, 80));
    for (bytes, kind) in [
        (&b"%PDF-1.7 drawing"[..], "PDF"),
        (&b"GIF89a\x01\x00\x01\x00"[..], "GIF"),
        (&b"<?xml version=\"1.0\"?><svg></svg>"[..], "SVG"),
        (&b"hello"[..], "not a recognised image"),
    ] {
        let error = picture::show(
            bytes,
            &picture::Request {
                region: None,
                grid: true,
                size: 512,
            },
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(
            error.message,
            format!("Only PNG and JPEG images can be shown (this file is {kind})")
        );
        assert_eq!(reason(&error), "UNSUPPORTED_IMAGE");
        assert!(error.repair.as_deref().unwrap().contains("PNG"));
    }
}

/// A PNG whose header says `width` x `height`, with no pixels.
fn png_header(width: u32, height: u32) -> Vec<u8> {
    fn crc(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
    let chunk = |kind: &[u8], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc(&body).to_be_bytes());
        out
    };
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(chunk(b"IHDR", &ihdr));
    bytes.extend(chunk(b"IDAT", &[]));
    bytes.extend(chunk(b"IEND", &[]));
    bytes
}

#[test]
fn oversized_images_are_refused_before_decoding() {
    for (width, height) in [(20_000, 20_000), (16_384, 4_000)] {
        let error = shown(&png_header(width, height), None, true, 1280)
            .err()
            .unwrap();
        assert_eq!(reason(&error), "IMAGE_TOO_LARGE", "{width} x {height}");
        assert!(
            error.message.contains(&format!("{width} x {height} px")),
            "{}",
            error.message
        );
    }
}

/// A zlib stream that inflates to `1 + 258 * copies` zero bytes: a literal,
/// then copies of 258 bytes at distance 1, in one block of the fixed codes.
fn zlib_zeros(copies: usize) -> Vec<u8> {
    struct Bits {
        out: Vec<u8>,
        pending: u64,
        count: u32,
    }
    impl Bits {
        fn put(&mut self, value: u32, count: u32) {
            self.pending |= u64::from(value) << self.count;
            self.count += count;
            while self.count >= 8 {
                self.out.push(self.pending as u8);
                self.pending >>= 8;
                self.count -= 8;
            }
        }
        /// A Huffman code goes most significant bit first.
        fn code(&mut self, code: u32, count: u32) {
            self.put(code.reverse_bits() >> (32 - count), count);
        }
    }
    let mut bits = Bits {
        out: vec![0x78, 0x01],
        pending: 0,
        count: 0,
    };
    bits.put(1, 1); // the last block
    bits.put(1, 2); // of the fixed codes
    bits.code(0x30, 8); // literal 0
    for _ in 0..copies {
        bits.code(0xC5, 8); // length 258
        bits.code(0, 5); // distance 1
    }
    bits.code(0, 7); // end of block
    bits.put(0, 7); // to the byte boundary
    let mut out = bits.out;
    // Adler-32 of zeros: 1, and the length.
    let adler = ((1 + 258 * copies as u64) % 65_521) << 16 | 1;
    out.extend_from_slice(&(adler as u32).to_be_bytes());
    out
}

/// A PNG of `width` x `height` RGB `pixels` with `chunk` before them.
fn png_with_chunk(
    width: u32,
    height: u32,
    pixels: &[u8],
    chunk: (png::chunk::ChunkType, &[u8]),
) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer.write_chunk(chunk.0, chunk.1).unwrap();
    writer.write_image_data(pixels).unwrap();
    writer.finish().unwrap();
    bytes
}

#[test]
fn a_colour_profile_that_would_inflate_past_the_decoder_limit_is_dropped() {
    use ::image::ImageDecoder as _;
    // Under half a megabyte of file whose iCCP profile inflates to a
    // mebibyte more than a decoder may allocate.
    let copies = (picture::DECODER_BYTES as usize + (1 << 20)).div_ceil(258);
    let mut profile = b"bomb\0\0".to_vec();
    profile.extend(zlib_zeros(copies));
    let bytes = png_with_chunk(16, 16, &[90; 16 * 16 * 3], (png::chunk::iCCP, &profile));
    assert!(bytes.len() < 1 << 19, "{} bytes", bytes.len());
    // Unbounded, the decoder inflates it all before reading a pixel.
    let mut unbounded =
        ::image::codecs::png::PngDecoder::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
    assert_eq!(
        unbounded
            .icc_profile()
            .unwrap()
            .map(|profile| profile.len()),
        Some(1 + 258 * copies)
    );
    drop(unbounded);
    let mut bounded = picture::decoder(&bytes, ::image::ImageFormat::Png).unwrap();
    assert_eq!(
        bounded.icc_profile().unwrap().map(|profile| profile.len()),
        None
    );
    // The pixels are shown without it.
    let shown = shown(&bytes, None, false, 256).unwrap();
    assert_eq!((shown.width, shown.height), (16, 16));
    assert_eq!(decoded(&shown).get_pixel(10, 10).0, [90, 90, 90]);
}

#[test]
fn the_exif_orientation_is_applied_before_sizes_and_regions() {
    // Stored 40 x 20 with a red square at the top left, and EXIF saying the
    // camera was turned: upright the image is 20 x 40 with the square at its
    // top right.
    let mut pixels = vec![255u8; 40 * 20 * 3];
    for y in 0..10 {
        for x in 0..10 {
            let at = (y * 40 + x) * 3;
            pixels[at..at + 3].copy_from_slice(&[255, 0, 0]);
        }
    }
    // A big-endian TIFF header and one entry: Orientation (0x0112), one
    // SHORT, 6 (rotate 90 degrees clockwise to view).
    let exif = [
        &b"MM\0*"[..],
        &8u32.to_be_bytes(),
        &1u16.to_be_bytes(),
        &0x0112u16.to_be_bytes(),
        &3u16.to_be_bytes(),
        &1u32.to_be_bytes(),
        &6u16.to_be_bytes(),
        &[0, 0],
        &0u32.to_be_bytes(),
    ]
    .concat();
    let bytes = png_with_chunk(40, 20, &pixels, (png::chunk::eXIf, &exif));
    let whole = shown(&bytes, None, false, 256).unwrap();
    assert_eq!((whole.width, whole.height), (20, 40));
    let corner = shown(&bytes, Some([0.5, 0.0, 1.0, 0.25]), false, 256).unwrap();
    assert_eq!(corner.region_px, [10, 0, 20, 10]);
    let image = decoded(&corner);
    let (w, h) = image.dimensions();
    for (x, y) in [(0, 0), (w / 2, h / 2), (w - 1, h - 1)] {
        assert_eq!(image.get_pixel(x, y).0, [255, 0, 0], "({x}, {y})");
    }
    let left = shown(&bytes, Some([0.0, 0.0, 0.5, 0.25]), false, 256).unwrap();
    assert!(decoded(&left).pixels().all(|pixel| pixel.0 == [255; 3]));
}

#[test]
fn a_picture_over_the_byte_cap_is_shown_smaller_and_stays_png() {
    // Noise does not compress: as a 1280 px PNG it is well over the cap.
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let pixels = (0..1280 * 960 * 3)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect::<Vec<_>>();
    let bytes = png_of(1280, 960, png::ColorType::Rgb, &pixels);
    let shown = shown(&bytes, None, false, 1280).unwrap();
    assert_eq!(shown.picture.mime_type, "image/png");
    assert!(shown.picture.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert!(shown.picture.bytes.len() <= pictures::PICTURE_BYTES);
    let note = shown
        .notes
        .iter()
        .find(|note| note.starts_with("Shown at "))
        .expect("the step down is noted");
    let size = note["Shown at ".len()..].split(' ').next().unwrap();
    let size = size.parse::<u32>().unwrap();
    assert!(size < 1280, "{note}");
    assert!(shown.picture.width.max(shown.picture.height) <= size);
}

#[test]
fn regions_must_be_ordered_and_large_enough() {
    let bytes = red_square(400, 300, [0, 0, 10, 10]);
    let refused = |region: [f64; 4]| shown(&bytes, Some(region), true, 512).err().unwrap();
    for region in [
        [0.6, 0.2, 0.4, 0.4],
        [0.2, 0.2, 0.2, 0.4],
        [-0.1, 0.0, 0.5, 0.5],
    ] {
        let error = refused(region);
        assert_eq!(reason(&error), "BAD_REGION", "{region:?}");
        assert!(error.repair.as_deref().unwrap().contains("fractions"));
    }
    let tiny = refused([0.5, 0.5, 0.51, 0.51]);
    assert_eq!(tiny.message, "region is only 4 x 3 source pixels");
    // Values above 1 are pixels, all four of them.
    let pixels = shown(&bytes, Some([100.0, 30.0, 300.0, 150.0]), true, 512).unwrap();
    assert_eq!(pixels.region_px, [100, 30, 300, 150]);
    assert_eq!(pixels.region, [0.25, 0.1, 0.75, 0.5]);
    assert!(pixels.notes.contains(&"region read as pixels".to_owned()));
    // A strip narrower or shorter than its grid labels is still drawn.
    for strip in [[0.0, 0.0, 9.0, 300.0], [0.0, 0.0, 400.0, 9.0]] {
        let shown = shown(&bytes, Some(strip), true, 1280).unwrap();
        let [x, y, w, h] = shown.content;
        assert!(w.min(h) <= 40 && (x + w).max(y + h) <= 1280, "{strip:?}");
    }
}

#[test]
fn pictures_are_byte_identical() {
    let bytes = red_square(640, 480, [100, 100, 300, 200]);
    let one = shown(&bytes, Some([0.1, 0.1, 0.6, 0.5]), true, 1280).unwrap();
    let two = shown(&bytes, Some([0.1, 0.1, 0.6, 0.5]), true, 1280).unwrap();
    assert_eq!(one.picture.bytes, two.picture.bytes);
}

/* ----------------------------- the operations ---------------------------- */

use super::super::testing::{engine_available, Sandbox, PLATE};
#[cfg(unix)]
use super::super::testing::{wait_until, StandIn};

fn agent() -> Origin {
    Origin::Agent {
        session_id: "view-session".to_owned(),
    }
}

fn notes(result: &Value) -> Vec<String> {
    result["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| note.as_str().unwrap().to_owned())
        .collect()
}

/// The picture a result names, read back as a host does, after checking
/// it is a PNG of the reported size.
fn picture_of(root: &Path, result: &Value) -> Vec<u8> {
    let entry = &result["images"][0];
    assert_eq!(result["images"].as_array().unwrap().len(), 1);
    let picture = pictures::read_back(root, entry).unwrap();
    assert!(entry["path"]
        .as_str()
        .unwrap()
        .starts_with(".bureau/cache/views-v1/"));
    assert_eq!(entry["bytes"], picture.bytes.len());
    if picture.mime_type == "image/png" {
        let reader = png::Decoder::new(std::io::Cursor::new(picture.bytes.as_slice()))
            .read_info()
            .unwrap();
        assert_eq!(
            [reader.info().width, reader.info().height],
            [
                entry["widthPx"].as_u64().unwrap() as u32,
                entry["heightPx"].as_u64().unwrap() as u32
            ]
        );
    }
    picture.bytes
}

#[cfg(unix)]
fn stand_in_part(sandbox: &Sandbox) -> Value {
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Box", "source": "w = 20;\ncube([w, 10, 2]);\n"}),
        )
        .unwrap();
    assert_eq!(part["render"]["ok"], true, "{part}");
    part
}

#[cfg(unix)]
#[test]
fn a_part_is_drawn_from_its_stored_mesh_without_running_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let (renders, jobs) = (engine.renders(), sandbox.jobs("cad_render").len());
    let view = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"]}),
        )
        .unwrap();
    assert_eq!(engine.renders(), renders, "the engine did not run");
    assert_eq!(sandbox.jobs("cad_render").len(), jobs, "no job was opened");
    assert_eq!(view["mesh"]["source"], "stored");
    assert_eq!(
        view["mesh"]["outputHash"],
        sandbox.revision(&part["revisionId"])["payload"]["stl"]["sha256"]
    );
    assert_eq!(view["revisionId"], part["revisionId"]);
    assert_eq!(view["bounds"]["size"], json!([20.0, 10.0, 2.0]));
    let names = view["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["front", "top", "right", "iso"]);
    for orthographic in &view["views"].as_array().unwrap()[..3] {
        assert_eq!(orthographic["mmPerPx"], view["mmPerPx"]);
    }
    assert_eq!(view["views"][3]["toScale"], false);
    // No section was asked for: one through the middle, normal to y.
    let section = &view["sections"][0];
    assert_eq!(
        (&section["label"], &section["auto"], &section["plane"]),
        (&json!("A-A"), &json!(true), &json!("y=5.001"))
    );
    assert_eq!(
        section["loops"],
        json!(["material rectangle 20×2 centered (x=10, z=1)"])
    );
    let notes = notes(&view);
    assert!(
        notes[0].starts_with("Drawn from revision 1's stored mesh"),
        "{notes:?}"
    );
    assert!(notes
        .iter()
        .any(|note| note.contains("binds and verifies nothing")));
    let bytes = picture_of(&sandbox.root, &view);
    assert_eq!(
        view["images"][0]["sha256"],
        bureau_storage::sha256_hex(&bytes)
    );
    assert!(view.to_string().len() < 4_000, "{}", view.to_string().len());
    // Drawn again, the same picture.
    let again = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"]}),
        )
        .unwrap();
    assert_eq!(again["images"], view["images"]);
}

#[cfg(unix)]
#[test]
fn a_variant_is_drawn_from_a_render_job_and_nothing_is_saved() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let renders = engine.renders();
    let view = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"], "params": {"w": 25}, "views": ["top"], "sections": []}),
        )
        .unwrap();
    assert_eq!(engine.renders(), renders + 1);
    let jobs = sandbox.jobs("cad_render");
    assert_eq!(jobs.len(), 2);
    assert_eq!(
        jobs.iter()
            .filter(|job| job["status"] == "succeeded")
            .count(),
        2
    );
    assert_eq!(view["mesh"]["source"], "rendered");
    assert_eq!(view["mesh"]["params"], json!({"w": 25}));
    assert_eq!(view["sections"], json!([]));
    assert!(notes(&view)[0].starts_with("Drawn from a variant of revision 1 with params"));
    assert_eq!(
        sandbox.revisions(&part["artifactId"]).len(),
        1,
        "nothing was committed"
    );
    picture_of(&sandbox.root, &view);
}

#[cfg(unix)]
#[test]
fn a_stored_mesh_that_cannot_be_read_is_rendered_again_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    // The revision points at a mesh the object store does not hold.
    let missing = "ab".repeat(32);
    sandbox.with_handle(|handle| {
        handle
            .db
            .execute(
                "UPDATE revision SET payload=json_set(payload,'$.stl.sha256',?1,'$.renderIdentity.outputHash',?1) WHERE id=?2",
                rusqlite::params![missing, part["revisionId"].as_str().unwrap()],
            )
            .unwrap()
    });
    let view = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"]}),
        )
        .unwrap();
    assert_eq!(view["mesh"]["source"], "rendered");
    assert_eq!(
        notes(&view)[0],
        "The stored mesh could not be read; the part was rendered again for this picture."
    );
}

#[cfg(unix)]
#[test]
fn nothing_to_draw_is_refused_with_a_repair_before_a_job_opens() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let jobs = sandbox.jobs("cad_render").len();
    for params in [json!(null), json!({"w": 30})] {
        let mut input = json!({"artifactId": part["artifactId"], "views": [], "sections": []});
        if !params.is_null() {
            input["params"] = params;
        }
        let error = sandbox.call_as(agent(), "cad.view", input).unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("VALIDATION", "Nothing to draw")
        );
        assert_eq!(reason(&error), "NOTHING_TO_DRAW");
        assert!(error.repair.as_deref().unwrap().contains("\"views\""));
    }
    assert_eq!(sandbox.jobs("cad_render").len(), jobs);
    // Sections alone are something to draw.
    let sections = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"], "views": [], "sections": [{"axis": "z", "at": 1}]}),
        )
        .unwrap();
    assert_eq!(sections["views"], json!([]));
    assert_eq!(sections["sections"][0]["plane"], "z=1");
}

#[cfg(unix)]
#[test]
fn a_variant_view_renders_with_the_lock_released() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    engine.hold();
    let renders = engine.renders();
    std::thread::scope(|scope| {
        let viewer = scope.spawn(|| {
            sandbox.call_as(
                agent(),
                "cad.view",
                json!({"artifactId": part["artifactId"], "params": {"w": 22}}),
            )
        });
        wait_until("the variant to be rendering", || {
            engine.renders() == renders + 1
        });
        // Held open: reads and writes are served meanwhile.
        assert!(sandbox.call("artifact.list", json!({})).is_ok());
        assert!(sandbox
            .call("project.update_intent", json!({"intent": "meanwhile"}))
            .is_ok());
        assert!(!viewer.is_finished());
        engine.release();
        let view = viewer.join().unwrap().unwrap();
        assert_eq!(view["mesh"]["source"], "rendered");
    });
}

fn write_input(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn image_view_shows_a_project_file_and_refuses_paths_outside_it() {
    let sandbox = Sandbox::new();
    let root = sandbox.root.clone();
    let drawing = red_square(400, 300, [200, 100, 220, 120]);
    write_input(&root, "inputs/drawing.png", &drawing);
    let shown = sandbox
        .call_as(
            agent(),
            "image.view",
            json!({"path": "inputs/drawing.png", "region": [0.4, 0.2, 0.6, 0.5]}),
        )
        .unwrap();
    assert_eq!(shown["path"], "inputs/drawing.png");
    assert_eq!(shown["format"], "png");
    assert_eq!(shown["sha256"], bureau_storage::sha256_hex(&drawing));
    assert_eq!(
        (&shown["widthPx"], &shown["heightPx"]),
        (&json!(400), &json!(300))
    );
    assert_eq!(shown["regionPx"], json!([160, 60, 240, 150]));
    assert!(shown["grid"]["x"].as_array().unwrap().len() >= 5);
    picture_of(&root, &shown);
    // The same file by other names.
    let dotted = sandbox
        .call_as(
            agent(),
            "image.view",
            json!({"path": "./inputs/drawing.png"}),
        )
        .unwrap();
    assert_eq!(dotted["path"], "inputs/drawing.png");
    let elsewhere = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        // An absolute path through a link to the project is inside it.
        let link = elsewhere.path().join("project-link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let absolute = sandbox
            .call_as(
                agent(),
                "image.view",
                json!({"path": link.join("inputs/drawing.png")}),
            )
            .unwrap();
        assert_eq!(absolute["path"], "inputs/drawing.png");
        std::os::unix::fs::symlink(elsewhere.path(), root.join("escape")).unwrap();
    }
    write_input(elsewhere.path(), "secret.png", &drawing);
    let picture = dotted["images"][0]["path"].as_str().unwrap().to_owned();
    let mut refused = vec![
        json!("../secret.png"),
        json!(elsewhere.path().join("secret.png")),
        json!(".bureau/state.sqlite"),
        json!("bureau.project.json"),
        json!(picture),
    ];
    if cfg!(unix) {
        refused.push(json!("escape/secret.png"));
    }
    for path in refused {
        let error = sandbox
            .call_as(agent(), "image.view", json!({"path": path}))
            .unwrap_err();
        assert_eq!(error.code, "PATH_OUTSIDE_PROJECT", "{path}: {error}");
    }
    let error = sandbox
        .call_as(agent(), "image.view", json!({"path": picture}))
        .unwrap_err();
    assert_eq!(
        error.repair.as_deref(),
        Some("That is a cad_view picture; call cad_view again with fewer views, a section, or a larger size.")
    );
    let missing = sandbox
        .call_as(agent(), "image.view", json!({"path": "inputs/none.png"}))
        .unwrap_err();
    assert_eq!(
        (missing.code.as_str(), missing.message.as_str()),
        ("NOT_FOUND", "Image file not found: inputs/none.png")
    );
    // Not an image: refused with a way forward.
    write_input(&root, "inputs/drawing.pdf", b"%PDF-1.7");
    let pdf = sandbox
        .call_as(agent(), "image.view", json!({"path": "inputs/drawing.pdf"}))
        .unwrap_err();
    assert_eq!(reason(&pdf), "UNSUPPORTED_IMAGE");
}

#[test]
fn pictures_are_refused_on_a_read_only_project() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    bureau_storage::ProjectHandle::create(&root, "Future", "test").unwrap();
    write_input(
        &root,
        "inputs/drawing.png",
        &red_square(64, 64, [0, 0, 8, 8]),
    );
    let marker = root.join("bureau.project.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value["version"] = json!(999);
    fs::write(&marker, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
    let opened = app
        .dispatch("project.open", json!({"path": root}), Origin::User, None)
        .unwrap();
    assert_eq!(opened["readOnly"], true);
    let core = Arc::new(std::sync::Mutex::new(app));
    for (op, input) in [
        ("image.view", json!({"path": "inputs/drawing.png"})),
        (
            "cad.view",
            json!({"artifactId": "00000000-0000-4000-8000-000000000001"}),
        ),
    ] {
        let error = dispatch_shared(
            &core,
            op,
            input,
            agent(),
            opened["projectId"].as_str(),
            None,
        )
        .unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("READ_ONLY", "Project is read-only"),
            "{op}"
        );
    }
    assert!(!root.join(pictures::DIR).exists(), "nothing was written");
}

#[test]
fn a_rendered_plate_is_drawn_with_its_sections() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Sensor plate", "source": PLATE, "timeoutMs": 60_000}),
        )
        .unwrap();
    assert_eq!(part["render"]["ok"], true, "{part}");
    let view = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"], "sections": [{"axis": "z", "at": 2}], "size": 768}),
        )
        .unwrap();
    assert_eq!(view["mesh"]["source"], "stored");
    let section = &view["sections"][0];
    assert_eq!(
        (&section["label"], &section["plane"]),
        (&json!("A-A"), &json!("z=2"))
    );
    assert!(section.get("auto").is_none());
    let holes = section["loops"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item.as_str().unwrap().starts_with("cut-out circle d=3.2"))
        .count();
    assert_eq!(holes, 4, "{section}");
    assert_eq!(section["openChains"], 0);
    assert_eq!(view["bounds"]["size"], json!([40.0, 30.0, 4.0]));
    let bytes = picture_of(&sandbox.root, &view);
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert!(
        view["images"][0]["widthPx"]
            .as_u64()
            .unwrap()
            .max(view["images"][0]["heightPx"].as_u64().unwrap())
            <= 768
    );
}

/// The automatic section of this plate, y = 25.001, crosses the bottom-face
/// edge from the corner (0, 50) to the hole vertex (7.5, 10) at x =
/// 4.6873125, a half-micron that the two triangles sharing the edge rounded
/// to neighbouring keys: the picture drew half the part and called the mesh
/// open.
#[test]
fn the_automatic_section_of_a_slotted_plate_closes_every_loop() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let source = "$fn = 64;\nw = 80; d = 50; t = 6;\ndifference() {\n  cube([w, d, t]);\n  for (x = [10, 70]) for (y = [10, 40]) translate([x, y, -1]) cylinder(d = 5, h = t + 2);\n  translate([40, 25, -1]) cylinder(d = 20, h = t + 2);\n  translate([-1, 20, 4]) cube([w + 2, 10, 3]);\n}\n";
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Slotted plate", "source": source, "timeoutMs": 60_000}),
        )
        .unwrap();
    assert_eq!(part["render"]["ok"], true, "{part}");
    let view = sandbox
        .call_as(
            agent(),
            "cad.view",
            json!({"artifactId": part["artifactId"], "views": ["front"], "size": 512}),
        )
        .unwrap();
    let section = &view["sections"][0];
    assert_eq!(
        (&section["plane"], &section["auto"]),
        (&json!("y=25.001"), &json!(true)),
        "{section}"
    );
    assert_eq!(section["openChains"], 0, "{section}");
    assert_eq!(
        section["loops"],
        json!([
            "material rectangle 30×4 centered (x=15, z=2)",
            "material rectangle 30×4 centered (x=65, z=2)"
        ])
    );
}
