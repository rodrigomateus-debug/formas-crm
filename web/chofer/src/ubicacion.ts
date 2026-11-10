// Ubicación, sin molestar: se usa si el navegador ya tiene permiso; si nunca se preguntó, se pregunta una sola vez.
// Si el chofer dice que no (o el celular tarda), la foto sale igual sin ubicación.

const CLAVE = 'chofer-ubicacion-preguntada';

export type Punto = { lat: number; lng: number };

async function permiso(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    return p.state;
  } catch {
    return 'prompt';
  }
}

export async function ubicacion(): Promise<Punto | null> {
  if (!('geolocation' in navigator)) return null;
  const estado = await permiso();
  if (estado === 'denied') return null;
  if (estado === 'prompt') {
    let preguntada = true; // sin almacenamiento no se puede recordar: mejor no preguntar nunca que preguntar siempre
    try { preguntada = localStorage.getItem(CLAVE) === '1'; localStorage.setItem(CLAVE, '1'); } catch { /* queda en true */ }
    if (preguntada) return null;
  }
  return new Promise((ok) => {
    const reloj = setTimeout(() => ok(null), 15_000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(reloj); ok({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      () => { clearTimeout(reloj); ok(null); },
      { enableHighAccuracy: false, maximumAge: 120_000, timeout: 10_000 },
    );
  });
}

/** Espera la ubicación como mucho `ms`: nunca frena el envío. */
export function conTope<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((ok) => setTimeout(() => ok(null), ms))]);
}
