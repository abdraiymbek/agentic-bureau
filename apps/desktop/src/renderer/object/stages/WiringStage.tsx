import React, { useEffect, useState } from 'react';
import type { WiringPayload } from '@bureau/contracts';
import { recordedQuantityText } from '../../lib/diff';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Block, Button, Notice, Skeleton, State } from '../../ui/kit';
import { DiagramViewer } from './DiagramViewer';
import { ObjectLink, type StageProps } from './shared';

interface Finding {
  severity: string;
  code: string;
  message: string;
  connectionId?: string;
}

type Checked =
  | { state: 'checking' }
  | { state: 'done'; findings: Finding[]; coverage: string }
  | { state: 'failed'; error: string };

const SEVERITY: Record<string, { state: string; label: string }> = {
  error: { state: 'failed', label: 'Error' },
  warning: { state: 'stale', label: 'Warning' },
};

export function WiringStage({ view }: StageProps) {
  const artifacts = useStore((s) => s.artifacts);
  const p = (view.revision?.payload ?? {}) as Partial<WiringPayload>;
  const artifactId = view.artifact.id;
  const revisionId = view.revision?.id;
  const [checked, setChecked] = useState<Checked>({ state: 'checking' });
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [diagram, setDiagram] = useState<string | null>(null);
  const [diagramError, setDiagramError] = useState('');
  const [drawAttempt, setDrawAttempt] = useState(0);
  const [marked, setMarked] = useState<string | null>(null);

  // The checks read the record and change nothing, so they run for whatever is on screen.
  useEffect(() => {
    let active = true;
    setChecked({ state: 'checking' });
    void cmd<{ findings: Finding[]; coverage: string }>('wiring.validate', {
      artifactId,
      revisionId,
    })
      .then((r) => active && setChecked({ state: 'done', ...r }))
      .catch((e) => active && setChecked({ state: 'failed', error: errMsg(e) }));
    return () => {
      active = false;
    };
  }, [artifactId, revisionId, checkAttempt]);

  useEffect(() => {
    let active = true;
    setDiagram(null);
    setDiagramError('');
    void cmd<{ diagramSvg: string }>('wiring.render', { artifactId, revisionId })
      .then((r) => {
        if (!active) return;
        if (!r.diagramSvg) setDiagramError('The renderer returned no diagram.');
        else setDiagram(r.diagramSvg);
      })
      .catch((e) => active && setDiagramError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [artifactId, revisionId, drawAttempt]);

  const connections = p.connections ?? [];
  const readable = (message: string) =>
    message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, (id) => {
      const component = artifacts.find((v) => v.artifact.id === id);
      if (component) return component.artifact.title;
      const n = connections.findIndex((c) => c.id === id);
      return n >= 0 ? `connection ${n + 1}` : id;
    });
  const connectionNumber = (id?: string) => {
    const n = id ? connections.findIndex((c) => c.id === id) : -1;
    return n >= 0 ? n + 1 : null;
  };
  const findings = checked.state === 'done' ? checked.findings : [];
  const flagged = new Set(findings.map((f) => f.connectionId).filter(Boolean));

  return (
    <div className="doc wide">
      <Block
        title="Checks"
        count={checked.state === 'done' ? findings.length : undefined}
        actions={
          <Button
            size="sm"
            busy={checked.state === 'checking'}
            onClick={() => setCheckAttempt((n) => n + 1)}
          >
            Check again
          </Button>
        }
      >
        {checked.state === 'checking' ? (
          <Skeleton lines={2} />
        ) : checked.state === 'failed' ? (
          <Notice tone="err" role="alert">
            The wiring checks did not run: {checked.error}
          </Notice>
        ) : findings.length === 0 ? (
          <p className="tone-ok-text">No findings within the checked coverage.</p>
        ) : (
          <ul className="findings">
            {findings.map((f, i) => {
              const severity = SEVERITY[f.severity] ?? { state: 'info', label: 'Info' };
              const n = connectionNumber(f.connectionId);
              return (
                <li key={i}>
                  <State
                    state={severity.state}
                    label={severity.label}
                    tone={severity.state === 'info' ? 'neutral' : undefined}
                    quiet
                  />
                  <span>{readable(f.message)}</span>
                  {n !== null && (
                    <button
                      type="button"
                      className="cell-link"
                      aria-pressed={marked === f.connectionId}
                      onClick={() =>
                        setMarked(marked === f.connectionId ? null : (f.connectionId ?? null))
                      }
                    >
                      Connection {n}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {checked.state === 'done' && checked.coverage && (
          <p className="footnote">{checked.coverage}</p>
        )}
      </Block>
      {p.coverageNote && <Notice>{p.coverageNote}</Notice>}

      <Block
        title="Diagram"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setDrawAttempt((n) => n + 1)}>
            Draw again
          </Button>
        }
      >
        {diagramError ? (
          <Notice tone="err" role="alert">
            Diagram unavailable: {diagramError}
          </Notice>
        ) : diagram ? (
          <DiagramViewer
            svg={diagram}
            label={`Wiring diagram of revision ${view.revision?.seq ?? ''}`}
            className="wiring-diagram"
          />
        ) : (
          <p role="status" className="dim">
            Drawing recorded wiring…
          </p>
        )}
      </Block>

      <Block title="Pins" count={p.pins?.length ?? 0}>
        {!p.pins?.length ? (
          <p className="dim">No pin definitions recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Pin</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Voltage range</th>
                </tr>
              </thead>
              <tbody>
                {p.pins.map((pin, i) => (
                  <tr key={i}>
                    <td>
                      <ObjectLink id={pin.componentArtifactId} />
                    </td>
                    <td className="mono">{pin.pin}</td>
                    <td>{pin.name ?? '—'}</td>
                    <td>{pin.type}</td>
                    <td className="num nowrap">
                      {pin.voltageRange ? (
                        `${recordedQuantityText(pin.voltageRange.min)} – ${recordedQuantityText(pin.voltageRange.max)}`
                      ) : (
                        <span className="unknown">Unknown</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      <Block title="Connections" count={connections.length}>
        {!connections.length ? (
          <p className="dim">
            No connections recorded. Ask the agent to populate the wiring pins and connections.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Signal</th>
                  <th className="num">Voltage</th>
                  <th>Wire</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c, i) => (
                  <tr
                    key={c.id ?? i}
                    className={marked === c.id ? 'marked' : undefined}
                    aria-current={marked === c.id ? 'true' : undefined}
                  >
                    <td className="num dim">
                      {i + 1}
                      {flagged.has(c.id) && (
                        <span
                          className="row-flag tone-warn"
                          role="img"
                          aria-label="Has a finding"
                        />
                      )}
                    </td>
                    <td>
                      <ObjectLink id={c.from.componentArtifactId} />
                      <small className="cell-sub mono">{c.from.pin}</small>
                    </td>
                    <td>
                      <ObjectLink id={c.to.componentArtifactId} />
                      <small className="cell-sub mono">{c.to.pin}</small>
                    </td>
                    <td>
                      {c.signalRole}
                      {c.polarity && <small className="cell-sub">Polarity · {c.polarity}</small>}
                      {c.notes && <small className="cell-sub">{c.notes}</small>}
                    </td>
                    <td className="num nowrap">
                      {c.voltage ? recordedQuantityText(c.voltage) : '—'}
                    </td>
                    <td className="dim nowrap">
                      {c.wire?.gauge ?? '—'}
                      {c.wire?.currentRating
                        ? ` · ${recordedQuantityText(c.wire.currentRating)}`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
    </div>
  );
}
