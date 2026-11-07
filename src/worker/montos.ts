import type { Ctx } from './env';

// Monto del negocio = total de sus pedidos (pedido de Rodrigo del 07/11/2026). Al cerrar un negocio el monto es un
// estimado; el número final es el del pedido confirmado (total sin IVA de Finnegans). Cuando cambia el total de un pedido
// asociado a un negocio, o se le asocia, se le quita o se anula un pedido, el negocio pasa a tener la suma de sus pedidos.
// Solo hacia adelante: se revisan los negocios de lo que cambió, no se reescriben de golpe los montos de negocios viejos.
// Los casos raros:
// - varios pedidos en un negocio (se dividió en dos, una reposición): la suma de todos;
// - pedidos anulados: no cuentan; si están todos anulados (o se le quitaron todos), el negocio queda como estaba;
// - si a alguno de sus pedidos todavía no le llegó el total, el negocio espera: nunca queda un monto a medias;
// - un pedido asociado a más de un negocio: no se sabe cuánto es de cada uno, así que esos negocios no se tocan;
// - negocios perdidos, en otra moneda que los pedidos, o con «Monto a mano» marcado: no se tocan.
// El cambio queda en el historial del monto, con fuente «pedidos». Se escribe en tanda (pocas consultas aunque sean muchos
// negocios) y sin tocar la fecha de modificación del negocio, así el tablero no se reordena (como los totales de los pedidos).

const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';

export interface MontosEstado {
  revisados: number;      // negocios con pedidos
  actualizados: number;
  sin_total: number;      // esperan el total de algún pedido
  compartidos: number;    // tienen un pedido que también está en otro negocio
  a_mano: number;         // «Monto a mano», perdidos u otra moneda
}

interface Fila {
  deal_id: number; monto: number | null; moneda: string | null; a_mano: unknown; perdido: number;
  order_id: number; total: number | null; etapa: string | null; moneda_pedido: string | null; negocios: number;
}

// ¿El negocio tiene algún pedido no anulado? Si una persona le cambia el monto, queda «Monto a mano» (api.ts): si no, la
// próxima corrida lo volvería a poner como el total de los pedidos.
export async function tienePedidos(db: D1Database, dealId: number) {
  return !!(await db.prepare(`SELECT 1 FROM associations a JOIN records o ON o.id = a.to_id AND o.object_type = 'order' AND o.archived = 0
    WHERE a.from_id = ? AND a.to_type = 'order' AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '') != ? LIMIT 1`).bind(dealId, ANULADO).first());
}

// `ids`: negocios o pedidos que cambiaron (de un pedido, se revisan sus negocios).
export async function montosDesdePedidos(db: D1Database, ids: number[], ctx?: Ctx): Promise<MontosEstado> {
  const estado: MontosEstado = { revisados: 0, actualizados: 0, sin_total: 0, compartidos: 0, a_mano: 0 };
  if (!ids.length) return estado;
  const filtro = `AND d.id IN (
      SELECT id FROM records WHERE id IN (SELECT value FROM json_each(?1)) AND object_type = 'deal'
      UNION SELECT to_id FROM associations WHERE from_id IN (SELECT value FROM json_each(?1)) AND from_type = 'order' AND to_type = 'deal')`;
  const q = db.prepare(`SELECT d.id AS deal_id, d.amount AS monto, json_extract(d.props, '$.deal_currency_code') AS moneda,
      json_extract(d.props, '$.monto_a_mano') AS a_mano, (s.is_closed = 1 AND s.is_won = 0) AS perdido,
      o.id AS order_id, o.amount AS total, json_extract(o.props, '$.hs_pipeline_stage') AS etapa,
      json_extract(o.props, '$.hs_currency_code') AS moneda_pedido,
      (SELECT COUNT(*) FROM associations a2 JOIN records d2 ON d2.id = a2.to_id AND d2.archived = 0
        WHERE a2.from_id = o.id AND a2.to_type = 'deal') AS negocios
    FROM associations a
    JOIN records d ON d.id = a.from_id AND d.object_type = 'deal' AND d.archived = 0
    JOIN records o ON o.id = a.to_id AND o.object_type = 'order' AND o.archived = 0
    LEFT JOIN stages s ON s.id = d.stage_id
    WHERE a.from_type = 'deal' AND a.to_type = 'order' ${filtro}
    ORDER BY d.id`);
  const { results } = await q.bind(JSON.stringify(ids)).all<Fila>();
  const porNegocio = new Map<number, Fila[]>();
  for (const f of results) porNegocio.set(f.deal_id, [...(porNegocio.get(f.deal_id) ?? []), f]);
  if (!porNegocio.size) return estado;
  const userId = ctx?.user.id ?? (await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").first<{ id: number }>())?.id ?? null;
  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const [dealId, filas] of porNegocio) {
    estado.revisados++;
    const d = filas[0];
    const moneda = d.moneda || 'ARS';
    const vivos = filas.filter((f) => f.etapa !== ANULADO);
    if (String(d.a_mano) === 'true' || d.perdido || vivos.some((f) => (f.moneda_pedido || 'ARS') !== moneda)) { estado.a_mano++; continue; }
    if (vivos.some((f) => f.negocios > 1)) { estado.compartidos++; continue; }
    if (!vivos.length) continue;
    if (vivos.some((f) => f.total == null)) { estado.sin_total++; continue; }
    const suma = Math.round(vivos.reduce((n, f) => n + Number(f.total), 0) * 100) / 100;
    if (d.monto != null && Math.abs(Number(d.monto) - suma) < 0.01) continue;
    stmts.push(
      db.prepare("UPDATE records SET props = json_set(props, '$.amount', ?), amount = ? WHERE id = ?").bind(suma, suma, dealId),
      db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'amount', ?, ?, ?, ?, 'pedidos')")
        .bind(dealId, d.monto == null ? null : String(d.monto), String(suma), ts, userId),
    );
    estado.actualizados++;
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  return estado;
}
