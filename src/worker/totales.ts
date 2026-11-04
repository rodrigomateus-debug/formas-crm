import type { Env } from './env';
import { HttpError } from './env';

// Total sin IVA de cada pedido, desde Finnegans (scripts/pedidos-totales.mjs, solo lectura): el neto del pedido de venta,
// en pesos, sumado renglón por renglón. Con eso el tablero de pedidos suma cada columna, como el de negocios.
// Se aplica en tanda (pocas consultas aunque sean cientos de pedidos), queda en el historial de la propiedad y no toca la
// fecha de modificación del pedido, así el tablero no se reordena cada vez que llega un total.

// «PEDVTASTP - 00031277», «PEDVTASTP - 31277» y «pedvtastp-31277» son el mismo pedido.
export const clavePedido = (p: unknown) => {
  const m = String(p ?? '').match(/^\s*([A-Za-z]+)\s*-\s*(\d+)\s*$/);
  return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null;
};

export interface TotalesEstado { recibidos: number; pedidos: number; cruzados: number; actualizados: number; at: string }

export async function aplicarTotales(env: Env, body: { totales?: Record<string, number> }): Promise<TotalesEstado> {
  const tot = body?.totales;
  if (!tot || typeof tot !== 'object' || Array.isArray(tot)) throw new HttpError(400, 'Falta totales: {"PEDVTASTP - 31277": 123456.78, …}.');
  const db = env.DB;
  const porPedido = new Map<string, number>();
  for (const [k, v] of Object.entries(tot)) {
    const c = clavePedido(k);
    const n = Number(v);
    if (c && Number.isFinite(n)) porPedido.set(c, Math.round(n * 100) / 100);
  }
  const sys = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<{ id: number }>();
  const { results } = await db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido, json_extract(props, '$.hs_total_price') AS total
    FROM records WHERE object_type = 'order' AND archived = 0 AND json_extract(props, '$.pedido_finnegans') IS NOT NULL`)
    .all<{ id: number; pedido: string; total: number | string | null }>();
  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let cruzados = 0, actualizados = 0;
  for (const r of results) {
    const k = clavePedido(r.pedido);
    if (!k || !porPedido.has(k)) continue;
    cruzados++;
    const v = porPedido.get(k)!;
    if (r.total != null && r.total !== '' && Math.abs(Number(r.total) - v) < 0.01) continue;
    actualizados++;
    stmts.push(
      db.prepare(`UPDATE records SET props = json_set(props, '$.hs_total_price', ?, '$.hs_currency_code', COALESCE(json_extract(props, '$.hs_currency_code'), 'ARS')),
        amount = ? WHERE id = ?`).bind(v, v, r.id),
      db.prepare('INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(r.id, 'hs_total_price', r.total == null || r.total === '' ? null : String(r.total), String(v), ts, sys?.id ?? null, 'finnegans'),
    );
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  const out = { recibidos: porPedido.size, pedidos: results.length, cruzados, actualizados, at: ts };
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totales_pedidos', ?)").bind(JSON.stringify(out)).run();
  return out;
}
