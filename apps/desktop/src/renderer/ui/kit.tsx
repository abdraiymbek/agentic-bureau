/**
 * Bureau primitives. Every surface is built from these and the tokens.
 * The live catalogue is the Design system view (`system/DesignSystemView.tsx`).
 */
import React, { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import * as RadixTooltip from '@radix-ui/react-tooltip';
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
} from './icons';
import type { ArtifactType } from '@bureau/contracts';
import { absoluteDate, describeQuantity, formatDate, parseDate } from './format';
import type { DateStyle, QuantityInput } from './format';
import { ariaShortcut, displayShortcut } from './shortcuts';
import { stateWord } from './vocabulary';
import type { StateDimension, Tone } from './vocabulary';

/* ------------------------------------------------------------------ */
/* Brand                                                                */
/* ------------------------------------------------------------------ */

/** The mark's pixels on its 5-unit grid (column, row, which of the two colours). */
const MARK_PIXELS: [number, number, 0 | 1][] = [
  [0, 0, 0],
  [2, 0, 1],
  [4, 0, 0],
  [1, 1, 0],
  [3, 1, 1],
  [0, 3, 1],
  [2, 3, 0],
  [4, 3, 1],
  [1, 4, 1],
  [3, 4, 0],
];

/**
 * The Agentic Bureau mark: two rows of the checker, cyan and ice. The colours come from the
 * theme (`--signal`, `--ice`), so on light grounds the ice pixels turn Carbon. `mono` draws it
 * in the current text colour. Square pixels, never rounded, rotated or animated.
 */
export function Mark({
  size = 18,
  className,
  mono = false,
}: {
  size?: number;
  className?: string;
  mono?: boolean;
}) {
  return (
    <svg
      className={className ? `mark ${className}` : 'mark'}
      width={size}
      height={size}
      viewBox="0 0 98 98"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {MARK_PIXELS.map(([x, y, tone]) => (
        <rect
          key={`${x}-${y}`}
          x={x * 20}
          y={y * 20}
          width={18}
          height={18}
          fill={mono ? 'currentColor' : tone ? 'var(--ice)' : 'var(--signal)'}
        />
      ))}
    </svg>
  );
}

export function Brand({ size = 18 }: { size?: number }) {
  return (
    <span className="brand">
      <Mark size={size} />
      <span className="brand-word">Bureau</span>
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

export { stateLabel, stateTone, stateWord, VOCABULARY } from './vocabulary';
export type { StateDimension, StateWord, Tone } from './vocabulary';

/**
 * A labelled engineering state: a dot plus the one word the vocabulary gives it. Colour never
 * carries meaning alone. Name the dimension when a state word is ambiguous ("partial").
 */
export function State({
  state,
  dimension,
  label,
  tone,
  quiet = false,
}: {
  state: string;
  dimension?: StateDimension;
  /** Overrides the vocabulary word; use only for a sentence-specific label. */
  label?: string;
  tone?: Tone;
  quiet?: boolean;
}) {
  const word = stateWord(state, dimension);
  return (
    <span className={`state tone-${tone ?? word.tone}${quiet ? ' quiet' : ''}`}>
      <span className="state-dot" aria-hidden="true" />
      {label ?? word.label}
    </span>
  );
}

/**
 * The live pixel: a 3×3 field that steps while something actually runs now. Under reduced
 * motion it holds one frame. Pair it with a word.
 */
export function Pulse({ tone = 'signal' }: { tone?: Tone }) {
  return (
    <span className={`pulse tone-${tone}`} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                             */
/* ------------------------------------------------------------------ */

const TooltipShared = React.createContext(false);

// A tooltip follows focus only while the user moves it with Tab. Focus that a sheet or a menu
// places for them would otherwise open a tooltip that then takes the next Escape for itself.
let tabbing = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (tabbing = e.key === 'Tab'), true);
  window.addEventListener('pointerdown', () => (tabbing = false), true);
}

/** One provider at the application root lets neighbouring tooltips skip their delay. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={500} skipDelayDuration={300}>
      <TooltipShared.Provider value={true}>{children}</TooltipShared.Provider>
    </RadixTooltip.Provider>
  );
}

/** Names a control on hover and when Tab reaches it. The child must accept a ref and DOM props. */
export function Tooltip({
  label,
  shortcut,
  children,
  side = 'top',
}: {
  label: React.ReactNode;
  /** Shown after the label, such as "⌘J". */
  shortcut?: string;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const shared = useContext(TooltipShared);
  const tip = (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger
        asChild
        onFocus={(e) => {
          if (!tabbing) e.preventDefault();
        }}
      >
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {label}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
  // Also works outside the root provider: isolated renders and tests.
  return shared ? tip : <RadixTooltip.Provider delayDuration={500}>{tip}</RadixTooltip.Provider>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'signal';

const present = (node: React.ReactNode) => node !== null && node !== undefined && node !== false;

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    /** 26, 32 or 38 px. */
    size?: 'sm' | 'md' | 'lg';
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
    /**
     * Work is in flight: a spinner takes the icon's place (or covers the label when there is no
     * icon), the width does not change, and presses are ignored. The button stays focusable.
     */
    busy?: boolean;
    /** Keyboard shortcut shown after the label, such as "⌘↵". Announced as a shortcut, not as text. */
    shortcut?: string;
  }
>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    trailing,
    busy = false,
    shortcut,
    children,
    className,
    type,
    onClick,
    ...props
  },
  ref,
) {
  const hasIcon = present(icon);
  const spinner = (
    <span className="btn-spinner" aria-hidden="true">
      <Spinner size={size === 'sm' ? 10 : 12} />
    </span>
  );
  const classes = ['btn', `btn-${variant}`, `btn-${size}`];
  if (busy) classes.push(hasIcon ? 'busy' : 'busy busy-cover');
  if (className) classes.push(className);
  return (
    <button
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      {...props}
      {...(busy ? { 'aria-busy': true, 'aria-disabled': true } : null)}
      ref={ref}
      type={type ?? 'button'}
      className={classes.join(' ')}
      onClick={busy ? (e) => e.preventDefault() : onClick}
    >
      {hasIcon && (
        <span className="btn-icon">
          {icon}
          {busy && spinner}
        </span>
      )}
      {present(children) && <span className="btn-label">{children}</span>}
      {shortcut && <Kbd aria-hidden="true">{shortcut}</Kbd>}
      {trailing}
      {busy && !hasIcon && spinner}
    </button>
  );
});

export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    /** The accessible name and the tooltip. */
    label: string;
    /** 26, 32 or 38 px square. */
    size?: 'sm' | 'md' | 'lg';
    /** Shown in the tooltip and announced as the shortcut. */
    shortcut?: string;
    /** For toggles: rendered as `aria-pressed` and a held-down look. */
    pressed?: boolean;
  }
