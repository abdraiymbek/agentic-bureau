/**
 * The evaluation suite judges parts with the same deterministic check engine
 * the agent-facing `cad.check` tool uses (packages/core/src/cad-checks.ts).
 * The engine is validated against real OpenSCAD renders of closed-form shapes
 * in packages/engineering/src/mesh.test.ts and against hand-written reference
 * solutions for every task before any agent run.
 */
export { preservationCheck, runChecks, type CheckResult } from '@omenflow/core';
export type { Expectation, HoleSpec, SectionSpec } from '@omenflow/contracts';
