/** Diagnostic probes for OMEN_V0.1_MASTER_PLAN.md. Only writes disposable temp data.
 * Run: pnpm exec tsx audit/pre-release/reproduce.ts
 * These record observed behavior; they are NOT assertions that bugs should remain.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { unzipSync, strFromU8 } from 'fflate';
import { CoreApp, nullHost } from '../../packages/core/src/index.js';
import { createEngineTools } from '../../packages/engineering/src/index.js';
import { OPS, newId } from '../../packages/contracts/src/index.js';
import { BridgeServer } from '../../packages/agent-host/src/bridge/server.js';
import { FrameDecoder, encodeFrame } from '../../packages/agent-host/src/bridge/framing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-audit-probes-'));
const results: Record<string, unknown> = {
  root,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
const user = { kind: 'user' } as const;
const agent = { kind: 'agent', sessionId: newId() } as const;
type Call = (op: string, payload?: any, origin?: any, idem?: string) => Promise<any>;
async function probe(name: string, fn: (app: CoreApp, call: Call, ctx: any) => Promise<unknown>) {
  const app = new CoreApp(path.join(root, name, 'settings'), nullHost);
  app.engineTools = createEngineTools();
  const p = (await app.dispatch(
    'project.create',
    { name, path: path.join(root, name, 'project'), intent: 'Disposable audit' },
    user,
  )) as any;
  const call: Call = (op, payload = {}, origin = user, idem) =>
    app.dispatch(op, payload, origin, p.projectId, idem);
  const start = performance.now();
  try {
    results[name] = {
      result: await fn(app, call, app.contextFor(p.projectId)),
      ms: Math.round(performance.now() - start),
    };
  } catch (e) {
    results[name] = { error: String(e), stack: (e as Error).stack };
  } finally {
    app.closeAll();
  }
  console.log(name, JSON.stringify(results[name]));
}
const note = (call: Call, title: string, inputs: any[] = []) =>
  call(
    'artifact.create_draft',
    { type: 'note', title, payload: { markdown: title }, inputs },
    agent,
  );
const accept = (call: Call, r: any) =>
  call('artifact.accept_draft', {
    artifactId: r.artifact?.id ?? r.artifactId,
    draftRevisionId: r.revision?.id ?? r.revisionId,
    rationale: 'audit baseline',
  });

async function main() {
  results.toolSurface = {
    all: OPS.length,
    offeredToAgent: OPS.filter((o) => o.capability === 'both' && o.agentVisible).length,
    schemaChars: JSON.stringify(
      OPS.filter((o) => o.capability === 'both' && o.agentVisible).map((o) => ({
        name: o.name,
        description: o.description,
      })),
    ).length,
  };
  await probe('source-mesh-divergence', async (_app, call, ctx) => {
    const first = await call('cad.write_source', { title: 'Cube', source: 'cube([10,10,10]);' });
    await accept(call, first);
    const edit = await call('artifact.apply_edit', {
      artifactId: first.artifactId,
      baseRevisionId: first.revisionId,
      fileWrites: [
        {
          path: first.sourcePath,
          contentBase64: Buffer.from('cube([20,10,10]);').toString('base64'),
        },
      ],
      rationale: 'GUI source edit',
    });
    const file = await call('artifact.read_file', {
      artifactId: first.artifactId,
      path: first.sourcePath,
    });
    const source = await call('cad.read_source', { artifactId: first.artifactId });
    const inspected = await call('cad.inspect', { artifactId: first.artifactId });
    const checked = await call('cad.check', {
      artifactId: first.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    });
    const preview = await call('build.preview');
    return {
      fileSource: Buffer.from(file.contentBase64, 'base64').toString(),
      cadSource: source.source,
      geometry: inspected.geometry,
      oldGeometryCheckPass: checked.pass,
      freshness: ctx.freshnessOf(first.artifactId),
      build: preview.counts,
      payloadScad: edit.revision.payload.scad.sha256,
      fileScad: edit.revision.files.find((f: any) => f.path.endsWith('.scad')).sha256,
    };
  });
  await probe('parameter-override-and-compose', async (_app, call, ctx) => {
    const first = await call('cad.write_source', {
      title: 'Param cube',
      source: 'width=10; cube([width,10,10]);',
      params: { width: 20 },
    });
    const set = await call('cad.set_param', {
      artifactId: first.artifactId,
      name: 'width',
      value: 30,
    });
    const read = await call('cad.read_source', { artifactId: first.artifactId });
    const composed = await call('cad.compose', {
      title: 'Instance',
      instances: [{ artifactId: first.artifactId }],
    });
    return {
      initialSize: first.geometry.bounds.size,
      setSize: set.geometry.bounds.size,
      source: read.source,
      recordedParams: read.recordedParams,
      composedSize: composed.geometry.bounds.size,
      composedInputs: ctx.repo.getRevision(composed.revisionId).inputs,
      edges: ctx.repo.allEdges().length,
    };
  });
  await probe('weak-checks', async (_app, call) => {
    const r = await call('cad.write_source', { title: 'Wrong size', source: 'cube(10);' });
    const failed = await call('cad.check', {
      artifactId: r.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [20, 20, 20] } },
    });
    const dropped = await call('cad.check', { artifactId: r.artifactId, expect: {} });
    const rewrite = await call('cad.write_source', {
      artifactId: r.artifactId,
      source: 'cube(10); // unchanged geometry',
    });
    const forgotten = await call('cad.check', { artifactId: r.artifactId, expect: {} });
    await accept(call, rewrite);
    return {
      failed: failed.pass,
      dropped: {
        pass: dropped.pass,
        total: dropped.total,
        warning: dropped.droppedFailingAssertions,
      },
      afterRevision: { pass: forgotten.pass, warning: forgotten.droppedFailingAssertions },
      build: (await call('build.preview')).counts,
    };
  });
  await probe('graph-freshness-and-cycles', async (_app, call, ctx) => {
    const a = await note(call, 'A');
    await accept(call, a);
    const b = await note(call, 'B', [{ artifactId: a.artifact.id, revisionId: a.revision.id }]);
    await accept(call, b);
    const c = await note(call, 'C', [{ artifactId: b.artifact.id, revisionId: b.revision.id }]);
    await accept(call, c);
    await call('artifact.apply_edit', {
      artifactId: a.artifact.id,
      baseRevisionId: a.revision.id,
      payload: { markdown: 'A changed' },
      rationale: 'change upstream',
    });
    const afterChange = {
      b: ctx.freshnessOf(b.artifact.id).freshness,
      c: ctx.freshnessOf(c.artifact.id).freshness,
    };
    await call('artifact.revert', {
      artifactId: b.artifact.id,
      toRevisionId: b.revision.id,
      rationale: 'revert stale B',
    });
    const afterRevert = ctx.freshnessOf(b.artifact.id).freshness;
    await call(
      'artifact.update_draft',
      {
        artifactId: a.artifact.id,
        inputs: [{ artifactId: c.artifact.id, revisionId: c.revision.id }],
      },
      agent,
    );
    const cycleEdges = ctx.repo
      .allEdges()
      .map((e: any) => [e.upstreamArtifactId, e.downstreamArtifactId]);
    await call('artifact.archive', { artifactId: a.artifact.id, archived: true });
    return {
      afterChange,
      afterRevert,
      cycleAccepted: cycleEdges.length === 3,
      afterArchiveB: ctx.freshnessOf(b.artifact.id).freshness,
    };
  });
  await probe('proposal-conflict-bypass', async (_app, call, ctx) => {
    const a = await note(call, 'A');
    await accept(call, a);
    const b = await call(
      'artifact.update_draft',
      { artifactId: a.artifact.id, payload: { markdown: 'agent draft' } },
      agent,
    );
    const p = await call(
      'proposal.submit',
      {
        changes: [
          {
            artifactId: a.artifact.id,
            baseRevisionId: null,
            newRevisionId: b.revision.id,
            kind: 'new_artifact',
          },
        ],
        reason: 'bad kind bypass',
      },
      agent,
    );
    const u = await call('artifact.apply_edit', {
      artifactId: a.artifact.id,
      baseRevisionId: a.revision.id,
      payload: { markdown: 'new user baseline' },
      rationale: 'mid-flight edit',
    });
    await call('proposal.approve', { proposalId: p.id, rationale: 'approve stale proposal' });
    return {
      acceptedOverNewerBaseline:
        ctx.repo.getArtifact(a.artifact.id).selectedRevisionId === b.revision.id,
      userRevision: u.revision.id,
    };
  });
  await probe('partial-mutation', async (_app, call, ctx) => {
    let error = '';
    try {
      await call(
        'artifact.create_draft',
        { type: 'requirement', title: 'Invalid requirement', payload: {} },
        agent,
      );
    } catch (e) {
      error = String(e);
    }
    const orphan = ctx.repo
      .listArtifacts()
      .filter((a: any) => ctx.repo.listRevisions(a.id).length === 0).length;
    const a = await note(call, 'valid');
    try {
      await call(
        'proposal.submit',
        {
          changes: [
            {
              artifactId: a.artifact.id,
              baseRevisionId: null,
              newRevisionId: a.revision.id,
              kind: 'new_artifact',
            },
            {
              artifactId: newId(),
              baseRevisionId: null,
              newRevisionId: newId(),
              kind: 'new_artifact',
            },
          ],
          reason: 'partial',
        },
        agent,
      );
    } catch {}
    return {
      error,
      orphanArtifacts: orphan,
      firstRevisionState: ctx.repo.getRevision(a.revision.id).reviewState,
      proposalCount: ctx.repo.listProposals().length,
    };
  });
  await probe('retry-idempotency', async (_app, call, ctx) => {
    const payload = { type: 'note', title: 'Retry', payload: { markdown: 'retry' } };
    const r = await Promise.all([
      call('artifact.create_draft', payload, agent, 'same-key'),
      call('artifact.create_draft', payload, agent, 'same-key'),
    ]);
    return {
      artifacts: ctx.repo.listArtifacts().length,
      ids: r.map((x) => x.artifact.id),
      stored: ctx.repo.getIdempotent('same-key') !== null,
    };
  });
  await probe('filesystem-boundary', async (_app, call, ctx) => {
    const outside = path.join(root, 'outside-marker.txt');
    fs.writeFileSync(outside, 'AUDIT-NON-SECRET');
    const read = await call(
      'artifact.create_draft',
      {
        type: 'note',
        title: 'Outside read',
        payload: { markdown: 'test' },
        files: [{ path: 'artifacts/research/copied.txt', sourcePath: outside }],
      },
      agent,
    );
    const write = await call(
      'artifact.create_draft',
      {
        type: 'note',
        title: 'Internal write',
        payload: { markdown: 'test' },
        files: [
          {
            path: '.omenflow/cache/agent-marker.txt',
            contentBase64: Buffer.from('AUDIT-WRITE').toString('base64'),
          },
        ],
      },
      agent,
    );
    let rejected = '';
    try {
      await call(
        'artifact.create_draft',
        {
          type: 'note',
          title: 'Traversal',
          payload: { markdown: 'test' },
          files: [
            {
              path: '../recovered-outside.txt',
              contentBase64: Buffer.from('AUDIT-RECOVERY').toString('base64'),
            },
          ],
        },
        agent,
      );
    } catch (e) {
      rejected = String(e);
    }
    const pending = ctx.repo
      .pendingMaterializations()
      .filter((m: any) => m.path.startsWith('..')).length;
    const projectId = ctx.projectId;
    const projectRoot = ctx.root;
    _app.closeProject(projectId);
    await _app.dispatch('project.open', { path: projectRoot }, user);
    return {
      outsideRead: ctx.objects.readText(read.revision.files[0].sha256),
      internalWrite: fs.existsSync(path.join(projectRoot, write.revision.files[0].path)),
      initialTraversalError: rejected,
      pendingTraversal: pending,
      outsideWrittenOnReopen: fs.existsSync(path.join(projectRoot, '..', 'recovered-outside.txt')),
    };
  });
  await probe('archive-overwrite-and-terminal', async (_app, call, ctx) => {
    const a = await note(call, 'Original');
    await accept(call, a);
    ctx.emit('session.data', 'system', { sessionId: 'audit', chunk: 'AUDIT-TERMINAL-MARKER' });
    const archive = path.join(root, 'archive.zip');
    await call('project.export_archive', { destPath: archive });
    const zip = unzipSync(fs.readFileSync(archive));
    const manifest = JSON.parse(strFromU8(zip['archive-manifest.json']!));
    const snapshot = JSON.parse(strFromU8(zip['snapshot.json']!));
    const dest = path.join(root, 'archive-target');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'README.md'), 'USER-MARKER');
    await _app.dispatch(
      'project.import_archive',
      { archivePath: archive, destDir: dest, newIdentity: true },
      user,
    );
    return {
      existingFileOverwritten:
        fs.readFileSync(path.join(dest, 'README.md'), 'utf8') !== 'USER-MARKER',
      declaredExcludes: manifest.excludes,
      terminalInSnapshot: snapshot.events.some((e: any) => e.type === 'session.data'),
      terminalInDatabase: Buffer.from(zip['.omenflow/state.sqlite']!).includes(
        Buffer.from('AUDIT-TERMINAL-MARKER'),
      ),
    };
  });
  await probe('readonly-and-app-gate', async (app, call, ctx) => {
    const projectRoot = ctx.root;
    app.closeProject(ctx.projectId);
    const pfPath = path.join(projectRoot, 'omenflow.project.json');
    const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
    pf.version = 999;
    fs.writeFileSync(pfPath, JSON.stringify(pf));
    const opened = (await app.dispatch('project.open', { path: projectRoot }, user)) as any;
    await app.dispatch(
      'project.rename',
      { name: 'Changed by agent origin' },
      agent,
      opened.projectId,
    );
    return {
      readOnly: opened.readOnly,
      nameAfterAgentRename: app.contextFor(opened.projectId).repo.getProject().name,
    };
  });
  await probe('event-cursor', async (_app, call, ctx) => {
    for (let i = 0; i < 610; i++) ctx.emit('audit.event', 'system', { i });
    const r = await call('project.changes_since', { seq: 0 });
    const next = await call('project.changes_since', { seq: r.latest });
    return {
      returned: r.events.length,
      lastReturned: r.events.at(-1).seq,
      advertisedLatest: r.latest,
      nextReturned: next.events.length,
      skipped: r.latest - r.events.at(-1).seq,
    };
  });
  await probe('summary-budget', async (_app, call) => {
    await call('project.update_intent', { intent: 'x'.repeat(20000) });
    const r = await call('project.summary', { budget: 1000 });
    return { requestedBudget: 1000, actualChars: JSON.stringify(r).length };
  });
  await probe('rejected-revision-target', async (_app, call) => {
    const a = await call('cad.write_source', { title: 'Baseline', source: 'cube(10);' });
    await accept(call, a);
    const b = await call('cad.write_source', { artifactId: a.artifactId, source: 'cube(20);' });
    const p = await call('proposal.submit', {
      changes: [
        {
          artifactId: a.artifactId,
          baseRevisionId: a.revisionId,
          newRevisionId: b.revisionId,
          kind: 'baseline_update',
        },
      ],
      reason: 'bad size',
    });
    await call('proposal.reject', { proposalId: p.id, rationale: 'keep ten' });
    const r = await call('cad.read_source', { artifactId: a.artifactId });
    return {
      selectedSource: r.source,
      selectedReviewState: r.reviewState,
      isBaseline: r.isBaseline,
    };
  });
  await probe('calculation-binding', async (_app, call) => {
    const a = await call('artifact.create_draft', {
      type: 'requirement',
      title: 'Mass',
      payload: {
        statement: 'Mass',
        acceptanceCriterion: 'one kg',
        target: { value: 1, unit: 'kg' },
      },
    });
    await accept(call, a);
    const r = await call('calculation.run', {
      expression: 'm',
      inputs: [
        {
          name: 'm',
          quantity: { value: 99, unit: 'kg' },
          sourceRef: { artifactId: a.artifact.id, revisionId: a.revision.id },
        },
      ],
      submitForReview: false,
    });
    let dimensionalError = '';
    try {
      await call('calculation.run', {
        expression: 'l * w',
        inputs: [
          { name: 'l', quantity: { value: 2, unit: 'm' }, literal: true },
          { name: 'w', quantity: { value: 3, unit: 'm' }, literal: true },
        ],
        submitForReview: false,
      });
    } catch (e) {
      dimensionalError = String(e);
    }
    return { claimedInputMass: 1, computed: r.result, dimensionalError };
  });
  await probe('revocation-existing-connection', async (app, _call, ctx) => {
    const socketDir = fs.mkdtempSync('/tmp/of-audit-');
    const bridge = new BridgeServer(app, { socketPath: path.join(socketDir, 'b.sock') });
    await bridge.ready;
    const sid = newId();
    const token = bridge.issueToken({
      projectId: ctx.projectId,
      sessionId: sid,
      ops: ['artifact.create_draft'],
    });
    const sock = net.createConnection(bridge.socketPath);
    const decoder = new FrameDecoder();
    const queue: unknown[] = [];
    let receive: ((x: any) => void) | null = null;
    sock.on('data', (b) => {
      for (const m of decoder.push(b)) {
        if (receive) {
          const f = receive;
          receive = null;
          f(m);
        } else queue.push(m);
      }
    });
    const next = () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise<any>((resolve) => {
            receive = resolve;
          });
    sock.write(encodeFrame({ type: 'hello', token, mode: 'call', protocolVersion: 1 }));
    await next();
    bridge.revoke(sid);
    sock.write(
      encodeFrame({
        requestId: 'after-revoke',
        op: 'artifact.create_draft',
        payload: { type: 'note', title: 'After revocation', payload: { markdown: 'marker' } },
      }),
    );
    const r: any = await next();
    sock.destroy();
    await bridge.close();
    fs.rmSync(socketDir, { recursive: true, force: true });
    return {
      tokenRemoved: bridge.grantForToken(token) === null,
      requestAfterRevokeSucceeded: r.ok,
      artifacts: ctx.repo.listArtifacts().length,
    };
  });
  await probe('cancel-during-probe', async (_app, call, ctx) => {
    const a = await call('cad.write_source', { title: 'Cancellation', source: 'cube(5);' });
    await accept(call, a);
    const cad = ctx.tools.cad;
    const originalProbe = cad.probe.bind(cad);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    cad.probe = async () => {
      await gate;
      return originalProbe();
    };
    const r = await call('cad.render', { artifactId: a.artifactId });
    await call('job.cancel', { jobId: r.job.id });
    const initial = ctx.repo.getJob(r.job.id).status;
    release();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && ctx.repo.listRevisions(a.artifactId).length === 1)
      await new Promise((r) => setTimeout(r, 50));
    return {
      initialCancelStatus: initial,
      finalStatus: ctx.repo.getJob(r.job.id).status,
      revisions: ctx.repo.listRevisions(a.artifactId).length,
    };
  });
  await probe('duplicate-open-and-file-metadata', async (app, call, ctx) => {
    const job = ctx.createJob({ kind: 'audit', tool: 'audit' });
    ctx.jobStatus(job.id, 'running');
    const opened = (await app.dispatch('project.open', { path: ctx.root }, user)) as any;
    await call('project.rename', { name: 'Renamed' });
    const pf = JSON.parse(fs.readFileSync(path.join(ctx.root, 'omenflow.project.json'), 'utf8'));
    return {
      sameId: opened.projectId === ctx.projectId,
      liveJobAfterDuplicateOpen: ctx.repo.getJob(job.id).status,
      databaseName: ctx.repo.getProject().name,
      markerName: pf.name,
    };
  });
  await probe('invalid-geometry-repair', async (_app, call, ctx) => {
    const first = await call('cad.write_source', { title: 'Repair', source: 'cube(10);' });
    await accept(call, first);
    const syntax = await call('cad.write_source', {
      artifactId: first.artifactId,
      source: 'cube([;',
    });
    const empty = await call('cad.write_source', {
      artifactId: first.artifactId,
      source: 'difference(){cube(10);cube(10);}',
    });
    const repaired = await call('cad.write_source', {
      artifactId: first.artifactId,
      source: 'cube([12,10,10]);',
    });
    return {
      syntax: syntax.render,
      empty: empty.render,
      repaired: repaired.geometry?.bounds,
      baselinePreserved:
        ctx.repo.getArtifact(first.artifactId).selectedRevisionId === first.revisionId,
      revisions: ctx.repo.listRevisions(first.artifactId).length,
    };
  });
  await probe('research-loopback-policy', async (_app, call, ctx) => {
    // Stub host: no network request is made. Test only core URL authorization.
    const previous = ctx.host.researchOpen;
    let requested: string | null = null;
    ctx.host.researchOpen = async (url: string) => {
      requested = url;
      return { ok: true };
    };
    try {
      await call('browser.open', { url: 'http://127.0.0.2:9999/' }, agent);
    } finally {
      ctx.host.researchOpen = previous;
    }
    return { loopbackPassedToHost: requested, networkRequestMade: false };
  });
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log('RESULTS', path.join(root, 'results.json'));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
