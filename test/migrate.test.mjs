// Prueba de la migración contra un HubSpot simulado (mismas respuestas que la API v3/v4) y el CRM local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const run = promisify(execFile);
const seed = Date.now() % 1e6;
const id = (n) => String(70_000_000_000 + seed * 100 + n);

const OWNERS = [
  { id: '73383412', email: 'rodrigo.mateus@formaspublicitarias.com', firstName: 'Rodrigo', lastName: 'Mateus', teams: [{ id: '57132078', primary: true }] },
  { id: String(1_400_000_000 + seed), email: `vendedora${seed}@formas.ar`, firstName: 'Vende', lastName: `Dora ${seed}`, teams: [{ id: '58079782', primary: true }] },
  // Ya dada de alta en el CRM con su mail de formas.ar; en HubSpot figura con el de formaspublicitarias.com.
  { id: String(1_500_000_000 + seed), email: `otra${seed}@formaspublicitarias.com`, firstName: 'Otra', lastName: `Vendedora ${seed}`, teams: [{ id: '58079782', primary: true }] },
];
const COMPANY = { id: id(1), properties: { name: `Migrada SA ${seed}`, domain: `migrada${seed}.com.ar`, hubspot_owner_id: OWNERS[1].id, tipo_de_empresa_cotizacion: 'a_cotizacion_mensual', createdate: '2025-03-01T10:00:00Z', hs_lastmodifieddate: '2026-01-01T10:00:00Z', campo_nuevo_hs: 'valor raro' } };
const DARWIN_CONTACT = { id: id(7), properties: { firstname: 'Juan Pérez', lastname: 'Pérez', email: `incompleto549351${seed}@gmail.com`, mobilephone: `549351${seed}`, createdate: '2026-10-01T10:00:00Z', lastmodifieddate: '2026-10-01T10:00:00Z' } };
const CONTACT = { id: id(2), properties: { firstname: 'Marta', lastname: `Migrada ${seed}`, email: `marta@migrada${seed}.com.ar`, mobilephone: '+54 9 351 555-0000', hubspot_owner_id: OWNERS[1].id, lifecyclestage: 'customer', createdate: '2025-03-02T10:00:00Z', lastmodifieddate: '2026-01-01T10:00:00Z' },
  associations: { companies: { results: [{ id: id(1), type: 'contact_to_company' }] } } };
const DEAL = { id: id(3), properties: { dealname: `Remeras migradas ${seed}`, pipeline: '674405796', dealstage: '989921333', amount: '1500000', closedate: '2026-02-01T00:00:00Z', hubspot_owner_id: OWNERS[1].id, motivo_de_cierre_perdido: '', createdate: '2025-12-01T10:00:00Z', hs_lastmodifieddate: '2026-01-15T10:00:00Z', hs_v2_date_entered_989921330: '2025-12-01T10:00:00Z', hs_v2_date_entered_989921333: '2026-01-10T10:00:00Z', hs_object_source_label: 'INTEGRATION', hs_object_source_detail_1: 'Pipedream' },
  associations: { contacts: { results: [{ id: id(2), type: 'deal_to_contact' }] }, companies: { results: [{ id: id(1), type: 'deal_to_company' }] } } };
const NOTE = { id: id(4), properties: { hs_timestamp: '2026-01-11T12:00:00Z', hs_note_body: '<p>Pidió <b>muestras</b></p>', hubspot_owner_id: OWNERS[1].id }, associations: { contacts: { results: [{ id: id(2) }] }, deals: { results: [{ id: id(3) }] } } };
const EMAIL = { id: id(5), properties: { hs_timestamp: '2026-01-12T12:00:00Z', hs_email_subject: 'Cotización', hs_email_text: 'Te paso la cotización', hs_email_direction: 'EMAIL', hs_email_from_email: OWNERS[1].email, hs_email_to_email: CONTACT.properties.email, hubspot_owner_id: OWNERS[1].id }, associations: { contacts: { results: [{ id: id(2) }] }, companies: { results: [{ id: id(1) }] } } };
const TASK = { id: id(6), properties: { hs_timestamp: new Date(Date.now() + 86400000).toISOString(), hs_task_subject: `Prospectar Migrada ${seed}`, hs_task_body: 'Persona objetivo: Marta', hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'TODO', hubspot_owner_id: OWNERS[1].id }, associations: { companies: { results: [{ id: id(1) }] } } };

