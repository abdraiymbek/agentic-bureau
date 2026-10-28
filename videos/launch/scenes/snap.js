// Into one record: on the cut the terminal's text is ~200 hairline segments. A
// wave front, led by the thread's head along the thread, sweeps left to right
// and snaps each segment into its slot — node outlines, title bars, the recorded
// links' routed runs (gutter stubs and buses, lanes between rows), label bars and
// the thread itself (the fragments from shot 2, re-forming). As a
// node's outline lands it resolves into the real Flow map (the three objects the
// agent's recorded calls touched wear the soft agent-touch ring); heads and links
// follow. The camera lays the record back in 3D, then everything but the thread
// breathes out, the thread lying flat on its y for the cut to the Paper title.
import { E, clamp, lerp, prog, ez, rng, noise1, words, $$ } from '../lib/core.js';
import { reveal } from '../lib/type.js';
import { threadY, createThread } from '../lib/film.js';
import { createLineField } from '../lib/lines.js';
import { NODES, LINKS, HEADS, GROUPS, COL_INDEX, NW, NH, linkPath } from '../lib/flowmap.js';
import { createFlowMap, FLOWMAP_CSS, FLOWMAP_ICONS } from '../lib/flowmapView.js';

let S;

// Times (global seconds).
const FRONT_A = 6.04; // the front leaves the left edge
const FRONT_B = 7.0; // and locks at the right
const LOCK = 7.0; // thread fragments fuse into one line
const TILT_A = 6.9;
const TILT_B = 7.5;
const BREATH = 7.5;
const COPY_AT = 6.25;

const PAY = NODES.find((n) => n.id === 'payload'); // its centre row is the thread
// Only the objects the agent's recorded calls touched (pieces.js CALLS) wear the
// agent-touch ring; everything else resolves without it.
const AGENT_TOUCHED = new Set(['payload', 'mass', 'ramp']);
// Wheel radius (loaded) was drafted and never accepted: no approved baseline.
const marks = (id) => (id === 'wheel' ? 'ring' : '');
// Type groups, with the Design column's "Mechanical" label lifted clear of the
// Payload capacity row so the thread passes under it instead of striking it: 5 px
// centres its glyphs (top + 4 … top + 14) between the lane above it (y 147, the
// clear band lib/flowmap.js routes through) and the thread (173), ~7 px each side,
// so neither the lane nor the thread runs into it.
const GROUPS_S = GROUPS.map(([x, y, l, n]) => [x, y, l, n, l === 'Mechanical' ? -5 : 0]);
// The quiet row past Payload capacity ends at the Design column: it fades out
// behind the Components column's nodes and is gone by the column's left edge, so
// it never runs on into Usable pack energy (on the row) or out to the frame edge
// as if it were a link.
const DESIGN_X = HEADS.find(([, l]) => l === 'Design')[0];
const ROW_END = [DESIGN_X - 160, DESIGN_X - 8];
// 9:16 holds on Intent until Payload capacity (the thread's row, drafted by the
// agent) has its title up, keeping it whole to ~6.85, then trucks left along the
// thread so the consequence columns slide in after the inputs (space follows
// causality) and settle with the lay-back.
const TRUCK_P = 560;
const TRUCK_A = 6.66;
const TRUCK_B = 7.45;

// The terminal's last frame (pieces.js at 5.999, screen px): where the segments
// sit on the cut. Rows are [x0, x1, centre y at x0, centre y at x1, half-height,
// weight]. The committed request's two rows and the live prompt on the thread
// ('>' and the cursor block), IBM Plex Mono centred above its baseline; the
// activity rail's head and its three calls (tool, then object chip), sloping a
// little with the camera's turn.
const CUT_TEXT = {
  land: [[160, 1263, 360, 360, 24, 1], [225, 1166, 441, 441, 24, 1], [162, 192, 524, 524, 9, 1.4], [225, 257, 516.6, 516.6, 18, 2.4]],
  port: [[80, 1014, 807.7, 807.7, 20, 1], [135, 931, 876.4, 876.4, 20, 1], [82, 107, 946, 946, 8, 1.4], [135, 162, 940.2, 940.2, 15, 2.4]],
};
const CUT_RAIL = {
  land: [[1338, 1632, 619.5, 620.5, 8, 1], [1338, 1643, 698, 701, 8, 1], [1342, 1590, 743.3, 745.5, 12, 1], [1338, 1556, 818.3, 822.3, 8, 1],
    [1342, 1614, 863.6, 868.5, 12, 1], [1338, 1585, 938.6, 945.5, 8, 1], [1342, 1709, 984.1, 994, 12, 1]],
  port: [[142, 471, 1080.5, 1084, 10, 1], [142, 483, 1154.6, 1160.6, 10, 1], [145, 424, 1199.5, 1204.1, 15, 1], [142, 386, 1270.9, 1278.1, 10, 1],
    [145, 451, 1315.9, 1324.6, 15, 1], [142, 418, 1387.4, 1399.1, 10, 1], [145, 558, 1432.6, 1449.4, 15, 1]],
};
// The thread's stub on the cut: the live prompt's baseline, up to the cursor (alpha 0.24).
const CUT_THREAD = { land: 224.9, port: 134.9 };
/** A row by weighted length, for u in [0, 1). */
function pickRow(rows, u) {
  const w = rows.map((q) => (q[1] - q[0]) * q[5]);
  let acc = u * w.reduce((s, v) => s + v, 0);
  for (let i = 0; i < rows.length; i++) if ((acc -= w[i]) < 0) return rows[i];
  return rows.at(-1);
}

