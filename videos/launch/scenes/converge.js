// The machine, whole — the bookend. Hard cut from Paper to the assembled rover
// as a point cloud in a ¾ hero view under one last raking light. Then every
// point collapses in screen space: down onto the thread's line (streaking as it
// falls), the line stretches like a breath in, then contracts into one 6 px
// point of light at the lockup mark's apex. Black but the point, which swells
// with the score's reverse swell; the end card cuts the mark in under it at 24.0
// and the light decays into the mark over the first frames of the card. No
// full-frame flash: the energy is in the point, so the field stays graphite.
//
// One WebGL pass: the rover's points, edges, dust and motion streaks share a
// shader that projects each vertex, then mixes its screen position toward the
// line and the apex as a function of time alone.
import * as THREE from 'three';
import { E, clamp, lerp, ez, prog, rng, show } from '../lib/core.js';
import { buildRover } from '../lib/rover.js';

let S;

// Beats inside the shot (global seconds).
const SWEEP = [22.5, 23.22]; // raking light, rear → front
const FLAT0 = 23.18; // points start falling onto the line
const FLAT_DUR = 0.2; // per point
const FLAT_SPREAD = 0.1; // per-point stagger, rear (left) first
const CON = [23.45, 23.73]; // the line contracts into the point
const DARK = 23.75; // black but the point
const RISE_TAU = 0.09; // the point swells like the score's reverse swell, exp(-(24 - t) / 0.09)
const FALL_RATE = 18; // after the hit the light decays as exp(-18 (t - 24)): gone in about 4 frames at 30 fps
const AFTER = 0.3; // the afterglow overlay's life past the cut
const HALO_A = 0.11; // a wide, faint halo around the point at the hit (local; the frame edges stay black)
const DENSITY = 0.6; // surface points per mm²
const STREAK_SHARE = 0.65; // of the surface points leave a streak as they fall

// Camera and layout per format. Apex = the end card's mark apex (measured).
const LOOK = {
  land: { target: [4, 27, 0], az: [-76, -63], el: [23, 18], r: [350, 322], fov: 26, lineY: 540, apex: [570.7, 469.5], stretch: 1.32, flare: 640, halo: 460 },
  port: { target: [4, 28, 0], az: [-76, -63], el: [26, 21], r: [640, 594], fov: 26, lineY: 960, apex: [540, 710.6], stretch: 1.04, flare: 520, halo: 420 },
};

