import { Hono } from 'hono';
import type { Ctx, Env, ObjectType } from './env';
import { assertType, HttpError, now, OBJECT_TYPES } from './env';
import { requireRole, canWrite, newToken, sha256 } from './auth';
import { Meta } from './meta';
import {
  archiveRecords, buildWhere, createRecord, getRow, mergeRecords, restoreRecord, rowToRecord, searchRecords, sqlFor, updateRecord,
  type Filter, type RecordRow, type SearchParams,
} from './records';
import { associate, associationsOf, dissociate } from './associations';
import { createActivity, getActivity, listTasks, timeline, unlinkActivity, updateActivity, type ActivityInput } from './activities';
import { autoAssociateCompany, upsertCompany, upsertContact } from './upsert';
import { gmailConfig, syncAll, DEFAULT_GMAIL } from './gmail';
import { assertDealVisible, canSee, companiesFor, requireCompany, visiblePipelineIds } from './pipelines';

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const api = new Hono<App>();

async function hiddenPipelines(db: D1Database, ctx: Ctx) {
  const meta = new Meta(db);
  const visible = await visiblePipelineIds(meta, ctx.user);
  return visible ? (await meta.pipelines()).map((p) => p.id).filter((id) => !visible.includes(id)) : [];
}

const num = (v: string | undefined) => (v == null || v === '' ? undefined : Number(v));

function parseSearch(q: Record<string, string>): SearchParams {
  const json = <T>(s?: string): T | undefined => {
    if (!s) return undefined;
    try { return JSON.parse(s) as T; } catch { throw new HttpError(400, 'Los filtros no son JSON válido.'); }
  };
  return {
    q: q.q,
    filters: json<Filter[]>(q.filters),
    groups: json<Filter[][]>(q.groups),
    associatedWith: num(q.associated_with),
    sort: q.sort,
    dir: q.dir === 'asc' ? 'asc' : 'desc',
    limit: num(q.limit),
    offset: num(q.offset),
    includeArchived: q.archived === '1',
  };
}

// ---------- Sesión y configuración ----------

api.get('/me', (c) => c.json(c.get('ctx').user));

api.get('/meta', async (c) => {
  const db = c.env.DB;
  const meta = new Meta(db);
  const [users, teams, tags] = await db.batch([
    db.prepare('SELECT id, email, name, role, team_id, extra_teams, active FROM users ORDER BY active DESC, name'),
    db.prepare('SELECT id, name FROM teams ORDER BY name'),
    db.prepare('SELECT id, name, color FROM tags ORDER BY name'),
  ]);
  return c.json({
    me: c.get('ctx').user,
    properties: await meta.properties(),
    pipelines: (await meta.pipelines()).filter((p) => canSee(c.get('ctx').user, p)),
    users: users.results,
    teams: teams.results,
    tags: tags.results,
  });
});

// ---------- Registros ----------

api.get('/records/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const res = await searchRecords(c.env.DB, c.get('ctx'), type, parseSearch(c.req.query()));
  // Columna "Empresa asociada" de las listas: la principal de cada registro, en una sola consulta.
  if (c.req.query('with') === 'company' && res.results.length) {
    const { results } = await c.env.DB.prepare(
      `SELECT a.from_id, r.id, r.name FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
       WHERE a.from_id IN (SELECT value FROM json_each(?)) AND a.to_type = 'company' ORDER BY a.is_primary DESC, a.created_at`,
    ).bind(JSON.stringify(res.results.map((r) => r.id))).all<{ from_id: number; id: number; name: string }>();
    const byRec = new Map<number, { id: number; name: string }>();
    for (const r of results) if (!byRec.has(r.from_id)) byRec.set(r.from_id, { id: r.id, name: r.name });
    return c.json({ ...res, results: res.results.map((r) => ({ ...r, company: byRec.get(r.id) ?? null })) });
  }
  return c.json(res);
});

api.post('/records/:type/search', async (c) => {
  const type = assertType(c.req.param('type'));
  return c.json(await searchRecords(c.env.DB, c.get('ctx'), type, await c.req.json<SearchParams>()));
});

