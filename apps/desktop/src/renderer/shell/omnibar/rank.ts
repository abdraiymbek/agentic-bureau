/**
 * Omnibar ranking. Objects and commands are matched word by word; asking the agent is never the
 * default result of a search — it is listed last, and selected first only when the query starts
 * with the ask prefix.
 */

export type GroupId =
  'recent' | 'objects' | 'content' | 'decisions' | 'goto' | 'agent' | 'actions' | 'ask';

export const GROUP_LABELS: Record<GroupId, string> = {
  recent: 'Recent',
  objects: 'Objects',
  content: 'Project content',
  decisions: 'Decisions',
  goto: 'Go to',
  agent: 'Agent',
  actions: 'Actions',
  ask: 'Ask the agent',
};

/** Order of groups when nothing is typed, and the tie-break when scores are equal. */
const GROUP_ORDER: GroupId[] = [
  'recent',
  'objects',
  'content',
  'decisions',
  'goto',
  'agent',
  'actions',
  'ask',
];

/** How many of a group are shown before "refine your search". */
export const GROUP_CAP: Record<GroupId, number> = {
  recent: 8,
  objects: 12,
  content: 12,
  decisions: 6,
  goto: 10,
  agent: 8,
  actions: 12,
  ask: 1,
};

export const ASK_PREFIX = '>';

export interface Candidate {
  id: string;
  group: GroupId;
  label: string;
  /** Extra words that find it: type, state, subsystem, synonyms. Weighted below the label. */
  keywords?: string;
  /** Position among recently used items, 0 = most recent. */
  recent?: number;
  /** Exact query the host matched inside a revision's content. */
  contentQuery?: string;
}

export interface Query {
  /** `ask` when the person typed the ask prefix: the text goes to the agent and nothing else is searched. */
  mode: 'search' | 'ask';
  text: string;
  tokens: string[];
}

export function parseQuery(raw: string): Query {
  const trimmed = raw.trim();
  if (trimmed.startsWith(ASK_PREFIX)) {
    const text = trimmed.slice(ASK_PREFIX.length).trim();
    return { mode: 'ask', text, tokens: [] };
  }
  return { mode: 'search', text: trimmed, tokens: tokenize(trimmed) };
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;:/·—–-]+/)
    .map((t) => t.replace(/^[("'“‘]+|[)"'”’.!?]+$/g, ''))
    .filter(Boolean);
}

/** Best score of one query token against a list of words; 0 = no match. */
function tokenScore(token: string, list: string[]): number {
  let best = 0;
  for (const w of list) {
    if (w === token) return 30;
    if (w.startsWith(token)) best = Math.max(best, 20 + Math.min(token.length, 6));
    else if (token.length >= 3 && w.includes(token)) best = Math.max(best, 8);
  }
  return best;
}

/**
 * Every token must match a word of the label or the keywords. No subsequence matching: "stale"
 * finds out-of-date objects through their keywords, not every command containing s, t, a, l, e.
 */
export function scoreCandidate(candidate: Candidate, query: Query): number {
  if (!query.tokens.length) return 0;
  const label = tokenize(candidate.label);
  const extra = tokenize(candidate.keywords ?? '');
  let total = 0;
  for (const token of query.tokens) {
    const inLabel = tokenScore(token, label);
    const inExtra = tokenScore(token, extra) * 0.6;
    const best = Math.max(inLabel, inExtra);
    if (best === 0)
      return candidate.contentQuery === query.text
        ? 12 - Math.min(candidate.label.length, 80) * 0.02
        : 0;
    total += best;
  }
  const lower = candidate.label.toLowerCase();
  const phrase = query.text.toLowerCase();
  if (lower.startsWith(phrase)) total += 18;
  else if (lower.includes(phrase)) total += 10;
  if (candidate.recent !== undefined) total += Math.max(0, 6 - candidate.recent);
  return total - Math.min(lower.length, 80) * 0.02;
}

export interface RankedGroup<T extends Candidate> {
  id: GroupId;
  label: string;
  items: T[];
  /** Matches left out by the group's cap. */
  more: number;
}

export interface Ranking<T extends Candidate> {
  groups: RankedGroup<T>[];
  /** Flat list in display order, for keyboard navigation. */
  flat: T[];
  /** Index selected when the list appears; -1 selects nothing, so Return does nothing. */
  initial: number;
}

/**
 * Rank candidates for a query. `ask` is the "Ask the agent" item for the current text, or null
 * when no agent can be asked; it always comes last unless the query used the ask prefix.
 */
export function rank<T extends Candidate>(candidates: T[], raw: string, ask: T | null): Ranking<T> {
  const query = parseQuery(raw);
  if (query.mode === 'ask') {
    const items = ask && query.text ? [ask] : [];
    const groups = items.length
      ? [{ id: 'ask' as const, label: GROUP_LABELS.ask, items, more: 0 }]
      : [];
    return { groups, flat: items, initial: items.length ? 0 : -1 };
  }
  const scored = new Map<GroupId, { item: T; score: number }[]>();
  for (const item of candidates) {
    if (item.group === 'ask') continue;
    let score: number;
    if (query.tokens.length) {
      score = scoreCandidate(item, query);
      if (score <= 0) continue;
    } else {
      // With nothing typed, recent objects stand in for the whole object list.
      if (item.group === 'objects') continue;
      score = 0;
    }
    const list = scored.get(item.group) ?? [];
    list.push({ item, score });
    scored.set(item.group, list);
  }
  const groups: (RankedGroup<T> & { best: number })[] = [];
  for (const [id, list] of scored) {
    if (query.tokens.length) list.sort((a, b) => b.score - a.score);
    const cap = GROUP_CAP[id];
    groups.push({
      id,
      label: GROUP_LABELS[id],
      items: list.slice(0, cap).map((x) => x.item),
      more: Math.max(0, list.length - cap),
      best: list[0]?.score ?? 0,
    });
  }
  groups.sort((a, b) =>
    query.tokens.length && b.best !== a.best
      ? b.best - a.best
      : GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id),
  );
  const result: RankedGroup<T>[] = groups.map(({ best: _best, ...g }) => g);
  if (ask && query.text) result.push({ id: 'ask', label: GROUP_LABELS.ask, items: [ask], more: 0 });
  const flat = result.flatMap((g) => g.items);
  const initial = flat.findIndex((item) => item.group !== 'ask');
  return { groups: result, flat, initial };
}

/** The next selectable index, wrapping, or -1 when the list is empty. */
export function moveSelection(current: number, length: number, delta: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}
