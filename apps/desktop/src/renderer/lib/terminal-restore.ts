export type TerminalSnapshot = {
  session: { id?: string; scrollback?: string; scrollbackCursor?: number } | null;
};

export type TerminalLiveFrame = { sessionId?: string; seq?: number; chunk: string };

/**
 * One asynchronous history restore per xterm lifetime, not per React ref.
 * Live frames carry a session sequence; only frames newer than the snapshot
 * cursor are written, so output concurrent with restore cannot duplicate or
 * reorder the snapshot.
 */
export function createTerminalRestore(
  read: () => Promise<TerminalSnapshot>,
  write: (text: string) => void,
  reset: () => void = () => {},
) {
  let disposed = false;
  let restored = false;
  let pending = false;
  let cursor = 0;
  let sessionId: string | undefined;
  let generation = 0;
  const buffered: TerminalLiveFrame[] = [];

  function applyFrame(frame: TerminalLiveFrame): void {
    if (disposed || (sessionId && frame.sessionId && frame.sessionId !== sessionId)) return;
    if (typeof frame.seq === 'number') {
      if (frame.seq <= cursor) return;
      write(frame.chunk);
      cursor = frame.seq;
      return;
    }
    if (restored) write(frame.chunk);
  }

  return {
    selectSession(id: string): void {
      if (disposed || id === sessionId) return;
      const replacing = sessionId !== undefined;
      sessionId = id;
      generation++;
      pending = false;
      restored = false;
      cursor = 0;
      // Early output from this session may have arrived before its state event.
      const matching = buffered.filter((frame) => !frame.sessionId || frame.sessionId === id);
      buffered.splice(0, buffered.length, ...matching);
      if (replacing) reset();
    },
    acceptLive(frame: TerminalLiveFrame): void {
      if (disposed) return;
      if (!restored) {
        buffered.push(frame);
        return;
      }
      applyFrame(frame);
    },
    async restore(): Promise<void> {
      if (disposed || restored || pending) return;
      pending = true;
      const requestGeneration = generation;
      try {
        const result = await read();
        if (disposed || generation !== requestGeneration || !result.session) return;
        if (sessionId && result.session.id && result.session.id !== sessionId) return;
        sessionId ??= result.session.id;
        write(result.session.scrollback ?? '');
        cursor = result.session.scrollbackCursor ?? 0;
        restored = true;
        const queued = buffered.splice(0).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        for (const frame of queued) applyFrame(frame);
      } catch {
        // Session/service state notifications may retry; never consume history
        // because the core was temporarily unavailable.
      } finally {
        if (generation === requestGeneration) pending = false;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
