import {
  ComponentPayload,
  ErrorCodes,
  Money,
  Offer,
  Origin,
  OmenflowError,
  addMoney,
  convert,
  formatQty,
  isUnknown,
  newId,
  scaleMoney,
  type MaybeQuantity,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, createDraft } from './artifacts.js';
import { addEdge } from './graph.js';
import { submitProposal } from './proposals.js';

/**
 * Components: sourced identity + properties, separate seller offers,
 * revisioned selection. Unknown fields stay unknown — never zeroed.
 */
export function addCandidate(
  ctx: ProjectContext,
  input: {
    title: string;
    manufacturer?: string;
    vendor?: string;
    partNumber: string;
    description?: string;
    properties: ComponentPayload['properties'];
    attributes: ComponentPayload['attributes'];
    offer?: {
      seller: string;
      url?: string;
      price: Money | null;
      quantityBasis: number;
      availabilityText?: string;
      sourceId?: string;
    };
    sourceId?: string;
    alternativeTo?: string;
  },
  origin: Origin,
) {
  // Enforce "selectable real component" requirements up front.
  if (!input.manufacturer && !input.vendor) {
    throw new OmenflowError(ErrorCodes.MISSING_SOURCE, 'Component needs a manufacturer or vendor', {
      repair: 'Provide manufacturer/vendor plus a source URL or datasheet.',
    });
  }
  if (!input.sourceId && !input.offer?.url && !input.offer?.sourceId) {
    throw new OmenflowError(
      ErrorCodes.MISSING_SOURCE,
      'Component needs a source (URL/datasheet capture)',
      {
        repair: 'Capture the product page with source.capture first.',
      },
    );
  }
  const missing: string[] = [];
  for (const [k, v] of Object.entries(input.properties)) {
    if (isUnknown(v.quantity as MaybeQuantity)) missing.push(k);
  }
  const payload: ComponentPayload = {
    manufacturer: input.manufacturer,
    vendor: input.vendor,
    partNumber: input.partNumber,
    description: input.description,
    properties: input.properties,
    attributes: input.attributes,
    status: 'candidate',
    missingFields: missing,
  };
  const { artifact, revision } = createDraft(
    ctx,
    {
      type: 'component',
      title: input.title,
      payload,
      files: [],
      inputs: input.sourceId
        ? [{ artifactId: input.sourceId, relationship: 'derived_from', label: 'sourced from' }]
        : [],
      rationale: 'component candidate',
    },
    origin,
  );
  if (input.offer) {
    const offer: Offer = {
      id: newId(),
      seller: input.offer.seller,
      url: input.offer.url,
      price: input.offer.price,
      quantityBasis: input.offer.quantityBasis,
      availabilityText: input.offer.availabilityText,
      observedAt: new Date().toISOString(),
      sourceId: input.offer.sourceId,
    };
    ctx.repo.insertOffer(offer, artifact.id);
  }
  if (input.alternativeTo) {
    addEdge(ctx, artifact.id, input.alternativeTo, 'alternative_to', 'alternative', origin.kind);
  }
  return { artifact, revision };
}

export function addOffer(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    seller: string;
    url?: string;
    price: Money | null;
    quantityBasis: number;
    availabilityText?: string;
    sourceId?: string;
  },
  origin: Origin = { kind: 'system' },
) {
  const artifact = ctx.requireArtifact(input.artifactId);
  if (artifact.type !== 'component') {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Offers attach to component artifacts');
  }
  const offer: Offer = {
    id: newId(),
    seller: input.seller,
    url: input.url,
    price: input.price,
    quantityBasis: input.quantityBasis,
    availabilityText: input.availabilityText,
    observedAt: new Date().toISOString(),
    sourceId: input.sourceId,
  };
  ctx.repo.insertOffer(offer, artifact.id);
  ctx.emit('component.offer_added', origin.kind, { artifactId: artifact.id, offerId: offer.id });
  return { offer };
}

/** Side-by-side comparison across explicit criteria — never price-only. */
export function compareComponents(ctx: ProjectContext, artifactIds: string[]) {
  const rows = artifactIds.map((id) => {
    const a = ctx.requireArtifact(id);
    if (a.type !== 'component') {
      throw new OmenflowError(ErrorCodes.VALIDATION, `${a.title} is not a component`);
    }
    const rev = a.selectedRevisionId
      ? ctx.repo.getRevision(a.selectedRevisionId)
      : ctx.repo.listRevisions(a.id).at(-1);
    const payload = rev?.payload as ComponentPayload | undefined;
    return {
      artifact: a,
      revision: rev ?? null,
      payload: payload ?? null,
      offers: ctx.repo.offersForComponent(a.id),
      freshness: ctx.freshnessOf(a.id).freshness,
    };
  });
  // Union of property names → criteria matrix.
  const criteria = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.payload?.properties ?? {})) criteria.add(k);
  const matrix = [...criteria].map((name) => ({
    criterion: name,
    values: rows.map((r) => {
      const q = r.payload?.properties?.[name]?.quantity;
      return q === undefined ? null : q;
    }),
  }));
  return { components: rows, matrix };
}

/**
 * Propose selecting a component: creates a proposal binding the candidate
 * revision + BOM lines. Approval updates the baseline, archives the replaced
 * component, and inserts BOM lines atomically.
 */
