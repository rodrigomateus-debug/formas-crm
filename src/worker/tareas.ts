import type { Ctx } from './env';
import { HttpError, now } from './env';
import { mencionesDe } from './conversacion';

// Tareas en equipo, como en ClickUp y Asana (pedido de Rodrigo del 18/11/2026). La tarea sigue siendo una actividad
// (activities, type 'task') con su responsable principal (owner_id) y sus relaciones con pedidos, negocios, empresas y
// contactos (activity_links). Acá se suma:
// - colaboradores: otras personas que trabajan la tarea (tarea_colaboradores). Ven la tarea en «Mis tareas» y se enteran
//   de lo que se escribe en ella.
// - la conversación de la tarea (tarea_comentarios), con @menciones como la de los pedidos, y hasta dónde leyó cada uno
//   (tarea_lecturas).
// Avisos (tabla avisos, la campanita y el mail): sumar a alguien como colaborador le avisa como una asignación; una
// mención le llega a la campanita y al mail; un comentario, a la campanita del principal y los colaboradores.

const MAX = 5000;

export interface Comentario {
  id: number; activity_id: number; user_id: number | null; body: string; menciones: number[]; responde_a: number | null;
  source: string; editado_at: string | null; borrado_at: string | null; created_at: string;
}
type ComentarioRow = Omit<Comentario, 'menciones'> & { menciones: string };
const comentario = (r: ComentarioRow): Comentario => ({ ...r, menciones: JSON.parse(r.menciones || '[]'), body: r.borrado_at ? '' : r.body });

export interface ResumenTarea { colaboradores: number[]; comentarios: number; sin_leer: number }

async function tarea(db: D1Database, id: number) {
  const t = await db.prepare("SELECT id, owner_id, subject, archived FROM activities WHERE id = ? AND type = 'task'").bind(id)
    .first<{ id: number; owner_id: number | null; subject: string; archived: number }>();
  if (!t) throw new HttpError(404, `No existe la tarea ${id}.`);
  return t;
}

async function colaboradoresDe(db: D1Database, id: number) {
  const { results } = await db.prepare('SELECT user_id FROM tarea_colaboradores WHERE activity_id = ? ORDER BY created_at, user_id').bind(id).all<{ user_id: number }>();
  return results.map((r) => r.user_id);
}

// Colaboradores, cantidad de comentarios y los sin leer de quien mira, para muchas tareas en tres consultas.
export async function resumenTareas(db: D1Database, userId: number, ids: number[]) {
  const out = new Map<number, ResumenTarea>(ids.map((id) => [id, { colaboradores: [], comentarios: 0, sin_leer: 0 }]));
  if (!ids.length) return out;
  const lista = JSON.stringify(ids);
  const [cols, coms] = await db.batch([
    db.prepare('SELECT activity_id, user_id FROM tarea_colaboradores WHERE activity_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, user_id').bind(lista),
    db.prepare(`SELECT c.activity_id, COUNT(*) AS n, SUM(CASE WHEN c.id > COALESCE(l.leido_hasta, 0) AND COALESCE(c.user_id, 0) != ?2 THEN 1 ELSE 0 END) AS sin_leer
      FROM tarea_comentarios c LEFT JOIN tarea_lecturas l ON l.activity_id = c.activity_id AND l.user_id = ?2
      WHERE c.activity_id IN (SELECT value FROM json_each(?1)) AND c.borrado_at IS NULL GROUP BY c.activity_id`).bind(lista, userId),
  ]);
  for (const r of cols.results as Array<{ activity_id: number; user_id: number }>) out.get(r.activity_id)?.colaboradores.push(r.user_id);
  for (const r of coms.results as Array<{ activity_id: number; n: number; sin_leer: number }>) {
    const t = out.get(r.activity_id);
    if (t) { t.comentarios = r.n; t.sin_leer = r.sin_leer ?? 0; }
  }
  return out;
}

