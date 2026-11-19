import type { Ctx } from './env';
import { now } from './env';
import { NATIVE_ID_START, type Props, type RecordRow } from './records';

// Orden de trabajo (pedido de Rodrigo del 19/11/2026). Lo que Producción trabaja es un objeto propio, la «Orden de trabajo»
// (OT), aparte del pedido de Ventas. Funciona igual que el pedido:
//   - Nace sola con el pedido (en «Pedido confirmado»), venga de donde venga (ClickUp, Finnegans, a mano, Claude). Una por
//     pedido: el vínculo está en `ot_pedido` (único en la base) y además se asocian como cualquier registro.
//   - Copia del pedido su nombre («PDV 31167 · Cliente» → «OT 31167 · Cliente»), su etapa y sus datos de producción, y tiene
//     su misma empresa, contactos y negocio. La etapa es la del pedido: hasta «Listo para producción» la mueven las
//     vendedoras; después, ClickUp según el estado de los productos (lo que Producción cambia en la pestaña Producción).
//     En la OT nada se edita a mano (sus propiedades son de solo lectura) ni se le cambian las relaciones.
//   - Si el pedido se borra, se borra su OT; si se restaura, vuelve la misma.
//   - Los productos, la conversación (una sola, la del pedido), los bocetos, los logos, los remitos y lo de ClickUp siguen
//     colgando del pedido: la ficha de la OT los muestra y los edita desde ahí (api.ts traduce la OT a su pedido).
// Ver docs/ORDENES.md.

// Lo que la OT copia de su pedido (mismos nombres internos: la etapa se ve y se filtra igual).
export const OT_COPIA = ['pdv_finnegans', 'hs_pipeline_stage', 'unidad_de_negocio', 'tipo_de_pedido', 'fecha_de_entrega', 'fecha_pedido',
  'detalle_produccion', 'entregado_el', 'cliente_clickup', 'pedido_finnegans', 'url_clickup'];
// Las relaciones del pedido que la OT tiene también.
export const OT_RELACIONES = ['company', 'contact', 'deal'];
export const CONFIRMADO = '4b27b500-f031-4927-9811-68a0b525cbae';
// Entregado y Anulado: un pedido así sin OT no la crea (los que ya estaban cerrados cuando nacieron las OT, o los que entran
// ya cerrados, por ejemplo un PDV viejo traído de ClickUp). Si se reabre, la crea.
const CERRADOS = ['1237498998', '3c85a297-e9ce-400b-b42e-9f16853d69d6'];

// «PDV 31167 · Cliente» → «OT 31167 · Cliente». El mismo cálculo que la migración 0102.
export function nombreOT(pedido: string) {
  const n = pedido.trim();
  return /^PDV /.test(n) ? `OT ${n.slice(4)}` : `OT · ${n || 'Pedido'}`;
}

function propsOT(pedido: RecordRow): Props {
  const p = JSON.parse(pedido.props) as Props;
  // pedido_id: sin propiedad propia (no se ve como dato), para que las pantallas lleguen al pedido sin otra consulta.
  const out: Props = { nombre_ot: nombreOT(pedido.name), pedido_id: pedido.id };
  for (const k of OT_COPIA) if (p[k] != null && p[k] !== '') out[k] = p[k];
  if (pedido.owner_id != null) out.owner_id = pedido.owner_id;
  if (out.hs_pipeline_stage == null) out.hs_pipeline_stage = CONFIRMADO;
  return out;
}

