import React from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { useStore } from '../store';
import { errMsg } from '../api';

export function webUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Keep recorded destinations visible and open them in the system browser. */
export function ExternalLink({ url, children }: { url?: string; children?: React.ReactNode }) {
  const href = webUrl(url);
  if (!href)
    return (
      <span className="unknown">{url ? 'No usable web link recorded' : 'No link recorded'}</span>
    );
  return (
    <a
      className="cell-link"
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        void window.omenflow
          .openExternal(href)
          .catch((error) => useStore.getState().toast('error', errMsg(error)));
      }}
    >
      <ArrowSquareOut size={13} />
      {children ?? url}
    </a>
  );
}
