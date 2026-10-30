#!/usr/bin/env node
// Migración HubSpot → Formas CRM.
//
// Lee todo de HubSpot con un token de app privada y lo carga en el CRM por /api/migrate (token de administrador).
// Es repetible: se puede correr varias veces antes del corte (y con --since como sincronización diaria)
// sin pisar lo que ya se editó en el CRM.
//
//   HUBSPOT_TOKEN=pat-…  CRM_URL=https://crm.formas…  CRM_TOKEN=fcrm_…  node scripts/migrate-hubspot.mjs
//
// Opciones:
//   --since=2026-10-01   solo registros y actividades modificados desde esa fecha (sincronización incremental)
//   --only=contacts,deals,emails   limitar a algunos objetos (users, config, contacts, companies, deals, orders,
//                                  associations, notes, calls, emails, meetings, tasks, communications, finalize)
//   --limit=200          tope por objeto (para pruebas)
//   --dry                no escribe en el CRM, solo cuenta
//   --hubspot-url=…      otra URL base de la API de HubSpot (para pruebas)
//
// Alcances que necesita la app privada de HubSpot: crm.objects.contacts/companies/deals/orders.read,
// crm.objects.owners.read, crm.schemas.*.read, sales-email-read (cuerpo de los mails) y e-commerce (pedidos).

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const HS = (args['hubspot-url'] ?? 'https://api.hubapi.com').replace(/\/$/, '');
const HS_TOKEN = process.env.HUBSPOT_TOKEN;
const CRM = (process.env.CRM_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const CRM_TOKEN = process.env.CRM_TOKEN;
const DRY = !!args.dry;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const SINCE = args.since ? new Date(args.since).getTime() : null;
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);

if (!HS_TOKEN) { console.error('Falta HUBSPOT_TOKEN.'); process.exit(1); }
if (!CRM_TOKEN && !DRY) { console.error('Falta CRM_TOKEN (token de administrador del CRM).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function hs(method, path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${HS}${path}`, {
      method, headers: { authorization: `Bearer ${HS_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HubSpot ${method} ${path}: ${res.status} ${data.message ?? ''}`);
    await sleep(110); // ~9 pedidos por segundo, debajo del límite de apps privadas
    return data;
  }
  throw new Error(`HubSpot ${method} ${path}: demasiados reintentos`);
}

async function crm(kind, items = [], extra = {}) {
  if (DRY) return { ok: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${CRM}/api/migrate`, {
      method: 'POST', headers: { authorization: `Bearer ${CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind, items, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status < 500) throw new Error(`CRM ${kind}: ${res.status} ${data.error ?? ''}`);
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`CRM ${kind}: falló después de reintentos`);
}

async function inChunks(items, size, kind) {
  for (let i = 0; i < items.length; i += size) await crm(kind, items.slice(i, i + size));
}

// Todos los objetos de un tipo (o los modificados desde --since), con propiedades y asociaciones.
async function* listAll(type, properties, associations = []) {
  let after;
  let n = 0;
  if (SINCE) {
    const modified = ['contacts'].includes(type) ? 'lastmodifieddate' : 'hs_lastmodifieddate';
    do {
      const page = await hs('POST', `/crm/v3/objects/${type}/search`, {
        filterGroups: [{ filters: [{ propertyName: modified, operator: 'GTE', value: String(SINCE) }] }],
        properties, limit: 100, after, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      });
      for (const r of page.results) { if (n++ >= LIMIT) return; yield r; }
      after = page.paging?.next?.after;
      if (after && Number(after) >= 10000) { log(`  ${type}: el buscador de HubSpot corta en 10.000; usá un --since más corto`); break; }
    } while (after);
    if (associations.length) log(`  (con --since las asociaciones de ${type} se leen aparte)`);
    return;
  }
  do {
    const q = new URLSearchParams({ limit: '100', properties: properties.join(','), archived: 'false' });
    if (associations.length) q.set('associations', associations.join(','));
    if (after) q.set('after', after);
    const page = await hs('GET', `/crm/v3/objects/${type}?${q}`);
    for (const r of page.results) { if (n++ >= LIMIT) return; yield r; }
    after = page.paging?.next?.after;
  } while (after);
}

