import { avisarAsignacion } from './avisos';
import { controlAlGanar } from './facturar';
import type { Ctx, ObjectType } from './env';
import { HttpError, now } from './env';
import { Meta, type Property, type Tag } from './meta';
import { emitDealEvent } from './events';
import { checkCreate, checkMove, requireCompany, stageAutomation, visiblePipelineIds } from './pipelines';

// Los registros nuevos arrancan en este id para no chocar con los ids de HubSpot que trae la migración
// (los migrados conservan su id de HubSpot, así los links y los tableros siguen andando).
export const NATIVE_ID_START = 900_000_000_001;

export type Props = Record<string, unknown>;

export interface RecordRow {
  id: number;
  object_type: ObjectType;
  name: string;
  props: string;
  owner_id: number | null;
  email: string | null;
  domain: string | null;
  phone: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  amount: number | null;
  close_date: string | null;
  stage_entered_at: string | null;
  last_activity_at: string | null;
  last_contacted_at: string | null;
  next_activity_at: string | null;
  created_at: string;
  updated_at: string;
  source: string;
  source_detail: string | null;
  archived: number;
}

export interface CrmRecord {
  id: number;
  type: ObjectType;
  name: string;
  props: Props;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

const FREE_MAIL = new Set([
  'gmail.com', 'hotmail.com', 'hotmail.com.ar', 'yahoo.com', 'yahoo.com.ar', 'outlook.com', 'outlook.com.ar', 'live.com',
  'live.com.ar', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'fibertel.com.ar', 'speedy.com.ar', 'arnet.com.ar',
  'msn.com', 'gmx.com', 'mail.com',
]);

export function normDomain(v: unknown): string | null {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  return s || null;
}

export function emailDomain(email: unknown): string | null {
  const m = String(email ?? '').toLowerCase().match(/@([^@\s>]+)$/);
  if (!m || FREE_MAIL.has(m[1])) return null;
  return m[1];
}

// Teléfonos: se guardan los últimos 10 dígitos para cruzar con WhatsApp (549…) y con cargas a mano.
export function normPhone(v: unknown): string | null {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return d.slice(-10);
}

// Perfil de LinkedIn → "linkedin.com/in/<slug>" (sin protocolo, www, parámetros ni barra final; acentos decodificados).
export function normLinkedin(v: unknown): string | null {
  let s = String(v ?? '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* queda como vino */ }
  const m = s.toLowerCase().match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/);
  return m ? `linkedin.com/${m[1]}/${m[2]}` : null;
}

// "Maria Valentina Di Lorenzo" + "Di Lorenzo" → nombre "Maria Valentina", apellido "Di Lorenzo".
export function splitName(first?: unknown, last?: unknown, full?: unknown) {
  let f = String(first ?? '').trim();
  let l = String(last ?? '').trim();
  if (!f && !l && full) {
    const parts = String(full).trim().split(/\s+/);
    f = parts.slice(0, Math.max(1, parts.length - 1)).join(' ');
    l = parts.length > 1 ? parts[parts.length - 1] : '';
  }
  if (l && f.toLowerCase().endsWith(` ${l.toLowerCase()}`)) f = f.slice(0, -(l.length + 1)).trim();
  return { firstname: f || undefined, lastname: l || undefined };
}

export function displayName(type: ObjectType, p: Props): string {
  const s = (k: string) => (p[k] == null ? '' : String(p[k]).trim());
  switch (type) {
    case 'contact':
      return [s('firstname'), s('lastname')].filter(Boolean).join(' ') || s('email') || s('phone') || s('mobilephone') || 'Sin nombre';
    case 'company':
      return s('name') || s('domain') || 'Empresa sin nombre';
    case 'deal':
      return s('dealname') || 'Negocio sin nombre';
    case 'order':
      return s('hs_order_name') || s('pdv_finnegans') || 'Pedido';
  }
}

// Propiedad → expresión SQL (sobre el alias r). Las que no están acá salen del JSON.
const COLUMNS: Record<string, string> = {
  hs_object_id: 'r.id',
  name: 'r.name',
  dealname: 'r.name',
  hs_order_name: 'r.name',
  owner_id: 'r.owner_id',
  pipeline: 'r.pipeline_id',
  dealstage: 'r.stage_id',
  amount: 'r.amount',
  closedate: 'r.close_date',
  createdate: 'r.created_at',
  hs_lastmodifieddate: 'r.updated_at',
  notes_last_updated: 'r.last_activity_at',
  notes_last_contacted: 'r.last_contacted_at',
  notes_next_activity_date: 'r.next_activity_at',
  hs_v2_date_entered_current_stage: 'r.stage_entered_at',
  source: 'r.source',
};

const COMPUTED_SQL: Record<string, string> = {
  num_associated_deals: "(SELECT COUNT(*) FROM associations a JOIN records d ON d.id = a.to_id AND d.archived = 0 WHERE a.from_id = r.id AND a.to_type = 'deal')",
  num_associated_contacts: "(SELECT COUNT(*) FROM associations a JOIN records d ON d.id = a.to_id AND d.archived = 0 WHERE a.from_id = r.id AND a.to_type = 'contact')",
  total_revenue: `(SELECT COALESCE(SUM(d.amount), 0) FROM associations a JOIN records d ON d.id = a.to_id AND d.archived = 0
    JOIN stages s ON s.id = d.stage_id AND s.is_won = 1 WHERE a.from_id = r.id AND a.to_type = 'deal')`,
};

const NUMERIC = new Set(['number', 'currency']);

export async function sqlFor(meta: Meta, type: ObjectType, prop: string): Promise<{ expr: string; numeric: boolean }> {
  if (COLUMNS[prop]) return { expr: COLUMNS[prop], numeric: ['amount', 'hs_object_id', 'owner_id'].includes(prop) };
  if (type === 'contact' && prop === 'email') return { expr: 'r.email', numeric: false };
  if (type === 'company' && prop === 'domain') return { expr: 'r.domain', numeric: false };
  if (COMPUTED_SQL[prop]) return { expr: COMPUTED_SQL[prop], numeric: true };
  const p = await meta.property(type, prop);
  if (!p) throw new HttpError(400, `La propiedad "${prop}" no existe en ${type}.`);
  const json = `json_extract(r.props, '$."${prop.replace(/"/g, '')}"')`;
  return { expr: NUMERIC.has(p.type) ? `CAST(${json} AS REAL)` : json, numeric: NUMERIC.has(p.type) };
}

export function rowToRecord(row: RecordRow): CrmRecord {
  const props = JSON.parse(row.props) as Props;
  return {
    id: row.id,
    type: row.object_type,
    name: row.name,
    props: {
      ...props,
      hs_object_id: row.id,
      createdate: row.created_at,
      hs_lastmodifieddate: row.updated_at,
      notes_last_updated: row.last_activity_at,
      notes_last_contacted: row.last_contacted_at,
      notes_next_activity_date: row.next_activity_at,
      ...(row.object_type === 'deal' ? { hs_v2_date_entered_current_stage: row.stage_entered_at } : {}),
      source: row.source_detail ? `${row.source} · ${row.source_detail}` : row.source,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: !!row.archived,
  };
}

// ---------- Validación ----------

function coerce(p: Property, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = typeof raw === 'string' ? raw.trim() : raw;
  switch (p.type) {
    case 'number':
    case 'currency': {
      const n = typeof s === 'number' ? s : Number(String(s).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) throw new HttpError(400, `"${p.label}" tiene que ser un número (llegó "${raw}").`);
      return n;
    }
    case 'bool': {
      const v = String(s).toLowerCase();
      if (['true', 'sí', 'si', '1', 'yes'].includes(v)) return 'true';
      if (['false', 'no', '0'].includes(v)) return 'false';
      throw new HttpError(400, `"${p.label}" es sí/no (llegó "${raw}").`);
    }
    case 'date': {
      const d = new Date(String(s));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `"${p.label}" no es una fecha válida (llegó "${raw}").`);
      return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : d.toISOString().slice(0, 10);
    }
    case 'datetime': {
      const d = new Date(typeof s === 'number' ? s : String(s));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `"${p.label}" no es una fecha válida (llegó "${raw}").`);
      return d.toISOString();
    }
    case 'enum': {
      if (!p.options.length) return String(s);
      const hit = p.options.find((o) => o.value === String(s)) ?? p.options.find((o) => o.label.toLowerCase() === String(s).toLowerCase());
      if (!hit) throw new HttpError(400, `"${p.label}" no acepta "${raw}". Opciones: ${p.options.map((o) => o.value).join(' | ')}`);
      return hit.value;
    }
    case 'multienum': {
      const parts = (Array.isArray(s) ? s : String(s).split(';')).map((x) => String(x).trim()).filter(Boolean);
      const out = parts.map((x) => {
        const hit = p.options.find((o) => o.value === x) ?? p.options.find((o) => o.label.toLowerCase() === x.toLowerCase());
        if (!hit && p.options.length) throw new HttpError(400, `"${p.label}" no acepta "${x}".`);
        return hit ? hit.value : x;
      });
      return out.join(';') || null;
    }
    case 'owner': {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new HttpError(400, `"${p.label}" tiene que ser el id de un usuario.`);
      return n;
    }
    case 'email':
      return String(s).toLowerCase();
    default:
      return String(s);
  }
}

