import { PartCard } from '../ui/PartCard';
import React, { useState } from 'react';
import {
  ArrowRight,
  ArrowsOut,
  ClockCounterClockwise,
  Files,
  GearSix,
  GitBranch,
  Graph,
  Minus,
  Package,
  Plus,
  Robot,
} from '@phosphor-icons/react';
import appIcon from '../../../../../design-system/brand/app-icon.png';
import { ExternalLink } from '../ui/ExternalLink';
import { useStore } from '../store';
import {
  Block,
  Brand,
  Button,
  Disclosure,
  Empty,
  Facts,
  Field,
  IconButton,
  Kbd,
  Mark,
  Notice,
  Pulse,
  Segmented,
  State,
  TypeGlyph,
  TYPES,
  TYPE_ORDER,
  LAYERS,
} from '../ui/kit';

const COLOR_TOKENS = [
  ['--field', 'Field', 'Window and map canvas'],
  ['--surface', 'Surface', 'The stage in focus'],
  ['--raised', 'Raised', 'Islands, menus, cards'],
  ['--raised-2', 'Raised 2', 'Hover, inputs'],
  ['--inset', 'Inset', 'Code, terminal, viewport'],
  ['--text', 'Text', 'Content'],
  ['--text-2', 'Text 2', 'Supporting'],
  ['--text-3', 'Text 3', 'Metadata'],
  ['--signal', 'Signal', 'Live agent, focus, the lit thread'],
  ['--ok', 'Positive', 'Approved, current, passed'],
  ['--warn', 'Attention', 'Needs review, out of date'],
  ['--err', 'Error', 'Missing input, failure, rejection'],
  ['--primary', 'Primary', 'The one decisive action'],
] as const;

const TYPE_SCALE = [
  ['--text-3xl', 'Launcher question', 'What are you building?'],
  ['--text-2xl', 'Project and object title', 'Sable inspection rover'],
  ['--text-xl', 'Result and target values', '0.42 kg'],
  ['--text-lg', 'Statement', 'The rover shall carry a 300 g payload.'],
  ['--text-md', 'Working text', 'Approval updates the baseline and marks dependents.'],
  ['--text-sm', 'Controls, rails, tables', 'Depends on · Payload capacity'],
  ['--text-xs', 'Metadata', 'r4 · agent · 12 min ago'],
] as const;

const PRINCIPLES = [
  [
    'One thing in focus',
    'Everything else is context or one step away. There are no pages, only zoom levels.',
  ],
  [
    'Space follows causality',
    'Inputs sit left, consequences right. Moving through the project means moving along its links.',
  ],
  [
    'The interface takes the shape of the work',
    'A part becomes a 3D stage, a calculation an equation, a proposal a decision.',
  ],
  [
    'Agents propose, people decide',
    'The agent types into a real terminal. Nothing becomes the design until a person approves it.',
  ],
  [
    'Calm until it matters',
    'State appears when it asks something of you. Colour always comes with a word.',
  ],
] as const;

