/**
 * The rover's causal map, drawn the way the Flow lens draws it: columns by layer, links left to
 * right, one lit thread. It draws itself in, lights the payload thread, follows the pointer
 * while it is interactive, and after the decision shows the impact travelling the same links.
 */
import React, { useMemo, useState } from 'react';
import { State, TypeGlyph } from '../ui/kit';
import {
  GROUPS,
  HEADS,
  LINKS,
  NODES,
  ORIGIN,
  WORLD,
  downstream,
  type MapLabel,
  type Thread,
} from './rover';

export type MapPhase = 'hidden' | 'drawing' | 'lit' | 'focus' | 'decide' | 'impact' | 'backdrop';

const IMPACT: Thread = downstream(ORIGIN);

function Label({ label, className }: { label: MapLabel; className: string }) {
  return (
    <div
      className={className}
      style={{ left: label.x, top: label.y, '--d': `${label.delay}s` } as React.CSSProperties}
    >
      {label.label}
      <span className="num">{label.count}</span>
    </div>
  );
}

export function MapScene({ phase, reduced }: { phase: MapPhase; reduced: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const interactive = phase === 'lit';
  const litFrom =
    phase === 'hidden' || phase === 'drawing' ? null : (interactive && hover) || ORIGIN;
  const thread = useMemo(() => (litFrom ? downstream(litFrom) : null), [litFrom]);
  const impact = phase === 'impact' || phase === 'backdrop';
  const pulses = interactive && !reduced && thread;

  return (
    <div
      className="intro-map"
      data-phase={phase}
      style={{ width: WORLD.width, height: WORLD.height }}
      aria-hidden="true"
    >
      <svg
        className="intro-links"
        width={WORLD.width}
        height={WORLD.height}
        viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
      >
        <g className="intro-links-base">
          {LINKS.map((l) => (
            <path
              key={l.key}
              d={l.d}
              pathLength={1}
              style={{ '--d': `${l.delay}s` } as React.CSSProperties}
              data-thread={thread?.links.has(l.key) ? '' : undefined}
              data-dim={thread && !thread.links.has(l.key) ? '' : undefined}
            />
          ))}
        </g>
        {impact && (
          <g className="intro-links-impact">
            {LINKS.filter((l) => IMPACT.links.has(l.key)).map((l) => (
              <path
                key={l.key}
                d={l.d}
                pathLength={1}
                style={{ '--w': IMPACT.wave[l.key] ?? 0 } as React.CSSProperties}
              />
            ))}
          </g>
        )}
        {pulses && (
          <g className="intro-pulses">
            {LINKS.filter((l) => thread.links.has(l.key)).map((l, i) => (
              <circle key={l.key} r={4} className="intro-pulse">
                <animateMotion
                  dur="1.9s"
                  begin={`${(i * 0.3) % 1.2}s`}
                  repeatCount="indefinite"
                  path={l.d}
                />
              </circle>
            ))}
          </g>
        )}
      </svg>
      {HEADS.map((h) => (
        <Label key={h.label} label={h} className="intro-map-head" />
      ))}
      {GROUPS.map((g) => (
        <Label key={`${g.label}-${g.y}`} label={g} className="intro-map-group" />
      ))}
      {NODES.map((n) => {
        const onThread = thread?.nodes.has(n.id);
        const stale = impact && n.id !== ORIGIN && IMPACT.nodes.has(n.id);
        const mark =
          n.id === ORIGIN && !impact ? 'warn' : n.id === 'wheel' ? 'ring' : stale ? 'warn' : null;
        return (
          <div
            key={n.id}
            className="map-node intro-node"
            style={
              {
                left: n.x,
                top: n.y,
                '--d': `${n.delay}s`,
                '--w': IMPACT.wave[n.id] ?? 0,
              } as React.CSSProperties
            }
            data-thread={onThread ? (n.id === litFrom ? 'origin' : '') : undefined}
            data-dim={thread && !onThread ? '' : undefined}
            data-stale={stale ? '' : undefined}
            onPointerEnter={() => interactive && setHover(n.id)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="intro-node-in">
              <TypeGlyph type={n.type} />
              <span className="map-node-title">{n.label}</span>
              {mark && <i className="intro-mark" data-tone={mark} />}
            </span>
            {stale && (
              <span className="intro-peek">
                <State state="stale" dimension="freshness" />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