const iso = (v) => {
  if (v == null || v === '') return null;
  const d = /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const stripHtml = (s) => String(s ?? '')
  .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();
const linksOf = (r) => Object.values(r.associations ?? {}).flatMap((a) => (a.results ?? []).map((x) => Number(x.id)));

const stats = {};
const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };

// ---------- 1. Usuarios (propietarios) ----------
if (want('users')) {
  log('Propietarios…');
  const users = [];
  for (const archived of ['false', 'true']) {
    let after;
    do {
      const page = await hs('GET', `/crm/v3/owners?limit=100&archived=${archived}${after ? `&after=${after}` : ''}`);
      for (const o of page.results) {
        if (!o.email) continue;
        users.push({ hs_owner_id: o.id, email: o.email, name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email, active: archived === 'false', team_hs_id: o.teams?.find((t) => t.primary)?.id ?? o.teams?.[0]?.id ?? null, team_hs_ids: (o.teams ?? []).map((t) => t.id) });
      }
      after = page.paging?.next?.after;
    } while (after);
  }
  await crm('users', users);
  bump('users', users.length);
}

// ---------- 2. Pipelines y propiedades ----------
const STAGE_IDS = [];
if (want('config') || want('deals')) {
  log('Pipelines…');
  const pipes = await hs('GET', '/crm/v3/pipelines/deals');
  const items = pipes.results.map((p) => ({
    id: p.id, label: p.label, display_order: p.displayOrder,
    stages: p.stages.map((s) => {
      STAGE_IDS.push(s.id);
      const prob = Number(s.metadata?.probability ?? 0);
      const closed = s.metadata?.isClosed === 'true';
      return { id: s.id, label: s.label, display_order: s.displayOrder, probability: prob, is_closed: closed, is_won: closed && prob === 1 };
    }),
  }));
  if (want('config')) await crm('pipelines', items);
}

// Propiedades que el CRM conoce (después de sincronizar), con los nombres de HubSpot.
const CRM_TYPES = { contacts: 'contact', companies: 'company', deals: 'deal', orders: 'order' };
let crmProps = null;
async function loadCrmProps() {
  if (!CRM_TOKEN) return null;
  const res = await fetch(`${CRM}/api/meta`, { headers: { authorization: `Bearer ${CRM_TOKEN}` } });
  if (!res.ok) throw new Error(`CRM /api/meta: ${res.status}`);
  const meta = await res.json();
  return meta.properties.reduce((acc, p) => ((acc[p.object_type] ??= []).push(p.name === 'owner_id' ? 'hubspot_owner_id' : p.name), acc), {});
}

const PROPS = {};
for (const type of ['contacts', 'companies', 'deals', 'orders']) {
  if (!want('config') && !want(type)) continue;
  let defs = [];
  try { defs = (await hs('GET', `/crm/v3/properties/${type}`)).results; } catch (e) { log(`  sin acceso a propiedades de ${type}: ${e.message}`); continue; }
  // Se traen las propiedades propias (sin hs_) y las de HubSpot que el CRM ya conoce.
  const custom = defs.filter((d) => !d.name.startsWith('hs_') && !d.hubspotDefined && !d.calculated);
  if (want('config')) {
    await crm('properties', [...custom, ...defs.filter((d) => d.type === 'enumeration')].map((d) => ({
      object_type: type, name: d.name, label: d.label, type: d.type, fieldType: d.fieldType, description: d.description, options: d.options?.filter((o) => !o.hidden),
    })));
  }
  PROPS[type] = defs.filter((d) => !d.name.startsWith('hs_') && !d.calculated).map((d) => d.name);
}
crmProps = await loadCrmProps();
if (crmProps) for (const type of Object.keys(PROPS)) PROPS[type] = crmProps[CRM_TYPES[type]] ?? PROPS[type];

// ---------- 3. Registros ----------
const EXTRA = {
  contacts: ['createdate', 'lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1'],
  companies: ['createdate', 'hs_lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1'],
  deals: ['createdate', 'hs_lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1', 'hs_v2_date_entered_current_stage'],
  orders: ['hs_createdate', 'hs_lastmodifieddate', 'hs_object_source_label'],
};
const ASSOC = { contacts: ['companies'], deals: ['contacts', 'companies'], orders: ['contacts', 'deals'], companies: ['companies'] };

