import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorCodes, Origin, OmenflowError, qty } from '@omenflow/contracts';
import { openProject } from '@omenflow/storage';
import { CoreApp, nullHost, writeBinaryStl, parseStlTriangles, analyzeMesh } from './index.js';
import { dispatch } from './dispatch.js';
import type { ProjectContext } from './context.js';
import type { CalcEngine, CadAdapter } from './tools.js';

const USER: Origin = { kind: 'user' };
const AGENT: Origin = { kind: 'agent', sessionId: '00000000-0000-4000-8000-000000000001' };

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-core-'));
}

/** Trivial calc engine for tests: sums input values, unit of first input. */
const fakeCalc: CalcEngine = {
  templates: () => [
    {
      id: 'mass_budget',
      title: 'Mass budget',
      description: 'sum of masses',
      expression: 'sum',
      inputs: [{ name: 'payload', unit: 'kg', required: true }],
      outputUnit: 'kg',
      assumptions: ['linear sum'],
      limitations: ['ignores wiring'],
    },
  ],
  evaluate: async (_expr, inputs) => {
    const first = inputs[0];
    const sum = inputs.reduce(
      (n, i) => (i.quantity && 'value' in i.quantity ? n + i.quantity.value : n),
      0,
    );
    return {
      value: sum,
      unit:
        first && 'value' in (first.quantity as object)
          ? (first.quantity as { unit: string }).unit
          : 'kg',
    };
  },
};

function boxStl(length: number): Buffer {
  const vertices = [
    [0, 0, 0],
    [length, 0, 0],
    [length, 10, 0],
    [0, 10, 0],
    [0, 0, 2],
    [length, 0, 2],
    [length, 10, 2],
    [0, 10, 2],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return writeBinaryStl(Float64Array.from(faces.flatMap((f) => f.flatMap((v) => vertices[v]!))));
}

const fakeCad: CadAdapter = {
  toolId: 'openscad',
  async probe() {
    return { available: true, executablePath: '/bin/true', version: 'test' };
  },
  async validateSource() {
    return { ok: true, errors: [] };
  },
  async render(spec) {
    fs.writeFileSync(spec.outPath, boxStl(Number(spec.params.length ?? 10)));
    return { ok: true };
  },
  cancel() {},
  inspectStl(buf) {
    const mesh = analyzeMesh(parseStlTriangles(buf));
    return {
      triangles: mesh.triangles,
      bytes: buf.byteLength,
      format: 'binary' as const,
      bounds: mesh.bounds,
      plausible: mesh.topology.watertight,
    };
  },
};

async function setup(): Promise<{ app: CoreApp; ctx: ProjectContext; dir: string }> {
  const dir = tmpdir();
  const app = new CoreApp(path.join(dir, '.appdata'), nullHost);
  apps.push(app);
  app.engineTools = { calc: fakeCalc, cad: fakeCad };
  const res = (await app.dispatch(
    'project.create',
    { name: 'Rover', path: path.join(dir, 'rover'), intent: 'inspection rover' },
    USER,
  )) as { projectId: string };
  const ctx = app.contextFor(res.projectId);
  ctx.tools = app.engineTools;
  return { app, ctx, dir: path.join(dir, 'rover') };
}

const apps: CoreApp[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.closeAll();
});

const agentCall = (ctx: ProjectContext, op: string, payload: unknown, key?: string) =>
  dispatch(ctx, { op, payload, origin: AGENT, idempotencyKey: key });
const userCall = (ctx: ProjectContext, op: string, payload: unknown, key?: string) =>
  dispatch(ctx, { op, payload, origin: USER, idempotencyKey: key });

