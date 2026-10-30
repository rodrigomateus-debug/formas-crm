import type { Ctx, Env, ObjectType } from './env';
import { assertType, HttpError, OBJECT_TYPES } from './env';
import { Meta } from './meta';
import { createRecord, getRow, mergeRecords, rowToRecord, searchRecords, sqlFor, updateRecord, type Filter } from './records';
import { associate, associationsOf, dissociate } from './associations';
import { createActivity, getActivity, listTasks, timeline, updateActivity, ACTIVITY_TYPES } from './activities';
import { applyBundle, autoAssociateCompany, type Bundle } from './upsert';
import { companiesFor, requireCompany } from './pipelines';

// Servidor MCP (Streamable HTTP, respuestas JSON) para que Claude y Cowork lean y actualicen el CRM.
// Reemplaza al conector de HubSpot: mismas ideas (buscar, crear, actualizar, asociar, registrar actividad).

const PROTOCOL = '2025-06-18';

const FILTER_SCHEMA = {
  type: 'array',
  description: 'Filtros AND. op: eq, neq, contains, not_contains, in, not_in, gt, gte, lt, lte, between (value+high), known, unknown, within_last (días), within_next (días), before_days_ago (días). En owner_id, value "me" es el usuario del token.',
  items: {
    type: 'object',
    properties: {
      prop: { type: 'string' }, op: { type: 'string' }, value: {}, values: { type: 'array', items: {} }, high: {},
    },
    required: ['prop', 'op'],
  },
};

const OBJ = { type: 'string', enum: OBJECT_TYPES, description: 'contact (contacto), company (empresa), deal (negocio), order (pedido)' };
const IDS = { type: 'array', items: { type: 'integer' } };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  run: (args: Record<string, any>, ctx: Ctx, env: Env, base: string) => Promise<unknown>;
}

const link = (base: string, type: string, id: number) => `${base}/${type === 'company' ? 'companies' : `${type}s`}/${id}`;

function slim(base: string, r: ReturnType<typeof rowToRecord>, props?: string[]) {
  const p = props?.length ? Object.fromEntries(props.map((k) => [k, r.props[k] ?? null])) : Object.fromEntries(Object.entries(r.props).filter(([, v]) => v != null && v !== ''));
  return { id: r.id, type: r.type, name: r.name, url: link(base, r.type, r.id), properties: p };
}

