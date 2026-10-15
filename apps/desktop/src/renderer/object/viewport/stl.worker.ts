/** Decodes and parses STL bytes away from the interface thread. */
import { decodeBase64, parseStl, type ParsedMesh } from '../../lib/stl-parse';

export interface ParseRequest {
  id: number;
  bytes?: ArrayBuffer;
  base64?: string;
}

export type ParseReply = { id: number; mesh: ParsedMesh } | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (reply: ParseReply, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
  const { id, bytes, base64 } = event.data;
  try {
    const mesh = parseStl(bytes ?? decodeBase64(base64 ?? ''));
    scope.postMessage({ id, mesh }, [
      mesh.positions.buffer,
      mesh.indices.buffer,
      mesh.edges.buffer,
    ]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
