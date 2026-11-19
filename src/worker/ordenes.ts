import type { Ctx } from './env';
import { now } from './env';
import { createRecord, updateRecord, type Props, type RecordRow } from './records';

// Orden de trabajo (pedido de Rodrigo del 19/11/2026). Lo que Producción trabaja es un objeto propio, la «Orden de trabajo»
// (OT), aparte del pedido de Ventas. Funciona igual que el pedido:
//   - Nace sola con el pedido (en «Pedido confirmado»), venga de donde venga (ClickUp, Finnegans, a mano, Claude).
//   - Copia del pedido su etapa (la que mueve ClickUp, o la vendedora antes de producción) y sus datos de producción, y
//     queda relacionada con el pedido y con su misma empresa, contactos y negocio. Todo eso lo mantiene esta función: no se
//     edita en la OT (sus propiedades son de solo lectura) ni se le cambian las relaciones a mano.
//   - Si el pedido se borra, se borra su OT; si se restaura, vuelve.
// Los productos, la conversación, los bocetos y lo de ClickUp siguen colgando del pedido: la ficha de la OT los muestra
// desde ahí. Ver docs/ORDENES.md.

// Lo que la OT copia de su pedido (mismos nombres internos: la etapa se ve y se filtra igual).
export const OT_COPIA = ['pdv_finnegans', 'hs_pipeline_stage', 'owner_id', 'unidad_de_negocio', 'tipo_de_pedido', 'fecha_de_entrega', 'fecha_pedido',
  'detalle_produccion', 'entregado_el', 'cliente_clickup', 'pedido_finnegans', 'url_clickup'];
// Las relaciones del pedido que la OT tiene también.
export const OT_RELACIONES = ['company', 'contact', 'deal'];
const CONFIRMADO = '4b27b500-f031-4927-9811-68a0b525cbae';
// Entregado y Anulado: los pedidos que ya estaban así cuando nacieron las OT (migración 0101) siguen sin ella.
const CERRADOS = ['1237498998', '3c85a297-e9ce-400b-b42e-9f16853d69d6'];

// «PDV 31167 · Cliente» → «OT 31167 · Cliente».
export function nombreOT(pedido: string) {
  const n = pedido.trim();
  return /^PDV /i.test(n) ? `OT ${n.slice(4)}` : `OT · ${n || 'Pedido'}`;
}

function propsOT(pedido: RecordRow): Props {
  const p = JSON.parse(pedido.props) as Props;
  const out: Props = { nombre_ot: nombreOT(pedido.name) };
  for (const k of OT_COPIA) out[k] = k === 'owner_id' ? pedido.owner_id : (p[k] ?? null);
  if (out.hs_pipeline_stage == null) out.hs_pipeline_stage = CONFIRMADO;
  return out;
}

// La OT de un pedido (si tiene varias por un combinado, la más vieja).
export async function otDePedido(db: D1Database, pedidoId: number) {
  const r = await db.prepare(`SELECT r.id FROM associations a JOIN records r ON r.id = a.to_id
    WHERE a.from_id = ? AND a.to_type = 'work_order' ORDER BY r.archived, r.id LIMIT 1`).bind(pedidoId).first<{ id: number }>();
  return r?.id ?? null;
}

// El pedido de una OT.
export async function pedidoDeOT(db: D1Database, otId: number) {
  const r = await db.prepare("SELECT to_id FROM associations WHERE from_id = ? AND to_type = 'order' ORDER BY created_at LIMIT 1")
    .bind(otId).first<{ to_id: number }>();
  return r?.to_id ?? null;
}

const INS = `INSERT INTO associations (from_type, from_id, to_type, to_id, label, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (from_id, to_id) DO UPDATE SET label = excluded.label, is_primary = excluded.is_primary`;

