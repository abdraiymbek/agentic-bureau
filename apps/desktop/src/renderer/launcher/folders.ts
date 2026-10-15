/**
 * Where a new project goes. The person picks a location; the project gets its own folder there,
 * named after the project, so any folder (Documents, a code directory) works as a location.
 */

/** A folder name for a project name: path separators and reserved characters are replaced. */
export function folderNameFor(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Untitled project';
}

const separatorOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');

export function joinPath(parent: string, child: string): string {
  const trimmed = parent.length > 1 ? parent.replace(/[\\/]+$/, '') : parent;
  const sep = separatorOf(parent);
  return trimmed.endsWith(sep) ? `${trimmed}${child}` : `${trimmed}${sep}${child}`;
}

/** The containing folder; null at a filesystem root. */
export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at < 0) return null;
  if (at === 0) return trimmed.length > 1 ? trimmed.slice(0, 1) : null;
  return trimmed.slice(0, at);
}

/** A sensible default location: where the most recent project lives. */
export function defaultLocation(recentPaths: string[]): string | null {
  return recentPaths.length ? parentOf(recentPaths[0]!) : null;
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

export type Placement =
  | { kind: 'create'; path: string; folder: string }
  | { kind: 'exists'; path: string; name: string | null }
  | { kind: 'inside-project'; project: string; name: string | null };

/**
 * What creating `folder` in `location` would do, judged from the projects this app knows:
 * the target may already be a project (open it instead), or the location may itself be one.
 */
export function placement(
  location: string,
  folder: string,
  known: { path: string; name: string | null }[],
): Placement {
  const path = joinPath(location, folder);
  const existing = known.find((p) => samePath(p.path, path));
  if (existing) return { kind: 'exists', path: existing.path, name: existing.name };
  const host = known.find((p) => samePath(p.path, location));
  if (host) return { kind: 'inside-project', project: host.path, name: host.name };
  return { kind: 'create', path, folder };
}

/** "Rover 2", "Rover 3", … for a folder that is taken by something that is not a project. */
export function nextFolderName(folder: string): string {
  const m = /^(.*\S) (\d+)$/.exec(folder);
  return m ? `${m[1]} ${Number(m[2]) + 1}` : `${folder} 2`;
}

export type CreateRefusal = 'project-exists' | 'folder-not-empty' | null;

/** The two refusals of `project.create` the launcher can resolve on the person's behalf. */
export function createRefusal(message: string): CreateRefusal {
  if (/^Project already exists\b/.test(message)) return 'project-exists';
  if (/^Folder is not empty\b/.test(message)) return 'folder-not-empty';
  return null;
}

export interface RecentProject {
  path: string;
  name: string | null;
  /** When the host recorded the last opening; null when it does not record it. */
  lastOpenedAt: string | null;
  /** False when the host reports the folder gone; hosts that list only existing folders say true. */
  exists: boolean;
}

/**
 * Reads `app.recent_projects`. Hosts that record openings return `entries`; earlier hosts return
 * `projects` (folders that still exist) with `projectNames`.
 */
export function readRecents(result: unknown): RecentProject[] {
  const r = (result ?? {}) as {
    entries?: unknown;
    projects?: unknown;
    projectNames?: Record<string, unknown>;
  };
  if (Array.isArray(r.entries))
    return r.entries
      .filter(
        (e): e is { path: string } =>
          !!e && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string',
      )
      .map((e) => {
        const x = e as { path: string; name?: unknown; lastOpenedAt?: unknown; exists?: unknown };
        return {
          path: x.path,
          name: typeof x.name === 'string' && x.name.trim() ? x.name : null,
          lastOpenedAt: typeof x.lastOpenedAt === 'string' ? x.lastOpenedAt : null,
          exists: x.exists !== false,
        };
      });
  const names = r.projectNames ?? {};
  return (Array.isArray(r.projects) ? r.projects : [])
    .filter((p): p is string => typeof p === 'string')
    .map((path) => ({
      path,
      name:
        typeof names[path] === 'string' && (names[path] as string).trim()
          ? (names[path] as string)
          : null,
      lastOpenedAt: null,
      exists: true,
    }));
}

/** The folder's own name, for projects whose marker carries no name. */
export function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}
