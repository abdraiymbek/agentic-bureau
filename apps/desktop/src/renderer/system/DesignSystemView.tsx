import React, { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowRight,
  CaretDown,
  CheckCircle,
  Cube,
  Export,
  GearSix,
  MagnifyingGlass,
  Minus,
  Plus,
  Robot,
  Trash,
  X,
} from '@phosphor-icons/react';
import appIcon from '../../../../../design-system/brand/app-icon.png';
import { PayloadDiff } from '../decide/PayloadDiff';
import { diffPayload } from '../lib/diff';
import { InlineVerification } from '../chat/InlineVerification';
import { useAgentUi } from '../shell/agent/agent-store';
import { ActivityBar } from '../shell/ActivityBar';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ExternalLink } from '../ui/ExternalLink';
import { PartCard } from '../ui/PartCard';
import { composite, contrastGrade, contrastRatio, parseColor } from '../ui/contrast';
import { LENSES } from '../project/lenses';
import { useStore } from '../store';
import {
  Block,
  Brand,
  Button,
  Checkbox,
  ConfirmButton,
  Disclosure,
  Empty,
  Facts,
  Field,
  IconButton,
  Kbd,
  LAYERS,
  Mark,
  Menu,
  Notice,
  Pulse,
  Qty,
  QuantityField,
  Segmented,
  Skeleton,
  Spinner,
  State,
  Time,
  Tooltip,
  TYPES,
  TYPE_ORDER,
  TypeGlyph,
  VOCABULARY,
  formatMoney,
  type QuantityValue,
  type StateDimension,
} from '../ui/kit';

/* ------------------------------------------------------------------ */
/* Catalogue data: roles, not markup                                    */
/* ------------------------------------------------------------------ */

const COLOR_GROUPS: { title: string; tokens: [token: string, role: string][] }[] = [
  {
    title: 'Planes',
    tokens: [
      ['--field', 'Window, map canvas'],
      ['--surface', 'The stage in focus'],
      ['--raised', 'Islands, menus, cards'],
      ['--raised-2', 'Hover, inputs'],
      ['--pressed', 'A control held down'],
      ['--inset', 'Code, terminal, viewport'],
      ['--overlay', 'Scrim behind dialogs'],
    ],
  },
  {
    title: 'Text and lines',
    tokens: [
      ['--text', 'Content'],
      ['--text-2', 'Support'],
      ['--text-3', 'Metadata, labels, units'],
      ['--text-4', 'Separators, idle marks'],
      ['--line', 'Hairlines'],
      ['--line-strong', 'Control edges, island rims'],
      ['--line-control', 'Hovered edges'],
    ],
  },
  {
    title: 'Signal and state',
    tokens: [
      ['--signal', 'Signal fill'],
      ['--signal-stroke', 'Signal as a line, ring or dot'],
      ['--signal-text', 'Signal as text'],
      ['--focus', 'Focus ring'],
      ['--ok', 'Approved, current, passed'],
      ['--warn', 'In review, out of date'],
      ['--err', 'Missing input, failure'],
      ['--primary', 'The one decisive action'],
    ],
  },
];

/** Measured pairs: [foreground, background, what it is used for]. */
const CONTRAST_PAIRS: [fg: string, bg: string, use: string][] = [
  ['--text-2', '--surface', 'Supporting text'],
  ['--text-3', '--field', 'Metadata on the field'],
  ['--text-3', '--surface', 'Labels on the stage'],
  ['--text-3', '--raised-2', 'Key caps, hovered rows'],
  ['--ok', '--ok-soft', 'Approved pill'],
  ['--warn', '--warn-soft', 'Out of date pill'],
  ['--err', '--err-soft', 'Missing input pill'],
  ['--signal-stroke', '--field', 'Lit thread, live dot'],
  ['--focus', '--raised-2', 'Focus ring on an input'],
  ['--text-4', '--surface', 'Separator'],
];

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
];

const TYPE_SCALE = [
  ['--text-3xl', 'Launcher question, calculation result', 'What are you building?'],
  ['--text-2xl', 'Project and object titles', 'Sable inspection rover'],
  ['--text-xl', 'Statements, target values, totals', '0.412 kg'],
  ['--text-lg', 'Lede, omnibar input', 'The rover shall carry a 300 g payload.'],
  ['--text-md', 'Working text', 'Approval updates the baseline and marks dependents.'],
  ['--text-sm', 'Controls, rails, tables', 'Depends on · Payload capacity'],
  ['--text-xs', 'Metadata', 'r4 · agent · 12 min ago'],
  ['--text-2xs', 'Counts and key caps', '⌘K · 3'],
] as const;

/** Optical tuning per size: display sizes track tighter; values use tabular figures. */
const TYPE_ROLE: Partial<Record<string, string>> = {
  '--text-3xl': 'text-display num',
  '--text-2xl': 'text-display',
  '--text-xl': 'text-title num',
  '--text-lg': 'text-title',
};

