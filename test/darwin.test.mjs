// Actividad diaria de Darwin (src/worker/darwin.ts): los eventos que manda el workflow de Darwin, el resumen del día con IA
// en el contacto (y su negocio) y las consultas con datos fijos («quién consultó por botellas»), y las conversaciones sin
// respuesta. Claude simulado en el puerto 8797 (ANTHROPIC_BASE_URL de .dev.vars.example).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(CRM + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const api = (m, p, b) => call(m, `/api${p}`, b);

// Claude: con datos de esta corrida, un resumen y dos consultas; con cualquier otra cosa (corridas viejas en la misma base), nada nuevo.
const pedidos = [];
let claude;
before(async () => {
  claude = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    res.setHeader('content-type', 'application/json');
    if (!req.url.startsWith('/anthropic/v1/messages')) { res.statusCode = 404; return res.end('{}'); }
    const p = JSON.parse(body);
    const datos = p.messages[0].content;
    pedidos.push({ model: p.model, datos, system: p.system });
    const nuestro = datos.includes(RUN);
    const out = nuestro && datos.includes('300 botellas')
      ? { hubo_novedad: true, resumen: `Maru atendió a Ana ${RUN}: quiere 300 botellas térmicas con logo grabado para fin de año y una mochila. Se la pasó a la vendedora.`,
        proximo_paso: 'Mandar cotización de las botellas',
        consultas: [
          { categoria: 'Drinkware', tipo: 'Botella', producto: 'Botella térmica 500 ml', cantidad: 300, precio_unitario: 9000, presupuesto_total: null, fecha_necesaria: '2026-12-15',
            ocasion: 'Fin de año', personalizacion: 'logo grabado láser', pidio_muestra: true, pidio_boceto: false, objecion: '', competidor: '', entrega: 'CABA' },
          { categoria: 'Marroquinería', tipo: 'Mochila', producto: 'Mochila notebook', cantidad: null, precio_unitario: null, presupuesto_total: null, fecha_necesaria: '',
            ocasion: '', personalizacion: '', pidio_muestra: false, pidio_boceto: false, objecion: 'Precio', competidor: '', entrega: '' },
        ] }
      : { hubo_novedad: false, resumen: '', proximo_paso: '', consultas: [] };
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: p.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify(out) }] }));
  });
  await new Promise((r) => claude.listen(8797, r));
});
after(() => claude?.close());

const state = {};
const ayer = new Date(Date.now() - 30 * 3600_000).toISOString();
const tel = `549115${String(Date.now()).slice(-7)}`;
const conv = `15552-${tel}`;
const evento = (eventType, data, timestamp = ayer) => ({ evento: eventType, timestamp, data: {
  conversationId: conv, sessionId: 1, channelFamily: 'wa', channelType: 'wa-cloud', phoneNumber: `+${tel}`, conversationThreadId: tel, conversationTitle: `Ana ${RUN}`, ...data } });

test('Darwin → CRM: los eventos del día se guardan con el token de integración', async () => {
  const tok = await api('POST', '/tokens', { name: `Darwin actividad ${RUN}`, source: 'darwin' });
  assert.equal(tok.status, 201, JSON.stringify(tok.data));
  state.h = { authorization: `Bearer ${tok.data.token}` };
  const sin = await call('POST', '/hooks/darwin/evento', evento('session.opened', {}));
  assert.equal(sin.status, 401);
  const ct = await api('POST', '/records/contact', { props: { origen_del_contacto: 'Contacto por Whatsapp', firstname: 'Ana', lastname: RUN, mobilephone: `+${tel}` } });
  assert.equal(ct.status, 201, JSON.stringify(ct.data));
  state.contact = ct.data.id;
  for (const e of [
    evento('session.opened', {}),
    evento('session.forwarded.qualified', { forwardedToName: 'Rodrigo Mateus', forwardedToEmail: 'rodrigo.mateus@formas.ar', forwardType: 'qualified', forwardedAt: ayer,
      summary: `Ana ${RUN} quiere 300 botellas con logo para fin de año`, smartFields: { producto: 'Botellas', cantidad: 300, apellido: 'nolastname' } }),
    evento('session.analyzed', { summary: `Ana ${RUN} quiere 300 botellas con logo para fin de año y consultó por mochilas`, smartFields: { Categoria: 'Drinkware' } }),
  ]) {
    const r = await call('POST', '/hooks/darwin/evento', e, state.h);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.conversation_id, conv);
  }
  // Una conversación de alguien que no está en el CRM: no se crea nada.
  const otro = `549223${String(Date.now()).slice(-7)}`;
  const r = await call('POST', '/hooks/darwin/evento', { evento: 'session.analyzed', timestamp: ayer, data: { conversationId: `15552-${otro}`, phoneNumber: otro, channelFamily: 'wa',
    conversationTitle: `Desconocido ${RUN}`, summary: 'Hola' } }, state.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  state.otro = `15552-${otro}`;
  const malo = await call('POST', '/hooks/darwin/evento', { evento: 'session.opened', data: {} }, state.h);
  assert.equal(malo.status, 400);
});

