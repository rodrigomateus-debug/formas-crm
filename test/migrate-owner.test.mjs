// Prueba del 1 a 1 con el HubSpot de un vendedor (scripts/migrate-hubspot.mjs --owner) contra un HubSpot simulado
// (búsqueda, lectura por lotes y asociaciones v4) y el CRM local: lo que cambia, se desasocia, se borra o se reasigna
// allá queda igual acá, y lo que es solo del CRM no se pierde.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const run = promisify(execFile);
const seed = Date.now() % 1e6;
const id = (n) => String(71_000_000_000 + seed * 100 + n);
const OWNER = { id: String(1_600_000_000 + seed), email: `mili${seed}@formaspublicitarias.com`, firstName: 'Mili', lastName: `Prueba ${seed}`, teams: [{ id: '57132078', primary: true }] };
const OTRO = { id: String(1_700_000_000 + seed), email: `otro${seed}@formaspublicitarias.com`, firstName: 'Otro', lastName: `Vendedor ${seed}`, teams: [] };

const t0 = '2026-01-01T10:00:00Z';
// Estado de HubSpot (se cambia entre corridas).
const db = {
  companies: { [id(1)]: { name: `Empresa Mili ${seed}`, domain: `mili${seed}.com.ar`, hubspot_owner_id: OWNER.id, createdate: t0, hs_lastmodifieddate: t0 },
    [id(9)]: { name: `Empresa de Otro ${seed}`, hubspot_owner_id: OTRO.id, createdate: t0, hs_lastmodifieddate: t0 } },
  contacts: {
    [id(2)]: { firstname: 'Ana', lastname: `Uno ${seed}`, email: `ana@mili${seed}.com.ar`, jobtitle: 'Compras', hubspot_owner_id: OWNER.id, createdate: t0, lastmodifieddate: t0 },
    [id(3)]: { firstname: 'Beto', lastname: `Dos ${seed}`, email: `beto@mili${seed}.com.ar`, hubspot_owner_id: OWNER.id, createdate: t0, lastmodifieddate: t0 },
    [id(4)]: { firstname: 'Ceci', lastname: `Tres ${seed}`, hubspot_owner_id: OWNER.id, createdate: t0, lastmodifieddate: t0 },
  },
  deals: {
    [id(5)]: { dealname: `Negocio uno ${seed}`, pipeline: '674405796', dealstage: '989921330', amount: '100', hubspot_owner_id: OWNER.id, createdate: t0, hs_lastmodifieddate: t0 },
    [id(6)]: { dealname: `Negocio dos ${seed}`, pipeline: '674405796', dealstage: '989921330', amount: '200', hubspot_owner_id: OWNER.id, createdate: t0, hs_lastmodifieddate: t0 },
  },
  orders: {},
  notes: { [id(10)]: { hs_timestamp: t0, hs_note_body: 'Nota uno', hubspot_owner_id: OWNER.id, hs_createdate: t0, hs_lastmodifieddate: t0 },
    [id(11)]: { hs_timestamp: t0, hs_note_body: 'Nota que se borra', hubspot_owner_id: OWNER.id, hs_createdate: t0, hs_lastmodifieddate: t0 } },
  // Mail cargado por otro usuario en un contacto de Mili: también es parte de su historial.
  emails: { [id(12)]: { hs_timestamp: t0, hs_email_subject: `Mail de otro ${seed}`, hs_email_text: 'Hola', hs_email_direction: 'EMAIL', hubspot_owner_id: OTRO.id, hs_createdate: t0, hs_lastmodifieddate: t0 } },
  tasks: { [id(13)]: { hs_timestamp: t0, hs_task_subject: `Llamar ${seed}`, hs_task_status: 'NOT_STARTED', hubspot_owner_id: OWNER.id, hs_createdate: t0, hs_lastmodifieddate: t0 } },
  calls: {}, meetings: {}, communications: {},
};
// Asociaciones (sin dirección): [tipoA, idA, tipoB, idB, principal]
let assocs = [
  ['contacts', id(2), 'companies', id(1), true], ['contacts', id(3), 'companies', id(1), true], ['contacts', id(4), 'companies', id(9), true],
  ['deals', id(5), 'contacts', id(2), false], ['deals', id(5), 'contacts', id(3), false], ['deals', id(5), 'companies', id(1), true],
  ['deals', id(6), 'companies', id(9), true],
  ['notes', id(10), 'contacts', id(2), false], ['notes', id(11), 'deals', id(5), false], ['emails', id(12), 'contacts', id(3), false],
  ['tasks', id(13), 'deals', id(6), false],
];
const assocFrom = (from, to, fid) => assocs.flatMap(([a, ai, b, bi, p]) => (a === from && ai === fid && b === to ? [{ id: bi, p }] : b === from && bi === fid && a === to ? [{ id: ai, p }] : []));

