// Procedural score for the use-case showcase, synthesised sample by sample from
// the same cue sheet as the picture (showcase/cues.js), so keystrokes, node
// arrivals and clicks land on their frames. 120 BPM from the moment the prompt
// is sent; each chapter of the build adds a layer, the decision resolves it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BEAT0, CALLS, CUE, NODE_TIMES, TYPE_TIMES } from '../showcase/cues.js';

const SR = 48000;
const TAU = Math.PI * 2;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const beat = (n) => BEAT0 + n / 2;

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function writeSoundtrack(file, duration) {
  const N = Math.ceil(duration * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const sendL = new Float32Array(N);
  const sendR = new Float32Array(N);
  const duck = new Float32Array(N).fill(1);
  const rand = rng(23);

  const put = (i, l, r, send = 0) => {
    if (i < 0 || i >= N) return;
    L[i] += l;
    R[i] += r;
    if (send) {
      sendL[i] += l * send;
      sendR[i] += r * send;
    }
  };
  const pan = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

  const kick = (t, gain = 1) => {
    const s0 = Math.round(t * SR);
    let ph = 0;
    for (let i = 0; i < SR * 0.45; i++) {
      const x = i / SR;
      const f = 46 + 100 * Math.exp(-x * 30);
      ph += (TAU * f) / SR;
      const v = Math.sin(ph) * Math.exp(-x * 8) * gain * 0.75 + (i < 80 ? (rand() - 0.5) * 0.2 * gain : 0);
      put(s0 + i, v, v);
      const d = 1 - 0.55 * gain * Math.exp(-x * 9);
      if (s0 + i < N) duck[s0 + i] = Math.min(duck[s0 + i], d);
    }
  };

  const hat = (t, gain, p = 0) => {
    const s0 = Math.round(t * SR);
    let prev = 0;
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * 0.05; i++) {
      const n = rand() * 2 - 1;
      const hp = n - prev;
      prev = n;
      const v = hp * Math.exp(-(i / SR) * 95) * gain;
      put(s0 + i, v * gl, v * gr, 0.1);
    }
  };

  /** A key, a click, a ledger row: short noise with a tonal body. */
  const tick = (t, gain, p = 0, tone = 3200, decay = 400) => {
    const s0 = Math.round(t * SR);
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * 0.03; i++) {
      const x = i / SR;
      const v = (Math.sin(TAU * tone * x) * 0.6 + (rand() - 0.5)) * Math.exp(-x * decay) * gain;
      put(s0 + i, v * gl, v * gr, 0.15);
    }
  };

  /** A soft keyboard key: a low thock under a small click. */
  const key = (t, gain, p = 0) => {
    const s0 = Math.round(t * SR);
    const [gl, gr] = pan(p);
    const body = 180 + rand() * 60;
    let lp = 0;
    for (let i = 0; i < SR * 0.06; i++) {
      const x = i / SR;
      const n = rand() * 2 - 1;
      lp += (n - lp) * 0.35;
      const v = (Math.sin(TAU * body * x) * Math.exp(-x * 70) * 0.7 + lp * Math.exp(-x * 260) * 0.9) * gain;
      put(s0 + i, v * gl, v * gr, 0.08);
    }
  };

  const whoosh = (t, dur, gain, f0, f1, p0 = -0.6, p1 = 0.6, attack = 0.5) => {
    const s0 = Math.round(t * SR);
    const n = Math.round(dur * SR);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const f = f0 * (f1 / f0) ** k;
      const w = (TAU * f) / SR;
      const alpha = Math.sin(w) / (2 * 2.2);
      const a0 = 1 + alpha;
      const x = rand() * 2 - 1;
      const y = (alpha * x + 2 * Math.cos(w) * y1 - (1 - alpha) * y2) / a0;
      y2 = y1;
      y1 = y;
      const env =
        k < attack
          ? Math.sin((Math.PI / 2) * (k / attack)) ** 2
          : Math.cos((Math.PI / 2) * ((k - attack) / (1 - attack))) ** 2;
      const [gl, gr] = pan(p0 + (p1 - p0) * k);
      const v = y * env * gain * 3;
      put(s0 + i, v * gl, v * gr, 0.25);
    }
  };

  const boom = (t, gain, f0 = 70, f1 = 30, decay = 2.2, noise = 0.4) => {
    const s0 = Math.round(t * SR);
    let ph = 0;
    let lp = 0;
    for (let i = 0; i < SR * decay * 1.6; i++) {
      const x = i / SR;
      const f = f1 + (f0 - f1) * Math.exp(-x * 5);
      ph += (TAU * f) / SR;
      const n = rand() * 2 - 1;
      lp += (n - lp) * (0.02 + 0.3 * Math.exp(-x * 14));
      const v =
        (Math.tanh(Math.sin(ph) * 1.6) * Math.exp((-x / decay) * 2.2) + lp * noise * Math.exp(-x * 3.5)) * gain;
      put(s0 + i, v, v, 0.35);
    }
  };

  const bell = (t, note, gain, p = 0, decay = 1.6) => {
    const s0 = Math.round(t * SR);
    const f = midi(note);
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * decay * 2; i++) {
      const x = i / SR;
      const a = Math.min(1, x * 300) * Math.exp((-x / decay) * 3);
      const v =
        (Math.sin(TAU * f * x) +
          0.35 * Math.sin(TAU * f * 2.01 * x) * Math.exp(-x * 6) +
          0.12 * Math.sin(TAU * f * 3.99 * x) * Math.exp(-x * 10)) *
        a *
        gain;
      put(s0 + i, v * gl, v * gr, 0.55);
    }
  };

  /** A plucked note for each object arriving on the map. */
  const pluck = (t, note, gain, p = 0) => {
    const s0 = Math.round(t * SR);
    const f = midi(note);
    const [gl, gr] = pan(p);
    let ph = 0;
    let lp = 0;
    for (let i = 0; i < SR * 0.9; i++) {
      const x = i / SR;
      ph = (ph + f / SR) % 1;
      const saw = 2 * ph - 1;
      const cut = 0.04 + 0.5 * Math.exp(-x * 18);
      lp += (saw - lp) * cut;
      const v = lp * Math.min(1, x * 600) * Math.exp(-x * 5.5) * gain;
      put(s0 + i, v * gl, v * gr, 0.4);
    }
  };

  const gliss = (t, dur, f0, f1, gain, p = 0) => {
    const s0 = Math.round(t * SR);
    let ph = 0;
    const [gl, gr] = pan(p);
    for (let i = 0; i < dur * SR; i++) {
      const k = i / (dur * SR);
      ph += (TAU * f0 * (f1 / f0) ** k) / SR;
      const v = Math.sin(ph) * Math.sin(Math.PI * k) ** 2 * gain;
      put(s0 + i, v * gl, v * gr, 0.5);
    }
  };

  /* Pad: detuned saws through a low-pass that opens chapter by chapter. */
  const minor = [40, 47, 52, 55, 59, 62, 66]; // E minor 9
  const major = [40, 47, 52, 56, 59, 63, 66]; // E major 9: the decision resolves it
  const voices = [];
  for (const [chord, t0, t1] of [
    [minor, 0, CUE.approved - 0.02],
    [major, CUE.approved, duration],
  ])
    for (const n of chord)
      for (const det of [-0.07, 0.07]) voices.push({ f: midi(n + det), t0, t1, ph: rand(), p: det > 0 ? 0.55 : -0.55 });
  const cutoff = (t) => {
    if (t >= CUE.approved) return 600 + 2600 * Math.exp(-(t - CUE.approved) * 0.4);
    const steps = [
      [0, 220],
      [CUE.ch1, 420],
      [CUE.ch2, 650],
      [CUE.ch3, 900],
      [CUE.ch4, 1300],
      [CUE.whole, 1800],
      [29.4, 700],
      [CUE.approved - 0.3, 2400],
    ];
    let c = steps[0][1];
    for (let i = 1; i < steps.length; i++) {
      const [ts, v] = steps[i];
      const [, pv] = steps[i - 1];
      if (t >= ts) c = pv + (v - pv) * Math.min(1, (t - ts) / 0.8);
    }
    return c;
  };
  const padGain = (t) => {
    const fadeIn = Math.min(1, t / 1.5);
    const out = Math.max(0, Math.min(1, (duration - 0.2 - t) / 2.2));
    const gap = t > CUE.approved - 0.2 && t < CUE.approved ? (CUE.approved - t) / 0.2 : 1;
    return (t < CUE.approved ? 0.045 : 0.07) * fadeIn * out * gap;
  };
  const lp = [0, 0];
  const lp2 = [0, 0];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let l = 0;
    let r = 0;
    for (const v of voices) {
      if (t < v.t0 || t > v.t1) continue;
      v.ph = (v.ph + v.f / SR) % 1;
      const s = 2 * v.ph - 1;
      const [gl, gr] = pan(v.p);
      l += s * gl;
      r += s * gr;
    }
    const a = 1 - Math.exp((-TAU * cutoff(t)) / SR);
    lp[0] += (l - lp[0]) * a;
    lp[1] += (r - lp[1]) * a;
    lp2[0] += (lp[0] - lp2[0]) * a;
    lp2[1] += (lp[1] - lp2[1]) * a;
    const g = padGain(t) * duck[i];
    put(i, lp2[0] * g, lp2[1] * g, 0.3);
  }

  /* Sub under the build, gone for the breath before the decision. */
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const on = Math.min(1, Math.max(0, (t - BEAT0) / 2)) * (t < 29.4 ? 1 : t < CUE.approved ? 0.3 : Math.max(0, 1 - (t - CUE.approved) / 4));
    const v = Math.sin(TAU * midi(28) * t) * 0.08 * on * duck[i];
    put(i, v, v);
  }

  /* Rhythm: a heartbeat while the agent works, layers added per chapter. */
  const lastBeat = Math.floor((29.4 - BEAT0) * 2);
  for (let b = 0; b <= lastBeat; b++) {
    const t = beat(b);
    if (t >= CUE.ch1 || b % 2 === 0) kick(t, b % 4 === 0 ? 0.95 : 0.6);
  }
  for (let s = 0; beat(s / 2) < 29.3; s++) {
    const t = beat(s / 2);
    if (t < CUE.ch2) continue;
    hat(t, s % 2 ? 0.1 : 0.045, s % 2 ? 0.35 : -0.35);
  }
  // From Design on, a quiet sixteenth arpeggio climbs the minor pentatonic.
  const pent = [64, 67, 69, 71, 74, 76, 79, 81];
  for (let s = 0; beat(s / 4) < 29.3; s++) {
    const t = beat(s / 4);
    if (t < CUE.ch3) continue;
    const g = t < CUE.ch4 ? 0.022 : 0.03;
    bell(t, pent[(s * 3) % pent.length], g, (s % 4) / 2 - 0.75, 0.35);
  }

  /* Ask: the window, the keys, send. */
  bell(0.35, 76, 0.05, -0.2, 2.2);
  tick(CUE.clickComposer, 0.35, 0.1, 2200, 520);
  TYPE_TIMES.forEach((t, i) => key(t, 0.32 + rand() * 0.12, Math.sin(i * 1.7) * 0.25));
  tick(CUE.clickSend, 0.55, 0.15, 2400, 520);
  whoosh(CUE.clickSend - 0.1, 0.55, 0.45, 300, 5200, 0.1, -0.2, 0.75);
  boom(CUE.clickSend + 0.02, 0.45, 90, 38, 1.0, 0.25);
  bell(CUE.clickSend + 0.05, 71, 0.06, 0.3, 1.4);
  for (const [t] of CALLS) tick(t, 0.16, 0.6, 3800, 600);
  tick(CUE.clickFlow, 0.45, -0.4, 2300, 520);
  whoosh(CUE.clickFlow - 0.05, 0.6, 0.4, 600, 4200, -0.5, 0.4, 0.4);

  /* Build: every object lands with a note, higher with each layer. */
  const LAYER = { req: 0, asm: 0, s: 1, c: 1, arch: 2, hinge: 2, mount: 2, wiring: 2, assembly: 2 };
  const notes = [52, 55, 57, 59, 62, 64, 67, 69, 71, 74, 76];
  Object.entries(NODE_TIMES)
    .sort((a, b) => a[1] - b[1])
    .forEach(([id, t], i) => {
      const layer = LAYER[id.split('_')[0]] ?? LAYER[id.replace(/\d+$/, '')] ?? 3;
      const n = notes[Math.min(notes.length - 1, layer * 2 + (i % 4))] + 12;
      pluck(t, n, 0.07, ((i % 5) - 2) * 0.25);
      tick(t, 0.08, ((i % 5) - 2) * 0.25, 5200, 900);
    });
  for (const [t, n] of [
    [CUE.ch1, 76],
    [CUE.ch2, 79],
    [CUE.ch3, 81],
    [CUE.ch4, 83],
  ]) {
    boom(t, 0.32, 80, 40, 0.9, 0.15);
    bell(t + 0.02, n, 0.06, 0.2, 1.8);
    whoosh(t - 0.45, 0.6, 0.3, 400, 3800, -0.6, 0.6, 0.85);
  }

  /* The part renders: a click, then a scan rising through it. */
  tick(CUE.clickShow3d, 0.45, 0.3, 2400, 520);
  gliss(CUE.clickShow3d + 0.3, 1.8, 220, 880, 0.05, 0.2);
  whoosh(CUE.clickShow3d + 0.25, 1.9, 0.18, 300, 2400, 0.4, -0.2, 0.7);

  /* The whole map, a proposal arrives, the thread lights. */
  whoosh(CUE.whole - 0.3, 1.2, 0.35, 5000, 400, 0.3, -0.3, 0.2);
  bell(CUE.proposal + 0.2, 83, 0.06, 0.4, 1.2);
  bell(CUE.proposal + 0.32, 88, 0.05, 0.5, 1.4);
  gliss(CUE.hover + 0.08, 1.3, 660, 1320, 0.035, -0.3);
  [64, 71, 76, 79].forEach((n, i) => bell(CUE.hover + 0.1 + i * 0.12, n + 12, 0.035, -0.4 + i * 0.25, 1.2));

  /* Decide: a breath, three deliberate clicks, then the resolve. */
  whoosh(29.0, 1.0, 0.3, 4000, 300, -0.2, 0.3, 0.15);
  tick(CUE.clickCheck, 0.5, 0.2, 2600, 520);
  tick(CUE.clickApprove, 0.5, 0.2, 2200, 520);
  tick(CUE.clickConfirm, 0.6, 0.2, 2000, 480);
  {
    const s0 = Math.round((CUE.clickConfirm + 0.02) * SR);
    const len = (CUE.approved - CUE.clickConfirm) * SR;
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len;
      ph += (TAU * (180 * (1600 / 180) ** (k * k))) / SR;
      const v = Math.sin(ph) * k ** 2 * 0.09;
      put(s0 + i, v, v, 0.3);
    }
  }
  boom(CUE.approved, 0.95, 64, 27, 2.4, 0.8);
  whoosh(CUE.approved, 2.6, 0.3, 9000, 1200, -0.2, 0.2, 0.02);
  [76, 83, 80, 88].forEach((n, i) => bell(CUE.approved + 0.05 + i * 0.26, n, 0.07 - i * 0.01, i % 2 ? 0.45 : -0.45, 2.2));

  /* End card. */
  whoosh(CUE.pullBack, 1.2, 0.25, 3000, 500, 0.2, -0.2, 0.3);
  bell(CUE.end + 0.05, 76, 0.07, -0.2, 2.6);
  bell(CUE.end + 0.35, 83, 0.06, 0.25, 2.6);
  bell(CUE.end + 0.65, 88, 0.05, 0, 3.2);
  boom(CUE.end, 0.4, 60, 30, 2.0, 0.2);

  /* Reverb send: a small Freeverb-style network. */
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((n) => Math.round(n * (SR / 44100) * 1.25));
  const verb = (input, spread) => {
    const out = new Float32Array(N);
    for (const len0 of combs) {
      const len = len0 + spread;
      const buf = new Float32Array(len);
      let idx = 0;
      let filt = 0;
      for (let i = 0; i < N; i++) {
        const y = buf[idx];
        filt = y * 0.72 + filt * 0.28;
        buf[idx] = input[i] + filt * 0.86;
        out[i] += y;
        idx = (idx + 1) % len;
      }
    }
    for (const len0 of [556, 441, 341, 225]) {
      const len = Math.round(len0 * (SR / 44100)) + spread;
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[idx];
        const y = -out[i] + b;
        buf[idx] = out[i] + b * 0.5;
        out[i] = y;
        idx = (idx + 1) % len;
      }
    }
    return out;
  };
  const vl = verb(sendL, 0);
  const vr = verb(sendR, 23);

  /* Master: sum, gentle saturation, fades, normalise. */
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const fade = Math.min(1, t / 0.05) * Math.min(1, Math.max(0, (duration - t) / 0.6));
    L[i] = Math.tanh((L[i] + vl[i] * 0.09) * 1.15) * fade;
    R[i] = Math.tanh((R[i] + vr[i] * 0.09) * 1.15) * fade;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = 0.89 / peak;

  const data = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    data.writeInt16LE(Math.round(L[i] * norm * 32767), i * 4);
    data.writeInt16LE(Math.round(R[i] * norm * 32767), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DURATION } = await import('../showcase/cues.js');
  const out = new URL('../out/showcase-audio.wav', import.meta.url);
  fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  console.log(writeSoundtrack(fileURLToPath(out), DURATION));
}
