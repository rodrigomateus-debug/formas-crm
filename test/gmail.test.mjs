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
const sinNombre = `marta@prospecto2-${run}.com`;
const msg = (id, from, to, subject, text, mid) => ({
  id, threadId: `t${id}`, internalDate: String(Date.now() - 60000), labelIds: from.includes(me) ? ['SENT'] : ['INBOX'],
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: mid }],
    parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64(`<p>${text}</p>`) } }] },
});
const MESSAGES = [
  msg(`m1${run}`, `"Compras Cliente" <${client}>`, me, 'Pedido de cotización', 'Hola, necesitamos 200 tazas.\n\nEl jue, 22 oct 2026 a la(s) 12:04 p.m., Rodrigo escribió:\n> cita vieja', `<a1-${run}@mail>`),
  msg(`m2${run}`, `Rodrigo Mateus <${me}>`, `"Nuevo Prospecto" <${nuevo}>, colega@formas.ar`, 'Presentación Formas', 'Te paso nuestro catálogo.', `<a2-${run}@mail>`),
  msg(`m3${run}`, `Desconocido <alguien@otro-${run}.com>`, me, 'Spam', 'Hola', `<a3-${run}@mail>`),
  msg(`m4${run}`, `notificaciones <noreply@cliente-${run}.com.ar>`, me, 'Aviso', 'automático', `<a4-${run}@mail>`),
  // Enviado a una dirección sin nombre y, después, la respuesta con nombre: el contacto toma el nombre.
  { ...msg(`m5${run}`, `Rodrigo Mateus <${me}>`, sinNombre, 'Catálogo de fin de año', 'Te paso el catálogo.', `<a5-${run}@mail>`), internalDate: String(Date.now() - 50000) },
  { ...msg(`m6${run}`, `"Gómez, Marta" <${sinNombre}>`, me, 'Re: Catálogo de fin de año', 'Gracias, lo miro.', `<a6-${run}@mail>`), internalDate: String(Date.now() - 40000) },
];

// Tanda grande (para el tope de consultas): mails de un contacto, todos dentro del margen de 10 minutos que se relee.
const bulk = [];
let gets = 0;   // mails pedidos de a uno
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (url.pathname === '/token') return send({ access_token: 'fake', expires_in: 3600 });
    if (url.pathname === '/gmail/v1/users/me/messages') {
      const after = Number((url.searchParams.get('q') ?? '').match(/after:(\d+)/)?.[1] ?? 0);
      const all = [...MESSAGES, ...bulk].filter((x) => Number(x.internalDate) / 1000 > after).sort((x, y) => Number(y.internalDate) - Number(x.internalDate));
      return send({ messages: all.map((x) => ({ id: x.id })) });
    }
    const m = url.pathname.match(/messages\/(\w+)$/);
    if (m) { gets++; return send([...MESSAGES, ...bulk].find((x) => x.id === m[1])); }
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
  assert.equal(mine.logged, 4, 'el del cliente, los dos enviados y la respuesta; ni el desconocido ni el noreply');

  const tl = await api('GET', `/records/contact/${contact.id}/timeline`);
  const email = tl.activities.find((a) => a.type === 'email');
  assert.equal(email.direction, 'in');
  assert.equal(email.body, 'Hola, necesitamos 200 tazas.', 'corta la cita del mail anterior');
  assert.ok(tl.activities[0].links.some((l) => l.type === 'company'), 'también en la empresa (dominio corporativo)');

  const created = await api('GET', `/records/contact?q=${encodeURIComponent(nuevo)}`);
  assert.equal(created.total, 1, 'contacto creado por el mail enviado');
  assert.equal(created.results[0].props.firstname, 'Nuevo');
  const marta = (await api('GET', `/records/contact?q=${encodeURIComponent(sinNombre)}`)).results[0];
  assert.deepEqual([marta.props.firstname, marta.props.lastname], ['Marta', 'Gómez'], 'el nombre llega con la respuesta');

  // Segunda pasada (mismos Message-ID): no duplica.
  await api('POST', '/gmail/sync');
  const tl2 = await api('GET', `/records/contact/${contact.id}/timeline?types=email`);
  assert.equal(tl2.activities.length, 1);
  await api('PUT', '/gmail', { enabled: false });
});

test('una tanda de 70 mails en pocos minutos se lee en varias corridas, sin pasarse del tope ni repetir', async (t) => {
  const status = await api('GET', '/gmail');
  if (!status.has_credentials) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (ver encabezado)'); return; }
  await api('PUT', '/gmail', { enabled: true, users: [me] });
  for (let i = 0; i < 70; i++) {
    const x = msg(`b${i}x${run}`, `"Compras Cliente" <${client}>`, me, `Tanda ${run} ${i}`, `Mail ${i}`, `<b${i}-${run}@mail>`);
    x.internalDate = String(Date.now() - (70 - i) * 2000);
    bulk.push(x);
  }
  let total = 0;
  for (let corrida = 0; corrida < 4; corrida++) {
    gets = 0;
    const mine = (await api('POST', '/gmail/sync')).find((o) => o.mailbox === me);
    assert.ok(mine && !mine.error, JSON.stringify(mine));
    assert.ok(gets <= 43, `corrida ${corrida}: ${gets} mails pedidos`);
    total += mine.logged;
    if (!mine.pending) break;
  }
  assert.equal(total, 70, 'los 70, una vez cada uno');
  gets = 0;
  const again = (await api('POST', '/gmail/sync')).find((o) => o.mailbox === me);
  assert.deepEqual([again.logged, gets], [0, 0], 'la corrida siguiente no vuelve a pedir los que ya leyó');
});
