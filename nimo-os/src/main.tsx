import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import OverlayApp from './overlay/OverlayApp.tsx';
import './index.css';

// Two windows, one bundle:
//   ?view=overlay   → the floating transparent companion (Electron overlay)
//   (default)       → the full NIMO OS dashboard
const view = new URLSearchParams(window.location.search).get('view');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'overlay' ? <OverlayApp /> : <App />}
  </StrictMode>,
);
