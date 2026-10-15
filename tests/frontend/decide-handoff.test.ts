import { describe, expect, it } from 'vitest';
import { handoffText, rebaseText, recordOf } from '../../apps/desktop/src/renderer/decide/handoff';
import { carrierDetail, detail, ids } from './decide-fixtures';

describe('handoff to the agent', () => {
  it('states the decision, the rationale, the full ids and the next step', () => {
    const text = handoffText([recordOf(detail(), 'approved', '  Sensor package confirmed.  ', [])]);
    expect(text).toBe(
      [
        'Omen Flow: the person recorded a review decision.',
        '',
        `1. Approved proposal ${ids.p1} ("Increase payload capacity to 500 g").`,
        '   Rationale: "Sensor package confirmed."',
        `   requirement "Payload capacity" (artifact ${ids.req}, revision r2 ${ids.r2})`,
        '   1 downstream object may now be out of date.',
        '',
        'Next:',
        '- Approved revisions are now the baseline: build on them. Call work_status to see what is still unfinished, including objects the approval marked out of date.',
        `Full record: proposal_read {"proposalId":"${ids.p1}"}; call it through tool_call if proposal_read is not in your tool list.`,
      ].join('\n'),
    );
  });

  it('gives each outcome its own next step, once, and names accepted scopes', () => {
    const text = handoffText([
      recordOf(detail(), 'changes_requested', 'Use 480 g.', []),
      recordOf(detail({ proposal: { id: ids.p2 } }), 'rejected', '', []),
      recordOf(detail({ proposal: { id: ids.p3 } }), 'approved', 'ok', ['Camera tray']),
    ]);
    expect(text).toContain('the person recorded 3 review decisions.');
    expect(text).toContain(`1. Asked for changes on proposal ${ids.p1}`);
    expect(text).toContain('   Rationale: none given.');
    expect(text).toContain('   Verification scope accepted for: Camera tray.');
    expect(text).toContain('submit a replacement with proposal_submit for the same objects');
    expect(text).toContain('Do not resubmit a rejected change as it was.');
    expect(text.match(/^- /gm)).toHaveLength(3);
    expect(text).toContain('(one call per proposal id above)');
  });

  it('names the kept baseline, not the retired copy, for an approved bill of materials edit', () => {
    const text = handoffText([recordOf(carrierDetail(), 'approved', '', [])]);
    expect(text).toContain(
      `   component "Motor" (artifact ${ids.req}, bill of materials edit; the baseline stays revision r1 ${ids.r1})`,
    );
    expect(text).not.toContain(ids.r2);
    expect(text).not.toContain('may now be out of date');
  });

  it('asks for a rebase with the revisions that moved', () => {
    expect(
      rebaseText(detail(), [
        { title: 'Payload capacity', artifactId: ids.req, baseSeq: 1, currentSeq: 3 },
      ]),
    ).toBe(
      `Proposal ${ids.p1} ("Increase payload capacity to 500 g") cannot be approved because its base moved: Payload capacity (artifact ${ids.req}) was proposed on r1 but its baseline is now r3. Rebuild the change on the current baseline and submit it again with proposal_submit for the same objects; the new proposal supersedes this one. Then call work_status.`,
    );
  });
});