const TOOLS: Tool[] = [
  {
    name: 'search_records',
    description: 'Busca contactos, empresas, negocios o pedidos. Texto libre (nombre, mail, dominio, teléfono, id) y/o filtros por propiedad. Devuelve total y registros con link al CRM. Para ver qué propiedades existen usá list_properties.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJ,
        query: { type: 'string' },
        filters: FILTER_SCHEMA,
        associated_with: { type: 'integer', description: 'Solo registros asociados a este id (ej. negocios de una empresa).' },
        sort: { type: 'string', description: 'Propiedad para ordenar (default hs_lastmodifieddate).' },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Máximo 200 (default 20).' },
        offset: { type: 'integer' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Propiedades a devolver (default: todas las que tienen valor).' },
      },
      required: ['object_type'],
    },
    run: async (a, ctx, env, base) => {
      const res = await searchRecords(env.DB, ctx, assertType(a.object_type), {
        q: a.query, filters: a.filters, associatedWith: a.associated_with, sort: a.sort, dir: a.direction, limit: Math.min(a.limit ?? 20, 200), offset: a.offset,
      });
      return { total: res.total, offset: res.offset, results: res.results.map((r) => slim(base, r, a.properties)) };
    },
  },
  {
    name: 'get_record',
    description: 'Trae un registro por id con todas sus propiedades, sus asociaciones (contactos, empresas, negocios, pedidos) y la actividad reciente (notas, mails, llamadas, reuniones, WhatsApp, tareas).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, activity_limit: { type: 'integer', description: 'Cuántas actividades traer (default 15, 0 = ninguna).' } },
      required: ['id'],
    },
    run: async (a, _ctx, env, base) => {
      const row = await getRow(env.DB, Number(a.id));
      const assoc = await associationsOf(env.DB, row.id);
      const lim = a.activity_limit ?? 15;
      const tl = lim ? await timeline(env.DB, row.id, { limit: lim }) : null;
      return {
        ...slim(base, rowToRecord(row)),
        archived: !!row.archived,
        associations: Object.fromEntries(Object.entries(assoc).map(([t, list]) => [t, list.map((r) => ({ id: r.id, name: r.name, url: link(base, t, r.id), primary: r.primary }))])),
        activity: tl?.activities.map((x) => ({
          id: x.id, type: x.type, when: x.type === 'task' ? x.due_at : x.occurred_at, subject: x.subject, body: x.body.slice(0, 1500),
          direction: x.direction, status: x.status, owner_id: x.owner_id,
        })),
        activity_counts: tl?.counts,
      };
    },
  },
  {
    name: 'create_record',
    description: 'Crea un contacto, empresa, negocio o pedido. Los contactos se deduplican por email (si ya existe da error con el id). En negocios: pipeline y dealstage aceptan id o nombre; si falta la etapa va a la primera. Conviene usar upsert_bundle cuando hay que crear contacto + empresa + negocio juntos.',
    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJ,
        properties: { type: 'object', description: 'Nombre interno → valor. owner_id es el id del usuario (ver list_users).' },
        associate_with: { ...IDS, description: 'Ids de registros a asociar.' },
      },
      required: ['object_type', 'properties'],
    },
    run: async (a, ctx, env, base) => {
      const type = assertType(a.object_type);
      const assoc: number[] = [...new Set<number>((a.associate_with ?? []).map(Number))];
      if (type === 'deal') {
        const companies = await companiesFor(env.DB, assoc);
        const pipeline = (await new Meta(env.DB).pipelines()).find((p) => p.id === (a.properties?.pipeline ?? 'default') || p.label === a.properties?.pipeline);
        requireCompany(ctx, pipeline, companies.length);
        for (const co of companies) if (!assoc.includes(co)) assoc.push(co);
      }
      const row = await createRecord(env.DB, ctx, type, a.properties ?? {});
      for (const id of assoc) await associate(env.DB, ctx, row.id, id);
      if (row.object_type === 'contact' && !(await env.DB.prepare("SELECT 1 FROM associations WHERE from_id = ? AND to_type = 'company'").bind(row.id).first())) {
        await autoAssociateCompany(env.DB, ctx, row);
      }
      return slim(base, rowToRecord(await getRow(env.DB, row.id)));
    },
  },
  {
    name: 'update_record',
    description: 'Actualiza propiedades de un registro (para vaciar una propiedad mandá null). Mover un negocio de etapa = cambiar dealstage. Queda en el historial con el origen "mcp".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, properties: { type: 'object' } },
      required: ['id', 'properties'],
    },
    run: async (a, ctx, env, base) => {
      const cur = await getRow(env.DB, Number(a.id));
      return slim(base, rowToRecord(await updateRecord(env.DB, ctx, cur.object_type, cur.id, a.properties ?? {})));
    },
  },
  {
    name: 'upsert_bundle',
    description: 'Alta inteligente: busca antes de crear (contacto por email o teléfono, empresa por dominio o nombre), completa solo lo vacío y asocia todo. Puede crear un negocio (con dedupe_open=true reutiliza un negocio abierto del contacto en ese pipeline), una nota y una tarea asociadas.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'object' }, company: { type: 'object' }, deal: { type: 'object' },
        note: { type: 'string' },
        task: { type: 'object', description: '{subject, body, due_at, owner_id, priority}' },
        owner_id: { type: 'integer', description: 'Propietario por defecto para lo que se cree.' },
      },
    },
    run: async (a, ctx, env) => applyBundle(env.DB, ctx, a as Bundle),
  },
  {
    name: 'associate_records',
    description: 'Asocia dos registros (contacto↔empresa, negocio↔contacto, negocio↔empresa, pedido↔contacto, empresa↔empresa). primary=true marca la empresa principal.',
    inputSchema: {
      type: 'object',
      properties: { from_id: { type: 'integer' }, to_id: { type: 'integer' }, label: { type: 'string' }, primary: { type: 'boolean' }, remove: { type: 'boolean', description: 'true para desasociar.' } },
      required: ['from_id', 'to_id'],
    },
    run: async (a, ctx, env) => {
      if (a.remove) await dissociate(env.DB, ctx, Number(a.from_id), Number(a.to_id));
      else await associate(env.DB, ctx, Number(a.from_id), Number(a.to_id), { label: a.label, primary: a.primary });
      return { ok: true };
    },
  },
  {
    name: 'log_activity',
    description: 'Registra una actividad en uno o más registros: note (nota), call (llamada, con outcome), email, meeting (reunión), whatsapp. Si se registra en un contacto, también queda en su empresa principal.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ACTIVITY_TYPES.filter((t) => t !== 'task') },
        record_ids: IDS,
        subject: { type: 'string' }, body: { type: 'string' },
        occurred_at: { type: 'string', description: 'ISO 8601; default ahora. Una reunión futura cuenta como próxima actividad.' },
        direction: { type: 'string', enum: ['in', 'out'] },
        outcome: { type: 'string' },
        owner_id: { type: 'integer' },
        meta: { type: 'object', description: 'Datos extra (from, to, duration_min, location, end_at…).' },
      },
      required: ['type', 'record_ids'],
    },
    run: async (a, ctx, env) => {
      const act = await createActivity(env.DB, ctx, { ...a, type: a.type, links: (a.record_ids ?? []).map(Number) } as never);
      return { id: act.id, type: act.type, links: act.links };
    },
  },
  {
    name: 'create_task',
    description: 'Crea una tarea (ej. "Prospectar <empresa>", "Llamar para seguimiento") asociada a registros. due_at en ISO 8601. owner_id = vendedora (ver list_users).',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' }, body: { type: 'string' }, due_at: { type: 'string' }, owner_id: { type: 'integer' },
        record_ids: IDS, priority: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        task_type: { type: 'string', enum: ['todo', 'call', 'email', 'whatsapp', 'meeting'] },
      },
      required: ['subject'],
    },
    run: async (a, ctx, env) => {
      const t = await createActivity(env.DB, ctx, { ...a, type: 'task', links: (a.record_ids ?? []).map(Number) } as never);
      return { id: t.id, subject: t.subject, due_at: t.due_at, owner_id: t.owner_id, links: t.links };
    },
  },
  {
    name: 'list_tasks',
    description: 'Lista tareas. owner: id de usuario, "me" o "all". status: open (default), done, all. due: overdue, today, week, upcoming, all.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: ['integer', 'string'] }, status: { type: 'string', enum: ['open', 'done', 'all'] },
        due: { type: 'string', enum: ['overdue', 'today', 'week', 'upcoming', 'all'] }, query: { type: 'string' },
        record_id: { type: 'integer' }, limit: { type: 'integer' },
      },
    },
    run: async (a, ctx, env) => {
      const owner = a.owner === 'all' ? 'all' : a.owner === 'me' || a.owner == null ? ctx.user.id : Number(a.owner);
      const res = await listTasks(env.DB, ctx, { owner, status: a.status, due: a.due, q: a.query, record: a.record_id, limit: a.limit ?? 50 });
      return { total: res.total, results: res.results.map((t) => ({ id: t.id, subject: t.subject, due_at: t.due_at, status: t.status, owner_id: t.owner_id, priority: t.priority, body: t.body.slice(0, 600), links: t.links })) };
    },
  },
  {
    name: 'update_activity',
    description: 'Cambia una actividad o tarea: completar (status COMPLETED), reprogramar (due_at), editar texto, reasignar (owner_id) o borrar (archived true).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, status: { type: 'string', enum: ['NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'COMPLETED'] }, due_at: { type: 'string' },
        subject: { type: 'string' }, body: { type: 'string' }, owner_id: { type: 'integer' }, archived: { type: 'boolean' }, record_ids: IDS,
      },
      required: ['id'],
    },
    run: async (a, ctx, env) => {
      const { id, record_ids, ...rest } = a;
      const act = await updateActivity(env.DB, ctx, Number(id), { ...rest, links: record_ids?.map(Number) });
      return { id: act.id, status: act.status, due_at: act.due_at, archived: act.archived };
    },
  },
  {
    name: 'merge_records',
    description: 'Combina dos registros duplicados del mismo tipo: el secundario se archiva y sus asociaciones, actividades y datos vacíos pasan al principal.',
    inputSchema: { type: 'object', properties: { primary_id: { type: 'integer' }, secondary_id: { type: 'integer' } }, required: ['primary_id', 'secondary_id'] },
    run: async (a, ctx, env, base) => {
      const p = await getRow(env.DB, Number(a.primary_id));
      return slim(base, rowToRecord(await mergeRecords(env.DB, ctx, p.object_type, p.id, Number(a.secondary_id))));
    },
  },
  {
    name: 'report',
    description: 'Cuentas y sumas agrupadas (para preguntas tipo "cuántos negocios ganó cada vendedora este mes" o "monto abierto por etapa"). group_by: cualquier propiedad, o month:<propiedad de fecha> (ej. month:createdate, month:closedate).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { object_type: OBJ, group_by: { type: 'array', items: { type: 'string' } }, filters: FILTER_SCHEMA, sum: { type: 'string', description: 'Propiedad numérica a sumar (default amount en negocios).' } },
      required: ['object_type'],
    },
    run: async (a, ctx, env) => report(env.DB, ctx, assertType(a.object_type), a.group_by ?? [], a.filters ?? [], a.sum),
  },
  {
    name: 'list_properties',
    description: 'Propiedades de un tipo de objeto: nombre interno, etiqueta, tipo y opciones válidas (para enums).',
    readOnly: true,
    inputSchema: { type: 'object', properties: { object_type: OBJ, query: { type: 'string', description: 'Filtra por nombre o etiqueta.' } }, required: ['object_type'] },
    run: async (a, _ctx, env) => {
      const props = await new Meta(env.DB).properties(assertType(a.object_type));
      const q = (a.query ?? '').toLowerCase();
      return props.filter((p) => !q || p.name.includes(q) || p.label.toLowerCase().includes(q)).map((p) => ({
        name: p.name, label: p.label, type: p.type, group: p.group_name, read_only: !!p.read_only, options: p.options.length ? p.options : undefined,
      }));
    },
  },
  {
    name: 'list_pipelines',
    description: 'Pipelines de negocios con sus etapas (id, nombre, probabilidad, si es cerrada/ganada, propiedades obligatorias para entrar) y sus reglas (no saltear etapas, no volver atrás, empresa obligatoria, etapas de alta). Leelo antes de crear o mover negocios.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, _ctx, env) => (await new Meta(env.DB).pipelines()).map((p) => ({
      id: p.id, label: p.label, team_id: p.team_id, rules: p.config.rules ?? {},
      stages: p.stages.map((s) => ({ id: s.id, label: s.label, probability: s.probability, closed: !!s.is_closed, won: !!s.is_won, required_props: s.config.required_props ?? [], auto_task: s.config.task?.subject ?? null })),
    })),
  },
  {
    name: 'list_users',
    description: 'Usuarios del CRM (propietarios posibles): id, nombre, mail, rol y equipo. También dice quién es el usuario de este token.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx, env) => {
      const { results } = await env.DB.prepare('SELECT u.id, u.name, u.email, u.role, u.active, t.name AS team FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.active DESC, u.name').all();
      return { me: { id: ctx.user.id, name: ctx.user.name }, users: results };
    },
  },
  {
    name: 'property_history',
    description: 'Historial de cambios de un registro (quién cambió qué, cuándo y desde dónde). Filtrable por propiedad.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, property: { type: 'string' } }, required: ['id'] },
    run: async (a, _ctx, env) => {
      const { results } = await env.DB.prepare(
        `SELECT c.prop, c.old_value, c.new_value, c.changed_at, c.source, u.name AS user FROM changes c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.record_id = ? ${a.property ? 'AND c.prop = ?' : ''} ORDER BY c.changed_at DESC LIMIT 200`,
      ).bind(...(a.property ? [Number(a.id), a.property] : [Number(a.id)])).all();
      return results;
    },
  },
  {
    name: 'get_activity',
    description: 'Trae una actividad completa (cuerpo entero del mail o nota) por id.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: async (a, _ctx, env) => getActivity(env.DB, Number(a.id)),
  },
];