for (const type of ['companies', 'contacts', 'deals', 'orders']) {
  if (!want(type) || !PROPS[type]) continue;
  log(`${type}…`);
  const props = [...new Set([...PROPS[type], ...EXTRA[type], ...(type === 'deals' ? STAGE_IDS.map((s) => `hs_v2_date_entered_${s}`) : [])])];
  const useProps = props;
  let batch = [];
  const assocBatch = [];
  for await (const r of listAll(type, useProps, SINCE ? [] : ASSOC[type])) {
    const p = r.properties ?? {};
    const history = {};
    if (type === 'deals') for (const s of STAGE_IDS) if (p[`hs_v2_date_entered_${s}`]) history[s] = iso(p[`hs_v2_date_entered_${s}`]);
    batch.push({
      type, hs_id: r.id, props: p, archived: !!r.archived,
      created_at: iso(p.createdate ?? p.hs_createdate ?? r.createdAt), updated_at: iso(p.hs_lastmodifieddate ?? p.lastmodifieddate ?? r.updatedAt),
      source_label: p.hs_object_source_label, source_detail: p.hs_object_source_detail_1,
      stage_entered_at: iso(p.hs_v2_date_entered_current_stage), stage_history: history,
    });
    for (const [toType, a] of Object.entries(r.associations ?? {})) {
      for (const x of a.results ?? []) {
        // La empresa principal se marca después con la API v4 (trae la etiqueta "Primary").
        assocBatch.push({ from: r.id, to: x.id, primary: false });
        void toType;
      }
    }
    if (batch.length >= 100) { await crm('records', batch); bump(type, batch.length); batch = []; process.stdout.write('.'); }
  }
  if (batch.length) { await crm('records', batch); bump(type, batch.length); }
  process.stdout.write('\n');
  if (assocBatch.length && want('associations') !== false) { await inChunks(assocBatch, 200, 'associations'); bump(`${type}_associations`, assocBatch.length); }
}

// Empresa principal de contactos y negocios (v4 trae el tipo "Primary").
if (want('associations') && !SINCE) {
  log('Empresas principales…');
  for (const from of ['contacts', 'deals']) {
    const ids = [];
    for await (const r of listAll(from, ['hs_object_id'])) ids.push(r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const res = await hs('POST', `/crm/v4/associations/${from}/companies/batch/read`, { inputs: ids.slice(i, i + 100).map((id) => ({ id })) });
      const items = [];
      for (const row of res.results ?? []) {
        for (const t of row.to ?? []) {
          const primary = (t.associationTypes ?? []).some((x) => x.label === 'Primary' || x.typeId === 1 || x.typeId === 5);
          items.push({ from: row.from.id, to: t.toObjectId, primary });
        }
      }
      if (items.length) await crm('associations', items);
    }
  }
}

