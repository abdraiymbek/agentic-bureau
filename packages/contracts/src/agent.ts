import type { ArtifactType, EvidenceKind, Proposal } from './entities.js';
import type { CapabilityProfile } from './session.js';
import type { MaybeQuantity } from './units.js';

/**
 * Result shapes of the agent-facing operations served by the Rust host:
 * `agent.activity`, `work.status` and `project.coverage`. There is no
 * TypeScript implementation; these types are the contract the renderer reads.
 */

/* ------------------------------------------------------------------ */
/* agent.activity — the agent call ledger                               */
/* ------------------------------------------------------------------ */

/**
 * One recorded agent call. Arguments are never stored. Also the payload of
 * the live `omenflow:agent:call` host channel.
 */
export interface AgentCallRecord {
  /** Monotonic per project. */
  seq: number;
  /** ISO time the call finished. */
  at: string;
  projectId: string;
  sessionId: string;
  /** Underscore tool name as called, or the op for `omenflow call`. */
  tool: string;
  /** Dotted op actually dispatched. */
  op: string;
  via: 'mcp' | 'call';
  ok: boolean;
  /** Error code when the call failed, else null. */
  code: string | null;
  /** One-line error message when the call failed, else null. */
  message: string | null;
  durationMs: number;
  mutating: boolean;
  /** Artifacts named in the input or the result (at most 8). */
  artifactIds: string[];
  /** Input repairs the host applied, e.g. "renamed revisionID → revisionId". */
  notes: string[];
  /**
   * What else the host ran inside the call, in order: the cad_check a source
   * write with `expect` ran, the work_status attached to a committed check.
   * Absent when nothing else ran, and on records of earlier builds.
   */
  alsoRan?: AgentCallAlsoRan[];
}

/**
 * One operation the host ran inside an agent's call. The call's own record
 * says how the call ended; this says how the inner run ended.
 */
export interface AgentCallAlsoRan {
  /** Underscore tool name, e.g. "cad_check". */
  tool: string;
  /** Dotted op, e.g. "cad.check". */
  op: string;
  /** False when it did not run to an answer; `code` then says why. */
  ok: boolean;
  code?: string;
  /** True when the answer was replayed for a retried call with the same idempotency key. */
  replayed?: boolean;
  /** cad_check: the recorded status, whether it was committed and its assertion counts. */
  verificationStatus?: string;
  committed?: boolean;
  passed?: number;
  total?: number;
  /** work_status: the scope it answered for, whether it is ready and how many blockers it lists. */
  scope?: string;
  ready?: boolean;
  blockers?: number;
  /**
   * work_status: how many agent sessions it read as one scope, when its answer named them
   * (`WorkStatus.sessionIds`: a conversation continuation's covers the turns it continues and
   * its own). Absent for one session's answer, and on records of earlier builds.
   */
  sessions?: number;
}

export interface AgentSessionSummary {
  sessionId: string;
  adapterId: string;
  model: string | null;
  profile: CapabilityProfile;
  startedAt: string;
  endedAt: string | null;
  calls: number;
  errors: number;
}

export interface AgentActivity {
  /** The most recent calls, bounded by the request's `limit`. Order by `seq`. */
  calls: AgentCallRecord[];
  sessions: AgentSessionSummary[];
}

/* ------------------------------------------------------------------ */
/* work.status — the completion gate                                    */
/* ------------------------------------------------------------------ */

export const workStatusKinds = [
  'cad_unverified',
  'cad_spec_unasserted',
  'cad_check_failed',
  'cad_scope_changed',
  'cad_render_failed',
  'component_unsourced',
  'component_no_offer',
  'wiring_unvalidated',
  'wiring_findings',
  'calculation_not_run',
  'changes_requested',
  'stale_dependent',
  'empty_payload',
  'draft_unproposed',
] as const;
export type WorkStatusKind = (typeof workStatusKinds)[number];

/** `blocker` makes a claim of completion false; `advice` does not. */
export type WorkStatusSeverity = 'blocker' | 'advice';

/** The call that resolves an outstanding item. */
export interface WorkStatusNext {
  /** Underscore tool name. */
  tool: string;
  why: string;
  /** Arguments already known, ready to pass to the tool. */
  args: Record<string, unknown>;
}

export interface WorkStatusItem {
  kind: WorkStatusKind;
  severity: WorkStatusSeverity;
  artifactId: string;
  /** Revision the item is about; null when it concerns the artifact as a whole. */
  revisionId: string | null;
  type: ArtifactType;
  title: string;
  detail: string;
  /** Null when only a person can resolve the item. */
  next: WorkStatusNext | null;
}

/** A proposal that is waiting for, or was sent back by, the human reviewer. */
export interface WorkStatusWaiting {
  proposalId: string;
  reason: string;
  state: Proposal['state'];
}

export interface WorkStatus {
  /** True when no outstanding item is a blocker. */
  ready: boolean;
  scope: 'session' | 'project';
  /** One or two sentences that can be shown or repeated as they are. */
  summary: string;
  outstanding: WorkStatusItem[];
  waitingOnHuman: WorkStatusWaiting[];
  /**
   * The agent sessions a session-scoped answer covers, oldest first. Present only on the answer
   * to a conversation continuation (its own `work_status`, and the digest on its check replies):
   * the sessions of the turns it continues, then its own.
   */
  sessionIds?: string[];
}

/* ------------------------------------------------------------------ */
/* project.coverage — requirement to evidence traceability              */
/* ------------------------------------------------------------------ */

export interface CoverageEvidence {
  artifactId: string;
  type: ArtifactType;
  title: string;
  relation: 'validates' | 'derived_from' | 'depends_on';
  state: 'current' | 'stale' | 'draft' | 'no_result';
  /** Recorded evidence kind, when the evidence carries one. */
  evidenceKind: EvidenceKind | null;
  /** Recorded result formatted with its unit, e.g. "0.412 kg"; null when none is recorded. */
  result: string | null;
  /** Taken only from a recorded test result. Never inferred by comparing numbers. */
  verdict: 'pass' | 'fail' | 'unknown';
}

export interface CoverageRequirement {
  artifactId: string;
  title: string;
  statement: string;
  /** Null when the requirement states no quantitative target. */
  target: MaybeQuantity | null;
  priority: 'must' | 'should' | 'could';
  review: 'approved' | 'draft' | 'in_review';
  /**
   * `covered`: current evidence exists and none of the rest is stale, draft
   * or without a result. `partial`: current evidence exists beside evidence
   * that is. `stale`: evidence exists but none is current. `none`: nothing
   * is linked.
   */
  coverage: 'covered' | 'partial' | 'stale' | 'none';
  reason: string;
  evidence: CoverageEvidence[];
}

export interface CoverageReport {
  requirements: CoverageRequirement[];
  totals: { requirements: number; covered: number; partial: number; stale: number; none: number };
}