export async function report(db: D1Database, ctx: Ctx, type: ObjectType, groupBy: string[], filters: Filter[], sumProp?: string) {
  const meta = new Meta(db);
  const cols: string[] = [];
  for (const g of groupBy.slice(0, 3)) {
    if (g.startsWith('month:')) cols.push(`substr(${(await sqlFor(meta, type, g.slice(6))).expr}, 1, 7)`);
    else cols.push((await sqlFor(meta, type, g)).expr);
  }
  const sumExpr = sumProp ? (await sqlFor(meta, type, sumProp)).expr : type === 'deal' || type === 'order' ? 'r.amount' : null;
  const ids = await searchRecords(db, ctx, type, { filters, limit: 1 });
  const where: string[] = ['r.object_type = ?', 'r.archived = 0'];
  const binds: unknown[] = [type];
  // Reutiliza el armado de filtros de la búsqueda: subconsulta por ids que cumplen.
  if (filters.length) {
    const all: number[] = [];
    for (let off = 0; off < ids.total; off += 500) all.push(...(await searchRecords(db, ctx, type, { filters, limit: 500, offset: off, sort: 'hs_object_id' })).results.map((r) => r.id));
    if (!all.length) return { total: 0, groups: [] };
    where.push(`r.id IN (SELECT value FROM json_each(?))`);
    binds.push(JSON.stringify(all));
  }
  const select = [...cols.map((c, i) => `${c} AS g${i}`), 'COUNT(*) AS count', ...(sumExpr ? [`COALESCE(SUM(${sumExpr}), 0) AS sum`] : [])];
  const sql = `SELECT ${select.join(', ')} FROM records r WHERE ${where.join(' AND ')} ${cols.length ? `GROUP BY ${cols.map((_, i) => `g${i}`).join(', ')} ORDER BY count DESC` : ''} LIMIT 500`;
  const { results } = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return {
    total: ids.total,
    group_by: groupBy,
    groups: results.map((r) => ({ keys: cols.map((_, i) => r[`g${i}`]), count: r.count, ...(sumExpr ? { sum: r.sum } : {}) })),
  };
}

