import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterStatus, SessionInfo } from '@bureau/contracts';
import type { ProjectContext } from '@bureau/core';
import { GUIDE_MARKER, agentGuide } from './guide.js';

/** Per-adapter persisted config (CoreApp settings.adapters[adapterId]). */
export interface AdapterConfig {
  executablePath?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Custom adapter only: how the tool reaches the bridge. */
  toolAccess?: 'mcp' | 'cli' | 'none';
  /** Populated by ConnectionManager.test(). */
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastError?: string | null;
}

export interface AdapterManifest {
  id: string;
  version: string;
  testedVersions: string[];
  platforms: string[];
}

export interface LaunchRequest {
  ctx: ProjectContext;
  sessionId: string;
  /** Effective config for this launch: persisted config + start() overrides. */
  config: AdapterConfig;
  /** Per-session bridge credentials (BUREAU_BRIDGE_*). */
  bridgeEnv: Record<string, string>;
  /** Absolute path of the generated bootstrap brief (`.bureau/work/<session>/bootstrap.md`). */
  bootstrapPath: string;
}

export interface LaunchSpec {
  path: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Agent adapter contract (docs/agent-adapters.md): executable discovery,
 * version check, launch args, project-scoped tool config, bootstrap context.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly manifest: AdapterManifest;
  readonly capabilities: { mcp: boolean; cli: boolean; resume: boolean };
  readonly installHint: string | null;
  discover(): Promise<AdapterStatus>;
  launchSpec(req: LaunchRequest): Promise<LaunchSpec>;
  /** Prepare project-scoped config; returns a restore fn (may be a no-op). */
  prepareProjectConfig?(projectDir: string): Promise<() => void>;
  resumeArgs?(session: SessionInfo): string[] | null;
}

/** Reads this adapter's persisted config (fresh on every call). */
export type ConfigGetter = () => AdapterConfig;

/* ------------------------------------------------------------------ */
/* Executable discovery helpers                                        */
/* ------------------------------------------------------------------ */

let cachedLoginPath: string | null | undefined;

/**
 * PATH of a login shell — GUI apps on macOS inherit a stub PATH that lacks
 * Homebrew/npm-global dirs. Cached once per process; null on failure.
 */
