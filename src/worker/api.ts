import { procesarSalidaClickup } from './clickup';
import { datosParaFacturar } from './facturar';
import { Hono } from 'hono';
import type { Ctx, Env, ObjectType } from './env';
import { assertType, HttpError, now, OBJECT_TYPES, PROFILES } from './env';
import { requireRole, canWrite, newToken, sha256 } from './auth';
import { Meta } from './meta';
import {
  archiveRecords, buildWhere, createRecord, getRow, mergeRecords, restoreRecord, rowToRecord, searchRecords, sqlFor, tagsFor, tagSql, updateRecord,
  type CrmRecord, type Filter, type RecordRow, type SearchParams, UNIDADES } from './records';
import { associate, associationsOf, dissociate } from './associations';
import { createActivity, getActivity, listTasks, timeline, unlinkActivity, updateActivity, type ActivityInput } from './activities';
import { autoAssociateCompany, upsertCompany, upsertContact } from './upsert';
import { gmailConfig, syncAll, DEFAULT_GMAIL } from './gmail';
import { assertDealVisible, canSee, companiesFor, requireCompany, teamsOf, visiblePipelineIds } from './pipelines';
import { clickupAttachment, clickupRemitos, clickupStatus, syncClickup } from './clickup';
import { fotosDePedidos, orderProducts } from './productos';
import { finnegansState, syncFacturas } from './finnegans';

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
  const me = c.get('ctx').user;
  const [users, teams, tags, mine, keyProps] = await db.batch([
    db.prepare('SELECT id, email, name, role, team_id, extra_teams, active FROM users ORDER BY active DESC, name'),
    db.prepare('SELECT id, name FROM teams ORDER BY name'),
    db.prepare('SELECT id, name, color, object_type, description, rule FROM tags ORDER BY display_order, name'),
    // Pipelines donde el usuario tiene negocios, de más a menos: si no tiene equipo, Negocios arranca en el primero.
    db.prepare(`SELECT pipeline_id FROM records WHERE object_type = 'deal' AND owner_id = ? AND archived = 0
      GROUP BY pipeline_id ORDER BY COUNT(*) DESC`).bind(me.id),
    db.prepare("SELECT value FROM settings WHERE key = 'key_props'"),
  ]);
  const pipelines = (await meta.pipelines()).filter((p) => canSee(me, p));
  return c.json({
    me: { ...me, deal_pipelines: (mine.results as Array<{ pipeline_id: string }>).map((r) => r.pipeline_id).filter((id) => pipelines.some((p) => p.id === id)) },
    properties: await meta.properties(),
    pipelines,
    users: users.results,
    teams: teams.results,
    tags: (tags.results as Array<{ rule: string }>).map((t) => ({ ...t, rule: JSON.parse(t.rule || '{}') })),
    // «Acerca de» de contactos, empresas y pedidos, elegido en la ficha (los negocios lo tienen por pipeline).
    key_props: JSON.parse((keyProps.results[0] as { value?: string } | undefined)?.value ?? '{}'),
  });
});

// ---------- Logo de las empresas y foto de los contactos ----------

// Trae una imagen de afuera una sola vez y la guarda en la caché de Cloudflare (una semana; un día si no hay).
// Si no hay imagen responde 404 y la pantalla muestra las iniciales.
async function cachedImage(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, key: string, url: string) {
  const cache = (caches as unknown as { default: Cache }).default;
  const req = new Request(`https://imagenes.formas-crm/${key}`);
  let res = await cache.match(req);
  if (!res) {
    const r = await fetch(url).catch(() => null);
    const ok = !!r && r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('image/');
    res = new Response(ok ? await r!.arrayBuffer() : null, {
      status: ok ? 200 : 404,
      headers: { 'content-type': ok ? r!.headers.get('content-type')! : 'text/plain', 'cache-control': `public, max-age=${ok ? 604800 : 86400}` },
    });
    c.executionCtx.waitUntil(cache.put(req, res.clone()));
  }
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'image/png', 'cache-control': `private, max-age=${res.status === 200 ? 604800 : 86400}` } });
}

// Logo de la empresa: el favicon de su dominio (como HubSpot), de Google.
api.get('/favicon/:domain', async (c) => {
  const domain = c.req.param('domain').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253) return c.body(null, 404);
  return cachedImage(c, `favicon/${domain}`, `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`);
});

// Foto del contacto: la de Gravatar asociada a su mail (la misma fuente que usa HubSpot). Sale solo el hash del mail.
api.get('/avatar/:email', async (c) => {
  const email = c.req.param('email').trim().toLowerCase();
  if (!/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) || email.length > 254) return c.body(null, 404);
  const hash = await sha256(email);
  return cachedImage(c, `avatar/${hash}`, `https://gravatar.com/avatar/${hash}?d=404&s=96`);
});

