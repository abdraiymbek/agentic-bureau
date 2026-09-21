/** Thirty-sample local command timings; provider/network time is excluded. */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreApp, nullHost, type CadReport } from '@omenflow/core';
import { createEngineTools } from '@omenflow/engineering';

async function main() {
  const [project, out] = process.argv.slice(2);
  if (!project || !out) throw new Error('Provide disposable reference project and output JSON');
  const app = new CoreApp(path.join(path.dirname(out), 'command-appdata'), nullHost);
  app.engineTools = createEngineTools();
  const user = { kind: 'user' } as const;
  try {
    const { projectId } = (await app.dispatch('project.open', { path: project }, user)) as {
      projectId: string;
    };
    const ctx = app.contextFor(projectId);
    const artifactId = ctx.repo.listArtifacts({ type: 'mechanical' })[0]!.id;
    const written = (await app.dispatch(
      'cad.write_source',
      { artifactId, source: '$fn=316; sphere(r=10);' },
      user,
      projectId,
    )) as CadReport;
    const output = [];
    for (const [op, payload] of [
      ['artifact.read', { artifactId }],
      ['project.search', { query: 'Reference', limit: 20 }],
      ['cad.inspect', { artifactId, revisionId: written.revisionId }],
    ] as const) {
      const samples = [];
      for (let i = 0; i < 30; i++) {
        let last = performance.now();
        let maximumGap = 0;
        const start = last;
        const timer = setInterval(() => {
          const now = performance.now();
          maximumGap = Math.max(maximumGap, now - last);
          last = now;
        }, 5);
        try {
          const result = await app.dispatch(op, payload, user, projectId);
          const ms = performance.now() - start;
          await new Promise((resolve) => setTimeout(resolve, 10));
          samples.push({
            ms,
            maximumTimerGapMs: maximumGap,
            bytes: Buffer.byteLength(JSON.stringify(result)),
          });
        } finally {
          clearInterval(timer);
        }
      }
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      output.push({
        op,
        samples: samples.length,
        p50Ms: sorted[14],
        p95Ms: sorted[28],
        maxMs: sorted[29],
        maximumTimerGapMs: Math.max(...samples.map((s) => s.maximumTimerGapMs)),
        raw: samples,
      });
    }
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          project,
          artifacts: 500,
          triangles: written.geometry?.triangles,
          method:
            'Source core commands, 30 sequential samples each, 5 ms timer; excludes provider/network time. Timer gap includes scheduler contention. This is not a packaged first-paint measurement.',
          measurements: output,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(JSON.stringify(output.map(({ raw: _raw, ...summary }) => summary)));
  } finally {
    app.closeAll();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
