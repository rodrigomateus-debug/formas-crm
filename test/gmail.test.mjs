// Prueba del registro automático de mails contra un Google simulado.
// Necesita que el `wrangler dev` corra con estas variables en .dev.vars (las genera `node test/gmail-dev-vars.mjs`):
//   GOOGLE_SA_JSON (cualquier clave RSA), GOOGLE_TOKEN_URL=http://localhost:8799/token, GMAIL_API_URL=http://localhost:8799
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const run = Date.now().toString(36);
const b64 = (s) => Buffer.from(s).toString('base64url');
const api = async (method, path, body) => (await fetch(`${CRM}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();

const me = 'rodrigo.mateus@formaspublicitarias.com';
const client = `compras@cliente-${run}.com.ar`;
const nuevo = `nuevo@prospecto-${run}.com`;
const msg = (id, from, to, subject, text, mid) => ({
  id, threadId: `t${id}`, internalDate: String(Date.now() - 60000), labelIds: from.includes(me) ? ['SENT'] : ['INBOX'],
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: mid }],
    parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64(`<p>${text}</p>`) } }] },
});
const MESSAGES = [
  msg('m1', `"Compras Cliente" <${client}>`, me, 'Pedido de cotización', 'Hola, necesitamos 200 tazas.\n\nEl jue, 22 oct 2026 a la(s) 12:04 p.m., Rodrigo escribió:\n> cita vieja', `<a1-${run}@mail>`),
  msg('m2', `Rodrigo Mateus <${me}>`, `"Nuevo Prospecto" <${nuevo}>, colega@formas.ar`, 'Presentación Formas', 'Te paso nuestro catálogo.', `<a2-${run}@mail>`),
  msg('m3', `Desconocido <alguien@otro-${run}.com>`, me, 'Spam', 'Hola', `<a3-${run}@mail>`),
  msg('m4', `notificaciones <noreply@cliente-${run}.com.ar>`, me, 'Aviso', 'automático', `<a4-${run}@mail>`),
];

let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (url.pathname === '/token') return send({ access_token: 'fake', expires_in: 3600 });
    if (url.pathname === '/gmail/v1/users/me/messages') return send({ messages: MESSAGES.map((m) => ({ id: m.id })) });
    const m = url.pathname.match(/messages\/(\w+)$/);
    if (m) return send(MESSAGES.find((x) => x.id === m[1]));
    res.statusCode = 404; send({ error: { message: 'no simulado' } });
  });
  await new Promise((r) => server.listen(8799, r));
});
after(() => server.close());

test('registra mails con contactos, crea el contacto al enviar y no duplica', async (t) => {
  const status = await api('GET', '/gmail');
  if (!status.has_credentials) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (ver encabezado)'); return; }
  const contact = await api('POST', '/records/contact', { props: { firstname: 'Compras', email: client } });
  await api('PUT', '/gmail', { enabled: true, users: [me] });
  const out = await api('POST', '/gmail/sync');
  const mine = out.find((o) => o.mailbox === me);
  assert.ok(mine && !mine.error, JSON.stringify(out));
  assert.equal(mine.logged, 2, 'el del cliente y el enviado al prospecto; ni el desconocido ni el noreply');

  const tl = await api('GET', `/records/contact/${contact.id}/timeline`);
  const email = tl.activities.find((a) => a.type === 'email');
  assert.equal(email.direction, 'in');
  assert.equal(email.body, 'Hola, necesitamos 200 tazas.', 'corta la cita del mail anterior');
  assert.ok(tl.activities[0].links.some((l) => l.type === 'company'), 'también en la empresa (dominio corporativo)');

  const created = await api('GET', `/records/contact?q=${encodeURIComponent(nuevo)}`);
  assert.equal(created.total, 1, 'contacto creado por el mail enviado');
  assert.equal(created.results[0].props.firstname, 'Nuevo');

  // Segunda pasada (mismos Message-ID): no duplica.
  await api('POST', '/gmail/sync');
  const tl2 = await api('GET', `/records/contact/${contact.id}/timeline?types=email`);
  assert.equal(tl2.activities.length, 1);
  await api('PUT', '/gmail', { enabled: false });
});