// `system`: lo escribe una sincronización (ClickUp, Finnegans), que sí puede completar las propiedades de solo lectura.
export async function validateProps(meta: Meta, type: ObjectType, input: Props, opts: { strict?: boolean; system?: boolean } = {}) {
  const out: Props = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const name = k === 'hubspot_owner_id' ? 'owner_id' : k;
    const p = await meta.property(type, name);
    if (!p) {
      if (opts.strict !== false) throw new HttpError(400, `La propiedad "${k}" no existe en ${type}. Usá list_properties para ver las disponibles.`);
      ignored.push(k);
      continue;
    }
    if (p.read_only && !opts.system) continue;
    out[name] = coerce(p, v);
  }
  return { props: out, ignored };
}

// ---------- Escritura ----------

interface Promoted {
  name: string;
  owner_id: number | null;
  email: string | null;
  domain: string | null;
  phone: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  amount: number | null;
  close_date: string | null;
}

function promote(type: ObjectType, p: Props): Promoted {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  return {
    name: displayName(type, p),
    owner_id: num(p.owner_id),
    email: type === 'contact' ? ((p.email as string) || null) : type === 'order' ? ((p.hs_billing_address_email as string) || null) : null,
    domain: type === 'company' ? normDomain(p.domain || p.website) : type === 'contact' ? emailDomain(p.email) : null,
    phone: normPhone(p.phone || p.mobilephone || p.hs_customer_phone || p.hs_billing_address_phone),
    pipeline_id: type === 'deal' ? ((p.pipeline as string) || null) : null,
    stage_id: type === 'deal' ? ((p.dealstage as string) || null) : null,
    amount: type === 'deal' ? num(p.amount) : type === 'order' ? num(p.hs_total_price) : null,
    close_date: type === 'deal' ? ((p.closedate as string) || null) : null,
  };
}