const SPACE = ['--s-1', '--s-2', '--s-3', '--s-4', '--s-5', '--s-6', '--s-8', '--s-10', '--s-12'];
const RADII = ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'];
const LAYER_TOKENS = [
  '--z-raised',
  '--z-stage-tools',
  '--z-sticky',
  '--z-canvas-tools',
  '--z-project-head',
  '--z-island',
  '--z-agent-tab',
  '--z-agent-window',
  '--z-titlebar',
  '--z-overlay',
  '--z-dialog',
  '--z-menu',
  '--z-toast',
  '--z-tooltip',
];
const MOTION_TOKENS = [
  ['--t-fast', 'Feedback: hover, press, exit'],
  ['--t', 'State and enter'],
  ['--t-slow', 'Zoom and sheet'],
  ['--ease', 'Enter and state change'],
  ['--ease-in', 'Exit'],
  ['--ease-in-out', 'Loops'],
] as const;

const MOTIONS = [
  ['motion-fade', 'Scrim, tooltip'],
  ['motion-rise', 'Island, menu, toast'],
  ['motion-sheet', 'Sheet'],
  ['motion-zoom-in', 'Zoom into a level'],
  ['motion-zoom-out', 'Zoom out of a level'],
] as const;

const PREVIEW_STATES = ['rest', 'hover', 'focus', 'pressed', 'disabled', 'busy'] as const;
const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'signal'] as const;

const DIMENSION_NOTES: Record<StateDimension, string> = {
  review: 'A revision',
  proposal: 'A proposal',
  freshness: 'A baseline against its inputs',
  evidence: 'How a value is known; coverage',
  result: 'A recorded test result',
  verification: 'A committed CAD check',
  execution: 'Sessions and jobs',
  part: 'A component in selection',
};

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

const SHORTCUTS = [
  ['⌘K', 'go or ask'],
  ['esc', 'zoom out'],
  ['⌘[', 'back'],
  ['⌘J', 'agent window'],
  ['⌘⇧D', 'decisions'],
  [`⌘1–${LENSES.length}`, 'lenses'],
  ['⌘↵', 'approve'],
  ['⌘,', 'settings'],
] as const;

const InlineChart = lazy(() => import('../chat/InlineChart'));

const SECTIONS = [
  'Principles',
  'Colour',
  'Type',
  'Geometry and depth',
  'Motion',
  'Controls',
  'Feedback and input',
  'State',
  'Values',
  'Content',
  'Engineering objects',
  'Conversation',
  'In the product',
] as const;

const sectionId = (title: string) => `system-${title.toLowerCase().replaceAll(' ', '-')}`;

/* ------------------------------------------------------------------ */
/* View                                                                 */
/* ------------------------------------------------------------------ */