>(function IconButton(
  { label, size = 'md', shortcut, pressed, children, className, type, ...props },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
        aria-pressed={pressed}
        {...props}
        ref={ref}
        type={type ?? 'button'}
        className={`icon-btn icon-btn-${size}${className ? ` ${className}` : ''}`}
        aria-label={label}
      >
        {children}
      </button>
    </Tooltip>
  );
});

/** A key or chord. Written Mac style; other platforms see Ctrl, Alt and Shift. */
export function Kbd({
  children,
  ...props
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd className="kbd" {...props}>
      {typeof children === 'string' ? displayShortcut(children) : children}
    </kbd>
  );
}

const CONFIRM_WINDOW_MS = 4000;

/**
 * A destructive or irreversible action that takes two presses. The first press arms it and
 * swaps the label; it stands down after a few seconds, on blur, on Escape, or on a press elsewhere.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  tone = 'err',
  size = 'md',
  icon,
  disabled,
  busy,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  tone?: 'err' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    // WebKit does not focus a clicked button, so blur alone would miss a press elsewhere.
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [armed]);
  return (
    <>
      <Button
        ref={ref}
        variant={tone === 'err' ? 'danger' : 'ghost'}
        size={size}
        icon={icon}
        disabled={disabled}
        busy={busy}
        className={armed ? 'armed' : undefined}
        onBlur={() => setArmed(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && armed) {
            e.stopPropagation();
            setArmed(false);
          }
        }}
        onClick={() => {
          setArmed(!armed);
          if (armed) onConfirm();
        }}
      >
        {armed ? confirmLabel : label}
      </Button>
      <span className="sr-only" role="status">
        {armed ? `${confirmLabel} Press again to confirm.` : ''}
      </span>
    </>
  );
}

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  tone?: 'err' | 'neutral';
  shortcut?: string;
  disabled?: boolean;
}

/** A short list of actions behind one trigger. The trigger must accept a ref and DOM props. */
export function Menu({
  trigger,
  items,
  align = 'start',
}: {
  trigger: React.ReactElement;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          className="menu"
          align={align}
          sideOffset={6}
          // Escape closes the menu and nothing else; the workspace does not also zoom out.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => (
            <RadixMenu.Item
              key={`${i}:${item.label}`}
              className={`menu-item${item.tone === 'err' ? ' tone-err' : ''}`}
              disabled={item.disabled}
              aria-keyshortcuts={item.shortcut ? ariaShortcut(item.shortcut) : undefined}
              onSelect={item.onSelect}
            >
              {item.icon}
              <span className="grow truncate">{item.label}</span>
              {item.shortcut && <Kbd aria-hidden="true">{item.shortcut}</Kbd>}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/** Index of the option an arrow key moves to, skipping disabled ones; -1 when there is none. */
export function segmentedStep(
  disabled: boolean[],
  from: number,
  key: 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp' | 'Home' | 'End',
): number {
  const n = disabled.length;
  const enabled = disabled.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0]!;
  if (key === 'End') return enabled[enabled.length - 1]!;
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}

const STEP_KEYS = new Set(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']);

/**
 * One choice among a few: lenses, modes, themes. A radio group with one tab stop; arrow keys,
 * Home and End move the choice.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value && !o.disabled);
  const tabStop = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!STEP_KEYS.has(e.key)) return;
        const from = refs.current.findIndex((el) => el === document.activeElement);
        const next = segmentedStep(
          options.map((o) => !!o.disabled),
          from < 0 ? tabStop : from,
          e.key as Parameters<typeof segmentedStep>[2],
        );
        if (next < 0) return;
        e.preventDefault();
        refs.current[next]?.focus();
        if (options[next]!.value !== value) onChange(options[next]!.value);
      }}
    >
      {options.map((o, i) => (
        <button
          type="button"
          role="radio"
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          aria-checked={o.value === value}
          aria-label={o.count === undefined ? undefined : `${o.label}, ${o.count}`}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="count" aria-hidden="true">
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

type FieldChild = React.ReactElement<{
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}>;

/** Label, one control, and a hint or an error, connected by id. Keeps the control's own id. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  /** Replaces the hint and marks the control invalid. */
  error?: string;
  required?: boolean;
  children: FieldChild;
  className?: string;
}) {
  const generated = useId();
  const id = children.props.id ?? generated;
  const note = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && <span className="field-required"> required</span>}
      </label>
      {React.cloneElement(children, {
        id,
        'aria-describedby':
          [children.props['aria-describedby'], note].filter(Boolean).join(' ') || undefined,
        'aria-invalid': error ? true : children.props['aria-invalid'],
        'aria-required': required || children.props['aria-required'],
      })}
      {error ? (
        <p id={note} className="field-error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p id={note}>{hint}</p>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className={`checkbox${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="checkbox-copy">
        {label}
        {hint && <small id={`${id}-hint`}>{hint}</small>}
      </span>
    </label>
  );
}

