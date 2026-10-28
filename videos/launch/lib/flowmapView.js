// The rover's Flow map as film-scale DOM + SVG, styled from the Lens tokens:
// column heads, type groups, nodes with their type icon and marks, causal links
// ending in open chevrons, the lit thread (signal) and the stale path (amber,
// always with its "Out of date" word on the node). Scenes own the camera; this
// owns the map's state.
import { E, clamp, ez, lerp, ic } from './core.js';
import { NODES, LINKS, HEADS, GROUPS, COL_INDEX, NW, NH, THREAD_NODES, THREAD_LINKS, TYPE_ICON, linkPath } from './flowmap.js';

export const FLOWMAP_ICONS = [...new Set(Object.values(TYPE_ICON))];
export const MAP_W = 1540;
export const MAP_H = 500;

export const FLOWMAP_CSS = `
.fm { position: absolute; left: 0; top: 0; width: ${MAP_W}px; height: ${MAP_H}px; transform-origin: 0 0; }
.fm > svg { position: absolute; left: 0; top: 0; overflow: visible; }
.fm path.l { fill: none; stroke: rgba(255,255,255,0.17); stroke-width: 1.5; stroke-linecap: round; stroke-dasharray: 1 1; }
.fm path.s { fill: none; stroke: var(--warn); stroke-width: 2.6; stroke-linecap: round; stroke-dasharray: 1 1; }
.fm path.ch { fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.fm circle.p { fill: var(--signal); filter: drop-shadow(0 0 7px var(--signal)); }
.fm circle.h { fill: #ffd9a0; filter: drop-shadow(0 0 8px var(--warn)); }
.fm .head { position: absolute; font: 500 18px var(--font-sans); color: var(--text); letter-spacing: -0.01em; white-space: nowrap; }
.fm .grp { position: absolute; font: 400 14px var(--font-sans); color: var(--text-3); white-space: nowrap; }
.fm .head span, .fm .grp span { margin-left: 8px; color: var(--text-3); font-weight: 400; }
.fm .node { position: absolute; width: ${NW}px; height: ${NH}px; display: flex; align-items: center; gap: 11px; padding: 0 15px;
  border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); color: #d4d6da;
  font: 400 16px var(--font-sans); letter-spacing: -0.005em; white-space: nowrap; transform-origin: 50% 50%; }
.fm .node .ic { font-size: 17px; color: var(--text-3); }
.fm .node .nl { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.fm .node .mk { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.fm .node .mk.warn { background: var(--warn); }
.fm .node .mk.ring { border: 1.5px solid var(--text-3); }
.fm .node .od { position: absolute; right: 1px; top: 1px; bottom: 1px; display: flex; align-items: center; gap: 7px; padding: 0 14px 0 18px; border-radius: 0 11px 11px 0;
  background: linear-gradient(90deg, rgba(34,29,21,0), rgb(34,29,21) 14px); font: 500 13.5px var(--font-sans); color: var(--warn); white-space: nowrap; opacity: 0; }
.fm .node .od::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
`;

const C = {
  edge: [255, 255, 255, 0.17],
  signal: [207, 243, 110, 1],
  signalLine: [207, 243, 110, 0.55],
  line: [255, 255, 255, 0.12],
  warn: [241, 187, 104, 0.85],
  surface: [17, 18, 20, 1],
  signalSoft: [30, 36, 20, 1],
  warnSoft: [34, 29, 21, 1],
};
const mix = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const col = (c) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})`;

/** Open chevron at the consequence end of a link path. */
function chevronAt(pathEl) {
  const L = pathEl.getTotalLength();
  const p = pathEl.getPointAtLength(L);
  const q = pathEl.getPointAtLength(Math.max(0, L - 2));
  const a = Math.atan2(p.y - q.y, p.x - q.x);
  const s = 6;
  const p1 = [p.x - Math.cos(a - 0.6) * s, p.y - Math.sin(a - 0.6) * s];
  const p2 = [p.x - Math.cos(a + 0.6) * s, p.y - Math.sin(a + 0.6) * s];
  return `M${p1[0].toFixed(2)} ${p1[1].toFixed(2)} L${p.x.toFixed(2)} ${p.y.toFixed(2)} L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
}

