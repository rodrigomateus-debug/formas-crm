// «Conectar con Claude» (src/worker/conectar.ts): el flujo OAuth como lo hace Claude (descubrimiento, registro, permiso con
// PKCE, token y renovación) y, desde Claude, cada uno edita solo lo suyo (src/worker/mcp.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const VUELTA = 'https://claude.ai/api/mcp/auth_callback';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
const mcp = (token, method, params) => fetch(`${CRM}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const herramienta = async (token, name, args) => (await (await mcp(token, 'tools/call', { name, arguments: args })).json()).result;

// Conectar como lo hace Claude, como el usuario `como` (x-dev-user en desarrollo).
async function conectar(cliente, como) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: cliente, redirect_uri: VUELTA, code_challenge: challenge, code_challenge_method: 'S256', state: `st-${RUN}` });
  const H = como ? { 'x-dev-user': como } : {};
  const pagina = await fetch(`${CRM}/conectar/autorizar?${q}`, { headers: H });
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Permitir/);
  const form = new URLSearchParams({ ...Object.fromEntries(q), decision: 'permitir' });
  const ok = await fetch(`${CRM}/conectar/autorizar`, { method: 'POST', redirect: 'manual', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded', origin: CRM }, body: form });
  assert.equal(ok.status, 302);
  const vuelta = new URL(ok.headers.get('location'));
  assert.equal(`${vuelta.origin}${vuelta.pathname}`, VUELTA);
  assert.equal(vuelta.searchParams.get('state'), `st-${RUN}`);
  const code = vuelta.searchParams.get('code');
  const pedir = (v) => fetch(`${CRM}/mcp/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: cliente, redirect_uri: VUELTA }) });
  return { html, code, pedir, verifier };
}

