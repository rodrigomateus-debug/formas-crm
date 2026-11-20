import { agruparTalles, esGenerico, TALLES_VERSION } from './talles';
import { TIPO_SQL } from './servicios';

// Talle y grupo guardados (talles.ts, migración 0105): en cada artículo de Producción y en cada renglón del pedido. Se
// recalculan al guardar lo que trae ClickUp (produccion.ts, guardarTareas), al leer los renglones de Finnegans
// (productos.ts) y, para lo viejo o si cambian las reglas (TALLES_VERSION), de a tandas en el cron (completarTalles).

const TANDA = 200;
async function enTandas(db: D1Database, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += TANDA) await db.batch(stmts.slice(i, i + TANDA));
}

// Los artículos de cada PDV. El nombre es el de la subtarea de ClickUp y, si no dice el talle, el del renglón del pedido
// atado a ella; el SKU, el «Código:» de la subtarea o el del renglón.
export async function recalcularTallesPdvs(db: D1Database, pdvTasks: string[]) {
  const pdvs = [...new Set(pdvTasks.filter(Boolean))];
  if (!pdvs.length) return 0;
  type Fila = { task_id: string; pdv_task: string; nombre: string; codigo: string | null; orden: number; talle: string | null; grupo_talle: string | null;
    record_id: number | null };
  const filas: Fila[] = [];
  for (let i = 0; i < pdvs.length; i += TANDA) {
    filas.push(...(await db.prepare(`SELECT a.task_id, a.pdv_task, a.nombre, a.codigo, a.orden, a.talle, a.grupo_talle, COALESCE(a.record_id, p.record_id) AS record_id
        FROM produccion a LEFT JOIN produccion p ON p.task_id = a.pdv_task WHERE a.es_pdv = 0 AND a.pdv_task IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(pdvs.slice(i, i + TANDA))).all<Fila>()).results);
  }
  // El renglón del pedido atado a cada artículo (por pedido, que tiene índice; el primero, si hay más de uno).
  type Renglon = { clickup_task: string; code: string | null; nombre: string | null; descripcion: string | null };
  const pedidos = [...new Set(filas.map((f) => f.record_id).filter((x): x is number => x != null))];
  const renglon = new Map<string, Renglon>();
  for (let i = 0; i < pedidos.length; i += TANDA) {
    const { results } = await db.prepare(`SELECT li.clickup_task, li.code, COALESCE(p.name, li.name) AS nombre, li.description AS descripcion FROM line_items li
        LEFT JOIN products p ON p.code = li.code WHERE li.record_id IN (SELECT value FROM json_each(?)) AND li.clickup_task IS NOT NULL ORDER BY li.id`)
      .bind(JSON.stringify(pedidos.slice(i, i + TANDA))).all<Renglon>();
    for (const r of results) if (!renglon.has(r.clickup_task)) renglon.set(r.clickup_task, r);
  }
  const dePdv = new Map<string, Fila[]>();
  for (const f of filas) { const l = dePdv.get(f.pdv_task) ?? []; l.push(f); dePdv.set(f.pdv_task, l); }
  const stmts: D1PreparedStatement[] = [];
  for (const arts of dePdv.values()) {
    const g = agruparTalles(arts.map((a) => {
      const li = renglon.get(a.task_id);
      const sku = a.codigo?.trim() || li?.code?.trim() || null;
      return { id: a.task_id, sku, orden: a.orden, nombres: [a.nombre, ...(esGenerico(sku) ? [li?.descripcion, li?.nombre] : [li?.nombre, li?.descripcion])] };
    }));
    for (const a of arts) {
      const talle = g.talles.get(a.task_id)?.talle ?? null, grupo = g.grupoDe.get(a.task_id) ?? null;
      if (talle !== a.talle || grupo !== a.grupo_talle) stmts.push(db.prepare('UPDATE produccion SET talle = ?, grupo_talle = ? WHERE task_id = ?').bind(talle, grupo, a.task_id));
    }
  }
  for (let i = 0; i < pdvs.length; i += TANDA) {
    stmts.push(db.prepare('UPDATE produccion SET talles_v = ? WHERE es_pdv = 1 AND task_id IN (SELECT value FROM json_each(?))').bind(TALLES_VERSION, JSON.stringify(pdvs.slice(i, i + TANDA))));
  }
  await enTandas(db, stmts);
  return pdvs.length;
}

// Los renglones de cada pedido (sin los servicios). El nombre, el de la ficha del producto o, en los SKU genéricos
// («PS_GE_2000»), la descripción del renglón, que es donde la vendedora escribió el producto.
export async function recalcularTallesPedidos(db: D1Database, recordIds: number[]) {
  const ids = [...new Set(recordIds.filter((x) => Number.isFinite(x)))];
  if (!ids.length) return 0;
  type Fila = { id: number; record_id: number; position: number; code: string | null; li_name: string | null; description: string | null; name: string | null;
    talle: string | null; grupo_talle: string | null; tipo: string };
  const filas: Fila[] = [];
  for (let i = 0; i < ids.length; i += TANDA) {
    filas.push(...(await db.prepare(`SELECT li.id, li.record_id, li.position, li.code, li.name AS li_name, li.description, p.name, li.talle, li.grupo_talle,
          ${TIPO_SQL()} AS tipo FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids.slice(i, i + TANDA))).all<Fila>()).results);
  }
  const dePedido = new Map<number, Fila[]>();
  for (const f of filas) { const l = dePedido.get(f.record_id) ?? []; l.push(f); dePedido.set(f.record_id, l); }
  const stmts: D1PreparedStatement[] = [];
  for (const lis of dePedido.values()) {
    const productos = lis.filter((l) => l.tipo !== 'servicio');
    const g = agruparTalles(productos.map((l) => ({ id: String(l.id), sku: l.code, orden: l.position,
      nombres: esGenerico(l.code) ? [l.description, l.li_name, l.name] : [l.name, l.li_name, l.description] })));
    for (const l of lis) {
      const talle = g.talles.get(String(l.id))?.talle ?? null, grupo = g.grupoDe.get(String(l.id)) ?? null;
      if (talle !== l.talle || grupo !== l.grupo_talle) stmts.push(db.prepare('UPDATE line_items SET talle = ?, grupo_talle = ? WHERE id = ?').bind(talle, grupo, l.id));
    }
  }
  for (let i = 0; i < ids.length; i += TANDA) {
    stmts.push(db.prepare('UPDATE line_item_sync SET talles_v = ? WHERE record_id IN (SELECT value FROM json_each(?))').bind(TALLES_VERSION, JSON.stringify(ids.slice(i, i + TANDA))));
  }
  await enTandas(db, stmts);
  return ids.length;
}

// En el cron: los PDV y los pedidos calculados con otra versión de las reglas (o nunca), de a tandas. Cuando no queda
// ninguno son dos consultas que no devuelven nada.
export async function completarTalles(db: D1Database, max = 150) {
  const [pdvs, pedidos] = await db.batch([
    db.prepare('SELECT task_id FROM produccion WHERE es_pdv = 1 AND talles_v < ? ORDER BY actualizado DESC LIMIT ?').bind(TALLES_VERSION, max),
    db.prepare('SELECT record_id FROM line_item_sync WHERE talles_v < ? ORDER BY fetched_at DESC LIMIT ?').bind(TALLES_VERSION, max),
  ]);
  const p = await recalcularTallesPdvs(db, (pdvs.results as Array<{ task_id: string }>).map((r) => r.task_id));
  const o = await recalcularTallesPedidos(db, (pedidos.results as Array<{ record_id: number }>).map((r) => r.record_id));
  return { pdvs: p, pedidos: o };
}
