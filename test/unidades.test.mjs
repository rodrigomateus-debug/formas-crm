// Filtro por unidad de negocio (Formas Shop, Corporate, NoEstres) en todas las vistas: negocios por el equipo de su
// pipeline, pedidos por su unidad de ClickUp, empresas por la suya (a mano, por sus compras o por el propietario),
// contactos por la de su empresa y tareas por el equipo de su propietario.
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

  // Contactos sin empresa (mail personal: no se les crea una) y empresas sin unidad a mano ni compras: por el equipo del propietario.
  const cShop = (await api('POST', '/records/contact', { props: { firstname: `Ana ${RUN}`, email: `ana.${RUN}@gmail.com`, owner_id: shop.id } })).data;
  const cCorp = (await api('POST', '/records/contact', { props: { firstname: `Beto ${RUN}`, email: `beto.${RUN}@gmail.com`, owner_id: corp.id } })).data;
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

test('unidad de la empresa: a mano, por sus compras o por el propietario; los contactos heredan la de su empresa', async () => {
  const R = `${RUN}u`;
  // Alguien de dos equipos (como Rodrigo): sus empresas sin más datos son de las dos unidades.
  const dos = (await api('POST', '/users', { email: `dos.${R}@formas.ar`, name: `Dos ${R}`, team_id: 57132078, extra_teams: [57393663] })).data;
  const nueva = async (name, props = {}) => (await api('POST', '/records/company', { props: { name: `${name} ${R}`, owner_id: dos.id, ...props } })).data;
  const porDueno = await nueva('PorDueno');
  const aMano = await nueva('AMano', { unidades_de_negocio: 'corporate' });
  const porCompras = await nueva('PorCompras');
  // unidad_finnegans es de solo lectura: la carga el script de clientes (acá, por su hook).
  const tok = (await api('POST', '/tokens', { name: `Unidades ${R}`, source: 'api' })).data.token;
  const ap = await fetch(`${CRM}/hooks/clientes/aplicar`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ updates: [{ id: porCompras.id, props: { unidad_finnegans: 'Corporate' } }], resumen: {} }) });
  assert.equal(ap.status, 200, await ap.text());
  const deUnidad = async (u) => ids(await api('GET', `/records/company?groups=${groups([u], [{ prop: 'name', op: 'contains', value: R }])}`));
  const corp = await deUnidad('corporate');
  const shop = await deUnidad('shop');
  assert.ok(corp.includes(aMano.id) && !shop.includes(aMano.id), 'a mano manda sobre el propietario');
  assert.ok(corp.includes(porCompras.id) && !shop.includes(porCompras.id), 'sus compras mandan sobre el propietario');
  assert.ok(shop.includes(porDueno.id) && (await deUnidad('noestres')).includes(porDueno.id) && !corp.includes(porDueno.id), 'sin datos, la del propietario');
  // A mano gana también sobre las compras, y se edita (y se borra) como cualquier campo.
  await api('PATCH', `/records/company/${porCompras.id}`, { props: { unidades_de_negocio: 'noestres;shop' } });
  assert.ok((await deUnidad('noestres')).includes(porCompras.id) && !(await deUnidad('corporate')).includes(porCompras.id));
  await api('PATCH', `/records/company/${porCompras.id}`, { props: { unidades_de_negocio: '' } });
  assert.ok((await deUnidad('corporate')).includes(porCompras.id), 'vacío vuelve a la de sus compras');

  // Contactos: la de su empresa principal (aunque su propietario sea de otro equipo); sin empresa, la de su propietario.
  const shopUser = (await api('POST', '/users', { email: `shop2.${R}@formas.ar`, name: `Shop2 ${R}`, team_id: 57132078 })).data;
  const conEmp = (await api('POST', '/records/contact', { props: { firstname: `ConEmp ${R}`, email: `conemp.${R}@gmail.com`, owner_id: shopUser.id }, associations: [aMano.id] })).data;
  const sinEmp = (await api('POST', '/records/contact', { props: { firstname: `SinEmp ${R}`, email: `sinemp.${R}@gmail.com`, owner_id: shopUser.id } })).data;
  const contactos = async (u) => ids(await api('GET', `/records/contact?groups=${groups([u], [{ prop: 'firstname', op: 'contains', value: R }])}`));
  assert.ok((await contactos('corporate')).includes(conEmp.id) && !(await contactos('shop')).includes(conEmp.id), 'hereda la de su empresa');
  assert.ok((await contactos('shop')).includes(sinEmp.id), 'sin empresa, la del propietario');
  // La lista trae la unidad de cada contacto para la columna.
  const lista = (await api('GET', `/records/contact?q=${encodeURIComponent(R)}`)).data.results;
  assert.deepEqual(lista.find((x) => x.id === conEmp.id).unidad, { keys: ['corporate'], origen: 'manual', empresa: true });
  assert.deepEqual(lista.find((x) => x.id === sinEmp.id).unidad, { keys: ['shop'], origen: 'propietario', empresa: false });
});
