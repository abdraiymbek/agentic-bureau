/**
 * A code-split view that can be fetched ahead of need. `preload()` starts loading the chunk;
 * once it has arrived the component renders at once, without passing through its Suspense
 * fallback (a plain `React.lazy` suspends for a tick even when the module is already loaded).
 * A failed load is forgotten, so the next render (an error boundary's retry) fetches again.
 */
import React from 'react';

type Module<P> = { default: React.ComponentType<P> };

export interface LazyView<P> {
  Component: React.ComponentType<P>;
  /** Starts loading the chunk. Rejects when it cannot be loaded; rendering reports that too. */
  preload: () => Promise<unknown>;
}

export function lazyView<P extends object>(
  load: () => Promise<React.ComponentType<P>>,
): LazyView<P> {
  let loaded: Module<P> | null = null;
  let loading: Promise<Module<P>> | null = null;
  const preload = () => {
    loading ??= load().then(
      (component) => (loaded = { default: component }),
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  const make = (): React.ComponentType<P> =>
    React.lazy<React.ComponentType<P>>(
      () =>
        // React resolves a lazy component in the same render when its thenable calls back
        // synchronously, which a native promise never does.
        ({
          then: (resolve: (m: Module<P>) => void, reject: (e: unknown) => void) => {
            if (loaded) return resolve(loaded);
            preload().then(resolve, (error: unknown) => {
              // React keeps a failed lazy component failed; the next render gets a new one.
              lazy = make();
              reject(error);
            });
          },
        }) as unknown as Promise<Module<P>>,
    ) as unknown as React.ComponentType<P>;
  let lazy = make();
  function View(props: P) {
    return React.createElement(lazy, props);
  }
  return { Component: View, preload };
}
