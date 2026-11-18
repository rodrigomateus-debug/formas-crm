// Perfil Ventas: cambia solo lo suyo o lo que no tiene propietario, y como propietario se pone solo a sí misma (api.ts,
// soloLoSuyoVentas). Un contacto nuevo con el mail de una empresa de otra vendedora no queda asociado a esa empresa
// (upsert.ts, autoAssociateCompany). Lo encontró la revisión de la versión celular (docs/MOVIL.md).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const A = `ventas-a-${RUN}@example.com`, B = `ventas-b-${RUN}@example.com`;
let idA, idB;

async function api(method, path, body, user) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(user ? { 'x-dev-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  idA = (await api('POST', '/users', { email: A, name: `Vendedora A ${RUN}`, profile: 'comercial', role: 'member' })).data.id;
  idB = (await api('POST', '/users', { email: B, name: `Vendedora B ${RUN}`, profile: 'comercial', role: 'member' })).data.id;
  assert.ok(idA && idB, 'se crean las dos vendedoras de prueba');
});

test('Ventas no edita ni se queda con lo de otra vendedora', async () => {
  const dominio = `lo-suyo-${RUN}.com.ar`;
  const deB = await api('POST', '/records/company', { props: { name: `Empresa de B ${RUN}`, domain: dominio, owner_id: idB } }, B);
  assert.equal(deB.status, 201);

  // Un contacto con el mail de ese dominio: queda sin empresa (no se cuela la de B).
  const contacto = await api('POST', '/records/contact', { props: { firstname: 'Prueba', email: `compras@${dominio}`, origen_del_contacto: 'Referido', owner_id: idA } }, A);
  assert.equal(contacto.status, 201);
  const ficha = await api('GET', `/records/contact/${contacto.data.id}`, undefined, A);
  assert.equal(ficha.data.associations.company.length, 0, 'no se asocia la empresa de otra vendedora');

  // La empresa de B: A no la cambia ni se la queda (aunque la llegara a ver).
  const editar = await api('PATCH', `/records/company/${deB.data.id}`, { props: { city: 'Rosario', owner_id: idA } }, A);
  assert.ok([403, 404].includes(editar.status), `no edita lo de B (${editar.status})`);
  assert.equal((await api('GET', `/records/company/${deB.data.id}`)).data.record.props.owner_id, idB, 'sigue siendo de B');

  // Lo suyo: lo edita, pero no se lo pasa a otra persona.
  const suyo = await api('POST', '/records/company', { props: { name: `Empresa de A ${RUN}`, owner_id: idA } }, A);
  assert.equal((await api('PATCH', `/records/company/${suyo.data.id}`, { props: { city: 'Córdoba' } }, A)).status, 200);
  const regalar = await api('PATCH', `/records/company/${suyo.data.id}`, { props: { owner_id: idB } }, A);
  assert.equal(regalar.status, 403, 'no se lo pasa a otra vendedora');
  assert.match(regalar.data.error, /solo podés ponerte a vos/);

  // Lo que no tiene propietario: lo toma.
  const libre = await api('POST', '/records/company', { props: { name: `Empresa libre ${RUN}` } });
  await api('PATCH', `/records/company/${libre.data.id}`, { props: { owner_id: null } });   // quien la crea queda de dueño: se suelta
  assert.equal((await api('PATCH', `/records/company/${libre.data.id}`, { props: { owner_id: idA } }, A)).status, 200, 'toma lo que no tiene dueño');

  // Lo mismo en el cambio masivo.
  const masivo = await api('POST', '/records/company/batch', { ids: [suyo.data.id], props: { owner_id: idB } }, A);
  assert.equal(masivo.data.updated, 0);
  assert.equal(masivo.data.failed.length, 1);

  // El administrador sí puede asignar a cualquiera.
  assert.equal((await api('PATCH', `/records/company/${suyo.data.id}`, { props: { owner_id: idB } })).status, 200);

  for (const id of [deB.data.id, contacto.data.id, suyo.data.id, libre.data.id]) await api('DELETE', `/records/${id === contacto.data.id ? 'contact' : 'company'}/${id}`);
});
