import type { Ctx, Env, User } from './env';
import { Meta } from './meta';
import { createRecord, updateRecord, ORDER_CONFIRMED } from './records';
import { associate } from './associations';
import { finnegansPedido, finnegansToken } from './finnegans';

// Pedidos desde ClickUp (pedido de Rodrigo del 30/10/2026). La lista PEC («Producciones en curso → Produccion Merch»)
// tiene una tarea por PDV y una subtarea por artículo, cada una con su estado. Cada 10 minutos se leen las tareas que
// cambiaron y, por cada PDV, el CRM crea el pedido si no existe y le pone el estado general que corresponde.
//
// - El estado sale de los ARTÍCULOS, no del PDV (regla de Rodrigo: el del PDV no es certero).
// - La vendedora solo pasa el pedido de «Pedido confirmado» a «Listo para producción»; lo demás lo mueve esto.
// - Cuando el PDV está entregado, la foto del remito que suben a la tarea del PDV queda en el pedido (tabla `files`).
// - ClickUp solo se lee.

const LIST = '901326159292';
const API = (env: Env) => env.CLICKUP_API_URL ?? 'https://api.clickup.com/api/v2';
const MAX_PDV = 40;   // PDV por corrida (cada uno es una consulta a ClickUp); lo que falta sigue en la próxima

export const STAGE = {
  confirmado: ORDER_CONFIRMED,
  listo_produccion: '3725360f-519b-4b18-a593-494d60a29c9f',
  boceto: 'esperando_boceto',
  produccion: '1237498994',
  listo_entregar: '1237498996',
  parcial: 'entregado_parcial',
  entregado: '1237498998',
  anulado: '3c85a297-e9ce-400b-b42e-9f16853d69d6',
};
const ANULADOS = ['anulado', 'anulada', 'cancelado'];
const NO_ARRANCO = ['ingreso de pedido', 'pdv', 'personales'];
const ESPERA = ['boceto pendiente', 'en espera de confirmación', 'en espera de confirmacion'];
// Unidades de negocio de ClickUp que tienen pedidos en el CRM (Mercado Libre no tiene vendedora).
const UNIDADES: Record<string, string> = { 'FORMAS SHOP': 'FORMAS SHOP', CORPORATE: 'CORPORATE', 'NO ESTRÉS': 'NO ESTRÉS', 'NO ESTRES': 'NO ESTRÉS' };
// El VENDEDOR de ClickUp se carga a mano y tiene apodos (como CLICKUP_ALIAS del tablero de Formas Shop).
const ALIAS: Record<string, string> = { eli: 'elizabeth reynoso', elizabeth: 'elizabeth reynoso', lucia: 'lucia senini', luli: 'lucia senini', jorgelina: 'jorgelina carrasco' };

// Estado general del pedido a partir del estado de cada artículo. null = todavía no arrancó la producción (queda lo que
// haya puesto la vendedora).
export function generalStage(statuses: string[]): string | null {
  const s = statuses.map((x) => x.toLowerCase().trim()).filter(Boolean);
  if (!s.length) return null;
  const live = s.filter((x) => !ANULADOS.includes(x));
  if (!live.length) return STAGE.anulado;
  if (live.every((x) => x === 'entregados')) return STAGE.entregado;
  if (live.some((x) => x === 'entregados' || x === 'parcial entregado')) return STAGE.parcial;
  if (live.every((x) => x.startsWith('listo para ent'))) return STAGE.listo_entregar;
  if (live.some((x) => ESPERA.includes(x))) return STAGE.boceto;
  if (live.some((x) => !NO_ARRANCO.includes(x))) return STAGE.produccion;
  return null;
}

interface CuTask {
  id: string; name: string; parent?: string | null; url: string; date_updated?: string; text_content?: string; description?: string;
  status?: { status: string; type?: string };
  custom_fields?: Array<{ name: string; type: string; value?: unknown; type_config?: { options?: Array<{ id: string; name: string; orderindex?: number }> } }>;
  subtasks?: CuTask[];
  attachments?: Array<{ id: string; title?: string; extension?: string; mimetype?: string; size?: number; date?: string }>;
}

