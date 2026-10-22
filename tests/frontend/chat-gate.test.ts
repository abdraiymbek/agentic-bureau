import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatGate, ChatTurn } from '@omenflow/contracts';
import { CHAT_CONTINUE_TEXT } from '@omenflow/contracts/chat';
import {
  ContinuationMessage,
  NoToolCalls,
  WorkNotFinished,
  autoCaption,
  continuedCaption,
} from '../../apps/desktop/src/renderer/chat/InlineGate';
import { modelKey, modelMismatch, turnModel } from '../../apps/desktop/src/renderer/chat/model';
import { RecordedCall } from '../../apps/desktop/src/renderer/chat/RecordedCall';
import type { AgentCallRecord } from '@omenflow/contracts';

const gate = (change: Partial<ChatGate> = {}): ChatGate => ({
  ready: false,
  summary: '1 draft is empty. 1 component has no source.',
  blockers: 2,
  advice: 0,
  waiting: 0,
  outstanding: [
    {
      kind: 'empty_payload',
      severity: 'blocker',
      artifactId: 'a',
      title: 'Test notes',
      detail: 'Draft r1 has no content yet.',
      tool: 'artifact_update_draft',
    },
    {
      kind: 'component_unsourced',
      severity: 'blocker',
      artifactId: 'b',
      title: 'Steering servo',
      detail: 'Draft r1 cites no source for its data.',
      tool: null,
    },
  ],
  more: 0,
  sessionIds: ['s1'],
  calls: 3,
  inScope: 2,
  jobsRunning: 0,
  checkedAt: '2026-10-21T10:00:00.000Z',
  auto: { state: 'off' },
  ...change,
});
const turn = (change: Partial<ChatTurn> = {}): ChatTurn => ({
  requestId: 'r2',
  text: CHAT_CONTINUE_TEXT,
  response: 'Done.',
  adapterId: 'claude-code',
  sessionId: 's2',
  state: 'completed',
  error: null,
  createdAt: '2026-10-21T10:01:00.000Z',
  ...change,
});
const card = (props: Partial<Parameters<typeof WorkNotFinished>[0]> = {}) =>
  renderToStaticMarkup(
    React.createElement(WorkNotFinished, {
      gate: gate(),
      latest: true,
      blocked: false,
      onContinue: () => {},
      onEdit: () => {},
      ...props,
    }),
  );
const continueButton = /<button[^>]*>(?:(?!<\/button>).)*Continue<\/span><\/button>/;