export function DesignSystemView() {
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
            and a causal grammar that makes complex engineering feel simple. Every specimen below is
            the real component, shown in Graphite and Paper side by side.
          </p>
          <div className="row">
            <Segmented
              label="Application theme"
              value={theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: 'dark', label: 'Graphite' },
                { value: 'light', label: 'Paper' },
              ]}
            />
          </div>
          <nav className="system-toc" aria-label="Catalogue sections">
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="link"
                onClick={() =>
                  document.getElementById(sectionId(s))?.scrollIntoView({ block: 'start' })
                }
              >
                {s}
              </button>
            ))}
          </nav>
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
          <div className="zoom-model">
            {[
              [
                'Project',
                'The whole system as one flow — Intent → Parts → Design → Evidence. Lenses re-project it as parts, a timeline, files, or requirement evidence.',
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
                {i > 0 && <ArrowRight size={14} className="zoom-arrow" aria-hidden="true" />}
                <div className="zoom-level island">
                  <span className="zoom-n">Level {i}</span>
                  <strong>{t}</strong>
                  <p>{b}</p>
                </div>
              </React.Fragment>
            ))}
          </div>
          <div className="zoom-model-foot">
            {SHORTCUTS.map(([k, what]) => (
              <span key={what}>
                <Kbd>{k}</Kbd> {what}
              </span>
            ))}
          </div>
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
          note="Graphite and Paper share roles. Signal is the only chromatic accent outside state; drawn as a line it uses the stroke role, which stays readable on Paper."
        >
          <Themes>
            {() => (
              <>
                {COLOR_GROUPS.map((g) => (
                  <div key={g.title} className="swatch-group">
                    <h3>{g.title}</h3>
                    <div className="swatches">
                      {g.tokens.map(([v, role]) => (
                        <div className="swatch" key={v}>
                          <span className="swatch-chip" style={{ background: `var(${v})` }} />
                          <code>{v}</code>
                          <small>{role}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <ContrastTable />
              </>
            )}
          </Themes>
          <Themes label="Terminal">
            {() => (
              <div className="ansi">
                <pre className="ansi-sample">
                  <span style={{ color: 'var(--ansi-bright-black)' }}>$ </span>
                  <span style={{ color: 'var(--terminal-fg)' }}>omenflow call cad.check</span>
                  {'\n'}
                  <span style={{ color: 'var(--ansi-green)' }}>passed</span>
                  <span style={{ color: 'var(--ansi-bright-black)' }}> · 6 of 6 checks</span>
                  {'\n'}
                  <span style={{ color: 'var(--ansi-yellow)' }}>warning</span>
                  <span style={{ color: 'var(--terminal-fg)' }}> scope changed since r2</span>
                </pre>
                <div className="ansi-grid">
                  {ANSI.map((c) => (
                    <span key={c} className="ansi-chip" style={{ color: `var(--ansi-${c})` }}>
                      <span aria-hidden="true">■</span> {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Themes>
        </Section>

        <Section
          title="Type"
          note="Geist for the interface, IBM Plex Mono for values, identifiers and source. Display sizes tighten their tracking; numbers use tabular figures."
        >
          <Themes single>
            {() => (
              <div className="type-scale">
                {TYPE_SCALE.map(([v, role, sample]) => (
                  <div key={v} className="type-row">
                    <span className="type-meta">
                      {role}
                      <code>{v}</code>
                    </span>
                    <span
                      className={`type-sample ${TYPE_ROLE[v] ?? ''}`}
                      style={{ fontSize: `var(${v})` }}
                    >
                      {sample}
                    </span>
                  </div>
                ))}
                <div className="type-row">
                  <span className="type-meta">
                    Values and source
                    <code>--font-mono</code>
                  </span>
                  <span className="mono">3f9c21aa · camera-tray.scad · 12.50 USD</span>
                </div>
                <div className="type-row">
                  <span className="type-meta">
                    Line heights
                    <code>--leading-*</code>
                  </span>
                  <span className="type-leading">
                    <code>display 1.15</code> <code>tight 1.35</code> <code>working 1.5</code>{' '}
                    <code>prose 1.65</code>
                  </span>
                </div>
              </div>
            )}
          </Themes>
        </Section>

        <Section
          title="Geometry and depth"
          note="Spacing is 4-based. Controls are 26, 32 and 38 px. Three planes: the flat field, the stage with a hairline, and islands that float with a layered shadow."
        >
          <Themes>
            {() => (
              <div className="geometry">
                <div className="depth-field">
                  <span className="depth-label">Field</span>
                  <div className="depth-stage">
                    <span className="depth-label">Stage</span>
                    <div className="island depth-island">
                      <span className="depth-label">Island</span>
                    </div>
                  </div>
                </div>
                <div className="shadow-row">
                  {['--shadow-float', '--shadow-menu', '--shadow-pop'].map((s) => (
                    <div key={s} className="shadow-chip" style={{ boxShadow: `var(${s})` }}>
                      <code>{s}</code>
                    </div>
                  ))}
                </div>
                <div className="control-heights">
                  <Button size="sm">26 px</Button>
                  <Button>32 px</Button>
                  <Button size="lg">38 px</Button>
                  <IconButton size="sm" label="26 px icon button">
                    <Plus size={13} />
                  </IconButton>
                  <IconButton label="32 px icon button">
                    <Plus size={15} />
                  </IconButton>
                  <IconButton size="lg" label="38 px icon button">
                    <Plus size={17} />
                  </IconButton>
                </div>
              </div>
            )}
          </Themes>
          <div className="token-tables">
            <TokenTable
              title="Space"
              tokens={SPACE}
              render={(v) => <span className="space-bar" style={{ width: `var(${v})` }} />}
            />
            <TokenTable
              title="Radius"
              tokens={RADII}
              render={(v) => <span className="radius-chip" style={{ borderRadius: `var(${v})` }} />}
            />
            <TokenTable title="Layers" tokens={LAYER_TOKENS} />
          </div>
        </Section>

        <Section
          title="Motion"
          note="Functional only: 120 ms feedback, 200 ms state, 320 ms zoom and sheet. Exits are quicker than entrances. Reduced motion makes all of it instant; live indicators breathe instead of spinning."
        >
          <MotionSpecimens />
          <div className="token-tables">
            <TokenTable
              title="Duration and easing"
              tokens={MOTION_TOKENS.map(([t]) => t)}
              notes={Object.fromEntries(MOTION_TOKENS)}
            />
          </div>
        </Section>

        <Section
          title="Controls"
          note="Every state uses the same rule as the live control: hover, keyboard focus, pressed (fill and scale at once), disabled, and busy (the width never changes)."
        >
          <Themes>{() => <ButtonMatrix />}</Themes>
          <Themes>{() => <ControlSpecimens />}</Themes>
        </Section>

        <Section
          title="Feedback and input"
          note="Work in flight says so, irreversible actions take two presses, and a quantity keeps its unit. Empty is not set, never zero."
        >
          <Themes>{() => <FeedbackSpecimens />}</Themes>
        </Section>

        <Section
          title="State"
          note="One word per state, per dimension. Review, freshness, evidence and execution are independent; each is a dot plus a word."
        >
          <Themes>
            {() => (
              <div className="vocabulary">
                {(Object.keys(VOCABULARY) as StateDimension[]).map((d) => (
                  <div key={d} className="vocabulary-row">
                    <span className="vocabulary-name">
                      {d[0]!.toUpperCase() + d.slice(1)}
                      <small>{DIMENSION_NOTES[d]}</small>
                    </span>
                    <span className="vocabulary-states">
                      {Object.keys(VOCABULARY[d]).map((s) => (
                        <State key={s} state={s} dimension={d} />
                      ))}
                    </span>
                  </div>
                ))}
                <div className="vocabulary-row">
                  <span className="vocabulary-name">
                    Live
                    <small>Only things running now</small>
                  </span>
                  <span className="vocabulary-states">
                    <span className="row">
                      <Pulse /> Running
                    </span>
                    <span className="row">
                      <Pulse tone="warn" /> Waiting on you
                    </span>
                    <State state="running" dimension="execution" quiet />
                  </span>
                </div>
              </div>
            )}
          </Themes>
        </Section>

        <Section
          title="Values"
          note="One formatter for quantities and one for times. A value and its unit never break apart; unknown says why; money keeps its recorded decimals."
        >
          <Themes>{() => <ValueSpecimens />}</Themes>
        </Section>

        <Section
          title="Content"
          note="Stage content: notices, records, tables, code, empty states, progressive detail, recorded changes and sourced parts."
        >
          <Themes>{() => <ContentSpecimens />}</Themes>
          <Themes label="Recorded change">
            {() => (
              <PayloadDiff
                entries={diffPayload(
                  { target: { value: 0.3, unit: 'kg' }, acceptance: 'Carries 300 g up a 15° ramp' },
                  { target: { value: 0.5, unit: 'kg' }, acceptance: 'Carries 500 g up a 15° ramp' },
                )}
              />
            )}
          </Themes>
          <Themes label="Sourced part" single>
            {() => (
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
            )}
          </Themes>
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
          title="Conversation"
          note="The Agent tab's conversation pane. These labelled specimens never start an agent: only Send runs one, and every message in the product is a recorded request or a real run's output."
        >
          <Themes label="Composer and delivery · specimens">
            {() => (
              <>
                <div className="chat-composer">
                  <textarea
                    aria-label="Specimen conversation message"
                    placeholder="Describe what you want to make…"
                    rows={3}
                  />
                  <div className="chat-composer-tools">
                    <IconButton label="Specimen add context" disabled>
                      <Plus size={16} />
                    </IconButton>
                    <span className="chat-muted">Codex CLI · specimen</span>
                    <span className="grow" />
                    <IconButton label="Specimen send (disabled)" disabled>
                      <ArrowRight size={16} />
                    </IconButton>
                  </div>
                </div>
                <p className="chat-composer-note">
                  Agents draft. You decide. · No agent runs in this specimen.
                </p>
                <div className="chat-delivery">
                  <strong>Message needs attention</strong>
                  <p>
                    Unconfirmed delivery stays visible. Retry preserves the original request ID and
                    newer text in the composer.
                  </p>
                  <Button size="sm" disabled>
                    Retry original request · specimen
                  </Button>
                </div>
                <div className="chat-call-ledger">
                  <span className="chat-eyebrow">Host call ledger</span>
                  <p>Only real recorded calls appear here. No activity is fabricated.</p>
                </div>
              </>
            )}
          </Themes>
          <Themes label="Inline chart · illustrative specimen">
            {() => (
              <Suspense fallback={<p>Loading chart specimen…</p>}>
                <InlineChart
                  part={{
                    kind: 'chart',
                    title: 'A focused engineering scenario',
                    xLabel: 'Width',
                    xUnit: 'mm',
                    yLabel: 'Illustrative volume',
                    yUnit: 'cm³',
                    source: 'Design-system specimen; no engine was run',
                    provenance: 'illustrative',
                    points: [
                      { x: 50, y: 18 },
                      { x: 60, y: 24 },
                      { x: 70, y: 33 },
                      { x: 80, y: 45 },
                    ],
                  }}
                />
              </Suspense>
            )}
          </Themes>
          <Themes label="Human review evidence · labelled specimen">
            {() => (
              <InlineVerification
                verification={{
                  status: 'passed',
                  evidenceHash: 'specimen-only-no-engine-run',
                  evidence: {
                    pass: true,
                    checks: [
                      {
                        name: 'overall size · specimen',
                        pass: true,
                        detail: '64 × 46 × 4.5 mm — illustrative recorded-result layout',
                      },
                    ],
                    integrity: { pass: true, detail: 'Specimen only; no geometry was checked.' },
                    coverage: {
                      units: 'mm',
                      assertions: ['overall size · specimen'],
                      limitations: ['This design-system example is not engineering evidence.'],
                    },
                  },
                }}
                accepted={false}
                onAccept={() => {}}
                disabled
              />
            )}
          </Themes>
        </Section>

        <Section
          title="In the product"
          note="Composite patterns are shown where they live, not copied here. Open each one for real."
        >
          <InProduct />
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

/* ------------------------------------------------------------------ */
/* Frames                                                               */
/* ------------------------------------------------------------------ */

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
    <section
      className="system-section"
      id={sectionId(title)}
      aria-labelledby={`${sectionId(title)}-h`}
    >
      <header>
        <h2 id={`${sectionId(title)}-h`}>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}

/**
 * Renders a specimen twice, once per theme, from the same components. Each pane carries its own
 * `data-theme`, so the tokens resolve as they do in the application. Menus and tooltips open in
 * the application theme because they render at the document root.
 */
function Themes({
  children,
  label,
  single = false,
}: {
  children: () => React.ReactNode;
  label?: string;
  /** Stack the panes even when there is room for both side by side. */
  single?: boolean;
}) {
  return (
    <div className={`theme-pair${single ? ' stacked' : ''}`}>
      {(['dark', 'light'] as const).map((t) => (
        <div key={t} className="theme-pane" data-theme={t}>
          <span className="theme-name">
            {t === 'dark' ? 'Graphite' : 'Paper'}
            {label ? ` · ${label}` : ''}
          </span>
          {children()}
        </div>
      ))}
    </div>
  );
}

function TokenTable({
  title,
  tokens,
  render,
  notes,
}: {
  title: string;
  tokens: readonly string[];
  render?: (token: string) => React.ReactNode;
  notes?: Record<string, string>;
}) {
  const values = useTokenValues(tokens);
  return (
    <table className="table token-table">
      <caption>{title}</caption>
      <tbody>
        {tokens.map((t) => (
          <tr key={t}>
            <td>
              <code>{t}</code>
            </td>
            <td className="mono">{values[t] ?? ''}</td>
            <td>{render ? render(t) : notes?.[t]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Token values as the document resolves them (these tokens are the same in both themes). */
function useTokenValues(tokens: readonly string[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  const key = tokens.join(' ');
  useLayoutEffect(() => {
    const css = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(key.split(' ').map((t) => [t, css.getPropertyValue(t).trim()])));
  }, [key]);
  return values;
}

/** Ratios measured from the tokens in force in this pane, not copied from a table. */
function ContrastTable() {
  const ref = useRef<HTMLTableElement>(null);
  const [ratios, setRatios] = useState<(number | null)[]>([]);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const css = getComputedStyle(ref.current);
    const read = (t: string) => parseColor(css.getPropertyValue(t));
    setRatios(
      CONTRAST_PAIRS.map(([fg, bg]) => {
        const f = read(fg);
        let b = read(bg);
        if (!f || !b) return null;
        // A translucent background (a soft tint) sits on the stage surface.
        if (b.a < 1) {
          const surface = read('--surface');
          if (!surface) return null;
          b = composite(b, surface);
        }
        return contrastRatio(f, b);
      }),
    );
  }, []);
  return (
    <table className="table contrast-table" ref={ref}>
      <caption>Measured contrast</caption>
      <thead>
        <tr>
          <th>Pair</th>
          <th>Use</th>
          <th className="num">Ratio</th>
          <th>Meets</th>
        </tr>
      </thead>
      <tbody>
        {CONTRAST_PAIRS.map(([fg, bg, use], i) => {
          const r = ratios[i];
          return (
            <tr key={`${fg}${bg}`}>
              <td>
                <span
                  className="contrast-sample"
                  style={{ color: `var(${fg})`, background: `var(${bg})` }}
                >
                  Aa
                </span>
                <code>
                  {fg.slice(2)} on {bg.slice(2)}
                </code>
              </td>
              <td>{use}</td>
              <td className="num">
                {r == null ? '—' : `${(Math.floor(r * 100) / 100).toFixed(2)}:1`}
              </td>
              <td>{r == null ? 'Not measured' : contrastGrade(r)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/* Specimens                                                            */
/* ------------------------------------------------------------------ */

type MotionPhase = { run: number; phase: 'in' | 'leaving' | 'gone' };

/** Each utility on a real island: Enter remounts it, Exit plays the exit and then unmounts it. */
function MotionSpecimens() {
  const [state, setState] = useState<Record<string, MotionPhase>>({});
  const update = (cls: string, next: (m: MotionPhase) => MotionPhase) =>
    setState((all) => ({ ...all, [cls]: next(all[cls] ?? { run: 0, phase: 'in' }) }));
  return (
    <div className="motion-grid">
      {MOTIONS.map(([cls, use]) => {
        const m = state[cls] ?? { run: 0, phase: 'in' };
        return (
          <div key={cls} className="motion-row">
            <span className="motion-name">
              <code>.{cls}</code>
              <small>{use}</small>
            </span>
            <span className="motion-stage">
              {m.phase !== 'gone' && (
                <span
                  key={m.run}
                  className={`motion-box island ${cls}`}
                  data-leaving={m.phase === 'leaving' ? '' : undefined}
                  onAnimationEnd={() => {
                    if (m.phase === 'leaving') update(cls, (x) => ({ ...x, phase: 'gone' }));
                  }}
                />
              )}
            </span>
            <span className="row">
              <Button
                size="sm"
                onClick={() => update(cls, (x) => ({ run: x.run + 1, phase: 'in' }))}
              >
                Enter
              </Button>
              {!cls.startsWith('motion-zoom') && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={m.phase !== 'in'}
                  onClick={() => update(cls, (x) => ({ ...x, phase: 'leaving' }))}
                >
                  Exit
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ButtonMatrix() {
  return (
    <table className="state-matrix">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">State</span>
          </th>
          {VARIANTS.map((v) => (
            <th key={v} scope="col">
              {v[0]!.toUpperCase() + v.slice(1)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {PREVIEW_STATES.map((s) => (
          <tr key={s}>
            <th scope="row">{s[0]!.toUpperCase() + s.slice(1)}</th>
            {VARIANTS.map((v) => (
              <td key={v}>
                <Button
                  variant={v}
                  size="sm"
                  tabIndex={-1}
                  disabled={s === 'disabled'}
                  busy={s === 'busy'}
                  data-preview={s === 'hover' || s === 'focus' || s === 'pressed' ? s : undefined}
                  icon={v === 'signal' ? <Plus size={12} /> : undefined}
                >
                  {v === 'danger' ? 'Reject' : v === 'primary' ? 'Approve' : 'Action'}
                </Button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ControlSpecimens() {
  const [seg, setSeg] = useState<'flow' | 'parts' | 'timeline' | 'files'>('parts');
  const [tool, setTool] = useState(true);
  return (
    <div className="stack">
      <div className="specimen-row wrap">
        <Segmented
          label="Lens"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'flow', label: 'Flow' },
            { value: 'parts', label: 'Parts', count: 7 },
            { value: 'timeline', label: 'Timeline' },
            { value: 'files', label: 'Files', disabled: true },
          ]}
        />
        <IconButton label="Settings" shortcut="⌘,">
          <GearSix size={15} />
        </IconButton>
        <IconButton label="Wireframe" pressed={tool} onClick={() => setTool(!tool)}>
          <Cube size={15} />
        </IconButton>
        <IconButton label="Search" data-preview="hover" tabIndex={-1}>
          <MagnifyingGlass size={15} />
        </IconButton>
        <IconButton label="Unavailable" disabled>
          <X size={15} />
        </IconButton>
        <Kbd>⌘K</Kbd>
        <Kbd>⌘⇧D</Kbd>
      </div>
      <div className="field-grid">
        <Field label="Rest">
          <input className="num" defaultValue="300" />
        </Field>
        <Field label="Hover">
          <input className="num" defaultValue="300" data-preview="hover" tabIndex={-1} />
        </Field>
        <Field label="Focus">
          <input className="num" defaultValue="300" data-preview="focus" tabIndex={-1} />
        </Field>
        <Field label="Disabled">
          <input className="num" defaultValue="300" disabled />
        </Field>
        <Field label="Error" error="Enter a number in grams.">
          <input defaultValue="three hundred" />
        </Field>
        <Field label="Unit" hint="Changes with the value." required>
          <select defaultValue="g">
            <option>g</option>
            <option>kg</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function FeedbackSpecimens() {
  const toast = useStore((s) => s.toast);
  const [drafts, setDrafts] = useState(false);
  const [target, setTarget] = useState<QuantityValue>({ value: 300, unit: 'g' });
  const [broken, setBroken] = useState(false);
  return (
    <div className="stack">
      <div className="specimen-row wrap">
        <Button busy>Rendering</Button>
        <Button variant="primary" shortcut="⌘↵">
          Approve changes
        </Button>
        <Tooltip label="Shown on hover and when Tab reaches it" shortcut="⌘J">
          <Button variant="ghost">Tooltip</Button>
        </Tooltip>
        <ConfirmButton
          label="Discard draft"
          confirmLabel="Discard r3?"
          icon={<Trash size={13} />}
          onConfirm={() => toast('info', 'Specimen only. Nothing was discarded.')}
        />
        <Menu
          trigger={<Button trailing={<CaretDown size={11} />}>Export</Button>}
          items={[
            {
              label: 'Build package',
              icon: <Export size={14} />,
              shortcut: '⌘E',
              onSelect: () => toast('info', 'Specimen only. Nothing was exported.'),
            },
            {
              label: 'Project archive',
              icon: <Archive size={14} />,
              onSelect: () => toast('info', 'Specimen only. Nothing was exported.'),
            },
            {
              label: 'Unavailable here',
              icon: <Minus size={14} />,
              disabled: true,
              onSelect: () => {},
            },
            {
              label: 'Delete export',
              icon: <Trash size={14} />,
              tone: 'err',
              onSelect: () => toast('info', 'Specimen only. Nothing was deleted.'),
            },
          ]}
        />
      </div>
      <div className="specimen-grid">
        <Block title="Quantity and choice">
          <QuantityField
            label="Target"
            value={target}
            onChange={setTarget}
            units={['g', 'kg']}
            hint={
              target.value === null
                ? 'Recorded as not set.'
                : `Recorded as ${target.value} ${target.unit}.`
            }
          />
          <QuantityField
            label="Read-only target"
            value={{ value: 0.5, unit: 'kg' }}
            onChange={() => {}}
            disabled
          />
          <Checkbox
            checked={drafts}
            onChange={setDrafts}
            label="Include drafts in build"
            hint="Drafts stay labelled in the package."
          />
          <Checkbox checked onChange={() => {}} label="Read-only project" disabled />
        </Block>
        <Block title="Loading and failure">
          <Skeleton lines={3} />
          <span className="row">
            <Spinner label="Rendering the mesh" />{' '}
            <span className="dim">Spinner with a spoken label</span>
          </span>
          <ErrorBoundary label="This specimen" onRetry={() => setBroken(false)}>
            <Fragile broken={broken} onBreak={() => setBroken(true)} />
          </ErrorBoundary>
        </Block>
      </div>
    </div>
  );
}

function ValueSpecimens() {
  const [now] = useState(() => Date.now());
  const minutes = (m: number) => new Date(now - m * 60_000).toISOString();
  return (
    <div className="specimen-grid">
      <Block title="Quantities">
        <Facts
          rows={[
            ['Known', <Qty key="k" value={{ value: 0.41234, unit: 'kg' }} />],
            [
              'With bounds',
              <Qty key="b" value={{ value: 0.3, unit: 'kg', min: 0.28, max: 0.32 }} />,
            ],
            [
              'Unknown',
              <Qty key="u" value={{ unknown: true, reason: 'battery mass not recorded' }} />,
            ],
            ['Not set', <Qty key="n" value={null} />],
            ['Torque', <Qty key="t" value={{ value: 0.157, unit: 'N*m' }} />],
            ['Angle', <Qty key="a" value={{ value: 15, unit: 'deg' }} />],
            [
              'Money',
              <span key="m" className="num">
                {formatMoney({ amount: '12.50', currency: 'USD' })}
              </span>,
            ],
          ]}
        />
      </Block>
      <Block title="Times">
        <Facts
          rows={[
            ['Seconds earlier', <Time key="1" value={minutes(0.2)} />],
            ['Minutes earlier', <Time key="2" value={minutes(12)} />],
            ['Hours earlier', <Time key="3" value={minutes(185)} />],
            ['Days earlier', <Time key="4" value={minutes(60 * 24 * 5)} />],
            ['Date only', <Time key="5" value="2026-09-26" />],
            ['Exact', <Time key="6" value={minutes(12)} style="datetime" />],
          ]}
        />
        <p className="footnote">
          Offsets are from when this view opened. Hover a time for the exact moment; relative times
          keep themselves current.
        </p>
      </Block>
    </div>
  );
}

function ContentSpecimens() {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(true);
  return (
    <div className="stack">
      <Notice tone="warn">
        <strong>An input changed after this was recorded.</strong> Payload capacity → Rover mass
        budget → this
      </Notice>
      <Notice tone="ok" action={<Button size="sm">Resume agent</Button>}>
        Decision recorded. The agent can continue from it.
      </Notice>
      <Notice tone="err" role="alert">
        Missing input: battery mass is unknown.
      </Notice>
      <Notice tone="signal">Context: Camera tray, revision 3.</Notice>
      <Notice>An assumption is not an established fact.</Notice>
      <div className="specimen-grid">
        <Block title="Record" count={3}>
          <Facts
            rows={[
              ['Origin', 'agent · codex'],
              ['Evidence', <State key="e" state="calculated" dimension="evidence" quiet />],
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
            icon={<CheckCircle size={22} />}
            title="You’re caught up"
            body="Proposed changes arrive here with before-and-after values."
            action={
              <Button size="sm" onClick={() => toast('info', 'Specimen only. Nothing was opened.')}>
                Open the flow
              </Button>
            }
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Part</th>
              <th className="num">Qty</th>
              <th className="num">Mass</th>
              <th className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Camera Module 3<span className="cell-sub mono">SC0872</span>
              </td>
              <td className="num">1</td>
              <td className="num">
                <Qty value={{ value: 4, unit: 'g' }} />
              </td>
              <td className="num">{formatMoney({ amount: '25.00', currency: 'USD' })}</td>
            </tr>
            <tr>
              <td>
                LiPo 2S 450 mAh<span className="cell-sub mono">GNB-450-2S</span>
              </td>
              <td className="num">1</td>
              <td className="num">
                <Qty value={{ unknown: true, reason: '' }} />
              </td>
              <td className="num">{formatMoney(null)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="code-block">{`difference() {\n  cube([40, 30, 5]);\n  translate([10, 10, -1]) cylinder(d = 4, h = 7);\n}`}</pre>
      <Disclosure
        label="Controlled disclosure"
        meta="progressive detail"
        open={open}
        onToggle={() => setOpen((o) => !o)}
        actions={
          <Button size="sm" variant="ghost">
            Copy
          </Button>
        }
      >
        <p className="dim">
          Deep detail — arguments, diagnostics, identifiers — lives one interaction away.
        </p>
      </Disclosure>
      <Disclosure label="Self-managed disclosure" meta="defaultOpen false">
        <p className="dim">Opens and closes without a parent holding its state.</p>
      </Disclosure>
      <div className="row">
        <ExternalLink url="https://example.com/component">Example supplier</ExternalLink>
        <ExternalLink url="ftp://example.com/file" />
      </div>
    </div>
  );
}

function InProduct() {
  const projectId = useStore((s) => s.projectId);
  const { set, go, decide, toast } = useStore.getState();
  const rows: {
    name: string;
    where: string;
    open?: () => void;
    action?: string;
    needsProject?: boolean;
  }[] = [
    {
      name: 'Omnibar · commands and revision content',
      where: 'shell/Omnibar.tsx',
      action: 'Open ⌘K',
      open: () => set({ omniOpen: true }),
    },
    {
      name: 'Settings sheet',
      where: 'shell/Settings.tsx',
      action: 'Open ⌘,',
      open: () => set({ settingsOpen: true }),
    },
    {
      name: 'Toast (clears the decision bar and map controls)',
      where: 'frame/Toasts.tsx',
      action: 'Show one',
      open: () => toast('info', 'A toast from the catalogue. Nothing else happened.'),
    },
    {
      name: 'Agent window',
      where: 'shell/Agent.tsx, shell/agent/',
      action: 'Open ⌘J',
      open: () => set({ agentWindowOpen: true }),
      needsProject: true,
    },
    {
      name: 'Agent tab: conversation, inline cards, pane switch',
      where: 'chat/Conversation.tsx, chat/InlineCards.tsx, shell/agent/SessionBar.tsx',
      action: 'Open the conversation',
      open: () => {
        useAgentUi.getState().setPane('conversation');
        go({ level: 'agent' });
      },
      needsProject: true,
    },
    {
      name: 'Agent tab: session bar, terminal, activity rail',
      where: 'shell/agent/SessionBar.tsx, shell/agent/ActivityRail.tsx',
      action: 'Open the terminal',
      open: () => {
        useAgentUi.getState().setPane('terminal');
        go({ level: 'agent' });
      },
      needsProject: true,
    },
    {
      name: 'Flow map, map nodes, legend, peek, Needs you',
      where: 'project/FlowMap.tsx, project/flow/',
      action: 'Open the flow',
      open: () => go({ level: 'project', lens: 'flow' }),
      needsProject: true,
    },
    {
      name: 'Evidence matrix, evidence chips',
      where: 'project/EvidenceLens.tsx',
      action: 'Open ⌘5',
      open: () => go({ level: 'project', lens: 'evidence' }),
      needsProject: true,
    },
    {
      name: 'Lens table rows, totals strip, compare table',
      where: 'project/PartsLens.tsx',
      action: 'Open ⌘2',
      open: () => go({ level: 'project', lens: 'parts' }),
      needsProject: true,
    },
    {
      name: 'Folding rails, stage header, revision banner, save bar, viewport tools',
      where: 'object/ObjectView.tsx, object/rails.tsx, object/stages/, object/viewport/',
      action: 'Open from the flow',
      needsProject: true,
    },
    {
      name: 'Queue, phase notices, diff rows, decision bar',
      where: 'decide/DecideView.tsx, decide/DecisionBar.tsx',
      action: 'Open decisions',
      open: () => decide(null),
      needsProject: true,
    },
    {
      name: 'Unsaved-work prompt',
      where: 'frame/LeavePrompt.tsx',
      action: 'Leave an unsaved edit',
      needsProject: true,
    },
    {
      name: 'Frame strip, project loading',
      where: 'frame/FrameStrip.tsx, frame/StageStates.tsx',
      action: 'Shown when a load fails',
      needsProject: true,
    },
  ];
  return (
    <div className="stack">
      <Themes label="Activity bar, the real component (inert here)">
        {() => (
          <div className="specimen-activity" ref={(el) => el?.setAttribute('inert', '')}>
            <ActivityBar />
          </div>
        )}
      </Themes>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Source</th>
              <th>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const blocked = r.needsProject && !projectId;
              return (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="mono">{r.where}</td>
                  <td className="num">
                    {r.open ? (
                      <Button size="sm" variant="ghost" disabled={blocked} onClick={r.open}>
                        {r.action}
                      </Button>
                    ) : (
                      <span className="dim">{r.action}</span>
                    )}
                    {blocked && <span className="cell-sub">Open a project first</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        <Robot size={12} aria-hidden="true" /> The terminal pane is the real PTY and the
        conversation shows only real runs. The catalogue never shows a scripted session.
      </p>
    </div>
  );
}

/** Fails on request, so the boundary's fallback can be seen without a real defect. */
function Fragile({ broken, onBreak }: { broken: boolean; onBreak: () => void }) {
  if (broken) throw new Error('This specimen was asked to fail.');
  return (
    <div className="row">
      <Button size="sm" onClick={onBreak}>
        Fail this specimen
      </Button>
      <span className="dim">A failure stays inside its region.</span>
    </div>
  );
}
