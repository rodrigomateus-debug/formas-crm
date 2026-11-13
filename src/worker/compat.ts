import { Hono } from 'hono';
import type { Ctx, Env, ObjectType } from './env';
import { HttpError } from './env';
import { restringido } from './alcance';
import { Meta } from './meta';
import { createRecord, getRow, updateRecord, searchRecords, rowToRecord, type Filter, type RecordRow } from './records';
import { associate } from './associations';
import { createActivity, type ActivityRow } from './activities';

// Subconjunto de la API de HubSpot (crm/v3, crm/v4, owners, pipelines) sobre el CRM propio.
// Sirve para que los tableros (formas-tablero/claude/hs_api.py, formas-shop-tablero/shop.py y worker.js)
// sigan andando cambiando solo la URL base (https://api.hubapi.com → https://<crm>/hubspot) y el token.
// Los ids son los mismos de HubSpot para todo lo migrado.

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const compat = new Hono<App>();

// La API compatible es para los tableros y las integraciones (tokens de administrador). Un token de una usuaria del perfil
// Ventas no entra: desde acá se lee por id sin el recorte de lo que ve cada vendedora (alcance.ts).
// Solo en sus rutas (/crm/…): el compat también está montado en la raíz y no tiene que tocar el resto.
compat.use('/crm/*', async (c, next) => {
  const ctx = c.get('ctx');
  if (ctx && restringido(ctx.user)) throw new HttpError(403, 'La API compatible con HubSpot es para los tableros y las integraciones: no está en los perfiles Ventas ni Producción.');
  await next();
});

const RECORD_TYPES: Record<string, ObjectType> = {
  contacts: 'contact', contact: 'contact', '0-1': 'contact',
  companies: 'company', company: 'company', '0-2': 'company',
  deals: 'deal', deal: 'deal', '0-3': 'deal',
  orders: 'order', order: 'order', '0-123': 'order',
};
const ACTIVITY_TYPES: Record<string, ActivityRow['type']> = {
  tasks: 'task', task: 'task', notes: 'note', note: 'note', emails: 'email', email: 'email',
  calls: 'call', call: 'call', meetings: 'meeting', meeting: 'meeting', communications: 'whatsapp',
};
const PLURAL: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals', order: 'orders', task: 'tasks', note: 'notes', email: 'emails', call: 'calls', meeting: 'meetings', whatsapp: 'communications' };

// Ids de tipo de asociación de HubSpot que leen los tableros (deal→company 5 es "principal").
const ASSOC_TYPE_ID: Record<string, number> = {
  'contact>company': 279, 'company>contact': 280, 'deal>contact': 3, 'contact>deal': 4, 'deal>company': 341, 'company>deal': 342,
  'order>contact': 507, 'contact>order': 508, 'task>company': 192, 'task>contact': 204, 'task>deal': 216,
  'email>company': 186, 'email>contact': 198, 'email>deal': 210, 'note>company': 190, 'note>contact': 202, 'note>deal': 214,
  'call>company': 182, 'call>contact': 194, 'call>deal': 206, 'meeting>company': 188, 'meeting>contact': 200, 'meeting>deal': 212,
};

const ALIAS: Record<string, string> = { hubspot_owner_id: 'owner_id', amount_in_home_currency: 'amount', hs_lastactivitydate: 'notes_last_updated' };

// Los tableros conocen a cada vendedora por su owner id de HubSpot (PERSONAS). Si el usuario ya existía en el CRM
// con otro id, se traduce en las dos direcciones con users.hs_owner_id.
interface OwnerMap { toHs: (id: unknown) => string | null; fromHs: (v: unknown) => unknown }
async function ownerMap(db: D1Database): Promise<OwnerMap> {
  const { results } = await db.prepare('SELECT id, hs_owner_id FROM users WHERE hs_owner_id IS NOT NULL').all<{ id: number; hs_owner_id: string }>();
  const toHs = new Map(results.map((u) => [String(u.id), u.hs_owner_id]));
  const fromHs = new Map(results.map((u) => [u.hs_owner_id, u.id]));
  return {
    toHs: (id) => (id == null || id === '' ? null : toHs.get(String(id)) ?? String(id)),
    fromHs: (v) => (v == null || v === '' ? v : fromHs.get(String(v)) ?? Number(v)),
  };
}

