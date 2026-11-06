// Fotos de los usuarios: la de su cuenta de Google (src/worker/fotos.ts), con el Google simulado del puerto 8799
// (test/google-falso.mjs). Por el permiso de perfil o, si falta, por el de Drive; sin cuenta de Google queda sin foto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { googleFalso } from './google-falso.mjs';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
// Al agregar un usuario, la foto se trae aparte (después de contestar): se espera a que aparezca.
async function esperar(fn, que) {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no pasó: ${que}`);
}
const usuario = async (id) => (await api('GET', '/users')).data.find((u) => u.id === id);
const foto = (email) => `https://lh3.googleusercontent.com/a/foto-${email}=s96-c`;

let g;
before(async () => { g = await googleFalso(); });
after(async () => { await g.cerrar(); });

test('fotos de Google de los usuarios', async (t) => {
  const st0 = (await api('GET', '/users/fotos')).data;
  if (!st0.cuenta_de_servicio) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (node test/gmail-dev-vars.mjs)'); return; }

  // 1. Al agregar un usuario se trae su foto (96 px), y llega a la lista de usuarios de la pantalla (meta).
  const a = (await api('POST', '/users', { email: `foto.${RUN}@formas.ar`, name: `Foto ${RUN}` })).data;
  assert.equal((await esperar(async () => (await usuario(a.id))?.photo_url, 'foto del usuario nuevo')), foto(a.email));
  assert.equal((await api('GET', '/meta')).data.users.find((u) => u.id === a.id).photo_url, foto(a.email));

  // 2. Un mail que Google no conoce: revisado, sin foto (se ven las iniciales).
  g.perfil.sinCuenta.add(`sincuenta.${RUN}@formas.ar`);
  const b = (await api('POST', '/users', { email: `sincuenta.${RUN}@formas.ar`, name: `Sin Cuenta ${RUN}` })).data;
  const b2 = await esperar(async () => { const u = await usuario(b.id); return u?.photo_checked_at ? u : null; }, 'usuario sin cuenta revisado');
  assert.equal(b2.photo_url, null);

  // 3. Sin el permiso de perfil en la delegación: la trae por Drive (el permiso de los bocetos) y la próxima vez va directo.
  g.perfil.negar.add('perfil');
  const c = (await api('POST', '/users', { email: `drive.${RUN}@formas.ar`, name: `Drive ${RUN}` })).data;
  assert.equal(await esperar(async () => (await usuario(c.id))?.photo_url, 'foto por Drive'), foto(c.email), 'mismo tamaño que por el perfil');
  assert.ok(g.drive.tokens.some((x) => x.sub === c.email && x.scope === 'https://www.googleapis.com/auth/drive'));
  assert.equal((await api('GET', '/users/fotos')).data.metodo, 'drive');

  // 4. Sin ninguno de los dos permisos: queda el aviso de qué permiso sumar, y el usuario sin revisar (se reintenta).
  g.perfil.negar.add('drive');
  const d = (await api('POST', '/users', { email: `nopermiso.${RUN}@formas.ar`, name: `No Permiso ${RUN}` })).data;
  const st = await esperar(async () => { const s = (await api('GET', '/users/fotos')).data; return s.sin_permiso ? s : null; }, 'aviso de permiso');
  assert.match(st.error, /userinfo\.profile/);
  assert.equal((await usuario(d.id)).photo_checked_at, null);

  // 5. Con el permiso, el botón «Traer fotos de Google» las trae a todas (las que faltan primero; si hay muchas, en tandas).
  g.perfil.negar.clear();
  await esperar(async () => {
    const r = await api('POST', '/users/fotos');
    assert.equal(r.status, 200);
    assert.equal(r.data.error, null, JSON.stringify(r.data));
    return (await usuario(d.id)).photo_url === foto(d.email);
  }, 'el botón trae la foto que faltaba');
  assert.equal((await api('GET', '/users/fotos')).data.sin_permiso, false);
});