// ---------- Registros ----------

api.get('/records/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const found = await searchRecords(c.env.DB, c.get('ctx'), type, parseSearch(c.req.query()));
  // Etiquetas de color de cada registro (si el objeto tiene).
  const tagMap = await tagsFor(c.env.DB, c.get('ctx'), type, found.results.map((r) => r.id));
  const res = { ...found, results: found.results.map((r) => (tagMap.size ? { ...r, tags: tagMap.get(r.id) ?? [] } : r)) };
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
  // Se revisa antes de crear: si un registro para asociar no existe, no queda creado uno suelto.
  for (const id of assoc) {
    if (!Number.isInteger(id) || !(await c.env.DB.prepare('SELECT 1 FROM records WHERE id = ? AND archived = 0').bind(id).first())) {
      throw new HttpError(400, `No existe el registro ${body.associations?.[assoc.indexOf(id)] ?? id} para asociar.`);
    }
  }
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

// Los ids de todo lo que coincide con un filtro, para «Seleccionar los N» (hasta 10.000).
api.get('/records/:type/ids', async (c) => {
  const type = assertType(c.req.param('type'));
  const meta = new Meta(c.env.DB);
  const p = parseSearch(c.req.query());
  const { whereSql, binds } = await buildWhere(meta, c.get('ctx'), type, p);
  const { results } = await c.env.DB.prepare(`SELECT r.id FROM records r WHERE ${whereSql} ORDER BY r.id LIMIT 10001`).bind(...binds).all<{ id: number }>();
  if (results.length > 10000) throw new HttpError(400, 'Son más de 10.000 registros: filtrá un poco más para hacerlo de una vez.');
  return c.json({ ids: results.map((r) => r.id) });
});

api.get('/records/:type/:id', async (c) => {
  const type = assertType(c.req.param('type'));
  const row = await getRow(c.env.DB, Number(c.req.param('id')), type);
  if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), c.get('ctx').user, row.pipeline_id);
  if (row.archived) {
    const merged = await c.env.DB.prepare('SELECT merged_into FROM records WHERE id = ?').bind(row.id).first<{ merged_into: number | null }>();
    if (merged?.merged_into) return c.json({ redirect: merged.merged_into, record: rowToRecord(row) });
  }
  const tags = (await tagsFor(c.env.DB, c.get('ctx'), type, [row.id])).get(row.id) ?? [];
  return c.json({ record: { ...rowToRecord(row), tags }, associations: await associationsOf(c.env.DB, row.id, await hiddenPipelines(c.env.DB, c.get('ctx'))) });
});

api.patch('/records/:type/:id', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ props: Record<string, unknown> }>();
  if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), ctx.user, (await getRow(c.env.DB, Number(c.req.param('id')), type)).pipeline_id);
  const row = await updateRecord(c.env.DB, ctx, type, Number(c.req.param('id')), body.props ?? {});
  // Si el pedido pasó a «Listo para producción», el cambio en ClickUp sale enseguida (sin demorar la respuesta).
  if (type === 'order' && 'hs_pipeline_stage' in (body.props ?? {})) c.executionCtx.waitUntil(procesarSalidaClickup(c.env).catch(() => undefined));
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

// Acciones masivas: editar, asignar, crear tareas o borrar. De a 200 por pedido (la pantalla manda de a tandas);
// cada registro se procesa por separado y se informa cuáles no se pudieron y por qué, sin dejar la tanda por la mitad.
api.post('/records/:type/batch', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const body = await c.req.json<{ ids: number[]; props?: Record<string, unknown>; archive?: boolean; task?: { subject: string; due_at?: string; task_type?: string; priority?: string; body?: string; owner?: 'record' | 'me' } }>();
  const ids = [...new Set((body.ids ?? []).map(Number).filter(Number.isInteger))];
  if (ids.length > 200) throw new HttpError(400, 'Mandá hasta 200 registros por vez.');
  if (body.archive) {
    requireRole(ctx, 'admin', 'manager');
    return c.json({ archived: await archiveRecords(c.env.DB, ctx, ids), failed: [] });
  }
  const failed: Array<{ id: number; name?: string; error: string; missing?: string[] }> = [];
  let updated = 0;
  let tasks = 0;
  for (const id of ids) {
    try {
      if (body.task) {
        const row = await getRow(c.env.DB, id, type);
        if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), ctx.user, row.pipeline_id);
        await createActivity(c.env.DB, ctx, {
          type: 'task', subject: body.task.subject.replace('{nombre}', row.name), body: body.task.body ?? '', due_at: body.task.due_at, task_type: body.task.task_type ?? 'todo',
          priority: (body.task.priority as ActivityInput['priority']) ?? 'none', owner_id: body.task.owner === 'me' ? ctx.user.id : row.owner_id ?? ctx.user.id, links: [id],
        });
        tasks++;
      } else {
        if (type === 'deal') await assertDealVisible(new Meta(c.env.DB), ctx.user, (await getRow(c.env.DB, id, type)).pipeline_id);
        await updateRecord(c.env.DB, ctx, type, id, body.props ?? {});
        updated++;
      }
    } catch (e) {
      const err = e as Error & { missing?: string[] };
      const name = (await c.env.DB.prepare('SELECT name FROM records WHERE id = ?').bind(id).first<{ name: string }>())?.name;
      failed.push({ id, name, error: err.message, ...(err.missing ? { missing: err.missing } : {}) });
    }
  }
  if (type === 'order' && body.props && 'hs_pipeline_stage' in body.props) c.executionCtx.waitUntil(procesarSalidaClickup(c.env).catch(() => undefined));
  return c.json({ updated, tasks, failed });
});

