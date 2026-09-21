import React, { useState } from 'react';
import {
  ArrowRight,
  Cube,
  Sun,
  Moon,
  CheckCircle,
  GitBranch,
  MagnifyingGlass,
  WarningCircle,
  SlidersHorizontal,
  ListChecks,
} from '@phosphor-icons/react';
import {
  ArtifactIcon,
  Brand,
  EmptyState,
  FormField,
  IconButton,
  ObjectGroup,
  PageHeader,
  SearchField,
  SectionHeading,
  StatusBadge,
} from '../components/ui';
import { useStore } from '../store';

export function DesignSystemView() {
  const { theme, density, set, toast } = useStore();
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('Camera mounting plate');
  const [selected, setSelected] = useState('Requirements');
  const [groupCollapsed, setGroupCollapsed] = useState(false);
  const swatches = [
    { label: 'Application', token: '--bg-app' },
    { label: 'Workspace', token: '--bg-main' },
    { label: 'Raised', token: '--bg-raised' },
    { label: 'Inset', token: '--bg-inset' },
    { label: 'Selection', token: '--accent-soft' },
    { label: 'Accent', token: '--accent' },
  ];
  return (
    <div className="page-scroll design-reference">
      <PageHeader
        title="The Omen Flow system"
        description="A working reference for every surface, object, and interaction."
      >
        <div className="segmented">
          <button aria-pressed={theme === 'dark'} onClick={() => set({ theme: 'dark' })}>
            <Moon size={14} />
            Dark
          </button>
          <button aria-pressed={theme === 'light'} onClick={() => set({ theme: 'light' })}>
            <Sun size={14} />
            Light
          </button>
        </div>
      </PageHeader>
      <section className="ds-brand">
        <Brand />
        <h2>Precision in flow.</h2>
        <p>The engineering stays connected. The interface stays out of your way.</p>
        <div className="ds-principles">
          <span>Intent before decoration</span>
          <span>Evidence before confidence</span>
          <span>One continuous workspace</span>
        </div>
      </section>
      <section className="ds-section">
        <SectionHeading title="Surfaces & color" />
        <div className="swatch-grid">
          {swatches.map((s) => (
            <div key={s.token}>
              <div style={{ background: `var(${s.token})` }} className="swatch" />
              <strong>{s.label}</strong>
              <code>{s.token}</code>
            </div>
          ))}
        </div>
        <p className="ds-note">
          Blue means focus or selection. Green, amber, and red communicate engineering state, always
          with a label.
        </p>
      </section>
      <section className="ds-section">
        <SectionHeading title="Typography" />
        <div className="type-specimen">
          <span>Geist / Interface</span>
          <h1>Engineering begins with a clear intent.</h1>
          <h2>Camera mounting plate</h2>
          <p>Track the design, its constraints, and the evidence behind each decision.</p>
          <code>mass = 184.20 g · tolerance ±0.05 mm</code>
        </div>
        <p className="ds-note">
          24–32 px for project identity. 20 px for page titles. 13 px for working content. IBM Plex
          Mono for code and technical expressions.
        </p>
      </section>
      <section className="ds-section">
        <SectionHeading title="Actions & interaction" />
        <div className="ds-example-row">
          <button className="primary" onClick={() => toast('ok', 'Example action completed')}>
            <CheckCircle size={15} />
            Approve changes
          </button>
          <button onClick={() => toast('info', 'Secondary action example')}>Preview impact</button>
          <button className="ghost" onClick={() => toast('info', 'Tertiary action example')}>
            Cancel
          </button>
          <button
            className="danger"
            onClick={() => toast('info', 'Destructive action example only')}
          >
            Reject
          </button>
          <button disabled>Unavailable</button>
          <IconButton
            label="Example settings"
            onClick={() => toast('info', 'Icon buttons always have accessible names')}
          >
            <SlidersHorizontal size={16} />
          </IconButton>
        </div>
        <p className="ds-note">
          One primary action per decision area. Icon buttons have an accessible name, a hover label,
          and a visible keyboard focus ring.
        </p>
      </section>
      <section className="ds-section">
        <SectionHeading title="Engineering state" />
        <p className="dim">
          CAD review binds the viewport and assertion table to the displayed candidate revision.
          Baseline overlay, candidate and baseline source disclosures, effective overrides, and
          coverage limitations share this identity. Scope acceptance is a separate, explicit
          checkbox; approval alone does not establish verification. Loading and service errors use
          the existing labeled notices.
        </p>
        <div className="ds-example-row">
          {['approved', 'pending', 'draft', 'stale', 'missing_input', 'rejected', 'experimental'].map(
            (state) => (
            <StatusBadge key={state} state={state} />
            ),
          )}
        </div>
        <div className="inline-notice warning">
          <div className="row">
            <WarningCircle size={16} />
            <strong>An input changed</strong>
          </div>
          Payload requirement changed from 300 g to 500 g. Recalculate the mass budget before using
          this result.
        </div>
        <div className="inline-notice warning" role="alert">
          artifact.apply_edit: Working file diverged — review the conflict candidate. The source
          was left unchanged.
          <span className="mono dim"> REVISION_CONFLICT</span>
        </div>
        <p className="ds-note">
          Illustrative state example. Review state, freshness, and evidence are independent
          dimensions. Recoverable command failures keep the stable code and repair action visible
          until the engineer dismisses them.
        </p>
      </section>
      <section className="ds-section">
        <SectionHeading title="Forms & selection" />
        <div className="ds-form-grid">
          <div>
            <FormField label="Object name" hint="Use the name engineers would use in a review.">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <SearchField value={filter} onChange={setFilter} placeholder="Filter example objects" />
          </div>
          <div className="ds-nav-example">
            {['Requirements', 'Design files', 'Review queue']
              .filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
              .map((label) => {
                const Icon =
                  { Requirements: ListChecks, 'Design files': Cube, 'Review queue': GitBranch }[
                    label
                  ] ?? Cube;
                return (
                  <button
                    key={label}
                    className={`nav-item ${selected === label ? 'active' : ''}`}
                    onClick={() => setSelected(label)}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                );
              })}
            <p className="ds-note">Selected: {selected}</p>
          </div>
        </div>
        <div className="ds-form-grid">
          <div className="ds-nav-example" style={{ background: 'var(--bg-main)' }}>
            <ObjectGroup
              label="Calculations"
              count={2}
              collapsed={groupCollapsed}
              onToggle={() => setGroupCollapsed((c) => !c)}
            >
              <button className="object-row selected" aria-pressed="true">
                <span className="object-icon">
                  <ArtifactIcon type="calculation" />
                </span>
                <span className="object-row-copy">
                  <span>Rover mass budget</span>
                  <small>Revision 1</small>
                </span>
              </button>
              <button className="object-row">
                <span className="object-icon">
                  <ArtifactIcon type="calculation" />
                </span>
                <span className="object-row-copy">
                  <span>Wheel torque at 15° incline</span>
                  <small>Revision 1</small>
                </span>
              </button>
            </ObjectGroup>
            <p className="ds-note">
              Object browser group. Groups fold so the engineer sees only the disciplines in play; a
              search or the current selection always keeps its group open. Calculation objects are
              labeled experimental until quantity bindings and derived units are finished.
            </p>
          </div>
          <div>
            <div className="ds-nav-example" style={{ padding: 0, overflow: 'hidden' }}>
              <PageHeader title="Design files" count={26} compact />
            </div>
            <p className="ds-note">
              Compact page header for object workspaces: the route is named once, the object owns
              the surface, and the breadcrumb carries the full location.
            </p>
          </div>
        </div>
      </section>
      <section className="ds-section">
        <SectionHeading
          title="Data & density"
          action={
            <div className="segmented">
              <button
                aria-pressed={density === 'comfortable'}
                onClick={() => set({ density: 'comfortable' })}
              >
                Comfortable
              </button>
              <button
                aria-pressed={density === 'compact'}
                onClick={() => set({ density: 'compact' })}
              >
                Compact
              </button>
            </div>
          }
        />
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Example object</th>
                <th>Revision</th>
                <th>Review state</th>
                <th className="numeric">Mass</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Camera mounting plate<small>Mechanical design</small>
                </td>
                <td>r03</td>
                <td>
                  <StatusBadge state="approved" />
                </td>
                <td className="numeric">184.20 g</td>
              </tr>
              <tr>
                <td>
                  Protective enclosure<small>Mechanical design</small>
                </td>
                <td>r01</td>
                <td>
                  <StatusBadge state="draft" />
                </td>
                <td className="numeric">Unknown</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="ds-note">
          These are component specimens. Unknown data never becomes zero. Numeric columns align
          right and always keep their units.
        </p>
      </section>
      <section className="ds-section">
        <SectionHeading title="Empty & filtered states" />
        <div className="ds-empty-example">
          <EmptyState
            title="No matching design files"
            body="Try another name, or clear the filter to see every object."
            icon={<MagnifyingGlass size={24} />}
            action={
              <button
                onClick={() => {
                  setFilter('');
                  toast('info', 'Example filter cleared');
                }}
              >
                Clear filter
                <ArrowRight size={14} />
              </button>
            }
          />
        </div>
      </section>
      <footer className="ds-footer">
        Canonical specification: <code>design-system/design.md</code>
        <br />
        Components in this page use the same tokens and primitives as the application.
      </footer>
    </div>
  );
}