async function cu<T>(env: Env, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(API(env) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: env.CLICKUP_TOKEN! } });
  if (!res.ok) throw new Error(`ClickUp ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Campos personalizados de una tarea → { nombre: valor legible } (desplegables por nombre, fechas como AAAA-MM-DD).
function fields(t: CuTask) {
  const out: Record<string, string> = {};
  for (const c of t.custom_fields ?? []) {
    let v = c.value as unknown;
    if (v == null || v === '') continue;
    if (c.type === 'drop_down') {
      const ops = c.type_config?.options ?? [];
      const o = typeof v === 'object' ? (v as { name?: string }) : ops.find((x) => x.id === v || x.orderindex === Number(v));
      v = o?.name ?? v;
    } else if (c.type === 'date') {
      const d = new Date(Number(v) - 3 * 3600_000);   // hora de Buenos Aires
      v = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : v;
    }
    out[(c.name ?? '').trim()] = String(v).trim();
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Nombre de empresa para comparar: sin la forma societaria del final ("Memes Games SRL" = "MEMES GAMES S.R.L.").
const companyKey = (s: string) => norm(s).replace(/[.,]/g, '').replace(/(\s(s ?r ?l|s ?a ?s|s ?a ?u|s ?a ?i ?c|s ?a ?c ?i ?f|s ?a|s ?h))+$/, '').trim();

// Datos del PDV que necesita el pedido.
export function readPdv(t: CuTask) {
  const f = fields(t);
  const text = t.text_content || t.description || '';
  const line = (k: string) => text.match(new RegExp(`${k}:\\s*(.+)`, 'i'))?.[1]?.trim() ?? '';
  const npdv = (f['N° PDV'] || t.name).match(/(\d+)/)?.[1] ?? '';
  const unidad = UNIDADES[(f['UNIDAD DE NEGOCIO'] ?? '').trim().toUpperCase()];
  const fe = line('Fecha entrega').match(/(\d{2})-(\d{2})-(\d{4})/);
  const items = t.subtasks?.length ? t.subtasks : [t];
  const statuses = ANULADOS.includes((t.status?.status ?? '').toLowerCase()) ? ['anulado'] : items.map((x) => x.status?.status ?? '');
  const count = new Map<string, number>();
  for (const st of statuses) count.set(st, (count.get(st) ?? 0) + 1);
  return {
    npdv, unidad, url: t.url,
    pedido: line('Pedido').replace(/\s+/g, ' '),
    cliente: f.CLIENTE || line('Cliente'),
    vendedor: f['🧑‍💻 VENDEDOR'] || f.VENDEDOR || line('Vendedor'),
    mailVendedor: f['MAIL VENDEDOR'] ?? '',
    evento: f['🎫 EVENTO'] === 'true' || /^s[ií]/i.test(line('Es evento')),
    entrega: fe ? `${fe[3]}-${fe[2]}-${fe[1]}` : null,
    entregado: f['ENTREGAS (FECHA REAL)'] ?? null,
    stage: generalStage(statuses),
    detalle: [...count.entries()].sort((a, b) => b[1] - a[1]).map(([st, n]) => `${n} ${st}`).join(' · '),
  };
}

async function systemCtx(env: Env): Promise<Ctx> {
  const u = await env.DB.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<User>();
  return { user: u!, source: 'clickup', sourceDetail: 'Lista PEC' };
}

async function ownerFor(db: D1Database, vendedor: string, mail: string) {
  const users = (await db.prepare('SELECT id, name, email FROM users WHERE active = 1').all<{ id: number; name: string; email: string }>()).results;
  const v = norm(vendedor);
  const want = ALIAS[v] ?? v;
  return users.find((u) => norm(u.name) === want)?.id
    ?? users.find((u) => want && norm(u.name).startsWith(want))?.id
    ?? users.find((u) => mail && u.email.toLowerCase() === mail.toLowerCase())?.id
    ?? null;
}

// Empresa del pedido: por CUIT (leyendo el pedido en Finnegans, si hay credenciales) o por razón social.
async function companyFor(env: Env, pdv: ReturnType<typeof readPdv>, fin: string | null) {
  const db = env.DB;
  if (fin && pdv.pedido) {
    const c = await finnegansPedido(env, fin, pdv.pedido).catch(() => null);
    const cuit = c?.cuit?.replace(/\D/g, '');
    if (cuit) {
      const hit = await db.prepare(`SELECT id FROM records WHERE object_type = 'company' AND archived = 0
        AND replace(replace(COALESCE(json_extract(props, '$.cuit'), ''), '-', ''), ' ', '') = ? LIMIT 1`).bind(cuit).first<{ id: number }>();
      if (hit) return hit.id;
    }
  }
  const key = companyKey(pdv.cliente);
  if (key.length < 3) return null;
  const { results } = await db.prepare("SELECT id, name FROM records WHERE object_type = 'company' AND archived = 0 AND name LIKE ? LIMIT 50")
    .bind(`%${key.split(' ')[0]}%`).all<{ id: number; name: string }>();
  return results.find((r) => companyKey(r.name) === key)?.id ?? null;
}

async function findOrder(db: D1Database, pdv: ReturnType<typeof readPdv>) {
  const { results } = await db.prepare(`SELECT id, props FROM records WHERE object_type = 'order' AND archived = 0
    AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) IN (?, ?, ?)`).bind(pdv.npdv, `PDV - ${pdv.npdv}`, `PDV ${pdv.npdv}`).all<{ id: number; props: string }>();
  if (results.length <= 1) return results[0];
  // El mismo número en dos unidades (talonarios distintos): el de la misma unidad o el del mismo pedido de Finnegans.
  return results.find((r) => { const p = JSON.parse(r.props); return p.pedido_finnegans === pdv.pedido || p.unidad_de_negocio === pdv.unidad; }) ?? results[0];
}

// Un PDV de ClickUp → su pedido en el CRM. Devuelve qué hizo.
export async function upsertPdv(env: Env, ctx: Ctx, t: CuTask, fin: string | null): Promise<'creado' | 'actualizado' | 'igual' | 'omitido'> {
  const db = env.DB;
  const pdv = readPdv(t);
  if (!pdv.npdv || !pdv.unidad) return 'omitido';
  const existing = await findOrder(db, pdv);
  let id: number;
  let result: 'creado' | 'actualizado' | 'igual' = 'igual';
  const synced: Record<string, unknown> = {
    unidad_de_negocio: pdv.unidad, cliente_clickup: pdv.cliente || null, pedido_finnegans: pdv.pedido || null, url_clickup: pdv.url,
    detalle_produccion: pdv.detalle, entregado_el: pdv.stage === STAGE.entregado || pdv.stage === STAGE.parcial ? pdv.entregado : null,
  };
  if (!existing) {
    const pipeline = (await new Meta(db).property('order', 'hs_pipeline'))?.options[0]?.value;
    const row = await createRecord(db, ctx, 'order', {
      ...synced, hs_order_name: `PDV ${pdv.npdv}${pdv.cliente ? ` · ${pdv.cliente}` : ''}`, pdv_finnegans: pdv.npdv,
      hs_pipeline_stage: pdv.stage ?? STAGE.confirmado, hs_pipeline: pipeline ?? null, tipo_de_pedido: pdv.evento ? 'EVENTO' : 'PEDIDO NORMAL',
      fecha_de_entrega: pdv.entrega, owner_id: await ownerFor(db, pdv.vendedor, pdv.mailVendedor),
    }, { system: true, strict: false });
    id = row.id;
    const company = await companyFor(env, pdv, fin);
    if (company) await associate(db, ctx, id, company, { primary: true }).catch(() => undefined);
    result = 'creado';
  } else {
    id = existing.id;
    const cur = JSON.parse(existing.props) as Record<string, unknown>;
    const change: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(synced)) if (v != null && String(v) !== String(cur[k] ?? '')) change[k] = v;
    if (pdv.stage && pdv.stage !== cur.hs_pipeline_stage) change.hs_pipeline_stage = pdv.stage;
    if (!cur.fecha_de_entrega && pdv.entrega) change.fecha_de_entrega = pdv.entrega;
    if (!cur.tipo_de_pedido) change.tipo_de_pedido = pdv.evento ? 'EVENTO' : 'PEDIDO NORMAL';
    if (cur.owner_id == null) { const o = await ownerFor(db, pdv.vendedor, pdv.mailVendedor); if (o) change.owner_id = o; }
    if (Object.keys(change).length) { await updateRecord(db, ctx, 'order', id, change, { system: true, strict: false }); result = 'actualizado'; }
    // Sin empresa (por ejemplo, entró antes de que la empresa estuviera en el CRM): se vuelve a buscar.
    const hasCompany = await db.prepare(`SELECT 1 FROM associations WHERE (from_id = ? AND to_type = 'company') OR (to_id = ? AND from_type = 'company') LIMIT 1`).bind(id, id).first();
    if (!hasCompany) {
      const company = await companyFor(env, pdv, fin);
      if (company) { await associate(db, ctx, id, company, { primary: true }).catch(() => undefined); result = 'actualizado'; }
    }
  }
  // El remito: lo que suben a la tarea del PDV cuando lo entregan (una foto del remito firmado).
  if (pdv.stage === STAGE.entregado || pdv.stage === STAGE.parcial) {
    for (const a of t.attachments ?? []) {
      const r = await db.prepare(`INSERT OR IGNORE INTO files (record_id, kind, name, mime, size, source, source_ref, meta)
        VALUES (?, 'remito', ?, ?, ?, 'clickup', ?, ?)`).bind(id, a.title || `Remito PDV ${pdv.npdv}`, a.mimetype ?? null, a.size ?? null, `${t.id}:${a.id}`,
        JSON.stringify({ task: t.id, attachment: a.id, date: a.date ? new Date(Number(a.date)).toISOString() : null })).run();
      if (r.meta.changes && result === 'igual') result = 'actualizado';
    }
  }
  return result;
}

export interface ClickupState { last?: number; at?: string; creados?: number; actualizados?: number; error?: string | null; pendientes?: number }

export async function clickupState(db: D1Database): Promise<ClickupState> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'clickup_state'").first<{ value: string }>();
  return r ? JSON.parse(r.value) : {};
}

// Lee lo que cambió en la lista PEC desde la última corrida y actualiza los pedidos.
// `full`: la primera vez (o a pedido), los PDV abiertos y los cerrados de los últimos 45 días.
export async function syncClickup(env: Env, opts: { full?: boolean } = {}) {
  if (!env.CLICKUP_TOKEN) return { skipped: 'Falta CLICKUP_TOKEN.' };
  const db = env.DB;
  const state = await clickupState(db);
  const started = Date.now();
  const since = opts.full || !state.last ? started - 45 * 86_400_000 : state.last - 5 * 60_000;
  const out: ClickupState = { ...state, at: new Date(started).toISOString(), creados: 0, actualizados: 0, error: null };
  try {
    // 1. Tareas que cambiaron (PDV y artículos), abiertas y cerradas; y en la carga completa, todas las abiertas.
    const changed: CuTask[] = [];
    const pages = async (params: Record<string, string | number>) => {
      for (let page = 0; page < 30; page++) {
        const d = await cu<{ tasks: CuTask[]; last_page?: boolean }>(env, `/list/${LIST}/task`, { ...params, subtasks: 'true', page });
        changed.push(...d.tasks);
        if (d.last_page !== false || !d.tasks.length) break;
      }
    };
    await pages({ include_closed: 'true', date_updated_gt: since, order_by: 'updated', reverse: 'true' });
    if (opts.full || !state.last) await pages({});
    // 2. PDV a revisar (el padre de cada artículo), del cambio más viejo al más nuevo.
    const byPdv = new Map<string, number>();
    for (const t of changed) {
      const pid = t.parent || t.id;
      byPdv.set(pid, Math.max(byPdv.get(pid) ?? 0, Number(t.date_updated ?? 0)));
    }
    const queue = [...byPdv.entries()].sort((a, b) => a[1] - b[1]);
    const ctx = await systemCtx(env);
    const fin = await finnegansToken(env).catch(() => null);
    let last = started;
    for (const [i, [pid]] of queue.entries()) {
      if (i >= MAX_PDV) { last = queue[i - 1][1]; break; }
      const t = await cu<CuTask>(env, `/task/${pid}`, { include_subtasks: 'true' });
      if (t.parent || !/PDV/i.test(t.name)) continue;
      const r = await upsertPdv(env, ctx, t, fin);
      if (r === 'creado') out.creados!++;
      if (r === 'actualizado') out.actualizados!++;
    }
    out.pendientes = Math.max(0, queue.length - MAX_PDV);
    out.last = last;
  } catch (e) {
    out.error = (e as Error).message;
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clickup_state', ?)").bind(JSON.stringify(out)).run();
  return out;
}

// Para abrir un remito: ClickUp da un link nuevo (y de un solo uso si los adjuntos son privados) cada vez que se pide.
export async function clickupAttachment(env: Env, taskId: string, attachmentId: string) {
  if (!env.CLICKUP_TOKEN) return null;
  const t = await cu<{ attachments?: Array<{ id: string; url?: string; url_w_query?: string; title?: string; mimetype?: string }> }>(env, `/task/${taskId}`);
  const a = t.attachments?.find((x) => x.id === attachmentId);
  const url = a?.url_w_query || a?.url;
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: env.CLICKUP_TOKEN } });
  if (!res.ok) return null;
  return { body: res.body, type: res.headers.get('content-type') ?? a?.mimetype ?? 'application/octet-stream', name: a?.title ?? 'remito' };
}

