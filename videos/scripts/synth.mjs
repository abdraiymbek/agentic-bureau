// A small sample-accurate synthesiser for film scores: instruments write into a
// stereo buffer with a reverb send and a sidechain duck track, then master()
// sums, saturates, fades and returns 16-bit WAV bytes. Deterministic: the same
// cue list always produces the same file.
import fs from 'node:fs';

export const SR = 48000;
const TAU = Math.PI * 2;
export const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// Fixed-length voices stop while still a few per cent loud; a 30 ms taper over
// the last samples keeps that cut from clicking.
const endTaper = (i, n) => Math.min(1, (n - i) / (SR * 0.03));

function lcg(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function createMix(duration, seed = 7) {
  const N = Math.ceil(duration * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const sendL = new Float32Array(N);
  const sendR = new Float32Array(N);
  const duck = new Float32Array(N).fill(1);
  const rand = lcg(seed);

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

  const I = {
    N,
    duck,
    rand,
    put,
    pan,

    /** Kick with sidechain ducking (depth 0–1) of anything that reads `duck`. */
    kick(t, gain = 1, { f0 = 150, f1 = 44, depth = 0.6, click = 0.25 } = {}) {
      const s0 = Math.round(t * SR);
      const n = SR * 0.5;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const f = f1 + (f0 - f1) * Math.exp(-x * 28);
        ph += (TAU * f) / SR;
        const v = Math.sin(ph) * Math.exp(-x * 7) * endTaper(i, n) * gain * 0.8 + (i < 90 ? (rand() - 0.5) * click * gain : 0);
        put(s0 + i, v, v);
        const d = 1 - depth * gain * Math.exp(-x * 9);
        if (s0 + i < N && s0 + i >= 0) duck[s0 + i] = Math.min(duck[s0 + i], d);
      }
    },

    hat(t, gain, p = 0, decay = 90) {
      const s0 = Math.round(t * SR);
      let prev = 0;
      const [gl, gr] = pan(p);
      for (let i = 0; i < SR * 0.08; i++) {
        const n = rand() * 2 - 1;
        const hp = n - prev;
        prev = n;
        const v = hp * Math.exp(-(i / SR) * decay) * gain;
        put(s0 + i, v * gl, v * gr, 0.1);
      }
    },

    /** Short clap/snare: noise burst through a band, with a body tone. */
    snare(t, gain, p = 0) {
      const s0 = Math.round(t * SR);
      const [gl, gr] = pan(p);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      const f = 1800;
      const w = (TAU * f) / SR;
      const alpha = Math.sin(w) / (2 * 0.9);
      const a0 = 1 + alpha;
      for (let i = 0; i < SR * 0.25; i++) {
        const x = i / SR;
        const n = rand() * 2 - 1;
        // RBJ band-pass (b0 = α, b2 = −α): without the zero at DC the
        // resonator passed the sub band louder than the centre.
        const y = (alpha * (n - x2) + 2 * Math.cos(w) * y1 - (1 - alpha) * y2) / a0;
        x2 = x1;
        x1 = n;
        y2 = y1;
        y1 = y;
        const v = (y * 2.2 * Math.exp(-x * 22) + Math.sin(TAU * 190 * x) * 0.35 * Math.exp(-x * 30)) * gain;
        put(s0 + i, v * gl, v * gr, 0.25);
      }
    },

    tick(t, gain, p = 0, tone = 3200) {
      const s0 = Math.round(t * SR);
      const [gl, gr] = pan(p);
      for (let i = 0; i < SR * 0.02; i++) {
        const x = i / SR;
        const v = (Math.sin(TAU * tone * x) * 0.6 + (rand() - 0.5)) * Math.exp(-x * 400) * gain;
        put(s0 + i, v * gl, v * gr, 0.15);
      }
    },

    /** Band-passed noise sweep from f0 to f1 Hz. */
    whoosh(t, dur, gain, f0, f1, p0 = -0.6, p1 = 0.6, attack = 0.5, q = 2.2) {
      const s0 = Math.round(t * SR);
      const n = Math.round(dur * SR);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < n; i++) {
        const k = i / n;
        const f = f0 * (f1 / f0) ** k;
        const w = (TAU * f) / SR;
        const alpha = Math.sin(w) / (2 * q);
        const a1 = -2 * Math.cos(w);
        const a2 = 1 - alpha;
        const a0 = 1 + alpha;
        const x = rand() * 2 - 1;
        const y = (alpha * (x - x2) - a1 * y1 - a2 * y2) / a0; // RBJ band-pass, as in snare
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        const e = k < attack ? Math.sin((Math.PI / 2) * (k / attack)) ** 2 : Math.cos((Math.PI / 2) * ((k - attack) / (1 - attack))) ** 2;
        const [gl, gr] = pan(p0 + (p1 - p0) * k);
        const v = y * e * gain * 3;
        put(s0 + i, v * gl, v * gr, 0.25);
      }
    },

    /** Sub boom: pitched drop with a noise tail. */
    boom(t, gain, f0 = 70, f1 = 30, decay = 2.2, noise = 0.4) {
      const s0 = Math.round(t * SR);
      const len = Math.round(SR * decay * 1.6);
      let ph = 0;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / SR;
        const f = f1 + (f0 - f1) * Math.exp(-x * 5);
        ph += (TAU * f) / SR;
        const n = rand() * 2 - 1;
        lp += (n - lp) * (0.02 + 0.3 * Math.exp(-x * 14));
        const v = (Math.tanh(Math.sin(ph) * 1.6) * Math.exp((-x / decay) * 2.2) + lp * noise * Math.exp(-x * 3.5)) * endTaper(i, len) * gain;
        put(s0 + i, v, v, 0.35);
      }
    },

    bell(t, note, gain, p = 0, decay = 1.6, send = 0.55) {
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
        put(s0 + i, v * gl, v * gr, send);
      }
    },

    /** Plucked saw through a closing low-pass: arps and stabs. */
    pluck(t, note, gain, p = 0, decay = 0.35, bright = 4000) {
      const s0 = Math.round(t * SR);
      const f = midi(note);
      const [gl, gr] = pan(p);
      let ph = rand();
      let lp = 0;
      const len = Math.round(SR * decay * 3);
      for (let i = 0; i < len; i++) {
        const x = i / SR;
        ph = (ph + f / SR) % 1;
        const s = 2 * ph - 1;
        const fc = 200 + bright * Math.exp(-x * 18);
        lp += (s - lp) * (1 - Math.exp((-TAU * fc) / SR));
        const v = lp * Math.min(1, x * 800) * Math.exp(-x / decay) * endTaper(i, len) * gain;
        put(s0 + i, v * gl, v * gr, 0.4);
      }
    },

    gliss(t, dur, f0, f1, gain, p = 0) {
      const s0 = Math.round(t * SR);
      let ph = 0;
      const [gl, gr] = pan(p);
      for (let i = 0; i < dur * SR; i++) {
        const k = i / (dur * SR);
        ph += (TAU * f0 * (f1 / f0) ** k) / SR;
        const v = Math.sin(ph) * Math.sin(Math.PI * k) ** 2 * gain;
        put(s0 + i, v * gl, v * gr, 0.5);
      }
    },

    /** Tonal riser: an accelerating sine sweep, ending at t + dur. */
    riser(t, dur, f0, f1, gain, curve = 2.2) {
      const s0 = Math.round(t * SR);
      let ph = 0;
      for (let i = 0; i < dur * SR; i++) {
        const k = i / (dur * SR);
        ph += (TAU * (f0 * (f1 / f0) ** (k * k))) / SR;
        const v = Math.sin(ph) * k ** curve * gain;
        put(s0 + i, v, v, 0.3);
      }
    },

    /**
     * Pad: detuned saws through a moving low-pass. sections = [{ t0, t1,
     * notes, gain(t), cutoff(t), duckDepth }].
     */
    pad(sections) {
      for (const sec of sections) {
        const voices = [];
        for (const n of sec.notes)
          for (const det of [-0.08, 0.08]) voices.push({ f: midi(n + det), ph: rand(), p: det > 0 ? 0.5 : -0.5 });
        const lp = [0, 0];
        const lp2 = [0, 0];
        const i0 = Math.max(0, Math.round(sec.t0 * SR));
        const i1 = Math.min(N, Math.round(sec.t1 * SR));
        for (let i = i0; i < i1; i++) {
          const t = i / SR;
          let l = 0;
          let r = 0;
          for (const v of voices) {
            v.ph = (v.ph + v.f / SR) % 1;
            const s = 2 * v.ph - 1;
            const [gl, gr] = pan(v.p);
            l += s * gl;
            r += s * gr;
          }
          const a = 1 - Math.exp((-TAU * sec.cutoff(t)) / SR);
          lp[0] += (l - lp[0]) * a;
          lp[1] += (r - lp[1]) * a;
          lp2[0] += (lp[0] - lp2[0]) * a;
          lp2[1] += (lp[1] - lp2[1]) * a;
          const d = 1 - (sec.duckDepth ?? 1) * (1 - duck[i]);
          const g = sec.gain(t) * d;
          put(i, lp2[0] * g, lp2[1] * g, 0.3);
        }
      }
    },

    /** Sustained sine sub: gain(t) envelope, optionally ducked. */
    sub(note, gain, t0 = 0, t1 = duration, duckDepth = 1) {
      const f = midi(note);
      for (let i = Math.round(t0 * SR); i < Math.min(N, Math.round(t1 * SR)); i++) {
        const t = i / SR;
        const d = 1 - duckDepth * (1 - duck[i]);
        const v = Math.sin(TAU * f * t) * gain(t) * d;
        put(i, v, v);
      }
    },

    /** Reverb, master bus, fades; returns WAV bytes. */
    master({ verb = 0.09, drive = 1.15, fadeIn = 0.05, fadeOut = 0.5, ceiling = 0.89 } = {}) {
      const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((n) => Math.round(n * (SR / 44100) * 1.25));
      const reverb = (input, spread) => {
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
      const vl = reverb(sendL, 0);
      const vr = reverb(sendR, 23);
      let peak = 0;
      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const fade = Math.min(1, t / fadeIn) * Math.min(1, Math.max(0, (duration - t) / fadeOut));
        L[i] = Math.tanh((L[i] + vl[i] * verb) * drive) * fade;
        R[i] = Math.tanh((R[i] + vr[i] * verb) * drive) * fade;
        peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      }
      const norm = ceiling / peak;
      const data = Buffer.alloc(N * 4);
      for (let i = 0; i < N; i++) {
        data.writeInt16LE(Math.round(L[i] * norm * 32767), i * 4);
        data.writeInt16LE(Math.round(R[i] * norm * 32767), i * 4 + 2);
      }
      return wav(data);
    },
  };
  return I;
}

export function wav(data) {
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
  return Buffer.concat([h, data]);
}

export const writeWav = (file, bytes) => {
  fs.writeFileSync(file, bytes);
  return file;
};
