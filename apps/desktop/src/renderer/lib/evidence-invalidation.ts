import type { ProjectEvent } from '@omenflow/contracts';

/** Evidence can change without creating a revision or changing a proposal's list entry. */
export function evidenceArtifactIds(event: ProjectEvent): string[] {
  const data = event.data as Record<string, unknown> | null;
  if (!data) return [];
  if (
    event.type === 'job.updated' &&
    (data.kind !== 'cad_check' || data.status === 'queued' || data.status === 'running')
  )
    return [];
  if (event.type !== 'job.updated' && event.type !== 'cad.scope.accepted') return [];
  return typeof data.artifactId === 'string' ? [data.artifactId] : [];
}
