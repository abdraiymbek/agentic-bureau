import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs` while `active`. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/** True until `windowMs` after `since`; renders again once when that time has passed. */
export function useRecent(since: number | null, windowMs: number): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const left = since + windowMs - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => bump((n) => n + 1), left + 20);
    return () => window.clearTimeout(timer);
  }, [since, windowMs]);
  return since !== null && Date.now() - since < windowMs;
}
