import React, { useContext, useState } from 'react';
import { ArrowRight, Play } from '../ui/icons';
import { useStore } from '../store';
import { useAgentUi } from '../shell/agent/agent-store';
import { Button, TypeGlyph } from '../ui/kit';
import { FlowMap } from './FlowMap';
import { ProjectHead } from './flow/chrome';
import { NeedsYou } from './flow/NeedsYou';

/** The Flow lens: the map of every object, with what needs a human floating over it. */
export default function FlowLens() {
  const projectId = useStore((s) => s.projectId);
  const empty = useStore((s) => s.artifacts.length === 0);
  const head = useContext(ProjectHead);
  const [island, setIsland] = useState<HTMLElement | null>(null);
  // The frame shows the project loading until its first load is complete (App, `ProjectLoading`),
  // so an empty list here is an empty project.
  if (empty) return <Beginning />;
  return (
    <>
      <NeedsYou onRest={setIsland} />
      <FlowMap key={projectId} head={head} island={island} />
    </>
  );
}

/** An empty project is a starting line, not an empty dashboard. */
function Beginning() {
  const session = useStore((s) => s.session);
  const project = useStore((s) => s.project);
  const askAbout = useStore((s) => s.askAbout);
  const go = useStore((s) => s.go);
  const pane = useAgentUi((s) => s.pane);
  // The conversation takes a request without a running session; the terminal needs its CLI.
  const ready = session?.state === 'running' || pane === 'conversation';
  const prompt = project?.intent
    ? `Read the project intent and draft the first requirements with measurable targets and acceptance criteria. Intent: ${project.intent}`
    : 'Help me define this project. Ask me what it must do, then draft requirements with measurable targets.';
  return (
    <div className="beginning">
      <div className="beginning-flow" aria-hidden="true">
        {(['requirement', 'component', 'mechanical', 'calculation'] as const).map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 && <span className="beginning-link" />}
            <span className="beginning-node">
              <TypeGlyph type={t} size={14} />
              {['Intent', 'Parts', 'Design', 'Evidence'][i]}
            </span>
          </React.Fragment>
        ))}
      </div>
      <h2>Start with what it must do.</h2>
      <p>
        Your agent drafts requirements, parts, models, and calculations. They appear here as one
        connected flow — and none become the design until you approve them.
      </p>
      {ready ? (
        <Button
          variant="primary"
          onClick={() => askAbout(prompt)}
          trailing={<ArrowRight size={14} />}
        >
          Draft first requirements
        </Button>
      ) : (
        <Button
          variant="signal"
          icon={<Play size={13} weight="fill" />}
          onClick={() => go({ level: 'agent' })}
        >
          Open the agent
        </Button>
      )}
    </div>
  );
}
