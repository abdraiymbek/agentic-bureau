// The opening's own point cloud for the rover: area-weighted surface samples
// that keep their face normals, plus dense samples along the crisp edges, so a
// macro reads as hardware rather than noise. Lit by a raking light plane (a hot
// band with an afterglow behind it), a key, a rim, and depth-of-field bokeh.
// One THREE.Points per part goes into that part's stage group, so the stage's
// explode moves it; the stage's own points stay off.
import * as THREE from 'three';
import { rng } from './core.js';

/** Area-weighted surface samples with their triangle normals. */
function sampleSurface(geom, density, seed) {
  const pos = geom.attributes.position.array;
  const tris = pos.length / 9;
  const cum = new Float32Array(tris);
  const nrm = new Float32Array(tris * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  for (let i = 0; i < tris; i++) {
    a.fromArray(pos, i * 9);
    b.fromArray(pos, i * 9 + 3).sub(a);
    c.fromArray(pos, i * 9 + 6).sub(a);
    b.cross(c);
    const area = b.length() / 2;
    total += area;
    cum[i] = total;
    if (area > 0) b.normalize();
    nrm.set([b.x, b.y, b.z], i * 3);
  }
  const n = Math.max(120, Math.round(total * density));
  const r = rng(seed);
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
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
    for (let j = 0; j < 3; j++) {
      const p0 = pos[lo * 9 + j];
      P[k * 3 + j] = p0 + (pos[lo * 9 + 3 + j] - p0) * u + (pos[lo * 9 + 6 + j] - p0) * v;
      N[k * 3 + j] = nrm[lo * 3 + j];
    }
  }
  return { P, N, n };
}

/** Samples every `step` mm along each edge segment, with a little jitter. */
function sampleEdges(edges, step, seed) {
  const e = edges.attributes.position.array;
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < e.length; i += 6) {
    const dx = e[i + 3] - e[i];
    const dy = e[i + 4] - e[i + 1];
    const dz = e[i + 5] - e[i + 2];
    const len = Math.hypot(dx, dy, dz);
    const m = Math.max(1, Math.round(len / step));
    for (let k = 0; k < m; k++) {
      const f = (k + r()) / m;
      out.push(e[i] + dx * f, e[i + 1] + dy * f, e[i + 2] + dz * f);
    }
  }
  return new Float32Array(out);
}

const VS = `
uniform float uSize, uPx, uFocus, uAperture, uMaxSize, uThin, uSweepPos, uSweepW, uAhead, uAfter, uTrail, uHot, uFlare, uKey, uRim, uKeep, uEdge;
uniform vec3 uSweepDir, uBandDir, uKeyDir, uRimDir;
uniform vec4 uPinch; // xy: centre (NDC), zw: half-widths (NDC); a large width leaves that axis alone
attribute float aKind;
attribute float aRand;
varying float vA;
varying float vHot;
varying float vDisc;
void main() {
  if (aRand > mix(uKeep, 1.0, step(0.5, aKind))) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vec4 clip = projectionMatrix * mv;
  float depth = max(-mv.z, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 V = normalize(cameraPosition - wp.xyz);
  float edge = step(0.5, aKind);
  // Lambert against the key and the band's light; edges catch light from any side.
  float lk = mix(max(dot(n, uKeyDir), 0.0), 0.6, edge);
  float lb = mix(0.25 + 0.75 * max(dot(n, uBandDir), 0.0), 0.85, edge);
  float fres = mix(pow(1.0 - abs(dot(n, V)), 2.0), 0.45, edge);
  float rim = uRim * fres * mix(max(dot(n, uRimDir), 0.0), 0.6, edge);
  // The light plane: a hot band, an afterglow behind it, dim ahead.
  float s = dot(wp.xyz, uSweepDir) - uSweepPos;
  float band = exp(-(s * s) / (uSweepW * uSweepW));
  // Afterglow: strongest just behind the band, settling to half over uTrail mm.
  float behind = 1.0 - smoothstep(-uSweepW * 0.6, uSweepW * 1.2, s);
  float level = uAhead + (uAfter - uAhead) * behind * (0.5 + 0.5 * exp(min(s + uSweepW, 0.0) / uTrail));
  // Pinch: the band's light gathers toward one point on screen.
  vec2 q = (clip.xy / clip.w - uPinch.xy) / uPinch.zw;
  float pinch = exp(-dot(q, q));
  float hot = band * lb * uHot * pinch;
  float grain = 0.65 + 0.7 * fract(aRand * 7.31);
  float I = (level * (0.4 + 0.6 * lk) * mix(1.0, uEdge, edge) + hot + rim + uKey * lk) * grain;
  float base = uSize * uPx / depth * mix(1.0, 1.25, edge);
  float coc = abs(depth - uFocus) / depth * uAperture;
  float ps = clamp(base * (1.0 + uFlare * min(hot, 1.5)) + coc, 1.0, uMaxSize);
  // Bokeh thinning: far out of focus, draw a seeded fraction of the discs, each
  // brighter by the same factor, so the light is kept and the fill rate is not.
  // Discs near the cut fade rather than pop as the focus racks.
  float keep = clamp(uThin / max(coc * coc, 1.0), 0.06, 1.0);
  float thin = clamp((keep - fract(aRand * 13.37)) / (0.2 * keep) + 1.0, 0.0, 1.0);
  if (thin <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_PointSize = ps;
  // A defocused point spreads the same light over a larger disc.
  vA = I * clamp((base * base) / (ps * ps), 0.05, 1.0) * thin / keep;
  vHot = clamp(hot * 1.2, 0.0, 1.0);
  vDisc = clamp(coc / 5.0, 0.0, 1.0);
  gl_Position = clip;
}`;

