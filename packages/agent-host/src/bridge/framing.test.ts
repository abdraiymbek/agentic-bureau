import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES } from '@omenflow/contracts';
import { FrameDecoder, encodeFrame } from './framing.js';

describe('bridge framing', () => {
  it('roundtrips a single frame', () => {
    const msg = { type: 'hello', token: 'abc', n: 42 };
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(msg));
    expect(out).toEqual([msg]);
  });

  it('roundtrips multiple frames in one chunk', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      encodeFrame({ a: 1 }),
      encodeFrame({ b: 'two' }),
      encodeFrame([3]),
    ]);
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 'two' }, [3]]);
  });

  it('reassembles frames split across chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ hello: 'world', data: 'x'.repeat(1000) });
    const part1 = frame.subarray(0, 7);
    const part2 = frame.subarray(7, 500);
    const part3 = frame.subarray(500);
    expect(decoder.push(part1)).toEqual([]);
    expect(decoder.push(part2)).toEqual([]);
    const out = decoder.push(part3);
    expect(out).toEqual([{ hello: 'world', data: 'x'.repeat(1000) }]);
    expect(decoder.pending().length).toBe(0);
  });

  it('keeps leftover partial frame in pending()', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ ok: true });
    const out = decoder.push(Buffer.concat([frame, frame.subarray(0, 6)]));
    expect(out).toEqual([{ ok: true }]);
    expect(decoder.pending().length).toBe(6);
  });

  it('rejects oversize frames', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(/exceeds/);
  });

  it('rejects invalid JSON bodies', () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from('not json', 'utf8');
    const frame = Buffer.concat([Buffer.from([body.length, 0, 0, 0]), body]);
    expect(() => decoder.push(frame)).toThrow(/JSON/);
  });
});
