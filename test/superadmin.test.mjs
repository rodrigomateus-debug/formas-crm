// Superadmin y «Ver como» (src/worker/auth.ts): el administrador principal (ADMIN_EMAIL, el usuario de desarrollo) mira el
// CRM como otro usuario desde su sesión (cabecera x-ver-como), solo para mirar; da y saca el permiso de superadmin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('superadmin: ver como otro usuario, solo para mirar', async () => {
  const meta = (await call('GET', '/meta')).data;
  assert.equal(meta.superadmin, true, 'el administrador principal es superadmin sin marca');
  assert.equal(meta.real_user, undefined);
  const yo = meta.me;
  const ceci = (await call('POST', '/users', { email: `ceci.vc.${RUN}@formas.ar`, name: `Ceci VC ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const ana = (await call('POST', '/users', { email: `ana.vc.${RUN}@formas.ar`, name: `Ana VC ${RUN}`, profile: 'admin' })).data;
  const beto = (await call('POST', '/users', { email: `beto.vc.${RUN}@formas.ar`, name: `Beto VC ${RUN}`, profile: 'admin' })).data;
  const usuarios = (await call('GET', '/users')).data;
  assert.deepEqual([usuarios.find((u) => u.id === yo.id).superadmin, usuarios.find((u) => u.id === yo.id).principal], [1, true]);
  assert.equal(usuarios.find((u) => u.id === ana.id).superadmin, 0, 'ser admin no alcanza');

  // Mirando como Ceci: la sesión es la de ella, con quién es en realidad.
  const V = { 'x-ver-como': String(ceci.id) };
  const comoCeci = (await call('GET', '/meta', undefined, V)).data;
  assert.deepEqual([comoCeci.me.id, comoCeci.me.profile, comoCeci.real_user.id, comoCeci.superadmin], [ceci.id, 'produccion', yo.id, true]);
  assert.equal((await call('GET', '/me', undefined, V)).data.id, ceci.id);
  assert.equal((await call('GET', '/users', undefined, V)).status, 200, 'Ceci no es admin, pero /users no lo pide');
  // Solo para mirar: nada se cambia a nombre de ella.
  const crear = await call('POST', '/records/company', { props: { name: `Como Ceci ${RUN}` } }, V);
  assert.equal(crear.status, 403);
  assert.equal(crear.data.ver_como, true);
  assert.match(crear.data.error, /solo para mirar/);
  assert.ok(!(await call('GET', `/search?q=${encodeURIComponent(`Como Ceci ${RUN}`)}`)).data.company.length, 'no se creó');
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV VC ${RUN}` } })).data;
  assert.equal((await call('POST', `/records/order/${pedido.id}/conversacion/leido`, { hasta: 1 }, V)).status, 403, 'ni siquiera lo leído');
  // Sin cabecera, todo sigue siendo de Rodrigo.
  assert.equal((await call('GET', '/me')).data.id, yo.id);

  // Un usuario que no está o que se desactivó: la pantalla vuelve sola al usuario propio.
  const nadie = await call('GET', '/meta', undefined, { 'x-ver-como': '999999999' });
  assert.deepEqual([nadie.status, nadie.data.ver_como_invalido], [403, true]);
  await call('PATCH', `/users/${ceci.id}`, { active: false });
  assert.equal((await call('GET', '/meta', undefined, V)).data.ver_como_invalido, true);
  await call('PATCH', `/users/${ceci.id}`, { active: true });

  // Un admin que no es superadmin no puede (ni con otra sesión); con un token, la cabecera no cuenta.
  const comoAna = { 'x-dev-user': ana.email };
  assert.equal((await call('GET', '/meta', undefined, comoAna)).data.superadmin, false);
  assert.equal((await call('GET', '/meta', undefined, { ...comoAna, ...V })).status, 403);
  const tok = (await call('POST', '/tokens', { name: `VC ${RUN}`, source: 'api', user_id: beto.id })).data.token;
  assert.equal((await call('GET', '/me', undefined, { authorization: `Bearer ${tok}`, ...V })).data.id, beto.id);

  // El permiso lo dan y lo sacan los superadmins; al principal no se le saca.
  assert.equal((await call('PATCH', `/users/${ana.id}`, { superadmin: true }, { 'x-dev-user': beto.email })).status, 403);
  assert.equal((await call('PATCH', `/users/${ana.id}`, { superadmin: true })).status, 200);
  assert.equal((await call('GET', '/meta', undefined, { ...comoAna, ...V })).data.me.id, ceci.id, 'Ana ya puede');
  assert.equal((await call('PATCH', `/users/${yo.id}`, { superadmin: false }, comoAna)).status, 400);
  assert.equal((await call('PATCH', `/users/${ana.id}`, { superadmin: false })).status, 200);
  assert.equal((await call('GET', '/meta', undefined, { ...comoAna, ...V })).status, 403);
});
