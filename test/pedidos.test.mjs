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
const PDV_C = String(Number(PDV) + 3);   // de una vendedora que todavía no tiene usuario en el CRM
const CUIT = `30-7${String(Date.now()).slice(-7)}-8`;
const RECIBIDO = Date.now() - 86_400_000;   // ENTREGAS (FECHA REAL): ayer
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
const pdvTask = (id, npdv, unidad, statuses, attachments = [], updated = Date.now(), vendedor = 'Rodrigo Mateus', viejo = false) => ({
  id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: String(updated), status: { status: 'pdv' },
  // Los PDV viejos no tienen «Pedido:»: traen «Tipo de Documento» y una «Fecha pedido» que no es el número.
  text_content: viejo
    ? `PDV - ${npdv}\nTipo de Documento: PEDVTAFP\nCliente: Cliente ${RUN} S.R.L.\nVendedor: ${vendedor}\nEs evento: No\nFecha pedido: 31-03-2026\nFecha entrega: 30-11-2026`
    : `Pedido: PEDVTASTP - ${npdv}\nCliente: Cliente ${RUN} S.R.L.\nVendedor: ${vendedor}\nEs evento: Sí\nFecha entrega: 30-11-2026`,
  custom_fields: [field('N° PDV', `PDV - ${npdv}`), field('CLIENTE', `Cliente ${RUN} S.R.L.`), field('🧑‍💻 VENDEDOR', vendedor),
    { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: unidad } }, field('ENTREGAS (FECHA REAL)', String(RECIBIDO), 'date')],
  subtasks: statuses.map((s, i) => ({ id: `${id}-${i}`, name: `Taza ${i} - Proveedor`, parent: id, date_updated: String(updated), status: { status: s },
    text_content: `PDV - ${npdv}\nProducto: Taza ${i}\nCantidad: 1.000\nCódigo: TAZA\\_${i}`, custom_fields: [field('CANTIDAD ', '150', 'number')] })),
  attachments,
});
const cu = { statuses: ['ingreso de pedido', 'pdv'], attachments: [], artAttachments: [], bulk: 0, cGone: false, puts: [] };
const pdvC = () => pdvTask('cuC', PDV_C, 'CORPORATE', ['pdv'], [], Date.now(), `Nueva ${RUN}`, true);
const BULK = (i) => String(Number(PDV) + 100 + i);
const AYER = Date.now() - 86_400_000;
let hits = 0;   // consultas que recibe el ClickUp/Finnegans simulado
let facturas = [];
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits++;
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const p = decodeURIComponent(url.pathname);
    // Lo único que el CRM escribe en ClickUp: el estado de las tareas («ingreso de pedido» → «pdv»).
    if (req.method === 'PUT' && p.startsWith('/clickup/task/')) {
      let body = '';
      req.on('data', (ch) => { body += ch; });
      req.on('end', () => { cu.puts.push({ id: p.slice(14), status: JSON.parse(body || '{}').status }); send({ id: p.slice(14) }); });
      return;
    }
    if (p === '/clickup/list/901326159292/task') {
      const tasks = [pdvTask('cuA', PDV, 'FORMAS SHOP', cu.statuses, cu.attachments), pdvTask('cuML', PDV_ML, 'MERCADO LIBRE ', ['pdv']), pdvTask('cuB', PDV_B, 'CORPORATE', ['pdv']), pdvC(),
        ...Array.from({ length: cu.bulk }, (_, i) => pdvTask(`cuN${i}`, BULK(i), 'FORMAS SHOP', ['en el impresor'], [], AYER))].flatMap((t) => [t, ...t.subtasks]).filter((t) => Number(t.date_updated) > Number(url.searchParams.get('date_updated_gt') ?? 0));
      const page = Number(url.searchParams.get('page') ?? 0);
      return send({ tasks: tasks.slice(page * 100, page * 100 + 100), last_page: (page + 1) * 100 >= tasks.length });
    }
    if (p === '/clickup/task/cuA') return send({ ...pdvTask('cuA', PDV, 'FORMAS SHOP', cu.statuses, cu.attachments), attachments: cu.attachments.map((a) => ({ ...a, url: 'http://localhost:8797/archivos/remito.jpg' })) });
    if (p === '/clickup/task/cuML') return send(pdvTask('cuML', PDV_ML, 'MERCADO LIBRE ', ['pdv']));
    if (p === '/clickup/task/cuB') return send(pdvTask('cuB', PDV_B, 'CORPORATE', ['pdv']));
    if (p === '/clickup/task/cuC') return cu.cGone ? send({ err: 'Task not found' }, 404) : send(pdvC());
    if (p.startsWith('/clickup/task/cuN')) { const i = Number(p.slice(17)); return send(pdvTask(`cuN${i}`, BULK(i), 'FORMAS SHOP', ['en el impresor'], [], AYER)); }
    if (/^\/clickup\/task\/cuA-\d+$/.test(p)) return send({ id: p.slice(14), name: 'Artículo', parent: 'cuA', status: { status: 'entregados' }, attachments: p.endsWith('-0') ? cu.artAttachments.map((a) => ({ ...a, url: 'http://localhost:8797/archivos/remito.jpg' })) : [] });
    if (p === '/archivos/remito.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(JPG); }
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV.padStart(8, '0')}`) {
      return send({ Cliente: 'C-PRUEBA', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'IMP_P18.030.03', Cantidad: 300, Precio: 8339.6, Descuento1: 0, Descuento2: 0, Descripcion: '', IncluyeImpuesto: false },
        { ProductoCodigo: 'OTRO-1', Cantidad: 10, Precio: 100, Descuento1: 10, Descuento2: 0, Descripcion: 'Con logo a 1 color', IncluyeImpuesto: false },
      ] });
    }
    if (p === '/fin/producto/IMP_P18.030.03') return send({ Nombre: 'Bolsa Shopper Colors Azul Marino', Descripcion: 'Bolsa de lona con base de yute.', ProductoImagen: 'https://www.promoproductos.com/upload/bolsa.jpg' });
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
  // Un pedido de una vendedora sin usuario queda sin vendedora; cuando se le da el alta, «Revisar todo» (también con token
  // por /hooks/pedidos/revisar) se la pone con lo que trae la lista, sin volver a pedir el PDV.
  const c = (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV_C}`)}`)).data.results[0];
  assert.ok(c && !c.props.owner_id, 'sin vendedora todavía');
  const nueva = (await api('POST', '/users', { email: `nueva.${RUN}@formas.ar`, name: `Nueva ${RUN}`, role: 'member' })).data;
  cu.cGone = true;
  const tokR = (await api('POST', '/tokens', { name: `Revisar ${RUN}`, source: 'api' })).data.token;
  assert.equal((await api('POST', '/hooks/pedidos/revisar')).status, 401, 'sin token no');
  assert.equal((await api('POST', '/hooks/pedidos/revisar', undefined, { authorization: `Bearer ${tokR}` })).status, 200);
  assert.equal((await api('GET', `/records/order/${c.id}`)).data.record.props.owner_id, nueva.id, 'con la vendedora nueva');

  // 2. La vendedora solo lo pasa a «Listo para producción»; el resto lo mueve ClickUp.
  await api('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vende ${RUN}`, role: 'member' });
  asUser = `vende.${RUN}@formas.ar`;
  assert.equal((await api('PATCH', `/records/order/${o.id}`, { props: { hs_pipeline_stage: '1237498994' } })).status, 403, 'no a En producción');
  assert.equal((await api('PATCH', `/records/order/${o.id}`, { props: { hs_pipeline_stage: '3725360f-519b-4b18-a593-494d60a29c9f' } })).status, 200);
  asUser = null;
  // En ClickUp, lo que seguía en «ingreso de pedido» pasa a «pdv» (el artículo 0); lo que ya estaba en «pdv» no se toca.
  for (let i = 0; i < 30 && !cu.puts.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(cu.puts, [{ id: 'cuA-0', status: 'pdv' }]);

  // 3. El estado sale de los artículos.
  cu.statuses = ['en el impresor', 'boceto pendiente'];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, 'esperando_boceto');
  cu.statuses = ['en el impresor', 'listo para entergar'];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, '1237498994');
  assert.match((await order()).props.detalle_produccion, /1 en el impresor/);

  // 4. Entregado: con el remito que suben a ClickUp (al artículo, como hacen en la realidad; se busca al abrir el pedido).
  cu.statuses = ['entregados', 'entregados'];
  cu.artAttachments = [{ id: 'att1', title: `PDV ${PDV}.jpeg`, mimetype: 'image/jpeg', size: JPG.length, date: String(Date.now()) }];
  await api('POST', '/integrations/clickup/sync', { full: true });
  assert.equal((await order()).props.hs_pipeline_stage, '1237498998');
  let files = (await api('GET', `/records/order/${o.id}/files`)).data;
  const remito = files.find((f) => f.kind === 'remito');
  assert.ok(remito?.ready, 'remito adjunto');
  const img = await api('GET', `/files/${remito.id}`);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(Buffer.from(img.data).length, JPG.length);

  // La tarea post-entrega: para la vendedora, a los 3 días de recibido, asociada al pedido. Una sola aunque se relea.
  await api('POST', '/integrations/clickup/sync', { full: true });
  const post = (await api("GET", `/records/order/${o.id}/timeline?types=task`)).data.activities.filter((a) => /^Post-entrega/.test(a.subject));
  assert.equal(post.length, 1, 'una tarea post-entrega');
  assert.match(post[0].subject, new RegExp(`PDV ${PDV}`));
  assert.equal(post[0].owner_id, (await order()).props.owner_id);
  const recibido = new Date(RECIBIDO - 3 * 3600_000).toISOString().slice(0, 10);
  assert.equal(post[0].due_at.slice(0, 10), new Date(Date.parse(`${recibido}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10));

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

  // 6. Productos: los renglones del pedido de Finnegans, con la ficha (nombre, descripción y foto) de cada producto.
  const pr = (await api('GET', `/records/order/${o.id}/products`)).data;
  assert.equal(pr.items.length, 2);
  assert.deepEqual([pr.items[0].name, pr.items[0].quantity, pr.items[0].unit_price, pr.items[0].subtotal, pr.items[0].image_url, pr.items[0].description],
    ['Bolsa Shopper Colors Azul Marino', 300, 8339.6, 2501880, 'https://www.promoproductos.com/upload/bolsa.jpg', 'Bolsa de lona con base de yute.']);
  assert.deepEqual([pr.items[1].name, pr.items[1].discount, pr.items[1].subtotal, pr.items[1].description], ['OTRO-1', 10, 900, 'Con logo a 1 color'], 'sin ficha: el código; con su descuento');
  assert.equal(pr.total, 2502780);
  hits = 0;
  await api('GET', `/records/order/${o.id}/products`);
  assert.equal(hits, 0, 'la segunda vez sale de lo guardado');

  // 7. En la línea de tiempo se ve cómo avanzó.
  const tl = (await api('GET', `/records/order/${o.id}/timeline`)).data;
  assert.ok(tl.changes.some((c) => c.prop === 'hs_pipeline_stage') && tl.changes.some((c) => c.prop === 'factura_numero'));
});

test('pedidos desde ClickUp: cada corrida respeta el tope de consultas y sigue en la próxima', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  cu.bulk = 60;   // 60 PDV nuevos, con su artículo: la lista ocupa varias páginas
  let st = { leyendo_lista: true, pendientes: 1 };
  for (let i = 0; i < 20 && (st.leyendo_lista || st.pendientes); i++) {
    hits = 0;
    st = (await api('POST', '/integrations/clickup/sync', { full: i === 0 })).data;
    assert.ok(!st.error, st.error);
    assert.ok(hits <= 45, `corrida ${i}: ${hits} consultas`);
  }
  assert.equal(st.pendientes, 0);
  for (const i of [0, 30, 59]) {
    const o = (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${BULK(i)}`)}`)).data.results[0];
    assert.equal(o?.props.hs_pipeline_stage, '1237498994', `PDV ${BULK(i)} en producción`);
  }
  cu.bulk = 0;
});

test('productos: el pedido de los PDV viejos y, si Finnegans no tiene renglones, los artículos de ClickUp', async () => {
  // PDV viejo: «Tipo de Documento: PEDVTAFP» + número del PDV (no la «Fecha pedido»).
  const c = (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV_C}`)}`)).data.results[0];
  if (c) assert.equal(c.props.pedido_finnegans, `PEDVTAFP - ${PDV_C}`);
  // PDV_B: su pedido no está en Finnegans (el simulado responde 404) → los artículos de ClickUp, sin precio.
  const b = (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV_B}`)}`)).data.results[0];
  assert.ok(b, 'pedido B');
  const prods = (await api('GET', `/records/order/${b.id}/products`)).data;
  assert.equal(prods.source, 'clickup');
  assert.equal(prods.items.length, 1);
  assert.deepEqual([prods.items[0].name, prods.items[0].quantity, prods.items[0].code, prods.items[0].status, prods.items[0].unit_price], ['Taza 0', 150, 'TAZA_0', 'pdv', null]);
});
