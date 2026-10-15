/**
 * Input to the PTY, in order. Host commands run concurrently, so two writes issued back to back
 * can arrive swapped; here each write waits for the one before it. Input typed while a write is
 * in flight is sent as one batch when it returns.
 */
export interface OrderedWriter {
  /** Resolves once this data has been handed to the host (or dropped because the send failed). */
  write(data: string): Promise<void>;
  /** Drop anything not yet sent. In-flight data cannot be recalled. */
  clear(): void;
}

export function createOrderedWriter(
  send: (data: string) => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): OrderedWriter {
  let pending = '';
  let waiters: (() => void)[] = [];
  let running = false;

  async function pump() {
    running = true;
    while (pending) {
      const data = pending;
      const done = waiters;
      pending = '';
      waiters = [];
      try {
        await send(data);
      } catch (error) {
        onError(error);
      }
      for (const resolve of done) resolve();
    }
    running = false;
  }

  return {
    write(data) {
      if (!data) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending += data;
        waiters.push(resolve);
        if (!running) void pump();
      });
    },
    clear() {
      pending = '';
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    },
  };
}