export function loginShellPath(): string | null {
  if (cachedLoginPath !== undefined) return cachedLoginPath;
  cachedLoginPath = null;
  if (process.platform === 'win32') return cachedLoginPath;
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  if (!fs.existsSync(shell)) return cachedLoginPath;
  try {
    const out = execFileSync(shell, ['-lic', 'echo -n $PATH'], {
      timeout: 4_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.includes('/') || out.includes(':')) cachedLoginPath = out;
  } catch {
    /* no login shell PATH */
  }
  return cachedLoginPath;
}

/** Directories searched for executables: login-shell PATH first, then env PATH. */
export function searchPathDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const source of [loginShellPath(), process.env.PATH]) {
    for (const dir of (source ?? '').split(path.delimiter)) {
      const d = dir.trim();
      if (d && !seen.has(d)) {
        seen.add(d);
        dirs.push(d);
      }
    }
  }
  return dirs;
}

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate `name` on the (login-shell augmented) PATH. */
export function which(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchPathDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Run `<exe> --version`-ish; returns a version string or null. */
export function probeVersion(
  exe: string,
  args: string[] = ['--version'],
  timeoutMs = 5_000,
): string | null {
  try {
    const out = execFileSync(exe, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const text = out.trim();
    const semver = text.match(/\d+\.\d+(\.\d+)?[-\w.]*/);
    return semver ? semver[0] : text.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** testedVersions entries are prefixes like '0.5' or exact '1.2.3'. */
export function recognizedVersion(version: string | null, testedVersions: string[]): boolean {
  if (!version) return false;
  return testedVersions.some(
    (t) =>
      version === t || version.startsWith(t.endsWith('.') ? t : `${t}.`) || version.startsWith(t),
  );
}

/* ------------------------------------------------------------------ */
/* Shared status + resolution                                          */
/* ------------------------------------------------------------------ */

export interface ResolvedExe {
  path: string | null;
  /** True when found via PATH lookup rather than an absolute configured path. */
  fromPath: boolean;
}

export function resolveExecutable(configured: string | undefined, name: string): ResolvedExe {
  if (configured) return { path: configured, fromPath: false };
  const found = which(name);
  return { path: found, fromPath: !!found };
}

export function baseStatus(adapter: AgentAdapter, cfg: AdapterConfig): AdapterStatus {
  return {
    adapterId: adapter.id,
    label: adapter.label,
    available: false,
    executablePath: null,
    version: null,
    testedVersionRange: adapter.manifest.testedVersions.join(' | ') || null,
    recognizedVersion: false,
    capabilities: { ...adapter.capabilities },
    lastTestAt: cfg.lastTestAt ?? null,
    lastTestOk: cfg.lastTestOk ?? null,
    lastError: null,
    installHint: adapter.installHint,
  };
}

/* ------------------------------------------------------------------ */
/* Bootstrap brief                                                     */
/* ------------------------------------------------------------------ */

const BRIEF_ARTIFACT_CAP = 50;

/**
 * Markdown bootstrap context delivered to the agent at session start.
 * Written to `.bureau/work/<sessionId>/bootstrap.md`; returns the path.
 */
export function writeBootstrapBrief(ctx: ProjectContext, sessionId: string): string {
  const project = ctx.handle.project;
  const artifacts = ctx.repo.listArtifacts();
  const requirements = artifacts
    .filter((a) => a.type === 'requirement' && a.selectedRevisionId)
    .map((a) => `- ${a.title} (\`${a.id}\`)`);
  const assumptions = artifacts
    .filter((a) => a.type === 'assumption')
    .map((a) => {
      const rev = a.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : null;
      const statement = (rev?.payload as { statement?: string } | undefined)?.statement ?? '';
      return `- ${a.title}${statement ? ` — ${statement}` : ''} (\`${a.id}\`)`;
    });
  const pending = ctx.repo.listProposals('pending').length;
  const stale = ctx.repo.allStale().length;
  const bounded = artifacts.slice(0, BRIEF_ARTIFACT_CAP);

  const lines = [
    `# Bureau session bootstrap`,
    ``,
    `**Project:** ${project.name} (\`${project.id}\`)`,
    `**Session:** \`${sessionId}\``,
    ``,
    `## Intent`,
    ``,
    project.intent?.trim() || '_No intent recorded yet._',
    ``,
    `## Accepted requirements`,
    ``,
    ...(requirements.length ? requirements : ['_None yet._']),
    ``,
    `## Open assumptions`,
    ``,
    ...(assumptions.length ? assumptions : ['_None._']),
    ``,
    `## Work queues`,
    ``,
    `- Pending proposals: ${pending}`,
    `- Stale artifacts: ${stale}`,
    ``,
    `## Artifacts (id — type — title)`,
    ``,
    ...(bounded.length
      ? bounded.map((a) => `- \`${a.id}\` — ${a.type} — ${a.title}`)
      : ['_Empty project._']),
    artifacts.length > bounded.length ? `- …and ${artifacts.length - bounded.length} more` : '',
    ``,
    `## Tools`,
    ``,
    'Prefer the bureau MCP tools (tool names use `_` for `.`, e.g. `cad.check` →',
    '`cad_check`). Without MCP: session credentials are in env (`BUREAU_BRIDGE_SOCK`,',
    '`BUREAU_BRIDGE_TOKEN`, `BUREAU_PROJECT_ID`, `BUREAU_SESSION_ID`) and the `bureau`',
    'helper reads them:',
    ``,
    '- `bureau call <op> --help` — purpose and input JSON schema of one op.',
    '- `bureau call <op> --input <file|->` — call one op; payload is JSON.',
    '- `bureau mcp` — MCP stdio server exposing the agent tool set.',
    ``,
    `## Rules`,
    ``,
    `- Accepted engineering changes go through **proposals** (`,
    '  `bureau call proposal.submit --input changes.json`); drafts are free.',
    `- Direct baseline edits return APPROVAL_REQUIRED — propose instead.`,
    `- Use \`project.summary\` for a fresh bounded summary any time.`,
    ``,
  ].filter((l) => l !== '');

  const dir = ctx.handle.workDir(sessionId);
  const file = path.join(dir, 'bootstrap.md');
  fs.writeFileSync(file, [...lines, '', agentGuide()].join('\n'), 'utf8');
  writeAgentGuide(ctx.root);
  return file;
}

/**
 * Keep `<project>/AGENTS.md` current with the Bureau agent guide. Agent
 * CLIs (Codex and others) read this file from the working directory on their
 * own — it is the one channel that reliably reaches the model without the
 * user having to paste anything. A user-authored AGENTS.md (no marker) is
 * never overwritten; the guide is appended below it instead.
 */
export function writeAgentGuide(projectRoot: string): string {
  const file = path.join(projectRoot, 'AGENTS.md');
  const guide = agentGuide();
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    /* absent */
  }
  if (!existing) {
    fs.writeFileSync(file, guide, 'utf8');
  } else if (existing.includes(GUIDE_MARKER)) {
    const idx = existing.indexOf(GUIDE_MARKER);
    const head = existing.slice(0, idx).trimEnd();
    const next = head ? `${head}\n\n${guide}` : guide;
    if (next !== existing) fs.writeFileSync(file, next, 'utf8');
  } else {
    fs.writeFileSync(file, `${existing.trimEnd()}\n\n${guide}`, 'utf8');
  }
  return file;
}