export interface QuantityValue {
  /** null means not set. It is never shown, summed, or saved as zero. */
  value: number | null;
  unit: string;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Empty text is null (not set); undefined means the text is not a number. */
function parseQuantity(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = DECIMAL.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const quantityText = (n: number | null) => (n === null ? '' : String(n));

/**
 * One quantity: a value and its unit, changed together. Every change reports both. Text that
 * is not a number is flagged and never reported; leaving the field restores the recorded value.
 */
export function QuantityField({
  value,
  onChange,
  units,
  label,
  hint,
  disabled,
  placeholder = '—',
}: {
  value: QuantityValue;
  onChange: (next: QuantityValue) => void;
  /** Offered units. Without them the unit is free text. */
  units?: string[];
  label?: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  // What is being typed, with the number it stands for. Once the recorded value moves away
  // from that number (another revision, an undo), the recorded value is shown again.
  const [draft, setDraft] = useState({ text: quantityText(value.value), of: value.value });
  const text = draft.of === value.value ? draft.text : quantityText(value.value);
  const invalid = parseQuantity(text) === undefined;
  const name = label ?? 'Quantity';
  const describedBy = invalid ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <div className={`quantity${invalid ? ' invalid' : ''}${disabled ? ' disabled' : ''}`}>
        <input
          id={id}
          className="quantity-value num"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label ? undefined : `${name} value`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            const parsed = parseQuantity(e.target.value);
            setDraft({ text: e.target.value, of: parsed === undefined ? value.value : parsed });
            if (parsed !== undefined && parsed !== value.value)
              onChange({ value: parsed, unit: value.unit });
          }}
          onBlur={() => {
            if (invalid) setDraft({ text: quantityText(value.value), of: value.value });
          }}
        />
        {units?.length ? (
          <select
            className="quantity-unit"
            aria-label={`${name} unit`}
            value={value.unit}
            disabled={disabled}
            onChange={(e) => onChange({ value: value.value, unit: e.target.value })}
          >
            {[...new Set([...units, value.unit])].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="quantity-unit"
            aria-label={`${name} unit`}
            autoComplete="off"
            spellCheck={false}
            value={value.unit}
            placeholder="unit"
            disabled={disabled}
            onChange={(e) => onChange({ value: value.value, unit: e.target.value })}
          />
        )}
      </div>
      {invalid ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          Not a number. Clear the field to leave it not set.
        </p>
      ) : (
        hint && <p id={`${id}-hint`}>{hint}</p>
      )}
    </div>
  );
}

