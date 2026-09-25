import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../../../../design-system/fonts/fonts.css';
import '../../../../design-system/tokens.css';
import './styles/app.css';

async function mount() {
  if (!window.omenflow && '__TAURI_INTERNALS__' in window) {
    const { installTauriApi } = await import('./tauri-api');
    await installTauriApi();
  }
  if (
    !window.omenflow &&
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has('design-preview')
  ) {
    const { installDesignPreview } = await import('./preview');
    await installDesignPreview();
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void mount();
