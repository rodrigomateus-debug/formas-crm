import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { Budget, OutOfBudget } from './budget';
import { norm } from './clickup';
import { esDia, hoyBsAs, listarTransportistas, lugarFin, lugarSalida, puedeEditarCronograma, rutaDelDia, sumarDias, type Parada, type RutaGuardada } from './cronograma';
import { claveOrden, distanciaKm, servicioDe, simular, type Destino, type ParadaRuta, type Punto, type TramosReales } from '../../web/src/ruta';

// Rendimiento de los choferes (pedido de Rodrigo del 17/11/2026; docs/RENDIMIENTO.md): qué recorrido hizo cada chofer cada
// día, en km y en tiempo, para sacar promedios por chofer y, más adelante, costo por km.
//
// - El plan: una foto del recorrido cuando el chofer sale (o marca la primera parada); si nadie avisó nada, al cerrar el día.
// - Lo que pasó: las paradas que marcó en la app, en el orden en que las marcó. Los km son por calles (servicio de rutas
//   OSRM) pasando por esas paradas; si el servicio no contesta, en línea recta por 1,35 y el día queda como «estimado».
// - La salida y la llegada: del GPS de la app (con la app abierta detecta que se alejó del punto de salida o que volvió),
//   del botón («Salgo», «Terminé») o, si no hay ninguna de las dos, estimadas con la primera y la última parada.
// - El día se cierra solo a la noche (`cerrarPendientes`, desde el cron); se puede volver a calcular a mano.
//
// La app del chofer es una página web: solo recibe la ubicación mientras está abierta y en pantalla. No se sigue el viaje
// entero: se guarda el punto en los momentos en que el chofer la usa.

type Origen = 'gps' | 'boton' | 'marca' | 'estimada' | 'manual';
interface PuntoPlan { nombre: string; lat: number | null; lng: number | null }
interface ParadaPlan { clave: string; nombre: string; lat: number | null; lng: number | null; n: number; horario: [number, number] | null; espera_hasta?: number | null; estricto?: boolean }
export interface Plan { salida: number; base: PuntoPlan; fin: PuntoPlan | null; paradas: ParadaPlan[] }
// Cada parada del recorrido como quedó: `orden` es el lugar en que la hizo (null: no la hizo); `lejos`, a cuántos metros
// de la parada estaba cuando la marcó (si dio la ubicación).
export interface Paso { clave: string; nombre: string; resultado: 'hecho' | 'no_se_pudo' | 'sin_marca' | 'sin_visitar'; at: string | null; orden: number | null; km: number | null; lejos: number | null }
interface Fila {
  fecha: string; n: number; chofer: string; plan: string | null; plan_at: string | null; plan_km: number | null; plan_min: number | null; plan_paradas: number | null;
  salida_at: string | null; salida_origen: Origen | null; salida_lat: number | null; salida_lng: number | null;
  llegada_at: string | null; llegada_origen: Origen | null; llegada_lat: number | null; llegada_lng: number | null;
  km: number | null; min_manejo: number | null; hechas: number | null; no_se_pudo: number | null; sin_visitar: number | null;
  estimado: number; detalle: string | null; cerrado_at: string | null; corregido_por: number | null; corregido_at: string | null;
}
type RutaDia = Awaited<ReturnType<typeof rutaDelDia>>;

// Las cuentas de la noche no las pide nadie: corren como el Hub.
const HUB = { id: 0, email: '', name: 'Hub', role: 'admin', profile: 'admin', team_id: null, active: 1 } as User;
const OSRM = (env: Env) => (env.OSRM_URL ?? 'https://router.project-osrm.org').replace(/\/$/, '');
const punto = (p: { lat: number | null; lng: number | null } | null | undefined): Punto | null => (p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);
const exigir = (u: User) => { if (!puedeEditarCronograma(u)) throw new HttpError(403, 'El rendimiento de los recorridos lo ven Logística, Producción y los administradores.'); };
const numero = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const redondo = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
// Sin servicio de rutas: línea recta por 1,35, a 38 km/h (lo mismo que la ruta del día).
const recto = (a: Punto, b: Punto) => { const km = distanciaKm(a, b) * 1.35; return { km, min: (km / 38) * 60 }; };
// Lo que tarda de más un tramo en horario de trabajo (la ruta del día usa entre 1,3 y 1,65 según la hora).
const TRANSITO = 1.4;

