import type { Ctx } from './env';
import { HttpError, now } from './env';

// Pedidos compartidos (pedido de Rodrigo del 13/11/2026): el propietario del pedido es uno solo (la vendedora), pero lo
// puede compartir con más personas para que lo vean y lo trabajen, por ejemplo con su backoffice. Con quien se comparte:
// - lo ve aunque tenga el perfil Ventas (alcance.ts), con el cliente y sus contactos, como si fuera suyo;
// - sigue la conversación del pedido (conversacion.ts) y le llegan los avisos de cambios (cambios.ts), igual que al
//   propietario;
// - en «Míos» de Pedidos le aparece junto con los suyos (records.ts, filtro del propietario «yo»).
// Lo comparte cualquiera que puede editar el pedido. Queda en el historial y en la conversación (prop 'compartido_con'), y a
// quien se lo comparten le llega un aviso (kind 'compartido').

const MAX = 20;
const FUENTES_PERSONA = ['crm', 'mcp', 'api'];

export async function compartidosDe(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT c.user_id FROM compartidos c JOIN users u ON u.id = c.user_id AND u.active = 1 AND u.deleted_at IS NULL
    WHERE c.record_id = ? ORDER BY c.created_at, c.user_id`).bind(recordId).all<{ user_id: number }>();
  return results.map((r) => r.user_id);
}

async function nombres(db: D1Database, ids: number[]) {
  if (!ids.length) return '';
  const { results } = await db.prepare('SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<{ id: number; name: string }>();
  const por = new Map(results.map((u) => [u.id, u.name]));
  return ids.map((id) => por.get(id) ?? `Usuario ${id}`).join(', ');
}

// Deja el pedido compartido con exactamente esta lista de usuarios (sin el propietario, que ya lo ve).
export async function compartir(db: D1Database, ctx: Ctx, rec: { id: number; object_type: string; owner_id: number | null }, users: unknown) {
  if (rec.object_type !== 'order') throw new HttpError(400, 'Por ahora se comparten los pedidos.');
  if (!Array.isArray(users)) throw new HttpError(400, 'Falta la lista de personas con quienes compartirlo.');
  const pedidos = [...new Set(users.map(Number).filter((n) => Number.isInteger(n) && n > 0))].filter((u) => u !== Number(rec.owner_id));
  if (pedidos.length > MAX) throw new HttpError(400, `Se comparte con hasta ${MAX} personas.`);
  const validos = pedidos.length ? (await db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND active = 1 AND deleted_at IS NULL')
    .bind(JSON.stringify(pedidos)).all<{ id: number }>()).results.map((r) => r.id) : [];
  if (validos.length !== pedidos.length) throw new HttpError(400, 'Alguna de esas personas no es un usuario activo del CRM.');
  const antes = await compartidosDe(db, rec.id);
  const nuevos = pedidos.filter((u) => !antes.includes(u));
  const fuera = antes.filter((u) => !pedidos.includes(u));
  if (!nuevos.length && !fuera.length) return antes;
  const ts = now();
  const despues = [...antes.filter((u) => !fuera.includes(u)), ...nuevos];
  const ultimo = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM mensajes WHERE record_id = ?').bind(rec.id).first<{ m: number }>())!.m;
  const persona = FUENTES_PERSONA.includes(ctx.source);
  await db.batch([
    ...fuera.flatMap((u) => [
      db.prepare('DELETE FROM compartidos WHERE record_id = ? AND user_id = ?').bind(rec.id, u),
      // Deja de seguir la conversación si la seguía solo por tenerlo compartido.
      db.prepare("DELETE FROM conversacion_participantes WHERE record_id = ? AND user_id = ? AND motivo = 'compartido'").bind(rec.id, u),
    ]),
    ...nuevos.flatMap((u) => [
      db.prepare('INSERT OR IGNORE INTO compartidos (record_id, user_id, by_user, created_at) VALUES (?, ?, ?, ?)').bind(rec.id, u, ctx.user.id, ts),
      // Sigue la conversación desde ahora (lo de antes no le queda como sin leer).
      db.prepare("INSERT OR IGNORE INTO conversacion_participantes (record_id, user_id, leido_hasta, motivo) VALUES (?, ?, ?, 'compartido')").bind(rec.id, u, ultimo),
      // Le avisa (campanita y mail), salvo que se lo haya compartido a sí mismo.
      ...(persona && u !== ctx.user.id
        ? [db.prepare("INSERT INTO avisos (user_id, kind, record_id, by_user) VALUES (?, 'compartido', ?, ?)").bind(u, rec.id, ctx.user.id)] : []),
    ]),
    // En el historial del pedido (y en su conversación), con los nombres.
    db.prepare(`INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source, actor) VALUES (?, 'compartido_con', ?, ?, ?, ?, ?, ?)`)
      .bind(rec.id, (await nombres(db, antes)) || null, (await nombres(db, despues)) || null, ts, ctx.actor ? ctx.actor.userId : ctx.user.id, ctx.source, ctx.actor?.name ?? null),
  ]);
  return despues;
}
