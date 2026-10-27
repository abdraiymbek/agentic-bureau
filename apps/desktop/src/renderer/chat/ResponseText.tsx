import React, { useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import { linkDestination } from '../lib/markdown';
import { useStore } from '../store';
import { errMsg } from '../api';
/** Animate genuine arrivals only. History mounts fully readable; transport owns run state. */
export function ResponseText({
  text,
  running,
  fresh,
}: {
  text: string;
  running: boolean;
  fresh: boolean;
}) {
  const first = useRef(text);
  const [selected, setSelected] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [settled, setSettled] = useState(!fresh);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    const selection = () => setSelected(!!window.getSelection()?.toString());
    document.addEventListener('selectionchange', selection);
    return () => {
      query.removeEventListener('change', change);
      document.removeEventListener('selectionchange', selection);
    };
  }, []);
  useEffect(() => {
    if (running) {
      setSettled(false);
      return;
    }
    if ((!fresh && first.current === text) || selected) return;
    const timer = setTimeout(() => setSettled(true), 260);
    return () => clearTimeout(timer);
  }, [running, text, fresh, selected]);
  const animate = !reduced && !settled && (fresh || text !== first.current);
  return (
    <div
      className="prose chat-stream"
      onClick={(e) => {
        const a = (e.target as Element).closest('a');
        if (!a) return;
        e.preventDefault();
        const url = linkDestination(a.getAttribute('href'));
        if (url)
          void window.bureau
            .openExternal(url)
            .catch((error) => useStore.getState().toast('error', errMsg(error)));
      }}
    >
      <Streamdown
        mode="streaming"
        isAnimating={animate}
        animated={{ animation: 'fadeIn', duration: 220, sep: 'word' }}
        controls={false}
        linkSafety={{ enabled: false }}
        components={{ img: ({ alt }) => <span>[Image: {alt || 'omitted'}]</span> }}
      >
        {text}
      </Streamdown>
    </div>
  );
}