const OBJECTS = { companies: [COMPANY], contacts: [CONTACT, DARWIN_CONTACT], deals: [DEAL], orders: [], notes: [NOTE], emails: [EMAIL], tasks: [TASK], calls: [], meetings: [], communications: [] };
const PROPS = {
  companies: [{ name: 'name', label: 'Name', type: 'string', hubspotDefined: true }, { name: 'campo_nuevo_hs', label: 'Campo nuevo', type: 'string', fieldType: 'text' },
    { name: 'tipo_de_empresa_cotizacion', label: 'Tipo', type: 'enumeration', fieldType: 'select', options: [{ value: 'a_cotizacion_mensual', label: 'A' }, { value: 'd_anual', label: 'D - anual' }] }],
  contacts: [{ name: 'firstname', label: 'First', type: 'string', hubspotDefined: true }],
  deals: [{ name: 'dealname', label: 'Deal', type: 'string', hubspotDefined: true }],
  orders: [],
};

let server;
let port;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    let m;
    if (url.pathname === '/crm/v3/owners') return send({ results: url.searchParams.get('archived') === 'true' ? [] : OWNERS });
    if (url.pathname === '/crm/v3/pipelines/deals') return send({ results: [{ id: '674405796', label: 'Corporate (Grandes Cuentas)', displayOrder: 0, stages: [
      { id: '989921330', label: 'Nueva Oportunidad', displayOrder: 0, metadata: { probability: '0.2', isClosed: 'false' } },
      { id: '989921333', label: 'Respuesta de Cotización', displayOrder: 2, metadata: { probability: '0.7', isClosed: 'false' } }] }] });
    if ((m = url.pathname.match(/^\/crm\/v3\/properties\/(\w+)$/))) return send({ results: PROPS[m[1]] ?? [] });
    if ((m = url.pathname.match(/^\/crm\/v3\/objects\/(\w+)$/))) return send({ results: OBJECTS[m[1]] ?? [] });
    if ((m = url.pathname.match(/^\/crm\/v4\/associations\/(\w+)\/companies\/batch\/read$/))) {
      return send({ results: m[1] === 'contacts' ? [{ from: { id: id(2) }, to: [{ toObjectId: Number(id(1)), associationTypes: [{ typeId: 1, label: 'Primary' }] }] }] : [] });
    }
    res.statusCode = 404; send({ message: `no simulado: ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

const api = async (path, opts = {}) => (await fetch(`${CRM}/api${path}`, opts)).json();

test('migra usuarios, registros, asociaciones, historia de etapas y actividades', async () => {
  const tok = await api('/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'migración test', source: 'hubspot' }) });
  const alta = await fetch(`${CRM}/hooks/migrate`, { method: 'POST', headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'users', items: [{ hs_owner_id: OWNERS[2].id, email: `otra${seed}@formas.ar`, name: `Otra Vendedora ${seed}`, active: true }] }) });
  assert.equal(alta.status, 200, 'alta por /hooks/migrate con token');
  assert.equal((await fetch(`${CRM}/hooks/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"users","items":[]}' })).status, 401, 'sin token no entra');
  // Antes de migrar, el CRM ya había creado solo el contacto (por ejemplo, desde Gmail) y su empresa por el dominio.
  const json = { 'content-type': 'application/json' };
  const nativo = await api('/records/contact', { method: 'POST', headers: json, body: JSON.stringify({ props: { firstname: 'Marta', email: CONTACT.properties.email.toUpperCase() } }) });
  const nativoEmp = (await api(`/records/contact/${nativo.id}`)).associations.company[0];
  assert.ok(nativoEmp, 'empresa creada sola por el dominio');
  await api('/activities', { method: 'POST', headers: json, body: JSON.stringify({ type: 'note', body: `Nota de Gmail ${seed}`, links: [nativo.id] }) });
  const env = { ...process.env, HUBSPOT_TOKEN: 'fake', CRM_URL: CRM, CRM_TOKEN: tok.token };
  const out = await run('node', ['scripts/migrate-hubspot.mjs', `--hubspot-url=http://localhost:${port}`], { env });
  assert.match(out.stdout, /Listo/);

  // Rodrigo ya existía: conserva su id y queda ligado al owner de HubSpot. La vendedora nueva toma el id de HubSpot.
  const users = await api('/users');
  assert.equal(users.find((u) => u.email === 'rodrigo.mateus@formaspublicitarias.com').hs_owner_id, '73383412');
  const vend = users.find((u) => u.email === OWNERS[1].email);
  assert.equal(vend.id, Number(OWNERS[1].id));
  const otra = users.filter((u) => u.hs_owner_id === OWNERS[2].id);
  assert.equal(otra.length, 1, 'no se duplica quien ya estaba ligado a su propietario de HubSpot');
  assert.equal(otra[0].email, `otra${seed}@formas.ar`, 'conserva el mail con el que entra');
  assert.equal(otra[0].team_id, 58079782, 'toma el equipo de HubSpot');

  const company = await api(`/records/company/${id(1)}`);
  assert.equal(company.record.name, `Migrada SA ${seed}`);
  assert.equal(company.record.props.owner_id, vend.id);
  assert.equal(company.record.props.campo_nuevo_hs, 'valor raro', 'propiedad custom creada al vuelo');
  const meta = await api('/meta');
  assert.ok(meta.properties.find((p) => p.object_type === 'company' && p.name === 'tipo_de_empresa_cotizacion').options.some((o) => o.value === 'd_anual'), 'opción nueva sumada');

  const contact = await api(`/records/contact/${id(2)}`);
  assert.equal(contact.associations.company[0].id, Number(id(1)));
  assert.equal((await api(`/records/contact/${nativo.id}`)).redirect, Number(id(2)), 'el contacto creado antes se combinó en el de HubSpot');
  assert.equal((await api(`/records/company/${nativoEmp.id}`)).redirect, Number(id(1)), 'la empresa creada antes, también');
  assert.ok((await api(`/records/contact/${id(2)}/timeline`)).activities.some((a) => a.body === `Nota de Gmail ${seed}`), 'con su actividad');
  assert.equal(contact.associations.company[0].primary, true);

  const deal = await api(`/records/deal/${id(3)}`);
  assert.equal(deal.record.props.amount, 1500000);
  assert.equal(deal.record.props.dealstage, '989921333');
  assert.equal(deal.associations.contact.length, 1);
  assert.match(deal.record.props.source, /hubspot · INTEGRATION · Pipedream/);

  const tl = await api(`/records/company/${id(1)}/timeline`);
  const types = tl.activities.map((a) => a.type).sort();
  assert.deepEqual(types, ['email', 'note', 'note', 'task'], 'las de HubSpot y la del contacto creado antes de migrar');
  assert.ok(tl.activities.some((a) => a.type === 'note' && a.body === 'Pidió muestras'));
  assert.equal(tl.activities.find((a) => a.type === 'task').priority, 'high');
  const c2 = await api(`/records/contact/${id(2)}`);
  assert.ok(c2.record.props.notes_last_contacted, 'último contacto recalculado por el mail');

  // Los tableros piden por owner de HubSpot y por la historia de etapas.
  const compat = await (await fetch(`${CRM}/hubspot/crm/v3/objects/deals/search`, {
    method: 'POST', headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: OWNERS[1].id }] }], properties: ['dealname', 'hubspot_owner_id', 'hs_v2_date_entered_989921333'] }),
  })).json();
  assert.equal(compat.total, 1);
  assert.equal(compat.results[0].properties.hubspot_owner_id, OWNERS[1].id);
  assert.equal(compat.results[0].properties.hs_v2_date_entered_989921333, '2026-01-10T10:00:00.000Z');

  const darwin = await api(`/records/contact/${id(7)}`);
  assert.equal(darwin.record.props.email, undefined, 'sin el mail inventado por Darwin');
  assert.equal(darwin.record.props.firstname, 'Juan', 'sin el apellido repetido');

  // Repetir la migración no duplica nada.
  await run('node', ['scripts/migrate-hubspot.mjs', `--hubspot-url=http://localhost:${port}`], { env });
  const again = await api(`/records/company/${id(1)}/timeline`);
  assert.equal(again.activities.length, 4);
});
