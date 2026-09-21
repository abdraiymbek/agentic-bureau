/** Recheck saved provider deliveries without changing their sources or original evidence.
 * pnpm exec tsx evals/cad/revalidate.ts OUTPUT ORIGINAL_MAIN ORIGINAL_HOLDOUT
 */
import fs from 'node:fs';
import path from 'node:path';
import { CoreApp, nullHost } from '@omenflow/core';
import { createEngineTools } from '@omenflow/engineering';
import type { Expectation } from '@omenflow/contracts';
import { CAD_CHECKER_VERSION } from '../../packages/core/src/cad-verification.js';
import { evaluateProject, type TaskResult } from './harness.js';
import { TASKS } from './tasks.js';
import { HOLDOUT_TASKS } from './holdout.js';

async function main() {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || !inputs.length)
    throw new Error('Provide output and original campaign directories');
  const results = [];
  for (const input of inputs) {
    for (const task of [...TASKS, ...HOLDOUT_TASKS]) {
      const folder = path.join(input, task.id);
      if (!fs.existsSync(folder)) continue;
      for (const run of fs
        .readdirSync(folder)
        .filter((r) => /^r\d+$/.test(r))
        .sort()) {
        const originalDir = path.join(folder, run);
        const original: TaskResult = JSON.parse(
          fs.readFileSync(path.join(originalDir, 'result.json'), 'utf8'),
        );
        const dir = path.join(output, task.id, run);
        if (fs.existsSync(dir)) throw new Error(`Refusing to overwrite ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.cpSync(path.join(originalDir, 'project'), path.join(dir, 'project'), {
          recursive: true,
        });
        const app = new CoreApp(path.join(dir, 'appdata'), nullHost);
        app.engineTools = createEngineTools();
        const user = { kind: 'user' } as const;
        try {
          const { projectId } = (await app.dispatch(
            'project.open',
            { path: path.join(dir, 'project') },
            user,
          )) as { projectId: string };
          const ctx = app.contextFor(projectId);
          const revision = ctx.repo.getRevision(original.metrics.finalRevisionId!);
          if (!revision) throw new Error('Original final revision missing');
          const oldEvidence = JSON.parse(
            ctx.objects.read(original.metrics.verificationEvidenceHash!).toString('utf8'),
          ) as { expect: Expectation; checkerVersion: string };
          const fresh = (await app.dispatch(
            'cad.check',
            {
              artifactId: revision.artifactId,
              revisionId: revision.id,
              expect: oldEvidence.expect,
            },
            user,
            projectId,
          )) as { ready: boolean; evidenceHash: string; verificationStatus: string };
          const evaluated = await evaluateProject(
            app,
            projectId,
            task,
            task.seed ? revision.artifactId : null,
            dir,
          );
          const unchanged = ctx.repo.getRevision(revision.id)?.contentHash === revision.contentHash;
          const result = {
            taskId: task.id,
            run,
            originalPass: original.pass,
            originalChecker: oldEvidence.checkerVersion,
            checker: CAD_CHECKER_VERSION,
            sourceAndRevisionUnchanged: unchanged,
            ready: fresh.ready,
            verificationStatus: fresh.verificationStatus,
            evidenceHash: fresh.evidenceHash,
            pass:
              original.pass && unchanged && fresh.ready && evaluated.checks.every((c) => c.pass),
            checks: evaluated.checks,
          };
          fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
          results.push(result);
          console.log(
            `${task.id} ${run}: ${result.pass ? 'PASS' : 'FAIL'} ${fresh.verificationStatus}`,
          );
        } finally {
          app.closeAll();
        }
      }
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(
    `${results.filter((r) => r.pass).length}/${results.length} revalidated with ${CAD_CHECKER_VERSION}`,
  );
  if (!results.length || results.some((r) => !r.pass)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
