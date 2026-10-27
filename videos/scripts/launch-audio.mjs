// Procedural score for the launch film (launch/STORYBOARD.md, "Score"): D minor,
// 120 BPM (beat 0.5 s, bar 2 s), synthesised with synth.mjs sample by sample from
// the same times as the picture. Every time the score hangs on lives in CUE and
// every pitch in KEY, so a picture retime is an edit to those two tables only.
// Deterministic: one seed, no clock.
//
//   node scripts/launch-audio.mjs   → out/launch-audio.wav
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMix, wav, writeWav, SR, midi } from './synth.mjs';

/* ------------------------------------------------------------------------ */
/* Cue sheet (global film seconds). Mirrors STORYBOARD.md shot by shot.      */
/* ------------------------------------------------------------------------ */
export const CUE = {
  // Act I — sparse heavy hits on the cuts
  open: 0.0, // 1 · frame 0 already lit: hit + air, D1 sub swell
  light: [0.0, 1.2], // the raking light travels +X
  words: [0.25, 0.37, 0.5, 0.62], // "every" "machine" · "you" "build" (blur, 0.12 s/word; "build" sharp at 0.90)
  wordPan: [-0.74, -0.5, -0.77, -0.62], // each word's centre x (16:9): two lines read left → right
  carve: [0.2, 0.95], // the light's air dips under the word ticks
  head: [1.0, 1.5], // the light leaves the rover as the thread's head, runs right
  pieces: 1.5, // 2 · hard cut, heavy hit; the rover's rim and halo flare and settle by 1.64
  explode: 1.566, // the parts start to separate (CUT + 0.066)
  shards: [
    // [after the explode, pan, Hz]: wheels out, tray up, battery down, boards, camera, dust
    [0.012, -0.8, 1650],
    [0.026, 0.8, 1480],
    [0.045, 0.1, 2050],
    [0.07, -0.2, 1220],
    [0.105, 0.35, 1900],
    [0.15, -0.55, 2300],
    [0.22, 0.6, 1380],
  ],
  leaders: [1.9, 1.96, 2.02, 2.08], // four leaders draw, 60 ms apart
  leaderPan: [-0.27, 0.08, -0.31, 0.6], // tray, battery, Pi, wheel: midway along each leader, anchor → label (16:9)
  heartbeat: [2.0, 2.5], // a soft pulse under the exploded view
  islands: 3.0, // 3 · hit; the kick drops out
  // Requirements, Parts, Mechanical are there on the cut frame (the hit reveals them);
  // Calculations, Electronics, Tests pop on 8ths.
  islandAt: [3.0, 3.0, 3.0, 3.25, 3.5, 3.75],
  islandPan: [-0.56, 0.56, -0.39, 0.05, 0.61, 0.17], // island centre x (16:9) → pan
  islandDepth: [1, 1, 1.2, 1, 1, 0.8], // one nearer, one farther
  terminal: 4.5, // 4 · hard cut into the agent terminal (the CLI already running), the kick returns on every beat
  prompt: [4.625, 'Build a compact inspection rover with a removable camera tray.', 120], // start, text, keys per second
  submit: 5.25, // Enter: the request commits (its frame still holds the cursor after "tray.")…
  // …and the carriage return: a cut on the next 60 fps frame (pieces.js RT = SUBMIT + 1/60 − 1e-4),
  // then the transcript settles into place, cubicOut over SETTLE 0.45 s.
  ret: [5.26657, 5.71657],
  cursorPan: 0.26, // the cursor sits at x ≈ 63 % while it types (16:9)
  retPan: [-0.62, -0.74], // after the cut it is at x ≈ 19 %, settling to ≈ 13 % (the prompt column on the margin)
  calls: [5.375, 5.5, 5.625], // call rows rise in the right-hand rail, on 16ths after Enter
  callPan: 0.68, // the rail's rows centre at x ≈ 84 % (16:9)
  riseToSnap: [5.5, 6.0],
  snap: 6.0, // 5 · ~200 segments snap into the Flow map
  front: [6.04, 7.0], // the wavefront crosses left → right on a sine in-out
  frontX: [-160 / 1920, 2320 / 1920], // its travel, in screen widths
  segments: 220,
  lock: 7.0, // the thread fuses: lock thump
  riseToBreath: [6.4, 7.5],
  breath: [7.5, 8.0], // 6 · near silence…
  inhale: [7.6, 8.0], // …but for an inhale into the title
  // Act II — the record
  title: 8.0, // 7 · THE title hit (Paper), pad bloom
  groove: 9.0, // the groove creeps back
  claps: [9.5, 10.5, 11.5, 16.5, 17.5, 19.0, 19.5], // on 2 and 4, and the hit at 19.0
  lens: 9.5, // 8 · full groove
  thread: 10.0, // the thread lights: shimmer
  // A tick per node the head reaches (lens.js REACH): Payload capacity, Camera tray, Rover
  // mass budget, Wheel torque, then Ramp traverse at the end of the one long reach.
  reach: [10.0, 10.125, 10.25, 10.375, 10.5],
  reachPan: [-0.69, 0.53, 0.81, 0.69, 0.64], // each node's x as it is reached: the camera pans right with the head (16:9)
  toms: [11.0, 11.75], // 9 · plate cuts: requirement, Camera tray
  split: 12.5, // 10 · Paper split, groove thins to kick + hat
  hollow: 13.0, // the hollow 0.5 kg lands: scratch
  rack: [13.4, 13.9], // focus rack: whoosh
  bar: 14.0, // 11 · the Decision bar: tension
  swap: 15.0, // "until you approve." (on the beat)
  ring: 15.375, // the focus ring draws round Approve, a 16th before ⌘ goes down
  ringPan: 0.57, // Approve sits at x ≈ 78 % (16:9)
  roll: [15.5, 15.875], // keycaps go down: a roll of 16ths
  gap: [15.9375, 16.0], // total silence (the last 32nd before the bar line)
  press: 16.0, // THE PRESS: click + sub + chord lifting minor → major
  // The third bends F → F# (start, duration) while "Approved as the new baseline." opens:
  // decide.js NOTICE, 16.04–16.20 cubicOut (its text is fully up from 16.12).
  lift: [16.04, 0.16],
  impact: 16.5, // 12 · groove returns; impact travels the recorded links
  legs: [
    [16.5, 16.75], // payload → tray, payload → mass
    [17.0, 17.25], // payload → ramp (the long reach)
    [17.5, 17.75], // mass → torque
  ],
  arrivals: [16.75, 17.25, 17.75], // amber bells: tray + mass, ramp, torque
  arrivalPan: [[0.55, 1.0], [0.27], [0.21]], // per bell, each node's x as it arrives (16:9): tray, mass · ramp · torque
  ramp: 18.0, // 13 · the ramp test: hum, ticks, small riser
  rampLight: [18.0, 18.96], // the raking light climbs the slope on a sine in-out
  callouts: [18.25, 18.5], // "15°", "≥ 0.5 m/s"
  propose: 19.0, // 14 · "agents propose." hit + clap
  steps: [19.0, 19.25, 19.5, 19.75], // the four-note rise
  apex: 20.0, // 15 · "people decide." THE APEX: full chord over a pedal
  chevron: 20.5, // the thread gains its chevron
  chevronPan: 0.84, // its tip, x = 1768 of 1920 (and 992 of 1080 in 9:16)
  turn: 21.25, // the chord turns over the pedal
  converge: 22.5, // 16 · the machine, whole: accelerating ticks
  sweep: [22.5, 23.22], // final raking light
  collapse: 23.18, // points fall onto the line, the line contracts to a point
  cut: 23.75, // music cut…
  reverse: [23.55, 24.0], // …a reverse swell grows under it into the logo
  logo: 24.0, // 17 · THE LOGO HIT
  tagline: [24.5, 24.9, 25.3], // "See the whole." "Focus on one." "Decide."
  taglinePan: [-0.2, 0.06, 0.26], // each sentence's centre on one line (16:9; 9:16 stacks them centred)
  decayed: 26.8, // everything has rung out; silent to the end
};

