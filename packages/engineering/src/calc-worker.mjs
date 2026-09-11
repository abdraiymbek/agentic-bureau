/**
 * Restricted mathjs evaluator — runs inside a node:worker_threads Worker with a
 * small heap limit (resourceLimits) and a parent-enforced wall-clock timeout.
 *
 * This file is plain .mjs on purpose: it must load under node/vitest/vite
 * without transpilation.
 *
 * Protocol: the job arrives via workerData —
 *   { expression: string,
 *     inputs: [{ name, value, unit }],   // unit = mathjs-native base unit | null (dimensionless)
 *     outputUnit: string }               // canonical STARK unit name | '1'
 * and replies exactly once on parentPort:
 *   { ok: true, value, unit } | { ok: false, code: 'INVALID_UNITS' | 'VALIDATION', error }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { create, all } from 'mathjs';

const math = create(all);

/* Contract units mathjs lacks natively. Registered here as trusted setup code —
 * user expressions cannot reach createUnit (see DISABLED below). */
for (const [name, def] of [
  ['Ah', '3600 C'],
  ['mAh', '3.6 C'],
  ['rpm', '0.10471975511965977 rad/s'],
  ['mph', '0.44704 m/s'],
]) {
  try {
    math.createUnit(name, { definition: def, override: true });
  } catch {
    /* already defined — fine */
  }
}

/* Capture the evaluator, then strip every code-loading / code-evaluating /
 * expression-rewriting surface so expressions cannot reach them. */
const rawEvaluate = math.evaluate;
const DISABLED = [
  'import',
  'createUnit',
  'evaluate',
  'parse',
  'compile',
  'help',
  'reviver',
  'simplify',
  'rationalize',
  'derivative',
  'resolve',
  'lsolve',
  'lusolve',
];
const stubs = {};
for (const n of DISABLED) {
  stubs[n] = () => {
    throw new Error(`function '${n}' is disabled`);
  };
}
math.import(stubs, { override: true });

function fail(code, error) {
  return { ok: false, code, error };
}

function classify(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /unit|convert|dimension|incompat/i.test(msg) ? 'INVALID_UNITS' : 'VALIDATION';
}

function run(job) {
  // Plain object scope — mathjs introspects it and breaks on null-prototype objects.
  const scope = {};
  for (const inp of job.inputs) {
    scope[inp.name] = inp.unit == null ? inp.value : math.unit(inp.value, inp.unit);
  }
  const result = rawEvaluate(job.expression, scope);
  const out = typeof job.outputUnit === 'string' && job.outputUnit ? job.outputUnit : '1';

  if (result && result.isUnit) {
    if (out === '1') {
      // Only succeeds when the result is genuinely dimensionless.
      return { ok: true, value: result.toNumber(''), unit: '1' };
    }
    return { ok: true, value: result.toNumber(out), unit: out };
  }

  let v;
  if (typeof result === 'number') {
    v = result;
  } else if (
    result &&
    typeof result.valueOf === 'function' &&
    typeof result.valueOf() === 'number'
  ) {
    v = Number(result.valueOf());
  } else {
    return fail('VALIDATION', `Unsupported expression result type: ${math.typeOf(result)}`);
  }
  if (!Number.isFinite(v)) return fail('VALIDATION', 'Result is not finite');
  return { ok: true, value: v, unit: out };
}

try {
  parentPort.postMessage(run(workerData));
} catch (e) {
  parentPort.postMessage(fail(classify(e), e instanceof Error ? e.message : String(e)));
}
