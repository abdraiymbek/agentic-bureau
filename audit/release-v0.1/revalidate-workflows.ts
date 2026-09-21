/** Refresh verification on copies of completed two-turn workflow deliveries. */
import fs from 'node:fs';
import path from 'node:path';
import { CoreApp, nullHost, type CadReport } from '@omenflow/core';
import { createEngineTools } from '@omenflow/engineering';
import { canonicalScadRef } from '../../packages/core/src/cad-input.js';

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Provide completed workflow directory and new output');
  const results = [];
  for (const scenario of fs.readdirSync(input)) {
    const folder = path.join(input, scenario);
    if (!fs.statSync(folder).isDirectory()) continue;
    for (const run of fs.readdirSync(folder).filter((name) => /^r\d+$/.test(name))) {
      const original = path.join(folder, run);
      const summary = JSON.parse(fs.readFileSync(path.join(original, 'result.json'), 'utf8'));
      const delivery = JSON.parse(
        fs.readFileSync(path.join(original, 'turn2/result.json'), 'utf8'),
      );
      const dir = path.join(output, scenario, run);
      if (fs.existsSync(dir)) throw new Error(`Refusing to overwrite ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(path.join(original, 'turn2/project'), path.join(dir, 'project'), {
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
        const baseline = ctx.repo.listArtifacts().map((a) => [a.id, a.selectedRevisionId]);
        const old = ctx.requireRevision(delivery.metrics.finalRevisionId);
        const ref = canonicalScadRef(old)!;
        if (!ref.sha256) throw new Error('No original source');
        const previous = JSON.parse(
          ctx.objects.read(delivery.metrics.verificationEvidenceHash).toString('utf8'),
        );
        const rendered = (await app.dispatch(
          'cad.write_source',
          { artifactId: old.artifactId, source: ctx.objects.read(ref.sha256).toString('utf8') },
          user,
          projectId,
        )) as CadReport;
        const checked = (await app.dispatch(
          'cad.check',
          { artifactId: old.artifactId, revisionId: rendered.revisionId, expect: previous.expect },
          user,
          projectId,
        )) as { ready: boolean; pass: boolean; verificationStatus: string; evidenceHash: string };
        const revision = ctx.requireRevision(rendered.revisionId);
        const sourceAndParametersUnchanged =
          canonicalScadRef(revision)?.sha256 === ref.sha256 &&
          JSON.stringify((revision.payload as { params: unknown }).params) ===
            JSON.stringify((old.payload as { params: unknown }).params);
        const baselinesUnchanged =
          JSON.stringify(baseline) ===
          JSON.stringify(ctx.repo.listArtifacts().map((a) => [a.id, a.selectedRevisionId]));
        const expectedStatus = summary.scopeEscalated ? 'scope_changed' : 'passed';
        const result = {
          scenario,
          run,
          sourceAndParametersUnchanged,
          baselinesUnchanged,
          expectedStatus,
          verificationStatus: checked.verificationStatus,
          evidenceHash: checked.evidenceHash,
          pass:
            summary.pass &&
            sourceAndParametersUnchanged &&
            baselinesUnchanged &&
            checked.pass &&
            checked.verificationStatus === expectedStatus &&
            checked.ready === !summary.scopeEscalated,
        };
        results.push(result);
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(
          `${scenario} ${run}: ${result.pass ? 'PASS' : 'FAIL'} ${checked.verificationStatus}`,
        );
      } finally {
        app.closeAll();
      }
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(
    `${results.filter((r) => r.pass).length}/${results.length} workflow deliveries refreshed`,
  );
  if (results.length !== 30 || results.some((r) => !r.pass)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
