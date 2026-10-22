//! The drawing sheet: views placed as in a third-angle drawing (top above
//! front, right beside it, left and back further out, bottom below), the
//! isometric view in the top right corner, sections in a row underneath and
//! a footer with the scale bar. Every orthographic view and section shares
//! one round scale, so a feature can be followed from view to view.
use super::raster::{section_panel, view_panel, Canvas, Placement, Topology, FRAME, INK};
use super::*;

const MARGIN: usize = 10;
const GAP: usize = 16;
/// Pixels added around the content of a panel, one on each side.
const PAD: usize = 2;
/// Smallest isometric cell, in pixels each way.
const ISO_MIN: usize = 96;
const LETTERS: [char; 4] = ['A', 'B', 'C', 'D'];

/// Round scales in mm per pixel: these mantissas, in hundredths, times a
/// power of ten.
const SCALES: [f64; 10] = [
    100.0, 125.0, 150.0, 200.0, 250.0, 300.0, 400.0, 500.0, 600.0, 800.0,
];
/// Lengths a scale bar may stand for, in hundredths, times a power of ten.
const BAR_LENGTHS: [f64; 3] = [100.0, 200.0, 500.0];

/// What the sheet is drawn from that does not depend on the scale.
struct Plan<'a> {
    spec: &'a Spec,
    /// Text scale: 2 on sheets of 640 pixels or more.
    k: usize,
    label_h: usize,
    footer_h: usize,
    /// Model extent of each column and row of the grid, mm.
    column_mm: [f64; 4],
    row_mm: [f64; 3],
    used_columns: [bool; 4],
    used_rows: [bool; 3],
    has_iso: bool,
    view_labels: Vec<String>,
    /// Width and height of each section, mm.
    section_mm: Vec<[f64; 2]>,
    section_labels: Vec<String>,
    /// The overall x extent, which the scale bar is sized to.
    x_mm: f64,
    /// The largest extent: past it, a larger scale shrinks nothing more.
    largest_mm: f64,
    footer: String,
}

/// Where everything goes at one scale.
struct Layout {
    scale: f64,
    width: usize,
    height: usize,
    columns: [(usize, usize); 4],
    rows: [(usize, usize); 3],
    sections: Vec<(usize, usize)>,
    section_row: (usize, usize),
    /// Labels widened their columns; otherwise they are clipped to their panels.
    widened: bool,
}

/// The smallest round length at least `value`: 1, 2 or 5 × 10^e.
fn bar_length(value: f64) -> f64 {
    round_at_least(&BAR_LENGTHS, value)
}

fn axis_letter(direction: P3) -> &'static str {
    let index = (0..3)
        .max_by(|a, b| direction[*a].abs().total_cmp(&direction[*b].abs()))
        .unwrap_or(0);
    ["X", "Y", "Z"][index]
}