// Clonar un negocio (como «Clonar» de HubSpot), por ejemplo para repetir un pedido: mismos datos y asociaciones,
// en la primera etapa abierta del pipeline, sin fecha ni motivos de cierre.
api.post('/records/:type/:id/clone', async (c) => {
  const ctx = c.get('ctx');
  canWrite(ctx);
  const type = assertType(c.req.param('type'));
  const src = rowToRecord(await getRow(c.env.DB, Number(c.req.param('id')), type));
  const meta = new Meta(c.env.DB);
  if (type === 'deal') await assertDealVisible(meta, ctx.user, String(src.props.pipeline));
  const defs = await meta.properties(type);
  const skip = new Set(['closedate', 'closed_lost_reason', 'closed_won_reason', 'motivo_de_cierre_perdido', 'hs_object_id', 'email', 'domain']);
  const props: Record<string, unknown> = {};
  for (const d of defs) if (!d.read_only && !skip.has(d.name) && src.props[d.name] != null && src.props[d.name] !== '') props[d.name] = src.props[d.name];
  const nameProp = type === 'deal' ? 'dealname' : type === 'order' ? 'hs_order_name' : 'name';
  if (type !== 'contact') props[nameProp] = `${src.name} (copia)`;
  if (type === 'deal') {
    const pipe = (await meta.pipelines()).find((p) => p.id === src.props.pipeline);
    const open = pipe?.stages.find((s) => !s.is_closed);
    if (open) props.dealstage = open.id;
  }
  const row = await createRecord(c.env.DB, ctx, type, props);
  const { results } = await c.env.DB.prepare("SELECT to_id, is_primary FROM associations WHERE from_id = ? AND to_type IN ('contact', 'company')").bind(src.id).all<{ to_id: number; is_primary: number }>();
  for (const a of results) await associate(c.env.DB, ctx, row.id, a.to_id, { primary: !!a.is_primary });
  return c.json(rowToRecord(await getRow(c.env.DB, row.id)), 201);
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
    q: q.q,
    owner: num(q.owner),
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
    unidades: q.unidades ? q.unidades.split(',') : undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  }));
});

// ---------- Tablero de negocios ----------

// Datos extra de las tarjetas del tablero, en tres consultas para todas: el contacto y la empresa asociados
// (los principales primero) y la próxima actividad (tarea abierta o reunión por venir), como en HubSpot.
type CardInfo = { contact?: { id: number; name: string }; company?: { id: number; name: string }; next?: { type: string; subject: string; at: string } };
async function cardInfo(db: D1Database, ids: number[]) {
  const info = new Map<number, CardInfo>(ids.map((id) => [id, {}]));
  if (!ids.length) return info;
  const list = JSON.stringify(ids);
  const [contacts, companies, next] = await db.batch([
    db.prepare(`SELECT a.from_id, r.id, r.name FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
      WHERE a.from_id IN (SELECT value FROM json_each(?)) AND a.to_type = 'contact' ORDER BY a.is_primary DESC, a.created_at`).bind(list),
    db.prepare(`SELECT a.from_id, r.id, r.name FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
      WHERE a.from_id IN (SELECT value FROM json_each(?)) AND a.to_type = 'company' ORDER BY a.is_primary DESC, a.created_at`).bind(list),
    db.prepare(`SELECT l.record_id, a.type, a.subject, COALESCE(a.due_at, a.occurred_at) AS at FROM activity_links l JOIN activities a ON a.id = l.activity_id
      WHERE l.record_id IN (SELECT value FROM json_each(?)) AND a.archived = 0
        AND ((a.type = 'task' AND COALESCE(a.status, '') != 'COMPLETED') OR (a.type = 'meeting' AND a.occurred_at > ?))
      ORDER BY at`).bind(list, now()),
  ]);
  for (const r of contacts.results as Array<{ from_id: number; id: number; name: string }>) { const i = info.get(r.from_id); if (i && !i.contact) i.contact = { id: r.id, name: r.name }; }
  for (const r of companies.results as Array<{ from_id: number; id: number; name: string }>) { const i = info.get(r.from_id); if (i && !i.company) i.company = { id: r.id, name: r.name }; }
  for (const r of next.results as Array<{ record_id: number; type: string; subject: string; at: string }>) { const i = info.get(r.record_id); if (i && !i.next) i.next = { type: r.type, subject: r.subject, at: r.at }; }
  return info;
}