api.post('/records/:type', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ props: Record<string, unknown>; associations?: number[] }>();
  const assoc = [...new Set((body.associations ?? []).map(Number))];
  if (type === 'deal') {
    // Como HubSpot: el negocio se asocia también a la empresa principal de sus contactos.
    const companies = await companiesFor(c.env.DB, assoc);
    const meta = new Meta(c.env.DB);
    const pipeline = (await meta.pipelines()).find((p) => p.id === (body.props?.pipeline ?? 'default') || p.label === body.props?.pipeline);
    requireCompany(ctx, pipeline, companies.length);
    for (const co of companies) if (!assoc.includes(co)) assoc.push(co);
  }
  const row = await createRecord(c.env.DB, ctx, type, body.props ?? {});
  for (const id of assoc) await associate(c.env.DB, ctx, row.id, id);
  if (type === 'contact') {
    const hasCompany = await c.env.DB.prepare("SELECT 1 FROM associations WHERE from_id = ? AND to_type = 'company'").bind(row.id).first();
    if (!hasCompany) await autoAssociateCompany(c.env.DB, ctx, row);
  }
  return c.json(rowToRecord(await getRow(c.env.DB, row.id)), 201);
});

api.get('/records/:type/:id', async (c) => {
  const type = assertType(c.req.param('type'));
  const row = await getRow(c.env.DB, Number(c.req.param('id')), type);
  if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), c.get('ctx').user, row.pipeline_id);
  if (row.archived) {
    const merged = await c.env.DB.prepare('SELECT merged_into FROM records WHERE id = ?').bind(row.id).first<{ merged_into: number | null }>();
    if (merged?.merged_into) return c.json({ redirect: merged.merged_into, record: rowToRecord(row) });
  }
  return c.json({ record: rowToRecord(row), associations: await associationsOf(c.env.DB, row.id, await hiddenPipelines(c.env.DB, c.get('ctx'))) });
});

api.patch('/records/:type/:id', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ props: Record<string, unknown> }>();
  if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), ctx.user, (await getRow(c.env.DB, Number(c.req.param('id')), type)).pipeline_id);
  const row = await updateRecord(c.env.DB, ctx, type, Number(c.req.param('id')), body.props ?? {});
  return c.json(rowToRecord(row));
});

api.delete('/records/:type/:id', async (c) => {
  const ctx = c.get('ctx');
  requireRole(ctx, 'admin', 'manager');
  assertType(c.req.param('type'));
  await archiveRecords(c.env.DB, ctx, [Number(c.req.param('id'))]);
  return c.json({ ok: true });
});

api.post('/records/:type/:id/restore', async (c) => {
  const ctx = c.get('ctx');
  requireRole(ctx, 'admin', 'manager');
  await restoreRecord(c.env.DB, ctx, Number(c.req.param('id')));
  return c.json({ ok: true });
});

api.post('/records/:type/batch', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ ids: number[]; props?: Record<string, unknown>; archive?: boolean }>();
  if (body.archive) {
    requireRole(ctx, 'admin', 'manager');
    return c.json({ archived: await archiveRecords(c.env.DB, ctx, body.ids) });
  }
  let updated = 0;
  for (const id of body.ids.slice(0, 500)) {
    await updateRecord(c.env.DB, ctx, type, id, body.props ?? {});
    updated++;
  }
  return c.json({ updated });
});

api.post('/records/:type/:id/merge', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const { other_id } = await c.req.json<{ other_id: number }>();
  return c.json(rowToRecord(await mergeRecords(c.env.DB, ctx, type, Number(c.req.param('id')), Number(other_id))));
});

