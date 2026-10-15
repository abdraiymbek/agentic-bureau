import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowSquareOut,
  Copy,
  DotsThree,
  DownloadSimple,
  MagnifyingGlass,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import type { ArtifactView, ComponentPayload, MaybeQuantity, Offer } from '@omenflow/contracts';
import { recordedQuantityText } from '../lib/diff';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { useViewState } from '../lib/view-memory';
import { ExternalLink } from '../ui/ExternalLink';
import { OfferDetails, ProductImage, observedDate, purchaseUrl } from '../ui/PartCard';
import { Button, Empty, IconButton, Menu, Segmented, State, type MenuItem } from '../ui/kit';
import { askAgent } from '../lib/actions';
import { copyText } from './copy';
import {
  COMPARE_LIMIT,
  GROUP_HINT,
  GROUP_LABEL,
  alternativesPrompt,
  bomTotalsView,
  compareLabel,
  compareValues,
  formatMass,
  formatMoney,
  lineMass,
  massUnitFor,
  partGroup,
  type Bom,
  type BomLineView,
  type PartGroup,
  type UnknownEntry,
} from './parts';
import { useRowNav, type RowProps } from './row-nav';

interface ComponentDetail {
  artifact: { id: string; title: string };
  payload: ComponentPayload | null;
  offers: Offer[];
}
interface Comparison {
  matrix: { criterion: string; values: (MaybeQuantity | null)[] }[];
  components: ComponentDetail[];
}

const COMPARE_CHUNK = 20;

