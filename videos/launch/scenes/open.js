// Opening, shots 1–2. Frame 0 is already lit: an extreme macro of the Sable
// rover's near wheel as a dense point cloud, a raking light plane mid-sweep
// (hot band, afterglow behind, dim ahead) and a rack from tread to hub. Near
// 1.0 the band's light gathers onto the thread and leaves the rover as its
// head, running right. 1.5, hard cut on the hit: the whole rover, ¾ hero,
// explodes into its parts; leaders name four of them with fixture facts; the
// thread fractures into drifting stubs.
import * as THREE from 'three';
import { E, ez, clamp, lerp, prog, rng, words, $$, show } from '../lib/core.js';
import { reveal } from '../lib/type.js';
import { createThread, threadY } from '../lib/film.js';
import { createRoverStage } from '../lib/roverStage.js';
import { attachCloud } from '../lib/open-cloud.js';

let S;

const CUT = 1.5;
const V3 = (a) => new THREE.Vector3(...a);

// Camera on an orbit: target, distance, azimuth (from +Z toward +X), elevation.
function orbit(T, D, az, el) {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return [T[0] + D * Math.sin(a) * Math.cos(e), T[1] + D * Math.sin(e), T[2] + D * Math.cos(a) * Math.cos(e)];
}

// Per-format shot design. `at` shifts the lens so the target lands there
// (off-axis frustum, no re-aiming). The macro's light plane runs along
// `sweep` at `speed` mm/s and crosses the thread at x = `birth` at 1.0; `ex`
// scales the explode per axis.
const SHOTS = {
  land: {
    macro: { T: [30, 30, 52], D: [122, 112], az: [33, 41], el: [10, 12], fov: 32, at: [1180, 540], sweep: [0.82, 0.22, -0.57], speed: 19, birth: 1340 },
    hero: { T: [12, 44, 0], D: [600, 576], az: [52, 58], el: [22, 22], fov: 26, at: [960, 400], ex: [0.9, 0.62, 1.45] },
  },
  port: {
    macro: { T: [30, 30, 52], D: [150, 138], az: [30, 38], el: [8, 10], fov: 36, at: [540, 1330], sweep: [0.18, 1, -0.1], speed: 26, birth: 600 },
    hero: { T: [10, 52, 0], D: [760, 730], az: [58, 64], el: [16, 16], fov: 30, at: [540, 800], ex: [0.8, 1.3, 0.5] },
  },
};

// Four facts from the fixture, each anchored to a visible corner of its part
// (rest coordinates) and labelled where that format has room: [x, baseline of the
// facts line, side] (side +1: text starts at x; −1: text ends at x). Both formats
// set the name over its facts, so the labels can be read at phone size and the
// longest one (the Pi's) still fits beside its part.
const TAGS = [
  { part: 'tray', name: 'Camera tray', val: '62 × 44', unit: 'mm', land: [[-18, 56, 31], [700, 150, -1]], port: [[-18, 56, 31], [80, 300, 1]] },
  { part: 'battery', name: 'LiPo 2S', val: '450', unit: 'mAh', land: [[20, 7, 15], [1090, 730, 1]], port: [[20, 7, -15], [1000, 1340, -1]] },
  { part: 'pi', name: 'Raspberry Pi Zero 2 W', key: 'avg current', val: 'Unknown', land: [[-37, 35, 15], [690, 330, -1]], port: [[29, 35, -15], [1000, 600, -1]] },
  // Either wheel carries the same fact; each format names the one with room beside it.
  // The label sits under its wheel so the leader drops straight onto the shelf's near end
  // (9:16: level with the battery's, clear of the battery box).
  { part: ['wheelL', 'wheelR'], name: 'Wheel', val: 'r 0.03', unit: 'm', note: 'assumption', land: [[30, 0.5, -49], [1478, 560, 1]], port: [[30, 0.5, 49], [205, 1340, 1]] },
];
// Label size per format (px): names #a4a7ae, values #ededee, units and notes #848890.
const TAG_FS = { land: 26, port: 28 };

