// Procedural score and sound design for the trailer, synthesised sample by
// sample so it stays in lockstep with the visual timeline (120 BPM, 0.5 s beat).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TAU = Math.PI * 2;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function writeSoundtrack(file, duration = 18.5) {
  const N = Math.ceil(duration * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const sendL = new Float32Array(N);
  const sendR = new Float32Array(N);
  const duck = new Float32Array(N).fill(1);
  const rand = rng(7);

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

  /* Kick with sidechain ducking of the pad. */
  const kick = (t, gain = 1) => {
    const s0 = Math.round(t * SR);
    let ph = 0;
    for (let i = 0; i < SR * 0.5; i++) {
      const x = i / SR;
      const f = 44 + 110 * Math.exp(-x * 28);
      ph += (TAU * f) / SR;
      const v = Math.sin(ph) * Math.exp(-x * 7) * gain * 0.8 + (i < 90 ? (rand() - 0.5) * 0.25 * gain : 0);
      put(s0 + i, v, v);
      const d = 1 - 0.6 * gain * Math.exp(-x * 9);
      if (s0 + i < N) duck[s0 + i] = Math.min(duck[s0 + i], d);
    }
  };

  const hat = (t, gain, p = 0) => {
    const s0 = Math.round(t * SR);
    let prev = 0;
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * 0.06; i++) {
      const n = rand() * 2 - 1;
      const hp = n - prev;
      prev = n;
      const v = hp * Math.exp(-(i / SR) * 90) * gain;
      put(s0 + i, v * gl, v * gr, 0.1);
    }
  };

  const tick = (t, gain, p = 0, tone = 3200) => {
    const s0 = Math.round(t * SR);
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * 0.02; i++) {
      const x = i / SR;
      const v = (Math.sin(TAU * tone * x) * 0.6 + (rand() - 0.5)) * Math.exp(-x * 400) * gain;
      put(s0 + i, v * gl, v * gr, 0.15);
    }
  };

  /** Band-passed noise sweep; dir > 0 rises, < 0 falls. */
  const whoosh = (t, dur, gain, f0, f1, p0 = -0.6, p1 = 0.6, attack = 0.5) => {
    const s0 = Math.round(t * SR);
    const n = Math.round(dur * SR);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const f = f0 * (f1 / f0) ** k;
      const q = 2.2;
      const w = (TAU * f) / SR;
      const alpha = Math.sin(w) / (2 * q);
      const b0 = alpha;
      const a1 = -2 * Math.cos(w);
      const a2 = 1 - alpha;
      const a0 = 1 + alpha;
      const x = rand() * 2 - 1;
      const y = (b0 * x - a1 * y1 - a2 * y2) / a0;
      y2 = y1;
      y1 = y;
      const env = k < attack ? Math.sin((Math.PI / 2) * (k / attack)) ** 2 : Math.cos((Math.PI / 2) * ((k - attack) / (1 - attack))) ** 2;
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
      const v = (Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-x / decay * 2.2) + lp * noise * Math.exp(-x * 3.5)) * gain;
      put(s0 + i, v, v, 0.35);
    }
  };

  const bell = (t, note, gain, p = 0, decay = 1.6) => {
    const s0 = Math.round(t * SR);
    const f = midi(note);
    const [gl, gr] = pan(p);
    for (let i = 0; i < SR * decay * 2; i++) {
      const x = i / SR;
      const a = Math.min(1, x * 300) * Math.exp(-x / decay * 3);
      const v =
        (Math.sin(TAU * f * x) + 0.35 * Math.sin(TAU * f * 2.01 * x) * Math.exp(-x * 6) + 0.12 * Math.sin(TAU * f * 3.99 * x) * Math.exp(-x * 10)) *
        a *
        gain;
      put(s0 + i, v * gl, v * gr, 0.55);
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

  /* Pad: detuned saws through a moving low-pass, ducked by the kick. */
  const chordA = [40, 47, 52, 55, 59, 62]; // E minor 9 colour
  const chordB = [40, 47, 52, 56, 59, 63, 66]; // E major 9 resolve
  const padVoices = [];
  for (const [chord, t0, t1] of [
    [chordA, 0.0, 15.45],
    [chordB, 15.5, duration],
  ])
    for (const n of chord)
      for (const det of [-0.08, 0.08]) padVoices.push({ f: midi(n + det), t0, t1, ph: rand(), p: det > 0 ? 0.5 : -0.5 });
  const cutoff = (t) => {
    if (t < 15.45) return 250 + 1500 * Math.min(1, t / 14) ** 2 + (t > 14 ? (t - 14) * 1800 : 0);
    return 2600 * Math.exp(-(t - 15.5) * 0.35) + 500;
  };
  const padGain = (t) => {
    if (t < 15.45) return 0.05 * Math.min(1, t / 2.2) * (t > 15.2 ? Math.max(0, (15.45 - t) / 0.25) : 1);
    return 0.07 * Math.min(1, (t - 15.5) / 0.05) * Math.max(0, Math.min(1, (duration - 0.1 - t) / 1.6));
  };
  const lp = [0, 0];
  const lp2 = [0, 0];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let l = 0;
    let r = 0;
    for (const v of padVoices) {
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
    const g = padGain(t) * (t < 15.45 ? duck[i] : 1);
    put(i, lp2[0] * g, lp2[1] * g, 0.3);
  }

  /* Sub drone under the whole piece. */
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const g = 0.09 * Math.min(1, t / 3) * (t < 15.45 ? 1 : 0) * duck[i];
    const v = Math.sin(TAU * midi(28) * t) * g;
    put(i, v, v);
  }

  /* Rhythm: heartbeat from the flow reveal, hats once the thread lights. */
  for (let b = 5; b <= 28; b++) {
    const t = b * 0.5;
    if (t >= 14.5) break;
    kick(t, b % 4 === 1 ? 1 : 0.62);
  }
  for (let s = 18; s < 58; s++) {
    const t = s * 0.25;
    hat(t, s % 2 ? 0.11 : 0.05, s % 2 ? 0.35 : -0.35);
  }
  for (let s = 0; s < 16; s++) hat(10.5 + s * 0.125, s % 2 ? 0.06 : 0.035, s % 2 ? 0.4 : -0.4);

  /* Typing. */
  for (let t = 0.5; t < 1.62; t += 0.028 + rand() * 0.02) tick(t, 0.22, rand() * 0.6 - 0.3);
  for (let t = 11.12; t < 11.62; t += 0.035 + rand() * 0.025) tick(t, 0.16, rand() * 0.6 - 0.3);
  for (let t = 13.15; t < 14.15; t += 0.03 + rand() * 0.025) tick(t, 0.12, -0.5 + rand() * 0.3);
  for (let i = 0; i < 4; i++) tick(1.72 + i * 0.13, 0.25, 0, 1800);

  /* Transitions. */
  whoosh(2.2, 1.1, 0.5, 300, 4200, -0.7, 0.4, 0.3);
  boom(2.5, 0.55, 90, 38, 1.2, 0.3);
  gliss(5.18, 0.7, 520, 1560, 0.07, 0.3);
  bell(5.22, 83, 0.05, 0.4, 1.2);
  tick(6.44, 0.5, 0.2, 2400);
  whoosh(6.28, 0.44, 0.55, 200, 6000, 0.2, 0, 0.92);
  boom(6.72, 0.7, 110, 36, 1.4, 0.5);
  bell(6.74, 76, 0.07, -0.3, 1.5);
  for (const [i, t] of [8.38, 8.88, 9.38, 9.88, 10.38].entries()) {
    whoosh(t - 0.02, 0.3, 0.42, 900, 5200, 0.8, -0.8, 0.45);
    tick(t + 0.12, 0.35, 0, 1400 + i * 180);
  }
  tick(11.9, 0.6, 0.1, 2600);
  bell(11.95, 76, 0.1, -0.2, 1.4);
  bell(12.08, 83, 0.09, 0.2, 1.6);
  whoosh(12.36, 0.6, 0.45, 5000, 300, 0.4, -0.4, 0.2);
  for (const [t, n] of [
    [13.28, 69],
    [13.6, 67],
    [13.9, 64],
  ])
    bell(t, n, 0.065, 0.5, 0.8);

  /* Riser into the convergence, a breath of silence, then the impact. */
  whoosh(13.95, 1.5, 0.5, 250, 9000, -0.3, 0.3, 0.97);
  {
    const s0 = Math.round(14.05 * SR);
    let ph = 0;
    for (let i = 0; i < 1.4 * SR; i++) {
      const k = i / (1.4 * SR);
      ph += (TAU * (140 * (1900 / 140) ** (k * k))) / SR;
      const v = Math.sin(ph) * k ** 2.2 * 0.11;
      put(s0 + i, v, v, 0.3);
    }
  }
  boom(15.5, 1.0, 64, 27, 2.6, 0.9);
  whoosh(15.5, 2.8, 0.35, 9000, 1200, -0.2, 0.2, 0.02);
  [76, 83, 80, 88, 87].forEach((n, i) => bell(15.62 + i * 0.3, n, 0.075 - i * 0.008, i % 2 ? 0.45 : -0.45, 2.2));

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
    const fade = Math.min(1, t / 0.05) * Math.min(1, Math.max(0, (duration - t) / 0.5));
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
  const out = new URL('../out/trailer-audio.wav', import.meta.url);
  fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  console.log(writeSoundtrack(fileURLToPath(out)));
}
