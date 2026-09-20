import { HardDrive, GitBranch, WarningCircle, TerminalWindow } from '@phosphor-icons/react';
import { useStore } from '../store';
export function StatusBar() {
  const { proposals, stale, projectPath, readOnly, session, navigate, set } = useStore();
  const pending = proposals.filter((p) => p.state === 'pending').length;
  const staleCount = Object.values(stale).filter((s) => s.length > 0).length;
  return (
    <footer className="statusbar">
      <span className="row">
        <HardDrive size={12} />
        {readOnly ? 'Read-only project' : 'Local workspace'}
      </span>
      {pending > 0 && (
        <button className="row" onClick={() => navigate('reviews')}>
          <GitBranch size={12} />
          {pending} in review
        </button>
      )}
      {staleCount > 0 && (
        <button className="row warn" onClick={() => navigate('history')}>
          <WarningCircle size={12} />
          {staleCount} out of date
        </button>
      )}
      <span className="grow" />
      <span className="status-path truncate">{projectPath}</span>
      <button className="row" onClick={() => set({ sidecarOpen: true, sidecarTab: 'agent' })}>
        <TerminalWindow size={12} />
        {session?.state === 'running' ? `${session.adapterId} connected` : 'Agent ready to connect'}
      </button>
    </footer>
  );
}