export default function create(span) {
  return {
    id: 'open',
    span,
    css: `
#s-open { background: var(--field); }
#s-open canvas.gl, #s-open canvas.glow { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-open .slate { position: absolute; left: 160px; top: 96px; font: 400 15px/1 var(--font-mono); color: var(--text-3); letter-spacing: 0.01em; white-space: nowrap; }
#s-open .c1 { position: absolute; left: 160px; top: 0; font-size: 72px; font-weight: 500; letter-spacing: -0.032em; color: var(--text); }
#s-open .c1 .ln { position: absolute; left: 0; white-space: nowrap; line-height: 1; }
#s-open .c2 { position: absolute; left: 50%; top: 0; font-size: 96px; font-weight: 600; letter-spacing: -0.032em; color: var(--text); white-space: nowrap; line-height: 1; transform-origin: 50% 70%; }
#s-open svg.lead { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
#s-open svg.lead polyline { stroke: var(--text-3); stroke-width: 1; fill: none; }
#s-open svg.lead circle { fill: var(--text-2); }
#s-open .tag { position: absolute; top: 0; left: 0; font: 400 ${TAG_FS.land}px/1 var(--font-mono); white-space: nowrap; display: flex; flex-direction: column; gap: 0.42em; }
#s-open .tag.end { align-items: flex-end; }
#s-open .tag .row { display: flex; gap: 0.6em; align-items: baseline; }
#s-open .tag .nm { color: var(--text-2); }
#s-open .tag .dot { color: var(--text-4); }
#s-open .tag .v { color: var(--text); }
#s-open .tag .u { color: var(--text-3); margin-left: -0.35em; }
#s-open .tag .k, #s-open .tag .note { color: var(--text-3); }
#s-open .flare { position: absolute; left: 0; top: 0; width: 0; height: 0; }
#s-open .flare i { position: absolute; display: block; }
#s-open .flare .s1 { left: -300px; top: -1px; width: 600px; height: 2px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.7) 50%, transparent); }
#s-open .flare .s2 { left: -760px; top: -9px; width: 1520px; height: 18px; background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(255,255,255,0.16), transparent 72%); }
#s-open .flare .core { left: -90px; top: -90px; width: 180px; height: 180px; background: radial-gradient(circle, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.14) 22%, transparent 62%); }
#s-open .frag { position: absolute; left: 0; top: 0; height: 1.5px; margin-top: -0.75px; background: #ededee; transform-origin: 50% 50%; }
#s-open .tag .row.nm { color: var(--text-2); }
#s-open.portrait .slate { left: 80px; top: 240px; font-size: 22px; }
#s-open.portrait .c1 { left: 80px; font-size: 84px; }
#s-open.portrait .tag { font-size: ${TAG_FS.port}px; }
`,
    build(root, ctx) {
      const { W, H, portrait } = ctx;
      root.classList.toggle('portrait', portrait);
      const F = portrait ? SHOTS.port : SHOTS.land;
      root.innerHTML = `
        <canvas class="glow" width="${W / 6}" height="${H / 6}"></canvas>
        <canvas class="gl" width="${W}" height="${H}"></canvas>
        <svg class="lead" viewBox="0 0 ${W} ${H}"></svg>
        <div class="slate">sable inspection rover</div>
        <div class="c1 display"><div class="ln a">${words('every machine')}</div><div class="ln b">${words('you build')}</div></div>
        <div class="c2 display">${words('lives in pieces')}</div>
        <div class="flare"><i class="s2"></i><i class="s1"></i><i class="core"></i></div>`;
      const canvas = root.querySelector('canvas.gl');
      // Bloom: a 1/6-size blurred copy of the WebGL frame, laid under it.
      const glow = root.querySelector('canvas.glow');

      // The stage's renderer asks for MSAA, which SwiftShader pays for on every
      // fragment; points are smooth on their own, so take the context first without it.
      canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      const stage = createRoverStage(canvas, { pointsPerMm2: 0.02, fov: F.macro.fov });
      // Solids become dark occluders: invisible against the field, but they hide
      // the far side of every part so the cloud reads as hardware.
      for (const p of stage.parts) {
        p.solid.material = new THREE.MeshBasicMaterial({ color: 0x0b0c0e, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
        p.explode.multiply(V3(F.hero.ex));
      }
      const near = new Set(['wheelR', 'motorR']);
      const mid = new Set(['chassis', 'tray', 'regulator', 'driver', 'pi']);
      const cloud = attachCloud(stage, canvas, (id) =>
        near.has(id) ? { surface: 1.7, edge: 0.32 } : mid.has(id) ? { surface: 0.5, edge: 0.5 } : { surface: 0.35, edge: 0.7 },
      );

      // Copy: shot 1 on two baselines, shot 2 centred low.
      const c1 = root.querySelector('.c1');
      const size1 = portrait ? 84 : 72;
      const base1 = portrait ? [400, 492] : [Math.round(H * 0.56) - 80, Math.round(H * 0.56)];
      // At line-height 1, Geist's baseline sits ~0.8 em below the line box top.
      c1.querySelector('.a').style.top = `${base1[0] - size1 * 0.8}px`;
      c1.querySelector('.b').style.top = `${base1[1] - size1 * 0.8}px`;
      const c2 = root.querySelector('.c2');
      // 9:16: baseline at 77 % keeps the descenders clear of the bottom 380 px
      // platform zone and the caps clear of the lowest labels.
      c2.style.top = `${Math.round(H * (portrait ? 0.77 : 0.82)) - 96 * 0.8}px`;

      // Leaders and tags.
      const svg = root.querySelector('svg.lead');
      const tags = TAGS.map((d) => {
        const [at, pos] = portrait ? d.port : d.land;
        const el = document.createElement('div');
        el.className = `tag${pos[2] < 0 ? ' end' : ''}`;
        const facts =
          (d.key ? `<span class="k">${d.key}</span><span class="dot">·</span>` : '') +
          `<span class="v">${d.val}</span>` +
          (d.unit ? `<span class="u">${d.unit}</span>` : '') +
          (d.note ? `<span class="dot">·</span><span class="note">${d.note}</span>` : '');
        el.innerHTML = `<div class="row nm">${d.name}</div><div class="row">${facts}</div>`;
        root.appendChild(el);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', portrait ? '3.5' : '3');
        svg.append(line, dot);
        const id = Array.isArray(d.part) ? d.part[portrait ? 1 : 0] : d.part;
        const part = stage.parts.find((p) => p.id === id);
        const box = el.getBoundingClientRect();
        return { el, line, dot, part, pos, w: box.width, h: box.height, anchor: V3(at) };
      });

      // Fractured thread: ~14 stubs spanning the width, with seeded drift.
      const r = rng(1507);
      const cuts = [0];
      while (cuts[cuts.length - 1] < W) cuts.push(cuts[cuts.length - 1] + (W / 14) * (0.55 + r() * 0.9));
      const frags = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const gap = 6 + r() * 26;
        const x0 = cuts[i] + gap / 2;
        const x1 = Math.min(W + 40, cuts[i + 1] - gap / 2);
        if (x1 - x0 < 12) continue;
        const el = document.createElement('div');
        el.className = 'frag';
        root.appendChild(el);
        frags.push({ el, x0, x1, dy: (r() - 0.5) * (portrait ? 260 : 190), dx: (r() - 0.5) * 90, rot: (r() - 0.5) * 22, life: 0.4 + r() * 0.3, a: 0.5 + r() * 0.5 });
      }

      // Dust: specks shed by the parts as they separate.
      const dustN = 420;
      const dpos = new Float32Array(dustN * 3);
      const dalpha = new Float32Array(dustN);
      const dsize = new Float32Array(dustN);
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
      dg.setAttribute('aA', new THREE.BufferAttribute(dalpha, 1));
      dg.setAttribute('aS', new THREE.BufferAttribute(dsize, 1));
      const dmat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `attribute float aA; attribute float aS; varying float vA; void main(){ vA = aA; gl_PointSize = aS; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; float a = (1.0 - smoothstep(0.1, 0.5, r)) * vA; gl_FragColor = vec4(vec3(a), a); }`,
      });
      const dust = new THREE.Points(dg, dmat);
      dust.frustumCulled = false;
      dust.renderOrder = 3;
      stage.root.add(dust);
      const dr = rng(733);
      const shedders = stage.parts.filter((p) => p.id !== 'chassis');
      const specks = Array.from({ length: dustN }, () => {
        const p = shedders[Math.floor(dr() * shedders.length)];
        const src = cloud.points[stage.parts.indexOf(p)].geometry.attributes.position.array;
        const k = Math.floor(dr() * (src.length / 3)) * 3;
        const ex = p.explode.clone().normalize();
        const dir = V3([ex.x + (dr() - 0.5) * 1.6, ex.y + (dr() - 0.5) * 1.6 + 0.2, ex.z + (dr() - 0.5) * 1.6]).normalize();
        return { p, rest: V3([src[k], src[k + 1], src[k + 2]]), dir, sp: 12 + dr() * 40, a: 0.35 + dr() * 0.65, s: 1.6 + dr() * 2.8, life: 0.6 + dr() * 0.9 };
      });

      S = {
        W,
        H,
        F,
        portrait,
        stage,
        cloud,
        canvas,
        glow: { a: glow, ga: glow.getContext('2d') },
        slate: root.querySelector('.slate'),
        c1,
        w1: $$('.a .w > span', c1),
        w2: $$('.b .w > span', c1),
        c2,
        c2w: $$('.w > span', c2),
        svg,
        tags,
        frags,
        dust,
        dpos,
        dalpha,
        dsize,
        specks,
        thread: createThread(root, ctx),
        flare: root.querySelector('.flare'),
        streak: root.querySelectorAll('.flare .s1, .flare .s2'),
        ty: threadY(ctx),
        v: new THREE.Vector3(),
        up: new THREE.Vector3(0, 1, 0),
      };
      c2.style.marginLeft = `${-c2.getBoundingClientRect().width / 2}px`;
    },

    render(t) {
      const macro = t < CUT;
      S.slate.style.visibility = macro ? 'visible' : 'hidden';
      S.c1.style.visibility = macro ? 'visible' : 'hidden';
      S.c2.style.visibility = macro ? 'hidden' : 'visible';
      S.svg.style.visibility = macro ? 'hidden' : 'visible';
      S.dust.visible = !macro;
      if (macro) renderMacro(t);
      else renderHero(t);
    },

    // No full-frame flash on the 1.5 hit: the light hits the machine instead
    // (see `hit` in renderHero), so the graphite stays near black.
  };
}