function planDe(r: RutaDia, x: RutaGuardada): Plan {
  const porClave = new Map(r.paradas.map((p) => [p.clave, p]));
  const base = lugarSalida(x, r.bases), fin = lugarFin(x, r.bases);
  return {
    salida: x.salida, base: { nombre: base.nombre, lat: base.lat, lng: base.lng }, fin: fin ? { nombre: fin.nombre, lat: fin.lat, lng: fin.lng } : null,
    paradas: x.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p).map((p) => ({
      clave: p.clave, nombre: p.nombre, lat: p.lat, lng: p.lng, n: p.movimientos.length + p.encargos.length, horario: p.horario,
      espera_hasta: p.espera_hasta ?? null, ...(p.estricto ? { estricto: true } : {}) })),
  };
}

// El camino por calles entre esos puntos, en orden: km y minutos (con la calle libre) de cada tramo. null si el servicio no
// contesta. Lo que ya se pidió queda guardado.
async function camino(env: Env, pts: Punto[], b: Budget): Promise<Array<{ km: number; min: number }> | null> {
  if (pts.length < 2) return [];
  const clave = pts.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const ya = await env.DB.prepare('SELECT tramos FROM caminos WHERE clave = ?').bind(clave).first<{ tramos: string }>();
  if (ya) return JSON.parse(ya.tramos) as Array<{ km: number; min: number }>;
  b.take();
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 12_000);
  try {
    const res = await fetch(`${OSRM(env)}/route/v1/driving/${clave}?overview=false`, { signal: corte.signal, headers: { 'user-agent': 'formas-crm/1.0 (rendimiento de recorridos)' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { routes?: Array<{ legs?: Array<{ distance: number; duration: number }> }> };
    const legs = j.routes?.[0]?.legs;
    if (!legs || legs.length !== pts.length - 1) return null;
    const tramos = legs.map((l) => ({ km: redondo(l.distance / 1000, 3), min: redondo(l.duration / 60, 2) }));
    await env.DB.prepare('INSERT OR REPLACE INTO caminos (clave, tramos, at) VALUES (?, ?, ?)').bind(clave, JSON.stringify(tramos), now()).run();
    return tramos;
  } catch (e) {
    console.error('rendimiento: servicio de rutas', (e as Error).message);
    return null;
  } finally { clearTimeout(reloj); }
}

// Los km y el tiempo que daba el plan: la misma cuenta de la ruta del día (tránsito según la hora, tiempo en cada parada y
// esperas por horario), con las distancias por calles.
async function medirPlan(env: Env, plan: Plan, b: Budget) {
  const base = punto(plan.base), destino: Destino = plan.fin ? punto(plan.fin) : 'ultima';
  const orden: ParadaRuta[] = plan.paradas.map((p) => ({ clave: p.clave, lat: p.lat, lng: p.lng, horario: p.horario, movimientos: Array.from({ length: p.n }),
    espera_hasta: p.espera_hasta ?? null, estricto: p.estricto }));
  const ubicadas = orden.map(punto).filter((p): p is Punto => !!p), fin = destino !== 'ultima' ? destino : null;
  let reales: TramosReales | null = null;
  if (base && ubicadas.length) {
    const legs = await camino(env, [base, ...ubicadas, ...(fin ? [fin] : [])], b);
    if (legs) {
      let k = 0;
      const nada = { km: 0, min: 0 };
      reales = { clave: claveOrden(base, orden, destino), tramos: [...orden.map((p) => (punto(p) ? legs[k++] : nada)), fin ? legs[k] : nada] };
    }
  }
  const sim = simular(base, orden, plan.salida, reales, destino);
  return { km: sim.km, min: sim.fin - plan.salida, estimado: !reales || sim.incierta };
}

const leer = (db: D1Database, fecha: string, n: number) => db.prepare('SELECT * FROM recorridos_medidos WHERE fecha = ? AND n = ?').bind(fecha, n).first<Fila>();

// La fila del recorrido, con la foto del plan la primera vez (cuando el chofer avisa que sale o marca la primera parada).
async function asegurar(env: Env, fecha: string, n: number, chofer: string): Promise<Fila | null> {
  const ya = await leer(env.DB, fecha, n);
  if (ya && norm(ya.chofer) === norm(chofer)) return ya;
  const r = await rutaDelDia(env, HUB, fecha);
  const x = r.guardada ? r.rutas.find((y) => y.n === n && y.chofer && norm(y.chofer) === norm(chofer)) : null;
  if (!x) return null;
  // Logística le pasó ese recorrido a este chofer durante el día: lo que había anotado era del otro.
  if (ya) await env.DB.prepare('DELETE FROM recorridos_medidos WHERE fecha = ? AND n = ?').bind(fecha, n).run();
  const plan = planDe(r, x);
  await env.DB.prepare('INSERT OR IGNORE INTO recorridos_medidos (fecha, n, chofer, plan, plan_at, plan_paradas) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(fecha, n, x.chofer, JSON.stringify(plan), now(), plan.paradas.length).run();
  return leer(env.DB, fecha, n);
}

// La hora que manda el celular vale si es de hace poco (pudo quedar esperando la señal); si no, la del servidor.
function horaDe(at: unknown) {
  const t = typeof at === 'string' ? Date.parse(at) : NaN, ahora = Date.now();
  return Number.isFinite(t) && t <= ahora + 5 * 60_000 && t >= ahora - 12 * 3600_000 ? new Date(Math.min(t, ahora)).toISOString() : new Date(ahora).toISOString();
}

// El chofer sale o termina (app del chofer): con el botón o porque la app, abierta, vio que se alejó del punto de salida o
// que volvió. De la salida vale la primera; de la llegada, la última. `quitar` la saca (se equivocó de botón). Lo que
// corrigió Logística a mano no se pisa.
export async function anotarEvento(env: Env, chofer: string, b: { n?: unknown; tipo?: unknown; origen?: unknown; at?: unknown; lat?: unknown; lng?: unknown; quitar?: unknown }) {
  const fecha = hoyBsAs(), n = Number(b.n);
  const tipo = b.tipo === 'llegada' ? 'llegada' : b.tipo === 'salida' ? 'salida' : null;
  if (!tipo || !Number.isInteger(n)) throw new HttpError(400, 'Falta qué pasó (salida o llegada) y de qué recorrido.');
  const origen: Origen = b.origen === 'gps' ? 'gps' : 'boton';
  const f = await asegurar(env, fecha, n, chofer);
  if (!f || norm(f.chofer) !== norm(chofer)) throw new HttpError(404, 'Ese recorrido no es tuyo hoy. Puede que Logística lo haya cambiado: actualizá la pantalla.');
  const actual = tipo === 'salida' ? { at: f.salida_at, origen: f.salida_origen } : { at: f.llegada_at, origen: f.llegada_origen };
  const lat = numero(b.lat), lng = numero(b.lng), at = horaDe(b.at);
  const firme = actual.origen === 'gps' || actual.origen === 'boton';
  let poner: { at: string | null; origen: Origen | null; lat: number | null; lng: number | null } | null = null;
  if (actual.origen === 'manual') poner = null;
  else if (b.quitar) poner = firme ? { at: null, origen: null, lat: null, lng: null } : null;
  else if (!firme || !actual.at || (tipo === 'salida' ? at < actual.at : at > actual.at)) poner = { at, origen, lat, lng };
  if (poner) {
    await env.DB.prepare(`UPDATE recorridos_medidos SET ${tipo}_at = ?, ${tipo}_origen = ?, ${tipo}_lat = ?, ${tipo}_lng = ? WHERE fecha = ? AND n = ?`)
      .bind(poner.at, poner.origen, poner.lat, poner.lng, fecha, n).run();
  }
  const x = (await leer(env.DB, fecha, n))!;
  return { ok: true, medicion: medicionDe(x) };
}

// Lo que la app del chofer necesita saber de su recorrido: si ya avisó que salió y que terminó.
const medicionDe = (f: Fila | null | undefined) => ({
  salida_at: f && (f.salida_origen === 'gps' || f.salida_origen === 'boton' || f.salida_origen === 'manual') ? f.salida_at : null,
  llegada_at: f && (f.llegada_origen === 'gps' || f.llegada_origen === 'boton' || f.llegada_origen === 'manual') ? f.llegada_at : null,
});
export async function conMedicion<T extends { n: number }>(db: D1Database, fecha: string, chofer: string, recorridos: T[]) {
  if (!recorridos.length) return recorridos.map((r) => ({ ...r, medicion: medicionDe(null) }));
  // Solo lo anotado de este chofer: si el recorrido era de otro hasta hace un rato, lo del otro no cuenta.
  const filas = (await db.prepare('SELECT * FROM recorridos_medidos WHERE fecha = ?').bind(fecha).all<Fila>()).results.filter((f) => norm(f.chofer) === norm(chofer));
  return recorridos.map((r) => ({ ...r, medicion: medicionDe(filas.find((f) => f.n === r.n)) }));
}

// Después de que el chofer marca una parada: dónde estaba (si mandó la ubicación) y, la primera vez, la foto del plan. No
// frena ni rompe la marca: corre atrás.
export async function anotarMarca(env: Env, chofer: string, b: { clave?: unknown; lat?: unknown; lng?: unknown }) {
  const fecha = hoyBsAs(), clave = String(b.clave ?? ''), lat = numero(b.lat), lng = numero(b.lng);
  if (!clave) return;
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    await env.DB.prepare('UPDATE cronograma_visitas SET lat = ?, lng = ? WHERE fecha = ? AND clave = ?').bind(lat, lng, fecha, clave).run();
  }
  const rutas = (await env.DB.prepare('SELECT n, chofer, orden FROM cronograma_rutas WHERE fecha = ? AND chofer IS NOT NULL').bind(fecha).all<{ n: number; chofer: string; orden: string }>()).results
    .filter((x) => norm(x.chofer) === norm(chofer));
  if (!rutas.length) return;
  const suya = rutas.find((x) => { try { return (JSON.parse(x.orden) as unknown[]).map(String).includes(clave); } catch { return false; } }) ?? rutas[0];
  await asegurar(env, fecha, suya.n, chofer);
}

// Una parada cuenta como hecha sin marca del chofer cuando alguien la marcó desde el Hub (sus artículos y encargos hechos).
const hechaSinMarca = (p: Parada) => p.movimientos.length + p.encargos.length > 0 && p.movimientos.every((m) => m.hecho) && p.encargos.every((e) => e.estado === 'hecho');
const minutos = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

// Mide los recorridos de un día: el plan y lo que pasó. Los expresos no cuentan (su costo es por envío). Devuelve cuántos
// recorridos quedaron medidos. Si se llega al tope de consultas, corta (OutOfBudget) y sigue en la próxima.
export async function medirDia(env: Env, fecha: string, b: Budget = Budget.of(env)) {
  if (!esDia(fecha)) throw new HttpError(400, 'Falta el día (AAAA-MM-DD).');
  const db = env.DB, hoy = hoyBsAs();
  if (fecha > hoy) throw new HttpError(400, 'Ese día todavía no llegó.');
  const r = await rutaDelDia(env, HUB, fecha);
  const expresos = new Set((await listarTransportistas(db)).filter((t) => t.tipo === 'expreso').map((t) => norm(t.nombre)));
  const marcas = new Map((await db.prepare('SELECT clave, lat, lng FROM cronograma_visitas WHERE fecha = ?').bind(fecha).all<{ clave: string; lat: number | null; lng: number | null }>()).results.map((x) => [x.clave, x]));
  const porClave = new Map(r.paradas.map((p) => [p.clave, p]));
  const cerrar = fecha < hoy ? now() : null;
  let medidos = 0;
  for (const x of r.guardada ? r.rutas : []) {
    if (!x.chofer || expresos.has(norm(x.chofer))) continue;
    // Lo anotado de ese recorrido vale si es del mismo chofer; si Logística lo cambió de chofer, se empieza de nuevo.
    const anotada = await leer(db, fecha, x.n);
    const previa = anotada && norm(anotada.chofer) === norm(x.chofer) ? anotada : null;
    if (anotada && !previa) await db.prepare('DELETE FROM recorridos_medidos WHERE fecha = ? AND n = ?').bind(fecha, x.n).run();
    const delPlan = previa?.plan ? (JSON.parse(previa.plan) as Plan) : null;
    const paradas = x.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p);
    if (!paradas.length && !delPlan) continue;   // un recorrido vacío: nada que medir
    const plan = delPlan ?? planDe(r, x);
    const planMedido = await medirPlan(env, plan, b);

    // Lo que hizo: las que marcó, en el orden en que las marcó; las hechas desde el Hub, donde estaban en el plan.
    const marcada = (p: Parada) => !!p.visita && p.visita.resultado !== 'salteada';
    const conHora = paradas.filter(marcada).sort((a, c) => a.visita!.at.localeCompare(c.visita!.at));
    const seq = [...conHora];
    paradas.forEach((p, i) => {
      if (marcada(p) || !hechaSinMarca(p)) return;
      let j = -1;
      for (let k = i - 1; k >= 0 && j < 0; k--) j = seq.indexOf(paradas[k]);
      seq.splice(j + 1, 0, p);
    });
    const base = punto(plan.base) ?? punto(lugarSalida(x, r.bases));
    const finLugar = lugarFin(x, r.bases), fin = finLugar ? punto(finLugar) : null;
    const ubicadas = seq.filter((p) => punto(p));
    const pts = base && ubicadas.length ? [base, ...ubicadas.map((p) => punto(p)!), ...(fin ? [fin] : [])] : [];
    const legs = pts.length ? await camino(env, pts, b) : [];
    const tramos = legs ?? pts.slice(1).map((p, i) => recto(pts[i], p));
    const km = tramos.reduce((s, t) => s + t.km, 0), manejo = tramos.reduce((s, t) => s + t.min, 0);
    const estimado = !!(seq.length && (!legs || !base || ubicadas.length < seq.length || (finLugar && !fin)));

    const pasos: Paso[] = paradas.map((p) => {
      const orden = seq.indexOf(p), u = ubicadas.indexOf(p), m = marcas.get(p.clave), aca = punto(p), donde = punto(m);
      return {
        clave: p.clave, nombre: p.nombre, at: marcada(p) ? p.visita!.at : null, orden: orden >= 0 ? orden + 1 : null,
        resultado: marcada(p) ? (p.visita!.resultado as 'hecho' | 'no_se_pudo') : orden >= 0 ? 'sin_marca' : 'sin_visitar',
        km: u >= 0 && tramos[u] ? redondo(tramos[u].km, 2) : null, lejos: marcada(p) && aca && donde ? Math.round(distanciaKm(aca, donde) * 1000) : null,
      };
    });
    const hechas = pasos.filter((p) => p.resultado === 'hecho' || p.resultado === 'sin_marca').length;
    const noSePudo = pasos.filter((p) => p.resultado === 'no_se_pudo').length;

    // La salida y la llegada: lo que avisó la app o corrigió Logística; si no, estimadas con la primera y la última marca.
    const primera = conHora[0], ultima = conHora[conHora.length - 1];
    let salida = { at: previa?.salida_at ?? null, origen: previa?.salida_origen ?? null };
    if (!(salida.at && (salida.origen === 'gps' || salida.origen === 'boton' || salida.origen === 'manual'))) {
      const viaje = primera && seq[0] === primera && ubicadas[0] === primera && tramos[0] ? tramos[0].min * TRANSITO : 0;
      salida = primera ? { at: minutos(primera.visita!.at, -(servicioDe(primera.movimientos.length + primera.encargos.length) + viaje)), origen: 'estimada' } : { at: null, origen: null };
    }
    let llegada = { at: previa?.llegada_at ?? null, origen: previa?.llegada_origen ?? null };
    const firme = !!llegada.at && (llegada.origen === 'manual' || ((llegada.origen === 'gps' || llegada.origen === 'boton') && (!ultima || llegada.at! >= ultima.visita!.at)));
    if (!firme) {
      if (!ultima) llegada = { at: null, origen: null };
      else if (!finLugar) llegada = { at: ultima.visita!.at, origen: 'marca' };   // termina en la última parada: llegó cuando la marcó
      else {
        const vuelta = fin && seq[seq.length - 1] === ultima && ubicadas[ubicadas.length - 1] === ultima && tramos.length === ubicadas.length + 1 ? tramos[tramos.length - 1].min * TRANSITO : 0;
        llegada = { at: minutos(ultima.visita!.at, vuelta), origen: 'estimada' };
      }
    }
    // Mientras se hacía la cuenta pudo llegar un aviso de la app (salió, llegó): si lo que se va a guardar es una estimación
    // y la fila ya tiene un aviso firme, el aviso queda. El punto del aviso se borra solo si cambia de dónde sale la hora.
    const FIRME = "('gps', 'boton', 'manual')";
    const blanda = (o: Origen | null) => (o === 'gps' || o === 'boton' || o === 'manual' ? 0 : 1);
    const dejaS = `(?21 = 1 AND recorridos_medidos.salida_origen IN ${FIRME})`;
    const dejaL = `(?22 = 1 AND recorridos_medidos.llegada_origen IN ${FIRME})`;
    const previaFirme = previa?.llegada_origen === 'gps' || previa?.llegada_origen === 'boton' || previa?.llegada_origen === 'manual';
    await db.prepare(`INSERT INTO recorridos_medidos (fecha, n, chofer, plan, plan_at, plan_km, plan_min, plan_paradas, salida_at, salida_origen, llegada_at, llegada_origen,
        km, min_manejo, hechas, no_se_pudo, sin_visitar, estimado, detalle, cerrado_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
      ON CONFLICT(fecha, n) DO UPDATE SET chofer = excluded.chofer, plan = excluded.plan, plan_at = excluded.plan_at, plan_km = excluded.plan_km, plan_min = excluded.plan_min,
        plan_paradas = excluded.plan_paradas,
        salida_lat = CASE WHEN ${dejaS} OR excluded.salida_origen IS recorridos_medidos.salida_origen THEN recorridos_medidos.salida_lat ELSE NULL END,
        salida_lng = CASE WHEN ${dejaS} OR excluded.salida_origen IS recorridos_medidos.salida_origen THEN recorridos_medidos.salida_lng ELSE NULL END,
        salida_at = CASE WHEN ${dejaS} THEN recorridos_medidos.salida_at ELSE excluded.salida_at END,
        salida_origen = CASE WHEN ${dejaS} THEN recorridos_medidos.salida_origen ELSE excluded.salida_origen END,
        llegada_lat = CASE WHEN ${dejaL} OR excluded.llegada_origen IS recorridos_medidos.llegada_origen THEN recorridos_medidos.llegada_lat ELSE NULL END,
        llegada_lng = CASE WHEN ${dejaL} OR excluded.llegada_origen IS recorridos_medidos.llegada_origen THEN recorridos_medidos.llegada_lng ELSE NULL END,
        llegada_at = CASE WHEN ${dejaL} THEN recorridos_medidos.llegada_at ELSE excluded.llegada_at END,
        llegada_origen = CASE WHEN ${dejaL} THEN recorridos_medidos.llegada_origen ELSE excluded.llegada_origen END,
        km = excluded.km, min_manejo = excluded.min_manejo, hechas = excluded.hechas, no_se_pudo = excluded.no_se_pudo, sin_visitar = excluded.sin_visitar,
        estimado = excluded.estimado, detalle = excluded.detalle, cerrado_at = excluded.cerrado_at`)
      .bind(fecha, x.n, x.chofer, JSON.stringify(plan), delPlan ? previa!.plan_at : now(), redondo(planMedido.km, 2), redondo(planMedido.min), plan.paradas.length,
        salida.at, salida.origen, llegada.at, llegada.origen, seq.length ? redondo(km, 2) : null, seq.length ? redondo(manejo) : null, hechas, noSePudo,
        pasos.filter((p) => p.resultado === 'sin_visitar').length, estimado || planMedido.estimado ? 1 : 0, JSON.stringify(pasos), cerrar,
        blanda(salida.origen), blanda(llegada.origen) && !previaFirme ? 1 : 0).run();
    medidos++;
  }
  // Lo que quedó de un recorrido que ya no existe o cambió de chofer (y no era de nadie que haya avisado algo) se saca.
  const vivos = new Set((r.guardada ? r.rutas : []).filter((x) => x.chofer && !expresos.has(norm(x.chofer))).map((x) => x.n));
  for (const f of (await db.prepare('SELECT n FROM recorridos_medidos WHERE fecha = ?').bind(fecha).all<{ n: number }>()).results) {
    if (!vivos.has(f.n)) await db.prepare('DELETE FROM recorridos_medidos WHERE fecha = ? AND n = ?').bind(fecha, f.n).run();
  }
  if (cerrar) await db.prepare('INSERT OR REPLACE INTO rendimiento_dias (fecha, cerrado_at, recorridos) VALUES (?, ?, ?)').bind(fecha, cerrar, medidos).run();
  return { fecha, recorridos: medidos };
}

// Desde el cron, de noche: cierra el último día con recorridos que quedó sin cerrar (uno por corrida; los de los últimos 10
// días). Si no hay nada, no hace ninguna consulta a otro servicio.
export async function cerrarPendientes(env: Env, b: Budget = Budget.of(env)) {
  const hoy = hoyBsAs();
  const d = await env.DB.prepare(`SELECT DISTINCT fecha FROM cronograma_rutas WHERE chofer IS NOT NULL AND fecha < ?1 AND fecha >= ?2
      AND fecha NOT IN (SELECT fecha FROM rendimiento_dias) ORDER BY fecha DESC LIMIT 1`).bind(hoy, sumarDias(hoy, -10)).first<{ fecha: string }>();
  if (!d) return null;
  try { return await medirDia(env, d.fecha, b); }
  catch (e) { if (e instanceof OutOfBudget) return null; throw e; }
}

// ---------- Para la pantalla «Rendimiento» ----------

const aFila = (f: Fila) => ({
  fecha: f.fecha, n: f.n, chofer: f.chofer, plan_km: f.plan_km, plan_min: f.plan_min, plan_paradas: f.plan_paradas,
  salida_at: f.salida_at, salida_origen: f.salida_origen, llegada_at: f.llegada_at, llegada_origen: f.llegada_origen,
  // Las horas en la calle: de la salida a la llegada.
  min: f.salida_at && f.llegada_at && f.llegada_at > f.salida_at ? redondo((Date.parse(f.llegada_at) - Date.parse(f.salida_at)) / 60_000) : null,
  km: f.km, min_manejo: f.min_manejo, hechas: f.hechas ?? 0, no_se_pudo: f.no_se_pudo ?? 0, sin_visitar: f.sin_visitar ?? 0,
  estimado: !!f.estimado, cerrado: !!f.cerrado_at, corregido: !!f.corregido_at,
  pasos: f.detalle ? (JSON.parse(f.detalle) as Paso[]) : [],
  plan: f.plan ? (JSON.parse(f.plan) as Plan).paradas.map((p) => p.nombre) : [],
});

export async function rendimiento(env: Env, user: User, q: { desde?: string; hasta?: string }) {
  exigir(user);
  const hoy = hoyBsAs();
  const hasta = esDia(q.hasta) ? q.hasta : hoy, desde = esDia(q.desde) ? q.desde : sumarDias(hasta, -30);
  if (desde > hasta || sumarDias(desde, 400) < hasta) throw new HttpError(400, 'El período tiene que ser de hasta 400 días.');
  const filas = (await env.DB.prepare('SELECT * FROM recorridos_medidos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, n').bind(desde, hasta).all<Fila>()).results;
  const propios = (await env.DB.prepare("SELECT nombre, propio FROM transportistas WHERE tipo = 'chofer'").all<{ nombre: string; propio: number }>()).results;
  // Los días del período con recorridos armados que todavía no se midieron (para «Traer los días que faltan»).
  const faltan = (await env.DB.prepare(`SELECT DISTINCT fecha FROM cronograma_rutas WHERE chofer IS NOT NULL AND fecha BETWEEN ?1 AND ?2 AND fecha < ?3
      AND fecha NOT IN (SELECT fecha FROM rendimiento_dias) ORDER BY fecha DESC`).bind(desde, hasta, hoy).all<{ fecha: string }>()).results.map((x) => x.fecha);
  return {
    desde, hasta, hoy, filas: filas.map(aFila), faltan,
    choferes: [...new Set(filas.map((f) => f.chofer))].map((nombre) => ({ nombre, propio: !!propios.find((p) => norm(p.nombre) === norm(nombre))?.propio })),
  };
}

// Volver a calcular un día (o traer uno de antes). Uno por pedido: cada día consulta al servicio de rutas.
export async function medirAMano(env: Env, ctx: Ctx, b: { fecha?: unknown }) {
  exigir(ctx.user);
  return medirDia(env, String(b.fecha ?? ''));
}

// Logística corrige la hora de salida o de llegada de un recorrido («08:40»; vacío: vuelve a lo que diga la app o la
// estimación). Queda quién lo cambió.
export async function corregir(env: Env, ctx: Ctx, fecha: string, n: number, b: { salida?: unknown; llegada?: unknown }) {
  exigir(ctx.user);
  const f = esDia(fecha) && Number.isInteger(n) ? await leer(env.DB, fecha, n) : null;
  if (!f) throw new HttpError(404, 'Ese recorrido no está medido.');
  for (const tipo of ['salida', 'llegada'] as const) {
    const v = b[tipo];
    if (v === undefined) continue;
    const hora = String(v ?? '').trim();
    if (hora && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(hora)) throw new HttpError(400, 'La hora va como 08:40.');
    // La hora es la de Buenos Aires (UTC−3). Una llegada antes que la salida es del día siguiente (pasada la medianoche): no se acepta.
    const at = hora ? new Date(`${fecha}T${hora.padStart(5, '0')}:00-03:00`).toISOString() : null;
    await env.DB.prepare(`UPDATE recorridos_medidos SET ${tipo}_at = ?, ${tipo}_origen = ?, ${tipo}_lat = NULL, ${tipo}_lng = NULL, corregido_por = ?, corregido_at = ? WHERE fecha = ? AND n = ?`)
      .bind(at, at ? 'manual' : null, ctx.user.id, now(), fecha, n).run();
  }
  const x = (await leer(env.DB, fecha, n))!;
  if (x.salida_at && x.llegada_at && x.llegada_at <= x.salida_at && x.salida_origen === 'manual' && x.llegada_origen === 'manual') {
    throw new HttpError(400, 'La llegada tiene que ser después de la salida.');
  }
  await medirDia(env, fecha);   // lo que se vació vuelve a estimarse
  return aFila((await leer(env.DB, fecha, n))!);
}

// El vehículo de ese chofer es de Formas o es externo.
export async function marcarPropio(env: Env, ctx: Ctx, b: { nombre?: unknown; propio?: unknown }) {
  exigir(ctx.user);
  const nombre = String(b.nombre ?? '').replace(/\s+/g, ' ').trim();
  if (nombre.length < 2) throw new HttpError(400, 'Falta el chofer.');
  const todos = (await env.DB.prepare('SELECT id, nombre FROM transportistas').all<{ id: number; nombre: string }>()).results;
  const ya = todos.find((x) => norm(x.nombre) === norm(nombre));
  if (ya) await env.DB.prepare('UPDATE transportistas SET propio = ? WHERE id = ?').bind(b.propio ? 1 : 0, ya.id).run();
  else await env.DB.prepare("INSERT INTO transportistas (nombre, tipo, propio, created_by) VALUES (?, 'chofer', ?, ?)").bind(nombre, b.propio ? 1 : 0, ctx.user.id).run();
  return { ok: true };
}
