/**
 * Level 1, played: one object on its stage between the rails of what it depends on and what it
 * affects. The camera tray renders live; its dimensions and parameters arrive as they would.
 */
import React from 'react';
import { ArrowsOut, BoundingBox, CaretDown, Cube, GridFour } from '@phosphor-icons/react';
import { lazyView } from '../lib/lazy-view';
import { Facts, State, TypeGlyph } from '../ui/kit';
import { typed, useProgress } from './motion';

const TrayScene = lazyView(() => import('./TrayScene').then((m) => m.default));

export const preloadTray = () => TrayScene.preload();

const DIMS = '62.00 × 14.50 × 44.00 mm';
const PARAMS: [name: string, value: number, digits: number, words: string][] = [
  ['tray_width', 62, 0, 'Payload bay width'],
  ['tray_depth', 44, 0, 'Front-to-back depth'],
  ['tray_thick', 2.5, 1, 'Plate thickness'],
];

export function ObjectAct({
  theme,
  reduced,
  origin,
}: {
  theme: 'dark' | 'light';
  reduced: boolean;
  /** Where on the stage the zoom grows from: the node that was focused. */
  origin: string;
}) {
  const k = useProgress(true, 1100, 900, reduced);
  const stagger = (i: number) => ({ '--i': i }) as React.CSSProperties;
  return (
    <div
      className="intro-object"
      style={{ '--zoom-origin': origin } as React.CSSProperties}
      aria-label="The Camera tray on its stage"
    >
      <aside className="intro-orail" style={stagger(0)}>
        <h3>
          Depends on <span className="num">2</span>
        </h3>
        <div className="intro-rlink" style={stagger(1)}>
          <TypeGlyph type="requirement" />
          <div>
            <strong>Payload capacity</strong>
            <small>tray sized to payload requirement · pinned</small>
          </div>
          <i className="intro-mark" data-tone="warn" />
          <span className="intro-conn" />
        </div>
        <div className="intro-rlink" style={stagger(2)}>
          <TypeGlyph type="component" />
          <div>
            <strong>Raspberry Pi Camera Module 3 Wide</strong>
            <small>camera slot dimensions · pinned</small>
          </div>
          <span className="intro-conn" />
        </div>
        <h3 style={stagger(3)}>Record</h3>
        <div style={stagger(4)}>
          <Facts
            rows={[
              ['Origin', 'user'],
              ['Recorded', '1 min ago'],
              ['Material', 'PLA · assumption'],
              ['Identifier', <span className="mono">e7da2b35</span>],
            ]}
          />
        </div>
      </aside>

      <section className="intro-ostage" style={stagger(0)}>
        <div className="intro-crumb" style={stagger(1)}>
          <Cube size={13} /> Mechanical <span>›</span> payload
        </div>
        <h2 className="intro-otitle" style={stagger(2)}>
          Camera tray
        </h2>
        <div className="row intro-ostates" style={stagger(3)}>
          <State state="approved" dimension="review" />
          <State state="current" dimension="freshness" />
          <span className="dim">Revision 2</span>
        </div>
        <div className="intro-well" style={stagger(4)}>
          <React.Suspense fallback={null}>
            <TrayScene.Component theme={theme} reduced={reduced} />
          </React.Suspense>
          <div className="island intro-well-island intro-well-rev">
            Revision <strong>r2 · Baseline</strong>
            <CaretDown size={11} />
          </div>
          <div className="island intro-well-island intro-well-tools" aria-hidden="true">
            <ArrowsOut size={13} />
            <span>
              <Cube size={13} /> Persp
            </span>
            <BoundingBox size={13} />
            <GridFour size={13} />
          </div>
          <div className="intro-dims mono" data-on={k > 0.02 ? '' : undefined}>
            {typed(DIMS, k)}
          </div>
        </div>
        <div className="intro-params" style={stagger(5)}>
          {PARAMS.map(([name, value, digits, words]) => (
            <div className="intro-param" key={name}>
              <span className="mono intro-param-name">{name}</span>
              <span className="mono intro-param-value">{(value * k).toFixed(digits)} mm</span>
              <span className="intro-param-words">{words}</span>
            </div>
          ))}
        </div>
      </section>

      <aside className="intro-orail intro-orail-right" style={stagger(0)}>
        <h3>Affects</h3>
        <p className="intro-rquiet" style={stagger(1)}>
          Nothing depends on this yet.
        </p>
        <h3 style={stagger(2)}>
          Revisions <span className="num">2</span>
        </h3>
        <div className="intro-rev" data-on="" style={stagger(3)}>
          <span className="mono">r2</span>
          <div>
            <strong>
              Baseline <em>· user</em>
            </strong>
            <small>Attach illustrative geometry</small>
          </div>
        </div>
        <div className="intro-rev" style={stagger(4)}>
          <span className="mono">r1</span>
          <div>
            <strong>
              Superseded <em>· user</em>
            </strong>
            <small>first printable tray for the removable payload</small>
          </div>
        </div>
      </aside>
    </div>
  );
}