async function stageSets(db: D1Database) {
  const pipes = await new Meta(db).pipelines();
  const all = pipes.flatMap((p) => p.stages);
  return { closed: all.filter((s) => s.is_closed).map((s) => s.id), won: all.filter((s) => s.is_won).map((s) => s.id), all };
}

async function stageHistory(db: D1Database, ids: number[]) {
  const out = new Map<number, Record<string, string>>();
  if (!ids.length) return out;
  const { results } = await db.prepare(
    `SELECT record_id, new_value, MIN(changed_at) AS at FROM changes WHERE prop = 'dealstage' AND record_id IN (SELECT value FROM json_each(?)) GROUP BY record_id, new_value`,
  ).bind(JSON.stringify(ids)).all<{ record_id: number; new_value: string; at: string }>();
  for (const r of results) {
    const m = out.get(r.record_id) ?? {};
    m[`hs_v2_date_entered_${r.new_value}`] = r.at;
    m[`hs_date_entered_${r.new_value}`] = r.at;
    out.set(r.record_id, m);
  }
  return out;
}

async function recordOut(db: D1Database, rows: RecordRow[], wanted: string[] | null) {
  const sets = await stageSets(db);
  const om = await ownerMap(db);
  const hist = rows[0]?.object_type === 'deal' ? await stageHistory(db, rows.map((r) => r.id)) : new Map();
  const extra = new Map<number, Record<string, unknown>>();
  if (rows.length && rows[0].object_type !== 'deal') {
    const { results } = await db.prepare(
      `SELECT a.from_id AS id, SUM(a.to_type = 'deal') AS deals, SUM(a.to_type = 'contact') AS contacts,
         SUM(a.to_type = 'deal' AND d.stage_id IN (SELECT value FROM json_each(?2))) AS closed_deals
       FROM associations a JOIN records d ON d.id = a.to_id AND d.archived = 0 WHERE a.from_id IN (SELECT value FROM json_each(?1)) GROUP BY a.from_id`,
    ).bind(JSON.stringify(rows.map((r) => r.id)), JSON.stringify(sets.closed)).all<{ id: number; deals: number; contacts: number; closed_deals: number }>();
    for (const r of results) extra.set(r.id, { num_associated_deals: r.deals, num_associated_contacts: r.contacts, hs_num_open_deals: r.deals - r.closed_deals });
    const last = await db.prepare(
      `SELECT l.record_id AS id, MAX(CASE WHEN a.type = 'email' AND a.direction = 'out' THEN a.occurred_at END) AS em,
         MAX(CASE WHEN a.type = 'call' THEN a.occurred_at END) AS ca, MAX(CASE WHEN a.type = 'meeting' THEN a.occurred_at END) AS me,
         SUM(a.type IN ('email', 'call', 'meeting', 'whatsapp')) AS contacted
       FROM activity_links l JOIN activities a ON a.id = l.activity_id AND a.archived = 0 WHERE l.record_id IN (SELECT value FROM json_each(?)) GROUP BY l.record_id`,
    ).bind(JSON.stringify(rows.map((r) => r.id))).all<{ id: number; em: string; ca: string; me: string; contacted: number }>();
    for (const r of last.results) Object.assign(extra.get(r.id) ?? extra.set(r.id, {}).get(r.id)!, {
      hs_last_logged_outgoing_email_date: r.em, hs_last_logged_call_date: r.ca, hs_last_booked_meeting_date: r.me, num_contacted_notes: r.contacted,
    });
  }
  const owners = await db.prepare(
    `SELECT record_id, MAX(changed_at) AS at FROM changes WHERE prop = 'owner_id' AND record_id IN (SELECT value FROM json_each(?)) GROUP BY record_id`,
  ).bind(JSON.stringify(rows.map((r) => r.id))).all<{ record_id: number; at: string }>();
  const ownerAt = new Map(owners.results.map((o) => [o.record_id, o.at]));
  return rows.map((row) => {
    const r = rowToRecord(row);
    const p: Record<string, unknown> = { ...r.props, ...(extra.get(row.id) ?? {}), ...(hist.get(row.id) ?? {}) };
    p.hubspot_owner_id = om.toHs(p.owner_id);
    p.hubspot_owner_assigneddate = ownerAt.get(row.id) ?? null;
    p.hs_lastactivitydate = row.last_activity_at;
    if (row.object_type === 'contact') p.hs_whatsapp_phone_number = p.hs_whatsapp_phone_number ?? p.mobilephone ?? null;
    if (row.object_type === 'deal') {
      p.amount_in_home_currency = row.amount;
      p.hs_is_closed = String(sets.closed.includes(row.stage_id ?? ''));
      p.hs_is_closed_won = String(sets.won.includes(row.stage_id ?? ''));
      p.hs_is_closed_lost = String(sets.closed.includes(row.stage_id ?? '') && !sets.won.includes(row.stage_id ?? ''));
      p.hs_deal_stage_probability = sets.all.find((s) => s.id === row.stage_id)?.probability ?? null;
      if (row.close_date && p.hs_is_closed === 'true') p.days_to_close = Math.max(0, Math.round((Date.parse(row.close_date) - Date.parse(row.created_at)) / 86_400_000));
    }
    const props = wanted ? Object.fromEntries(wanted.map((k) => [k, p[k] == null ? null : String(p[k])])) : Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? null : String(v)]));
    props.hs_object_id = String(row.id);
    return { id: String(row.id), properties: props, createdAt: row.created_at, updatedAt: row.updated_at, archived: !!row.archived };
  });
}