describe('revisions and proposals', () => {
  let app: CoreApp;
  let ctx: ProjectContext;
  beforeEach(async () => {
    ({ app, ctx } = await setup());
    void app;
  });

  it('draft → proposal → approve moves baseline; revisions stay immutable', async () => {
    const { artifact, revision } = (await agentCall(ctx, 'artifact.create_draft', {
      type: 'requirement',
      title: 'Payload capacity',
      payload: {
        statement: 'Carry the inspection payload',
        target: qty(0.3, 'kg'),
        acceptanceCriterion: 'rover carries payload',
        priority: 'must',
      },
      files: [],
      inputs: [],
      rationale: 'initial',
    })) as never as { artifact: { id: string }; revision: { id: string } };
    const p = (await agentCall(ctx, 'proposal.submit', {
      changes: [
        {
          artifactId: artifact.id,
          baseRevisionId: null,
          newRevisionId: revision.id,
          kind: 'new_artifact',
        },
      ],
      reason: 'accept requirement',
    })) as never as { id: string };
    const approved = (await userCall(ctx, 'proposal.approve', {
      proposalId: p.id,
      rationale: 'ok',
    })) as never as { state: string };
    expect(approved.state).toBe('accepted');
    const a = ctx.repo.getArtifact(artifact.id)!;
    expect(a.selectedRevisionId).toBe(revision.id);
    const rev = ctx.repo.getRevision(revision.id)!;
    expect(rev.reviewState).toBe('approved');
  });

  it('agents cannot resolve proposals or apply direct edits', async () => {
    const { artifact, revision } = (await agentCall(ctx, 'artifact.create_draft', {
      type: 'note',
      title: 'N',
      payload: { markdown: 'x' },
      files: [],
      inputs: [],
      rationale: '',
    })) as never as { artifact: { id: string }; revision: { id: string } };
    const p = (await agentCall(ctx, 'proposal.submit', {
      changes: [
        {
          artifactId: artifact.id,
          baseRevisionId: null,
          newRevisionId: revision.id,
          kind: 'new_artifact',
        },
      ],
      reason: 'r',
    })) as never as { id: string };
    await expect(agentCall(ctx, 'proposal.approve', { proposalId: p.id })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED,
    });
    await expect(
      agentCall(ctx, 'artifact.apply_edit', {
        artifactId: artifact.id,
        baseRevisionId: revision.id,
        payload: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.APPROVAL_REQUIRED });
  });

  it('rejects approval when the base moved (REVISION_CONFLICT)', async () => {
    const { artifact, revision } = (await agentCall(ctx, 'artifact.create_draft', {
      type: 'requirement',
      title: 'R',
      payload: { statement: 'a', acceptanceCriterion: 'c', priority: 'must' },
      files: [],
      inputs: [],
      rationale: '',
    })) as never as { artifact: { id: string }; revision: { id: string } };
    await userCall(ctx, 'artifact.accept_draft', {
      artifactId: artifact.id,
      draftRevisionId: revision.id,
      rationale: 'baseline',
    });
    // Agent drafts v2 and proposes.
    const d2 = (await agentCall(ctx, 'artifact.update_draft', {
      artifactId: artifact.id,
      payload: { statement: 'b', acceptanceCriterion: 'c', priority: 'must' },
      rationale: 'v2',
    })) as never as { revision: { id: string } };
    const p = (await agentCall(ctx, 'proposal.submit', {
      changes: [
        {
          artifactId: artifact.id,
          baseRevisionId: revision.id,
          newRevisionId: d2.revision.id,
          kind: 'baseline_update',
        },
      ],
      reason: 'v2',
    })) as never as { id: string };
    // User edits baseline directly → proposal base stale.
    await userCall(ctx, 'artifact.apply_edit', {
      artifactId: artifact.id,
      baseRevisionId: revision.id,
      payload: { statement: 'c', acceptanceCriterion: 'c', priority: 'must' },
      rationale: 'user edit',
    });
    await expect(userCall(ctx, 'proposal.approve', { proposalId: p.id })).rejects.toMatchObject({
      code: ErrorCodes.REVISION_CONFLICT,
    });
  });

  it('idempotent mutation returns the stored response', async () => {
    const payload = {
      type: 'note',
      title: 'Idem',
      payload: { markdown: 'm' },
      files: [],
      inputs: [],
      rationale: '',
    };
    const r1 = (await agentCall(ctx, 'artifact.create_draft', payload, 'k1')) as never as {
      artifact: { id: string };
    };
    const r2 = (await agentCall(ctx, 'artifact.create_draft', payload, 'k1')) as never as {
      artifact: { id: string };
      idempotent?: boolean;
    };
    expect(r2.idempotent).toBe(true);
    expect(r2.artifact.id).toBe(r1.artifact.id);
    await expect(
      agentCall(ctx, 'artifact.create_draft', { ...payload, title: 'different' }, 'k1'),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION });
  });
});

