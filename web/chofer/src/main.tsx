import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tomarTokenDelLink } from './api';
import App from './App';
import './estilos.css';

tomarTokenDelLink();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// La cáscara de la app queda guardada en el celular para que abra sin señal (public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    const registro = navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).then(() => navigator.serviceWorker.ready);
    const tipografia = document.fonts?.ready.catch(() => undefined);
    Promise.all([registro, tipografia]).then(([reg]) => {
      // Le pasa al service worker lo que esta página necesitó para abrir (los archivos llevan un nombre distinto en cada versión).
      const urls = performance.getEntriesByType('resource')
        .map((r) => r.name)
        .filter((u) => (u.startsWith(location.origin + base) && !u.includes('/api/')) || u.startsWith('https://fonts.'));
      reg.active?.postMessage({ tipo: 'guardar', urls });
    }).catch(() => { /* sin service worker la app anda igual, solo que no abre sin señal */ });
  });
}
