#!/usr/bin/env node
// Migración HubSpot → Formas CRM.
//
// Lee todo de HubSpot con un token de app privada y lo carga en el CRM por /hooks/migrate (token de administrador).
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
//   --owner=494686419    1 a 1 con el HubSpot de un vendedor (id de propietario o mail; varios separados por coma):
//                        todos sus contactos, empresas, negocios y pedidos, los registros asociados, todas las
//                        asociaciones (las que se sacaron allá se sacan acá), todas las actividades suyas o de sus
//                        registros, y archiva lo que ya no está en HubSpot. HubSpot manda (pisa lo editado en el CRM,
//                        salvo lo que es solo del CRM). Al final compara los totales de los dos lados.
//   --report=archivo.json  con --owner, deja el control en ese archivo
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
const OWNERS_1A1 = args.owner ? String(args.owner).split(',').map((x) => x.trim()).filter(Boolean) : [];
// Tipos y asociaciones del modo --owner.
const REC_TYPES = ['contacts', 'companies', 'deals', 'orders'];
const REC_ASSOC = { contacts: ['companies', 'deals', 'orders'], companies: ['contacts', 'deals', 'companies'], deals: ['contacts', 'companies', 'orders'], orders: ['contacts', 'companies', 'deals'] };
const CRM_TO_HS = { contact: 'contacts', company: 'companies', deal: 'deals', order: 'orders' };
const ACT_TO_HS = { note: ['notes', 'communications'], email: ['emails'], call: ['calls'], meeting: ['meetings'], task: ['tasks'], whatsapp: ['communications'] };

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

// El CRM siempre contesta JSON. Otra cosa (casi siempre la página de login de Cloudflare Access, con 200 o una
// redirección) quiere decir que el pedido no llegó al Worker: se corta con un mensaje claro y no con un error de JSON.
async function crmJson(res, what) {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error(`CRM ${what}: respondió ${res.status} ${type ? `(${type.split(';')[0]})` : 'sin content-type'} en vez de datos (¿el login de Cloudflare Access está tapando /hooks?).`);
  }
  return res.json();
}

async function crm(kind, items = [], extra = {}) {
  if (DRY) return { ok: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    // Por /hooks/migrate y no por /api/migrate: /api pide el login de Cloudflare Access y devuelve su página.
    const res = await fetch(`${CRM}/hooks/migrate`, {
      method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind, items, ...extra }),
    });
    const data = await crmJson(res, kind);
    if (res.ok) return data;
    if (res.status < 500) throw new Error(`CRM ${kind}: ${res.status} ${data.error ?? ''}`);
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`CRM ${kind}: falló después de reintentos`);
}

async function inChunks(items, size, kind) {
  for (let i = 0; i < items.length; i += size) await crm(kind, items.slice(i, i + size));
}

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Asociaciones (API v4) de muchos registros a la vez: { [fromId]: [{ to, primary }] }. Sigue la paginación de los que
// tienen más de las que entran en una respuesta (una empresa con miles de mails).
async function assocOf(from, to, ids) {
  const out = {};
  for (const part of chunks([...ids].map(String), 100)) {
    const res = await hs('POST', `/crm/v4/associations/${from}/${to}/batch/read`, { inputs: part.map((id) => ({ id })) });
    for (const row of res.results ?? []) {
      const fid = String(row.from.id);
      const list = (out[fid] ??= []);
      const push = (t) => list.push({ to: String(t.toObjectId), primary: (t.associationTypes ?? []).some((x) => x.label === 'Primary' || (from === 'contacts' && to === 'companies' && x.typeId === 1) || (from === 'deals' && to === 'companies' && x.typeId === 5)) });
      for (const t of row.to ?? []) push(t);
      let after = row.paging?.next?.after;
      while (after) {
        const page = await hs('GET', `/crm/v4/objects/${from}/${fid}/associations/${to}?limit=500&after=${encodeURIComponent(after)}`);
        for (const t of page.results ?? []) push(t);
        after = page.paging?.next?.after;
      }
    }
  }
  return out;
}

