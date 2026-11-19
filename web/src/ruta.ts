// Cálculo del recorrido del día (Cronograma → Ruta). Por ahora sin tránsito en vivo: el tiempo de cada tramo es el de
// calle libre por un factor según la hora, como un día de tránsito moderado normal (pedido de Rodrigo del 12/11/2026).
// Si el servicio de rutas contesta (useOsrm en CronogramaRuta.tsx), el tramo usa la distancia y el tiempo por calles; si
// no, la distancia en línea recta por 1,35 a 38 km/h.

export interface Punto { lat: number; lng: number }
// `estricto`: el horario es una hora fijada a mano en la ruta del día («a las 12:00»): llegar tarde ahí pesa mucho más
// que a un horario de recepción, así el orden más corto la cumple.
// `espera_hasta`: con una hora fijada «a las 12:00» se espera hasta las 12:00, aunque llegar a las 11:45 no es tarde.
export interface ParadaRuta { clave: string; lat: number | null; lng: number | null; horario: [number, number] | null; movimientos: unknown[]; encargos?: unknown[]; estricto?: boolean; espera_hasta?: number | null }
// `falta`: si no se pudo calcular, qué punta no está ubicada: de donde sale el tramo o adonde va.
export interface Tramo { km: number; min: number; nivel: 'fluido' | 'moderado' | 'pesado'; estimado: boolean; sinUbicar: boolean; falta?: 'desde' | 'hasta' | null }
// `incierta`: antes hay un tramo sin calcular (falta ubicar una dirección), así que la hora sale de menos.
export interface Llegada { clave: string; llega: number; espera: number; tarde: number; servicio: number; tramo: Tramo; incierta: boolean }
export interface Simulacion { paradas: Llegada[]; vuelta: Tramo; fin: number; km: number; tarde: number; sinUbicar: number; costo: number; incierta: boolean }
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
// Las horas en que cambia el factor de factorTransito (en minutos).
const CORTES = [7, 10, 12, 14, 16.5, 19.5].map((h) => h * 60);
// Cuánto tarda un tramo de `libre` minutos con la calle libre que sale a la hora `t`: si cruza a otra franja (sale a las
// 9:30 y llega pasadas las 10), cada parte va con el factor de su franja, no todo con el de la salida.
export function minutosDeViaje(t: number, libre: number) {
  let ahora = t, falta = libre;
  for (let n = 0; n < 16 && falta > 1e-9; n++) {
    const h = ((ahora % 1440) + 1440) % 1440, f = factorTransito(h), corte = CORTES.find((c) => c > h);
    const alcanza = corte == null ? Infinity : (corte - h) / f;
    if (falta <= alcanza) { ahora += falta * f; falta = 0; } else { ahora += corte! - h; falta -= alcanza; }
  }
  return ahora - t;
}
// Minutos en cada parada: estacionar, más cargar o descargar cada movimiento.
export const servicioDe = (movs: number) => Math.min(35, 8 + 4 * movs);
const coord = (p: Punto | ParadaRuta | null) => (p && p.lat != null ? `${p.lat!.toFixed(5)},${p.lng!.toFixed(5)}` : '?');
export const claveOrden = (base: Punto | null, orden: ParadaRuta[], destino: Destino = base) =>
  [...[base, ...orden].map(coord), destino === 'ultima' ? 'fin' : coord(destino)].join(';');

