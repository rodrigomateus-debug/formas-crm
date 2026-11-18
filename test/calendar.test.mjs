// Google Calendar (calendar.ts) contra un Google simulado (puerto 8799, el de GOOGLE_TOKEN_URL y CALENDAR_API_URL de
// .dev.vars; las genera `node test/gmail-dev-vars.mjs`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const run = Date.now().toString(36);
const api = async (method, path, body) => (await fetch(`${CRM}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();

let me = '';   // el usuario de desarrollo (DEV_USER_EMAIL), leído del CRM
const cliente = `compras@cliente-cal-${run}.com.ar`;
const nuevo = `ana.lopez@prospecto-cal-${run}.com`;
const enHora = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const eventos = [];   // lo que «hay» en el calendario
const creados = [];   // lo que el CRM pidió crear
let server;

before(async () => {
  me = (await api('GET', '/me')).email;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (b, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/token') return send({ access_token: 'fake', expires_in: 3600 });
      if (url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'GET') return send({ items: eventos });
      if (url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
        const b = JSON.parse(Buffer.concat(chunks).toString());
        const id = `nuevo${run}${creados.length}`;
        const e = { ...b, id, iCalUID: `${id}@google.com`, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${id}`, organizer: { email: me, self: true },
          ...(url.searchParams.get('conferenceDataVersion') ? { hangoutLink: `https://meet.google.com/abc-${run}` } : {}) };
        creados.push({ body: b, query: Object.fromEntries(url.searchParams) });
        eventos.push(e);
        return send(e);
      }
      send({ error: { message: 'no simulado' } }, 404);
    });
  });
  await new Promise((r) => server.listen(8799, r));
});
after(() => server.close());

test('calendario: las reuniones con gente de afuera quedan en el contacto y su empresa; se mueven y se cancelan', async (t) => {
  const st = await api('GET', '/calendar');
  if (!st.has_credentials) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (ver encabezado)'); return; }
  const contacto = await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Compras', email: cliente } });
  eventos.push(
    { id: `e1${run}`, iCalUID: `e1${run}@google.com`, status: 'confirmed', summary: 'Presentación de productos', description: 'Llevar muestras',
      start: { dateTime: enHora(24) }, end: { dateTime: enHora(25) }, organizer: { email: me, self: true },
      attendees: [{ email: me, self: true, responseStatus: 'accepted' }, { email: cliente }, { email: nuevo, displayName: 'Ana López' }, { email: 'colega@formas.ar' }] },
    // Solo gente de adentro: no se registra.
    { id: `e2${run}`, iCalUID: `e2${run}@google.com`, status: 'confirmed', summary: 'Reunión interna', start: { dateTime: enHora(2) }, end: { dateTime: enHora(3) },
      attendees: [{ email: me }, { email: 'colega@formaspublicitarias.com' }] },
  );
  await api('PUT', '/calendar', { enabled: true, users: [me] });
  const out = await api('POST', '/calendar/sync');
  const mio = out.find((o) => o.calendar === me);
  assert.ok(mio && !mio.error, JSON.stringify(out));
  assert.equal(mio.nuevas, 1, 'solo la reunión con gente de afuera');

  const tl = await api('GET', `/records/contact/${contacto.id}/timeline?types=meeting`);
  assert.equal(tl.activities.length, 1);
  const r = tl.activities[0];
  assert.equal(r.subject, 'Presentación de productos');
  assert.ok(r.links.some((l) => l.type === 'company'), 'también en la empresa (por el dominio)');
  const ana = (await api('GET', `/records/contact?q=${encodeURIComponent(nuevo)}`)).results[0];
  assert.ok(ana, 'el invitado que no era contacto se crea');
  assert.deepEqual([ana.props.firstname, ana.props.lastname], ['Ana', 'López']);

  // Se mueve: se actualiza la misma actividad (no se duplica).
  eventos[0].start = { dateTime: enHora(48) }; eventos[0].end = { dateTime: enHora(49) };
  const out2 = (await api('POST', '/calendar/sync')).find((o) => o.calendar === me);
  assert.equal(out2.actualizadas, 1);
  const tl2 = await api('GET', `/records/contact/${contacto.id}/timeline?types=meeting`);
  assert.equal(tl2.activities.length, 1);
  assert.equal(tl2.activities[0].occurred_at, eventos[0].start.dateTime);

  // Se cancela: se archiva.
  eventos[0].status = 'cancelled';
  const out3 = (await api('POST', '/calendar/sync')).find((o) => o.calendar === me);
  assert.equal(out3.archivadas, 1);
  const tl3 = await api('GET', `/records/contact/${contacto.id}/timeline?types=meeting`);
  assert.equal(tl3.activities.length, 0);
  await api('PUT', '/calendar', { enabled: false });
});

test('calendario: agendar desde la ficha crea el evento con invitados y Meet, y la reunión en el contacto', async (t) => {
  const st = await api('GET', '/calendar/estado');
  if (!st.agendar) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba'); return; }
  const mail = `jefa@agendar-${run}.com.ar`;
  const contacto = await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Jefa', email: mail } });
  const r = await api('POST', '/calendar/reunion', { subject: 'Revisión de pedido', body: 'Ver muestras', start: enHora(30), end: enHora(31), attendees: [mail], meet: true, links: [contacto.id] });
  assert.ok(r.activity, JSON.stringify(r));
  assert.equal(r.meet, `https://meet.google.com/abc-${run}`);
  const pedido = creados.at(-1);
  assert.equal(pedido.query.sendUpdates, 'all', 'manda las invitaciones');
  assert.deepEqual(pedido.body.attendees, [{ email: mail }]);
  assert.ok(pedido.body.conferenceData?.createRequest, 'pide el Meet');
  const tl = await api('GET', `/records/contact/${contacto.id}/timeline?types=meeting`);
  assert.equal(tl.activities.length, 1, 'una sola reunión (no la duplica al registrar)');
  assert.equal(tl.activities[0].meta.meet, r.meet);

  // La próxima pasada del calendario la reconoce: no la duplica.
  await api('PUT', '/calendar', { enabled: true, users: [me] });
  await api('POST', '/calendar/sync');
  const tl2 = await api('GET', `/records/contact/${contacto.id}/timeline?types=meeting`);
  assert.equal(tl2.activities.length, 1);
  await api('PUT', '/calendar', { enabled: false });

  const mal = await fetch(`${CRM}/api/calendar/reunion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'x', start: enHora(2), end: enHora(1), attendees: [mail] }) });
  assert.equal(mal.status, 400, 'fin antes del comienzo');
});
