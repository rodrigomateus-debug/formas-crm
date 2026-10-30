import { Hono } from 'hono';
import type { Ctx, Env, ObjectType } from './env';
import { assertType, HttpError, now, OBJECT_TYPES } from './env';
import { requireRole, canWrite, newToken, sha256 } from './auth';
import { Meta } from './meta';
import {
  archiveRecords, createRecord, getRow, mergeRecords, restoreRecord, rowToRecord, searchRecords, updateRecord,
  type Filter, type RecordRow, type SearchParams,
} from './records';
import { associate, associationsOf, dissociate } from './associations';
import { createActivity, getActivity, listTasks, timeline, unlinkActivity, updateActivity, type ActivityInput } from './activities';
import { upsertCompany, upsertContact } from './upsert';

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const api = new Hono<App>();

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
    db.prepare('SELECT id, email, name, role, team_id, active FROM users ORDER BY active DESC, name'),
    db.prepare('SELECT id, name FROM teams ORDER BY name'),
    db.prepare('SELECT id, name, color FROM tags ORDER BY name'),
  ]);
  return c.json({
    me: c.get('ctx').user,
    properties: await meta.properties(),
    pipelines: await meta.pipelines(),
    users: users.results,
    teams: teams.results,
    tags: tags.results,
  });
});

// ---------- Registros ----------

api.get('/records/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  return c.json(await searchRecords(c.env.DB, c.get('ctx'), type, parseSearch(c.req.query())));
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
  const row = await createRecord(c.env.DB, ctx, type, body.props ?? {});
  for (const id of body.associations ?? []) await associate(c.env.DB, ctx, row.id, id);
  return c.json(rowToRecord(await getRow(c.env.DB, row.id)), 201);
});

api.get('/records/:type/:id', async (c) => {
  const type = assertType(c.req.param('type'));
  const row = await getRow(c.env.DB, Number(c.req.param('id')), type);
  if (row.archived) {
    const merged = await c.env.DB.prepare('SELECT merged_into FROM records WHERE id = ?').bind(row.id).first<{ merged_into: number | null }>();
    if (merged?.merged_into) return c.json({ redirect: merged.merged_into, record: rowToRecord(row) });
  }
  return c.json({ record: rowToRecord(row), associations: await associationsOf(c.env.DB, row.id) });
});

api.patch('/records/:type/:id', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ props: Record<string, unknown> }>();
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
  for (const t of OBJECT_TYPES) out[t] = (await searchRecords(c.env.DB, ctx, t, { q, limit: 6 })).results;
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
  const pipeline = pipelines.find((p) => p.id === q.pipeline) ?? pipelines[0];
  const filters: Filter[] = [{ prop: 'pipeline', op: 'eq', value: pipeline.id }];
  if (q.owner) filters.push({ prop: 'owner_id', op: 'eq', value: q.owner });
  if (q.created_days) filters.push({ prop: 'createdate', op: 'within_last', value: Number(q.created_days) });
  const extra = parseSearch(q);
  const perStage = Math.min(Number(q.per_stage) || 50, 200);
  const columns = [];
  for (const st of pipeline.stages) {
    const stageFilters = [...filters, ...(extra.filters ?? []), { prop: 'dealstage', op: 'eq', value: st.id } as Filter];
    // Las etapas cerradas muestran lo reciente (90 días) para que el tablero no se llene de historia.
    if (st.is_closed && !q.closed_all) stageFilters.push({ prop: 'hs_v2_date_entered_current_stage', op: 'within_last', value: Number(q.closed_days) || 90 });
    const res = await searchRecords(db, ctx, 'deal', { q: extra.q, filters: stageFilters, sort: q.sort || 'hs_lastmodifieddate', dir: 'desc', limit: perStage });
    const sum = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM records WHERE object_type = 'deal' AND archived = 0 AND pipeline_id = ? AND stage_id = ?
       ${q.owner ? 'AND owner_id = ?' : ''}`,
    ).bind(...[pipeline.id, st.id, ...(q.owner ? [Number(q.owner === 'me' ? ctx.user.id : q.owner)] : [])]).first<{ total: number }>();
    columns.push({ stage: st, total: res.total, amount: sum?.total ?? 0, deals: res.results });
  }
  return c.json({ pipeline, columns });
});

// ---------- Inicio / reportes ----------

api.get('/dashboard', async (c) => {
  const db = c.env.DB;
  const ctx = c.get('ctx');
  const owner = c.req.query('owner');
  const ownerId = owner === 'all' ? null : owner ? Number(owner === 'me' ? ctx.user.id : owner) : null;
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(3, 0, 0, 0);
  const m = month.toISOString();
  const ow = ownerId ? 'AND r.owner_id = ?' : '';
  const ob = ownerId ? [ownerId] : [];
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

api.post('/pipelines', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ label: string; team_id?: number; stages: Array<{ label: string; probability: number; is_closed?: boolean; is_won?: boolean }> }>();
  const id = `p${Date.now()}`;
  const stmts = [c.env.DB.prepare("INSERT INTO pipelines (id, object_type, label, display_order, team_id) VALUES (?, 'deal', ?, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM pipelines), ?)")
    .bind(id, b.label, b.team_id ?? null)];
  b.stages.forEach((s, i) => stmts.push(c.env.DB.prepare('INSERT INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`${id}_${i}`, id, s.label, i, s.probability, s.is_closed ? 1 : 0, s.is_won ? 1 : 0)));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

api.put('/pipelines/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const id = c.req.param('id');
  const b = await c.req.json<{ label: string; team_id?: number | null; stages: Array<{ id?: string; label: string; probability: number; is_closed?: boolean; is_won?: boolean; archived?: boolean }> }>();
  const stmts = [c.env.DB.prepare('UPDATE pipelines SET label = ?, team_id = ? WHERE id = ?').bind(b.label, b.team_id ?? null, id)];
  b.stages.forEach((s, i) => {
    if (s.id) {
      stmts.push(c.env.DB.prepare('UPDATE stages SET label = ?, display_order = ?, probability = ?, is_closed = ?, is_won = ?, archived = ? WHERE id = ? AND pipeline_id = ?')
        .bind(s.label, i, s.probability, s.is_closed ? 1 : 0, s.is_won ? 1 : 0, s.archived ? 1 : 0, s.id, id));
    } else {
      stmts.push(c.env.DB.prepare('INSERT INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`${id}_${Date.now()}_${i}`, id, s.label, i, s.probability, s.is_closed ? 1 : 0, s.is_won ? 1 : 0));
    }
  });
  await c.env.DB.batch(stmts);
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
  const b = await c.req.json<{ name?: string; role?: string; team_id?: number | null; active?: boolean }>();
  const cur = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(c.req.param('id'))).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, 'No existe el usuario.');
  await c.env.DB.prepare('UPDATE users SET name = ?, role = ?, team_id = ?, active = ? WHERE id = ?')
    .bind(b.name ?? cur.name, b.role ?? cur.role, b.team_id === undefined ? cur.team_id : b.team_id, b.active === undefined ? cur.active : b.active ? 1 : 0, cur.id).run();
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
