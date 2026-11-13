import type { User } from './env';
import { HttpError, now } from './env';

// Renglones que no son productos sino cobros (pedido de Rodrigo del 13/11/2026): envío, setup de logo, servicios de arte,
// adicionales y diferencias de precio. No se producen ni se entregan, así que no llevan logo ni boceto, no cuentan como
// artículo en Producción y no pesan en el estado del pedido. Sí suman en el total y van a la factura como siempre.
//
// El tipo sale del código del renglón:
//   1. si un administrador lo cambió en ese pedido (line_item_tipos), eso;
//   2. si el rubro de su ficha en Finnegans es de servicios, o el código está en la lista de cobros, 'servicio';
//   3. si no, 'producto'.

export type Tipo = 'producto' | 'servicio';

// Rubros de Finnegans (ProductoRubroCodigo): Servicios de Arte, Servicios de Logística y Otros servicios.
const RUBROS_SERVICIO = ['SDA', 'SDL', 'OS'];
// Códigos de cobro sin rubro en Finnegans (los usados en pedidos desde 2024): Artículos varios (el comodín de los
// adicionales y las diferencias de precio), los de envío, Mercaderías servicios (armado de kit) y Financiación.
const CODIGOS_SERVICIO = ['1161', '1113', '1170', 'ML_SHIPPING', '2008', '1218'];

export function tipoPorDefecto(code: string | null | undefined, rubro?: string | null): Tipo {
  const c = String(code ?? '').trim().toUpperCase();
  return RUBROS_SERVICIO.includes(String(rubro ?? '').trim().toUpperCase()) || CODIGOS_SERVICIO.includes(c) ? 'servicio' : 'producto';
}

// El tipo de un renglón (`li`: line_items, `p`: su ficha en products, con LEFT JOIN).
export const TIPO_SQL = (li = 'li', p = 'p') =>
  `COALESCE((SELECT lt.tipo FROM line_item_tipos lt WHERE lt.record_id = ${li}.record_id AND lt.code = ${li}.code), ${p}.tipo, 'producto')`;
// Las tareas de ClickUp (artículos del PDV) de los renglones de servicio de un pedido: para dejarlas fuera de las cuentas.
export const TAREAS_SERVICIO_SQL = (record: string) =>
  `(SELECT sli.clickup_task FROM line_items sli LEFT JOIN products sp ON sp.code = sli.code
     WHERE sli.record_id = ${record} AND sli.clickup_task IS NOT NULL AND ${TIPO_SQL('sli', 'sp')} = 'servicio')`;

// Los artículos de ClickUp que son un servicio, de una tanda de pedidos (por el renglón del pedido atado a cada artículo).
export async function tareasServicio(db: D1Database, recordIds: Array<number | null | undefined>) {
  const ids = [...new Set(recordIds.filter((x): x is number => x != null))];
  if (!ids.length) return new Set<string>();
  const { results } = await db.prepare(`SELECT li.clickup_task AS task FROM line_items li LEFT JOIN products p ON p.code = li.code
    WHERE li.record_id IN (SELECT value FROM json_each(?)) AND li.clickup_task IS NOT NULL AND ${TIPO_SQL()} = 'servicio'`).bind(JSON.stringify(ids)).all<{ task: string }>();
  return new Set(results.map((r) => r.task));
}

