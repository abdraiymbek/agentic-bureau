import React from 'react';
import { ArrowRight } from '../../ui/icons';
import type { AssemblyPayload } from '@bureau/contracts';
import { Empty, Notice } from '../../ui/kit';
import { ObjectLink, Steps, type StageProps } from './shared';

export function AssemblyStage({ view }: StageProps) {
  const p = (view.revision?.payload ?? {}) as Partial<AssemblyPayload>;
  if (!p.steps?.length)
    return (
      <Empty
        title="No steps recorded"
        body="Ask your agent to draft the build sequence, tools, and calibration."
      />
    );
  return (
    <div className="doc">
      <Steps
        steps={p.steps.map((s, i) => ({
          n: s.order,
          key: `${s.order}-${i}`,
          body: (
            <>
              <p>{s.instruction}</p>
              {s.tools.length > 0 && <small>Tools · {s.tools.join(', ')}</small>}
              {s.calibration && <Notice>Calibration · {s.calibration}</Notice>}
              {s.componentRefs.length > 0 && (
                <div className="chips">
                  {s.componentRefs.map((id) => (
                    <ObjectLink key={id} id={id} className="chip" glyph>
                      <ArrowRight size={11} />
                    </ObjectLink>
                  ))}
                </div>
              )}
            </>
          ),
        }))}
      />
    </div>
  );
}
