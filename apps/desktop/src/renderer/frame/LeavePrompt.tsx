import React, { useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useStore } from '../store';
import { Button } from '../ui/kit';

/**
 * Asks before a navigation discards unsaved work (`lib/dirty.ts`). Keeping the edits is the
 * default: it has focus, and Escape or a press outside chooses it.
 */
export function LeavePrompt() {
  const prompt = useStore((s) => s.leavePrompt);
  const resolve = useStore((s) => s.resolveLeavePrompt);
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={!!prompt} onOpenChange={(open) => !open && resolve(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay motion-fade" />
        <Dialog.Content
          className="frame-prompt motion-rise"
          role="alertdialog"
          aria-describedby="frame-prompt-body"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            keep.current?.focus();
          }}
        >
          <Dialog.Title className="frame-prompt-title">Discard unsaved changes?</Dialog.Title>
          <div id="frame-prompt-body" className="frame-prompt-body">
            <p>These changes are not saved anywhere yet:</p>
            <ul>
              {prompt?.labels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </div>
          <div className="frame-prompt-actions">
            <Button variant="danger" onClick={() => resolve(true)}>
              Discard and {prompt?.action ?? 'continue'}
            </Button>
            <span className="grow" />
            <Button ref={keep} variant="primary" onClick={() => resolve(false)}>
              Keep editing
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
