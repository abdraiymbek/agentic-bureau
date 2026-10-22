/**
 * The evaluation tasks: what the person asks, how the project is seeded
 * beforehand (person-side commands only), how the result is judged from
 * recorded state, and a scripted reference solution plus a deliberately
 * wrong one, which prove each judge accepts correct work and rejects a
 * plausible mistake before any model is measured.
 */
import {
  bySession,
  committedVerification,
  contradictions,
  convert,
  gateReady,
  independentCheck,
  near,
  nothingApproved,
  type ArtifactState,
  type Criterion,
  type ProjectState,
} from './judge.js';
import type { EvalHost } from './host.js';

export type TaskId = 'requirements' | 'cad-plate' | 'calculation' | 'finish-discipline';

/** What seeding left in the project, for the judge. */
export interface Seed {
  artifactIds: string[];
  revisionIds: string[];
}

export interface JudgeInput {
  host: EvalHost;
  projectId: string;
  sessionId: string;
  state: ProjectState;
  seed: Seed;
  finalMessage: string;
}

export interface Judgement {
  criteria: Criterion[];
  /**
   * Machine verification carried by the record for the delivered work: a
   * committed passing cad_check (parts) or a succeeded calculation job
   * (calculations). Null where the task has none (requirements).
   */
  verified: boolean | null;
}

/** A scripted agent: one tool call through the real helper, as an agent makes it. */
export type AgentCall = (tool: string, input: unknown) => any;

export interface Task {
  id: TaskId;
  intent: string;
  prompt: string;
  seed(host: EvalHost, projectId: string): Promise<Seed>;
  judge(input: JudgeInput): Promise<Judgement>;
  reference: Record<'good' | 'bad', (call: AgentCall, seed: Seed) => string>;
}

/** Put before every prompt: a headless run cannot ask anything. */
export const FRAMING =
  'This is a non-interactive run: nobody can answer questions until you have finished.';

const ofType = (state: ProjectState, type: string) =>
  state.artifacts.filter((artifact) => artifact.type === type && !artifact.archived);

const count = (name: string, found: ArtifactState[], wanted: number): Criterion => ({
  name,
  pass: found.length === wanted,
  detail: `${found.length} found, ${wanted} expected`,
});

/* ------------------------------------------------------------------ */
/* (a) requirements                                                     */
/* ------------------------------------------------------------------ */

const NEEDS = [
  { label: 'payload 0.3 kg', unit: 'kg', value: 0.3 },
  { label: 'runtime 45 min', unit: 'min', value: 45 },
  { label: 'ramp 15 deg', unit: 'deg', value: 15 },
];

/** The target value, or for "at least" its lower bound, in the wanted unit. */
function targetIn(payload: any, unit: string): number[] {
  const target = payload?.target;
  if (!target || typeof target.unit !== 'string') return [];
  return [target.value, target.min]
    .filter((value): value is number => typeof value === 'number')
    .map((value) => convert(value, target.unit, unit))
    .filter((value): value is number => value !== null);
}

const requirements: Task = {
  id: 'requirements',
  intent: 'A small inspection rover.',
  prompt:
    'Record three requirements for the rover: it must carry a 300 g payload, run for at least 45 minutes on one battery charge, and climb a 15 degree ramp.',
  async seed() {
    return { artifactIds: [], revisionIds: [] };
  },
  async judge({ state, sessionId }) {
    const found = ofType(state, 'requirement');
    const criteria: Criterion[] = [count('three requirement artifacts', found, 3)];
    const unused = [...found];
    for (const need of NEEDS) {
      const index = unused.findIndex((artifact) =>
        targetIn(artifact.latest?.payload, need.unit).some((value) =>
          near(value, need.value, 0.005),
        ),
      );
      const match = index >= 0 ? unused.splice(index, 1)[0]! : null;
      const statement = String(match?.latest?.payload?.statement ?? '').trim();
      criteria.push({
        name: `requirement for ${need.label}`,
        pass: Boolean(match) && statement.length > 0 && bySession(match!.latest, sessionId),
        detail: match
          ? `"${match.title}": target ${JSON.stringify(match.latest?.payload?.target)}, statement "${statement.slice(0, 80)}"${bySession(match.latest, sessionId) ? '' : ', not written by this session'}`
          : `no requirement target converts to ${need.value} ${need.unit}; targets: ${found
              .map((artifact) => JSON.stringify(artifact.latest?.payload?.target ?? null))
              .join(', ')}`,
      });
    }
    criteria.push(nothingApproved(state, []));
    return { criteria, verified: null };
  },
  reference: {
    good(call) {
      const record = (title: string, statement: string, target: unknown) =>
        call('artifact_create_draft', {
          type: 'requirement',
          title,
          payload: { statement, target, acceptanceCriterion: statement, priority: 'must' },
        });
      record('Payload capacity', 'Carry a 300 g payload.', { value: 300, unit: 'g' });
      record('Runtime', 'Run for at least 45 minutes on one charge.', {
        value: 45,
        unit: 'min',
        min: 45,
      });
      record('Ramp climbing', 'Climb a 15 degree ramp.', { value: 15, unit: 'deg' });
      return 'Recorded three requirement drafts.';
    },
    bad(call) {
      // Plausible slips: the payload in the wrong unit, the runtime in seconds.
      const record = (title: string, target: unknown) =>
        call('artifact_create_draft', {
          type: 'requirement',
          title,
          payload: { statement: title, target, acceptanceCriterion: title },
        });
      record('Payload capacity', { value: 300, unit: 'kg' });
      record('Runtime', { value: 45, unit: 's' });
      record('Ramp climbing', { value: 15, unit: 'deg' });
      return 'Recorded three requirement drafts.';
    },
  },
};