export function DesignSystemView() {
  const [seg, setSeg] = useState<'flow' | 'parts' | 'timeline'>('flow');
  const [open, setOpen] = useState(true);
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);
  return (
    <div className="system">
      <div className="system-col">
        <header className="system-hero">
          <Mark size={30} />
          <h1>Lens</h1>
          <p>
            The Omen Flow design language. One graphite field, one signal colour, three zoom levels,
            and a causal grammar that makes complex engineering feel simple.
          </p>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'dark', label: 'Graphite' },
              { value: 'light', label: 'Paper' },
            ]}
          />
        </header>

        <Section title="Principles">
          <ol className="principles">
            {PRINCIPLES.map(([t, b], i) => (
              <li key={t}>
                <span className="num">{i + 1}</span>
                <div>
                  <strong>{t}</strong>
                  <p>{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          title="Interaction model"
          note="Semantic zoom replaces navigation. Esc zooms out; ⌘K goes anywhere."
        >
          <div className="zoom-model">
            {[
              [
                'Project',
                'The whole system as one flow — Intent → Parts → Design → Evidence. Lenses re-project it as parts, a timeline, or files.',
              ],
              [
                'Object',
                'One object on the stage, its inputs on the left rail and its consequences on the right.',
              ],
              [
                'Decision',
                'One proposal at a time: evidence in the centre, impact on the right, the decision pinned below.',
              ],
            ].map(([t, b], i) => (
              <React.Fragment key={t}>
                {i > 0 && <ArrowRight size={14} className="zoom-arrow" />}
                <div className="zoom-level island">
                  <span className="zoom-n">Level {i}</span>
                  <strong>{t}</strong>
                  <p>{b}</p>
                </div>
              </React.Fragment>
            ))}
          </div>
          <div className="zoom-model-foot">
            <span>
              <Kbd>⌘K</Kbd> go or ask
            </span>
            <span>
              <Kbd>esc</Kbd> zoom out
            </span>
            <span>
              <Kbd>⌘[</Kbd> back
            </span>
            <span>
              <Kbd>⌘J</Kbd> agent window
            </span>
            <span>
              <Kbd>⌘⇧D</Kbd> decisions
            </span>
            <span>
              <Kbd>⌘1–4</Kbd> lenses
            </span>
            <span>
              <Kbd>⌘↵</Kbd> approve
            </span>
          </div>
        </Section>

        <Section
          title="Brand"
          note="The mark is three facets meeting at one point: intent, design, and evidence converging. Always monochrome."
        >
          <div className="brand-row">
            <div className="brand-tile dark">
              <Mark size={56} />
            </div>
            <div className="brand-tile light">
              <Mark size={56} />
            </div>
            <div className="brand-tile icon">
              <img src={appIcon} alt="Omen Flow app icon" width={88} height={88} />
            </div>
            <div className="brand-tile lockup">
              <Brand size={22} />
              <small>Titlebar 17 px · lockup 18–22 px · launcher 34 px</small>
            </div>
          </div>
        </Section>

        <Section
          title="Colour"
          note="Graphite and Paper share roles. Signal is the only chromatic accent outside state."
        >
          <div className="swatches">
            {COLOR_TOKENS.map(([v, name, use]) => (
              <div className="swatch" key={v}>
                <span className="swatch-chip" style={{ background: `var(${v})` }} />
                <strong>{name}</strong>
                <code>{v}</code>
                <small>{use}</small>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Type"
          note="Geist for the interface, IBM Plex Mono for values, identifiers, and source."
        >
          <div className="type-scale">
            {TYPE_SCALE.map(([v, role, sample]) => (
              <div key={v} className="type-row">
                <span className="type-meta">
                  {role}
                  <code>{v}</code>
                </span>
                <span
                  style={{ fontSize: `var(${v})` }}
                  className={v === '--text-xl' ? 'num mono' : ''}
                >
                  {sample}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Controls">
          <div className="specimen-row">
            <Button variant="primary">Approve changes</Button>
            <Button>Request changes</Button>
            <Button variant="ghost">Discard</Button>
            <Button variant="danger">Reject</Button>
            <Button variant="signal" icon={<Plus size={13} />}>
              Start Codex
            </Button>
            <Button size="sm">Small</Button>
            <IconButton label="Settings">
              <GearSix size={15} />
            </IconButton>
            <Kbd>⌘K</Kbd>
          </div>
          <div className="specimen-row">
            <Segmented
              label="Lens"
              value={seg}
              onChange={setSeg}
              options={[
                { value: 'flow', label: 'Flow' },
                { value: 'parts', label: 'Parts', count: 7 },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
            <Field label="Target value">
              <input className="num" defaultValue="300" />
            </Field>
            <Field label="Unit">
              <select defaultValue="g">
                <option>g</option>
                <option>kg</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section
          title="State"
          note="Review, freshness, evidence, and execution are independent. Each is a dot plus a word."
        >
          <div className="specimen-row wrap">
            {[
              'approved',
              'current',
              'passed',
              'pending',
              'stale',
              'changes_requested',
              'draft',
              'candidate',
              'rejected',
              'missing_input',
              'failed',
            ].map((s) => (
              <State key={s} state={s} />
            ))}
            <State state="running" />
            <span className="row">
              <Pulse /> live
            </span>
          </div>
        </Section>

        <Section
          title="Engineering objects"
          note="Fourteen types across four causal layers. Glyphs are neutral; they never carry state."
        >
          <div className="layers">
            {LAYERS.map((l) => (
              <div key={l.id} className="layer">
                <strong>{l.label}</strong>
                <small>{l.hint}</small>
                {TYPE_ORDER.filter((t) => TYPES[t].layer === l.id).map((t) => (
                  <span key={t} className="layer-type">
                    <TypeGlyph type={t} size={14} />
                    {TYPES[t].label}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Graph grammar"
          note="The map is navigation, not decoration. Hover lights the causal thread; everything else steps back."
        >
          <div className="specimen-row wrap map-specimens">
            <div className="map-node">
              <TypeGlyph type="requirement" size={14} />
              <span className="map-node-title">Payload capacity</span>
            </div>
            <div className="map-node stale">
              <TypeGlyph type="calculation" size={14} />
              <span className="map-node-title">Rover mass budget</span>
              <span className="map-mark tone-warn" />
            </div>
            <div className="map-node touched">
              <TypeGlyph type="mechanical" size={14} />
              <span className="map-node-title">Camera tray</span>
            </div>
            <div className="map-node lit">
              <TypeGlyph type="component" size={14} />
              <span className="map-node-title">LiPo 2S 450 mAh</span>
            </div>
            <div className="map-node dim">
              <TypeGlyph type="source" size={14} />
              <span className="map-node-title">Supplier listing</span>
            </div>
            <div className="map-node">
              <TypeGlyph type="test" size={14} />
              <span className="map-node-title">Ramp traverse</span>
              <span className="map-mark hollow" />
            </div>
          </div>
          <div className="specimen-grid">
            <div className="rail-specimen">
              <section className="links links-up">
                <h2>
                  Depends on <span className="count">2</span>
                </h2>
                <ul>
                  <li>
                    <button type="button" className="link-node">
                      <TypeGlyph type="requirement" size={14} />
                      <span className="link-copy">
                        <span className="link-title">Payload capacity</span>
                        <small>depends on</small>
                      </span>
                    </button>
                  </li>
                  <li>
                    <button type="button" className="link-node">
                      <TypeGlyph type="component" size={14} />
                      <span className="link-copy">
                        <span className="link-title">Camera Module 3</span>
                        <small>derived from · pinned</small>
                      </span>
                      <span className="map-mark tone-warn" />
                    </button>
                  </li>
                </ul>
              </section>
            </div>
            <div className="diff">
              <div className="diff-row">
                <span className="diff-field">target</span>
                <span className="diff-from">0.3 kg</span>
                <span className="diff-arrow">→</span>
                <span className="diff-to">0.5 kg</span>
              </div>
              <div className="diff-row">
                <span className="diff-field">acceptance criterion</span>
                <span className="diff-from">Carries 300 g up a 15° ramp</span>
                <span className="diff-arrow">→</span>
                <span className="diff-to">Carries 500 g up a 15° ramp</span>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Recorded artifact content"
          note="Drafts carry complete content. The revision picker separates latest work, baseline, and history; supplier links retain their recorded destination."
        >
          <div className="specimen-grid">
            <Block title="Revision">
              <Field label="Displayed revision">
                <select defaultValue="draft">
                  <option value="draft">r2 · draft</option>
                  <option value="baseline">r1 · Baseline</option>
                </select>
              </Field>
              <Notice>
                Showing r2 · draft. The approved baseline is available in the revision picker.
              </Notice>
            </Block>
            <Block title="Supplier offer · illustrative">
              <ExternalLink url="https://example.com/component">Example supplier</ExternalLink>
              <p className="num">Price unknown · per 1</p>
              <p className="dim">
                Recorded observations populate content fields. New test outcomes require new
                evidence.
              </p>
            </Block>
          </div>
        </Section>

        <Section
          title="Sourced parts"
          note="One product per line: product photo, identity, engineering reason, price and quantity basis, and the recorded seller destination. Missing data stays explicit; sample offers below are illustrative."
        >
          <ul className="parts-list">
            <PartCard
              title="Controller board · illustrative"
              payload={{
                manufacturer: 'Example maker',
                partNumber: 'CTRL-01',
                selectionReason: 'Provides the digital inputs needed by the sensor assembly.',
                status: 'candidate',
              }}
              offers={[
                {
                  seller: 'Example seller',
                  url: 'https://example.com/product',
                  price: { amount: '12.50', currency: 'USD' },
                  quantityBasis: 1,
                  observedAt: '2026-09-26',
                },
              ]}
              onFocus={() => {}}
            />
          </ul>
        </Section>

        <Section title="Surfaces">
          <div className="specimen-grid">
            <Notice tone="warn">
              <strong>An input changed after this was recorded.</strong> Payload capacity → Rover
              mass budget → this
            </Notice>
            <Notice tone="ok">Decision recorded. The agent can continue from it.</Notice>
            <Notice tone="err">Missing input: battery mass is unknown.</Notice>
            <Notice>An assumption is not an established fact.</Notice>
          </div>
          <div className="specimen-grid">
            <Block title="Record">
              <Facts
                rows={[
                  ['Origin', 'agent · codex'],
                  ['Evidence', 'calculated'],
                  [
                    'Identifier',
                    <span className="mono" key="i">
                      3f9c21aa
                    </span>,
                  ],
                ]}
              />
            </Block>
            <div className="island empty-specimen">
              <Empty
                title="You’re caught up"
                body="Proposed changes arrive here with before-and-after values."
              />
            </div>
          </div>
          <Disclosure
            label="Disclosure"
            meta="progressive detail"
            open={open}
            onToggle={() => setOpen((o) => !o)}
          >
            <p className="dim">
              Deep detail — arguments, diagnostics, identifiers — lives one interaction away.
            </p>
          </Disclosure>
        </Section>

        <Section
          title="Workbench"
          note="A 48 px activity bar on the left: the Agent tab first, then the lenses and decisions. The agent window floats over any other tab."
        >
          <div className="specimen-grid">
            <nav className="activity-bar specimen-activity" aria-label="Activity bar specimen">
              <button
                type="button"
                className="activity-btn"
                aria-label="Agent"
                title="Agent"
                aria-current="page"
              >
                <Robot size={22} />
                <Pulse />
              </button>
              <button
                type="button"
                className="activity-btn"
                aria-label="Flow (⌘1)"
                title="Flow (⌘1)"
              >
                <Graph size={22} />
              </button>
              <button
                type="button"
                className="activity-btn"
                aria-label="Parts (⌘2)"
                title="Parts (⌘2)"
              >
                <Package size={22} />
              </button>
              <button
                type="button"
                className="activity-btn"
                aria-label="Timeline (⌘3)"
                title="Timeline (⌘3)"
              >
                <ClockCounterClockwise size={22} />
              </button>
              <button
                type="button"
                className="activity-btn"
                aria-label="Files (⌘4)"
                title="Files (⌘4)"
              >
                <Files size={22} />
              </button>
              <button
                type="button"
                className="activity-btn"
                aria-label="Decisions (⌘⇧D)"
                title="Decisions (⌘⇧D)"
              >
                <GitBranch size={22} />
                <span className="activity-badge">1</span>
              </button>
              <div className="activity-bottom">
                <button
                  type="button"
                  className="activity-btn"
                  aria-label="Agent window (⌘J)"
                  title="Agent window (⌘J)"
                  aria-pressed="true"
                >
                  <Robot size={22} />
                </button>
                <button
                  type="button"
                  className="activity-btn"
                  aria-label="Settings (⌘,)"
                  title="Settings (⌘,)"
                >
                  <GearSix size={22} />
                </button>
              </div>
            </nav>
            <div
              className="agent-surface mode-window live specimen-agent"
              aria-label="Agent window specimen"
            >
              <header className="agent-head">
                <span className="agent-light live" />
                <span className="agent-name truncate">Codex CLI</span>
                <span className="agent-status">Running</span>
                <span className="grow" />
                <IconButton size="sm" label="Open agent tab">
                  <ArrowsOut size={13} />
                </IconButton>
                <IconButton size="sm" label="Close agent window (⌘J)">
                  <Minus size={13} />
                </IconButton>
              </header>
              <div className="agent-screen">
                <pre className="specimen-term">
                  <span className="dim">$ codex</span>
                  {'\n'}Reading project intent… drafting requirements with measurable targets.
                  {'\n'}
                  <span className="dim">proposal submitted · waiting for your review</span>
                </pre>
              </div>
              <div className="agent-resize" aria-hidden="true" />
            </div>
          </div>
        </Section>

        <footer className="system-foot">
          <span>
            Source of truth: <code>design-system/tokens.css</code>,{' '}
            <code>design-system/design.md</code>, <code>renderer/ui/kit.tsx</code>.
          </span>
        </footer>
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="system-section">
      <header>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}
