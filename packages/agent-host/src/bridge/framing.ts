import { ErrorCodes, MAX_FRAME_BYTES, BureauError } from '@bureau/contracts';

/**
 * Bridge wire framing: 4-byte little-endian length prefix + JSON body.
 * Shared by the bridge server, the Node CLI shim, and the Rust helper
 * (native/bureau-bridge) — keep the format boring and identical.
 */

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder for a stream of length-prefixed frames. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed bytes; returns every complete frame parsed this push. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        // Drop the stream: a peer announcing a giant frame is not our protocol.
        this.buf = Buffer.alloc(0);
        throw new BureauError(
          ErrorCodes.VALIDATION,
          `Bridge frame exceeds ${MAX_FRAME_BYTES} bytes`,
        );
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new BureauError(ErrorCodes.VALIDATION, 'Bridge frame is not valid JSON');
      }
      out.push(parsed);
    }
    return out;
  }

  /** Raw bytes consumed but not yet part of a complete frame (for handoff). */
  pending(): Buffer {
    return this.buf;
  }
}