const DATEISH = /date|_at$|timestamp|closedate|createdate|hs_v2_date/;

function toVal(prop: string, v: unknown) {
  if (v == null) return v;
  const s = String(v);
  if (DATEISH.test(prop) && /^\d{12,}$/.test(s)) return new Date(Number(s)).toISOString();
  return s;
}

async function translateFilters(db: D1Database, groups: Array<{ filters?: Array<Record<string, any>> }>): Promise<Filter[][]> {
  const sets = await stageSets(db);
  const om = await ownerMap(db);
  return groups.map((g) => (g.filters ?? []).map((f) => {
    const prop = ALIAS[f.propertyName] ?? f.propertyName;
    const op = String(f.operator).toUpperCase();
    if (prop === 'hs_is_closed' || prop === 'hs_is_closed_won' || prop === 'hs_is_closed_lost') {
      const ids = prop === 'hs_is_closed' ? sets.closed : prop === 'hs_is_closed_won' ? sets.won : sets.closed.filter((s) => !sets.won.includes(s));
      const yes = String(f.value) === 'true' ? op === 'EQ' : op === 'NEQ';
      return { prop: 'dealstage', op: yes ? 'in' : 'not_in', values: ids } as Filter;
    }
    const conv = (v: unknown) => (prop === 'owner_id' ? om.fromHs(v) : toVal(prop, v));
    const value = conv(f.value);
    switch (op) {
      case 'EQ': return { prop, op: 'eq', value };
      case 'NEQ': return { prop, op: 'neq', value };
      case 'LT': return { prop, op: 'lt', value };
      case 'LTE': return { prop, op: 'lte', value };
      case 'GT': return { prop, op: 'gt', value };
      case 'GTE': return { prop, op: 'gte', value };
      case 'BETWEEN': return { prop, op: 'between', value, high: toVal(prop, f.highValue) };
      case 'IN': return { prop, op: 'in', values: (f.values ?? []).map(conv) };
      case 'NOT_IN': return { prop, op: 'not_in', values: (f.values ?? []).map(conv) };
      case 'HAS_PROPERTY': return { prop, op: 'known' };
      case 'NOT_HAS_PROPERTY': return { prop, op: 'unknown' };
      case 'CONTAINS_TOKEN': return { prop, op: 'contains', value: String(f.value).replace(/\*/g, '') };
      case 'NOT_CONTAINS_TOKEN': return { prop, op: 'not_contains', value: String(f.value).replace(/\*/g, '') };
      default: throw new HttpError(400, `Operador no soportado: ${f.operator}`);
    }
  }));
}

