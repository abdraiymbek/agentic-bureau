import React, { useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { useStore, type Toast } from '../store';
import { IconButton } from '../ui/kit';
import { TOAST_EDGE, toastClearance } from './toast-clearance';

/** Keeps the stack clear of avoided controls while it shows anything, on every view. */
function useClearance(stack: React.RefObject<HTMLDivElement | null>, count: number): number {
  const view = useStore((s) => s.view);
  const [bottom, setBottom] = useState(TOAST_EDGE);
  useLayoutEffect(() => {
    if (!count) return;
    const avoided = () => [...document.querySelectorAll('[data-toast-avoid]')];
    const measure = () => {
      const size = stack.current?.getBoundingClientRect();
      setBottom(
        toastClearance(
          { width: window.innerWidth, height: window.innerHeight },
          { width: size?.width ?? 0, height: size?.height ?? 0 },
          avoided().map((el) => el.getBoundingClientRect()),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of avoided()) observer.observe(el);
    if (stack.current) observer.observe(stack.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [stack, count, view]);
  return bottom;
}

/** Toasts that left the store stay mounted until their exit animation has played. */
function useLeaving(toasts: Toast[]): {
  shown: Toast[];
  leaving: Set<number>;
  done: (id: number) => void;
} {
  const [leaving, setLeaving] = useState<Toast[]>([]);
  const previous = useRef(toasts);
  useLayoutEffect(() => {
    const gone = previous.current.filter((t) => !toasts.some((x) => x.id === t.id));
    previous.current = toasts;
    if (gone.length) setLeaving((current) => [...current, ...gone]);
  }, [toasts]);
  const shown = [...toasts, ...leaving].sort((a, b) => a.id - b.id);
  return {
    shown,
    leaving: new Set(leaving.map((t) => t.id)),
    done: (id) => setLeaving((current) => current.filter((t) => t.id !== id)),
  };
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const set = useStore((s) => s.set);
  const { shown, leaving, done } = useLeaving(toasts);
  const stack = useRef<HTMLDivElement>(null);
  const bottom = useClearance(stack, shown.length);
  return (
    <div className="toasts" ref={stack} aria-live="polite" style={{ bottom }}>
      {shown.map((t) => {
        const gone = leaving.has(t.id);
        return (
          <div
            key={t.id}
            className={`toast motion-rise tone-${t.kind}`}
            role={gone ? undefined : t.kind === 'error' ? 'alert' : 'status'}
            data-leaving={gone ? '' : undefined}
            onAnimationEnd={(e) => {
              if (gone && e.target === e.currentTarget) done(t.id);
            }}
          >
            {t.kind === 'error' ? (
              <WarningCircle size={15} />
            ) : t.kind === 'ok' ? (
              <CheckCircle size={15} />
            ) : (
              <Info size={15} />
            )}
            <span>{t.text}</span>
            <IconButton
              size="sm"
              label="Dismiss notification"
              disabled={gone}
              onClick={() =>
                set({ toasts: useStore.getState().toasts.filter((x) => x.id !== t.id) })
              }
            >
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
