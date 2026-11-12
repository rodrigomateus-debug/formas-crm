import type { Env } from './env';
import { Budget, OutOfBudget } from './budget';
import { finnegansPedidoVenta, finnegansProducto, finnegansToken } from './finnegans';
import { articulosDelPdv, articulosLivianos, type Articulo } from './clickup';
import { estadosPec, PRODUCCION_TARJETA_SQL, produccionDePedido, type Persona } from './produccion';
import { clavePedido } from './totales';
import { HttpError } from './env';

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
      ...arts.map((a, i) => db.prepare(`INSERT INTO line_items (record_id, position, code, name, quantity, source, status, clickup_task) VALUES (?, ?, ?, ?, ?, 'clickup', ?, ?)`)
        .bind(recordId, i, a.code, a.name, a.quantity, a.status || null, a.task_id)),
    ]);
    if (token) await fichas(env, token, arts.map((a) => a.code), b);
    return arts.length ? 'clickup' : null;
  }
  if (!token) return null;
  const currency = MONEDA[p?.MonedaCodigo ?? 'PES'] ?? p?.MonedaCodigo ?? 'ARS';
  // En ClickUp cada producto tiene su estado (el PDV junta los de todos): se busca el artículo de cada renglón por código
  // o por nombre, para mostrar su estado y saber a qué subtarea va su boceto.
  let arts: Articulo[] = [];
  if (taskId && env.CLICKUP_TOKEN && items.length) {
    try { arts = await articulosLivianos(env, taskId, b); } catch (e) { if (e instanceof OutOfBudget) throw e; }
  }
  const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const usados = new Set<string>();
  const articuloDe = (code: string | undefined, desc: string | undefined) => {
    const c = norm(code), d = norm(desc);
    const a = arts.find((x) => !usados.has(x.task_id) && c && norm(x.code) === c)
      ?? arts.find((x) => !usados.has(x.task_id) && c && norm(x.name).includes(c))
      ?? arts.find((x) => !usados.has(x.task_id) && d && (norm(x.name).includes(d) || d.includes(norm(x.name))))
      ?? (arts.length === 1 && items.length === 1 ? arts[0] : undefined);
    if (a) usados.add(a.task_id);
    return a;
  };
  await db.batch([
    db.prepare('DELETE FROM line_items WHERE record_id = ?').bind(recordId),
    ...items.map((it, i) => {
      // Los dos descuentos de Finnegans van uno sobre otro.
      const discount = 1 - (1 - (it.Descuento1 ?? 0) / 100) * (1 - (it.Descuento2 ?? 0) / 100);
      const art = articuloDe(it.ProductoCodigo, it.Descripcion);
      return db.prepare(`INSERT INTO line_items (record_id, position, code, description, quantity, unit_price, discount, tax_included, currency, status, clickup_task)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(recordId, i, it.ProductoCodigo ?? null, it.Descripcion?.trim() || null, it.Cantidad ?? null,
        it.Precio ?? null, Math.round(discount * 10000) / 100, it.IncluyeImpuesto ? 1 : 0, currency, art?.status || null, art?.task_id ?? null);
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
  const clave = clavePedido(props.pedido_finnegans);
  const [renglones, cot] = await db.batch([
    db.prepare(`SELECT li.code, li.description, li.quantity, li.unit_price, li.discount, li.tax_included, li.currency,
        li.name AS li_name, li.status, li.clickup_task, p.name, p.description AS product_description,
        so.image_url AS foto_cot, p.image_url AS foto_fin, sk.image_url AS foto_sku
      FROM line_items li LEFT JOIN products p ON p.code = li.code ${FOTO_STP('?')} WHERE li.record_id = ? ORDER BY li.position`).bind(clave, recordId),
    db.prepare('SELECT sku, nombre, cantidades, image_url FROM stp_items WHERE pedido = ? ORDER BY pos').bind(clave ?? ''),
  ]);
  const results = renglones.results as Array<{ code: string | null; description: string | null; quantity: number | null; unit_price: number | null; discount: number; tax_included: number; currency: string | null;
    li_name: string | null; status: string | null; clickup_task: string | null; name: string | null; product_description: string | null;
    foto_cot: string | null; foto_fin: string | null; foto_sku: string | null }>;
  const { fotos, sueltas } = fotosDeRenglones(results, cot.results as StpItem[]);
  // Producción: quién tiene asignado cada artículo en ClickUp (y el PDV entero).
  const prod = await produccionDePedido(db, recordId);
  // El color de cada estado, el mismo que en ClickUp.
  const estados = results.some((r) => r.status) ? await estadosPec(db) : [];
  const items = results.map((r, i) => ({
    code: r.code, name: r.name ?? r.li_name ?? r.code ?? 'Producto', description: r.description ?? r.product_description, image_url: fotos[i], status: r.status, clickup_task: r.clickup_task,
    asignados: (r.clickup_task && prod?.porTarea.get(r.clickup_task)) || [],
    status_color: estados.find((e) => e.status === String(r.status ?? '').toLowerCase().trim())?.color ?? null,
    quantity: r.quantity, unit_price: r.unit_price, discount: r.discount, tax_included: !!r.tax_included, currency: r.currency ?? 'ARS',
    subtotal: r.quantity != null && r.unit_price != null ? Math.round(r.quantity * r.unit_price * (1 - r.discount / 100) * 100) / 100 : null,
  }));
  return {
    pedido, configured, clickup: !!taskId, source: sync?.source ?? null, fetched_at: sync?.fetched_at ?? null, error: sync?.error ?? null, items,
    produccion: prod ? { asignados: prod.asignados, listos: prod.listos, total: prod.total } : null,
    // Las fotos de la cotización que no quedaron en ningún producto (solo si a alguno le falta foto).
    cotizacion_fotos: items.length && items.every((i) => i.image_url) ? [] : sueltas,
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

// ---------- Fotos del registro de cotizaciones del STP ----------
// La que eligió la vendedora al cotizar, por pedido de Finnegans y SKU, y la de cada SKU para los demás pedidos (tabla
// stp_imagenes, la carga scripts/stp-imagenes.mjs). Qué foto va en cada producto lo decide fotosDeRenglones.
const FOTO_STP = (pedido: string) => `LEFT JOIN stp_imagenes so ON so.pedido = ${pedido} AND so.sku = UPPER(TRIM(li.code))
    LEFT JOIN stp_imagenes sk ON sk.pedido = '' AND sk.sku = UPPER(TRIM(li.code))
      AND UPPER(TRIM(li.code)) NOT LIKE '%!_GE!_%' ESCAPE '!' AND UPPER(TRIM(li.code)) NOT LIKE '%!_GE' ESCAPE '!'`;
const PEDIDO_DE_R = "NULLIF(UPPER(TRIM(json_extract(r.props, '$.pedido_finnegans'))), '')";

// Los productos manuales comparten un SKU genérico («PICPS_GE_6000», «PS_GE_2000»): un mismo código es vasos, naipes y
// paletas en el mismo pedido, así que ni la foto de ese SKU en la cotización ni la de otras cotizaciones sirven.
const esGenerico = (code: string | null) => /_GE(_|$)/i.test(code ?? '');
// Las palabras que nombran el producto: sin acentos, en singular, sin códigos de modelo, colores ni las palabras del nombre
// de los genéricos («Vasos» → {VASO}; «Vaso Térmico Negro 500ML» → {VASO, TERMICO}). La misma idea que _palabras del tablero.
const PAL_NO = new Set(['NEGRO', 'NEGRA', 'BLANCO', 'BLANCA', 'AZUL', 'ROJO', 'ROJA', 'VERDE', 'GRIS', 'AMARILLO', 'NARANJA', 'VIOLETA',
  'ROSA', 'MARRON', 'BEIGE', 'CELESTE', 'NATURAL', 'COLOR', 'COLORE', 'ALGODON', 'POLIESTER', 'ACERO', 'INOXIDABLE', 'PLASTICO', 'METAL',
  'METALICO', 'ALUMINIO', 'CUERO', 'MADERA', 'VIDRIO', 'TELA', 'PARA', 'LOGO', 'PERSONALIZADO', 'PERSONALIZADA', 'ESTAMPADO', 'BORDADO',
  'IMPRESION', 'SERVICIO', 'PRODUCTO', 'MODELO', 'TALLE', 'COMBINADO', 'COMBINADA', 'UNIDAD', 'PACK', 'MARINO', 'CLARO', 'OSCURO',
  'PRODUCCION', 'SIMPLE', 'HOGAR', 'TIEMPO', 'LIBRE', 'GENERICO', 'GENERICA', 'CON', 'SIN', 'DESDE', 'HASTA']);
export function palabras(...textos: Array<string | null | undefined>) {
  const out = new Set<string>();
  for (const t of textos) {
    for (let w of String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/)) {
      if (w.length < 4 || !/^[A-Z]+$/.test(w)) continue;
      if (w.endsWith('S') && w.length > 4) w = w.slice(0, -1);
      if (!PAL_NO.has(w)) out.add(w);
    }
  }
  return out;
}

export interface StpItem { sku: string; nombre: string; cantidades: string; image_url: string }
interface RenglonFoto { code: string | null; description: string | null; quantity: number | null; li_name: string | null; name: string | null;
  foto_cot: string | null; foto_fin: string | null; foto_sku: string | null }
// La foto de cada renglón del pedido, en este orden:
//   1. la de su SKU en la cotización del pedido (si el SKU es genérico, solo si la cotización tiene un único producto con él);
//   2. la de su ficha en Finnegans, si el código no es genérico;
//   3. la del producto de la cotización con el mismo nombre (las palabras de la descripción del renglón, o de su nombre si
//      el código no es genérico); si empatan, el de la cantidad más parecida;
//   4. la del producto de la cotización con la misma cantidad, si es uno solo;
//   5. la de su SKU en otras cotizaciones (nunca para los genéricos).
// Cada producto de la cotización se usa una sola vez. `sueltas`: las fotos de la cotización que no quedaron en ningún renglón.
export function fotosDeRenglones(renglones: RenglonFoto[], cot: StpItem[]) {
  const libres = cot.map((c, i) => ({ i, sku: c.sku.toUpperCase(), pal: palabras(c.nombre), cant: cantidadesDe(c.cantidades), url: c.image_url }));
  const usados = new Set<number>();
  const tomar = (k: number) => { usados.add(k); return libres[k].url; };
  const porSku = (code: string | null) => libres.filter((c) => c.sku === (code ?? '').trim().toUpperCase());
  const fotos: Array<string | null> = renglones.map(() => null);
  // 1. Por SKU en la cotización del pedido.
  renglones.forEach((r, i) => {
    if (!r.foto_cot) return;
    const mismos = porSku(r.code);
    if (esGenerico(r.code) && mismos.length > 1) return;
    fotos[i] = r.foto_cot;
    const c = mismos.find((x) => !usados.has(x.i) && x.url === r.foto_cot) ?? mismos.find((x) => !usados.has(x.i));
    if (c) usados.add(c.i);
  });
  // 2. La ficha de Finnegans (la de un genérico, si tiene, va después del cruce por nombre).
  renglones.forEach((r, i) => { if (!fotos[i] && r.foto_fin && !esGenerico(r.code)) fotos[i] = r.foto_fin; });
  const dif = (q: number | null, cant: number[]) => (q == null || !cant.length ? Infinity : Math.min(...cant.map((c) => Math.abs(c - q) / Math.max(c, q, 1))));
  // 3. Por nombre: primero los renglones con más palabras en común (el cruce más seguro).
  const candidatos: Array<{ i: number; k: number; comunes: number; d: number }> = [];
  renglones.forEach((r, i) => {
    if (fotos[i]) return;
    const pal = palabras(r.description, r.li_name, esGenerico(r.code) ? null : r.name);
    for (const c of libres) {
      const comunes = [...c.pal].filter((w) => pal.has(w)).length;
      if (comunes) candidatos.push({ i, k: c.i, comunes, d: dif(r.quantity, c.cant) });
    }
  });
  candidatos.sort((a, b) => b.comunes - a.comunes || a.d - b.d);
  for (const c of candidatos) if (!fotos[c.i] && !usados.has(c.k)) fotos[c.i] = tomar(c.k);
  renglones.forEach((r, i) => { if (!fotos[i] && r.foto_fin) fotos[i] = r.foto_fin; });
  // 4. Por cantidad: solo si un único producto libre de la cotización tiene esa cantidad.
  renglones.forEach((r, i) => {
    if (fotos[i] || r.quantity == null) return;
    const iguales = libres.filter((c) => !usados.has(c.i) && c.cant.includes(r.quantity!));
    if (iguales.length === 1) fotos[i] = tomar(iguales[0].i);
  });
  // 5. La del SKU en otras cotizaciones.
  renglones.forEach((r, i) => { if (!fotos[i] && r.foto_sku && !esGenerico(r.code)) fotos[i] = r.foto_sku; });
  const puestas = new Set(fotos);
  const sueltas = [...new Set(libres.filter((c) => !usados.has(c.i) && !puestas.has(c.url)).map((c) => c.url))];
  return { fotos, sueltas };
}
function cantidadesDe(s: string) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []; } catch { return []; }
}
const URL_OK = /^https?:\/\/[^\s"'<>]{4,600}$/;

export interface ImagenesEstado { recibidas: number; guardadas: number; borradas: number; pedidos: number; skus: number;
  productos?: { recibidos: number; pedidos: number; total: number }; at: string }

// {filas: [["PEDVTASTP - 31277", "SKU", "https://…"], ["", "SKU", "https://…"], …]}: pedido vacío es la foto del SKU; una
// fila sin foto borra la que había.
// {productos: [["PEDVTASTP - 31277", "SKU", "Nombre del producto", [100, 250], "https://…"], …]}: los productos de la cotización
// de cada pedido (tabla stp_items); los de cada pedido que llega reemplazan a los que tenía. ["PEDVTASTP - 31277"] solo, los borra.
// Los productos de un pedido tienen que venir en el mismo envío. Puede venir uno solo de los dos.
export async function aplicarImagenes(env: Env, body: { filas?: unknown; productos?: unknown }): Promise<ImagenesEstado> {
  if (!Array.isArray(body?.filas) && !Array.isArray(body?.productos)) {
    throw new HttpError(400, 'Falta filas: [["PEDVTASTP - 31277", "SKU", "https://…"], …] o productos: [["PEDVTASTP - 31277", "SKU", "Nombre", [100], "https://…"], …].');
  }
  const filas = new Map<string, [string, string, string]>();
  for (const f of (Array.isArray(body.filas) ? body.filas : []) as unknown[]) {
    if (!Array.isArray(f)) continue;
    const pedido = f[0] ? clavePedido(f[0]) : '';
    const sku = String(f[1] ?? '').trim().toUpperCase();
    const url = String(f[2] ?? '').trim();
    if (pedido === null || !sku || sku.length > 120 || (url && !URL_OK.test(url))) continue;
    filas.set(`${pedido}|${sku}`, [pedido, sku, url]);
  }
  // Los productos, agrupados por pedido (en el orden en que llegan).
  const productos = new Map<string, Array<[string, number, string, string, string, string]>>();
  for (const f of (Array.isArray(body.productos) ? body.productos : []) as unknown[]) {
    if (!Array.isArray(f)) continue;
    const pedido = clavePedido(f[0]);
    if (!pedido) continue;
    const lista = productos.get(pedido) ?? [];
    productos.set(pedido, lista);
    const sku = String(f[1] ?? '').trim().toUpperCase();
    const url = String(f[4] ?? '').trim();
    if (!sku || sku.length > 120 || !URL_OK.test(url)) continue;
    const cant = (Array.isArray(f[3]) ? f[3] : [f[3]]).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 20);
    lista.push([pedido, lista.length, sku, String(f[2] ?? '').trim().slice(0, 200), JSON.stringify(cant), url]);
  }
  const db = env.DB;
  const guardar = [...filas.values()].filter((f) => f[2]);
  const borrar = [...filas.values()].filter((f) => !f[2]);
  const tandas = [];
  for (let i = 0; i < guardar.length; i += 1000) {
    tandas.push(db.prepare(`INSERT INTO stp_imagenes (pedido, sku, image_url)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE true
      ON CONFLICT(pedido, sku) DO UPDATE SET image_url = excluded.image_url`).bind(JSON.stringify(guardar.slice(i, i + 1000))));
  }
  if (borrar.length) {
    tandas.push(db.prepare(`DELETE FROM stp_imagenes WHERE (pedido, sku) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`)
      .bind(JSON.stringify(borrar)));
  }
  const pedidos = [...productos.keys()];
  for (let i = 0; i < pedidos.length; i += 1000) {
    tandas.push(db.prepare('DELETE FROM stp_items WHERE pedido IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pedidos.slice(i, i + 1000))));
  }
  const items = [...productos.values()].flat();
  for (let i = 0; i < items.length; i += 1000) {
    tandas.push(db.prepare(`INSERT INTO stp_items (pedido, pos, sku, nombre, cantidades, image_url)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
        json_extract(value, '$[5]') FROM json_each(?)`).bind(JSON.stringify(items.slice(i, i + 1000))));
  }
  if (tandas.length) await db.batch(tandas);
  const [n, m] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(pedido != ''), 0) AS pedidos, COALESCE(SUM(pedido = ''), 0) AS skus FROM stp_imagenes"),
    db.prepare('SELECT COUNT(*) AS total FROM stp_items'),
  ]);
  const nn = n.results[0] as { pedidos: number; skus: number } | undefined;
  const estado: ImagenesEstado = { recibidas: Array.isArray(body.filas) ? body.filas.length : 0, guardadas: guardar.length, borradas: borrar.length,
    pedidos: nn?.pedidos ?? 0, skus: nn?.skus ?? 0, at: new Date().toISOString() };
  if (Array.isArray(body.productos)) {
    estado.productos = { recibidos: items.length, pedidos: pedidos.length, total: (m.results[0] as { total: number } | undefined)?.total ?? 0 };
  }
  // El estado de los productos se guarda aparte, para que un envío de solo filas no lo pise.
  await db.batch([
    ...(Array.isArray(body.filas) ? [db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('imagenes_stp', ?)").bind(JSON.stringify({ ...estado, productos: undefined }))] : []),
    ...(estado.productos ? [db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('imagenes_stp_productos', ?)").bind(JSON.stringify({ ...estado.productos, at: estado.at }))] : []),
  ]);
  return estado;
}

// Las dos consultas de las miniaturas, para los pedidos que devuelve `ids` (una subconsulta con sus parámetros): así el
// tablero las pide en el mismo viaje a la base que las tarjetas. La segunda trae los renglones de cada pedido ('li'), los
// productos de su cotización en el STP ('it') y las fotos de la cotización por SKU ('so'); armarFotos les pone foto con
// fotosDeRenglones, igual que el panel de productos (aviso de Rodrigo del 7/11/2026: la tarjeta mostraba también las
// opciones cotizadas que el cliente no pidió).
export function fotosSql(db: D1Database, ids: string, binds: unknown[]) {
  const conIds = `WITH ids(id) AS (${ids})`;   // usada varias veces, SQLite la calcula una sola
  return [
    db.prepare(`${conIds} SELECT * FROM (SELECT r.id AS record_id, (SELECT COUNT(*) FROM line_items li WHERE li.record_id = r.id) AS n,
        (SELECT COUNT(*) FROM stp_imagenes s WHERE s.pedido = ${PEDIDO_DE_R}) AS n_stp,
        (SELECT COUNT(*) FROM stp_items s WHERE s.pedido = ${PEDIDO_DE_R}) AS n_items
      FROM records r WHERE r.id IN (SELECT id FROM ids)) WHERE n > 0 OR n_stp > 0 OR n_items > 0`).bind(...binds),
    db.prepare(`${conIds}
        SELECT 'li' AS k, li.record_id, li.position AS pos, li.code, li.description, li.quantity, li.name AS li_name, p.name,
          so.image_url AS foto_cot, p.image_url AS foto_fin, sk.image_url AS foto_sku, NULL AS cantidades
          FROM line_items li JOIN records r ON r.id = li.record_id LEFT JOIN products p ON p.code = li.code ${FOTO_STP(PEDIDO_DE_R)}
          WHERE li.record_id IN (SELECT id FROM ids)
        UNION ALL
        SELECT 'it', r.id, s.pos, s.sku, NULL, NULL, NULL, s.nombre, s.image_url, NULL, NULL, s.cantidades
          FROM records r JOIN stp_items s ON s.pedido = ${PEDIDO_DE_R} WHERE r.id IN (SELECT id FROM ids)
        UNION ALL
        SELECT 'so', r.id, 0, s.sku, NULL, NULL, NULL, NULL, s.image_url, NULL, NULL, NULL
          FROM records r JOIN stp_imagenes s ON s.pedido = ${PEDIDO_DE_R} WHERE r.id IN (SELECT id FROM ids)
        ORDER BY 2, 1, 3`).bind(...binds),
  ];
}
// Lo adjunto de cada pedido, para los iconitos de abajo de la tarjeta: facturas, remitos y bocetos (cuántos de sus
// productos tienen al menos uno; el boceto va atado al código del producto o, si no tiene, a su nombre).
export interface Adjuntos {
  facturas: number; remitos: number; bocetos: number; con_boceto: number; productos: number;
  // Producción (produccion.ts): quién lo tiene asignado en ClickUp y cuántos artículos están listos.
  produccion?: { asignados: Persona[]; listos: number; total: number };
}
export function adjuntosSql(db: D1Database, ids: string, binds: unknown[]) {
  return db.prepare(`WITH ids(id) AS (${ids}) SELECT r.id AS record_id,
      (SELECT COUNT(*) FROM files f WHERE f.record_id = r.id AND f.kind = 'factura') AS facturas,
      (SELECT COUNT(*) FROM remitos m WHERE m.record_id = r.id AND m.estado NOT IN ('descartado', 'duplicado')) AS remitos,
      (SELECT COUNT(*) FROM bocetos b WHERE b.record_id = r.id AND b.archived = 0) AS bocetos,
      (SELECT COUNT(*) FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id = r.id
        AND EXISTS (SELECT 1 FROM bocetos b WHERE b.record_id = r.id AND b.archived = 0 AND b.producto IN (li.code, li.name, p.name))) AS con_boceto,
      (SELECT COUNT(*) FROM line_items li WHERE li.record_id = r.id) AS productos${PRODUCCION_TARJETA_SQL}
    FROM records r WHERE r.id IN (SELECT id FROM ids)`).bind(...binds);
}
type FilaAdjuntos = Omit<Adjuntos, 'produccion'> & { record_id: number; prod_asignados: string | null; prod_total: number; prod_listos: number };
export function armarAdjuntos(rows: unknown[]) {
  return new Map((rows as FilaAdjuntos[]).map(({ record_id, prod_asignados, prod_total, prod_listos, ...a }) => {
    let asignados: Persona[] = [];
    try { asignados = JSON.parse(prod_asignados ?? '[]'); } catch { /* sin asignados */ }
    const produccion = prod_total || asignados.length ? { asignados, listos: prod_listos, total: prod_total } : undefined;
    return [record_id, { ...a, ...(produccion ? { produccion } : {}) } as Adjuntos];
  }));
}

// Fotos y adjuntos de una tanda de pedidos (las tarjetas que se suman con «Cargar más»).
export async function extrasDePedidos(db: D1Database, ids: number[]) {
  if (!ids.length) return { fotos: new Map<number, { fotos: string[]; productos: number }>(), adjuntos: new Map<number, Adjuntos>() };
  const lista = JSON.stringify(ids);
  const [cuantos, fotos, adj] = await db.batch([...fotosSql(db, 'SELECT value FROM json_each(?)', [lista]), adjuntosSql(db, 'SELECT value FROM json_each(?)', [lista])]);
  return { fotos: armarFotos(cuantos.results, fotos.results), adjuntos: armarAdjuntos(adj.results) };
}

// Hasta 3 fotos por pedido: las de sus productos, como en el panel (fotosDeRenglones); si a alguno le falta foto, también las
// de su cotización que no quedaron en ningún producto; sin productos leídos, las de la cotización.
export function armarFotos(cuantos: unknown[], filas: unknown[]) {
  type Fila = { k: 'li' | 'it' | 'so'; record_id: number; code: string | null; description: string | null; quantity: number | null; li_name: string | null;
    name: string | null; foto_cot: string | null; foto_fin: string | null; foto_sku: string | null; cantidades: string | null };
  const de = new Map<number, Fila[]>();
  for (const f of filas as Fila[]) { const l = de.get(f.record_id) ?? []; l.push(f); de.set(f.record_id, l); }
  const out = new Map<number, { fotos: string[]; productos: number }>();
  for (const c of cuantos as Array<{ record_id: number; n: number; n_stp: number; n_items: number }>) {
    const fs = de.get(c.record_id) ?? [];
    const lineas = fs.filter((f) => f.k === 'li');
    const items: StpItem[] = fs.filter((f) => f.k === 'it').map((f) => ({ sku: f.code ?? '', nombre: f.name ?? '', cantidades: f.cantidades ?? '[]', image_url: f.foto_cot ?? '' }));
    const cotizacion = items.length ? items.map((i) => i.image_url) : fs.filter((f) => f.k === 'so').map((f) => f.foto_cot ?? '');
    let lista: Array<string | null>;
    if (lineas.length) {
      const { fotos, sueltas } = fotosDeRenglones(lineas, items);
      lista = fotos.some((f) => !f) ? [...fotos, ...(items.length ? sueltas : cotizacion)] : fotos;
    } else lista = cotizacion;
    const fotos = [...new Set(lista.filter((u): u is string => !!u))].slice(0, 3);
    out.set(c.record_id, { fotos, productos: c.n || c.n_items || c.n_stp });
  }
  return out;
}