// ---------- Actividades (tasks, notes, emails, calls, meetings) ----------

const ACT_COL: Record<string, string> = {
  hs_timestamp: "COALESCE(CASE WHEN a.type = 'task' THEN a.due_at END, a.occurred_at)", hubspot_owner_id: 'a.owner_id', hs_object_id: 'a.id',
  hs_createdate: 'a.created_at', hs_lastmodifieddate: 'a.updated_at', hs_task_status: 'a.status', hs_task_subject: 'a.subject', hs_task_body: 'a.body',
  hs_task_priority: 'UPPER(a.priority)', hs_task_type: 'UPPER(a.task_type)', hs_email_subject: 'a.subject', hs_email_text: 'a.body', hs_note_body: 'a.body',
  hs_call_title: 'a.subject', hs_call_body: 'a.body', hs_meeting_title: 'a.subject', hs_meeting_body: 'a.body', hs_meeting_start_time: 'a.occurred_at',
  hs_email_direction: "CASE a.direction WHEN 'in' THEN 'INCOMING_EMAIL' ELSE 'EMAIL' END",
};

function activityOut(a: ActivityRow, wanted: string[] | null, om: OwnerMap) {
  const meta = JSON.parse(a.meta || '{}') as Record<string, unknown>;
  const ts = a.type === 'task' ? a.due_at : a.occurred_at;
  const p: Record<string, unknown> = {
    hs_object_id: a.id, hs_timestamp: ts, hubspot_owner_id: om.toHs(a.owner_id), hs_createdate: a.created_at, hs_lastmodifieddate: a.updated_at,
  };
  if (a.type === 'task') Object.assign(p, { hs_task_subject: a.subject, hs_task_body: a.body, hs_task_status: a.status, hs_task_priority: (a.priority ?? 'none').toUpperCase(), hs_task_type: (a.task_type ?? 'todo').toUpperCase() });
  if (a.type === 'note') Object.assign(p, { hs_note_body: a.body });
  if (a.type === 'email') Object.assign(p, {
    hs_email_subject: a.subject, hs_email_text: a.body, hs_email_direction: a.direction === 'in' ? 'INCOMING_EMAIL' : 'EMAIL', hs_email_status: 'SENT',
    hs_email_from_email: meta.from, hs_email_to_email: meta.to, hs_email_cc_email: meta.cc, hs_email_open_count: meta.opens ?? 0,
    hs_email_click_count: meta.clicks ?? 0, hs_email_reply_count: meta.replies ?? 0,
  });
  if (a.type === 'call') Object.assign(p, { hs_call_title: a.subject, hs_call_body: a.body, hs_call_disposition: a.outcome, hs_call_duration: meta.duration_ms, hs_call_direction: a.direction === 'in' ? 'INBOUND' : 'OUTBOUND' });
  if (a.type === 'meeting') Object.assign(p, { hs_meeting_title: a.subject, hs_meeting_body: a.body, hs_meeting_start_time: a.occurred_at, hs_meeting_end_time: meta.end_at, hs_meeting_outcome: a.outcome });
  const props = wanted ? Object.fromEntries(wanted.map((k) => [k, p[k] == null ? null : String(p[k])])) : Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? null : String(v)]));
  props.hs_object_id = String(a.id);
  return { id: String(a.id), properties: props, createdAt: a.created_at, updatedAt: a.updated_at, archived: !!a.archived };
}