api.get('/records/:type/:id/history', async (c) => {
  const id = Number(c.req.param('id'));
  const prop = c.req.query('prop');
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, u.name AS user_name FROM changes c LEFT JOIN users u ON u.id = c.user_id WHERE c.record_id = ? ${prop ? 'AND c.prop = ?' : ''}
     ORDER BY c.changed_at DESC LIMIT 300`,
  ).bind(...(prop ? [id, prop] : [id])).all();
  return c.json(results);
});

api.get('/records/:type/:id/timeline', async (c) => {
  const q = c.req.query();
  return c.json(await timeline(c.env.DB, Number(c.req.param('id')), {
    hiddenPipelines: await hiddenPipelines(c.env.DB, c.get('ctx')),
    types: q.types ? q.types.split(',') : undefined,
    rollup: q.rollup !== '0',
    limit: num(q.limit),
    before: q.before,
  }));
});

// Búsqueda global (la lupa de arriba).
api.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  if (q.trim().length < 2) return c.json({ contact: [], company: [], deal: [], order: [] });
  const ctx = c.get('ctx');
  const out: Record<string, unknown> = {};
  const found = await Promise.all(OBJECT_TYPES.map((t) => searchRecords(c.env.DB, ctx, t, { q, limit: 6, noCount: true })));
  OBJECT_TYPES.forEach((t, i) => { out[t] = found[i].results; });
  return c.json(out);
});

// ---------- Asociaciones ----------

api.post('/associations', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const b = await c.req.json<{ from_id: number; to_id: number; label?: string; primary?: boolean }>();
  await associate(c.env.DB, ctx, Number(b.from_id), Number(b.to_id), { label: b.label, primary: b.primary });
  return c.json({ ok: true });
});

api.delete('/associations', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const b = await c.req.json<{ from_id: number; to_id: number }>();
  await dissociate(c.env.DB, ctx, Number(b.from_id), Number(b.to_id));
  return c.json({ ok: true });
});

// ---------- Actividades y tareas ----------

api.post('/activities', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  return c.json(await createActivity(c.env.DB, ctx, await c.req.json<ActivityInput>()), 201);
});

api.get('/activities/:id', async (c) => c.json(await getActivity(c.env.DB, Number(c.req.param('id')))));

api.patch('/activities/:id', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  return c.json(await updateActivity(c.env.DB, ctx, Number(c.req.param('id')), await c.req.json()));
});

api.delete('/activities/:id', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  return c.json(await updateActivity(c.env.DB, ctx, Number(c.req.param('id')), { archived: true }));
});

api.delete('/activities/:id/links/:record', async (c) => {
  canWrite(c.get('ctx'));
  await unlinkActivity(c.env.DB, Number(c.req.param('id')), Number(c.req.param('record')));
  return c.json({ ok: true });
});

api.get('/tasks', async (c) => {
  const q = c.req.query();
  return c.json(await listTasks(c.env.DB, c.get('ctx'), {
    owner: q.owner === 'all' ? 'all' : num(q.owner),
    status: (q.status as 'open' | 'done' | 'all') ?? 'open',
    due: (q.due as 'overdue' | 'today' | 'week' | 'upcoming' | 'all') ?? 'all',
    q: q.q,
    record: num(q.record),
    limit: num(q.limit),
    offset: num(q.offset),
  }));
});

// ---------- Tablero de negocios ----------

api.get('/board', async (c) => {
  const q = c.req.query();
  const db = c.env.DB;
  const ctx = c.get('ctx');
  const meta = new Meta(db);
  const pipelines = await meta.pipelines();
  const allowed = pipelines.filter((p) => canSee(ctx.user, p));
  if (!allowed.length) throw new HttpError(403, 'No tenés acceso a ningún pipeline.');
  const pipeline = pipelines.find((p) => p.id === q.pipeline) ?? allowed[0];
  await assertDealVisible(meta, ctx.user, pipeline.id);
  const extra = parseSearch(q);
  const filters: Filter[] = [{ prop: 'pipeline', op: 'eq', value: pipeline.id }, ...(extra.filters ?? [])];
  if (q.owner) filters.push({ prop: 'owner_id', op: 'eq', value: q.owner });
  if (q.created_days) filters.push({ prop: 'createdate', op: 'within_last', value: Number(q.created_days) });
  const { whereSql, binds } = await buildWhere(meta, ctx, 'deal', { q: extra.q, filters });
  const perStage = Math.min(Number(q.per_stage) || 50, 200);
  // Las etapas cerradas muestran lo reciente (90 días por defecto) para que el tablero no se llene de historia.
  const since = q.closed_all ? '0000' : new Date(Date.now() - (Number(q.closed_days) || 90) * 86_400_000).toISOString();
  const visible = `${whereSql} AND (s.is_closed = 0 OR r.stage_entered_at >= ?)`;
  // Dos consultas en un solo viaje a la base: las tarjetas (las primeras N por etapa) y los totales por etapa.
  const [cards, totals] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.stage_id ORDER BY r.updated_at DESC) AS rn
      FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${visible}) WHERE rn <= ${perStage}`).bind(...binds, since),
    db.prepare(`SELECT r.stage_id, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE ${visible} GROUP BY r.stage_id`).bind(...binds, since),
  ]);
  const rows = cards.results as unknown as RecordRow[];
  const tot = new Map((totals.results as Array<{ stage_id: string; n: number; amount: number }>).map((t) => [t.stage_id, t]));
  const columns = pipeline.stages.map((st) => ({
    stage: st,
    total: tot.get(st.id)?.n ?? 0,
    amount: tot.get(st.id)?.amount ?? 0,
    deals: rows.filter((r) => r.stage_id === st.id).map(rowToRecord),
  }));
  return c.json({ pipeline, columns });
});

