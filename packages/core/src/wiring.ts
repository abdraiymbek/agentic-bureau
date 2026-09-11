import {
  ComponentPayload,
  ErrorCodes,
  Origin,
  StarkError,
  WiringConnection,
  WiringPayload,
  type Pin,
} from '@stark/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision } from './artifacts.js';
import type { WiringAnalyzer } from './tools.js';

function wiringTool(ctx: ProjectContext): WiringAnalyzer {
  const w = ctx.tools.wiring as WiringAnalyzer | undefined;
  if (!w) throw new StarkError(ErrorCodes.TOOL_MISSING, 'Wiring analyzer not registered');
  return w;
}

function resolveComponent(ctx: ProjectContext) {
  return (artifactId: string): Record<string, unknown> | undefined => {
    const a = ctx.repo.getArtifact(artifactId);
    const rev = a?.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : undefined;
    return rev?.payload as Record<string, unknown> | undefined;
  };
}

function wiringPayloadOf(
  ctx: ProjectContext,
  artifactId: string,
  revisionId?: string,
): WiringPayload {
  const a = ctx.requireArtifact(artifactId);
  if (a.type !== 'wiring') throw new StarkError(ErrorCodes.VALIDATION, 'Not a wiring artifact');
  const rev = revisionId
    ? ctx.requireRevision(revisionId)
    : a.selectedRevisionId
      ? ctx.repo.getRevision(a.selectedRevisionId)
      : ctx.repo.listRevisions(a.id).at(-1);
  if (!rev) throw new StarkError(ErrorCodes.VALIDATION, 'No wiring revision');
  return rev.payload as WiringPayload;
}

export function wiringValidate(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const payload = wiringPayloadOf(ctx, artifactId, revisionId);
  return wiringTool(ctx).validate(payload, resolveComponent(ctx));
}

export function wiringRender(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const payload = wiringPayloadOf(ctx, artifactId, revisionId);
  const resolveTitle = (id: string) => {
    const a = ctx.repo.getArtifact(id);
    return a ? { title: a.title } : undefined;
  };
  return wiringTool(ctx).render(payload, resolveTitle);
}

export function wiringSetPins(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    pins: Pin[];
    baseRevisionId?: string;
  },
  origin: Origin,
) {
  const a = ctx.requireArtifact(input.artifactId);
  if (a.type !== 'wiring') throw new StarkError(ErrorCodes.VALIDATION, 'Not a wiring artifact');
  const cur = input.baseRevisionId
    ? ctx.requireRevision(input.baseRevisionId)
    : a.selectedRevisionId
      ? ctx.repo.getRevision(a.selectedRevisionId)
      : ctx.repo.listRevisions(a.id).at(-1);
  if (!cur) throw new StarkError(ErrorCodes.VALIDATION, 'No wiring revision');
  const payload = cur.payload as WiringPayload;
  return commitRevision(ctx, {
    artifactId: a.id,
    parentId: cur.id,
    origin,
    payload: { ...payload, pins: input.pins },
    files: cur.files,
    inputs: cur.inputs,
    rationale: 'set pins',
    reviewState: 'draft',
  });
}

export function wiringSetConnections(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    connections: WiringConnection[];
    baseRevisionId?: string;
  },
  origin: Origin,
) {
  const a = ctx.requireArtifact(input.artifactId);
  if (a.type !== 'wiring') throw new StarkError(ErrorCodes.VALIDATION, 'Not a wiring artifact');
  const cur = input.baseRevisionId
    ? ctx.requireRevision(input.baseRevisionId)
    : a.selectedRevisionId
      ? ctx.repo.getRevision(a.selectedRevisionId)
      : ctx.repo.listRevisions(a.id).at(-1);
  if (!cur) throw new StarkError(ErrorCodes.VALIDATION, 'No wiring revision');
  const payload = cur.payload as WiringPayload;
  // Record dependencies on the connected component revisions.
  const inputs = [...(cur.inputs ?? [])];
  for (const c of input.connections) {
    for (const end of [c.from, c.to]) {
      if (
        !inputs.some(
          (i) =>
            i.artifactId === end.componentArtifactId && i.revisionId === end.componentRevisionId,
        )
      ) {
        inputs.push({
          artifactId: end.componentArtifactId,
          revisionId: end.componentRevisionId,
          relationship: 'depends_on',
          label: 'pinout source',
        });
      }
    }
  }
  void ({} as ComponentPayload);
  return commitRevision(ctx, {
    artifactId: a.id,
    parentId: cur.id,
    origin,
    payload: { ...payload, connections: input.connections },
    files: cur.files,
    inputs,
    rationale: 'set connections',
    reviewState: 'draft',
  });
}
