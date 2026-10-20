import type { NativeShutdownRequest, OmenflowApi } from '../api';
import { confirmLeave } from './dirty';
import { unsavedEdits } from './unsaved-edits';

/** Keep the work registered until native shutdown actually happens: agent consent may cancel it. */
export function installNativeShutdownGuard(api: OmenflowApi): () => void {
  if (!api.onShutdownRequest || !api.replyToShutdown) return () => {};
  const reply = api.replyToShutdown.bind(api);
  let active = true;
  let pending: string | null = null;
  const answer = async (request: NativeShutdownRequest) => {
    if (!active || pending) return;
    pending = request.requestId;
    try {
      // Receipt is separate from the decision: a person can take as long as they need to answer.
      await reply(request.requestId, 'received');
      if (!active) return;
      const discard = await confirmLeave(
        request.action === 'quit' ? 'quit Omen Flow' : 'close the window',
        {
          keep: true,
          extraLabels: unsavedEdits
            .list()
            .filter((e) => !e.mounted)
            .map((e) => e.label),
        },
      );
      if (active) await reply(request.requestId, discard ? 'discard' : 'cancel');
    } catch (error) {
      console.error('Native close request was cancelled', error);
      await reply(request.requestId, 'cancel').catch(() => {});
    } finally {
      if (pending === request.requestId) pending = null;
    }
  };
  const stop = api.onShutdownRequest((request) => void answer(request));
  return () => {
    active = false;
    stop();
    if (pending) void reply(pending, 'cancel').catch(() => {});
  };
}
