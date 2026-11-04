import { ownersOfUnitsSql, UNIDADES } from './records';
import { avisarAsignacion } from './avisos';
import type { Ctx } from './env';
import { HttpError, now } from './env';
import { refreshActivityDates } from './records';
import { primaryCompanyId } from './associations';

export type ActivityType = 'note' | 'email' | 'call' | 'meeting' | 'task' | 'whatsapp';
export const ACTIVITY_TYPES: ActivityType[] = ['note', 'email', 'call', 'meeting', 'task', 'whatsapp'];

export interface ActivityInput {
  type: ActivityType;
  subject?: string;
  body?: string;
  occurred_at?: string;
  owner_id?: number | null;
  direction?: 'in' | 'out' | null;
  status?: string | null;
  outcome?: string | null;
  due_at?: string | null;
  priority?: 'none' | 'low' | 'medium' | 'high' | null;
  task_type?: string | null;
  meta?: Record<string, unknown>;
  thread_id?: string | null;
  external_id?: string | null;
  links?: number[];
  // Si es false, no se asocia sola a la empresa principal del contacto.
  link_primary_company?: boolean;
}

export interface ActivityRow {
  id: number;
  type: ActivityType;
  occurred_at: string;
  owner_id: number | null;
  subject: string;
  body: string;
  direction: string | null;
  status: string | null;
  outcome: string | null;
  due_at: string | null;
  completed_at: string | null;
  priority: string | null;
  task_type: string | null;
  meta: string;
  thread_id: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  source: string;
  archived: number;
}

export const TASK_STATUS = ['NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'COMPLETED'];
export const CALL_OUTCOMES = ['Conectada', 'Ocupado', 'No atendió', 'Dejó mensaje', 'Número equivocado'];

const NATIVE_ACTIVITY_START = 900_000_000_001;

function iso(v: unknown, field: string) {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `"${field}" no es una fecha válida.`);
  return d.toISOString();
}

function shape(a: ActivityRow & { links?: string | null }) {
  const links = a.links ? (JSON.parse(`[${a.links}]`) as Array<{ id: number; type: string; name: string }>) : [];
  return { ...a, meta: JSON.parse(a.meta || '{}'), links, archived: !!a.archived };
}

async function linksWithCompanies(db: D1Database, links: number[], linkCompany: boolean) {
  const out = new Set(links.filter(Boolean));
  if (linkCompany) {
    for (const id of links) {
      const t = await db.prepare('SELECT object_type FROM records WHERE id = ?').bind(id).first<{ object_type: string }>();
      if (!t) throw new HttpError(404, `No existe el registro ${id} para asociar la actividad.`);
      if (t.object_type === 'contact') {
        const c = await primaryCompanyId(db, id);
        if (c) out.add(c);
      }
    }
  }
  return [...out];
}