impl Plan<'_> {
    fn text_w(&self, text: &str) -> usize {
        font::width(text, self.k)
    }

    fn scale_line(&self, scale: f64) -> (Option<(f64, usize)>, String) {
        let to_scale = self.spec.views.iter().any(|view| *view != ViewName::Iso)
            || !self.spec.sections.is_empty();
        if !to_scale {
            return (None, "NOT TO SCALE".to_owned());
        }
        let bar = bar_length((self.x_mm / 6.0).max(20.0 * scale));
        let bar_px = (bar / scale).round() as usize;
        (
            Some((bar, bar_px)),
            format!("{} MM   SCALE {scale} MM/PX", number(bar)),
        )
    }

    fn arrange(&self, scale: f64, widen: bool) -> Layout {
        let px = |mm: f64| (mm / scale).ceil() as usize + PAD;
        let mut column_w: [usize; 4] = std::array::from_fn(|c| {
            if self.used_columns[c] {
                px(self.column_mm[c])
            } else {
                0
            }
        });
        let mut row_h: [usize; 3] = std::array::from_fn(|r| {
            if self.used_rows[r] {
                px(self.row_mm[r])
            } else {
                0
            }
        });
        if self.has_iso {
            column_w[2] = column_w[2].max(ISO_MIN);
            row_h[0] = row_h[0].max(ISO_MIN);
        }
        if widen {
            for (view, label) in self.spec.views.iter().zip(&self.view_labels) {
                let (c, _) = view.cell();
                column_w[c] = column_w[c].max(self.text_w(label));
            }
        }
        let mut columns = [(0, 0); 4];
        let mut x = MARGIN;
        for c in 0..4 {
            if self.used_columns[c] {
                columns[c] = (x, column_w[c]);
                x += column_w[c] + GAP;
            }
        }
        let views_w = if x > MARGIN {
            x - GAP + MARGIN
        } else {
            2 * MARGIN
        };
        let mut sections = Vec::new();
        let mut x = MARGIN;
        for (mm, label) in self.section_mm.iter().zip(&self.section_labels) {
            let mut w = px(mm[0]);
            if widen {
                w = w.max(self.text_w(label));
            }
            sections.push((x, w));
            x += w + GAP;
        }
        let sections_w = if x > MARGIN {
            x - GAP + MARGIN
        } else {
            2 * MARGIN
        };
        let section_h = self
            .section_mm
            .iter()
            .map(|mm| px(mm[1]))
            .max()
            .unwrap_or(0);
        let (bar, line) = self.scale_line(scale);
        let footer_w = (bar.map_or(0, |(_, bar_px)| bar_px + font::ADVANCE * self.k)
            + self.text_w(&line))
        .max(self.text_w(&self.footer));
        let width = views_w
            .max(sections_w)
            .max((footer_w + 2 * MARGIN).min(self.spec.size));
        let mut rows = [(0, 0); 3];
        let mut y = MARGIN + self.label_h;
        for r in 0..3 {
            if self.used_rows[r] {
                rows[r] = (y, row_h[r]);
                y += row_h[r] + GAP + self.label_h;
            }
        }
        let mut section_row = (0, 0);
        if !sections.is_empty() {
            section_row = (y, section_h);
            y += section_h + GAP + self.label_h;
        }
        let height = y - GAP - self.label_h + self.footer_h + MARGIN;
        Layout {
            scale,
            width,
            height,
            columns,
            rows,
            sections,
            section_row,
            widened: widen,
        }
    }
}

/// Draw the sheet for `spec`. Pure and deterministic.
pub(super) fn draw(
    mesh: &mesh::Mesh,
    topology: &Topology,
    spec: &Spec,
    footer: &Footer,
) -> Drawing {
    let plan = plan(topology, spec, footer);
    let cuts = spec
        .sections
        .iter()
        .map(|cut| section::Section::from_mesh(mesh, cut.axis, cut.at))
        .collect::<Vec<_>>();
    let layout = choose(&plan);
    render(mesh, topology, &plan, &layout, cuts)
}

/// Width and height of the sheet at `scale`, labels widening their columns.
#[cfg(test)]
pub(super) fn size_at(topology: &Topology, spec: &Spec, footer: &Footer, scale: f64) -> [usize; 2] {
    let layout = plan(topology, spec, footer).arrange(scale, true);
    [layout.width, layout.height]
}

