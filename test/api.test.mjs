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
  const tasks = await api('GET', `/tasks?q=${RUN}`);
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

test('avisa por webhook cuando se gana un negocio (para Darwin)', async () => {
  const received = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ body: JSON.parse(b), sig: req.headers['x-formas-crm-signature'] }); res.end('ok'); }); });
  await new Promise((r) => server.listen(8797, r));
  try {
    const put = await api('PUT', '/webhooks', [{ event: 'deal.won', url: 'http://localhost:8797/darwin', secret: 's3cr3t', name: 'Darwin' }]);
    assert.equal(put.status, 200, JSON.stringify(put.data));
    await api('PATCH', `/records/deal/${state.darwinDeal}`, { props: { dealstage: 'presentationscheduled' } });
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