export async function createActivity(db: D1Database, ctx: Ctx, input: ActivityInput) {
  if (!ACTIVITY_TYPES.includes(input.type)) throw new HttpError(400, `Tipo de actividad desconocido: ${input.type}. Opciones: ${ACTIVITY_TYPES.join(', ')}`);
  if (input.type === 'task' && !input.subject?.trim()) throw new HttpError(400, 'La tarea necesita un título.');
  const ts = now();
  const occurred = iso(input.occurred_at, 'occurred_at') ?? ts;
  const due = input.type === 'task' ? (iso(input.due_at, 'due_at') ?? occurred) : iso(input.due_at, 'due_at');
  const status = input.type === 'task' ? (input.status && TASK_STATUS.includes(input.status) ? input.status : 'NOT_STARTED') : input.status ?? null;
  const links = await linksWithCompanies(db, input.links ?? [], input.link_primary_company !== false);
  // Mails y mensajes sincronizados: si ya está (mismo external_id), solo se suman los vínculos nuevos.
  if (input.external_id) {
    const existing = await db.prepare('SELECT id FROM activities WHERE type = ? AND external_id = ?').bind(input.type, input.external_id).first<{ id: number }>();
    if (existing) {
      await linkActivity(db, existing.id, links);
      return getActivity(db, existing.id);
    }
  }
  const row = await db.prepare(
    `INSERT INTO activities (id, type, occurred_at, owner_id, subject, body, direction, status, outcome, due_at, completed_at, priority,
       task_type, meta, thread_id, external_id, created_at, updated_at, created_by, source)
     VALUES ((SELECT MAX(COALESCE(MAX(id) + 1, 0), ${NATIVE_ACTIVITY_START}) FROM activities), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  ).bind(input.type, occurred, input.owner_id ?? ctx.user.id, input.subject?.trim() ?? '', input.body ?? '', input.direction ?? null, status,
    input.outcome ?? null, due, status === 'COMPLETED' ? ts : null, input.priority ?? (input.type === 'task' ? 'none' : null),
    input.task_type ?? null, JSON.stringify(input.meta ?? {}), input.thread_id ?? null, input.external_id ?? null, ts, ts, ctx.user.id,
    ctx.source).first<{ id: number }>();
  await linkActivity(db, row!.id, links);
  if (input.type === 'task') await avisarAsignacion(db, ctx, input.owner_id ?? ctx.user.id, { activityId: row!.id });
  return getActivity(db, row!.id);
}

export async function linkActivity(db: D1Database, activityId: number, recordIds: number[]) {
  if (!recordIds.length) return;
  await db.batch(recordIds.map((rid) => db.prepare(
    'INSERT OR IGNORE INTO activity_links (activity_id, record_id, object_type) SELECT ?, id, object_type FROM records WHERE id = ?',
  ).bind(activityId, rid)));
  await refreshActivityDates(db, recordIds);
}

export async function unlinkActivity(db: D1Database, activityId: number, recordId: number) {
  await db.prepare('DELETE FROM activity_links WHERE activity_id = ? AND record_id = ?').bind(activityId, recordId).run();
  await refreshActivityDates(db, [recordId]);
}

const SELECT_ACTIVITY = `SELECT a.*, (SELECT group_concat(json_object('id', r.id, 'type', r.object_type, 'name', r.name))
  FROM activity_links l JOIN records r ON r.id = l.record_id WHERE l.activity_id = a.id) AS links FROM activities a`;

export async function getActivity(db: D1Database, id: number) {
  const row = await db.prepare(`${SELECT_ACTIVITY} WHERE a.id = ?`).bind(id).first<ActivityRow & { links: string | null }>();
  if (!row) throw new HttpError(404, `No existe la actividad ${id}.`);
  return shape(row);
}

export async function updateActivity(db: D1Database, ctx: Ctx, id: number, input: Partial<ActivityInput> & { archived?: boolean }) {
  const cur = await getActivity(db, id);
  const ts = now();
  const status = input.status ?? cur.status;
  const fields: Record<string, unknown> = {
    subject: input.subject ?? cur.subject,
    body: input.body ?? cur.body,
    occurred_at: input.occurred_at ? iso(input.occurred_at, 'occurred_at') : cur.occurred_at,
    owner_id: input.owner_id === undefined ? cur.owner_id : input.owner_id,
    direction: input.direction === undefined ? cur.direction : input.direction,
    status,
    outcome: input.outcome === undefined ? cur.outcome : input.outcome,
    due_at: input.due_at === undefined ? cur.due_at : iso(input.due_at, 'due_at'),
    completed_at: status === 'COMPLETED' ? (cur.completed_at ?? ts) : null,
    priority: input.priority === undefined ? cur.priority : input.priority,
    task_type: input.task_type === undefined ? cur.task_type : input.task_type,
    meta: JSON.stringify(input.meta ? { ...cur.meta, ...input.meta } : cur.meta),
    archived: input.archived === undefined ? (cur.archived ? 1 : 0) : input.archived ? 1 : 0,
    updated_at: ts,
  };
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE activities SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => fields[k]), id).run();
  if (input.links) await linkActivity(db, id, input.links);
  await refreshActivityDates(db, cur.links.map((l) => l.id));
  if (cur.type === 'task' && fields.owner_id !== cur.owner_id) await avisarAsignacion(db, ctx, fields.owner_id as number | null, { activityId: id });
  return getActivity(db, id);
}

// Línea de tiempo de un registro. En empresas y negocios suma la actividad de los contactos asociados
// (y en empresas, la de sus negocios), que es lo que el equipo espera ver en la ficha.
export async function timeline(db: D1Database, recordId: number, opts: { types?: string[]; rollup?: boolean; limit?: number; before?: string; hiddenPipelines?: string[]; q?: string; owner?: number } = {}) {
  const rec = await db.prepare('SELECT object_type FROM records WHERE id = ?').bind(recordId).first<{ object_type: string }>();
  if (!rec) throw new HttpError(404, `No existe el registro ${recordId}.`);
  const rollup = opts.rollup !== false && rec.object_type !== 'contact';
  const scope = rollup
    ? `l.record_id = ?1 OR l.record_id IN (SELECT a.to_id FROM associations a JOIN records x ON x.id = a.to_id WHERE a.from_id = ?1
        AND a.to_type IN (${rec.object_type === 'company' ? "'contact', 'deal'" : "'contact'"}) AND (x.pipeline_id IS NULL OR x.pipeline_id NOT IN (SELECT value FROM json_each(?3))))`
    : '(l.record_id = ?1 AND ?3 IS NOT NULL)';
  const types = (opts.types ?? []).filter((t) => ACTIVITY_TYPES.includes(t as ActivityType));
  const typeSql = types.length ? `AND a.type IN (${types.map((t) => `'${t}'`).join(', ')})` : '';
  const before = opts.before ?? '9999';
  const limit = Math.min(opts.limit ?? 50, 200);
  const { results } = await db.prepare(
    `${SELECT_ACTIVITY} WHERE a.archived = 0 ${typeSql} AND COALESCE(a.due_at, a.occurred_at) < ?2
     AND a.id IN (SELECT l.activity_id FROM activity_links l WHERE ${scope})
     AND (?4 IS NULL OR a.subject LIKE ?4 OR a.body LIKE ?4) AND (?5 IS NULL OR a.owner_id = ?5)
     ORDER BY COALESCE(json_extract(a.meta, '$.pinned'), 0) DESC, CASE WHEN a.type = 'task' AND a.status != 'COMPLETED' THEN 0 ELSE 1 END,
       COALESCE(CASE WHEN a.type = 'task' THEN a.due_at END, a.occurred_at) DESC
     LIMIT ${limit}`,
  ).bind(recordId, before, JSON.stringify(opts.hiddenPipelines ?? []), opts.q?.trim() ? `%${opts.q.trim()}%` : null, opts.owner ?? null).all<ActivityRow & { links: string | null }>();
  const changes = await db.prepare(
    `SELECT c.*, u.name AS user_name FROM changes c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.record_id = ? AND c.prop IN ('dealstage', 'pipeline', 'owner_id', 'lifecyclestage', 'archived', 'merged', 'amount', 'hs_pipeline_stage', 'factura_numero')
     ORDER BY c.changed_at DESC LIMIT 100`,
  ).bind(recordId).all();
  const counts = await db.prepare(
    `SELECT a.type, COUNT(*) AS n FROM activities a WHERE a.archived = 0 AND a.id IN (SELECT l.activity_id FROM activity_links l WHERE ${scope}) GROUP BY a.type`,
  ).bind(recordId, '', JSON.stringify(opts.hiddenPipelines ?? [])).all<{ type: string; n: number }>();
  return {
    activities: results.map(shape),
    changes: changes.results,
    counts: Object.fromEntries(counts.results.map((c) => [c.type, c.n])),
  };
}

export interface TaskQuery {
  owner?: number | 'all';
  status?: 'open' | 'done' | 'all';
  due?: 'overdue' | 'today' | 'week' | 'upcoming' | 'all';
  q?: string;
  record?: number;
  unidades?: string[];   // por el equipo de quien tiene la tarea
  limit?: number;
  offset?: number;
}

export async function listTasks(db: D1Database, ctx: Ctx, q: TaskQuery) {
  const where = ["a.type = 'task'", 'a.archived = 0'];
  const binds: unknown[] = [];
  const owner = q.owner ?? ctx.user.id;
  if (owner !== 'all') { where.push('a.owner_id = ?'); binds.push(owner); }
  const unidades = (q.unidades ?? []).filter((k) => UNIDADES[k]);
  if (unidades.length) where.push(ownersOfUnitsSql(unidades, binds, 'a.owner_id'));
  if ((q.status ?? 'open') === 'open') where.push("a.status != 'COMPLETED'");
  if (q.status === 'done') where.push("a.status = 'COMPLETED'");
  const start = new Date(); start.setUTCHours(3, 0, 0, 0); // medianoche en Argentina (UTC-3)
  if (start.getTime() > Date.now()) start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start.getTime() + 86_400_000);
  if (q.due === 'overdue') { where.push('a.due_at < ?'); binds.push(start.toISOString()); }
  if (q.due === 'today') { where.push('a.due_at < ?'); binds.push(end.toISOString()); }
  if (q.due === 'week') { where.push('a.due_at < ?'); binds.push(new Date(start.getTime() + 7 * 86_400_000).toISOString()); }
  if (q.due === 'upcoming') { where.push('a.due_at >= ?'); binds.push(end.toISOString()); }
  if (q.q) { where.push('(a.subject LIKE ? OR a.body LIKE ?)'); binds.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.record) { where.push('a.id IN (SELECT activity_id FROM activity_links WHERE record_id = ?)'); binds.push(q.record); }
  const limit = Math.min(q.limit ?? 100, 500);
  const [list, count] = await db.batch([
    db.prepare(`${SELECT_ACTIVITY} WHERE ${where.join(' AND ')} ORDER BY a.due_at IS NULL, a.due_at ASC LIMIT ${limit} OFFSET ${q.offset ?? 0}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM activities a WHERE ${where.join(' AND ')}`).bind(...binds),
  ]);
  return {
    results: (list.results as unknown as Array<ActivityRow & { links: string | null }>).map(shape),
    total: (count.results[0] as { n: number }).n,
    today_end: end.toISOString(),
    today_start: start.toISOString(),
  };
}
