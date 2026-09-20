import React, { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { cmd, errMsg } from '../api';
import { DownloadSimple, Cube, CheckSquare } from '@phosphor-icons/react';
import { PageHeader, SearchField, StatusBadge, EmptyState } from '../components/ui';
import { useStore } from '../store';
import { formatQty, type ComponentPayload, type MaybeQuantity } from '@stark/contracts';

interface BomRow {
  lineId: string;
  title: string;
  partNumber: string;
  manufacturer: string;
  subsystem: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  mass: string;
  offerObserved: string;
  notes: string;
  artifactId: string;
}

/** Components + living BOM: candidates, offers, selection, totals. */
export function ComponentsView() {
  const { artifacts, selectArtifact, selectedArtifactId, toast } = useStore();
  const [tab, setTab] = useState<'bom' | 'candidates'>('bom');
  const [query, setQuery] = useState('');
  const components = artifacts.filter(
    (v) => v.artifact.type === 'component' && !v.artifact.archived,
  );
  const [bom, setBom] = useState<{
    lines: never[];
    totals: {
      cost: { amount: string; currency: string }[];
      missingPriceCount: number;
      knownMass: { value: number; unit: string } | null;
      missingMassCount: number;
      lineCount: number;
    };
  } | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<{
    matrix: { criterion: string; values: (MaybeQuantity | null)[] }[];
    components: { artifact: { id: string; title: string } }[];
  } | null>(null);

  const refreshBom = async () => {
    const r = await cmd<typeof bom>('bom.read', {});
    setBom(r);
  };
  useEffect(() => {
    void refreshBom().catch((e) => toast('error', errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts]);

  const rows: BomRow[] = useMemo(() => {
    if (!bom) return [];
    return (
      bom.lines as {
        line: {
          id: string;
          componentArtifactId: string;
          subsystem: string | null;
          quantity: number;
          notes: string;
          offerId: string | null;
        };
        componentTitle: string;
        partNumber: string;
        manufacturer: string;
        offer: {
          price: { amount: string; currency: string } | null;
          observedAt: string;
          seller: string;
        } | null;
        unitMass: { value: number; unit: string } | null;
        lineTotal: { amount: string; currency: string } | null;
      }[]
    ).map((l) => ({
      lineId: l.line.id,
      artifactId: l.line.componentArtifactId,
      title: l.componentTitle,
      partNumber: l.partNumber,
      manufacturer: l.manufacturer,
      subsystem: l.line.subsystem ?? '',
      quantity: l.line.quantity,
      unitPrice: l.offer?.price ? `${l.offer.price.amount} ${l.offer.price.currency}` : 'unknown',
      lineTotal: l.lineTotal ? `${l.lineTotal.amount} ${l.lineTotal.currency}` : 'unknown',
      mass: l.unitMass
        ? formatQty({ value: l.unitMass.value * l.line.quantity, unit: l.unitMass.unit })
        : 'unknown',
      offerObserved: l.offer ? `Observed ${l.offer.observedAt.slice(0, 10)}` : '',
      notes: l.line.notes,
    }));
  }, [bom]);

  const col = useMemo(() => createColumnHelper<BomRow>(), []);
  const columns = useMemo(
    () => [
      col.accessor('title', { header: 'Part' }),
      col.accessor('partNumber', { header: 'Part no.' }),
      col.accessor('manufacturer', { header: 'Mfr' }),
      col.accessor('subsystem', { header: 'Subsystem' }),
      col.accessor('quantity', {
        header: 'Qty',
        cell: (c) => <span className="num">{c.getValue()}</span>,
      }),
      col.accessor('unitPrice', {
        header: 'Unit price',
        cell: (c) => <span className="num">{c.getValue()}</span>,
      }),
      col.accessor('lineTotal', {
        header: 'Line total',
        cell: (c) => <span className="num">{c.getValue()}</span>,
      }),
      col.accessor('mass', {
        header: 'Mass',
        cell: (c) => <span className="num">{c.getValue()}</span>,
      }),
      col.accessor('offerObserved', {
        header: '',
        cell: (c) => (
          <span className="faint" style={{ fontSize: 11 }}>
            {c.getValue()}
          </span>
        ),
      }),
    ],
    [col],
  );
  const filteredRows = useMemo(
    () =>
      rows.filter((r) =>
        `${r.title} ${r.partNumber} ${r.subsystem}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [rows, query],
  );
  const table = useReactTable({ data: filteredRows, columns, getCoreRowModel: getCoreRowModel() });

  const runCompare = async () => {
    if (compareIds.size === 0) return;
    try {
      const r = await cmd<typeof compare>('component.compare', { artifactIds: [...compareIds] });
      setCompare(r);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const exportBom = async (format: 'csv' | 'markdown') => {
    const r = await cmd<{ content: string }>('bom.export', { format });
    const path = await window.stark.saveFile({
      defaultPath: `bom.${format === 'csv' ? 'csv' : 'md'}`,
    });
    if (!path) return;
    // Save via blob → can't write fs directly; use build.export? Renderer has no fs — use a data URL download fallback for desktop: write via command? We export through the build/export op writing to destPath. Use cad-style: reuse 'build.export'? BOM file write needs an fs path — add dedicated handling: saveFile returns path, then call artifact-level write? Simplest: keep content in a download via blob URL — in Electron renderer, anchor download works for blob:.
    const blob = new Blob([r.content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = path.split('/').pop() ?? `bom.${format === 'csv' ? 'csv' : 'md'}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const inspect = (id: string) => {
    selectArtifact(id);
    useStore.getState().set({ sidecarOpen: true, sidecarTab: 'inspector' });
  };
  return (
    <div className="page">
      <PageHeader
        title="Parts & materials"
        description="A living bill of materials, grounded in sourced components."
      >
        <button onClick={() => void exportBom('csv').catch((e) => toast('error', errMsg(e)))}>
          <DownloadSimple size={14} />
          Export CSV
        </button>
        <button
          className="ghost"
          onClick={() => void exportBom('markdown').catch((e) => toast('error', errMsg(e)))}
        >
          Markdown
        </button>
      </PageHeader>
      <div className="toolbar">
        <div className="segmented">
          <button
            className={tab === 'bom' ? 'active' : ''}
            aria-pressed={tab === 'bom'}
            onClick={() => setTab('bom')}
          >
            <CheckSquare size={14} />
            Bill of materials<span className="count">{rows.length}</span>
          </button>
          <button
            className={tab === 'candidates' ? 'active' : ''}
            aria-pressed={tab === 'candidates'}
            onClick={() => setTab('candidates')}
          >
            <Cube size={14} />
            Candidates<span className="count">{components.length}</span>
          </button>
        </div>
        <span className="grow" />
        <SearchField value={query} onChange={setQuery} placeholder="Filter parts" />
      </div>
      <div className="page-scroll">
        {compare && (
          <section className="comparison-panel">
            <div className="section-heading">
              <h2>Component comparison</h2>
              <button className="ghost" onClick={() => setCompare(null)}>
                Close
              </button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Criterion</th>
                    {compare.components.map((c) => (
                      <th key={c.artifact.id}>{c.artifact.title}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compare.matrix.map((m) => (
                    <tr key={m.criterion}>
                      <td>{m.criterion}</td>
                      {m.values.map((v, i) => (
                        <td key={i} className="numeric">
                          {v == null ? 'Unknown' : formatQty(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint">A price match alone is not compatibility evidence.</p>
          </section>
        )}
        {tab === 'bom' ? (
          <>
            {bom && (
              <div className="bom-summary">
                <div>
                  <span>Known subtotal</span>
                  <strong className="num">
                    {bom.totals.cost.length
                      ? bom.totals.cost.map((c) => `${c.amount} ${c.currency}`).join(' + ')
                      : 'Unknown'}
                  </strong>
                </div>
                <div>
                  <span>Known mass</span>
                  <strong className="num">
                    {bom.totals.knownMass ? formatQty(bom.totals.knownMass) : 'Unknown'}
                  </strong>
                </div>
                <div>
                  <span>Data to complete</span>
                  <strong>
                    {bom.totals.missingPriceCount + bom.totals.missingMassCount}
                    <span> missing values</span>
                  </strong>
                </div>
              </div>
            )}
            {!rows.length ? (
              <EmptyState
                title="Your BOM starts with a decision"
                body="Approve component selections in the review queue to add them to the bill of materials."
                action={
                  <button onClick={() => useStore.getState().navigate('reviews')}>
                    Open review queue
                  </button>
                }
              />
            ) : (
              <>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      {table.getHeaderGroups().map((hg) => (
                        <tr key={hg.id}>
                          {hg.headers.map((h) => (
                            <th
                              className={
                                ['quantity', 'unitPrice', 'lineTotal', 'mass'].includes(h.id)
                                  ? 'numeric'
                                  : ''
                              }
                              key={h.id}
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                            </th>
                          ))}
                        </tr>
                      ))}
                    </thead>
                    <tbody>
                      {table.getRowModel().rows.map((r) => (
                        <tr
                          key={r.id}
                          className={selectedArtifactId === r.original.artifactId ? 'selected' : ''}
                        >
                          {r.getVisibleCells().map((c) => (
                            <td
                              className={
                                ['quantity', 'unitPrice', 'lineTotal', 'mass'].includes(c.column.id)
                                  ? 'numeric'
                                  : ''
                              }
                              key={c.id}
                            >
                              {c.column.id === 'title' ? (
                                <button
                                  className="table-title-button"
                                  onClick={() => inspect(r.original.artifactId)}
                                >
                                  {r.original.title}
                                </button>
                              ) : (
                                flexRender(c.column.columnDef.cell, c.getContext())
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!table.getRowModel().rows.length && (
                  <EmptyState
                    title="No matching parts"
                    body="Try a different part name or subsystem."
                  />
                )}
                <p className="table-footnote">
                  {bom?.totals.missingPriceCount ?? 0} missing prices ·{' '}
                  {bom?.totals.missingMassCount ?? 0} missing masses. Unknown values are excluded
                  from known totals.
                </p>
              </>
            )}
          </>
        ) : (
          <>
            <div className="section-heading">
              <h2>Component candidates</h2>
              <button disabled={compareIds.size < 2} onClick={() => void runCompare()}>
                Compare selected {compareIds.size > 0 ? `(${compareIds.size})` : ''}
              </button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Component</th>
                    <th>Part number</th>
                    <th>Manufacturer</th>
                    <th>Selection</th>
                  </tr>
                </thead>
                <tbody>
                  {components
                    .filter((v) => v.artifact.title.toLowerCase().includes(query.toLowerCase()))
                    .map((v) => {
                      const p = (v.revision?.payload ?? {}) as ComponentPayload;
                      return (
                        <tr key={v.artifact.id}>
                          <td>
                            <input
                              aria-label={`Compare ${v.artifact.title}`}
                              type="checkbox"
                              checked={compareIds.has(v.artifact.id)}
                              onChange={(e) => {
                                const next = new Set(compareIds);
                                if (e.target.checked) next.add(v.artifact.id);
                                else next.delete(v.artifact.id);
                                setCompareIds(next);
                              }}
                            />
                          </td>
                          <td>
                            <button
                              className="table-title-button"
                              onClick={() => inspect(v.artifact.id)}
                            >
                              {v.artifact.title}
                            </button>
                          </td>
                          <td className="mono">{p.partNumber ?? 'Unknown'}</td>
                          <td>{p.manufacturer ?? p.vendor ?? 'Unknown'}</td>
                          <td>
                            <StatusBadge state={p.status ?? 'candidate'} />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {!components.length && (
              <EmptyState
                title="Find the right components"
                body="Ask your agent to research parts and capture sources. Compare candidates here before making a selection."
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
