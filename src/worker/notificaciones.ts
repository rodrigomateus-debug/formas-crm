import type { Ctx } from './env';
import { now } from './env';
import { visibleSql } from './alcance';
import { textoPlano } from './conversacion';

// La campanita de arriba (pedido de Rodrigo del 13/11/2026): lo que le pasó a cada uno en el CRM, lo último primero, con
// leído / no leído. Son los mismos avisos que salen por mail (avisos.ts: menciones, tareas y registros asignados, faltantes
// de entrega) más las respuestas a tus mensajes. Leer la conversación marca leídas sus menciones (conversacion.ts).

export interface Notificacion {
  id: number; kind: string; record_id: number | null; object_type: string | null; name: string | null; activity_id: number | null;
  subject: string | null; mensaje_id: number | null; texto: string | null; by_user: number | null; created_at: string; leido_at: string | null;
  encargo_id?: number | null; encargo_destino?: string | null; encargo_fecha?: string | null;   // un encargo de Recorridos (recorridos.ts)
}

// Lo que se puede mostrar: de registros que todavía existen y que la persona ve; las menciones y respuestas de mensajes
// borrados, no.
const FILTRO = (user: Ctx['user']) => `v.user_id = ?1 AND (v.record_id IS NULL OR (r.id IS NOT NULL AND r.archived = 0 AND ${visibleSql('r', user)}))
  AND NOT (v.kind IN ('mencion', 'respuesta') AND (m.id IS NULL OR m.borrado_at IS NOT NULL))
  AND NOT (v.kind = 'tarea' AND (a.id IS NULL OR a.archived = 1)) AND NOT (v.kind = 'encargo' AND e.id IS NULL)`;
const JOINS = `FROM avisos v LEFT JOIN records r ON r.id = v.record_id LEFT JOIN mensajes m ON m.id = v.mensaje_id LEFT JOIN activities a ON a.id = v.activity_id
  LEFT JOIN encargos e ON e.id = v.encargo_id`;

export async function notificaciones(db: D1Database, ctx: Ctx, opts: { limite?: number; noLeidas?: boolean } = {}) {
  const lim = Math.min(Math.max(opts.limite ?? 30, 1), 100);
  const [lista, cuenta] = await db.batch([
    db.prepare(`SELECT v.id, v.kind, v.record_id, r.object_type, r.name, v.activity_id, a.subject, v.mensaje_id, COALESCE(m.body, v.detalle) AS texto, v.by_user, v.created_at, v.leido_at,
        v.encargo_id, e.destino AS encargo_destino, e.fecha AS encargo_fecha
      ${JOINS} WHERE ${FILTRO(ctx.user)} ${opts.noLeidas ? 'AND v.leido_at IS NULL' : ''} ORDER BY v.id DESC LIMIT ?2`).bind(ctx.user.id, lim),
    db.prepare(`SELECT COUNT(*) AS n ${JOINS} WHERE ${FILTRO(ctx.user)} AND v.leido_at IS NULL`).bind(ctx.user.id),
  ]);
  const items = (lista.results as Notificacion[]).map((n) => ({ ...n, texto: n.texto != null ? textoPlano(n.texto).slice(0, 200) || '📎 Adjunto' : null }));
  return { no_leidas: (cuenta.results[0] as { n: number }).n, items };
}

// Marcar leídas (las de la lista o, sin lista, todas) o volver a dejarlas sin leer. Solo las propias.
export async function marcarNotificaciones(db: D1Database, ctx: Ctx, ids: unknown, leidas: boolean) {
  const lista = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : null;
  if (lista && !lista.length) return { ok: true };
  await db.prepare(`UPDATE avisos SET leido_at = ? WHERE user_id = ? ${lista ? 'AND id IN (SELECT value FROM json_each(?))' : 'AND leido_at IS NULL'}`)
    .bind(...[leidas ? now() : null, ctx.user.id, ...(lista ? [JSON.stringify(lista)] : [])]).run();
  return { ok: true };
}
