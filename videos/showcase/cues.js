// Shared timeline for the showcase picture and its soundtrack (seconds). The
// picture and scripts/showcase-audio.mjs both read these, so retiming a beat here
// moves its sound with it.

export const DURATION = 38;

export const PROMPT =
  'Design a survey quadcopter that carries a 300 g sensor head for 20 minutes and folds into a backpack.';

/** The score runs at 120 BPM from the moment the prompt is sent: beat n is at BEAT0 + n / 2. */
export const BEAT0 = 5.3;

export const CUE = {
  clickComposer: 0.95,
  typeStart: 1.15,
  typeEnd: 4.7,
  clickSend: 5.3,
  clickFlow: 7.55,
  ch1: 8.3,
  ch2: 12.3,
  ch3: 16.3,
  clickShow3d: 19.0,
  ch4: 22.3,
  whole: 26.3,
  hover: 27.8,
  proposal: 27.3,
  clickCheck: 30.05,
  clickApprove: 30.75,
  clickConfirm: 31.35,
  approved: 31.8,
  pullBack: 33.3,
  end: 34.3,
};

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** When each character of the prompt lands: an uneven human rhythm, slower after spaces. */
export const TYPE_TIMES = (() => {
  const rand = rng(11);
  const gaps = [...PROMPT].map((ch, i) => {
    const prev = PROMPT[i - 1];
    let g = 0.55 + rand() * 0.9;
    if (prev === ' ') g += 0.5;
    if (prev === ',' || prev === '.') g += 1.2;
    if (/[0-9]/.test(ch)) g += 0.35;
    return g;
  });
  const total = gaps.reduce((a, b) => a + b, 0);
  const span = CUE.typeEnd - CUE.typeStart;
  let acc = 0;
  return gaps.map((g) => {
    acc += g;
    return CUE.typeStart + (acc / total) * span;
  });
})();

/** Host call ledger rows as they arrive: [time, tool, duration ms]. */
export const CALLS = [
  [5.55, 'project_summary', 14],
  [5.8, 'artifact_create_draft', 41],
  [6.02, 'artifact_create_draft', 37],
  [6.24, 'artifact_create_draft', 39],
  [6.5, 'artifact_create_draft', 44],
  [6.82, 'source_capture', 212],
  [7.1, 'source_capture', 187],
  [7.36, 'source_capture', 203],
];

/** Each object's arrival on the map; the soundtrack ticks on every one. */
export const NODE_TIMES = {
  req_payload: 8.65,
  req_flight: 8.9,
  req_fold: 9.15,
  asm_hover: 9.5,
  s0: 12.55,
  s1: 12.75,
  s2: 12.95,
  s3: 13.15,
  s4: 13.35,
  s5: 13.55,
  c0: 13.05,
  c1: 13.25,
  c2: 13.45,
  c3: 13.65,
  c4: 13.85,
  c5: 14.05,
  arch: 16.75,
  hinge: 17.0,
  mount: 17.25,
  wiring: 17.5,
  assembly: 17.75,
  mass: 22.65,
  twr: 22.9,
  endurance: 23.15,
  hovertest: 23.55,
};
