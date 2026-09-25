/**
 * Omen Flow primitives. Every surface is built from these and the tokens.
 * The live catalogue is the Design system view (`system/DesignSystemView.tsx`).
 */
import React, { useId } from 'react';
import {
  Calculator,
  CaretRight,
  Circle,
  Circuitry,
  Code,
  Cube,
  FileText,
  Flask,
  Link,
  ListChecks,
  Lightbulb,
  Package,
  Stack,
  TreeStructure,
  Wrench,
  Question,
  type Icon,
} from '@phosphor-icons/react';
import type { ArtifactType } from '@omenflow/contracts';

/* ------------------------------------------------------------------ */
/* Brand                                                                */
/* ------------------------------------------------------------------ */

/** The Omen Flow mark: three facets meeting at one point. Always monochrome. */
export function Mark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="60 48 380 380"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinejoin="round"
    >
      <path d="M241.5 84 L227.2 253 Q225.8 267.5 213.5 276 L70.5 375 Z" />
      <path d="M258.5 84 L272.8 253 Q274.2 267.5 286.5 276 L429.5 375 Z" />
      <path d="M80 393 L238 325 Q250 318.5 262 325 L420 393 Z" />
    </svg>
  );
}

export function Brand({ size = 18 }: { size?: number }) {
  return (
    <span className="brand">
      <Mark size={size} />
      <span className="brand-word">
        Omen <span>Flow</span>
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Engineering object types                                             */
/* ------------------------------------------------------------------ */

export type Layer = 'intent' | 'design' | 'parts' | 'evidence';

export const LAYERS: { id: Layer; label: string; hint: string }[] = [
  { id: 'intent', label: 'Intent', hint: 'What it must do' },
  { id: 'design', label: 'Design', hint: 'How it is built' },
  { id: 'parts', label: 'Parts', hint: 'What it is made of' },
  { id: 'evidence', label: 'Evidence', hint: 'Why we believe it' },
];

interface TypeMeta {
  label: string;
  plural: string;
  icon: Icon;
  layer: Layer;
}

export const TYPES: Record<ArtifactType, TypeMeta> = {
  requirement: { label: 'Requirement', plural: 'Requirements', icon: ListChecks, layer: 'intent' },
  assumption: { label: 'Assumption', plural: 'Assumptions', icon: Question, layer: 'intent' },
  concept: { label: 'Concept', plural: 'Concepts', icon: Lightbulb, layer: 'design' },
  architecture: {
    label: 'Architecture',
    plural: 'Architecture',
    icon: TreeStructure,
    layer: 'design',
  },
  subsystem: { label: 'Subsystem', plural: 'Subsystems', icon: Stack, layer: 'design' },
  mechanical: { label: 'Mechanical', plural: 'Mechanical', icon: Cube, layer: 'design' },
  wiring: { label: 'Electronics', plural: 'Electronics', icon: Circuitry, layer: 'design' },
  software: { label: 'Software', plural: 'Software', icon: Code, layer: 'design' },
  assembly: { label: 'Assembly', plural: 'Assembly', icon: Wrench, layer: 'design' },
  note: { label: 'Note', plural: 'Notes', icon: FileText, layer: 'design' },
  component: { label: 'Component', plural: 'Components', icon: Package, layer: 'parts' },
  source: { label: 'Source', plural: 'Sources', icon: Link, layer: 'parts' },
  calculation: {
    label: 'Calculation',
    plural: 'Calculations',
    icon: Calculator,
    layer: 'evidence',
  },
  test: { label: 'Test', plural: 'Tests', icon: Flask, layer: 'evidence' },
};

export const TYPE_ORDER = Object.keys(TYPES) as ArtifactType[];

export function typeMeta(type: string): TypeMeta {
  return (
    TYPES[type as ArtifactType] ?? { label: type, plural: type, icon: Circle, layer: 'design' }
  );
}

export function TypeGlyph({ type, size = 15 }: { type: string; size?: number }) {
  const Glyph = typeMeta(type).icon;
  return <Glyph size={size} weight="regular" aria-hidden="true" className="type-glyph" />;
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

export type Tone = 'ok' | 'warn' | 'err' | 'signal' | 'neutral';

const STATE_LABELS: Record<string, string> = {
  current: 'Current',
  stale: 'Out of date',
  missing_input: 'Missing input',
  pending: 'Needs review',
  proposed: 'In review',
  accepted: 'Approved',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
  conflicted: 'Conflicted',
  cancelled: 'Cancelled',
  draft: 'Draft',
  selected: 'Selected',
  candidate: 'Candidate',
  superseded: 'Superseded',
  experimental: 'Experimental',
  passed: 'Passed',
  failed: 'Failed',
  inconclusive: 'Inconclusive',
  not_run: 'Not run',
  running: 'Running',
  starting: 'Starting',
  exited: 'Ended',
  interrupted: 'Interrupted',
};

export function stateTone(state: string): Tone {
  if (['current', 'accepted', 'approved', 'selected', 'passed'].includes(state)) return 'ok';
  if (
    ['stale', 'pending', 'proposed', 'changes_requested', 'experimental', 'conflicted'].includes(
      state,
    )
  )
    return 'warn';
  if (['missing_input', 'rejected', 'failed'].includes(state)) return 'err';
  if (['running', 'starting'].includes(state)) return 'signal';
  return 'neutral';
}

export function stateLabel(state: string) {
  return STATE_LABELS[state] ?? state.replaceAll('_', ' ');
}

/** A labelled engineering state. Colour never carries meaning alone. */
export function State({
  state,
  label,
  tone,
  quiet = false,
}: {
  state: string;
  label?: string;
  tone?: Tone;
  quiet?: boolean;
}) {
  const t = tone ?? stateTone(state);
  return (
    <span className={`state tone-${t} ${quiet ? 'quiet' : ''}`}>
      <span className="state-dot" aria-hidden="true" />
      {label ?? stateLabel(state)}
    </span>
  );
}

/** Live pulse for things that are actually running now. */
export function Pulse({ tone = 'signal' }: { tone?: Tone }) {
  return <span className={`pulse tone-${tone}`} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Controls                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'signal';

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: 'sm' | 'md' | 'lg';
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
  }
>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, children, className, type, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type ?? 'button'}
      className={`btn btn-${variant} btn-${size} ${className ?? ''}`}
    >
      {icon}
      {children && <span className="btn-label">{children}</span>}
      {trailing}
    </button>
  );
});