type RpcReq = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, any> };

async function handleOne(msg: RpcReq, ctx: Ctx, env: Env, base: string) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: msg.params?.protocolVersion && ['2025-06-18', '2025-03-26', '2024-11-05'].includes(msg.params.protocolVersion) ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'formas-crm', title: 'Formas CRM', version: '1.0.0' },
        instructions: 'CRM propio de Formas Publicitarias (reemplazo de HubSpot). Objetos: contact, company, deal, order. '
          + 'Antes de crear, buscá (search_records) para no duplicar, o usá upsert_bundle. Usá list_properties para nombres internos y opciones válidas, '
          + 'list_pipelines para etapas y list_users para propietarios. Todo lo que hagas queda en el historial con origen "mcp".',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Herramienta desconocida: ${msg.params?.name}`);
      try {
        if (!tool.readOnly && ctx.user.role === 'viewer') throw new HttpError(403, 'El usuario del token es de solo lectura.');
        const result = await tool.run(msg.params?.arguments ?? {}, ctx, env, base);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: Array.isArray(result) ? { results: result } : result });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      if (msg.method?.startsWith('notifications/')) return null;
      return fail(-32601, `Método no soportado: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, ctx: Ctx, env: Env) {
  if (req.method !== 'POST') return new Response('Este endpoint MCP acepta POST (Streamable HTTP).', { status: 405, headers: { allow: 'POST' } });
  const base = new URL(req.url).origin;
  let body: RpcReq | RpcReq[];
  try { body = await req.json(); } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, { status: 400 }); }
  const mcpCtx: Ctx = { ...ctx, source: ctx.source === 'crm' ? 'mcp' : ctx.source };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(m, mcpCtx, env, base)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const res = await handleOne(body, mcpCtx, env, base);
  if (!res) return new Response(null, { status: 202 });
  const headers: Record<string, string> = {};
  if (body.method === 'initialize') headers['mcp-session-id'] = crypto.randomUUID();
  return Response.json(res, { headers });
}
