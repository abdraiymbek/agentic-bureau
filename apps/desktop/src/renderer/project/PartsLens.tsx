import React, { useEffect, useMemo, useState } from 'react';
import { DownloadSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import {
  formatQty,
  type ComponentPayload,
  type Offer,
  type MaybeQuantity,
} from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { OfferDetails, PartCard } from '../ui/PartCard';
import { Button, Empty, IconButton, Segmented } from '../ui/kit';

interface BomLineView {
  line: {
    id: string;
    componentArtifactId: string;
    subsystem: string | null;
    quantity: number;
    notes: string;
  };
  componentTitle: string;
  partNumber: string;
  manufacturer: string;
  imageUrl?: string;
  selectionReason?: string;
  description?: string;
  offer: {
    price: { amount: string; currency: string } | null;
    observedAt: string;
    seller: string;
    url?: string;
    quantityBasis: number;
    availabilityText?: string;
  } | null;
  unitMass: { value: number; unit: string } | null;
  lineTotal: { amount: string; currency: string } | null;
}
interface Bom {
  lines: BomLineView[];
  totals: {
    cost: { amount: string; currency: string }[];
    missingPriceCount: number;
    knownMass: { value: number; unit: string } | null;
    missingMassCount: number;
    lineCount: number;
  };
}
interface Comparison {
  matrix: { criterion: string; values: (MaybeQuantity | null)[] }[];
  components: {
    artifact: { id: string; title: string };
    payload: ComponentPayload | null;
    offers: Offer[];
  }[];
}

/** The project as a bill of materials. Unknown stays unknown; it never becomes zero. */
export function PartsLens() {
  const artifacts = useStore((s) => s.artifacts);
  const { toast, focus, decide } = useStore.getState();
  const [mode, setMode] = useState<'bom' | 'candidates'>('candidates');
  const [query, setQuery] = useState('');
  const [bom, setBom] = useState<Bom | null>(null);
  const [bomError, setBomError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [candidateDetails, setCandidateDetails] = useState<Comparison['components']>([]);
  const [candidateError, setCandidateError] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const components = artifacts.filter(
    (v) => v.artifact.type === 'component' && !v.artifact.archived,
  );

  useEffect(() => {
    let cancelled = false;
    void cmd<Bom>('bom.read', {})
      .then((r) => !cancelled && (setBom(r), setBomError('')))
      .catch((e) => !cancelled && setBomError(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  useEffect(() => {
    let active = true;
    const ids = artifacts
      .filter((v) => v.artifact.type === 'component' && !v.artifact.archived)
      .map((v) => v.artifact.id);
    if (!ids.length) {
      setCandidateDetails([]);
      return;
    }
    // The comparison endpoint includes draft payloads and offers; artifact.list contains baselines.
    void Promise.all(
      Array.from({ length: Math.ceil(ids.length / 20) }, (_, i) =>
        cmd<Comparison>('component.compare', { artifactIds: ids.slice(i * 20, i * 20 + 20) }),
      ),
    )
      .then((results) => {
        if (active) {
          setCandidateDetails(results.flatMap((r) => r.components));
          setCandidateError('');
        }
      })
      .catch((e) => active && setCandidateError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [artifacts]);

  const lines = useMemo(
    () =>
      (bom?.lines ?? []).filter((l) =>
        `${l.componentTitle} ${l.partNumber} ${l.line.subsystem ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [bom, query],
  );

  const visibleCandidates = components.filter((v) => {
    const p = candidateDetails.find((c) => c.artifact.id === v.artifact.id)?.payload;
    return `${v.artifact.title} ${p?.partNumber ?? ''} ${p?.manufacturer ?? p?.vendor ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });

  const exportBom = async (format: 'csv' | 'markdown') => {
    try {
      const r = await cmd<{ content: string }>('bom.export', { format });
      const name = `bom.${format === 'csv' ? 'csv' : 'md'}`;
      const path = await window.omenflow.saveFile({ defaultPath: name });
      if (!path) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.content], { type: 'text/plain' }));
      a.download = path.split(/[\\/]/).pop() ?? name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const compare = async () => {
    try {
      setComparison(await cmd<Comparison>('component.compare', { artifactIds: [...picked] }));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="lens-page">
      <div className="lens-bar">
        <Segmented
          label="Parts view"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'bom', label: 'Bill of materials', count: bom?.lines.length },
            { value: 'candidates', label: 'Candidates', count: components.length },
          ]}
        />
        <label className="find">
          <MagnifyingGlass size={13} />
          <input
            aria-label="Filter parts"
            placeholder="Filter parts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="grow" />
        {mode === 'bom' ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void exportBom('markdown')}>
              Markdown
            </Button>
            <Button
              size="sm"
              icon={<DownloadSimple size={13} />}
              onClick={() => void exportBom('csv')}
            >
              Export CSV
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={picked.size < 2} onClick={() => void compare()}>
            Compare {picked.size >= 2 ? picked.size : ''}
          </Button>
        )}
      </div>

      {comparison && (
        <section className="compare island">
          <header>
            <h3>Side by side</h3>
            <IconButton size="sm" label="Close comparison" onClick={() => setComparison(null)}>
              <X size={12} />
            </IconButton>
          </header>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Property</th>
                  {comparison.components.map((c) => (
                    <th key={c.artifact.id}>{c.artifact.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="dim">Why this part</td>
                  {comparison.components.map((c) => (
                    <td key={c.artifact.id}>
                      {c.payload?.selectionReason || (
                        <span className="unknown">Reason not recorded</span>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="dim">Seller offers</td>
                  {comparison.components.map((c) => (
                    <td key={c.artifact.id}>
                      {c.offers.length ? (
                        c.offers.map((o) => <OfferDetails key={o.id} offer={o} />)
                      ) : (
                        <span className="unknown">No offer recorded</span>
                      )}
                    </td>
                  ))}
                </tr>

                {comparison.matrix.map((m) => (
                  <tr key={m.criterion}>
                    <td className="dim">{m.criterion.replaceAll('_', ' ')}</td>
                    {m.values.map((v, i) => (
                      <td key={i} className="num">
                        {v == null ? <span className="unknown">Unknown</span> : formatQty(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">A matching price or value is not compatibility evidence.</p>
        </section>
      )}

      {mode === 'bom' ? (
        <>
          {bom && bom.lines.length > 0 && (
            <div className="totals">
              <div>
                <span>Known cost</span>
                <strong className="num">
                  {bom.totals.cost.length
                    ? bom.totals.cost.map((c) => `${c.amount} ${c.currency}`).join(' + ')
                    : 'Unknown'}
                </strong>
                {bom.totals.missingPriceCount > 0 && (
                  <small>{bom.totals.missingPriceCount} prices unknown</small>
                )}
              </div>
              <div>
                <span>Known mass</span>
                <strong className="num">
                  {bom.totals.knownMass ? formatQty(bom.totals.knownMass) : 'Unknown'}
                </strong>
                {bom.totals.missingMassCount > 0 && (
                  <small>{bom.totals.missingMassCount} masses unknown</small>
                )}
              </div>
              <div>
                <span>Lines</span>
                <strong className="num">{bom.totals.lineCount}</strong>
              </div>
            </div>
          )}
          {bomError ? (
            <Empty title="The bill of materials didn’t load" body={bomError} />
          ) : !bom ? (
            <p className="lens-muted" role="status">
              Reading the bill of materials…
            </p>
          ) : !bom.lines.length ? (
            <Empty
              title="The bill starts with a decision"
              body="Approved component selections become lines here, with sourced cost and mass."
              action={<Button onClick={() => decide(null)}>Open decisions</Button>}
            />
          ) : (
            <>
              <ul className="parts-list" aria-label="Bill of materials">
                {lines.map((l) => (
                  <PartCard
                    key={l.line.id}
                    title={l.componentTitle}
                    payload={{
                      partNumber: l.partNumber,
                      manufacturer: l.manufacturer,
                      imageUrl: l.imageUrl,
                      selectionReason: l.selectionReason,
                      description: l.description,
                      status: 'selected',
                    }}
                    offers={l.offer ? [l.offer] : []}
                    reason={l.selectionReason || l.line.notes}
                    onFocus={() => focus(l.line.componentArtifactId)}
                  >
                    <div className="part-quantities">
                      <span>
                        Quantity <strong className="num">{l.line.quantity}</strong>
                      </span>
                      {l.line.subsystem && <span>{l.line.subsystem}</span>}
                      <span>
                        Extended cost{' '}
                        <strong className="num">
                          {l.lineTotal
                            ? `${l.lineTotal.amount} ${l.lineTotal.currency}`
                            : 'Unknown'}
                        </strong>
                      </span>
                      <span>
                        Mass{' '}
                        <strong className="num">
                          {l.unitMass
                            ? formatQty({
                                value: l.unitMass.value * l.line.quantity,
                                unit: l.unitMass.unit,
                              })
                            : 'Unknown'}
                        </strong>
                      </span>
                    </div>
                  </PartCard>
                ))}
              </ul>
              {!lines.length && <p className="lens-muted">No line matches “{query}”.</p>}
            </>
          )}
          {bom && bom.lines.length > 0 && (
            <p className="footnote">
              Unknown values are excluded from known totals, never counted as zero.
            </p>
          )}
        </>
      ) : !components.length ? (
        <Empty
          title="No candidates yet"
          body="Ask your agent to research parts with sources. Candidates gather here for comparison before a selection."
        />
      ) : (
        <>
          <div className="parts-intro">
            <div>
              <h2>Parts to source</h2>
              <p>Product offers and the reasons behind each choice. Select parts to compare.</p>
            </div>
            <span className="dim">{components.length} parts · human review before selection</span>
          </div>
          {candidateError && (
            <p className="tone-warn-text">Candidate details didn’t load: {candidateError}</p>
          )}
          <ul className="parts-list" aria-label="Part candidates">
            {visibleCandidates.map((v) => {
              const detail = candidateDetails.find((c) => c.artifact.id === v.artifact.id);
              const p = (detail?.payload ?? v.revision?.payload ?? {}) as Partial<ComponentPayload>;
              return (
                <PartCard
                  key={v.artifact.id}
                  title={v.artifact.title}
                  payload={p}
                  offers={detail?.offers ?? []}
                  onFocus={() => focus(v.artifact.id)}
                  selection={
                    <input
                      type="checkbox"
                      aria-label={`Compare ${v.artifact.title}`}
                      checked={picked.has(v.artifact.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(v.artifact.id);
                        else next.delete(v.artifact.id);
                        setPicked(next);
                      }}
                    />
                  }
                />
              );
            })}
          </ul>
          {query && !visibleCandidates.length && (
            <p className="lens-muted">No part matches “{query}”.</p>
          )}

          <p className="footnote">
            Recorded seller prices; shipping and tax may be additional. Prices and availability can
            change.
          </p>
        </>
      )}
    </div>
  );
}
