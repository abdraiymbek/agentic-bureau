import { parentPort, workerData } from 'node:worker_threads';
import { toErrorBody, OmenflowError, ErrorCodes } from '@omenflow/contracts';
import { analyzeMesh, parseStlTriangles, orientTriangles } from './mesh.js';
import { runChecks, preservationCheck } from './cad-checks.js';
import { inspectGeometry } from './cad-geometry.js';

try {
  const tris =
    workerData.operation === 'prepare'
      ? parseStlTriangles(Buffer.from(workerData.stl))
      : workerData.tris instanceof Float64Array
        ? workerData.tris
        : new Float64Array(workerData.tris);
  if (workerData.operation === 'prepare' && !tris.length)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'OpenSCAD output has no finite geometry');
  const report =
    workerData.operation === 'prepare'
      ? orientTriangles(tris)
      : workerData.operation === 'details'
        ? inspectGeometry({ ...workerData, tris })
        : workerData.operation === 'check'
          ? runChecks(tris, workerData.expect)
          : workerData.operation === 'preserve'
            ? preservationCheck(workerData.reference, tris, workerData.regions)
            : analyzeMesh(tris);
  parentPort!.postMessage({ ok: true, report });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: toErrorBody(error) });
}