/* Pitches (MIDI). D minor; the press lifts it to D major. */
export const KEY = {
  words: [81, 86, 84, 89], // A5 D6 C6 F6
  islands: [74, 81, 77, 84, 76, 79], // D5 A5 F5 (one Dm chord on the hit) · C6 E5 G5: scattered, unresolved
  calls: [74, 77, 81], // D5 F5 A5: the agent builds the triad
  grains: [77, 79, 81, 84, 86, 89, 91, 93, 96], // D minor pentatonic, rising with x
  lock: 50, // D3
  bed: [38, 45, 50, 53], // Dm, under Act I
  title: [38, 45, 50, 53, 57, 60, 64], // Dm9 bloom
  path: [46, 53, 57, 60, 62, 65], // Bbmaj9: the thread lights
  reach: [81, 84, 86, 89, 93], // A5 C6 D6 F6 A6
  glide: [69, 81], // A4 → A5 under the travelling head: an octave below the ticks, so it never sits on one
  shimmer: [86, 89, 93], // D6 F6 A6
  split: [43, 50, 58, 62, 65, 69], // Gm9, thinned
  tension: [45, 50, 53, 57, 62, 64], // Dm(add9)/A
  ring: 93, // A6
  press: [50, 57, 62, 65, 69, 74], // D minor … (65 bends to 66)
  bend: [65, 66], // F4 → F#4
  major: [38, 50, 57, 62, 66, 69], // … D major
  impact: [46, 53, 57, 60, 62, 65], // Bbmaj9: consequence
  amber: [[74, 77], [81], [84]], // D5+F5, A5, C6 (storyboard)
  ramp: [48, 55, 62, 64], // Cadd9
  callouts: [88, 91], // E6 G6
  hum: 36, // C2
  steps: [74, 76, 78, 81], // D5 E5 F#5 A5 (lydian over C)
  apex: [38, 45, 50, 54, 57, 64, 66, 69], // Dadd9 over the D pedal
  turn: [38, 50, 55, 59, 62, 69, 71], // G(add9)/D
  apexArp: [62, 69, 74, 76, 78, 76, 74, 69],
  turnArp: [62, 67, 71, 74, 76, 74, 71, 67],
  chevron: 90, // F#6
  converge: [38, 45, 50], // open fifth: neither minor nor major
  logo: [38, 45, 50, 54, 57, 64, 69], // Dadd9
  logoBells: [74, 81], // D5 A5
  tagline: [81, 76, 74], // A5 E5 D5: settles on the root
  bass: { groove: 38, path: 34, tension: 33, impact: 34, propose: 36, pedal: 26 }, // D2 Bb1 A1 Bb1 C2 D1
};

/* The mixer's hand on the master, after the reverb: [time, gain] breakpoints,
   smoothstep between them. It makes the breath, the gap and the cut true
   silence (no reverb tail leaks through) and closes the tail. */
export const FADER = [
  [CUE.breath[0] - 0.01, 1],
  [CUE.breath[0], 0],
  [CUE.breath[1], 0],
  [CUE.breath[1] + 0.001, 1],
  [CUE.gap[0] - 0.006, 1],
  [CUE.gap[0], 0],
  [CUE.gap[1], 0],
  [CUE.gap[1] + 0.001, 1],
  [CUE.cut, 1],
  [CUE.cut + 0.008, 0],
  [CUE.logo, 0],
  [CUE.logo + 0.001, 1],
  [CUE.decayed - 0.7, 1],
  [CUE.decayed, 0],
];

const CEILING = 0.83; // −1.6 dBFS sample peak…
const TRUE_PEAK = 0.871; // …and at most −1.2 dBTP (4× oversampled): headroom for the codec
const LIMIT_DB = 2; // the most the limiter takes off a hit's first milliseconds

const TAU = Math.PI * 2;
const BEAT = 0.5;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x) => {
  const k = clamp(x);
  return k * k * (3 - 2 * k);
};
/** Attack/release envelope over [t0, t1]. */
const env = (t, t0, t1, a, r) => clamp((t - t0) / a) * clamp((t1 - t) / r);
/** Grid times from t0 (inclusive) to t1 (exclusive). */
const grid = (t0, t1, step) => {
  const out = [];
  for (let k = 0; t0 + k * step < t1 - 1e-6; k++) out.push(+(t0 + k * step).toFixed(6));
  return out;
};
const taper = (i, n, len = SR * 0.01) => Math.min(1, (n - i) / len);

