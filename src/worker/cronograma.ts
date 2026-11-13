import Anthropic from '@anthropic-ai/sdk';
import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { Budget } from './budget';
import { norm } from './clickup';
import { CERRADOS, claveProveedor, editarProduccion, estadosPec, lista, refrescarPdv, type FilaDb } from './produccion';
import { finnegansPedidoVenta, finnegansToken } from './finnegans';
import { updateRecord } from './records';
import { direccionDesdeRuta, direccionesDePedidos } from './direcciones';
import { MODELO } from './remitos';
import { optimizar, simular, type Destino, type Punto } from '../../web/src/ruta';

// Cronograma (pedido de Rodrigo del 12/11/2026): reemplaza la planilla «Cronograma Semanal» de Logística. La planilla
// repetía a mano lo que ya está en ClickUp, y las dos se desfasaban. Acá los movimientos no se cargan: salen de las
// fechas de cada artículo (tabla `produccion`, que llena la sincronización de ClickUp):
//
//   Entregas  ← ENTREGAS (FECHA REAL)          Retiros ← RETIROS (PROVEEDOR) y RETIRO (IMPRESOR)
//   Ingresos  ← INGRESO (PROVEEDOR)            Egresos ← EGRESO (IMPRESOR)
//
// Mover un movimiento a otro día escribe la fecha en ClickUp; marcarlo como hecho cambia el estado del artículo en
// ClickUp. Vale para todas las unidades, aunque producción todavía trabaje Corporate en ClickUp. Lo único propio son las
// notas sueltas, los feriados, lo que se marcó como hecho y los recorridos de cada día (docs/CRONOGRAMA.md).

export const TIPOS = {
  entrega: { col: 'entrega_real', rol: null, nombre: 'Entrega' },
  ingreso: { col: 'ingreso_proveedor', rol: 'proveedor', nombre: 'Ingreso' },
  retiro_proveedor: { col: 'retiro_proveedor', rol: 'proveedor', nombre: 'Retiro' },
  egreso: { col: 'egreso_impresor', rol: 'impresor', nombre: 'Egreso' },
  retiro_impresor: { col: 'retiro_impresor', rol: 'impresor', nombre: 'Retiro' },
} as const;
export type Tipo = keyof typeof TIPOS;
const esTipo = (t: unknown): t is Tipo => typeof t === 'string' && t in TIPOS;
export const esDia = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

// A qué estado pasa el artículo en ClickUp cuando se marca hecho cada movimiento. Se puede cambiar en la configuración
// del cronograma (settings `cronograma`).
const ESTADO_AL_HACER: Record<Tipo, string> = {
  ingreso: 'en control de depósito', retiro_proveedor: 'en control de depósito', egreso: 'en el impresor',
  retiro_impresor: 'en revision', entrega: 'entregados',
};
// Con el artículo en estos estados, lo anterior a la entrega ya pasó: no se lo vuelve atrás.
const AVANZADOS = ['listo para entergar', 'listo para entregar', 'parcial entregado', 'entregados'];

export interface Base { id: string; nombre: string; direccion: string }
export interface CronogramaConfig { bases: Base[]; estados: Record<Tipo, string> }
const BASES: Base[] = [
  { id: 'roca', nombre: 'Depósito Gral. Roca', direccion: 'General Roca 4250, Florida Oeste, Vicente López, Buenos Aires' },
  { id: 'matienzo', nombre: 'Oficina Matienzo', direccion: 'Matienzo 1308, Florida Oeste, Vicente López, Buenos Aires' },
];
export async function cronogramaConfig(db: D1Database): Promise<CronogramaConfig> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'cronograma'").first<{ value: string }>();
  let c: Partial<CronogramaConfig> = {};
  try { c = r ? JSON.parse(r.value) : {}; } catch { /* rota: la de siempre */ }
  const bases = Array.isArray(c.bases) && c.bases.length ? c.bases.filter((b) => b && b.id && b.direccion) : BASES;
  return { bases: bases.length ? bases : BASES, estados: { ...ESTADO_AL_HACER, ...(c.estados ?? {}) } };
}
export async function guardarCronogramaConfig(db: D1Database, cfg: Partial<CronogramaConfig>) {
  const actual = await cronogramaConfig(db);
  const bases = Array.isArray(cfg.bases) ? cfg.bases.map((b, i) => ({ id: String(b.id || `base${i + 1}`), nombre: String(b.nombre ?? '').trim() || `Base ${i + 1}`, direccion: String(b.direccion ?? '').trim() })).filter((b) => b.direccion) : actual.bases;
  const estados = { ...actual.estados };
  for (const [k, v] of Object.entries(cfg.estados ?? {})) if (esTipo(k) && typeof v === 'string' && v.trim()) estados[k] = v.toLowerCase().trim();
  const nuevo = { bases: bases.length ? bases : actual.bases, estados };
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cronograma', ?)").bind(JSON.stringify(nuevo)).run();
  return nuevo;
}

// Logística, Producción y los administradores editan; el resto mira.
export const puedeEditarCronograma = (u: User) => u.role !== 'viewer' && (u.role === 'admin' || u.profile === 'logistica' || u.profile === 'produccion');
function exigir(ctx: Ctx) {
  if (!puedeEditarCronograma(ctx.user)) throw new HttpError(403, 'El cronograma lo editan Logística, Producción y los administradores.');
}

// ---------- Los movimientos ----------

export interface Movimiento {
  id: string; tipo: Tipo; fecha: string; task_id: string; pdv_task: string; npdv: string | null; cliente: string | null; unidad: string | null;
  record_id: number | null; articulo: string; cantidad: number | null; estado: string; lugar: string | null; company_id: number | null;
  hecho: boolean; hecho_por: number | null; evento: boolean; avisos: string[]; url: string | null;
  expreso?: { nombre: string; guia: string | null } | null;   // la entrega va por un expreso (entrega_expresos)
  dominio?: string | null;   // el dominio de la empresa de la tarjeta (el cliente en las entregas; si no, el proveedor o impresor), para su logo
  chofer?: string | null;    // en la semana: el chofer (o expreso) del recorrido del día en el que está su parada
  retira_en?: string | null; // en la semana: lo retira el cliente en Formas (tarjeta «Entrega»), así que no es parada de nadie
}
// La parada de la ruta del día en la que cae un movimiento: la entrega, en la de su PDV; un retiro o un egreso, en la de
// esa empresa (tres retiros en el mismo impresor son una parada). No depende de la dirección. Un pedido que va a varias
// direcciones tiene además las paradas «:2», «:3»… (rutaDelDia).
export const claveParada = (m: Pick<Movimiento, 'tipo' | 'pdv_task' | 'company_id' | 'lugar'>) =>
  m.tipo === 'entrega' ? `p:${m.pdv_task}` : m.company_id ? `e:${m.company_id}` : `o:${norm(m.lugar ?? 'Sin proveedor')}`;
export const esDeLaParada = (clave: string, base: string) => clave === base || clave.startsWith(`${base}:`);
type FilaMov = FilaDb & { pdv_npdv: string | null; pdv_cliente: string | null; pdv_unidad: string | null; pdv_record: number | null; pdv_entrega: string | null; evento: string | null; pactada: string | null };
interface Opcion { campo: string; option_id: string; nombre: string; company_id: number | null; empresa: string | null }

export const sumarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const diaSemana = (dia: string) => new Date(`${dia}T12:00:00Z`).getUTCDay();
export const hoyBsAs = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
// El nombre del artículo sin la coletilla que le pone ClickUp («Necessaire - Proveedor»).
const nombreArticulo = (s: string) => s.replace(/\s+-\s+(proveedor|impresor|stock)\s*$/i, '').trim();

const SELECT_MOV = `SELECT a.*, p.npdv AS pdv_npdv, p.cliente AS pdv_cliente, p.unidad AS pdv_unidad, p.record_id AS pdv_record, p.entrega_real AS pdv_entrega,
    json_extract(r.props, '$.tipo_de_pedido') AS evento, json_extract(r.props, '$.fecha_de_entrega') AS pactada
  FROM produccion a JOIN produccion p ON p.task_id = a.pdv_task LEFT JOIN records r ON r.id = p.record_id AND r.archived = 0
  WHERE (a.es_pdv = 0 OR NOT EXISTS (SELECT 1 FROM produccion h WHERE h.pdv_task = a.task_id AND h.es_pdv = 0))
    AND a.estado NOT IN ('anulado', 'anulada', 'cancelado') AND p.estado NOT IN ('anulado', 'anulada', 'cancelado')`;

async function opciones(db: D1Database) {
  const { results } = await db.prepare(`SELECT o.campo, o.option_id, o.nombre, o.company_id, r.name AS empresa
    FROM produccion_opciones o LEFT JOIN records r ON r.id = o.company_id AND r.archived = 0`).all<Opcion>();
  return new Map(results.map((o) => [`${o.campo}:${o.option_id}`, o]));
}

function armar(filas: FilaMov[], ops: Map<string, Opcion>, hechos: Map<string, { user_id: number | null }>, feriados: Map<string, string>, desde: string, hasta: string) {
  const out: Movimiento[] = [];
  for (const f of filas) {
    const fechas: Record<Tipo, string | null> = {
      entrega: f.entrega_real ?? f.pdv_entrega, ingreso: f.ingreso_proveedor, retiro_proveedor: f.retiro_proveedor,
      egreso: f.egreso_impresor, retiro_impresor: f.retiro_impresor,
    };
    const previos = [fechas.ingreso, fechas.retiro_proveedor, fechas.egreso, fechas.retiro_impresor].filter((x): x is string => !!x).sort();
    for (const tipo of Object.keys(TIPOS) as Tipo[]) {
      const fecha = fechas[tipo];
      if (!fecha || fecha < desde || fecha > hasta) continue;
      const rol = TIPOS[tipo].rol;
      const op = rol ? ops.get(`${rol}:${f[rol] ?? ''}`) : undefined;
      const marca = hechos.get(`${f.task_id}:${tipo}`);
      const implicito = f.estado === 'entregados' || (tipo !== 'entrega' && AVANZADOS.includes(f.estado));
      const avisos: string[] = [];
      if (feriados.has(fecha)) avisos.push(`Cae en feriado (${feriados.get(fecha)})`);
      else if ([0, 6].includes(diaSemana(fecha))) avisos.push('Cae en fin de semana');
      // La entrega real (la de producción) quedó para después de la pactada (la del comercial, en Finnegans).
      const pactada = String(f.pactada ?? '').slice(0, 10);
      if (tipo === 'entrega' && esDia(pactada) && fecha > pactada) avisos.push(`Pactada para el ${Number(pactada.slice(8))}/${Number(pactada.slice(5, 7))}`);
      if (tipo === 'entrega' && previos.length) {
        const ultimo = previos[previos.length - 1];
        if (ultimo > fecha) avisos.push('La entrega es anterior al último retiro');
        else if (ultimo === fecha) avisos.push('Se retira y se entrega el mismo día');
      }
      if (tipo === 'retiro_impresor' && fechas.egreso && fechas.egreso > fecha) avisos.push('El retiro del impresor es anterior al egreso');
      out.push({
        id: `${f.task_id}:${tipo}`, tipo, fecha, task_id: f.task_id, pdv_task: f.pdv_task, npdv: f.pdv_npdv ?? f.npdv, cliente: f.cliente ?? f.pdv_cliente,
        unidad: f.pdv_unidad ?? f.unidad, record_id: f.pdv_record ?? f.record_id, articulo: f.es_pdv ? '' : nombreArticulo(f.nombre), cantidad: f.cantidad,
        estado: f.estado, lugar: rol ? op?.empresa ?? op?.nombre ?? null : null, company_id: op?.company_id ?? null,
        hecho: !!marca || implicito, hecho_por: marca?.user_id ?? null, evento: String(f.evento ?? '').toUpperCase() === 'EVENTO', avisos, url: f.url,
      });
    }
  }
  return out;
}

export async function movimientos(db: D1Database, desde: string, hasta: string) {
  const filas = (await db.prepare(`${SELECT_MOV} AND (COALESCE(a.entrega_real, p.entrega_real) BETWEEN ?1 AND ?2 OR a.ingreso_proveedor BETWEEN ?1 AND ?2
      OR a.retiro_proveedor BETWEEN ?1 AND ?2 OR a.egreso_impresor BETWEEN ?1 AND ?2 OR a.retiro_impresor BETWEEN ?1 AND ?2)`).bind(desde, hasta).all<FilaMov>()).results;
  const [ops, hechos, feriados] = await Promise.all([
    opciones(db),
    db.prepare(`SELECT h.task_id, h.tipo, h.user_id FROM cronograma_hechos h JOIN produccion a ON a.task_id = h.task_id`).all<{ task_id: string; tipo: string; user_id: number | null }>(),
    db.prepare('SELECT fecha, nombre FROM feriados WHERE fecha BETWEEN ? AND ?').bind(desde, hasta).all<{ fecha: string; nombre: string }>(),
  ]);
  const fer = new Map(feriados.results.map((x) => [x.fecha, x.nombre]));
  return { movs: armar(filas, ops, new Map(hechos.results.map((h) => [`${h.task_id}:${h.tipo}`, h])), fer, desde, hasta), feriados: fer };
}