// Orden de las tarjetas de un tablero: cualquier propiedad (como «Ordenar por» de HubSpot); por defecto, la última modificación.
async function boardOrder(meta: Meta, type: ObjectType, q: Record<string, string>) {
  const expr = q.sort ? (await sqlFor(meta, type, q.sort)).expr : 'r.updated_at';
  return `(${expr} IS NULL), ${expr} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, r.id DESC`;
}

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
  if (q.owner) filters.push({ prop: 'owner_id', op: q.owner === 'none' ? 'unknown' : 'eq', value: q.owner });
  if (q.created_days) filters.push({ prop: 'createdate', op: 'within_last', value: Number(q.created_days) });
  // Los filtros de la vista (grupos O) se suman a los del tablero en cada grupo.
  const groups = extra.groups?.length ? extra.groups.map((g) => [...g, ...filters]) : undefined;
  const { whereSql, binds } = await buildWhere(meta, ctx, 'deal', { q: extra.q, filters, groups });
  const perStage = Math.min(Number(q.per_stage) || 50, 200);
  const order = await boardOrder(meta, 'deal', q);
  // Las etapas cerradas muestran lo reciente (90 días por defecto) para que el tablero no se llene de historia.
  const since = q.closed_all ? '0000' : new Date(Date.now() - (Number(q.closed_days) || 90) * 86_400_000).toISOString();
  const visible = `${whereSql} AND (s.is_closed = 0 OR r.stage_entered_at >= ?)`;
  const withInfo = async (rows: RecordRow[]) => {
    const [info, tags] = await Promise.all([cardInfo(db, rows.map((r) => r.id)), tagsFor(db, ctx, 'deal', rows.map((r) => r.id))]);
    return rows.map((r) => ({ ...rowToRecord(r), card: info.get(r.id), tags: tags.get(r.id) ?? [] }));
  };
  // «Cargar más» de una columna: las siguientes tarjetas de esa etapa.
  if (q.stage) {
    const { results } = await db.prepare(`SELECT r.* FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${visible} AND r.stage_id = ?
      ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, since, q.stage, perStage, Math.max(0, Number(q.offset) || 0)).all();
    return c.json({ deals: await withInfo(results as unknown as RecordRow[]) });
  }
  // Dos consultas en un solo viaje a la base: las tarjetas (las primeras N por etapa) y los totales por etapa,
  // con el monto ponderado por la probabilidad de cada etapa.
  const [cards, totals] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.stage_id ORDER BY ${order}) AS rn
      FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${visible}) WHERE rn <= ${perStage}`).bind(...binds, since),
    db.prepare(`SELECT r.stage_id, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount, COALESCE(SUM(r.amount * s.probability), 0) AS weighted
      FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${visible} GROUP BY r.stage_id`).bind(...binds, since),
  ]);
  const rows = await withInfo(cards.results as unknown as RecordRow[]);
  const tot = new Map((totals.results as Array<{ stage_id: string; n: number; amount: number; weighted: number }>).map((t) => [t.stage_id, t]));
  const columns = pipeline.stages.map((st) => ({
    stage: st,
    total: tot.get(st.id)?.n ?? 0,
    amount: tot.get(st.id)?.amount ?? 0,
    weighted: tot.get(st.id)?.weighted ?? 0,
    deals: rows.filter((r) => r.props.dealstage === st.id),
  }));
  return c.json({ pipeline, columns });
});

// Tarjetas de pedidos: hasta 3 fotos de sus productos y cuántos productos tiene (miniaturas del tablero).
async function conFotos(db: D1Database, type: ObjectType, records: CrmRecord[]) {
  if (type !== 'order' || !records.length) return records;
  const f = await fotosDePedidos(db, records.map((r) => r.id));
  return records.map((r) => (f.get(r.id)?.fotos.length ? { ...r, fotos: f.get(r.id)!.fotos, productos: f.get(r.id)!.productos } : r));
}