fn plan<'a>(topology: &Topology, spec: &'a Spec, footer: &Footer) -> Plan<'a> {
    let k = if spec.size >= 640 { 2 } else { 1 };
    let extent = |name: ViewName| topology.extent(&name.frame());
    let tiny = 1e-6;
    let front = extent(ViewName::Front);
    let right = extent(ViewName::Right);
    let (x_mm, y_mm, z_mm) = (
        (front[1] - front[0]).max(tiny),
        (right[1] - right[0]).max(tiny),
        (front[3] - front[2]).max(tiny),
    );
    let mut used_columns = [false; 4];
    let mut used_rows = [false; 3];
    for view in &spec.views {
        let (c, r) = view.cell();
        used_columns[c] = true;
        used_rows[r] = true;
    }
    let view_labels = spec
        .views
        .iter()
        .map(|view| {
            if *view == ViewName::Iso {
                return "ISO  NOT TO SCALE".to_owned();
            }
            let frame = view.frame();
            let e = extent(*view);
            format!(
                "{}  {} {}  {} {}",
                view.label(),
                axis_letter(frame.right),
                number(e[1] - e[0]),
                axis_letter(frame.up),
                number(e[3] - e[2])
            )
        })
        .collect::<Vec<_>>();
    let section_mm = spec
        .sections
        .iter()
        .map(|cut| {
            let e = topology.extent(&cut.frame());
            [(e[1] - e[0]).max(tiny), (e[3] - e[2]).max(tiny)]
        })
        .collect::<Vec<_>>();
    let section_labels = spec
        .sections
        .iter()
        .zip(LETTERS)
        .map(|(cut, letter)| {
            format!(
                "SECTION {letter}-{letter}  {}={}{}",
                ["X", "Y", "Z"][cut.axis],
                number(cut.at),
                if cut.auto { "  AUTO" } else { "" }
            )
        })
        .collect::<Vec<_>>();
    let mut footer_text = format!("DIAGNOSTIC VIEW  REV {}", footer.revision_seq);
    if footer.variant {
        footer_text.push_str("  VARIANT");
    }
    footer_text.push_str("  MESH ");
    footer_text.push_str(
        &footer
            .mesh_hash
            .chars()
            .take(8)
            .collect::<String>()
            .to_uppercase(),
    );
    Plan {
        spec,
        k,
        label_h: font::HEIGHT * k + 6,
        footer_h: 2 * font::LINE * k + 8,
        column_mm: [y_mm, x_mm, y_mm, x_mm],
        row_mm: [y_mm, z_mm, y_mm],
        used_columns,
        used_rows,
        has_iso: spec.views.contains(&ViewName::Iso),
        view_labels,
        section_mm,
        section_labels,
        x_mm,
        largest_mm: x_mm.max(y_mm).max(z_mm),
        footer: footer_text,
    }
}

/// The smallest round scale whose sheet fits the requested size, with labels
/// widening their columns when that fits at any scale, and clipped to their
/// panels when it does not.
fn choose(plan: &Plan) -> Layout {
    let rows = plan.used_rows.iter().filter(|used| **used).count()
        + usize::from(!plan.section_mm.is_empty());
    let columns = plan.used_columns.iter().filter(|used| **used).count();
    let size = plan.spec.size as f64;
    let room = |fixed: usize| (size - fixed as f64).max(1.0);
    let views_mm: f64 = (0..4)
        .filter(|c| plan.used_columns[*c])
        .map(|c| plan.column_mm[c])
        .sum();
    let sections_mm: f64 = plan.section_mm.iter().map(|mm| mm[0]).sum();
    let height_mm: f64 = (0..3)
        .filter(|r| plan.used_rows[*r])
        .map(|r| plan.row_mm[r])
        .sum::<f64>()
        + plan.section_mm.iter().map(|mm| mm[1]).fold(0.0, f64::max);
    let lower = (views_mm / room(2 * MARGIN + GAP * columns.saturating_sub(1)))
        .max(sections_mm / room(2 * MARGIN + GAP * plan.section_mm.len().saturating_sub(1)))
        .max(
            height_mm
                / room(
                    2 * MARGIN + rows * plan.label_h + GAP * rows.saturating_sub(1) + plan.footer_h,
                ),
        );
    let start = first_round_index(&SCALES, lower);
    // Past the largest extent every panel is a few pixels; a larger scale
    // shrinks nothing more.
    let end = first_round_index(&SCALES, plan.largest_mm).max(start);
    for widen in [true, false] {
        for index in start..=end {
            let layout = plan.arrange(round_value(&SCALES, index), widen);
            if layout.width.max(layout.height) <= plan.spec.size {
                return layout;
            }
        }
    }
    plan.arrange(round_value(&SCALES, end), false)
}

