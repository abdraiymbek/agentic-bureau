import { ErrorCodes, Origin, StarkError } from '@stark/contracts';
import type { ProjectContext } from './context.js';
import { captureSource } from './sources.js';

const SEARCH_ENGINES: Record<string, (q: string) => string> = {
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

/** Reject local/file URLs and private-network destinations from agent research. */
function assertPublicHttpUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new StarkError(ErrorCodes.VALIDATION, `Bad URL: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new StarkError(ErrorCodes.VALIDATION, `Only http(s) research URLs allowed: ${u.protocol}`);
  }
  const host = u.hostname;
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new StarkError(ErrorCodes.CONNECTION_DENIED, `Private network destination blocked: ${host}`);
  }
}

export async function researchSearch(ctx: ProjectContext, query: string, engine?: string) {
  const build = SEARCH_ENGINES[engine ?? 'duckduckgo'] ?? SEARCH_ENGINES.duckduckgo!;
  const url = build(query);
  const res = await ctx.host.researchOpen(url);
  if (!res.ok) throw new StarkError(ErrorCodes.INTERNAL, res.error ?? 'Research browser failed');
  return { url };
}

export async function browserOpen(ctx: ProjectContext, url: string) {
  assertPublicHttpUrl(url);
  const res = await ctx.host.researchOpen(url);
  if (!res.ok) throw new StarkError(ErrorCodes.INTERNAL, res.error ?? 'Research browser failed');
  return { url };
}

export async function browserRead(ctx: ProjectContext) {
  return ctx.host.researchReadPage();
}

export async function browserFollowLink(ctx: ProjectContext, sel: { selector?: string; url?: string }) {
  if (sel.url) assertPublicHttpUrl(sel.url);
  const res = await ctx.host.researchFollowLink(sel);
  if (!res.ok) throw new StarkError(ErrorCodes.INTERNAL, res.error ?? 'follow_link failed');
  return res;
}

export async function browserScreenshot(ctx: ProjectContext) {
  return ctx.host.researchScreenshot();
}

export async function browserCapture(ctx: ProjectContext, input: { title?: string; excerpt?: string }, origin: Origin) {
  const page = await ctx.host.researchReadPage();
  if (!page.url) throw new StarkError(ErrorCodes.VALIDATION, 'No research page loaded');
  return captureSource(
    ctx,
    {
      url: page.url,
      title: input.title ?? page.title ?? page.url,
      excerpt: input.excerpt ?? page.text.slice(0, 4000),
      sourceKind: 'article',
    },
    origin,
  );
}

export async function researchReadPage(ctx: ProjectContext, url: string) {
  assertPublicHttpUrl(url);
  await ctx.host.researchOpen(url);
  return ctx.host.researchReadPage();
}