// Etapas de pedido que ya no están activas: entregado y anulado.
const ORDER_CLOSED = ['1237498998', '3c85a297-e9ce-400b-b42e-9f16853d69d6'];

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
  const groups = extra.groups?.length ? extra.groups.map((g) => [...g, ...filters]) : undefined;
  const { whereSql, binds } = await buildWhere(meta, ctx, type, { q: extra.q, filters, groups });
  const { expr } = await sqlFor(meta, type, propName);
  const perColumn = Math.min(Number(q.per_column) || 40, 200);
  const order = await boardOrder(meta, type, q);
  // «Cargar más» de una columna: las siguientes tarjetas con ese valor ('' es «Sin dato»).
  if (q.value !== undefined) {
    const { results } = await db.prepare(`SELECT r.* FROM records r WHERE ${whereSql} AND COALESCE(CAST(${expr} AS TEXT), '') = ?
      ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, q.value, perColumn, Math.max(0, Number(q.offset) || 0)).all();
    return c.json({ records: await conFotos(db, type, (results as unknown as RecordRow[]).map(rowToRecord)) });
  }
  // Pedidos: cuántos siguen activos (ni entregados ni anulados) y cuánto suman sin IVA, agrupe por lo que agrupe el tablero.
  const activosSql = type === 'order'
    ? db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount FROM records r WHERE ${whereSql} AND COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') NOT IN (?, ?)`).bind(...binds, ...ORDER_CLOSED)
    : db.prepare('SELECT NULL AS n, NULL AS amount');
  const [cards, totals, activos] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT r.*, CAST(${expr} AS TEXT) AS board_value, ROW_NUMBER() OVER (PARTITION BY ${expr} ORDER BY ${order}) AS rn
      FROM records r WHERE ${whereSql}) WHERE rn <= ${perColumn}`).bind(...binds),
    db.prepare(`SELECT CAST(${expr} AS TEXT) AS v, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS amount, SUM(CASE WHEN r.amount IS NULL THEN 1 ELSE 0 END) AS sin_monto
      FROM records r WHERE ${whereSql} GROUP BY v`).bind(...binds),
    activosSql,
  ]);
  const options = prop.type === 'owner'
    ? (await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all<{ id: number; name: string }>()).results.map((u) => ({ value: String(u.id), label: u.name }))
    : prop.type === 'bool' && !prop.options.length ? [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }] : prop.options;
  const tot = new Map((totals.results as Array<{ v: string | null; n: number; amount: number; sin_monto: number }>).map((t) => [t.v ?? '', t]));
  const counts = new Map([...tot].map(([k, t]) => [k, t.n]));
  // Valores que no están entre las opciones (viejos o de otro sistema) también tienen su columna.
  const known = new Set(options.map((o) => o.value));
  const others = [...counts.keys()].filter((v) => v && !known.has(v)).map((v) => ({ value: v, label: v }));
  const rows = cards.results as unknown as Array<RecordRow & { board_value: string | null }>;
  const recs = await conFotos(db, type, rows.map(rowToRecord));
  const valueOf = new Map(rows.map((r) => [r.id, r.board_value ?? '']));
  const columns = [...options, ...others, { value: '', label: 'Sin dato' }]
    // Monto de la columna (pedidos: el total sin IVA) y cuántas tarjetas no lo tienen, para el pie de la columna.
    .map((o) => ({ value: o.value, label: o.label, total: counts.get(o.value) ?? 0, amount: tot.get(o.value)?.amount ?? 0, sin_monto: tot.get(o.value)?.sin_monto ?? 0,
      records: recs.filter((r) => valueOf.get(r.id) === o.value) }))
    .filter((col) => col.value !== '' || col.total > 0 || prop.type !== 'owner');
  return c.json({ prop: { name: prop.name, label: prop.label, type: prop.type }, columns,
    activos: (activos.results[0] as { n: number | null } | undefined)?.n ?? null, activos_monto: (activos.results[0] as { amount: number | null } | undefined)?.amount ?? null });
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
  // Unidades de negocio: los negocios de los pipelines de esos equipos.
  const teams = (c.req.query('unidades') ?? '').split(',').filter((k) => UNIDADES[k]).map((k) => UNIDADES[k].team);
  const ow = `${ownerId ? 'AND r.owner_id = ?' : ''} AND (r.pipeline_id IS NULL OR r.pipeline_id NOT IN (SELECT value FROM json_each(?)))${teams.length
    ? ` AND r.pipeline_id IN (SELECT id FROM pipelines WHERE team_id IN (${teams.map(() => '?').join(', ')}))` : ''}`;
  const ob = [...(ownerId ? [ownerId] : []), JSON.stringify(hidden), ...teams];
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

// Vistas guardadas: propias, compartidas con todos o con un equipo (como «Administrar lo que se comparte» de HubSpot).
api.get('/views/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const user = c.get('ctx').user;
  const { results } = await c.env.DB.prepare(`SELECT * FROM views WHERE object_type = ?
    AND (shared = 1 OR user_id = ? OR team_id IN (SELECT value FROM json_each(?))) ORDER BY display_order, id`)
    .bind(type, user.id, JSON.stringify([...teamsOf(user)])).all<{ config: string }>();
  return c.json(results.map((v) => ({ ...v, config: JSON.parse(v.config) })));
});

api.post('/views/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const b = await c.req.json<{ name: string; shared?: boolean; team_id?: number | null; config: unknown }>();
  if (!b.name?.trim()) throw new HttpError(400, 'Falta el nombre de la vista.');
  const row = await c.env.DB.prepare('INSERT INTO views (object_type, name, user_id, shared, team_id, config) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(type, b.name.trim(), c.get('ctx').user.id, b.shared ? 1 : 0, b.shared ? null : b.team_id ?? null, JSON.stringify(b.config ?? {})).first();
  return c.json(row, 201);
});

api.patch('/views/:type/:id', async (c) => {
  const b = await c.req.json<{ name?: string; shared?: boolean; team_id?: number | null; config?: unknown }>();
  const ctx = c.get('ctx');
  const cur = await c.env.DB.prepare('SELECT * FROM views WHERE id = ?').bind(Number(c.req.param('id'))).first<{ user_id: number; name: string; shared: number; team_id: number | null; config: string }>();
  if (!cur) throw new HttpError(404, 'No existe la vista.');
  if (cur.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Solo quien creó la vista la puede cambiar.');
  const shared = b.shared === undefined ? cur.shared : b.shared ? 1 : 0;
  const team = shared ? null : b.team_id === undefined ? cur.team_id : b.team_id;
  await c.env.DB.prepare('UPDATE views SET name = ?, shared = ?, team_id = ?, config = ? WHERE id = ?')
    .bind(b.name?.trim() || cur.name, shared, team, b.config ? JSON.stringify(b.config) : cur.config, Number(c.req.param('id'))).run();
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

// Exportar a CSV con los filtros de la lista. Sale como se lee en pantalla: nombre del propietario, de la etapa y del
// pipeline, la etiqueta de cada opción y la empresa asociada (no los números internos).
api.get('/export/:type', async (c) => {
  const type = assertType(c.req.param('type'));
  const params = parseSearch(c.req.query());
  const cols = (c.req.query('columns') ?? '').split(',').filter(Boolean);
  const db = c.env.DB;
  const meta = new Meta(db);
  const props = await meta.properties(type);
  const pipelines = await meta.pipelines();
  const users = new Map((await db.prepare('SELECT id, name FROM users').all<{ id: number; name: string }>()).results.map((u) => [String(u.id), u.name]));
  const stages = new Map(pipelines.flatMap((p) => p.stages.map((st) => [st.id, st.label] as const)));
  const pipeNames = new Map(pipelines.map((p) => [p.id, p.label]));
  const columns = cols.length ? cols : props.filter((p) => !p.read_only).map((p) => p.name);
  const label = (n: string) => (n === '__company' ? 'Empresa' : props.find((p) => p.name === n)?.label ?? n);
  const show = (n: string, v: unknown) => {
    if (v == null || v === '') return '';
    if (type === 'deal' && n === 'dealstage') return stages.get(String(v)) ?? v;
    if (type === 'deal' && n === 'pipeline') return pipeNames.get(String(v)) ?? v;
    const d = props.find((p) => p.name === n);
    if (d?.type === 'owner') return users.get(String(v)) ?? v;
    if (d?.type === 'bool') return v === true || v === 'true' ? 'Sí' : 'No';
    if (d?.type === 'enum') return d.options.find((o) => o.value === String(v))?.label ?? v;
    if (d?.type === 'multienum') return String(v).split(';').map((x) => d.options.find((o) => o.value === x)?.label ?? x).join('; ');
    return v;
  };
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['ID', ...columns.map(label)].map(esc).join(',')];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await searchRecords(db, c.get('ctx'), type, { ...params, limit: 500, offset });
    // Empresa principal de cada registro de la página, en una sola consulta.
    const companies = new Map<number, string>();
    if (columns.includes('__company') && page.results.length) {
      const { results } = await db.prepare(`SELECT a.from_id, r.name FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
        WHERE a.from_id IN (SELECT value FROM json_each(?)) AND a.to_type = 'company' ORDER BY a.is_primary DESC`).bind(JSON.stringify(page.results.map((r) => r.id))).all<{ from_id: number; name: string }>();
      for (const r of results) if (!companies.has(r.from_id)) companies.set(r.from_id, r.name);
    }
    for (const r of page.results) lines.push([r.id, ...columns.map((k) => (k === '__company' ? companies.get(r.id) ?? '' : show(k, r.props[k])))].map(esc).join(','));
    if (page.results.length < 500) break;
  }
  return new Response('\ufeff' + lines.join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}s-${now().slice(0, 10)}.csv"` },
  });
});

