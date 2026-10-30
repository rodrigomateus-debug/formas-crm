import type { Ctx } from './env';
import { HttpError } from './env';
import { createRecord, updateRecord, normDomain, normPhone, emailDomain, rowToRecord, type Props, type RecordRow } from './records';
import { associate, primaryCompanyId } from './associations';
import { createActivity, type ActivityInput } from './activities';

// Alta "inteligente" para integraciones (Darwin, Zapier, formularios, Claude): busca antes de crear,
// completa solo lo vacío y asocia contacto ↔ empresa ↔ negocio.

export async function findContact(db: D1Database, p: Props) {
  if (p.email) {
    const r = await db.prepare("SELECT * FROM records WHERE object_type = 'contact' AND archived = 0 AND email = ? LIMIT 1").bind(String(p.email).toLowerCase()).first<RecordRow>();
    if (r) return r;
  }
  for (const k of ['phone', 'mobilephone', 'hs_whatsapp_phone_number']) {
    const ph = normPhone(p[k]);
    if (ph) {
      const r = await db.prepare("SELECT * FROM records WHERE object_type = 'contact' AND archived = 0 AND phone = ? ORDER BY updated_at DESC LIMIT 1").bind(ph).first<RecordRow>();
      if (r) return r;
    }
  }
  return null;
}

export async function findCompany(db: D1Database, p: Props) {
  const d = normDomain(p.domain || p.website);
  if (d) {
    const r = await db.prepare("SELECT * FROM records WHERE object_type = 'company' AND archived = 0 AND domain = ? LIMIT 1").bind(d).first<RecordRow>();
    if (r) return r;
  }
  if (p.name) {
    const r = await db.prepare("SELECT * FROM records WHERE object_type = 'company' AND archived = 0 AND name = ? COLLATE NOCASE LIMIT 1").bind(String(p.name).trim()).first<RecordRow>();
    if (r) return r;
  }
  return null;
}

// Completa solo propiedades vacías (no pisa lo que cargó una vendedora), salvo `overwrite`.
async function fillEmpty(db: D1Database, ctx: Ctx, row: RecordRow, p: Props, overwrite = false) {
  const cur = JSON.parse(row.props) as Props;
  const patch: Props = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === '') continue;
    if (overwrite || cur[k] == null || cur[k] === '') patch[k] = v;
  }
  if (!Object.keys(patch).length) return row;
  return updateRecord(db, ctx, row.object_type, row.id, patch, { strict: false });
}

export async function upsertContact(db: D1Database, ctx: Ctx, p: Props, opts: { overwrite?: boolean; autoCompany?: boolean } = {}) {
  const found = await findContact(db, p);
  if (found) return { row: await fillEmpty(db, ctx, found, p, opts.overwrite), created: false };
  const row = await createRecord(db, ctx, 'contact', p, { strict: false, skipDedupe: true });
  // Como el ajuste de HubSpot "crear y asociar empresas con contactos": por dominio del mail corporativo.
  if (opts.autoCompany !== false) {
    const dom = emailDomain(p.email);
    if (dom) {
      let company = await findCompany(db, { domain: dom });
      if (!company) {
        const guess = dom.split('.')[0];
        company = await createRecord(db, ctx, 'company', { name: guess.charAt(0).toUpperCase() + guess.slice(1), domain: dom, owner_id: p.owner_id ?? null }, { strict: false, skipDedupe: true });
      }
      await associate(db, ctx, row.id, company.id);
    }
  }
  return { row, created: true };
}

export async function upsertCompany(db: D1Database, ctx: Ctx, p: Props, opts: { overwrite?: boolean } = {}) {
  const found = await findCompany(db, p);
  if (found) return { row: await fillEmpty(db, ctx, found, p, opts.overwrite), created: false };
  if (!p.name && !p.domain) throw new HttpError(400, 'Para crear una empresa hace falta nombre o dominio.');
  return { row: await createRecord(db, ctx, 'company', p, { strict: false, skipDedupe: true }), created: true };
}

export interface Bundle {
  contact?: Props;
  company?: Props;
  deal?: Props & { dedupe_open?: boolean };
  note?: string;
  activity?: Omit<ActivityInput, 'links'>;
  task?: Omit<ActivityInput, 'links' | 'type'>;
  owner_id?: number;
}

// Un paquete: contacto + empresa + negocio + nota/tarea, todo asociado. Lo usan los webhooks y el MCP.
export async function applyBundle(db: D1Database, ctx: Ctx, b: Bundle) {
  const out: Record<string, unknown> = {};
  const ids: number[] = [];
  let contactId: number | null = null;
  let companyId: number | null = null;
  if (b.owner_id) for (const part of [b.contact, b.company, b.deal]) if (part && part.owner_id == null) part.owner_id = b.owner_id;
  if (b.company && Object.values(b.company).some((v) => v != null && v !== '')) {
    const r = await upsertCompany(db, ctx, b.company);
    companyId = r.row.id;
    ids.push(companyId);
    out.company = { id: companyId, created: r.created, name: r.row.name };
  }
  if (b.contact && Object.values(b.contact).some((v) => v != null && v !== '')) {
    const r = await upsertContact(db, ctx, b.contact, { autoCompany: !companyId });
    contactId = r.row.id;
    ids.push(contactId);
    out.contact = { id: contactId, created: r.created, name: r.row.name };
    if (companyId) await associate(db, ctx, contactId, companyId);
    else companyId = await primaryCompanyId(db, contactId);
  }
  if (b.deal) {
    const { dedupe_open, ...dealProps } = b.deal;
    let dealRow: RecordRow | null = null;
    // Darwin manda varias veces la misma conversación: si el contacto ya tiene un negocio abierto en ese pipeline, se actualiza.
    if (dedupe_open && contactId) {
      dealRow = await db.prepare(
        `SELECT d.* FROM associations a JOIN records d ON d.id = a.to_id JOIN stages s ON s.id = d.stage_id
         WHERE a.from_id = ? AND a.to_type = 'deal' AND d.archived = 0 AND s.is_closed = 0 AND (? IS NULL OR d.pipeline_id = ?)
         ORDER BY d.updated_at DESC LIMIT 1`,
      ).bind(contactId, dealProps.pipeline ?? null, dealProps.pipeline ?? null).first<RecordRow>();
    }
    if (dealRow) {
      const { dealstage: _s, pipeline: _p, ...rest } = dealProps;
      dealRow = await fillEmpty(db, ctx, dealRow, rest);
      out.deal = { id: dealRow.id, created: false, name: dealRow.name };
    } else {
      if (!dealProps.dealname) {
        dealProps.dealname = [(out.contact as { name?: string })?.name, (out.company as { name?: string })?.name].filter(Boolean).join(' · ') || 'Nuevo negocio';
      }
      dealRow = await createRecord(db, ctx, 'deal', dealProps, { strict: false });
      out.deal = { id: dealRow.id, created: true, name: dealRow.name };
    }
    ids.push(dealRow.id);
    if (contactId) await associate(db, ctx, dealRow.id, contactId);
    if (companyId) await associate(db, ctx, dealRow.id, companyId);
  }
  const links = ids;
  if (b.note) out.note = (await createActivity(db, ctx, { type: 'note', body: b.note, links, link_primary_company: false })).id;
  if (b.activity) out.activity = (await createActivity(db, ctx, { ...b.activity, links, link_primary_company: false })).id;
  if (b.task) out.task = (await createActivity(db, ctx, { ...b.task, type: 'task', links, link_primary_company: false })).id;
  return out;
}

export { rowToRecord };