// La OT de un pedido y el pedido de una OT.
export async function otDePedido(db: D1Database, pedidoId: number) {
  return (await db.prepare('SELECT ot_id FROM ot_pedido WHERE pedido_id = ?').bind(pedidoId).first<{ ot_id: number }>())?.ot_id ?? null;
}
export async function pedidoDeOT(db: D1Database, otId: number) {
  return (await db.prepare('SELECT pedido_id FROM ot_pedido WHERE ot_id = ?').bind(otId).first<{ pedido_id: number }>())?.pedido_id ?? null;
}
// De muchos pedidos a la vez (pantallas de Producción, Cronograma…): pedido → OT.
export async function otsDePedidos(db: D1Database, pedidos: number[]) {
  const out = new Map<number, number>();
  if (!pedidos.length) return out;
  const { results } = await db.prepare('SELECT pedido_id, ot_id FROM ot_pedido WHERE pedido_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(pedidos)])).all<{ pedido_id: number; ot_id: number }>();
  for (const r of results) out.set(r.pedido_id, r.ot_id);
  return out;
}
// Al revés: OT → pedido.
export async function pedidosDeOTs(db: D1Database, ots: number[]) {
  const out = new Map<number, number>();
  if (!ots.length) return out;
  const { results } = await db.prepare('SELECT pedido_id, ot_id FROM ot_pedido WHERE ot_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(ots)])).all<{ pedido_id: number; ot_id: number }>();
  for (const r of results) out.set(r.ot_id, r.pedido_id);
  return out;
}

const INS = `INSERT INTO associations (from_type, from_id, to_type, to_id, label, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (from_id, to_id) DO UPDATE SET label = excluded.label, is_primary = excluded.is_primary`;
const archivar = (db: D1Database, ctx: Ctx, id: number, archivada: boolean, ts: string) => [
  db.prepare('UPDATE records SET archived = ?, updated_at = ? WHERE id = ?').bind(archivada ? 1 : 0, ts, id),
  db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'archived', ?, ?, ?, ?, ?)")
    .bind(id, String(!archivada), String(archivada), ts, ctx.user.id, ctx.source),
];

// Crea o pone al día la OT de un pedido. Devuelve su id (null si el pedido no tiene ni le corresponde).
//   `crear`: al dar de alta el pedido nace siempre (salvo que entre ya entregado o anulado). Después, solo si el pedido está
//     activo y tiene su PDV en ClickUp (los que quedaron colgados de HubSpot sin PDV no la crean por cambiarles algo).
//   `relaciones`: revisar también empresas, contactos y negocio (al crearla, al cambiar una relación del pedido y en la
//     conciliación). Los datos se copian sin historial propio: el historial es el del pedido (la conversación junta los dos).
// Liviano a propósito: corre con cada cambio de un pedido en la sincronización de ClickUp (una lectura y una escritura).
export async function sincronizarOT(db: D1Database, ctx: Ctx, pedidoIn: number | RecordRow, opts: { crear?: boolean; relaciones?: boolean } = {}): Promise<number | null> {
  const pedido = typeof pedidoIn === 'number'
    ? await db.prepare("SELECT * FROM records WHERE id = ? AND object_type = 'order'").bind(pedidoIn).first<RecordRow>()
    : pedidoIn;
  if (!pedido || pedido.object_type !== 'order') return null;
  const ot = await db.prepare('SELECT r.* FROM ot_pedido x JOIN records r ON r.id = x.ot_id WHERE x.pedido_id = ?').bind(pedido.id).first<RecordRow>();
  const ts = now();
  if (pedido.archived) {
    // Pedido borrado (o combinado en otro): su OT también.
    if (ot && !ot.archived) await db.batch(archivar(db, ctx, ot.id, true, ts));
    return ot?.id ?? null;
  }
  const props = propsOT(pedido);
  const nombre = String(props.nombre_ot);
  if (!ot) {
    if (CERRADOS.includes(String(props.hs_pipeline_stage))) return null;
    if (!opts.crear && !props.url_clickup) return null;
    const row = await db.prepare(`INSERT INTO records (id, object_type, name, props, owner_id, last_activity_at, created_at, updated_at, created_by, source, source_detail)
      VALUES ((SELECT MAX(COALESCE(MAX(id) + 1, 0), ${NATIVE_ID_START}) FROM records), 'work_order', ?, ?, ?, ?, ?, ?, ?, ?, 'orden de trabajo') RETURNING id`)
      .bind(nombre, JSON.stringify(props), pedido.owner_id, pedido.last_activity_at, ts, ts, ctx.user.id, ctx.source).first<{ id: number }>();
    const id = row!.id;
    const vinculo = await db.prepare('INSERT INTO ot_pedido (pedido_id, ot_id) VALUES (?, ?) ON CONFLICT (pedido_id) DO NOTHING').bind(pedido.id, id).run();
    if (!vinculo.meta.changes) {
      // Otra sincronización la creó al mismo tiempo: queda la suya.
      await db.prepare('DELETE FROM records WHERE id = ?').bind(id).run();
      return otDePedido(db, pedido.id);
    }
    await db.batch([
      db.prepare(INS).bind('order', pedido.id, 'work_order', id, null, 0, ts),
      db.prepare(INS).bind('work_order', id, 'order', pedido.id, null, 0, ts),
    ]);
    await relacionesOT(db, pedido.id, id, ts);
    return id;
  }
  const stmts: D1PreparedStatement[] = [];
  if (ot.archived) stmts.push(...archivar(db, ctx, ot.id, false, ts));
  const cur = JSON.parse(ot.props) as Props;
  const distinto = ot.name !== nombre || (ot.owner_id ?? null) !== (pedido.owner_id ?? null)
    || [...new Set([...Object.keys(cur), ...Object.keys(props)])].some((k) => String(cur[k] ?? '') !== String(props[k] ?? ''));
  if (distinto) {
    stmts.push(db.prepare('UPDATE records SET name = ?, props = ?, owner_id = ?, last_activity_at = ?, updated_at = ? WHERE id = ?')
      .bind(nombre, JSON.stringify(props), pedido.owner_id, pedido.last_activity_at ?? ot.last_activity_at, ts, ot.id));
  }
  if (stmts.length) await db.batch(stmts);
  if (opts.relaciones) await relacionesOT(db, pedido.id, ot.id, ts);
  return ot.id;
}

// Las empresas, contactos y negocio del pedido, también en la OT (con la misma empresa principal); lo que el pedido ya no
// tiene, se le saca. El vínculo con el pedido no se toca.
async function relacionesOT(db: D1Database, pedidoId: number, otId: number, ts: string) {
  const tipos = JSON.stringify(OT_RELACIONES);
  const [del, de] = await db.batch([
    db.prepare('SELECT to_type, to_id, label, is_primary FROM associations WHERE from_id = ? AND to_type IN (SELECT value FROM json_each(?))').bind(pedidoId, tipos),
    db.prepare('SELECT to_type, to_id, label, is_primary FROM associations WHERE from_id = ? AND to_type IN (SELECT value FROM json_each(?))').bind(otId, tipos),
  ]);
  type A = { to_type: string; to_id: number; label: string | null; is_primary: number };
  const ot = new Map((de.results as A[]).map((a) => [a.to_id, a]));
  const stmts: D1PreparedStatement[] = [];
  for (const a of del.results as A[]) {
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

// Dos pedidos combinados (records.ts, mergeRecords): queda la OT del pedido que queda. Si no tenía, pasa a ser suya la del
// otro; si tenían las dos, la del otro se borra (queda apuntando a la buena).
export async function combinarOTs(db: D1Database, ctx: Ctx, primarioId: number, perdedorId: number) {
  const [a, b] = await Promise.all([otDePedido(db, primarioId), otDePedido(db, perdedorId)]);
  if (b == null) return;
  const ts = now();
  if (a == null) {
    await db.batch([
      db.prepare('DELETE FROM ot_pedido WHERE pedido_id = ?').bind(perdedorId),
      db.prepare('INSERT INTO ot_pedido (pedido_id, ot_id) VALUES (?, ?)').bind(primarioId, b),
    ]);
  } else {
    await db.batch([
      db.prepare('DELETE FROM ot_pedido WHERE pedido_id = ?').bind(perdedorId),
      db.prepare('UPDATE records SET archived = 1, merged_into = ?, updated_at = ? WHERE id = ?').bind(a, ts, b),
      db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'merged', ?, ?, ?, ?, ?)")
        .bind(a, String(b), 'orden de trabajo combinada', ts, ctx.user.id, ctx.source),
      // Lo que se cargó en la OT que se va (notas, tareas) pasa a la que queda.
      db.prepare('INSERT OR IGNORE INTO activity_links (activity_id, record_id, object_type) SELECT activity_id, ?, object_type FROM activity_links WHERE record_id = ?').bind(a, b),
      db.prepare('DELETE FROM activity_links WHERE record_id = ?').bind(b),
      db.prepare('DELETE FROM associations WHERE from_id = ? OR to_id = ?').bind(b, b),
    ]);
  }
  await sincronizarOT(db, ctx, primarioId, { relaciones: true });
}

// Conciliación (cron, una vez por hora): algunos procesos escriben el pedido directo en la base, sin pasar por
// updateRecord (la vendedora y la fecha que trae el informe de totales, la migración de HubSpot…). Acá se buscan, solo con
// SQL, las OT que quedaron distintas de su pedido (datos, propietario, borrado o relaciones) y los pedidos activos con PDV
// que todavía no tienen la suya, y se ponen al día de a `limite`.
export async function conciliarOTs(db: D1Database, ctx: Ctx, limite = 15) {
  const igual = (k: string) => k === 'hs_pipeline_stage'
    ? `COALESCE(json_extract(p.props, '$.${k}'), '${CONFIRMADO}') = COALESCE(json_extract(o.props, '$.${k}'), '${CONFIRMADO}')`
    : `COALESCE(json_extract(p.props, '$.${k}'), '') = COALESCE(json_extract(o.props, '$.${k}'), '')`;
  const nombre = `CASE WHEN trim(p.name) LIKE 'PDV %' THEN 'OT ' || substr(trim(p.name), 5) WHEN trim(p.name) = '' THEN 'OT · Pedido' ELSE 'OT · ' || trim(p.name) END`;
  const rel = (desde: string, hacia: string) => `EXISTS (SELECT to_id, is_primary, COALESCE(label, '') FROM associations WHERE from_id = ${desde}.id AND to_type IN ('company', 'contact', 'deal')
    EXCEPT SELECT to_id, is_primary, COALESCE(label, '') FROM associations WHERE from_id = ${hacia}.id AND to_type IN ('company', 'contact', 'deal'))`;
  const { results } = await db.prepare(`
    SELECT p.id FROM ot_pedido x JOIN records p ON p.id = x.pedido_id JOIN records o ON o.id = x.ot_id
    WHERE NOT (p.archived = 1 AND o.archived = 1) AND (
      p.archived != o.archived OR o.name != ${nombre} OR p.owner_id IS NOT o.owner_id OR json_extract(o.props, '$.pedido_id') IS NOT p.id
      OR NOT (${OT_COPIA.map(igual).join(' AND ')})
      OR ${rel('p', 'o')} OR ${rel('o', 'p')})
    UNION
    SELECT o.id FROM records o
    WHERE o.object_type = 'order' AND o.archived = 0 AND COALESCE(json_extract(o.props, '$.url_clickup'), '') != ''
      AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), ?) NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM ot_pedido x WHERE x.pedido_id = o.id)
    LIMIT ?`).bind(CONFIRMADO, JSON.stringify(CERRADOS), limite).all<{ id: number }>();
  let revisadas = 0;
  for (const { id } of results) {
    try { await sincronizarOT(db, ctx, id, { relaciones: true }); revisadas++; } catch (e) { console.error('orden de trabajo', id, (e as Error).message); }
  }
  return { revisadas };
}