/* ------------------------------------------------------------------------ */
/* Instruments synth.mjs does not have. All write through the mix's put(), so */
/* they share its reverb send, and read its duck track.                     */
/* ------------------------------------------------------------------------ */
function kit(I) {
  const { put, pan, rand, duck } = I;
  const at = (t) => Math.round(t * SR);
  const noise = () => rand() * 2 - 1;
  const k1 = (fc) => 1 - Math.exp((-TAU * fc) / SR);
  const bpf = (fc, q) => {
    const w = (TAU * fc) / SR;
    const a = Math.sin(w) / (2 * q);
    return { b: a / (1 + a), a1: (-2 * Math.cos(w)) / (1 + a), a2: (1 - a) / (1 + a) };
  };
  const ducked = (i, depth) => 1 - depth * (1 - (duck[i] ?? 1));

  return {
    /** Wide transient: decorrelated, darkened noise — the width of a hit. */
    crack(t, gain, { lp = 6500, hp = 180, decay = 40, send = 0.4 } = {}) {
      const s0 = at(t);
      const n = Math.round(SR * Math.min(0.25, 6 / decay));
      const a = k1(lp);
      const h = k1(hp);
      let l = 0;
      let r = 0;
      let hl = 0;
      let hr = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        l += (noise() - l) * a;
        r += (noise() - r) * a;
        hl += (l - hl) * h;
        hr += (r - hr) * h;
        const e = Math.min(1, x * 8000) * Math.exp(-x * decay) * taper(i, n) * gain;
        put(s0 + i, (l - hl) * e, (r - hr) * e, send);
      }
    },

    /** Plate: a stereo band-limited noise tail, the long ring after a heavy hit. */
    plate(t, gain, { decay = 1.2, lp = 3000, hp = 240, send = 0.5 } = {}) {
      const s0 = at(t);
      const n = Math.round(SR * decay * 2.6);
      const a = k1(lp);
      const h = k1(hp);
      const st = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        st[0] += (noise() - st[0]) * a;
        st[1] += (st[0] - st[1]) * a;
        st[2] += (st[1] - st[2]) * h;
        st[3] += (noise() - st[3]) * a;
        st[4] += (st[3] - st[4]) * a;
        st[5] += (st[4] - st[5]) * h;
        const e = Math.min(1, x * 300) * Math.exp((-x / decay) * 3) * gain;
        put(s0 + i, (st[1] - st[2]) * e, (st[4] - st[5]) * e, send);
      }
    },

    /** Glass: a pure high ping, one inharmonic partial, a 1 ms tick. */
    glass(t, note, gain, p = 0, decay = 0.35, send = 0.35) {
      const s0 = at(t);
      const f = midi(note);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * decay * 3.3);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        lp += (noise() - lp) * 0.35;
        const tick = i < 60 ? lp * (1 - i / 60) * 0.45 : 0;
        const v =
          ((Math.sin(TAU * f * x) * Math.exp((-x / decay) * 3) + 0.2 * Math.sin(TAU * f * 2.756 * x) * Math.exp(-x * 45)) * Math.min(1, x * 3000) + tick) *
          gain;
        put(s0 + i, v * gl, v * gr, send);
      }
    },

    /** Metal shard: inharmonic partials, a falling pitch, a short ring. */
    shard(t, f0, gain, p = 0, decay = 0.2) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const RAT = [1, 1.593, 2.135, 2.917];
      const AMP = [1, 0.6, 0.42, 0.25];
      const ph = [0, 0, 0, 0];
      const n = Math.round(SR * decay * 3.5);
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const drop = 1 - 0.06 * (1 - Math.exp(-x * 12));
        let v = 0;
        for (let k = 0; k < 4; k++) {
          ph[k] += (TAU * f0 * RAT[k] * drop) / SR;
          v += AMP[k] * Math.sin(ph[k]) * Math.exp((-x / (decay / (1 + 0.6 * k))) * 3);
        }
        if (i < 72) v += noise() * (1 - i / 72) * 0.4;
        v *= Math.min(1, x * 4000) * gain;
        put(s0 + i, v * gl, v * gr, 0.35);
      }
    },

    /**
     * Key: a soft click over a low thock, one per character typed. `thock` sets
     * the body: at fast typing rates a full thock on every key fuses into a buzz.
     */
    key(t, gain, p = 0, thock = 0.5) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * 0.05);
      let lp = 0;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        lp += (noise() - lp) * 0.45;
        ph += (TAU * (160 + 120 * Math.exp(-x * 120))) / SR;
        const v = (lp * Math.exp(-x * 1500) + thock * Math.sin(ph) * Math.exp(-x * 90) * Math.min(1, x * 8000)) * gain;
        put(s0 + i, v * gl, v * gr, 0.06);
      }
    },

    /**
     * Air: synth.mjs's band-passed noise sweep, with a gain shape over absolute
     * time (to carve room for something) and an ease on its travel (pitch and
     * pan follow the picture's motion curve, not a straight line).
     */
    air(t, dur, gain, f0, f1, p0, p1, { attack = 0.5, q = 2.2, shape = () => 1, ease = (k) => k } = {}) {
      const s0 = at(t);
      const n = Math.round(dur * SR);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < n; i++) {
        const k = i / n;
        const u = ease(k);
        const w = (TAU * f0 * (f1 / f0) ** u) / SR;
        const al = Math.sin(w) / (2 * q);
        const a0 = 1 + al;
        const x = noise();
        const y = (al * (x - x2) + 2 * Math.cos(w) * y1 - (1 - al) * y2) / a0;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        const e = k < attack ? Math.sin((Math.PI / 2) * (k / attack)) ** 2 : Math.cos((Math.PI / 2) * ((k - attack) / (1 - attack))) ** 2;
        const [gl, gr] = pan(p0 + (p1 - p0) * u);
        const v = y * e * shape(t + k * dur) * gain * 3;
        put(s0 + i, v * gl, v * gr, 0.25);
      }
    },

    /** Tock: a tuned woodblock, for a call row arriving. */
    tock(t, note, gain, p = 0) {
      const s0 = at(t);
      const f = midi(note);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * 0.16);
      let ph = 0;
      let ph2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const fi = f * (1 + 0.05 * Math.exp(-x * 80));
        ph += (TAU * fi) / SR;
        ph2 += (TAU * fi * 2.71) / SR;
        const v = (Math.sin(ph) * Math.exp(-x * 32) + 0.25 * Math.sin(ph2) * Math.exp(-x * 110)) * Math.min(1, x * 2500) * gain;
        put(s0 + i, v * gl, v * gr, 0.3);
      }
    },

    /** Clap: three bursts and a tail through a band-pass. */
    clap(t, gain, p = 0, fc = 1300) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const { b, a1, a2 } = bpf(fc, 1.1);
      const n = Math.round(SR * 0.32);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      const burst = (x, o) => (x >= o ? Math.exp(-(x - o) * 420) : 0);
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const nz = noise();
        const y = b * (nz - x2) - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = nz;
        y2 = y1;
        y1 = y;
        const e = burst(x, 0) + 0.8 * burst(x, 0.0085) + 0.65 * burst(x, 0.017) + (x > 0.021 ? 0.5 * Math.exp(-(x - 0.021) * 16) : 0);
        const v = y * e * gain * 2.4;
        put(s0 + i, v * gl, v * gr, 0.3);
      }
    },

    /** Hat: differenced noise darkened above ~7 kHz, so it never fizzes. */
    hat(t, gain, p = 0, decay = 70) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * Math.min(0.12, 6 / decay));
      let prev = 0;
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const nz = noise();
        lp += (nz - prev - lp) * 0.62;
        prev = nz;
        const v = lp * Math.exp(-x * decay) * Math.min(1, x * 6000) * gain;
        put(s0 + i, v * gl, v * gr, 0.1);
      }
    },

    /** Bass 8th: saw + sine through a closing low-pass, kick-ducked, dry. */
    bass(t, note, gain, dur = 0.22, { bright = 850, depth = 0.7, sub = 0.45 } = {}) {
      const s0 = at(t);
      const f = midi(note);
      const n = Math.round(SR * (dur + 0.03));
      let ph = 0;
      let l1 = 0;
      let l2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph = (ph + f / SR) % 1;
        const a = k1(90 + bright * Math.exp(-x * 16));
        l1 += (2 * ph - 1 - l1) * a;
        l2 += (l1 - l2) * a;
        const e = Math.min(1, x * 600) * Math.exp(-x * 3) * (x < dur ? 1 : Math.max(0, 1 - (x - dur) / 0.03));
        const v = (l2 * 0.8 + Math.sin(TAU * ph) * sub) * e * ducked(s0 + i, depth) * gain;
        put(s0 + i, v, v, 0);
      }
    },

    /** Tom: a pitched drop with a stick. */
    tom(t, f0, f1, gain, p = 0) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * 0.6);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph += (TAU * (f1 + (f0 - f1) * Math.exp(-x * 14))) / SR;
        const v = (Math.tanh(Math.sin(ph) * 1.3) * Math.exp(-x * 6.5) + (i < 120 ? noise() * (1 - i / 120) * 0.3 : 0)) * taper(i, n, SR * 0.05) * gain;
        put(s0 + i, v * gl, v * gr, 0.3);
      }
    },

    /** Scratch: a pen stroke — narrow noise, falling, with stick-slip grit. */
    scratch(t, gain, p = 0) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * 0.11);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const { b, a1, a2 } = bpf(3200 - 1400 * (i / n), 3);
        const nz = noise();
        const y = b * (nz - x2) - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = nz;
        y2 = y1;
        y1 = y;
        const grit = 0.55 + 0.45 * Math.sign(Math.sin(TAU * 95 * x));
        const v = y * grit * Math.min(1, x * 900) * Math.exp(-x * 30) * gain * 3;
        put(s0 + i, v * gl, v * gr, 0.15);
      }
    },

    /** Switch: the mechanical press — contact tick, housing clack, bottom-out thock. */
    press(t, gain) {
      const s0 = at(t);
      const n = Math.round(SR * 0.14);
      const { b, a1, a2 } = bpf(4200, 1.5);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const nz = noise();
        const y = b * (nz - x2) - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = nz;
        y2 = y1;
        y1 = y;
        const tick = y * 3 * Math.exp(-x * 900);
        const c = x - 0.007;
        const clack = c >= 0 ? (Math.sin(TAU * 1850 * c) * 0.55 + nz * 0.2) * Math.exp(-c * 260) * Math.min(1, c * 6000) : 0;
        ph += (TAU * (210 + 140 * Math.exp(-x * 60))) / SR;
        const thock = Math.sin(ph) * Math.exp(-x * 55) * 0.7 * Math.min(1, x * 6000);
        const v = (tick + clack + thock) * taper(i, n) * gain;
        put(s0 + i, v, v, 0.2);
      }
    },

    /** Stab: detuned saws through a closing filter; `bend` slides one voice. */
    stab(t, notes, gain, { decay = 0.5, bright = 3000, bend = null, send = 0.4 } = {}) {
      const s0 = at(t);
      const n = Math.round(SR * decay * 4);
      const voices = [];
      notes.forEach((note, k) =>
        [-0.07, 0.07].forEach((det, j) => voices.push({ note, det, ph: rand(), g: pan(((k % 2 ? 1 : -1) * 0.5 + (j ? 0.15 : -0.15)) * 0.9) })),
      );
      const lp = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        let l = 0;
        let r = 0;
        for (const v of voices) {
          let m = v.note;
          if (bend && v.note === bend.from) m = bend.from + (bend.to - bend.from) * smooth((x - bend.at) / bend.dur);
          v.ph = (v.ph + midi(m + v.det) / SR) % 1;
          const s = 2 * v.ph - 1;
          l += s * v.g[0];
          r += s * v.g[1];
        }
        const a = k1(260 + bright * Math.exp(-x * 6));
        lp[0] += (l - lp[0]) * a;
        lp[1] += (lp[0] - lp[1]) * a;
        lp[2] += (r - lp[2]) * a;
        lp[3] += (lp[2] - lp[3]) * a;
        const e = Math.min(1, x * 700) * Math.exp((-x / decay) * 2.2) * taper(i, n, SR * 0.05) * gain;
        put(s0 + i, lp[1] * e, lp[3] * e, send);
      }
    },

    /** Hum: a motor at rest — low harmonics, a slow wobble, no drive. */
    hum(t0, t1, note, gain) {
      const f = midi(note);
      const A = [1, 0.5, 0.33, 0.2, 0.12, 0.07];
      const i0 = at(t0);
      const i1 = at(t1);
      let ph = 0;
      let l1 = 0;
      let l2 = 0;
      const a = k1(520);
      for (let i = i0; i < i1; i++) {
        const t = i / SR;
        ph += (TAU * f * (1 + 0.002 * Math.sin(TAU * 0.7 * t))) / SR;
        let s = 0;
        for (let k = 0; k < A.length; k++) s += A[k] * Math.sin((k + 1) * ph);
        l1 += (s - l1) * a;
        l2 += (l1 - l2) * a;
        const v = l2 * (1 + 0.15 * Math.sin(TAU * 5.5 * t)) * env(t, t0, t1, 0.08, 0.08) * gain;
        put(i, v, v, 0.1);
      }
    },

    /** Grain: a 4 ms windowed sine — one segment snapping into place. */
    grain(t, f, gain, p = 0) {
      const s0 = at(t);
      const [gl, gr] = pan(p);
      const n = Math.round(SR * 0.004);
      for (let i = 0; i < n; i++) {
        const w = Math.sin((Math.PI * i) / n) ** 2;
        const v = Math.sin((TAU * f * i) / SR) * w * gain;
        put(s0 + i, v * gl, v * gr, 0.2);
      }
    },

    /** Shimmer: high detuned sines with a tremolo, hanging over a lit thing. */
    shimmer(t0, t1, notes, gain) {
      const i0 = at(t0);
      const i1 = at(t1 + 0.6);
      const vs = [];
      notes.forEach((n, k) => [-0.04, 0.04].forEach((d, j) => vs.push({ f: midi(n + d), g: pan((j ? 0.6 : -0.6) * (k % 2 ? -1 : 1)), tr: 7 + k * 1.7 + j })));
      for (let i = i0; i < i1; i++) {
        const t = i / SR;
        const x = t - t0;
        const e = clamp(x / 0.15) * (t < t1 ? 1 : Math.exp(-(t - t1) * 8)) * gain;
        let l = 0;
        let r = 0;
        for (const v of vs) {
          const s = Math.sin(TAU * v.f * x) * (0.7 + 0.3 * Math.sin(TAU * v.tr * x));
          l += s * v.g[0];
          r += s * v.g[1];
        }
        put(i, l * e, r * e, 0.5);
      }
    },

    /**
     * Pads: synth.mjs's detuned-saw pad, with the reverb send as a parameter.
     * Its fixed 0.3 send let the room's comb colouring pull sustained chords
     * 3–5 dB to the left; a lighter send (and a small right trim on the dry
     * voices) keeps the image centred. sections as in synth.mjs's pad().
     */
    pads(sections, { send = 0.1, trim = 0 } = {}) {
      for (const sec of sections) {
        const voices = [];
        for (const n of sec.notes)
          for (const det of [-0.08, 0.08]) voices.push({ f: midi(n + det), ph: rand(), g: pan((det > 0 ? 0.5 : -0.5) + trim) });
        const lp = [0, 0, 0, 0];
        const i0 = Math.max(0, at(sec.t0));
        const i1 = Math.min(I.N, at(sec.t1));
        for (let i = i0; i < i1; i++) {
          const t = i / SR;
          let l = 0;
          let r = 0;
          for (const v of voices) {
            v.ph = (v.ph + v.f / SR) % 1;
            const s = 2 * v.ph - 1;
            l += s * v.g[0];
            r += s * v.g[1];
          }
          const a = k1(sec.cutoff(t));
          lp[0] += (l - lp[0]) * a;
          lp[1] += (r - lp[1]) * a;
          lp[2] += (lp[0] - lp[2]) * a;
          lp[3] += (lp[1] - lp[3]) * a;
          const g = sec.gain(t) * ducked(i, sec.duckDepth ?? 1);
          put(i, lp[2] * g, lp[3] * g, send);
        }
      }
    },

    /** Wash: a soft cymbal — band-limited noise, a short bloom, a long decay; `shape` is a gain over absolute time. */
    wash(t, gain, decay = 2.0, shape = () => 1) {
      const s0 = at(t);
      const n = Math.round(SR * decay * 2.4);
      const h = k1(2500);
      const a = k1(7500);
      const st = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const x = i / SR;
        const nl = noise();
        const nr = noise();
        st[0] += (nl - st[0]) * h;
        st[1] += (nl - st[0] - st[1]) * h;
        st[2] += (nl - st[0] - st[1] - st[2]) * a;
        st[3] += (nr - st[3]) * h;
        st[4] += (nr - st[3] - st[4]) * h;
        st[5] += (nr - st[3] - st[4] - st[5]) * a;
        const e = Math.min(1, x * 30) * Math.exp((-x / decay) * 3) * shape(t + x) * gain;
        put(s0 + i, st[2] * e, st[5] * e, 0.4);
      }
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Layers after the master: the fader, and the two sounds that live inside  */
/* the silences it makes (an inhale, a reverse swell). Dry, at fixed dBFS.  */
/* ------------------------------------------------------------------------ */
function fader(t) {
  if (t <= FADER[0][0]) return FADER[0][1];
  for (let k = 1; k < FADER.length; k++) {
    const [ta, ga] = FADER[k - 1];
    const [tb, gb] = FADER[k];
    if (t < tb) return ga + (gb - ga) * smooth((t - ta) / (tb - ta));
  }
  return FADER[FADER.length - 1][1];
}

