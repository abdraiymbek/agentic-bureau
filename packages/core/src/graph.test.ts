import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Artifact, ErrorCodes, RecordedInput, Revision, newId } from '@omenflow/contracts';
import { CoreApp, nullHost } from './index.js';
import { dispatch } from './dispatch.js';
import { ProjectContext } from './context.js';
import {
  evaluateInputs,
  impactReport,
  listEdges,
  propagateFrom,
  validateSelectedRevisions,
} from './graph.js';

const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-graph-regression-'));
  roots.push(root);
  const app = new CoreApp(path.join(root, 'app'), nullHost);
  apps.push(app);
  const result = (await app.dispatch(
    'project.create',
    { name: 'Graph', path: path.join(root, 'project') },
    { kind: 'user' },
  )) as { projectId: string };
  return app.contextFor(result.projectId);
}
function call(ctx: ProjectContext, op: string, payload: unknown) {
  return dispatch(ctx, { op, payload, origin: { kind: 'user' } });
}
type Part = { artifact: Artifact; revision: Revision };
async function note(
  ctx: ProjectContext,
  title: string,
  inputs: RecordedInput[] = [],
): Promise<Part> {
  const result = (await call(ctx, 'artifact.create_draft', {
    type: 'note',
    title,
    payload: { markdown: title },
    inputs,
    files: [],
    rationale: 'fixture',
  })) as Part;
  await call(ctx, 'artifact.accept_draft', {
    artifactId: result.artifact.id,
    draftRevisionId: result.revision.id,
    rationale: 'fixture',
  });
  return result;
}
const input = (part: Part): RecordedInput => ({
  artifactId: part.artifact.id,
  revisionId: part.revision.id,
  relationship: 'depends_on',
});
async function edit(ctx: ProjectContext, part: Part): Promise<Part> {
  return (await call(ctx, 'artifact.apply_edit', {
    artifactId: part.artifact.id,
    baseRevisionId: part.revision.id,
    payload: { markdown: 'changed' },
    rationale: 'new inputs',
  })) as Part;
}

/** Seed only immutable baseline records; no derived edges are necessary. */
function chain(ctx: ProjectContext, count: number): Part[] {
  const parts: Part[] = [];
  const createdAt = new Date().toISOString();
  ctx.repo.tx(() => {
    for (let i = 0; i < count; i++) {
      const artifact: Artifact = {
        id: newId(),
        title: `Node ${i}`,
        type: 'note',
        subsystem: null,
        selectedRevisionId: null,
        archived: false,
        createdAt,
      };
      const revision: Revision = {
        id: newId(),
        artifactId: artifact.id,
        parentId: null,
        seq: 1,
        origin: 'user',
        originDetail: null,
        createdAt,
        payload: { markdown: 'fixture' },
        contentHash: 'fixture',
        files: [],
        inputs: i ? [input(parts[i - 1]!)] : [],
        rationale: 'fixture',
        reviewState: 'approved',
      };
      artifact.selectedRevisionId = revision.id;
      ctx.repo.insertArtifact(artifact);
      ctx.repo.insertRevision(revision);
      parts.push({ artifact, revision });
    }
  });
  return parts;
}