async function searchActivities(db: D1Database, type: ActivityRow['type'], body: Record<string, any>) {
  const om = await ownerMap(db);
  const groups = (body.filterGroups ?? []) as Array<{ filters?: Array<Record<string, any>> }>;
  const binds: unknown[] = [type];
  const ors: string[] = [];
  for (const g of groups) {
    const ands: string[] = [];
    for (const f of g.filters ?? []) {
      const col = ACT_COL[f.propertyName];
      if (!col) throw new HttpError(400, `Propiedad no soportada en ${PLURAL[type]}: ${f.propertyName}`);
      const v = toVal(f.propertyName === 'hs_timestamp' ? 'hs_timestamp' : f.propertyName, f.value);
      const op = String(f.operator).toUpperCase();
      const simple: Record<string, string> = { EQ: '=', NEQ: '!=', LT: '<', LTE: '<=', GT: '>', GTE: '>=' };
      if (simple[op]) { ands.push(`${col} ${simple[op]} ?`); binds.push(f.propertyName === 'hubspot_owner_id' ? om.fromHs(v) : v); }
      else if (op === 'BETWEEN') { ands.push(`${col} BETWEEN ? AND ?`); binds.push(v, toVal('hs_timestamp', f.highValue)); }
      else if (op === 'IN' || op === 'NOT_IN') {
        const vs = (f.values ?? []).map((x: unknown) => (f.propertyName === 'hubspot_owner_id' ? om.fromHs(x) : x));
        ands.push(`${col} ${op === 'IN' ? '' : 'NOT '}IN (${vs.map(() => '?').join(', ') || 'NULL'})`); binds.push(...vs);
      } else if (op === 'CONTAINS_TOKEN') { ands.push(`${col} LIKE ?`); binds.push(`%${String(f.value).replace(/\*/g, '')}%`); }
      else if (op === 'HAS_PROPERTY') ands.push(`${col} IS NOT NULL AND ${col} != ''`);
      else if (op === 'NOT_HAS_PROPERTY') ands.push(`(${col} IS NULL OR ${col} = '')`);
      else throw new HttpError(400, `Operador no soportado: ${f.operator}`);
    }
    if (ands.length) ors.push(`(${ands.join(' AND ')})`);
  }
  const where = `a.type = ? AND a.archived = 0${ors.length ? ` AND (${ors.join(' OR ')})` : ''}`;
  const sort = (body.sorts?.[0] ?? {}) as { propertyName?: string; direction?: string };
  const sortCol = ACT_COL[sort.propertyName ?? 'hs_timestamp'] ?? ACT_COL.hs_timestamp;
  const limit = Math.min(Number(body.limit) || 10, 200);
  const offset = Number(body.after) || 0;
  const [list, count] = await db.batch([
    db.prepare(`SELECT a.* FROM activities a WHERE ${where} ORDER BY ${sortCol} ${sort.direction === 'ASCENDING' ? 'ASC' : 'DESC'}, a.id LIMIT ${limit} OFFSET ${offset}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM activities a WHERE ${where}`).bind(...binds),
  ]);
  const total = (count.results[0] as { n: number }).n;
  return {
    total,
    results: (list.results as unknown as ActivityRow[]).map((a) => activityOut(a, body.properties ?? null, om)),
    ...(offset + limit < total ? { paging: { next: { after: String(offset + limit) } } } : {}),
  };
}

// ---------- Rutas ----------

compat.post('/oauth/v2/private-apps/get/access-token-info', (c) => c.json({
  userId: c.get('ctx').user.id, hubId: 47666798, appId: 0,
  scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.companies.read', 'crm.objects.companies.write',
    'crm.objects.deals.read', 'crm.objects.deals.write', 'crm.objects.orders.read', 'crm.objects.owners.read', 'crm.schemas.deals.read'],
}));

compat.get('/crm/v3/owners', async (c) => {
  const archived = c.req.query('archived') === 'true';
  const { results } = await c.env.DB.prepare('SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = ? ORDER BY u.id')
    .bind(archived ? 0 : 1).all<{ id: number; email: string; name: string; team_id: number | null; team_name: string | null; created_at: string; hs_owner_id: string | null }>();
  return c.json({
    results: results.map((u) => {
      const [firstName, ...rest] = u.name.split(' ');
      return {
        id: u.hs_owner_id ?? String(u.id), email: u.email, firstName, lastName: rest.join(' '), userId: u.id, createdAt: u.created_at, updatedAt: u.created_at, archived,
        teams: u.team_id ? [{ id: String(u.team_id), name: u.team_name, primary: true }] : [],
      };
    }),
  });
});