describe('the completion gate record on a turn', () => {
  it('names the host as its author and shows the summary, labelled items and their tools', () => {
    const html = card();
    expect(html).toContain('Completion gate · work_status, recorded by Omen Flow');
    expect(html).toContain('Work not finished');
    expect(html).toContain('2 blockers');
    expect(html).toContain('1 draft is empty. 1 component has no source.');
    expect(html).toContain('Empty');
    expect(html).toContain('No source');
    expect(html).toContain('<code>artifact_update_draft</code>');
    expect(html).toContain('Needs you');
    expect(html).toContain('2026-10-21T10:00:00.000Z');
    expect(card({ gate: gate({ more: 4 }) })).toContain('4 more in work_status');
    expect(card({ gate: gate({ blockers: 1 }) })).toContain('1 blocker<');
  });

  it('offers Continue only on the latest turn, and waits while busy', () => {
    expect(card()).toMatch(continueButton);
    expect(card().match(continueButton)![0]).not.toContain('disabled');
    expect(card({ blocked: true }).match(continueButton)![0]).toContain('disabled');
    expect(card()).toContain('Edit request');
    // An earlier turn's record collapses to one dated line.
    const earlier = card({ latest: false });
    expect(earlier).not.toContain('Work not finished</h2>');
    expect(earlier).not.toMatch(continueButton);
    expect(earlier).toContain('Work not finished when this response ended');
    expect(earlier).toContain('<time');
    expect(earlier).not.toContain('below.');
  });

  it('says on a continued turn who continued it, as the conversation shows it', () => {
    // A continuation is always added after the turn it continues, so a continued turn is never
    // the latest one: its record is the collapsed line.
    const continued = (automatic: boolean) =>
      card({
        latest: false,
        continuedBy: turn({ requestId: 'r2', continues: { requestId: 'r1', automatic } }),
      });
    expect(continued(true)).toContain('Omen Flow continued once, automatically, below.');
    expect(continued(false)).toContain('You continued this below.');
    for (const html of [continued(true), continued(false)]) {
      expect(html).not.toMatch(continueButton);
      expect(html).toContain('Work not finished when this response ended');
    }
    expect(continuedCaption(turn({ continues: { requestId: 'r1', automatic: true } }))).toBe(
      'Omen Flow continued once, automatically, below.',
    );
    expect(continuedCaption(turn({ continues: { requestId: 'r1', automatic: false } }))).toBe(
      'You continued this below.',
    );
  });

  it('says what Omen Flow did about the unfinished work', () => {
    const skipped = (reason: string, detail?: string) =>
      gate({
        auto: { state: 'skipped', reason, ...(detail ? { detail } : {}) } as ChatGate['auto'],
      });
    expect(autoCaption(gate())).toBeNull();
    for (const [reason, words] of [
      ['needs_person', 'need you or facts from outside the project'],
      ['already_continued', 'Omen Flow already continued once after your message'],
      ['jobs_running', 'a job was still running'],
      ['busy', 'another agent was working in this project'],
      ['prompt_limit', 'this conversation is too long'],
      ['project_closed', 'the project was closed'],
      ['read_only', 'the project is read-only'],
    ] as const) {
      expect(autoCaption(skipped(reason))).toContain(words);
      expect(card({ gate: skipped(reason) })).toContain(words);
    }
    expect(autoCaption(skipped('agent_unavailable', 'Executable not found: /x/codex'))).toBe(
      'Not continued automatically: Executable not found: /x/codex',
    );
    // A state a later host records reads as nothing, never as something it is not.
    expect(
      autoCaption(gate({ auto: { state: 'queued' } as unknown as ChatGate['auto'] })),
    ).toBeNull();
    expect(card({ gate: gate({ jobsRunning: 1 }) })).toContain('A job was still running');
    expect(card({ refused: 'Only the latest turn of a conversation can be continued' })).toContain(
      'Only the latest turn of a conversation can be continued',
    );
  });

  it('labels a response that called no tool, and a continuation by who sent it', () => {
    const note = renderToStaticMarkup(
      React.createElement(NoToolCalls, { latest: true, blocked: false, onContinue: () => {} }),
    );
    expect(note).toContain('Recorded by Omen Flow');
    expect(note).toContain('No Omen Flow tools were called in this response.');
    expect(note).toMatch(continueButton);
    expect(
      renderToStaticMarkup(
        React.createElement(NoToolCalls, { latest: false, blocked: false, onContinue: () => {} }),
      ),
    ).not.toMatch(continueButton);
    const automatic = renderToStaticMarkup(
      React.createElement(ContinuationMessage, { text: CHAT_CONTINUE_TEXT, automatic: true }),
    );
    expect(automatic).toContain('aria-label="Sent by Omen Flow"');
    expect(automatic).toContain(
      'Sent by Omen Flow, once, because work_status reported unfinished work',
    );
    expect(automatic).toContain('is-automatic');
    const yours = renderToStaticMarkup(
      React.createElement(ContinuationMessage, { text: CHAT_CONTINUE_TEXT, automatic: false }),
    );
    expect(yours).toContain('You asked the agent to continue');
    expect(yours).not.toContain('is-automatic');
  });

  it('never shows money or a cost', () => {
    for (const html of [card(), card({ latest: false })]) {
      expect(html).not.toContain('$');
      expect(html.toLowerCase()).not.toContain('cost');
    }
  });
});

