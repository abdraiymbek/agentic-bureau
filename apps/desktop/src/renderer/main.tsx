import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../../../../design-system/fonts/fonts.css';
import './tokens.css';
import './global.css';

async function mount() {
  if (
    !window.stark &&
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
