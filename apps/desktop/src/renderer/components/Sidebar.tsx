import React from 'react';
import {
  Cube,
  FileText,
  Folder,
  GitBranch,
  Cube as _Cube,
  ListChecks,
  RadioButton,
  ClockCounterClockwise,
  ListBullets,
} from '@phosphor-icons/react';
import { useStore, type Nav } from '../store';

const NAV: { id: Nav; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <ListBullets size={14} /> },
  { id: 'requirements', label: 'Requirements', icon: <ListChecks size={14} /> },
  { id: 'components', label: 'Components', icon: <Cube size={14} /> },
  { id: 'artifacts', label: 'Artifacts', icon: <FileText size={14} /> },
  { id: 'reviews', label: 'Reviews', icon: <RadioButton size={14} /> },
  { id: 'history', label: 'History', icon: <ClockCounterClockwise size={14} /> },
  { id: 'files', label: 'Files', icon: <Folder size={14} /> },
  { id: 'connections', label: 'Connections', icon: <GitBranch size={14} /> },
];

export function Sidebar() {
  const { nav, navigate, proposals, artifacts, selectArtifact, stale } = useStore();
  const pending = proposals.filter((p) => p.state === 'pending').length;
  const mech = artifacts.filter((v) => v.artifact.type === 'mechanical');
  const wiring = artifacts.filter((v) => v.artifact.type === 'wiring');
  const software = artifacts.filter((v) => v.artifact.type === 'software');
  const staleCount = Object.values(stale).filter((s) => s.length > 0).length;

  const group = (label: string, views: typeof mech) =>
    views.length > 0 && (
      <div style={{ marginTop: 12 }}>
        <div
          className="faint"
          style={{
            fontSize: 11,
            padding: '0 8px 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {label}
        </div>
        {views.map((v) => (
          <NavRow
            key={v.artifact.id}
            label={v.artifact.title}
            active={false}
            stale={(stale[v.artifact.id] ?? []).length > 0}
            onClick={() => {
              selectArtifact(v.artifact.id);
              navigate('artifacts');
            }}
          />
        ))}
      </div>
    );

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: 'var(--bg-app)',
        borderRight: '1px solid var(--border)',
        padding: '8px 0',
        fontSize: 13,
      }}
    >
      {NAV.map((n) => (
        <NavRow
          key={n.id}
          label={n.label}
          icon={n.icon}
          active={nav === n.id}
          badge={n.id === 'reviews' && pending ? pending : undefined}
          stale={n.id === 'overview' && staleCount > 0}
          onClick={() => navigate(n.id)}
        />
      ))}
      {group('Mechanical', mech)}
      {group('Electronics', wiring)}
      {group('Software', software)}
      {staleCount > 0 && (
        <div className="warn" style={{ padding: '12px 8px 4px', fontSize: 12 }}>
          {staleCount} artifact{staleCount > 1 ? 's' : ''} stale
        </div>
      )}
    </div>
  );
}

function NavRow(props: {
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  badge?: number;
  stale?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={(e) => e.key === 'Enter' && props.onClick?.()}
      style={{
        height: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px',
        margin: '0 4px',
        borderRadius: 4,
        cursor: 'pointer',
        background: props.active ? 'var(--bg-raised)' : 'transparent',
        color: props.active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {props.icon}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {props.label}
      </span>
      {props.stale && <span className="warn">●</span>}
      {props.badge !== undefined && (
        <span
          style={{
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            borderRadius: 8,
            fontSize: 11,
            padding: '0 6px',
            fontWeight: 600,
          }}
        >
          {props.badge}
        </span>
      )}
    </div>
  );
}