// ---------- Archivos (factura de Finnegans, remito de ClickUp) ----------

// Datos para facturar de un negocio: lo que falta y lo que conviene saber antes de que llegue a administración.
api.get('/records/deal/:id/facturar', async (c) => c.json(await datosParaFacturar(c.env.DB, Number(c.req.param('id')))));

api.get('/records/:type/:id/files', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('type') === 'order') {
    const rec = await getRow(c.env.DB, id);
    await clickupRemitos(c.env, id, JSON.parse(rec.props)).catch((e) => console.error((e as Error).message));
  }
  const { results } = await c.env.DB.prepare(`SELECT id, kind, name, mime, size, source, meta, created_at, data IS NOT NULL AS has_data
    FROM files WHERE record_id = ? ORDER BY kind, created_at`).bind(id).all<{ meta: string; has_data: number; source: string }>();
  return c.json(results.map((f) => ({ ...f, meta: JSON.parse(f.meta || '{}'), ready: !!f.has_data || f.source === 'clickup' })));
});

// Productos del pedido (de Finnegans): cantidad, precio y la ficha de cada producto con su foto.
api.get('/records/order/:id/products', async (c) => {
  const rec = await getRow(c.env.DB, Number(c.req.param('id')));
  if (rec.object_type !== 'order') throw new HttpError(404, 'No es un pedido.');
  return c.json(await orderProducts(c.env, rec.id, JSON.parse(rec.props), { refresh: c.req.query('refresh') === '1' }));
});

