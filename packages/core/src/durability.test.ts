import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorCodes, BureauError, PROJECT_FILE, type Origin } from '@bureau/contracts';
import { openProject } from '@bureau/storage';
import { CoreApp } from './app.js';

const user: Origin = { kind: 'user' };
const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-durability-'));
  roots.push(root);
  return root;
}

describe('app-level create/rename reservations and crash hooks', () => {
  it('shows the persisted project name in recents after rename and restart without opening it', async () => {
    const root = tmp();
    const data = path.join(root, 'appdata');
    const projectPath = path.join(fs.realpathSync(root), 'folder-name');
    const app = new CoreApp(data);
    apps.push(app);
    const created = (await app.dispatch(
      'project.create',
      { name: 'Original', path: projectPath },
      user,
    )) as { projectId: string };
    await app.dispatch('project.rename', { name: 'Renamed plate' }, user, created.projectId);
    app.closeAll();
    const restarted = new CoreApp(data);
    apps.push(restarted);
    const recent = await restarted.dispatch('app.recent_projects', {}, user);
    expect(recent).toEqual({
      projects: [projectPath],
      projectNames: { [projectPath]: 'Renamed plate' },
    });
    expect(restarted.contexts.size).toBe(0);
    fs.writeFileSync(path.join(projectPath, PROJECT_FILE), '{damaged');
    expect(await restarted.dispatch('app.recent_projects', {}, user)).toEqual({
      projects: [projectPath],
      projectNames: {},
    });
  });

  it('replays a completed create and recovers after death between domain and register', async () => {
    const root = tmp();
    const app = new CoreApp(path.join(root, 'appdata'));
    apps.push(app);
    const payload = { name: 'Plate', path: path.join(root, 'project'), intent: '' };
    app.durabilityHooks.push((b) => {
      if (b === 'project.create.after-domain') throw new Error('injected death');
    });
    await expect(
      app.dispatch('project.create', payload, user, undefined, 'create-1'),
    ).rejects.toThrow('injected death');
    expect(fs.existsSync(path.join(payload.path, PROJECT_FILE))).toBe(true);
    app.durabilityHooks.length = 0;
    const recovered = (await app.dispatch(
      'project.create',
      payload,
      user,
      undefined,
      'create-1',
    )) as { projectId: string; recovered?: boolean };
    expect(recovered.projectId).toBeTruthy();
    const replay = (await app.dispatch('project.create', payload, user, undefined, 'create-1')) as {
      projectId: string;
      idempotent?: boolean;
    };
    expect(replay.projectId).toBe(recovered.projectId);
    expect(replay.idempotent).toBe(true);
  });

  it('finishes marker and SQLite rename from one journal after death between the writes', async () => {
    const root = tmp();
    const app = new CoreApp(path.join(root, 'appdata'));
    apps.push(app);
    const created = (await app.dispatch(
      'project.create',
      { name: 'Old', path: path.join(root, 'project') },
      user,
    )) as { projectId: string };
    const projectPath = app.contextFor(created.projectId).root;
    app.durabilityHooks.push((b) => {
      if (b === 'project.rename.after-db') throw new Error('injected death');
    });
    await expect(
      app.dispatch('project.rename', { name: 'New' }, user, created.projectId, 'rename-1'),
    ).rejects.toThrow('injected death');
    const marker = JSON.parse(fs.readFileSync(path.join(projectPath, PROJECT_FILE), 'utf8')) as {
      name: string;
    };
    expect(marker.name).toBe('Old');
    expect(app.contextFor(created.projectId).repo.getProject()?.name).toBe('New');
    expect(fs.existsSync(path.join(projectPath, '.bureau/recovery/rename.json'))).toBe(true);
    app.closeProject(created.projectId);
    const reopened = openProject(projectPath);
    expect(reopened.project.name).toBe('New');
    expect(JSON.parse(fs.readFileSync(path.join(projectPath, PROJECT_FILE), 'utf8')).name).toBe(
      'New',
    );
    expect(fs.existsSync(path.join(projectPath, '.bureau/recovery/rename.json'))).toBe(false);
    reopened.close();
  });
});