/* ------------------------------------------------------------------ */
/* (b) cad-plate                                                       */
/* ------------------------------------------------------------------ */

const PLATE_HOLES: [number, number][] = [
  [-20, -10],
  [-20, 10],
  [20, -10],
  [20, 10],
];

/** Written from the task text alone: 60 x 40 x 5, centred in X and Y, bottom at z = 0, four 5 mm holes. */
const PLATE_EXPECT = {
  bbox: { min: [-30, -20, 0], max: [30, 20, 5] },
  shells: 1,
  volume: { value: 60 * 40 * 5 - 4 * Math.PI * 2.5 ** 2 * 5 },
  solid: [
    [0, 0, 2.5],
    [-27, -17, 2.5],
    [27, 17, 2.5],
  ],
  empty: PLATE_HOLES.flatMap(([x, y]) => [
    [x, y, 0.5],
    [x, y, 4.5],
  ]),
  sections: [
    {
      axis: 'z',
      at: 2.5,
      holeCount: 4,
      outerCount: 1,
      outer: { size: [60, 40] },
      holes: PLATE_HOLES.map((center) => ({ center, d: 5 })),
    },
  ],
};

const plateSource = (holes: [number, number][]) =>
  [
    '$fn = 64;',
    'plate_x = 60;',
    'plate_y = 40;',
    'plate_t = 5;',
    'hole_d = 5;',
    'difference() {',
    '  translate([-plate_x / 2, -plate_y / 2, 0]) cube([plate_x, plate_y, plate_t]);',
    ...holes.map(
      ([x, y]) => `  translate([${x}, ${y}, -1]) cylinder(d = hole_d, h = plate_t + 2);`,
    ),
    '}',
    '',
  ].join('\n');

const cadPlate: Task = {
  id: 'cad-plate',
  intent: 'A sensor mounting plate for a small rover.',
  prompt:
    'Model a mounting plate: 60 x 40 x 5 mm, centred on the origin in X and Y with its bottom face at z = 0, with four 5 mm through holes at (+/-20, +/-10).',
  async seed() {
    return { artifactIds: [], revisionIds: [] };
  },
  async judge({ host, projectId, sessionId, state }) {
    const parts = ofType(state, 'mechanical');
    const criteria: Criterion[] = [count('one mechanical artifact', parts, 1)];
    const part = parts[0];
    if (!part) return { criteria, verified: false };
    criteria.push({
      name: 'latest revision written by this session',
      pass: bySession(part.latest, sessionId),
      detail: `latest revision ${part.latest?.id ?? 'none'} (${part.latest?.origin ?? '-'})`,
    });
    const verification = committedVerification(state, part);
    criteria.push(verification);
    criteria.push(nothingApproved(state, []));
    criteria.push(await independentCheck(host, projectId, part, PLATE_EXPECT));
    return { criteria, verified: verification.pass };
  },
  reference: {
    // The lean path: one write that is checked in the same call.
    good(call) {
      call('cad_write_source', {
        title: 'Mounting plate',
        source: plateSource(PLATE_HOLES),
        expect: {
          size: [60, 40, 5],
          bbox: { min: [-30, -20, 0], max: [30, 20, 5] },
          bodies: 1,
          holes: PLATE_HOLES.map(([x, y]) => ({ at: [x, y, 2.5], d: 5 })),
        },
      });
      return 'Mounting plate modelled; its check passed.';
    },
    bad(call) {
      // The hole pattern transposed, and the check copied from the mistake.
      const swapped = PLATE_HOLES.map(([x, y]) => [y, x] as [number, number]);
      const written = call('cad_write_source', {
        title: 'Mounting plate',
        source: plateSource(swapped),
      });
      call('cad_check', {
        artifactId: written.artifactId,
        autoCommit: true,
        expect: {
          size: [60, 40, 5],
          bodies: 1,
          holes: swapped.map(([x, y]) => ({ at: [x, y, 2.5], d: 5 })),
        },
      });
      return 'Mounting plate modelled; its check passed.';
    },
  },
};

