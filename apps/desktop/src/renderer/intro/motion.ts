/**
 * Small motion helpers for the introduction: the system's reduced-motion preference, and a
 * progress value that eases from 0 to 1 once something becomes active (at once under reduced
 * motion), for numbers that count up and text that types itself.
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia(QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(QUERY);
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

/**
 * 0 until `active`, then eased to 1 over `ms` after `delay`. Reduced motion jumps to 1. Going
 * inactive resets to 0 so the next activation plays again.
 */
export function useProgress(active: boolean, ms: number, delay = 0, reduced = false): number {
  const [k, setK] = useState(0);
  useEffect(() => {
    if (!active) {
      setK(0);
      return;
    }
    if (reduced || ms <= 0) {
      setK(1);
      return;
    }
    const start = performance.now() + delay;
    let frame = 0;
    const step = (now: number) => {
      const x = Math.min(1, Math.max(0, (now - start) / ms));
      setK(easeOutExpo(x));
      if (x < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, ms, delay, reduced]);
  return k;
}

/** The first `k` of a string, for text that types itself. */
export const typed = (text: string, k: number) => text.slice(0, Math.round(text.length * k));