// Map placement: Payload capacity's centre row sits on the thread. 9:16 keeps the
// map at a readable size, Intent at the left margin, the rest off the right edge.
function layout(ctx) {
  const TY = threadY(ctx);
  const s = ctx.portrait ? 0.95 : 1.08;
  const ox = ctx.portrait ? 80 : 160;
  const oy = TY - PAY.cy * s;
  // The tilt's pivot: Payload capacity in 16:9; the frame's centre after the truck in 9:16.
  const pivot = ctx.portrait ? [ctx.W / 2 + TRUCK_P, TY] : [ox + PAY.cx * s, TY];
  // The loose cloud's depth spreads about the frame's centre while it is loose.
  const parX = ctx.portrait ? ctx.W / 2 + 120 : pivot[0];
  return { TY, s, ox, oy, pivot, parX };
}

export default function create(span) {
  return {
    id: 'snap',
    span,
    icons: FLOWMAP_ICONS,
    css:
      FLOWMAP_CSS +
      `
#s-snap { background: var(--field); }
#s-snap .cam { position: absolute; inset: 0; perspective: 1400px; }
#s-snap .plane { position: absolute; inset: 0; transform-origin: 0 0; }
#s-snap .mapwrap { position: absolute; inset: 0; }
#s-snap canvas.segs { position: absolute; left: 0; top: 0; }
#s-snap .fm .node, #s-snap .fm > svg, #s-snap .thread { will-change: transform; }
#s-snap .fm .node .tr { position: absolute; inset: -1px; border-radius: 12px; border: 1.5px solid rgba(207, 243, 110, 0.62);
  box-shadow: 0 0 0 1px rgba(207, 243, 110, 0.2); opacity: 0; will-change: opacity; pointer-events: none; }
#s-snap .thread .hd { box-shadow: 0 0 6px 2px rgba(255,255,255,0.85); }
#s-snap .fm .grp { background: var(--field); padding: 0 8px 3px 0; }
#s-snap .copy { position: absolute; left: 160px; font: 600 88px/1 var(--font-sans); letter-spacing: -0.032em; color: var(--text); white-space: nowrap; }
#s-snap .copy .ln { position: absolute; left: 0; top: 0; }
#s-snap.portrait .copy { left: 80px; font-size: 108px; }
`,
    build(root, ctx) {
      root.classList.toggle('portrait', ctx.portrait);
      const { W, H, portrait } = ctx;
      const L = layout(ctx);
      const { TY, s, ox, oy } = L;
      const lines = portrait ? ['into one', 'record'] : ['into one record'];
      // The segment canvas spans the plane the camera will see: in 9:16 that runs
      // past the right edge by the truck.
      const CW = portrait ? W + TRUCK_P + 360 : W;
      root.innerHTML = `
        <div class="cam"><div class="plane"><div class="mapwrap"></div><canvas class="segs" width="${CW}" height="${H}" style="width:${CW}px;height:${H}px"></canvas></div></div>
        <div class="copy">${lines.map((l) => `<div class="ln">${words(l)}</div>`).join('')}</div>`;
      const plane = root.querySelector('.plane');
      const mapwrap = root.querySelector('.mapwrap');
      const canvas = root.querySelector('canvas');
      const g = canvas.getContext('2d');
      const thread = createThread(plane, ctx, { y: TY });
      plane.insertBefore(thread.el, plane.firstChild);
      // For the breath: a second thread outside the tilted plane, flat on the
      // thread's y, so the cut to the title hands over a horizontal hairline.
      const flat = createThread(root, ctx, { y: TY });
      root.querySelector('.cam').style.perspectiveOrigin = `${W / 2}px ${TY}px`;
      const fm = createFlowMap(mapwrap);
      fm.el.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;

      // Copy on its baseline(s): bottom-left, H − 120 in 16:9; the headline slot
      // (two lines, 108 px) in 9:16, above the map.
      const copy = root.querySelector('.copy');
      const fs = portrait ? 108 : 88;
      g.font = `600 ${fs}px Geist`;
      const m = g.measureText('into');
      const asc = m.fontBoundingBoxAscent;
      const desc = m.fontBoundingBoxDescent;
      const toBase = (fs - (asc + desc)) / 2 + asc;
      const bases = portrait ? [360, 474] : [H - 120];
      $$('.ln', copy).forEach((el, i) => (el.style.top = `${bases[i] - toBase}px`));

      // ---------------------------------------------------------------- targets
      const X = (x) => ox + x * s;
      const Y = (y) => oy + y * s;
      const T = [];
      const add = (x, y, a, len, meta) => T.push({ x, y, a, len, ...meta });
      const hLine = (x0, x1, y, meta) => add((X(x0) + X(x1)) / 2, Y(y), 0, (x1 - x0) * s, meta);
      const vLine = (x, y0, y1, meta) => add(X(x), (Y(y0) + Y(y1)) / 2, Math.PI / 2, (y1 - y0) * s, meta);

      // Node outlines (four edges, corners left open) and a title bar each.
      g.font = '400 16px Geist';
      const INS = 9;
      for (const n of NODES) {
        hLine(n.x + INS, n.x + NW - INS, n.y, { kind: 'edge', node: n.id });
        hLine(n.x + INS, n.x + NW - INS, n.y + NH, { kind: 'edge', node: n.id });
        vLine(n.x, n.y + INS, n.y + NH - INS, { kind: 'edge', node: n.id });
        vLine(n.x + NW, n.y + INS, n.y + NH - INS, { kind: 'edge', node: n.id });
        const tw = Math.min(g.measureText(n.label).width * 0.6, 104);
        hLine(n.x + 43, n.x + 43 + tw, n.cy, { kind: 'bar', node: n.id });
      }

      // Gutter runs along each recorded link's routed path (lib/flowmap.js
      // linkPath): a port stub where it leaves or enters a gutter, a bus where it
      // changes height in a gutter, a lane run where it crosses a column between
      // rows; a link within one column is a bracket on the column's right. Runs
      // that links share (Payload capacity's three, the pack's three) are laid once.
      const runs = new Map();
      const run = (key, l, mk) => {
        let rn = runs.get(key);
        if (!rn) {
          const i0 = T.length;
          mk();
          runs.set(key, (rn = { idxs: T.slice(i0).map((_, k) => i0 + k), links: [] }));
        }
        rn.links.push(l);
      };
      const stub = (x0, x1, y, l) => run(`h:${x0}:${x1}:${y}`, l, () => hLine(x0, x1, y, { kind: 'stub' }));
      // Type-group labels a lane may pass behind (it leaves them clear).
      g.font = '400 14px Geist';
      const grpBox = GROUPS_S.map(([x, y0, l, n, dy]) => [x - 6, x + g.measureText(`${l} ${n}`).width + 14, y0 + dy - 2, y0 + dy + 19]);
      const lane = (x0, x1, y, l) =>
        run(`l:${x0}:${y}`, l, () => {
          const n = Math.max(1, Math.round((x1 - x0 - 8) / 62));
          const step = (x1 - x0 - 8) / n;
          for (let i = 0; i < n; i++) {
            const a0 = x0 + 4 + i * step + 3;
            const a1 = x0 + 4 + (i + 1) * step - 3;
            if (grpBox.some(([b0, b1, c0, c1]) => y > c0 && y < c1 && a1 > b0 && a0 < b1)) continue;
            hLine(a0, a1, y, { kind: 'lane' });
          }
        });
      const bus = [[], [], [], []];
      for (const l of LINKS) {
        const { a, b } = l;
        if (a.x === b.x) {
          const xr = a.x + NW;
          stub(xr + 2, xr + 30, a.cy, l);
          run(`v:${l.key}`, l, () => vLine(xr + 34, a.cy, b.cy, { kind: 'stub' }));
          stub(xr + 2, xr + 30, b.cy, l);
          continue;
        }
        // Walk the path: horizontal runs (L) and gutter bends (C, via the gutter's middle).
        const tk = linkPath(l).match(/[MLC]|-?\d+(?:\.\d+)?/g);
        let x = 0;
        let y = 0;
        for (let i = 0; i < tk.length; ) {
          const c = tk[i++];
          const v = () => Number(tk[i++]);
          if (c === 'M') {
            x = v();
            y = v();
          } else if (c === 'L') {
            const nx = v();
            const ny = v();
            // Across a column through the gap between its rows, or straight over a gutter.
            if (COL_INDEX[x] !== undefined && nx - x === NW) lane(x, nx, ny, l);
            else if (nx - x > 1) stub(x + 4, nx - 4, ny, l);
            x = nx;
            y = ny;
          } else {
            const xm = v();
            v(), v(), v();
            const nx = v();
            const ny = v();
            stub(x + 4, xm - 5, y, l);
            if (Math.abs(ny - y) >= 6) bus[COL_INDEX[nx] - 1].push([Math.min(y, ny), Math.max(y, ny), l, xm]);
            stub(xm + 5, nx - 4, ny, l);
            x = nx;
            y = ny;
          }
        }
      }
      bus.forEach((spans, gi) => {
        if (!spans.length) return;
        spans.sort((p, q) => p[0] - q[0]);
        const merged = [];
        for (const [y0, y1, l, xm] of spans) {
          const last = merged.at(-1);
          if (last && y0 <= last.y1 + 4) {
            last.y1 = Math.max(last.y1, y1);
            last.links.push(l);
          } else merged.push({ y0, y1, xm, links: [l] });
        }
        for (const mrg of merged) {
          const n = Math.max(1, Math.round((mrg.y1 - mrg.y0) / 58));
          const step = (mrg.y1 - mrg.y0) / n;
          const i0 = T.length;
          for (let i = 0; i < n; i++) vLine(mrg.xm, mrg.y0 + i * step + 3, mrg.y0 + (i + 1) * step - 3, { kind: 'bus' });
          runs.set(`b:${gi}:${mrg.y0}`, { idxs: T.slice(i0).map((_, k) => i0 + k), links: mrg.links });
        }
      });

      // Column heads and type groups: a bar where each label will be.
      const labelEls = $$('.head, .grp', fm.el).map((el) => ({ el }));
      HEADS.forEach(([x, l, n], i) => {
        g.font = '500 18px Geist';
        const w0 = g.measureText(l).width;
        g.font = '400 18px Geist';
        labelEls[i].idx = T.length;
        hLine(x, x + w0 + 8 + g.measureText(String(n)).width, 25, { kind: 'label' });
      });
      GROUPS_S.forEach(([x, y0, l, n, dy], i) => {
        const y = y0 + dy;
        g.font = '400 14px Geist';
        const lb = labelEls[HEADS.length + i];
        lb.idx = T.length;
        if (dy) lb.el.style.top = `${y}px`;
        hLine(x, x + g.measureText(`${l} ${n}`).width + 4, y + 9, { kind: 'label' });
      });

      // The thread's fragments: the row outside the nodes that sit on it.
      const row = PAY.cy;
      const block = NODES.filter((n) => n.y <= row && n.y + NH >= row).map((n) => [X(n.x) - 8, X(n.x + NW) + 8]);
      g.font = '400 14px Geist';
      for (const [x, y0, l, n, dy] of GROUPS_S) if (y0 + dy <= row && y0 + dy + 19 >= row) block.push([X(x) - 6, X(x + g.measureText(`${l} ${n}`).width + 14)]);
      for (const t of T) if (t.a === 0 && Math.abs(t.y - TY) < 1) block.push([t.x - t.len / 2 - 8, t.x + t.len / 2 + 8]);
      const piece = portrait ? 46 : 58;
      const gap = portrait ? 10 : 12;
      for (let x = -20; x < (portrait ? W + TRUCK_P + 120 : W + 20); x += piece + gap) {
        const x0 = x;
        const x1 = x + piece;
        if (block.some(([b0, b1]) => x1 > b0 && x0 < b1)) continue;
        add((x0 + x1) / 2, TY, 0, piece, { kind: 'thread' });
      }

      // -------------------------------------------------------------- segments
      const field = createLineField(T, { seed: 23, W, H, spread: 1 });
      const segs = field.segs;
      const r = rng(907);
      const tx0 = X(0);
      const tx1 = X(1586);
      // Where the front leaves the plane: past the map's last column in either format.
      const fx1 = portrait ? tx1 + 300 : W + 400;
      const cutText = CUT_TEXT[portrait ? 'port' : 'land'];
      const cutRail = CUT_RAIL[portrait ? 'port' : 'land'];
      const BASE = { edge: 0.95, bar: 0.5, stub: 0.78, bus: 0.6, lane: 0.5, label: 0.5, thread: 1 };
      for (const sg of segs) {
        // On the cut each segment sits where the terminal had text: the right of the
        // map (16:9) or everything below the thread (9:16) comes from the rail's rows,
        // the rest from the request and the prompt; across a row, left to right as
        // across the map.
        const fromRail = portrait ? sg.y > TY + 26 : sg.x > 0.63 * W + (r() - 0.5) * 160;
        const kx = fromRail && !portrait ? clamp((sg.x - 0.6 * W) / (tx1 - 0.6 * W)) : clamp((sg.x - tx0) / ((portrait ? tx1 : 0.63 * W) - tx0));
        const q = pickRow(fromRail ? cutRail : cutText, r());
        const span = q[1] - q[0];
        const pad = Math.min(8, span / 4);
        const ku = clamp((lerp(q[0] + pad, q[1] - pad, kx) + (r() - 0.5) * Math.min(60, span * 0.6) - q[0]) / span);
        sg.bx = q[0] + ku * span;
        sg.by = lerp(q[2], q[3], ku) + ((r() + r() + r() - 1.5) / 1.5) * q[4];
        // A few sit near the lens on the cut, out of focus.
        sg.zb = 0;
        if (sg.kind !== 'thread' && r() < 0.16) {
          sg.bx = r() * W;
          sg.by = TY + (r() - 0.5) * H * (portrait ? 0.7 : 0.8);
          sg.zb = 0.7 + r() * 0.3;
        }
        const sl = (portrait ? 34 : 40) + r() * (portrait ? 20 : 26);
        // The rail's type is smaller than the request's (22 px against 52 px; 9:16's rail is scaled 1.25).
        sg.bl = sl * (0.6 + r() * 0.5) * (fromRail && !sg.zb ? (portrait ? 0.75 : 0.6) : 1);
        sg.sl = sl;
        // Angles within ±90° of the slot, so each settles the short way round.
        sg.ba = sg.a + (r() - 0.5) * Math.PI * 0.96;
        sg.sa = sg.a + (r() - 0.5) * Math.PI * 0.96;
        // A loose cloud around the slot: wider and taller in 9:16.
        sg.sx = sg.x + (r() - 0.5) * (portrait ? 220 : 300);
        // 9:16 spreads the cloud over ~70 % of the height so the frame fills.
        sg.sy = portrait ? TY + (r() - 0.5) * H * 0.6 + (sg.y - TY) * 0.4 : sg.y + lerp(-250, 110, r());
        if (sg.kind === 'thread') sg.sy = sg.y + (r() - 0.5) * (portrait ? 160 : 90);
        sg.z = (r() - 0.5) * 2;
        sg.d0 = 6 + r() * 0.05;
        sg.d1 = sg.d0 + 0.3 + r() * 0.14;
        sg.base = BASE[sg.kind];
        // The front reaches the slot: the thread leads, rows farther from it trail (a zipper).
        const xe = sg.x + Math.abs(sg.y - TY) * (portrait ? 0.32 : 0.5) + sg.delay * 70;
        sg.tPass = passAt(xe, fx1);
        sg.dur = 0.2 + r() * 0.08;
        sg.tIn = sg.tPass + sg.dur * 0.62;
      }

      // Resolve times: a node when its outline has landed, a label when its bar
      // has, a link once both ends are there.
      const tR = {};
      for (const sg of segs) if (sg.node) tR[sg.node] = Math.max(tR[sg.node] ?? 0, sg.tIn);
      for (const lb of labelEls) lb.tIn = segs[lb.idx].tIn;
      const tL = Object.fromEntries(LINKS.map((l) => [l.key, Math.max(tR[l.a.id], tR[l.b.id]) + 0.04]));
      for (const rn of runs.values()) for (const i of rn.idxs) segs[i].fadeAt = Math.min(...rn.links.map((l) => tL[l.key]));
      // Placeholder bars clear before their text arrives; outlines hand over to the node.
      const FADE = { bar: [-0.02, 0.07], label: [0, 0.08], edge: [0.02, 0.18], thread: [-0.02, 0.1], stub: [0, 0.25], bus: [0, 0.25], lane: [0, 0.25] };
      for (const sg of segs) {
        if (sg.node) sg.fadeAt = tR[sg.node];
        else if (sg.kind === 'label') sg.fadeAt = sg.tIn;
        else if (sg.kind === 'thread') sg.fadeAt = LOCK;
        sg.fadeA = sg.fadeAt + FADE[sg.kind][0];
        sg.fadeB = sg.fadeAt + FADE[sg.kind][1];
      }

      S = { root, plane, mapwrap, canvas, g, thread, flat, fm, copy, L, W, H, CW, fx1, segs, tR, tL, labelEls,
        // Payload capacity's right edge on the plane (the thread's mask starts there)
        // and the stretch where the quiet row fades out before the Design column.
        payRight: X(PAY.x + NW),
        rowEnd: ROW_END.map(X),
        threadLn: thread.el.querySelector('.ln'),
        words: $$('.w > span', copy),
        nodeParts: fm.nodes.map((n) => {
          // The agent-touch ring: its own layer, so relaxing it only changes opacity.
          const tr = document.createElement('i');
          tr.className = 'tr';
          n.el.appendChild(tr);
          return { ic: n.el.querySelector('.ic'), nl: n.el.querySelector('.nl'), mk: n.mk, tr };
        }) };
    },
    render(t, ctx) {
      const { W, L, fm, tR, tL } = S;
      const { TY } = L;

      // Camera: a slow push from the cut (about the frame's centre on the thread),
      // then the record lays back into 3D about Payload capacity. 9:16 eases back
      // a touch so the tilt's perspective keeps the right-hand loops in frame.
      const tilt = E.cubicInOut(prog(t, TILT_A, TILT_B));
      const drift = E.sine(prog(t, TILT_B, 8));
      const push = 1 + (ctx.portrait ? 0.015 : 0.03) * E.sine(prog(t, 6, 8)) + (ctx.portrait ? -0.035 : 0.025) * E.cubicInOut(prog(t, TILT_A, 8));
      const rx = 22 * tilt + 1.6 * drift;
      const rz = -4 * tilt - 0.4 * drift;
      const [px, py] = L.pivot;
      const cx = W / 2;
      // 9:16: the camera trucks along the thread behind the front, so Design and
      // Evidence slide in as they are built and settle before the lay-back ends.
      const fx = frontAt(t, S.fx1);
      const truck = ctx.portrait ? TRUCK_P * E.sine(prog(t, TRUCK_A, TRUCK_B)) : 0;
      S.plane.style.transform =
        `translate(${(cx - truck).toFixed(1)}px,${TY}px) scale(${push.toFixed(4)}) translate(${(px - cx).toFixed(1)}px,0px) ` +
        `rotateX(${rx.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg) translate(${(-px).toFixed(1)}px,${-py}px)`;

      // Breath: everything but the thread steps back to ~20 %.
      const dim = lerp(1, 0.2, E.cubicOut(prog(t, BREATH, BREATH + 0.18)));
      S.mapwrap.style.opacity = dim.toFixed(3);
      S.canvas.style.opacity = dim.toFixed(3);
      S.copy.style.opacity = dim.toFixed(3);

      // The thread: on the cut, the prompt's baseline stub from the terminal holds
      // until the head picks it up; the head rides the front; behind it a quiet
      // line the fragments snap onto. At the lock only Intent's segment fuses
      // bright: past Payload capacity's right edge the row stays quiet and relaxes,
      // and from the Components column on it fades out entirely (gone by the Design
      // column), so a line never runs on into a node on the row (Usable pack energy)
      // or to the frame edge as if it were a causal link. In the breath the record
      // tilts away with its thread while a flat thread takes the line (40 % by 7.9)
      // into the title's cut.
      const lift = lerp(0.34, 1, E.cubicOut(prog(t, LOCK - 0.03, LOCK + 0.08)));
      const lineA = lift * lerp(1, 0.4, E.cubicInOut(prog(t, 7.62, 7.9)));
      const headA = ez(t, FRONT_A + 0.06, FRONT_A + 0.2, E.cubicOut) * (1 - prog(t, 6.8, 6.95));
      const locked = t >= LOCK;
      const sw = E.cubicInOut(prog(t, 7.5, 7.7));
      const from = -700;
      S.thread.set({ from, to: locked ? W + 700 : Math.max(-700, fx), alpha: t >= 6.07 ? lineA * (1 - sw) : 0, headAlpha: locked ? 0 : headA * 0.95 });
      // The row past Payload capacity: 34 % as built, 25 % at rest in both formats
      // (never brighter than the real links it overlaps); past the Components
      // column it dissolves with the thread's fragments (gone by ~7.08).
      if (t >= LOCK - 0.03) {
        const a = S.payRight + 6 - from;
        const k = E.cubicInOut(prog(t, LOCK - 0.03, LOCK + 0.3));
        const rest = clamp(lerp(0.34, 0.25, k) / lift);
        const end = clamp((0.34 * (1 - E.cubicInOut(prog(t, LOCK - 0.02, LOCK + 0.1)))) / lift);
        const [e0, e1] = S.rowEnd.map((x) => (x - from).toFixed(1));
        const mk =
          `linear-gradient(90deg, #000 ${a.toFixed(1)}px, rgba(0,0,0,${rest.toFixed(3)}) ${(a + 40).toFixed(1)}px, ` +
          `rgba(0,0,0,${rest.toFixed(3)}) ${e0}px, rgba(0,0,0,${end.toFixed(3)}) ${e1}px)`;
        S.threadLn.style.maskImage = mk;
        S.threadLn.style.webkitMaskImage = mk;
      }
      const stubX = CUT_THREAD[ctx.portrait ? 'port' : 'land'];
      if (sw > 0) S.flat.set({ from: 0, to: W, alpha: lineA * sw });
      else S.flat.set({ from: clamp(fx, 0, stubX), to: stubX, alpha: fx < stubX ? 0.24 : 0 });

      // The map resolving behind the segments; only the agent's recorded objects wear the ring.
      const ring = (id) =>
        AGENT_TOUCHED.has(id) ? prog(t, tR[id], tR[id] + 0.06) * (1 - E.cubicInOut(prog(t, tR[id] + 0.12, tR[id] + 0.72))) : 0;
      fm.render({
        appear: (n) => prog(t, tR[n.id], tR[n.id] + 0.14),
        linkDraw: (l) => prog(t, tL[l.key], tL[l.key] + 0.3),
        marks,
      });
      const rings = [];
      fm.nodes.forEach((n, i) => {
        const rg = ring(n.id);
        if (rg > 0.01) rings.push([n, rg]);
        n.el.style.transform = 'none'; // in place: the view's rise would slip off the outline
        const p = S.nodeParts[i];
        // (Its soft glow is drawn on the segment canvas.)
        p.tr.style.opacity = rg.toFixed(3);
        p.ic.style.opacity = prog(t, tR[n.id] + 0.04, tR[n.id] + 0.16).toFixed(3);
        p.nl.style.opacity = prog(t, tR[n.id] + 0.07, tR[n.id] + 0.22).toFixed(3);
        p.mk.style.opacity = p.nl.style.opacity;
      });
      for (const lb of S.labelEls) {
        const k = prog(t, lb.tIn + 0.04, lb.tIn + 0.22);
        lb.el.style.opacity = k.toFixed(3);
        lb.el.style.transform = `translateY(${((1 - E.expoOut(k)) * 8).toFixed(2)}px)`;
      }

      drawSegs(t, fx, rings);

      // Copy.
      reveal(S.words, t, { at: COPY_AT, stagger: 0.07, dur: 0.6, style: 'rise' });
    },
    fx(t) {
      if (t < 6.95 || t >= 8) return null;
      // The lock thump: a small exposure lift, not a strobe.
      const lock = t >= LOCK ? 0.022 * Math.exp(-(t - LOCK) / 0.045) : 0;
      return { flash: lock, vignette: 1 + 0.3 * ez(t, BREATH, BREATH + 0.3, E.cubicOut) };
    },
  };
}