fn render(
    mesh: &mesh::Mesh,
    topology: &Topology,
    plan: &Plan,
    layout: &Layout,
    cuts: Vec<section::Section>,
) -> Drawing {
    let k = plan.k;
    let mut canvas = Canvas::new(layout.width, layout.height);
    let mut panels = Vec::new();
    let mut labels = Vec::new();
    for (view, label) in plan.spec.views.iter().zip(&plan.view_labels) {
        let (c, r) = view.cell();
        let ((x, w), (y, h)) = (layout.columns[c], layout.rows[r]);
        let frame = view.frame();
        let extent = topology.extent(&frame);
        let iso = *view == ViewName::Iso;
        let scale = if iso {
            ((extent[1] - extent[0]) / (w as f64 - 4.0))
                .max((extent[3] - extent[2]) / (h as f64 - 4.0))
                .max(1e-9)
        } else {
            layout.scale
        };
        let placement = Placement::centred(extent, scale, w, h);
        let panel = view_panel(mesh, topology, &frame, &placement, (w, h), !iso);
        canvas.blit(&panel, x as i64, y as i64);
        labels.push((label.as_str(), x, y, w));
        panels.push(Panel {
            kind: PanelKind::View(*view),
            rect: [x, y, w, h],
            frame,
            placement,
            to_scale: !iso,
        });
    }
    let (y, h) = layout.section_row;
    for (((cut, measured), label), (x, w)) in plan
        .spec
        .sections
        .iter()
        .zip(cuts)
        .zip(&plan.section_labels)
        .zip(&layout.sections)
    {
        let frame = cut.frame();
        let placement = Placement::centred(topology.extent(&frame), layout.scale, *w, h);
        let panel = section_panel(&measured, &placement, (*w, h), k);
        canvas.blit(&panel, *x as i64, y as i64);
        labels.push((label.as_str(), *x, y, *w));
        panels.push(Panel {
            kind: PanelKind::Section {
                cut: *cut,
                measured,
            },
            rect: [*x, y, *w, h],
            frame,
            placement,
            to_scale: true,
        });
    }
    for (label, x, y, w) in labels {
        let (x, y) = (x as i64, y as i64);
        let shown = if layout.widened {
            label
        } else {
            font::clip(label, w, k)
        };
        canvas.text(shown, x, y - plan.label_h as i64 + 3, k);
    }
    for panel in &panels {
        let [x, y, w, h] = panel.rect.map(|value| value as i64);
        canvas.outline(x - 1, y - 1, w + 2, h + 2, FRAME);
    }
    // Footer: the scale bar and what the picture is.
    let room = layout.width - 2 * MARGIN;
    let line = (font::LINE * k) as i64;
    let top = layout.height as i64 - MARGIN as i64 - 2 * line;
    let (bar, text) = plan.scale_line(layout.scale);
    let mut x = MARGIN as i64;
    if let Some((_, bar_px)) = bar {
        let bar_px = bar_px.min(room) as i64;
        for i in 0..bar_px {
            for j in 0..2 {
                canvas.set(x + i, top + 3 * k as i64 + j, INK);
            }
        }
        for j in 0..(font::HEIGHT * k) as i64 {
            canvas.set(x, top + j, INK);
            canvas.set(x + bar_px - 1, top + j, INK);
        }
        x += bar_px + (font::ADVANCE * k) as i64;
    }
    let rest = (MARGIN + room).saturating_sub(x as usize);
    canvas.text(font::clip(&text, rest, k), x, top, k);
    canvas.text(
        font::clip(&plan.footer, room, k),
        MARGIN as i64,
        top + line,
        k,
    );
    let to_scale = panels.iter().any(|panel| panel.to_scale);
    Drawing {
        canvas,
        panels,
        scale: to_scale.then_some(layout.scale),
    }
}

#[cfg(test)]
pub(super) fn round_scales(from: f64, count: usize) -> Vec<f64> {
    let start = first_round_index(&SCALES, from);
    (start..start + count as i64)
        .map(|index| round_value(&SCALES, index))
        .collect()
}