// Sin `destino`, vuelve a donde salió.
export function simular(base: Punto | null, orden: ParadaRuta[], salida: number, reales?: TramosReales | null, destino: Destino = base): Simulacion {
  const usar = reales && reales.clave === claveOrden(base, orden, destino) ? reales.tramos : null;
  let t = salida, prev: Punto | null = base, km = 0, tarde = 0, sinUbicar = 0, tardeFija = 0, incierta = false;
  const tramo = (a: Punto | null, b: Punto | null, i: number): Tramo => {
    if (!a || !b) { incierta = true; return { km: 0, min: 0, nivel: nivelDe(factorTransito(t)), estimado: true, sinUbicar: true, falta: !b ? 'hasta' : 'desde' }; }
    const r = usar?.[i];
    const d = r ? r.km : distanciaKm(a, b) * 1.35;
    const libre = r ? r.min : (d / 38) * 60;
    const min = minutosDeViaje(t, libre);
    return { km: d, min, nivel: nivelDe(libre > 0 ? min / libre : factorTransito(t)), estimado: !r, sinUbicar: false, falta: null };
  };
  const paradas: Llegada[] = [];
  orden.forEach((p, i) => {
    const aca = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
    const tr = tramo(prev, aca, i), dudosa = incierta;
    if (!aca) sinUbicar++;
    t += tr.min; km += tr.km;
    const llega = t;
    let espera = 0;
    // Desde cuándo la atienden: el principio de su horario o, con una hora fijada «a las», esa hora.
    const abre = p.espera_hasta != null ? Math.max(p.horario?.[0] ?? 0, Math.min(p.espera_hasta, p.horario?.[1] ?? p.espera_hasta)) : p.horario?.[0];
    if (abre != null && t < abre) { espera = abre - t; t = abre; }
    // Sin ubicar no se sabe a qué hora llega: no cuenta como tarde.
    const late = aca && p.horario && llega > p.horario[1] ? llega - p.horario[1] : 0;
    tarde += late;
    if (p.estricto) tardeFija += late;
    const servicio = servicioDe(p.movimientos.length + (p.encargos?.length ?? 0));
    paradas.push({ clave: p.clave, llega, espera, tarde: late, servicio, tramo: tr, incierta: dudosa });
    t += servicio;
    if (aca) prev = aca;
  });
  // La vuelta: al lugar donde termina; si termina en la última parada, no hay.
  const vuelta: Tramo = destino === 'ultima' ? { km: 0, min: 0, nivel: nivelDe(factorTransito(t)), estimado: false, sinUbicar: false, falta: null } : tramo(prev, destino, orden.length);
  km += vuelta.km;
  const fin = t + vuelta.min;
  // Lo que cuesta cada orden: el tiempo en la calle, más llegar tarde (a una hora fijada, mucho más).
  return { paradas, vuelta, fin, km, tarde, sinUbicar, costo: fin - salida + tarde * 6 + tardeFija * 40, incierta };
}

// El orden más corto: primero el vecino más cercano y después se prueba mover y dar vuelta tramos mientras mejore. Tiene
// en cuenta el horario de cada lugar (llegar tarde cuesta) y las horas fijadas a mano (cuesta mucho más). Las paradas sin
// ubicar quedan al final, como estaban.
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

// Dónde entra una parada nueva en un recorrido que alguien ordenó a mano: en el lugar que menos lo alarga. Sin ubicar, al
// final. Devuelve la posición. La usan el servidor y la Ruta del día («Pasar a…»).
export function dondeEntra(salida: Punto | null, fin: Destino, actual: ParadaRuta[], p: ParadaRuta, hora: number) {
  if (!salida || p.lat == null || p.lng == null) return actual.length;
  let mejor = actual.length, costo = Infinity;
  for (let i = 0; i <= actual.length; i++) {
    const c = simular(salida, [...actual.slice(0, i), p, ...actual.slice(i)], hora, null, fin).costo;
    if (c < costo - 0.01) { costo = c; mejor = i; }
  }
  return mejor;
}

// Una hora fijada a mano: el horario en el que hay que llegar. «A las 12:00» es de 11:45 a 12:15; «entre las 10 y las 13»
// es ese rango (`hasta`).
export type ModoHora = 'a_las' | 'antes' | 'desde' | 'entre';
export interface Pactada { modo: ModoHora; min: number; hasta?: number | null }
export const TOLERANCIA = 15;
export const ventanaPactada = (p: Pactada): [number, number] =>
  p.modo === 'entre' ? [p.min, Math.max(p.min, p.hasta ?? p.min)] : p.modo === 'antes' ? [0, p.min] : p.modo === 'desde' ? [p.min, 24 * 60 - 1] : [Math.max(0, p.min - TOLERANCIA), Math.min(24 * 60 - 1, p.min + TOLERANCIA)];
export const textoPactada = (p: Pactada) => p.modo === 'entre' ? `Entre las ${hhmm(p.min)} y las ${hhmm(p.hasta ?? p.min)}` : `${p.modo === 'antes' ? 'Antes de las' : p.modo === 'desde' ? 'Desde las' : 'A las'} ${hhmm(p.min)}`;

export const hhmm = (m: number) => { const x = Math.round(m); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
export const duracion = (m: number) => { const x = Math.round(m); return x < 60 ? `${x} min` : `${Math.floor(x / 60)} h ${String(x % 60).padStart(2, '0')}`; };
