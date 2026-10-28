import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from '../../ui/icons';
import { IconButton } from '../../ui/kit';
import type { SearchResult, TerminalEngine } from './terminal';

/** Find in the scrollback. Return and ↓ go to the next match, ⇧Return and ↑ to the previous. */
export function TerminalSearch({
  engine,
  onClose,
}: {
  engine: TerminalEngine;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult>({ index: -1, total: 0 });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    return () => engine.clearSearch();
  }, [engine]);

  const step = (direction: 1 | -1, text = query) => setResult(engine.find(text, direction));
  const close = () => {
    onClose();
    engine.focus();
  };

  return (
    <div className="terminal-search" role="search">
      <input
        ref={input}
        value={query}
        placeholder="Find in scrollback"
        aria-label="Find in scrollback"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          step(1, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <span className="terminal-search-count mono" role="status">
        {query ? (result.total ? `${result.index + 1} of ${result.total}` : 'No matches') : ''}
      </span>
      <IconButton
        size="sm"
        label="Previous match (⇧↵)"
        disabled={!result.total}
        onClick={() => step(-1)}
      >
        <ArrowUp size={13} />
      </IconButton>
      <IconButton size="sm" label="Next match (↵)" disabled={!result.total} onClick={() => step(1)}>
        <ArrowDown size={13} />
      </IconButton>
      <IconButton size="sm" label="Close search (esc)" onClick={close}>
        <X size={13} />
      </IconButton>
    </div>
  );
}
