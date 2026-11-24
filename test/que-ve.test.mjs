// Qué ve, Back office y varios perfiles (pedidos de Rodrigo del 20/11/2026; src/worker/alcance.ts, docs/PERFILES.md):
// - «Qué ve»: lo suyo o todo y, además, lo de personas elegidas (por usuario). Sin el perfil Back office es solo para ver.
// - Back office: «Carmen es el back office de Mili y Sonia: que pueda ver y editar lo suyo, lo de Mili y lo de Sonia,
//   asignarles ventas y pedir en nombre de ellas».
// - Varios perfiles: Carmen es Comercial y Back office.
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
const crear = async (type, props, associations, headers) => {
  const r = await call('POST', `/records/${type}`, { props: type === 'contact' ? { origen_del_contacto: 'Linkedin', ...props } : props, associations }, headers);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const ids = (list) => list.map((r) => r.id);
const usuario = async (nombre, extra = {}) => {
  const r = await call('POST', '/users', { email: `${nombre.toLowerCase()}.${RUN}@formas.ar`, name: `${nombre} ${RUN}`, profile: 'comercial', role: 'manager', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const deal = (name, owner, associations, headers) => crear('deal', { dealname: `${name} ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: owner }, associations, headers);
const fila = async (id) => (await call('GET', '/users')).data.find((u) => u.id === id);

test('Qué ve sin back office: lo de las personas elegidas o todo, solo para ver', async () => {
  const vera = await usuario('Vera');
  const mili = await usuario('MiliV');
  const otra = await usuario('OtraV');
  const V = { 'x-dev-user': vera.email };
  const empMili = await crear('company', { name: `Empresa MiliV ${RUN}`, owner_id: mili.id });
  const negMili = await deal('Negocio MiliV', mili.id, [empMili.id]);
  const negOtra = await deal('Negocio OtraV', otra.id);
  const tareaMili = (await call('POST', '/activities', { type: 'task', subject: `Tarea suelta MiliV ${RUN}`, owner_id: mili.id })).data;
  const negocios = async () => ids((await call('GET', `/records/deal?q=${RUN}`, undefined, V)).data.results);

  assert.equal((await call('GET', `/records/deal/${negMili.id}`, undefined, V)).status, 403, 'por defecto, solo lo suyo');
  assert.equal((await call('PATCH', `/users/${vera.id}`, { ve_usuarios: [mili.id, 999999999, vera.id] })).status, 200);
  assert.deepEqual(JSON.parse((await fila(vera.id)).ve_usuarios), [mili.id], 'solo usuarios que existen y no ella misma');
  assert.ok((await negocios()).includes(negMili.id) && !(await negocios()).includes(negOtra.id));
  assert.equal((await call('GET', `/records/company/${empMili.id}`, undefined, V)).status, 200);
  assert.ok(ids((await call('GET', `/tasks?owner=all&status=all&q=${RUN}`, undefined, V)).data.results).includes(tareaMili.id), 'las tareas sueltas de Mili');
  // Ver no es editar ni asignar.
  assert.deepEqual((await call('GET', `/records/deal/${negMili.id}`, undefined, V)).data.solo_ver, { de: `MiliV ${RUN}` });
  const cambio = await call('PATCH', `/records/deal/${negMili.id}`, { props: { amount: 1 } }, V);
  assert.equal(cambio.status, 403);
  assert.match(cambio.data.error, new RegExp(`es de MiliV ${RUN}`));
  assert.equal((await call('POST', '/records/company', { props: { name: `A nombre de Mili ${RUN}`, owner_id: mili.id } }, V)).status, 403, 'tampoco crea a nombre de ella');

  // Todo: ve lo de Otra, sin editarlo; con «su equipo» ya no hay opción (es por usuario).
  assert.equal((await call('PATCH', `/users/${vera.id}`, { ve: 'todos' })).status, 200);
  assert.ok((await negocios()).includes(negOtra.id));
  assert.equal((await call('PATCH', `/records/deal/${negOtra.id}`, { props: { amount: 1 } }, V)).status, 403);
  assert.equal((await call('PATCH', `/users/${vera.id}`, { ve: 'equipo' })).status, 400);
  // Los pipelines que ve siguen valiendo encima.
  assert.equal((await call('PATCH', `/users/${vera.id}`, { pipelines: [] })).status, 200);
  assert.ok(!(await negocios()).includes(negOtra.id));
});

test('Back office: ve y edita lo de quienes atiende, les asigna y carga a su nombre', async () => {
  const carmen = await usuario('Carmen', { perfiles: ['comercial', 'backoffice'] });
  const mili = await usuario('Mili');
  const sonia = await usuario('Sonia');
  const otra = await usuario('Otra');
  const C = { 'x-dev-user': carmen.email };
  const f = await fila(carmen.id);
  assert.deepEqual([f.profile, JSON.parse(f.perfiles)], ['comercial', ['comercial', 'backoffice']], 'Comercial (principal) y Back office');
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { ve_usuarios: [mili.id, sonia.id] })).status, 200);

  const empMili = await crear('company', { name: `Empresa Mili ${RUN}`, owner_id: mili.id });
  const negMili = await deal('Negocio Mili', mili.id, [empMili.id]);
  const negOtra = await deal('Negocio Otra', otra.id);

  // Ve y edita lo de Mili como si fuera suyo (la ficha no dice «Solo para ver»).
  const ficha = await call('GET', `/records/deal/${negMili.id}`, undefined, C);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.data.solo_ver, undefined);
  assert.equal((await call('PATCH', `/records/deal/${negMili.id}`, { props: { amount: 1234 } }, C)).status, 200);
  // Le pasa el negocio a Sonia (otra que atiende) y lo recupera; a Otra no.
  assert.equal((await call('PATCH', `/records/deal/${negMili.id}`, { props: { owner_id: sonia.id } }, C)).status, 200);
  const aOtra = await call('PATCH', `/records/deal/${negMili.id}`, { props: { owner_id: otra.id } }, C);
  assert.equal(aOtra.status, 403);
  assert.match(aOtra.data.error, /back office/);
  // Crea a nombre de Mili (empresa, negocio y pedido); a nombre de Otra, no.
  const nueva = await crear('company', { name: `Cliente nuevo de Mili ${RUN}`, owner_id: mili.id }, undefined, C);
  assert.equal(Number(nueva.props.owner_id), mili.id);
  const negNuevo = await deal('Venta de Mili', mili.id, [nueva.id], C);
  const ped = await crear('order', { hs_order_name: `Pedido de Mili ${RUN}`, owner_id: mili.id }, [negNuevo.id], C);
  assert.equal(Number(ped.props.owner_id), mili.id);
  assert.equal((await call('POST', '/records/company', { props: { name: `De Otra ${RUN}`, owner_id: otra.id } }, C)).status, 403);
  // Lo de Otra, ni lo ve.
  assert.equal((await call('GET', `/records/deal/${negOtra.id}`, undefined, C)).status, 403);

  // Inicio: sus números o los de una persona que atiende; los de otra, no (vuelven los suyos).
  assert.equal((await call('GET', `/dashboard/vendedora?owner=${mili.id}`, undefined, C)).status, 200);

  // Recorridos: pide a nombre de Mili; lo ve en sus encargos (y Mili en los suyos) y lo puede cambiar. A nombre de Otra, no.
  const fecha = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const enc = await call('POST', '/recorridos/encargos', { fecha, en_nombre_de: mili.id, destino: { nombre: `Cliente ${RUN}`, direccion: 'Av. Corrientes 1234, CABA' }, llevar: [{ cant: 1, que: 'Caja' }] }, C);
  assert.equal(enc.status, 200, JSON.stringify(enc.data));
  assert.equal(enc.data.user_id, mili.id);
  const deCarmen = ids((await call('GET', '/recorridos/encargos', undefined, C)).data.encargos);
  const deMili = ids((await call('GET', '/recorridos/encargos', undefined, { 'x-dev-user': mili.email })).data.encargos);
  assert.ok(deCarmen.includes(enc.data.id) && deMili.includes(enc.data.id));
  assert.equal((await call('PATCH', `/recorridos/encargos/${enc.data.id}`, { notas: 'Dejar en recepción' }, C)).status, 200);
  assert.equal((await call('POST', '/recorridos/encargos', { fecha, en_nombre_de: otra.id, destino: { nombre: 'X', direccion: 'Y 1' }, llevar: [{ cant: 1, que: 'Caja' }] }, C)).status, 403);

  // Sin el perfil Back office, las mismas personas son solo para ver.
  assert.equal((await call('PATCH', `/users/${carmen.id}`, { perfiles: ['comercial'] })).status, 200);
  assert.equal((await call('PATCH', `/records/deal/${negNuevo.id}`, { props: { amount: 1 } }, C)).status, 403);
  assert.equal((await call('GET', `/records/deal/${negNuevo.id}`, undefined, C)).status, 200);
});

test('Varios perfiles: el primero es el principal, Admin va solo y de los dos lados ve la suma', async () => {
  const pia = await usuario('Pia', { perfiles: ['produccion', 'logistica'] });
  let f = await fila(pia.id);
  assert.deepEqual([f.profile, JSON.parse(f.perfiles)], ['produccion', ['produccion', 'logistica']]);
  assert.equal((await call('GET', '/produccion', undefined, { 'x-dev-user': pia.email })).status, 200);
  assert.equal((await call('POST', '/records/deal', { props: { dealname: 'x', pipeline: 'default', dealstage: 'appointmentscheduled' } }, { 'x-dev-user': pia.email })).status, 403, 'sin perfil comercial no crea negocios');

  // Comercial y Producción: sus negocios y todos los pedidos, con la pantalla de Producción.
  const otra = await usuario('OtraP');
  const negOtra = await deal('Negocio OtraP', otra.id);
  const pedOtra = await crear('order', { hs_order_name: `Pedido OtraP ${RUN}`, owner_id: otra.id }, [negOtra.id]);
  assert.equal((await call('PATCH', `/users/${pia.id}`, { perfiles: ['comercial', 'produccion'] })).status, 200);
  const P = { 'x-dev-user': pia.email };
  assert.equal((await call('GET', `/records/order/${pedOtra.id}`, undefined, P)).status, 200, 'los pedidos, por Producción');
  assert.equal((await call('GET', `/records/deal/${negOtra.id}`, undefined, P)).status, 403, 'los negocios de otra, no');
  assert.equal((await call('GET', '/produccion', undefined, P)).status, 200);
  const mio = await deal('Negocio Pia', pia.id, undefined, P);
  assert.ok(ids((await call('GET', `/records/deal?q=${RUN}`, undefined, P)).data.results).includes(mio.id));

  // Admin va solo; dejar de serlo vuelve a «Edita».
  assert.equal((await call('PATCH', `/users/${pia.id}`, { perfiles: ['comercial', 'admin'] })).status, 200);
  f = await fila(pia.id);
  assert.deepEqual([f.profile, f.role, f.perfiles], ['admin', 'admin', null]);
  // Solo Back office: en la columna vieja queda como comercial (su mismo lado), y la lista dice la verdad.
  assert.equal((await call('PATCH', `/users/${pia.id}`, { perfiles: ['backoffice'] })).status, 200);
  f = await fila(pia.id);
  assert.deepEqual([f.profile, f.role, JSON.parse(f.perfiles)], ['comercial', 'member', ['backoffice']]);
  assert.equal((await call('PATCH', `/users/${pia.id}`, { perfiles: [] })).status, 400);
  assert.equal((await call('PATCH', `/users/${pia.id}`, { perfiles: ['jefa'] })).status, 400);
});