/** The project as a bill of materials and the components behind it. Unknown never becomes zero. */
export function PartsLens() {
  const artifacts = useStore((s) => s.artifacts);
  const [mode, setMode] = useViewState<'bom' | 'components'>('parts:mode', 'components');
  const [query, setQuery] = useViewState('parts:query', '');
  const [bom, setBom] = useState<Bom | null>(null);
  const [bomError, setBomError] = useState('');
  const [details, setDetails] = useState<ComponentDetail[]>([]);
  const [detailError, setDetailError] = useState('');
  const components = useMemo(
    () => artifacts.filter((v) => v.artifact.type === 'component' && !v.artifact.archived),
    [artifacts],
  );

  useEffect(() => {
    let active = true;
    void cmd<Bom>('bom.read', {})
      .then((r) => {
        if (!active) return;
        setBom(r);
        setBomError('');
      })
      .catch((e) => {
        if (!active) return;
        setBom(null);
        setBomError(errMsg(e));
      });
    return () => {
      active = false;
    };
  }, [artifacts]);

  useEffect(() => {
    let active = true;
    const ids = components.map((v) => v.artifact.id);
    if (!ids.length) {
      setDetails([]);
      return;
    }
    // The comparison includes draft payloads and every offer; artifact.list carries baselines only.
    void Promise.all(
      Array.from({ length: Math.ceil(ids.length / COMPARE_CHUNK) }, (_, i) =>
        cmd<Comparison>('component.compare', {
          artifactIds: ids.slice(i * COMPARE_CHUNK, (i + 1) * COMPARE_CHUNK),
        }),
      ),
    )
      .then((results) => {
        if (!active) return;
        setDetails(results.flatMap((r) => r.components));
        setDetailError('');
      })
      .catch((e) => active && setDetailError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [components]);

  return (
    <div className="lens-page">
      <div className="lens-bar">
        <Segmented
          label="Parts view"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'components', label: 'Components', count: components.length },
            { value: 'bom', label: 'Bill of materials', count: bom?.lines.length },
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
        {mode === 'bom' && <ExportMenu disabled={!bom?.lines.length} />}
      </div>
      {mode === 'bom' ? (
        <BomView bom={bom} error={bomError} query={query} />
      ) : (
        <ComponentsView
          components={components}
          details={details}
          error={detailError}
          query={query}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */

function ExportMenu({ disabled }: { disabled: boolean }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // Success is reported only when the host says it wrote the file at the chosen path.
  const save = (format: 'csv' | 'markdown') =>
    run(async () => {
      const ext = format === 'csv' ? 'csv' : 'md';
      const dest = await window.omenflow.saveFile({
        defaultPath: `bill-of-materials.${ext}`,
        filters: [{ name: format === 'csv' ? 'CSV' : 'Markdown', extensions: [ext] }],
      });
      if (!dest) return;
      const r = await cmd<{ path?: string }>('bom.export', { format, destPath: dest });
      if (r.path) toast('ok', `Bill of materials saved to ${r.path}`);
      else
        toast(
          'error',
          'Not saved. This workspace service returns the bill of materials as text but does not write files. Use “Copy as Markdown” instead.',
        );
    });

  const copy = () =>
    run(async () => {
      const r = await cmd<{ content: string }>('bom.export', { format: 'markdown' });
      await copyText(r.content, 'the bill of materials as Markdown');
    });

  return (
    <Menu
      align="end"
      trigger={
        <Button size="sm" icon={<DownloadSimple size={13} />} busy={busy} disabled={disabled}>
          Export
        </Button>
      }
      items={[
        { label: 'Save as CSV…', onSelect: () => void save('csv') },
        { label: 'Save as Markdown…', onSelect: () => void save('markdown') },
        {
          label: 'Copy as Markdown',
          icon: <Copy size={13} />,
          onSelect: () => void copy(),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Bill of materials                                                    */
/* ------------------------------------------------------------------ */

function BomView({ bom, error, query }: { bom: Bom | null; error: string; query: string }) {
  const decide = useStore((s) => s.decide);
  const focus = useStore((s) => s.focus);
  const lines = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (bom?.lines ?? []).filter((l) =>
      `${l.componentTitle} ${l.partNumber} ${l.manufacturer} ${l.line.subsystem ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [bom, query]);
  const rowProps = useRowNav(lines.map((l) => l.line.id));

  if (error) return <Empty title="The bill of materials didn’t load" body={error} />;
  if (!bom)
    return (
      <p className="lens-muted" role="status">
        Reading the bill of materials…
      </p>
    );
  if (!bom.lines.length)
    return (
      <Empty
        title="The bill starts with a decision"
        body="Approved component selections become lines here, with sourced cost and mass."
        action={<Button onClick={() => decide(null)}>Open decisions</Button>}
      />
    );
  const unit = massUnitFor(bom.totals.knownMass);
  return (
    <>
      <BomTotals bom={bom} unit={unit} />
      {lines.length ? (
        <div className="lens-table">
          <table className="table parts-table bom-table" data-rows="">
            <thead>
              <tr>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col">
                  <span className="sr-only">Image</span>
                </th>
                <th scope="col">Part</th>
                <th scope="col" className="num">
                  Unit price
                </th>
                <th scope="col" className="num">
                  Extended
                </th>
                <th scope="col" className="num">
                  Mass
                </th>
                <th scope="col">Buy</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <BomRow
                  key={l.line.id}
                  line={l}
                  unit={unit}
                  rowProps={rowProps(l.line.id, () => focus(l.line.componentArtifactId))}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="lens-muted">No line matches “{query}”.</p>
      )}
      <p className="footnote">
        Totals cover the whole bill, not the filter. Unknown values are excluded from known totals,
        never counted as zero. Recorded seller prices; shipping and tax may be additional.
      </p>
    </>
  );
}

function Excluded({
  label,
  entries,
  unlisted,
}: {
  label: string;
  entries: UnknownEntry[];
  unlisted: number;
}) {
  if (!entries.length && !unlisted) return null;
  return (
    <div className="bom-excluded">
      <span className="bom-excluded-label">{label}</span>
      <ul>
        {entries.map((e) => (
          <li key={e.lineId}>
            {e.componentTitle}
            {e.reason && <span className="dim"> · {e.reason}</span>}
          </li>
        ))}
        {unlisted > 0 && (
          <li className="dim">
            {unlisted} more counted by the workspace service without a line reference
          </li>
        )}
      </ul>
    </div>
  );
}

function BomTotals({ bom, unit }: { bom: Bom; unit: 'g' | 'kg' | null }) {
  const t = bomTotalsView(bom);
  const priceUnknown = t.priceUnknown.length + t.priceUnknownUnlisted;
  const massUnknown = t.massUnknown.length + t.massUnknownUnlisted;
  return (
    <section className="bom-totals" aria-label="Bill of materials totals">
      <dl>
        <div>
          <dt>Known cost</dt>
          <dd className="num">
            {t.cost.length ? (
              t.cost.map((m, i) => (
                <React.Fragment key={m.currency}>
                  {i > 0 && <span className="dim"> + </span>}
                  {formatMoney(m)}
                </React.Fragment>
              ))
            ) : (
              <span className="unknown">Unknown</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Known mass</dt>
          <dd className="num">
            {t.mass ? formatMass(t.mass, unit) : <span className="unknown">Unknown</span>}
          </dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd className="num">{t.lines}</dd>
        </div>
        <div>
          <dt>Excluded as unknown</dt>
          <dd className="num">
            {priceUnknown || massUnknown ? (
              <span className="tone-warn-text">
                {priceUnknown} {priceUnknown === 1 ? 'price' : 'prices'}, {massUnknown}{' '}
                {massUnknown === 1 ? 'mass' : 'masses'}
              </span>
            ) : (
              'None'
            )}
          </dd>
        </div>
      </dl>
      {(priceUnknown > 0 || massUnknown > 0 || t.replaced > 0) && (
        <div className="bom-excluded-list">
          <Excluded
            label="Price unknown"
            entries={t.priceUnknown}
            unlisted={t.priceUnknownUnlisted}
          />
          <Excluded label="Mass unknown" entries={t.massUnknown} unlisted={t.massUnknownUnlisted} />
          {t.replaced > 0 && (
            <p className="dim">
              {t.replaced} {t.replaced === 1 ? 'line belongs' : 'lines belong'} to replaced
              components and {t.replaced === 1 ? 'is' : 'are'} left out of the bill.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BomRow({
  line: l,
  unit,
  rowProps,
}: {
  line: BomLineView;
  unit: 'g' | 'kg' | null;
  rowProps: RowProps;
}) {
  const focus = useStore((s) => s.focus);
  const mass = formatMass(lineMass(l), unit);
  const href = purchaseUrl(l.offer?.url);
  return (
    <tr {...rowProps} className="lens-row" aria-label={`${l.line.quantity} × ${l.componentTitle}`}>
      <td className="num parts-qty">{l.line.quantity}</td>
      <td>
        <ProductImage url={l.imageUrl} name={l.componentTitle} size="thumb" />
      </td>
      <td className="parts-part">
        <button
          type="button"
          className="cell-link"
          tabIndex={-1}
          onClick={() => focus(l.line.componentArtifactId)}
        >
          {l.componentTitle}
        </button>
        <span className="cell-sub">
          {l.manufacturer || 'Maker unknown'} ·{' '}
          <span className="mono">{l.partNumber || 'part number unknown'}</span>
          {l.line.subsystem && <> · {l.line.subsystem}</>}
        </span>
        {l.componentRevisionCurrent === false && (
          <span className="cell-sub tone-warn-text">Pinned to an earlier revision</span>
        )}
      </td>
      <td className="num">
        {l.offer?.price ? formatMoney(l.offer.price) : <span className="unknown">Unknown</span>}
        {l.offer && <OfferBasis offer={l.offer} />}
      </td>
      <td className="num">
        {l.lineTotal ? formatMoney(l.lineTotal) : <span className="unknown">Unknown</span>}
        {!l.lineTotal && l.priceUnknownReason && (
          <span className="cell-sub">{l.priceUnknownReason}</span>
        )}
      </td>
      <td className="num">
        {mass ?? <span className="unknown">Unknown</span>}
        {!mass && l.massUnknownReason && <span className="cell-sub">{l.massUnknownReason}</span>}
      </td>
      <td className="parts-buy">
        {href ? (
          <ExternalLink url={href}>{new URL(href).hostname.replace(/^www\./, '')}</ExternalLink>
        ) : (
          <span className="unknown">Link needed</span>
        )}
      </td>
      <td className="parts-actions">
        <PartActions
          id={l.line.componentArtifactId}
          title={l.componentTitle}
          manufacturer={l.manufacturer}
          partNumber={l.partNumber}
          reason={l.selectionReason}
          purchase={href}
        />
      </td>
    </tr>
  );
}

/** Pack basis, seller and the local date the price was observed. */
function OfferBasis({ offer }: { offer: Pick<Offer, 'quantityBasis' | 'seller' | 'observedAt'> }) {
  return (
    <>
      <span className="cell-sub" title={offer.seller}>
        {offer.quantityBasis === 1 ? 'Each' : `Pack of ${offer.quantityBasis}`} · {offer.seller}
      </span>
      <span className="cell-sub">
        Observed <time dateTime={offer.observedAt}>{observedDate(offer.observedAt)}</time>
      </span>
    </>
  );
}

function PartActions({
  id,
  title,
  manufacturer,
  partNumber,
  reason,
  purchase,
}: {
  id: string;
  title: string;
  manufacturer?: string;
  partNumber?: string;
  reason?: string | null;
  purchase: string | null;
}) {
  const focus = useStore((s) => s.focus);
  const readOnly = useStore((s) => s.readOnly);
  const items: MenuItem[] = [
    { label: 'Open component', onSelect: () => focus(id) },
    {
      label: 'Ask agent for alternatives',
      icon: <Sparkle size={13} />,
      disabled: readOnly,
      onSelect: () => {
        askAgent(alternativesPrompt({ id, title, manufacturer, partNumber, reason }));
      },
    },
    {
      label: 'Copy part number',
      icon: <Copy size={13} />,
      disabled: !partNumber,
      onSelect: () => void copyText(partNumber ?? '', `part number ${partNumber}`),
    },
  ];
  if (purchase)
    items.push({
      label: 'Open purchase page',
      icon: <ArrowSquareOut size={13} />,
      onSelect: () =>
        void window.omenflow
          .openExternal(purchase)
          .catch((e) => useStore.getState().toast('error', errMsg(e))),
    });
  return (
    <Menu
      align="end"
      trigger={
        <IconButton size="sm" label={`Actions for ${title}`}>
          <DotsThree size={14} weight="bold" />
        </IconButton>
      }
      items={items}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Components                                                           */
/* ------------------------------------------------------------------ */

interface PartRow {
  view: ArtifactView;
  payload: Partial<ComponentPayload>;
  offers: Offer[];
  group: PartGroup;
}

const GROUP_ORDER: PartGroup[] = ['candidate', 'selected', 'set-aside'];

function ComponentsView({
  components,
  details,
  error,
  query,
}: {
  components: ArtifactView[];
  details: ComponentDetail[];
  error: string;
  query: string;
}) {
  const focus = useStore((s) => s.focus);
  const toast = useStore((s) => s.toast);
  const [picked, setPicked] = useViewState<string[]>('parts:picked', []);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return components
      .map((view): PartRow => {
        const detail = details.find((d) => d.artifact.id === view.artifact.id);
        const payload = (detail?.payload ??
          view.revision?.payload ??
          {}) as Partial<ComponentPayload>;
        return { view, payload, offers: detail?.offers ?? [], group: partGroup(payload.status) };
      })
      .filter(({ view, payload }) =>
        `${view.artifact.title} ${payload.partNumber ?? ''} ${payload.manufacturer ?? payload.vendor ?? ''}`
          .toLowerCase()
          .includes(q),
      );
  }, [components, details, query]);
  const groups = GROUP_ORDER.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) }));
  const ordered = groups.flatMap((g) => g.rows);
  const rowProps = useRowNav(ordered.map((r) => r.view.artifact.id));

  // Parts that left the project leave the comparison; the open comparison follows the record.
  const ids = components.map((v) => v.artifact.id);
  const live = picked.filter((id) => ids.includes(id));
  const liveKey = live.join(',');
  useEffect(() => {
    if (!comparing || live.length < 2) {
      setComparison(null);
      return;
    }
    let active = true;
    void cmd<Comparison>('component.compare', { artifactIds: live })
      .then((r) => active && setComparison(r))
      .catch((e) => {
        if (!active) return;
        toast('error', errMsg(e));
        setComparing(false);
      });
    return () => {
      active = false;
    };
    // `liveKey` stands for `live`; `details` changes whenever the record does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparing, liveKey, details]);

  if (!components.length)
    return (
      <Empty
        title="No components yet"
        body="Ask your agent to research parts with sources. Candidates gather here for comparison before a selection."
      />
    );

  const toggle = (id: string, on: boolean) =>
    setPicked((p) => (on ? [...p.filter((x) => x !== id), id] : p.filter((x) => x !== id)));

  return (
    <>
      <div className="parts-compare-bar">
        <span className="dim">
          {live.length
            ? `${live.length} of ${COMPARE_LIMIT} picked for comparison`
            : `Pick 2 to ${COMPARE_LIMIT} parts to compare them side by side.`}
        </span>
        {live.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
            Clear
          </Button>
        )}
        <Button
          size="sm"
          disabled={live.length < 2}
          aria-pressed={comparing && live.length >= 2}
          onClick={() => setComparing(!comparing)}
        >
          {comparing && live.length >= 2
            ? 'Hide comparison'
            : live.length
              ? `Compare ${live.length}`
              : 'Compare'}
        </Button>
      </div>
      {comparing && comparison && (
        <ComparePanel comparison={comparison} onClose={() => setComparing(false)} />
      )}
      {error && <p className="tone-warn-text">Part details didn’t load: {error}</p>}
      {rows.length ? (
        <div className="lens-table">
          <table className="table parts-table components-table" data-rows="">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Compare</span>
                </th>
                <th scope="col">
                  <span className="sr-only">Image</span>
                </th>
                <th scope="col">Part</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Price
                </th>
                <th scope="col">Buy</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            {groups
              .filter((g) => g.rows.length)
              .map((g) => (
                <tbody key={g.group}>
                  <tr className="parts-group">
                    <th scope="colgroup" colSpan={7}>
                      {GROUP_LABEL[g.group]}
                      <span className="count">{g.rows.length}</span>
                      <span className="dim"> · {GROUP_HINT[g.group]}</span>
                    </th>
                  </tr>
                  {g.rows.map((r) => (
                    <ComponentRow
                      key={r.view.artifact.id}
                      row={r}
                      picked={live.includes(r.view.artifact.id)}
                      canPick={live.length < COMPARE_LIMIT}
                      onPick={(on) => toggle(r.view.artifact.id, on)}
                      rowProps={rowProps(r.view.artifact.id, () => focus(r.view.artifact.id))}
                    />
                  ))}
                </tbody>
              ))}
          </table>
        </div>
      ) : (
        <p className="lens-muted">No part matches “{query}”.</p>
      )}
      <p className="footnote">
        Recorded seller prices; shipping and tax may be additional. Prices and availability can
        change.
      </p>
    </>
  );
}

function ComponentRow({
  row: { view, payload, offers },
  picked,
  canPick,
  onPick,
  rowProps,
}: {
  row: PartRow;
  picked: boolean;
  canPick: boolean;
  onPick: (on: boolean) => void;
  rowProps: RowProps;
}) {
  const focus = useStore((s) => s.focus);
  const title = view.artifact.title;
  const [offer, ...more] = offers;
  const href = purchaseUrl(offer?.url);
  return (
    <tr {...rowProps} className={`lens-row ${picked ? 'picked' : ''}`} aria-label={title}>
      <td>
        <input
          type="checkbox"
          aria-label={`Compare ${title}`}
          checked={picked}
          disabled={!picked && !canPick}
          title={!picked && !canPick ? `Compare up to ${COMPARE_LIMIT} parts` : undefined}
          onChange={(e) => onPick(e.target.checked)}
        />
      </td>
      <td>
        <ProductImage url={payload.imageUrl} name={title} size="thumb" />
      </td>
      <td className="parts-part">
        <button
          type="button"
          className="cell-link"
          tabIndex={-1}
          onClick={() => focus(view.artifact.id)}
        >
          {title}
        </button>
        <span className="cell-sub">
          {payload.manufacturer || payload.vendor || 'Maker unknown'} ·{' '}
          <span className="mono">{payload.partNumber || 'part number unknown'}</span>
        </span>
        <span className="cell-sub parts-reason">
          {payload.selectionReason || (
            <span className="unknown">Selection reason not recorded</span>
          )}
        </span>
      </td>
      <td className="parts-state">
        <State state={payload.status ?? 'candidate'} quiet />
        {view.pendingProposal && <State state="proposed" quiet />}
        {!view.revision && <span className="cell-sub">No approved revision</span>}
      </td>
      <td className="num">
        {offer ? (
          <>
            {offer.price ? (
              formatMoney(offer.price)
            ) : (
              <span className="unknown">Price unknown</span>
            )}
            <OfferBasis offer={offer} />
            {more.length > 0 && (
              <span className="cell-sub">
                {more.length} more {more.length === 1 ? 'offer' : 'offers'}
              </span>
            )}
          </>
        ) : (
          <span className="unknown">No offer recorded</span>
        )}
      </td>
      <td className="parts-buy">
        {href ? (
          <ExternalLink url={href}>{new URL(href).hostname.replace(/^www\./, '')}</ExternalLink>
        ) : (
          <span className="unknown">Link needed</span>
        )}
      </td>
      <td className="parts-actions">
        <PartActions
          id={view.artifact.id}
          title={title}
          manufacturer={payload.manufacturer ?? payload.vendor}
          partNumber={payload.partNumber}
          reason={payload.selectionReason}
          purchase={href}
        />
      </td>
    </tr>
  );
}

function ComparePanel({ comparison, onClose }: { comparison: Comparison; onClose: () => void }) {
  const focus = useStore((s) => s.focus);
  const n = comparison.components.length;
  return (
    <section className="compare island" aria-label="Side by side">
      <header>
        <h3>Side by side</h3>
        <span className="dim">Differences are named in the first column.</span>
        <span className="grow" />
        <IconButton size="sm" label="Close comparison" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </header>
      <div className="compare-scroll">
        <table className="table compare-table">
          <thead>
            <tr>
              <th scope="col">Property</th>
              {comparison.components.map((c) => (
                <th scope="col" key={c.artifact.id}>
                  <button type="button" className="cell-link" onClick={() => focus(c.artifact.id)}>
                    {c.artifact.title}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Why this part</th>
              {comparison.components.map((c) => (
                <td key={c.artifact.id}>
                  {c.payload?.selectionReason || (
                    <span className="unknown">Reason not recorded</span>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Seller offers</th>
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
            {comparison.matrix.map((m) => {
              const row = compareValues(m.values);
              return (
                <tr key={m.criterion} className={`compare-${row.verdict}`}>
                  <th scope="row">
                    {m.criterion.replaceAll('_', ' ')}
                    <span className="compare-verdict">{compareLabel(row, n)}</span>
                  </th>
                  {m.values.map((v, i) => (
                    <td key={i} className="num">
                      {v == null ? (
                        <span className="unknown">Not recorded</span>
                      ) : (
                        recordedQuantityText(v)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="footnote">A matching price or value is not compatibility evidence.</p>
    </section>
  );
}