async function checkDealStage(meta: Meta, props: Props, current?: Props) {
  const pipelines = await meta.pipelines();
  const pipelineId = (props.pipeline ?? current?.pipeline ?? 'default') as string;
  const pipeline = pipelines.find((p) => p.id === pipelineId || p.label.toLowerCase() === String(pipelineId).toLowerCase());
  if (!pipeline) throw new HttpError(400, `El pipeline "${pipelineId}" no existe. Opciones: ${pipelines.map((p) => `${p.id} (${p.label})`).join(', ')}`);
  props.pipeline = pipeline.id;
  const stageId = (props.dealstage ?? (props.pipeline !== current?.pipeline ? undefined : current?.dealstage)) as string | undefined;
  if (!stageId) {
    props.dealstage = pipeline.stages[0].id;
  } else {
    const st = pipeline.stages.find((s) => s.id === stageId || s.label.toLowerCase() === String(stageId).toLowerCase());
    if (!st) throw new HttpError(400, `La etapa "${stageId}" no es del pipeline ${pipeline.label}. Opciones: ${pipeline.stages.map((s) => `${s.id} (${s.label})`).join(', ')}`);
    props.dealstage = st.id;
  }
}

export async function getRow(db: D1Database, id: number, type?: ObjectType) {
  const row = await db.prepare('SELECT * FROM records WHERE id = ?').bind(id).first<RecordRow>();
  if (!row || (type && row.object_type !== type)) throw new HttpError(404, `No existe el registro ${id}${type ? ` (${type})` : ''}.`);
  return row;
}

const TRACK_ON_CREATE = ['dealstage', 'pipeline', 'owner_id', 'lifecyclestage', 'amount', 'hs_lead_status'];

// Estado del pedido: lo mueve ClickUp. A mano, la vendedora solo lo pasa de «Pedido confirmado» a «Listo para producción»
// (y lo puede volver atrás si se equivocó). Los administradores y las sincronizaciones lo pueden poner en cualquiera.
export const ORDER_CONFIRMED = '4b27b500-f031-4927-9811-68a0b525cbae';
export const ORDER_READY = '3725360f-519b-4b18-a593-494d60a29c9f';
function checkOrderStage(ctx: Ctx, opts: { system?: boolean }, from: unknown, to: unknown) {
  if (opts.system || ctx.user.role === 'admin' || ['clickup', 'hubspot'].includes(ctx.source)) return;
  const manual = [ORDER_CONFIRMED, ORDER_READY];
  if (manual.includes(String(from ?? ORDER_CONFIRMED)) && manual.includes(String(to))) return;
  throw new HttpError(403, 'El estado del pedido lo mueve ClickUp. A mano solo se pasa de «Pedido confirmado» a «Listo para producción».');
}