test('conectar con Claude: OAuth como un conector de HubSpot o ClickUp', async () => {
  // 1. Sin token, /mcp dice dónde pedir permiso.
  const sin = await mcp(null, 'initialize', {});
  assert.equal(sin.status, 401);
  assert.match(sin.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:8787\/\.well-known\/oauth-protected-resource"/);
  const recurso = await (await fetch(`${CRM}/.well-known/oauth-protected-resource`)).json();
  assert.deepEqual(recurso.authorization_servers, [CRM]);
  const servidor = await (await fetch(`${CRM}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual([servidor.authorization_endpoint, servidor.token_endpoint, servidor.code_challenge_methods_supported], [`${CRM}/conectar/autorizar`, `${CRM}/mcp/oauth/token`, ['S256']]);

  // 2. Claude se registra; otra app (que vuelve a otro sitio) no.
  const malo = await fetch(servidor.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://malo.example.com/cb'] }) });
  assert.equal(malo.status, 400);
  const reg = await (await fetch(servidor.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [VUELTA] }) })).json();
  assert.match(reg.client_id, /^cl_/);

  // 3. Permiso (como Rodrigo, administrador) y token, con PKCE; el código sirve una sola vez.
  // Con la verificación equivocada no hay token, y ese código ya no sirve (no se puede probar hasta adivinar).
  const prueba = await conectar(reg.client_id);
  assert.equal((await prueba.pedir('otra-verificacion-que-no-coincide-con-el-challenge-xx')).status, 400, 'PKCE');
  assert.equal((await prueba.pedir(prueba.verifier)).status, 400, 'el código se quemó');
  const yo = await conectar(reg.client_id);
  assert.match(yo.html, /puede cargar y cambiar cualquier cosa/);
  const tok = await (await yo.pedir(yo.verifier)).json();
  assert.ok(tok.access_token?.startsWith('fcrm_') && tok.refresh_token && tok.expires_in > 0, JSON.stringify(tok));
  assert.equal((await yo.pedir(yo.verifier)).status, 400, 'el código ya se usó');
  // Un formulario armado en otra página no da permiso.
  const otro = await fetch(`${CRM}/conectar/autorizar`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://malo.example.com' },
    body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: VUELTA, code_challenge: 'x'.repeat(43), decision: 'permitir' }) });
  assert.equal(otro.status, 403);

  // 4. Con el token, el MCP anda.
  const init = await (await mcp(tok.access_token, 'initialize', { protocolVersion: '2025-06-18' })).json();
  assert.equal(init.result.serverInfo.name, 'formas-crm');

  // 5. Desde Claude, una vendedora edita solo lo suyo.
  // Logística ve todo el CRM: así la prueba es de lo que se puede cambiar desde Claude, no de lo que ve cada perfil
  // (Ventas y Producción ven solo lo suyo, alcance.ts y test/ventas.test.mjs).
  const vera = (await call('POST', '/users', { email: `vera.claude.${RUN}@formas.ar`, name: `Vera Claude ${RUN}`, role: 'member', profile: 'logistica' })).data;
  const suyo = (await call('POST', '/records/company', { props: { name: `De Vera ${RUN}`, owner_id: vera.id } })).data;
  const ajeno = (await call('POST', '/records/company', { props: { name: `De Rodrigo ${RUN}`, owner_id: (await call('GET', '/me')).data.id } })).data;
  // Sin propietario (como un lead que entra por un formulario): al crear desde la pantalla queda de quien la crea, se lo saca.
  const sinDuenio = (await call('POST', '/records/company', { props: { name: `Sin dueño ${RUN}` } })).data;
  await call('PATCH', `/records/company/${sinDuenio.id}`, { props: { owner_id: null } });
  const v = await conectar(reg.client_id, vera.email);
  assert.match(v.html, /solo lo tuyo/);
  const tv = (await (await v.pedir(v.verifier)).json()).access_token;
  const r1 = await herramienta(tv, 'update_record', { id: suyo.id, properties: { city: 'Rosario' } });
  assert.ok(!r1.isError, JSON.stringify(r1));
  const r2 = await herramienta(tv, 'update_record', { id: ajeno.id, properties: { city: 'Rosario' } });
  assert.ok(r2.isError && /solo podés cambiar lo tuyo/.test(r2.content[0].text), JSON.stringify(r2));
  assert.ok(!(await herramienta(tv, 'update_record', { id: sinDuenio.id, properties: { owner_id: vera.id } })).isError, 'tomar uno sin propietario');
  assert.ok((await herramienta(tv, 'update_record', { id: suyo.id, properties: { owner_id: ajeno.id } })).isError, 'no se lo pasa a otro');
  assert.ok((await herramienta(tv, 'log_activity', { type: 'note', record_ids: [ajeno.id], body: 'x' })).isError, 'ni una nota en lo ajeno');
  assert.ok(!(await herramienta(tv, 'log_activity', { type: 'note', record_ids: [suyo.id], body: `Nota ${RUN}` })).isError);
  assert.ok((await herramienta(tv, 'upsert_bundle', { company: { name: 'x' } })).isError, 'el alta inteligente, solo administradores');
  assert.ok(!(await herramienta(tv, 'search_records', { object_type: 'company', query: `De Rodrigo ${RUN}` })).isError, 'ver, sí');
  // El administrador cambia cualquier cosa.
  assert.ok(!(await herramienta(tok.access_token, 'update_record', { id: suyo.id, properties: { city: 'Córdoba' } })).isError);

  // 6. Renovar: el token nuevo sirve y el anterior no (401, para que Claude renueve o vuelva a pedir permiso).
  const nuevo = await (await fetch(`${CRM}/mcp/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
  assert.ok(nuevo.access_token && nuevo.access_token !== tok.access_token, JSON.stringify(nuevo));
  assert.equal((await mcp(tok.access_token, 'initialize', {})).status, 401);
  assert.equal((await mcp(nuevo.access_token, 'initialize', {})).status, 200);

  // 7. Desde el CRM: cada uno ve sus conexiones y las desconecta.
  const conV = (await call('GET', '/claude/conexiones', undefined, { 'x-dev-user': vera.email })).data;
  assert.equal(conV.conexiones.length, 1);
  assert.equal(conV.conexiones[0].tipo, 'oauth');
  assert.equal((await call('DELETE', `/claude/conexiones/${conV.conexiones[0].id}`)).status, 200);
  assert.equal((await mcp(tv, 'initialize', {})).status, 200, 'una ajena no se desconecta');
  await call('DELETE', `/claude/conexiones/${conV.conexiones[0].id}`, undefined, { 'x-dev-user': vera.email });
  assert.equal((await mcp(tv, 'initialize', {})).status, 401, 'desconectado');
});