const FS = `
uniform float uOpacity;
uniform vec3 uColor;
varying float vA;
varying float vHot;
varying float vDisc;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.12, 0.5, r);
  float disc = (1.0 - smoothstep(0.38, 0.5, r)) * (0.78 + 0.22 * smoothstep(0.22, 0.46, r));
  float a = clamp(mix(soft, disc, vDisc) * vA * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), vHot) * a, a);
}`;

/**
 * Build a cloud for every stage part. dens(id) → { surface: points per mm²,
 * edge: mm between edge samples }. Returns { uniforms, set(values), points }.
 */
export function attachCloud(stage, canvas, dens) {
  const uniforms = {
    uSize: { value: 0.5 },
    uPx: { value: canvas.height / 2 / Math.tan((26 * Math.PI) / 360) },
    uFocus: { value: 200 },
    uAperture: { value: 0 },
    uMaxSize: { value: 24 },
    uThin: { value: 64 },
    uSweepPos: { value: -1000 },
    uSweepW: { value: 10 },
    uSweepDir: { value: new THREE.Vector3(1, 0, 0) },
    uAhead: { value: 0.06 },
    uAfter: { value: 0.15 },
    uTrail: { value: 30 },
    uHot: { value: 1 },
    uFlare: { value: 0.4 },
    uKey: { value: 0 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uRim: { value: 0 },
    uRimDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeep: { value: 1 },
    uEdge: { value: 1.4 },
    uBandDir: { value: new THREE.Vector3(0, 1, 0) },
    uPinch: { value: new THREE.Vector4(0, 0, 100, 100) },
    uOpacity: { value: 1 },
    uColor: { value: new THREE.Color(0xa4a7ae) },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const points = stage.parts.map((p, i) => {
    const d = dens(p.id);
    const s = sampleSurface(p.geom, d.surface, 4000 + i * 131);
    const e = sampleEdges(p.edges.isLineSegments ? p.edges.geometry : p.edges, d.edge, 9000 + i * 71);
    const ne = e.length / 3;
    const n = s.n + ne;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const kind = new Float32Array(n);
    const rand = new Float32Array(n);
    pos.set(s.P, 0);
    nrm.set(s.N, 0);
    pos.set(e, s.n * 3);
    kind.fill(1, s.n);
    for (let k = s.n; k < n; k++) nrm[k * 3 + 1] = 1; // edges carry no face normal
    const r = rng(77 + i);
    for (let k = 0; k < n; k++) rand[k] = r() * 0.999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    p.group.add(pts);
    return pts;
  });
  return {
    mat,
    uniforms,
    points,
    count: points.reduce((a, p) => a + p.geometry.attributes.position.count, 0),
    set(v) {
      for (const k in v) {
        const u = uniforms[k];
        if (!u) continue;
        if (u.value?.isVector3) u.value.set(...v[k]).normalize();
        else if (u.value?.isVector4) u.value.set(...v[k]);
        else if (u.value?.isColor) u.value.set(v[k]);
        else u.value = v[k];
      }
    },
  };
}
