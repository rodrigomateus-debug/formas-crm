// Negocio ↔ pedido ↔ Finnegans (vinculos.ts, pedidosfin.ts): el N° de PDV del negocio lo asocia con su pedido, los pedidos
// se dan de alta desde el informe de Finnegans sin duplicar los de ClickUp, las facturas se leen solo cuando hay una nueva
// y Finnegans puede avisar por webhook. Con un Finnegans simulado (puerto 8797) y las variables de .dev.vars.example.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const N = 400000 + Math.floor(Math.random() * 90000);   // números de PDV de esta corrida
const CUIT = `30-6${String(Date.now()).slice(-7)}-1`;
const PASOS = '990934411';        // «Pasos operativos» de Formas Shop (Inbound)
const GANADO_CORP = '989921336';  // «Cierre Ganado» de Corporate
let asUser = null;
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path.startsWith('/hooks') ? '' : '/api'}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

// ---------- Finnegans simulado ----------
const pedidas = [];   // cada consulta que recibió
const fin = { facturas: {} };
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    pedidas.push(p + (url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen') ? `?${url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen')}` : ''));
    if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') return send(fin.facturas[url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen')] ?? []);
    if (p.startsWith('/fin/facturaVenta/')) return send({ NumeroComprobante: 'A-00006-00099001', Fecha: '2026-11-12', CAE: '86400000000009', CAEFechaVto: '2026-11-22' });
    // El pedido que nombra el aviso (por su identificación externa, como la manda el cotizador) y uno de FP DEMO.
    if (p === `/fin/pedidoVenta/AVISO ${RUN}`) return send({ Cliente: 'C-AVISO', EmpresaCodigo: 'EMPRE01', NumeroInterno: N + 5, MonedaCodigo: 'PES', Fecha: '2026-11-13', VendedorCodigo: 'nadie@formas.ar', USR_FechaEntrega: '2026-12-01', USR_EsEvento: true, Items: [] });
    if (p === `/fin/pedidoVenta/DEMO ${RUN}`) return send({ Cliente: 'C-AVISO', EmpresaCodigo: '7', NumeroInterno: N + 6, Fecha: '2026-11-13', Items: [] });
    if (p === '/fin/cliente/C-AVISO') return send({ IdentificacionTributariaNumero: CUIT, RazonSocial: `VINCULO ${RUN} SA` });
    send({ error: 'no simulado' }, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server.close());

const tokenAdmin = async () => (await api('POST', '/tokens', { name: `Vinculos ${RUN}`, source: 'api' })).data.token;
const pedidoPorNombre = async (n) => (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${n}`)}`)).data.results.filter((o) => String(o.props.pdv_finnegans) === String(n));
const asociados = async (type, id) => (await api('GET', `/records/${type}/${id}`)).data.associations;

test('negocio y pedido: el N° de PDV los asocia, y los pedidos entran desde Finnegans sin duplicarse', async () => {
  asUser = null;
  const tok = await tokenAdmin();
  const auth = { authorization: `Bearer ${tok}` };
  const totales = (body) => api('POST', '/hooks/pedidos/totales', body, auth);
  const empresa = (await api('POST', '/records/company', { props: { name: `Vinculo ${RUN} SA`, cuit: CUIT } })).data;

  // 0. Las etapas que piden el N° de PDV (sin obligar): «Pasos operativos» y, en Corporate, «Cierre Ganado».
  const meta = (await api('GET', '/meta')).data;
  const etapa = (id) => meta.pipelines.flatMap((p) => p.stages).find((s) => s.id === id);
  assert.deepEqual(etapa(PASOS).config.ask_props, ['pdv_finnegans']);
  assert.deepEqual(etapa(GANADO_CORP).config.ask_props, ['pdv_finnegans']);
  assert.ok(!(etapa(PASOS).config.required_props ?? []).includes('pdv_finnegans'), 'es opcional');

  // 1. El pedido ya está en el CRM (entró por ClickUp): al cargar el número en el negocio, quedan asociados.
  const o1 = (await api('POST', '/records/order', { props: { hs_order_name: `PDV ${N} · Vinculo ${RUN}`, pdv_finnegans: String(N), unidad_de_negocio: 'FORMAS SHOP', hs_total_price: 150000 } })).data;
  const d1 = (await api('POST', '/records/deal', { props: { dealname: `Negocio uno ${RUN}`, pipeline: 'default', amount: 100000 }, associations: [empresa.id] })).data;
  // Pasar a «Pasos operativos» sin el número no rebota (es opcional).
  assert.equal((await api('PATCH', `/records/deal/${d1.id}`, { props: { dealstage: PASOS, pdv_finnegans: '' } })).status, 200);
  const r1 = await api('PATCH', `/records/deal/${d1.id}`, { props: { pdv_finnegans: `PDV ${N}` } });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.props.pdv_finnegans, String(N), 'se guarda solo el número');
  assert.deepEqual((await asociados('deal', d1.id)).order.map((x) => x.id), [o1.id], 'asociado con su pedido');
  assert.equal(Number(r1.data.props.amount), 150000, 'el monto del negocio pasa a ser el del pedido');
  // El mismo PDV en otro negocio rebota, sin cambiar nada.
  const d2 = (await api('POST', '/records/deal', { props: { dealname: `Negocio dos ${RUN}`, pipeline: 'default', amount: 5 }, associations: [empresa.id] })).data;
  const rep = await api('PATCH', `/records/deal/${d2.id}`, { props: { pdv_finnegans: String(N), dealstage: PASOS } });
  assert.equal(rep.status, 409);
  assert.match(rep.data.error, /ya está cargado en el negocio/);
  assert.notEqual((await api('GET', `/records/deal/${d2.id}`)).data.record.props.dealstage, PASOS, 'rebota antes de cambiar la etapa');

  // 2. El número se carga antes de que exista el pedido: queda esperando, y cuando el pedido llega de Finnegans se asocia.
  assert.equal((await api('PATCH', `/records/deal/${d2.id}`, { props: { pdv_finnegans: String(N + 1), dealstage: PASOS } })).status, 200);
  assert.equal((await asociados('deal', d2.id)).order.length, 0, 'todavía no hay pedido');
  const hoy = new Date().toISOString().slice(0, 10);
  const informe = { totales: { [`PEDVTASTP - ${N + 1}`]: 321000 }, vendedores: {}, pedidos: {
    [`PEDVTASTP - ${N + 1}`]: { cliente: `VINCULO ${RUN} S.A.`, cuit: CUIT, vendedor: 'Nadie', fecha: hoy, entrega: '2026-12-10', evento: false },
    [`PEDVTAML - ${N + 2}`]: { cliente: 'Mercado Libre', fecha: hoy },   // Mercado Libre no es un pedido del CRM
  } };
  const t1 = await totales(informe);
  assert.equal(t1.status, 200);
  assert.equal(t1.data.nuevos.creados, 1);
  const [o2] = await pedidoPorNombre(N + 1);
  assert.ok(o2, 'el pedido se dio de alta desde Finnegans');
  assert.equal(o2.props.unidad_de_negocio, 'FORMAS SHOP', 'la unidad sale del tipo de documento');
  assert.equal(o2.props.pedido_finnegans, `PEDVTASTP - ${N + 1}`);
  assert.equal(o2.props.fecha_de_entrega, '2026-12-10');
  assert.equal(Number(o2.props.hs_total_price), 321000, 'con su total en la misma pasada');
  const a2 = await asociados('order', o2.id);
  assert.equal(a2.company[0]?.id, empresa.id, 'con su empresa, por CUIT');
  assert.deepEqual(a2.deal.map((x) => x.id), [d2.id], 'y con el negocio que tenía su número');
  assert.equal(Number((await api('GET', `/records/deal/${d2.id}`)).data.record.props.amount), 321000);
  assert.equal((await pedidoPorNombre(N + 2)).length, 0, 'Mercado Libre no entra');

  // 3. No se duplica: el mismo informe otra vez no crea nada; un pedido que ya estaba por su número (de ClickUp, sin el
  //    pedido de Finnegans) se completa en vez de crearse otro; el mismo número en otra unidad sí es otro pedido.
  assert.equal((await totales(informe)).data.nuevos.creados, 0);
  assert.equal((await pedidoPorNombre(N + 1)).length, 1);
  const o3 = (await api('POST', '/records/order', { props: { hs_order_name: `PDV ${N + 3} · de ClickUp ${RUN}`, pdv_finnegans: String(N + 3), unidad_de_negocio: 'FORMAS SHOP' } })).data;
  const t3 = await totales({ totales: {}, pedidos: {
    [`PEDVTASTP - ${N + 3}`]: { cliente: `VINCULO ${RUN} S.A.`, cuit: CUIT, fecha: hoy },
    [`PEDVTAFP - ${N + 3}`]: { cliente: `VINCULO ${RUN} S.A.`, cuit: CUIT, fecha: hoy },
  } });
  assert.deepEqual([t3.data.nuevos.completados, t3.data.nuevos.creados], [1, 1]);
  const tres = await pedidoPorNombre(N + 3);
  assert.equal(tres.length, 2, 'uno por unidad');
  assert.equal(tres.find((o) => o.id === o3.id).props.pedido_finnegans, `PEDVTASTP - ${N + 3}`, 'el de ClickUp quedó con su pedido de Finnegans');
  assert.equal(tres.find((o) => o.id !== o3.id).props.unidad_de_negocio, 'CORPORATE');
  const dup = (await api('GET', '/integrations/pedidos')).data.finnegans.duplicados;
  assert.ok(!dup.some((g) => [N, N + 1, N + 3].includes(Number(g.pdv))), 'ninguno de estos quedó repetido');

  // 4. Sin número: si la empresa tiene un solo negocio esperando pedido en esa unidad, se asocia solo. El Corporate de
  //    recién (N + 3) no tiene negocio de Corporate: queda sin negocio.
  const d4 = (await api('POST', '/records/deal', { props: { dealname: `Negocio cuatro ${RUN}`, pipeline: 'default', amount: 9, dealstage: PASOS }, associations: [empresa.id] })).data;
  await totales({ totales: { [`PEDVTASTP - ${N + 4}`]: 77000 }, pedidos: { [`PEDVTASTP - ${N + 4}`]: { cliente: `VINCULO ${RUN} S.A.`, cuit: CUIT, fecha: hoy } } });
  const [o4] = await pedidoPorNombre(N + 4);
  assert.deepEqual((await asociados('order', o4.id)).deal.map((x) => x.id), [d4.id], 'el único negocio que esperaba pedido');
  assert.equal((await asociados('order', tres.find((o) => o.id !== o3.id).id)).deal.length, 0, 'el de Corporate, sin negocio');

  // 5. Facturas: el informe avisa una factura con CAE de un pedido; la sincronización consulta a Finnegans solo ese pedido.
  const ie = `FC PEDVTASTP-${String(N + 1).padStart(8, '0')} 1`;
  fin.facturas[`PEDVTASTP - ${String(N + 1).padStart(8, '0')}`] = [{ DESTINONOMBRE: `FCVTAELECT - ${N}`, DESTINOIDENTIFICACIONEXTERNA: ie, DESTINOTRANSACCIONID: 1, TIPODOCUMENTO: 'FCVTAELECT',
    CATEGORIATIPODOCUMENTO: -8, DESTINOIMPORTETOTAL: 388410, OBTUVOCAE: 'SI', DESTINOFECHA: '12/11/2026' }];
  const s5 = await api('POST', '/hooks/pedidos/saldos', { filas: [], facturas: {
    [`EMPRE01|FCVTAELECT - ${N}`]: { pedido: `PEDVTASTP - ${N + 1}`, factor: 1.21, ie: ie.toUpperCase(), cae: true },
    [`EMPRE01|NCVEE - ${N + 1}`]: { pedido: `PEDVTASTP - ${N + 4}`, factor: 1.21, ie: 'NC X 1', cae: true },                 // una nota de crédito no se adjunta
    [`7|FCVTAELECT - ${N + 2}`]: { pedido: `PEDVTASTP - ${N + 4}`, factor: 1.21, ie: 'FC DEMO 1', cae: true },               // FP DEMO tampoco
    [`EMPRE01|FCVTAELECT - ${N + 3}`]: { pedido: `PEDVTASTP - ${N + 4}`, factor: 1.21, ie: 'FC SIN CAE 1' },                 // sin CAE todavía
  } }, auth);
  assert.equal(s5.status, 200);
  pedidas.length = 0;
  const f5 = (await api('POST', '/integrations/finnegans/sync', { barrido: false })).data;
  assert.ok(!f5.error, f5.error);
  const informes = pedidas.filter((x) => x.startsWith('/fin/reports/ApiGetDocumentosDestino'));
  assert.ok(informes.some((x) => x.endsWith(String(N + 1).padStart(8, '0'))), 'consultó el pedido con la factura nueva');
  assert.ok(!informes.some((x) => x.endsWith(String(N + 4).padStart(8, '0'))), 'y no los otros');
  assert.equal((await api('GET', `/records/order/${o2.id}`)).data.record.props.factura_numero, 'A-00006-00099001', 'la factura quedó en el pedido');
  // Ya adjunta: otra pasada no vuelve a consultar ese pedido.
  pedidas.length = 0;
  await api('POST', '/hooks/pedidos/saldos', { filas: [], facturas: { [`EMPRE01|FCVTAELECT - ${N}`]: { pedido: `PEDVTASTP - ${N + 1}`, factor: 1.21, ie, cae: true } } }, auth);
  await api('POST', '/integrations/finnegans/sync', { barrido: false });
  assert.ok(!pedidas.some((x) => x.endsWith(String(N + 1).padStart(8, '0'))), 'sin novedades, sin consultas');

  // 6. El aviso de Finnegans (webhook): con la llave en la dirección; el pedido que nombra se da de alta en el momento.
  const vende = `vende.vinc.${RUN}@formas.ar`;
  await api('POST', '/users', { email: vende, name: `Vende ${RUN}` });
  asUser = vende;
  assert.equal((await api('POST', '/integrations/finnegans/webhook', {})).status, 403, 'la dirección la pide un administrador');
  asUser = null;
  const hook = (await api('POST', '/integrations/finnegans/webhook', {})).data.url;
  assert.match(hook, /\/hooks\/finnegans\/[0-9a-f]{64}$/);
  assert.equal((await api('POST', '/integrations/finnegans/webhook', {})).data.url, hook, 'siempre la misma');
  assert.equal((await api('POST', '/hooks/finnegans/llave-equivocada', { x: 1 })).status, 404);
  const camino = new URL(hook).pathname;
  // Como lo manda Finnegans: el tipo de documento, la identificación externa y el evento; con un token suyo en la dirección.
  const aviso = (code, event = 'create', type = 'PEDVTASTP') => api('POST', `${camino}?access_token=secreto-${RUN}&async=1`,
    { eventID: 1, webhook: 'FORMAS_HUB_PEDIDOS', webhookType: 'Documento', token: `secreto-${RUN}`, object: { type, category: 'PDV', code, event }, params: {}, sucursal: '7' });
  assert.equal((await aviso(`AVISO ${RUN}`)).status, 200);
  const [o6] = await pedidoPorNombre(N + 5);
  assert.ok(o6, 'el pedido del aviso se dio de alta');
  assert.equal(o6.props.pedido_finnegans, `PEDVTASTP - ${N + 5}`, 'con el número que le dio Finnegans');
  assert.equal(o6.props.tipo_de_pedido, 'EVENTO');
  assert.equal(o6.props.fecha_de_entrega, '2026-12-01');
  assert.equal((await asociados('order', o6.id)).company[0]?.id, empresa.id);
  // Un pedido de FP DEMO, una anulación, otro tipo de documento o algo que no es un aviso: solo quedan registrados.
  await aviso(`DEMO ${RUN}`);
  assert.equal((await pedidoPorNombre(N + 6)).length, 0, 'FP DEMO no entra');
  assert.equal((await aviso(`AVISO ${RUN}`, 'nullify')).status, 200);
  assert.equal((await aviso(`AVISO ${RUN}`, 'create', 'FP_PDVMELI')).status, 200);
  assert.equal((await api('POST', camino, 'hola')).status, 200);
  assert.equal((await api('GET', camino)).status, 200, 'también por GET, como prueba Finnegans la dirección');
  // El registro guarda lo que llegó, sin los tokens de Finnegans.
  const registro = (await api('GET', '/inbound')).data.filter((x) => x.source === 'finnegans');
  assert.ok(registro.some((x) => x.payload.includes(`AVISO ${RUN}`)), 'queda registrado');
  assert.ok(!registro.some((x) => x.payload.includes(`secreto-${RUN}`)), 'sin los tokens');
});

test('razón social: manda la empresa del negocio; si no, la del CUIT; si nadie la tiene, se sugiere', async () => {
  asUser = null;
  const tok = await tokenAdmin();
  const auth = { authorization: `Bearer ${tok}` };
  const hoy = new Date().toISOString().slice(0, 10);
  const base = String(Date.now()).slice(-7);
  const cuit = (k) => `30${base}${k}1`;   // 11 números
  const llegar = (n, razon, c) => api('POST', '/hooks/pedidos/totales', { totales: {}, pedidos: { [`PEDVTASTP - ${n}`]: { cliente: razon, cuit: c, fecha: hoy } } }, auth);
  const razon = async (type, id) => (await api('GET', `/records/${type}/${id}/razon-social`)).data;
  const M = N + 100;

  // 1. El negocio ya tiene su empresa: queda esa aunque el pedido venga con otra razón social, que pasa a ser una de las suyas.
  const marca = (await api('POST', '/records/company', { props: { name: `Marca ${RUN}` } })).data;
  const d1 = (await api('POST', '/records/deal', { props: { dealname: `Con empresa ${RUN}`, pipeline: 'default', amount: 1, dealstage: PASOS, pdv_finnegans: String(M) }, associations: [marca.id] })).data;
  await llegar(M, `RAZON UNO ${RUN} SA`, cuit(1));
  const [o1] = await pedidoPorNombre(M);
  assert.equal(o1.props.razon_social, `RAZON UNO ${RUN} SA`);
  assert.equal(o1.props.cuit, cuit(1));
  const a1 = await asociados('order', o1.id);
  assert.deepEqual([a1.deal[0]?.id, a1.company[0]?.id], [d1.id, marca.id], 'el pedido queda con la empresa del negocio');
  assert.deepEqual((await razon('company', marca.id)).razones.map((z) => z.cuit), [cuit(1)], 'y esa razón social es de la empresa');
  const r1 = await razon('order', o1.id);
  assert.equal(r1.sugerida, false);
  assert.equal(r1.empresa.id, marca.id);
  // Otro pedido con ese CUIT, sin negocio: va solo a esa empresa.
  await llegar(M + 1, `RAZON UNO ${RUN} SA`, cuit(1));
  const [o1b] = await pedidoPorNombre(M + 1);
  assert.equal((await asociados('order', o1b.id)).company[0]?.id, marca.id, 'por el CUIT');

  // 2. Nadie tiene ese CUIT y el negocio no tiene empresa (lo normal en el Shop): queda como empresa sugerida.
  const d2 = (await api('POST', '/records/deal', { props: { dealname: `Sin empresa ${RUN}`, pipeline: 'default', amount: 1, dealstage: PASOS, pdv_finnegans: String(M + 2) } })).data;
  await llegar(M + 2, `RAZON DOS ${RUN} SRL`, cuit(2));
  const [o2] = await pedidoPorNombre(M + 2);
  assert.equal((await asociados('order', o2.id)).company.length, 0, 'no se adivina la empresa');
  const r2 = await razon('order', o2.id);
  assert.deepEqual([r2.sugerida, r2.pedido.razon, r2.de], [true, `RAZON DOS ${RUN} SRL`, null]);
  assert.equal((await razon('deal', d2.id)).sugerida, true, 'también se ve desde el negocio');
  // Crear la empresa con esa razón social: queda en el pedido y en el negocio.
  assert.equal((await api('POST', `/records/order/${o2.id}/razon-social`, { accion: 'otra' })).status, 400);
  const c2 = (await api('POST', `/records/order/${o2.id}/razon-social`, { accion: 'crear' })).data;
  assert.equal(c2.sugerida, false);
  assert.equal(c2.empresa.name, `RAZON DOS ${RUN} SRL`);
  assert.equal((await asociados('deal', d2.id)).company[0]?.id, c2.empresa.id, 'la empresa queda también en el negocio');
  assert.equal((await api('GET', `/records/company/${c2.empresa.id}`)).data.record.props.cuit, cuit(2));

  // 3. Asignarla a una empresa que ya está: la razón social se suma a las de esa empresa.
  await llegar(M + 3, `RAZON TRES ${RUN} SA`, cuit(3));
  const [o3] = await pedidoPorNombre(M + 3);
  assert.equal((await razon('order', o3.id)).sugerida, true);
  assert.equal((await api('POST', `/records/order/${o3.id}/razon-social`, { accion: 'asignar', company_id: marca.id })).status, 200);
  assert.equal((await asociados('order', o3.id)).company[0]?.id, marca.id);
  assert.deepEqual((await razon('company', marca.id)).razones.map((z) => z.cuit).sort(), [cuit(1), cuit(3)].sort(), 'una empresa con dos razones sociales');

  // 4. Crear una empresa con otro nombre (la marca) que factura con esa razón social.
  await llegar(M + 4, `RAZON CUATRO ${RUN} SA`, cuit(4));
  const [o4] = await pedidoPorNombre(M + 4);
  assert.equal((await api('POST', `/records/order/${o4.id}/razon-social`, { accion: 'crear_con_nombre', name: '' })).status, 400);
  const c4 = (await api('POST', `/records/order/${o4.id}/razon-social`, { accion: 'crear_con_nombre', name: `Otra marca ${RUN}` })).data;
  assert.equal(c4.empresa.name, `Otra marca ${RUN}`);
  assert.equal((await api('GET', `/records/company/${c4.empresa.id}`)).data.record.props.razon_social, `RAZON CUATRO ${RUN} SA`);
  // Un CUIT que ya es de una empresa no se puede dar a otra: avisa de quién es.
  await llegar(M + 5, `RAZON CUATRO ${RUN} SA`, cuit(4));
  const [o5] = await pedidoPorNombre(M + 5);
  assert.equal((await asociados('order', o5.id)).company[0]?.id, c4.empresa.id, 'el segundo pedido de esa razón social ya sabe su empresa');
});
