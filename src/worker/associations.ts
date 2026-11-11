import type { Ctx, ObjectType } from './env';
import { HttpError, now } from './env';
import { getRow, rowToRecord, refreshActivityDates, type RecordRow } from './records';
import { heredarRelacion } from './relacion';

// Cada asociación se guarda en los dos sentidos (A→B y B→A) para leer rápido desde cualquier lado.
export async function associate(db: D1Database, ctx: Ctx, aId: number, bId: number, opts: { label?: string | null; primary?: boolean } = {}) {
  if (aId === bId) throw new HttpError(400, 'Un registro no se puede asociar consigo mismo.');
  const a = await getRow(db, aId);
  const b = await getRow(db, bId);
  if (a.object_type === b.object_type && a.object_type !== 'company') {
    throw new HttpError(400, `No se asocian dos registros de tipo ${a.object_type}.`);
  }
  // Un pedido va en un solo negocio (un negocio sí puede tener varios pedidos): así el monto del negocio es la suma de sus
  // pedidos sin repartir ninguno (montos.ts). Pedido de Rodrigo del 07/11/2026.
  const pedido = a.object_type === 'order' && b.object_type === 'deal' ? a : b.object_type === 'order' && a.object_type === 'deal' ? b : null;
  if (pedido) {
    const negocio = pedido === a ? b : a;
    const otro = await db.prepare(`SELECT d.id, d.name FROM associations x JOIN records d ON d.id = x.to_id AND d.archived = 0
      WHERE x.from_id = ? AND x.to_type = 'deal' AND d.id != ? LIMIT 1`).bind(pedido.id, negocio.id).first<{ id: number; name: string }>();
    if (otro) throw new HttpError(409, `El pedido «${pedido.name}» ya está en el negocio «${otro.name}». Un pedido va en un solo negocio: quitalo de ese para sumarlo a este.`);
  }
  // Empresa principal del contacto o del negocio: la primera que se asocia, o la que se marca.
  let primary = !!opts.primary;
  const contactish = (x: RecordRow, y: RecordRow) => x.object_type !== 'company' && y.object_type === 'company';
  if (!primary && (contactish(a, b) || contactish(b, a))) {
    const owner = a.object_type === 'company' ? b : a;
    const has = await db.prepare("SELECT 1 FROM associations WHERE from_id = ? AND to_type = 'company' AND is_primary = 1").bind(owner.id).first();
    primary = !has;
  }
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  if (primary) {
    const owner = a.object_type === 'company' ? b : a;
    stmts.push(db.prepare("UPDATE associations SET is_primary = 0 WHERE from_id = ? AND to_type = 'company'").bind(owner.id));
    stmts.push(db.prepare("UPDATE associations SET is_primary = 0 WHERE to_id = ? AND from_type = 'company'").bind(owner.id));
  }
  const ins = 'INSERT INTO associations (from_type, from_id, to_type, to_id, label, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (from_id, to_id) DO UPDATE SET label = COALESCE(excluded.label, label), is_primary = MAX(is_primary, excluded.is_primary)';
  stmts.push(db.prepare(ins).bind(a.object_type, a.id, b.object_type, b.id, opts.label ?? null, primary ? 1 : 0, ts));
  stmts.push(db.prepare(ins).bind(b.object_type, b.id, a.object_type, a.id, opts.label ?? null, primary ? 1 : 0, ts));
  stmts.push(db.prepare("INSERT INTO changes (record_id, prop, new_value, changed_at, user_id, source) VALUES (?, 'association', ?, ?, ?, ?)")
    .bind(a.id, `${b.object_type}:${b.id}`, ts, ctx.user.id, ctx.source));
  await db.batch(stmts);
  await refreshActivityDates(db, [a.id, b.id]);
  // Un contacto con su empresa principal: si no tiene tipo de relación, hereda el de la empresa (proveedor, equipo…).
  if (primary && (a.object_type === 'contact' || b.object_type === 'contact') && (a.object_type === 'company' || b.object_type === 'company')) {
    await heredarRelacion(db, ctx, a.object_type === 'contact' ? a : b, a.object_type === 'company' ? a : b);
  }
}

export async function dissociate(db: D1Database, ctx: Ctx, aId: number, bId: number) {
  const ts = now();
  await db.batch([
    db.prepare('DELETE FROM associations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(aId, bId, bId, aId),
    db.prepare("INSERT INTO changes (record_id, prop, old_value, changed_at, user_id, source) VALUES (?, 'association', ?, ?, ?, ?)")
      .bind(aId, String(bId), ts, ctx.user.id, ctx.source),
  ]);
}

export async function associationsOf(db: D1Database, id: number, hiddenPipelines: string[] = []) {
  const { results } = await db.prepare(
    `SELECT r.*, a.label AS assoc_label, a.is_primary AS assoc_primary FROM associations a JOIN records r ON r.id = a.to_id
     WHERE a.from_id = ? AND r.archived = 0 AND (r.pipeline_id IS NULL OR r.pipeline_id NOT IN (SELECT value FROM json_each(?)))
     ORDER BY a.is_primary DESC, r.updated_at DESC LIMIT 500`,
  ).bind(id, JSON.stringify(hiddenPipelines)).all<RecordRow & { assoc_label: string | null; assoc_primary: number }>();
  const out: Record<ObjectType, Array<ReturnType<typeof rowToRecord> & { label: string | null; primary: boolean }>> = {
    contact: [], company: [], deal: [], order: [],
  };
  for (const r of results) out[r.object_type].push({ ...rowToRecord(r), label: r.assoc_label, primary: !!r.assoc_primary });
  return out;
}

export async function primaryCompanyId(db: D1Database, id: number) {
  const row = await db.prepare("SELECT to_id FROM associations WHERE from_id = ? AND to_type = 'company' ORDER BY is_primary DESC, created_at LIMIT 1")
    .bind(id).first<{ to_id: number }>();
  return row?.to_id ?? null;
}