compat.get('/crm/v3/pipelines/:objectType', async (c) => {
  const pipes = await new Meta(c.env.DB).pipelines();
  return c.json({
    results: pipes.map((p) => ({
      id: p.id, label: p.label, displayOrder: p.display_order, archived: false,
      stages: p.stages.map((s) => ({
        id: s.id, label: s.label, displayOrder: s.display_order, archived: false,
        metadata: { probability: String(s.probability), isClosed: String(!!s.is_closed) },
      })),
    })),
  });
});

compat.get('/crm/v3/properties/:objectType', async (c) => {
  const type = RECORD_TYPES[c.req.param('objectType')];
  if (!type) throw new HttpError(404, 'Tipo no soportado.');
  const props = await new Meta(c.env.DB).properties(type);
  return c.json({
    results: props.map((p) => ({
      name: p.name === 'owner_id' ? 'hubspot_owner_id' : p.name, label: p.label, groupName: p.group_name, description: p.description,
      type: { enum: 'enumeration', multienum: 'enumeration', bool: 'enumeration', number: 'number', currency: 'number', date: 'date', datetime: 'datetime' }[p.type] ?? 'string',
      fieldType: p.type, options: p.options.map((o, i) => ({ ...o, displayOrder: i, hidden: false })),
    })),
  });
});

compat.post('/crm/v3/objects/:objectType/search', async (c) => {
  const t = c.req.param('objectType');
  const body = await c.req.json<Record<string, any>>();
  if (ACTIVITY_TYPES[t]) return c.json(await searchActivities(c.env.DB, ACTIVITY_TYPES[t], body));
  const type = RECORD_TYPES[t];
  if (!type) throw new HttpError(404, `Tipo no soportado: ${t}`);
  const groups = await translateFilters(c.env.DB, body.filterGroups ?? []);
  const sort = (body.sorts?.[0] ?? {}) as { propertyName?: string; direction?: string } | string;
  const sortProp = typeof sort === 'string' ? sort.replace(/^-/, '') : sort.propertyName;
  const dir = typeof sort === 'string' ? (sort.startsWith('-') ? 'desc' : 'asc') : sort.direction === 'DESCENDING' ? 'desc' : 'asc';
  const limit = Math.min(Number(body.limit) || 10, 200);
  const offset = Number(body.after) || 0;
  const res = await searchRecords(c.env.DB, c.get('ctx'), type, {
    q: body.query, groups, sort: sortProp ? (ALIAS[sortProp] ?? sortProp) : 'hs_object_id', dir: sortProp ? dir : 'asc', limit, offset,
  });
  const rows = await Promise.all(res.results.map((r) => getRow(c.env.DB, r.id)));
  return c.json({
    total: res.total,
    results: await recordOut(c.env.DB, rows, body.properties?.length ? body.properties : null),
    ...(offset + limit < res.total ? { paging: { next: { after: String(offset + limit) } } } : {}),
  });
});

