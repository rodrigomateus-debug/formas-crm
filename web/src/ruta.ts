// Cálculo del recorrido del día (Cronograma → Ruta). Por ahora sin tránsito en vivo: el tiempo de cada tramo es el de
// calle libre por un factor según la hora, como un día de tránsito moderado normal (pedido de Rodrigo del 12/11/2026).
// Si el servicio de rutas contesta (useOsrm en CronogramaRuta.tsx), el tramo usa la distancia y el tiempo por calles; si
// no, la distancia en línea recta por 1,35 a 38 km/h.

export interface Punto { lat: number; lng: number }
export interface ParadaRuta { clave: string; lat: number | null; lng: number | null; horario: [number, number] | null; movimientos: unknown[] }
export interface Tramo { km: number; min: number; nivel: 'fluido' | 'moderado' | 'pesado'; estimado: boolean; sinUbicar: boolean }
export interface Llegada { clave: string; llega: number; espera: number; tarde: number; servicio: number; tramo: Tramo }
export interface Simulacion { paradas: Llegada[]; vuelta: Tramo; fin: number; km: number; tarde: number; sinUbicar: number; costo: number }
// Lo que devolvió el servicio de rutas para un orden dado: por tramo, km y minutos con la calle libre.
export interface TramosReales { clave: string; tramos: Array<{ km: number; min: number }> }
// Dónde termina el recorrido (pedido de Rodrigo del 13/11/2026): un punto (el mismo de donde sale, otro depósito u otro
// lugar; null si no se pudo ubicar) o 'ultima': termina en la última parada, sin volver a ningún lado.
export type Destino = Punto | null | 'ultima';

export function distanciaKm(a: Punto, b: Punto) {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}
// Cuánto más tarda un tramo según la hora (t: minutos desde las 0:00).
export function factorTransito(t: number) {
  const h = t / 60;
  return h < 7 ? 1.15 : h < 10 ? 1.6 : h < 12 ? 1.35 : h < 14 ? 1.4 : h < 16.5 ? 1.3 : h < 19.5 ? 1.65 : 1.15;
}
const nivelDe = (f: number): Tramo['nivel'] => (f >= 1.55 ? 'pesado' : f >= 1.3 ? 'moderado' : 'fluido');
// Minutos en cada parada: estacionar, más cargar o descargar cada movimiento.
export const servicioDe = (movs: number) => Math.min(35, 8 + 4 * movs);
const coord = (p: Punto | ParadaRuta | null) => (p && p.lat != null ? `${p.lat!.toFixed(5)},${p.lng!.toFixed(5)}` : '?');
export const claveOrden = (base: Punto | null, orden: ParadaRuta[], destino: Destino = base) =>
  [...[base, ...orden].map(coord), destino === 'ultima' ? 'fin' : coord(destino)].join(';');

// Sin `destino`, vuelve a donde salió.
export function simular(base: Punto | null, orden: ParadaRuta[], salida: number, reales?: TramosReales | null, destino: Destino = base): Simulacion {
  const usar = reales && reales.clave === claveOrden(base, orden, destino) ? reales.tramos : null;
  let t = salida, prev: Punto | null = base, km = 0, tarde = 0, sinUbicar = 0;
  const tramo = (a: Punto | null, b: Punto | null, i: number): Tramo => {
    const f = factorTransito(t);
    if (!a || !b) return { km: 0, min: 0, nivel: nivelDe(f), estimado: true, sinUbicar: true };
    const r = usar?.[i];
    const d = r ? r.km : distanciaKm(a, b) * 1.35;
    const libre = r ? r.min : (d / 38) * 60;
    return { km: d, min: libre * f, nivel: nivelDe(f), estimado: !r, sinUbicar: false };
  };
  const paradas: Llegada[] = [];
  orden.forEach((p, i) => {
    const aca = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
    const tr = tramo(prev, aca, i);
    if (!aca) sinUbicar++;
    t += tr.min; km += tr.km;
    const llega = t;
    let espera = 0;
    if (p.horario && t < p.horario[0]) { espera = p.horario[0] - t; t = p.horario[0]; }
    const late = p.horario && llega > p.horario[1] ? llega - p.horario[1] : 0;
    tarde += late;
    const servicio = servicioDe(p.movimientos.length);
    paradas.push({ clave: p.clave, llega, espera, tarde: late, servicio, tramo: tr });
    t += servicio;
    if (aca) prev = aca;
  });
  // La vuelta: al lugar donde termina; si termina en la última parada, no hay.
  const vuelta = destino === 'ultima' ? { km: 0, min: 0, nivel: nivelDe(factorTransito(t)), estimado: false, sinUbicar: false } : tramo(prev, destino, orden.length);
  km += vuelta.km;
  const fin = t + vuelta.min;
  return { paradas, vuelta, fin, km, tarde, sinUbicar, costo: fin - salida + tarde * 6 };
}

// El orden más corto: primero el vecino más cercano y después se prueba mover y dar vuelta tramos mientras mejore. Tiene
// en cuenta el horario de cada lugar (llegar tarde cuesta). Las paradas sin ubicar quedan al final, como estaban.
export function optimizar(base: Punto | null, paradas: ParadaRuta[], salida: number, destino: Destino = base): ParadaRuta[] {
  const con = paradas.filter((p) => p.lat != null && p.lng != null), sin = paradas.filter((p) => p.lat == null || p.lng == null);
  if (con.length < 2) return [...con, ...sin];
  let o: ParadaRuta[] = [];
  const resto = [...con];
  let prev: Punto = base ?? { lat: con[0].lat!, lng: con[0].lng! };
  while (resto.length) {
    resto.sort((a, b) => distanciaKm(prev, a as Punto) - distanciaKm(prev, b as Punto));
    const s = resto.shift()!;
    prev = s as Punto;
    o.push(s);
  }
  let mejor = simular(base, o, salida, null, destino).costo, sigue = true, vueltas = 0;
  while (sigue && vueltas++ < 40) {
    sigue = false;
    for (let i = 0; i < o.length; i++) for (let j = 0; j < o.length; j++) {
      if (i === j) continue;
      const n = [...o]; n.splice(j, 0, n.splice(i, 1)[0]);
      const c = simular(base, n, salida, null, destino).costo;
      if (c < mejor - 0.01) { o = n; mejor = c; sigue = true; }
    }
    for (let i = 0; i < o.length - 1; i++) for (let j = i + 1; j < o.length; j++) {
      const n = [...o.slice(0, i), ...o.slice(i, j + 1).reverse(), ...o.slice(j + 1)];
      const c = simular(base, n, salida, null, destino).costo;
      if (c < mejor - 0.01) { o = n; mejor = c; sigue = true; }
    }
  }
  return [...o, ...sin];
}

export const hhmm = (m: number) => { const x = Math.round(m); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
export const duracion = (m: number) => { const x = Math.round(m); return x < 60 ? `${x} min` : `${Math.floor(x / 60)} h ${String(x % 60).padStart(2, '0')}`; };
