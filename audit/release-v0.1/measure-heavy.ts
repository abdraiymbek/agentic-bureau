/** Real 99k-triangle CAD work, core responsiveness, and a native reference project. */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreApp, nullHost, type CadReport } from '@omenflow/core';
import { newId, type Artifact, type Revision } from '@omenflow/contracts';
import { createEngineTools } from '@omenflow/engineering';

async function main() {
  const base = process.argv[2];
  if (!base) throw new Error('Provide a new disposable directory');
  const app = new CoreApp(path.join(base, 'appdata'), nullHost);
  app.engineTools = createEngineTools();
  const user = { kind: 'user' } as const;
  try {
    const created = (await app.dispatch(
      'project.create',
      {
        name: 'V01 Performance Reference',
        path: path.join(base, 'project'),
        intent:
          'Disposable 500-object and approximately 100k-triangle release qualification fixture.',
      },
      user,
    )) as { projectId: string };
    const ctx = app.contextFor(created.projectId);
    const now = new Date().toISOString();
    ctx.repo.tx(() => {
      for (let i = 0; i < 499; i++) {
        const a: Artifact = {
          id: newId(),
          type: 'note',
          title: `Reference note ${i + 1}`,
          subsystem: null,
          selectedRevisionId: newId(),
          archived: false,
          createdAt: now,
        };
        const r: Revision = {
          id: a.selectedRevisionId!,
          artifactId: a.id,
          parentId: null,
          seq: 1,
          origin: 'user',
          originDetail: null,
          createdAt: now,
          payload: { markdown: 'Reference fixture. '.repeat(50) },
          files: [],
          inputs: [],
          rationale: 'performance fixture',
          reviewState: 'approved',
          contentHash: 'fixture',
        };
        ctx.repo.insertArtifact(a);
        ctx.repo.insertRevision(r);
      }
    });
    async function measure<T>(name: string, fn: () => Promise<T>) {
      const gaps: number[] = [];
      let last = performance.now();
      const start = last;
      const timer = setInterval(() => {
        const at = performance.now();
        gaps.push(at - last);
        last = at;
      }, 5);
      try {
        const value = await fn();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          value,
          measurement: {
            name,
            wallMs: performance.now() - start,
            maxTimerGapMs: Math.max(0, ...gaps),
            timerTicks: gaps.length,
          },
        };
      } finally {
        clearInterval(timer);
      }
    }
    const written = await measure(
      'cad.write_source',
      () =>
        app.dispatch(
          'cad.write_source',
          { title: '100k reference sphere', source: '$fn=316; sphere(r=10);' },
          user,
          created.projectId,
        ) as Promise<CadReport>,
    );
    const part = written.value;
    const checked = await measure(
      'cad.check',
      () =>
        app.dispatch(
          'cad.check',
          {
            artifactId: part.artifactId,
            expect: {
              bbox: { min: [-10, -10, -10], max: [10, 10, 10], tol: 0.01 },
              shells: 1,
              solid: [[0, 0, 0]],
            },
          },
          user,
          created.projectId,
        ) as Promise<{ ready: boolean }>,
    );
    if (!checked.value.ready) throw new Error('Reference sphere failed verification');
    await app.dispatch(
      'artifact.accept_draft',
      {
        artifactId: part.artifactId,
        draftRevisionId: part.revisionId,
        rationale: 'Approve disposable performance fixture',
      },
      user,
      created.projectId,
    );
    const inspected = await measure('cad.inspect', () =>
      app.dispatch('cad.inspect', { artifactId: part.artifactId }, user, created.projectId),
    );
    const result = {
      at: new Date().toISOString(),
      method:
        '5 ms timer gaps in source core process during each complete command; includes scheduling contention, excludes prior fixture setup. Native desktop memory/frame-time is a separate measurement.',
      project: path.join(base, 'project'),
      artifacts: 500,
      triangles: part.geometry?.triangles,
      measurements: [written.measurement, checked.measurement, inspected.measurement],
      rssMiB: process.memoryUsage().rss / 1024 ** 2,
    };
    fs.writeFileSync(path.join(base, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    app.closeAll();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
