import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MetaProvider, ToastProvider } from './lib';
import Raiz from './Raiz';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <MetaProvider>
          <Raiz />
        </MetaProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