/** 12 dB/oct high-pass in place: keeps DC and subsonics out of the low end. */
function highpass(x, fc) {
  const w = (TAU * fc) / SR;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const a0 = 1 + al;
  const [b0, b1, b2, a1, a2] = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/**
 * Look-ahead peak limiter with make-up to the ceiling: shaves the first
 * milliseconds of the biggest hits (by at most `reduceDb`) so the music around
 * them can sit higher. 3 ms look-ahead, a smoothed attack, 120 ms release.
 */
function limit(L, R, reduceDb, ceiling) {
  const n = L.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const thr = peak * 10 ** (-reduceDb / 20);
  const LA = Math.round(SR * 0.003);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    need[i] = p > thr ? thr / p : 1;
  }
  // Minimum over the look-ahead window [i, i + LA] (monotonic deque, run backwards).
  const held = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0;
  let tl = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tl > h && need[dq[tl - 1]] >= need[i]) tl--;
    dq[tl++] = i;
    while (dq[h] > i + LA) h++;
    held[i] = need[dq[h]];
  }
  // Box-average over [i − LA, i] (reaches the held minimum by the peak), then release.
  const rel = 1 - Math.exp(-1 / (SR * 0.12));
  let acc = LA + 1; // the window starts full of unity gain
  let g = 1;
  for (let i = 0; i < n; i++) {
    acc += held[i] - (i > LA ? held[i - LA - 1] : 1);
    g = Math.min(acc / (LA + 1), g + (1 - g) * rel);
    L[i] *= g;
    R[i] *= g;
  }
  peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = ceiling / peak;
  for (let i = 0; i < n; i++) {
    L[i] *= k;
    R[i] *= k;
  }
}

