// La salida y la llegada de cada recorrido (pedido de Rodrigo del 17/11/2026; rendimiento.ts en el servidor): para medir
// cuánto tarda cada recorrido. El chofer avisa con un toque («Salgo», «Terminé») o, si la app está abierta y tiene permiso
// de ubicación, lo detecta sola: salió cuando se aleja del punto de salida y llegó cuando vuelve con todo hecho.
//
// El celular solo le da la ubicación a la app mientras está abierta y en pantalla: no se sigue el viaje. Se guarda el punto
// en esos momentos y al marcar cada parada.
//
// Lo avisado se ve enseguida y queda en el celular; si no hay señal, sale solo cuando vuelve.
import { avisarEvento, Rechazo, type EventoRecorrido, type MedicionRecorrido } from './api';
import type { Punto } from './ubicacion';

const CLAVE = 'chofer-jornada', COLA = 'chofer-eventos';
const hoy = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });

// Lo de hoy, por recorrido: lo que ya avisó y si la app lo vio en el punto de salida (para detectar que se fue).
export type Jornada = Record<number, { salida_at?: string | null; llegada_at?: string | null; estuvo?: boolean }>;
export function jornadaGuardada(): Jornada {
  try { const g = JSON.parse(localStorage.getItem(CLAVE) ?? 'null') as { dia: string; j: Jornada } | null; return g && g.dia === hoy() && g.j ? g.j : {}; } catch { return {}; }
}
export function guardarJornada(j: Jornada) { try { localStorage.setItem(CLAVE, JSON.stringify({ dia: hoy(), j })); } catch { /* sin almacenamiento */ } }

type EnCola = EventoRecorrido & { dia: string };
function cola(): EnCola[] { try { const c = JSON.parse(localStorage.getItem(COLA) ?? '[]') as EnCola[]; return Array.isArray(c) ? c.filter((e) => e.dia === hoy()) : []; } catch { return []; } }
function guardarCola(c: EnCola[]) { try { localStorage.setItem(COLA, JSON.stringify(c)); } catch { /* sin almacenamiento */ } }

let mandando = false;
// Manda lo que quedó esperando, en orden. Lo que el servidor rechaza (el recorrido cambió de chofer) se descarta; sin
// señal, queda para la próxima. Devuelve lo último que contestó el servidor de cada recorrido.
export async function mandarPendientes(): Promise<Record<number, MedicionRecorrido>> {
  const dichas: Record<number, MedicionRecorrido> = {};
  if (mandando) return dichas;
  mandando = true;
  try {
    for (;;) {
      const c = cola();
      if (!c.length) break;
      const { dia: _, ...ev } = c[0];
      try { dichas[ev.n] = await avisarEvento(ev); }
      catch (e) { if (!(e instanceof Rechazo)) break; }
      guardarCola(cola().slice(1));
    }
  } finally { mandando = false; }
  return dichas;
}
export function encolar(ev: EventoRecorrido) { guardarCola([...cola(), { ...ev, dia: hoy() }]); }

// ---------- La ubicación mientras la app está abierta ----------

export type Fijo = Punto & { precision: number; t: number };
let ultimo: Fijo | null = null;
/** El último punto que dio el celular, si es de hace poco y es preciso: para mandar con la marca de una parada. */
export function ultimoPunto(): Punto | null {
  return ultimo && Date.now() - ultimo.t < 120_000 && ultimo.precision <= 200 ? { lat: ultimo.lat, lng: ultimo.lng } : null;
}
/** El último punto, con su precisión, si es de hace poco: para volver a mirar cuando llega el recorrido. */
export function ultimoFijo(): Fijo | null { return ultimo && Date.now() - ultimo.t < 120_000 ? ultimo : null; }
/** Sigue la ubicación mientras la app está abierta, solo si ya tiene permiso (no pregunta). Devuelve cómo dejar de seguir. */
export function seguirUbicacion(alMoverse: (f: Fijo) => void): () => void {
  if (!('geolocation' in navigator) || !navigator.permissions?.query) return () => undefined;
  let id: number | null = null, vivo = true;
  const arrancar = () => {
    if (!vivo || id != null) return;
    id = navigator.geolocation.watchPosition(
      (p) => { ultimo = { lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy, t: Date.now() }; alMoverse(ultimo); },
      () => undefined, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 });
  };
  let estado: PermissionStatus | null = null;
  const mirar = () => { if (estado?.state === 'granted') arrancar(); };
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { estado = p; mirar(); p.addEventListener('change', mirar); }).catch(() => undefined);
  return () => { vivo = false; if (id != null) navigator.geolocation.clearWatch(id); estado?.removeEventListener('change', mirar); };
}

/** Kilómetros en línea recta entre dos puntos. */
export function km(a: Punto, b: Punto) {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}
// A cuánto del punto de salida cuenta como «está ahí» y a cuánto como «ya se fue» (la diferencia evita que el GPS, que se
// mueve solo unos metros, lo dé por salido en la puerta).
export const CERCA_KM = 0.25, LEJOS_KM = 0.45;
