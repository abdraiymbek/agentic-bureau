import React, { useId } from 'react';
import {
  ArrowRight,
  CaretRight,
  CheckCircle,
  Circle,
  Cube,
  FileText,
  ListChecks,
  Calculator,
  Circuitry,
  Code,
  Flask,
  Package,
  Link,
  WarningCircle,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import type { ArtifactView } from '@omenflow/contracts';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true" />
      {!compact && (
        <span>
          Omen <span className="brand-flow">Flow</span>
        </span>
      )}
    </span>
  );
}
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function IconButton({ label, children, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      className={`icon-button ${props.className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
});

const iconMap = {
  requirement: ListChecks,
  assumption: Circle,
  component: Package,
  mechanical: Cube,
  wiring: Circuitry,
  software: Code,
  calculation: Calculator,
  test: Flask,
  source: Link,
  assembly: Cube,
};
export function ArtifactIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = iconMap[type as keyof typeof iconMap] ?? FileText;
  return <Icon size={size} weight="regular" aria-hidden="true" />;
}
export const typeLabels: Record<string, string> = {
  mechanical: 'Mechanical',
  wiring: 'Electronics',
  software: 'Software',
  calculation: 'Calculations',
  test: 'Verification',
  assembly: 'Assembly',
  architecture: 'Architecture',
  concept: 'Concepts',
  subsystem: 'Subsystems',
  requirement: 'Requirements',
  assumption: 'Assumptions',
  component: 'Components',
  source: 'Sources',
  note: 'Notes',
};
const stateLabels: Record<string, string> = {
  current: 'Current',
  stale: 'Out of date',
  missing_input: 'Missing input',
  pending: 'In review',
  proposed: 'In review',
  accepted: 'Approved',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
  draft: 'Draft',
  selected: 'Selected',
  candidate: 'Candidate',
  superseded: 'Superseded',
  experimental: 'Experimental',
};
export function StatusBadge({ state, label }: { state: string; label?: string }) {
  const tone = ['current', 'accepted', 'approved', 'selected', 'passed'].includes(state)
    ? 'ok'
    : ['stale', 'pending', 'proposed', 'changes_requested', 'experimental'].includes(state)
      ? 'warn'
      : ['missing_input', 'rejected', 'failed'].includes(state)
        ? 'err'
        : 'neutral';
  const Icon =
    tone === 'ok' ? CheckCircle : tone === 'err' || tone === 'warn' ? WarningCircle : Circle;
  return (
    <span className={`status-badge ${tone}`}>
      <Icon size={12} />
      {label ?? stateLabels[state] ?? state.replaceAll('_', ' ')}
    </span>
  );
}
export function PageHeader({
  title,
  description,
  children,
  count,
  compact = false,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  count?: number;
  /** Object workspaces: the object is the subject, so the header only names the route. */
  compact?: boolean;
}) {
  return (
    <header className={`page-header ${compact ? 'compact' : ''}`}>
      <div>
        <div className="page-title-row">
          <h1>{title}</h1>
          {count !== undefined && <span className="count">{count}</span>}
        </div>
        {description && !compact && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon ?? <Cube size={25} weight="light" />}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder = 'Filter…',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-field">
      <MagnifyingGlass size={15} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <IconButton label="Clear filter" onClick={() => onChange('')}>
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}
/**
 * Collapsible group inside an object browser. Groups stay open by default; the engineer
 * folds the disciplines they are not working in. A group holding the selection never hides it.
 */
export function ObjectGroup({
  label,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="object-group">
      <button
        className="object-group-label"
        aria-expanded={!collapsed}
        onClick={onToggle}
        title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
      >
        <CaretRight size={11} className={`object-group-caret ${collapsed ? '' : 'open'}`} />
        <span className="grow truncate">{label}</span>
        <span>{count}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}
export function ObjectRow({
  view,
  selected,
  onClick,
  meta,
}: {
  view: ArtifactView;
  selected?: boolean;
  onClick: () => void;
  meta?: string;
}) {
  return (
    <button
      className={`object-row ${selected ? 'selected' : ''}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="object-icon">
        <ArtifactIcon type={view.artifact.type} />
      </span>
      <span className="object-row-copy">
        <span>{view.artifact.title}</span>
        <small>{meta ?? (view.revision ? `Revision ${view.revision.seq}` : 'No baseline')}</small>
      </span>
      {view.freshness !== 'current' && (
        <WarningCircle className="warn" size={14} aria-label="Needs attention" />
      )}
      {view.pendingProposal && <span className="review-dot" title="Pending review" />}
    </button>
  );
}
export function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {action}
    </div>
  );
}
export function TextLink({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className="text-link">
      {children}
      <ArrowRight size={14} />
    </button>
  );
}
export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && <p id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}
