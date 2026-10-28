/**
 * The Files lens's model: working files of approved revisions and of the current drafts, file
 * previews with a size cap, and the issues a refused build export reports.
 */
import type { ArtifactType, ArtifactView, FileRef, Revision } from '@bureau/contracts';
import { displayedMechanicalRevision } from '../lib/mechanical-revisions';

export type FileState = 'approved' | 'draft' | 'proposed';

export interface FileRow {
  key: string;
  artifactId: string;
  title: string;
  type: ArtifactType;
  path: string;
  role: FileRef['role'];
  revisionId: string;
  seq: number;
  state: FileState;
}

function rowsOf(view: ArtifactView, revision: Revision, state: FileState): FileRow[] {
  return revision.files.map((f) => ({
    key: `${revision.id}:${f.path}`,
    artifactId: view.artifact.id,
    title: view.artifact.title,
    type: view.artifact.type,
    path: f.path,
    role: f.role,
    revisionId: revision.id,
    seq: revision.seq,
    state,
  }));
}

/** Files of every approved revision in the store. */
export function baselineFiles(views: ArtifactView[]): FileRow[] {
  return views.flatMap((v) => (v.revision ? rowsOf(v, v.revision, 'approved') : []));
}

/** Objects whose current work is not the approved revision, so their history must be read. */
export function hasDraftWork(v: ArtifactView): boolean {
  return !v.artifact.archived && (v.draftCount > 0 || !v.revision);
}

/** Identifies what a history read depends on, so unchanged objects are not read again. */
export const historyKey = (v: ArtifactView) =>
  `${v.artifact.id}:${v.artifact.selectedRevisionId ?? '-'}:${v.draftCount}:${v.pendingProposal}${v.head ? `:${v.head.id}:${v.head.reviewState}` : ''}`;

/** Files of the newest draft that builds on the approved revision (the object's latest work). */
export function draftFiles(view: ArtifactView, revisions: Revision[]): FileRow[] {
  const baselineId = view.artifact.selectedRevisionId;
  const latest = displayedMechanicalRevision(revisions, baselineId, null);
  if (!latest || latest.id === baselineId) return [];
  if (latest.reviewState !== 'draft' && latest.reviewState !== 'proposed') return [];
  return rowsOf(view, latest, latest.reviewState);
}

export const FILE_STATE_LABEL: Record<FileState, string> = {
  approved: 'Approved',
  draft: 'Draft',
  proposed: 'In review',
};

/** The file on disk: the project folder joined with the recorded project-relative path. */
export function projectFilePath(root: string, relative: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${sep}${relative.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep)}`;
}

/** The last segments of a path, so the folder's own name stays visible when space is short. */
export function shortPath(path: string, keep = 2): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join('/')}`;
}

const TEXT = /\.(md|txt|json|scad|csv|yaml|yml|py|ts|js|c|cpp|h|hpp|toml|svg|ini|cfg|log)$/i;
export const isTextPath = (path: string) => TEXT.test(path);

/** Previews stop here; the file itself is one click away. */
export const PREVIEW_LIMIT_BYTES = 256 * 1024;

export function previewText(bytes: Uint8Array): { lines: string[]; truncated: boolean } {
  const truncated = bytes.length > PREVIEW_LIMIT_BYTES;
  // A cut inside a multi-byte character decodes to a replacement mark at the very end only.
  const text = new TextDecoder().decode(truncated ? bytes.subarray(0, PREVIEW_LIMIT_BYTES) : bytes);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { lines, truncated };
}

export interface BuildIssueGroup {
  artifactId: string | null;
  title: string;
  issues: { message: string; repair: string | null }[];
}

interface IssueSource {
  artifactId?: unknown;
  title?: unknown;
  issues?: unknown;
  issueDetails?: unknown;
}

function issueList(raw: unknown): BuildIssueGroup['issues'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) =>
      typeof i === 'string'
        ? { message: i, repair: null }
        : i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string'
          ? {
              message: (i as { message: string }).message,
              repair:
                typeof (i as { repair?: unknown }).repair === 'string'
                  ? (i as { repair: string }).repair
                  : null,
            }
          : null,
    )
    .filter((i): i is BuildIssueGroup['issues'][number] => i !== null);
}

function groupsOf(items: unknown): BuildIssueGroup[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item: IssueSource) => ({
      artifactId: typeof item?.artifactId === 'string' ? item.artifactId : null,
      title: typeof item?.title === 'string' ? item.title : 'Untitled object',
      issues: issueList(item?.issueDetails ?? item?.issues),
    }))
    .filter((g) => g.issues.length > 0);
}

/**
 * The per-object issues of a refused build export, as the host reported them: `details.artifacts`
 * (each with structured issues) or a bare list of preview items. Null when the refusal has none.
 */
export function buildIssuesFromError(details: unknown): BuildIssueGroup[] | null {
  const items = Array.isArray(details)
    ? details
    : details && typeof details === 'object'
      ? (details as { artifacts?: unknown }).artifacts
      : undefined;
  const groups = groupsOf(items);
  return groups.length ? groups : null;
}

/** The same list from `build.preview`, for hosts whose refusal carries no details. */
export function buildIssuesFromPreview(preview: { items?: unknown }): BuildIssueGroup[] {
  return groupsOf(preview.items);
}