// Tablero por propiedad (empresas y contactos, como el tablero por etapa del ciclo de vida de HubSpot):
// una columna por opción de la propiedad (desplegable, sí/no o propietario) y las primeras N tarjetas de cada una.
api.get('/board-prop/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const q = c.req.query();
  const db = c.env.DB;
  const ctx = c.get('ctx');
  const meta = new Meta(db);
  const propName = q.prop || 'lifecyclestage';
  const prop = await meta.property(type, propName);
  if (!prop || !['enum', 'bool', 'owner'].includes(prop.type)) throw new HttpError(400, `No se puede armar un tablero por «${propName}»: tiene que ser un desplegable, sí/no o propietario.`);
  const extra = parseSearch(q);
  const filters: Filter[] = [...(extra.filters ?? [])];
  if (q.owner) filters.push({ prop: 'owner_id', op: q.owner === 'none' ? 'unknown' : 'eq', value: q.owner });
  const { whereSql, binds } = await buildWhere(meta, ctx, type, { q: extra.q, filters });
  const { expr } = await sqlFor(meta, type, propName);
  const perColumn = Math.min(Number(q.per_column) || 40, 200);
  const [cards, totals] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT r.*, CAST(${expr} AS TEXT) AS board_value, ROW_NUMBER() OVER (PARTITION BY ${expr} ORDER BY r.updated_at DESC) AS rn
      FROM records r WHERE ${whereSql}) WHERE rn <= ${perColumn}`).bind(...binds),
    db.prepare(`SELECT CAST(${expr} AS TEXT) AS v, COUNT(*) AS n FROM records r WHERE ${whereSql} GROUP BY v`).bind(...binds),
  ]);
  const options = prop.type === 'owner'
    ? (await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all<{ id: number; name: string }>()).results.map((u) => ({ value: String(u.id), label: u.name }))
    : prop.type === 'bool' && !prop.options.length ? [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }] : prop.options;
  const counts = new Map((totals.results as Array<{ v: string | null; n: number }>).map((t) => [t.v ?? '', t.n]));
  // Valores que no están entre las opciones (viejos o de otro sistema) también tienen su columna.
  const known = new Set(options.map((o) => o.value));
  const others = [...counts.keys()].filter((v) => v && !known.has(v)).map((v) => ({ value: v, label: v }));
  const rows = cards.results as unknown as Array<RecordRow & { board_value: string | null }>;
  const columns = [...options, ...others, { value: '', label: 'Sin dato' }]
    .map((o) => ({ value: o.value, label: o.label, total: counts.get(o.value) ?? 0, records: rows.filter((r) => (r.board_value ?? '') === o.value).map(rowToRecord) }))
    .filter((col) => col.value !== '' || col.total > 0 || prop.type !== 'owner');
  return c.json({ prop: { name: prop.name, label: prop.label, type: prop.type }, columns });
});

// ---------- Inicio / reportes ----------

api.get('/dashboard', async (c) => {
  const db = c.env.DB;
  const ctx = c.get('ctx');
  const owner = c.req.query('owner');
  const ownerId = owner === 'all' ? null : owner ? Number(owner === 'me' ? ctx.user.id : owner) : null;
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(3, 0, 0, 0);
  const m = month.toISOString();
  const hidden = await hiddenPipelines(db, ctx);
  const ow = `${ownerId ? 'AND r.owner_id = ?' : ''} AND (r.pipeline_id IS NULL OR r.pipeline_id NOT IN (SELECT value FROM json_each(?)))`;
  const ob = [...(ownerId ? [ownerId] : []), JSON.stringify(hidden)];
  const [open, won, created, lost, tasks] = await db.batch([
    db.prepare(`SELECT r.pipeline_id, r.stage_id, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE r.object_type = 'deal' AND r.archived = 0 AND s.is_closed = 0 ${ow} GROUP BY r.pipeline_id, r.stage_id`).bind(...ob),
    db.prepare(`SELECT r.owner_id, r.pipeline_id, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE r.object_type = 'deal' AND r.archived = 0 AND s.is_won = 1 AND r.close_date >= ? ${ow} GROUP BY r.owner_id, r.pipeline_id`).bind(m.slice(0, 10), ...ob),
    db.prepare(`SELECT r.pipeline_id, COUNT(*) AS n FROM records r WHERE r.object_type = 'deal' AND r.archived = 0 AND r.created_at >= ? ${ow} GROUP BY r.pipeline_id`).bind(m, ...ob),
    db.prepare(`SELECT json_extract(r.props, '$.motivo_de_cierre_perdido') AS motivo, COUNT(*) AS n FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE r.object_type = 'deal' AND r.archived = 0 AND s.is_closed = 1 AND s.is_won = 0 AND r.close_date >= ? ${ow} GROUP BY motivo ORDER BY n DESC`).bind(m.slice(0, 10), ...ob),
    db.prepare(`SELECT SUM(CASE WHEN due_at < ? THEN 1 ELSE 0 END) AS overdue, SUM(CASE WHEN due_at >= ? AND due_at < ? THEN 1 ELSE 0 END) AS today, COUNT(*) AS open
      FROM activities WHERE type = 'task' AND archived = 0 AND status != 'COMPLETED' AND owner_id = ?`)
      .bind(...todayBounds(), ownerId ?? ctx.user.id),
  ]);
  return c.json({ month: m, open: open.results, won: won.results, created: created.results, lost: lost.results, tasks: tasks.results[0] });
});

function todayBounds(): [string, string, string] {
  const start = new Date(); start.setUTCHours(3, 0, 0, 0);
  if (start.getTime() > Date.now()) start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start.getTime() + 86_400_000);
  return [start.toISOString(), start.toISOString(), end.toISOString()];
}

// ---------- Vistas guardadas ----------

api.get('/views/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const { results } = await c.env.DB.prepare('SELECT * FROM views WHERE object_type = ? AND (shared = 1 OR user_id = ?) ORDER BY display_order, id')
    .bind(type, c.get('ctx').user.id).all<{ config: string }>();
  return c.json(results.map((v) => ({ ...v, config: JSON.parse(v.config) })));
});

api.post('/views/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const b = await c.req.json<{ name: string; shared?: boolean; config: unknown }>();
  const row = await c.env.DB.prepare('INSERT INTO views (object_type, name, user_id, shared, config) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(type, b.name, c.get('ctx').user.id, b.shared ? 1 : 0, JSON.stringify(b.config ?? {})).first();
  return c.json(row, 201);
});

api.patch('/views/:type/:id', async (c) => {
  const b = await c.req.json<{ name?: string; shared?: boolean; config?: unknown }>();
  const ctx = c.get('ctx');
  const cur = await c.env.DB.prepare('SELECT * FROM views WHERE id = ?').bind(Number(c.req.param('id'))).first<{ user_id: number; name: string; shared: number; config: string }>();
  if (!cur) throw new HttpError(404, 'No existe la vista.');
  if (cur.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Solo quien creó la vista la puede cambiar.');
  await c.env.DB.prepare('UPDATE views SET name = ?, shared = ?, config = ? WHERE id = ?')
    .bind(b.name ?? cur.name, b.shared === undefined ? cur.shared : b.shared ? 1 : 0, b.config ? JSON.stringify(b.config) : cur.config, Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

api.delete('/views/:type/:id', async (c) => {
  const ctx = c.get('ctx');
  await c.env.DB.prepare('DELETE FROM views WHERE id = ? AND (user_id = ? OR ? = 1)').bind(Number(c.req.param('id')), ctx.user.id, ctx.user.role === 'admin' ? 1 : 0).run();
  return c.json({ ok: true });
});

// ---------- Importar y exportar ----------

api.post('/import/:type', async (c) => {
  const ctx: Ctx = { ...c.get('ctx'), source: 'import' };
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const { rows, company_by_name } = await c.req.json<{ rows: Array<Record<string, unknown>>; company_by_name?: boolean }>();
  const result = { created: 0, updated: 0, errors: [] as Array<{ row: number; error: string }> };
  for (const [i, raw] of rows.slice(0, 200).entries()) {
    try {
      const { __company, ...props } = raw as Record<string, unknown> & { __company?: string };
      let row: RecordRow;
      if (type === 'contact') {
        const r = await upsertContact(c.env.DB, ctx, props, { autoCompany: !__company });
        row = r.row; r.created ? result.created++ : result.updated++;
        if (__company && company_by_name !== false) {
          const comp = await upsertCompany(c.env.DB, ctx, { name: __company });
          await associate(c.env.DB, ctx, row.id, comp.row.id);
        }
      } else if (type === 'company') {
        const r = await upsertCompany(c.env.DB, ctx, props);
        r.created ? result.created++ : result.updated++;
      } else {
        row = await createRecord(c.env.DB, ctx, type as ObjectType, props, { strict: false });
        result.created++;
        if (__company) {
          const comp = await upsertCompany(c.env.DB, ctx, { name: __company });
          await associate(c.env.DB, ctx, row.id, comp.row.id);
        }
      }
    } catch (e) {
      result.errors.push({ row: i + 1, error: (e as Error).message });
    }
  }
  return c.json(result);
});

api.get('/export/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const params = parseSearch(c.req.query());
  const cols = (c.req.query('columns') ?? '').split(',').filter(Boolean);
  const meta = new Meta(c.env.DB);
  const props = await meta.properties(type);
  const columns = cols.length ? cols : props.filter((p) => !p.read_only).map((p) => p.name);
  const label = (n: string) => props.find((p) => p.name === n)?.label ?? n;
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['ID', ...columns.map(label)].map(esc).join(',')];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await searchRecords(c.env.DB, c.get('ctx'), type, { ...params, limit: 500, offset });
    for (const r of page.results) lines.push([r.id, ...columns.map((k) => r.props[k])].map(esc).join(','));
    if (page.results.length < 500) break;
  }
  return new Response('﻿' + lines.join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}s-${now().slice(0, 10)}.csv"` },
  });
});