// Abrir un archivo: el PDF guardado, o el remito traído de ClickUp en el momento (los links de ClickUp vencen).
api.get('/files/:id', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(Number(c.req.param('id'))).first<{ name: string; mime: string | null; source: string; source_ref: string; data: ArrayBuffer | null; record_id: number }>();
  if (!f) throw new HttpError(404, 'No existe el archivo.');
  const rec = await getRow(c.env.DB, f.record_id);
  if (rec.object_type === 'deal') await assertDealVisible(new Meta(c.env.DB), c.get('ctx').user, rec.pipeline_id);
  const disposition = `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  // D1 devuelve los BLOB como lista de números: se pasan a bytes.
  if (f.data) return new Response(f.data instanceof ArrayBuffer ? f.data : new Uint8Array(f.data as unknown as number[]), { headers: { 'content-type': f.mime ?? 'application/octet-stream', 'content-disposition': disposition, 'cache-control': 'private, max-age=3600' } });
  if (f.source === 'clickup') {
    const [task, att] = f.source_ref.split(':');
    const a = await clickupAttachment(c.env, task, att);
    if (!a) throw new HttpError(502, 'ClickUp no devolvió el archivo. Abrilo desde el PDV en ClickUp.');
    return new Response(a.body, { headers: { 'content-type': a.type, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}` } });
  }
  throw new HttpError(404, 'El PDF de la factura todavía no se bajó de Finnegans (se baja solo en la próxima hora).');
});

// Estado de las conexiones con ClickUp y Finnegans, y correrlas a mano.
api.get('/integrations/pedidos', async (c) => {
  const pend = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE kind = 'factura' AND data IS NULL").first<{ n: number }>();
  return c.json({
    clickup: { configured: !!c.env.CLICKUP_TOKEN, ...(await clickupStatus(c.env.DB)) },
    finnegans: { configured: !!(c.env.FINNEGANS_CLIENT_ID && c.env.FINNEGANS_CLIENT_SECRET), ...(await finnegansState(c.env.DB)), pdf_pendientes: pend?.n ?? 0 },
  });
});
api.post('/integrations/clickup/sync', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ full?: boolean }>().catch(() => ({} as { full?: boolean }));
  return c.json(await syncClickup(c.env, { full: !!b.full }));
});
api.post('/integrations/finnegans/sync', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  return c.json(await syncFacturas(c.env));
});

// ---------- Administración ----------

api.put('/key-props/:type', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const type = assertType(c.req.param('type'));
  const { props } = await c.req.json<{ props: string[] }>();
  const known = new Set((await new Meta(c.env.DB).properties(type)).map((p) => p.name));
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'key_props'").first<{ value: string }>();
  const all = { ...JSON.parse(row?.value ?? '{}'), [type]: (props ?? []).filter((p) => known.has(p)) };
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('key_props', ?)").bind(JSON.stringify(all)).run();
  return c.json(all);
});

