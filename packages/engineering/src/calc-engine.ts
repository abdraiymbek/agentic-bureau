import { Worker } from 'node:worker_threads';
import {
  ErrorCodes,
  StarkError,
  isUnknown,
  toBase,
  unitDef,
  type Dim,
  type MaybeQuantity,
} from '@stark/contracts';
import type { CalcEngine, CalcTemplate } from '@stark/core';

/** Contract dimension → mathjs-native base unit name used inside the worker. */
const BASE_UNIT: Record<Dim, string> = {
  length: 'm',
  mass: 'kg',
  time: 's',
  current: 'A',
  voltage: 'V',
  power: 'W',
  energy: 'J',
  charge: 'C',
  force: 'N',
  torque: 'N*m',
  angle: 'rad',
  angular_speed: 'rad/s',
  speed: 'm/s',
  acceleration: 'm/s^2',
  temperature: 'K',
  data: 'B',
  dimensionless: '1',
};

const MAX_EXPRESSION_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 2000;
const WORKER_HEAP_MB = 64;

/**
 * Expression pre-validation (parent side, before the worker spawns). This is a
 * pragmatic blocklist — the worker additionally strips code-evaluating
 * functions from the mathjs instance, so these checks exist to fail fast and
 * to deny things a mathjs parse tree could still reach:
 *  - no assignments: a bare '=' that is not part of ==, <=, >=, !=
 *  - character whitelist: identifiers, digits, whitespace, and the operators
 *    mathjs actually needs — which excludes ';' (statement chains), quotes
 *    (strings), '[]' (matrix/index accessors), '{}' (objects), '=>', '$', etc.
 *  - word blocklist: JS-ish / dynamic tokens that must never appear even if a
 *    future mathjs version gives them meaning.
 */
const ALLOWED_CHARS = /^[A-Za-z0-9_+\-*/^%(),.\s<>=!]*$/;
const BARE_ASSIGN = /(?<![!<>=])=(?!=)/;
const ARROW = /=>/;
const BLOCKED_WORDS =
  /\b(import|eval|function|require|process|globalThis|global|constructor|prototype|__proto__|new|this|while|return|async|await|delete|typeof|instanceof|class|yield|export|from)\b/;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertExpressionSafe(expression: string): void {
  if (!expression || !expression.trim()) {
    throw new StarkError(ErrorCodes.VALIDATION, 'Expression is empty');
  }
  if (expression.length > MAX_EXPRESSION_CHARS) {
    throw new StarkError(
      ErrorCodes.VALIDATION,
      `Expression too long (${expression.length} > ${MAX_EXPRESSION_CHARS} chars)`,
    );
  }
  if (ARROW.test(expression) || BARE_ASSIGN.test(expression)) {
    throw new StarkError(
      ErrorCodes.VALIDATION,
      "Expression must be pure — assignments ('=') and lambdas ('=>') are not allowed",
    );
  }
  if (!ALLOWED_CHARS.test(expression)) {
    const bad = [...expression].find((c) => !new RegExp(ALLOWED_CHARS.source).test(`${c}`));
    throw new StarkError(
      ErrorCodes.VALIDATION,
      `Expression contains disallowed character ${JSON.stringify(bad)} — only arithmetic, comparisons and function calls are permitted`,
    );
  }
  const word = BLOCKED_WORDS.exec(expression);
  if (word) {
    throw new StarkError(
      ErrorCodes.VALIDATION,
      `Expression contains disallowed token '${word[0]}'`,
    );
  }
}

interface WorkerInput {
  name: string;
  value: number;
  unit: string | null;
}
interface WorkerJob {
  expression: string;
  inputs: WorkerInput[];
  outputUnit: string;
}
interface WorkerReply {
  ok: boolean;
  value?: number;
  unit?: string;
  code?: 'INVALID_UNITS' | 'VALIDATION';
  error?: string;
}

export interface MathJsCalcEngineOptions {
  /** Hard wall-clock limit per evaluation, default 2000ms. */
  timeoutMs?: number;
}

/**
 * Unit-aware calculation engine: mathjs running a restricted expression inside
 * a worker thread (64MB heap cap + wall-clock timeout). Inputs arrive as
 * contract Quantities and are normalized to SI base units before marshalling,
 * so every unit mathjs sees is native.
 */
export class MathJsCalcEngine implements CalcEngine {
  private readonly timeoutMs: number;

  constructor(opts?: MathJsCalcEngineOptions) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  templates(): CalcTemplate[] {
    return TEMPLATES;
  }