// ---------- Administración ----------

api.post('/properties/:type', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const type = assertType(c.req.param('type'));
  const b = await c.req.json<{ name?: string; label: string; type: string; options?: { value: string; label: string }[]; group_name?: string; description?: string; in_create_form?: boolean }>();
  const name = (b.name || b.label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!name) throw new HttpError(400, 'Falta el nombre de la propiedad.');
  await c.env.DB.prepare(`INSERT INTO properties (object_type, name, label, type, options, group_name, description, in_create_form)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(type, name, b.label, b.type, JSON.stringify(b.options ?? []), b.group_name ?? 'Información',
    b.description ?? '', b.in_create_form ? 1 : 0).run();
  return c.json({ name }, 201);
});

api.patch('/properties/:type/:name', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const type = assertType(c.req.param('type'));
  const b = await c.req.json<{ label?: string; options?: unknown[]; group_name?: string; description?: string; in_create_form?: boolean; required?: boolean; archived?: boolean; display_order?: number }>();
  const p = await c.env.DB.prepare('SELECT * FROM properties WHERE object_type = ? AND name = ?').bind(type, c.req.param('name')).first<Record<string, unknown>>();
  if (!p) throw new HttpError(404, 'No existe la propiedad.');
  if (p.system && b.archived) throw new HttpError(400, 'Las propiedades del sistema no se pueden borrar.');
  await c.env.DB.prepare(`UPDATE properties SET label = ?, options = ?, group_name = ?, description = ?, in_create_form = ?, required = ?, archived = ?, display_order = ?
    WHERE object_type = ? AND name = ?`).bind(b.label ?? p.label, b.options ? JSON.stringify(b.options) : p.options, b.group_name ?? p.group_name,
    b.description ?? p.description, b.in_create_form === undefined ? p.in_create_form : b.in_create_form ? 1 : 0,
    b.required === undefined ? p.required : b.required ? 1 : 0, b.archived ? 1 : 0, b.display_order ?? p.display_order, type, c.req.param('name')).run();
  return c.json({ ok: true });
});

interface StageInput { id?: string; label: string; probability: number; is_closed?: boolean | number; is_won?: boolean | number; config?: Record<string, unknown> }

api.post('/pipelines', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ label: string; team_id?: number | null; copy_from?: string; stages?: StageInput[] }>();
  if (!b.label?.trim()) throw new HttpError(400, 'Falta el nombre del pipeline.');
  const meta = new Meta(c.env.DB);
  const source = b.copy_from ? (await meta.pipelines()).find((p) => p.id === b.copy_from) : undefined;
  const stages: StageInput[] = source ? source.stages.map((s) => ({ label: s.label, probability: s.probability, is_closed: s.is_closed, is_won: s.is_won, config: s.config as Record<string, unknown> }))
    : b.stages?.length ? b.stages
      : [{ label: 'Nueva oportunidad', probability: 0.2 }, { label: 'Envío de cotización', probability: 0.4 }, { label: 'Negociación', probability: 0.7 },
        { label: 'Cierre ganado', probability: 1, is_closed: true, is_won: true }, { label: 'Cierre perdido', probability: 0, is_closed: true, config: { required_props: ['motivo_de_cierre_perdido'] } }];
  const id = `p${Date.now()}`;
  const stmts = [c.env.DB.prepare("INSERT INTO pipelines (id, object_type, label, display_order, team_id, config) VALUES (?, 'deal', ?, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM pipelines), ?, ?)")
    .bind(id, b.label.trim(), b.team_id ?? null, JSON.stringify(source?.config ?? {}))];
  stages.forEach((s, i) => stmts.push(c.env.DB.prepare('INSERT INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`${id}_${i}`, id, s.label, i, Number(s.probability), s.is_closed ? 1 : 0, s.is_won ? 1 : 0, JSON.stringify(s.config ?? {}))));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

// Guarda nombre, equipo, reglas y etapas (orden, nombre, probabilidad, tipo, propiedades obligatorias, tarea automática).
// Las etapas que no vienen se borran; si tienen negocios, hay que decir a qué etapa pasan (`remove: [{ id, move_to }]`).
api.put('/pipelines/:id', async (c) => {
  const ctx = c.get('ctx');
  requireRole(ctx, 'admin');
  const id = c.req.param('id');
  const db = c.env.DB;
  const b = await c.req.json<{ label: string; team_id?: number | null; config?: Record<string, unknown>; stages: StageInput[]; remove?: Array<{ id: string; move_to?: string }> }>();
  const current = (await new Meta(db).pipelines()).find((p) => p.id === id);
  if (!current) throw new HttpError(404, 'No existe el pipeline.');
  if (!b.stages?.length) throw new HttpError(400, 'El pipeline necesita al menos una etapa.');
  if (!b.stages.some((s) => !s.is_closed)) throw new HttpError(400, 'El pipeline necesita al menos una etapa abierta.');
  const keep = new Set(b.stages.map((s) => s.id).filter(Boolean));
  const head = db.prepare('UPDATE pipelines SET label = ?, team_id = ?, config = ? WHERE id = ?').bind(b.label, b.team_id ?? null, JSON.stringify(b.config ?? current.config ?? {}), id);
  const removals: D1PreparedStatement[] = [];
  const upserts: D1PreparedStatement[] = [];
  for (const st of current.stages.filter((s) => !keep.has(s.id))) {
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM records WHERE object_type = 'deal' AND stage_id = ? AND archived = 0").bind(st.id).first<{ n: number }>())!.n;
    const move = b.remove?.find((r) => r.id === st.id)?.move_to;
    if (n && !move) throw new HttpError(409, `La etapa «${st.label}» tiene ${n} negocios: elegí a qué etapa pasan antes de borrarla.`);
    if (n && move) {
      const target = b.stages.find((s) => s.id === move);
      if (!target) throw new HttpError(400, 'La etapa de destino tiene que quedar en el pipeline.');
      removals.push(db.prepare("UPDATE records SET stage_id = ?, props = json_set(props, '$.dealstage', ?), updated_at = ? WHERE object_type = 'deal' AND stage_id = ?").bind(move, move, now(), st.id));
      removals.push(db.prepare(`INSERT INTO changes (record_id, prop, old_value, new_value, user_id, source)
        SELECT id, 'dealstage', ?, ?, ?, 'crm' FROM records WHERE object_type = 'deal' AND stage_id = ?`).bind(st.id, move, ctx.user.id, st.id));
    }
    removals.push(db.prepare('UPDATE stages SET archived = 1 WHERE id = ?').bind(st.id));
  }
  b.stages.forEach((s, i) => {
    const cfg = JSON.stringify(s.config ?? {});
    if (s.id && current.stages.some((x) => x.id === s.id)) {
      upserts.push(db.prepare('UPDATE stages SET label = ?, display_order = ?, probability = ?, is_closed = ?, is_won = ?, config = ? WHERE id = ? AND pipeline_id = ?')
        .bind(s.label, i, Number(s.probability), s.is_closed ? 1 : 0, s.is_won ? 1 : 0, cfg, s.id, id));
    } else {
      upserts.push(db.prepare('INSERT INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(`${id}_${Date.now()}_${i}`, id, s.label, i, Number(s.probability), s.is_closed ? 1 : 0, s.is_won ? 1 : 0, cfg));
    }
  });
  // Todo junto (D1 lo aplica en una transacción): etapas, después los negocios que se mueven y las etapas que se borran.
  await db.batch([head, ...upserts, ...removals]);
  return c.json({ ok: true });
});

api.delete('/pipelines/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const id = c.req.param('id');
  const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE object_type = 'deal' AND pipeline_id = ? AND archived = 0").bind(id).first<{ n: number }>())!.n;
  if (n) throw new HttpError(409, `El pipeline tiene ${n} negocios: pasalos a otro pipeline antes de borrarlo.`);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE pipelines SET archived = 1 WHERE id = ?').bind(id),
    c.env.DB.prepare('UPDATE stages SET archived = 1 WHERE pipeline_id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

api.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
  return c.json(results);
});

api.post('/users', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ email: string; name: string; role?: string; team_id?: number | null }>();
  const row = await c.env.DB.prepare('INSERT INTO users (email, name, role, team_id) VALUES (?, ?, ?, ?) RETURNING *')
    .bind(b.email.trim().toLowerCase(), b.name, b.role ?? 'member', b.team_id ?? null).first();
  return c.json(row, 201);
});

api.patch('/users/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ name?: string; role?: string; team_id?: number | null; extra_teams?: number[]; active?: boolean }>();
  const cur = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(c.req.param('id'))).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, 'No existe el usuario.');
  await c.env.DB.prepare('UPDATE users SET name = ?, role = ?, team_id = ?, extra_teams = ?, active = ? WHERE id = ?')
    .bind(b.name ?? cur.name, b.role ?? cur.role, b.team_id === undefined ? cur.team_id : b.team_id,
      b.extra_teams === undefined ? cur.extra_teams : JSON.stringify(b.extra_teams.map(Number)), b.active === undefined ? cur.active : b.active ? 1 : 0, cur.id).run();
  return c.json({ ok: true });
});

api.get('/tokens', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const { results } = await c.env.DB.prepare(
    'SELECT t.id, t.name, t.source, t.created_at, t.last_used_at, t.revoked, u.name AS user_name, u.email AS user_email FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.revoked, t.created_at DESC',
  ).all();
  return c.json(results);
});

api.post('/tokens', async (c) => {
  const ctx = c.get('ctx');
  requireRole(ctx, 'admin');
  const b = await c.req.json<{ name: string; source: string; user_id?: number }>();
  const token = newToken();
  await c.env.DB.prepare('INSERT INTO api_tokens (name, token_hash, user_id, source) VALUES (?, ?, ?, ?)')
    .bind(b.name, await sha256(token), b.user_id ?? ctx.user.id, b.source || 'api').run();
  // El token se muestra una sola vez; en la base queda solo el hash.
  return c.json({ token }, 201);
});

api.delete('/tokens/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  await c.env.DB.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

api.get('/inbound', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const { results } = await c.env.DB.prepare('SELECT * FROM inbound_log ORDER BY id DESC LIMIT 200').all();
  return c.json(results);
});

// ---------- Gmail ----------

api.get('/gmail', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const db = c.env.DB;
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'gmail_state:%' OR key = 'gmail_last_run'").all<{ key: string; value: string }>();
  return c.json({
    config: await gmailConfig(db),
    defaults: DEFAULT_GMAIL,
    has_credentials: !!c.env.GOOGLE_SA_JSON,
    state: Object.fromEntries(results.map((r) => [r.key.replace('gmail_state:', ''), JSON.parse(r.value)])),
  });
});

api.put('/gmail', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const cfg = { ...(await gmailConfig(c.env.DB)), ...(await c.req.json()) };
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gmail', ?)").bind(JSON.stringify(cfg)).run();
  return c.json(cfg);
});

api.post('/gmail/sync', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  return c.json(await syncAll(c.env));
});

// ---------- Avisos a otros sistemas ----------

api.get('/webhooks', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'webhooks'").first<{ value: string }>();
  return c.json(row ? JSON.parse(row.value) : []);
});

api.put('/webhooks', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const hooks = await c.req.json<Array<{ event: string; url: string; secret?: string; name?: string }>>();
  for (const h of hooks) {
    if (!['deal.won', 'deal.stage_changed'].includes(h.event)) throw new HttpError(400, `Evento desconocido: ${h.event}`);
    if (!/^https?:\/\//.test(h.url)) throw new HttpError(400, `URL inválida: ${h.url}`);
  }
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhooks', ?)").bind(JSON.stringify(hooks)).run();
  return c.json(hooks);
});
