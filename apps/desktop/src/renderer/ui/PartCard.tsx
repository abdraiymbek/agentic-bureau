import React, { useState } from 'react';
import { ImageSquare, Package } from '@phosphor-icons/react';
import type { ComponentPayload, Offer } from '@omenflow/contracts';
import { ExternalLink, webUrl } from './ExternalLink';
import { State } from './kit';

export function ProductImage({ url, name }: { url?: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = webUrl(url ?? undefined);
  return (
    <div className="part-photo">
      {src && failed !== src ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : (
        <span>
          <ImageSquare size={24} weight="light" />
          <small>{src ? 'Image unavailable' : 'Image not recorded'}</small>
        </span>
      )}
    </div>
  );
}

export function purchaseUrl(value?: string): string | null {
  const href = webUrl(value);
  if (!href) return null;
  const u = new URL(href);
  if (
    u.username ||
    u.password ||
    /(^|\.)(example\.(com|org|net)|localhost)$|\.(test|invalid|example|local)$/.test(u.hostname)
  )
    return null;
  return href;
}

export function OfferDetails({
  offer,
}: {
  offer: Pick<
    Offer,
    'url' | 'seller' | 'price' | 'quantityBasis' | 'observedAt' | 'availabilityText'
  >;
}) {
  const href = purchaseUrl(offer.url);
  return (
    <div className="part-offer">
      <div className="part-price num">
        {offer.price ? (
          `${offer.price.amount} ${offer.price.currency}`
        ) : (
          <span className="unknown">Price unknown</span>
        )}
      </div>
      <div className="part-basis">
        {offer.quantityBasis === 1 ? 'Each' : `Pack of ${offer.quantityBasis}`} · {offer.seller}
      </div>
      {offer.availabilityText && <p className="part-availability">{offer.availabilityText}</p>}
      {href ? (
        <ExternalLink url={href}>View at {offer.seller}</ExternalLink>
      ) : (
        <span className="unknown">Purchase link needed</span>
      )}
      {href && (
        <span className="part-domain" title={href}>
          {new URL(href).hostname.replace(/^www\./, '')}
        </span>
      )}
      <small className="part-observed">Observed {offer.observedAt.slice(0, 10)}</small>
    </div>
  );
}

/** A sourced shopping line, shared by candidates and approved BOM entries. */
export function PartCard({
  title,
  payload,
  offers,
  onFocus,
  children,
  selection,
  reason,
}: {
  title: string;
  payload: Partial<ComponentPayload>;
  offers: Pick<
    Offer,
    'url' | 'seller' | 'price' | 'quantityBasis' | 'observedAt' | 'availabilityText'
  >[];
  onFocus: () => void;
  children?: React.ReactNode;
  selection?: React.ReactNode;
  reason?: string;
}) {
  return (
    <li className="part-card">
      {selection && <div className="part-select">{selection}</div>}
      <ProductImage url={payload.imageUrl} name={title} />
      <div className="part-content">
        <div className="part-eyebrow">
          <Package size={13} />
          <span>{payload.manufacturer ?? payload.vendor ?? 'Maker unknown'}</span>
          <State state={payload.status ?? 'candidate'} quiet />
        </div>
        <button type="button" className="part-title cell-link" onClick={onFocus}>
          {title}
        </button>
        <span className="part-number mono">{payload.partNumber || 'Part number unknown'}</span>
        <p className="part-reason">
          <span>Why this part</span>
          {reason || payload.selectionReason || (
            <span className="unknown">Selection reason not recorded</span>
          )}
        </p>
        {payload.description && <p className="part-description">{payload.description}</p>}
        {children}
        {!!payload.missingFields?.length && (
          <small className="unknown">Missing: {payload.missingFields.join(', ')}</small>
        )}
      </div>
      <div className="part-offers">
        {offers.length ? (
          offers.map((o, i) => <OfferDetails key={`${o.url}-${i}`} offer={o} />)
        ) : (
          <span className="unknown">Price and purchase link needed</span>
        )}
      </div>
    </li>
  );
}