// Crea o pone al día la OT de un pedido: datos, etapa, borrado y relaciones. Devuelve el id de la OT (null si el pedido no
// tiene ni le corresponde). `crear`: al dar de alta el pedido, la OT nace siempre; después, solo si el pedido sigue activo
// (un pedido entregado o anulado antes de que existieran las OT no la crea por cambiarle algo).
export async function sincronizarOT(db: D1Database, ctx: Ctx, pedidoId: number, opts: { crear?: boolean } = {}): Promise<number | null> {
  const pedido = await db.prepare("SELECT * FROM records WHERE id = ? AND object_type = 'order'").bind(pedidoId).first<RecordRow>();
  if (!pedido) return null;
  const { results: ots } = await db.prepare(`SELECT r.* FROM associations a JOIN records r ON r.id = a.to_id
    WHERE a.from_id = ? AND a.to_type = 'work_order' ORDER BY r.archived, r.id`).bind(pedidoId).all<RecordRow>();
  const ts = now();
  // Un pedido combinado en otro trae su OT: queda una sola (la más vieja), las otras se borran.
  const sobran = ots.slice(1);
  if (sobran.length) {
    await db.batch(sobran.flatMap((o) => [
      db.prepare('UPDATE records SET archived = 1, merged_into = ?, updated_at = ? WHERE id = ?').bind(ots[0].id, ts, o.id),
      db.prepare('DELETE FROM associations WHERE from_id = ? OR to_id = ?').bind(o.id, o.id),
    ]));
  }
  let ot = ots[0] ?? null;
  if (pedido.archived) {
    // Pedido borrado (o combinado en otro): su OT también.
    if (ot && !ot.archived) {
      await db.batch([
        db.prepare('UPDATE records SET archived = 1, updated_at = ? WHERE id = ?').bind(ts, ot.id),
        db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'archived', 'false', 'true', ?, ?, ?)")
          .bind(ot.id, ts, ctx.user.id, ctx.source),
      ]);
    }
    return ot?.id ?? null;
  }
  const props = propsOT(pedido);
  if (!ot && !opts.crear && CERRADOS.includes(String(props.hs_pipeline_stage))) return null;
  if (!ot) {
    const row = await createRecord(db, ctx, 'work_order', props, { system: true, strict: false, skipDedupe: true });
    await db.batch([
      db.prepare(INS).bind('order', pedido.id, 'work_order', row.id, null, 0, ts),
      db.prepare(INS).bind('work_order', row.id, 'order', pedido.id, null, 0, ts),
    ]);
    ot = row;
  } else {
    if (ot.archived) {
      await db.batch([
        db.prepare('UPDATE records SET archived = 0, merged_into = NULL, updated_at = ? WHERE id = ?').bind(ts, ot.id),
        db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'archived', 'true', 'false', ?, ?, ?)")
          .bind(ot.id, ts, ctx.user.id, ctx.source),
      ]);
    }
    const cur = JSON.parse(ot.props) as Props;
    const cambio: Props = {};
    for (const [k, v] of Object.entries(props)) if (String(v ?? '') !== String(cur[k] ?? '')) cambio[k] = v;
    if (Object.keys(cambio).length) await updateRecord(db, ctx, 'work_order', ot.id, cambio, { system: true, strict: false });
  }
  await relacionesOT(db, pedido.id, ot.id, ts);
  return ot.id;
}

// Las empresas, contactos y negocio del pedido, también en la OT (con la misma empresa principal); lo que el pedido ya no
// tiene, se le saca.
async function relacionesOT(db: D1Database, pedidoId: number, otId: number, ts: string) {
  const tipos = JSON.stringify(OT_RELACIONES);
  const [del, de] = await db.batch([
    db.prepare('SELECT to_type, to_id, label, is_primary FROM associations WHERE from_id = ? AND to_type IN (SELECT value FROM json_each(?))').bind(pedidoId, tipos),
    db.prepare('SELECT to_type, to_id, label, is_primary FROM associations WHERE from_id = ? AND to_type IN (SELECT value FROM json_each(?))').bind(otId, tipos),
  ]);
  type A = { to_type: string; to_id: number; label: string | null; is_primary: number };
  const pedido = del.results as A[];
  const ot = new Map((de.results as A[]).map((a) => [a.to_id, a]));
  const stmts: D1PreparedStatement[] = [];
  for (const a of pedido) {
    const ya = ot.get(a.to_id);
    ot.delete(a.to_id);
    if (ya && (ya.label ?? null) === (a.label ?? null) && ya.is_primary === a.is_primary) continue;
    stmts.push(db.prepare(INS).bind('work_order', otId, a.to_type, a.to_id, a.label, a.is_primary, ts));
    stmts.push(db.prepare(INS).bind(a.to_type, a.to_id, 'work_order', otId, a.label, a.is_primary, ts));
  }
  for (const a of ot.values()) {
    stmts.push(db.prepare('DELETE FROM associations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(otId, a.to_id, a.to_id, otId));
  }
  if (stmts.length) await db.batch(stmts);
}

// Red de seguridad (cron): los pedidos activos que todavía no tienen OT (por ejemplo, los que trae la migración de HubSpot,
// que da de alta sin pasar por createRecord). De a `limite` por corrida.
export async function asegurarOTs(db: D1Database, ctx: Ctx, limite = 50) {
  const { results } = await db.prepare(`SELECT o.id FROM records o
    WHERE o.object_type = 'order' AND o.archived = 0
      AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), ?) NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM associations a WHERE a.from_id = o.id AND a.to_type = 'work_order')
    ORDER BY o.id DESC LIMIT ?`).bind(CONFIRMADO, JSON.stringify(CERRADOS), limite).all<{ id: number }>();
  let creadas = 0;
  for (const { id } of results) {
    try { if (await sincronizarOT(db, ctx, id)) creadas++; } catch (e) { console.error('orden de trabajo', id, (e as Error).message); }
  }
  return { creadas };
}
