import type { EngineTools } from '@bureau/core';
import { OpenScadAdapter, type OpenScadOptions } from './openscad.js';
import { MathJsCalcEngine, type MathJsCalcEngineOptions } from './calc-engine.js';
import { WiringAnalyzer } from './wiring-analyzer.js';

export { OpenScadAdapter, type OpenScadOptions } from './openscad.js';
export { MathJsCalcEngine, type MathJsCalcEngineOptions } from './calc-engine.js';
export { WiringAnalyzer } from './wiring-analyzer.js';

export interface EngineToolsOptions {
  /** User-configured OpenSCAD executable path (overrides auto-discovery). */
  openScadPath?: string;
  /** Persist a discovered tool path back to app settings. */
  onToolPath?: (toolId: string, path: string) => void;
  calc?: MathJsCalcEngineOptions;
}

/** Construct the real engineering tool adapters for the core dispatch. */
export function createEngineTools(opts?: EngineToolsOptions): EngineTools {
  const cadOpts: OpenScadOptions = {
    preferredPath: opts?.openScadPath,
    onDiscovered: opts?.onToolPath ? (p) => opts.onToolPath!('openscad', p) : undefined,
  };
  return {
    cad: new OpenScadAdapter(cadOpts),
    calc: new MathJsCalcEngine(opts?.calc),
    wiring: new WiringAnalyzer(),
  };
}
