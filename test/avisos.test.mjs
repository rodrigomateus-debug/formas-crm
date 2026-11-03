// Avisos por mail contra un Google simulado (mismas variables que la prueba de Gmail: GOOGLE_SA_JSON de prueba,
// GOOGLE_TOKEN_URL y GMAIL_API_URL apuntando a localhost:8799; las genera `node test/gmail-dev-vars.mjs`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const me = 'rodrigo.mateus@formaspublicitarias.com';
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const sent = [];   // { auth, raw }
let server;
before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (req.url === '/token') {
      const jwt = new URLSearchParams(body).get('assertion').split('.')[1];
      const claims = JSON.parse(Buffer.from(jwt, 'base64url').toString());
      return send({ access_token: `tok:${claims.sub}:${claims.scope}`, expires_in: 3600 });
    }
    if (req.url === '/gmail/v1/users/me/messages/send') {
      sent.push({ auth: req.headers.authorization, raw: Buffer.from(JSON.parse(body).raw, 'base64url').toString() });
      return send({ id: `s${sent.length}` });
    }
    if (req.url.startsWith('/gmail/v1/users/me/messages')) return send({ messages: [] });
    res.statusCode = 404; send({});
  });
  await new Promise((r) => server.listen(8799, r));
});
after(() => server.close());

// El texto de un mail: las partes en base64, decodificadas.
const decode = (raw) => raw.split(/--fcrm\w+/).map((part) => {
  const [head, ...rest] = part.split('\r\n\r\n');
  return /base64/.test(head) ? Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64').toString() : '';
}).join('\n');

test('avisos por mail: asignaciones de otra persona y resumen de tareas del día', async (t) => {
  const tok = (await call('POST', '/tokens', { name: `Avisos ${RUN}`, source: 'api' })).data.token;
  const H = { authorization: `Bearer ${tok}` };
  const estado = (await call('GET', '/hooks/avisos', undefined, H)).data;
  if (!estado.has_credentials) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba'); return; }
  const otra = (await call('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vera ${RUN}`, role: 'member' })).data;
  await call('PUT', '/hooks/avisos', { enabled: true, users: [me, otra.email], hora: 8 }, H);
  await call('POST', '/hooks/avisos/enviar', undefined, H);   // vacía lo que haya quedado de otras pruebas
  sent.length = 0;

  // Rodrigo (el usuario de desarrollo) le asigna una empresa y una tarea a Vera; una tarea propia no avisa.
  const emp = (await call('POST', '/records/company', { props: { name: `Asignada ${RUN}`, owner_id: otra.id } })).data;
  await call('POST', '/activities', { type: 'task', subject: `Llamar ${RUN}`, owner_id: otra.id, due_at: new Date().toISOString(), links: [emp.id] });
  // Vencida a las 23:59 de ayer (hora de Buenos Aires): la vencida más reciente, sale primera en el resumen.
  const inicioHoy = Date.parse(`${new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)}T03:00:00Z`);
  await call('POST', '/activities', { type: 'task', subject: `Mía ${RUN}`, due_at: new Date(inicioHoy - 60_000).toISOString() });
  const r1 = (await call('POST', '/hooks/avisos/enviar', undefined, H)).data;
  assert.equal(r1.asignaciones, 1, JSON.stringify(r1));
  const asign = sent.find((m) => m.raw.includes(`<${otra.email}>`));
  assert.ok(asign, 'el mail de asignación le llega a Vera');
  assert.ok(asign.auth.includes(`tok:${otra.email}:https://www.googleapis.com/auth/gmail.send`), 'sale de su casilla, con permiso de envío');
  const txt = decode(asign.raw);
  assert.match(txt, new RegExp(`Asignada ${RUN}`));
  assert.match(txt, new RegExp(`Llamar ${RUN}`));
  assert.match(txt, /\/companies\/\d+/);
  // Ya salió: la corrida siguiente no lo repite.
  assert.equal((await call('POST', '/hooks/avisos/enviar', undefined, H)).data.asignaciones, 0);

  // Resumen del día (forzado): Vera tiene una para hoy y Rodrigo una vencida.
  sent.length = 0;
  const r2 = (await call('POST', '/hooks/avisos/enviar?resumen=1', undefined, H)).data;
  assert.ok(r2.resumenes >= 2, JSON.stringify(r2));
  const deVera = decode(sent.find((m) => m.raw.includes(`<${otra.email}>`)).raw);
  assert.match(deVera, /Para hoy/);
  assert.match(deVera, new RegExp(`Llamar ${RUN}`));
  const deRodrigo = decode(sent.find((m) => m.raw.includes(`<${me}>`)).raw);
  assert.match(deRodrigo, /Vencidas/);
  assert.match(deRodrigo, new RegExp(`Mía ${RUN}`));
  await call('PUT', '/hooks/avisos', { users: [me] }, H);
});