// ---------- 4. Actividades ----------
const ENG = {
  notes: { type: 'note', props: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
  calls: { type: 'call', props: ['hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_call_disposition', 'hs_call_direction', 'hs_call_duration', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
  emails: { type: 'email', props: ['hs_timestamp', 'hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_direction', 'hs_email_from_email', 'hs_email_to_email', 'hs_email_cc_email', 'hs_email_thread_id', 'hs_email_open_count', 'hs_email_click_count', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
  meetings: { type: 'meeting', props: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_location', 'hs_meeting_outcome', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
  tasks: { type: 'task', props: ['hs_timestamp', 'hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_task_type', 'hs_task_completion_date', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
  communications: { type: 'whatsapp', props: ['hs_timestamp', 'hs_communication_channel_type', 'hs_communication_body', 'hs_communication_logged_from', 'hubspot_owner_id', 'hs_createdate', 'hs_lastmodifieddate'] },
};
const DISPOSITIONS = {
  'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Conectada', '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Ocupado', '73a0d17f-1163-4015-bdd5-ec830791da20': 'No atendió',
  'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Dejó mensaje', 'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Dejó mensaje', '17b47fee-58de-441e-a44c-c6300d46f273': 'Número equivocado',
};

for (const [hsType, cfg] of Object.entries(ENG)) {
  if (!want(hsType)) continue;
  log(`${hsType}…`);
  let batch = [];
  try {
    for await (const r of listAll(hsType, cfg.props, ['contacts', 'companies', 'deals'])) {
      const p = r.properties ?? {};
      const links = linksOf(r);
      const base = { hs_id: r.id, type: cfg.type, owner_hs: p.hubspot_owner_id, created_at: iso(p.hs_createdate ?? r.createdAt), updated_at: iso(p.hs_lastmodifieddate ?? r.updatedAt), links };
      let a;
      if (hsType === 'notes') a = { ...base, occurred_at: iso(p.hs_timestamp), body: stripHtml(p.hs_note_body) };
      if (hsType === 'calls') a = { ...base, occurred_at: iso(p.hs_timestamp), subject: p.hs_call_title ?? '', body: stripHtml(p.hs_call_body), outcome: DISPOSITIONS[p.hs_call_disposition] ?? null, direction: p.hs_call_direction === 'INBOUND' ? 'in' : 'out', meta: { duration_ms: p.hs_call_duration ? Number(p.hs_call_duration) : undefined } };
      if (hsType === 'emails') a = { ...base, occurred_at: iso(p.hs_timestamp), subject: p.hs_email_subject ?? '', body: p.hs_email_text || stripHtml(p.hs_email_html), direction: p.hs_email_direction === 'INCOMING_EMAIL' ? 'in' : 'out', thread_id: p.hs_email_thread_id ?? null, meta: { from: p.hs_email_from_email, to: p.hs_email_to_email, cc: p.hs_email_cc_email, opens: Number(p.hs_email_open_count ?? 0), clicks: Number(p.hs_email_click_count ?? 0) } };
      if (hsType === 'meetings') a = { ...base, occurred_at: iso(p.hs_meeting_start_time ?? p.hs_timestamp), subject: p.hs_meeting_title ?? '', body: stripHtml(p.hs_meeting_body), outcome: p.hs_meeting_outcome ?? null, meta: { end_at: iso(p.hs_meeting_end_time), location: p.hs_meeting_location } };
      if (hsType === 'tasks') a = { ...base, occurred_at: iso(p.hs_createdate ?? p.hs_timestamp), due_at: iso(p.hs_timestamp), subject: p.hs_task_subject ?? '(sin título)', body: stripHtml(p.hs_task_body), status: p.hs_task_status ?? 'NOT_STARTED', completed_at: iso(p.hs_task_completion_date), priority: (p.hs_task_priority ?? 'NONE').toLowerCase(), task_type: (p.hs_task_type ?? 'TODO').toLowerCase() };
      if (hsType === 'communications') {
        if (p.hs_communication_channel_type && p.hs_communication_channel_type !== 'WHATS_APP') a = { ...base, type: 'note', occurred_at: iso(p.hs_timestamp), body: `${p.hs_communication_channel_type}: ${stripHtml(p.hs_communication_body)}` };
        else a = { ...base, occurred_at: iso(p.hs_timestamp), body: stripHtml(p.hs_communication_body), direction: 'out' };
      }
      batch.push(a);
      if (batch.length >= 100) { await crm('activities', batch); bump(hsType, batch.length); batch = []; process.stdout.write('.'); }
    }
  } catch (e) {
    log(`  ${hsType}: ${e.message} (se sigue con lo demás)`);
  }
  if (batch.length) { await crm('activities', batch); bump(hsType, batch.length); }
  process.stdout.write('\n');
}

// ---------- 5. Recalcular fechas de actividad ----------
if (want('finalize') && !DRY) {
  log('Recalculando última y próxima actividad…');
  let offset = 0;
  for (;;) {
    const r = await crm('finalize', [], { offset, limit: 2000 });
    if (r.done) break;
    offset = r.next;
  }
}

log('Listo.', JSON.stringify(stats));
if (!DRY) log('En el CRM:', JSON.stringify(await crm('stats')));
