import { describe, expect, it } from 'vitest';
import { agentTouches, TOUCH_WINDOW_MS } from '../../apps/desktop/src/renderer/project/flow/touch';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const event = (origin: 'agent' | 'user' | 'system', minutesAgo: number, data: unknown) => ({
  origin,
  ts: at(minutesAgo),
  data,
});

describe('agent touch', () => {
  it('rings what the agent changed in the last 15 minutes and nothing else', () => {
    const touches = agentTouches(
      [
        event('agent', 2, { artifactId: 'recent' }),
        event('agent', 14.9, { artifactId: 'almost-lapsed' }),
        event('agent', 15, { artifactId: 'lapsed' }),
        event('agent', 40, { artifactId: 'old' }),
        event('user', 1, { artifactId: 'by-the-user' }),
        event('system', 1, { artifactId: 'by-the-system' }),
        event('agent', 1, { proposalId: 'no-object-named' }),
        event('agent', 1, null),
      ],
      NOW,
    );
    expect([...touches.ids].sort()).toEqual(['almost-lapsed', 'recent']);
  });

  it('says when the next ring lapses, and it has lapsed by then', () => {
    const events = [
      event('agent', 10, { artifactId: 'first' }),
      event('agent', 4, { artifactId: 'second' }),
    ];
    const touches = agentTouches(events, NOW);
    expect(touches.nextExpiry).toBe(NOW - 10 * 60_000 + TOUCH_WINDOW_MS);
    const later = agentTouches(events, touches.nextExpiry!);
    expect([...later.ids]).toEqual(['second']);
    expect(later.nextExpiry).toBe(NOW - 4 * 60_000 + TOUCH_WINDOW_MS);
    const done = agentTouches(events, later.nextExpiry!);
    expect(done.ids.size).toBe(0);
    expect(done.nextExpiry).toBeNull();
  });

  it('counts from the latest touch of an object', () => {
    const touches = agentTouches(
      [event('agent', 20, { artifactId: 'tray' }), event('agent', 3, { artifactId: 'tray' })],
      NOW,
    );
    expect([...touches.ids]).toEqual(['tray']);
    expect(touches.nextExpiry).toBe(NOW - 3 * 60_000 + TOUCH_WINDOW_MS);
  });

  it('ignores events it cannot date', () => {
    const touches = agentTouches(
      [{ origin: 'agent', ts: 'not a time', data: { artifactId: 'x' } }],
      NOW,
    );
    expect(touches).toEqual({ ids: new Set(), nextExpiry: null });
  });
});
