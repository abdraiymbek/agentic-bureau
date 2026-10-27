import React, { useState } from 'react';
import { WarningCircle, X } from '../ui/icons';
import { formatRecoverableError } from '../api';
import { useStore } from '../store';
import { Button, IconButton } from '../ui/kit';
import { failureSentence, loadFailure } from './load-copy';

/**
 * The one place for failures the person has to act on: the workspace service is gone, part
 * of the project record could not be refreshed, or an operation failed that nothing on screen
 * reported. Each says what failed in words and offers a retry or a dismiss. Failures a surface
 * already showed (a toast, an inline notice) never appear here.
 */
export function FrameStrip({ serviceError }: { serviceError: string | null }) {
  const projectId = useStore((s) => s.projectId);
  const load = useStore((s) => s.load);
  const firstLoadComplete = useStore((s) => s.firstLoadComplete);
  const frameError = useStore((s) => s.frameError);
  const retryLoad = useStore((s) => s.retryLoad);
  const dismissFrameError = useStore((s) => s.dismissFrameError);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Before the first load the stage itself explains a failure.
  const failure = projectId && firstLoadComplete ? loadFailure(load) : null;
  const failureKey = failure && `${failure.resources.join()}:${failure.message}`;

  if (serviceError)
    return (
      <div className="system-strip" role="alert">
        <WarningCircle size={14} />
        <span className="grow">{serviceError}</span>
      </div>
    );
  if (failure && failureKey !== dismissed)
    return (
      <div className="system-strip" role="alert">
        <WarningCircle size={14} />
        <span className="grow">
          {failureSentence(failure)} {failure.message}
          {failure.stale && <span className="dim"> · What is shown may be out of date.</span>}
        </span>
        <Button
          size="sm"
          variant="ghost"
          busy={retrying}
          onClick={() => {
            setRetrying(true);
            void retryLoad().finally(() => setRetrying(false));
          }}
        >
          Retry
        </Button>
        <IconButton size="sm" label="Dismiss" onClick={() => setDismissed(failureKey)}>
          <X size={12} />
        </IconButton>
      </div>
    );
  if (frameError)
    return (
      <div className="system-strip" role="alert">
        <WarningCircle size={14} />
        <span className="grow">
          {formatRecoverableError(frameError)}
          <span className="mono dim"> · {frameError.op}</span>
        </span>
        <IconButton size="sm" label="Dismiss" onClick={dismissFrameError}>
          <X size={12} />
        </IconButton>
      </div>
    );
  return null;
}