/** The 1.5 hit's envelope: 1 on the cut frame, gone by CUT + 0.14. */
const hitEnv = (t) => (t >= CUT && t < CUT + 0.14 ? 1 - ez(t, CUT, CUT + 0.14, E.cubicOut) : 0);

/** Bloom: a blurred, downsampled copy of the WebGL frame under it, showing
 * between the crisp points like halation (no blend-mode compositing). Above 1
 * the halo itself is brightened, since opacity stops at 1. */
function bloom(k) {
  const { a, ga } = S.glow;
  ga.clearRect(0, 0, a.width, a.height);
  ga.filter = k > 1 ? `blur(3px) brightness(${k.toFixed(3)})` : 'blur(3px)';
  ga.imageSmoothingQuality = 'medium';
  ga.drawImage(S.canvas, 0, 0, a.width, a.height);
  show(a, Math.min(1, k));
}

/** Point the stage camera (lens shifted so the target lands on shot.at). */
function aim(shot, pos) {
  const cam = S.stage.camera;
  cam.fov = shot.fov;
  cam.setViewOffset(S.W, S.H, S.W / 2 - shot.at[0], S.H / 2 - shot.at[1], S.W, S.H);
  cam.position.set(...pos);
  cam.lookAt(...shot.T);
  cam.updateMatrixWorld();
  S.cloud.set({ uPx: S.H / 2 / Math.tan((shot.fov * Math.PI) / 360) });
}

