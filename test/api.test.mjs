// Pruebas de punta a punta contra un `wrangler dev` corriendo (npm run dev) con la base local.
// CRM_URL cambia el destino. Cada corrida usa datos con sufijo único, así se puede repetir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const api = (m, p, b) => call(m, `/api${p}`, b);

const state = {};

test('crea empresa, contacto con dominio corporativo y se asocian solos', async () => {
  const comp = await api('POST', '/records/company', { props: { name: `Acme ${RUN}`, domain: `acme-${RUN}.com.ar`, industry: 'RETAIL' } });
  assert.equal(comp.status, 201, JSON.stringify(comp.data));
  state.company = comp.data.id;
  const dup = await api('POST', '/records/company', { props: { name: 'Otra', domain: `https://www.acme-${RUN}.com.ar/` } });
  assert.equal(dup.status, 409);
  const ct = await call('POST', '/hooks/bundle', undefined); // sin token
  assert.equal(ct.status, 401);
  const contact = await api('POST', '/records/contact', { props: { firstname: 'Ana', lastname: `Pérez ${RUN}`, email: `ana@acme-${RUN}.com.ar`, phone: '+54 9 11 5555-0001' }, associations: [state.company] });
  assert.equal(contact.status, 201, JSON.stringify(contact.data));
  state.contact = contact.data.id;
  assert.equal(contact.data.name, `Ana Pérez ${RUN}`);
  const again = await api('POST', '/records/contact', { props: { email: `ANA@acme-${RUN}.com.ar` } });
  assert.equal(again.status, 409, 'dedupe por email sin importar mayúsculas');
  const rec = await api('GET', `/records/contact/${state.contact}`);
  assert.equal(rec.data.associations.company.length, 1);
  assert.equal(rec.data.associations.company[0].primary, true);
});

