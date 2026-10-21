import type { ArtifactView, ChatPart, Revision } from '@omenflow/contracts';
import { cmd } from '../api';

/**
 * Resolve a temporary card using only reads, as the host resolves a recorded one: the revision
 * pinned and the title added. Never bypass the host's storage write gate.
 */
export async function resolveInspection(
  projectId: string,
  part: ChatPart,
): Promise<{ part: ChatPart & { title?: string }; title: string }> {
  if (part.kind === 'artifact') {
    const response = await cmd<{ view: ArtifactView; revision: Revision | null }>(
      'artifact.read',
      { artifactId: part.artifactId, revisionId: part.revisionId, detail: 'full' },
      { projectId },
    );
    const revisionId = part.revisionId ?? response.view.head?.id ?? response.revision?.id;
    if (!revisionId) throw new Error('This artifact has no recorded revision to inspect.');
    const revision =
      response.revision?.id === revisionId
        ? response.revision
        : (
            await cmd<{ revision: Revision | null }>(
              'artifact.read',
              { artifactId: part.artifactId, revisionId, detail: 'full' },
              { projectId },
            )
          ).revision;
    if (revision?.id !== revisionId || revision.artifactId !== part.artifactId)
      throw new Error('The requested revision does not belong to this artifact.');
    return {
      part: {
        kind: 'artifact',
        artifactId: part.artifactId,
        revisionId,
        title: response.view.artifact.title,
      },
      title: response.view.artifact.title,
    };
  }
  if (part.kind === 'review') {
    const response = await cmd<{ proposal: { id: string; reason: string } }>(
      'proposal.read',
      { proposalId: part.proposalId },
      { projectId },
    );
    if (response.proposal.id !== part.proposalId)
      throw new Error('The requested proposal could not be read.');
    return { part, title: response.proposal.reason || 'Proposal inspection' };
  }
  throw new Error('Read-only inspection supports recorded artifacts and proposals.');
}
