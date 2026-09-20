import {
  HardDrive,
  GitBranch,
  WarningCircle,
  TerminalWindow,
  CircleNotch,
} from '@phosphor-icons/react';
import { useStore } from '../store';

const jobVerbs: Record<string, string> = {
  'cad.render': 'Rendering',
  'wiring.render': 'Drawing wiring',
  'calculation.run': 'Calculating',
  'build.export': 'Exporting build',
};

export function StatusBar() {
  const { proposals, stale, projectPath, readOnly, session, jobs, navigate, set } = useStore();
  const pending = proposals.filter((p) => p.state === 'pending').length;
  const staleCount = Object.values(stale).filter((s) => s.length > 0).length;
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const activeLabel =
    active.length === 1
      ? `${jobVerbs[active[0]!.kind] ?? 'Running'} · ${active[0]!.tool}`
      : `${active.length} tool jobs running`;
  const agentLabel =
    session?.state === 'running'
      ? `${session.adapterId} connected`
      : session?.state === 'starting'
        ? 'Agent starting…'
        : session?.state === 'failed'
          ? 'Agent session failed'
          : 'No agent session';
  return (
    <footer className="statusbar">
      <span className="row" title={projectPath ?? undefined}>
        <HardDrive size={12} />
        {readOnly ? 'Read-only project' : 'Local project'}
      </span>
      {pending > 0 && (
        <button className="row" onClick={() => navigate('reviews')}>
          <GitBranch size={12} />
          {pending} awaiting review
        </button>
      )}
      {staleCount > 0 && (
        <button className="row warn" onClick={() => navigate('history')}>
          <WarningCircle size={12} />
          {staleCount} out of date
        </button>
      )}
      <span className="grow" />
      {active.length > 0 && (
        <span className="row" role="status">
          <CircleNotch size={12} className="spin" />
          {activeLabel}
        </span>
      )}
      <button
        className={`row ${session?.state === 'running' ? 'ok' : ''}`}
        onClick={() => set({ sidecarOpen: true, sidecarTab: 'agent' })}
      >
        <TerminalWindow size={12} />
        {agentLabel}
      </button>
    </footer>
  );
}