export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }
>(function IconButton({ label, size = 'md', children, className, type, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type ?? 'button'}
      className={`icon-btn icon-btn-${size} ${className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
});

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`field ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && <p id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  children,
  action,
  role,
}: {
  tone?: Tone;
  children: React.ReactNode;
  action?: React.ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`notice tone-${tone}`} role={role}>
      <span className="notice-bar" aria-hidden="true" />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Disclosure({
  label,
  meta,
  open,
  onToggle,
  actions,
  children,
}: {
  label: string;
  meta?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`disclosure ${open ? 'open' : ''}`}>
      <div className="disclosure-head">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <CaretRight size={11} className="disclosure-caret" />
          <span>{label}</span>
          {meta && <span className="disclosure-meta">{meta}</span>}
        </button>
        {open && actions && <div className="disclosure-actions">{actions}</div>}
      </div>
      {open && <div className="disclosure-body">{children}</div>}
    </section>
  );
}

/** A quiet labelled block used on stages. */
export function Block({
  title,
  count,
  actions,
  children,
  className,
}: {
  title?: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`block ${className ?? ''}`}>
      {(title || actions) && (
        <header className="block-head">
          {title && (
            <h3>
              {title}
              {count !== undefined && <span className="count">{count}</span>}
            </h3>
          )}
          {actions && <div className="block-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Key/value rows for engineering metadata. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortId(id: string) {
  return id.slice(0, 8);
}

export function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
