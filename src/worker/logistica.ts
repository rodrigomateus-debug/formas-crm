import type { Ctx } from './env';
import { HttpError, now } from './env';

// Anotaciones de logística (pedido de Producción, Rodrigo del 19/11/2026): lo que hay que saber para entregar o retirar,
// con quién lo escribió. Dos alcances:
// - «puntual»: de este pedido y este movimiento (esta entrega, este retiro, este egreso). Se va con el pedido.
// - «siempre»: queda en la empresa (el cliente en las entregas; el proveedor o el impresor en lo demás) y aparece en todo
//   lo que se le entregue o se le retire de acá en más.
// Las escriben Logística y Producción desde el cronograma, y la vendedora desde su pedido (ahí son siempre de la entrega).
// Se ven en la tarjeta del cronograma, en la parada de la Ruta del día, en la app del chofer y en el pedido.
// No reemplazan las observaciones de la dirección («tocar timbre de recepción»), que son de esa dirección.

export const TIPOS_NOTA = ['entrega', 'ingreso', 'retiro_proveedor', 'egreso', 'retiro_impresor'] as const;
export interface NotaLogistica { id: number; alcance: 'puntual' | 'siempre'; texto: string; por: string | null; user_id: number | null; at: string }
interface Fila { id: number; alcance: 'puntual' | 'siempre'; record_id: number | null; tipo: string | null; company_id: number | null; texto: string; user_id: number | null; created_at: string; por: string | null }
const SELECT = `SELECT n.id, n.alcance, n.record_id, n.tipo, n.company_id, n.texto, n.user_id, n.created_at, u.name AS por
  FROM logistica_notas n LEFT JOIN users u ON u.id = n.user_id WHERE n.borrada_at IS NULL`;
const nota = (f: Fila): NotaLogistica => ({ id: f.id, alcance: f.alcance, texto: f.texto, por: f.por, user_id: f.user_id, at: f.created_at });

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

// Las anotaciones de un conjunto de movimientos: las puntuales por pedido y tipo, y las de siempre por empresa.
// `m.empresa`: la empresa a la que se va (en las entregas, la del pedido).
export async function notasPara(db: D1Database, movs: Array<{ record_id: number | null; tipo: string; empresa: number | null }>) {
  const pedidos = [...new Set(movs.map((m) => m.record_id).filter((x): x is number => !!x))];
  const empresas = [...new Set(movs.map((m) => m.empresa).filter((x): x is number => !!x))];
  const puntuales = new Map<string, NotaLogistica[]>(), siempre = new Map<number, NotaLogistica[]>();
  if (!pedidos.length && !empresas.length) return { puntuales, siempre };
  const { results } = await db.prepare(`${SELECT} AND ((n.alcance = 'puntual' AND n.record_id IN (SELECT value FROM json_each(?1)))
      OR (n.alcance = 'siempre' AND n.company_id IN (SELECT value FROM json_each(?2)))) ORDER BY n.id`).bind(JSON.stringify(pedidos), JSON.stringify(empresas)).all<Fila>();
  for (const f of results) {
    if (f.alcance === 'puntual') { const k = `${f.record_id}|${f.tipo ?? 'entrega'}`; puntuales.set(k, [...(puntuales.get(k) ?? []), nota(f)]); }
    else if (f.company_id) siempre.set(f.company_id, [...(siempre.get(f.company_id) ?? []), nota(f)]);
  }
  return { puntuales, siempre };
}

// Las de un pedido (para su ficha): las de su entrega y las de siempre de su empresa.
export async function notasDePedido(db: D1Database, recordId: number, tipo = 'entrega', companyId: number | null = null) {
  const empresa = companyId ? await db.prepare("SELECT id, name FROM records WHERE id = ? AND object_type = 'company' AND archived = 0").bind(companyId).first<{ id: number; name: string }>()
    : (await empresaDePedidos(db, [recordId])).get(recordId) ?? null;
  const { puntuales, siempre } = await notasPara(db, [{ record_id: recordId, tipo, empresa: empresa?.id ?? null }]);
  return { notas: [...(siempre.get(empresa?.id ?? -1) ?? []), ...(puntuales.get(`${recordId}|${tipo}`) ?? [])], empresa };
}

// `companyId`: en un retiro, un egreso o un ingreso, la empresa a la que se va (el proveedor o el impresor); en una entrega
// no se pasa y es la del pedido.
export async function crearNota(db: D1Database, ctx: Ctx, b: { record_id?: unknown; tipo?: unknown; alcance?: unknown; texto?: unknown; company_id?: unknown }) {
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'Tu usuario es de solo lectura.');
  const texto = String(b.texto ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500);
  if (texto.length < 2) throw new HttpError(400, 'Falta la anotación.');
  const alcance = b.alcance === 'siempre' ? 'siempre' : 'puntual';
  const tipo = (TIPOS_NOTA as readonly string[]).includes(String(b.tipo)) ? String(b.tipo) : 'entrega';
  const recordId = Number(b.record_id) || null;
  if (recordId && !(await db.prepare("SELECT 1 FROM records WHERE id = ? AND object_type = 'order' AND archived = 0").bind(recordId).first())) throw new HttpError(404, 'Ese pedido ya no está.');
  let companyId: number | null = null;
  if (alcance === 'siempre') {
    companyId = tipo === 'entrega' ? (recordId ? (await empresaDePedidos(db, [recordId])).get(recordId)?.id ?? null : null) : Number(b.company_id) || null;
    if (!companyId) throw new HttpError(400, tipo === 'entrega'
      ? 'Este pedido todavía no tiene su empresa: para guardarla para todas las entregas, asociale la empresa. Mientras, guardala solo para esta entrega.'
      : 'Ese lugar no es una empresa del Hub: guardala solo para esta vez.');
  } else if (!recordId) throw new HttpError(400, 'Falta de qué pedido es.');
  const f = await db.prepare(`INSERT INTO logistica_notas (alcance, record_id, tipo, company_id, texto, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(alcance, recordId, alcance === 'puntual' ? tipo : null, companyId, texto, ctx.user.id, now()).first<{ id: number }>();
  return { id: f!.id, alcance, texto, por: ctx.user.name, user_id: ctx.user.id, at: now() } satisfies NotaLogistica;
}

// La borra quien la escribió, un administrador o quien edita el cronograma (`edita`).
export async function borrarNota(db: D1Database, ctx: Ctx, id: number, edita: boolean) {
  const n = await db.prepare('SELECT user_id FROM logistica_notas WHERE id = ? AND borrada_at IS NULL').bind(id).first<{ user_id: number | null }>();
  if (!n) throw new HttpError(404, 'Esa anotación ya no está.');
  if (n.user_id !== ctx.user.id && ctx.user.role !== 'admin' && !edita) throw new HttpError(403, 'La borra quien la escribió, Logística o Producción.');
  await db.prepare('UPDATE logistica_notas SET borrada_at = ? WHERE id = ?').bind(now(), id).run();
  return { ok: true };
}