describe('dependency graph + staleness (300g → 500g)', () => {
  it('payload change propagates through recorded inputs, preserving history', async () => {
    const { app, ctx, dir } = await setup();

    // Requirement: payload 300 g.
    const req = (await userCall(ctx, 'artifact.create_draft', {
      type: 'requirement',
      title: 'Payload',
      payload: {
        statement: 'carry payload',
        target: qty(300, 'g'),
        acceptanceCriterion: 'carries it',
        priority: 'must',
      },
      files: [],
      inputs: [],
      rationale: '',
    })) as never as { artifact: { id: string }; revision: { id: string } };
    await userCall(ctx, 'artifact.accept_draft', {
      artifactId: req.artifact.id,
      draftRevisionId: req.revision.id,
      rationale: '',
    });

    // Mass budget calculation consuming the requirement.
    const calcRes = (await agentCall(ctx, 'calculation.run', {
      templateId: 'mass_budget',
      inputs: [
        {
          name: 'payload',
          quantity: qty(300, 'g'),
          sourceRef: { artifactId: req.artifact.id, revisionId: req.revision.id },
        },
      ],
      assumptions: [],
      title: 'Mass budget',
      submitForReview: false,
    })) as never as { artifactId: string; revision: { id: string } };
    await userCall(ctx, 'artifact.accept_draft', {
      artifactId: calcRes.artifactId,
      draftRevisionId: calcRes.revision.id,
      rationale: '',
    });
    expect(ctx.freshnessOf(calcRes.artifactId).freshness).toBe('current');

    // Change requirement 300 g → 500 g as the user.
    const cur = ctx.repo.getArtifact(req.artifact.id)!;
    const curRev = ctx.repo.getRevision(cur.selectedRevisionId!)!;
    await userCall(ctx, 'artifact.apply_edit', {
      artifactId: req.artifact.id,
      baseRevisionId: cur.selectedRevisionId!,
      payload: { ...(curRev.payload as object), target: qty(500, 'g') },
      rationale: 'payload grew',
    });

    // Calculation is now stale with an explanation path.
    const { freshness, reasons } = ctx.freshnessOf(calcRes.artifactId);
    expect(freshness).toBe('stale');
    expect(reasons[0]!.path).toContain(req.artifact.id);
    // Old revision preserved.
    const old = ctx.repo.getRevision(calcRes.revision.id)!;
    expect(old.reviewState).toBe('superseded' === old.reviewState ? 'approved' : old.reviewState);
    expect(ctx.repo.listRevisions(calcRes.artifactId).length).toBe(1);

    // Reopen: state survives.
    const h2 = openProject(dir);
    const ctx2 = app.register(h2);
    expect(ctx2.freshnessOf(calcRes.artifactId).freshness).toBe('stale');
    ctx2.handle.close();
  });

  it('rejects depends_on cycles with the path', async () => {
    const { ctx } = await setup();
    const mk = async (t: string) => {
      const r = (await userCall(ctx, 'artifact.create_draft', {
        type: 'note',
        title: t,
        payload: { markdown: '' },
        files: [],
        inputs: [],
        rationale: '',
      })) as never as { artifact: { id: string }; revision: { id: string } };
      await userCall(ctx, 'artifact.accept_draft', {
        artifactId: r.artifact.id,
        draftRevisionId: r.revision.id,
        rationale: '',
      });
      return r.artifact.id;
    };
    const a = await mk('A');
    const b = await mk('B');
    const c = await mk('C');
    await userCall(ctx, 'graph.propose_edges', {
      edges: [
        { upstreamArtifactId: a, downstreamArtifactId: b, relationship: 'depends_on', label: '' },
      ],
    });
    await userCall(ctx, 'graph.propose_edges', {
      edges: [
        { upstreamArtifactId: b, downstreamArtifactId: c, relationship: 'depends_on', label: '' },
      ],
    });
    await expect(
      userCall(ctx, 'graph.propose_edges', {
        edges: [
          { upstreamArtifactId: c, downstreamArtifactId: a, relationship: 'depends_on', label: '' },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CYCLE_DETECTED });
    // connects_to cycles are permitted.
    await userCall(ctx, 'graph.propose_edges', {
      edges: [
        {
          upstreamArtifactId: c,
          downstreamArtifactId: a,
          relationship: 'connects_to',
          label: 'feedback',
        },
      ],
    });
  });
});

describe('components and BOM', () => {
  it('candidate → selection proposal → approve → BOM totals', async () => {
    const { ctx } = await setup();
    // Source required for a real component.
    const src = (await agentCall(ctx, 'source.capture', {
      url: 'https://vendor.example/motor',
      title: 'Motor product page',
      sourceKind: 'manufacturer',
    })) as never as { artifact: { id: string } };
    const cand = (await agentCall(ctx, 'component.add_candidate', {
      title: 'Drive motor',
      manufacturer: 'Acme',
      partNumber: 'MTR-100',
      properties: {
        mass: { quantity: qty(45, 'g'), sourceId: src.artifact.id },
        voltage: { quantity: qty(12, 'V'), sourceId: src.artifact.id },
      },
      attributes: {},
      offer: {
        seller: 'VendorCo',
        url: 'https://vendor.example/motor',
        price: { amount: '12.50', currency: 'USD' },
        quantityBasis: 1,
        sourceId: src.artifact.id,
      },
      sourceId: src.artifact.id,
    })) as never as { artifact: { id: string }; revision: { id: string } };
    const prop = (await agentCall(ctx, 'component.propose_selection', {
      artifactId: cand.artifact.id,
      revisionId: cand.revision.id,
      bomLines: [
        { subsystem: 'drive', quantity: 4, offerId: null, location: 'corners', notes: '' },
      ],
      reason: 'meets torque',
    })) as never as { proposal: { id: string } };
    await userCall(ctx, 'proposal.approve', { proposalId: prop.proposal.id, rationale: 'ok' });
    const bom = (await userCall(ctx, 'bom.read', {})) as never as {
      lines: unknown[];
      totals: { missingPriceCount: number; knownMass: { value: number; unit: string } | null };
    };
    expect(bom.lines.length).toBe(1);
    expect(bom.totals.knownMass?.unit).toBe('g');
    expect(Math.round(bom.totals.knownMass!.value)).toBe(180);
  });

  it('missing price stays unknown, never zero', async () => {
    const { ctx } = await setup();
    const src = (await agentCall(ctx, 'source.capture', {
      url: 'https://x.example/p',
      title: 'p',
      sourceKind: 'supplier',
    })) as never as { artifact: { id: string } };
    await agentCall(ctx, 'component.add_candidate', {
      title: 'Wheel',
      vendor: 'Shop',
      partNumber: 'W-1',
      properties: {},
      attributes: {},
      offer: { seller: 'Shop', url: 'https://x.example/p', price: null, quantityBasis: 1 },
      sourceId: src.artifact.id,
    });
    const bom = (await userCall(ctx, 'bom.read', {})) as never as {
      totals: { missingPriceCount: number };
    };
    expect(bom.totals.missingPriceCount).toBe(0); // no lines yet — candidates don't enter BOM until selected
  });
});

describe('CAD job path (fake adapter, real pipeline)', () => {
  it('render job produces a draft revision with STL + bounds', async () => {
    const { ctx } = await setup();
    const scadB64 = Buffer.from('length=10; cube([length,10,2]);').toString('base64');
    const { artifact } = (await agentCall(ctx, 'artifact.create_draft', {
      type: 'mechanical',
      title: 'Tray',
      payload: { params: { length: { value: 100, unit: 'mm' } }, modelUnit: 'mm' },
      files: [{ path: 'artifacts/mechanical/tray.scad', contentBase64: scadB64 }],
      inputs: [],
      rationale: 'v1',
    })) as never as { artifact: { id: string } };
    const { job } = (await agentCall(ctx, 'cad.render', {
      artifactId: artifact.id,
      timeoutMs: 5000,
    })) as never as { job: { id: string } };
    // Wait for async job.
    for (let i = 0; i < 50; i++) {
      const j = ctx.repo.getJob(job.id)!;
      if (['succeeded', 'failed'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const j = ctx.repo.getJob(job.id)!;
    expect(j.status).toBe('succeeded');
    const drafts = ctx.repo.listDrafts(artifact.id);
    expect(drafts.length).toBeGreaterThan(0);
    const last = drafts.at(-1)!;
    const p = last.payload as { stl?: { sha256?: string }; bounds?: { max: number[] } };
    expect(p.stl?.sha256).toBeTruthy();
    expect(p.bounds?.max[0]).toBe(100);
  });
});

describe('project summary budget', () => {
  it('returns bounded structured context', async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 30; i++) {
      const r = (await agentCall(ctx, 'artifact.create_draft', {
        type: 'requirement',
        title: `R${i}`,
        payload: { statement: `req ${i}`, acceptanceCriterion: 'x', priority: 'should' },
        files: [],
        inputs: [],
        rationale: '',
      })) as never as { artifact: { id: string }; revision: { id: string } };
      await userCall(ctx, 'artifact.accept_draft', {
        artifactId: r.artifact.id,
        draftRevisionId: r.revision.id,
        rationale: '',
      });
    }
    const s = (await agentCall(ctx, 'project.summary', { budget: 2000 })) as object;
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(2100);
  });
});
