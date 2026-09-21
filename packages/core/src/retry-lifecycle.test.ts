import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from './app.js';
import { createDraft } from './artifacts.js';
import { createCadVerificationEvidence } from './cad-verification.js';
import { renderFingerprint } from './cad-input.js';
import type { MechanicalPayload } from '@omenflow/contracts';
import { newId, OmenflowError, ErrorCodes, type Origin } from '@omenflow/contracts';

const user: Origin = { kind: 'user' };
const agent: Origin = { kind: 'agent', sessionId: newId() };
const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-retry-lifecycle-'));
  roots.push(root);
  const app = new CoreApp(path.join(root, 'settings'));
  apps.push(app);
  const { projectId } = (await app.dispatch(
    'project.create',
    { name: 'Safety', path: path.join(root, 'project') },
    user,
  )) as { projectId: string };
  const ctx = app.contextFor(projectId);
  const call = (op: string, payload: unknown, key?: string) =>
    app.dispatch(op, payload, user, projectId, key);
  return { app, ctx, call, projectId };
}

describe('durable retry completion', () => {
  it.each([ErrorCodes.TOOL_MISSING, ErrorCodes.CANCELLED])(
    'replays known async %s across restart without reexecuting',
    async (code) => {
      const { app, ctx, projectId, call } = await fixture();
      let executions = 0;
      ctx.tools.calc = {
        templates: () => [],
        evaluate: async () => {
          executions++;
          throw new OmenflowError(code, 'recorded failure', { repair: 'inspect the request' });
        },
      };
      const payload = {
        expression: 'x',
        inputs: [{ name: 'x', quantity: { value: 1, unit: 'kg' }, literal: true }],
      };
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => call('calculation.run', payload, 'failure')),
      );
      expect(
        results.every((r) => r.status === 'rejected' && (r.reason as OmenflowError).code === code),
      ).toBe(true);
      expect(executions).toBe(1);
      await expect(call('calculation.run', payload, 'failure')).rejects.toMatchObject({
        code,
        message: 'recorded failure',
        repair: 'inspect the request',
      });
      expect(executions).toBe(1);
      const projectPath = ctx.root;
      app.closeProject(projectId);
      await app.dispatch('project.open', { path: projectPath }, user);
      await expect(call('calculation.run', payload, 'failure')).rejects.toMatchObject({
        code,
        message: 'recorded failure',
      });
      expect(app.contextFor(projectId).repo.listArtifacts()).toHaveLength(0);
    },
  );
});

describe('terminal lifecycle invariants', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'interrupted'] as const)(
    'does not treat a terminal %s job as active by default',
    async (state) => {
      const { ctx } = await fixture();
      const job = ctx.createJob({ kind: 'test', tool: 'fixture' });
      ctx.jobStatus(job.id, state);
      expect(() => ctx.assertJobActive(job.id)).toThrow();
      if (state !== 'failed')
        expect(() => ctx.assertJobActive(job.id, { allowFailed: true })).toThrow();
    },
  );
  it('continues cancelling other jobs and closes despite a broken worker cancellation hook', async () => {
    const { app, ctx, projectId } = await fixture();
    const first = ctx.createJob({ kind: 'test', tool: 'fixture' });
    const second = ctx.createJob({ kind: 'test', tool: 'fixture' });
    ctx.jobCancels.set(first.id, () => {
      throw new Error('worker failed to receive signal');
    });
    let secondCancelled = false;
    ctx.jobCancels.set(second.id, () => {
      secondCancelled = true;
    });
    expect(() => app.closeProject(projectId)).not.toThrow();
    expect(secondCancelled).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(ctx.handle.pdb.db.open).toBe(false);
  });
});