test('resumen del día: actividad en el contacto con lo que pasó y las consultas con datos fijos', async () => {
  const r = await api('POST', '/darwin/resumir', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.hecho >= 1, JSON.stringify(r.data));
  assert.ok(r.data.sin_contacto >= 1, JSON.stringify(r.data));
  const nuestro = pedidos.find((p) => p.datos.includes(RUN) && p.datos.includes('300 botellas'));
  assert.ok(nuestro, 'le pasa a Claude los resúmenes de Darwin');
  assert.equal(nuestro.model, 'claude-sonnet-5-5');
  assert.match(nuestro.datos, /Rodrigo Mateus/);
  assert.ok(!nuestro.datos.includes(tel), 'no le manda el teléfono completo');

  const tl = await api('GET', `/records/contact/${state.contact}/timeline`);
  assert.equal(tl.status, 200, JSON.stringify(tl.data));
  const act = (tl.data.activities ?? tl.data).filter((a) => a.type === 'whatsapp' && a.meta?.darwin);
  assert.equal(act.length, 1);
  assert.match(act[0].body, /300 botellas/);
  assert.match(act[0].body, /Próximo paso: Mandar cotización/);
  assert.match(act[0].body, /• Botella \(Botella térmica 500 ml\) — 300 u\./);
  assert.equal(act[0].meta.atendio, 'Rodrigo Mateus');
  assert.match(act[0].meta.link, /getdarwin\.ai\/agent\/1986\/conversations\/all\/15552-/);
  state.activity = act[0].id;

  const b = await api('GET', `/consultas?tipo=Botella&q=${RUN}`);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.total, 1);
  const c = b.data.consultas[0];
  assert.equal(c.contact_id, state.contact);
  assert.equal(c.cantidad, 300);
  assert.equal(c.categoria, 'Drinkware');
  assert.equal(c.ocasion, 'Fin de año');
  assert.equal(c.pidio_muestra, true);
  assert.equal(c.atendio, 'Rodrigo Mateus');
  const porTexto = await api('GET', `/consultas?q=${encodeURIComponent('grabado láser')}&contact_id=${state.contact}`);
  assert.equal(porTexto.data.total, 1, 'busca en la personalización');
  const cien = await api('GET', `/consultas?q=${RUN}&min_cantidad=100`);
  assert.deepEqual(cien.data.consultas.map((x) => x.tipo), ['Botella'], 'la mochila no tiene cantidad');
  const todas = await api('GET', `/consultas?contact_id=${state.contact}`);
  assert.equal(todas.data.total, 2);
  assert.equal((await api('GET', `/consultas?q=${RUN}&sin_venta=1`)).data.total, 2, 'consultó y todavía no compró');
});

test('si llega algo más de ese día se rehace: un solo resumen y sin consultas repetidas', async () => {
  const r = await call('POST', '/hooks/darwin/evento', evento('session.closed', { closedAt: ayer, summary: `Ana ${RUN} quiere 300 botellas con logo para fin de año; cerró la sesión` }), state.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await api('POST', '/darwin/resumir', {});
  const tl = await api('GET', `/records/contact/${state.contact}/timeline`);
  const act = (tl.data.activities ?? tl.data).filter((a) => a.type === 'whatsapp' && a.meta?.darwin);
  assert.equal(act.length, 1);
  assert.equal(act[0].id, state.activity);
  assert.equal((await api('GET', `/consultas?contact_id=${state.contact}`)).data.total, 2);
});

test('sin respuesta: el cliente escribió después de la última respuesta del equipo', async () => {
  const hace = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  await call('POST', '/hooks/darwin/evento', evento('session.analyzed', { lastHumanActivityAt: hace(40) }, hace(39)), state.h);
  await call('POST', '/hooks/darwin/evento', evento('session.replied', {}, hace(30)), state.h);
  const p = await api('GET', '/darwin/pendientes?horas=24');
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const fila = p.data.pendientes.find((x) => x.conversation_id === conv);
  assert.ok(fila, 'aparece');
  assert.equal(fila.asignada_a, 'Rodrigo Mateus');
  assert.equal(fila.contact_id, state.contact);
  assert.ok(!(await api('GET', '/darwin/pendientes?horas=48')).data.pendientes.some((x) => x.conversation_id === conv), 'escribió hace 30 h, no 48');
  // La vendedora contesta: sale de la lista.
  await call('POST', '/hooks/darwin/evento', evento('session.analyzed', { lastHumanActivityAt: hace(1) }, hace(1)), state.h);
  assert.ok(!(await api('GET', '/darwin/pendientes?horas=24')).data.pendientes.some((x) => x.conversation_id === conv));
});

test('Claude (MCP): buscar_consultas', async () => {
  const tok = await api('POST', '/tokens', { name: `Claude consultas ${RUN}`, source: 'mcp' });
  const rpc = (method, params) => call('POST', `/mcp/${tok.data.token}`, { jsonrpc: '2.0', id: 1, method, params });
  const list = await rpc('tools/list', {});
  assert.ok(list.data.result.tools.some((t) => t.name === 'buscar_consultas'));
  const r = await rpc('tools/call', { name: 'buscar_consultas', arguments: { tipo: 'Botella', q: RUN } });
  const out = JSON.parse(r.data.result.content[0].text);
  assert.equal(out.total, 1);
  assert.match(out.consultas[0].url, new RegExp(`/contacts/${state.contact}$`));
});

test('estado del resumen diario', async () => {
  const e = await api('GET', '/darwin/estado');
  assert.equal(e.status, 200);
  assert.ok(e.data.consultas >= 2);
  assert.ok(e.data.sin_contacto >= 1);
});
