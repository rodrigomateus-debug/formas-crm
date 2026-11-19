import type { Ctx } from './env';
import { HttpError, now } from './env';
import { companyKey } from './clickup';

// Anotaciones de logística (pedido de Producción, Rodrigo del 19/11/2026): lo que hay que saber para entregar o retirar,
// con quién lo escribió. Dos alcances:
// - «puntual»: de este pedido y este movimiento (esta entrega, este retiro, este egreso). Se va con el pedido.
// - «siempre»: queda en el destino y aparece cada vez que se va a ese lugar, sea por una entrega, un retiro, un egreso o
//   un encargo de Recorridos. El destino se reconoce por la empresa del Hub, por el lugar de la libreta de Recorridos o
//   por el nombre (el cliente del PDV, que siempre está aunque el pedido no tenga la empresa asociada).
// Las escriben Logística y Producción desde el cronograma, y la vendedora desde su pedido (ahí son de la entrega).
// Se ven en la tarjeta del cronograma, en la parada de la Ruta del día, en la app del chofer y en el pedido.
// Reemplazan las observaciones de entrega de la dirección y de la ficha de la empresa (migración 0097).

export const TIPOS_NOTA = ['entrega', 'ingreso', 'retiro_proveedor', 'egreso', 'retiro_impresor'] as const;
export interface NotaLogistica { id: number; alcance: 'puntual' | 'siempre'; texto: string; por: string | null; user_id: number | null; at: string; destino?: string | null }
// A dónde se va: lo que se sepa de la empresa, el lugar de la libreta y el nombre.
export interface Destino { company_id?: number | null; lugar_id?: number | null; nombre?: string | null }
interface Fila { id: number; alcance: 'puntual' | 'siempre'; record_id: number | null; tipo: string | null; company_id: number | null; lugar_id: number | null; nombre: string | null;
  clave: string | null; texto: string; user_id: number | null; created_at: string; por: string | null }
const SELECT = `SELECT n.id, n.alcance, n.record_id, n.tipo, n.company_id, n.lugar_id, n.nombre, n.clave, n.texto, n.user_id, n.created_at, u.name AS por
  FROM logistica_notas n LEFT JOIN users u ON u.id = n.user_id WHERE n.borrada_at IS NULL`;
const nota = (f: Fila): NotaLogistica => ({ id: f.id, alcance: f.alcance, texto: f.texto, por: f.por, user_id: f.user_id, at: f.created_at, ...(f.alcance === 'siempre' ? { destino: f.nombre } : {}) });
const claveDe = (nombre: string | null | undefined) => { const k = companyKey(String(nombre ?? '')); return k.length >= 3 ? k : null; };

// La empresa de cada pedido (la principal), para las anotaciones «siempre» de sus entregas.
export async function empresaDePedidos(db: D1Database, pedidos: number[]) {
  const out = new Map<number, { id: number; name: string }>();
  if (!pedidos.length) return out;
  const { results } = await db.prepare(`SELECT s.from_id, s.to_id, c.id, c.name, s.is_primary FROM associations s
      JOIN records c ON c.object_type = 'company' AND c.archived = 0 AND c.id IN (s.from_id, s.to_id)
    WHERE s.from_id IN (SELECT value FROM json_each(?1)) OR s.to_id IN (SELECT value FROM json_each(?1)) ORDER BY s.is_primary`)
    .bind(JSON.stringify(pedidos)).all<{ from_id: number; to_id: number; id: number; name: string }>();
  const set = new Set(pedidos);
  // Ordenadas con la principal al final: es la que queda.
  for (const r of results) { const pedido = set.has(r.from_id) && r.from_id !== r.id ? r.from_id : r.to_id; if (set.has(pedido) && pedido !== r.id) out.set(pedido, { id: r.id, name: r.name }); }
  return out;
}

// Las anotaciones de un conjunto de movimientos o encargos, en el mismo orden: las puntuales por pedido y tipo, y las de
// siempre de su destino (por la empresa, por el lugar de la libreta o por el nombre).
export async function notasPara(db: D1Database, items: Array<{ record_id?: number | null; tipo?: string | null; destino: Destino }>): Promise<NotaLogistica[][]> {
  const pedidos = [...new Set(items.filter((m) => m.tipo).map((m) => m.record_id).filter((x): x is number => !!x))];
  const empresas = [...new Set(items.map((m) => m.destino.company_id).filter((x): x is number => !!x))];
  const lugares = [...new Set(items.map((m) => m.destino.lugar_id).filter((x): x is number => !!x))];
  const claves = [...new Set(items.map((m) => claveDe(m.destino.nombre)).filter((x): x is string => !!x))];
  if (!pedidos.length && !empresas.length && !lugares.length && !claves.length) return items.map(() => []);
  const { results } = await db.prepare(`${SELECT} AND ((n.alcance = 'puntual' AND n.record_id IN (SELECT value FROM json_each(?1)))
      OR (n.alcance = 'siempre' AND (n.company_id IN (SELECT value FROM json_each(?2)) OR n.lugar_id IN (SELECT value FROM json_each(?3)) OR n.clave IN (SELECT value FROM json_each(?4)))))
    ORDER BY n.id`).bind(JSON.stringify(pedidos), JSON.stringify(empresas), JSON.stringify(lugares), JSON.stringify(claves)).all<Fila>();
  if (!results.length) return items.map(() => []);
  const siempre = results.filter((f) => f.alcance === 'siempre'), puntuales = results.filter((f) => f.alcance === 'puntual');
  return items.map((m) => {
    const k = claveDe(m.destino.nombre);
    return [
      ...siempre.filter((f) => (!!f.company_id && f.company_id === m.destino.company_id) || (!!f.lugar_id && f.lugar_id === m.destino.lugar_id) || (!!f.clave && f.clave === k)),
      ...(m.tipo && m.record_id ? puntuales.filter((f) => f.record_id === m.record_id && (f.tipo ?? 'entrega') === m.tipo) : []),
    ].map(nota);
  });
}