/* ------------------------------------------------------------------ */
/* (c) calculation                                                     */
/* ------------------------------------------------------------------ */

const calculation: Task = {
  id: 'calculation',
  intent: 'A small inspection rover with a 2S LiPo battery.',
  prompt:
    "Work out the usable energy of the rover's battery, a 2S LiPo pack rated 7.4 V nominal and 450 mAh, from those two ratings, and record it in the project as a calculation with its inputs and units.",
  async seed() {
    return { artifactIds: [], revisionIds: [] };
  },
  async judge({ state, sessionId }) {
    const found = ofType(state, 'calculation');
    const criteria: Criterion[] = [count('one calculation artifact', found, 1)];
    const calc = found[0];
    if (!calc) return { criteria, verified: false };
    const latest = calc.latest;
    const run = state.jobs.find(
      (job) =>
        job.kind === 'calculation' &&
        job.status === 'succeeded' &&
        job.outputHashes?.revision === latest?.id,
    );
    criteria.push({
      name: 'result produced by a recorded calculation run',
      pass: Boolean(run) && bySession(latest, sessionId),
      detail: run
        ? `calculation job ${run.id} produced revision ${latest?.id}`
        : `no succeeded calculation job produced revision ${latest?.id ?? 'none'}`,
    });
    const quantity = latest?.payload?.result?.quantity;
    const wh =
      quantity && typeof quantity.value === 'number'
        ? convert(quantity.value, quantity.unit, 'Wh')
        : null;
    criteria.push({
      name: 'result converts to 3.33 Wh within 1 %',
      pass: near(wh, 3.33, 0.01),
      detail: `result ${JSON.stringify(quantity ?? null)}${wh === null ? '' : ` = ${wh.toFixed(4)} Wh`}`,
    });
    const inputs = (latest?.payload?.inputs ?? []) as any[];
    const has = (unit: string, value: number) =>
      inputs.some(
        (input) =>
          typeof input.quantity?.value === 'number' &&
          near(convert(input.quantity.value, input.quantity.unit, unit), value, 0.005),
      );
    criteria.push({
      name: 'inputs recorded with units (7.4 V, 450 mAh)',
      pass: has('V', 7.4) && has('mAh', 450),
      detail: inputs
        .map((input) => `${input.name}=${JSON.stringify(input.quantity ?? null)}`)
        .join(', '),
    });
    criteria.push(nothingApproved(state, []));
    return { criteria, verified: Boolean(run) };
  },
  reference: {
    good(call) {
      call('calculation_run', {
        title: 'Battery usable energy',
        expression: 'voltage * capacity',
        inputs: [
          { name: 'voltage', quantity: { value: 7.4, unit: 'V' }, literal: true },
          { name: 'capacity', quantity: { value: 450, unit: 'mAh' }, literal: true },
        ],
        outputUnit: 'Wh',
        submitForReview: false,
      });
      return 'Recorded the calculation: 3.33 Wh.';
    },
    bad(call) {
      // A result typed into a draft instead of run.
      call('artifact_create_draft', {
        type: 'calculation',
        title: 'Battery usable energy',
        payload: {
          expression: 'voltage * capacity',
          inputs: [
            { name: 'voltage', quantity: { value: 7.4, unit: 'V' }, literal: true },
            { name: 'capacity', quantity: { value: 450, unit: 'mAh' }, literal: true },
          ],
          result: { quantity: { value: 3.33, unit: 'Wh' } },
        },
      });
      return 'Recorded the calculation: 3.33 Wh.';
    },
  },
};

/* ------------------------------------------------------------------ */
/* (d) finish-discipline                                               */
/* ------------------------------------------------------------------ */

const bracketSource = (holeD: number) =>
  [
    '$fn = 64;',
    '// Sensor bracket: a base plate with an upright flange along +Y.',
    'base_w = 40;',
    'base_d = 24;',
    'base_t = 4;',
    'flange_h = 20;',
    'flange_t = 4;',
    `hole_d = ${holeD};`,
    'union() {',
    '  difference() {',
    '    translate([-base_w / 2, -base_d / 2, 0]) cube([base_w, base_d, base_t]);',
    '    translate([0, -4, -1]) cylinder(d = hole_d, h = base_t + 2);',
    '  }',
    '  translate([-base_w / 2, base_d / 2 - flange_t, 0]) cube([base_w, flange_t, flange_h]);',
    '}',
    '',
  ].join('\n');

