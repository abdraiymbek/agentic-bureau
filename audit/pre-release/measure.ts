/** Bounded, disposable performance probes. pnpm exec tsx audit/pre-release/measure.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CoreApp,
  nullHost,
  countIntersectingPairs,
  type TriangleBuffer,
} from '../../packages/core/src/index.js';
import { newId, type Artifact, type Revision } from '../../packages/contracts/src/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-audit-perf-'));
const output: unknown[] = [];
const user = { kind: 'user' } as const;
async function main() {
  for (const count of [100, 500, 2000]) {
    const app = new CoreApp(path.join(root, String(count), 'app'), nullHost);
    const created = (await app.dispatch(
      'project.create',
      {
        name: `scale-${count}`,
        path: path.join(root, String(count), 'project'),
        intent: 'audit scale',
      },
      user,
    )) as { projectId: string };
    const ctx = app.contextFor(created.projectId);
    let first!: Artifact;
    let prev!: Artifact;
    const ts = new Date().toISOString();
    ctx.repo.tx(() => {
      for (let i = 0; i < count; i++) {
        const a: Artifact = {
          id: newId(),
          type: 'note',
          title: `Object ${i}`,
          subsystem: null,
          selectedRevisionId: newId(),
          archived: false,
          createdAt: ts,
        };
        const inputs = i
          ? [
              {
                artifactId: prev.id,
                revisionId: prev.selectedRevisionId!,
                relationship: 'depends_on' as const,
              },
            ]
          : [];
        const r: Revision = {
          id: a.selectedRevisionId!,
          artifactId: a.id,
          parentId: null,
          seq: 1,
          origin: 'user',
          originDetail: null,
          createdAt: ts,
          payload: { markdown: 'x'.repeat(200) },
          files: [],
          inputs,
          rationale: 'scale fixture',
          reviewState: 'approved',
          contentHash: 'audit',
        };
        ctx.repo.insertArtifact(a);
        ctx.repo.insertRevision(r);
        if (i)
          ctx.repo.insertEdge({
            id: newId(),
            upstreamArtifactId: prev.id,
            downstreamArtifactId: a.id,
            relationship: 'depends_on',
            requiredUpstreamRevisionId: prev.selectedRevisionId,
            label: '',
            createdBy: 'user',
            createdAt: ts,
          });
        else first = a;
        prev = a;
      }
    });
    const timings: Record<string, unknown> = { artifacts: count };
    for (const [op, payload] of [
      ['artifact.list', { limit: 500 }],
      ['project.summary', {}],
      ['graph.impact', { refs: [{ artifactId: first.id, revisionId: first.selectedRevisionId }] }],
    ] as const) {
      const samples: number[] = [];
      let bytes = 0;
      for (let j = 0; j < 5; j++) {
        const start = performance.now();
        const result = await app.dispatch(op, payload, user, created.projectId);
        samples.push(performance.now() - start);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      timings[op] = { ms: samples.map((x) => Math.round(x * 100) / 100), jsonBytes: bytes };
    }
    const t = performance.now();
    await app.dispatch(
      'artifact.apply_edit',
      {
        artifactId: first.id,
        baseRevisionId: first.selectedRevisionId,
        payload: { markdown: 'changed' },
        rationale: 'change root',
      },
      user,
      created.projectId,
    );
    timings.rootEditMs = Math.round(performance.now() - t);
    timings.staleCount = ctx.repo.allStale().length;
    timings.rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    output.push(timings);
    console.log(JSON.stringify(timings));
    app.closeAll();
  }
  // Disjoint triangles exercise the all-pairs AABB loop without expensive actual intersections.
  for (const n of [1000, 5000, 10000, 20000]) {
    const tris = new Float64Array(n * 9) as TriangleBuffer;
    for (let i = 0; i < n; i++) tris.set([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0], i * 9);
    const start = performance.now();
    const pairs = countIntersectingPairs(tris);
    const result = { triangles: n, pairs, intersectionMs: Math.round(performance.now() - start) };
    output.push(result);
    console.log(JSON.stringify(result));
  }
  fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(output, null, 2));
  console.log('RESULTS', path.join(root, 'measurements.json'));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