/** A quantity as text: value and unit kept together; not set and unknown said in words. */
export function Qty({ value, digits }: { value: QuantityInput; digits?: number }) {
  const { text, known } = describeQuantity(value, digits);
  return <span className={known ? 'qty num' : 'qty unknown'}>{text}</span>;
}

/** Spoken before a toned notice so its tone is never carried by the colour bar alone. */
const NOTICE_TONE_WORD: Partial<Record<Tone, string>> = {
  ok: 'Done',
  warn: 'Attention',
  err: 'Problem',
};

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
  const word = NOTICE_TONE_WORD[tone];
  return (
    <div className={`notice tone-${tone}`} role={role}>
      <span className="notice-bar" aria-hidden="true" />
      <div className="notice-body">
        {word && <span className="sr-only">{word}: </span>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
  icon,
  as: Heading = 'h3',
}: {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  /** The heading level that fits the surrounding outline. */
  as?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <Heading className="empty-title">{title}</Heading>
      {body && <p>{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/**
 * Progressive detail. Controlled with `open` and `onToggle`, or self-managed from `defaultOpen`.
 */
export function Disclosure({
  label,
  meta,
  open,
  defaultOpen = false,
  onToggle,
  actions,
  children,
}: {
  label: string;
  meta?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const bodyId = useId();
  return (
    <section className={`disclosure${isOpen ? ' open' : ''}`}>
      <div className="disclosure-head">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={isOpen ? bodyId : undefined}
          onClick={() => {
            if (open === undefined) setOwn(!own);
            onToggle?.();
          }}
        >
          <CaretRight size={11} className="disclosure-caret" aria-hidden="true" />
          <span>{label}</span>
          {meta && <span className="disclosure-meta">{meta}</span>}
        </button>
        {isOpen && actions && <div className="disclosure-actions">{actions}</div>}
      </div>
      {isOpen && (
        <div className="disclosure-body" id={bodyId}>
          {children}
        </div>
      )}
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
    <section className={`block${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="block-head">
          {title && (
            <h3>
              {title}
              {count !== undefined && (
                <>
                  <span className="sr-only">, </span>
                  <span className="count">{count}</span>
                </>
              )}
            </h3>
          )}
          {actions && <div className="block-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Key/value rows for engineering metadata. Values are selectable. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Work in flight. Decorative unless it has a label, which is announced politely. */
export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  const ring = (
    <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
  );
  if (!label) return ring;
  return (
    <span className="spinner-labelled" role="status">
      {ring}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A placeholder with the rough shape of content that is still loading. */
export function Skeleton({
  lines = 1,
  width,
  height,
}: {
  lines?: number;
  width?: number | string;
  height?: number | string;
}) {
  return (
    <span className="skeleton" role="status" style={{ width }}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="skeleton-line"
          style={{ height, width: lines > 1 && i === lines - 1 ? '62%' : undefined }}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

export {
  absoluteDate,
  describeQuantity,
  displayUnit,
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  parseDate,
} from './format';
export type { DateStyle, QuantityInput, QuantityText } from './format';
export { ariaShortcut, displayShortcut, isMacPlatform } from './shortcuts';

/** Relative time in words ("12 min ago"); unreadable input reads "Unknown time". */
export function relativeTime(iso: string, now = Date.now()): string {
  return formatDate(iso, 'relative', now);
}

// Every mounted <Time> re-renders from one shared clock, twice a minute.
const TICK_MS = 30_000;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  clockTimer ??= setInterval(() => clockListeners.forEach((l) => l()), TICK_MS);
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer !== undefined) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
const clockNow = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

/**
 * A recorded time. Relative by default and kept current while it is on screen; the exact time is
 * in `dateTime` and on hover.
 */
export function Time({ value, style = 'relative' }: { value: string; style?: DateStyle }) {
  // Subscribing re-renders this on every tick; the text is computed from the clock at render.
  useSyncExternalStore(subscribeClock, clockNow, clockNow);
  const parsed = parseDate(value);
  return (
    <time
      className="num"
      dateTime={parsed ? (parsed.dateOnly ? value : parsed.date.toISOString()) : undefined}
      title={absoluteDate(value)}
    >
      {formatDate(value, style)}
    </time>
  );
}

export function shortId(id: string) {
  return id.slice(0, 8);
}

export function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
