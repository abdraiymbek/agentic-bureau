import { useStore } from '../store';

export function StatusBar() {
  const { proposals, stale, projectPath } = useStore();
  const pending = proposals.filter((p) => p.state === 'pending').length;
  const staleCount = Object.values(stale).filter((s) => s.length > 0).length;
  return (
    <div
      style={{
        height: 26,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 12px',
        background: 'var(--bg-app)',
        borderTop: '1px solid var(--border)',
        fontSize: 12,
        color: 'var(--text-secondary)',
      }}
    >
      <span>Saved locally</span>
      {pending > 0 && (
        <span className="warn">
          {pending} artifact{pending > 1 ? 's' : ''} need{pending > 1 ? '' : 's'} review
        </span>
      )}
      {staleCount > 0 && <span className="warn">{staleCount} stale</span>}
      <span style={{ flex: 1 }} />
      <span className="faint mono" style={{ fontSize: 11 }}>
        {projectPath ?? ''}
      </span>
    </div>
  );
}