export async function createRecord(db: D1Database, ctx: Ctx, type: ObjectType, input: Props, opts: { strict?: boolean; system?: boolean; skipDedupe?: boolean; id?: number; createdAt?: string } = {}) {
  const meta = new Meta(db);
  const { props } = await validateProps(meta, type, input, opts);
  if (type === 'order' && props.hs_pipeline_stage != null) checkOrderStage(ctx, opts, ORDER_CONFIRMED, props.hs_pipeline_stage);
  for (const p of await meta.properties(type)) {
    if (p.required && (props[p.name] == null || props[p.name] === '') && !(type === 'deal' && ['pipeline', 'dealstage'].includes(p.name))) {
      throw new HttpError(400, `Falta "${p.label}".`);
    }
  }
  if (type === 'deal') {
    await checkDealStage(meta, props);
    const stage = (await meta.stage(props.dealstage as string))!;
    await checkCreate(meta, ctx, (await meta.pipelineOf(stage.id))!, stage, props);
  }
  if (type === 'company' && !props.domain && props.website) props.domain = normDomain(props.website);
  if (props.owner_id == null && ctx.source === 'crm' && ctx.user.role !== 'viewer') props.owner_id = ctx.user.id;
  if (type === 'contact' && props.email && !opts.skipDedupe) {
    const dup = await db.prepare("SELECT id FROM records WHERE object_type = 'contact' AND email = ? AND archived = 0").bind(props.email).first<{ id: number }>();
    if (dup) throw new HttpError(409, `Ya existe un contacto con ${props.email} (id ${dup.id}).`);
  }
  if (type === 'company' && props.domain && !opts.skipDedupe) {
    const dup = await db.prepare("SELECT id FROM records WHERE object_type = 'company' AND domain = ? AND archived = 0").bind(normDomain(props.domain)).first<{ id: number }>();
    if (dup) throw new HttpError(409, `Ya existe una empresa con el dominio ${props.domain} (id ${dup.id}).`);
  }
  const c = promote(type, props);
  const ts = opts.createdAt ?? now();
  const row = await db.prepare(
    `INSERT INTO records (id, object_type, name, props, owner_id, email, domain, phone, pipeline_id, stage_id, amount, close_date,
      stage_entered_at, created_at, updated_at, created_by, source, source_detail)
     VALUES (COALESCE(?, (SELECT MAX(COALESCE(MAX(id) + 1, 0), ${NATIVE_ID_START}) FROM records)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).bind(opts.id ?? null, type, c.name, JSON.stringify(props), c.owner_id, c.email, c.domain, c.phone, c.pipeline_id, c.stage_id, c.amount,
    c.close_date, c.stage_id ? ts : null, ts, ts, ctx.user.id, ctx.source, ctx.sourceDetail ?? null).first<RecordRow>();
  const changes = TRACK_ON_CREATE.filter((k) => props[k] != null).map((k) =>
    db.prepare('INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, NULL, ?, ?, ?, ?)')
      .bind(row!.id, k, String(props[k]), ts, ctx.user.id, ctx.source));
  if (changes.length) await db.batch(changes);
  await avisarAsignacion(db, ctx, c.owner_id, { recordId: row!.id });
  if (type === 'deal') await stageAutomation(db, ctx, row!.id, (await meta.stage(c.stage_id!))!, c.owner_id, c.name);
  return row!;
}

export async function updateRecord(db: D1Database, ctx: Ctx, type: ObjectType, id: number, input: Props, opts: { strict?: boolean; system?: boolean } = {}) {
  const meta = new Meta(db);
  const row = await getRow(db, id, type);
  const current = JSON.parse(row.props) as Props;
  const { props } = await validateProps(meta, type, input, opts);
  if (type === 'order' && 'hs_pipeline_stage' in props && props.hs_pipeline_stage !== current.hs_pipeline_stage) checkOrderStage(ctx, opts, current.hs_pipeline_stage, props.hs_pipeline_stage);
  const next: Props = { ...current, ...props };
  if (type === 'deal' && ('pipeline' in props || 'dealstage' in props)) {
    const stagePart: Props = { pipeline: props.pipeline ?? current.pipeline, dealstage: props.dealstage };
    await checkDealStage(meta, stagePart, current);
    next.pipeline = stagePart.pipeline;
    next.dealstage = stagePart.dealstage;
    if (next.dealstage !== current.dealstage) {
      const to = (await meta.stage(next.dealstage as string))!;
      const pipeline = (await meta.pipelineOf(to.id))!;
      await checkMove(meta, ctx, pipeline, await meta.stage(current.dealstage as string), to, next);
      if (next.pipeline !== current.pipeline) {
        const { results } = await db.prepare("SELECT to_id FROM associations WHERE from_id = ? AND to_type = 'company'").bind(id).all();
        requireCompany(ctx, pipeline, results.length);
      }
    }
  }
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  const changed = Object.keys({ ...current, ...next }).filter((k) => String(current[k] ?? '') !== String(next[k] ?? ''));
  if (!changed.length) return row;
  const c = promote(type, next);
  const ts = now();
  const stageMoved = changed.includes('dealstage');
  const stmts = [
    db.prepare(`UPDATE records SET name = ?, props = ?, owner_id = ?, email = ?, domain = ?, phone = ?, pipeline_id = ?, stage_id = ?,
      amount = ?, close_date = ?, stage_entered_at = CASE WHEN ? THEN ? ELSE stage_entered_at END, updated_at = ? WHERE id = ?`)
      .bind(c.name, JSON.stringify(next), c.owner_id, c.email, c.domain, c.phone, c.pipeline_id, c.stage_id, c.amount, c.close_date,
        stageMoved ? 1 : 0, ts, ts, id),
    ...changed.map((k) => db.prepare('INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, k, current[k] == null ? null : String(current[k]), next[k] == null ? null : String(next[k]), ts, ctx.user.id, ctx.source)),
  ];
  // Si el negocio pasa a una etapa cerrada sin fecha de cierre, se completa con hoy (igual que HubSpot).
  if (type === 'deal' && stageMoved) {
    const st = await meta.stage(next.dealstage as string);
    if (st?.is_closed && !props.closedate) {
      next.closedate = ts.slice(0, 10);
      stmts[0] = db.prepare(`UPDATE records SET name = ?, props = ?, owner_id = ?, pipeline_id = ?, stage_id = ?, amount = ?, close_date = ?,
        stage_entered_at = ?, updated_at = ? WHERE id = ?`)
        .bind(c.name, JSON.stringify(next), c.owner_id, c.pipeline_id, c.stage_id, c.amount, next.closedate, ts, ts, id);
    }
  }
  await db.batch(stmts);
  if (changed.includes('owner_id')) await avisarAsignacion(db, ctx, c.owner_id, { recordId: id });
  if (type === 'deal' && stageMoved) {
    const st = (await meta.stage(next.dealstage as string))!;
    await stageAutomation(db, ctx, id, st, c.owner_id, c.name);
    await emitDealEvent(db, st.is_won ? ['deal.stage_changed', 'deal.won'] : ['deal.stage_changed'], id);
    if (st.is_won) await controlAlGanar(db, ctx, id, c.owner_id).catch((e) => console.error('datos para facturar', id, (e as Error).message));
  }
  return getRow(db, id);
}

export async function archiveRecords(db: D1Database, ctx: Ctx, ids: number[]) {
  if (!ids.length) return 0;
  const ts = now();
  await db.batch(ids.flatMap((id) => [
    db.prepare('UPDATE records SET archived = 1, updated_at = ? WHERE id = ?').bind(ts, id),
    db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'archived', 'false', 'true', ?, ?, ?)")
      .bind(id, ts, ctx.user.id, ctx.source),
  ]));
  return ids.length;
}

export async function restoreRecord(db: D1Database, ctx: Ctx, id: number) {
  const ts = now();
  await db.batch([
    db.prepare('UPDATE records SET archived = 0, updated_at = ? WHERE id = ?').bind(ts, id),
    db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'archived', 'true', 'false', ?, ?, ?)")
      .bind(id, ts, ctx.user.id, ctx.source),
  ]);
}

// Combinar: el registro `loserId` se archiva y todo lo suyo (asociaciones, actividades, propiedades vacías) pasa al primario.
export async function mergeRecords(db: D1Database, ctx: Ctx, type: ObjectType, primaryId: number, loserId: number) {
  if (primaryId === loserId) throw new HttpError(400, 'No se puede combinar un registro consigo mismo.');
  const primary = await getRow(db, primaryId, type);
  const loser = await getRow(db, loserId, type);
  const pp = JSON.parse(primary.props) as Props;
  const lp = JSON.parse(loser.props) as Props;
  const fill: Props = {};
  for (const [k, v] of Object.entries(lp)) if ((pp[k] == null || pp[k] === '') && v != null && v !== '') fill[k] = v;
  if (type === 'contact' && lp.email && pp.email && lp.email !== pp.email) {
    fill.hs_additional_emails = [pp.hs_additional_emails, lp.email].filter(Boolean).join(';');
  }
  const ts = now();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary, created_at)
      SELECT ?, ?, to_type, to_id, label, 0, created_at FROM associations WHERE from_id = ? AND to_id != ?`).bind(type, primaryId, loserId, primaryId),
    db.prepare(`INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary, created_at)
      SELECT from_type, from_id, ?, ?, label, 0, created_at FROM associations WHERE to_id = ? AND from_id != ?`).bind(type, primaryId, loserId, primaryId),
    db.prepare('DELETE FROM associations WHERE from_id = ? OR to_id = ?').bind(loserId, loserId),
    db.prepare('INSERT OR IGNORE INTO activity_links (activity_id, record_id, object_type) SELECT activity_id, ?, object_type FROM activity_links WHERE record_id = ?').bind(primaryId, loserId),
    db.prepare('DELETE FROM activity_links WHERE record_id = ?').bind(loserId),
    db.prepare('UPDATE OR IGNORE files SET record_id = ? WHERE record_id = ?').bind(primaryId, loserId),
    // Los productos (de Finnegans) se vuelven a leer en el registro que queda.
    db.prepare('DELETE FROM line_items WHERE record_id = ?').bind(loserId),
    db.prepare('DELETE FROM line_item_sync WHERE record_id IN (?, ?)').bind(loserId, primaryId),
    db.prepare('UPDATE records SET archived = 1, merged_into = ?, updated_at = ? WHERE id = ?').bind(primaryId, ts, loserId),
    db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'merged', ?, ?, ?, ?, ?)")
      .bind(primaryId, String(loserId), loser.name, ts, ctx.user.id, ctx.source),
  ]);
  if (Object.keys(fill).length) {
    const meta = new Meta(db);
    const known: Props = {};
    for (const [k, v] of Object.entries(fill)) if (await meta.property(type, k)) known[k] = v;
    if (Object.keys(known).length) await updateRecord(db, ctx, type, primaryId, known, { strict: false });
  }
  await refreshActivityDates(db, [primaryId]);
  return getRow(db, primaryId);
}

