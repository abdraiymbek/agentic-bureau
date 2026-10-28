import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { TooltipProvider } from './ui/kit';
import { perfMark } from './lib/perf';
// Library styles load before ours, so our overrides win even when the component that uses
// them arrives in a later chunk (the agent terminal).
import '@xterm/xterm/css/xterm.css';
import '../../../../design-system/fonts/bureau.css';
import '../../../../design-system/tokens.css';
import './styles/index.css';

perfMark('start');

// The theme is applied as the store changes, before any component's effects run, so
// everything that reads computed colours (the terminal palette) sees the new theme at once.
document.documentElement.dataset.theme = useStore.getState().theme;
useStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) document.documentElement.dataset.theme = s.theme;
});
if (
  '__TAURI_INTERNALS__' in window &&
  (/Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent))
)
  document.documentElement.dataset.chrome = 'mac-overlay';

async function mount() {
  if (!window.bureau && '__TAURI_INTERNALS__' in window) {
    const { installTauriApi } = await import('./tauri-api');
    await installTauriApi();
  }
  if (
    !window.bureau &&
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has('design-preview')
  ) {
    const { installDesignPreview } = await import('./preview');
    await installDesignPreview();
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary label="Bureau">
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
void mount();