export function createFlowMap(container) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const el = document.createElement('div');
  el.className = 'fm';
  el.innerHTML =
    `<svg width="${MAP_W}" height="${MAP_H}" viewBox="0 0 ${MAP_W} ${MAP_H}"><g class="base"></g><g class="stale"></g><g class="pulses"></g></svg>` +
    HEADS.map(([x, l, n]) => `<div class="head" data-col="${COL_INDEX[x]}" style="left:${x}px;top:14px">${l}<span>${n}</span></div>`).join('') +
    GROUPS.map(([x, y, l, n]) => `<div class="grp" data-col="${COL_INDEX[x]}" style="left:${x}px;top:${y}px">${l}<span>${n}</span></div>`).join('') +
    NODES.map(
      (n) =>
        `<div class="node" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px">${ic(TYPE_ICON[n.type])}<span class="nl">${n.label}</span><i class="mk"></i><span class="od">Out of date</span></div>`,
    ).join('');
  container.appendChild(el);
  const svg = el.querySelector('svg');
  const g = { base: svg.querySelector('.base'), stale: svg.querySelector('.stale'), pulses: svg.querySelector('.pulses') };
  const mkPath = (parent, d, cls) => {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    parent.appendChild(p);
    return p;
  };

  const nodes = NODES.map((n) => {
    const node = el.querySelector(`[data-id="${n.id}"]`);
    return { ...n, col: COL_INDEX[n.x], el: node, mk: node.querySelector('.mk'), od: node.querySelector('.od'), thread: THREAD_NODES.has(n.id) };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links = LINKS.map((l) => {
    const d = linkPath(l);
    const path = mkPath(g.base, d, 'l');
    path.setAttribute('pathLength', '1');
    const len = path.getTotalLength();
    const chev = mkPath(g.base, chevronAt(path), 'ch');
    const stale = mkPath(g.stale, d, 's');
    stale.setAttribute('pathLength', '1');
    const head = document.createElementNS(svgNS, 'circle');
    head.setAttribute('r', '5');
    head.setAttribute('class', 'h');
    g.stale.appendChild(head);
    const pulse = document.createElementNS(svgNS, 'circle');
    pulse.setAttribute('r', '4.5');
    pulse.setAttribute('class', 'p');
    g.pulses.appendChild(pulse);
    return { ...l, path, len, chev, stale, head, pulse, thread: THREAD_LINKS.has(l.key), a: byId[l.a.id], b: byId[l.b.id] };
  });
  const labels = [...el.querySelectorAll('.head, .grp')].map((e) => ({ el: e, col: Number(e.dataset.col) }));

  return {
    el,
    nodes,
    links,
    byId,
    /**
     * appear(n) → 0..1 entrance per node (default: all in)
     * linkDraw(l) → 0..1 draw-on per link (default: after both ends)
     * lit       → 0..1 the Payload capacity thread in signal, everything else steps back
     * pulseT    → seconds; pulses travel the lit thread
     * stale(key)→ 0..1 amber travel along a link; staleNode(id) → 0..1 out-of-date state
     * marks(id) → 'warn' | 'ring' | ''
     * focus(id) → 0..1 extra emphasis for one node (scale + glow)
     */
    render({ appear = () => 1, linkDraw = null, lit = 0, pulseT = null, stale = () => 0, staleNode = () => 0, marks = () => '', focus = () => 0, labelK = 1, dimRest = 0 } = {}) {
      for (const n of nodes) {
        const ap = clamp(appear(n));
        const nl = n.thread ? lit : 0;
        const st = clamp(staleNode(n.id));
        const fo = clamp(focus(n.id));
        let dim = n.thread ? 1 : lerp(1, 0.28, lit);
        dim *= lerp(1, 0.45, dimRest * (st > 0 || n.id === 'payload' ? 0 : 1));
        n.el.style.transform = `translate3d(0,${((1 - E.expoOut(ap)) * 24).toFixed(2)}px,0) scale(${(lerp(0.94, 1, E.expoOut(ap)) * (1 + 0.04 * fo)).toFixed(4)})`;
        n.el.style.opacity = (ap * dim).toFixed(3);
        n.el.style.borderColor = col(mix(mix(C.line, C.signalLine, Math.max(nl, fo)), C.warn, st));
        n.el.style.background = col(mix(mix(C.surface, C.signalSoft, Math.max(nl, fo * 0.6)), C.warnSoft, st));
        n.el.style.boxShadow =
          nl > 0.01 || fo > 0.01
            ? `0 0 ${(26 + 18 * fo).toFixed(1)}px rgba(207,243,110,${(0.14 * Math.max(nl * 0.8, fo)).toFixed(3)})`
            : st > 0.01
              ? `0 0 26px rgba(241,187,104,${(0.16 * st).toFixed(3)})`
              : 'none';
        n.el.style.color = nl > 0.5 || fo > 0.5 ? 'var(--text)' : '';
        const mk = st > 0.4 ? 'warn' : marks(n.id);
        if (n.mk.className !== `mk ${mk}`) n.mk.className = `mk ${mk}`;
        n.od.style.opacity = clamp((st - 0.4) / 0.6).toFixed(3);
      }
      for (const l of labels) l.el.style.opacity = (labelK * lerp(1, 0.5, lit)).toFixed(3);
      for (const l of links) {
        const dp = linkDraw ? clamp(linkDraw(l)) : Math.min(clamp(appear(l.a)), clamp(appear(l.b)));
        l.path.style.strokeDashoffset = (1 - E.cubicInOut(dp)).toFixed(4);
        const tl = l.thread ? lit : 0;
        const dim = l.thread ? 1 : lerp(1, 0.22, lit);
        const stroke = col(mix(C.edge, C.signal, tl));
        l.path.style.stroke = stroke;
        l.path.style.strokeWidth = lerp(1.5, 2.4, tl).toFixed(2);
        l.path.style.opacity = dim.toFixed(3);
        l.chev.style.stroke = stroke;
        l.chev.style.opacity = (dim * clamp((dp - 0.85) / 0.15)).toFixed(3);
        const sp = clamp(stale(l.key));
        l.stale.style.strokeDashoffset = (1 - sp).toFixed(4);
        l.stale.style.opacity = sp > 0 ? '1' : '0';
        if (sp > 0 && sp < 1) {
          const hp = l.path.getPointAtLength(sp * l.len);
          l.head.setAttribute('cx', hp.x.toFixed(2));
          l.head.setAttribute('cy', hp.y.toFixed(2));
          l.head.style.opacity = '1';
        } else l.head.style.opacity = '0';
        if (pulseT != null && l.thread && lit > 0.01) {
          const ph = (((pulseT * 0.85 + l.a.y * 0.001) % 1) + 1) % 1;
          const p = l.path.getPointAtLength(ph * l.len);
          l.pulse.setAttribute('cx', p.x.toFixed(2));
          l.pulse.setAttribute('cy', p.y.toFixed(2));
          l.pulse.style.opacity = (lit * Math.sin(Math.PI * ph)).toFixed(3);
        } else l.pulse.style.opacity = '0';
      }
    },
  };
}

/** Default draw-in: columns left to right, rows top to bottom, starting at t0. */
export const columnAppear = (t, t0, colGap = 0.13, rowGap = 0.035, dur = 0.65) => {
  const rowIndex = {};
  const order = new Map();
  for (const n of NODES) {
    const c = COL_INDEX[n.x];
    rowIndex[c] = (rowIndex[c] ?? -1) + 1;
    order.set(n.id, t0 + c * colGap + rowIndex[c] * rowGap);
  }
  return (n) => ez(t, order.get(n.id), order.get(n.id) + dur, E.lin);
};