// El destino de la entrega de un pedido: su empresa y el nombre del cliente del PDV (que está aunque no tenga empresa).
export async function destinoDePedido(db: D1Database, recordId: number): Promise<Destino> {
  const [emp, r] = await Promise.all([empresaDePedidos(db, [recordId]), db.prepare(`SELECT name, json_extract(props, '$.cliente_clickup') AS cliente, json_extract(props, '$.razon_social') AS razon
    FROM records WHERE id = ?`).bind(recordId).first<{ name: string; cliente: string | null; razon: string | null }>()]);
  const e = emp.get(recordId);
  return { company_id: e?.id ?? null, nombre: e?.name ?? r?.cliente ?? r?.razon ?? null };
}

// Las de un pedido (para su ficha o para la tarjeta): las de ese movimiento y las de siempre de su destino.
// `destino`: en un retiro, un egreso o un ingreso, a dónde se va (el proveedor o el impresor); en una entrega es el del pedido.
export async function notasDePedido(db: D1Database, recordId: number, tipo = 'entrega', destino?: Destino) {
  const d = tipo === 'entrega' || !destino ? await destinoDePedido(db, recordId) : destino;
  const [notas] = await notasPara(db, [{ record_id: recordId, tipo, destino: d }]);
  return { notas, destino: d.nombre || d.company_id || d.lugar_id ? { nombre: d.nombre ?? null } : null };
}

// Las de siempre de un destino, sin pedido: para la tarjeta de un encargo de Recorridos.
export async function notasDeDestino(db: D1Database, d: Destino) {
  const [notas] = await notasPara(db, [{ destino: d }]);
  return { notas, destino: d.nombre || d.company_id || d.lugar_id ? { nombre: d.nombre ?? null } : null };
}

export async function crearNota(db: D1Database, ctx: Ctx, b: { record_id?: unknown; tipo?: unknown; alcance?: unknown; texto?: unknown; destino?: Destino | null }) {
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'Tu usuario es de solo lectura.');
  const texto = String(b.texto ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500);
  if (texto.length < 2) throw new HttpError(400, 'Falta la anotación.');
  const alcance = b.alcance === 'siempre' ? 'siempre' : 'puntual';
  const tipo = (TIPOS_NOTA as readonly string[]).includes(String(b.tipo)) ? String(b.tipo) : 'entrega';
  const recordId = Number(b.record_id) || null;
  if (recordId && !(await db.prepare("SELECT 1 FROM records WHERE id = ? AND object_type = 'order' AND archived = 0").bind(recordId).first())) throw new HttpError(404, 'Ese pedido ya no está.');
  let d: Destino = {};
  if (alcance === 'siempre') {
    d = tipo === 'entrega' && recordId ? await destinoDePedido(db, recordId)
      : { company_id: Number(b.destino?.company_id) || null, lugar_id: Number(b.destino?.lugar_id) || null, nombre: String(b.destino?.nombre ?? '').trim().slice(0, 200) || null };
    if (d.company_id && !d.nombre) d.nombre = (await db.prepare('SELECT name FROM records WHERE id = ?').bind(d.company_id).first<{ name: string }>())?.name ?? null;
    if (!d.company_id && !d.lugar_id && !claveDe(d.nombre)) throw new HttpError(400, 'No se sabe a qué lugar es: guardala solo para esta vez.');
  } else if (!recordId) throw new HttpError(400, 'Falta de qué pedido es.');
  const ts = now();
  const f = await db.prepare(`INSERT INTO logistica_notas (alcance, record_id, tipo, company_id, lugar_id, nombre, clave, texto, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(alcance, recordId, alcance === 'puntual' ? tipo : null, d.company_id ?? null, d.lugar_id ?? null, d.nombre ?? null, claveDe(d.nombre), texto, ctx.user.id, ts).first<{ id: number }>();
  return { id: f!.id, alcance, texto, por: ctx.user.name, user_id: ctx.user.id, at: ts, ...(alcance === 'siempre' ? { destino: d.nombre ?? null } : {}) } satisfies NotaLogistica;
}

// La borra quien la escribió, un administrador o quien edita el cronograma (`edita`).
export async function borrarNota(db: D1Database, ctx: Ctx, id: number, edita: boolean) {
  const n = await db.prepare('SELECT user_id FROM logistica_notas WHERE id = ? AND borrada_at IS NULL').bind(id).first<{ user_id: number | null }>();
  if (!n) throw new HttpError(404, 'Esa anotación ya no está.');
  if (n.user_id !== ctx.user.id && ctx.user.role !== 'admin' && !edita) throw new HttpError(403, 'La borra quien la escribió, Logística o Producción.');
  await db.prepare('UPDATE logistica_notas SET borrada_at = ? WHERE id = ?').bind(now(), id).run();
  return { ok: true };
}

// El horario fijado en el cronograma para la entrega de un pedido (de ayer en adelante), para verlo en su ficha.
export async function horariosDePedido(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT h.fecha, h.modo, h.minutos, h.hasta FROM cronograma_horas h
    WHERE h.fecha >= date('now', '-1 day') AND EXISTS (SELECT 1 FROM produccion p WHERE p.record_id = ?1 AND p.es_pdv = 1 AND (h.clave = 'p:' || p.task_id OR h.clave LIKE 'p:' || p.task_id || ':%'))
    ORDER BY h.fecha LIMIT 5`).bind(recordId).all<{ fecha: string; modo: string; minutos: number; hasta: number | null }>();
  return results;
}
