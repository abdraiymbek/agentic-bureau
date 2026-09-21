/** Same 2,000-node fixture as pre-release/measure.ts; 30 graph command samples. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreApp, nullHost } from '../../packages/core/src/index.js';
import { newId, type Artifact, type Revision } from '../../packages/contracts/src/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-audit-perf-'));
const output: unknown[] = [];
const user = { kind: 'user' } as const;
async function main() {
  for (const count of [2000]) {
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
      ['graph.impact', { refs: [{ artifactId: first.id, revisionId: first.selectedRevisionId }] }],
    ] as const) {
      const samples: number[] = [];
      let bytes = 0;
      for (let j = 0; j < 30; j++) {
        const start = performance.now();
        const result = await app.dispatch(op, payload, user, created.projectId);
        samples.push(performance.now() - start);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      const sorted = [...samples].sort((a, b) => a - b);
      timings[op] = {
        ms: samples.map((x) => Math.round(x * 1000) / 1000),
        p50Ms: sorted[Math.ceil(0.5 * sorted.length) - 1],
        p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1],
        jsonBytes: bytes,
      };
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
  const evidence = {
    measuredAt: new Date().toISOString(),
    command: 'pnpm exec tsx audit/execution/measure-graph.ts',
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      memoryGiB: os.totalmem() / 1024 ** 3,
      node: process.version,
    },
    method:
      'Thirty consecutive samples, no excluded warmup; nearest-rank p50/p95. Same 2000-node immutable baseline chain as pre-release/measure.ts. Times cover await CoreApp.dispatch only, not JSON serialization, bridge or renderer. Each result is serialized outside the timer. One root edit, no root-edit percentile claim. Synthetic process RSS includes fixture and serialization allocation, not desktop memory.',
    results: output,
    limitations: [
      'Not whole-desktop reference performance.',
      'No 100 ms event-loop stall claim.',
      'No 32 KiB transport budget claim.',
    ],
  };
  fs.mkdirSync('audit/execution/evidence', { recursive: true });
  fs.writeFileSync(
    'audit/execution/evidence/graph-impact-30.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  fs.rmSync(root, { recursive: true, force: true });
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