/** World point → screen pixels with the stage camera. */
function toScreen(v) {
  v.project(S.stage.camera);
  return [(v.x * 0.5 + 0.5) * S.W, (-v.y * 0.5 + 0.5) * S.H];
}

function macroCam(m, t) {
  // A steady dolly and orbit that gathers speed into the cut.
  const p = prog(t, 0, CUT);
  const k = 0.8 * p + 0.2 * p ** 3;
  return orbit(m.T, lerp(m.D[0], m.D[1], k), lerp(m.az[0], m.az[1], k), lerp(m.el[0], m.el[1], k));
}

function renderMacro(t) {
  const { stage, cloud, F, portrait } = S;
  const m = F.macro;
  // Where the light leaves the rover: a fixed screen point on the thread. The
  // band is timed to reach it at 1.0 (the wheel face under it, camera at 1.0).
  const bx = m.birth;
  const d = V3(m.sweep).normalize();
  aim(m, macroCam(m, 1.0));
  const cam = S.stage.camera;
  const ray = V3([(bx / S.W) * 2 - 1, 1 - (S.ty / S.H) * 2, 0.5]).unproject(cam).sub(cam.position).normalize();
  const hit = cam.position.clone().addScaledVector(ray, (54 - cam.position.z) / ray.z);
  const sBirth = hit.dot(d);
  const sweepAt = (tt) => sBirth + (tt - 1.0) * m.speed;

  const pos = macroCam(m, t);
  aim(m, pos);
  // Focus racks from the tread (nearest rib) to the hub, 0.3–1.1.
  const fwd = V3(m.T).sub(V3(pos)).normalize();
  const tread = V3([58, 36, 52]).sub(V3(pos)).dot(fwd);
  const hub = V3([30, 30, 54]).sub(V3(pos)).dot(fwd);
  const focus = lerp(tread, hub, ez(t, 0.3, 1.1, E.cubicInOut));

  // 0.78–1.02 the band's light gathers onto the thread at the birth point (its
  // reach narrows geometrically), then drains into the head.
  const g = ez(t, 0.78, 1.02, E.cubicInOut);
  const ndc = [(bx / S.W) * 2 - 1, 1 - (S.ty / S.H) * 2];
  const reach = 6 * (0.05 / 6) ** g;
  // 16:9: the band stands vertical, so gather it vertically; 9:16: it lies along the thread already.
  const pinch = portrait ? [ndc[0], ndc[1], reach * 6 + 0.06, reach * 0.9] : [ndc[0], ndc[1], 60, reach];
  const drain = 1 - ez(t, 1.0, 1.22, E.cubicOut);
  const kick = 1 + 0.4 * (1 - ez(t, 0, 0.3, E.cubicOut));
  cloud.set({
    uSize: 0.36,
    uFocus: focus,
    uAperture: portrait ? 40 : 46,
    uMaxSize: 24,
    uSweepDir: m.sweep,
    uSweepPos: sweepAt(t),
    uSweepW: lerp(6.5, 4, g),
    uBandDir: portrait ? [0.3, -0.5, 0.8] : [-0.5, 0.3, 0.8],
    uAhead: 0.07 * lerp(1, 0.55, ez(t, 1.0, 1.45, E.cubicOut)),
    uAfter: 0.15 * lerp(1, 0.42, ez(t, 1.0, 1.45, E.cubicOut)),
    uTrail: 30,
    uHot: (1.5 + 2.5 * g) * drain * kick,
    uFlare: 0.8,
    uKey: 0.02,
    uKeyDir: [0.4, 0.8, 0.5],
    uRim: 0.1,
    uRimDir: [-0.6, 0.5, -0.4],
    uEdge: 1.25,
    uKeep: 1,
    uPinch: pinch,
    uOpacity: 1,
  });
  stage.render({ cam: { pos, target: m.T, fov: m.fov }, looks: { points: 0, edges: 0, solid: 1 }, explode: 0, groundAlpha: 0 });
  bloom(1);

  // Slate and copy.
  const sl = ez(t, 0.2, 0.55, E.cubicOut);
  show(S.slate, sl);
  S.slate.style.transform = `translateX(${((1 - sl) * -10).toFixed(2)}px)`;
  // "build" is sharp by 0.9 and holds 0.6 s to the cut (score: words at 0.25, 0.37, 0.5, 0.62).
  reveal(S.w1, t, { at: 0.25, stagger: 0.12, dur: 0.28, style: 'blur' });
  reveal(S.w2, t, { at: 0.5, stagger: 0.12, dur: 0.28, style: 'blur' });

  // The head runs from the birth point to past the right edge by 1.5, leaving the hairline.
  const q = prog(t, 1.0, CUT);
  const head = lerp(bx, S.W + 40, 0.3 * q + 0.7 * q ** 2.2);
  const on = t >= 1.0;
  S.thread.set({ from: bx, to: on ? head : bx, alpha: on ? 0.9 : 0, headAlpha: on ? 1 : 0, fade: portrait ? 200 : 320 });
  // A flare rides the head: brightest as it is born, stretched by its speed.
  const fl = on ? 0.55 + 0.45 * (1 - ez(t, 1.0, 1.18, E.cubicOut)) : g * 0.8;
  show(S.flare, fl * (1 - ez(t, 1.44, CUT, E.lin) * 0.3));
  S.flare.style.transform = `translate(${(on ? head : bx).toFixed(1)}px, ${S.ty}px)`;
  const birth = g * (1 - ez(t, 1.0, 1.16, E.cubicOut));
  const [soft, hard] = S.streak;
  hard.style.opacity = birth.toFixed(3);
  hard.style.transform = `scaleX(${(0.4 + 1.2 * birth).toFixed(3)})`;
  soft.style.transform = `scaleX(${(0.5 + 0.5 * g + (on ? 0.9 * q : 0)).toFixed(3)})`;
  for (const f of S.frags) f.el.style.visibility = 'hidden';
  for (const tg of S.tags) tg.el.style.visibility = 'hidden';
}

