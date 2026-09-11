import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, openProject } from './project.js';
import { resolveProjectPath, isInside } from './paths.js';
import { StarkError } from '@stark/contracts';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stark-test-'));
}

describe('project lifecycle', () => {
  it('creates the documented layout', () => {
    const dir = tmpdir();
    const h = createProject(path.join(dir, 'Rover'), 'Rover', 'inspection rover');
    expect(fs.existsSync(path.join(h.root, 'stark.project.json'))).toBe(true);
    expect(fs.existsSync(path.join(h.root, '.stark', 'state.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(h.root, 'artifacts', 'mechanical'))).toBe(true);
    expect(h.project.name).toBe('Rover');
    h.close();
  });

  it('reopens and preserves project identity', () => {
    const dir = path.join(tmpdir(), 'P');
    const h1 = createProject(dir, 'P', 'intent');
    const id = h1.project.id;
    h1.close();
    const h2 = openProject(dir);
    expect(h2.project.id).toBe(id);
    expect(h2.readOnly).toBe(false);
    h2.close();
  });

  it('refuses to create inside a non-empty foreign folder', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    expect(() => createProject(dir, 'X', '')).toThrow(StarkError);
  });

  it('object store is content-addressed and immutable', () => {
    const dir = path.join(tmpdir(), 'P');
    const h = createProject(dir, 'P', '');
    const h1 = h.objects.putText('hello');
    const h2 = h.objects.putText('hello');
    expect(h1).toBe(h2);
    expect(h.objects.readText(h1)).toBe('hello');
    h.close();
  });
});

describe('path safety', () => {
  it('rejects escapes', () => {
    const root = tmpdir();
    expect(() => resolveProjectPath(root, '../outside.txt')).toThrow(StarkError);
    expect(() => resolveProjectPath(root, '/etc/passwd')).toThrow(StarkError);
    expect(() => resolveProjectPath(root, 'a/../../b')).toThrow(StarkError);
  });
  it('resolves safe paths', () => {
    const root = tmpdir();
    const p = resolveProjectPath(root, 'artifacts/mechanical/tray.scad');
    expect(isInside(root, p)).toBe(true);
  });
});
