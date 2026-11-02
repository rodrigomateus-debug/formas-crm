// Pedidos desde ClickUp, con la factura de Finnegans y el remito, contra un ClickUp y un Finnegans simulados (puerto 8797).
// Necesita en .dev.vars las variables de .dev.vars.example (CLICKUP_* y FINNEGANS_* apuntando a localhost:8797).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const PDV = String(70000 + Math.floor(Math.random() * 20000));
const PDV_ML = String(Number(PDV) + 1);
const PDV_B = String(Number(PDV) + 2);
const CUIT = `30-7${String(Date.now()).slice(-7)}-8`;
let asUser = null;
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path.startsWith('/hooks') ? '' : '/api'}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

// ---------- ClickUp y Finnegans simulados ----------
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = Buffer.from('%PDF-1.4 factura de prueba');
const field = (name, value, type = 'short_text') => ({ name, type, value });
const pdvTask = (id, npdv, unidad, statuses, attachments = []) => ({
  id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: String(Date.now()), status: { status: 'pdv' },
  text_content: `Pedido: PEDVTASTP - ${npdv}\nCliente: Cliente ${RUN} S.R.L.\nVendedor: Rodrigo Mateus\nEs evento: Sí\nFecha entrega: 30-11-2026`,
  custom_fields: [field('N° PDV', `PDV - ${npdv}`), field('CLIENTE', `Cliente ${RUN} S.R.L.`), field('🧑‍💻 VENDEDOR', 'Rodrigo Mateus'),
    { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: unidad } }, field('ENTREGAS (FECHA REAL)', '1793343600000', 'date')],
  subtasks: statuses.map((s, i) => ({ id: `${id}-${i}`, name: `Artículo ${i}`, parent: id, status: { status: s } })),
  attachments,
});
const cu = { statuses: ['ingreso de pedido', 'pdv'], attachments: [] };
let facturas = [];
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const p = decodeURIComponent(url.pathname);
    if (p === '/clickup/list/901326159292/task') {
      const tasks = [pdvTask('cuA', PDV, 'FORMAS SHOP', cu.statuses, cu.attachments), pdvTask('cuML', PDV_ML, 'MERCADO LIBRE ', ['pdv']), pdvTask('cuB', PDV_B, 'CORPORATE', ['pdv'])];
      return send({ tasks: tasks.flatMap((t) => [t, ...t.subtasks]), last_page: true });
    }
    if (p === '/clickup/task/cuA') return send({ ...pdvTask('cuA', PDV, 'FORMAS SHOP', cu.statuses, cu.attachments), attachments: cu.attachments.map((a) => ({ ...a, url: 'http://localhost:8797/archivos/remito.jpg' })) });
    if (p === '/clickup/task/cuML') return send(pdvTask('cuML', PDV_ML, 'MERCADO LIBRE ', ['pdv']));
    if (p === '/clickup/task/cuB') return send(pdvTask('cuB', PDV_B, 'CORPORATE', ['pdv']));
    if (p === '/archivos/remito.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(JPG); }
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV.padStart(8, '0')}`) return send({ Cliente: 'C-PRUEBA' });
    if (p === '/fin/cliente/C-PRUEBA') return send({ IdentificacionTributariaNumero: CUIT, RazonSocial: `CLIENTE ${RUN} SRL` });
    if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') {
      return send(url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen') === `PEDVTASTP - ${PDV.padStart(8, '0')}` ? facturas : []);
    }
    if (p === `/fin/facturaVenta/FC PEDVTASTP-${PDV.padStart(8, '0')} 1`) return send({ NumeroComprobante: 'A-00006-00012345', Fecha: '2026-10-30', CAE: '86400000000001', CAEFechaVto: '2026-11-09' });
    send({ error: 'no simulado' }, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server.close());

const order = async () => (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV}`)}`)).data.results[0];

test('pedidos desde ClickUp: alta, regla de la vendedora, estado por artículos, remito y factura', async (t) => {
  asUser = null;
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }
  const comp = (await api('POST', '/records/company', { props: { name: `Otro nombre ${RUN}`, domain: `cliente-${RUN}.com.ar`, cuit: CUIT } })).data;

  // 1. Alta: el PDV nuevo crea el pedido en «Pedido confirmado», con su empresa (por CUIT), vendedora, tipo y entrega.
  const r1 = (await api('POST', '/integrations/clickup/sync', { full: true })).data;
  assert.ok(!r1.error, r1.error);
  const o = await order();
  assert.ok(o, 'creó el pedido');
  assert.equal(o.props.hs_pipeline_stage, '4b27b500-f031-4927-9811-68a0b525cbae');
  assert.equal(o.props.unidad_de_negocio, 'FORMAS SHOP');
  assert.equal(o.props.tipo_de_pedido, 'EVENTO');
  assert.equal(o.props.fecha_de_entrega, '2026-11-30');
  assert.equal(o.props.pedido_finnegans, `PEDVTASTP - ${PDV}`);
  assert.ok(o.props.owner_id, 'con la vendedora');
  assert.equal((await api('GET', `/records/order/${o.id}`)).data.associations.company[0].id, comp.id, 'empresa por CUIT');
  assert.equal((await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV_ML}`)}`)).data.total, 0, 'Mercado Libre no crea pedidos');
  // Un pedido que entró antes que su empresa: cuando la empresa aparece en el CRM, la sincronización lo asocia.
  const b = (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV_B}`)}`)).data.results[0];
  assert.equal((await api('GET', `/records/order/${b.id}`)).data.associations.company.length, 0, 'sin empresa todavía');
  const compB = (await api('POST', '/records/company', { props: { name: `Cliente ${RUN} SRL` } })).data;
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await api('GET', `/records/order/${b.id}`)).data.associations.company[0]?.id, compB.id, 'empresa asociada después');

  // 2. La vendedora solo lo pasa a «Listo para producción»; el resto lo mueve ClickUp.
  await api('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vende ${RUN}`, role: 'member' });
  asUser = `vende.${RUN}@formas.ar`;
  assert.equal((await api('PATCH', `/records/order/${o.id}`, { props: { hs_pipeline_stage: '1237498994' } })).status, 403, 'no a En producción');
  assert.equal((await api('PATCH', `/records/order/${o.id}`, { props: { hs_pipeline_stage: '3725360f-519b-4b18-a593-494d60a29c9f' } })).status, 200);
  asUser = null;

  // 3. El estado sale de los artículos.
  cu.statuses = ['en el impresor', 'boceto pendiente'];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, 'esperando_boceto');
  cu.statuses = ['en el impresor', 'listo para entergar'];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, '1237498994');
  assert.match((await order()).props.detalle_produccion, /1 en el impresor/);

  // 4. Entregado: con el remito que suben a ClickUp.
  cu.statuses = ['entregados', 'entregados'];
  cu.attachments = [{ id: 'att1', title: `PDV ${PDV}.jpeg`, mimetype: 'image/jpeg', size: JPG.length, date: String(Date.now()) }];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, '1237498998');
  let files = (await api('GET', `/records/order/${o.id}/files`)).data;
  const remito = files.find((f) => f.kind === 'remito');
  assert.ok(remito?.ready, 'remito adjunto');
  const img = await api('GET', `/files/${remito.id}`);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(Buffer.from(img.data).length, JPG.length);

  // 5. Factura: aparece cuando tiene CAE; el PDF lo sube la tarea de GitHub.
  facturas = [{ DESTINONOMBRE: 'FCVTAELECT - 9999', DESTINOIDENTIFICACIONEXTERNA: `FC PEDVTASTP-${PDV.padStart(8, '0')} 1`, DESTINOTRANSACCIONID: 555, TIPODOCUMENTO: 'FCVTAELECT', CATEGORIATIPODOCUMENTO: -8, DESTINOIMPORTETOTAL: 121000, OBTUVOCAE: 'NO', DESTINOFECHA: '30-10-2026' }];
  for (let i = 0; i < 20 && !(await api('POST', '/integrations/finnegans/sync')).data.error; i++) if ((await api('GET', '/integrations/pedidos')).data.finnegans.cursor === 0) break;
  assert.equal((await api('GET', `/records/order/${o.id}/files`)).data.filter((f) => f.kind === 'factura').length, 0, 'sin CAE todavía no');
  facturas[0].OBTUVOCAE = 'SI';
  for (let i = 0; i < 20; i++) {
    await api('POST', '/integrations/finnegans/sync');
    if ((await api('GET', `/records/order/${o.id}/files`)).data.some((f) => f.kind === 'factura')) break;
  }
  files = (await api('GET', `/records/order/${o.id}/files`)).data;
  const fac = files.find((f) => f.kind === 'factura');
  assert.equal(fac?.meta.numero, 'A-00006-00012345');
  assert.equal(fac.ready, false, 'el PDF todavía no');
  assert.equal((await order()).props.factura_numero, 'A-00006-00012345');
  assert.equal((await api('GET', `/files/${fac.id}`)).status, 404);
  const tok = (await api('POST', '/tokens', { name: `PDF ${RUN}`, source: 'api' })).data.token;
  const auth = { authorization: `Bearer ${tok}` };
  const pend = (await api('GET', '/hooks/facturas/pendientes', undefined, auth)).data;
  assert.ok(pend.some((p) => p.id === fac.id && p.transaccion_id === 555));
  assert.equal((await api('PUT', `/hooks/facturas/${fac.id}/pdf`, 'no soy un pdf', { ...auth, 'content-type': 'application/pdf' })).status, 400);
  assert.equal((await api('PUT', `/hooks/facturas/${fac.id}/pdf`, new Uint8Array(PDF), { ...auth, 'content-type': 'application/pdf' })).status, 200);
  const pdf = await api('GET', `/files/${fac.id}`);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(Buffer.from(pdf.data).toString(), PDF.toString());

  // 6. En la línea de tiempo se ve cómo avanzó.
  const tl = (await api('GET', `/records/order/${o.id}/timeline`)).data;
  assert.ok(tl.changes.some((c) => c.prop === 'hs_pipeline_stage') && tl.changes.some((c) => c.prop === 'factura_numero'));
});