// Ids de un tipo que cumplen unos filtros, sin el tope de 10.000 del buscador: se avanza por hs_object_id.
async function searchIds(type, filters) {
  const ids = [];
  let last = '0';
  for (;;) {
    const page = await hs('POST', `/crm/v3/objects/${type}/search`, {
      filterGroups: [{ filters: [...filters, { propertyName: 'hs_object_id', operator: 'GT', value: last }] }],
      properties: ['hs_object_id'], limit: 200, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
    });
    const res = page.results ?? [];
    for (const r of res) ids.push(String(r.id));
    if (res.length < 200) break;
    last = String(res[res.length - 1].id);
  }
  return ids;
}

// Lee registros por id (los que no vuelven es porque ya no están: borrados o combinados).
async function batchRead(type, ids, properties) {
  const out = [];
  for (const part of chunks([...ids].map(String), 100)) {
    const res = await hs('POST', `/crm/v3/objects/${type}/batch/read`, { properties, inputs: part.map((id) => ({ id })) });
    out.push(...(res.results ?? []));
  }
  return out;
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
  // Por /hooks/migrate y no por /api/meta, igual que la carga: /api pide el login de Cloudflare Access.
  const res = await fetch(`${CRM}/hooks/migrate/properties`, { redirect: 'manual', headers: { authorization: `Bearer ${CRM_TOKEN}` } });
  const meta = await crmJson(res, 'propiedades');
  if (!res.ok) throw new Error(`CRM propiedades: ${res.status} ${meta.error ?? ''}`);
  return meta.properties.reduce((acc, p) => ((acc[p.object_type] ??= []).push(p.name === 'owner_id' ? 'hubspot_owner_id' : p.name), acc), {});
}

const PROPS = {};
const DE_FINNEGANS = new Set(['saldo_pendiente_de_pago_mxn']);
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
  // El saldo pendiente de los pedidos ya no viene de HubSpot: lo trae Finnegans (scripts/pedidos-totales.mjs).
  PROPS[type] = defs.filter((d) => !d.name.startsWith('hs_') && !d.calculated && !DE_FINNEGANS.has(d.name)).map((d) => d.name);
}
crmProps = await loadCrmProps();
if (crmProps) for (const type of Object.keys(PROPS)) PROPS[type] = (crmProps[CRM_TYPES[type]] ?? PROPS[type]).filter((p) => !DE_FINNEGANS.has(p));

// ---------- 3. Registros ----------
const EXTRA = {
  contacts: ['createdate', 'lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1'],
  companies: ['createdate', 'hs_lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1'],
  deals: ['createdate', 'hs_lastmodifieddate', 'hs_object_source_label', 'hs_object_source_detail_1', 'hs_v2_date_entered_current_stage'],
  orders: ['hs_createdate', 'hs_lastmodifieddate', 'hs_object_source_label'],
};
const ASSOC = { contacts: ['companies'], deals: ['contacts', 'companies'], orders: ['contacts', 'deals'], companies: ['companies'] };
const recordProps = (type) => [...new Set([...PROPS[type], ...EXTRA[type], ...(type === 'deals' ? STAGE_IDS.map((s) => `hs_v2_date_entered_${s}`) : [])])];
function recordItem(type, r) {
  const p = r.properties ?? {};
  const history = {};
  if (type === 'deals') for (const s of STAGE_IDS) if (p[`hs_v2_date_entered_${s}`]) history[s] = iso(p[`hs_v2_date_entered_${s}`]);
  return {
    type, hs_id: r.id, props: p, archived: !!r.archived,
    created_at: iso(p.createdate ?? p.hs_createdate ?? r.createdAt), updated_at: iso(p.hs_lastmodifieddate ?? p.lastmodifieddate ?? r.updatedAt),
    source_label: p.hs_object_source_label, source_detail: p.hs_object_source_detail_1,
    stage_entered_at: iso(p.hs_v2_date_entered_current_stage), stage_history: history,
  };
}
// Registros tocados con --since: el recálculo de última/próxima actividad va solo sobre ellos (y no sobre toda la base).
const TOUCHED = new Set();

