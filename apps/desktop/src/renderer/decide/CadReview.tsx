import React, { useEffect, useState } from 'react';
import type { MechanicalPayload, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { Disclosure, Notice, State, Spinner, decodeBase64 } from '../ui/kit';
import { StlViewport } from '../object/StlViewport';

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

/** Renders only the immutable revisions bound into the proposal. */
export function CadReview({
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
  const projectId = useStore((s) => s.projectId);
  const [meshes, setMeshes] = useState<{ next: ArrayBuffer | null; base: ArrayBuffer | null }>({
    next: null,
    base: null,
  });
  const [source, setSource] = useState({ next: '', base: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

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
        const r = await cmd<{ contentBase64: string }>(
          'artifact.read_file',
          { artifactId: rev.artifactId, revisionId: rev.id, path: ref.path },
          { projectId: projectId ?? undefined },
        );
        return decodeBase64(r.contentBase64);
      };
      const [mesh, src] = await Promise.all([file('.stl'), file('.scad')]);
      return {
        mesh: (mesh?.buffer as ArrayBuffer | undefined) ?? null,
        source: src ? new TextDecoder().decode(src) : '',
      };
    };
    void Promise.all([load(next), load(base)])
      .then(([n, b]) => {
        if (cancelled) return;
        setMeshes({ next: n.mesh, base: b.mesh });
        setSource({ next: n.source, base: b.source });
      })
      .catch((e) => !cancelled && setError(errMsg(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, next, base]);

  const payload = next.payload as MechanicalPayload;
  const evidence = verification?.evidence;
  const status = verification?.status ?? 'unverified';
  const canAccept =
    !!evidence?.pass &&
    !['failed', 'partial', 'unverified'].includes(status) &&
    !!verification?.evidenceHash;

  return (
    <div className="cad-review">
      {error && (
        <Notice tone="warn" role="alert">
          {error}
        </Notice>
      )}
      <div className="cad-canvas">
        {loading ? (
          <div className="mech-empty">
            <Spinner size={16} />
            <strong>Loading bound geometry</strong>
          </div>
        ) : meshes.next ? (
          <StlViewport
            stlData={meshes.next}
            compareData={overlay ? meshes.base : null}
            modelUnit={payload.modelUnit}
          />
        ) : (
          <div className="mech-empty">
            <strong>No rendered geometry on this candidate</strong>
            <span>Approval would not establish verification.</span>
          </div>
        )}
        {meshes.base && meshes.next && (
          <label className="cad-overlay island">
            <input
              type="checkbox"
              checked={overlay}
              onChange={(e) => setOverlay(e.target.checked)}
            />
            Overlay baseline r{base?.seq}
          </label>
        )}
      </div>
      <p className="dim cad-caption">
        Candidate r{next.seq} · {payload.modelUnit} · right-handed, Z up
      </p>

      <div className="verify">
        <div className="verify-head">
          <span>Verification</span>
          <State
            state={status}
            tone={
              status === 'verified' || status === 'passed'
                ? 'ok'
                : status === 'failed'
                  ? 'err'
                  : 'warn'
            }
            label={status.replaceAll('_', ' ')}
          />
        </div>
        {evidence && (
          <>
            {evidence.scopeChanges.length > 0 && (
              <Notice tone="warn">
                Assertion scope changed: {evidence.scopeChanges.join(', ')}. Review the full scope
                below.
              </Notice>
            )}
            <div className="checks">
              {evidence.checks.map((c, i) => (
                <div className="check" key={i}>
                  <State
                    state={c.pass ? 'passed' : 'failed'}
                    label={c.pass ? 'Pass' : 'Fail'}
                    quiet
                  />
                  <span className="check-name">{c.name}</span>
                  <span className="check-detail mono">{c.detail}</span>
                </div>
              ))}
            </div>
            <p className="footnote">
              Checks establish only the declared scope. The engineering requirements may be
              incomplete.
            </p>
            <Disclosure
              label="Declared scope"
              meta={evidence.coverage.units}
              open={!!open.scope}
              onToggle={() => toggle('scope')}
            >
              <pre className="code-block">{JSON.stringify(evidence.expect, null, 2)}</pre>
            </Disclosure>
            <Disclosure
              label="Coverage limits"
              open={!!open.limits}
              onToggle={() => toggle('limits')}
            >
              <ul className="plain-list">
                {evidence.coverage.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </Disclosure>
            {canAccept && (
              <label className="check-accept">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={accepted}
                  onChange={(e) => onAcceptScope(e.target.checked)}
                />
                Accept this verification scope with my approval
              </label>
            )}
          </>
        )}
      </div>

      <Disclosure
        label="Effective parameters"
        open={!!open.params}
        onToggle={() => toggle('params')}
      >
        <pre className="code-block">
          {JSON.stringify(payload.renderIdentity?.params ?? payload.params, null, 2)}
        </pre>
      </Disclosure>
      <Disclosure label="Candidate source" open={!!open.src} onToggle={() => toggle('src')}>
        <pre className="code-block">{source.next || 'No source attachment'}</pre>
      </Disclosure>
      {base && (
        <Disclosure label="Baseline source" open={!!open.base} onToggle={() => toggle('base')}>
          <pre className="code-block">{source.base || 'No source attachment'}</pre>
        </Disclosure>
      )}
    </div>
  );
}