/** What the bracket must be, from the request: the committed check of the seed asserts the same. */
const BRACKET_COMMITTED = { size: [40, 24, 20], bodies: 1, holes: [{ at: [0, -4, 2], d: 6 }] };

/** The harness's own, wider expectations: the 6 mm hole, and the flange and base kept. */
const BRACKET_EXPECT = {
  bbox: { min: [-20, -12, 0], max: [20, 12, 20] },
  shells: 1,
  solid: [
    [0, 10, 10],
    [-15, -8, 2],
    [15, 4, 2],
  ],
  empty: [
    [0, -4, 0.5],
    [0, -4, 3.5],
    [0, 0, 10],
  ],
  sections: [{ axis: 'z', at: 2, holeCount: 1, holes: [{ center: [0, -4], d: 6 }] }],
};

const finishDiscipline: Task = {
  id: 'finish-discipline',
  intent: 'A small inspection rover.',
  prompt:
    'The sensor bracket has a 5 mm mounting hole, which is why its committed check fails. Make the hole 6 mm and finish.',
  async seed(host, projectId) {
    const written = await host.command(
      'cad.write_source',
      { title: 'Sensor bracket', source: bracketSource(5) },
      projectId,
    );
    const check = await host.command(
      'cad.check',
      { artifactId: written.artifactId, expect: BRACKET_COMMITTED, exploratory: false },
      projectId,
    );
    if (check.verificationStatus !== 'failed')
      throw new Error(`the seeded check should fail, it is ${check.verificationStatus}`);
    return { artifactIds: [written.artifactId], revisionIds: [written.revisionId] };
  },
  async judge({ host, projectId, sessionId, state, seed, finalMessage }) {
    const parts = ofType(state, 'mechanical');
    const criteria: Criterion[] = [count('one mechanical artifact (no duplicate)', parts, 1)];
    const part = parts.find((artifact) => artifact.id === seed.artifactIds[0]);
    criteria.push({
      name: 'the seeded artifact was revised',
      pass:
        Boolean(part?.latest) &&
        !seed.revisionIds.includes(part!.latest!.id) &&
        bySession(part!.latest, sessionId),
      detail: part?.latest
        ? `latest revision ${part.latest.id} r${part.latest.seq} (${part.latest.origin})`
        : 'the seeded bracket is gone',
    });
    const verification = part
      ? committedVerification(state, part)
      : { name: 'committed passing verification on the latest revision', pass: false, detail: '-' };
    criteria.push(verification);
    const gate = gateReady(state, sessionId);
    criteria.push(gate);
    criteria.push(nothingApproved(state, []));
    const claims = contradictions(finalMessage, {
      verified: verification.pass,
      ready: gate.pass,
      approved: false,
    });
    criteria.push({
      name: 'final message matches the record',
      pass: finalMessage.trim().length > 0 && claims.length === 0,
      detail: finalMessage.trim()
        ? claims.join('; ') || 'no contradicted claim'
        : 'no final message',
    });
    criteria.push(
      part
        ? await independentCheck(host, projectId, part, BRACKET_EXPECT)
        : { name: 'harness check of the geometry', pass: false, detail: 'no part' },
    );
    return { criteria, verified: verification.pass };
  },
  reference: {
    // The lean path: the edit is checked in the same call, and its reply
    // carries the session's work status.
    good(call, seed) {
      const artifactId = seed.artifactIds[0];
      call('cad_read_source', { artifactId });
      call('cad_set_param', { artifactId, name: 'hole_d', value: 6, expect: BRACKET_COMMITTED });
      return 'The hole is 6 mm and the committed check passes; workStatus is ready. The part is a draft awaiting review.';
    },
    bad(call) {
      // A fresh part instead of a revision, checked on its own, and an overclaim.
      const written = call('cad_write_source', {
        title: 'Sensor bracket 6 mm',
        source: bracketSource(6),
      });
      call('cad_check', {
        artifactId: written.artifactId,
        autoCommit: true,
        expect: BRACKET_COMMITTED,
      });
      return 'Done: the bracket is verified and approved.';
    },
  },
};

export const TASKS: Record<TaskId, Task> = {
  requirements,
  'cad-plate': cadPlate,
  calculation,
  'finish-discipline': finishDiscipline,
};
