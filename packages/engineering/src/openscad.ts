import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CadAdapter,
  CadRenderResult,
  CadRenderSpec,
  StlInspect,
  ToolProbeResult,
} from '@omenflow/core';

/** A resolved executable: command plus fixed leading args (e.g. flatpak run). */
interface ResolvedExe {
  command: string;
  argsPrefix: string[];
  /** Human-readable form for probe results / job records. */
  display: string;
}

export interface OpenScadOptions {
  /** User-configured executable path (highest priority). */
  preferredPath?: string;
  /** Lazy getter for a user-configured path, e.g. reads live app settings. */
  settingsGet?: () => string | undefined;
  /** Called when discovery resolves a path that was not user-configured. */
  onDiscovered?: (path: string) => void;
}

const VERSION_TIMEOUT_MS = 10_000;
const PROBE_RENDER_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/**
 * Real OpenSCAD adapter: discovers the binary per-platform, probes it with an
 * actual cube render, validates sources via CSG export, and runs render jobs
 * as tracked child processes (cancellable, timed, streamed logs).
 */
export class OpenScadAdapter implements CadAdapter {
  readonly toolId = 'openscad';

  private readonly opts: OpenScadOptions;
  /** Lazily cached login-shell PATH lookup (Finder-launched apps lack PATH). */
  private loginShellPath: string | null | undefined;
  private readonly jobs = new Map<
    string,
    { child: ChildProcess; state: 'running' | 'cancelling' }
  >();

  constructor(opts?: OpenScadOptions) {
    this.opts = opts ?? {};
  }

  /* --------------------------- discovery ------------------------------- */

  private configuredPath(): string | undefined {
    return this.opts.preferredPath ?? this.opts.settingsGet?.();
  }

