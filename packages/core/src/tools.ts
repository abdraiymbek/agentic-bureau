import type { MaybeQuantity, WiringConnection, WiringPayload } from '@omenflow/contracts';

/**
 * Engineering tool contracts. Implementations live in packages/engineering
 * (OpenSCAD adapter, mathjs engine, wiring analyzer). Core calls through
 * these interfaces so tests can substitute fakes and adapters stay swappable.
 */

export interface ToolProbeResult {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  error?: string;
}

export interface CadRenderSpec {
  jobId: string;
  scadPath: string;
  outPath: string;
  params: Record<string, number | string | boolean>;
  timeoutMs: number;
  workDir: string;
}

export interface CadRenderResult {
  ok: boolean;
  error?: string;
}

export interface StlInspect {
  triangles: number;
  bytes: number;
  format: 'ascii' | 'binary';
  bounds: { min: [number, number, number]; max: [number, number, number] };
  plausible: boolean;
}

export interface CadAdapter {
  toolId: string;
  probe(): Promise<ToolProbeResult>;
  validateSource(scadPath: string): Promise<{ ok: boolean; errors: string[] }>;
  render(spec: CadRenderSpec, onLog: (chunk: string) => void): Promise<CadRenderResult>;
  cancel(jobId: string): void;
  inspectStl(buf: Buffer): StlInspect;
}

export interface CalcTemplate {
  id: string;
  title: string;
  description: string;
  expression: string;
  inputs: { name: string; unit: string; required: boolean; description?: string }[];
  outputUnit: string;
  assumptions: string[];
  limitations: string[];
}

export interface CalcEngine {
  templates(): CalcTemplate[];
  /** Evaluate a restricted expression with named quantities → quantity. */
  evaluate(
    expression: string,
    inputs: { name: string; quantity: MaybeQuantity }[],
    outputUnit?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ value: number; unit: string }>;
}

export interface WiringFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  connectionId?: string;
}
export interface WiringAnalyzer {
  validate(
    payload: WiringPayload,
    resolveComponent: (artifactId: string) => Record<string, unknown> | undefined,
  ): { findings: WiringFinding[]; coverage: string };
  render(
    payload: WiringPayload,
    resolveComponent: (artifactId: string) => { title: string } | undefined,
  ): {
    table: { connection: WiringConnection; fromLabel: string; toLabel: string }[];
    diagramSvg: string;
  };
}

export interface EngineTools {
  cad?: CadAdapter;
  calc?: CalcEngine;
  wiring?: WiringAnalyzer;
}
