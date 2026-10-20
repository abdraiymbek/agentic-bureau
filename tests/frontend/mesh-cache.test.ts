import { describe, expect, it, vi } from 'vitest';
import { MeshCache } from '../../apps/desktop/src/renderer/object/viewport/mesh-cache';
import type { ParsedMesh } from '../../apps/desktop/src/renderer/lib/stl-parse';

const mesh = (bytes: number): ParsedMesh => ({
  positions: new Float32Array(bytes / 4),
  indices: new Uint32Array(0),
  edges: new Float32Array(0),
  triangles: 1,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
});

describe('retained mesh memory', () => {
  it('evicts the least recently used mesh by bytes, preserving active references', async () => {
    const cache = new MeshCache(24, 8);
    const a = mesh(12);
    const b = mesh(12);
    const c = mesh(12);
    const loadA = vi.fn(async () => a);
    const loadB = vi.fn(async () => b);
    const active = await cache.get('a', loadA);
    await cache.get('b', loadB);
    await cache.get('a', loadA);
    await cache.get('c', async () => c);
    await cache.get('a', loadA);
    expect(loadA).toHaveBeenCalledTimes(1);
    await cache.get('b', loadB);
    expect(loadB).toHaveBeenCalledTimes(2);
    expect(active).toBe(a);
    expect(active.positions.byteLength).toBe(12);
  });

  it('counts every typed array and still bounds the number of small meshes', async () => {
    const cache = new MeshCache(40, 1);
    const a = mesh(12);
    a.indices = new Uint32Array(3);
    a.edges = new Float32Array(6);
    const large = vi.fn(async () => a);
    await cache.get('large', large);
    await cache.get('large', large);
    expect(large).toHaveBeenCalledTimes(2);
    const small = vi.fn(async () => mesh(4));
    await cache.get('small', small);
    await cache.get('other', async () => mesh(4));
    await cache.get('small', small);
    expect(small).toHaveBeenCalledTimes(2);
  });

  it('coalesces unfinished work even while retained entries are evicted', async () => {
    const cache = new MeshCache(12, 1);
    let finish!: (mesh: ParsedMesh) => void;
    const load = vi.fn(() => new Promise<ParsedMesh>((resolve) => (finish = resolve)));
    const first = cache.get('pending', load);
    await Promise.resolve();
    await cache.get('other', async () => mesh(12));
    expect(cache.get('pending', load)).toBe(first);
    finish(mesh(16));
    await first;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('permits retry after rejected or synchronously failed work', async () => {
    const cache = new MeshCache(24, 8);
    await expect(cache.get('a', () => Promise.reject(new Error('damaged')))).rejects.toThrow(
      'damaged',
    );
    await expect(
      cache.get('a', () => {
        throw new Error('read failed');
      }),
    ).rejects.toThrow('read failed');
    const result = mesh(12);
    await expect(cache.get('a', async () => result)).resolves.toBe(result);
  });
});
