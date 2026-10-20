/**
 * Parsed meshes by content. Parsing happens once per distinct file, in a worker, and the
 * retained results let switching views, overlays or revisions reuse work within a byte budget.
 */
import { decodeBase64, parseStl, type ParsedMesh } from '../../lib/stl-parse';
import type { ParseReply, ParseRequest } from './stl.worker';
import { MeshCache } from './mesh-cache';

export type MeshSource = { bytes: ArrayBuffer } | { base64: string };

const byKey = new MeshCache(64 * 1024 * 1024, 8);
const byBuffer = new WeakMap<ArrayBuffer, Promise<ParsedMesh>>();
const waiting = new Map<number, { resolve: (m: ParsedMesh) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;

function failAll(error: Error) {
  for (const request of waiting.values()) request.reject(error);
  waiting.clear();
}

function startWorker(): Worker | null {
  if (worker || workerUnavailable) return worker;
  try {
    worker = new Worker(new URL('./stl.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerUnavailable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<ParseReply>) => {
    const reply = event.data;
    const request = waiting.get(reply.id);
    if (!request) return;
    waiting.delete(reply.id);
    if ('mesh' in reply) request.resolve(reply.mesh);
    else request.reject(new Error(reply.error));
  };
  worker.onerror = (event) => {
    // The worker script itself failed. Later parses run inline rather than never finishing.
    workerUnavailable = true;
    worker?.terminate();
    worker = null;
    failAll(new Error(event.message || 'The geometry worker stopped.'));
  };
  return worker;
}

function parse(source: MeshSource): Promise<ParsedMesh> {
  const running = startWorker();
  if (!running)
    return Promise.resolve().then(() =>
      parseStl('bytes' in source ? source.bytes : decodeBase64(source.base64)),
    );
  return new Promise<ParsedMesh>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    const request: ParseRequest = { id, ...source };
    running.postMessage(request);
  });
}

/**
 * The parsed mesh for a content key (a file's sha256). `load` runs only when that content has
 * no retained result or parse in flight. Failed work is not kept, so it can be tried again.
 */
export function meshByKey(key: string, load: () => Promise<MeshSource>): Promise<ParsedMesh> {
  return byKey.get(key, () => load().then(parse));
}

/** The parsed mesh for bytes already in hand, remembered for as long as the bytes live. */
export function meshFromBytes(bytes: ArrayBuffer): Promise<ParsedMesh> {
  const known = byBuffer.get(bytes);
  if (known) return known;
  const mesh = parse({ bytes });
  byBuffer.set(bytes, mesh);
  mesh.catch(() => {
    if (byBuffer.get(bytes) === mesh) byBuffer.delete(bytes);
  });
  return mesh;
}
