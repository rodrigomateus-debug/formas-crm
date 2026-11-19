// API compatible con HubSpot (compat.ts), auditoría de rendimiento del 19/11/2026: recorrer todo de a páginas va por la
// clave (el último id, o fecha~id en las actividades), sin saltear ni repetir nada; una posición vieja sigue andando.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body) {
  const res = await fetch(`${CRM}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}

test('tableros: recorrer empresas de a 2 trae todas una vez, con el id como «after»', async () => {
  const creadas = [];
  for (let i = 0; i < 5; i++) creadas.push((await call('POST', '/api/records/company', { props: { name: `Página ${RUN} ${i}` } })).data.id);
  const filtro = { filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: `Página ${RUN}` }] }], properties: ['name'], limit: 2 };
  const vistos = [];
  let after;
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const r = await call('POST', '/crm/v3/objects/companies/search', { ...filtro, ...(after ? { after } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 5);
    vistos.push(...r.data.results.map((x) => Number(x.id)));
    after = r.data.paging?.next?.after;
    if (!after) break;
    assert.ok(Number(after) >= 1_000_000, `«after» es un id (${after})`);
  }
  assert.deepEqual(vistos, [...creadas].sort((a, b) => a - b), 'todas, en orden y sin repetir');
  // Una posición (como antes) sigue andando.
  const vieja = await call('POST', '/crm/v3/objects/companies/search', { ...filtro, after: '2' });
  assert.deepEqual(vieja.data.results.map((x) => Number(x.id)), [...creadas].sort((a, b) => a - b).slice(2, 4));
});

test('tableros: recorrer notas por fecha de a 2 trae todas una vez', async () => {
  const emp = (await call('POST', '/api/records/company', { props: { name: `Notas página ${RUN}` } })).data;
  const creadas = [];
  for (let i = 0; i < 5; i++) {
    // Dos con la misma fecha: el desempate es el id.
    const n = await call('POST', '/api/activities', { type: 'note', body: `Nota ${RUN} ${i}`, occurred_at: `2026-03-0${i < 2 ? 1 : i}T10:00:00.000Z`, links: [emp.id] });
    creadas.push(Number(n.data.id));
  }
  const filtro = { filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: `Nota ${RUN}` }] }], limit: 2 };
  const vistos = [];
  let after;
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const r = await call('POST', '/crm/v3/objects/notes/search', { ...filtro, ...(after ? { after } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vistos.push(...r.data.results.map((x) => Number(x.id)));
    after = r.data.paging?.next?.after;
    if (!after) break;
    assert.match(after, /^c:.+~\d+$/);
  }
  assert.deepEqual([...vistos].sort((a, b) => a - b), [...creadas].sort((a, b) => a - b), 'todas, sin repetir');
  assert.equal(new Set(vistos).size, vistos.length);
});
