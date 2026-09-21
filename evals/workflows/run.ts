/** Two real provider turns separated by a closed/reopened project, with fixed faults/review stimuli. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp, nullHost } from '@omenflow/core';
import type { Expectation } from '@omenflow/contracts';
import { runTask, type TaskResult, type RunOptions } from '../cad/harness.js';
import type { Task } from '../cad/tasks.js';

const user = { kind: 'user' } as const;
const source = (diameter: number) =>
  `$fn=64; hole_diameter=${diameter}; difference(){translate([-30,-20,0])cube([60,40,5]);for(x=[-20,20])for(y=[-10,10])translate([x,y,-1])cylinder(d=hole_diameter,h=7);}`;
const centers: [number, number][] = [
  [-20, -10],
  [-20, 10],
  [20, -10],
  [20, 10],
];
function expectPlate(d: number): Expectation {
  return {
    bbox: { min: [-30, -20, 0], max: [30, 20, 5] },
    shells: 1,
    volume: { value: 12000 - 4 * Math.PI * (d / 2) ** 2 * 5 },
    solid: [[0, 0, 2.5]],
    empty: centers.map(([x, y]) => [x, y, 2.5]),
    sections: [
      {
        axis: 'z',
        at: 2.5,
        holeCount: 4,
        outerCount: 1,
        outer: { size: [60, 40] },
        holes: centers.map((center) => ({ center, d })),
      },
    ],
  };
}
const inspect =
  'Read the existing Mounting plate source and summarize its dimensions and hole pattern. Do not edit, render, check, or propose anything yet.';
const modify = (d: number) =>
  `Modify the existing Mounting plate on the same artifact: make all four through holes diameter ${d} mm. Preserve the 60 by 40 by 5 mm envelope, centers at (+/-20,+/-10), and all unrelated geometry. Render and verify the final revision; do not approve it.`;
type Scenario = {
  id: string;
  first: string;
  second: string;
  finalD: number;
  firstD?: number;
  fault?: 'missing' | 'cancel';
  invalid?: boolean;
  review?: boolean;
  changedRequest?: boolean;
  ambiguous?: boolean;
  unrelated?: boolean;
};
const scenarios: Scenario[] = [
  { id: 'existing-part', first: inspect, second: modify(6), finalD: 6 },
  {
    id: 'ambiguous-fit',
    first: 'The Mounting plate holes need to fit my new screws. Modify the plate for them.',
    second:
      'The missing size is now specified: make all four through holes diameter 6 mm, preserving all other dimensions and geometry. Use the same artifact, render and verify the final revision.',
    finalD: 6,
    ambiguous: true,
  },
  {
    id: 'reviewer-correction',
    first: modify(6) + ' Submit a proposal for human review.',
    second:
      'Read the saved changes-requested decision. Correct that candidate on the same artifact and submit a replacement proposal. Do not approve or accept verification scope yourself. State any remaining human review explicitly.',
    firstD: 6,
    finalD: 5.5,
    review: true,
  },
  {
    id: 'changed-request',
    first: modify(6),
    second:
      'Updated requirement for this ongoing job: the four holes must be diameter 7 mm instead of 6 mm. Keep every other dimension unchanged and retain the same artifact. Render and check the candidate; explicitly disclose any remaining scope acceptance.',
    firstD: 6,
    finalD: 7,
    changedRequest: true,
  },
  {
    id: 'inch-conversion',
    first: inspect,
    second:
      'Make the four holes one quarter inch in diameter. Keep the source and model in millimetres and all other dimensions unchanged. Revise the existing artifact, render and verify it.',
    finalD: 6.35,
  },
  {
    id: 'invalid-source-recovery',
    first:
      'Inspect/render the existing Mounting plate and report the source error. Do not edit it yet or claim it is ready.',
    second:
      'Repair the invalid source. The complete required shape is a 60 by 40 by 5 mm plate centered on XY, bottom at Z=0, with four diameter-6 through holes at (+/-20,+/-10). Use the same artifact, render, and verify it.',
    finalD: 6,
    invalid: true,
  },
  {
    id: 'tool-outage-recovery',
    first:
      'Inspect/render the existing Mounting plate. If OpenSCAD is unavailable, report that limitation and leave the source unchanged.',
    second: 'OpenSCAD is available again. ' + modify(6),
    finalD: 6,
    fault: 'missing',
  },
  {
    id: 'cancelled-render-recovery',
    first:
      'Inspect/render the existing Mounting plate once. If interrupted, preserve the existing source, report the interruption and stop without retrying.',
    second: 'The interruption is over. ' + modify(6),
    finalD: 6,
    fault: 'cancel',
  },
  {
    id: 'reopened-candidate',
    first: modify(6) + ' Submit a proposal for human review.',
    second:
      'The application was closed and this project reopened. Recover the existing diameter-6 candidate and pending proposal, without creating a duplicate artifact or changing the approved baseline. Read its saved verification scope and recheck that exact scope. Report the current review state.',
    firstD: 6,
    finalD: 6,
  },
  {
    id: 'unrelated-record-preserved',
    first: inspect,
    second:
      modify(6) +
      ' Preserve the unrelated Interface contract note and its approved revision exactly.',
    finalD: 6,
    unrelated: true,
  },
];
function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1];
}
const output = arg('out');
if (!output) throw new Error('Provide --out <directory>');
const out = path.resolve(output);
const runs = Number(arg('runs', '3'));
const only = arg('tasks')?.split(',');
const framing =
  'You are working inside an Omen Flow engineering project with the omenflow MCP server connected. Use its tools to inspect and revise project artifacts. All dimensions are in millimetres unless explicitly stated otherwise.';
const budget = { seconds: 420, cadTools: 20 };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, 'protocol.json'),
  JSON.stringify({ model: 'gpt-5.6-luna', effort: 'high', runs, budget, scenarios }, null, 2) +
    '\n',
);

function state(app: CoreApp, projectId: string) {
  const ctx = app.contextFor(projectId);
  return {
    artifacts: ctx.repo.listArtifacts({ includeArchived: true }).map((a) => ({
      id: a.id,
      title: a.title,
      selected: a.selectedRevisionId,
      archived: a.archived,
      revisions: ctx.repo.listRevisions(a.id).map((r) => ({ id: r.id, hash: r.contentHash })),
    })),
    proposals: ctx.repo.listProposals(),
  };
}
async function snapshotState(dir: string) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'of-workflow-read-'));
  const app = new CoreApp(data, nullHost);
  try {
    const opened = (await app.dispatch('project.open', { path: dir }, user)) as {
      projectId: string;
    };
    return state(app, opened.projectId);
  } finally {
    app.closeAll();
    fs.rmSync(data, { recursive: true, force: true });
  }
}
function metrics(rs: TaskResult[]) {
  return {
    seconds: rs.reduce((n, r) => n + r.metrics.durationMs / 1000, 0),
    cadTools: rs.reduce(
      (n, r) =>
        n +
        Object.entries(r.metrics.toolCallsByName)
          .filter(([k]) => k.startsWith('cad_'))
          .reduce((a, [, v]) => a + v, 0),
      0,
    ),
  };
}
async function main() {
  const outcomes: unknown[] = [];
  for (let run = 1; run <= runs; run++)
    for (const scenario of scenarios.filter((s) => !only || only.includes(s.id))) {
      const dir = path.join(out, scenario.id, 'r' + run);
      fs.mkdirSync(dir, { recursive: true });
      const completed = path.join(dir, 'result.json');
      if (fs.existsSync(completed)) {
        outcomes.push(JSON.parse(fs.readFileSync(completed, 'utf8')));
        continue;
      }
      console.log(`Starting ${scenario.id} r${run}`);
      const seedSource = scenario.invalid
        ? 'difference(){cube([60,40,5]); INVALID SYNTAX'
        : source(4);
      const task: Task = {
        id: scenario.id,
        category: 'modification',
        prompt: scenario.first,
        expect: expectPlate(scenario.firstD ?? 4),
        seed: {
          title: 'Mounting plate',
          path: 'artifacts/mechanical/mounting-plate.scad',
          scad: seedSource,
        },
      };
      const options: RunOptions = {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        ignoreUserConfig: true,
        outDir: dir,
        runName: 'turn1',
        timeoutMs: 240000,
        framing,
      };
      let before: ReturnType<typeof state> | undefined;
      options.beforeAgent = async (app, id) => {
        const ctx = app.contextFor(id);
        if (scenario.unrelated) {
          const draft = (await app.dispatch(
            'artifact.create_draft',
            {
              type: 'note',
              title: 'Interface contract',
              payload: {
                markdown:
                  'Keep datum Z=0; connector remains 12 V; unknown current must stay unknown.',
              },
              rationale: 'fixture',
            },
            user,
            id,
          )) as { artifact: { id: string }; revision: { id: string } };
          await app.dispatch(
            'artifact.accept_draft',
            {
              artifactId: draft.artifact.id,
              draftRevisionId: draft.revision.id,
              rationale: 'fixture',
            },
            user,
            id,
          );
        }
        before = state(app, id);
        fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
        if (scenario.fault) {
          const cad = ctx.tools.cad!;
          ctx.tools.cad = {
            toolId: cad.toolId,
            probe:
              scenario.fault === 'missing'
                ? async () => ({
                    available: false,
                    executablePath: null,
                    version: null,
                    error: 'OpenSCAD unavailable (controlled evaluation outage)',
                  })
                : cad.probe.bind(cad),
            validateSource: cad.validateSource.bind(cad),
            inspectStl: cad.inspectStl.bind(cad),
            cancel: cad.cancel.bind(cad),
            render:
              scenario.fault === 'cancel'
                ? async (spec) => {
                    ctx.cancelJob(spec.jobId);
                    return { ok: false, error: 'cancelled' };
                  }
                : cad.render.bind(cad),
          };
        }
      };
      const first = await runTask(task, options);
      const firstState = await snapshotState(path.join(dir, 'turn1/project'));
      const firstProvider = first.checks
        .filter((c) => c.name.startsWith('provider ') || c.name === 'agent jobs complete')
        .every((c) => c.pass);
      const readOnly = !scenario.firstD;
      const firstPreserved =
        JSON.stringify(before!.artifacts) === JSON.stringify(firstState.artifacts);
      const firstHonest =
        !scenario.ambiguous || /\?|diameter|screw size|what size/i.test(first.metrics.finalMessage);
      const firstPass = firstProvider && (readOnly ? firstPreserved && firstHonest : first.pass);
      const finalTask: Task = {
        ...task,
        prompt: scenario.second,
        expect: expectPlate(scenario.finalD),
        seed: { ...task.seed!, scad: source(4) },
        changeRegions: scenario.invalid
          ? undefined
          : centers.map(([x, y]) => ({ center: [x, y, 2.5], radius: 6 })),
      };
      let requestedProposal: string | undefined;
      const second = await runTask(finalTask, {
        ...options,
        runName: 'turn2',
        projectSnapshot: path.join(dir, 'turn1/project'),
        beforeAgent: async (app, id) => {
          if (scenario.review) {
            const p = app
              .contextFor(id)
              .repo.listProposals()
              .find((p) => p.state === 'pending');
            if (p) {
              requestedProposal = p.id;
              await app.dispatch(
                'proposal.request_changes',
                {
                  proposalId: p.id,
                  rationale:
                    'Change the four holes to diameter 5.5 mm, retaining all other dimensions and geometry. Submit a replacement for review.',
                },
                user,
                id,
              );
            }
          }
        },
      });
      const after = await snapshotState(path.join(dir, 'turn2/project'));
      const baselinePreserved = before!.artifacts.every((a) => {
        const found = after.artifacts.find((b) => b.id === a.id);
        return (
          found?.selected === a.selected &&
          !found.archived &&
          found.revisions.find((r) => r.id === a.selected)?.hash ===
            a.revisions.find((r) => r.id === a.selected)?.hash
        );
      });
      const unrelatedPreserved =
        !scenario.unrelated ||
        JSON.stringify(before!.artifacts.find((a) => a.title === 'Interface contract')) ===
          JSON.stringify(after.artifacts.find((a) => a.title === 'Interface contract'));
      const failed = second.checks.filter((c) => !c.pass);
      const scopeEscalated =
        !!(scenario.review || scenario.changedRequest) &&
        failed.length === 1 &&
        failed[0]!.name === 'final revision verified' &&
        failed[0]!.detail.includes('scope_changed') &&
        /scope_changed|scope.changed|scope acceptance|human.{0,30}accept/i.test(
          second.metrics.finalMessage,
        );
      const reviewPreserved =
        !scenario.review ||
        (!!requestedProposal &&
          after.proposals.some((p) => p.id === requestedProposal && p.state === 'superseded') &&
          after.proposals.some((p) => p.id !== requestedProposal && p.state === 'pending'));
      const reopenedProposalPreserved =
        scenario.id !== 'reopened-candidate' ||
        (firstState.proposals.some((p) => p.state === 'pending') &&
          after.proposals.length === firstState.proposals.length);
      const cost = metrics([first, second]);
      const result = {
        scenario: scenario.id,
        run,
        pass:
          firstPass &&
          (second.pass || scopeEscalated) &&
          baselinePreserved &&
          unrelatedPreserved &&
          reviewPreserved &&
          reopenedProposalPreserved &&
          cost.seconds <= budget.seconds &&
          cost.cadTools <= budget.cadTools,
        firstPass,
        secondPass: second.pass,
        scopeEscalated,
        baselinePreserved,
        unrelatedPreserved,
        reviewPreserved,
        reopenedProposalPreserved,
        cost,
        budget,
        failedChecks: failed,
      };
      fs.writeFileSync(completed, JSON.stringify(result, null, 2) + '\n');
      outcomes.push(result);
      console.log(JSON.stringify(result));
    }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(outcomes, null, 2) + '\n');
  if (outcomes.some((o) => !(o as { pass: boolean }).pass)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