function renderHero(t) {
  const { stage, cloud, F } = S;
  const h = F.hero;
  const l = t - CUT;
  const k = E.sine(prog(t, CUT, 3.0));
  const pos = orbit(h.T, lerp(h.D[0], h.D[1], k), lerp(h.az[0], h.az[1], k), lerp(h.el[0], h.el[1], k));
  aim(h, pos);
  // Assembled for two frames, then the explode (expoOut), still drifting after.
  const ex = ez(t, CUT + 0.066, 2.4, E.expoOut) * 0.94 + 0.06 * ez(t, 2.0, 3.0, E.sine);
  const focus = V3(h.T).distanceTo(V3(pos));
  // The 1.5 hit lands as light on the machine: the band, the rim and the
  // afterglow flare on the cut and settle by CUT + 0.14, with a hotter halo.
  const hit = hitEnv(t);
  cloud.set({
    uSize: 0.75,
    uFocus: focus,
    uAperture: 11,
    uMaxSize: 16,
    uSweepDir: [0.85, 0.2, -0.5],
    uSweepPos: lerp(-110, 200, 0.6 * ez(t, CUT, 3.0, E.cubicOut) + 0.4 * prog(t, CUT, 3.0)),
    uSweepW: 22,
    uBandDir: [0.5, 0.8, 0.3],
    uAhead: 0.3 * (1 + 0.8 * hit),
    uAfter: 0.42 * (1 + 0.8 * hit),
    uTrail: 80,
    uHot: lerp(1.2, 0.45, ez(t, CUT, 2.4, E.cubicOut)) * (1 + 1.5 * hit),
    uFlare: 0.3,
    uKey: 0.2,
    uKeyDir: [0.5, 0.8, 0.4],
    uRim: 1.1 * (1 + 1.2 * hit),
    uRimDir: [-0.7, 0.55, -0.45],
    uEdge: 2.4,
    uKeep: 0.7,
    uPinch: [0, 0, 60, 60],
    uOpacity: 1,
  });
  renderDust(l, ex);
  // Edges are the cloud's own edge samples (smooth without MSAA), not line segments.
  stage.render({ cam: { pos, target: h.T, fov: h.fov }, looks: { points: 0, edges: 0, solid: 1 }, explode: ex, groundAlpha: 0 });
  bloom(lerp(0.8, 1.4, hit));

  // Copy: on the cut, settling from 1.04.
  S.c2.style.transform = `scale(${lerp(1.04, 1, ez(t, CUT, CUT + 0.7, E.expoOut)).toFixed(4)})`;
  reveal(S.c2w, t, { at: CUT, stagger: 0, dur: 0.01, style: 'cut' });

  // Leaders draw from 1.9, 60 ms apart: anchor → elbow → shelf under the label.
  const fs = S.portrait ? TAG_FS.port : TAG_FS.land;
  S.tags.forEach((g, i) => {
    const a = 1.9 + i * 0.06;
    const draw = ez(t, a, a + 0.32, E.expoOut);
    const txt = ez(t, a + 0.12, a + 0.4, E.cubicOut);
    const w = S.v.copy(g.part.explode).multiplyScalar(ex).add(g.anchor).applyAxisAngle(S.up, stage.root.rotation.y);
    const [ax, ay] = toScreen(w);
    const [lx, ly, side] = g.pos;
    // The shelf runs under the last line; the leader meets it at the end nearer the anchor.
    const x0 = side > 0 ? lx - 12 : lx - g.w - 12;
    const x1 = x0 + g.w + 24;
    const shelfY = ly + fs * 0.6;
    const near = Math.abs(ax - x0) < Math.abs(ax - x1) ? x0 : x1;
    const far = near === x0 ? x1 : x0;
    const len1 = Math.hypot(near - ax, shelfY - ay);
    const len2 = Math.abs(far - near);
    const L = (len1 + len2) * draw;
    let poly = `${ax.toFixed(1)},${ay.toFixed(1)}`;
    if (L <= len1) {
      const f = len1 > 0 ? L / len1 : 1;
      poly += ` ${lerp(ax, near, f).toFixed(1)},${lerp(ay, shelfY, f).toFixed(1)}`;
    } else {
      poly += ` ${near.toFixed(1)},${shelfY.toFixed(1)} ${lerp(near, far, (L - len1) / Math.max(1, len2)).toFixed(1)},${shelfY.toFixed(1)}`;
    }
    g.line.setAttribute('points', poly);
    g.line.style.opacity = draw > 0.001 ? '1' : '0';
    g.dot.setAttribute('cx', ax.toFixed(1));
    g.dot.setAttribute('cy', ay.toFixed(1));
    g.dot.style.opacity = ez(t, a, a + 0.1, E.lin).toFixed(3);
    show(g.el, txt);
    const tx = side > 0 ? lx : lx - g.w;
    g.el.style.transform = `translate(${tx.toFixed(1)}px, ${(ly - g.h + fs * 0.22 + (1 - txt) * 6).toFixed(1)}px)`;
  });

  // The thread fractures on the hit; its stubs drift apart and are gone by 2.2.
  S.thread.set({ alpha: 0, headAlpha: 0 });
  show(S.flare, 0);
  const q = 0.3 + 0.7 * ez(t, CUT, CUT + 0.7, E.expoOut);
  for (const f of S.frags) {
    const a = f.a * (1 - ez(t, CUT + 0.04, CUT + f.life, E.cubicIn));
    if (!show(f.el, a)) continue;
    f.el.style.width = `${(f.x1 - f.x0).toFixed(1)}px`;
    f.el.style.transform = `translate(${(f.x0 + f.dx * q).toFixed(1)}px, ${(S.ty + f.dy * q).toFixed(1)}px) rotate(${(f.rot * q).toFixed(2)}deg)`;
  }
}

function renderDust(l, ex) {
  const { specks, dpos, dalpha, dsize, v } = S;
  specks.forEach((s, i) => {
    const q = clamp(l / s.life);
    v.copy(s.p.explode).multiplyScalar(ex).add(s.rest).addScaledVector(s.dir, s.sp * Math.sqrt(Math.max(0, ex)) + l * 6);
    v.y += l * l * 6;
    dpos.set([v.x, v.y, v.z], i * 3);
    dalpha[i] = s.a * ez(l, 0.06, 0.14, E.lin) * (1 - E.cubicIn(q));
    dsize[i] = s.s;
  });
  const at = S.dust.geometry.attributes;
  at.position.needsUpdate = true;
  at.aA.needsUpdate = true;
  at.aS.needsUpdate = true;
}
