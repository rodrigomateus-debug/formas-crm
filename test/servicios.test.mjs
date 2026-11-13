// Renglones de servicio (servicios.ts): los cobros que no son productos («Artículos varios», envío, setup de logo…) vienen
// marcados como servicio, no cuentan en Producción ni pesan en el estado del pedido, y solo un administrador les cambia el
// tipo. Contra un ClickUp y un Finnegans simulados (puerto 8797), con las variables de .dev.vars.example.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const PDV = String(20000 + Math.floor(Math.random() * 9000));
const ARTE = `ARTE_${RUN}`.toUpperCase();   // un código nuevo cuyo rubro en Finnegans es Servicios de Arte
const ENTREGADO = '1237498998';
let asUser = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

// El caso del PDV 30745: dos productos ya entregados y un adicional («Artículos varios») que quedó en «ingreso de pedido».
const ARTS = [
  { nombre: `Mochila ${RUN}`, codigo: `MOCH_${RUN}`, cantidad: 80, status: 'entregados' },
  { nombre: `Cooler ${RUN}`, codigo: `COOL_${RUN}`, cantidad: 20, status: 'entregados' },
  { nombre: 'adicional 10,5', codigo: '1161', cantidad: 1, status: 'ingreso de pedido' },
  { nombre: `Bordado ${RUN}`, codigo: ARTE, cantidad: 1, status: 'pdv' },
];
const field = (name, value, type = 'short_text') => ({ name, type, value });
const tarea = () => {
  const updated = String(Date.now());
  return {
    id: `sv${RUN}`, name: `PDV - ${PDV}`, parent: null, url: `https://app.clickup.com/t/sv${RUN}`, date_updated: updated, status: { status: 'pdv' },
    text_content: `Pedido: PEDVTASTP - ${PDV}\nCliente: Servicios ${RUN} S.A.\nVendedor: Rodrigo Mateus\nEs evento: No\nFecha entrega: 30-11-2026`,
    custom_fields: [field('N° PDV', `PDV - ${PDV}`), field('CLIENTE', `Servicios ${RUN} S.A.`), field('🧑‍💻 VENDEDOR', 'Rodrigo Mateus'),
      { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: 'FORMAS SHOP' } }],
    assignees: [], attachments: [],
    subtasks: ARTS.map((a, i) => ({ id: `sv${RUN}-${i}`, name: `${a.nombre} - Proveedor`, parent: `sv${RUN}`, url: `https://app.clickup.com/t/sv${RUN}-${i}`, date_updated: updated,
      status: { status: a.status }, assignees: [], tags: [], text_content: `Producto: ${a.nombre}\nCantidad: ${a.cantidad}\nCódigo: ${a.codigo.replace(/_/g, '\\_')}`,
      custom_fields: [field('CANTIDAD ', String(a.cantidad), 'number'), { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: 'FORMAS SHOP' } }] })),
  };
};
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (p === '/clickup/list/901326159292/task') {
      const t = tarea();
      return send({ tasks: Number(url.searchParams.get('page') ?? 0) === 0 ? [t, ...t.subtasks] : [], last_page: true });
    }
    if (p === '/clickup/list/901326159292') return send({ statuses: [] });
    if (p === `/clickup/task/sv${RUN}`) return send(tarea());
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV.padStart(8, '0')}`) {
      return send({ Cliente: 'C-SERV', MonedaCodigo: 'PES', Items: ARTS.map((a) => ({ ProductoCodigo: a.codigo, Cantidad: a.cantidad, Precio: 1000, Descripcion: a.codigo === '1161' ? a.nombre : '', IncluyeImpuesto: false })) });
    }
    if (p === '/fin/producto/1161') return send({ Nombre: 'ARTICULOS VARIOS' });
    if (p === `/fin/producto/${ARTE}`) return send({ Nombre: 'BORDADO - SERVICIO DE ARTE', ProductoRubroCodigo: 'SDA' });
    const prod = ARTS.find((a) => p === `/fin/producto/${a.codigo}`);
    if (prod) return send({ Nombre: prod.nombre, ProductoRubroCodigo: 'TEX' });
    if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') return send([]);
    send({ error: 'no simulado' }, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server.close());

const sync = async (full = false) => { const r = (await api('POST', '/integrations/clickup/sync', { full })).data; assert.ok(!r.error, r.error); return r; };
const pedido = async () => (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV}`)}`)).data.results[0];
const enProduccion = async (q = '') => (await api('GET', `/produccion${q}`)).data.pdvs.find((x) => x.npdv === PDV);

test('servicios: vienen marcados, no cuentan en Producción ni en el estado del pedido, y los cambia un administrador', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }

  // 1. El PDV entra. «Artículos varios» (1161) ya se sabe que es un servicio; el bordado todavía no (su ficha no se leyó),
  //    así que por ahora pesa: dos entregados y uno en «pdv» es «Entregado parcial».
  await sync(true);
  let o = await pedido();
  assert.ok(o, 'creó el pedido');
  assert.notEqual(o.props.hs_pipeline_stage, ENTREGADO, 'el bordado, sin ficha, todavía cuenta');

  // 2. Al leer los productos de Finnegans, cada renglón viene con su tipo: por la lista de códigos (1161) y por el rubro (SDA).
  const pr = (await api('GET', `/records/order/${o.id}/products`)).data;
  const de = (code) => pr.items.find((i) => i.code === code);
  assert.equal(pr.items.length, 4);
  assert.equal(de(ARTS[0].codigo).tipo, 'producto');
  assert.equal(de('1161').tipo, 'servicio', 'Artículos varios es un servicio');
  assert.equal(de(ARTE).tipo, 'servicio', 'rubro Servicios de Arte');
  assert.equal(de('1161').status, null, 'un servicio va sin estado de producción');
  assert.equal(de(ARTS[0].codigo).status, 'entregados');
  assert.equal(pr.total, (80 + 20 + 1 + 1) * 1000, 'los servicios suman en el total');
  assert.deepEqual([pr.produccion.listos, pr.produccion.total], [2, 2], 'en producción cuentan solo los dos productos');

  // 3. Con eso el CRM pide volver a leer el PDV: sin los servicios, está todo entregado.
  await sync();
  o = await pedido();
  assert.equal(o.props.hs_pipeline_stage, ENTREGADO, 'el adicional y el bordado no lo dejan en Entregado parcial');

  // 4. Producción: no queda nada por producir (no se ve entre los abiertos); con los entregados, solo los dos productos.
  assert.equal(await enProduccion(), undefined, 'un PDV al que solo le quedan servicios abiertos no se ve');
  const pdv = await enProduccion('?cerrados=1');
  assert.ok(pdv, 'con «ver entregados», sí');
  assert.deepEqual(pdv.articulos.map((a) => a.nombre).sort(), [`Cooler ${RUN} - Proveedor`, `Mochila ${RUN} - Proveedor`].sort(), 'sin los servicios');
  assert.deepEqual([pdv.listos, pdv.total], [2, 2]);
  assert.equal(pdv.etapa, ENTREGADO);

  // 5. Solo un administrador cambia el tipo; vale para ese código en ese pedido.
  const vende = `vende.serv.${RUN}@formas.ar`;
  await api('POST', '/users', { email: vende, name: `Vende ${RUN}` });
  asUser = vende;
  assert.equal((await api('PUT', `/records/order/${o.id}/products/tipo`, { code: '1161', tipo: 'producto' })).status, 403, 'una vendedora no');
  asUser = null;
  assert.equal((await api('PUT', `/records/order/${o.id}/products/tipo`, { code: 'NO-ESTA', tipo: 'producto' })).status, 404);
  assert.equal((await api('PUT', `/records/order/${o.id}/products/tipo`, { code: '1161', tipo: 'cualquiera' })).status, 400);
  assert.equal((await api('PUT', `/records/order/${o.id}/products/tipo`, { code: '1161', tipo: 'producto' })).status, 200);
  const pr2 = (await api('GET', `/records/order/${o.id}/products`)).data;
  assert.equal(pr2.items.find((i) => i.code === '1161').tipo, 'producto', 'en este pedido es mercadería');
  assert.equal(pr2.items.find((i) => i.code === '1161').status, 'ingreso de pedido', 'y vuelve a tener su estado');
  assert.equal(pr2.items.find((i) => i.code === ARTE).tipo, 'servicio', 'el otro servicio sigue igual');
  // Como producto, vuelve a pesar: falta entregarlo.
  await sync();
  o = await pedido();
  assert.notEqual(o.props.hs_pipeline_stage, ENTREGADO, 'con el 1161 como producto, falta entregarlo');
  const abierto = await enProduccion();
  assert.ok(abierto?.articulos.some((a) => a.nombre.startsWith('adicional')), 'y aparece en Producción');
  // Volver a servicio borra la excepción.
  assert.equal((await api('PUT', `/records/order/${o.id}/products/tipo`, { code: '1161', tipo: 'servicio' })).status, 200);
  await sync();
  assert.equal((await pedido()).props.hs_pipeline_stage, ENTREGADO);
});