  private static isExecutable(p: string): boolean {
    try {
      if (!fs.existsSync(p)) return false;
      // X_OK is a no-op on Windows but correct on posix.
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Login-shell `command -v openscad` — macOS Finder PATH differs. Cached once. */
  private viaLoginShell(): string | null {
    if (this.loginShellPath !== undefined) return this.loginShellPath;
    this.loginShellPath = null;
    try {
      const out = execFileSync('/bin/zsh', ['-lic', 'command -v openscad'], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const p = out.trim().split('\n').at(-1)?.trim();
      if (p && OpenScadAdapter.isExecutable(p)) this.loginShellPath = p;
    } catch {
      /* no login-shell openscad */
    }
    return this.loginShellPath;
  }

  private viaWhich(cmd: 'which' | 'where', name: string): string | null {
    try {
      const out = execFileSync(cmd, [name], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(/\r?\n/)) {
        const p = line.trim();
        if (p && OpenScadAdapter.isExecutable(p)) return p;
      }
    } catch {
      /* not on PATH */
    }
    return null;
  }

  /** Flatpak install: needs `flatpak run` prefix instead of a bare binary. */
  private viaFlatpak(): ResolvedExe | null {
    const flatpak = this.viaWhich('which', 'flatpak') ?? '/usr/bin/flatpak';
    if (!OpenScadAdapter.isExecutable(flatpak)) return null;
    try {
      execFileSync(flatpak, ['info', 'org.openscad.OpenSCAD'], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return {
        command: flatpak,
        argsPrefix: ['run', 'org.openscad.OpenSCAD'],
        display: 'flatpak run org.openscad.OpenSCAD',
      };
    } catch {
      return null;
    }
  }

  /** Resolve the executable. Re-scans each call; only the login-shell lookup is cached. */
  private discover(): ResolvedExe | null {
    const configured = this.configuredPath();
    if (configured && OpenScadAdapter.isExecutable(configured)) {
      return { command: configured, argsPrefix: [], display: configured };
    }

    const candidates: (ResolvedExe | null)[] = [];
    if (process.platform === 'darwin') {
      for (const p of [
        '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD',
        '/opt/homebrew/bin/openscad',
        '/usr/local/bin/openscad',
        this.viaLoginShell() ?? '',
      ]) {
        candidates.push(p ? { command: p, argsPrefix: [], display: p } : null);
      }
    } else if (process.platform === 'win32') {
      candidates.push(
        this.pathResult(this.viaWhich('where', 'openscad')),
        this.pathResult('C:\\Program Files\\OpenSCAD\\openscad.exe'),
        this.pathResult(
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenSCAD', 'openscad.exe'),
        ),
        this.pathResult('C:\\Program Files (x86)\\OpenSCAD\\openscad.exe'),
      );
    } else {
      candidates.push(
        this.pathResult(this.viaWhich('which', 'openscad')),
        this.pathResult('/usr/bin/openscad'),
        this.pathResult('/usr/local/bin/openscad'),
        this.pathResult('/snap/bin/openscad'),
        this.viaFlatpak(),
      );
    }

    for (const c of candidates) {
      if (c && OpenScadAdapter.isExecutable(c.command)) {
        if (!configured) this.opts.onDiscovered?.(c.display);
        return c;
      }
    }
    return null;
  }

  private pathResult(p: string | null): ResolvedExe | null {
    return p ? { command: p, argsPrefix: [], display: p } : null;
  }

  /* --------------------------- process helpers ------------------------- */

  private runCapture(
    exe: ResolvedExe,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(exe.command, [...exe.argsPrefix, ...args], {
          shell: false,
          windowsHide: true,
        });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: '', error: (e as Error).message });
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (r: {
        code: number | null;
        stdout: string;
        stderr: string;
        error?: string;
      }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        OpenScadAdapter.killChild(child);
        finish({ code: null, stdout, stderr, error: 'timeout' });
      }, timeoutMs);
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', (e) => finish({ code: null, stdout, stderr, error: e.message }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
    });
  }

  private static killChild(child: ChildProcess): void {
    try {
      if (process.platform === 'win32') {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
      } else {
        child.kill('SIGTERM');
        const ref = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS);
        ref.unref();
      }
    } catch {
      /* already gone */
    }
  }

  /* --------------------------- CadAdapter ------------------------------ */

  async probe(): Promise<ToolProbeResult> {
    const exe = this.discover();
    if (!exe) {
      return {
        available: false,
        executablePath: null,
        version: null,
        error: 'OpenSCAD not found',
      };
    }
    const ver = await this.runCapture(exe, ['--version'], VERSION_TIMEOUT_MS);
    if (ver.error) {
      return { available: false, executablePath: exe.display, version: null, error: ver.error };
    }
    const m = /OpenSCAD version\s+([0-9][\w.-]*)/i.exec(`${ver.stdout}\n${ver.stderr}`);
    if (!m) {
      return {
        available: false,
        executablePath: exe.display,
        version: null,
        error: `Unrecognized --version output: ${(ver.stdout + ver.stderr).trim().slice(0, 200)}`,
      };
    }
    const version = m[1]!;

    // Real probe render: cube(1) → STL must be nonempty.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-openscad-probe-'));
    try {
      const scad = path.join(dir, 'probe.scad');
      const stl = path.join(dir, 'probe.stl');
      fs.writeFileSync(scad, 'cube(1);\n');
      const r = await this.runCapture(exe, ['-o', stl, scad], PROBE_RENDER_TIMEOUT_MS);
      const ok = r.code === 0 && fs.existsSync(stl) && fs.statSync(stl).size > 0;
      if (!ok) {
        return {
          available: false,
          executablePath: exe.display,
          version,
          error:
            r.error ?? `probe render failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`,
        };
      }
      return { available: true, executablePath: exe.display, version };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `openscad -o <tmp>.csg <src>` — CSG export validates parsing quickly. */
  async validateSource(scadPath: string): Promise<{ ok: boolean; errors: string[] }> {
    const exe = this.discover();
    if (!exe) return { ok: false, errors: ['OpenSCAD not found'] };
    const csg = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-scad-check-')),
      'out.csg',
    );
    try {
      const r = await this.runCapture(exe, ['-o', csg, scadPath], VALIDATE_TIMEOUT_MS);
      const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const errorLines = lines.filter((l) => l.includes('ERROR:'));
      const ok = r.code === 0 && !r.error && errorLines.length === 0;
      return { ok, errors: errorLines.length > 0 ? errorLines : ok ? [] : lines };
    } finally {
      fs.rmSync(path.dirname(csg), { recursive: true, force: true });
    }
  }

  async render(spec: CadRenderSpec, onLog: (chunk: string) => void): Promise<CadRenderResult> {
    const exe = this.discover();
    if (!exe) return { ok: false, error: 'OpenSCAD not found' };

    const args = [...exe.argsPrefix, '-o', spec.outPath];
    for (const [k, v] of Object.entries(spec.params ?? {})) {
      const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
      args.push('-D', `${k}=${val}`);
    }
    args.push(spec.scadPath);

    return new Promise<CadRenderResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(exe.command, args, {
          cwd: spec.workDir,
          shell: false,
          windowsHide: true,
        });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
        return;
      }
      this.jobs.set(spec.jobId, { child, state: 'running' });
      let timedOut = false;
      let done = false;
      const finish = (r: CadRenderResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.jobs.delete(spec.jobId);
        resolve(r);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        OpenScadAdapter.killChild(child);
      }, spec.timeoutMs);
      timer.unref();

      child.stdout?.on('data', (d) => onLog(String(d)));
      child.stderr?.on('data', (d) => onLog(String(d)));
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('close', (code) => {
        if (timedOut) return finish({ ok: false, error: 'timeout' });
        const cancelled = this.jobs.get(spec.jobId)?.state === 'cancelling';
        if (cancelled) return finish({ ok: false, error: 'cancelled' });
        const exists = fs.existsSync(spec.outPath) && fs.statSync(spec.outPath).size > 0;
        finish(
          code === 0 && exists
            ? { ok: true }
            : { ok: false, error: `openscad exited ${code}${exists ? '' : ' (no output)'}` },
        );
      });
    });
  }

  cancel(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.state = 'cancelling';
    OpenScadAdapter.killChild(j.child);
  }

  /* --------------------------- STL inspection --------------------------- */

  inspectStl(buf: Buffer): StlInspect {
    const bytes = buf.byteLength;
    // Binary: 80-byte header + u32 triangle count + 50 bytes per triangle.
    if (bytes >= 84) {
      const count = buf.readUInt32LE(80);
      if (84 + count * 50 === bytes) return OpenScadAdapter.parseBinaryStl(buf, count);
    }
    const text = buf.toString('utf8');
    if (/^\s*solid/i.test(text) && /\bfacet\b/i.test(text) && /\bvertex\b/i.test(text)) {
      return OpenScadAdapter.parseAsciiStl(text, bytes);
    }
    // Unrecognized — report implausible rather than throwing.
    return {
      triangles: 0,
      bytes,
      format: /^\s*solid/i.test(text) ? 'ascii' : 'binary',
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      plausible: false,
    };
  }

  private static parseBinaryStl(buf: Buffer, count: number): StlInspect {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const base = 84 + i * 50 + 12; // skip normal
      for (let v = 0; v < 3; v++) {
        for (let axis = 0; axis < 3; axis++) {
          const f = buf.readFloatLE(base + (v * 3 + axis) * 4);
          if (f < min[axis]!) min[axis] = f;
          if (f > max[axis]!) max[axis] = f;
        }
      }
    }
    const finite = [...min, ...max].every(Number.isFinite);
    return {
      triangles: count,
      bytes: buf.byteLength,
      format: 'binary',
      bounds: { min: finite ? min : [0, 0, 0], max: finite ? max : [0, 0, 0] },
      plausible: finite && count > 0,
    };
  }

  private static parseAsciiStl(text: string, bytes: number): StlInspect {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const vertexRe = /vertex\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)/g;
    let vertexCount = 0;
    let m: RegExpExecArray | null;
    while ((m = vertexRe.exec(text)) !== null) {
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      vertexCount++;
      for (let axis = 0; axis < 3; axis++) {
        const f = v[axis]!;
        if (f < min[axis]!) min[axis] = f;
        if (f > max[axis]!) max[axis] = f;
      }
    }
    const triangles = (text.match(/facet\s+normal/g) ?? []).length;
    const finite = [...min, ...max].every(Number.isFinite);
    return {
      triangles,
      bytes,
      format: 'ascii',
      bounds: { min: finite ? min : [0, 0, 0], max: finite ? max : [0, 0, 0] },
      plausible: finite && triangles > 0 && vertexCount === triangles * 3,
    };
  }
}
