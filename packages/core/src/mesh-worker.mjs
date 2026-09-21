// Source-tree bootstrap only. The desktop build replaces this with a standalone
// bundle of mesh-worker.ts, so the shipped app needs neither tsx nor TypeScript.
import { tsImport } from 'tsx/esm/api';
await tsImport('./mesh-worker.ts', import.meta.url);
