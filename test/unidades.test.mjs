// Filtro por unidad de negocio (Formas Shop, Corporate, NoEstres) en todas las vistas: negocios por el equipo de su
// pipeline, pedidos por su unidad de ClickUp, contactos, empresas y tareas por el equipo de su propietario.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const groups = (values, extra = []) => encodeURIComponent(JSON.stringify([[{ prop: '__unidad', op: 'in', values }, ...extra]]));
const ids = (r) => r.data.results.map((x) => x.id);

test('filtro por unidad de negocio en negocios, pedidos, contactos, empresas y tareas', async () => {
  const shop = (await api('POST', '/users', { email: `shop.${RUN}@formas.ar`, name: `Shop ${RUN}`, team_id: 57132078 })).data;
  const corp = (await api('POST', '/users', { email: `corp.${RUN}@formas.ar`, name: `Corp ${RUN}`, team_id: 58079782 })).data;
  const mismo = [{ prop: 'name', op: 'contains', value: RUN }];

  // Negocios: por el pipeline (Formas Shop Inbound = default; Corporate = 674405796).
  const emp = (await api('POST', '/records/company', { props: { name: `Unidad ${RUN}`, owner_id: corp.id } })).data;
  const dShop = (await api('POST', '/records/deal', { props: { dealname: `Shop ${RUN}`, pipeline: 'default' } })).data;
  const dCorp = (await api('POST', '/records/deal', { props: { dealname: `Corp ${RUN}`, pipeline: '674405796' }, associations: [emp.id] })).data;
  const deals = ids(await api('GET', `/records/deal?groups=${groups(['corporate'], [{ prop: 'dealname', op: 'contains', value: RUN }])}`));
  assert.ok(deals.includes(dCorp.id) && !deals.includes(dShop.id));
  const ambos = ids(await api('GET', `/records/deal?groups=${groups(['corporate', 'shop'], [{ prop: 'dealname', op: 'contains', value: RUN }])}`));
  assert.ok(ambos.includes(dCorp.id) && ambos.includes(dShop.id), 'varias unidades a la vez');

  // Pedidos: por la unidad que trae ClickUp.
  const oNe = (await api('POST', '/records/order', { props: { hs_order_name: `PDV NE ${RUN}`, unidad_de_negocio: 'NO ESTRÉS' } })).data;
  const oSh = (await api('POST', '/records/order', { props: { hs_order_name: `PDV SH ${RUN}`, unidad_de_negocio: 'FORMAS SHOP' } })).data;
  const ords = ids(await api('GET', `/records/order?groups=${groups(['noestres'], [{ prop: 'hs_order_name', op: 'contains', value: RUN }])}`));
  assert.ok(ords.includes(oNe.id) && !ords.includes(oSh.id));

  // Contactos y empresas: por el equipo del propietario.
  const cShop = (await api('POST', '/records/contact', { props: { firstname: `Ana ${RUN}`, email: `ana.${RUN}@x.com`, owner_id: shop.id } })).data;
  const cCorp = (await api('POST', '/records/contact', { props: { firstname: `Beto ${RUN}`, email: `beto.${RUN}@x.com`, owner_id: corp.id } })).data;
  const cons = ids(await api('GET', `/records/contact?groups=${groups(['shop'], [{ prop: 'firstname', op: 'contains', value: RUN }])}`));
  assert.ok(cons.includes(cShop.id) && !cons.includes(cCorp.id));
  assert.ok(ids(await api('GET', `/records/company?groups=${groups(['corporate'], mismo)}`)).includes(emp.id));
  assert.ok(!ids(await api('GET', `/records/company?groups=${groups(['shop'], mismo)}`)).includes(emp.id));

  // Tareas: por el equipo de quien la tiene.
  await api('POST', '/activities', { type: 'task', subject: `Tarea shop ${RUN}`, owner_id: shop.id, due_at: new Date().toISOString() });
  await api('POST', '/activities', { type: 'task', subject: `Tarea corp ${RUN}`, owner_id: corp.id, due_at: new Date().toISOString() });
  const t = (await api('GET', `/tasks?owner=all&due=all&q=${encodeURIComponent(RUN)}&unidades=corporate`)).data.results.map((x) => x.subject);
  assert.deepEqual(t, [`Tarea corp ${RUN}`]);

  // Inicio: los negocios abiertos de una unidad.
  const dash = (await api('GET', '/dashboard?owner=all&unidades=noestres')).data;
  assert.ok(dash.open.every((x) => ['687889576', '746355608'].includes(x.pipeline_id)), 'solo pipelines de NoEstres');
});