// Lo mismo para un PDV que se está leyendo de ClickUp (clickup.ts), donde cada artículo puede traer su código de Finnegans
// en la descripción: sirve también cuando los productos del pedido todavía no se leyeron. `recordId`: el pedido, si ya existe.
export async function articulosServicio(db: D1Database, recordId: number | null, arts: Array<{ task_id: string; code: string | null }>) {
  const out = new Set<string>();
  if (!arts.length) return out;
  const [atados, cambiados] = recordId == null ? [[], []] : (await db.batch([
    db.prepare('SELECT clickup_task AS task, code FROM line_items WHERE record_id = ? AND clickup_task IS NOT NULL').bind(recordId),
    db.prepare('SELECT code, tipo FROM line_item_tipos WHERE record_id = ?').bind(recordId),
  ])).map((r) => r.results as Array<Record<string, string | null>>);
  const codigoDe = new Map(atados.map((r) => [r.task as string, r.code]));
  const cambiado = new Map(cambiados.map((r) => [r.code as string, r.tipo as Tipo]));
  const codigos = arts.map((a) => codigoDe.get(a.task_id) ?? a.code);
  const conCodigo = [...new Set(codigos.filter((c): c is string => !!c))];
  const fichas = conCodigo.length ? new Map((await db.prepare('SELECT code, tipo FROM products WHERE code IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(conCodigo)).all<{ code: string; tipo: Tipo }>()).results.map((r) => [r.code, r.tipo])) : new Map<string, Tipo>();
  arts.forEach((a, i) => {
    const c = codigos[i];
    if (c && (cambiado.get(c) ?? fichas.get(c) ?? tipoPorDefecto(c)) === 'servicio') out.add(a.task_id);
  });
  return out;
}

// Un administrador cambia el tipo de un renglón en un pedido (todos los renglones de ese pedido con ese código).
export async function cambiarTipo(db: D1Database, user: User, recordId: number, code: string, tipo: string) {
  if (user.role !== 'admin') throw new HttpError(403, 'El tipo de un renglón (producto o servicio) lo cambia un administrador.');
  const c = code.trim();
  if (!c) throw new HttpError(400, 'Falta el código del renglón.');
  if (tipo !== 'producto' && tipo !== 'servicio') throw new HttpError(400, 'El tipo es «producto» o «servicio».');
  const li = await db.prepare('SELECT li.code, p.tipo FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id = ? AND li.code = ? LIMIT 1')
    .bind(recordId, c).first<{ code: string; tipo: Tipo | null }>();
  if (!li) throw new HttpError(404, 'Ese pedido no tiene un renglón con ese código.');
  // Si queda igual que el tipo del código, no hace falta guardar la excepción.
  if ((li.tipo ?? tipoPorDefecto(c)) === tipo) await db.prepare('DELETE FROM line_item_tipos WHERE record_id = ? AND code = ?').bind(recordId, c).run();
  else {
    await db.prepare(`INSERT INTO line_item_tipos (record_id, code, tipo, user_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(record_id, code) DO UPDATE SET tipo = excluded.tipo, user_id = excluded.user_id, updated_at = excluded.updated_at`).bind(recordId, c, tipo, user.id, now()).run();
  }
  return { code: c, tipo };
}

// ---------- El estado del pedido, cuando cambia qué es un servicio ----------
// El estado del pedido sale de sus artículos de ClickUp sin los servicios (readPdv en clickup.ts), y se calcula al leer el
// PDV. Si un renglón pasa a ser servicio (o deja de serlo) sin que el PDV cambie en ClickUp, se pide volver a leerlo: la
// sincronización lo toma en su próxima corrida y actualiza el pedido como siempre (historial, tarea post-entrega, entrega).

export async function pedirRelectura(db: D1Database, pdvTask: string | null | undefined) {
  if (!pdvTask) return;
  await db.prepare(`INSERT INTO settings (key, value) VALUES ('clickup_releer', json_array(?1))
    ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$[#]', ?1)`).bind(pdvTask).run();
}
export async function relecturasPedidas(db: D1Database) {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'clickup_releer'").first<{ value: string }>();
  if (!r) return [];
  // Solo se borra si nadie agregó otro mientras tanto.
  await db.prepare("DELETE FROM settings WHERE key = 'clickup_releer' AND value = ?").bind(r.value).run();
  try { const v = JSON.parse(r.value); return Array.isArray(v) ? [...new Set(v.map(String))].slice(0, 500) : []; } catch { return []; }
}

// Los estados de los artículos del pedido que sí se producen (lo que ya leyó la vista de Producción), y si alguno de sus
// artículos es un servicio. Para saber si el estado del pedido quedó calculado con un servicio adentro.
export async function estadosSinServicios(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT pr.estado, pr.task_id IN ${TAREAS_SERVICIO_SQL('?1')} AS servicio FROM produccion pr
    WHERE pr.record_id = ?1 AND pr.es_pdv = 0`).bind(recordId).all<{ estado: string; servicio: number }>();
  return { estados: results.filter((r) => !r.servicio).map((r) => r.estado), conServicios: results.some((r) => r.servicio) };
}