const PROPS = {
  companies: [{ name: 'name', label: 'Name', type: 'string', hubspotDefined: true }],
  contacts: [{ name: 'firstname', label: 'First', type: 'string', hubspotDefined: true }, { name: 'jobtitle', label: 'Cargo', type: 'string', hubspotDefined: true }],
  deals: [{ name: 'dealname', label: 'Deal', type: 'string', hubspotDefined: true }],
  orders: [],
};

let server;
let port;
before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const ch of req) body += ch;
    const json = body ? JSON.parse(body) : {};
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    let m;
    if (url.pathname === '/crm/v3/owners') return send({ results: url.searchParams.get('archived') === 'true' ? [] : [OWNER, OTRO] });
    if ((m = url.pathname.match(/^\/crm\/v3\/owners\/(\d+)$/))) return send([OWNER, OTRO].find((o) => o.id === m[1]) ?? {});
    if (url.pathname === '/crm/v3/pipelines/deals') return send({ results: [{ id: '674405796', label: 'Corporate (Grandes Cuentas)', displayOrder: 0, stages: [
      { id: '989921330', label: 'Nueva Oportunidad', displayOrder: 0, metadata: { probability: '0.2', isClosed: 'false' } }] }] });
    if ((m = url.pathname.match(/^\/crm\/v3\/properties\/(\w+)$/))) return send({ results: PROPS[m[1]] ?? [] });
    if ((m = url.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/search$/))) {
      const f = json.filterGroups[0].filters;
      const owner = f.find((x) => x.propertyName === 'hubspot_owner_id')?.value;
      const gt = BigInt(f.find((x) => x.propertyName === 'hs_object_id')?.value ?? '0');
      const ids = Object.entries(db[m[1]] ?? {}).filter(([k, p]) => (!owner || p.hubspot_owner_id === owner) && BigInt(k) > gt).map(([k]) => k).sort();
      return send({ total: ids.length, results: ids.slice(0, json.limit).map((k) => ({ id: k, properties: { ...db[m[1]][k], hs_object_id: k } })) });
    }
    if ((m = url.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/batch\/read$/))) {
      const store = db[m[1]] ?? {};
      return send({ results: json.inputs.filter((x) => store[x.id]).map((x) => ({ id: x.id, properties: { ...store[x.id], hs_object_id: x.id } })) });
    }
    if ((m = url.pathname.match(/^\/crm\/v4\/associations\/(\w+)\/(\w+)\/batch\/read$/))) {
      const [, from, to] = m;
      return send({ results: json.inputs.map((x) => ({ from: { id: x.id }, to: assocFrom(from, to, x.id).map((a) => ({ toObjectId: Number(a.id), associationTypes: a.p ? [{ typeId: 1, label: 'Primary' }] : [{ typeId: 279, label: null }] })) }))
        .filter((r) => r.to.length) });
    }
    res.statusCode = 404; send({ message: `no simulado: ${req.method} ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

const api = async (p, opts = {}) => (await fetch(`${CRM}/api${p}`, opts)).json();
const jsonH = { 'content-type': 'application/json' };

test('--owner deja el CRM 1 a 1 con el HubSpot del vendedor', async () => {
  const tok = await api('/tokens', { method: 'POST', headers: jsonH, body: JSON.stringify({ name: 'migración 1a1', source: 'hubspot' }) });
  const env = { ...process.env, HUBSPOT_TOKEN: 'fake', CRM_URL: CRM, CRM_TOKEN: tok.token };
  const report = path.join(os.tmpdir(), `control-${seed}.json`);
  const correr = () => run('node', ['scripts/migrate-hubspot.mjs', `--hubspot-url=http://localhost:${port}`, `--owner=${OWNER.id}`, `--report=${report}`], { env });

  let out = await correr();
  assert.match(out.stdout, /Control HubSpot \/ CRM/);
  let ctl = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual(ctl.diferencias, [], out.stdout);
  assert.deepEqual(ctl.registros.contacts, { hubspot: 3, crm: 3 });
  assert.deepEqual(ctl.actividades.emails, { hubspot: 1, crm: 1 }, 'el mail que cargó otro en su contacto');

  const empresaOtro = await api(`/records/company/${id(9)}`);
  assert.equal(empresaOtro.record.name, `Empresa de Otro ${seed}`, 'trae también la empresa de otro asociada a lo suyo');
  let deal = await api(`/records/deal/${id(5)}`);
  assert.deepEqual(deal.associations.contact.map((x) => x.id).sort(), [Number(id(2)), Number(id(3))]);

  // En el CRM: se edita el cargo (después que HubSpot) y se marca algo que es solo del CRM.
  await api(`/records/contact/${id(2)}`, { method: 'PATCH', headers: jsonH, body: JSON.stringify({ props: { jobtitle: 'Editado en el CRM', tipo_de_relacion: 'proveedor' } }) });

  // En HubSpot: cambia el mail y se vacía el cargo; se saca un contacto del negocio; se borra un contacto y una nota;
  // un negocio pasa a otro vendedor; la tarea se completa.
  const t1 = new Date().toISOString();
  Object.assign(db.contacts[id(2)], { email: `ana.nueva@mili${seed}.com.ar`, jobtitle: null, lastmodifieddate: '2026-02-01T10:00:00Z' });
  assocs = assocs.filter(([a, ai, b, bi]) => !(a === 'deals' && ai === id(5) && b === 'contacts' && bi === id(3)));
  delete db.contacts[id(4)];
  assocs = assocs.filter(([, ai, , bi]) => ai !== id(4) && bi !== id(4));
  delete db.notes[id(11)];
  db.deals[id(6)].hubspot_owner_id = OTRO.id;
  Object.assign(db.tasks[id(13)], { hs_task_status: 'COMPLETED', hs_lastmodifieddate: t1 });

  out = await correr();
  ctl = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual(ctl.diferencias, [], out.stdout);
  assert.deepEqual(ctl.registros.contacts, { hubspot: 2, crm: 2 });
  assert.deepEqual(ctl.registros.deals, { hubspot: 1, crm: 1 });

  const ana = await api(`/records/contact/${id(2)}`);
  assert.equal(ana.record.props.email, `ana.nueva@mili${seed}.com.ar`);
  assert.equal(ana.record.props.jobtitle, undefined, 'HubSpot manda: lo vaciado allá se vacía acá aunque se haya editado en el CRM');
  assert.equal(ana.record.props.tipo_de_relacion, 'proveedor', 'lo que es solo del CRM se conserva');
  deal = await api(`/records/deal/${id(5)}`);
  assert.deepEqual(deal.associations.contact.map((x) => x.id), [Number(id(2))], 'la asociación que se sacó en HubSpot se saca acá');
  assert.equal((await api(`/records/contact/${id(4)}`)).record?.archived ?? true, true, 'el contacto borrado en HubSpot queda archivado');
  const d6 = await api(`/records/deal/${id(6)}`);
  assert.equal(d6.record.props.owner_id, Number(OTRO.id), 'el negocio reasignado pasa al otro vendedor');
  const tl = await api(`/records/deal/${id(5)}/timeline`);
  assert.ok(!tl.activities.some((a) => a.body === 'Nota que se borra'), 'la nota borrada en HubSpot no se ve más');
  const tl6 = await api(`/records/deal/${id(6)}/timeline`);
  assert.equal(tl6.activities.find((a) => a.type === 'task')?.status, 'COMPLETED');
});