// Deja los colaboradores de la tarea como `userIds` (sin el principal). A los nuevos se les avisa.
export async function guardarColaboradores(db: D1Database, ctx: Ctx, activityId: number, userIds: unknown) {
  if (!Array.isArray(userIds)) throw new HttpError(400, '"colaboradores" tiene que ser una lista de ids de usuarios.');
  const t = await tarea(db, activityId);
  const pedidos = [...new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== t.owner_id))].slice(0, 30);
  if (pedidos.length) {
    const { results } = await db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL').bind(JSON.stringify(pedidos)).all<{ id: number }>();
    const existen = new Set(results.map((r) => r.id));
    const falta = pedidos.find((id) => !existen.has(id));
    if (falta) throw new HttpError(400, `No existe el usuario ${falta}.`);
  }
  const antes = await colaboradoresDe(db, activityId);
  const nuevos = pedidos.filter((id) => !antes.includes(id));
  const fuera = antes.filter((id) => !pedidos.includes(id));
  const stmts: D1PreparedStatement[] = [
    ...fuera.map((id) => db.prepare('DELETE FROM tarea_colaboradores WHERE activity_id = ? AND user_id = ?').bind(activityId, id)),
    ...nuevos.map((id) => db.prepare('INSERT OR IGNORE INTO tarea_colaboradores (activity_id, user_id, added_by) VALUES (?, ?, ?)').bind(activityId, id, ctx.user.id)),
  ];
  // A quien lo suman (no a uno mismo, ni lo que entra por integraciones): «te sumó a una tarea».
  if (['crm', 'mcp'].includes(ctx.source)) {
    for (const id of nuevos.filter((x) => x !== ctx.user.id)) {
      stmts.push(db.prepare("INSERT INTO avisos (user_id, kind, activity_id, by_user, detalle) VALUES (?, 'tarea', ?, ?, 'colaborador')").bind(id, activityId, ctx.user.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return pedidos;
}

// El principal no figura además como colaborador (si pasa a serlo, sale de la lista).
export async function sacarPrincipalDeColaboradores(db: D1Database, activityId: number, ownerId: number | null) {
  if (ownerId == null) return;
  await db.prepare('DELETE FROM tarea_colaboradores WHERE activity_id = ? AND user_id = ?').bind(activityId, ownerId).run();
}

// La conversación de la tarea (o, con `desde`, lo nuevo, editado o borrado después) y hasta dónde leyó cada uno.
export async function comentarios(db: D1Database, activityId: number, opts: { desde?: string | null } = {}) {
  await tarea(db, activityId);
  const desde = opts.desde && !Number.isNaN(Date.parse(opts.desde)) ? new Date(opts.desde).toISOString() : '';
  const [lista, lecturas] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT * FROM tarea_comentarios WHERE activity_id = ?1 AND COALESCE(borrado_at, editado_at, created_at) > ?2 ORDER BY id DESC LIMIT 300) ORDER BY id`)
      .bind(activityId, desde),
    db.prepare('SELECT user_id, leido_hasta FROM tarea_lecturas WHERE activity_id = ?').bind(activityId),
  ]);
  return { comentarios: (lista.results as ComentarioRow[]).map(comentario), lecturas: lecturas.results as Array<{ user_id: number; leido_hasta: number }>, at: now() };
}

export async function comentar(db: D1Database, ctx: Ctx, activityId: number, input: { body?: unknown; responde_a?: unknown }) {
  const t = await tarea(db, activityId);
  if (t.archived) throw new HttpError(400, 'La tarea está borrada.');
  const body = String(input.body ?? '').trim();
  if (!body) throw new HttpError(400, 'Escribí algo.');
  if (body.length > MAX) throw new HttpError(400, `El comentario no puede pasar de ${MAX} letras.`);
  const responde = input.responde_a == null || input.responde_a === '' ? null : Number(input.responde_a);
  if (responde != null) {
    const ok = await db.prepare('SELECT 1 FROM tarea_comentarios WHERE id = ? AND activity_id = ?').bind(responde, activityId).first();
    if (!ok) throw new HttpError(400, 'El comentario al que respondés no es de esta tarea.');
  }
  const menciones = mencionesDe(body);
  const ts = now();
  const row = await db.prepare(`INSERT INTO tarea_comentarios (activity_id, user_id, body, menciones, responde_a, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(activityId, ctx.user.id, body, JSON.stringify(menciones), responde, ctx.source === 'mcp' ? 'mcp' : 'crm', ts).first<ComentarioRow>();
  const c = comentario(row!);
  // Quien escribe ya lo leyó. A los mencionados: campanita y mail. Al principal y los colaboradores: la campanita.
  const equipo = [t.owner_id, ...(await colaboradoresDe(db, activityId))].filter((x): x is number => x != null);
  const { results: activos } = await db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND active = 1 AND deleted_at IS NULL')
    .bind(JSON.stringify([...new Set([...menciones, ...equipo])])).all<{ id: number }>();
  const vivos = new Set(activos.map((u) => u.id));
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO tarea_lecturas (activity_id, user_id, leido_hasta) VALUES (?, ?, ?)
      ON CONFLICT (activity_id, user_id) DO UPDATE SET leido_hasta = MAX(leido_hasta, excluded.leido_hasta)`).bind(activityId, ctx.user.id, c.id),
  ];
  for (const id of menciones.filter((x) => x !== ctx.user.id && vivos.has(x))) {
    stmts.push(db.prepare("INSERT INTO avisos (user_id, kind, activity_id, by_user, comentario_id) VALUES (?, 'tarea_mencion', ?, ?, ?)").bind(id, activityId, ctx.user.id, c.id));
  }
  for (const id of [...new Set(equipo)].filter((x) => x !== ctx.user.id && !menciones.includes(x) && vivos.has(x))) {
    stmts.push(db.prepare("INSERT INTO avisos (user_id, kind, activity_id, by_user, comentario_id, sent_at, error) VALUES (?, 'tarea_comentario', ?, ?, ?, ?, 'solo en el CRM')")
      .bind(id, activityId, ctx.user.id, c.id, ts));
  }
  await db.batch(stmts);
  return c;
}

async function propio(db: D1Database, ctx: Ctx, id: number, borrar: boolean) {
  const c = await db.prepare('SELECT * FROM tarea_comentarios WHERE id = ?').bind(id).first<ComentarioRow>();
  if (!c) throw new HttpError(404, `No existe el comentario ${id}.`);
  if (c.borrado_at) throw new HttpError(400, 'El comentario ya está borrado.');
  const admin = ctx.user.role === 'admin';
  if (c.user_id !== ctx.user.id && !(borrar && admin)) throw new HttpError(403, borrar ? 'Solo se pueden borrar los comentarios propios.' : 'Solo se pueden editar los comentarios propios.');
  return c;
}

export async function editarComentario(db: D1Database, ctx: Ctx, id: number, input: { body?: unknown }) {
  await propio(db, ctx, id, false);
  const body = String(input.body ?? '').trim();
  if (!body) throw new HttpError(400, 'Escribí algo (o borralo).');
  if (body.length > MAX) throw new HttpError(400, `El comentario no puede pasar de ${MAX} letras.`);
  const row = await db.prepare('UPDATE tarea_comentarios SET body = ?, menciones = ?, editado_at = ? WHERE id = ? RETURNING *')
    .bind(body, JSON.stringify(mencionesDe(body)), now(), id).first<ComentarioRow>();
  return comentario(row!);
}

export async function borrarComentario(db: D1Database, ctx: Ctx, id: number) {
  await propio(db, ctx, id, true);
  const ts = now();
  await db.batch([
    db.prepare('UPDATE tarea_comentarios SET borrado_at = ? WHERE id = ?').bind(ts, id),
    // Lo que avisaba de este comentario ya no tiene qué mostrar (ni mandar por mail).
    db.prepare("UPDATE avisos SET leido_at = COALESCE(leido_at, ?), sent_at = COALESCE(sent_at, ?), error = COALESCE(error, 'comentario borrado') WHERE comentario_id = ?").bind(ts, ts, id),
  ]);
  return { ok: true };
}

// Leer la tarea: hasta el último comentario (o `hasta`), y sus avisos de comentarios y menciones quedan leídos.
export async function leerTarea(db: D1Database, ctx: Ctx, activityId: number, hasta?: unknown) {
  const ultimo = hasta != null ? Number(hasta)
    : (await db.prepare('SELECT MAX(id) AS id FROM tarea_comentarios WHERE activity_id = ?').bind(activityId).first<{ id: number | null }>())?.id ?? 0;
  if (!Number.isFinite(ultimo)) throw new HttpError(400, '"hasta" no es válido.');
  await db.batch([
    db.prepare(`INSERT INTO tarea_lecturas (activity_id, user_id, leido_hasta) VALUES (?, ?, ?)
      ON CONFLICT (activity_id, user_id) DO UPDATE SET leido_hasta = MAX(leido_hasta, excluded.leido_hasta)`).bind(activityId, ctx.user.id, ultimo),
    db.prepare(`UPDATE avisos SET leido_at = ? WHERE user_id = ? AND activity_id = ? AND kind IN ('tarea_mencion', 'tarea_comentario') AND leido_at IS NULL
      AND COALESCE(comentario_id, 0) <= ?`).bind(now(), ctx.user.id, activityId, ultimo),
  ]);
  return { ok: true };
}
