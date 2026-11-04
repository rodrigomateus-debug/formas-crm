import { useEffect, useState } from 'react';

// Tema del CRM (Design System de Formas: claro, oscuro y alto contraste). Cada uno lo elige en su usuario y queda en este
// navegador. «Automático» sigue al sistema: alto contraste si lo pide, si no oscuro o claro. El script de index.html lo
// aplica antes de dibujar la página, para que no parpadee.
export type Tema = 'auto' | 'light' | 'dark' | 'contrast';
export const TEMAS: Array<[Tema, string]> = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro'], ['contrast', 'Alto contraste']];
const KEY = 'crm-tema';

function leer(): Tema {
  try { const t = localStorage.getItem(KEY) as Tema | null; return t && TEMAS.some(([k]) => k === t) ? t : 'auto'; } catch { return 'auto'; }
}
function resolver(t: Tema): Exclude<Tema, 'auto'> {
  if (t !== 'auto') return t;
  if (matchMedia('(prefers-contrast: more)').matches) return 'contrast';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const aplicar = (t: Tema) => document.documentElement.setAttribute('data-theme', resolver(t));

export function useTema() {
  const [tema, setTema] = useState<Tema>(leer);
  useEffect(() => {
    aplicar(tema);
    if (tema !== 'auto') return;
    const qs = [matchMedia('(prefers-color-scheme: dark)'), matchMedia('(prefers-contrast: more)')];
    const h = () => aplicar('auto');
    qs.forEach((q) => q.addEventListener('change', h));
    return () => qs.forEach((q) => q.removeEventListener('change', h));
  }, [tema]);
  const elegir = (t: Tema) => { try { localStorage.setItem(KEY, t); } catch { /* sin almacenamiento: dura hasta recargar */ } setTema(t); };
  return { tema, elegir };
}