// The front sweeps the plane on a sine in-out: readable through the map, slow
// out of the cut and into the lock.
const FX0 = -160;
function frontAt(t, fx1) {
  return lerp(FX0, fx1, E.sine(prog(t, FRONT_A, FRONT_B)));
}
function passAt(x, fx1) {
  const v = (x - FX0) / (fx1 - FX0);
  if (v <= 0) return FRONT_A;
  if (v >= 1) return FRONT_B;
  return FRONT_A + (Math.acos(1 - 2 * v) / Math.PI) * (FRONT_B - FRONT_A);
}

function drawSegs(t, fx, rings) {
  const { g, segs, CW, H, L } = S;
  const cx = L.parX;
  const cy = L.TY;
  g.clearRect(0, 0, CW, H);
  // The head's bloom and the soft pool of light that travels with it.
  const lit = ez(t, FRONT_A + 0.06, FRONT_A + 0.25, E.cubicOut) * (1 - prog(t, 6.75, 6.95));
  if (lit > 0.01 && fx > -300 && fx < CW + 300) {
    for (const [R, a] of [[L.s * 380, 0.07], [L.s * 70, 0.22]]) {
      const grd = g.createRadialGradient(fx, cy, 0, fx, cy, R);
      grd.addColorStop(0, `rgba(255,255,255,${(a * lit).toFixed(3)})`);
      grd.addColorStop(0.35, `rgba(255,255,255,${(a * 0.3 * lit).toFixed(3)})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(fx - R, cy - R, R * 2, R * 2);
    }
  }
  // The agent-touch glow round each freshly resolved node.
  g.strokeStyle = '#cff36e';
  for (const [n, rg] of rings) {
    g.beginPath();
    g.roundRect(L.ox + n.x * L.s, L.oy + n.y * L.s, 250 * L.s, 46 * L.s, 12 * L.s);
    for (const [w, a] of [[16, 0.025], [9, 0.045], [4, 0.07]]) {
      g.globalAlpha = a * rg;
      g.lineWidth = w * L.s;
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  g.lineCap = 'butt';
  g.strokeStyle = '#f4f4f5';
  let drawn = lit > 0.01 || rings.length > 0;
  for (const s of segs) {
    let al = s.base * (1 - prog(t, s.fadeA, s.fadeB));
    if (al <= 0.003) continue;
    drawn = true;
    const u = E.cubicOut(prog(t, s.d0, s.d1));
    const k = prog(t, s.tPass, s.tPass + s.dur);
    const eP = E.expoOut(k);
    // Turns fast with a slight overshoot (less on long edges, which would wag).
    const ka = clamp(k * 1.6);
    const eA = lerp(E.expoOut(ka), E.backOut(ka), clamp(70 / s.len));
    // Ahead of the front they jitter, harder as it approaches.
    const free = 1 - eP;
    const near = prog(t, s.tPass - 0.3, s.tPass);
    const amp = (3 + 10 * u + 12 * near) * free;
    const jx = noise1(t * 1.6 + s.seed, 1) * amp;
    const jy = noise1(t * 1.6 + s.seed, 2) * amp * 0.8;
    const ja = noise1(t * 1.2 + s.seed, 3) * (0.2 + 0.5 * near) * free;
    let x = lerp(lerp(s.bx, s.sx, u), s.x, eP) + jx;
    let y = lerp(lerp(s.by, s.sy, u), s.y, eP) + jy;
    const a = lerp(lerp(s.ba, s.sa, u), s.a, eA) + ja;
    // It flies in and turns first, then draws out to the length of its slot.
    const len = lerp(lerp(s.bl, s.sl, u), s.len, E.expoOut(prog(k, 0.2, 1)));
    // Depth: the loose cloud spreads through focus; landing brings it sharp.
    const z = lerp(s.zb, s.z, u) * free;
    const par = 1 + 0.14 * z;
    x = cx + (x - cx) * par;
    y = cy + (y - cy) * par;
    const blur = Math.abs(z) * 5.5;
    const w = 2 * (1 + 0.3 * z) * lerp(1.15, 1, eP);
    // Light rides the front; each segment flares as it locks.
    const light = Math.exp(-(((x - fx) / 220) ** 2)) * 0.25 * free;
    const tl = s.tPass + 0.04;
    const flare = t >= tl ? Math.exp(-(t - tl) / 0.09) : 0;
    al = Math.min(1, al * lerp(0.82, 1, eP) + light) / (1 + blur * 0.18);
    const dx = Math.cos(a) * len * 0.5 * par;
    const dy = Math.sin(a) * len * 0.5 * par;
    g.beginPath();
    g.moveTo(x - dx, y - dy);
    g.lineTo(x + dx, y + dy);
    if (blur > 0.8) {
      g.globalAlpha = al * 0.12;
      g.lineWidth = w + blur * 2.4;
      g.stroke();
      g.globalAlpha = al * 0.2;
      g.lineWidth = w + blur * 1.1;
      g.stroke();
    }
    if (flare > 0.02) {
      g.globalAlpha = 0.28 * flare * al;
      g.lineWidth = w + 7;
      g.stroke();
    }
    g.globalAlpha = Math.min(1, al * (1 + 0.4 * flare));
    g.lineWidth = w;
    g.stroke();
  }
  g.globalAlpha = 1;
  S.canvas.style.visibility = drawn ? 'visible' : 'hidden';
}