  async evaluate(
    expression: string,
    inputs: { name: string; quantity: MaybeQuantity }[],
    outputUnit?: string,
  ): Promise<{ value: number; unit: string }> {
    assertExpressionSafe(expression);

    const marshalled: WorkerInput[] = [];
    for (const i of inputs) {
      if (!INPUT_NAME.test(i.name) || BLOCKED_WORDS.test(i.name)) {
        throw new StarkError(ErrorCodes.VALIDATION, `Invalid input name '${i.name}'`);
      }
      if (isUnknown(i.quantity)) {
        throw new StarkError(
          ErrorCodes.INVALID_UNITS,
          `Input '${i.name}' is unknown (${'reason' in (i.quantity as object) ? (i.quantity as { reason: string }).reason : 'no value'})`,
        );
      }
      const q = i.quantity as { value: number; unit: string };
      const def = unitDef(q.unit);
      if (!def) {
        throw new StarkError(ErrorCodes.INVALID_UNITS, `Unknown unit '${q.unit}' for input '${i.name}'`);
      }
      marshalled.push({
        name: i.name,
        value: toBase(q),
        unit: def.dim === 'dimensionless' ? null : BASE_UNIT[def.dim],
      });
    }

    let out = '1';
    if (outputUnit !== undefined) {
      const def = unitDef(outputUnit);
      if (!def) {
        throw new StarkError(ErrorCodes.INVALID_UNITS, `Unknown output unit '${outputUnit}'`);
      }
      out = def.dim === 'dimensionless' ? '1' : def.name;
    }

    const reply = await this.runWorker({ expression, inputs: marshalled, outputUnit: out });
    if (!reply.ok) {
      const code = reply.code === 'INVALID_UNITS' ? ErrorCodes.INVALID_UNITS : ErrorCodes.VALIDATION;
      throw new StarkError(code, reply.error ?? 'calculation failed');
    }
    const value = reply.value!;
    if (!Number.isFinite(value)) {
      throw new StarkError(ErrorCodes.VALIDATION, 'Result is not finite');
    }
    return { value, unit: reply.unit ?? out };
  }

  private runWorker(job: WorkerJob): Promise<WorkerReply> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(new URL('./calc-worker.mjs', import.meta.url), {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => {
        done(() =>
          reject(
            new StarkError(ErrorCodes.TIMEOUT, `Calculation timed out after ${this.timeoutMs}ms`),
          ),
        );
      }, this.timeoutMs);
      worker.once('message', (m: WorkerReply) => done(() => resolve(m)));
      worker.once('error', (e) =>
        done(() => reject(new StarkError(ErrorCodes.INTERNAL, `calc worker error: ${e.message}`))),
      );
      worker.once('exit', (code) => {
        if (code !== 0) {
          done(() =>
            reject(new StarkError(ErrorCodes.INTERNAL, `calc worker exited with code ${code}`)),
          );
        } else {
          done(() =>
            reject(new StarkError(ErrorCodes.INTERNAL, 'calc worker exited without a result')),
          );
        }
      });
    });
  }
}

const TEMPLATES: CalcTemplate[] = [
  {
    id: 'mass_budget',
    title: 'Mass budget',
    description: 'Total dry mass as the sum of subsystem masses.',
    expression: 'payload + chassis + electronics + battery',
    inputs: [
      { name: 'payload', unit: 'kg', required: true, description: 'Payload mass' },
      { name: 'chassis', unit: 'kg', required: true, description: 'Chassis / frame mass' },
      { name: 'electronics', unit: 'kg', required: true, description: 'Electronics mass' },
      { name: 'battery', unit: 'kg', required: true, description: 'Battery mass' },
    ],
    outputUnit: 'kg',
    assumptions: ['Static dry mass sum; connectors and wiring not included'],
    limitations: ['Estimate only — weigh the final assembly'],
  },
  {
    id: 'power_budget',
    title: 'Power budget',
    description: 'Required supply power: larger of margined average load and peak load.',
    expression: 'max(avg_load * margin, peak_load)',
    inputs: [
      { name: 'avg_load', unit: 'W', required: true, description: 'Average continuous load' },
      { name: 'peak_load', unit: 'W', required: true, description: 'Worst-case momentary load' },
      {
        name: 'margin',
        unit: '1',
        required: true,
        description: 'Dimensionless headroom factor applied to average load (e.g. 1.25)',
      },
    ],
    outputUnit: 'W',
    assumptions: ['Peak load is a hard floor regardless of margin'],
    limitations: ['Estimate only — measure real draw under load'],
  },
  {
    id: 'battery_energy',
    title: 'Battery energy',
    description: 'Usable pack energy from nominal voltage, capacity and depth of discharge.',
    expression: 'voltage * capacity * usable_fraction',
    inputs: [
      { name: 'voltage', unit: 'V', required: true, description: 'Nominal pack voltage' },
      { name: 'capacity', unit: 'Ah', required: true, description: 'Nameplate capacity' },
      {
        name: 'usable_fraction',
        unit: '1',
        required: true,
        description: 'Usable fraction of nameplate (0–1), e.g. 0.8 for 80% DoD',
      },
    ],
    outputUnit: 'Wh',
    assumptions: ['Constant nominal voltage; ignores discharge-curve sag and temperature'],
    limitations: ['Estimate only — real capacity varies with rate, age and temperature'],
  },
  {
    id: 'torque_load',
    title: 'Torque load (incline + acceleration)',
    description: 'Wheel torque needed to hold on an incline while accelerating: m·g·(sin θ + a/g)·r.',
    expression: 'mass * g * (sin(incline) + accel / g) * wheel_radius',
    inputs: [
      { name: 'mass', unit: 'kg', required: true, description: 'Total vehicle mass' },
      { name: 'g', unit: 'm/s^2', required: true, description: 'Gravity (9.80665 m/s^2 standard)' },
      { name: 'incline', unit: 'deg', required: true, description: 'Maximum incline angle' },
      { name: 'wheel_radius', unit: 'm', required: true, description: 'Loaded wheel radius' },
      { name: 'accel', unit: 'm/s^2', required: true, description: 'Required linear acceleration' },
    ],
    outputUnit: 'N*m',
    assumptions: [
      'Standard gravity 9.80665 m/s² is applied inside the expression',
      'Total torque at the driven wheels — divide by driven-wheel count for per-wheel torque',
    ],
    limitations: ['Ignores rolling resistance, drivetrain losses and wheel slip'],
  },
];
