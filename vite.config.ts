import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La interfaz vive en web/ y se compila a dist/, que el Worker sirve como assets estáticos.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
      '/hooks': 'http://localhost:8787',
      '/hubspot': 'http://localhost:8787',
    },
  },
});