describe("a turn's recorded activity", () => {
  const call = (change: Partial<AgentCallRecord> = {}): AgentCallRecord => ({
    seq: 7,
    at: '2026-10-21T10:00:30.000Z',
    projectId: 'p',
    sessionId: 's2',
    tool: 'cad_write_source',
    op: 'cad.write_source',
    via: 'mcp',
    ok: true,
    code: null,
    message: null,
    durationMs: 812,
    mutating: true,
    artifactIds: ['part-000001'],
    notes: [],
    ...change,
  });
  const row = (record: AgentCallRecord) =>
    renderToStaticMarkup(React.createElement(RecordedCall, { call: record, onInspect: () => {} }));
  const check = (verificationStatus: string, committed: boolean) => ({
    tool: 'cad_check',
    op: 'cad.check',
    ok: true,
    verificationStatus,
    committed,
    passed: verificationStatus === 'passed' ? 3 : 1,
    total: 3,
  });

  it('shows a write whose check failed in the warning tone, with the check', () => {
    const failed = row(call({ alsoRan: [check('failed', false)] }));
    expect(failed).toContain('tone-warn');
    expect(failed).not.toContain('tone-ok');
    expect(failed).toContain('Returned');
    expect(failed).toContain(
      'Host also ran: cad_check: Check failed, 1 of 3 assertions pass, not committed',
    );
    expect(failed).toContain('chat-call-also warn');
    const partial = row(call({ alsoRan: [check('partial', true)] }));
    expect(partial).toContain('tone-warn');
    expect(partial).toContain('Partly verified');
  });

  it('keeps a call whose check passed, or that ran nothing else, in the ok tone', () => {
    const passed = row(
      call({
        alsoRan: [
          check('passed', true),
          { tool: 'work_status', op: 'work.status', ok: true, scope: 'session', ready: true },
        ],
      }),
    );
    expect(passed).toContain('tone-ok');
    expect(passed).toContain('Host also ran: cad_check: Verified, 3 of 3 assertions pass');
    expect(passed).toContain('Host also ran: work_status (this session): ready');
    expect(passed).not.toContain('chat-call-also warn');
    const plain = row(call());
    expect(plain).toContain('tone-ok');
    expect(plain).not.toContain('Host also ran');
    expect(plain).toContain('Inspect object 000001');
  });

  it("says a continuation's work status read the turn it continues", () => {
    const continued = row(
      call({
        alsoRan: [
          check('passed', true),
          {
            tool: 'work_status',
            op: 'work.status',
            ok: true,
            scope: 'session',
            ready: false,
            blockers: 1,
            sessions: 2,
          },
        ],
      }),
    );
    expect(continued).toContain(
      'Host also ran: work_status (this turn and the one it continues): not ready, 1 blocker',
    );
    expect(continued).not.toContain('(this session)');
  });

  it('shows a failed call as failed, with its message', () => {
    const failed = row(
      call({ ok: false, code: 'VALIDATION', message: 'Invalid input for cad_write_source' }),
    );
    expect(failed).toContain('tone-err');
    expect(failed).toContain('Failed');
    expect(failed).toContain('Invalid input for cad_write_source');
  });
});

describe('the model a turn ran', () => {
  it('prefers what the CLI reported over what Omen Flow passed', () => {
    expect(turnModel(turn())).toBeNull();
    expect(turnModel(turn({ model: 'claude-haiku-5-5' }))).toBe('claude-haiku-5-5');
    expect(
      turnModel(turn({ model: 'claude-haiku-5-5', resolvedModel: 'claude-haiku-5-5-20261001' })),
    ).toBe('claude-haiku-5-5-20261001');
  });

  it('warns only when a full id was passed and another model ran', () => {
    const mismatch = (model: string | undefined, resolvedModel: string | undefined) =>
      modelMismatch(
        turn({ ...(model ? { model } : {}), ...(resolvedModel ? { resolvedModel } : {}) }),
      );
    expect(mismatch('haiku', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(mismatch('claude-haiku-5-5', 'claude-haiku-5-5')).toBe(false);
    expect(mismatch('claude-haiku-5-5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(mismatch('claude-opus-5-5', 'us.anthropic.claude-opus-5-5')).toBe(false);
    expect(mismatch('claude-opus-5-5', 'us.anthropic.claude-opus-5-5-20260101-v1:0')).toBe(false);
    expect(mismatch('claude-opus-5-5', 'claude-opus-5-5@20260101')).toBe(false);
    expect(mismatch('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(false);
    expect(mismatch('claude-opus-5', 'claude-opus-5-5')).toBe(true);
    expect(mismatch('claude-sonnet-5-5', 'claude-sonnet-5')).toBe(true);
    expect(mismatch('claude-haiku-5-5', undefined)).toBe(false);
    expect(mismatch(undefined, 'claude-haiku-5-5')).toBe(false);
    expect(modelKey(' Claude-Fable-5-1-20261001 ')).toBe('claude-fable-5-1');
  });
});
