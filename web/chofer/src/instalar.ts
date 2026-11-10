// «Agregar a la pantalla de inicio»: si la app ya corre instalada, en qué teléfono está y, en Android/Chrome, el evento
// que deja ofrecer la instalación con un botón propio.

type EventoInstalar = Event & { prompt: () => Promise<unknown>; userChoice?: Promise<{ outcome: string }> };

/** Abierta desde el ícono de la pantalla de inicio (no en una pestaña del navegador). */
export function instalada(): boolean {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true; // iPhone
    return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}

export function telefono(): 'iphone' | 'android' | 'otro' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  return 'otro';
}

export type Instalacion = { /** Hay botón para instalar (Android/Chrome). */ conBoton: boolean; /** Se instaló recién. */ hecha: boolean };

let foto: Instalacion = { conBoton: false, hecha: false };
let evento: EventoInstalar | null = null;
const oyentes = new Set<() => void>();
function publicar(cambio: Partial<Instalacion>): void {
  foto = { ...foto, ...cambio };
  oyentes.forEach((o) => o());
}

// Se escucha desde que carga el módulo: Chrome dispara el evento una sola vez, apenas decide que la app se puede instalar.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // sin el cartel propio de Chrome: lo ofrece la tarjeta de la app
  evento = e as EventoInstalar;
  publicar({ conBoton: true });
});
window.addEventListener('appinstalled', () => { evento = null; publicar({ conBoton: false, hecha: true }); });

export const instalacion = {
  suscribir(o: () => void): () => void { oyentes.add(o); return () => { oyentes.delete(o); }; },
  leer(): Instalacion { return foto; },
  async pedir(): Promise<void> {
    const e = evento;
    if (!e) return;
    evento = null; // el evento sirve una sola vez
    publicar({ conBoton: false });
    try {
      await e.prompt();
      const r = await e.userChoice;
      if (r?.outcome === 'accepted') publicar({ hecha: true });
    } catch { /* lo canceló: no pasa nada */ }
  },
};