describe('async domain commit vs result reservation', () => {
  it('replays a journaled result after death before SQLite idempotency', async () => {
    const root = tmp();
    const app = new CoreApp(path.join(root, 'appdata'));
    apps.push(app);
    const created = (await app.dispatch(
      'project.create',
      { name: 'Calc', path: path.join(root, 'project') },
      user,
    )) as { projectId: string };
    const ctx = app.contextFor(created.projectId);
    let executions = 0;
    ctx.tools.calc = {
      templates: () => [],
      evaluate: async () => {
        executions++;
        return { value: 4, unit: 'kg' };
      },
    };
    const payload = {
      expression: 'x',
      inputs: [{ name: 'x', quantity: { value: 4, unit: 'kg' }, literal: true }],
      submitForReview: false,
    };
    app.durabilityHooks.push((b) => {
      if (b === 'dispatch.after-result-journal') throw new Error('injected death');
    });
    await expect(
      app.dispatch('calculation.run', payload, user, created.projectId, 'calc-1'),
    ).rejects.toThrow('injected death');
    expect(executions).toBe(1);
    expect(ctx.repo.listArtifacts()).toHaveLength(1);
    app.durabilityHooks.length = 0;
    const replay = (await app.dispatch(
      'calculation.run',
      payload,
      user,
      created.projectId,
      'calc-1',
    )) as { artifactId: string; recovered?: boolean; experimental?: boolean };
    expect(executions).toBe(1);
    expect(replay.recovered).toBe(true);
    expect(replay.experimental).toBe(true);
    expect(ctx.repo.listArtifacts()).toHaveLength(1);
  });
});

describe('import reservation recovery', () => {
  it('reopens a published import after death between expand and register', async () => {
    const root = tmp();
    const app = new CoreApp(path.join(root, 'appdata'));
    apps.push(app);
    const created = (await app.dispatch(
      'project.create',
      { name: 'Src', path: path.join(root, 'src') },
      user,
    )) as { projectId: string };
    const archive = path.join(root, 'src.zip');
    await app.dispatch('project.export_archive', { destPath: archive }, user, created.projectId);
    app.closeProject(created.projectId);
    const dest = path.join(root, 'imported');
    const payload = { archivePath: archive, destDir: dest, newIdentity: false };
    app.durabilityHooks.push((b) => {
      if (b === 'project.import.after-domain') throw new Error('injected death');
    });
    await expect(
      app.dispatch('project.import_archive', payload, user, undefined, 'imp-1'),
    ).rejects.toThrow('injected death');
    expect(fs.existsSync(path.join(dest, PROJECT_FILE))).toBe(true);
    app.durabilityHooks.length = 0;
    const recovered = (await app.dispatch(
      'project.import_archive',
      payload,
      user,
      undefined,
      'imp-1',
    )) as { projectId: string; recovered?: boolean };
    expect(recovered.projectId).toBeTruthy();
    expect(recovered.recovered).toBe(true);
  });
});

describe('calculation cancellation', () => {
  it('does not commit a cancelled calculation', async () => {
    const root = tmp();
    const app = new CoreApp(path.join(root, 'appdata'));
    apps.push(app);
    const created = (await app.dispatch(
      'project.create',
      { name: 'Calc', path: path.join(root, 'project') },
      user,
    )) as { projectId: string };
    const ctx = app.contextFor(created.projectId);
    ctx.tools.calc = {
      templates: () => [],
      evaluate: (_e, _i, _u, opts) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(new BureauError(ErrorCodes.CANCELLED, 'cancelled'));
          if (opts?.signal?.aborted) return fail();
          opts?.signal?.addEventListener('abort', fail);
        }),
    };
    const pending = app.dispatch(
      'calculation.run',
      {
        expression: 'x',
        inputs: [{ name: 'x', quantity: { value: 1, unit: 'kg' }, literal: true }],
        submitForReview: false,
      },
      user,
      created.projectId,
    );
    await viWaitForJob(ctx);
    const job = ctx.repo.listJobs(10).find((j) => j.kind === 'calculation')!;
    ctx.cancelJob(job.id);
    await expect(pending).rejects.toThrow();
    expect(ctx.repo.listArtifacts()).toHaveLength(0);
    expect(ctx.repo.getJob(job.id)?.status).toBe('cancelled');
  });
});

async function viWaitForJob(ctx: { repo: { listJobs: (n: number) => { kind: string }[] } }) {
  for (let i = 0; i < 50; i++) {
    if (ctx.repo.listJobs(10).some((j) => j.kind === 'calculation')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('calculation job did not start');
}