// El dominio de la empresa de cada movimiento, para mostrar su logo: en las entregas, la empresa del pedido; en lo demás,
// el proveedor o el impresor. Dos consultas para toda la semana.
async function ponerDominios(db: D1Database, movs: Movimiento[]) {
  const pedidos = [...new Set(movs.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
  const empresas = [...new Set(movs.filter((m) => m.tipo !== 'entrega' && m.company_id).map((m) => m.company_id!))];
  const [dePedido, deEmpresa] = await Promise.all([
    pedidos.length ? db.prepare(`SELECT r.id, (SELECT json_extract(c.props, '$.domain') FROM associations s
          JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END AND c.object_type = 'company' AND c.archived = 0
        WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS dominio
      FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pedidos)).all<{ id: number; dominio: string | null }>() : { results: [] },
    empresas.length ? db.prepare("SELECT id, json_extract(props, '$.domain') AS dominio FROM records WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(empresas)).all<{ id: number; dominio: string | null }>() : { results: [] },
  ]);
  const a = new Map(dePedido.results.map((x) => [x.id, x.dominio])), b = new Map(deEmpresa.results.map((x) => [x.id, x.dominio]));
  for (const m of movs) m.dominio = (m.tipo === 'entrega' ? a.get(m.record_id ?? -1) : b.get(m.company_id ?? -1)) || null;
  // Las entregas que van por expreso, con su guía.
  const exp = await expresosDe(db, movs.filter((m) => m.tipo === 'entrega').map((m) => `p:${m.pdv_task}`));
  for (const m of movs) if (m.tipo === 'entrega') { const e = exp.get(`p:${m.pdv_task}`); m.expreso = e ? { nombre: e.expreso, guia: e.guia } : null; }
}

// La semana que se mira (`desde`–`hasta`) y, para la barra de semanas, cuánto hay y cuánto falta en cada día de un rango
// más ancho (`rd`–`rh`).
export async function vistaCronograma(db: D1Database, user: User, q: { desde: string; hasta: string; rd?: string; rh?: string }) {
  if (!esDia(q.desde) || !esDia(q.hasta) || q.hasta < q.desde) throw new HttpError(400, 'Faltan las fechas (desde y hasta, AAAA-MM-DD).');
  const rd = esDia(q.rd) && q.rd < q.desde ? q.rd : q.desde;
  const rh = esDia(q.rh) && q.rh > q.hasta ? q.rh : q.hasta;
  if (Date.parse(rh) - Date.parse(rd) > 200 * 86_400_000) throw new HttpError(400, 'El rango es demasiado largo.');
  const [{ movs, feriados }, encs] = await Promise.all([movimientos(db, rd, rh), encargosEntre(db, rd, rh)]);
  const hoy = hoyBsAs();
  const dias: Record<string, { total: number; pendientes: number; atrasados: number }> = {};
  // Los encargos (Recorridos) cuentan igual que un movimiento; uno que no se pudo hacer sigue pendiente hasta que Logística
  // lo pase a otro día o lo cancele.
  for (const m of [...movs, ...encs.map((e) => ({ fecha: e.fecha, hecho: e.estado === 'hecho' }))]) {
    const d = (dias[m.fecha] ??= { total: 0, pendientes: 0, atrasados: 0 });
    d.total++;
    if (!m.hecho) { d.pendientes++; if (m.fecha < hoy) d.atrasados++; }
  }
  const [notas, sinFecha] = await Promise.all([
    db.prepare('SELECT id, fecha, texto, hecho, user_id FROM cronograma_notas WHERE fecha BETWEEN ? AND ? ORDER BY id').bind(rd, rh).all<{ id: number; fecha: string; texto: string; hecho: number; user_id: number | null }>(),
    db.prepare(`${SELECT_MOV} AND a.estado IN ('listo para entergar', 'listo para entregar') AND COALESCE(a.entrega_real, p.entrega_real) IS NULL
      ORDER BY p.npdv LIMIT 150`).all<FilaMov>(),
  ]);
  for (const n of notas.results) { const d = (dias[n.fecha] ??= { total: 0, pendientes: 0, atrasados: 0 }); d.total++; if (!n.hecho) { d.pendientes++; if (n.fecha < hoy) d.atrasados++; } }
  const deLaSemana = movs.filter((m) => m.fecha >= q.desde && m.fecha <= q.hasta);
  const encargos = encs.filter((e) => e.fecha >= q.desde && e.fecha <= q.hasta);
  const [, , quienes] = await Promise.all([ponerDominios(db, deLaSemana), ponerChoferes(db, deLaSemana, encargos, q.desde, q.hasta), choferesYExpresos(db)]);
  return {
    hoy, desde: q.desde, hasta: q.hasta,
    movimientos: deLaSemana, encargos,
    notas: notas.results.filter((n) => n.fecha >= q.desde && n.fecha <= q.hasta),
    feriados: Object.fromEntries(feriados), dias,
    sin_fecha: sinFecha.results.map((f) => ({
      task_id: f.task_id, pdv_task: f.pdv_task, npdv: f.pdv_npdv ?? f.npdv, cliente: f.cliente ?? f.pdv_cliente, unidad: f.pdv_unidad ?? f.unidad,
      record_id: f.pdv_record ?? f.record_id, articulo: f.es_pdv ? '' : nombreArticulo(f.nombre), cantidad: f.cantidad,
    })),
    choferes: quienes.choferes, expresos: quienes.expresos.map((x) => x.nombre),
    puede_editar: puedeEditarCronograma(user),
  };
}

// En la semana, quién hace cada movimiento: el chofer (o el expreso) del recorrido de ese día que tiene su parada. Lo que no
// está en ningún recorrido va al primero, igual que en la ruta del día; un día sin recorridos guardados no tiene chofer
// todavía. Las entregas que retira el cliente en Formas no son parada de nadie.
async function ponerChoferes(db: D1Database, movs: Movimiento[], encs: EncargoDia[], desde: string, hasta: string) {
  const pedidos = [...new Set(movs.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
  const [cfg, dirs, guardadas] = await Promise.all([
    cronogramaConfig(db),
    direccionesDePedidos(db, pedidos),
    db.prepare('SELECT fecha, chofer, orden FROM cronograma_rutas WHERE fecha BETWEEN ? AND ? ORDER BY fecha, n').bind(desde, hasta)
      .all<{ fecha: string; chofer: string | null; orden: string }>(),
  ]);
  const porDia = new Map<string, Array<{ chofer: string | null; orden: string[] }>>();
  for (const r of guardadas.results) porDia.set(r.fecha, [...(porDia.get(r.fecha) ?? []), { chofer: r.chofer, orden: lista(r.orden).map(String) }]);
  for (const m of movs) {
    if (m.tipo === 'ingreso') continue;
    const todas = m.tipo === 'entrega' && m.record_id ? dirs.get(m.record_id) ?? [] : [];
    if (todas.length && todas.every((d) => d.retira)) {
      m.retira_en = [...new Set(todas.map((d) => cfg.bases.find((x) => x.id === d.retira)?.nombre ?? d.direccion))].join(' y ');
      continue;
    }
    const rutas = porDia.get(m.fecha), base = claveParada(m);
    m.chofer = rutas?.length ? (rutas.find((r) => r.orden.some((c) => esDeLaParada(c, base))) ?? rutas[0]).chofer : null;
  }
  // Un encargo va con el chofer de la parada en la que cae: la del mismo lugar si ese día ya se va ahí, o la suya. Como
  // en la ruta del día: la entrega con la empresa del pedido y su dirección, el retiro o egreso con la dirección de la
  // empresa (sin lo que se busca afuera, Finnegans o el mapa).
  if (!encs.length) return;
  const viajes = movs.filter((m) => m.tipo !== 'ingreso' && !m.retira_en);
  const { empresaDePedido, dirEmpresa } = await empresasDe(db, [...new Set(viajes.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))],
    [...new Set(viajes.map((m) => m.company_id).filter((x): x is number => !!x))]);
  const sitios = new Map<string, Sitio[]>();
  for (const m of viajes) {
    const company = m.tipo === 'entrega' ? empresaDePedido.get(m.record_id ?? -1) ?? null : m.company_id;
    const dir = m.tipo === 'entrega' ? (m.record_id ? (dirs.get(m.record_id) ?? []).find((d) => !d.retira)?.direccion ?? null : null) ?? dirEmpresa.get(company ?? -1) ?? null
      : dirEmpresa.get(company ?? -1) ?? null;
    sitios.set(m.fecha, [...(sitios.get(m.fecha) ?? []), { clave: claveParada(m), nombre: (m.tipo === 'entrega' ? m.cliente : m.lugar) ?? '', company_id: company, direccion: dir }]);
  }
  for (const e of encs) {
    const del = sitios.get(e.fecha) ?? [];
    const base = anfitrion(e, del);
    if (!del.some((x) => x.clave === base)) sitios.set(e.fecha, [...del, { clave: base, nombre: e.destino, company_id: e.company_id, lugar_id: e.lugar_id, direccion: e.direccion }]);
    const rutas = porDia.get(e.fecha);
    e.parada = base;
    e.chofer = rutas?.length ? (rutas.find((r) => r.orden.some((c) => esDeLaParada(c, base))) ?? rutas[0]).chofer : null;
  }
}

// La empresa de cada pedido y la dirección de cada empresa (la de su ficha), en dos consultas.
async function empresasDe(db: D1Database, pedidos: number[], empresas: number[]) {
  const empresaDePedido = new Map<number, number>();
  if (pedidos.length) {
    const { results } = await db.prepare(`SELECT r.id, (SELECT c.id FROM associations s JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END
        AND c.object_type = 'company' AND c.archived = 0 WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS company_id
      FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pedidos)).all<{ id: number; company_id: number | null }>();
    for (const r of results) if (r.company_id) empresaDePedido.set(r.id, r.company_id);
  }
  const ids = [...new Set([...empresas, ...empresaDePedido.values()])];
  const dirEmpresa = new Map<number, string>();
  if (ids.length) {
    const { results } = await db.prepare(`SELECT id, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city FROM records WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids)).all<{ id: number; address: string | null; city: string | null }>();
    for (const e of results) if (e.address) dirEmpresa.set(e.id, [e.address, e.city].filter(Boolean).join(', '));
  }
  return { empresaDePedido, dirEmpresa };
}

// Los del desplegable «Chofer»: los choferes de la lista y los que tienen link de la app (Entregas → Choferes), sin
// repetir, y los expresos.
export async function choferesYExpresos(db: D1Database, lista_?: Transportista[]) {
  const ts = lista_ ?? await listarTransportistas(db);
  const conLink = (await db.prepare("SELECT name FROM api_tokens WHERE source = 'chofer' AND revoked = 0 ORDER BY name").all<{ name: string }>()).results.map((c) => c.name);
  const choferes = [...new Map([...ts.filter((x) => x.tipo === 'chofer').map((x) => x.nombre), ...conLink].map((n) => [norm(n), n])).values()].sort((a, b) => a.localeCompare(b));
  return { choferes, con_link: conLink, expresos: ts.filter((x) => x.tipo === 'expreso').map((x) => ({ id: x.id, nombre: x.nombre, direccion: x.direccion })) };
}

// ---------- Mover y marcar: se escribe en ClickUp ----------

const MAX_POR_VEZ = 25;
async function filasDe(db: D1Database, ids: unknown) {
  const l = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_POR_VEZ + 1);
  if (!l.length) throw new HttpError(400, 'Falta qué movimiento.');
  if (l.length > MAX_POR_VEZ) throw new HttpError(400, `De a ${MAX_POR_VEZ} artículos por vez.`);
  const { results } = await db.prepare('SELECT * FROM produccion WHERE task_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(l)).all<FilaDb>();
  if (!results.length) throw new HttpError(404, 'Esos artículos ya no están en producción (puede que los hayan borrado en ClickUp).');
  return results;
}
async function refrescar(env: Env, ctx: Ctx, pdvs: Iterable<string>) {
  for (const p of new Set(pdvs)) await refrescarPdv(env, ctx, p).catch((e) => console.error('cronograma: refrescar', p, (e as Error).message));
}

// Pasa un movimiento a otro día (o le saca la fecha, con `fecha` vacía): la fecha de cada artículo en ClickUp. En las
// entregas, también la del PDV si era la misma (los artículos sin fecha propia usan la del PDV).
export async function moverMovimiento(env: Env, ctx: Ctx, b: { ids?: unknown; tipo?: unknown; fecha?: unknown }) {
  exigir(ctx);
  if (!esTipo(b.tipo)) throw new HttpError(400, 'Falta el tipo de movimiento.');
  const fecha = b.fecha == null || b.fecha === '' ? null : b.fecha;
  if (fecha !== null && !esDia(fecha)) throw new HttpError(400, 'La fecha tiene que ser AAAA-MM-DD.');
  const filas = await filasDe(env.DB, b.ids);
  const col = TIPOS[b.tipo].col;
  let escritos = 0;
  const pdvsTocados: string[] = [];
  if (b.tipo === 'entrega') {
    // Cada artículo queda con su propia fecha. La del PDV se mueve solo si se movieron todos sus artículos abiertos: así
    // pasar uno a otro día no arrastra a los demás (ni a los que ya se entregaron).
    const pdvIds = [...new Set(filas.map((f) => f.pdv_task))];
    const todos = (await env.DB.prepare('SELECT * FROM produccion WHERE pdv_task IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pdvIds)).all<FilaDb>()).results;
    const pedidos = new Set(filas.map((f) => f.task_id));
    for (const id of pdvIds) {
      const p = todos.find((x) => x.task_id === id);
      const arts = todos.filter((x) => x.pdv_task === id && !x.es_pdv && !['anulado', 'anulada', 'cancelado'].includes(x.estado));
      for (const f of arts) if (pedidos.has(f.task_id) && f.entrega_real !== fecha) { await editarProduccion(env, ctx, f.task_id, col, fecha, { libre: true, sinRefrescar: true }); escritos++; }
      const abiertos = arts.filter((x) => x.estado !== 'entregados');
      const todosMovidos = abiertos.every((x) => pedidos.has(x.task_id)) && !arts.some((x) => x.estado === 'entregados');
      if (p && (pedidos.has(p.task_id) || todosMovidos) && p.entrega_real !== fecha) { await editarProduccion(env, ctx, p.task_id, col, fecha, { libre: true, sinRefrescar: true }); escritos++; pdvsTocados.push(p.task_id); }
    }
  } else {
    for (const f of filas) if ((f as unknown as Record<string, string | null>)[col] !== fecha) { await editarProduccion(env, ctx, f.task_id, col, fecha, { libre: true, sinRefrescar: true }); escritos++; }
  }
  // Lo que estaba marcado hecho deja de estarlo: cambió de día, hay que hacerlo de nuevo.
  await env.DB.prepare('DELETE FROM cronograma_hechos WHERE tipo = ? AND task_id IN (SELECT value FROM json_each(?))').bind(b.tipo, JSON.stringify(filas.map((f) => f.task_id))).run();
  await refrescar(env, ctx, pdvsTocados);
  return { escritos };
}

// Marca (o desmarca) como hecho: queda quién y cuándo, y el artículo cambia de estado en ClickUp. Si el artículo ya está
// más adelante, el estado no se toca. Al desmarcar vuelve al estado que tenía, si nadie lo cambió después.
// `enFondo`: dónde dejar lo que puede terminar después de contestar (releer los PDV de ClickUp); sin él, se espera.
export async function marcarHecho(env: Env, ctx: Ctx, b: { ids?: unknown; tipo?: unknown; hecho?: unknown }, opts: { chofer?: string; enFondo?: (p: Promise<unknown>) => void } = {}) {
  if (!opts.chofer) exigir(ctx);
  if (!esTipo(b.tipo)) throw new HttpError(400, 'Falta el tipo de movimiento.');
  const tipo = b.tipo, hecho = b.hecho !== false;
  const db = env.DB;
  // Lo que marca el chofer queda a su nombre (en la conversación del pedido y en el historial), no al de quien creó su link.
  const c2: Ctx = opts.chofer ? { ...ctx, actor: { name: opts.chofer, userId: null } } : ctx;
  const filas = await filasDe(db, b.ids);
  const destino = (await cronogramaConfig(db)).estados[tipo];
  const orden = (await estadosPec(db)).map((e) => e.status);
  const existe = orden.includes(destino);
  // Solo hacia adelante: si el artículo ya pasó ese estado (según el orden de la lista de ClickUp), no se lo vuelve atrás.
  const adelante = (actual: string) => { const a = orden.indexOf(actual); return a < 0 || a < orden.indexOf(destino); };
  const marcas = new Map((await db.prepare('SELECT task_id, estado_antes FROM cronograma_hechos WHERE tipo = ? AND task_id IN (SELECT value FROM json_each(?))')
    .bind(tipo, JSON.stringify(filas.map((f) => f.task_id))).all<{ task_id: string; estado_antes: string | null }>()).results.map((m) => [m.task_id, m]));
  let cambiados = 0;
  const pdvs: string[] = [], marcados: string[] = [];
  // Cada artículo: su estado en ClickUp y la marca. Van de a varios a la vez: de a uno, una parada con muchos artículos
  // hacía esperar varios segundos al chofer (o a Logística) cada vez que tocaba «Listo».
  await deAVarios(filas, async (f) => {
    if (hecho) {
      if (marcas.has(f.task_id)) return;
      const cambia = existe && f.estado !== destino && !CERRADOS.includes(f.estado) && adelante(f.estado) && !(tipo !== 'entrega' && AVANZADOS.includes(f.estado));
      if (cambia) { await editarProduccion(env, c2, f.task_id, 'estado', destino, { libre: true, sinRefrescar: true }); cambiados++; pdvs.push(f.pdv_task); }
      // OR IGNORE: si otro pedido la marcó recién, no se pierde el estado que tenía antes.
      await db.prepare('INSERT OR IGNORE INTO cronograma_hechos (task_id, tipo, estado_antes, user_id, chofer, at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(f.task_id, tipo, cambia ? f.estado : null, opts.chofer ? null : ctx.user.id, opts.chofer ?? null, now()).run();
      marcados.push(f.task_id);
    } else {
      const m = marcas.get(f.task_id);
      if (m?.estado_antes && f.estado === destino) { await editarProduccion(env, c2, f.task_id, 'estado', m.estado_antes, { libre: true, sinRefrescar: true }); cambiados++; pdvs.push(f.pdv_task); }
      await db.prepare('DELETE FROM cronograma_hechos WHERE task_id = ? AND tipo = ?').bind(f.task_id, tipo).run();
    }
  });
  // Releer los PDV (el estado del pedido) no hace falta para contestar: el estado de cada artículo ya quedó guardado.
  if (opts.enFondo) opts.enFondo(refrescar(env, c2, pdvs)); else await refrescar(env, c2, pdvs);
  return { cambiados, estado: existe ? destino : null, marcados };
}
// Hace `fn` con todos, de a `n` a la vez. Si alguno falla, espera a que terminen los demás (lo hecho queda hecho) y avisa
// el primer error.
async function deAVarios<T>(items: T[], fn: (x: T) => Promise<void>, n = 4) {
  let i = 0, error: unknown = null;
  const uno = async () => { while (i < items.length) { const x = items[i++]; try { await fn(x); } catch (e) { error ??= e; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, uno));
  if (error) throw error;
}

// ---------- Notas y feriados ----------

export async function guardarNota(db: D1Database, ctx: Ctx, id: number | null, b: { fecha?: unknown; texto?: unknown; hecho?: unknown }) {
  exigir(ctx);
  if (id == null) {
    const texto = String(b.texto ?? '').trim();
    if (!esDia(b.fecha) || !texto) throw new HttpError(400, 'La nota necesita el día y el texto.');
    const r = await db.prepare('INSERT INTO cronograma_notas (fecha, texto, user_id) VALUES (?, ?, ?) RETURNING id').bind(b.fecha, texto.slice(0, 500), ctx.user.id).first<{ id: number }>();
    return { id: r!.id };
  }
  const n = await db.prepare('SELECT id FROM cronograma_notas WHERE id = ?').bind(id).first();
  if (!n) throw new HttpError(404, 'Esa nota ya no está.');
  if (b.texto !== undefined) { const t = String(b.texto).trim(); if (!t) throw new HttpError(400, 'La nota no puede quedar vacía.'); await db.prepare('UPDATE cronograma_notas SET texto = ? WHERE id = ?').bind(t.slice(0, 500), id).run(); }
  if (b.fecha !== undefined) { if (!esDia(b.fecha)) throw new HttpError(400, 'La fecha tiene que ser AAAA-MM-DD.'); await db.prepare('UPDATE cronograma_notas SET fecha = ? WHERE id = ?').bind(b.fecha, id).run(); }
  if (b.hecho !== undefined) await db.prepare('UPDATE cronograma_notas SET hecho = ?, hecho_por = ?, hecho_at = ? WHERE id = ?').bind(b.hecho ? 1 : 0, b.hecho ? ctx.user.id : null, b.hecho ? now() : null, id).run();
  return { id };
}
export async function borrarNota(db: D1Database, ctx: Ctx, id: number) {
  exigir(ctx);
  await db.prepare('DELETE FROM cronograma_notas WHERE id = ?').bind(id).run();
  return { ok: true };
}
export async function guardarFeriado(db: D1Database, ctx: Ctx, b: { fecha?: unknown; nombre?: unknown }) {
  exigir(ctx);
  if (!esDia(b.fecha)) throw new HttpError(400, 'Falta el día.');
  const nombre = String(b.nombre ?? '').trim();
  if (nombre) await db.prepare('INSERT OR REPLACE INTO feriados (fecha, nombre) VALUES (?, ?)').bind(b.fecha, nombre.slice(0, 80)).run();
  else await db.prepare('DELETE FROM feriados WHERE fecha = ?').bind(b.fecha).run();
  return { ok: true };
}

// ---------- Direcciones ----------

// Para comparar y para buscar en el mapa: sin la unidad, el piso ni el departamento.
export function limpiarDireccion(s: string) {
  return s.replace(/\s+/g, ' ').replace(/[,;]?\s*\b(unidad|uf|piso|dto\.?|depto\.?|dpto\.?|departamento|of\.?|oficina|local|nave|galp[oó]n)\s*[:.]?\s*[\w°º-]+/gi, '').replace(/\s+,/g, ',').trim().replace(/[,;.\s]+$/, '');
}
export const claveDireccion = (s: string) => norm(limpiarDireccion(s)).replace(/[.,;]/g, ' ').replace(/\b(avenida|avda|av)\b/g, 'av').replace(/\b(general|gral)\b/g, 'gral')
  .replace(/\b(argentina|provincia de|pcia de|pcia|prov)\b/g, ' ').replace(/\s+/g, ' ').trim();

// «9 a 13», «09:00-13:30», «de 8 a 12 hs» → minutos desde las 0:00.
export function horarioDe(s: unknown): [number, number] | null {
  const m = String(s ?? '').match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:hs?\.?)?\s*(?:a|-|–|hasta)\s*(?:las\s*)?(\d{1,2})(?:[:.](\d{2}))?/i);
  if (!m) return null;
  const d = Number(m[1]) * 60 + Number(m[2] ?? 0), h = Number(m[3]) * 60 + Number(m[4] ?? 0);
  return d < h && h <= 24 * 60 ? [d, h] : null;
}

// La dirección de entrega del pedido de venta de Finnegans. El nombre exacto del campo no está documentado: se toma el
// primero que hable de la entrega (o del domicilio), sea un texto o un objeto con calle, número y localidad.
export function direccionDeFinnegans(p: unknown): string | null {
  if (!p || typeof p !== 'object') return null;
  const texto = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim().length > 4 ? v.trim() : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const partes = Object.entries(v as Record<string, unknown>).filter(([k, x]) => typeof x === 'string' && x.trim() && /calle|direcc|domic|numero|altura|localidad|ciudad|partido|provincia|nombre|descrip/i.test(k)).map(([, x]) => String(x).trim());
      return partes.length ? [...new Set(partes)].join(', ') : null;
    }
    return null;
  };
  const entradas = Object.entries(p as Record<string, unknown>);
  for (const re of [/(direcc|domic|lugar).*entrega|entrega.*(direcc|domic|lugar)/i, /^(direccion|domicilio)(entrega)?$/i, /direcc|domic/i]) {
    for (const [k, v] of entradas) { if (re.test(k) && !/factur|fiscal|legal|mail/i.test(k)) { const t = texto(v); if (t) return t; } }
  }
  return null;
}

async function direccionesFinnegans(env: Env, pedidos: Array<{ id: number; pedido: string | null }>, b: Budget, buscar: boolean) {
  const db = env.DB;
  const ya = new Map((await db.prepare('SELECT record_id, direccion FROM direcciones_finnegans WHERE record_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(pedidos.map((p) => p.id))).all<{ record_id: number; direccion: string | null }>()).results.map((r) => [r.record_id, r.direccion]));
  const faltan = pedidos.filter((p) => p.pedido && !ya.has(p.id)).slice(0, 6);
  if (buscar && faltan.length && env.FINNEGANS_CLIENT_ID) {
    try {
      const token = await finnegansToken(env, b);
      for (const p of faltan) {
        if (!token || b.left() < 3) break;
        const dir = direccionDeFinnegans(await finnegansPedidoVenta(env, token, p.pedido!, b));
        await db.prepare('INSERT OR REPLACE INTO direcciones_finnegans (record_id, direccion, at) VALUES (?, ?, ?)').bind(p.id, dir, now()).run();
        ya.set(p.id, dir);
      }
    } catch (e) { console.error('cronograma: Finnegans', (e as Error).message); }
  }
  return { direcciones: ya, pendientes: buscar && env.FINNEGANS_CLIENT_ID ? pedidos.filter((p) => p.pedido && !ya.has(p.id)).length : 0 };
}

// Dónde fueron las últimas entregas a cada cliente: la dirección de sus remitos leídos, la más reciente primero.
async function ultimasEntregas(db: D1Database, clientes: string[]) {
  const out = new Map<string, Array<{ direccion: string; fecha: string | null; record_id: number }>>();
  if (!clientes.length) return out;
  const { results } = await db.prepare(`SELECT p.cliente, rm.record_id, rm.fecha, json_extract(rm.lectura, '$.direccion_entrega') AS direccion
    FROM remitos rm JOIN produccion p ON p.record_id = rm.record_id AND p.es_pdv = 1
    WHERE rm.estado = 'ok' AND p.cliente IN (SELECT value FROM json_each(?)) AND json_extract(rm.lectura, '$.direccion_entrega') IS NOT NULL
    ORDER BY COALESCE(rm.fecha, rm.created_at) DESC LIMIT 400`).bind(JSON.stringify(clientes)).all<{ cliente: string; record_id: number; fecha: string | null; direccion: string }>();
  for (const r of results) {
    if (String(r.direccion).trim().length < 5) continue;
    const l = out.get(r.cliente) ?? [];
    if (l.length < 5) { l.push({ direccion: String(r.direccion).trim(), fecha: r.fecha, record_id: r.record_id }); out.set(r.cliente, l); }
  }
  return out;
}

const ESQUEMA_DIR = {
  type: 'object', additionalProperties: false, required: ['mismo_lugar', 'direccion_sugerida', 'motivo'],
  properties: { mismo_lugar: { type: 'boolean' }, direccion_sugerida: { type: 'string' }, motivo: { type: 'string' } },
};
const INSTRUCCIONES_DIR = `Sos parte del CRM de Formas Publicitarias (Buenos Aires). Te paso la dirección de entrega que figura en un pedido y las direcciones de las últimas entregas reales al mismo cliente (de los remitos firmados).
Decidí si la dirección del pedido es el mismo lugar que el de las últimas entregas. Es el mismo lugar aunque esté escrita distinto (abreviaturas, mayúsculas, con o sin localidad, piso u oficina, errores de tipeo). Es otro lugar si cambia la calle, la altura o la localidad.
- mismo_lugar: true si coincide con el lugar habitual de las últimas entregas (o si no hay un lugar habitual claro: las últimas entregas fueron a lugares distintos entre sí).
- direccion_sugerida: si mismo_lugar es false, la dirección de las últimas entregas, escrita completa y prolija; si es true, cadena vacía.
- motivo: una frase corta en castellano rioplatense para Logística («Las últimas 3 entregas fueron a Av. Libertador 1234, Vicente López»).`;

// Revisa la dirección del pedido contra las últimas entregas. Solo consulta a Claude si a simple vista no son iguales, y
// una vez por combinación (direcciones_revisadas). Devuelve la sugerencia si son lugares distintos y nadie la resolvió.
async function revisarDireccion(env: Env, recordId: number, actual: string, historial: string[], puedeConsultar: () => boolean) {
  const db = env.DB;
  const firma = [claveDireccion(actual), ...historial.map(claveDireccion)].join('|');
  const ya = await db.prepare('SELECT firma, distinta, sugerida, motivo, resuelta FROM direcciones_revisadas WHERE record_id = ?').bind(recordId)
    .first<{ firma: string; distinta: number; sugerida: string | null; motivo: string | null; resuelta: number }>();
  if (ya && ya.firma === firma) return ya.distinta && !ya.resuelta ? { sugerida: ya.sugerida!, motivo: ya.motivo ?? '' } : null;
  const guardar = (distinta: boolean, sugerida: string | null, motivo: string | null) => db.prepare(`INSERT OR REPLACE INTO direcciones_revisadas
    (record_id, firma, distinta, sugerida, motivo, resuelta, at) VALUES (?, ?, ?, ?, ?, 0, ?)`).bind(recordId, firma, distinta ? 1 : 0, sugerida, motivo, now()).run();
  const a = claveDireccion(actual);
  if (!a) return null;
  if (historial.some((h) => claveDireccion(h) === a)) { await guardar(false, null, null); return null; }
  if (!env.ANTHROPIC_API_KEY || !puedeConsultar()) return null;
  try {
    const res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeout: 25_000 }).beta.messages.create({
      model: MODELO, max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA_DIR } },
      system: INSTRUCCIONES_DIR,
      messages: [{ role: 'user', content: `Dirección del pedido: ${actual}\n\nÚltimas entregas al cliente (la más reciente primero):\n${historial.map((h, i) => `${i + 1}. ${h}`).join('\n')}` }],
    });
    const r = JSON.parse(res.content.map((x) => (x.type === 'text' ? x.text : '')).join('').trim()) as { mismo_lugar: boolean; direccion_sugerida: string; motivo: string };
    const distinta = r.mismo_lugar === false && String(r.direccion_sugerida ?? '').trim().length > 4;
    await guardar(distinta, distinta ? r.direccion_sugerida.trim().slice(0, 200) : null, distinta ? String(r.motivo ?? '').trim().slice(0, 300) : null);
    return distinta ? { sugerida: r.direccion_sugerida.trim().slice(0, 200), motivo: String(r.motivo ?? '').trim().slice(0, 300) } : null;
  } catch (e) { console.error('cronograma: revisar dirección', recordId, (e as Error).message); return null; }
}

// Aceptar la sugerencia (queda como dirección de entrega del pedido) o descartarla.
export async function resolverSugerencia(env: Env, ctx: Ctx, recordId: number, aceptar: boolean) {
  exigir(ctx);
  const s = await env.DB.prepare('SELECT sugerida FROM direcciones_revisadas WHERE record_id = ? AND distinta = 1').bind(recordId).first<{ sugerida: string | null }>();
  if (!s) throw new HttpError(404, 'No hay una sugerencia para ese pedido.');
  if (aceptar && s.sugerida) await direccionDesdeRuta(env, ctx, recordId, s.sugerida);
  await env.DB.prepare('UPDATE direcciones_revisadas SET resuelta = 1 WHERE record_id = ?').bind(recordId).run();
  return { ok: true };
}

// Corregir una dirección desde la ruta: la de entrega del pedido, o la de la empresa (proveedor o impresor).
export async function guardarDireccion(env: Env, ctx: Ctx, b: { record_id?: unknown; company_id?: unknown; direccion?: unknown; horario?: unknown }) {
  exigir(ctx);
  const direccion = b.direccion === undefined ? undefined : String(b.direccion ?? '').trim();
  if (b.record_id) {
    if (direccion === undefined) throw new HttpError(400, 'Falta la dirección.');
    // La dirección del pedido vive en su tarjeta «Entrega» (direcciones.ts): se cambia por ahí, así queda una sola.
    await direccionDesdeRuta(env, ctx, Number(b.record_id), direccion || null);
  } else if (b.company_id) {
    const cambios: Record<string, unknown> = {};
    if (direccion !== undefined) {
      // La pantalla muestra «dirección, ciudad»: si lo que se guarda termina con la ciudad de la ficha, la ciudad queda
      // en su campo; si no, la dirección nueva manda entera.
      const e = await env.DB.prepare("SELECT json_extract(props, '$.city') AS city FROM records WHERE id = ?").bind(Number(b.company_id)).first<{ city: string | null }>();
      const ciudad = String(e?.city ?? '').trim();
      if (ciudad && norm(direccion).endsWith(norm(ciudad))) cambios.address = direccion.slice(0, direccion.length - ciudad.length).replace(/[,\s]+$/, '') || null;
      else { cambios.address = direccion || null; cambios.city = null; }
    }
    if (b.horario !== undefined) {
      const h = String(b.horario ?? '').trim();
      if (h && !horarioDe(h)) throw new HttpError(400, 'El horario va como «9 a 13».');
      cambios.horario_recepcion = h || null;
    }
    await updateRecord(env.DB, ctx, 'company', Number(b.company_id), cambios, { strict: false });
  } else throw new HttpError(400, 'Falta de qué pedido o empresa es la dirección.');
  return { ok: true };
}

// ---------- El mapa: dónde queda cada dirección ----------

interface Geo { lat: number; lng: number; manual: boolean }
const GEOCODER = (env: Env) => env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search';
// El servicio pide a lo sumo una consulta por segundo: pocas por vez y la pantalla vuelve a pedir lo que falta.
const GEO_POR_VEZ = 4;

async function ubicar(env: Env, direcciones: string[], buscar: boolean) {
  const db = env.DB;
  const claves = [...new Set(direcciones.map(claveDireccion).filter(Boolean))];
  const out = new Map<string, Geo | null>();
  if (!claves.length) return { geo: out, pendientes: 0 };
  const { results } = await db.prepare('SELECT clave, lat, lng, ok, manual FROM geocodigos WHERE clave IN (SELECT value FROM json_each(?))').bind(JSON.stringify(claves))
    .all<{ clave: string; lat: number | null; lng: number | null; ok: number; manual: number }>();
  for (const r of results) out.set(r.clave, r.ok && r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng, manual: !!r.manual } : null);
  const faltan = buscar ? claves.filter((k) => !out.has(k)) : [];
  let hechas = 0;
  for (const k of faltan) {
    if (hechas >= GEO_POR_VEZ) break;
    const original = direcciones.find((d) => claveDireccion(d) === k)!;
    if (hechas) await new Promise((r) => setTimeout(r, 1100));
    hechas++;
    let punto: { lat: number; lng: number } | null = null;
    try {
      const url = new URL(GEOCODER(env));
      const q = limpiarDireccion(original);
      url.searchParams.set('q', /argentina/i.test(q) ? q : `${q}, Argentina`);
      url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '1'); url.searchParams.set('countrycodes', 'ar');
      url.searchParams.set('viewbox', '-59.4,-34.1,-57.7,-35.2');   // primero el área metropolitana, sin excluir el resto
      const res = await fetch(url, { headers: { 'user-agent': 'formas-crm/1.0 (cronograma de entregas)', 'accept-language': 'es' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      if (j[0]?.lat && j[0]?.lon && Number.isFinite(Number(j[0].lat))) punto = { lat: Number(j[0].lat), lng: Number(j[0].lon) };
    } catch (e) { console.error('cronograma: ubicar', (e as Error).message); continue; }   // falló el servicio: se intenta la próxima
    await db.prepare('INSERT OR REPLACE INTO geocodigos (clave, direccion, lat, lng, ok, manual, at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .bind(k, original, punto?.lat ?? null, punto?.lng ?? null, punto ? 1 : 0, now()).run();
    out.set(k, punto ? { ...punto, manual: false } : null);
  }
  return { geo: out, pendientes: buscar ? claves.filter((k) => !out.has(k)).length : 0 };
}

// Alguien corrió el punto en el mapa: queda ahí y no se vuelve a buscar.
export async function fijarPunto(db: D1Database, ctx: Ctx, b: { direccion?: unknown; lat?: unknown; lng?: unknown }) {
  exigir(ctx);
  const direccion = String(b.direccion ?? '').trim(), lat = Number(b.lat), lng = Number(b.lng);
  const clave = claveDireccion(direccion);
  if (!clave || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Falta la dirección o el punto.');
  await db.prepare('INSERT OR REPLACE INTO geocodigos (clave, direccion, lat, lng, ok, manual, at) VALUES (?, ?, ?, ?, 1, 1, ?)').bind(clave, direccion, lat, lng, now()).run();
  return { ok: true };
}

// Sacar la corrección a mano de un punto: la dirección se vuelve a buscar en el mapa la próxima vez que se abra la ruta.
export async function soltarPunto(db: D1Database, ctx: Ctx, direccion: string) {
  exigir(ctx);
  const clave = claveDireccion(String(direccion ?? ''));
  if (!clave) throw new HttpError(400, 'Falta la dirección.');
  await db.prepare('DELETE FROM geocodigos WHERE clave = ?').bind(clave).run();
  return { ok: true };
}

// ---------- La ruta del día ----------

export interface Parada {
  clave: string; nombre: string; direccion: string | null; origen: 'pedido' | 'finnegans' | 'ultima_entrega' | 'empresa' | 'libreta' | 'expreso' | 'encargo' | null;
  lat: number | null; lng: number | null; punto_manual: boolean; horario: [number, number] | null; horario_texto: string | null;
  company_id: number | null; record_id: number | null; movimientos: Movimiento[];
  encargos: EncargoDia[];   // lo que pidió alguien para ese día en ese lugar (Recorridos)
  sugerencia: { record_id: number; sugerida: string; motivo: string } | null;
  visita?: Visita | null;   // lo que marcó el chofer en la app
  expreso?: { nombre: string; guia: string | null; cliente: string } | null;   // no va directo: se lleva a este expreso
  lugar?: LugarInfo | null; // lo que dice la libreta de direcciones de ese lugar
}
export interface LugarInfo { nombre: string; horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null; coordinacion: string | null }
export interface Visita { resultado: 'hecho' | 'no_se_pudo' | 'salteada'; motivo: string | null; nota: string | null; chofer: string | null; at: string }
// `a_mano`: alguien ordenó sus paradas en la Ruta del día. Si no, se ordena solo por el recorrido más corto.
// `fin`: dónde termina (pedido de Rodrigo del 13/11/2026): 'igual' (vuelve a donde salió), el id de un depósito, 'ultima'
// (en la última parada, sin volver) u 'otro' (`fin_otro`).
type LugarRuta = { nombre: string; direccion: string; lat: number | null; lng: number | null };
interface RutaGuardada { n: number; chofer: string | null; base: string; salida: number; orden: string[]; base_otro?: LugarRuta | null; a_mano?: boolean; fin?: string; fin_otro?: LugarRuta | null }
type BaseGeo = Base & { lat: number | null; lng: number | null };
const puntoDe = (p: { lat: number | null; lng: number | null } | null | undefined): Punto | null => (p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);
// De dónde sale un recorrido: un depósito de Formas o el otro lugar que se eligió.
const lugarSalida = (r: RutaGuardada, bases: BaseGeo[]): LugarRuta => (r.base === 'otro' && r.base_otro ? r.base_otro : bases.find((b) => b.id === r.base) ?? bases[0]);
const salidaDe = (r: RutaGuardada, bases: BaseGeo[]) => puntoDe(lugarSalida(r, bases));
// Dónde termina: el lugar (null si termina en la última parada), y en el mapa.
const lugarFin = (r: RutaGuardada, bases: BaseGeo[]): LugarRuta | null =>
  r.fin === 'ultima' ? null : r.fin === 'otro' && r.fin_otro ? r.fin_otro : bases.find((b) => b.id === r.fin) ?? lugarSalida(r, bases);
const destinoDe = (r: RutaGuardada, bases: BaseGeo[]): Destino => { const l = lugarFin(r, bases); return l ? puntoDe(l) : 'ultima'; };

export async function rutaDelDia(env: Env, user: User, fecha: string, opts: { buscar?: boolean } = {}) {
  const buscar = !!opts.buscar;
  if (!esDia(fecha)) throw new HttpError(400, 'Falta el día (AAAA-MM-DD).');
  const db = env.DB;
  const b = Budget.of(env);
  const cfg = await cronogramaConfig(db);
  const { movs } = await movimientos(db, fecha, fecha);
  const llegan = movs.filter((m) => m.tipo === 'ingreso');
  const viajes = movs.filter((m) => m.tipo !== 'ingreso');

  // Las empresas (proveedores, impresores y clientes de los pedidos) con su dirección y su horario.
  const pedidosIds = [...new Set(viajes.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
  const pedidos = pedidosIds.length ? (await db.prepare(`SELECT r.id, json_extract(r.props, '$.direccion_entrega') AS manual, json_extract(r.props, '$.pedido_finnegans') AS pedido,
      (SELECT c.id FROM associations s JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END AND c.object_type = 'company' AND c.archived = 0
        WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS company_id
    FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pedidosIds))
    .all<{ id: number; manual: string | null; pedido: string | null; company_id: number | null }>()).results : [];
  const pedidoDe = new Map(pedidos.map((p) => [p.id, p]));
  const empresasIds = [...new Set([...viajes.map((m) => m.company_id), ...pedidos.map((p) => p.company_id)].filter((x): x is number => !!x))];
  const empresas = new Map(empresasIds.length ? (await db.prepare(`SELECT id, name, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city,
      json_extract(props, '$.horario_recepcion') AS horario FROM records WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(empresasIds))
    .all<{ id: number; name: string; address: string | null; city: string | null; horario: string | null }>()).results.map((e) => [e.id, e]) : []);
  const dirEmpresa = (id: number | null) => { const e = id ? empresas.get(id) : null; return e?.address ? [e.address, e.city].filter(Boolean).join(', ') : null; };

  // Las direcciones cargadas en la tarjeta «Entrega» de cada pedido (direcciones.ts): con varias, una parada por dirección.
  const cargadas = await direccionesDePedidos(db, pedidosIds);
  const fin = await direccionesFinnegans(env, pedidos.filter((p) => !p.manual && !cargadas.has(p.id)), b, buscar);
  const historial = await ultimasEntregas(db, [...new Set(viajes.filter((m) => m.tipo === 'entrega' && m.cliente).map((m) => m.cliente!))]);
  let consultas = 0;
  const puedeConsultar = () => buscar && consultas++ < 3;
  const revisadas = new Map<number, Parada['sugerencia']>();   // una vez por pedido, no por artículo

  await actualizarLugares(env, buscar);
  const libreta = await lugaresPara(db, [...new Set(viajes.map((m) => (m.tipo === 'entrega' ? m.cliente : m.lugar)).filter((x): x is string => !!x))]);

  const paradas = new Map<string, Parada>();
  const puntoGoogle = new Map<string, { lat: number; lng: number }>();
  // Las entregas que retira el cliente en Formas (tarjeta «Entrega» del pedido): no son paradas del chofer, van aparte.
  // `parcial`: el pedido además tiene direcciones a donde se envía (esas sí son paradas).
  const retiran: Array<Movimiento & { retira_en: string; parcial: boolean }> = [];
  for (const m of viajes) {
    let direccion: string | null = null, origen: Parada['origen'] = null, nombre = m.lugar ?? 'Sin proveedor', companyId = m.company_id, recordId: number | null = null;
    let sugerencia: Parada['sugerencia'] = null;
    // Un pedido que va a varias direcciones: una parada por cada una (con el mismo movimiento).
    let otras: string[] = [];
    if (m.tipo === 'entrega') {
      const p = m.record_id ? pedidoDe.get(m.record_id) : undefined;
      nombre = m.cliente ?? `PDV ${m.npdv ?? ''}`; companyId = p?.company_id ?? null; recordId = m.record_id;
      const previas = (m.cliente ? historial.get(m.cliente) ?? [] : []).filter((h) => h.record_id !== m.record_id);
      const deFinnegans = p ? fin.direcciones.get(p.id) ?? null : null;
      const todas = p ? cargadas.get(p.id) ?? [] : [];
      const retiros = todas.filter((d) => d.retira);
      const enTarjeta = todas.filter((d) => !d.retira);
      if (retiros.length) {
        const donde = [...new Set(retiros.map((d) => cfg.bases.find((x) => x.id === d.retira)?.nombre ?? d.direccion))].join(' y ');
        retiran.push({ ...m, retira_en: donde, parcial: enTarjeta.length > 0 });
        // Solo lo retira el cliente: no hay viaje (ni hay que buscarle otra dirección).
        if (!enTarjeta.length) continue;
      }
      for (const d of enTarjeta) if (d.validada && d.lat != null && d.lng != null) puntoGoogle.set(claveDireccion(d.direccion), { lat: d.lat, lng: d.lng });
      if (enTarjeta.length) { direccion = enTarjeta[0].direccion; origen = 'pedido'; otras = enTarjeta.slice(1).map((d) => d.direccion); }
      else if (p?.manual) { direccion = p.manual; origen = 'pedido'; }
      else if (deFinnegans) {
        direccion = deFinnegans; origen = 'finnegans';
        if (previas.length && m.record_id) {
          if (!revisadas.has(m.record_id)) {
            const s = await revisarDireccion(env, m.record_id, deFinnegans, previas.slice(0, 3).map((h) => h.direccion), puedeConsultar);
            revisadas.set(m.record_id, s ? { record_id: m.record_id, ...s } : null);
          }
          sugerencia = revisadas.get(m.record_id) ?? null;
        }
      } else if (previas.length) { direccion = previas[0].direccion; origen = 'ultima_entrega'; }
      else if (dirEmpresa(companyId)) { direccion = dirEmpresa(companyId); origen = 'empresa'; }
    } else if (dirEmpresa(companyId)) { direccion = dirEmpresa(companyId); origen = 'empresa'; }
    // Sin dirección: la de la libreta, si ese nombre tiene un solo lugar (o todos sus lugares son la misma dirección).
    let delLugar: Lugar | null = null;
    if (!direccion) { delLugar = unicoLugar(libreta.get(nombre)?.exactos ?? []); if (delLugar) { direccion = direccionLugar(delLugar); origen = 'libreta'; } }
    // La clave no depende de la dirección: corregirla no saca la parada del recorrido guardado ni pierde lo que marcó el
    // chofer. Una entrega es la de su PDV; un retiro o un egreso, el de esa empresa. Un pedido que va a varias direcciones
    // (tarjeta «Entrega») tiene una parada por dirección: la primera con la clave del PDV y las otras con su número (:2, :3…).
    const base = claveParada(m);
    const horarioTexto = companyId ? empresas.get(companyId)?.horario ?? null : null;
    for (const [i, dir] of [direccion, ...otras].entries()) {
      const clave = i ? `${base}:${i + 1}` : base;
      const par = paradas.get(clave) ?? { clave, nombre, direccion: dir, origen, lat: null, lng: null, punto_manual: false, horario: horarioDe(horarioTexto), horario_texto: horarioTexto,
        company_id: companyId, record_id: recordId, movimientos: [], encargos: [], sugerencia: null, lugar: delLugar ? infoLugar(delLugar) : null };
      par.movimientos.push(m);
      if (sugerencia && !par.sugerencia) par.sugerencia = sugerencia;
      if (!par.horario && horarioDe(horarioTexto)) { par.horario = horarioDe(horarioTexto); par.horario_texto = horarioTexto; }
      paradas.set(clave, par);
    }
  }

  const lista_ = [...paradas.values()];
  // Las entregas que van por expreso: la parada es el expreso (con su dirección, o la de la libreta si se llama igual), no
  // el cliente.
  const transportistas = await listarTransportistas(db);
  const porExpreso = await expresosDe(db, lista_.map((p) => p.clave));
  for (const p of lista_) {
    const e = porExpreso.get(p.clave);
    if (!e) continue;
    const t = transportistas.find((x) => x.tipo === 'expreso' && norm(x.nombre) === norm(e.expreso));
    const deLibreta = t?.direccion ? null : unicoLugar((await lugaresPara(db, [e.expreso])).get(e.expreso)?.exactos ?? []);
    p.expreso = { nombre: e.expreso, guia: e.guia, cliente: p.nombre };
    p.nombre = e.expreso; p.direccion = t?.direccion || (deLibreta ? direccionLugar(deLibreta) : null); p.origen = p.direccion ? 'expreso' : null;
    p.sugerencia = null; p.lugar = deLibreta ? infoLugar(deLibreta) : null; p.horario = null; p.horario_texto = null; p.company_id = null;
  }
  // Los encargos del día (Recorridos): van en la parada del mismo lugar si ese día ya se va ahí (un retiro de ClickUp en el
  // mismo impresor, la entrega a ese cliente, otro encargo); si no, son una parada propia. Los cancelados no.
  const encs = await encargosEntre(db, fecha, fecha);
  const lugaresEnc = await lugaresPorId(db, encs.map((e) => e.lugar_id));
  for (const e of encs) {
    const clave = anfitrion(e, lista_);
    let p = lista_.find((x) => x.clave === clave);
    if (!p) {
      const l = e.lugar_id ? lugaresEnc.get(e.lugar_id) ?? null : null;
      p = { clave, nombre: e.destino, direccion: e.direccion || (l?.direccion ? direccionLugar(l) : null), origen: 'encargo', lat: null, lng: null, punto_manual: false,
        horario: null, horario_texto: null, company_id: e.company_id, record_id: null, movimientos: [], encargos: [], sugerencia: null, lugar: l ? infoLugar(l) : null };
      lista_.push(p); paradas.set(clave, p);
    }
    p.encargos.push(e);
    if (!p.horario && horarioDe(e.horario)) { p.horario = horarioDe(e.horario); p.horario_texto = e.horario; }
  }
  // Lo que dice la libreta del lugar al que se va (horario, contacto, observaciones), reconocido por calle y altura.
  const porDir = await lugaresPorDireccion(db, lista_.filter((p) => p.direccion && !p.lugar).map((p) => p.direccion!));
  for (const p of lista_) {
    if (!p.lugar && p.direccion) { const l = porDir.get(claveCalle(p.direccion)); if (l) p.lugar = infoLugar(l); }
    if (p.lugar && !p.horario && horarioDe(p.lugar.horario)) { p.horario = horarioDe(p.lugar.horario); p.horario_texto = p.lugar.horario; }
    if (p.lugar && !buscar) p.lugar.coordinacion = null;
  }
  const guardadas = (await db.prepare('SELECT n, chofer, base, base_nombre, base_direccion, salida, orden, a_mano, fin, fin_nombre, fin_direccion FROM cronograma_rutas WHERE fecha = ? ORDER BY n').bind(fecha)
    .all<{ n: number; chofer: string | null; base: string | null; base_nombre: string | null; base_direccion: string | null; salida: number; orden: string; a_mano: number;
      fin: string | null; fin_nombre: string | null; fin_direccion: string | null }>()).results;
  const { geo, pendientes } = await ubicar(env, [...cfg.bases.map((x) => x.direccion), ...guardadas.filter((r) => r.base === 'otro' && r.base_direccion).map((r) => r.base_direccion!),
    ...guardadas.filter((r) => r.fin === 'otro' && r.fin_direccion).map((r) => r.fin_direccion!),
    ...lista_.map((p) => p.direccion).filter((d): d is string => !!d)], buscar);
  for (const p of lista_) {
    const g = p.direccion ? geo.get(claveDireccion(p.direccion)) : null;
    if (g) { p.lat = g.lat; p.lng = g.lng; p.punto_manual = g.manual; }
    // Validada con Google Maps en la tarjeta del pedido: el punto de Google, aunque el buscador del mapa no la haya buscado.
    else { const pg = p.direccion ? puntoGoogle.get(claveDireccion(p.direccion)) : undefined; if (pg) { p.lat = pg.lat; p.lng = pg.lng; } }
  }

  const visitas = new Map((await db.prepare('SELECT clave, resultado, motivo, nota, chofer, at FROM cronograma_visitas WHERE fecha = ?').bind(fecha)
    .all<Visita & { clave: string }>()).results.map((x) => [x.clave, x]));
  for (const p of lista_) { const x = visitas.get(p.clave); p.visita = x ? { resultado: x.resultado, motivo: x.motivo, nota: x.nota, chofer: x.chofer, at: x.at } : null; }

  // «Sale de» y «Termina en»: un depósito de Formas o, con «otro», el lugar que se eligió (con su punto en el mapa).
  const rutas: RutaGuardada[] = guardadas.length
    ? guardadas.map((r) => {
      const otro = r.base === 'otro' && r.base_direccion ? r.base_direccion : null;
      const g = otro ? geo.get(claveDireccion(otro)) : null;
      const finOtro = r.fin === 'otro' && r.fin_direccion ? r.fin_direccion : null;
      const gf = finOtro ? geo.get(claveDireccion(finOtro)) : null;
      return { n: r.n, chofer: r.chofer, salida: r.salida, orden: lista(r.orden).map(String), a_mano: !!r.a_mano,
        base: otro ? 'otro' : cfg.bases.some((x) => x.id === r.base) ? r.base! : cfg.bases[0].id,
        base_otro: otro ? { nombre: r.base_nombre || otro, direccion: otro, lat: g?.lat ?? null, lng: g?.lng ?? null } : null,
        fin: finOtro ? 'otro' : r.fin === 'ultima' ? 'ultima' : r.fin && cfg.bases.some((x) => x.id === r.fin) ? r.fin : 'igual',
        fin_otro: finOtro ? { nombre: r.fin_nombre || finOtro, direccion: finOtro, lat: gf?.lat ?? null, lng: gf?.lng ?? null } : null };
    })
    : [{ n: 1, chofer: null, base: cfg.bases[0].id, salida: 510, orden: [], a_mano: false, fin: 'igual', fin_otro: null }];
  // Las paradas que no están en ningún recorrido (un movimiento que se pasó a este día después de armarlo) van al primero,
  // también para el chofer; las que ya no existen se sacan.
  const existen = new Set(lista_.map((p) => p.clave)), vistas = new Set<string>();
  for (const r of rutas) r.orden = r.orden.filter((c) => existen.has(c) && !vistas.has(c) && (vistas.add(c), true));
  rutas[0].orden.push(...lista_.map((p) => p.clave).filter((c) => !vistas.has(c)));
  const bases = cfg.bases.map((x) => { const g = geo.get(claveDireccion(x.direccion)); return { ...x, lat: g?.lat ?? null, lng: g?.lng ?? null }; });
  // Los recorridos que nadie ordenó a mano (los armaron las tarjetas de la semana, o todavía nadie los tocó) van por el
  // más corto, también en la app del chofer; se vuelven a ordenar a medida que se ubican las direcciones.
  const porClave = new Map(lista_.map((p) => [p.clave, p]));
  for (const r of rutas) {
    if (r.a_mano || r.orden.length < 2) continue;
    r.orden = optimizar(salidaDe(r, bases), r.orden.map((c) => porClave.get(c)!), r.salida, destinoDe(r, bases)).map((p) => p.clave);
  }
  const { choferes, con_link, expresos } = await choferesYExpresos(db, transportistas);
  return {
    fecha, paradas: lista_, llegan, retiran, rutas, guardada: guardadas.length > 0, choferes, con_link, expresos, bases,
    buscando: pendientes + fin.pendientes, puede_editar: puedeEditarCronograma(user),
  };
}

// Desde la Ruta del día. Cada recorrido dice si alguien ordenó sus paradas a mano (`a_mano`); si no lo dice (la pantalla de
// antes), cuenta como ordenado a mano, como hasta ahora.
export async function guardarRutas(db: D1Database, ctx: Ctx, b: { fecha?: unknown; rutas?: unknown }) {
  exigir(ctx);
  if (!esDia(b.fecha)) throw new HttpError(400, 'Falta el día.');
  const rutas = (Array.isArray(b.rutas) ? b.rutas : []).slice(0, 8) as Array<Partial<RutaGuardada>>;
  if (!rutas.length) throw new HttpError(400, 'Falta el recorrido.');
  await escribirRutas(db, ctx, b.fecha, rutas);
  return { ok: true };
}
async function escribirRutas(db: D1Database, ctx: Ctx, fecha: string, rutas: Array<Partial<RutaGuardada>>) {
  const ts = now();
  await db.batch([
    db.prepare('DELETE FROM cronograma_rutas WHERE fecha = ?').bind(fecha),
    ...rutas.map((r, i) => {
      // Dónde termina: NULL vuelve a donde salió.
      const fin = r.fin === 'ultima' ? 'ultima' : r.fin === 'otro' ? (r.fin_otro?.direccion ? 'otro' : null) : r.fin && r.fin !== 'igual' ? String(r.fin).slice(0, 40) : null;
      return db.prepare(`INSERT INTO cronograma_rutas (fecha, n, chofer, base, base_nombre, base_direccion, salida, orden, a_mano, fin, fin_nombre, fin_direccion, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(fecha, i + 1, r.chofer ? String(r.chofer).slice(0, 80) : null, r.base ? String(r.base).slice(0, 40) : null,
          r.base === 'otro' && r.base_otro?.direccion ? String(r.base_otro.nombre ?? '').trim().slice(0, 120) || null : null,
          r.base === 'otro' && r.base_otro?.direccion ? String(r.base_otro.direccion).trim().slice(0, 300) : null,
          Math.min(1439, Math.max(0, Math.round(Number(r.salida) || 510))), JSON.stringify((Array.isArray(r.orden) ? r.orden : []).map(String)),
          r.a_mano === false ? 0 : 1, fin,
          fin === 'otro' ? String(r.fin_otro!.nombre ?? '').trim().slice(0, 120) || null : null,
          fin === 'otro' ? String(r.fin_otro!.direccion).trim().slice(0, 300) : null, ctx.user.id, ts);
    }),
  ]);
}

// El chofer de una tarjeta de la semana (pedido de Rodrigo del 13/11/2026): su parada pasa al recorrido de ese día que
// tiene ese chofer o expreso; si no hay, se arma uno nuevo que sale del mismo lugar y a la misma hora que el primero. Pasa
// la parada entera: tres retiros en el mismo impresor son una sola, y un pedido que va a varias direcciones pasa con
// todas. En un recorrido ordenado a mano entra donde menos lo alarga; en uno que se ordena solo, lo ordena rutaDelDia.
// Sin chofer va a un recorrido sin chofer. Un recorrido sin chofer que queda vacío se saca.
export async function asignarChofer(env: Env, ctx: Ctx, b: { fecha?: unknown; ids?: unknown; chofer?: unknown }) {
  exigir(ctx);
  if (!esDia(b.fecha)) throw new HttpError(400, 'Falta el día.');
  const fecha = b.fecha;
  const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean));
  if (!ids.size) throw new HttpError(400, 'Falta qué movimiento.');
  const r = await rutaDelDia(env, ctx.user, fecha);
  const pedido = String(b.chofer ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // Con el nombre como está en la lista.
  const chofer = pedido ? [...r.choferes, ...r.expresos.map((x) => x.nombre)].find((n) => norm(n) === norm(pedido)) ?? pedido : null;
  const paradas = r.paradas.filter((p) => p.movimientos.some((m) => ids.has(m.id)) || p.encargos.some((e) => ids.has(`enc:${e.id}`)));
  if (!paradas.length) throw new HttpError(400, 'Eso no es una parada de la ruta de ese día: lo retira el cliente en Formas, es un ingreso al depósito o el encargo ya no es de ese día.');
  const claves = new Set(paradas.map((p) => p.clave));
  const rutas: RutaGuardada[] = r.rutas.map((x) => ({ ...x, orden: x.orden.filter((c) => !claves.has(c)) }));
  let destino = rutas.find((x) => (chofer ? !!x.chofer && norm(x.chofer) === norm(chofer) : !x.chofer));
  if (!destino) {
    if (rutas.length >= 8) throw new HttpError(400, 'Ese día ya tiene 8 recorridos: pasá la parada desde la Ruta del día.');
    destino = { n: rutas.length + 1, chofer, base: rutas[0].base, base_otro: rutas[0].base_otro ?? null, salida: rutas[0].salida, orden: [], a_mano: false, fin: 'igual', fin_otro: null };
    rutas.push(destino);
  }
  if (destino.a_mano) {
    const porClave = new Map(r.paradas.map((p) => [p.clave, p]));
    for (const p of paradas) destino.orden = dondeEntra(salidaDe(destino, r.bases), destinoDe(destino, r.bases), destino.orden, p, porClave, destino.salida);
  } else destino.orden.push(...claves);
  const quedan = rutas.filter((x) => x === destino || x.chofer || x.orden.length);
  await escribirRutas(env.DB, ctx, fecha, quedan);
  return { ok: true, chofer: destino.chofer, recorrido: quedan.indexOf(destino) + 1, paradas: paradas.length, movimientos: paradas.reduce((n, p) => n + p.movimientos.length + p.encargos.length, 0) };
}
// Dónde entra una parada en un recorrido que alguien ordenó: en el lugar que menos lo alarga. Sin ubicar, al final.
function dondeEntra(salida: Punto | null, fin: Destino, orden: string[], p: Parada, porClave: Map<string, Parada>, hora: number) {
  const actual = orden.map((c) => porClave.get(c)).filter((x): x is Parada => !!x);
  if (!salida || p.lat == null || p.lng == null || actual.length !== orden.length) return [...orden, p.clave];
  let mejor = orden.length, costo = Infinity;
  for (let i = 0; i <= actual.length; i++) {
    const c = simular(salida, [...actual.slice(0, i), p, ...actual.slice(i)], hora, null, fin).costo;
    if (c < costo - 0.01) { costo = c; mejor = i; }
  }
  return [...orden.slice(0, mejor), p.clave, ...orden.slice(mejor)];
}

// El recorrido de un chofer para la app de los remitos (/hooks/chofer): las paradas en el orden que armó Logística, con
// la dirección y lo que hay que retirar o entregar en cada una. Es el recorrido de hoy que tiene su nombre (el del link;
// no puede haber dos links activos con el mismo nombre). Solo el de hoy: el link del chofer no sirve para otros días.
// Desde acá no se busca nada afuera (Finnegans, el mapa, Claude): eso lo dispara Logística al armar la ruta.
export async function rutaDelChofer(env: Env, user: User, chofer: string) {
  const dia = hoyBsAs();
  const r = await rutaDelDia(env, user, dia);
  const nombre = norm(chofer);
  const suyas = r.guardada ? r.rutas.filter((x) => x.chofer && norm(x.chofer) === nombre) : [];
  const porClave = new Map(r.paradas.map((p) => [p.clave, p]));
  return {
    fecha: dia,
    recorridos: suyas.map((x) => {
      const base = lugarSalida(x, r.bases), fin = lugarFin(x, r.bases);
      return {
        n: x.n, salida: x.salida, base: { nombre: base.nombre, direccion: base.direccion, lat: base.lat, lng: base.lng },
        // Dónde termina: null si termina en la última parada; `vuelve`: es el mismo lugar de donde sale.
        fin: fin ? { nombre: fin.nombre, direccion: fin.direccion, lat: fin.lat, lng: fin.lng } : null, vuelve: !!fin && fin.direccion === base.direccion,
        paradas: x.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p).map((p) => ({
          clave: p.clave, nombre: p.nombre, direccion: p.direccion, lat: p.lat, lng: p.lng, horario: p.horario,
          expreso: p.expreso ? { guia: p.expreso.guia, cliente: p.expreso.cliente } : null,
          visita: p.visita ? { resultado: p.visita.resultado, motivo: p.visita.motivo, nota: p.visita.nota } : null,
          lugar: p.lugar ? { horario: p.lugar.horario, telefono: p.lugar.telefono, contacto: p.lugar.contacto, observaciones: p.lugar.observaciones } : null,
          movimientos: p.movimientos.map((m) => ({ id: m.id, tipo: m.tipo, npdv: m.npdv, cliente: m.tipo === 'entrega' ? null : m.cliente, articulo: m.articulo, cantidad: m.cantidad, hecho: m.hecho })),
          encargos: p.encargos.map((e) => ({ id: e.id, llevar: e.llevar, retirar: e.retirar, desde: nombreBase(e.desde, r.bases), hacia: nombreBase(e.hacia, r.bases),
            horario: e.horario, contacto: e.contacto, notas: e.notas, urgente: e.urgente, quien: e.quien, estado: e.estado })),
        })),
      };
    }),
  };
}

// Por qué no se pudo hacer una parada. Son los motivos que usan las apps de reparto (nadie para recibir, cerrado,
// dirección incorrecta, rechazo), más «no estaba listo» para los retiros en proveedores e impresores.
export const MOTIVOS: Record<string, string> = {
  nadie: 'No había nadie', cerrado: 'Estaba cerrado', direccion: 'No encontré la dirección', rechazo: 'No lo quisieron recibir',
  no_listo: 'No estaba listo', otro: 'Otro motivo',
};

// El chofer marca una parada de su recorrido de hoy: la hizo (los artículos cambian de estado en ClickUp, a su nombre),
// no se pudo (con el motivo) o la deja para más tarde. `resultado` vacío borra lo marcado. Al deshacer un «hecho» se
// vuelve atrás solo lo que marcó él en esa parada, no lo que había marcado Logística. Repetir lo mismo no hace nada.
export async function marcarParada(env: Env, ctx: Ctx, chofer: string, b: { clave?: unknown; resultado?: unknown; motivo?: unknown; nota?: unknown }, enFondo?: (p: Promise<unknown>) => void) {
  const fecha = hoyBsAs();
  const clave = String(b.clave ?? '');
  const resultado = b.resultado == null || b.resultado === '' ? null : String(b.resultado);
  if (resultado && !['hecho', 'no_se_pudo', 'salteada'].includes(resultado)) throw new HttpError(400, 'Resultado desconocido.');
  const motivo = resultado === 'no_se_pudo' ? String(b.motivo ?? '') : null;
  if (resultado === 'no_se_pudo' && !(motivo! in MOTIVOS)) throw new HttpError(400, 'Falta el motivo.');
  const nota = String(b.nota ?? '').trim().slice(0, 300) || null;
  const r = await rutaDelDia(env, ctx.user, fecha);
  const nombre = norm(chofer);
  const suya = r.guardada && r.rutas.some((x) => x.chofer && norm(x.chofer) === nombre && x.orden.includes(clave));
  const parada = r.paradas.find((p) => p.clave === clave);
  if (!suya || !parada) throw new HttpError(404, 'Esa parada no está en tu recorrido de hoy. Puede que Logística lo haya cambiado: actualizá la pantalla.');
  const db = env.DB;
  const entrega = parada.movimientos.some((m) => m.tipo === 'entrega');
  const antes = await db.prepare('SELECT resultado, motivo, nota, marcados FROM cronograma_visitas WHERE fecha = ? AND clave = ?').bind(fecha, clave)
    .first<{ resultado: string; motivo: string | null; nota: string | null; marcados: string }>();
  if ((antes?.resultado ?? null) === resultado && (antes?.motivo ?? null) === motivo && (antes?.nota ?? null) === (resultado ? nota : null)) return { ok: true, entrega };
  let marcados = (lista(antes?.marcados) as Array<{ id: string; tipo: Tipo }>).filter((x) => x && esTipo(x.tipo));
  const encPrevios = (lista(antes?.marcados) as Array<{ id: string; tipo: string; antes?: string }>).filter((x) => x && x.tipo === 'encargo');
  const porTipo = (xs: Array<{ id: string; tipo: Tipo }>) => { const m = new Map<Tipo, string[]>(); for (const x of xs) m.set(x.tipo, [...(m.get(x.tipo) ?? []), x.id]); return m; };
  const deATandas = async (ids: string[], tipo: Tipo, hecho: boolean) => {
    const hechos: string[] = [];
    for (let i = 0; i < ids.length; i += MAX_POR_VEZ) hechos.push(...(await marcarHecho(env, ctx, { ids: ids.slice(i, i + MAX_POR_VEZ), tipo, hecho }, { chofer, enFondo })).marcados);
    return hechos;
  };
  if (resultado === 'hecho' && antes?.resultado !== 'hecho') {
    // Primero los artículos (si ClickUp falla, la parada no queda como hecha) y después la visita.
    marcados = [];
    for (const [tipo, ids] of porTipo(parada.movimientos.filter((m) => !m.hecho).map((m) => ({ id: m.task_id, tipo: m.tipo })))) {
      for (const id of await deATandas(ids, tipo, true)) marcados.push({ id, tipo });
    }
  } else if (resultado !== 'hecho' && antes?.resultado === 'hecho') {
    for (const [tipo, ids] of [...porTipo(marcados)].reverse()) await deATandas(ids, tipo, false);
    marcados = [];
  }
  // Los encargos de la parada quedan como los dejó el chofer (hecho o no se pudo, y se le avisa a quien lo pidió); al
  // deshacer o dejarla para después vuelven a como estaban.
  const encMarcados = await encargosDelChofer(db, chofer, parada.encargos, encPrevios, resultado, resultado === 'no_se_pudo' ? `${MOTIVOS[motivo!]}${nota ? `: ${nota}` : ''}` : null);
  if (resultado) {
    await db.prepare('INSERT OR REPLACE INTO cronograma_visitas (fecha, clave, resultado, motivo, nota, chofer, token_id, marcados, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(fecha, clave, resultado, motivo, nota, chofer, ctx.tokenId ?? null, JSON.stringify([...marcados, ...encMarcados]), now()).run();
  } else await db.prepare('DELETE FROM cronograma_visitas WHERE fecha = ? AND clave = ?').bind(fecha, clave).run();
  return { ok: true, entrega };
}

// ---------- Encargos (Recorridos, recorridos.ts) en el cronograma ----------

// Lo que alguien le pidió al recorrido de un día: a dónde, qué se deja y qué se retira. Acá solo lo que necesitan el
// cronograma, la ruta del día y la app del chofer; cargarlos, editarlos y lo demás está en recorridos.ts.
export interface ItemEnc { cant: number | null; que: string; pdv: string | null }
export type EstadoEnc = 'pendiente' | 'hecho' | 'no_se_pudo' | 'cancelado';
export interface EncargoDia {
  id: number; fecha: string; user_id: number | null; quien: string | null; destino: string; direccion: string | null; lugar_id: number | null; company_id: number | null;
  record_id: number | null; llevar: ItemEnc[]; retirar: ItemEnc[]; desde: string | null; hacia: string | null; horario: string | null; contacto: string | null;
  notas: string | null; urgente: boolean; estado: EstadoEnc; motivo: string | null; remito: number | null; hecho_chofer: string | null; hecho_por: number | null;
  origen: string; created_at: string;
  chofer?: string | null;   // en la semana: el chofer del recorrido en el que cae su parada
  parada?: string;          // en la semana: la parada en la que cae
}
export interface EncargoFila {
  id: number; fecha: string; user_id: number | null; pedido_por: string | null; quien: string | null; destino: string; direccion: string | null; lugar_id: number | null;
  company_id: number | null; record_id: number | null; llevar: string; retirar: string; desde: string | null; hacia: string | null; horario: string | null; contacto: string | null;
  notas: string | null; urgente: number; estado: EstadoEnc; motivo: string | null; remito: number | null; hecho_chofer: string | null; hecho_por: number | null; origen: string; created_at: string;
}
export const SELECT_ENC = 'SELECT e.*, COALESCE(u.name, e.pedido_por) AS quien FROM encargos e LEFT JOIN users u ON u.id = e.user_id';
const itemsDe = (s: string): ItemEnc[] => (lista(s) as ItemEnc[]).filter((x) => x && typeof x.que === 'string');
export const aEncargo = (r: EncargoFila): EncargoDia => ({
  id: r.id, fecha: r.fecha, user_id: r.user_id, quien: r.quien, destino: r.destino, direccion: r.direccion, lugar_id: r.lugar_id, company_id: r.company_id, record_id: r.record_id,
  llevar: itemsDe(r.llevar), retirar: itemsDe(r.retirar), desde: r.desde, hacia: r.hacia, horario: r.horario, contacto: r.contacto, notas: r.notas, urgente: !!r.urgente,
  estado: r.estado, motivo: r.motivo, remito: r.remito, hecho_chofer: r.hecho_chofer, hecho_por: r.hecho_por, origen: r.origen, created_at: r.created_at,
});
// Los de esos días, sin los cancelados ni el historial de la planilla.
export async function encargosEntre(db: D1Database, desde: string, hasta: string) {
  // El historial que se trajo de la planilla vieja (origen «planilla») no va: lo de esos días ya está en ClickUp.
  const { results } = await db.prepare(`${SELECT_ENC} WHERE e.fecha BETWEEN ? AND ? AND e.estado <> 'cancelado' AND e.origen = 'hub' ORDER BY e.id`).bind(desde, hasta).all<EncargoFila>();
  return results.map(aEncargo);
}
export async function lugaresPorId(db: D1Database, ids: Array<number | null>) {
  const l = [...new Set(ids.filter((x): x is number => !!x))];
  if (!l.length) return new Map<number, Lugar>();
  const { results } = await db.prepare('SELECT * FROM lugares WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(l)).all<Lugar>();
  return new Map(results.map((x) => [x.id, x]));
}
const nombreBase = (id: string | null, bases: Base[]) => (id ? bases.find((b) => b.id === id)?.nombre ?? null : null);

// Un lugar al que se va, para saber si dos cosas van al mismo lado: la parada de un movimiento, un encargo, un destino.
export interface Sitio { clave?: string; nombre: string; company_id?: number | null; lugar_id?: number | null; direccion?: string | null }
// La localidad de una dirección («Av. Libertador 1855, Vicente López» → «vicente lopez»), sin la provincia ni el país.
function localidad(d: string | null | undefined) {
  const p = String(d ?? '').split(',').slice(1).map((x) => norm(x).replace(/\b(provincia de|pcia\.? de|argentina|buenos aires|bs\.? as\.?)\b/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const l = p[0] ?? '';
  return /^(caba|c a b a|capital federal|ciudad autonoma.*)$/.test(l) ? 'caba' : l;
}
// Son el mismo lugar si son el mismo destino de la libreta; si las dos tienen calle y altura, manda la dirección (dos
// lugares de Nestlé son distintos, dos empresas en el mismo edificio son la misma parada), y la misma calle y altura en
// dos localidades distintas son dos lugares; si no, la misma empresa o el mismo nombre («IMPREFAS» de la libreta es el
// impresor IMPREFAS de ClickUp).
export function mismoSitio(a: Sitio, b: Sitio) {
  if (a.lugar_id && a.lugar_id === b.lugar_id) return true;
  const ca = a.direccion ? claveCalle(a.direccion) : '', cb = b.direccion ? claveCalle(b.direccion) : '';
  if (ca && cb) {
    if (ca !== cb) return false;
    const la = localidad(a.direccion), lb = localidad(b.direccion);
    return !la || !lb || la === lb || la.includes(lb) || lb.includes(la);
  }
  if (a.company_id && a.company_id === b.company_id) return true;
  const kb = new Set(clavesDeNombre(b.nombre));
  return clavesDeNombre(a.nombre).some((k) => kb.has(k));
}
// La parada propia de un encargo: la de su lugar de la libreta, la de su empresa (la misma que la de un retiro o un egreso
// en ese proveedor o impresor) o la de su dirección.
export const claveEncargo = (e: Pick<EncargoDia, 'company_id' | 'lugar_id' | 'direccion' | 'destino'>) => {
  if (e.lugar_id) return `l:${e.lugar_id}`;
  if (e.company_id) return `e:${e.company_id}`;
  const calle = e.direccion ? claveCalle(e.direccion) : '';
  return calle ? `d:${calle}${localidad(e.direccion) ? `|${localidad(e.direccion)}` : ''}` : `d:${claveProveedor(e.destino) || 'sin-destino'}`;
};
// En qué parada cae un encargo: la del mismo lugar, si ese día ya se va ahí; si no, la suya. Una parada con la misma
// clave pero en otra dirección (otra sucursal de la misma empresa) no es la misma: el encargo va aparte.
export function anfitrion(e: EncargoDia, sitios: Sitio[]) {
  const propia = claveEncargo(e);
  const yo: Sitio = { nombre: e.destino, company_id: e.company_id, lugar_id: e.lugar_id, direccion: e.direccion };
  const misma = sitios.find((s) => s.clave === propia);
  if (misma && mismoSitio(yo, misma)) return propia;
  const otro = sitios.find((s) => s.clave && mismoSitio(yo, s));
  if (otro) return otro.clave!;
  return misma ? `x:${e.id}` : propia;
}

// Un aviso de la campanita sobre un encargo, a quien lo pidió (o a quienes se diga). No sale por mail.
export async function avisarEncargo(db: D1Database, para: Array<number | null | undefined>, encargoId: number, detalle: string, byUser: number | null) {
  const a = [...new Set(para.filter((x): x is number => !!x && x !== byUser))];
  if (!a.length) return;
  const ts = now();
  await db.batch(a.map((u) => db.prepare("INSERT INTO avisos (user_id, kind, encargo_id, detalle, by_user, sent_at, error) VALUES (?, 'encargo', ?, ?, ?, ?, 'solo en el Hub')")
    .bind(u, encargoId, detalle.slice(0, 300), byUser, ts)));
}

// Lo que marca el chofer en una parada, en sus encargos: «hecho» o «no se pudo» (los pendientes, o los que antes no se
// pudieron); al deshacerlo, o si la deja para después, vuelven a como estaban. Lo que marcó Logística no se toca.
// Devuelve lo que quedó marcado por el chofer (para poder deshacerlo).
async function encargosDelChofer(db: D1Database, chofer: string, encs: EncargoDia[], previos: Array<{ id: string; antes?: string }>, resultado: string | null, porQue: string | null) {
  const nuevo: EstadoEnc | null = resultado === 'hecho' ? 'hecho' : resultado === 'no_se_pudo' ? 'no_se_pudo' : null;
  const prev = new Map(previos.map((x) => [Number(String(x.id).replace(/^enc:/, '')), (x.antes ?? 'pendiente') as EstadoEnc]));
  const ts = now(), stmts: D1PreparedStatement[] = [], out: Array<{ id: string; tipo: 'encargo'; antes: EstadoEnc }> = [];
  const avisos: Array<[EncargoDia, string]> = [];
  for (const e of encs) {
    const antes = prev.get(e.id) ?? e.estado;
    if (nuevo && (antes === 'pendiente' || antes === 'no_se_pudo')) {
      if (e.estado !== nuevo || e.motivo !== porQue) {
        stmts.push(db.prepare('UPDATE encargos SET estado = ?, motivo = ?, hecho_chofer = ?, hecho_por = NULL, hecho_at = ?, updated_at = ? WHERE id = ?').bind(nuevo, porQue, chofer, ts, ts, e.id));
        avisos.push([e, nuevo === 'hecho' ? `${chofer} lo marcó hecho.` : `No se pudo (${chofer}): ${porQue ?? ''}`.trim()]);
      }
      e.estado = nuevo; e.motivo = porQue;
      out.push({ id: `enc:${e.id}`, tipo: 'encargo', antes });
    } else if (prev.has(e.id) && e.estado !== antes && e.hecho_chofer === chofer) {
      // Si Logística lo cambió después (hecho_chofer queda vacío), queda como lo dejó Logística.
      stmts.push(db.prepare('UPDATE encargos SET estado = ?, motivo = NULL, hecho_chofer = NULL, hecho_at = NULL, updated_at = ? WHERE id = ?').bind(antes, ts, e.id));
      e.estado = antes; e.motivo = null;
    }
  }
  if (stmts.length) await db.batch(stmts);
  for (const [e, detalle] of avisos) await avisarEncargo(db, [e.user_id], e.id, detalle, null);
  return out;
}

// ---------- Choferes y expresos ----------

export interface Transportista { id: number; nombre: string; tipo: 'chofer' | 'expreso'; direccion: string | null }
export async function listarTransportistas(db: D1Database) {
  return (await db.prepare('SELECT id, nombre, tipo, direccion FROM transportistas WHERE activo = 1 ORDER BY nombre').all<Transportista>()).results;
}
// Agrega un chofer o un expreso a la lista (o, si ya estaba, le cambia el tipo o la dirección y lo vuelve a activar).
export async function guardarTransportista(db: D1Database, ctx: Ctx, b: { nombre?: unknown; tipo?: unknown; direccion?: unknown }) {
  exigir(ctx);
  const nombre = String(b.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tipo = b.tipo === 'expreso' ? 'expreso' : 'chofer';
  const direccion = tipo === 'expreso' ? String(b.direccion ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
  if (nombre.length < 2) throw new HttpError(400, 'Escribí el nombre.');
  const todos = (await db.prepare('SELECT id, nombre FROM transportistas').all<{ id: number; nombre: string }>()).results;
  const ya = todos.find((x) => norm(x.nombre) === norm(nombre));
  if (ya) { await db.prepare('UPDATE transportistas SET nombre = ?, tipo = ?, direccion = COALESCE(?, direccion), activo = 1 WHERE id = ?').bind(nombre, tipo, direccion, ya.id).run(); return { id: ya.id, nombre, tipo }; }
  const r = await db.prepare('INSERT INTO transportistas (nombre, tipo, direccion, created_by) VALUES (?, ?, ?, ?) RETURNING id').bind(nombre, tipo, direccion, ctx.user.id).first<{ id: number }>();
  return { id: r!.id, nombre, tipo };
}
export async function quitarTransportista(db: D1Database, ctx: Ctx, id: number) {
  exigir(ctx);
  await db.prepare('UPDATE transportistas SET activo = 0 WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function expresosDe(db: D1Database, claves: string[]) {
  const out = new Map<string, { expreso: string; guia: string | null }>();
  const unicas = [...new Set(claves)];
  if (!unicas.length) return out;
  const { results } = await db.prepare('SELECT clave, expreso, guia FROM entrega_expresos WHERE clave IN (SELECT value FROM json_each(?))').bind(JSON.stringify(unicas))
    .all<{ clave: string; expreso: string; guia: string | null }>();
  for (const r of results) out.set(r.clave, { expreso: r.expreso, guia: r.guia });
  return out;
}
// Una entrega va por expreso (o vuelve a ir directo, con `expreso` vacío). El número de guía se puede cargar después.
export async function guardarExpreso(db: D1Database, ctx: Ctx, b: { clave?: unknown; record_id?: unknown; expreso?: unknown; guia?: unknown }) {
  exigir(ctx);
  const clave = String(b.clave ?? '');
  if (!/^p:[\w-]+(:\d+)?$/.test(clave)) throw new HttpError(400, 'Solo una entrega puede ir por expreso.');
  const expreso = String(b.expreso ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!expreso) { await db.prepare('DELETE FROM entrega_expresos WHERE clave = ?').bind(clave).run(); return { ok: true }; }
  await db.prepare('INSERT OR REPLACE INTO entrega_expresos (clave, record_id, expreso, guia, user_id, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(clave, Number(b.record_id) || null, expreso, String(b.guia ?? '').trim().slice(0, 80) || null, ctx.user.id, now()).run();
  return { ok: true };
}

// ---------- La libreta de direcciones ----------

export interface Lugar { id: number; nombre: string; direccion: string | null; localidad: string | null; zona: string | null; horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null; coordinacion: string | null }
export const infoLugar = (l: Lugar): LugarInfo => ({ nombre: l.nombre, horario: l.horario, telefono: l.telefono, contacto: l.contacto, observaciones: l.observaciones, coordinacion: l.coordinacion });

// La dirección completa de un lugar: la calle, la localidad y, si es del conurbano, la provincia.
export function direccionLugar(l: { direccion: string | null; localidad: string | null; zona: string | null }) {
  const dir = String(l.direccion ?? '').replace(/\s+/g, ' ').trim();
  const loc = String(l.localidad ?? '').replace(/\s+/g, ' ').trim(), zona = norm(String(l.zona ?? ''));
  const partes = [dir];
  if (loc && !norm(dir).includes(norm(loc))) partes.push(loc);
  const caba = zona === 'caba' || norm(loc) === 'caba';
  if (caba && !/\bcaba\b/i.test(partes.join(' '))) partes.push('CABA');
  else if (!caba && ['norte', 'oeste', 'sur', 'noroeste'].includes(zona)) partes.push('Buenos Aires');
  return partes.filter(Boolean).join(', ');
}
// Calle y altura, para reconocer la misma dirección escrita distinto: sin localidad, artículos, piso ni puntuación
// («Av. Del Libertador 1855, Vicente López» y «AV LIBERTADOR 1855» dan lo mismo). Vacío si no tiene altura.
export function claveCalle(direccion: string) {
  const k = claveDireccion(direccion.split(',')[0]).replace(/\b(del|de|la|las|los|el|cp)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const m = k.match(/^(.*?\D)\s*(\d{1,6})\b/);
  return m && m[1].trim().length > 2 ? `${m[1].trim()} ${m[2]}` : '';
}
// Los nombres con los que se reconoce un lugar o una empresa: entero, sin lo que está entre paréntesis o después de un
// guion, cada parte de «A / B», y la primera palabra si es larga («NESTLE ARGENTINA S.A.» también es «nestle»). La
// primera palabra va además con «~» adelante: así se guarda en la libreta («NESTLE FLORENCIA» es «~nestle») sin que
// cuente como llamarse igual.
export function clavesDeNombre(nombre: string, conPrimera = false) {
  const out = new Set<string>();
  const base = nombre.replace(/\(.*?\)|\(.*$/g, ' ').split(/\s+-\s+/)[0];
  for (const parte of [nombre, base, ...base.split('/')]) { const k = claveProveedor(parte); if (k.length > 2) out.add(k); }
  if (conPrimera) { const p = norm(base).split(/[^a-z0-9]+/).filter(Boolean)[0] ?? ''; if (p.length >= 5) { out.add(p); out.add(`~${p}`); } }
  return [...out];
}
// De varios lugares con el mismo nombre, el que se usa solo: si hay uno, ese; si todos son la misma dirección, el primero;
// si uno solo es el depósito, ese. Si no, ninguno (se elige a mano en la parada).
export function unicoLugar(ls: Lugar[]): Lugar | null {
  const con = ls.filter((l) => l.direccion && claveCalle(l.direccion));
  if (!con.length) return null;
  if (new Set(con.map((l) => claveCalle(l.direccion!))).size === 1) return con[0];
  const depo = con.filter((l) => /dep[oó]sito/i.test(l.nombre));
  return depo.length === 1 ? depo[0] : null;
}
// Los lugares de la libreta para cada nombre. `exactos`: se llaman igual (sirven para usar la dirección sola).
// `parecidos`: además los que empiezan con la misma palabra («NESTLE ARGENTINA S.A.» → todos los «NESTLE…»): solo se
// ofrecen para elegir, nunca se usan solos.
export async function lugaresPara(db: D1Database, nombres: string[]) {
  const out = new Map<string, { exactos: Lugar[]; parecidos: Lugar[] }>();
  const claves = new Map(nombres.map((n) => [n, { exactas: clavesDeNombre(n), todas: clavesDeNombre(n, true) }]));
  const todas = [...new Set([...claves.values()].flatMap((c) => c.todas))];
  if (!todas.length) return out;
  const { results } = await db.prepare(`SELECT c.clave, l.* FROM lugares_claves c JOIN lugares l ON l.id = c.lugar_id WHERE c.clave IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(todas)).all<Lugar & { clave: string }>();
  const sinRepetir = (ls: Lugar[]) => [...new Map(ls.map((r) => [r.id, r])).values()];
  for (const [n, k] of claves) out.set(n, { exactos: sinRepetir(results.filter((r) => k.exactas.includes(r.clave))), parecidos: sinRepetir(results.filter((r) => k.todas.includes(r.clave))) });
  return out;
}
export async function lugaresPorDireccion(db: D1Database, direcciones: string[]) {
  const claves = [...new Set(direcciones.map(claveCalle).filter(Boolean))];
  const out = new Map<string, Lugar>();
  if (!claves.length) return out;
  const { results } = await db.prepare('SELECT * FROM lugares WHERE activo = 1 AND clave_dir IN (SELECT value FROM json_each(?)) ORDER BY (horario IS NOT NULL) + (observaciones IS NOT NULL) DESC')
    .bind(JSON.stringify(claves)).all<Lugar & { clave_dir: string }>();
  for (const l of results) if (!out.has(l.clave_dir)) out.set(l.clave_dir, l);
  return out;
}

// Buscar en la libreta, para elegir la dirección de una parada. Primero los lugares de ese cliente o proveedor.
export async function buscarLugares(db: D1Database, q: string, de = '') {
  const texto = norm(q).replace(/[%_]/g, ' ').trim();
  const sugeridos = de ? (await lugaresPara(db, [de])).get(de)?.parecidos ?? [] : [];
  const encontrados = texto.length >= 2 ? (await db.prepare(`SELECT * FROM lugares WHERE activo = 1 AND direccion IS NOT NULL AND (lower(nombre) LIKE ?1 OR lower(direccion) LIKE ?1 OR lower(COALESCE(localidad, '')) LIKE ?1)
      ORDER BY (lower(nombre) LIKE ?2) DESC, nombre LIMIT 25`).bind(`%${texto}%`, `${texto}%`).all<Lugar>()).results : [];
  const vistos = new Set<number>();
  return { lugares: [...(texto ? [] : sugeridos), ...encontrados, ...(texto ? sugeridos : [])].filter((l) => l.direccion && !vistos.has(l.id) && (vistos.add(l.id), true)).slice(0, 25)
    .map((l) => ({ id: l.id, nombre: l.nombre, direccion: direccionLugar(l), horario: l.horario, contacto: l.contacto, observaciones: l.observaciones })) };
}

// CSV con comillas, comas y saltos de línea dentro de una celda.
export function leerCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [], celda = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') comillas = false; else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; fila.push(celda); celda = ''; filas.push(fila); fila = []; }
    else celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

interface LugaresConfig { url: string; at: number; filas: number; error?: string | null; intento?: number }
export async function lugaresConfig(db: D1Database): Promise<LugaresConfig> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'lugares'").first<{ value: string }>();
  try { const c = r ? JSON.parse(r.value) : {}; return { url: String(c.url ?? ''), at: Number(c.at) || 0, filas: Number(c.filas) || 0, error: c.error ?? null, intento: Number(c.intento) || 0 }; } catch { return { url: '', at: 0, filas: 0 }; }
}
// La planilla tiene que ser una hoja de Google publicada como CSV.
const urlValida = (env: Env, url: string) => /^https:\/\/docs\.google\.com\/spreadsheets\/.+output=csv/.test(url) || (!!env.LUGARES_CSV_URL && url === env.LUGARES_CSV_URL);

// Copia la planilla a la libreta. Desde Recorridos (pedido de Rodrigo del 13/11/2026) la libreta es del Hub: cada lugar
// tiene su id para siempre (los encargos lo nombran), así que la copia ya no la borra entera. Suma los lugares nuevos y
// actualiza los que ya estaban (los reconoce por nombre y dirección); lo que se creó en el Hub queda, lo que se corrigió en
// el Hub la planilla ya no lo pisa, y lo que la planilla sacó queda inactivo. `forzar`: ahora; si no, una vez por día, y
// solo cuando la usa alguien que edita (o cuando todavía no se copió nunca). Si la planilla no se puede leer o viene
// vacía, queda la copia anterior.
export const clavePlanilla = (nombre: string, direccion: string | null) => `${norm(nombre).replace(/\s+/g, ' ')}|${claveDireccion(direccion ?? '')}`;
export async function actualizarLugares(env: Env, puede: boolean, forzar = false) {
  const db = env.DB;
  const cfg = await lugaresConfig(db);
  const url = env.LUGARES_CSV_URL || cfg.url;
  // Nunca se copió (por ejemplo, recién migrada): la copia la dispara cualquiera, pero si falló se reintenta en una hora.
  const nunca = !cfg.filas && Date.now() - (cfg.intento ?? 0) > 3_600_000;
  if (!url || (!forzar && !nunca && (!puede || Date.now() - cfg.at < 86_400_000))) return cfg;
  const guardar = (c: LugaresConfig) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('lugares', ?)").bind(JSON.stringify(c)).run().then(() => c);
  try {
    if (!urlValida(env, url)) throw new Error('La dirección tiene que ser la de una hoja de Google publicada como CSV.');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`La planilla contestó HTTP ${res.status}.`);
    const filas = leerCsv(await res.text());
    const cab = (filas.shift() ?? []).map((h) => norm(h));
    const col = (re: RegExp) => cab.findIndex((h) => re.test(h));
    const I = { nombre: col(/proveedor|nombre|lugar|cliente/), direccion: col(/direcc/), horario: col(/atencion|horario/), telefono: col(/telefono/), localidad: col(/localidad/), zona: col(/zona/),
      c1: col(/contacto 1|^contacto/), c2: col(/contacto 2/), obs: col(/observ/), coord: col(/coordinac/) };
    if (I.nombre < 0 || I.direccion < 0) throw new Error('La planilla no tiene las columnas PROVEEDOR y DIRECCION.');
    const t = (f: string[], i: number, max = 600) => (i < 0 ? null : String(f[i] ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
    const vistos = new Set<string>();
    const lugares = filas.map((f) => ({ nombre: t(f, I.nombre, 160), direccion: t(f, I.direccion, 300), localidad: t(f, I.localidad, 80), zona: t(f, I.zona, 40), horario: t(f, I.horario, 160),
      telefono: t(f, I.telefono, 60), contacto: [t(f, I.c1, 80), t(f, I.c2, 80)].filter(Boolean).join(' / ') || null, observaciones: t(f, I.obs), coordinacion: t(f, I.coord, 1200) }))
      .filter((l): l is typeof l & { nombre: string } => !!l.nombre)
      // Dos filas con el mismo nombre y la misma dirección son el mismo lugar: vale la primera.
      .map((l) => ({ ...l, clave: clavePlanilla(l.nombre, l.direccion), clave_dir: l.direccion ? claveCalle(l.direccion) || null : null }))
      .filter((l) => !vistos.has(l.clave) && (vistos.add(l.clave), true));
    if (lugares.length < 1) throw new Error('La planilla vino vacía.');
    const copia = Date.now();
    // De a muchas filas por consulta (un JSON con todas): son miles de lugares. Lo corregido en el Hub no se pisa.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < lugares.length; i += 400) {
      stmts.push(db.prepare(`INSERT INTO lugares (nombre, direccion, localidad, zona, horario, telefono, contacto, observaciones, coordinacion, clave_dir, clave_planilla, origen, activo, visto, updated_at)
        SELECT json_extract(value, '$.nombre'), json_extract(value, '$.direccion'), json_extract(value, '$.localidad'), json_extract(value, '$.zona'), json_extract(value, '$.horario'),
          json_extract(value, '$.telefono'), json_extract(value, '$.contacto'), json_extract(value, '$.observaciones'), json_extract(value, '$.coordinacion'), json_extract(value, '$.clave_dir'),
          json_extract(value, '$.clave'), 'planilla', 1, ?2, ?3
        FROM json_each(?1) WHERE true
        ON CONFLICT(clave_planilla) DO UPDATE SET visto = excluded.visto, activo = CASE WHEN lugares.editado = 1 THEN lugares.activo ELSE 1 END,
          nombre = CASE WHEN lugares.editado = 1 THEN lugares.nombre ELSE excluded.nombre END,
          direccion = CASE WHEN lugares.editado = 1 THEN lugares.direccion ELSE excluded.direccion END,
          localidad = CASE WHEN lugares.editado = 1 THEN lugares.localidad ELSE excluded.localidad END,
          zona = CASE WHEN lugares.editado = 1 THEN lugares.zona ELSE excluded.zona END,
          horario = CASE WHEN lugares.editado = 1 THEN lugares.horario ELSE excluded.horario END,
          telefono = CASE WHEN lugares.editado = 1 THEN lugares.telefono ELSE excluded.telefono END,
          contacto = CASE WHEN lugares.editado = 1 THEN lugares.contacto ELSE excluded.contacto END,
          observaciones = CASE WHEN lugares.editado = 1 THEN lugares.observaciones ELSE excluded.observaciones END,
          coordinacion = CASE WHEN lugares.editado = 1 THEN lugares.coordinacion ELSE excluded.coordinacion END,
          clave_dir = CASE WHEN lugares.editado = 1 THEN lugares.clave_dir ELSE excluded.clave_dir END`)
        .bind(JSON.stringify(lugares.slice(i, i + 400)), copia, now()));
    }
    // Lo que la planilla ya no tiene (y nadie corrigió en el Hub) deja de ofrecerse.
    stmts.push(db.prepare("UPDATE lugares SET activo = 0 WHERE origen = 'planilla' AND editado = 0 AND (visto IS NULL OR visto <> ?)").bind(copia));
    // Todo junto: si algo falla, queda la libreta como estaba.
    await db.batch(stmts);
    await reindexarLugares(db);
    return await guardar({ url: cfg.url, at: Date.now(), filas: lugares.length, error: null });
  } catch (e) {
    console.error('cronograma: libreta', (e as Error).message);
    // Se anota el intento: no se reintenta en cada apertura de la ruta, sino en una hora.
    return await guardar({ ...cfg, at: forzar ? cfg.at : Date.now() - 82_800_000, intento: Date.now(), error: (e as Error).message.slice(0, 200) });
  }
}
// Los nombres con los que se reconoce cada lugar activo (lugares_claves), de nuevo. Con `ids`, solo esos (un lugar que se
// creó o se corrigió en el Hub).
export async function reindexarLugares(db: D1Database, ids?: number[]) {
  const ls = ids
    ? (await db.prepare('SELECT id, nombre, activo FROM lugares WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<{ id: number; nombre: string; activo: number }>()).results
    : (await db.prepare('SELECT id, nombre, activo FROM lugares WHERE activo = 1').all<{ id: number; nombre: string; activo: number }>()).results;
  const pares = ls.filter((l) => l.activo).flatMap((l) => [...new Set([...clavesDeNombre(l.nombre), ...clavesDeNombre(l.nombre, true).filter((x) => x.startsWith('~'))])].map((k) => [k, l.id]));
  const stmts: D1PreparedStatement[] = [ids
    ? db.prepare('DELETE FROM lugares_claves WHERE lugar_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids))
    : db.prepare('DELETE FROM lugares_claves')];
  for (let i = 0; i < pares.length; i += 2000) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO lugares_claves (clave, lugar_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`)
      .bind(JSON.stringify(pares.slice(i, i + 2000))));
  }
  await db.batch(stmts);
}
export async function guardarLugaresConfig(env: Env, b: { url?: unknown }) {
  const url = String(b.url ?? '').trim();
  if (!urlValida(env, url)) throw new HttpError(400, 'Pegá el link de la hoja de Google publicada como CSV (Archivo → Compartir → Publicar en la web → CSV).');
  const cfg = await lugaresConfig(env.DB);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('lugares', ?)").bind(JSON.stringify({ ...cfg, url })).run();
  return actualizarLugares(env, true, true);
}
