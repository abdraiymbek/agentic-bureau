import React, { useEffect, useState } from 'react';
import type { ComponentPayload, Offer } from '@omenflow/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Block, Button, Facts, Notice, Skeleton, State } from '../../ui/kit';
import { ExternalLink } from '../../ui/ExternalLink';
import { ProductImage, purchaseUrl } from '../../ui/PartCard';
import { ObjectLink, qty, type StageProps } from './shared';

function observed(iso: string): string {
  const time = new Date(iso);
  return Number.isFinite(time.getTime())
    ? time.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : iso;
}

/** Offers side by side. A price that was not recorded reads "Unknown", never a number. */
function OffersTable({ offers }: { offers: Offer[] }) {
  return (
    <div className="table-wrap">
      <table className="table offers">
        <thead>
          <tr>
            <th>Seller</th>
            <th className="num">Price</th>
            <th>Sold as</th>
            <th>Availability</th>
            <th>Observed</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => {
            const href = purchaseUrl(offer.url);
            return (
              <tr key={offer.id}>
                <td>
                  {offer.seller}
                  <small className="cell-sub">
                    {href ? (
                      <ExternalLink url={href}>
                        {new URL(href).hostname.replace(/^www\./, '')}
                      </ExternalLink>
                    ) : (
                      <span className="unknown">Purchase link needed</span>
                    )}
                  </small>
                </td>
                <td className="num nowrap">
                  {offer.price ? (
                    `${offer.price.amount} ${offer.price.currency}`
                  ) : (
                    <span className="unknown">Unknown</span>
                  )}
                </td>
                <td className="nowrap">
                  {offer.quantityBasis === 1 ? 'Each' : `Pack of ${offer.quantityBasis}`}
                </td>
                <td>{offer.availabilityText ?? <span className="unknown">Not recorded</span>}</td>
                <td className="nowrap">
                  <time dateTime={offer.observedAt}>{observed(offer.observedAt)}</time>
                </td>
                <td>
                  {offer.sourceId ? (
                    <ObjectLink id={offer.sourceId} fallback="Recorded source" glyph />
                  ) : (
                    <span className="unknown">No source recorded</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ComponentStage({ view }: StageProps) {
  const projectId = useStore((s) => s.projectId);
  const partsVersion = useStore((s) => s.partsVersion);
  const p = (view.revision?.payload ?? {}) as Partial<ComponentPayload>;
  const props = Object.entries(p.properties ?? {});
  const attributes = Object.entries(p.attributes ?? {});
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [offerError, setOfferError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Offers belong to the object, not to a revision; adding one does not replace `view`.
  useEffect(() => {
    let active = true;
    void cmd<{ components: { offers: Offer[] }[] }>(
      'component.compare',
      { artifactIds: [view.artifact.id] },
      { projectId: projectId ?? undefined },
    )
      .then((r) => {
        if (!active) return;
        setOffers(r.components[0]?.offers ?? []);
        setOfferError('');
      })
      .catch((e) => active && setOfferError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [view, projectId, partsVersion, attempt]);
  const unpriced = offers?.filter((o) => !o.price).length ?? 0;
  return (
    <div className="doc">
      <div className="component-product">
        <ProductImage url={p.imageUrl} name={view.artifact.title} />
        {p.selectionReason && (
          <p className="part-reason">
            <span>Why this part</span>
            {p.selectionReason}
          </p>
        )}
      </div>
      {p.description && <p className="doc-lede">{p.description}</p>}
      <div className="spec-head">
        <div>
          <span className="target-label">Part number</span>
          <strong className="mono">{p.partNumber ?? 'Unknown'}</strong>
        </div>
        <div>
          <span className="target-label">Maker</span>
          <strong>{p.manufacturer ?? p.vendor ?? 'Unknown'}</strong>
        </div>
        <div>
          <span className="target-label">Selection</span>
          <State state={p.status ?? 'candidate'} />
        </div>
      </div>
      <Block title="Engineering properties" count={props.length}>
        {props.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th className="num">Value</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {props.map(([key, value]) => (
                  <tr key={key}>
                    <td>{key.replaceAll('_', ' ')}</td>
                    <td className="num nowrap">
                      {value.quantity ? (
                        qty(value.quantity)
                      ) : (
                        <span className="unknown">Unknown</span>
                      )}
                    </td>
                    <td>
                      {value.sourceId ? (
                        <ObjectLink id={value.sourceId} fallback="Recorded source" glyph />
                      ) : (
                        <span className="unknown">No source recorded</span>
                      )}
                      {value.locator && <small className="cell-sub">{value.locator}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim">No engineering properties recorded.</p>
        )}
      </Block>
      {attributes.length > 0 && (
        <Block title="Attributes">
          <Facts
            rows={attributes.map(([name, fact]) => [
              name,
              <span key={name}>
                {fact.value}
                {fact.sourceId && (
                  <>
                    {' '}
                    · <ObjectLink id={fact.sourceId} fallback="Recorded source" />
                  </>
                )}
                {fact.locator && <small className="cell-sub">{fact.locator}</small>}
              </span>,
            ])}
          />
        </Block>
      )}
      <Block title="Supplier offers" count={offers?.length}>
        {offerError ? (
          <Notice
            tone="err"
            role="alert"
            action={
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            }
          >
            Offers didn’t load: {offerError}
          </Notice>
        ) : !offers ? (
          <Skeleton lines={2} />
        ) : !offers.length ? (
          <p className="dim">
            No supplier offer recorded. Ask the agent to capture a product link and offer.
          </p>
        ) : (
          <>
            <OffersTable offers={offers} />
            {unpriced > 0 && (
              <p className="footnote">
                {unpriced === 1 ? '1 offer has' : `${unpriced} offers have`} no recorded price. An
                unknown price is excluded from every known total.
              </p>
            )}
          </>
        )}
      </Block>
      {(p.missingFields?.length ?? 0) > 0 && (
        <Notice tone="warn">Missing: {p.missingFields!.join(', ')}</Notice>
      )}
    </div>
  );
}