describe('revision-derived dependency correctness', () => {
  it('propagates a changed input transitively with its complete explanation path', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const b = await note(ctx, 'B', [input(a)]);
    const c = await note(ctx, 'C', [input(b)]);
    await edit(ctx, a);
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('stale');
    expect(ctx.freshnessOf(c.artifact.id).freshness).toBe('stale');
    expect(ctx.freshnessOf(c.artifact.id).reasons[0]?.path).toEqual([
      a.artifact.id,
      b.artifact.id,
      c.artifact.id,
    ]);
    expect(evaluateInputs(ctx, c.artifact.id)).toMatchObject([
      { upstreamArtifactId: a.artifact.id, reason: 'input_changed' },
    ]);
  });

  it('revert retains obsolete input findings; archive/unarchive reaches downstream baselines', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const b = await note(ctx, 'B', [input(a)]);
    const c = await note(ctx, 'C', [input(b)]);
    await call(ctx, 'artifact.archive', { artifactId: a.artifact.id, archived: true });
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('missing_input');
    expect(ctx.freshnessOf(c.artifact.id).freshness).toBe('missing_input');
    await call(ctx, 'artifact.archive', { artifactId: a.artifact.id, archived: false });
    expect(ctx.freshnessOf(c.artifact.id).freshness).toBe('current');
    await edit(ctx, a);
    await call(ctx, 'artifact.revert', {
      artifactId: b.artifact.id,
      toRevisionId: b.revision.id,
      rationale: 'historical content',
    });
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('stale');
    expect(ctx.freshnessOf(c.artifact.id).freshness).toBe('stale');
  });

  it('draft input changes never replace baseline edges and promotion removes old dependencies', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const x = await note(ctx, 'X');
    const b = await note(ctx, 'B', [input(a)]);
    const baselineEdges = listEdges(ctx);
    const candidate = (await call(ctx, 'artifact.update_draft', {
      artifactId: b.artifact.id,
      baseRevisionId: b.revision.id,
      inputs: [input(x)],
      rationale: 'switch source',
    })) as Part;
    expect(listEdges(ctx)).toEqual(baselineEdges);
    expect(ctx.repo.edgesTo(b.artifact.id).map((e) => e.upstreamArtifactId)).toEqual([
      a.artifact.id,
    ]);
    await call(ctx, 'artifact.accept_draft', {
      artifactId: b.artifact.id,
      draftRevisionId: candidate.revision.id,
      rationale: 'switch approved',
    });
    expect(
      listEdges(ctx)
        .filter((e) => e.downstreamArtifactId === b.artifact.id)
        .map((e) => e.upstreamArtifactId),
    ).toEqual([x.artifact.id]);
    await edit(ctx, a);
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('current');
    await edit(ctx, x);
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('stale');
  });

  it('ignores draft-polluted compatibility rows from older project versions', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const b = await note(ctx, 'B');
    ctx.repo.insertEdge({
      id: newId(),
      upstreamArtifactId: a.artifact.id,
      downstreamArtifactId: b.artifact.id,
      relationship: 'depends_on',
      requiredUpstreamRevisionId: a.revision.id,
      label: 'old draft residue',
      createdBy: 'agent',
      createdAt: new Date().toISOString(),
    });
    expect(impactReport(ctx, [input(a)]).affected).toEqual([]);
    expect(listEdges(ctx)).toEqual([]);
  });

  it('rejects wrong-artifact/missing input revisions without leaving an artifact or draft', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const b = await note(ctx, 'B');
    const artifactsBefore = ctx.repo.listArtifacts().length;
    for (const revisionId of [b.revision.id, newId()]) {
      await expect(
        call(ctx, 'artifact.create_draft', {
          type: 'note',
          title: 'Invalid input',
          payload: { markdown: '' },
          files: [],
          inputs: [{ ...input(a), revisionId }],
          rationale: 'invalid',
        }),
      ).rejects.toBeTruthy();
      expect(ctx.repo.listArtifacts()).toHaveLength(artifactsBefore);
      await expect(
        call(ctx, 'artifact.update_draft', {
          artifactId: b.artifact.id,
          inputs: [{ ...input(a), revisionId }],
          rationale: 'invalid',
        }),
      ).rejects.toBeTruthy();
      expect(ctx.repo.listRevisions(b.artifact.id)).toHaveLength(1);
    }
  });

  it('rejects cycles through revision input writes and rechecks combined proposal selections', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const b = await note(ctx, 'B', [input(a)]);
    const c = await note(ctx, 'C', [input(b)]);
    await expect(
      call(ctx, 'artifact.update_draft', {
        artifactId: a.artifact.id,
        inputs: [input(c)],
        rationale: 'cycle',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CYCLE_DETECTED });
    const x = await note(ctx, 'X');
    const y = await note(ctx, 'Y');
    const cx = (await call(ctx, 'artifact.update_draft', {
      artifactId: x.artifact.id,
      inputs: [input(y)],
      rationale: 'candidate x',
    })) as Part;
    const cy = (await call(ctx, 'artifact.update_draft', {
      artifactId: y.artifact.id,
      inputs: [input(x)],
      rationale: 'candidate y',
    })) as Part;
    expect(() => validateSelectedRevisions(ctx, [cx.revision, cy.revision])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CYCLE_DETECTED }),
    );
    await expect(
      call(ctx, 'proposal.submit', {
        changes: [cx, cy].map((p) => ({
          artifactId: p.artifact.id,
          newRevisionId: p.revision.id,
          baseRevisionId: p.revision.parentId,
          kind: 'baseline_update',
        })),
        reason: 'combined cycle',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CYCLE_DETECTED });
    const proposal = (await call(ctx, 'proposal.submit', {
      changes: [
        {
          artifactId: cy.artifact.id,
          newRevisionId: cy.revision.id,
          baseRevisionId: y.revision.id,
          kind: 'baseline_update',
        },
      ],
      reason: 'candidate y before x is approved',
    })) as { id: string };
    await call(ctx, 'artifact.accept_draft', {
      artifactId: cx.artifact.id,
      draftRevisionId: cx.revision.id,
      rationale: 'approve x',
    });
    await expect(
      call(ctx, 'proposal.approve', { proposalId: proposal.id, rationale: 'invalid' }),
    ).rejects.toMatchObject({ code: ErrorCodes.CYCLE_DETECTED });
    expect(ctx.requireArtifact(x.artifact.id).selectedRevisionId).toBe(cx.revision.id);
    expect(ctx.requireArtifact(y.artifact.id).selectedRevisionId).toBe(y.revision.id);
  });

  it('traverses beyond 64 nodes without stored edges and repairs transitive freshness', async () => {
    const ctx = await setup();
    const parts = chain(ctx, 100);
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    expect(impactReport(ctx, [input(first)]).affected).toHaveLength(99);
    ctx.repo.setArchived(first.artifact.id, true);
    const affected = propagateFrom(ctx, [first.artifact.id], 1);
    expect(affected).toHaveLength(99);
    expect(ctx.repo.allStale()).toHaveLength(99);
    expect(ctx.freshnessOf(last.artifact.id).reasons[0]?.path).toHaveLength(100);
    ctx.repo.setArchived(first.artifact.id, false);
    propagateFrom(ctx, [first.artifact.id], 2);
    expect(ctx.repo.allStale()).toHaveLength(0);
  });

  it('does not let matching duplicate inputs hide an obsolete revision', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const changed = await edit(ctx, a);
    const b = await note(ctx, 'B', [input(changed), input(a)]);
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('stale');
  });

  it('returns every affected node while disclosing bounded diagnostic paths on large chains', async () => {
    const ctx = await setup();
    const parts = chain(ctx, 2000);
    const report = impactReport(ctx, [input(parts[0]!)]);
    expect(report.affected).toHaveLength(1999);
    const last = report.affected.at(-1)!;
    expect(last.path).toHaveLength(32);
    expect(last.pathTruncated).toBe(true);
    expect(last.fullPathLength).toBe(2000);
    expect(last.path[0]).toBe(parts[0]!.artifact.id);
    expect(last.path.at(-1)).toBe(parts.at(-1)!.artifact.id);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(8 * 1024 * 1024);
  });

  it('pages impact results without dropping the total count', async () => {
    const ctx = await setup();
    const parts = chain(ctx, 12);
    const page = (await call(ctx, 'graph.impact', {
      refs: [input(parts[0]!)],
      limit: 3,
      offset: 0,
    })) as {
      affected: { artifactId: string }[];
      totalAffected: number;
      hasMore: boolean;
    };
    expect(page.affected).toHaveLength(3);
    expect(page.totalAffected).toBe(11);
    expect(page.hasMore).toBe(true);
    const rest = (await call(ctx, 'graph.impact', {
      refs: [input(parts[0]!)],
      limit: 20,
      offset: 3,
    })) as { affected: unknown[]; hasMore: boolean };
    expect(rest.affected).toHaveLength(8);
    expect(rest.hasMore).toBe(false);
  });

  it('does not propagate informational connects_to, belongs_to or alternative_to links', async () => {
    const ctx = await setup();
    const a = await note(ctx, 'A');
    const info = await note(ctx, 'Information', [{ ...input(a), relationship: 'belongs_to' }]);
    const b = await note(ctx, 'B', [input(info)]);
    await edit(ctx, a);
    expect(ctx.freshnessOf(info.artifact.id).freshness).toBe('current');
    expect(impactReport(ctx, [input(a)]).affected).toEqual([]);
    expect(ctx.freshnessOf(b.artifact.id).freshness).toBe('current');
  });
});
