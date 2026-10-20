import type { ArtifactType } from '@omenflow/contracts';

export interface ContentHit {
  artifactId: string;
  revisionId: string;
  title: string;
  snippet: string;
  type: ArtifactType;
  reviewState: string | null;
}

export interface ContentResults {
  results: ContentHit[];
  matched?: 'all_terms' | 'any_term' | 'substring' | 'none';
}

/** The search host uses literal brackets to mark matches; render the excerpt as plain text. */
export function contentExcerpt(snippet: string): string {
  return snippet.replace(/\[\[|\]\]/g, '');
}
