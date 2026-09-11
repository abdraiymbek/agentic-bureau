import { ErrorCodes, StarkError, formatQty, isUnknown, type MaybeQuantity } from '@stark/contracts';
import type { ProjectContext } from './context.js';

/**
 * Bounded structured project summary — the bootstrap context agents receive.
 * Fits within a character budget; links to detailed records by ID.
 */
export function projectSummary(ctx: ProjectContext, budgetChars: number) {
  const project = ctx.handle.project;
  const artifacts = ctx.repo.listArtifacts();
  const byType = new Map<string, number>();
  for (const a of artifacts) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);

  const reqs = artifacts
    .filter((a) => a.type === 'requirement')
    .map((a) => {
      const rev = a.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : null;
      const p = rev?.payload as { statement?: string; target?: MaybeQuantity; priority?: string } | undefined;
      return {
        id: a.id,
        title: a.title,
        statement: p?.statement ?? '',
        target: p?.target && !isUnknown(p.target) ? formatQty(p.target) : null,
        priority: p?.priority ?? 'should',
        freshness: ctx.freshnessOf(a.id).freshness,
      };
    });

  const assumptions = artifacts
    .filter((a) => a.type === 'assumption')
    .map((a) => {
      const rev = a.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : null;
      const p = rev?.payload as { statement?: string; needsValidation?: boolean } | undefined;
      return { id: a.id, title: a.title, statement: p?.statement ?? '', needsValidation: p?.needsValidation ?? true };
    });

  const pending = ctx.repo.listProposals('pending').map((p) => ({ id: p.id, reason: p.reason, changes: p.changes.length }));
  const stale = ctx.repo.allStale().map((s) => ({
    artifactId: s.artifactId,
    reason: s.reason,
    title: ctx.repo.getArtifact(s.artifactId)?.title ?? s.artifactId,
  }));
  const decisions = ctx.repo.listDecisions(10).map((d) => ({
    id: d.id,
    action: d.action,
    actor: d.actor,
    ts: d.ts,
    rationale: d.rationale,
  }));
  const events = ctx.repo.listEvents(10).map((e) => ({ seq: e.seq, type: e.type, ts: e.ts }));

  const summary = {
    project: { id: project.id, name: project.name, intent: project.intent },
    counts: Object.fromEntries(byType),
    requirements: reqs,
    assumptions,
    pendingProposals: pending,
    staleArtifacts: stale,
    recentDecisions: decisions,
    recentEvents: events,
    tools: 'stark call <op> or stark mcp — see tool.list',
    rules: 'Accepted engineering changes go through proposals; drafts are free.',
  };

  // Budget enforcement: progressively trim every list section.
  let json = JSON.stringify(summary);
  const lists: { key: keyof typeof summary; min: number }[] = [
    { key: 'requirements', min: 3 },
    { key: 'assumptions', min: 3 },
    { key: 'pendingProposals', min: 0 },
    { key: 'staleArtifacts', min: 0 },
    { key: 'recentDecisions', min: 0 },
    { key: 'recentEvents', min: 0 },
  ];
  let guard = 0;
  while (json.length > budgetChars && guard++ < 40) {
    const big = lists
      .map((l) => ({ ...l, len: (summary[l.key] as unknown[]).length }))
      .filter((l) => l.len > l.min)
      .sort((a, b) => b.len - a.len)[0];
    if (!big) break;
    (summary[big.key] as unknown[]).splice(Math.floor(big.len / 2));
    (summary[big.key] as unknown[]).length = Math.max(big.min, Math.floor(big.len / 2));
    json = JSON.stringify(summary);
  }
  return summary;
}

export function search(ctx: ProjectContext, query: string, limit: number) {
  // Escape FTS5 special chars minimally: wrap terms in quotes.
  const safe = query.replace(/"/g, ' ').trim();
  if (!safe) return { results: [] };
  try {
    const hits = ctx.repo.ftsSearch(safe, limit);
    return {
      results: hits.map((h) => {
        const a = ctx.repo.getArtifact(h.artifactId);
        return {
          artifactId: h.artifactId,
          revisionId: h.revisionId,
          title: h.title,
          type: a?.type ?? 'note',
          snippet: h.snippet,
        };
      }),
    };
  } catch (e) {
    throw new StarkError(ErrorCodes.VALIDATION, `Search failed: ${(e as Error).message}`);
  }
}

export function changesSince(ctx: ProjectContext, seq: number) {
  return { events: ctx.repo.eventsSince(seq), latest: ctx.repo.latestEventSeq() };
}
