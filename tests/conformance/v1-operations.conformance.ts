/**
 * The V1 operations and the core fixes behind them, through the same client
 * as the rest of the suite: user calls take the command route, agent calls
 * the real bridge with a session token. Engine-free: nothing here needs
 * OpenSCAD.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreError, RustCore } from './rust-core';

const USER = { kind: 'user' as const };
const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000f1' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;
let app: RustCore;
let projectId: string;
const user = (op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, USER, projectId) as Promise<any>;
const agent = (op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, AGENT, projectId) as Promise<any>;
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('the call was expected to fail');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CoreError);
      return error as CoreError;
    },
  );

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-v1-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'V1 operations', intent: 'conformance' },
    USER,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

const approvedNote = async (title: string, markdown: string) => {
  const draft = await user('artifact.create_draft', { type: 'note', title, payload: { markdown } });
  await user('artifact.accept_draft', {
    artifactId: draft.artifact.id,
    draftRevisionId: draft.revision.id,
  });
  return { artifactId: draft.artifact.id as string, revisionId: draft.revision.id as string };
};

describe('work.status', () => {
  it('is the project for the person and the session for an agent', async () => {
    const empty = await user('work.status');
    expect(empty).toMatchObject({ ready: true, scope: 'project', outstanding: [] });
    const own = await agent('work_status');
    expect(own).toMatchObject({ ready: true, scope: 'session', sessionId: AGENT.sessionId });

    const component = await agent('artifact.create_draft', {
      type: 'component',
      title: 'Drive motor',
      payload: { partNumber: 'DM-1' },
    });
    const calculation = await agent('artifact.create_draft', {
      type: 'calculation',
      title: 'Mass budget',
      payload: { expression: 'a + b', inputs: [] },
    });
    const note = await user('artifact.create_draft', {
      type: 'note',
      title: 'Bench notes',
      payload: { markdown: 'Measured by hand.' },
    });

    const project = await user('work.status');
    expect(project.scope).toBe('project');
    expect(project.ready).toBe(false);
    const kinds = (status: any) =>
      status.outstanding.map((item: any) => [item.kind, item.severity, item.artifactId]);
    expect(kinds(project)).toEqual([
      ['component_unsourced', 'blocker', component.artifact.id],
      ['component_no_offer', 'blocker', component.artifact.id],
      ['calculation_not_run', 'blocker', calculation.artifact.id],
      ['draft_unproposed', 'advice', note.artifact.id],
    ]);
    const notRun = project.outstanding[2];
    expect(notRun.next).toEqual({
      tool: 'calculation_run',
      why: expect.any(String),
      args: { artifactId: calculation.artifact.id, expression: 'a + b' },
    });
    expect(project.counts).toEqual({ blockers: 3, advice: 1, verifiedParts: 0 });

    // The agent's own view leaves out the person's note.
    const session = await agent('work_status');
    expect(session.scope).toBe('session');
    expect(kinds(session)).toEqual(kinds(project).slice(0, 3));
    // The person can ask for the latest agent session's view.
    const asked = await user('work.status', { scope: 'session' });
    expect(asked).toMatchObject({ scope: 'session', sessionId: AGENT.sessionId });
    expect(kinds(asked)).toEqual(kinds(session));
  });
});

describe('project.coverage', () => {
  it('traces a requirement to its test and takes the verdict only from a recorded result', async () => {
    const need = await user('artifact.create_draft', {
      type: 'requirement',
      title: 'Payload capacity',
      payload: {
        statement: 'Carry a 300 g sensor pack.',
        acceptanceCriterion: 'Drives 5 m with the pack fitted.',
        target: { value: 0.3, unit: 'kg' },
        priority: 'must',
      },
    });
    await user('artifact.accept_draft', {
      artifactId: need.artifact.id,
      draftRevisionId: need.revision.id,
    });
    const none = await user('project.coverage');
    expect(none.requirements[0]).toMatchObject({
      artifactId: need.artifact.id,
      target: { value: 0.3, unit: 'kg' },
      review: 'approved',
      coverage: 'none',
      evidence: [],
    });
    expect(none.totals).toEqual({ requirements: 1, covered: 0, partial: 0, stale: 0, none: 1 });

    const test = await agent('test.create_draft', {
      title: 'Lift test',
      procedure: [{ step: 1, instruction: 'Load 0.3 kg and drive 5 m', expected: 'No tipping' }],
      requirementRefs: [{ artifactId: need.artifact.id }],
    });
    const drafted = await user('project.coverage');
    expect(drafted.requirements[0].coverage).toBe('stale');
    expect(drafted.requirements[0].evidence).toEqual([
      expect.objectContaining({
        artifactId: test.artifact.id,
        relation: 'validates',
        state: 'draft',
        verdict: 'unknown',
      }),
    ]);

    await user('artifact.accept_draft', {
      artifactId: test.artifact.id,
      draftRevisionId: test.revision.id,
    });
    const planned = await user('project.coverage');
    expect(planned.requirements[0].evidence[0]).toMatchObject({
      state: 'no_result',
      result: null,
      verdict: 'unknown',
    });

    await user('test.record_result', {
      artifactId: test.artifact.id,
      evidenceKind: 'measured',
      observation: 'Carried 0.3 kg for 5 m in 12 s',
      result: 'passed',
      requirementRef: { artifactId: need.artifact.id },
    });
    const covered = await user('project.coverage');
    expect(covered.requirements[0]).toMatchObject({ coverage: 'covered' });
    expect(covered.requirements[0].evidence[0]).toMatchObject({
      state: 'current',
      evidenceKind: 'measured',
      result: 'Carried 0.3 kg for 5 m in 12 s',
      verdict: 'pass',
    });
    expect(covered.totals).toEqual({ requirements: 1, covered: 1, partial: 0, stale: 0, none: 0 });
  });
});

describe('tool.describe', () => {
  it('lists the catalogue and resolves either name form', async () => {
    const catalogue = await agent('tool_describe', {});
    expect(catalogue.tools.length).toBeGreaterThan(13);
    expect(catalogue.tools.slice(0, 2)).toEqual([
      {
        tool: 'project_summary',
        pack: 'core',
        tier: 'core',
        summary: expect.any(String),
        mutating: false,
      },
      {
        tool: 'artifact_list',
        pack: 'core',
        tier: 'core',
        summary: expect.any(String),
        mutating: false,
      },
    ]);
    expect(catalogue.tools.filter((tool: any) => tool.tier === 'core')).toHaveLength(13);
    for (const tool of catalogue.tools) expect(tool.tool).not.toContain('.');

    const underscore = await agent('tool_describe', { tool: 'cad_check' });
    const dotted = await user('tool.describe', { op: 'cad.check' });
    // An agent's copy of the schema is slimmed for the model; the fields are the same.
    const { inputSchema: slim, ...forAgent } = underscore;
    const { inputSchema: full, ...forPerson } = dotted;
    expect(forAgent).toEqual(forPerson);
    expect(Object.keys(slim.properties)).toEqual(Object.keys(full.properties));
    expect(full.additionalProperties).toBe(false);
    expect(slim.additionalProperties).toBeUndefined();
    expect(underscore).toMatchObject({
      op: 'cad.check',
      tool: 'cad_check',
      pack: 'cad',
      tier: 'core',
      mutating: true,
      agentAllowed: true,
    });
    expect(underscore.example.artifactId).toMatch(UUID);
    expect(underscore.inputSchema.properties.expect).toBeDefined();

    const unknown = await refusal(agent('tool_describe', { tool: 'cad_chek' }));
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.repair).toContain('Did you mean cad_check?');
    expect(unknown.details).toMatchObject({ nearest: 'cad_check' });
  });
});

describe('guide.read', () => {
  it('serves playbooks to agents and to the person', async () => {
    const start = await agent('guide_read', {});
    expect(start.topic).toBe('start');
    expect(start.topics.map((topic: any) => topic.id)).toEqual([
      'start',
      'requirements',
      'parts',
      'cad',
      'cad-verify',
      'wiring',
      'calculation',
      'tests',
      'review',
      'finish',
    ]);
    for (const topic of start.topics) {
      const playbook = await user('guide.read', { topic: topic.id });
      expect(playbook.topic).toBe(topic.id);
      expect(playbook.text.length).toBeLessThanOrEqual(2400);
      expect(playbook.text.trimEnd()).toMatch(/then call work_status\.?$/);
    }
    const unknown = await refusal(agent('guide_read', { topic: 'soldering' }));
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.repair).toContain('guide_read');
  });
});

describe('tool.call', () => {
  it('reaches any agent-allowed tool and nothing reserved for the person', async () => {
    const draft = await agent('tool_call', {
      tool: 'artifact_create_draft',
      input: { type: 'note', title: 'Through tool_call', payload: { markdown: 'Kept.' } },
    });
    expect(draft.revision.origin).toBe('agent');
    const listed = await agent('tool_call', { tool: 'artifact.list' });
    expect(listed.artifacts.map((view: any) => view.artifact.id)).toEqual([draft.artifact.id]);

    const denied = await refusal(agent('tool_call', { tool: 'proposal_approve', input: {} }));
    expect(denied.code).toBe('CAPABILITY_DENIED');
    expect(denied.repair).toContain('proposal_submit');
    const unknown = await refusal(agent('tool_call', { tool: 'artfact_list' }));
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.repair).toContain('artifact_list');
    const recursive = await refusal(agent('tool_call', { tool: 'tool_call', input: {} }));
    expect(recursive.code).toBe('VALIDATION');

    // The same reach from the person's side, recorded as theirs.
    const mine = await user('tool.call', {
      tool: 'artifact_create_draft',
      input: { type: 'note', title: 'Mine', payload: { markdown: 'By hand.' } },
    });
    expect(mine.revision.origin).toBe('user');
    expect((await refusal(user('tool.call', { tool: 'proposal_approve' }))).code).toBe(
      'CAPABILITY_DENIED',
    );
  });
});

describe('agent.activity', () => {
  it('lists the calls an agent made, failures included, without their arguments', async () => {
    expect(await user('agent.activity')).toEqual({ calls: [], sessions: [] });
    const drafted = await agent('artifact.create_draft', {
      type: 'note',
      title: 'Agent note',
      payload: { markdown: 'Secret words stay out of the ledger.' },
    });
    await refusal(agent('proposal.approve', { proposalId: drafted.artifact.id }));
    await agent('tool_call', { tool: 'work_status' });

    const activity = await user('agent.activity');
    expect(
      activity.calls.map((call: any) => [call.seq, call.tool, call.op, call.ok, call.code]),
    ).toEqual([
      [1, 'artifact.create_draft', 'artifact.create_draft', true, null],
      [2, 'proposal.approve', 'proposal.approve', false, 'CAPABILITY_DENIED'],
      [3, 'tool_call', 'work.status', true, null],
    ]);
    const first = activity.calls[0];
    expect(first).toMatchObject({
      projectId,
      sessionId: AGENT.sessionId,
      via: 'call',
      mutating: true,
      artifactIds: [drafted.artifact.id],
      notes: [],
    });
    expect(JSON.stringify(activity)).not.toContain('Secret words');
    expect(activity.sessions).toEqual([
      expect.objectContaining({
        sessionId: AGENT.sessionId,
        adapterId: 'direct',
        model: null,
        profile: 'standard',
        calls: 3,
        errors: 1,
      }),
    ]);
    const limited = await user('agent.activity', { limit: 1 });
    expect(limited.calls.map((call: any) => call.seq)).toEqual([3]);
    const earlier = await user('agent.activity', { beforeSeq: 3 });
    expect(earlier.calls.map((call: any) => call.seq)).toEqual([1, 2]);
  });

  it('streams each agent call on the agent-call channel', async () => {
    const seen: { name: string; data: any }[] = [];
    const stop = app.subscribe((event) => seen.push(event as { name: string; data: any }));
    const calls = () => seen.filter((event) => event.name === 'agent-call');
    await expect
      .poll(async () => {
        await agent('project_summary');
        return calls().length;
      })
      .toBeGreaterThan(0);
    stop();
    expect(calls()[0]!.data).toMatchObject({
      projectId,
      sessionId: AGENT.sessionId,
      tool: 'project_summary',
      op: 'project.summary',
      ok: true,
    });
    const recorded = (await user('agent.activity')).calls;
    for (const { data } of calls()) expect(recorded).toContainEqual(data);
  });
});

describe('review', () => {
  it('refuses an approval whose base was moved by a direct edit and keeps it pending', async () => {
    const note = await approvedNote('Plan', 'v1');
    const draft = await agent('artifact.update_draft', {
      artifactId: note.artifactId,
      baseRevisionId: note.revisionId,
      payload: { markdown: 'v2 by the agent' },
    });
    const proposal = await agent('proposal.submit', {
      changes: [
        {
          artifactId: note.artifactId,
          baseRevisionId: note.revisionId,
          newRevisionId: draft.revision.id,
          kind: 'baseline_update',
        },
      ],
      reason: 'agent edit',
    });
    const edited = await user('artifact.apply_edit', {
      artifactId: note.artifactId,
      baseRevisionId: note.revisionId,
      payloadPatch: { markdown: 'v1 edited by the person' },
      rationale: 'direct edit',
    });

    const read = await user('proposal.read', { proposalId: proposal.id });
    expect(read.proposal.changes[0].baseMoved).toBe(true);
    const stale = await refusal(user('proposal.approve', { proposalId: proposal.id }));
    expect(stale.code).toBe('REVISION_CONFLICT');
    expect(stale.message).toBe('Proposal base is stale');
    expect(stale.details).toEqual({
      artifactId: note.artifactId,
      currentRevisionId: edited.revision.id,
      baseRevisionId: note.revisionId,
      newRevisionId: draft.revision.id,
      proposalId: proposal.id,
    });
    expect((await user('proposal.read', { proposalId: proposal.id })).proposal.state).toBe(
      'pending',
    );
    const current = await user('artifact.read', { artifactId: note.artifactId });
    expect(current.revision.payload.markdown).toBe('v1 edited by the person');
  });

  it('a resubmitted change supersedes the proposal it replaces', async () => {
    const first = await agent('artifact.create_draft', {
      type: 'note',
      title: 'Test plan',
      payload: { markdown: 'first' },
    });
    const replaced = await agent('proposal.submit', {
      changes: [
        { artifactId: first.artifact.id, newRevisionId: first.revision.id, kind: 'new_artifact' },
      ],
      reason: 'first try',
    });
    const second = await agent('artifact.update_draft', {
      artifactId: first.artifact.id,
      draftRevisionId: first.revision.id,
      payload: { markdown: 'second' },
    });
    const replacement = await agent('proposal.submit', {
      changes: [
        { artifactId: first.artifact.id, newRevisionId: second.revision.id, kind: 'new_artifact' },
      ],
      reason: 'second try',
    });
    expect(replacement.supersedesProposalIds).toEqual([replaced.id]);

    const old = (await user('proposal.read', { proposalId: replaced.id })).proposal;
    expect(old).toMatchObject({ state: 'superseded', supersededBy: replacement.id });
    expect(old.impact.supersededByProposalId).toBe(replacement.id);
    const pending = await user('proposal.list', { state: 'pending' });
    expect(pending.proposals.map((p: any) => p.id)).toEqual([replacement.id]);
  });
});

describe('test results', () => {
  it("a person's result moves the approved test; an agent's is a draft on top of it", async () => {
    const test = await user('test.create_draft', {
      title: 'Ramp test',
      procedure: [{ step: 1, instruction: 'Climb the 15° ramp', expected: 'No slip' }],
    });
    await user('artifact.accept_draft', {
      artifactId: test.artifact.id,
      draftRevisionId: test.revision.id,
    });

    const byAgent = await agent('test.record_result', {
      artifactId: test.artifact.id,
      evidenceKind: 'measured',
      observation: 'Climbed at 0.6 m/s',
      result: 'passed',
    });
    expect(byAgent.approved).toBe(false);
    expect(byAgent.revision.reviewState).toBe('draft');
    let read = await user('artifact.read', { artifactId: test.artifact.id });
    expect(read.view.artifact.selectedRevisionId).toBe(test.revision.id);
    expect(read.revision.payload.results).toEqual([]);

    const byPerson = await user('test.record_result', {
      artifactId: test.artifact.id,
      evidenceKind: 'measured',
      observation: 'Climbed at 0.55 m/s with the pack fitted',
      result: 'passed',
    });
    expect(byPerson.approved).toBe(true);
    expect(byPerson.revision).toMatchObject({
      parentId: test.revision.id,
      origin: 'user',
      reviewState: 'approved',
    });
    read = await user('artifact.read', { artifactId: test.artifact.id });
    expect(read.view.artifact.selectedRevisionId).toBe(byPerson.revision.id);
    expect(read.revision.payload.results).toEqual([
      expect.objectContaining({
        observation: 'Climbed at 0.55 m/s with the pack fitted',
        result: 'passed',
        evidenceKind: 'measured',
        recordedBy: 'user',
      }),
    ]);
    // The new baseline retires the agent's open draft and carries it onto
    // itself as a new draft, so the agent's observation is still in review.
    expect(byPerson.carriedDraft.from).toBe(byAgent.revision.id);
    const history = await user('artifact.history', { artifactId: test.artifact.id });
    expect(history.revisions.map((revision: any) => [revision.id, revision.reviewState])).toEqual([
      [test.revision.id, 'superseded'],
      [byAgent.revision.id, 'superseded'],
      [byPerson.revision.id, 'approved'],
      [byPerson.carriedDraft.revisionId, 'draft'],
    ]);
    expect(history.revisions[1].payload.results[0].observation).toBe('Climbed at 0.6 m/s');
    expect(read.drafts.map((draft: any) => draft.id)).toEqual([byPerson.carriedDraft.revisionId]);
    expect(
      history.revisions[3].payload.results.map((result: any) => [
        result.observation,
        result.recordedBy,
      ]),
    ).toEqual([
      ['Climbed at 0.55 m/s with the pack fitted', 'user'],
      ['Climbed at 0.6 m/s', `agent:${AGENT.sessionId.slice(0, 8)}`],
    ]);
  });
});

describe('bom.changed', () => {
  const approve = async (type: string, title: string, payload: unknown) => {
    const draft = await agent('artifact.create_draft', { type, title, payload });
    const proposal = await agent('proposal.submit', {
      changes: [
        { artifactId: draft.artifact.id, newRevisionId: draft.revision.id, kind: 'new_artifact' },
      ],
      reason: `add ${title}`,
    });
    const before = (await user('project.changes_since', { seq: 0 })).events.length;
    await user('proposal.approve', { proposalId: proposal.id });
    const events = (await user('project.changes_since', { seq: 0 })).events.slice(before);
    return events.map((event: any) => event.type);
  };

  it('is announced only by an approval that changes what the BOM shows', async () => {
    const note = await approve('note', 'Bench notes', { markdown: 'Measured by hand.' });
    expect(note).toContain('proposal.resolved');
    expect(note).not.toContain('bom.changed');
    const component = await approve('component', 'Drive motor', { partNumber: 'DM-1' });
    expect(component).toContain('bom.changed');
  });
});

describe('engineering values', () => {
  const candidate = (title: string, mass: unknown, price: string | null) =>
    agent('component.add_candidate', {
      title,
      manufacturer: 'Example maker',
      partNumber: title.toUpperCase(),
      properties: { mass: { quantity: mass } },
      offer: {
        seller: 'Example shop',
        url: `https://example.com/${title}`,
        price: price ? { amount: price, currency: 'USD' } : null,
        quantityBasis: 1,
      },
    });
  const select = async (component: any, quantity: number) => {
    const proposed = await agent('component.propose_selection', {
      artifactId: component.artifact.id,
      bomLines: [{ quantity }],
      reason: 'chosen for the build',
    });
    await user('proposal.approve', { proposalId: proposed.proposal.id, rationale: 'ok' });
  };

  it('totals BOM mass across units and names what it cannot count', async () => {
    const servo = await candidate('servo', { value: 55, unit: 'g' }, '12.50');
    const frame = await candidate('frame', { value: 0.2, unit: 'kg' }, '30.00');
    const glue = await candidate(
      'glue',
      { unknown: true, reason: 'not on the product page' },
      null,
    );
    await select(servo, 2);
    await select(frame, 1);
    await select(glue, 1);

    const bom = await user('bom.read');
    // The total takes the unit of the first line with a known mass; lines are
    // ordered by id, so that is either the grams or the kilograms line.
    const known = bom.totals.knownMass;
    expect(['g', 'kg']).toContain(known.unit);
    expect(known.unit === 'g' ? known.value : known.value * 1000).toBeCloseTo(310, 9);
    expect(bom.totals.missingMassCount).toBe(1);
    expect(bom.totals.unknownMass).toEqual([
      {
        lineId: expect.stringMatching(UUID),
        componentTitle: 'glue',
        reason: 'mass: not on the product page',
      },
    ]);
    expect(bom.totals.cost).toEqual([{ amount: '55.00', currency: 'USD' }]);
    expect(bom.totals.unknownCost).toEqual([
      expect.objectContaining({ componentTitle: 'glue', reason: 'the offer records no price' }),
    ]);
    const glueLine = bom.lines.find((line: any) => line.componentTitle === 'glue');
    expect(glueLine).toMatchObject({ unitMass: null, lineMassKnown: false, lineTotal: null });
  });

  it('reports calculation results in the unit their dimension has', async () => {
    const run = (expression: string, inputs: [string, number, string][], outputUnit?: string) =>
      agent('calculation.run', {
        expression,
        title: expression,
        inputs: inputs.map(([name, value, unit]) => ({ name, quantity: { value, unit } })),
        ...(outputUnit ? { outputUnit } : {}),
        submitForReview: false,
      }).then((result) => result.revision.payload.result.quantity);
    expect(
      await run('voltage * current', [
        ['voltage', 12, 'V'],
        ['current', 2, 'A'],
      ]),
    ).toEqual({ value: 24, unit: 'W' });
    expect(
      await run('stall / required', [
        ['stall', 0.5, 'N*m'],
        ['required', 0.2, 'N*m'],
      ]),
    ).toEqual({ value: 2.5, unit: '1' });
    expect(
      await run('a + b', [
        ['a', 500, 'g'],
        ['b', 250, 'g'],
      ]),
    ).toEqual({ value: 750, unit: 'g' });
    expect(await run('ceil(x)', [['x', 12.3, 'mm']])).toEqual({ value: 13, unit: 'mm' });

    // Energy and torque share a dimension: the unit is never guessed.
    const work: [string, number, string][] = [
      ['force', 10, 'N'],
      ['distance', 2, 'm'],
    ];
    const ambiguous = await refusal(run('force * distance', work));
    expect(ambiguous.code).toBe('INVALID_UNITS');
    expect(ambiguous.details).toEqual({ outputUnits: ['J', 'N*m'] });
    expect(await run('force * distance', work, 'J')).toEqual({ value: 20, unit: 'J' });
  });

  it('assigns wiring connection ids and component revisions on the server', async () => {
    const supply = await candidate('supply', { value: 20, unit: 'g' }, '4.00');
    const servo = await candidate('servo', { value: 55, unit: 'g' }, '12.50');
    await select(supply, 1);
    await select(servo, 1);
    const approved = async (component: any) =>
      (await user('artifact.read', { artifactId: component.artifact.id })).view.artifact
        .selectedRevisionId as string;

    const wiring = await agent('artifact.create_draft', {
      type: 'wiring',
      title: 'Servo power',
      payload: {},
    });
    await agent('wiring.set_pins', {
      artifactId: wiring.artifact.id,
      pins: [
        { componentArtifactId: supply.artifact.id, pin: '5V', type: 'power' },
        { componentArtifactId: supply.artifact.id, pin: 'GND', type: 'ground' },
        { componentArtifactId: servo.artifact.id, pin: 'VCC', type: 'power' },
        { componentArtifactId: servo.artifact.id, pin: 'GND', type: 'ground' },
      ],
    });
    const connected = await agent('wiring.set_connections', {
      artifactId: wiring.artifact.id,
      connections: [
        {
          from: { componentArtifactId: supply.artifact.id, pin: '5V' },
          to: { componentArtifactId: servo.artifact.id, pin: 'VCC' },
          voltage: { value: 5, unit: 'V' },
          signalRole: 'power',
        },
        {
          from: { componentArtifactId: supply.artifact.id, pin: 'GND' },
          to: { componentArtifactId: servo.artifact.id, pin: 'GND' },
          signalRole: 'ground',
        },
      ],
    });
    const connections = connected.payload.connections;
    expect(connections).toHaveLength(2);
    expect(new Set(connections.map((connection: any) => connection.id)).size).toBe(2);
    for (const connection of connections) {
      expect(connection.id).toMatch(UUID);
      expect(connection.from.componentRevisionId).toBe(await approved(supply));
      expect(connection.to.componentRevisionId).toBe(await approved(servo));
    }
    expect(connections[0].voltage).toEqual({ value: 5, unit: 'V' });
    const validated = await agent('wiring.validate', { artifactId: wiring.artifact.id });
    expect(validated.revisionId).toBe(connected.id);
    expect(validated.findings).toEqual([]);
  });
});
