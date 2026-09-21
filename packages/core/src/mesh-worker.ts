import { parentPort, workerData } from 'node:worker_threads';
import { toErrorBody } from '@omenflow/contracts';
import { analyzeMesh } from './mesh.js';
import { runChecks, preservationCheck } from './cad-checks.js';

try {
  const tris =
    workerData.tris instanceof Float64Array ? workerData.tris : new Float64Array(workerData.tris);
  const report =
    workerData.operation === 'check'
      ? runChecks(tris, workerData.expect)
      : workerData.operation === 'preserve'
        ? preservationCheck(workerData.reference, tris, workerData.regions)
        : analyzeMesh(tris);
  parentPort!.postMessage({ ok: true, report });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: toErrorBody(error) });
}