// ---------- Búsqueda ----------

export interface Filter {
  prop: string;
  op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'known' | 'unknown' | 'within_last' | 'within_next' | 'before_days_ago';
  value?: unknown;
  values?: unknown[];
  high?: unknown;
}

export interface SearchParams {
  q?: string;
  filters?: Filter[];
  // Grupos OR de filtros AND (como los filterGroups de HubSpot). Si viene, reemplaza a `filters`.
  groups?: Filter[][];
  associatedWith?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

const ASSOC_PREFIX: Record<string, ObjectType> = { company: 'company', contact: 'contact', deal: 'deal' };

// Condición de una etiqueta (sus pipelines y sus grupos de filtros), sobre el registro `r`.
export async function tagSql(meta: Meta, ctx: Ctx, tag: Tag, binds: unknown[]): Promise<string> {
  const parts: string[] = [];
  if (tag.rule.pipelines?.length) { parts.push('r.pipeline_id IN (SELECT value FROM json_each(?))'); binds.push(JSON.stringify(tag.rule.pipelines)); }
  const groups = (tag.rule.groups ?? []).map((g) => g.filter((f) => f.prop !== '__tag')).filter((g) => g.length) as Filter[][];
  const g = await groupsSql(meta, ctx, tag.object_type as ObjectType, groups, binds);
  if (!g) return '0';
  parts.push(g);
  return `(${parts.join(' AND ')})`;
}

async function groupsSql(meta: Meta, ctx: Ctx, type: ObjectType, groups: Filter[][], binds: unknown[]) {
  const ors: string[] = [];
  for (const g of groups) {
    const ands: string[] = [];
    for (const f of g) ands.push(await filterSql(meta, ctx, type, f, binds));
    if (ands.length) ors.push(`(${ands.join(' AND ')})`);
  }
  return ors.length ? `(${ors.join(' OR ')})` : null;
}

// Etiquetas que le tocan a cada registro de una lista: una consulta por etiqueta, todas en un solo viaje.
export async function tagsFor(db: D1Database, ctx: Ctx, type: ObjectType, ids: number[]) {
  const meta = new Meta(db);
  const tags = await meta.tags(type);
  const out = new Map<number, number[]>();
  if (!tags.length || !ids.length) return out;
  const stmts: D1PreparedStatement[] = [];
  for (const t of tags) {
    const binds: unknown[] = [JSON.stringify(ids)];
    const cond = await tagSql(meta, ctx, t, binds);
    stmts.push(db.prepare(`SELECT r.id FROM records r WHERE r.id IN (SELECT value FROM json_each(?)) AND ${cond}`).bind(...binds));
  }
  const res = await db.batch(stmts);
  res.forEach((r, i) => { for (const row of r.results as Array<{ id: number }>) out.set(row.id, [...(out.get(row.id) ?? []), tags[i].id]); });
  return out;
}

// Unidades de negocio (Formas Shop, Corporate, NoEstres): el negocio, por el equipo de su pipeline; el pedido, por la unidad
// que trae ClickUp; contactos, empresas y tareas, por el equipo de su propietario (el principal o uno de los extra).
export const UNIDADES: Record<string, { team: number; pedido: string[] }> = {
  shop: { team: 57132078, pedido: ['FORMAS SHOP'] },
  corporate: { team: 58079782, pedido: ['CORPORATE'] },
  noestres: { team: 57393663, pedido: ['NO ESTRÉS', 'NO ESTRES', 'NOESTRES'] },
};

export function ownersOfUnitsSql(keys: string[], binds: unknown[], col = 'r.owner_id') {
  const teams = keys.map((k) => UNIDADES[k].team);
  const ph = teams.map(() => '?').join(', ');
  binds.push(...teams, ...teams);
  return `${col} IN (SELECT u.id FROM users u WHERE u.team_id IN (${ph}) OR EXISTS (SELECT 1 FROM json_each(COALESCE(u.extra_teams, '[]')) j WHERE j.value IN (${ph})))`;
}

function unidadSql(type: ObjectType, keys: string[], binds: unknown[]) {
  if (!keys.length) return '0';
  if (type === 'deal') {
    const teams = keys.map((k) => UNIDADES[k].team);
    binds.push(...teams);
    return `r.pipeline_id IN (SELECT id FROM pipelines WHERE team_id IN (${teams.map(() => '?').join(', ')}))`;
  }
  if (type === 'order') {
    const vals = keys.flatMap((k) => UNIDADES[k].pedido);
    binds.push(...vals);
    return `UPPER(COALESCE(json_extract(r.props, '$.unidad_de_negocio'), '')) IN (${vals.map(() => '?').join(', ')})`;
  }
  return ownersOfUnitsSql(keys, binds);
}

async function filterSql(meta: Meta, ctx: Ctx, type: ObjectType, f: Filter, binds: unknown[]): Promise<string> {
  if (f.prop === '__unidad') {
    const want = (f.values ?? String(f.value ?? '').split(';')).map(String).filter((k) => UNIDADES[k]);
    const cond = `(${unidadSql(type, want, binds)})`;
    return ['neq', 'not_in'].includes(f.op) ? `NOT ${cond}` : cond;
  }
  // Por etiqueta: «tiene la etiqueta X» es cumplir su regla.
  if (f.prop === '__tag') {
    const all = await meta.tags(type);
    const want = f.op === 'known' || f.op === 'unknown' ? all.map((t) => String(t.id)) : (f.values ?? String(f.value ?? '').split(';')).map(String);
    const conds: string[] = [];
    for (const t of all.filter((x) => want.includes(String(x.id)))) conds.push(await tagSql(meta, ctx, t, binds));
    const any = conds.length ? `(${conds.join(' OR ')})` : '0';
    return ['neq', 'not_in', 'unknown'].includes(f.op) ? `NOT ${any}` : any;
  }
  // Por un dato del registro asociado («empresa.tipo_de_empresa_cotizacion»): alguno de sus asociados de ese tipo lo cumple.
  const dot = f.prop.indexOf('.');
  if (dot > 0 && ASSOC_PREFIX[f.prop.slice(0, dot)]) {
    const other = ASSOC_PREFIX[f.prop.slice(0, dot)];
    const inner: unknown[] = [];
    const cond = (await filterSql(meta, ctx, other, { ...f, prop: f.prop.slice(dot + 1) }, inner)).replace(/\br\./g, 'x.');
    binds.push(other, ...inner);
    return `EXISTS (SELECT 1 FROM associations ax JOIN records x ON x.id = ax.to_id AND x.archived = 0 WHERE ax.from_id = r.id AND ax.to_type = ? AND ${cond})`;
  }
  const { expr, numeric } = await sqlFor(meta, type, f.prop);
  const val = (v: unknown) => {
    if (v === 'me') return ctx.user.id;
    if (numeric && v !== null && v !== '' && !Number.isNaN(Number(v))) return Number(v);
    return v;
  };
  const day = 86_400_000;
  switch (f.op) {
    case 'eq': binds.push(val(f.value)); return `${expr} = ?`;
    case 'neq': binds.push(val(f.value)); return `(${expr} IS NULL OR ${expr} != ?)`;
    case 'contains': binds.push(`%${f.value}%`); return `${expr} LIKE ?`;
    case 'not_contains': binds.push(`%${f.value}%`); return `(${expr} IS NULL OR ${expr} NOT LIKE ?)`;
    case 'in':
    case 'not_in': {
      const raw = f.values ?? String(f.value ?? '').split(';');
      // Propietario: «none» es «Sin asignar» y se puede elegir junto con otros (filtro rápido de varios propietarios).
      const withNull = f.op === 'in' && f.prop === 'owner_id' && raw.includes('none');
      const vs = raw.filter((v) => !(withNull && v === 'none')).map(val);
      const empty = `(${expr} IS NULL OR ${expr} = '')`;
      if (!vs.length) return f.op === 'in' ? (withNull ? empty : '0') : '1';
      binds.push(...vs);
      const list = vs.map(() => '?').join(', ');
      return f.op === 'in' ? (withNull ? `(${expr} IN (${list}) OR ${empty})` : `${expr} IN (${list})`) : `(${expr} IS NULL OR ${expr} NOT IN (${list}))`;
    }
    case 'gt': binds.push(val(f.value)); return `${expr} > ?`;
    case 'gte': binds.push(val(f.value)); return `${expr} >= ?`;
    case 'lt': binds.push(val(f.value)); return `${expr} < ?`;
    case 'lte': binds.push(val(f.value)); return `${expr} <= ?`;
    case 'between': binds.push(val(f.value), val(f.high)); return `${expr} BETWEEN ? AND ?`;
    case 'known': return `(${expr} IS NOT NULL AND ${expr} != '')`;
    case 'unknown': return `(${expr} IS NULL OR ${expr} = '')`;
    case 'within_last': binds.push(new Date(Date.now() - Number(f.value) * day).toISOString(), now()); return `${expr} BETWEEN ? AND ?`;
    case 'within_next': binds.push(now(), new Date(Date.now() + Number(f.value) * day).toISOString()); return `${expr} BETWEEN ? AND ?`;
    case 'before_days_ago': binds.push(new Date(Date.now() - Number(f.value) * day).toISOString()); return `(${expr} IS NULL OR ${expr} < ?)`;
    default: throw new HttpError(400, `Operador desconocido: ${(f as Filter).op}`);
  }
}

// Arma el WHERE de una búsqueda (texto, asociación y filtros Y/O). Lo usan la búsqueda y el tablero.
export async function buildWhere(meta: Meta, ctx: Ctx, type: ObjectType, params: SearchParams) {
  const binds: unknown[] = [type];
  const where = ['r.object_type = ?'];
  if (type === 'deal') {
    const visible = await visiblePipelineIds(meta, ctx.user);
    if (visible) { where.push('r.pipeline_id IN (SELECT value FROM json_each(?))'); binds.push(JSON.stringify(visible)); }
  }
  if (!params.includeArchived) where.push('r.archived = 0');
  if (params.q?.trim()) {
    const q = params.q.trim();
    const digits = q.replace(/\D/g, '');
    const parts = ['r.name LIKE ?', 'r.email LIKE ?', 'r.domain LIKE ?', "json_extract(r.props, '$.company') LIKE ?"];
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    if (digits.length >= 6) { parts.push('r.phone LIKE ?'); binds.push(`%${digits.slice(-10)}%`); }
    if (/^\d+$/.test(q)) { parts.push('r.id = ?'); binds.push(Number(q)); }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (params.associatedWith) {
    where.push('r.id IN (SELECT to_id FROM associations WHERE from_id = ?)');
    binds.push(params.associatedWith);
  }
  const groups = params.groups?.length ? params.groups : params.filters?.length ? [params.filters] : [];
  const g = await groupsSql(meta, ctx, type, groups, binds);
  if (g) where.push(g);
  return { whereSql: where.join(' AND '), binds };
}

export async function searchRecords(db: D1Database, ctx: Ctx, type: ObjectType, params: SearchParams & { noCount?: boolean }) {
  const meta = new Meta(db);
  const { whereSql, binds } = await buildWhere(meta, ctx, type, params);
  const sortProp = params.sort || 'hs_lastmodifieddate';
  const { expr: sortExpr } = await sqlFor(meta, type, sortProp);
  const dir = params.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 500);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const listSql = db.prepare(`SELECT r.* FROM records r WHERE ${whereSql} ORDER BY ${sortExpr} IS NULL, ${sortExpr} ${dir}, r.id DESC LIMIT ${limit} OFFSET ${offset}`).bind(...binds);
  if (params.noCount) {
    const { results } = await listSql.all<RecordRow>();
    return { results: results.map(rowToRecord), total: results.length, offset, limit };
  }
  const [list, count] = await db.batch([listSql, db.prepare(`SELECT COUNT(*) AS n FROM records r WHERE ${whereSql}`).bind(...binds)]);
  const rows = list.results as unknown as RecordRow[];
  return { results: rows.map(rowToRecord), total: (count.results[0] as { n: number }).n, offset, limit };
}

// ---------- Fechas de actividad (Última actividad / Último contacto / Próxima actividad) ----------

export async function refreshActivityDates(db: D1Database, recordIds: number[]) {
  const ids = [...new Set(recordIds)].filter(Boolean);
  if (!ids.length) return;
  const ts = now();
  const stmts = ids.map((id) => db.prepare(`UPDATE records SET
    last_activity_at = (SELECT MAX(a.occurred_at) FROM activities a JOIN activity_links l ON l.activity_id = a.id
      WHERE l.record_id = ?1 AND a.archived = 0 AND a.type != 'task' AND a.occurred_at <= ?2),
    last_contacted_at = (SELECT MAX(a.occurred_at) FROM activities a JOIN activity_links l ON l.activity_id = a.id
      WHERE l.record_id = ?1 AND a.archived = 0 AND a.type IN ('email', 'call', 'meeting', 'whatsapp') AND a.occurred_at <= ?2
      AND (a.type != 'email' OR a.direction = 'out')),
    next_activity_at = (SELECT MIN(COALESCE(a.due_at, a.occurred_at)) FROM activities a JOIN activity_links l ON l.activity_id = a.id
      WHERE l.record_id = ?1 AND a.archived = 0 AND ((a.type = 'task' AND a.status != 'COMPLETED') OR (a.type = 'meeting' AND a.occurred_at > ?2)))
    WHERE id = ?1`).bind(id, ts));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}