test('valida opciones de enums y tipos', async () => {
  const bad = await api('PATCH', `/records/company/${state.company}`, { props: { tipo_de_empresa_cotizacion: 'Z' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Opciones/);
  const byLabel = await api('PATCH', `/records/company/${state.company}`, { props: { tipo_de_empresa_cotizacion: 'A · Cotización mensual', objetivo_economico_anual: '1.500.000' } });
  assert.equal(byLabel.status, 200, JSON.stringify(byLabel.data));
  assert.equal(byLabel.data.props.tipo_de_empresa_cotizacion, 'a_cotizacion_mensual');
  assert.equal(byLabel.data.props.objetivo_economico_anual, 1500000);
});

test('negocio: etapa por defecto, mover de etapa, historial y cierre', async () => {
  const deal = await api('POST', '/records/deal', { props: { dealname: `Remeras ${RUN}`, pipeline: '674405796', amount: 250000 }, associations: [state.contact, state.company] });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  state.deal = deal.data.id;
  assert.equal(deal.data.props.dealstage, '989921330');
  const wrong = await api('PATCH', `/records/deal/${state.deal}`, { props: { dealstage: 'closedwon' } });
  assert.equal(wrong.status, 400, 'closedwon no es de Corporate');
  const won = await api('PATCH', `/records/deal/${state.deal}`, { props: { dealstage: 'Cierre Ganado' } });
  assert.equal(won.data.props.dealstage, '989921336');
  assert.ok(won.data.props.closedate, 'completa la fecha de cierre');
  const hist = await api('GET', `/records/deal/${state.deal}/history?prop=dealstage`);
  assert.equal(hist.data.length, 2);
  const comp = await api('GET', `/records/company/${state.company}`);
  assert.equal(comp.data.associations.deal.length, 1);
});

test('actividades: nota en el contacto aparece en la empresa y el negocio; tareas', async () => {
  const note = await api('POST', '/activities', { type: 'note', body: 'Pidió muestras', links: [state.contact] });
  assert.equal(note.status, 201);
  assert.ok(note.data.links.some((l) => l.id === state.company), 'se asocia a la empresa principal');
  const call1 = await api('POST', '/activities', { type: 'call', outcome: 'Conectada', body: 'Charla', links: [state.deal] });
  assert.equal(call1.status, 201);
  const due = new Date(Date.now() + 3600_000).toISOString();
  const task = await api('POST', '/activities', { type: 'task', subject: `Llamar ${RUN}`, due_at: due, links: [state.deal] });
  assert.equal(task.data.status, 'NOT_STARTED');
  state.task = task.data.id;
  const tl = await api('GET', `/records/company/${state.company}/timeline`);
  const types = tl.data.activities.map((a) => a.type);
  assert.ok(types.includes('note') && types.includes('call') && types.includes('task'), types.join());
  const dealRec = await api('GET', `/records/deal/${state.deal}`);
  assert.ok(dealRec.data.record.props.notes_next_activity_date, 'próxima actividad');
  assert.ok(dealRec.data.record.props.notes_last_contacted, 'último contacto por la llamada');
  const tasks = await api('GET', `/tasks?q=${encodeURIComponent(`Llamar ${RUN}`)}`);
  assert.equal(tasks.data.total, 1);
  const done = await api('PATCH', `/activities/${state.task}`, { status: 'COMPLETED' });
  assert.ok(done.data.completed_at);
});

test('búsqueda con filtros, texto y orden', async () => {
  const byText = await api('GET', `/records/contact?q=${encodeURIComponent(`acme-${RUN}`)}`);
  assert.equal(byText.data.total, 1);
  const byPhone = await api('GET', '/records/contact?q=1155550001');
  assert.ok(byPhone.data.total >= 1);
  const filters = JSON.stringify([{ prop: 'amount', op: 'gte', value: 200000 }, { prop: 'pipeline', op: 'eq', value: '674405796' }, { prop: 'owner_id', op: 'eq', value: 'me' }]);
  const deals = await api('GET', `/records/deal?filters=${encodeURIComponent(filters)}&sort=amount&dir=desc`);
  assert.ok(deals.data.results.some((d) => d.id === state.deal));
  const assoc = await api('GET', `/records/deal?associated_with=${state.company}`);
  assert.equal(assoc.data.total, 1);
  const board = await api('GET', '/board?pipeline=674405796');
  assert.equal(board.data.columns.length, 7);
});

test('MCP: initialize, tools/list y alta con upsert_bundle', async () => {
  const tok = await api('POST', '/tokens', { name: `Claude ${RUN}`, source: 'mcp' });
  assert.equal(tok.status, 201);
  state.token = tok.data.token;
  const rpc = (method, params, id = 1) => call('POST', `/mcp/${state.token}`, { jsonrpc: '2.0', id, method, params });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.data.result.serverInfo.name, 'formas-crm');
  const notif = await call('POST', `/mcp/${state.token}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
  const list = await rpc('tools/list', {});
  assert.ok(list.data.result.tools.length >= 15);
  const up = await rpc('tools/call', { name: 'upsert_bundle', arguments: {
    contact: { email: `ana@acme-${RUN}.com.ar`, jobtitle: 'Compras' },
    deal: { dealname: `Gorras ${RUN}`, pipeline: 'Formas Shop (Inbound)', dealstage: 'Nueva oportunidad' },
    task: { subject: `Prospectar Acme ${RUN}`, due_at: new Date(Date.now() + 86400000).toISOString() },
  } });
  const out = JSON.parse(up.data.result.content[0].text);
  assert.equal(out.contact.id, state.contact, 'reutiliza el contacto existente');
  assert.equal(out.contact.created, false);
  assert.ok(out.deal.created);
  const got = await rpc('tools/call', { name: 'get_record', arguments: { id: out.deal.id } });
  const rec = JSON.parse(got.data.result.content[0].text);
  assert.equal(rec.associations.company[0].id, state.company, 'el negocio hereda la empresa del contacto');
  // Preparar la reunión desde el negocio: arma todo sobre su empresa.
  const prep = JSON.parse((await rpc('tools/call', { name: 'preparar_reunion', arguments: { id: out.deal.id } })).data.result.content[0].text);
  assert.equal(prep.cliente.id, state.company);
  assert.ok(prep.negocios_abiertos.some((d) => d.id === out.deal.id));
  assert.ok(Array.isArray(prep.actividad_reciente) && Array.isArray(prep.pedidos));
  const hist = await rpc('tools/call', { name: 'property_history', arguments: { id: out.deal.id } });
  assert.ok(JSON.parse(hist.data.result.content[0].text).some((h) => h.source === 'mcp'));
  const rep = await rpc('tools/call', { name: 'report', arguments: { object_type: 'deal', group_by: ['pipeline'], filters: [{ prop: 'dealname', op: 'contains', value: RUN }] } });
  assert.equal(JSON.parse(rep.data.result.content[0].text).total, 2);
  const err = await rpc('tools/call', { name: 'update_record', arguments: { id: state.deal, properties: { inexistente: 1 } } });
  assert.equal(err.data.result.isError, true);
});

test('webhook de Darwin crea contacto + negocio y no duplica', async () => {
  const phone = `549341${String(Date.now()).slice(-7)}`;
  const payload = { name: `Juana ${RUN}`, phone, producto: 'Kit Verano', cantidad: 50, conversation_id: `15552-${phone}`, utm_source: 'META_ADS', utm_campaign: '1202' };
  const h = { authorization: `Bearer ${state.token}` };
  const first = await call('POST', '/hooks/darwin', payload, h);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.deal.created, true);
  const second = await call('POST', '/hooks/darwin', { ...payload, summary: 'Quiere 50 kits' }, h);
  assert.equal(second.data.deal.id, first.data.deal.id, 'mismo negocio abierto');
  const deal = await api('GET', `/records/deal/${first.data.deal.id}`);
  assert.equal(deal.data.record.props.dealname, `Juana ${RUN} - Kit Verano - 50 - Darwin`);
  assert.equal(deal.data.record.props.dealstage, 'appointmentscheduled');
  assert.match(deal.data.record.props.link_a_darwin, /getdarwin/);
});

test('Darwin manda su evento nativo (session.forwarded) sin Pipedream', async () => {
  const h = { authorization: `Bearer ${state.token}` };
  const phone = `549351${String(Date.now()).slice(-7)}`;
  const event = { data: {
    phoneNumber: phone, conversationId: `15552-${phone}`, conversationThreadId: phone, conversationTitle: `Cliente ${RUN}`,
    channelName: 'Formas Publicitarias', forwardedToName: 'Rodrigo Mateus Formas', forwardedToEmail: 'rodrigo.mateus@formaspublicitarias.com',
    forwardType: 'qualified', summary: 'Quiere 300 botellas con logo',
    smartFields: { name: 'Maru', producto: 'Botellas', cantidad: 300, anuncio_prellenado: 'Hola, quiero botellas' },
    source: { utmSource: null, utmCampaign: null, utmMedium: 'whatsapp' },
  } };
  const first = await call('POST', '/hooks/darwin', event, h);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const deal = await api('GET', `/records/deal/${first.data.deal.id}`);
  const p = deal.data.record.props;
  assert.equal(p.dealname, `Cliente ${RUN} - Botellas - 300 - Darwin`, 'no usa el nombre de la IA (Maru) sino el título');
  assert.equal(p.origen_del_prospecto, 'META_ADS', 'anuncio prellenado sin utm → META_ADS');
  assert.equal(p.origen_de_la_campana, 'Anuncio sin referral - Hola, quiero botellas');
  assert.equal(p.origen_del_negocio, 'Contacto por Whatsapp');
  assert.ok(p.owner_id, 'propietario por mail');
  const contact = deal.data.associations.contact[0];
  assert.ok(!contact.props.email, 'sin mail inventado');
  const escalated = await call('POST', '/hooks/darwin', { data: { ...event.data, forwardType: 'escalated' } }, h);
  assert.equal(escalated.data.deal.id, first.data.deal.id, 'calificado y después escalado: un solo negocio');
  state.darwinDeal = first.data.deal.id;
});

test('Darwin: contacto con WhatsApp, nombre y mail, y la empresa con su dominio asociada a todo', async () => {
  const h = { authorization: `Bearer ${state.token}` };
  const phone = `549261${String(Date.now()).slice(-7)}`;
  const dom = `optica${RUN}.com.ar`;
  // Como lo manda Darwin al asignar la conversación a una vendedora (session.forwarded.qualified), con su mail de otro
  // dominio de Formas y el «nolastname» que pone cuando no sabe el apellido.
  const event = { data: {
    phoneNumber: phone, conversationId: `15552-${phone}`, conversationThreadId: phone, conversationTitle: 'Optica Del Valle',
    channelName: 'Formas Publicitarias', channelFamily: 'wa', channelType: 'wa-cloud', forwardType: 'qualified',
    forwardedToName: 'Rodrigo Mateus', forwardedToEmail: 'rodrigo.mateus@formas.ar', summary: 'Quiere 100 abanicos',
    smartFields: { name: `Laura ${RUN}`, last_name: 'nolastname', apellido: 'nolastname', email: `Laura@${dom}`, company: `Óptica ${RUN}`, producto: 'Abanicos', cantidad: '100' },
    source: { utmSource: 'META_ADS', utmCampaign: '1202', utmMedium: 'WHATSAPP' },
  } };
  const r = await call('POST', '/hooks/darwin', event, h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.company.created, true);
  const deal = (await api('GET', `/records/deal/${r.data.deal.id}`)).data;
  assert.equal(deal.record.props.dealname, `Laura ${RUN} - Abanicos - 100 - Darwin`);
  assert.equal(deal.record.props.link_a_darwin, `https://app.getdarwin.ai/agent/1986/conversations/all/15552-${phone}`, 'el link para ir directo a la conversación');
  const me = (await api('GET', '/me')).data;
  assert.equal(deal.record.props.owner_id, me.id, 'la vendedora aunque en Darwin tenga el mail de formas.ar');
  const contact = (await api('GET', `/records/contact/${r.data.contact.id}`)).data;
  assert.equal([contact.record.props.firstname, contact.record.props.lastname].filter(Boolean).join(' '), `Laura ${RUN}`, 'sin «nolastname»');
  assert.equal(contact.record.props.email, `laura@${dom}`);
  assert.equal(contact.record.props.mobilephone, phone, 'el WhatsApp');
  const company = (await api('GET', `/records/company/${r.data.company.id}`)).data;
  assert.equal(company.record.props.name, `Óptica ${RUN}`);
  assert.equal(company.record.props.domain, dom, 'el dominio del mail corporativo');
  assert.deepEqual([deal.associations.contact?.map((x) => x.id), deal.associations.company?.map((x) => x.id)], [[r.data.contact.id], [r.data.company.id]]);
  assert.ok(contact.associations.company?.some((x) => x.id === r.data.company.id), 'contacto ↔ empresa');
  const tl = (await api('GET', `/records/company/${r.data.company.id}/timeline?rollup=0`)).data;
  assert.ok(tl.activities.some((a) => a.type === 'note' && /100 abanicos/.test(a.body)), 'la nota también en la empresa');
});

test('Darwin: con mail solo alcanza; sin WhatsApp ni mail no se crea nada', async () => {
  const h = { authorization: `Bearer ${state.token}` };
  // Instagram: el id del hilo no es un teléfono.
  const ig = { data: { conversationId: `2026-1784${RUN}`, conversationThreadId: `1784${String(Date.now()).slice(-9)}`, channelFamily: 'ig', channelType: 'ig',
    channelName: 'Formas Publicitarias SA', forwardedToEmail: 'rodrigo.mateus@formaspublicitarias.com', conversationTitle: `Insta ${RUN}`,
    smartFields: { name: `Insta ${RUN}`, email: '', producto: 'Gorras', cantidad: '30' } } };
  const sin = await call('POST', '/hooks/darwin', ig, h);
  assert.equal(sin.status, 200, JSON.stringify(sin.data));
  assert.match(sin.data.omitido, /WhatsApp ni mail/);
  assert.equal((await api('GET', `/records/deal?q=${encodeURIComponent(`Insta ${RUN}`)}`)).data.total, 0, 'no creó el negocio');
  const conMail = await call('POST', '/hooks/darwin', { data: { ...ig.data, smartFields: { ...ig.data.smartFields, email: `insta.${RUN}@gmail.com` } } }, h);
  assert.equal(conMail.status, 200, JSON.stringify(conMail.data));
  assert.equal(conMail.data.company, undefined, 'mail personal y sin empresa: sin empresa');
  const contact = (await api('GET', `/records/contact/${conMail.data.contact.id}`)).data.record.props;
  assert.deepEqual([contact.email, contact.mobilephone ?? null], [`insta.${RUN}@gmail.com`, null], 'el id de Instagram no es un WhatsApp');
  assert.equal(conMail.data.deal.created, true);
});

test('pasar a «Envío de cotización» pide el valor del negocio (y $0 no cuenta)', async () => {
  const deal = (await api('POST', '/records/deal', { props: { dealname: `Cotizar ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled' } })).data;
  assert.ok(deal.id, JSON.stringify(deal));
  const sinValor = await api('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: 'presentationscheduled' } });
  assert.equal(sinValor.status, 400);
  assert.deepEqual(sinValor.data.missing, ['amount']);
  assert.match(sinValor.data.error, /Envío de cotización/);
  assert.equal((await api('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: 'presentationscheduled', amount: 0 } })).status, 400, 'en $0 no pasa');
  const ok = await api('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: 'presentationscheduled', amount: 750000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.props.amount, 750000);
  const stage = (await api('GET', '/meta')).data.pipelines.find((p) => p.id === 'default').stages.find((s) => s.id === 'presentationscheduled');
  assert.deepEqual(stage.config.required_props, ['amount'], 'la etapa lo pide (la pantalla abre la ventana para cargarlo)');
});

test('el monto del negocio sigue al total de sus pedidos (y los casos raros)', async () => {
  const monto = async (id) => (await api('GET', `/records/deal/${id}`)).data.record.props;
  const asociar = (a, b) => api('POST', '/associations', { from_id: a, to_id: b });
  const deal = (await api('POST', '/records/deal', { props: { dealname: `Kits ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 1000000 } })).data;
  const o1 = (await api('POST', '/records/order', { props: { hs_order_name: `Kits ${RUN} 1`, hs_total_price: 400000 } })).data;
  const o2 = (await api('POST', '/records/order', { props: { hs_order_name: `Kits ${RUN} 2` } })).data;
  assert.ok(deal.id && o1.id && o2.id);

  // Se asocia el pedido: el estimado pasa a ser el total del pedido, y queda en el historial (fuente «pedidos»).
  await asociar(deal.id, o1.id);
  assert.equal((await monto(deal.id)).amount, 400000);
  const hist = (await api('GET', `/records/deal/${deal.id}/history?prop=amount`)).data;
  assert.ok(hist.some((c) => c.source === 'pedidos' && Number(c.new_value) === 400000), JSON.stringify(hist));
  // Un segundo pedido (se dividió en dos) todavía sin total: espera, no queda un monto a medias.
  await asociar(o2.id, deal.id);
  assert.equal((await monto(deal.id)).amount, 400000);
  // Llega su total: la suma de los dos.
  await api('PATCH', `/records/order/${o2.id}`, { props: { hs_total_price: 250000.5 } });
  assert.equal((await monto(deal.id)).amount, 650000.5);
  // Se anula un pedido: deja de contar.
  assert.equal((await api('PATCH', `/records/order/${o2.id}`, { props: { hs_pipeline_stage: '3c85a297-e9ce-400b-b42e-9f16853d69d6' } })).status, 200);
  assert.equal((await monto(deal.id)).amount, 400000);

  // Un pedido va en un solo negocio (un negocio sí puede tener varios): sumarlo a otro no se puede.
  const otro = (await api('POST', '/records/deal', { props: { dealname: `Otro ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 90000 } })).data;
  const doble = await asociar(otro.id, o1.id);
  assert.equal(doble.status, 409);
  assert.match(doble.data.error, /un solo negocio/);
  assert.equal((await api('POST', '/associations', { from_id: o1.id, to_id: otro.id })).status, 409, 'desde el pedido, tampoco');
  await api('PATCH', `/records/order/${o1.id}`, { props: { hs_total_price: 410000 } });
  assert.deepEqual([(await monto(deal.id)).amount, (await monto(otro.id)).amount], [410000, 90000]);

  // Pedidos sin negocio, para control: «Negocios asociados» = 0.
  const o3 = (await api('POST', '/records/order', { props: { hs_order_name: `Kits ${RUN} 3`, hs_total_price: 1000 } })).data;
  const filtro = encodeURIComponent(JSON.stringify([{ prop: 'num_associated_deals', op: 'eq', value: 0 }]));
  const sinNegocio = (await api('GET', `/records/order?q=${encodeURIComponent(`Kits ${RUN}`)}&filters=${filtro}`)).data.results.map((r) => r.id);
  assert.deepEqual(sinNegocio, [o3.id]);

  // Cambiarlo a mano lo deja «Monto a mano»: los pedidos ya no lo pisan, hasta que se desmarca.
  const mano = (await api('PATCH', `/records/deal/${deal.id}`, { props: { amount: 500000 } })).data;
  assert.deepEqual([mano.props.amount, mano.props.monto_a_mano], [500000, 'true']);
  await api('PATCH', `/records/order/${o1.id}`, { props: { hs_total_price: 420000 } });
  assert.equal((await monto(deal.id)).amount, 500000);
  // Al desmarcarlo vuelve enseguida al total del pedido.
  const vuelve = (await api('PATCH', `/records/deal/${deal.id}`, { props: { monto_a_mano: false } })).data;
  assert.deepEqual([vuelve.props.monto_a_mano, vuelve.props.amount], ['false', 420000]);
  // Un negocio sin pedidos se cambia a mano sin marcar nada.
  assert.equal((await api('PATCH', `/records/deal/${otro.id}`, { props: { amount: 95000 } })).data.props.monto_a_mano, undefined);
});

test('avisa por webhook cuando se gana un negocio (para Darwin)', async () => {
  const received = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ body: JSON.parse(b), sig: req.headers['x-formas-crm-signature'] }); res.end('ok'); }); });
  await new Promise((r) => server.listen(8797, r));
  try {
    const put = await api('PUT', '/webhooks', [{ event: 'deal.won', url: 'http://localhost:8797/darwin', secret: 's3cr3t', name: 'Darwin' }]);
    assert.equal(put.status, 200, JSON.stringify(put.data));
    await api('PATCH', `/records/deal/${state.darwinDeal}`, { props: { dealstage: 'presentationscheduled', amount: 500000 } });
    assert.equal(received.length, 0, 'cambio de etapa común: no avisa (solo está suscripto a deal.won)');
    await api('PATCH', `/records/deal/${state.darwinDeal}`, { props: { dealstage: 'closedwon', amount: 900000 } });
    assert.equal(received.length, 1);
    const b = received[0].body;
    assert.equal(b.event, 'deal.won');
    assert.equal(b.deal.amount, 900000);
    assert.match(b.deal.whatsapp_thread, /^549351/);
    assert.ok(received[0].sig, 'firmado');
  } finally {
    await api('PUT', '/webhooks', []);
    server.close();
  }
});

test('LinkedIn directo (sin Zapier): deduplica por perfil y arregla el nombre', async () => {
  const h = { authorization: `Bearer ${state.token}` };
  const url = `https://www.linkedin.com/in/maría-valentina-${RUN}/`;
  const first = await call('POST', '/hooks/linkedin', { firstName: `Maria Valentina Di Lorenzo${RUN}`, lastName: `Di Lorenzo${RUN}`, profileUrl: url, companyName: `Acme ${RUN}`, position: 'CEO' }, h);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.contact.created, true);
  assert.equal(first.data.company.id, state.company, 'la empresa existente se asocia');
  const again = await call('POST', '/hooks/linkedin', { lead: { first_name: 'Maria', last_name: `Di Lorenzo${RUN}`, profile_url: encodeURI(url.replace('https://www.', 'http://')), message_text: 'Hola! Me interesa' } }, h);
  assert.equal(again.data.contact.id, first.data.contact.id, 'mismo perfil con otra forma de URL');
  const rec = await api('GET', `/records/contact/${first.data.contact.id}`);
  assert.equal(rec.data.record.props.firstname, 'Maria Valentina');
  assert.equal(rec.data.record.props.campaign_name, 'Outbound');
  const tl = await api('GET', `/records/contact/${first.data.contact.id}/timeline?types=note`);
  assert.equal(tl.data.activities[0].body, 'Hola! Me interesa');
});

test('API compatible con HubSpot (lo que usan los tableros)', async () => {
  const h = { authorization: `Bearer ${state.token}` };
  const search = await call('POST', '/hubspot/crm/v3/objects/deals/search', {
    filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: `Remeras ${RUN}` }, { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' }] }],
    properties: ['dealname', 'amount_in_home_currency', 'hubspot_owner_id', 'hs_is_closed_won', 'hs_v2_date_entered_989921336'],
    limit: 10,
  }, h);
  assert.equal(search.status, 200, JSON.stringify(search.data));
  assert.equal(search.data.total, 1);
  const p = search.data.results[0].properties;
  assert.equal(p.amount_in_home_currency, '250000');
  assert.ok(p.hs_v2_date_entered_989921336);
  const assoc = await call('POST', '/hubspot/crm/v4/associations/deals/companies/batch/read', { inputs: [{ id: String(state.deal) }] }, h);
  assert.equal(assoc.data.results[0].to[0].toObjectId, state.company);
  const pipes = await call('GET', '/hubspot/crm/v3/pipelines/deals', undefined, h);
  assert.ok(['674405796', 'default', '740095901', '687889576'].every((id) => pipes.data.results.some((p) => p.id === id)), 'los pipelines de HubSpot con sus ids');
  const tasks = await call('POST', '/hubspot/crm/v3/objects/tasks/search', {
    filterGroups: [{ filters: [{ propertyName: 'hs_task_subject', operator: 'CONTAINS_TOKEN', value: `Prospectar Acme ${RUN}` }] }],
    properties: ['hs_task_subject', 'hs_timestamp', 'hs_task_status', 'hubspot_owner_id'],
  }, h);
  assert.equal(tasks.data.total, 1);
  const created = await call('POST', '/hubspot/crm/v3/objects/contacts', { properties: { firstname: 'Refe', lastname: RUN, mobilephone: '1134567890', hubspot_owner_id: '1', tipo_de_origen: 'Referido' } }, h);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const owners = await call('GET', '/hubspot/crm/v3/owners', undefined, h);
  assert.ok(owners.data.results.length >= 1);
  // Misma ruta que api.hubapi.com: los tableros solo cambian el host.
  const root = await call('GET', '/crm/v3/pipelines/deals', undefined, h);
  assert.equal(root.data.results.length, pipes.data.results.length);
  const scopes = await call('POST', '/oauth/v2/private-apps/get/access-token-info', { tokenKey: 'x' }, h);
  assert.ok(scopes.data.scopes.includes('crm.objects.deals.write'));
});

test('combinar duplicados pasa asociaciones y actividades', async () => {
  const dupe = await api('POST', '/records/company', { props: { name: `Acme dup ${RUN}`, city: 'Rosario' } });
  await api('POST', '/activities', { type: 'note', body: 'nota del duplicado', links: [dupe.data.id] });
  const merged = await api('POST', `/records/company/${state.company}/merge`, { other_id: dupe.data.id });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.equal(merged.data.props.city, 'Rosario', 'completa lo vacío');
  const tl = await api('GET', `/records/company/${state.company}/timeline?types=note`);
  assert.ok(tl.data.activities.some((a) => a.body === 'nota del duplicado'));
  const old = await api('GET', `/records/company/${dupe.data.id}`);
  assert.equal(old.data.redirect, state.company);
});

test('formulario web público con configuración', async () => {
  const missing = await call('POST', '/hooks/form/no-existe', { email: 'x@y.com' });
  assert.equal(missing.status, 404);
});

test('logo de empresa y foto de contacto: un dominio o mail inválido no sale a buscar nada', async () => {
  for (const d of ['no_es_dominio', 'localhost', `${'a'.repeat(250)}.com`]) {
    assert.equal((await api('GET', `/favicon/${d}`)).status, 404, d);
  }
  for (const e of ['no-es-mail', 'sin@dominio', `${'a'.repeat(250)}@formas.ar`]) {
    assert.equal((await api('GET', `/avatar/${encodeURIComponent(e)}`)).status, 404, e);
  }
});

test('crear con una asociación que no existe no deja el registro creado', async () => {
  const name = `Suelto ${Date.now().toString(36)}`;
  const r = await api('POST', '/records/deal', { props: { dealname: name, pipeline: '740095901' }, associations: [123] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No existe el registro 123/);
  assert.equal((await api('GET', `/records/deal?q=${encodeURIComponent(name)}`)).data.total, 0);
});

test('el tablero respeta los filtros de la vista (grupos)', async () => {
  const tag = `Vista ${Date.now().toString(36)}`;
  await api('POST', '/records/deal', { props: { dealname: `${tag} grande`, pipeline: '740095901', amount: 900000 } });
  await api('POST', '/records/deal', { props: { dealname: `${tag} chico`, pipeline: '740095901', amount: 1000 } });
  const groups = JSON.stringify([[{ prop: 'amount', op: 'gte', value: 500000 }]]);
  const b = (await api('GET', `/board?pipeline=740095901&q=${encodeURIComponent(tag)}&groups=${encodeURIComponent(groups)}`)).data;
  const names = b.columns.flatMap((c) => c.deals.map((d) => d.name));
  assert.deepEqual(names, [`${tag} grande`]);
});

test('tablero: ponderado, «Cargar más», orden y datos de la tarjeta', async () => {
  const tag = `Tab ${Date.now().toString(36)}`;
  const pipe = (await api('GET', '/meta')).data.pipelines.find((p) => p.id === '740095901');
  const st = pipe.stages[1];
  const con = (await api('POST', '/records/contact', { props: { firstname: 'Tarjeta', lastname: tag, email: `t.${Date.now()}@formas.ar` } })).data;
  const ids = [];
  for (const amount of [1000, 3000, 2000]) {
    ids.push((await api('POST', '/records/deal', { props: { dealname: `${tag} ${amount}`, pipeline: pipe.id, dealstage: st.id, amount }, associations: [con.id] })).data.id);
  }
  await api('POST', '/activities', { type: 'task', subject: `Llamar ${tag}`, due_at: new Date(Date.now() + 86_400_000).toISOString(), links: [ids[0]] });
  const q = `pipeline=${pipe.id}&q=${encodeURIComponent(tag)}`;
  const b = (await api('GET', `/board?${q}&per_stage=2&sort=amount&dir=desc`)).data;
  const col = b.columns.find((c) => c.stage.id === st.id);
  assert.equal(col.total, 3);
  assert.equal(col.amount, 6000);
  assert.equal(Math.round(col.weighted), Math.round(6000 * st.probability));
  assert.deepEqual(col.deals.map((d) => d.props.amount), [3000, 2000], 'ordenado por monto, de mayor a menor, y corta en 2');
  assert.equal(col.deals[0].card.contact.name, `Tarjeta ${tag}`);
  const more = (await api('GET', `/board?${q}&per_stage=2&sort=amount&dir=desc&stage=${st.id}&offset=2`)).data;
  assert.deepEqual(more.deals.map((d) => d.props.amount), [1000], '«Cargar más» trae la que faltaba');
  assert.equal(more.deals[0].card.next.subject, `Llamar ${tag}`, 'próxima actividad en la tarjeta');
});

test('filtro de varios propietarios con «Sin asignar»', async () => {
  const tag = `Own ${Date.now().toString(36)}`;
  await api('POST', '/records/company', { props: { name: `${tag} mío`, domain: `${tag.replace(' ', '-').toLowerCase()}-a.com.ar` } });
  const nadie = (await api('POST', '/records/company', { props: { name: `${tag} nadie`, domain: `${tag.replace(' ', '-').toLowerCase()}-b.com.ar` } })).data;
  await api('PATCH', `/records/company/${nadie.id}`, { props: { owner_id: null } });
  const run = async (values) => (await api('GET', `/records/company?q=${encodeURIComponent(tag)}&groups=${encodeURIComponent(JSON.stringify([[{ prop: 'owner_id', op: 'in', values }]]))}`)).data.total;
  assert.equal(await run(['me']), 1);
  assert.equal(await run(['none']), 1);
  assert.equal(await run(['me', 'none']), 2);
});

test('pedidos: estados generales y tablero por estado', async () => {
  const stage = (await api('GET', '/meta')).data.properties.find((p) => p.object_type === 'order' && p.name === 'hs_pipeline_stage');
  assert.equal(stage?.type, 'enum');
  assert.deepEqual(stage.options.map((o) => o.label), ['Pedido confirmado', 'Listo para producción', 'Esperando boceto o confirmación', 'En producción', 'Listo para entregar', 'Entregado parcial', 'Entregado', 'Anulado']);
  const tag = `Ped ${Date.now().toString(36)}`;
  await api('POST', '/records/order', { props: { hs_order_name: tag, hs_pipeline_stage: '1237498994', hs_total_price: 5000 } });
  const b = (await api('GET', `/board-prop/order?prop=hs_pipeline_stage&q=${encodeURIComponent(tag)}`)).data;
  assert.equal(b.columns.find((c) => c.value === '1237498994').records[0].name, tag);
  const more = (await api('GET', `/board-prop/order?prop=hs_pipeline_stage&q=${encodeURIComponent(tag)}&value=1237498994&offset=0`)).data;
  assert.equal(more.records.length, 1);
});

test('perfiles: admin, comercial, producción y logística; el perfil admin es el permiso admin', async () => {
  const u = await api('POST', '/users', { email: `prod.${RUN}@formas.ar`, name: `Prod ${RUN}`, profile: 'produccion' });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  assert.deepEqual([u.data.profile, u.data.role], ['produccion', 'member']);
  const me = (await api('POST', '/users', { email: `vende2.${RUN}@formas.ar`, name: `Vende2 ${RUN}`, role: 'member' })).data;
  assert.equal(me.profile, 'comercial', 'sin perfil: comercial');
  const get = async () => (await api('GET', '/users')).data.find((x) => x.id === u.data.id);
  const pick = (x) => [x.profile, x.role];

  await api('PATCH', `/users/${u.data.id}`, { profile: 'admin' });
  assert.deepEqual(pick(await get()), ['admin', 'admin'], 'perfil admin da permiso admin');
  await api('PATCH', `/users/${u.data.id}`, { team_id: 57132078 });
  assert.deepEqual(pick(await get()), ['admin', 'admin'], 'cambiar el equipo no le saca el admin');
  await api('PATCH', `/users/${u.data.id}`, { profile: 'logistica' });
  assert.deepEqual(pick(await get()), ['logistica', 'member'], 'deja de ser admin: edita');
  await api('PATCH', `/users/${u.data.id}`, { role: 'manager' });
  assert.deepEqual(pick(await get()), ['logistica', 'manager']);
  await api('PATCH', `/users/${u.data.id}`, { role: 'admin' });
  assert.deepEqual(pick(await get()), ['admin', 'admin'], 'permiso admin da perfil admin');
  await api('PATCH', `/users/${u.data.id}`, { role: 'viewer' });
  assert.deepEqual(pick(await get()), ['comercial', 'viewer'], 'deja de ser admin sin elegir perfil: comercial');
  assert.equal((await api('PATCH', `/users/${u.data.id}`, { profile: 'jefe' })).status, 400);
  assert.equal((await api('POST', '/users', { email: `x.${RUN}@formas.ar`, name: 'X', role: 'dueño' })).status, 400);
});

test('usuarios: los equipos van en una sola lista (el primero es el principal)', async () => {
  const u = (await api('POST', '/users', { email: `equipos.${RUN}@formas.ar`, name: `Equipos ${RUN}`, teams: [57132078, 57393663] })).data;
  const get = async () => (await api('GET', '/users')).data.find((x) => x.id === u.id);
  let x = await get();
  assert.deepEqual([x.team_id, JSON.parse(x.extra_teams)], [57132078, [57393663]]);
  await api('PATCH', `/users/${u.id}`, { teams: [57132078, 57393663, 58079782] });
  x = await get();
  assert.deepEqual([x.team_id, JSON.parse(x.extra_teams)], [57132078, [57393663, 58079782]], 'sumar uno no cambia el principal');
  await api('PATCH', `/users/${u.id}`, { teams: [57393663, 58079782] });
  x = await get();
  assert.deepEqual([x.team_id, JSON.parse(x.extra_teams)], [57393663, [58079782]], 'si se saca el principal, pasa el siguiente');
  await api('PATCH', `/users/${u.id}`, { teams: [] });
  x = await get();
  assert.deepEqual([x.team_id, JSON.parse(x.extra_teams)], [null, []]);
  assert.equal((await api('POST', '/users', { email: `EQUIPOS.${RUN}@formas.ar`, name: 'Otra vez' })).status, 400, 'el mismo mail no se duplica');
});

test('usuarios: eliminar pasa sus registros y tareas abiertas a otro, no entra más y puede volver', async () => {
  const email = `chau.${RUN}@formas.ar`;
  const ida = (await api('POST', '/users', { email, name: `Chau ${RUN}`, teams: [57132078] })).data;
  const recibe = (await api('POST', '/users', { email: `recibe.${RUN}@formas.ar`, name: `Recibe ${RUN}` })).data;
  const contacto = (await api('POST', '/records/contact', { props: { firstname: 'Chau', lastname: RUN, email: `cliente.chau.${RUN}@ejemplo.com`, owner_id: ida.id } })).data;
  const negocio = (await api('POST', '/records/deal', { props: { dealname: `Negocio chau ${RUN}`, pipeline: 'default', owner_id: ida.id } })).data;
  const abierta = (await api('POST', '/activities', { type: 'task', subject: `Abierta ${RUN}`, owner_id: ida.id, links: [contacto.id] })).data;
  const hecha = (await api('POST', '/activities', { type: 'task', subject: `Hecha ${RUN}`, owner_id: ida.id, status: 'COMPLETED', links: [contacto.id] })).data;
  const nota = (await api('POST', '/activities', { type: 'note', body: `Nota ${RUN}`, owner_id: ida.id, links: [contacto.id] })).data;
  const token = (await api('POST', '/tokens', { name: `Token ${RUN}`, source: 'api', user_id: ida.id })).data;

  const uso = (await api('GET', `/users/${ida.id}/uso`)).data;
  assert.equal(uso.registros.contact, 1);
  assert.equal(uso.registros.deal, 1);
  assert.equal(uso.tareas_abiertas, 1);

  assert.equal((await api('DELETE', `/users/${ida.id}`, { reasignar_a: ida.id })).status, 400, 'no se le pasan a sí mismo');
  const me = (await api('GET', '/me')).data;
  assert.equal((await api('DELETE', `/users/${me.id}`, {})).status, 400, 'no te podés eliminar a vos');
  const r = await api('DELETE', `/users/${ida.id}`, { reasignar_a: recibe.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  assert.equal((await api('GET', `/records/contact/${contacto.id}`)).data.record.props.owner_id, recibe.id);
  assert.equal((await api('GET', `/records/deal/${negocio.id}`)).data.record.props.owner_id, recibe.id);
  const hist = (await api('GET', `/records/deal/${negocio.id}/history?prop=owner_id`)).data;
  assert.equal(String(hist[0].new_value), String(recibe.id), 'queda en el historial');
  assert.equal((await api('GET', `/activities/${abierta.id}`)).data.owner_id, recibe.id, 'la tarea abierta pasa');
  assert.equal((await api('GET', `/activities/${hecha.id}`)).data.owner_id, ida.id, 'la tarea hecha queda con su nombre');
  assert.equal((await api('GET', `/activities/${nota.id}`)).data.owner_id, ida.id, 'la nota queda con su nombre');

  assert.ok(!(await api('GET', '/users')).data.some((x) => x.id === ida.id), 'sale de la lista');
  const enMeta = (await api('GET', '/meta')).data.users.find((x) => x.id === ida.id);
  assert.ok(enMeta?.deleted_at && !enMeta.active, 'sigue en meta (para el nombre), marcado');
  const entra = await call('GET', '/api/me', undefined, { 'x-dev-user': email });
  assert.equal(entra.status, 403);
  assert.match(entra.data.error ?? JSON.stringify(entra.data), /no tiene usuario/);
  if (token?.token) assert.equal((await call('GET', '/api/me', undefined, { authorization: `Bearer ${token.token}` })).status, 401, 'su token queda revocado');
  assert.equal((await api('PATCH', `/users/${ida.id}`, { name: 'X' })).status, 404);
  assert.equal((await api('DELETE', `/users/${ida.id}`, {})).status, 404, 'ya está eliminado');

  const vuelve = await api('POST', '/users', { email, name: `Chau ${RUN}`, teams: [57393663] });
  assert.equal(vuelve.status, 201, JSON.stringify(vuelve.data));
  assert.equal(vuelve.data.id, ida.id, 'vuelve el mismo usuario, con su historial');
  assert.equal((await call('GET', '/api/me', undefined, { 'x-dev-user': email })).status, 200);

  // Sin propietario: los registros quedan sin asignar.
  const otro = (await api('POST', '/users', { email: `nadie.${RUN}@formas.ar`, name: `Nadie ${RUN}` })).data;
  const suyo = (await api('POST', '/records/contact', { props: { firstname: 'Sin', lastname: RUN, email: `sin.${RUN}@ejemplo.com`, owner_id: otro.id } })).data;
  assert.equal((await api('DELETE', `/users/${otro.id}`, { reasignar_a: null })).status, 200);
  assert.equal((await api('GET', `/records/contact/${suyo.id}`)).data.record.props.owner_id ?? null, null);
});
