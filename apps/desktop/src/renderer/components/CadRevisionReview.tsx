import React, { useEffect, useState } from 'react';
import type { MechanicalPayload, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { StlViewport } from './StlViewport';

export interface VerificationReview {
  status: string;
  evidenceHash?: string;
  evidence?: {
    expect: unknown;
    pass: boolean;
    scopeChanges: string[];
    checks: { name: string; pass: boolean; detail: string }[];
    coverage: { units: string; frame: string; limitations: string[] };
  };
}

/** Render only the immutable revisions bound into the proposal. */
export function CadRevisionReview({
  base,
  next,
  verification,
  accepted,
  onAcceptScope,
  disabled,
}: {
  base: Revision | null;
  next: Revision;
  verification?: VerificationReview;
  accepted: boolean;
  onAcceptScope: (accepted: boolean) => void;
  disabled: boolean;
}) {
  const projectId = useStore((s) => s.project?.id);
  const [meshes, setMeshes] = useState<{ next: ArrayBuffer | null; base: ArrayBuffer | null }>({
    next: null,
    base: null,
  });
  const [source, setSource] = useState<{ next: string; base: string }>({ next: '', base: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setMeshes({ next: null, base: null });
    setSource({ next: '', base: '' });
    setError('');
    setLoading(true);
    const load = async (rev: Revision | null) => {
      if (!rev) return { mesh: null, source: '' };
      const file = async (suffix: string) => {
        const ref = rev.files.find((f) => f.path.toLowerCase().endsWith(suffix));
        if (!ref) return null;
        const result = await cmd<{ contentBase64: string }>(
          'artifact.read_file',
          { artifactId: rev.artifactId, revisionId: rev.id, path: ref.path },
          { projectId },
        );
        return Uint8Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0));
      };
      const [mesh, source] = await Promise.all([file('.stl'), file('.scad')]);
      return {
        mesh: (mesh?.buffer as ArrayBuffer | null) ?? null,
        source: source ? new TextDecoder().decode(source) : '',
      };
    };
    void Promise.all([load(next), load(base)])
      .then(([n, b]) => {
        if (cancelled) return;
        setMeshes({ next: n.mesh, base: b.mesh });
        setSource({ next: n.source, base: b.source });
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, next, base]);
  const payload = next.payload as MechanicalPayload;
  const evidence = verification?.evidence;
  return (
    <div>
      <p className="dim">
        Candidate revision {next.seq} · {payload.modelUnit} · right-handed Z up
      </p>
      {error && (
        <p className="inline-notice warning" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading bound geometry…</p>
      ) : meshes.next ? (
        <>
          {meshes.base && (
            <label>
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
              />{' '}
              Overlay baseline
            </label>
          )}
          <StlViewport
            stlData={meshes.next}
            compareData={compare ? meshes.base : null}
            modelUnit={payload.modelUnit}
          />
        </>
      ) : (
        <p className="inline-notice warning">
          No current rendered geometry on this candidate. Approval does not establish verification.
        </p>
      )}
      <p>
        <strong>Verification: {(verification?.status ?? 'unverified').replaceAll('_', ' ')}</strong>
      </p>
      {evidence && (
        <>
          {evidence.scopeChanges.length > 0 && (
            <p className="inline-notice warning">
              Assertion scope changed: {evidence.scopeChanges.join(', ')}. Review the complete scope
              below.
            </p>
          )}
          <table className="diff-table">
            <thead>
              <tr>
                <th>Assertion</th>
                <th>Result</th>
                <th>Measured evidence</th>
              </tr>
            </thead>
            <tbody>
              {evidence.checks.map((c, i) => (
                <tr key={i}>
                  <td>{c.name}</td>
                  <td>{c.pass ? 'PASS' : 'FAIL'}</td>
                  <td>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>Declared verification scope · {evidence.coverage.units}</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(evidence.expect, null, 2)}
            </pre>
          </details>
          <p className="dim">
            Checks establish only the declared scope. Engineering requirements may be incomplete.
          </p>
          <details>
            <summary>Coverage limitations</summary>
            <ul>
              {evidence.coverage.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
          {evidence.pass &&
            !['failed', 'partial', 'unverified'].includes(verification!.status) &&
            verification?.evidenceHash && (
              <label>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={accepted}
                  onChange={(e) => onAcceptScope(e.target.checked)}
                />{' '}
                Accept this displayed verification scope with approval
              </label>
            )}
        </>
      )}
      <details>
        <summary>Effective parameter overrides</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(payload.renderIdentity?.params ?? payload.params, null, 2)}
        </pre>
      </details>
      <details>
        <summary>Candidate source</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
          {source.next || 'No source attachment'}
        </pre>
      </details>
      {base && (
        <details>
          <summary>Baseline source</summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {source.base || 'No source attachment'}
          </pre>
        </details>
      )}
    </div>
  );
}
