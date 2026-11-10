import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La app del chofer (remitos desde el celular): una compilación aparte, servida por el Worker en /hooks/chofer/. Va por
// /hooks porque esa ruta no pasa por el login de Cloudflare Access (cada chofer entra con su link personal). Se compila
// después de la interfaz del CRM, a dist/chofer/.
export default defineConfig({
  root: 'web/chofer',
  base: '/hooks/chofer/',
  plugins: [react()],
  build: { outDir: '../../dist/chofer', emptyOutDir: true },
  server: { proxy: { '/hooks/chofer/api': 'http://localhost:8787' } },
});
