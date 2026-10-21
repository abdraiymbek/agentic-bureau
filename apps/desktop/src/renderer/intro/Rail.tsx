/** The introduction's progress: one causal rail, left to right, lit as far as you have come. */
import React from 'react';
import { SCENES, sceneIndex, type SceneId } from './model';

export function Rail({ current, onJump }: { current: SceneId; onJump: (id: SceneId) => void }) {
  const at = sceneIndex(current);
  return (
    <nav className="intro-rail" aria-label="Introduction progress">
      <ol>
        {SCENES.map((s, i) => (
          <li key={s.id} data-state={i < at ? 'done' : i === at ? 'current' : 'ahead'}>
            <button
              type="button"
              onClick={() => onJump(s.id)}
              aria-current={i === at ? 'step' : undefined}
              aria-label={`${s.short}, ${i + 1} of ${SCENES.length}`}
            >
              <i className="intro-rail-dot" aria-hidden="true" />
              <span>{s.short}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
