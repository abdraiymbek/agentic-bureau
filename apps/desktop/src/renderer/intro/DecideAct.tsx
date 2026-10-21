/**
 * Level 2, played: one proposal, its changes in the centre, its impact on the right, the
 * decision pinned below. The person approves it themselves; nothing here reaches a record.
 */
import React, { useState } from 'react';
import { ArrowRight, GitBranch } from '@phosphor-icons/react';
import { Button, State, Tooltip, TypeGlyph } from '../ui/kit';

const AFFECTED: [type: string, title: string][] = [
  ['mechanical', 'Camera tray'],
  ['calculation', 'Rover mass budget'],
  ['calculation', 'Wheel torque at 15° incline'],
  ['test', 'Ramp traverse with payload'],
];

export function DecideAct({
  approved,
  leaving,
  onApprove,
}: {
  approved: boolean;
  /** The impact has started travelling the map: the proposal gives way to it. */
  leaving: boolean;
  onApprove: () => void;
}) {
  const [rationale, setRationale] = useState('');
  const stagger = (i: number) => ({ '--i': i }) as React.CSSProperties;
  return (
    <div
      className="intro-decide"
      data-leaving={leaving ? '' : undefined}
      data-approved={approved ? '' : undefined}
    >
      <section className="intro-dstage">
        <div className="intro-dtop" style={stagger(0)}>
          <GitBranch size={13} /> Proposal 1 of 1
        </div>
        <h2 className="intro-dtitle" style={stagger(1)}>
          Increase payload capacity to 500 g
        </h2>
        <div className="row intro-dmeta" style={stagger(2)}>
          {approved ? (
            <State state="accepted" dimension="proposal" />
          ) : (
            <State state="pending" dimension="proposal" />
          )}
          <span className="dim">Proposed by user · 1 change</span>
        </div>
        <div className="intro-dchange" style={stagger(3)}>
          <span className="intro-dobject">
            <TypeGlyph type="requirement" /> Payload capacity
          </span>
          <span className="intro-dpill">baseline update</span>
          <span className="mono dim">r1 → r2</span>
        </div>
        <div className="intro-diff" style={stagger(4)}>
          <span className="intro-diff-key">target</span>
          <span className="mono intro-diff-old">0.3 kg</span>
          <ArrowRight size={13} aria-label="becomes" />
          <span className="mono intro-diff-new">0.5 kg</span>
        </div>
        {approved && (
          <p className="intro-dnotice motion-rise" role="status">
            <strong>Approved as the new baseline.</strong> Four dependents are marked out of date.
            Approval does not mean validated.
          </p>
        )}
        <div className="intro-dbar" style={stagger(5)}>
          <textarea
            className="intro-drationale"
            aria-label="Rationale"
            placeholder="Why this is right for the design (optional, kept in the record)"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            disabled={approved}
            rows={1}
          />
          {approved ? (
            <span className="intro-dbar-done">Recorded here only: this is the introduction.</span>
          ) : (
            <div className="row intro-dbuttons">
              <Tooltip label="Approve to see the impact travel; nothing here is recorded">
                <Button variant="ghost" size="sm" aria-disabled="true">
                  Reject
                </Button>
              </Tooltip>
              <Tooltip label="Approve to see the impact travel; nothing here is recorded">
                <Button size="sm" aria-disabled="true">
                  Request changes
                </Button>
              </Tooltip>
              <Button variant="primary" size="sm" shortcut="⌘↵" onClick={onApprove}>
                Approve changes
              </Button>
            </div>
          )}
        </div>
      </section>
      <aside className="intro-drail">
        <h3 style={stagger(1)}>
          Would affect <span className="num">4</span>
        </h3>
        {AFFECTED.map(([type, title], i) => (
          <div className="intro-arow" key={title} style={stagger(2 + i)}>
            <span className="intro-conn" />
            <TypeGlyph type={type} />
            <div>
              <strong>{title}</strong>
              {approved ? (
                <State state="stale" dimension="freshness" />
              ) : (
                <small>may need revisiting</small>
              )}
            </div>
          </div>
        ))}
        <div className="intro-means" style={stagger(6)}>
          <h3>What approval means</h3>
          <p>
            Approval updates the baseline and marks dependents for revisiting. It does not mean the
            design is validated or fit to build.
          </p>
        </div>
      </aside>
    </div>
  );
}