for (const type of ['companies', 'contacts', 'deals', 'orders']) {
  if (OWNERS_1A1.length || !want(type) || !PROPS[type]) continue;
  log(`${type}…`);
  const useProps = recordProps(type);
  let batch = [];
  const assocBatch = [];
  const sinceIds = [];
  for await (const r of listAll(type, useProps, SINCE ? [] : ASSOC[type])) {
    batch.push(recordItem(type, r));
    if (SINCE) { sinceIds.push(r.id); TOUCHED.add(String(r.id)); }
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
  // Con --since las asociaciones no vienen en el listado: se leen con la API v4 (y se suman, no se reemplazan).
  if (SINCE && sinceIds.length && want('associations')) {
    for (const to of ASSOC[type] ?? []) {
      const map = await assocOf(type, to, sinceIds);
      for (const [from, list] of Object.entries(map)) for (const x of list) assocBatch.push({ from, to: x.to, primary: x.primary });
    }
  }
  if (assocBatch.length && want('associations') !== false) { await inChunks(assocBatch, 200, 'associations'); bump(`${type}_associations`, assocBatch.length); }
}

// Empresa principal de contactos y negocios (v4 trae el tipo "Primary").
if (want('associations') && !SINCE && !OWNERS_1A1.length) {
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

function activityItem(hsType, r, links) {
  const cfg = ENG[hsType];
  const p = r.properties ?? {};
  const base = { hs_id: r.id, type: cfg.type, owner_hs: p.hubspot_owner_id, created_at: iso(p.hs_createdate ?? r.createdAt), updated_at: iso(p.hs_lastmodifieddate ?? r.updatedAt), links };
  if (hsType === 'notes') return { ...base, occurred_at: iso(p.hs_timestamp), body: stripHtml(p.hs_note_body) };
  if (hsType === 'calls') return { ...base, occurred_at: iso(p.hs_timestamp), subject: p.hs_call_title ?? '', body: stripHtml(p.hs_call_body), outcome: DISPOSITIONS[p.hs_call_disposition] ?? null, direction: p.hs_call_direction === 'INBOUND' ? 'in' : 'out', meta: { duration_ms: p.hs_call_duration ? Number(p.hs_call_duration) : undefined } };
  if (hsType === 'emails') return { ...base, occurred_at: iso(p.hs_timestamp), subject: p.hs_email_subject ?? '', body: p.hs_email_text || stripHtml(p.hs_email_html), direction: p.hs_email_direction === 'INCOMING_EMAIL' ? 'in' : 'out', thread_id: p.hs_email_thread_id ?? null, meta: { from: p.hs_email_from_email, to: p.hs_email_to_email, cc: p.hs_email_cc_email, opens: Number(p.hs_email_open_count ?? 0), clicks: Number(p.hs_email_click_count ?? 0) } };
  if (hsType === 'meetings') return { ...base, occurred_at: iso(p.hs_meeting_start_time ?? p.hs_timestamp), subject: p.hs_meeting_title ?? '', body: stripHtml(p.hs_meeting_body), outcome: p.hs_meeting_outcome ?? null, meta: { end_at: iso(p.hs_meeting_end_time), location: p.hs_meeting_location } };
  if (hsType === 'tasks') return { ...base, occurred_at: iso(p.hs_createdate ?? p.hs_timestamp), due_at: iso(p.hs_timestamp), subject: p.hs_task_subject ?? '(sin título)', body: stripHtml(p.hs_task_body), status: p.hs_task_status ?? 'NOT_STARTED', completed_at: iso(p.hs_task_completion_date), priority: (p.hs_task_priority ?? 'NONE').toLowerCase(), task_type: (p.hs_task_type ?? 'TODO').toLowerCase() };
  // communications
  if (p.hs_communication_channel_type && p.hs_communication_channel_type !== 'WHATS_APP') return { ...base, type: 'note', occurred_at: iso(p.hs_timestamp), body: `${p.hs_communication_channel_type}: ${stripHtml(p.hs_communication_body)}` };
  return { ...base, occurred_at: iso(p.hs_timestamp), body: stripHtml(p.hs_communication_body), direction: 'out' };
}

// Contactos, empresas, negocios y pedidos de cada actividad: { [actividad]: [ids] }.
async function engagementLinks(hsType, ids) {
  const out = {};
  for (const to of ['contacts', 'companies', 'deals']) {
    const map = await assocOf(hsType, to, ids);
    for (const [from, list] of Object.entries(map)) (out[from] ??= []).push(...list.map((x) => Number(x.to)));
  }
  return out;
}

if (OWNERS_1A1.length) {
  for (const o of OWNERS_1A1) await syncOwner(o);
  log('Listo.', JSON.stringify(stats));
  process.exit(stats.diferencias ? 2 : 0);
}

for (const [hsType, cfg] of Object.entries(ENG)) {
  if (!want(hsType)) continue;
  log(`${hsType}…`);
  let batch = [];
  try {
    // Con --since las asociaciones no vienen en el listado: se leen con la API v4 antes de mandar cada tanda.
    const flush = async () => {
      if (SINCE && batch.length) {
        const links = await engagementLinks(hsType, batch.map((a) => a.hs_id));
        for (const a of batch) { a.links = links[a.hs_id] ?? []; for (const l of a.links) TOUCHED.add(String(l)); }
      }
      await crm('activities', batch); bump(hsType, batch.length); batch = [];
    };
    for await (const r of listAll(hsType, cfg.props, ['contacts', 'companies', 'deals'])) {
      batch.push(activityItem(hsType, r, linksOf(r)));
      if (batch.length >= 100) { await flush(); process.stdout.write('.'); }
    }
    if (batch.length) await flush();
  } catch (e) {
    log(`  ${hsType}: ${e.message} (se sigue con lo demás)`);
  }
  process.stdout.write('\n');
}

// ---------- 5. Recalcular fechas de actividad ----------
if (want('finalize') && !DRY && SINCE) {
  log(`Recalculando última y próxima actividad de ${TOUCHED.size} registros…`);
  for (const part of chunks([...TOUCHED], 2000)) await crm('finalize', [], { ids: part });
} else if (want('finalize') && !DRY) {
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

// ---------- 1 a 1 con el HubSpot de un vendedor (--owner) ----------
// HubSpot manda: lo que hay allá queda igual acá (registros, asociaciones, actividades) y lo que ya no está se archiva.

async function resolveOwner(o) {
  if (/^\d+$/.test(o)) {
    for (const archived of ['false', 'true']) {
      try { const r = await hs('GET', `/crm/v3/owners/${o}?idProperty=id&archived=${archived}`); if (r?.id) return r; } catch { /* sigue */ }
    }
    return { id: o };
  }
  const r = await hs('GET', `/crm/v3/owners?email=${encodeURIComponent(o)}&limit=1`);
  if (!r.results?.[0]) throw new Error(`No hay propietario de HubSpot con el mail ${o}`);
  return r.results[0];
}

async function upsertRecords(type, list) {
  for (const part of chunks(list, 50)) await crm('records', part.map((r) => recordItem(type, r)), { force: true });
}

async function syncOwner(o) {
  const owner = await resolveOwner(o);
  const oid = String(owner.id);
  const who = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || oid;
  log(`=== 1 a 1 con el HubSpot de ${who} (propietario ${oid}) ===`);
  const filtro = [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: oid }];

  // 1. Sus registros, y los que están asociados a ellos (una empresa de otro, el contacto de un negocio suyo…).
  const mine = {};
  for (const t of REC_TYPES) { mine[t] = new Set(await searchIds(t, filtro)); log(`  ${t}: ${mine[t].size} suyos`); }
  const links = {}; // fromId → [{ to, primary }] (todas las asociaciones de sus registros con otros de HubSpot)
  const related = Object.fromEntries(REC_TYPES.map((t) => [t, new Set()]));
  for (const t of REC_TYPES) {
    if (!mine[t].size) continue;
    for (const to of REC_ASSOC[t]) {
      const map = await assocOf(t, to, mine[t]);
      for (const [from, list] of Object.entries(map)) {
        (links[from] ??= []).push(...list);
        for (const x of list) if (!mine[to].has(x.to)) related[to].add(x.to);
      }
    }
  }
  // 2. Registros (con todas sus propiedades), primero empresas para que los contactos encuentren la suya.
  const fetched = {};
  for (const t of ['companies', 'contacts', 'deals', 'orders']) {
    const ids = [...mine[t], ...related[t]];
    if (!ids.length || !PROPS[t]) continue;
    fetched[t] = await batchRead(t, ids, recordProps(t));
    await upsertRecords(t, fetched[t]);
    bump(t, fetched[t].length);
    log(`  ${t}: ${fetched[t].length} cargados (${related[t].size} asociados de otros)`);
  }
  // 3. Asociaciones: las de sus registros quedan exactamente como en HubSpot.
  const scope = REC_TYPES.flatMap((t) => [...mine[t]]);
  for (const part of chunks(scope, 50)) {
    const items = part.flatMap((from) => (links[from] ?? []).map((x) => ({ from, to: x.to, primary: x.primary })));
    await crm('associations', items, { replace: part });
    bump('associations', items.length);
  }
  log(`  asociaciones: ${stats.associations ?? 0}`);

  // 4. Actividades: las suyas y todas las de sus contactos, empresas y negocios (aunque las haya cargado otro).
  const hsActs = {};
  for (const [hsType, cfg] of Object.entries(ENG)) {
   try {
    const ids = new Set(await searchIds(hsType, filtro));
    for (const t of ['contacts', 'companies', 'deals']) {
      if (!mine[t].size) continue;
      const map = await assocOf(t, hsType, mine[t]);
      for (const list of Object.values(map)) for (const x of list) ids.add(x.to);
    }
    // Lo que de verdad está en HubSpot es lo que se puede leer (una asociación puede quedar apuntando a algo borrado).
    const read = (hsActs[hsType] = new Set());
    let n = 0;
    for (const part of chunks([...ids], hsType === 'emails' ? 50 : 100)) {
      const rows = await batchRead(hsType, part, cfg.props);
      for (const r of rows) read.add(String(r.id));
      const lk = await engagementLinks(hsType, rows.map((r) => r.id));
      await crm('activities', rows.map((r) => activityItem(hsType, r, lk[r.id] ?? [])), { force: true, replace_links: true });
      n += rows.length;
      if (n % 1000 < 100) process.stdout.write('.');
    }
    bump(hsType, n);
    log(`  ${hsType}: ${n}`);
   } catch (e) {
    // Sin esto no se puede asegurar el 1 a 1: queda como diferencia en el control.
    log(`  ${hsType}: ${e.message}`);
    hsActs[hsType] ??= new Set(['?']);
    bump('diferencias');
   }
  }

  // 5. Lo que el CRM tiene a su nombre y HubSpot ya no: reasignado a otro (se actualiza) o borrado/combinado (se archiva).
  const crmSide = await crm('owned', [], { owner_hs: oid });
  const archive = [];
  const extraRecs = {};
  for (const r of crmSide.records) {
    const t = CRM_TO_HS[r.object_type];
    if (t && !mine[t].has(String(r.id))) (extraRecs[t] ??= []).push(String(r.id));
  }
  for (const [t, ids] of Object.entries(extraRecs)) {
    const rows = await batchRead(t, ids, recordProps(t));
    const found = new Set(rows.map((r) => String(r.id)));
    await upsertRecords(t, rows.filter((r) => ids.includes(String(r.id))));
    for (const id of ids) if (!found.has(id)) archive.push({ kind: 'record', id });
    log(`  ${t}: ${rows.length} pasaron a otro propietario, ${ids.length - found.size} ya no están en HubSpot`);
  }
  const allHsActs = new Set(Object.values(hsActs).flatMap((x) => [...x]));
  const extraActs = crmSide.activities.filter((a) => !allHsActs.has(String(a.id)));
  for (const [crmType, hsTypes] of Object.entries(ACT_TO_HS)) {
    let pending = extraActs.filter((a) => a.type === crmType).map((a) => String(a.id));
    for (const hsType of hsTypes) {
      if (!pending.length) break;
      const rows = await batchRead(hsType, pending, ENG[hsType].props);
      if (rows.length) {
        const lk = await engagementLinks(hsType, rows.map((r) => r.id));
        await crm('activities', rows.map((r) => activityItem(hsType, r, lk[r.id] ?? [])), { force: true, replace_links: true });
      }
      const found = new Set(rows.map((r) => String(r.id)));
      pending = pending.filter((id) => !found.has(id));
    }
    for (const id of pending) archive.push({ kind: 'activity', id });
  }
  if (archive.length) await inChunks(archive, 200, 'archive');
  bump('archivados', archive.length);
  log(`  archivados en el CRM (ya no están en HubSpot): ${archive.length}`);

  // 6. Última y próxima actividad de lo que se tocó.
  const touched = [...new Set([...scope, ...REC_TYPES.flatMap((t) => [...related[t]]), ...Object.values(extraRecs).flat()].map(String))];
  for (const part of chunks(touched, 2000)) await crm('finalize', [], { ids: part });

  // 7. Control: los totales de los dos lados tienen que dar igual.
  const after = await crm('owned', [], { owner_hs: oid });
  const crmCount = {};
  for (const r of after.records) crmCount[CRM_TO_HS[r.object_type]] = (crmCount[CRM_TO_HS[r.object_type]] ?? 0) + 1;
  const crmActIds = new Set(after.activities.map((a) => String(a.id)));
  const report = { owner: oid, nombre: who, fecha: new Date().toISOString(), registros: {}, actividades: {}, faltan_actividades: [] };
  for (const t of REC_TYPES) report.registros[t] = { hubspot: mine[t].size, crm: crmCount[t] ?? 0 };
  for (const [hsType, ids] of Object.entries(hsActs)) {
    const missing = [...ids].filter((id) => !crmActIds.has(id));
    report.actividades[hsType] = { hubspot: ids.size, crm: ids.size - missing.length };
    report.faltan_actividades.push(...missing.slice(0, 50).map((id) => `${hsType}:${id}`));
  }
  const dif = [...Object.entries(report.registros), ...Object.entries(report.actividades)].filter(([, v]) => v.hubspot !== v.crm);
  report.diferencias = dif.map(([k, v]) => `${k}: HubSpot ${v.hubspot} / CRM ${v.crm}`);
  bump('diferencias', dif.length);
  log('  Control HubSpot / CRM:');
  for (const [k, v] of [...Object.entries(report.registros), ...Object.entries(report.actividades)]) log(`    ${k.padEnd(15)} ${String(v.hubspot).padStart(6)} ${String(v.crm).padStart(6)} ${v.hubspot === v.crm ? 'OK' : '≠'}`);
  if (args.report) {
    const fs = await import('node:fs');
    const file = OWNERS_1A1.length > 1 ? String(args.report).replace(/\.json$/, `-${oid}.json`) : String(args.report);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  }
}
