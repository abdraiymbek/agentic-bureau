import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from './app.js';
import type { Revision } from '@bureau/contracts';

const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('revision working-file compare-and-swap', () => {
  it.each([false, true])(
    'updates controlled parent bytes while preserving external divergence=%s',
    async (externalEdit) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-materialization-revision-'));
      roots.push(root);
      const app = new CoreApp(path.join(root, 'settings'));
      apps.push(app);
      const { projectId } = (await app.dispatch(
        'project.create',
        { name: 'Mirror', path: path.join(root, 'project') },
        { kind: 'user' },
      )) as { projectId: string };
      const ctx = app.contextFor(projectId);
      const call = (op: string, payload: unknown) =>
        app.dispatch(op, payload, { kind: 'user' }, projectId);
      const rel = 'artifacts/mechanical/part.scad';
      const created = (await call('artifact.create_draft', {
        type: 'mechanical',
        title: 'Part',
        payload: { params: {}, modelUnit: 'mm' },
        files: [{ path: rel, contentBase64: Buffer.from('cube(10);').toString('base64') }],
      })) as { artifact: { id: string }; revision: Revision };
      await call('artifact.accept_draft', {
        artifactId: created.artifact.id,
        draftRevisionId: created.revision.id,
        rationale: 'baseline',
      });
      if (externalEdit) fs.writeFileSync(path.join(ctx.root, rel), 'cube(30); // external edit');
      const changed = (await call('artifact.apply_edit', {
        artifactId: created.artifact.id,
        baseRevisionId: created.revision.id,
        fileWrites: [{ path: rel, contentBase64: Buffer.from('cube(20);').toString('base64') }],
        rationale: 'controlled edit',
      })) as { revision: Revision };
      expect(
        ctx.objects.readText(changed.revision.files.find((f) => f.path === rel)!.sha256!),
      ).toBe('cube(20);');
      const conflicts = fs
        .readdirSync(path.join(ctx.root, 'artifacts/mechanical'))
        .filter((name) => name.includes('.bureau-conflict-'));
      if (externalEdit) {
        expect(fs.readFileSync(path.join(ctx.root, rel), 'utf8')).toBe(
          'cube(30); // external edit',
        );
        expect(conflicts).toHaveLength(1);
        expect(
          fs.readFileSync(path.join(ctx.root, 'artifacts/mechanical', conflicts[0]!), 'utf8'),
        ).toBe('cube(20);');
      } else {
        expect(fs.readFileSync(path.join(ctx.root, rel), 'utf8')).toBe('cube(20);');
        expect(conflicts).toEqual([]);
      }
    },
  );
});
