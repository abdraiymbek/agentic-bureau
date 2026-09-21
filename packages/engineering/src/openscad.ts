import { spawn, type ChildProcess } from 'node:child_process';
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
  private loginShellPath: Promise<string | null> | undefined;
  private readonly jobs = new Map<
    string,
    { child: ChildProcess | null; state: 'running' | 'cancelling' }
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

  /** Finder PATH lookup is lazy, asynchronous and shared by concurrent probes. */
  private viaLoginShell(): Promise<string | null> {
    return (this.loginShellPath ??= this.runCapture(
      { command: '/bin/zsh', argsPrefix: [], display: '/bin/zsh' },
      ['-lic', 'command -v openscad'],
      LOGIN_SHELL_TIMEOUT_MS,
    ).then((result) => {
      const p = result.stdout.trim().split('\n').at(-1)?.trim();
      return result.code === 0 && p && OpenScadAdapter.isExecutable(p) ? p : null;
    }));
  }

  private async viaWhich(cmd: 'which' | 'where', name: string): Promise<string | null> {
    const result = await this.runCapture(
      { command: cmd, argsPrefix: [], display: cmd },
      [name],
      LOGIN_SHELL_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;
    for (const line of result.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && OpenScadAdapter.isExecutable(p)) return p;
    }
    return null;
  }

  private async viaFlatpak(): Promise<ResolvedExe | null> {
    const flatpak = (await this.viaWhich('which', 'flatpak')) ?? '/usr/bin/flatpak';
    if (!OpenScadAdapter.isExecutable(flatpak)) return null;
    const result = await this.runCapture(
      { command: flatpak, argsPrefix: [], display: flatpak },
      ['info', 'org.openscad.OpenSCAD'],
      LOGIN_SHELL_TIMEOUT_MS,
    );
    return result.code === 0
      ? {
          command: flatpak,
          argsPrefix: ['run', 'org.openscad.OpenSCAD'],
          display: 'flatpak run org.openscad.OpenSCAD',
        }
      : null;
  }

  /** Prefer configured/standard installations; never block the core on shell startup. */
  private async discover(): Promise<ResolvedExe | null> {
    const configured = this.configuredPath();
    if (configured && OpenScadAdapter.isExecutable(configured))
      return { command: configured, argsPrefix: [], display: configured };
    const found = (p: string | null): ResolvedExe | null => {
      if (!p || !OpenScadAdapter.isExecutable(p)) return null;
      if (!configured) this.opts.onDiscovered?.(p);
      return { command: p, argsPrefix: [], display: p };
    };
    if (process.platform === 'darwin') {
      for (const p of [
        '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD',
        '/opt/homebrew/bin/openscad',
        '/usr/local/bin/openscad',
      ]) {
        const result = found(p);
        if (result) return result;
      }
      return found(await this.viaLoginShell());
    }
    const onPath = found(
      await this.viaWhich(process.platform === 'win32' ? 'where' : 'which', 'openscad'),
    );
    if (onPath) return onPath;
    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\OpenSCAD\\openscad.exe',
            path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenSCAD', 'openscad.exe'),
            'C:\\Program Files (x86)\\OpenSCAD\\openscad.exe',
          ]
        : ['/usr/bin/openscad', '/usr/local/bin/openscad', '/snap/bin/openscad'];
    for (const p of candidates) {
      const result = found(p);
      if (result) return result;
    }
    if (process.platform !== 'win32') {
      const flatpak = await this.viaFlatpak();
      if (flatpak && !configured) this.opts.onDiscovered?.(flatpak.display);
      return flatpak;
    }
    return null;
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
    const exe = await this.discover();
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
    const exe = await this.discover();
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
    // Register before discovery yields so cancellation cannot miss a pending spawn.
    const pending = {
      child: null as ChildProcess | null,
      state: 'running' as 'running' | 'cancelling',
    };
    this.jobs.set(spec.jobId, pending);
    let exe: ResolvedExe | null;
    try {
      exe = await this.discover();
    } catch (error) {
      this.jobs.delete(spec.jobId);
      return { ok: false, error: (error as Error).message };
    }
    if (pending.state === 'cancelling' || !exe) {
      this.jobs.delete(spec.jobId);
      return {
        ok: false,
        error: pending.state === 'cancelling' ? 'cancelled' : 'OpenSCAD not found',
      };
    }

    const args = [...exe.argsPrefix, '-o', spec.outPath, '--export-format', 'binstl'];
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
        this.jobs.delete(spec.jobId);
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
    if (j.child) OpenScadAdapter.killChild(j.child);
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