const VS = `
uniform float uT, uSize, uPx, uFocus, uAperture, uSweepX, uSweepW, uTail, uMaxSize, uLineSize;
uniform float uF0, uFd, uSpread, uC0, uCd, uStretch, uLineY, uX0, uX1, uDrift, uFloor;
uniform vec2 uRes, uApex;
attribute vec3 aNormal;
attribute float aRand;
attribute float aTail;
attribute float aKind; // 0 surface point, 1 dust, 2 edge, 3 floor
varying float vA;
varying float vHot;
varying float vCoc;
float cubicInOut(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
void main() {
  vec3 p = position;
  bool dust = aKind > 0.5 && aKind < 1.5;
  // Dust drifts slowly on its own heading.
  if (dust) p += vec3(sin(aRand * 41.0), cos(aRand * 17.0) * 0.6, sin(aRand * 7.3 + 1.0)) * uDrift * (4.0 + 6.0 * fract(aRand * 9.1));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  // Nothing near or behind the lens.
  if (depth < 60.0) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); gl_PointSize = 1.0; vA = 0.0; return; }
  vec4 clip = projectionMatrix * mv;
  vec2 s0 = clamp((clip.xy / clip.w * 0.5 + 0.5) * uRes, -0.25 * uRes, 1.25 * uRes);
  // Collapse at this vertex's time (streak tails look a moment back).
  float t = uT - aTail * uTail;
  float xn = clamp((s0.x - uX0) / max(1.0, uX1 - uX0), 0.0, 1.0);
  float d = uSpread * (0.6 * aRand + 0.4 * xn);
  float f = cubicInOut(clamp((t - uF0 - d) / uFd, 0.0, 1.0));
  float c = cubicInOut(clamp((t - uC0) / uCd, 0.0, 1.0));
  // The lift toward the apex uses the head's time, so contracting streaks lie along the line.
  float cy = cubicInOut(clamp((uT - uC0) / uCd, 0.0, 1.0));
  float cx = 0.5 * (uX0 + uX1);
  vec2 s = vec2(cx + (s0.x - cx) * mix(1.0, uStretch, f), mix(s0.y, uLineY, f));
  s = vec2(mix(s.x, uApex.x, c), mix(s.y, uApex.y, cy));
  // At rest the true depth (hidden surfaces sit behind the depth-only solids); once moving, in front of everything.
  // The depth is taken a few mm toward the lens so a sprite on a slanted face is not half-hidden by it.
  vec4 cb = projectionMatrix * (mv + vec4(0.0, 0.0, 4.0, 0.0));
  gl_Position = vec4(s / uRes * 2.0 - 1.0, mix(cb.z / cb.w, -0.999, step(0.5, f)), 1.0);
  // Raking light: a bright band along X + 0.35 Z with an afterglow behind it.
  float u = p.x + p.z * 0.35 - uSweepX;
  float bu = u / uSweepW;
  float band = exp(-bu * bu);
  float after = 1.0 - smoothstep(-uSweepW * 2.0, uSweepW * 0.2, u);
  // Depth of field: the blur disc closes as the points fall into the line; lit points flare a little.
  float base = uSize * uPx / depth * (1.0 + 0.5 * band);
  float coc = abs(depth - uFocus) / depth;
  float size = clamp(base + coc * uAperture * (1.0 - f), 1.0, uMaxSize);
  size = mix(size, uLineSize, f);
  gl_PointSize = size;
  vCoc = coc * uAperture * (1.0 - f) / 12.0;
  vA = mix(clamp((base * base) / (size * size), 0.04, 1.0), 1.0, f);
  float lit = 0.55 + 1.2 * band + 0.2 * after;
  if (aKind < 0.5) {
    // Surface shading: a soft key from above, a rim on the silhouette, back faces dropped.
    vec3 n = normalize(aNormal);
    float facing = dot(normalize(normalMatrix * n), normalize(-mv.xyz));
    float key = max(dot(n, normalize(vec3(-0.35, 1.0, 0.25))), 0.0);
    float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 2.2);
    float back = smoothstep(-0.1, 0.25, facing);
    lit = (0.12 + 0.55 * key + 1.15 * rim) * (1.0 + 3.0 * band) + 0.3 * after * (0.35 + key);
    lit *= mix(back, 1.0, smoothstep(0.5, 0.9, f));
  } else if (aKind > 2.5) {
    // Floor grid: a pool around the machine that the light crosses too.
    float r = length(p.xz - vec2(5.0, 0.0));
    lit = (0.3 + 1.8 * band + 0.08 * after) * (1.0 - smoothstep(60.0, 230.0, r)) * uFloor;
  }
  vHot = clamp(band * 1.2 + (lit - 0.9) * 0.6 + f * 0.6 + c, 0.0, 1.0);
  vA *= lit + 0.6 * f * step(aKind, 2.5);
  // Dust is fainter and stays out of the line; streak tails fade to nothing.
  if (dust) {
    vec2 e = smoothstep(vec2(0.0), vec2(80.0), s0) * smoothstep(vec2(0.0), vec2(80.0), uRes - s0);
    vA *= 0.5 * e.x * e.y * (1.0 - f);
  }
  vA *= 1.0 - aTail;
}`;

const FS_POINTS = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vHot;
varying float vCoc;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.16, 0.5, r);
  float disc = (1.0 - smoothstep(0.4, 0.5, r)) * (0.7 + 0.3 * smoothstep(0.28, 0.47, r));
  float a = mix(soft, disc, clamp(vCoc * 3.0, 0.0, 1.0)) * vA * uOpacity;
  vec3 col = mix(uColor, vec3(1.0), vHot);
  gl_FragColor = vec4(col * a, a);
}`;

const FS_LINES = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vHot;
void main() {
  float a = clamp(vA, 0.0, 1.0) * uOpacity;
  vec3 col = mix(uColor, vec3(1.0), vHot);
  gl_FragColor = vec4(col * a, a);
}`;

