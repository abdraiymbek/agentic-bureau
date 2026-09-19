import React, { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { cmd } from '../api';
import { useStore } from '../store';
import {
  formatQty,
  isUnknown,
  type ComponentPayload,
  type MaybeQuantity,
} from '@omenflow/contracts';
import { EmptyBlock } from './OverviewView';

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
  const { artifacts, selectArtifact, selectedArtifactId, refreshArtifacts, toast } = useStore();
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
    void refreshBom();
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

  const col = createColumnHelper<BomRow>();
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
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  const runCompare = async () => {
    if (compareIds.size === 0) return;
    const r = await cmd<typeof compare>('component.compare', { artifactIds: [...compareIds] });
    setCompare(r);
  };

  const exportBom = async (format: 'csv' | 'markdown') => {
    const r = await cmd<{ content: string }>('bom.export', { format });
    const path = await window.omenflow.saveFile({
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

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div
        style={{
          width: 280,
          borderRight: '1px solid var(--border)',
          overflowY: 'auto',
          padding: 8,
        }}
      >
        <div className="dim" style={{ fontSize: 12, fontWeight: 600, padding: '4px 8px' }}>
          Component candidates
        </div>
        {components.length === 0 && (
          <div className="faint" style={{ padding: 8, fontSize: 12 }}>
            No components yet — the agent adds sourced candidates via component.add_candidate.
          </div>
        )}
        {components.map((v) => {
          const p = (v.revision?.payload ?? {}) as ComponentPayload;
          return (
            <div
              key={v.artifact.id}
              role="button"
              tabIndex={0}
              onClick={() => selectArtifact(v.artifact.id)}
              style={{
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background:
                  selectedArtifactId === v.artifact.id ? 'var(--bg-raised)' : 'transparent',
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13 }}>{v.artifact.title}</span>
                <span
                  className={`pill ${p.status === 'selected' ? 'current' : ''}`}
                  style={{ height: 18, fontSize: 11 }}
                >
                  {p.status ?? 'candidate'}
                </span>
              </div>
              <div className="faint" style={{ fontSize: 11 }}>
                {p.partNumber} — {p.manufacturer ?? p.vendor ?? ''}
              </div>
              <label
                className="row"
                style={{ fontSize: 11, marginTop: 2 }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={compareIds.has(v.artifact.id)}
                  onChange={(e) => {
                    const s = new Set(compareIds);
                    if (e.target.checked) s.add(v.artifact.id);
                    else s.delete(v.artifact.id);
                    setCompareIds(s);
                  }}
                />
                compare
              </label>
            </div>
          );
        })}
        <button
          style={{ margin: '8px', height: 26, fontSize: 12 }}
          disabled={compareIds.size < 2}
          onClick={runCompare}
        >
          Compare {compareIds.size > 1 ? `(${compareIds.size})` : ''}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {compare && (
          <div
            style={{
              marginBottom: 16,
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 12,
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="dim" style={{ fontSize: 12, fontWeight: 600 }}>
                Comparison
              </div>
              <button style={{ height: 22, fontSize: 11 }} onClick={() => setCompare(null)}>
                Close
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <Th>Criterion</Th>
                  {compare.components.map((c) => (
                    <Th key={c.artifact.id}>{c.artifact.title}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compare.matrix.map((m) => (
                  <tr key={m.criterion}>
                    <Td>{m.criterion}</Td>
                    {m.values.map((v, i) => (
                      <Td key={i}>
                        <span className="num">{v == null ? '—' : formatQty(v)}</span>
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
              A price-only match is not compatibility evidence.
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Bill of materials</h3>
          <div className="row">
            <button style={{ height: 26, fontSize: 12 }} onClick={() => exportBom('csv')}>
              Export CSV
            </button>
            <button style={{ height: 26, fontSize: 12 }} onClick={() => exportBom('markdown')}>
              Export Markdown
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyBlock
            title="No selected components"
            body="BOM fills when component selections are approved through the review flow."
          />
        ) : (
          <>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}
            >
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <Th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</Th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => selectArtifact(r.original.artifactId)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-raised)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {r.getVisibleCells().map((c) => (
                      <Td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {bom && (
              <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
                Known subtotal:{' '}
                {bom.totals.cost.length
                  ? bom.totals.cost.map((c) => `${c.amount} ${c.currency}`).join(' + ')
                  : 'unknown'}{' '}
                · {bom.totals.missingPriceCount} missing price · Known mass:{' '}
                {bom.totals.knownMass ? formatQty(bom.totals.knownMass) : 'unknown'} ·{' '}
                {bom.totals.missingMassCount} missing mass
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const Th = (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    {...props}
    style={{
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: '1px solid var(--border)',
      fontSize: 11,
      color: 'var(--text-secondary)',
      fontWeight: 600,
      ...props.style,
    }}
  />
);
const Td = (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td
    {...props}
    style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', ...props.style }}
  />
);
