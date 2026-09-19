import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, Origin, SourcePayload, OmenflowError, newId } from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { createDraft } from './artifacts.js';

/**
 * Sources: captured URLs and imported files with provenance.
 * Unknown metadata stays absent; retrieval time is always recorded.
 */
export function captureSource(
  ctx: ProjectContext,
  input: {
    url?: string;
    filePath?: string;
    title: string;
    publisher?: string;
    locator?: string;
    excerpt?: string;
    sourceKind: SourcePayload['sourceKind'];
  },
  origin: Origin,
) {
  if (!input.url && !input.filePath) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Source needs a url or filePath');
  }
  let fileHash: string | undefined;
  if (input.filePath) {
    const abs = path.isAbsolute(input.filePath) ? input.filePath : ctx.resolvePath(input.filePath);
    if (!fs.existsSync(abs)) {
      throw new OmenflowError(ErrorCodes.NOT_FOUND, `Source file not found: ${input.filePath}`);
    }
    fileHash = ctx.objects.putFile(abs);
  }
  const payload: SourcePayload = {
    kind: input.url ? 'url' : 'file',
    url: input.url,
    fileHash,
    title: input.title,
    publisher: input.publisher,
    retrievedAt: new Date().toISOString(),
    locator: input.locator,
    excerpt: input.excerpt,
    sourceKind: input.sourceKind,
  };
  return createDraft(
    ctx,
    {
      type: 'source',
      title: input.title,
      payload,
      files: [],
      inputs: [],
      rationale: 'source capture',
    },
    origin,
  );
}

export function readSource(ctx: ProjectContext, sourceId: string) {
  const a = ctx.requireArtifact(sourceId);
  if (a.type !== 'source') throw new OmenflowError(ErrorCodes.VALIDATION, 'Not a source artifact');
  const rev = a.selectedRevisionId
    ? ctx.repo.getRevision(a.selectedRevisionId)
    : ctx.repo.listRevisions(a.id).at(-1);
  return { artifact: a, revision: rev, payload: rev?.payload as SourcePayload | undefined };
}