/**
 * True peak: the largest value of the 4× oversampled signal (windowed sinc, 16 taps a
 * side), where a codec's reconstruction puts it. Only checked round large samples.
 */
function truePeak(L, R) {
  const OS = 4;
  const TAPS = 16;
  const h = [];
  for (let p = 1; p < OS; p++) {
    const row = [];
    for (let k = -TAPS; k <= TAPS; k++) {
      const x = k + p / OS;
      row.push((Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 1))));
    }
    h.push(row);
  }
  let tp = 0;
  for (const x of [L, R]) {
    let sp = 0;
    for (let i = 0; i < x.length; i++) sp = Math.max(sp, Math.abs(x[i]));
    for (let i = TAPS; i < x.length - TAPS; i++) {
      tp = Math.max(tp, Math.abs(x[i]));
      if (Math.abs(x[i]) < 0.5 * sp) continue;
      for (const row of h) {
        let s = 0;
        for (let k = -TAPS; k <= TAPS; k++) s += x[i - k] * row[k + TAPS];
        tp = Math.max(tp, Math.abs(s));
      }
    }
  }
  return tp;
}

function overdub(L, R, rand) {
  const noise = () => rand() * 2 - 1;
  const band = (fc, q) => {
    const w = (TAU * fc) / SR;
    const a = Math.sin(w) / (2 * q);
    return [a / (1 + a), (-2 * Math.cos(w)) / (1 + a), (1 - a) / (1 + a)];
  };
  const N = L.length;

  // The inhale into the title: breath-band noise, rising, cut by the hit.
  {
    const [t0, b1] = CUE.inhale;
    const s = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = Math.round(t0 * SR); i < Math.min(N, Math.round(b1 * SR)); i++) {
      const t = i / SR;
      const k = (t - t0) / (b1 - t0);
      const [b, a1, a2] = band(700 + 900 * k, 0.8);
      const nl = noise();
      const nr = noise();
      const yl = b * (nl - s[1]) - a1 * s[2] - a2 * s[3];
      s[1] = s[0];
      s[0] = nl;
      s[3] = s[2];
      s[2] = yl;
      const yr = b * (nr - s[5]) - a1 * s[6] - a2 * s[7];
      s[5] = s[4];
      s[4] = nr;
      s[7] = s[6];
      s[6] = yr;
      const e = k ** 2.4 * 0.05 * clamp((b1 - t) / 0.004);
      L[i] += yl * e;
      R[i] += yr * e;
    }
  }

  // The reverse swell into the logo: a reversed ring (noise + D5/A5) that
  // grows out of the cut and stops dead on the hit.
  {
    const [t0, t1] = CUE.reverse;
    const fs = KEY.logoBells.map(midi);
    const st = [0, 0, 0, 0, 0, 0];
    const a = 1 - Math.exp((-TAU * 4500) / SR);
    const h = 1 - Math.exp((-TAU * 260) / SR);
    for (let i = Math.round(t0 * SR); i < Math.min(N, Math.round(t1 * SR)); i++) {
      const t = i / SR;
      const d = t1 - t; // time before the hit
      st[0] += (noise() - st[0]) * a; // two poles down from 4.5 kHz: air, not hiss
      st[1] += (st[0] - st[1]) * a;
      st[2] += (st[1] - st[2]) * h;
      st[3] += (noise() - st[3]) * a;
      st[4] += (st[3] - st[4]) * a;
      st[5] += (st[4] - st[5]) * h;
      const edge = clamp((t - t0) / 0.05) * clamp(d / 0.003);
      const ring = fs.reduce((s, f, k) => s + Math.sin(TAU * f * d) * (k ? 0.6 : 1), 0) * Math.exp(-d / 0.16) * edge * 0.06;
      const e = Math.exp(-d / 0.09) * edge * 0.7;
      L[i] += (st[1] - st[2]) * e + ring;
      R[i] += (st[4] - st[5]) * e + ring;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The score                                                                */
/* ------------------------------------------------------------------------ */
export function writeLaunchSoundtrack(file, duration = 29) {
  const C = CUE;
  const I = createMix(duration, 0x1f10);
  const K = kit(I);
  const { rand } = I;

  /* 1 · Kicks first: they write the duck track the bass, pads and subs read. */
  const kicks = [
    [C.open, 0.62, { f0: 120, f1: 40, depth: 0.5 }],
    [C.pieces, 0.75, { f0: 130, f1: 38, depth: 0.7 }],
    [C.heartbeat[0], 0.3],
    [C.heartbeat[1], 0.42],
    [C.islands, 0.55],
    ...grid(C.terminal, C.lock, BEAT).map((t, i) => [t, [0.75, 0.55, 0.62, 0.8, 0.6][i] ?? 0.6]),
    [C.lock, 0.75, { f0: 110, f1: 52, depth: 0.4, click: 0.45 }],
    [C.title, 0.8, { f0: 120, f1: 38, depth: 0.55, click: 0.35 }],
    ...grid(C.groove, C.split, BEAT).map((t) => [t, t === C.groove ? 0.5 : t % 2 === 0 ? 0.8 : 0.66]),
    ...grid(C.split, C.bar, BEAT).map((t) => [t, 0.5]),
    ...grid(C.bar, C.roll[0] + 0.01, BEAT).map((t) => [t, t % 1 === 0 ? 0.72 : 0.45]),
    [C.press, 0.65, { f0: 140, f1: 42, depth: 0.5 }],
    ...grid(C.impact, C.ramp, BEAT).map((t) => [t, t % 1 === 0 ? 0.8 : 0.68]),
    [C.ramp, 0.5],
    [C.propose, 0.85],
    [C.propose + 0.5, 0.75],
    [C.propose + 0.75, 0.45],
    [C.apex, 0.8, { f0: 120, f1: 38, depth: 0.45 }],
    [C.converge, 0.55],
    [C.logo, 0.8, { f0: 120, f1: 38, depth: 0.3 }],
  ];
  for (const [t, g, o] of kicks) I.kick(t, g, o);

  /* 2 · Act I — sparse heavy hits on the cuts (0.0–7.5). */
  // 0.0: frame 0 is already lit — a hit and air.
  I.boom(C.open, 0.32, 80, midi(26), 0.7, 0.3);
  K.crack(C.open, 0.26, { lp: 5000, decay: 38 });
  // Air riding the raking light (+X), dipping under the word ticks (a broad carve, and 4 dB
  // more for each word's first 100 ms so its glass and click read through), then the
  // thread's head running right.
  {
    const [c0, c1] = C.carve;
    const word = (t) => C.words.reduce((g, w) => g * (1 - 0.37 * smooth((t - w + 0.006) / 0.006) * smooth((w + 0.1 - t) / 0.05)), 1);
    const carve = (t) => (1 - 0.45 * smooth((t - c0) / 0.08) * smooth((c1 - t) / 0.12)) * word(t);
    K.air(C.light[0], C.light[1] - C.light[0] + 0.15, 0.3, 2000, 4400, -0.7, 0.45, { attack: 0.45, q: 0.7, shape: carve });
  }
  I.whoosh(C.head[0], C.head[1] - C.head[0], 0.4, 1100, 4800, 0.1, 0.95, 0.88, 1.3);
  // D1 sub swell under the macro (and its octave, so small speakers hear it), cut by the hit.
  const swell = (lvl) => (t) => lvl * (0.15 + 0.85 * smooth(t / C.pieces)) * clamp((C.pieces - t) / 0.01);
  I.sub(26, swell(0.11), 0, C.pieces, 0.6);
  I.sub(38, swell(0.04), 0, C.pieces, 0.6);
  // Glass ticks on the words (copy sits left), each with a soft click: the glass alone is
  // pitch with no edge, and under the light's air the words landed silently.
  C.words.forEach((t, i) => {
    K.glass(t, KEY.words[i], 0.2, C.wordPan[i], 0.3);
    I.tick(t, 0.06, C.wordPan[i], 3200);
  });

  // 1.5: hard cut, the heavy hit — sub kick and noise into a long plate; metal shards
  // as the parts separate.
  I.boom(C.pieces, 0.55, 90, midi(26), 1.0, 0.55);
  K.crack(C.pieces, 0.42, { lp: 6000, decay: 30 });
  K.plate(C.pieces, 0.11, { decay: 1.3 });
  for (const [dt, p, f] of C.shards) K.shard(C.explode + dt, f, 0.05, p, 0.18 + 0.1 * rand());
  C.leaders.forEach((t, i) => I.tick(t, 0.05, C.leaderPan[i], 2600));

  // 3.0: hit; a glassy pluck per island, panned by its x, dulled by depth. The three
  // the hit reveals sound together as one chord, each a little softer.
  I.boom(C.islands, 0.28, 75, midi(26), 0.9, 0.3);
  K.crack(C.islands, 0.24, { lp: 4500, decay: 50 });
  C.islandPan.forEach((p, i) => {
    const t = C.islandAt[i];
    const z = C.islandDepth[i];
    const stack = C.islandAt.filter((u) => u === t).length;
    const g = Math.min(1, Math.sqrt(1.5 / stack));
    I.pluck(t, KEY.islands[i], 0.11 * z * g, p, 0.3, z > 1 ? 2200 : z < 1 ? 1600 : 4200);
    K.glass(t, KEY.islands[i] + 12, 0.028 * z * g, p, 0.45);
  });

  // 4.5: the agent terminal — a key tick per character as the request streams in
  // (120 a second: a body only on each word's first key, and each tick up to a
  // third of a key late, still inside its own character's reveal, so the stream
  // ratchets by word instead of buzzing at 120 Hz), Enter, the carriage return,
  // a tock per call row, a riser.
  {
    const [p0, text, pcps] = C.prompt;
    const chars = [...text];
    chars.forEach((ch, i) => {
      const first = i === 0 || chars[i - 1] === ' ';
      const g = ch === ' ' ? 0.016 : first ? 0.05 : 0.026 + 0.016 * rand();
      K.key(p0 + (i + 0.3 * rand()) / pcps, g, C.cursorPan + (rand() - 0.5) * 0.08, first ? 0.6 : 0.1);
    });
    K.key(C.submit, 0.13, C.cursorPan, 0.9);
    // The return: its fast part is the cut, what is heard is the settle. Pitch and pan
    // follow the cubicOut, the level its speed, so the air is spent where the move is.
    const [c0, c1] = C.ret;
    const speed = (t) => 1 - clamp((t - c0) / (c1 - c0));
    K.air(c0, c1 - c0, 0.07, 2600, 900, C.retPan[0], C.retPan[1], { attack: 0.03, q: 1.4, ease: (k) => 1 - (1 - k) ** 3, shape: speed });
    C.calls.forEach((t, i) => K.tock(t, KEY.calls[i], 0.13, C.callPan));
    const [r0, r1] = C.riseToSnap;
    I.riser(r0, r1 - r0, 260, 1040, 0.035);
    I.whoosh(r0, r1 - r0, 0.3, 500, 4200, 0.4, -0.2, 0.92, 1.2);
  }

  // 6.0: the snap — a granular rush of micro-clicks, one per segment as it locks
  // behind the front, rising in pitch and pan with x; the lock thump at 7.0.
  K.crack(C.snap, 0.22, { lp: 5000, decay: 60 });
  {
    const [f0, f1] = C.front;
    const [x0, x1] = C.frontX;
    const passAt = (x) => {
      const v = clamp((x - x0) / (x1 - x0));
      return f0 + (Math.acos(1 - 2 * v) / Math.PI) * (f1 - f0);
    };
    for (let s = 0; s < C.segments; s++) {
      const x = rand();
      const zip = rand() * 0.07; // rows away from the thread trail it (a zipper)
      const t = passAt(x + zip) + 0.62 * (0.2 + 0.08 * rand());
      if (t >= C.lock) continue;
      const g = KEY.grains;
      const note = g[clamp(Math.floor(x * g.length + (rand() - 0.5) * 1.5), 0, g.length - 1)];
      K.grain(t, midi(note), 0.05 + 0.05 * x, -0.85 + 1.7 * x);
    }
    I.whoosh(f0, f1 - f0, 0.22, 600, 3600, -0.8, 0.8, 0.85, 1.2);
  }
  K.crack(C.lock, 0.2, { lp: 3500, decay: 80 });
  I.pluck(C.lock, KEY.lock, 0.12, 0, 0.12, 900);
  {
    const [r0, r1] = C.riseToBreath;
    I.riser(r0, r1 - r0, 170, 760, 0.05, 2.4);
    I.whoosh(r1 - 0.6, 0.6, 0.3, 400, 5200, -0.3, 0.3, 0.97, 1.0);
  }
  // 7.5–8.0: the breath — the fader takes everything out; the inhale is an overdub.

  /* 3 · Act II — the record (8.0–19.0). */
  // 8.0: THE title hit — sub drop, wide transient, plate; the pad blooms.
  I.boom(C.title, 0.6, 95, midi(26), 1.4, 0.5);
  K.crack(C.title, 0.6, { lp: 7000, decay: 26 });
  K.plate(C.title, 0.12, { decay: 1.6 });
  I.bell(C.title, 74, 0.06, -0.3, 1.8);
  I.bell(C.title, 81, 0.045, 0.3, 1.8);

  // 9.0–12.5: the groove — clap on 2 and 4, hats, bass 8ths.
  C.claps.forEach((t) => K.clap(t, t < C.lens ? 0.26 : t === C.propose ? 0.5 : 0.38, t === C.propose ? 0 : 0.08));
  grid(C.groove, C.split, BEAT / 2).forEach((t) => {
    const off = Math.abs((t % BEAT) - 0.25) < 1e-6;
    if (off) K.hat(t, t < C.lens ? 0.05 : 0.08, 0.3, 60);
  });
  grid(C.lens, C.split, BEAT / 4).forEach((t, i) => {
    if (i % 2 && (t % BEAT) > 0.3) K.hat(t, 0.035, -0.35, 110);
  });
  grid(C.groove, C.split, BEAT / 2).forEach((t) => {
    const note = t < C.thread ? KEY.bass.groove : KEY.bass.path;
    const up = Math.abs((t % 1) - 0.75) < 1e-6 ? 12 : 0; // octave on the last 8th of each beat pair
    K.bass(t, note + up, t < C.lens ? 0.22 + 0.12 * ((t - C.groove) / 0.5) : 0.36);
  });
  // 10.0: the thread lights — shimmer, and a glass tick per node reached.
  K.shimmer(C.thread, C.thread + 0.9, KEY.shimmer, 0.006);
  I.gliss(C.thread, C.reach.at(-1) - C.thread + 0.05, midi(KEY.glide[0]), midi(KEY.glide[1]), 0.018, 0.2); // gone as the head lands on Ramp traverse
  C.reach.forEach((t, i) => K.glass(t, KEY.reach[i], 0.075, C.reachPan[i], 0.4));
  // 11.0 / 11.75: toms on the plate cuts, a sub swell under the tray.
  K.tom(C.toms[0], 150, 98, 0.38, -0.2);
  K.tom(C.toms[1], 112, 72, 0.6, 0.2);
  K.crack(C.toms[1], 0.15, { lp: 4000, decay: 60 });
  I.sub(KEY.bass.path, (t) => 0.12 * Math.sin(Math.PI * clamp((t - C.toms[1]) / (C.split - C.toms[1]))) ** 2, C.toms[1], C.split, 0.5);

  // 12.5–14.0: thinned to kick + hat; a scratch as the hollow value lands, a focus whoosh.
  K.crack(C.split, 0.12, { lp: 5000, decay: 70 });
  grid(C.split, C.bar, BEAT / 2).forEach((t) => {
    if (Math.abs((t % BEAT) - 0.25) < 1e-6) K.hat(t, 0.06, 0.3, 70);
  });
  K.scratch(C.hollow, 0.2, -0.25);
  I.whoosh(C.rack[0], C.rack[1] - C.rack[0], 0.2, 2200, 700, -0.15, -0.4, 0.5, 1.4);

  // 14.0–15.94: tension — A pedal pulsing, a rising filter, a roll of 16ths, then nothing.
  K.crack(C.bar, 0.2, { lp: 4000, decay: 50 });
  grid(C.bar, C.roll[0], BEAT / 2).forEach((t) => K.bass(t, KEY.bass.tension, 0.2 + 0.1 * ((t - C.bar) / (C.roll[0] - C.bar)), 0.2, { bright: 500 + 600 * ((t - C.bar) / 1.5) }));
  grid(C.roll[0], C.gap[0], BEAT / 4).forEach((t, i) => {
    K.bass(t, KEY.bass.tension, 0.3 + 0.03 * i, 0.1, { bright: 1300 });
    I.snare(t, 0.12 + 0.08 * i, (i % 2 ? 0.15 : -0.15));
  });
  grid(C.bar, C.gap[0], BEAT / 4).forEach((t, i) => K.hat(t, 0.025 + 0.03 * ((t - C.bar) / 2), i % 2 ? 0.35 : -0.35, 90));
  K.key(C.swap, 0.08, -0.4);
  K.glass(C.ring, KEY.ring, 0.115, C.ringPan, 0.4);
  I.riser(C.bar, C.gap[0] - C.bar, 110, 440, 0.05, 1.8);
  // The build into the gap; its sweep crosses the ring's register at 15.375, so it
  // dips there for the ping.
  {
    const ring = (t) => 1 - 0.4 * smooth((t - C.ring + 0.04) / 0.04) * smooth((C.ring + 0.25 - t) / 0.13);
    K.air(C.gap[0] - 0.95, 0.95, 0.32, 500, 6000, -0.3, 0.3, { attack: 0.985, q: 1.1, shape: ring });
  }

  // 16.0: THE PRESS — a crisp mechanical click, the sub, a chord lifting minor → major.
  K.press(C.press, 0.7);
  I.boom(C.press, 0.55, 70, midi(26), 0.8, 0.2);
  K.crack(C.press, 0.26, { lp: 7500, decay: 45 });
  K.stab(C.press, KEY.press, 0.06, { decay: 0.55, bend: { from: KEY.bend[0], to: KEY.bend[1], at: C.lift[0] - C.press, dur: C.lift[1] } });
  I.bell(C.lift[0] + C.lift[1], KEY.bend[1] + 12, 0.04, 0.2, 1.0);

  // 16.5–18.0: the groove returns under the impact; amber bells on the arrivals.
  grid(C.impact, C.ramp, BEAT / 2).forEach((t) => {
    if (Math.abs((t % BEAT) - 0.25) < 1e-6) K.hat(t, 0.08, 0.3, 60);
    const up = Math.abs((t % 1) - 0.75) < 1e-6 ? 12 : 0;
    K.bass(t, KEY.bass.impact + up, 0.36);
  });
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  C.legs.forEach(([a, b], i) => I.gliss(a, b - a + 0.02, midi(KEY.amber[i][0] - 12), midi(KEY.amber[i][0]), 0.02, mean(C.arrivalPan[i])));
  C.arrivals.forEach((t, i) =>
    KEY.amber[i].forEach((n, j) => {
      const g = 1 / Math.sqrt(KEY.amber[i].length);
      const p = C.arrivalPan[i][j]; // a bell per node: the tray and the mass budget ring apart
      I.bell(t, n, 0.26 * g, p, 1.3);
      K.glass(t, n + 12, 0.05 * g, p, 0.25); // the mallet
    }),
  );

  // 18.0–19.0: the ramp test — a motor at rest, ticks on the callouts, a small riser.
  K.hum(C.ramp, C.propose, KEY.hum, 0.05);
  I.whoosh(C.rampLight[0], C.rampLight[1] - C.rampLight[0], 0.14, 600, 2200, -0.6, 0.6, 0.5, 0.9);
  C.callouts.forEach((t, i) => K.glass(t, KEY.callouts[i], 0.09, -0.1 + 0.25 * i, 0.3));
  I.riser(C.callouts[1], C.propose - C.callouts[1], 200, 800, 0.03, 2.2);

  /* 4 · Act III — the thesis (19.0–29.0). */
  // 19.0: hit + clap, the four-note rise into the apex, a cymbal swell.
  I.boom(C.propose, 0.45, 110, midi(KEY.bass.propose), 0.8, 0.3);
  K.crack(C.propose, 0.4, { lp: 6000, decay: 40 });
  C.steps.forEach((t, i) => {
    I.pluck(t, KEY.steps[i], 0.09 + 0.02 * i, -0.3 + 0.2 * i, 0.4, 3600);
    K.glass(t, KEY.steps[i] + 12, 0.025 + 0.006 * i, -0.3 + 0.2 * i, 0.5);
  });
  grid(C.propose, C.apex, BEAT / 2).forEach((t) => K.bass(t, KEY.bass.propose, 0.34));
  grid(C.propose, C.apex, BEAT / 4).forEach((t, i) => K.hat(t, 0.03 + 0.04 * (i / 8), i % 2 ? 0.35 : -0.35, i % 2 ? 90 : 60));
  I.riser(C.propose, C.apex - C.propose, 220, 880, 0.035, 2.0);
  I.whoosh(C.propose + 0.2, C.apex - C.propose - 0.2, 0.18, 2200, 6500, -0.4, 0.4, 0.97, 0.7);

  // 20.0: THE APEX — full chord over a D pedal, low hit, cymbal, sustained.
  I.boom(C.apex, 0.6, 90, midi(26), 1.5, 0.5);
  K.crack(C.apex, 0.6, { lp: 7000, decay: 26 });
  // The wash steps back 4 dB for the chevron's 80 ms, so its glass and click read through it.
  const chevronRoom = (t) => 1 - 0.37 * smooth((t - C.chevron + 0.01) / 0.01) * smooth((C.chevron + 0.11 - t) / 0.03);
  K.wash(C.apex, 0.045, 2.2, chevronRoom);
  K.plate(C.apex, 0.1, { decay: 1.8 });
  const pedal = (lvl) => (t) => lvl * env(t, C.apex, C.converge, 0.02, 0.02) * (0.75 + 0.25 * Math.exp(-(t - C.apex) * 2));
  I.sub(KEY.bass.pedal, pedal(0.09), C.apex, C.converge, 0.3);
  I.sub(KEY.bass.pedal + 12, pedal(0.05), C.apex, C.converge, 0.3);
  grid(C.chevron, C.converge, BEAT / 4).forEach((t, i) => {
    const arp = t < C.turn ? KEY.apexArp : KEY.turnArp;
    const decay = clamp((C.converge - t) * 0.8, 0.05, 0.22); // the last ones dry up before the hard cut
    I.pluck(t, arp[i % arp.length], 0.045 * clamp((t - C.chevron) / 0.5 + 0.3), i % 2 ? 0.4 : -0.4, decay, 2600);
  });
  // The chevron: glass and a click at its tip, through the room the wash left.
  K.glass(C.chevron, KEY.chevron, 0.1, C.chevronPan, 0.6);
  I.tick(C.chevron, 0.06, C.chevronPan, 3400);

  // 22.5–23.75: the machine, whole — light pass, accelerating ticks, collapse, cut.
  K.crack(C.converge, 0.2, { lp: 4500, decay: 50 });
  I.whoosh(C.sweep[0], C.sweep[1] - C.sweep[0], 0.25, 600, 2600, -0.7, 0.6, 0.5, 0.9);
  {
    // 16ths easing into 32nds: the interval shrinks linearly from 0.125 to 0.0625 s.
    let t = C.converge;
    let k = 0;
    while (t < C.cut - 0.02) {
      const q = (t - C.converge) / (C.cut - C.converge);
      I.tick(t, 0.07 + 0.08 * q, k % 2 ? 0.15 * (1 - q) : -0.15 * (1 - q), 1800 + 1400 * q);
      K.glass(t, 86 + (k % 2 ? 3 : 0), 0.012 + 0.012 * q, 0, 0.12, 0.2);
      t += 0.125 - 0.0625 * q;
      k++;
    }
  }
  I.whoosh(C.collapse, C.cut - C.collapse, 0.35, 500, 4000, -0.6, 0, 0.92, 1.6);
  I.riser(C.converge + 0.4, C.cut - C.converge - 0.4, 150, 600, 0.03, 2.4);
  I.sub(KEY.bass.pedal, (t) => 0.08 * env(t, C.converge, C.cut, 0.05, 0.01) * clamp((t - C.converge) / 1.2 + 0.3), C.converge, C.cut, 0.5);
  // 23.75–24.0: the cut (fader) and the reverse swell (overdub).

  // 24.0: THE LOGO HIT — rings out under three soft bells on the tagline.
  I.boom(C.logo, 0.65, 100, midi(26), 1.0, 0.45);
  K.crack(C.logo, 0.65, { lp: 7500, decay: 24 });
  K.plate(C.logo, 0.12, { decay: 1.1 });
  KEY.logoBells.forEach((n, i) => I.bell(C.logo, n, 0.05, i ? 0.25 : -0.25, 1.3));
  C.tagline.forEach((t, i) => {
    I.bell(t, KEY.tagline[i], [0.17, 0.17, 0.2][i], C.taglinePan[i], 0.8, 0.4);
    K.glass(t, KEY.tagline[i] + 12, 0.03, C.taglinePan[i], 0.2);
  });

  /* 5 · Pads: one per harmonic span, ducked by the kick where the groove plays. */
  const PAD = 1.25; // pad bus level
  const P = (notes, t0, t1, gain, cutoff, duckDepth = 0.85) => ({ notes, t0, t1, gain: (t) => PAD * gain(t), cutoff, duckDepth });
  K.pads([
    // Act I: a dark Dm bed swelling to the breath.
    P(KEY.bed, C.pieces, C.breath[0], (t) => 0.055 * env(t, C.pieces, C.breath[0], 1.0, 0.01) * (0.6 + 0.4 * smooth((t - C.islands) / 4.5)), (t) => 220 + 900 * smooth((t - C.pieces) / 6) ** 2, 0.8),
    // 8.0: the bloom.
    P(KEY.title, C.title, C.thread + 0.04, (t) => (0.065 + 0.035 * Math.exp(-(t - C.title) * 1.5)) * env(t, C.title, C.thread + 0.04, 0.03, 0.06), (t) => 380 + 2400 * Math.exp(-((t - C.title - 0.35) ** 2) / 0.12) + 900 * smooth((t - C.title) / 0.4)),
    // 10.0: Bbmaj9 as the thread lights.
    P(KEY.path, C.thread - 0.02, C.split + 0.04, (t) => 0.077 * env(t, C.thread - 0.02, C.split + 0.04, 0.06, 0.06), (t) => 1100 + 600 * Math.exp(-(t - C.thread) * 2)),
    // 12.5: Gm9, low and thin.
    P(KEY.split, C.split - 0.02, C.bar + 0.03, (t) => 0.045 * env(t, C.split - 0.02, C.bar + 0.03, 0.06, 0.05), () => 650, 0.6),
    // 14.0: Dm/A, the filter rising into the gap.
    P(KEY.tension, C.bar - 0.02, C.gap[0], (t) => (0.042 + 0.05 * smooth((t - C.bar) / 1.9)) * env(t, C.bar - 0.02, C.gap[0], 0.05, 0.004), (t) => 400 + 2200 * smooth((t - C.bar) / 1.94) ** 2, 0.6),
    // 16.0: the lifted chord holds until the groove takes it to Bb.
    P(KEY.major, C.lift[0] + C.lift[1] - 0.04, C.impact + 0.06, (t) => 0.07 * env(t, C.lift[0] + C.lift[1] - 0.04, C.impact + 0.06, 0.08, 0.08), (t) => 900 + 1500 * Math.exp(-(t - C.press) * 3), 0.3),
    // 16.5: Bbmaj9 under the amber path.
    P(KEY.impact, C.impact - 0.02, C.ramp + 0.06, (t) => 0.077 * env(t, C.impact - 0.02, C.ramp + 0.06, 0.06, 0.08), () => 1300),
    // 18.0: Cadd9, quiet under the ramp, opening into the apex.
    P(KEY.ramp, C.ramp - 0.02, C.apex + 0.02, (t) => (0.042 + 0.05 * smooth((t - C.propose) / 1)) * env(t, C.ramp - 0.02, C.apex + 0.02, 0.08, 0.02), (t) => 600 + 2000 * smooth((t - C.propose) / 1) ** 2, 0.7),
    // 20.0: the apex chord over the pedal, then the turn.
    P(KEY.apex, C.apex, C.turn + 0.06, (t) => 0.084 * env(t, C.apex, C.turn + 0.06, 0.02, 0.12), (t) => 1800 + 1600 * Math.exp(-(t - C.apex) * 1.2), 0.3),
    P(KEY.turn, C.turn - 0.06, C.converge, (t) => 0.078 * env(t, C.turn - 0.06, C.converge, 0.12, 0.015), (t) => 1700 + 300 * Math.exp(-(t - C.turn)), 0.3),
    // 22.5: an open fifth, the filter rising to the cut.
    P(KEY.converge, C.converge, C.cut, (t) => (0.042 + 0.056 * smooth((t - C.converge) / 1.25)) * env(t, C.converge, C.cut, 0.02, 0.006), (t) => 300 + 1600 * smooth((t - C.converge) / 1.25) ** 2, 0.5),
    // 24.0: the logo chord rings out.
    P(KEY.logo, C.logo, C.decayed - 0.3, (t) => 0.1 * Math.exp(-(t - C.logo) * 2.0) * env(t, C.logo, C.decayed - 0.3, 0.015, 0.3), (t) => 600 + 2200 * Math.exp(-(t - C.logo) * 1.4), 0.2),
  ], { send: 0.1, trim: 0.06 });
  // Act I sub bed, ducked by the kicks from 4.5.
  I.sub(26, (t) => 0.05 * env(t, C.pieces, C.breath[0], 0.6, 0.01), C.pieces, C.breath[0], 1);

  /* 6 · Master, then the fader and the overdubs. */
  const bytes = I.master({ verb: 0.1, drive: 1.3, fadeIn: 0.002, fadeOut: 0.3, ceiling: CEILING });
  const n = (bytes.length - 44) / 4;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = bytes.readInt16LE(44 + i * 4) / 32767;
    R[i] = bytes.readInt16LE(46 + i * 4) / 32767;
  }
  highpass(L, 24);
  highpass(R, 24);
  limit(L, R, LIMIT_DB, CEILING);
  for (let i = 0; i < n; i++) {
    const g = fader(i / SR);
    L[i] *= g;
    R[i] *= g;
  }
  overdub(L, R, rand);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const tp = truePeak(L, R);
  const norm = Math.min(peak > CEILING ? CEILING / peak : 1, tp > TRUE_PEAK ? TRUE_PEAK / tp : 1);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(clamp(L[i] * norm, -1, 1) * 32767), i * 4);
    data.writeInt16LE(Math.round(clamp(R[i] * norm, -1, 1) * 32767), i * 4 + 2);
  }
  return writeWav(file, wav(data));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../out/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  console.log(writeLaunchSoundtrack(fileURLToPath(new URL('launch-audio.wav', dir))));
}