compat.post('/crm/v3/objects/:objectType/batch/read', async (c) => {
  const t = c.req.param('objectType');
  const body = await c.req.json<{ inputs: Array<{ id: string }>; properties?: string[]; propertiesWithHistory?: string[] }>();
  const ids = body.inputs.map((i) => Number(i.id)).filter(Boolean);
  if (ACTIVITY_TYPES[t]) {
    const { results } = await c.env.DB.prepare('SELECT * FROM activities WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<ActivityRow>();
    const om = await ownerMap(c.env.DB);
    return c.json({ status: 'COMPLETE', results: results.map((a) => activityOut(a, body.properties ?? null, om)) });
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM records WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<RecordRow>();
  const out = await recordOut(c.env.DB, results, body.properties?.length ? body.properties : null);
  if (body.propertiesWithHistory?.length) {
    const hist = await c.env.DB.prepare(
      `SELECT record_id, prop, new_value, changed_at, source, user_id FROM changes WHERE record_id IN (SELECT value FROM json_each(?)) AND prop IN (SELECT value FROM json_each(?)) ORDER BY changed_at DESC`,
    ).bind(JSON.stringify(ids), JSON.stringify(body.propertiesWithHistory.map((p) => ALIAS[p] ?? p))).all<{ record_id: number; prop: string; new_value: string; changed_at: string; source: string; user_id: number }>();
    for (const o of out as Array<Record<string, any>>) {
      o.propertiesWithHistory = {};
      for (const p of body.propertiesWithHistory) {
        o.propertiesWithHistory[p] = hist.results.filter((h) => h.record_id === Number(o.id) && h.prop === (ALIAS[p] ?? p))
          .map((h) => ({ value: h.new_value, timestamp: h.changed_at, sourceType: h.source.toUpperCase(), updatedByUserId: h.user_id }));
      }
    }
  }
  return c.json({ status: 'COMPLETE', results: out });
});

compat.get('/crm/v3/objects/:objectType/:id', async (c) => {
  const type = RECORD_TYPES[c.req.param('objectType')];
  if (!type) throw new HttpError(404, 'Tipo no soportado.');
  const row = await getRow(c.env.DB, Number(c.req.param('id')), type);
  const props = c.req.query('properties')?.split(',').filter(Boolean) ?? null;
  const [out] = await recordOut(c.env.DB, [row], props);
  const assocTypes = c.req.query('associations')?.split(',').filter(Boolean) ?? [];
  if (assocTypes.length) {
    const associations: Record<string, unknown> = {};
    for (const at of assocTypes) {
      const toType = RECORD_TYPES[at];
      if (!toType) continue;
      const { results } = await c.env.DB.prepare('SELECT to_id, is_primary FROM associations WHERE from_id = ? AND to_type = ?').bind(row.id, toType).all<{ to_id: number }>();
      associations[PLURAL[toType]] = { results: results.map((r) => ({ id: String(r.to_id), type: `${type}_to_${toType}` })) };
    }
    return c.json({ ...out, associations });
  }
  return c.json(out);
});

compat.post('/crm/v3/objects/:objectType', async (c) => {
  const t = c.req.param('objectType');
  const ctx = c.get('ctx');
  const body = await c.req.json<{ properties: Record<string, unknown>; associations?: Array<{ to: { id: string } }> }>();
  if (ACTIVITY_TYPES[t]) {
    const p = body.properties;
    const type = ACTIVITY_TYPES[t];
    const act = await createActivity(c.env.DB, ctx, {
      type,
      subject: (p.hs_task_subject ?? p.hs_email_subject ?? p.hs_call_title ?? p.hs_meeting_title ?? '') as string,
      body: (p.hs_task_body ?? p.hs_note_body ?? p.hs_email_text ?? p.hs_call_body ?? p.hs_meeting_body ?? '') as string,
      occurred_at: (type === 'task' ? undefined : p.hs_timestamp) as string | undefined,
      due_at: (type === 'task' ? p.hs_timestamp : undefined) as string | undefined,
      owner_id: p.hubspot_owner_id ? Number((await ownerMap(c.env.DB)).fromHs(p.hubspot_owner_id)) : undefined,
      status: p.hs_task_status as string | undefined,
      direction: p.hs_email_direction === 'INCOMING_EMAIL' ? 'in' : type === 'email' ? 'out' : undefined,
      links: (body.associations ?? []).map((a) => Number(a.to.id)),
    });
    return c.json(activityOut((await c.env.DB.prepare('SELECT * FROM activities WHERE id = ?').bind(act.id).first<ActivityRow>())!, null, await ownerMap(c.env.DB)), 201);
  }
  const type = RECORD_TYPES[t];
  if (!type) throw new HttpError(404, `Tipo no soportado: ${t}`);
  const om = await ownerMap(c.env.DB);
  const props = Object.fromEntries(Object.entries(body.properties ?? {}).map(([k, v]) => [ALIAS[k] ?? k, k === 'hubspot_owner_id' ? om.fromHs(v) : v]));
  const row = await createRecord(c.env.DB, ctx, type, props, { strict: false });
  for (const a of body.associations ?? []) await associate(c.env.DB, ctx, row.id, Number(a.to.id));
  const [out] = await recordOut(c.env.DB, [await getRow(c.env.DB, row.id)], null);
  return c.json(out, 201);
});

compat.patch('/crm/v3/objects/:objectType/:id', async (c) => {
  const type = RECORD_TYPES[c.req.param('objectType')];
  if (!type) throw new HttpError(404, 'Tipo no soportado.');
  const body = await c.req.json<{ properties: Record<string, unknown> }>();
  const om = await ownerMap(c.env.DB);
  const props = Object.fromEntries(Object.entries(body.properties ?? {}).map(([k, v]) => [ALIAS[k] ?? k, k === 'hubspot_owner_id' ? om.fromHs(v) : v]));
  const row = await updateRecord(c.env.DB, c.get('ctx'), type, Number(c.req.param('id')), props, { strict: false });
  const [out] = await recordOut(c.env.DB, [row], null);
  return c.json(out);
});

compat.post('/crm/v4/associations/:from/:to/batch/read', async (c) => {
  const from = c.req.param('from');
  const to = c.req.param('to');
  const toType = RECORD_TYPES[to] ?? ACTIVITY_TYPES[to];
  const fromType = RECORD_TYPES[from] ?? ACTIVITY_TYPES[from];
  if (!toType || !fromType) throw new HttpError(404, 'Tipo no soportado.');
  const { inputs } = await c.req.json<{ inputs: Array<{ id: string }> }>();
  const ids = inputs.map((i) => Number(i.id));
  let rows: Array<{ from_id: number; to_id: number; is_primary: number; label: string | null }>;
  if (ACTIVITY_TYPES[from]) {
    rows = (await c.env.DB.prepare(`SELECT activity_id AS from_id, record_id AS to_id, 0 AS is_primary, NULL AS label FROM activity_links
      WHERE activity_id IN (SELECT value FROM json_each(?)) AND object_type = ?`).bind(JSON.stringify(ids), toType).all<typeof rows[number]>()).results;
  } else if (ACTIVITY_TYPES[to]) {
    rows = (await c.env.DB.prepare(`SELECT l.record_id AS from_id, l.activity_id AS to_id, 0 AS is_primary, NULL AS label FROM activity_links l
      JOIN activities a ON a.id = l.activity_id AND a.type = ? AND a.archived = 0 WHERE l.record_id IN (SELECT value FROM json_each(?))`).bind(toType, JSON.stringify(ids)).all<typeof rows[number]>()).results;
  } else {
    rows = (await c.env.DB.prepare(`SELECT a.from_id, a.to_id, a.is_primary, a.label FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
      WHERE a.from_id IN (SELECT value FROM json_each(?)) AND a.to_type = ? ORDER BY a.is_primary DESC, a.created_at`).bind(JSON.stringify(ids), toType).all<typeof rows[number]>()).results;
  }
  const typeId = ASSOC_TYPE_ID[`${fromType}>${toType}`] ?? 1;
  const results = ids.map((id) => ({
    from: { id: String(id) },
    to: rows.filter((r) => r.from_id === id).map((r) => ({
      toObjectId: r.to_id,
      associationTypes: [
        { category: 'HUBSPOT_DEFINED', typeId, label: r.label },
        ...(r.is_primary ? [{ category: 'HUBSPOT_DEFINED', typeId: fromType === 'deal' ? 5 : 1, label: 'Primary' }] : []),
      ],
    })),
  })).filter((r) => r.to.length);
  return c.json({ status: 'COMPLETE', results });
});

compat.put('/crm/v4/objects/:from/:fromId/associations/default/:to/:toId', async (c) => {
  await associate(c.env.DB, c.get('ctx'), Number(c.req.param('fromId')), Number(c.req.param('toId')));
  return c.json({ status: 'COMPLETE' });
});

compat.put('/crm/v4/objects/:from/:fromId/associations/:to/:toId', async (c) => {
  await associate(c.env.DB, c.get('ctx'), Number(c.req.param('fromId')), Number(c.req.param('toId')));
  return c.json({ status: 'COMPLETE' });
});
