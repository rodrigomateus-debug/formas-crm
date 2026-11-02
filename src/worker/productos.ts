import type { Env } from './env';
import { Budget, OutOfBudget } from './budget';
import { finnegansPedidoVenta, finnegansProducto, finnegansToken } from './finnegans';

// Productos de un pedido (pedido de Rodrigo del 02/11/2026): los renglones del pedido de venta de Finnegans (cantidad,
// precio y descuentos) con la ficha de cada producto (nombre, descripción y foto). Se leen de Finnegans al abrir el
// pedido y quedan guardados: los renglones se vuelven a pedir cada 6 horas y la ficha del producto cada 30 días.
// Finnegans solo se lee.

const RENGLONES_HORAS = 6;
const FICHA_DIAS = 30;
const MONEDA: Record<string, string> = { PES: 'ARS', DOL: 'USD' };

async function refresh(env: Env, recordId: number, pedido: string) {
  const db = env.DB;
  const b = Budget.of(env);
  const token = await finnegansToken(env, b);
  if (!token) return;
  const p = await finnegansPedidoVenta(env, token, pedido, b);
  const items = p?.Items ?? [];
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
  const codes = [...new Set(items.map((it) => it.ProductoCodigo).filter(Boolean) as string[])];
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

export async function orderProducts(env: Env, recordId: number, props: Record<string, unknown>, opts: { refresh?: boolean } = {}) {
  const db = env.DB;
  const pedido = typeof props.pedido_finnegans === 'string' ? props.pedido_finnegans : null;
  const configured = !!(env.FINNEGANS_CLIENT_ID && env.FINNEGANS_CLIENT_SECRET);
  let sync = await db.prepare('SELECT fetched_at, error FROM line_item_sync WHERE record_id = ?').bind(recordId).first<{ fetched_at: string; error: string | null }>();
  // Si la última vez falló, se reintenta a los 10 minutos.
  const stale = !sync || opts.refresh || Date.now() - Date.parse(sync.fetched_at) > (sync.error ? 10 * 60_000 : RENGLONES_HORAS * 3600_000);
  if (pedido && configured && stale) {
    let error: string | null = null;
    try { await refresh(env, recordId, pedido); } catch (e) { error = e instanceof OutOfBudget ? null : (e as Error).message; }
    sync = { fetched_at: new Date().toISOString(), error };
    await db.prepare('INSERT OR REPLACE INTO line_item_sync (record_id, fetched_at, error) VALUES (?, ?, ?)').bind(recordId, sync.fetched_at, error).run();
  }
  const { results } = await db.prepare(`SELECT li.code, li.description, li.quantity, li.unit_price, li.discount, li.tax_included, li.currency,
      p.name, p.description AS product_description, p.image_url
    FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id = ? ORDER BY li.position`).bind(recordId)
    .all<{ code: string | null; description: string | null; quantity: number | null; unit_price: number | null; discount: number; tax_included: number; currency: string | null;
      name: string | null; product_description: string | null; image_url: string | null }>();
  const items = results.map((r) => ({
    code: r.code, name: r.name ?? r.code ?? 'Producto', description: r.description ?? r.product_description, image_url: r.image_url,
    quantity: r.quantity, unit_price: r.unit_price, discount: r.discount, tax_included: !!r.tax_included, currency: r.currency ?? 'ARS',
    subtotal: r.quantity != null && r.unit_price != null ? Math.round(r.quantity * r.unit_price * (1 - r.discount / 100) * 100) / 100 : null,
  }));
  return {
    pedido, configured, fetched_at: sync?.fetched_at ?? null, error: sync?.error ?? null, items,
    total: items.reduce((t, i) => t + (i.subtotal ?? 0), 0), currency: items[0]?.currency ?? 'ARS', tax_included: items.some((i) => i.tax_included),
  };
}