describe('replacement proposal supersession', () => {
  async function noteDraft(call: (op: string, payload: unknown) => Promise<unknown>, title: string) {
    return (await call('artifact.create_draft', {
      type: 'note',
      title,
      payload: { markdown: title },
    })) as { artifact: { id: string }; revision: { id: string } };
  }

  it('retires a changes-requested review when a covering replacement is submitted, not every open request', async () => {
    const { app, ctx, call, projectId } = await fixture();
    const plate = await noteDraft(call, 'Plate');
    await call('artifact.accept_draft', {
      artifactId: plate.artifact.id,
      draftRevisionId: plate.revision.id,
      rationale: 'baseline',
    });
    const holes = (await call('artifact.update_draft', {
      artifactId: plate.artifact.id,
      payload: { markdown: 'Ø6 holes' },
      rationale: 'enlarge holes',
    })) as { revision: { id: string } };
    const first = (await app.dispatch(
      'proposal.submit',
      {
        reason: 'Ø6 holes',
        changes: [
          {
            artifactId: plate.artifact.id,
            newRevisionId: holes.revision.id,
            baseRevisionId: plate.revision.id,
            kind: 'baseline_update',
          },
        ],
      },
      agent,
      projectId,
    )) as { id: string };
    await call('proposal.request_changes', {
      proposalId: first.id,
      rationale: 'Use Ø5.5 instead',
    });

    const other = await noteDraft(call, 'Unrelated note');
    const otherProposal = (await app.dispatch(
      'proposal.submit',
      {
        reason: 'unrelated',
        changes: [
          {
            artifactId: other.artifact.id,
            newRevisionId: other.revision.id,
            baseRevisionId: null,
            kind: 'new_artifact',
          },
        ],
      },
      agent,
      projectId,
    )) as { id: string };
    await call('proposal.request_changes', {
      proposalId: otherProposal.id,
      rationale: 'Need a clearer title',
    });

    const corrected = (await call('artifact.update_draft', {
      artifactId: plate.artifact.id,
      payload: { markdown: 'Ø5.5 holes' },
      rationale: 'requested Ø5.5',
    })) as { revision: { id: string } };
    const replacement = (await app.dispatch(
      'proposal.submit',
      {
        reason: 'Ø5.5 holes',
        changes: [
          {
            artifactId: plate.artifact.id,
            newRevisionId: corrected.revision.id,
            baseRevisionId: plate.revision.id,
            kind: 'baseline_update',
          },
        ],
      },
      agent,
      projectId,
    )) as { id: string; impact?: { supersedesProposalIds?: string[] } };

    expect(replacement.impact?.supersedesProposalIds).toEqual([first.id]);
    expect(ctx.repo.getProposal(first.id)?.state).toBe('superseded');
    expect(ctx.repo.getProposal(first.id)?.impact?.supersededByProposalId).toBe(replacement.id);
    expect(ctx.repo.getRevision(holes.revision.id)?.reviewState).toBe('superseded');
    expect(ctx.repo.getProposal(otherProposal.id)?.state).toBe('changes_requested');
    expect(ctx.repo.listProposals('changes_requested').map((p) => p.id)).toEqual([otherProposal.id]);

    await call('proposal.approve', {
      proposalId: replacement.id,
      rationale: 'Ø5.5 accepted',
    });
    expect(ctx.repo.getArtifact(plate.artifact.id)?.selectedRevisionId).toBe(corrected.revision.id);
    expect(ctx.repo.getProposal(first.id)?.state).toBe('superseded');
    expect(ctx.repo.getProposal(otherProposal.id)?.state).toBe('changes_requested');
  });
});

