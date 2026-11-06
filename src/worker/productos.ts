import type { Env } from './env';
import { Budget, OutOfBudget } from './budget';
import { finnegansPedidoVenta, finnegansProducto, finnegansToken } from './finnegans';
import { articulosDelPdv } from './clickup';

// Productos de un pedido (pedido de Rodrigo del 02/11/2026): los renglones del pedido de venta de Finnegans (cantidad,
// precio y descuentos) con la ficha de cada producto (nombre, descripción y foto). Se leen de Finnegans al abrir el
// pedido y quedan guardados: los renglones se vuelven a pedir cada 6 horas y la ficha del producto cada 30 días.
// Si Finnegans no tiene los renglones (pedido sin número, que no está o que quedó vacío), van los artículos del PDV de
// ClickUp (producto, cantidad, código y estado de producción, sin precio). Finnegans y ClickUp solo se leen.

const RENGLONES_HORAS = 6;
const FICHA_DIAS = 30;
const MONEDA: Record<string, string> = { PES: 'ARS', DOL: 'USD' };

async function refresh(env: Env, recordId: number, pedido: string | null, taskId: string | null, b: Budget): Promise<'finnegans' | 'clickup' | null> {
  const db = env.DB;
  const token = await finnegansToken(env, b);
  const p = token && pedido ? await finnegansPedidoVenta(env, token, pedido, b) : null;
  const items = p?.Items ?? [];
  if (!items.length && taskId && env.CLICKUP_TOKEN) {
    const arts = await articulosDelPdv(env, taskId, b);
    await db.batch([
      db.prepare('DELETE FROM line_items WHERE record_id = ?').bind(recordId),
      ...arts.map((a, i) => db.prepare(`INSERT INTO line_items (record_id, position, code, name, quantity, source, status) VALUES (?, ?, ?, ?, ?, 'clickup', ?)`)
        .bind(recordId, i, a.code, a.name, a.quantity, a.status || null)),
    ]);
    if (token) await fichas(env, token, arts.map((a) => a.code), b);
    return arts.length ? 'clickup' : null;
  }
  if (!token) return null;
  const currency = MONEDA[p?.MonedaCodigo ?? 'PES'] ?? p?.MonedaCodigo ?? 'ARS';
  await db.batch([
    db.prepare('DELETE FROM line_items WHERE record_id = ?').bind(recordId),
    ...items.map((it, i) => {
      // Los dos descuentos de Finnegans van uno sobre otro.
      const discount = 1 - (1 - (it.Descuento1 ?? 0) / 100) * (1 - (it.Descuento2 ?? 0) / 100);
      return db.prepare(`INSERT INTO line_items (record_id, position, code, description, quantity, unit_price, discount, tax_included, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(recordId, i, it.ProductoCodigo ?? null, it.Descripcion?.trim() || null, it.Cantidad ?? null,
        it.Precio ?? null, Math.round(discount * 10000) / 100, it.IncluyeImpuesto ? 1 : 0, currency);
    }),
  ]);
  await fichas(env, token, items.map((it) => it.ProductoCodigo), b);
  return items.length ? 'finnegans' : null;
}

// La ficha de cada producto (nombre, descripción y foto), si no se leyó en los últimos 30 días.
async function fichas(env: Env, token: string, all: Array<string | null | undefined>, b: Budget) {
  const db = env.DB;
  const codes = [...new Set(all.filter(Boolean) as string[])];
  if (codes.length) {
    const { results } = await db.prepare('SELECT code FROM products WHERE checked_at >= ? AND code IN (SELECT value FROM json_each(?))')
      .bind(new Date(Date.now() - FICHA_DIAS * 86_400_000).toISOString(), JSON.stringify(codes)).all<{ code: string }>();
    const known = new Set(results.map((r) => r.code));
    for (const code of codes.filter((c) => !known.has(c))) {
      const f = await finnegansProducto(env, token, code, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
      await db.prepare('INSERT OR REPLACE INTO products (code, name, description, image_url, checked_at) VALUES (?, ?, ?, ?, ?)')
        .bind(code, f?.Nombre?.trim() || null, f?.Descripcion?.trim() || null, /^https?:\/\//.test(f?.ProductoImagen ?? '') ? f!.ProductoImagen : null, new Date().toISOString()).run();
    }
  }
}

export async function orderProducts(env: Env, recordId: number, props: Record<string, unknown>, opts: { refresh?: boolean; budget?: Budget } = {}) {
  const db = env.DB;
  const pedido = typeof props.pedido_finnegans === 'string' && /PEDVTA/i.test(props.pedido_finnegans) ? props.pedido_finnegans : null;
  const taskId = String(props.url_clickup ?? '').match(/\/t\/([A-Za-z0-9]+)/)?.[1] ?? null;
  const configured = !!(env.FINNEGANS_CLIENT_ID && env.FINNEGANS_CLIENT_SECRET);
  const canRead = (pedido && configured) || (taskId && !!env.CLICKUP_TOKEN);
  let sync = await db.prepare('SELECT fetched_at, error, source FROM line_item_sync WHERE record_id = ?').bind(recordId).first<{ fetched_at: string; error: string | null; source: string | null }>();
  // Si la última vez falló, se reintenta a los 10 minutos.
  const stale = !sync || opts.refresh || Date.now() - Date.parse(sync.fetched_at) > (sync.error ? 10 * 60_000 : RENGLONES_HORAS * 3600_000);
  if (canRead && stale) {
    let error: string | null = null;
    let source: string | null = null;
    let cortado = false;
    try { source = await refresh(env, recordId, pedido, taskId, opts.budget ?? Budget.of(env)); } catch (e) {
      // Si se acabó el tope de consultas a mitad de camino, el pedido queda pendiente (no se marca como leído).
      if (e instanceof OutOfBudget) cortado = true; else error = (e as Error).message;
    }
    if (cortado) { if (opts.budget) throw new OutOfBudget(); }
    else {
      sync = { fetched_at: new Date().toISOString(), error, source };
      await db.prepare('INSERT OR REPLACE INTO line_item_sync (record_id, fetched_at, error, source) VALUES (?, ?, ?, ?)').bind(recordId, sync.fetched_at, error, source).run();
    }
  }
  const { results } = await db.prepare(`SELECT li.code, li.description, li.quantity, li.unit_price, li.discount, li.tax_included, li.currency,
      li.name AS li_name, li.status, p.name, p.description AS product_description, p.image_url
    FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id = ? ORDER BY li.position`).bind(recordId)
    .all<{ code: string | null; description: string | null; quantity: number | null; unit_price: number | null; discount: number; tax_included: number; currency: string | null;
      li_name: string | null; status: string | null; name: string | null; product_description: string | null; image_url: string | null }>();
  const items = results.map((r) => ({
    code: r.code, name: r.name ?? r.li_name ?? r.code ?? 'Producto', description: r.description ?? r.product_description, image_url: r.image_url, status: r.status,
    quantity: r.quantity, unit_price: r.unit_price, discount: r.discount, tax_included: !!r.tax_included, currency: r.currency ?? 'ARS',
    subtotal: r.quantity != null && r.unit_price != null ? Math.round(r.quantity * r.unit_price * (1 - r.discount / 100) * 100) / 100 : null,
  }));
  return {
    pedido, configured, clickup: !!taskId, source: sync?.source ?? null, fetched_at: sync?.fetched_at ?? null, error: sync?.error ?? null, items,
    total: items.reduce((t, i) => t + (i.subtotal ?? 0), 0), currency: items[0]?.currency ?? 'ARS', tax_included: items.some((i) => i.tax_included),
  };
}

// ---------- Productos de todos los pedidos (para las miniaturas de las tarjetas del tablero) ----------

const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const ENTREGADO = '1237498998';

// Pedidos cuyos productos todavía no se leyeron (o, si siguen activos, hace más de un día; si falló, hace más de 10
// minutos). Primero los que nunca se leyeron y los activos. Los anulados no.
const PENDIENTES_WHERE = `r.object_type = 'order' AND r.archived = 0
      AND (json_extract(r.props, '$.pedido_finnegans') IS NOT NULL OR json_extract(r.props, '$.url_clickup') IS NOT NULL)
      AND COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') != ?1
      AND (s.record_id IS NULL OR (s.error IS NOT NULL AND s.fetched_at < ?2)
        OR (COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') != ?3 AND s.fetched_at < ?4))`;
const pendientesBinds = () => [ANULADO, new Date(Date.now() - 10 * 60_000).toISOString(), ENTREGADO, new Date(Date.now() - 24 * 3600_000).toISOString()];

// Una tanda: tantos pedidos como entren en el tope de consultas de esta corrida (scripts/pedidos-totales.mjs la llama en
// vueltas hasta que no quedan pendientes).
export async function cargarProductosPendientes(env: Env, limit = 25) {
  const b = Budget.of(env);
  const db = env.DB;
  const { results } = await db.prepare(`SELECT r.id, r.props FROM records r LEFT JOIN line_item_sync s ON s.record_id = r.id WHERE ${PENDIENTES_WHERE}
    ORDER BY (s.record_id IS NULL) DESC, (COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') != ?3) DESC, r.updated_at DESC LIMIT ?5`)
    .bind(...pendientesBinds(), limit).all<{ id: number; props: string }>();
  let leidos = 0;
  for (const r of results) {
    if (b.left() < 12) break;   // un pedido puede pedir varias fichas de producto: no se empieza si no alcanza
    const t0 = new Date().toISOString();
    let res;
    try { res = await orderProducts(env, r.id, JSON.parse(r.props), { refresh: true, budget: b }); } catch (e) { if (e instanceof OutOfBudget) break; throw e; }
    // Si no había de dónde leerlo (sin pedido de Finnegans ni PDV de ClickUp utilizables), queda como revisado igual.
    if (!res.fetched_at || res.fetched_at < t0) {
      await db.prepare(`INSERT INTO line_item_sync (record_id, fetched_at, error, source) VALUES (?, ?, NULL, NULL)
        ON CONFLICT(record_id) DO UPDATE SET fetched_at = excluded.fetched_at`).bind(r.id, new Date().toISOString()).run();
    }
    leidos++;
  }
  const quedan = await db.prepare(`SELECT COUNT(*) AS n FROM records r LEFT JOIN line_item_sync s ON s.record_id = r.id WHERE ${PENDIENTES_WHERE}`)
    .bind(...pendientesBinds()).first<{ n: number }>();
  return { leidos, quedan: quedan?.n ?? 0 };
}

// Miniaturas de las tarjetas: hasta 3 fotos distintas de los productos de cada pedido y cuántos productos tiene.
export async function fotosDePedidos(db: D1Database, ids: number[]) {
  if (!ids.length) return new Map<number, { fotos: string[]; productos: number }>();
  const lista = JSON.stringify(ids);
  const [cuantos, fotos] = await db.batch(fotosSql(db, 'SELECT value FROM json_each(?)', [lista]));
  return armarFotos(cuantos.results, fotos.results);
}

// Las dos consultas de las miniaturas, para los pedidos que devuelve `ids` (una subconsulta con sus parámetros): así el
// tablero las pide en el mismo viaje a la base que las tarjetas.
export function fotosSql(db: D1Database, ids: string, binds: unknown[]) {
  return [
    db.prepare(`SELECT record_id, COUNT(*) AS n FROM line_items WHERE record_id IN (${ids}) GROUP BY record_id`).bind(...binds),
    db.prepare(`SELECT li.record_id, p.image_url FROM line_items li JOIN products p ON p.code = li.code
      WHERE li.record_id IN (${ids}) AND p.image_url IS NOT NULL ORDER BY li.record_id, li.position`).bind(...binds),
  ];
}
export function armarFotos(cuantos: unknown[], fotos: unknown[]) {
  const out = new Map<number, { fotos: string[]; productos: number }>();
  for (const r of cuantos as Array<{ record_id: number; n: number }>) out.set(r.record_id, { fotos: [], productos: r.n });
  for (const r of fotos as Array<{ record_id: number; image_url: string }>) {
    const o = out.get(r.record_id);
    if (o && o.fotos.length < 3 && !o.fotos.includes(r.image_url)) o.fotos.push(r.image_url);
  }
  return out;
}
