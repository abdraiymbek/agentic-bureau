import type { ParsedMesh } from '../../lib/stl-parse';

/** Retained meshes have a byte budget; work already underway is always shared. */
export class MeshCache {
  private readonly ready = new Map<string, { promise: Promise<ParsedMesh>; bytes: number }>();
  private readonly pending = new Map<string, Promise<ParsedMesh>>();
  private bytes = 0;

  constructor(
    private readonly byteLimit: number,
    private readonly countLimit: number,
  ) {}

  get(key: string, load: () => Promise<ParsedMesh>): Promise<ParsedMesh> {
    const known = this.ready.get(key);
    if (known) {
      this.ready.delete(key);
      this.ready.set(key, known);
      return known.promise;
    }
    const underway = this.pending.get(key);
    if (underway) return underway;
    const promise = Promise.resolve()
      .then(load)
      .then(
        (mesh) => {
          this.pending.delete(key);
          const bytes = mesh.positions.byteLength + mesh.indices.byteLength + mesh.edges.byteLength;
          // A large mesh can stay on screen without pinning it in the background cache.
          if (bytes <= this.byteLimit && this.countLimit > 0) {
            this.ready.set(key, { promise, bytes });
            this.bytes += bytes;
            for (const [oldest, entry] of this.ready) {
              if (this.bytes <= this.byteLimit && this.ready.size <= this.countLimit) break;
              this.ready.delete(oldest);
              this.bytes -= entry.bytes;
            }
          }
          return mesh;
        },
        (error: unknown) => {
          this.pending.delete(key);
          throw error;
        },
      );
    this.pending.set(key, promise);
    return promise;
  }
}