test('--since trae las asociaciones de lo que cambió (las actividades no quedan sueltas)', async () => {
  const tok = await api('/tokens', { method: 'POST', headers: jsonH, body: JSON.stringify({ name: 'migración since', source: 'hubspot' }) });
  const env = { ...process.env, HUBSPOT_TOKEN: 'fake', CRM_URL: CRM, CRM_TOKEN: tok.token };
  const ts = new Date().toISOString();
  db.notes[id(20)] = { hs_timestamp: ts, hs_note_body: `Nota nueva ${seed}`, hubspot_owner_id: OWNER.id, hs_createdate: ts, hs_lastmodifieddate: ts };
  assocs.push(['notes', id(20), 'contacts', id(2), false]);
  db.contacts[id(21)] = { firstname: 'Dani', lastname: `Nuevo ${seed}`, hubspot_owner_id: OWNER.id, createdate: ts, lastmodifieddate: ts };
  assocs.push(['contacts', id(21), 'companies', id(1), true]);
  const out = await run('node', ['scripts/migrate-hubspot.mjs', `--hubspot-url=http://localhost:${port}`, '--since=2026-01-01', '--only=users,config,contacts,associations,notes,finalize'], { env });
  assert.match(out.stdout, /Recalculando última y próxima actividad de \d+ registros/);
  const tl = await api(`/records/contact/${id(2)}/timeline`);
  assert.ok(tl.activities.some((a) => a.body === `Nota nueva ${seed}`), 'la nota nueva cuelga de su contacto');
  const dani = await api(`/records/contact/${id(21)}`);
  assert.equal(dani.associations.company?.[0]?.id, Number(id(1)), 'el contacto nuevo con su empresa');
  assert.equal(dani.associations.company[0].primary, true);
});
