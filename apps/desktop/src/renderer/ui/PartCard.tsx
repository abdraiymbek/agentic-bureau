import React, { useState } from 'react';
import { ImageSquare, Package } from '@phosphor-icons/react';
import type { ComponentPayload, Offer } from '@omenflow/contracts';
import { ExternalLink, webUrl } from './ExternalLink';
import { State } from './kit';

/**
 * Where a product image may be loaded from. The application only loads images over https, so an
 * http address is reported as such rather than shown as a broken image.
 */
export function imageSource(url?: string | null): { src: string } | { refused: string } | null {
  const href = webUrl(url ?? undefined);
  if (!href) return null;
  return new URL(href).protocol === 'https:'
    ? { src: href }
    : { refused: 'Image not loaded: insecure address' };
}

/**
 * A product photo in a box of fixed size. The placeholder holds the space until the image has
 * loaded, so nothing moves when it arrives; a missing, refused or failed image stays labelled.
 */
export function ProductImage({
  url,
  name,
  size = 'card',
}: {
  url?: string | null;
  name: string;
  size?: 'card' | 'thumb';
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const source = imageSource(url);
  const src = source && 'src' in source && failed !== source.src ? source.src : null;
  const note = !source
    ? 'Image not recorded'
    : 'refused' in source
      ? source.refused
      : failed === source.src
        ? 'Image unavailable'
        : null;
  return (
    <div
      className={`part-photo ${size === 'thumb' ? 'part-photo-thumb' : ''} ${src && loaded === src ? 'loaded' : ''}`}
      title={size === 'thumb' && note ? note : undefined}
    >
      <span className="part-photo-placeholder" aria-hidden={!!src}>
        <ImageSquare size={size === 'thumb' ? 16 : 24} weight="light" aria-hidden="true" />
        {note &&
          (size === 'thumb' ? <span className="sr-only">{note}</span> : <small>{note}</small>)}
      </span>
      {src && (
        <img
          src={src}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
        />
      )}
    </div>
  );
}

/** Hosts that cannot be a seller's page: placeholders, local names and bare addresses. */
const NOT_A_STORE =
  /(^|\.)(example\.(com|org|net)|localhost)$|\.(test|invalid|example|local|localhost|internal)$/;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

export function purchaseUrl(value?: string): string | null {
  const href = webUrl(value);
  if (!href) return null;
  const u = new URL(href);
  if (
    u.username ||
    u.password ||
    NOT_A_STORE.test(u.hostname) ||
    IP_LITERAL.test(u.hostname) ||
    !u.hostname.includes('.')
  )
    return null;
  return href;
}

/** The local calendar date of an observation; the recorded text when it is not a date. */
export function observedDate(iso: string): string {
  const t = new Date(iso);
  return Number.isFinite(t.getTime())
    ? t.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : iso;
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
      <small className="part-observed">
        Observed <time dateTime={offer.observedAt}>{observedDate(offer.observedAt)}</time>
      </small>
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
          <span>{payload.manufacturer || payload.vendor || 'Maker unknown'}</span>
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
