// Qué ve cada usuario (pedido de Rodrigo del 20/11/2026; src/worker/alcance.ts, docs/PERFILES.md#qué-ve): una vendedora puede
// ver, además de lo suyo, lo de su equipo, lo de todos o lo de personas elegidas («Carmen ve lo suyo, lo de Mili y lo de
// Sonia»). Es solo para ver: lo de las demás no lo edita. Encima siguen los pipelines que ve.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const crear = async (type, props, associations) => {
  const r = await call('POST', `/records/${type}`, { props: type === 'contact' ? { origen_del_contacto: 'Linkedin', ...props } : props, associations });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const ids = (list) => list.map((r) => r.id);
const usuario = async (nombre, extra = {}) => {
  const r = await call('POST', '/users', { email: `${nombre.toLowerCase()}.${RUN}@formas.ar`, name: `${nombre} ${RUN}`, profile: 'comercial', role: 'manager', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};

test('Qué ve: lo suyo, personas elegidas, su equipo y todo; lo de otras solo para ver', async () => {
  const equipo = (await call('GET', '/meta')).data.teams[0];
  assert.ok(equipo, 'hace falta un equipo en la base de prueba');
  const carmen = await usuario('Carmen');
  const mili = await usuario('Mili');
  const sonia = await usuario('Sonia', { teams: [equipo.id] });
  const otra = await usuario('Otra');
  const C = { 'x-dev-user': carmen.email };
  const deal = (name, owner, associations) => crear('deal', { dealname: `${name} ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: owner }, associations);

  const empMili = await crear('company', { name: `Empresa Mili ${RUN}`, owner_id: mili.id });
  const negMili = await deal('Negocio Mili', mili.id, [empMili.id]);
  const pedMili = await crear('order', { hs_order_name: `Pedido Mili ${RUN}`, owner_id: mili.id }, [negMili.id]);
  const contMili = await crear('contact', { firstname: 'Cliente', lastname: `Mili ${RUN}`, email: `cliente.mili.${RUN}@x.com`, owner_id: otra.id }, [empMili.id]);
  const negSonia = await deal('Negocio Sonia', sonia.id);
  const negOtra = await deal('Negocio Otra', otra.id);
  const tareaMili = (await call('POST', '/activities', { type: 'task', subject: `Tarea suelta Mili ${RUN}`, owner_id: mili.id })).data;

  const negocios = async () => ids((await call('GET', `/records/deal?q=${RUN}`, undefined, C)).data.results);
  const ficha = (tipo, id) => call('GET', `/records/${tipo}/${id}`, undefined, C);

  // Por defecto, solo lo suyo (como siempre).
  assert.deepEqual(await negocios(), []);
  assert.equal((await ficha('deal', negMili.id)).status, 403);

  // Lo suyo + Mili: sus negocios, su empresa, sus pedidos, lo asociado a eso y sus tareas sueltas; nada de Sonia ni de Otra.
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve_usuarios: [mili.id, 999999999, carmen.id] })).status, 200);
  const fila = (await call('GET', '/users')).data.find((u) => u.id === carmen.id);
  assert.deepEqual(JSON.parse(fila.ve_usuarios), [mili.id], 'solo usuarios que existen y no ella misma');
  assert.deepEqual((await negocios()).sort(), [negMili.id]);
  assert.equal((await ficha('company', empMili.id)).status, 200);
  assert.equal((await ficha('order', pedMili.id)).status, 200);
  assert.equal((await ficha('contact', contMili.id)).status, 200, 'lo asociado a lo de Mili, aunque sea de otra');
  const tareas = ids((await call('GET', `/tasks?owner=all&status=all&q=${RUN}`, undefined, C)).data.results);
  assert.ok(tareas.includes(tareaMili.id), 'las tareas de Mili, aunque no estén en ningún registro');
  assert.equal((await call('GET', `/activities/${tareaMili.id}`, undefined, C)).status, 200);

  // Ver no es editar: la ficha lo dice y cambiar rebota.
  const negocioMili = (await ficha('deal', negMili.id)).data;
  assert.deepEqual(negocioMili.solo_ver, { de: `Mili ${RUN}` });
  const cambio = await call('PATCH', `/records/deal/${negMili.id}`, { props: { amount: 1 } }, C);
  assert.equal(cambio.status, 403);
  assert.match(cambio.data.error, new RegExp(`es de Mili ${RUN}`));
  const propio = await deal('Negocio Carmen', carmen.id);
  assert.equal((await ficha('deal', propio.id)).data.solo_ver, undefined, 'lo suyo se edita como siempre');

  // Su equipo: lo de quienes comparten alguno de sus equipos (Sonia), y lo elegido sigue sumando (Mili).
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve: 'equipo' })).status, 200);
  assert.deepEqual((await negocios()).sort(), [propio.id, negMili.id].sort(), 'sin equipo, su equipo es solo ella');
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { teams: [equipo.id] })).status, 200);
  assert.deepEqual((await negocios()).sort(), [propio.id, negMili.id, negSonia.id].sort());
  assert.ok(!(await negocios()).includes(negOtra.id));

  // Todo: ve también lo de Otra, pero sigue sin editarlo.
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve: 'todos' })).status, 200);
  assert.ok((await negocios()).includes(negOtra.id));
  assert.equal((await ficha('deal', negOtra.id)).status, 200);
  assert.equal((await call('PATCH', `/records/deal/${negOtra.id}`, { props: { amount: 1 } }, C)).status, 403);
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve: 'otro' })).status, 400);

  // Los pipelines que ve siguen valiendo encima: sin el pipeline, no ve los negocios aunque vea todo.
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { pipelines: [] })).status, 200);
  assert.ok(!(await negocios()).includes(negOtra.id));
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { pipelines: null })).status, 200);

  // Vuelta a solo lo suyo.
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve: 'suyo', ve_usuarios: [] })).status, 200);
  assert.deepEqual(await negocios(), [propio.id]);
  assert.equal((await ficha('company', empMili.id)).status, 403);
});