describe('proposal candidate validity', () => {
  it('cannot resurrect a rejected revision through another previously submitted proposal', async () => {
    const { app, ctx, projectId, call } = await fixture();
    const { artifact, revision } = (await app.dispatch(
      'artifact.create_draft',
      { type: 'note', title: 'Candidate', payload: { markdown: 'change' } },
      agent,
      projectId,
    )) as { artifact: { id: string }; revision: { id: string } };
    const payload = {
      reason: 'review',
      changes: [
        {
          artifactId: artifact.id,
          newRevisionId: revision.id,
          baseRevisionId: null,
          kind: 'new_artifact',
        },
      ],
    };
    const first = (await app.dispatch('proposal.submit', payload, agent, projectId)) as {
      id: string;
    };
    const second = (await app.dispatch('proposal.submit', payload, agent, projectId)) as {
      id: string;
    };
    await call('proposal.reject', { proposalId: first.id, rationale: 'reject candidate' });
    await expect(
      call('proposal.approve', { proposalId: second.id, rationale: 'stale review' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REVISION_CONFLICT });
    expect(ctx.repo.getArtifact(artifact.id)?.selectedRevisionId).toBeNull();
    expect(ctx.repo.getRevision(revision.id)?.reviewState).toBe('rejected');
    expect(ctx.repo.getProposal(second.id)?.state).toBe('pending');
  });
});

describe('exact verification scope approval', () => {
  it('rolls scope acceptance, promotion and events back together when the decision commit fails', async () => {
    const { ctx, call } = await fixture();
    const source = Buffer.from('cube(10);');
    const mesh = Buffer.from('synthetic transaction fixture mesh');
    const sourceHash = ctx.objects.put(source);
    const outputHash = ctx.objects.put(mesh);
    const identity = {
      version: 1 as const,
      sourceHash,
      params: {},
      modelUnit: 'mm',
      frame: 'right-handed-z-up' as const,
      engine: 'fixture',
      engineVersion: '1',
      options: 'fixture',
    };
    const renderIdentity = {
      ...identity,
      outputHash,
      inputFingerprint: renderFingerprint(identity),
    };
    const candidate = createDraft(
      ctx,
      {
        type: 'mechanical',
        title: 'Part',
        payload: {
          params: {},
          modelUnit: 'mm',
          renderIdentity,
          scad: { path: 'artifacts/mechanical/part.scad', sha256: sourceHash },
          stl: { path: 'artifacts/mechanical/part.stl', sha256: outputHash },
        },
        files: [
          { path: 'artifacts/mechanical/part.scad', contentBase64: source.toString('base64') },
          { path: 'artifacts/mechanical/part.stl', contentBase64: mesh.toString('base64') },
        ],
        inputs: [],
        rationale: 'transaction fixture',
      },
      user,
    );
    const expectSpec = { bbox: { min: [0, 0, 0], max: [10, 10, 10] } };
    const evidence = createCadVerificationEvidence(
      ctx,
      candidate.revision,
      (candidate.revision.payload as MechanicalPayload).renderIdentity!,
      expectSpec,
      [{ name: 'bounding box', pass: true, detail: 'transaction fixture' }],
      { pass: true, detail: 'transaction fixture; geometry tested separately' },
    );
    const hash = ctx.objects.putText(JSON.stringify(evidence));
    const job = ctx.createJob({
      kind: 'cad_check',
      tool: 'cad.check',
      inputs: {
        artifactId: candidate.artifact.id,
        revisionId: candidate.revision.id,
        expect: expectSpec,
      },
    });
    ctx.jobStatus(job.id, 'succeeded', { outputHashes: { verification: hash } });
    const proposal = (await call('proposal.submit', {
      reason: 'scope',
      changes: [
        {
          artifactId: candidate.artifact.id,
          newRevisionId: candidate.revision.id,
          baseRevisionId: null,
          kind: 'new_artifact',
        },
      ],
    })) as { id: string };
    const scopeKey = `cad.scope.accepted.${candidate.artifact.id}`;
    const published: string[] = [];
    ctx.listeners.add((event) => published.push(event.type));
    const fault = vi.spyOn(ctx.repo, 'insertDecision').mockImplementationOnce(() => {
      throw new Error('injected decision failure');
    });
    await expect(
      call('proposal.approve', {
        proposalId: proposal.id,
        rationale: 'approve exact scope',
        verificationEvidence: { [candidate.artifact.id]: hash },
      }),
    ).rejects.toThrow('injected decision failure');
    fault.mockRestore();
    expect(ctx.repo.meta(scopeKey)).toBeNull();
    expect(ctx.repo.getArtifact(candidate.artifact.id)?.selectedRevisionId).toBeNull();
    expect(ctx.repo.getRevision(candidate.revision.id)?.reviewState).toBe('proposed');
    expect(ctx.repo.getProposal(proposal.id)?.state).toBe('pending');
    expect(published).toEqual([]);
    await call('proposal.approve', {
      proposalId: proposal.id,
      rationale: 'approve exact scope',
      verificationEvidence: { [candidate.artifact.id]: hash },
    });
    expect(JSON.parse(ctx.repo.meta(scopeKey)!).evidenceHash).toBe(hash);
    expect(ctx.repo.getArtifact(candidate.artifact.id)?.selectedRevisionId).toBe(
      candidate.revision.id,
    );
    expect(published).toContain('cad.scope.accepted');
  });
});