/** Pre-rendered glow sprites (canvas), drawn once in build. */
function sprite(w, h, fn) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = clamp(fn((x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  g.putImageData(img, 0, 0);
  return c;
}

export default function create(span) {
  const [T0] = span;
  return {
    id: 'converge',
    span,
    css: `
#s-converge { background: var(--field); }
#s-converge canvas.gl { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-converge .fx { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
#s-converge .hair { position: absolute; left: 0; top: 0; height: 1.5px; margin-top: -0.75px; transform-origin: 0 50%;
  background: linear-gradient(90deg, rgba(237,237,238,0) 0%, #ededee 12%, #fff 50%, #ededee 88%, rgba(237,237,238,0) 100%); }
#s-converge .core, #converge-after .core { position: absolute; left: 0; top: 0; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 3px 1px rgba(255,255,255,0.95), 0 0 14px 3px rgba(255,255,255,0.35); }
#converge-after { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 999; visibility: hidden; }
#converge-after .fx { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
`,
    build(root, ctx) {
      const { W, H } = ctx;
      const L = ctx.portrait ? LOOK.port : LOOK.land;
      root.innerHTML = `<canvas class="gl" width="${W}" height="${H}"></canvas>`;
      const canvas = root.querySelector('canvas');
      // A lean stage of our own: no MSAA (the points are soft sprites already), one scene, one camera.
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(L.fov, W / H, 1, 8000);
      const rover = buildRover({ pointsPerMm2: 0, minPoints: 1 });

      // Rover surface points with normals (and their streak twins), edges, and dust.
      const r = rng(1607);
      const pts = [];
      const nrm = [];
      const rand = [];
      const kind = [];
      rover.parts.forEach((p, i) => samplePart(p.geom, DENSITY, 4000 + i * 31, pts, nrm, rand, kind));
      const nRover = rand.length;
      // Dust motes in a loose volume around the machine, kept off its body.
      for (let k = 0; k < 90; k++) {
        let x, y, z;
        do {
          x = lerp(-320, 320, r());
          y = lerp(-30, 190, r());
          z = lerp(-320, 320, r());
        } while (Math.abs(x) < 80 && Math.abs(z) < 70 && y < 90);
        pts.push(x, y, z);
        nrm.push(0, 1, 0);
        rand.push(r());
        kind.push(1);
      }
      // A floor grid (10 mm) the machine stands on.
      for (let x = -240; x <= 240; x += 10)
        for (let z = -240; z <= 240; z += 10) {
          if (Math.hypot(x - 5, z) > 235) continue;
          pts.push(x, 0, z);
          nrm.push(0, 1, 0);
          rand.push(r());
          kind.push(3);
        }
      const n = rand.length;
      const pointGeom = new THREE.BufferGeometry();
      pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      pointGeom.setAttribute('aNormal', new THREE.Float32BufferAttribute(nrm, 3));
      pointGeom.setAttribute('aRand', new THREE.Float32BufferAttribute(rand, 1));
      pointGeom.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
      pointGeom.setAttribute('aTail', new THREE.Float32BufferAttribute(new Float32Array(n), 1));

      // Streaks: most surface points twice, a head and a tail that looks back in time.
      const pick = [];
      for (let i = 0; i < nRover; i++) if (rand[i] < STREAK_SHARE) pick.push(i);
      const m = pick.length;
      const sp = new Float32Array(m * 6);
      const sn = new Float32Array(m * 6);
      const sr = new Float32Array(m * 2);
      const sk = new Float32Array(m * 2);
      const st = new Float32Array(m * 2);
      pick.forEach((i, q) => {
        for (let j = 0; j < 3; j++) {
          sp[q * 6 + j] = sp[q * 6 + 3 + j] = pts[i * 3 + j];
          sn[q * 6 + j] = sn[q * 6 + 3 + j] = nrm[i * 3 + j];
        }
        sr[q * 2] = sr[q * 2 + 1] = rand[i];
        st[q * 2 + 1] = 1;
      });
      const streakGeom = new THREE.BufferGeometry();
      streakGeom.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      streakGeom.setAttribute('aNormal', new THREE.BufferAttribute(sn, 3));
      streakGeom.setAttribute('aRand', new THREE.BufferAttribute(sr, 1));
      streakGeom.setAttribute('aKind', new THREE.BufferAttribute(sk, 1));
      streakGeom.setAttribute('aTail', new THREE.BufferAttribute(st, 1));

      // Edges of every part, merged; each vertex its own stagger so the wire pulls like string.
      const ep = [];
      for (const p of rover.parts) ep.push(...p.edges.attributes.position.array);
      const ne = ep.length / 3;
      const er = new Float32Array(ne);
      for (let i = 0; i < ne; i++) er[i] = r();
      const edgeGeom = new THREE.BufferGeometry();
      edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
      edgeGeom.setAttribute('aNormal', new THREE.BufferAttribute(new Float32Array(ne * 3), 3));
      edgeGeom.setAttribute('aRand', new THREE.BufferAttribute(er, 1));
      edgeGeom.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(ne).fill(2), 1));
      edgeGeom.setAttribute('aTail', new THREE.BufferAttribute(new Float32Array(ne), 1));

      const px = H / 2 / Math.tan((L.fov * Math.PI) / 360);
      const U = {
        uT: { value: 0 },
        uSize: { value: 0.72 },
        uPx: { value: px },
        uFocus: { value: 400 },
        uAperture: { value: 0 },
        uSweepX: { value: -200 },
        uSweepW: { value: 20 },
        uTail: { value: 0.024 },
        uMaxSize: { value: 18 },
        uLineSize: { value: 2.2 },
        uF0: { value: FLAT0 },
        uFd: { value: FLAT_DUR },
        uSpread: { value: FLAT_SPREAD },
        uC0: { value: CON[0] },
        uCd: { value: CON[1] - CON[0] },
        uStretch: { value: L.stretch },
        uLineY: { value: H - L.lineY },
        uApex: { value: new THREE.Vector2(L.apex[0], H - L.apex[1]) },
        uX0: { value: 0 },
        uX1: { value: W },
        uRes: { value: new THREE.Vector2(W, H) },
        uDrift: { value: 0 },
        uFloor: { value: 1 },
      };
      // The materials share U's uniform objects, so one write reaches all three.
      const mat = (fs, color, opacity) =>
        new THREE.ShaderMaterial({
          vertexShader: VS,
          fragmentShader: fs,
          uniforms: { ...U, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
        });
      const points = new THREE.Points(pointGeom, mat(FS_POINTS, 0xc9ccd2, 1));
      const streaks = new THREE.LineSegments(streakGeom, mat(FS_LINES, 0xc9ccd2, 0.7));
      const edges = new THREE.LineSegments(edgeGeom, mat(FS_LINES, 0xededee, 0.16));
      for (const o of [edges, streaks, points]) {
        o.frustumCulled = false;
        o.renderOrder = 2;
        scene.add(o);
      }
      // The parts' solids write depth only, first, so surfaces hide what is behind them.
      const occluder = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      for (const p of rover.parts) {
        const mesh = new THREE.Mesh(p.geom, occluder);
        mesh.renderOrder = -1;
        scene.add(mesh);
      }

      // Glow layers: the line's halo, then the point (halo, bloom, anamorphic flare, core).
      const lineGlow = sprite(512, 64, (x, y) => (1 - smoothEdge(Math.abs(x) * 2, 0.6, 1)) * Math.exp(-((y * 64) ** 2) / (2 * 7 ** 2)));
      lineGlow.className = 'fx lineglow';
      root.appendChild(lineGlow);
      const P = pointLayers(root);
      const hair = document.createElement('div');
      hair.className = 'hair';
      root.insertBefore(hair, P.core);

      // The point's light outlives the shot by a few frames: the same layers in an
      // overlay of this scene's own, above the end card and under the engine's
      // grain, driven from fx(t) (called on every frame) so it can straddle the cut.
      // It sits at the apex, so it lands on the mark's tip as the mark cuts in.
      const after = document.createElement('div');
      after.id = 'converge-after';
      (root.parentElement ?? root).appendChild(after);
      const A = pointLayers(after);

      // A subsample for measuring the cloud's screen extent each frame.
      const probe = [];
      for (let i = 0; i < nRover; i += 23) probe.push(new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));

      S = { canvas, renderer, scene, camera, U, points, streaks, edges, lineGlow, hair, P, after, A, probe, L, W, H, v: new THREE.Vector3() };
    },
    render(t, ctx) {
      const { camera: cam, U, L, W, H } = S;
      const l = t - T0;
      const [ax, ay] = L.apex;

      // Camera: a slow push and orbit that settles as the collapse begins.
      const k = ez(t, T0, FLAT0 + 0.2, E.sineOut);
      const az = (lerp(L.az[0], L.az[1], k) * Math.PI) / 180;
      const el = (lerp(L.el[0], L.el[1], k) * Math.PI) / 180;
      const rr = lerp(L.r[0], L.r[1], k);
      const [tx, ty, tz] = L.target;
      const pos = [tx + rr * Math.cos(el) * Math.cos(az), ty + rr * Math.sin(el), tz - rr * Math.cos(el) * Math.sin(az)];
      cam.position.set(...pos);
      cam.lookAt(tx, ty, tz);
      cam.updateMatrixWorld();

      // The cloud's screen extent (drives the stagger and the stretch centre).
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const p of S.probe) {
        S.v.copy(p).project(cam);
        const sx = (S.v.x * 0.5 + 0.5) * W;
        if (sx < x0) x0 = sx;
        if (sx > x1) x1 = sx;
      }

      // Collapse state on the CPU (mean point) for the DOM glow layers.
      const F = E.cubicInOut(prog(t, FLAT0 + FLAT_SPREAD * 0.5, FLAT0 + FLAT_SPREAD * 0.5 + FLAT_DUR));
      const C = E.cubicInOut(prog(t, CON[0], CON[1]));
      const cxm = (x0 + x1) / 2;
      const half = ((x1 - x0) / 2) * lerp(1, L.stretch, F);
      const lx0 = lerp(cxm - half, ax, C);
      const lx1 = lerp(cxm + half, ax, C);
      const ly = lerp(L.lineY, ay, C);

      // WebGL pass, skipped once everything is in the point.
      const glOn = t < DARK + 0.02;
      show(S.canvas, glOn ? 1 : 0);
      if (glOn) {
        U.uT.value = t;
        // Long streaks while the points fall, short ones while the line contracts.
        U.uTail.value = lerp(0.024, 0.008, ez(t, CON[0], CON[0] + 0.12, E.sine));
        U.uX0.value = x0;
        U.uX1.value = x1;
        U.uSweepX.value = lerp(-64, 92, E.sine(prog(t, SWEEP[0], SWEEP[1])));
        U.uDrift.value = l;
        U.uFloor.value = 1 - ez(t, FLAT0, FLAT0 + 0.12, E.cubicOut);
        U.uFocus.value = rr - (ctx.portrait ? 60 : 46);
        U.uAperture.value = (ctx.portrait ? 30 : 40) * (1 - ez(t, FLAT0, FLAT0 + 0.2, E.cubicOut));
        S.edges.material.uniforms.uOpacity.value = 0.16 * (1 - 0.7 * F) * (1 - C);
        S.renderer.render(S.scene, cam);
      }

      // The hairline the points fall into, and its halo.
      const lw = Math.max(0, lx1 - lx0);
      const hairA = F * (1 - ez(t, CON[1] - 0.08, CON[1], E.cubicIn));
      if (show(S.hair, hairA * 0.9)) {
        S.hair.style.width = '100px';
        S.hair.style.transform = `translate(${lx0.toFixed(2)}px, ${ly.toFixed(2)}px) scaleX(${(lw / 100).toFixed(4)})`;
      }
      // The halo thins as the line shortens; the point's bloom takes over from it.
      const gA = F * (1 - ez(C, 0.7, 1, E.sine));
      if (show(S.lineGlow, gA * 0.8)) {
        const sx = (lw * 1.1) / 512;
        const sy = lerp(1, 0.4, C);
        S.lineGlow.style.transform = `translate(${(lx0 - lw * 0.05).toFixed(2)}px, ${(ly - 32 * sy).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      }

      // The point rides the line's centre, which lands on the apex; it swells into the hit.
      drawPoint(S.P, (lx0 + lx1) / 2, ly, C, lw, swellAt(t, span[1]), 1, S.L);
    },
    fx(t) {
      // No exposure lift: the light is the point's own. Past the cut it decays at
      // the apex, on top of the mark's tip, while the mark itself only appears.
      if (!S) return null;
      const l = t - span[1];
      const on = l >= 0 && l < AFTER;
      show(S.after, on ? 1 : 0);
      if (on) drawPoint(S.A, S.L.apex[0], S.L.apex[1], 1, 0, 1, Math.exp(-l * FALL_RATE) * (1 - ez(l, 0.15, AFTER, E.sine)), S.L);
      return null;
    },
  };
}

/** Area-weighted surface samples of a (non-indexed) geometry, with face normals. */
function samplePart(geom, density, seed, pts, nrm, rand, kind) {
  const pos = geom.attributes.position.array;
  const tris = pos.length / 9;
  const cum = new Float32Array(tris);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nn = new THREE.Vector3();
  let total = 0;
  for (let i = 0; i < tris; i++) {
    a.fromArray(pos, i * 9);
    b.fromArray(pos, i * 9 + 3).sub(a);
    c.fromArray(pos, i * 9 + 6).sub(a);
    total += b.cross(c).length() / 2;
    cum[i] = total;
  }
  const r = rng(seed);
  const n = Math.max(200, Math.round(total * density));
  for (let k = 0; k < n; k++) {
    const x = r() * total;
    let lo = 0;
    let hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = r();
    let v = r();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    a.fromArray(pos, lo * 9);
    b.fromArray(pos, lo * 9 + 3).sub(a);
    c.fromArray(pos, lo * 9 + 6).sub(a);
    pts.push(a.x + b.x * u + c.x * v, a.y + b.y * u + c.y * v, a.z + b.z * u + c.z * v);
    nn.crossVectors(b, c).normalize();
    nrm.push(nn.x, nn.y, nn.z);
    rand.push(r());
    kind.push(0);
  }
}

/** 0 below a, 1 above b, smooth between. */
function smoothEdge(x, a, b) {
  const k = clamp((x - a) / (b - a));
  return k * k * (3 - 2 * k);
}

/** The point's swell: 0 until the screen is black but the point, 1 on the hit, shaped like the score's reverse swell. */
function swellAt(t, hit) {
  const e0 = Math.exp(-(hit - DARK) / RISE_TAU);
  return clamp((Math.exp(-Math.max(0, hit - t) / RISE_TAU) - e0) / (1 - e0));
}

/** The point's layers inside `parent`: a wide halo, the bloom, the anamorphic flare, and the 6 px core. */
function pointLayers(parent) {
  const halo = sprite(256, 256, (x, y) => {
    const d = Math.hypot(x, y) * 2;
    return Math.exp(-(d * d) / (2 * 0.36 ** 2)) * (1 - smoothEdge(d, 0.8, 1));
  });
  const bloom = sprite(256, 256, (x, y) => {
    const d = Math.hypot(x, y) * 2;
    return Math.max(0, 0.7 * Math.exp(-(d * d) / 0.006) + 0.32 * Math.exp(-(d * d) / 0.05) + 0.1 * Math.exp(-(d * d) / 0.3)) * (1 - smoothEdge(d, 0.85, 1));
  });
  const flare = sprite(1024, 32, (x, y) => (1 - Math.abs(x) * 2) ** 2.4 * Math.exp(-((y * 32) ** 2) / (2 * 2.2 ** 2)));
  halo.className = 'fx halo';
  bloom.className = 'fx bloom';
  flare.className = 'fx flare';
  const core = document.createElement('div');
  core.className = 'core';
  parent.append(halo, bloom, flare, core);
  return { halo, bloom, flare, core };
}

/**
 * Draw the point at (x, y). C is the line's contraction (0..1), lw the line's
 * current length, swell the build into the hit (0..1), decay the afterglow past
 * it (1 until the cut, then falling to 0; the light also draws in as it fades).
 */
function drawPoint(P, x, y, C, lw, swell, decay, L) {
  const arrive = ez(C, 0.3, 1, E.cubicIn);
  if (show(P.core, ez(C, 0.6, 1, E.cubicIn) * decay)) P.core.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  const bA = arrive * (0.75 + 0.25 * swell) * decay;
  if (show(P.bloom, bA)) {
    const bs = lerp(1.2, 3.0, swell) * lerp(0.5, 1, arrive) * lerp(0.55, 1, decay);
    P.bloom.style.transform = `translate(${(x - 128 * bs).toFixed(2)}px, ${(y - 128 * bs).toFixed(2)}px) scale(${bs.toFixed(4)})`;
  }
  const fw = Math.max(260 + L.flare * swell, lw * 1.2) * lerp(0.2, 1, decay);
  const fA = ez(C, 0.15, 1, E.sine) * (0.55 + 0.45 * swell) * decay;
  if (show(P.flare, fA)) P.flare.style.transform = `translate(${(x - fw / 2).toFixed(2)}px, ${(y - 16).toFixed(2)}px) scale(${(fw / 1024).toFixed(4)}, 1)`;
  const hA = HALO_A * swell * decay;
  if (show(P.halo, hA)) {
    const hs = ((2 * L.halo) / 256) * lerp(0.6, 1, swell) * lerp(0.7, 1, decay);
    P.halo.style.transform = `translate(${(x - 128 * hs).toFixed(2)}px, ${(y - 128 * hs).toFixed(2)}px) scale(${hs.toFixed(4)})`;
  }
}