// Etiquetas de color con regla. Se valida la regla armando su consulta (propiedades y operadores que existen).
async function tagBody(c: { req: { json: <T>() => Promise<T> }; env: Env; get: (k: 'ctx') => Ctx }) {
  const b = await c.req.json<{ name: string; color?: string; object_type?: string; description?: string; rule?: { groups?: Filter[][]; pipelines?: string[] } }>();
  if (!b.name?.trim()) throw new HttpError(400, 'Falta el nombre de la etiqueta.');
  const color = /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color! : '#7c8597';
  const type = assertType(b.object_type ?? 'deal');
  const rule = { groups: (b.rule?.groups ?? []).map((g) => g.filter((f) => f.prop && f.prop !== '__tag')).filter((g) => g.length), pipelines: b.rule?.pipelines ?? [] };
  if (!rule.groups.length) throw new HttpError(400, 'La etiqueta necesita al menos un filtro en su regla.');
  await tagSql(new Meta(c.env.DB), c.get('ctx'), { id: 0, name: b.name, color, object_type: type, description: '', display_order: 0, rule }, []);
  return { name: b.name.trim(), color, type, description: b.description ?? '', rule };
}
api.post('/tags', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const t = await tagBody(c);
  const row = await c.env.DB.prepare('INSERT INTO tags (name, color, object_type, description, rule, display_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM tags)) RETURNING id')
    .bind(t.name, t.color, t.type, t.description, JSON.stringify(t.rule)).first<{ id: number }>();
  return c.json(row, 201);
});
api.put('/tags/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const t = await tagBody(c);
  await c.env.DB.prepare('UPDATE tags SET name = ?, color = ?, object_type = ?, description = ?, rule = ? WHERE id = ?')
    .bind(t.name, t.color, t.type, t.description, JSON.stringify(t.rule), Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});
api.delete('/tags/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

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

// Perfil y permisos van juntos en un punto: el perfil admin es el rol admin. Pasar a admin (por cualquiera de los dos) da
// los dos; dejar de serlo vuelve a «edita» (member) y, si no se elige otro, al perfil comercial.
const ROLES = ['admin', 'manager', 'member', 'viewer'];
function profileAndRole(b: { profile?: string; role?: string }, cur: { profile: string; role: string }) {
  if (b.profile !== undefined && !(PROFILES as readonly string[]).includes(b.profile)) throw new HttpError(400, `Perfil desconocido: ${b.profile}.`);
  if (b.role !== undefined && !ROLES.includes(b.role)) throw new HttpError(400, `Permiso desconocido: ${b.role}.`);
  if (b.profile === undefined && b.role === undefined) return cur;
  if (b.profile === 'admin' || (b.role === 'admin' && b.profile === undefined)) return { profile: 'admin', role: 'admin' };
  const profile = b.profile ?? (cur.profile === 'admin' ? 'comercial' : cur.profile);
  const role = b.role && b.role !== 'admin' ? b.role : cur.role === 'admin' || b.role === 'admin' ? 'member' : cur.role;
  return { profile, role };
}

api.post('/users', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ email: string; name: string; role?: string; profile?: string; team_id?: number | null }>();
  const { profile, role } = profileAndRole(b, { profile: 'comercial', role: 'member' });
  const row = await c.env.DB.prepare('INSERT INTO users (email, name, role, profile, team_id) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(b.email.trim().toLowerCase(), b.name, role, profile, b.team_id ?? null).first();
  return c.json(row, 201);
});

api.patch('/users/:id', async (c) => {
  requireRole(c.get('ctx'), 'admin');
  const b = await c.req.json<{ name?: string; role?: string; profile?: string; team_id?: number | null; extra_teams?: number[]; active?: boolean }>();
  const cur = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(c.req.param('id'))).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, 'No existe el usuario.');
  const { profile, role } = profileAndRole(b, { profile: String(cur.profile), role: String(cur.role) });
  if (cur.role === 'admin' && (role !== 'admin' || b.active === false)) {
    const otros = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(cur.id).first<{ n: number }>();
    if (!otros?.n) throw new HttpError(400, 'Es el único administrador activo: primero hacé administrador a otra persona.');
  }
  await c.env.DB.prepare('UPDATE users SET name = ?, role = ?, profile = ?, team_id = ?, extra_teams = ?, active = ? WHERE id = ?')
    .bind(b.name ?? cur.name, role, profile, b.team_id === undefined ? cur.team_id : b.team_id,
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
