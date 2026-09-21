/**
 * Cancellable mesh analysis worker. The parent passes:
 *   { tris: Float64Array | number[], moduleHref: string }
 * and receives one message: { ok: true, report } | { ok: false, message }.
 */
import { parentPort, workerData } from 'node:worker_threads';

try {
  const { analyzeMesh } = await import(workerData.moduleHref);
  const tris =
    workerData.tris instanceof Float64Array
      ? workerData.tris
      : new Float64Array(workerData.tris);
  parentPort.postMessage({ ok: true, report: analyzeMesh(tris) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
