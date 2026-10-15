import { createContext, useSyncExternalStore } from 'react';

/** The project header element, so the flow map can keep clear of it. */
export const ProjectHead = createContext<HTMLElement | null>(null);

/**
 * A value that changes outside React's render cycle. The map controller writes it; only the
 * small component that shows it re-renders.
 */
export class Signal<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = () => this.value;

  set = (value: T) => {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get);
}
