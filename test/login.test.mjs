// Login propio con Google (src/worker/login.ts y la sesión de auth.ts), contra un Google simulado (puerto 8795).
// Necesita en .dev.vars las variables GOOGLE_OAUTH_* y SESSION_SECRET de .dev.vars.example.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const CLIENTE = 'prueba-login.apps.googleusercontent.com';

// ---------- Google simulado: el canje del código devuelve un id_token con el mail que se pida ----------
const codigos = new Map();   // código → claims
let servidor;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
before(async () => {
  servidor = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const claims = codigos.get(p.get('code'));
      if (req.url !== '/google/token' || !claims || p.get('client_secret') !== 'prueba' || p.get('grant_type') !== 'authorization_code') {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'x', id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.firma` }));
    });
  });
  await new Promise((r) => servidor.listen(8795, r));
});
after(() => servidor?.close());

const sinSeguir = (path, cookie) => fetch(`${CRM}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const cookiesDe = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);

// Ida a Google y vuelta con un mail: devuelve la respuesta de la vuelta.
async function ingresar(email, extra = {}, volver = '%2Forders%2F123') {
  const ida = await sinSeguir(`/auth/google?volver=${volver}`);
  assert.equal(ida.status, 302);
  const google = new URL(ida.headers.get('location'));
  assert.equal(google.searchParams.get('client_id'), CLIENTE);
  assert.equal(google.searchParams.get('redirect_uri'), `${CRM}/auth/google/callback`);
  const estado = cookiesDe(ida).find((c) => c.startsWith('crm_login='));
  assert.ok(estado, 'deja el estado del ida y vuelta');
  const code = `cod-${Math.random().toString(36).slice(2)}`;
  codigos.set(code, { iss: 'https://accounts.google.com', aud: CLIENTE, exp: Math.floor(Date.now() / 1000) + 600, email, email_verified: true,
    nonce: google.searchParams.get('nonce'), ...extra });
  return sinSeguir(`/auth/google/callback?code=${code}&state=${google.searchParams.get('state')}`, estado);
}

test('login con Google: la página, la sesión y los rechazos', async () => {
  const pagina = await fetch(`${CRM}/login`);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Ingresar con Google/);
  assert.match(html, /\/login\/hero\.webp/);
  assert.doesNotMatch(html, /todavía no está configurado/, 'con las variables de prueba está configurado');

  // Un usuario del CRM entra y la sesión lo identifica (no al usuario de desarrollo).
  const email = `login.${RUN}@formas.ar`;
  const alta = await fetch(`${CRM}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: `Login ${RUN}`, profile: 'comercial', role: 'member' }) });
  assert.ok(alta.ok, `alta del usuario: ${alta.status}`);
  const vuelta = await ingresar(email);
  assert.equal(vuelta.status, 302);
  assert.equal(vuelta.headers.get('location'), '/orders/123', 'vuelve a donde estaba');
  const sesion = cookiesDe(vuelta).find((c) => c.startsWith('crm_sesion=') && c.length > 'crm_sesion='.length);
  assert.ok(sesion, 'deja la sesión');
  assert.match(vuelta.headers.getSetCookie().find((c) => c.startsWith('crm_sesion=')), /HttpOnly; SameSite=Lax/);
  const me = await (await fetch(`${CRM}/api/me`, { headers: { cookie: sesion } })).json();
  assert.equal(me.email, email);
  // Con la sesión, /login lleva directo al CRM.
  assert.equal((await sinSeguir('/login', sesion)).status, 302);
  // Un cambio desde otra página se rechaza.
  const ajeno = await fetch(`${CRM}/api/records/company`, { method: 'POST', headers: { cookie: sesion, origin: 'https://otro.example', 'content-type': 'application/json' }, body: '{"props":{"name":"x"}}' });
  assert.equal(ajeno.status, 403);
  // Una sesión adulterada no vale (cae al usuario de desarrollo, no al de la cookie).
  const [datos, firma] = sesion.slice('crm_sesion='.length).split('.');
  const otra = Buffer.from(JSON.stringify({ email: 'rodrigo.mateus@formaspublicitarias.com', exp: Date.now() + 1e9 })).toString('base64url');
  const trucha = await (await fetch(`${CRM}/api/me`, { headers: { cookie: `crm_sesion=${otra}.${firma}` } })).json();
  assert.notEqual(trucha.email, email);
  assert.ok(datos);

  // Rechazos: otro dominio, mail sin usuario, mail sin verificar, nonce de otra ida, estado que no coincide.
  assert.equal((await ingresar(`alguien.${RUN}@gmail.com`)).headers.get('location'), '/login?error=dominio&volver=%2Forders%2F123');
  assert.match((await ingresar(`nadie.${RUN}@formas.ar`)).headers.get('location'), /error=usuario/);
  assert.match((await ingresar(email, { email_verified: false })).headers.get('location'), /error=google/);
  assert.match((await ingresar(email, { nonce: 'otro' })).headers.get('location'), /error=google/);
  assert.match((await ingresar(email, { aud: 'otro-cliente' })).headers.get('location'), /error=google/);
  const ida = await sinSeguir('/auth/google');
  const malEstado = await sinSeguir('/auth/google/callback?code=x&state=otro', cookiesDe(ida).find((c) => c.startsWith('crm_login=')));
  assert.match(malEstado.headers.get('location'), /error=vencido/);
  assert.match((await sinSeguir('/auth/google/callback?code=x&state=y')).headers.get('location'), /error=vencido/, 'sin la cookie del ida y vuelta');
  // No se vuelve a otro sitio.
  for (const v of ['%2F%2Fevil.example', 'https%3A%2F%2Fevil.example', '%2Fauth%2Fsalir']) assert.equal((await ingresar(email, {}, v)).headers.get('location'), '/', v);

  // Salir borra la sesión.
  const salir = await sinSeguir('/auth/salir', sesion);
  assert.equal(salir.headers.get('location'), '/login?salio=1');
  assert.match(salir.headers.getSetCookie().find((c) => c.startsWith('crm_sesion=')), /Max-Age=0/);
});