export function proposeSelection(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    revisionId: string;
    bomLines: {
      subsystem: string | null;
      quantity: number;
      offerId: string | null;
      location: string | null;
      notes: string;
    }[];
    replacesArtifactId?: string;
    reason: string;
  },
  origin: Origin,
) {
  const artifact = ctx.requireArtifact(input.artifactId);
  if (artifact.type !== 'component') {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Selection target must be a component');
  }
  const rev = ctx.requireRevision(input.revisionId);
  if (rev.artifactId !== artifact.id) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to component');
  }
  const payload = { ...(rev.payload as ComponentPayload), status: 'selected' as const };
  // Draft carrying the new status.
  const selRev = commitRevision(ctx, {
    artifactId: artifact.id,
    parentId: rev.id,
    origin,
    payload,
    files: rev.files,
    inputs: rev.inputs,
    rationale: `select ${artifact.title}`,
    reviewState: 'draft',
  });
  const bomLines = input.bomLines.map((l) => ({
    componentArtifactId: artifact.id,
    componentRevisionId: selRev.id,
    subsystem: l.subsystem,
    quantity: l.quantity,
    offerId: l.offerId,
    location: l.location,
    notes: l.notes,
  }));
  const proposal = submitProposal(
    ctx,
    {
      changes: [
        {
          artifactId: artifact.id,
          baseRevisionId: artifact.selectedRevisionId,
          newRevisionId: selRev.id,
          kind: 'component_selection',
          replacesArtifactId: input.replacesArtifactId,
          bomLines,
        },
      ],
      reason: input.reason,
    },
    origin,
  );
  return { proposal };
}

/* ------------------------------------------------------------------ */
/* BOM                                                                  */
/* ------------------------------------------------------------------ */

export function readBom(ctx: ProjectContext) {
  const lines = ctx.repo.listBomLines().map((l) => {
    const component = ctx.repo.getArtifact(l.componentArtifactId);
    const rev = ctx.repo.getRevision(l.componentRevisionId);
    const payload = rev?.payload as ComponentPayload | undefined;
    const offer = l.offerId ? ctx.repo.getOffer(l.offerId) : null;
    const massProp = payload?.properties?.mass ?? payload?.properties?.weight;
    const unitMass =
      massProp && !isUnknown(massProp.quantity as MaybeQuantity)
        ? (massProp.quantity as { value: number; unit: string })
        : null;
    return {
      line: l,
      componentTitle: component?.title ?? l.componentArtifactId,
      partNumber: payload?.partNumber ?? '',
      manufacturer: payload?.manufacturer ?? payload?.vendor ?? '',
      offer,
      unitMass,
      lineMassKnown: unitMass !== null,
      lineTotal: offer?.price
        ? scaleMoney(offer.price, l.quantity / (offer.quantityBasis || 1))
        : null,
    };
  });
  // Totals: known subtotal per currency, missing-price count, known mass.
  const byCurrency = new Map<string, Money>();
  let missingPrice = 0;
  for (const r of lines) {
    if (r.lineTotal) {
      const cur = byCurrency.get(r.lineTotal.currency);
      byCurrency.set(r.lineTotal.currency, cur ? addMoney(cur, r.lineTotal) : r.lineTotal);
    } else {
      missingPrice++;
    }
  }
  let knownMass: { value: number; unit: string } | null = null;
  let missingMass = 0;
  for (const r of lines) {
    if (r.lineMassKnown && r.unitMass) {
      const q = { value: r.unitMass.value * r.line.quantity, unit: r.unitMass.unit };
      if (!knownMass) knownMass = q;
      else {
        try {
          const conv = convert(q, knownMass.unit);
          knownMass = { value: knownMass.value + conv.value, unit: knownMass.unit };
        } catch {
          missingMass++;
        }
      }
    } else missingMass++;
  }
  return {
    lines,
    totals: {
      cost: [...byCurrency.values()],
      missingPriceCount: missingPrice,
      knownMass,
      missingMassCount: missingMass,
      lineCount: lines.length,
    },
  };
}

export function bomMarkdown(ctx: ProjectContext): string {
  const { lines, totals } = readBom(ctx);
  const rows = lines.map((r) => {
    const price = r.offer?.price ? `${r.offer.price.amount} ${r.offer.price.currency}` : 'unknown';
    const obs = r.offer ? ` (observed ${r.offer.observedAt.slice(0, 10)})` : '';
    const mass = r.unitMass
      ? formatQty({ value: r.unitMass.value * r.line.quantity, unit: r.unitMass.unit })
      : 'unknown';
    return `| ${r.componentTitle} | ${r.partNumber} | ${r.manufacturer} | ${r.line.quantity} | ${price}${obs} | ${mass} | ${r.line.notes} |`;
  });
  const cost = totals.cost.map((c) => `${c.amount} ${c.currency}`).join(' + ') || 'unknown';
  return [
    '# Bill of materials',
    '',
    '| Part | Part no. | Manufacturer | Qty | Unit price | Mass | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Known subtotal: ${cost} — ${totals.missingPriceCount} line(s) missing price`,
    `Known mass: ${totals.knownMass ? formatQty(totals.knownMass) : 'unknown'} — ${totals.missingMassCount} line(s) missing mass`,
  ].join('\n');
}

export function bomCsv(ctx: ProjectContext): string {
  const { lines } = readBom(ctx);
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = lines.map((r) =>
    [
      esc(r.componentTitle),
      esc(r.partNumber),
      esc(r.manufacturer),
      r.line.quantity,
      r.offer?.price ? r.offer.price.amount : '',
      r.offer?.price?.currency ?? '',
      r.offer?.seller ?? '',
      r.offer?.url ?? '',
      r.offer?.observedAt ?? '',
      esc(r.line.notes),
    ].join(','),
  );
  return [
    'title,part_number,manufacturer,qty,unit_price,currency,seller,url,observed_at,notes',
    ...rows,
  ].join('\n');
}
