import React from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { useStore } from '../store';
import { errMsg } from '../api';
import { Tooltip } from './kit';

export function webUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Keep recorded destinations visible and open them in the system browser. A primary or middle
 * click opens the link outside the app; the destination is in the tooltip.
 */
export function ExternalLink({ url, children }: { url?: string; children?: React.ReactNode }) {
  const href = webUrl(url);
  if (!href)
    return (
      <span className="unknown">{url ? 'No usable web link recorded' : 'No link recorded'}</span>
    );
  const open = (event: React.MouseEvent) => {
    event.preventDefault();
    void window.omenflow
      .openExternal(href)
      .catch((error) => useStore.getState().toast('error', errMsg(error)));
  };
  return (
    <Tooltip label={href}>
      <a
        className="cell-link"
        href={href}
        onClick={open}
        onAuxClick={(event) => {
          if (event.button === 1) open(event);
        }}
      >
        <ArrowSquareOut size={13} aria-hidden="true" />
        {children ?? url}
        <span className="sr-only"> (opens in your browser)</span>
      </a>
    </Tooltip>
  );
}
