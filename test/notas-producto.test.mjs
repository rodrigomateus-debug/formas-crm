// Notas de producto (notasproducto.ts): lo que Producción anota de un producto de importador, atado al SKU, que se ve en
// Producción y en los productos de cada pedido con ese SKU y avisa a la vendedora y a Producción. Contra un ClickUp y un
// Finnegans simulados (puerto 8797), con las variables de .dev.vars.example.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const N = Math.floor(Math.random() * 10000);
// Un SKU propio de esta corrida (las notas son de todo el CRM): «IMP_T<run>.030» es el modelo, «.03» y «.05» los colores.
const MODELO = `IMP_T${RUN.toUpperCase()}.030`;
const AZUL = `${MODELO}.03`, ROJO = `${MODELO}.05`, OTRO = `ZEC-${RUN.toUpperCase()}`;
const PDV_A = String(60000 + N), PDV_B = String(70000 + N);
const VENDE = `Vende ${RUN}`;
let asUser = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const como = (u) => { asUser = u; };

// Los dos PDV en ClickUp, de Formas Shop y de la misma vendedora, con sus artículos («Código:» con el SKU).
const ARTS = { [PDV_A]: [[`Bolsa ${RUN}`, AZUL, 300], [`Vaso ${RUN}`, 'PS_GE_2000', 50]], [PDV_B]: [[`Bolsa roja ${RUN}`, ROJO, 120], [`Gorra ${RUN}`, OTRO, 10]] };
const field = (name, value, type = 'short_text') => ({ name, type, value });
const pdv = (npdv) => {
  const id = `np${RUN}${npdv}`, updated = String(Date.now());
  return {
    id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: updated, status: { status: 'pdv' }, assignees: [], attachments: [],
    text_content: `Pedido: PEDVTASTP - ${npdv}\nCliente: Bolsas ${RUN} S.A.\nVendedor: ${VENDE}\nEs evento: No\nFecha entrega: 30-11-2026`,
    custom_fields: [field('N° PDV', `PDV - ${npdv}`), field('CLIENTE', `Bolsas ${RUN} S.A.`), field('🧑‍💻 VENDEDOR', VENDE),
      { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: 'FORMAS SHOP' } }],
    subtasks: ARTS[npdv].map(([nombre, codigo, cant], i) => ({ id: `${id}-${i}`, name: `${nombre} - Proveedor`, parent: id, url: `https://app.clickup.com/t/${id}-${i}`,
      date_updated: updated, status: { status: 'pdv' }, assignees: [], tags: [], text_content: `Producto: ${nombre}\nCantidad: ${cant}\nCódigo: ${codigo.replace(/_/g, '\\_')}`,
      custom_fields: [field('CANTIDAD ', String(cant), 'number'), { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: 'FORMAS SHOP' } }] })),
  };
};
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (p === '/clickup/list/901326159292/task') {
      const ts = [pdv(PDV_A), pdv(PDV_B)].flatMap((t) => [t, ...t.subtasks]);
      return send({ tasks: Number(url.searchParams.get('page') ?? 0) === 0 ? ts : [], last_page: true });
    }
    if (p === '/clickup/list/901326159292') return send({ statuses: [] });
    for (const n of [PDV_A, PDV_B]) if (p === `/clickup/task/np${RUN}${n}`) return send(pdv(n));
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') return send([]);
    const item = ([, code, cant]) => ({ ProductoCodigo: code, Cantidad: cant, Precio: 1000, Descuento1: 0, Descuento2: 0, Descripcion: '', IncluyeImpuesto: false });
    for (const n of [PDV_A, PDV_B]) if (p === `/fin/pedidoVenta/PEDVTASTP - ${n.padStart(8, '0')}`) return send({ MonedaCodigo: 'PES', Items: ARTS[n].map(item) });
    if (p === `/fin/producto/${AZUL}`) return send({ Nombre: `Bolsa Shopper ${RUN} Azul`, Descripcion: '', ProductoImagen: '' });
    send({ error: 'no simulado' }, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server.close());

test('notas de producto: por SKU y por modelo, avisos, permisos y la ficha', async (t) => {
  como(null);
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.finnegans?.configured || !st.clickup?.configured) { t.skip('wrangler dev sin ClickUp ni Finnegans de prueba (ver .dev.vars.example)'); return; }
  const ceci = (await api('POST', '/users', { email: `ceci.notas.${RUN}@formas.ar`, name: `Ceci ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const sole = (await api('POST', '/users', { email: `sole.notas.${RUN}@formas.ar`, name: `Sole ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const vende = (await api('POST', '/users', { email: `vende.notas.${RUN}@formas.ar`, name: VENDE, profile: 'comercial', role: 'member' })).data;
  await api('POST', '/users', { email: `otra.notas.${RUN}@formas.ar`, name: `Otra ${RUN}`, profile: 'comercial', role: 'member' });
  const r = (await api('POST', '/integrations/clickup/sync', { full: true })).data;
  assert.ok(!r.error, r.error);
  const pedido = async (n) => (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${n}`)}`)).data.results[0];
  const a = await pedido(PDV_A);
  assert.ok(a, 'entró el pedido');
  assert.equal(a.props.owner_id, vende.id, 'de la vendedora');

  // 1. Los productos del pedido traen el SKU (los genéricos no: no llevan notas) y todavía ninguna nota.
  let prods = (await api('GET', `/records/order/${a.id}/products`)).data;
  assert.equal(prods.items.length, 2, prods.error);
  assert.equal(prods.items[0].sku, AZUL);
  assert.equal(prods.items[0].notas, null);
  assert.equal(prods.items[1].sku, null, 'genérico, sin notas');

  // 2. Escriben Producción y los administradores; un genérico no lleva notas.
  como(vende.email);
  assert.equal((await api('POST', `/productos/sku/${encodeURIComponent(AZUL)}/notas`, { texto: 'x' })).status, 403, 'Ventas no escribe');
  como(ceci.email);
  assert.equal((await api('POST', '/productos/sku/PS_GE_2000/notas', { texto: 'x' })).status, 400, 'genérico');
  assert.equal((await api('POST', `/productos/sku/${encodeURIComponent(AZUL)}/notas`, { texto: '  ' })).status, 400, 'sin texto');
  let ficha = (await api('GET', `/productos/sku/${encodeURIComponent(AZUL.toLowerCase())}`)).data;
  assert.equal(ficha.sku, AZUL, 'en mayúsculas');
  assert.equal(ficha.modelo, MODELO, 'el modelo, sin el color');
  assert.equal(ficha.nombre, `Bolsa Shopper ${RUN} Azul`, 'el nombre de la ficha de Finnegans');
  assert.equal((await api('GET', `/productos/sku/${OTRO}`)).data.modelo, null, 'sin variante que separar');
  const n1 = await api('POST', `/productos/sku/${encodeURIComponent(AZUL)}/notas`, {
    texto: 'La serigrafía se sale en la tela', tipo: 'serigrafia', gravedad: 'no', todos_colores: true, record_id: a.id, producto: 'Bolsa',
  });
  assert.equal(n1.status, 201, JSON.stringify(n1.data));
  assert.equal(n1.data.modelo, MODELO);
  const n2 = (await api('POST', `/productos/sku/${encodeURIComponent(AZUL)}/notas`, { texto: 'En blanco queda mejor', tipo: 'otro', gravedad: 'info' })).data;
  assert.equal(n2.modelo, null, 'solo ese color');
  assert.equal((await api('POST', `/productos/sku/${OTRO}/notas`, { texto: 'x', todos_colores: true })).status, 400, 'no se puede separar el color');

  // 3. El pedido donde se escribió no avisa; los productos muestran el resumen (la más grave manda).
  como(null);
  prods = (await api('GET', `/records/order/${a.id}/products?refresh=1`)).data;
  assert.deepEqual([prods.items[0].notas.n, prods.items[0].notas.gravedad], [2, 'no']);
  como(vende.email);
  let avisos = (await api('GET', '/notificaciones')).data.items.filter((x) => x.kind === 'producto');
  assert.equal(avisos.length, 0, 'la nota se escribió en este pedido');

  // En Producción, cada artículo con su SKU y el resumen de sus notas (el genérico, sin SKU).
  como(ceci.email);
  const prod = (await api('GET', '/produccion')).data.pdvs;
  const artsA = prod.find((x) => x.npdv === PDV_A).articulos, artsB = prod.find((x) => x.npdv === PDV_B).articulos;
  assert.deepEqual(artsA.map((x) => [x.sku, x.notas?.n ?? 0]), [[AZUL, 2], [null, 0]]);
  assert.deepEqual(artsB.map((x) => [x.sku, x.notas?.gravedad ?? null]), [[ROJO, 'no'], [OTRO, null]], 'el rojo, por la nota del modelo');

  // 4. Se leen los productos del otro pedido, con otro color del mismo modelo: le llega la nota del modelo (no la del color azul) y avisa a la
  //    vendedora y a Producción, una sola vez.
  como(null);
  const b = await pedido(PDV_B);
  prods = (await api('GET', `/records/order/${b.id}/products`)).data;
  assert.equal(prods.items[0].sku, ROJO);
  assert.deepEqual([prods.items[0].notas?.n, prods.items[0].notas?.gravedad], [1, 'no'], 'la del modelo');
  assert.equal(prods.items[1].notas, null);
  await api('GET', `/records/order/${b.id}/products?refresh=1`);
  for (const u of [vende, ceci, sole]) {
    como(u.email);
    avisos = (await api('GET', '/notificaciones')).data.items.filter((x) => x.kind === 'producto' && x.record_id === b.id);
    assert.equal(avisos.length, 1, `un aviso para ${u.name}`);
    assert.match(avisos[0].texto, /serigrafía se sale/);
    assert.match(avisos[0].texto, new RegExp(ROJO.replace(/[.]/g, '\\.')));
  }

  // 5. La ficha: las notas que valen (las del modelo también) y dónde se vendió. Otra vendedora no ve los pedidos ajenos.
  como(vende.email);
  ficha = (await api('GET', `/productos/sku/${encodeURIComponent(ROJO)}`)).data;
  assert.deepEqual(ficha.notas.map((n) => n.texto), ['La serigrafía se sale en la tela']);
  assert.equal(ficha.notas[0].record_id, a.id, 'el pedido donde pasó');
  assert.equal(ficha.puede_escribir, false);
  assert.deepEqual(ficha.ventas.map((v) => v.id), [b.id]);
  ficha = (await api('GET', `/productos/sku/${encodeURIComponent(AZUL)}`)).data;
  assert.equal(ficha.notas.length, 2);
  assert.equal(ficha.notas[0].gravedad, 'no', 'la más grave arriba');
  assert.equal(ficha.ventas[0].notas, 1, 'la que se escribió en ese pedido');
  como(`otra.notas.${RUN}@formas.ar`);
  ficha = (await api('GET', `/productos/sku/${encodeURIComponent(AZUL)}`)).data;
  assert.equal(ficha.notas.length, 2, 'las notas las ven todos');
  assert.equal(ficha.notas[0].record_id, null, 'sin el pedido de otra vendedora');
  assert.equal(ficha.ventas.length, 0);
  assert.equal(ficha.ventas_total, 1);

  // 6. La lista: por SKU, buscando y por tipo.
  let lista = (await api('GET', `/productos/notas?q=${encodeURIComponent(RUN)}`)).data.productos;
  assert.deepEqual(lista.map((p) => [p.sku, p.vigentes, p.gravedad]), [[AZUL, 2, 'no']]);
  lista = (await api('GET', `/productos/notas?q=${encodeURIComponent(RUN)}&tipo=bordado`)).data.productos;
  assert.equal(lista.length, 0);

  // 7. Cambiar el contenido: quien la escribió o un administrador. Archivar («ya no aplica»): cualquiera de Producción.
  como(sole.email);
  assert.equal((await api('PATCH', `/productos/notas/${n1.data.id}`, { texto: 'otra cosa' })).status, 403);
  assert.equal((await api('DELETE', `/productos/notas/${n1.data.id}`)).status, 403);
  const arch = await api('PATCH', `/productos/notas/${n1.data.id}`, { archivada: true });
  assert.equal(arch.status, 200);
  assert.ok(arch.data.archivada_at);
  como(vende.email);
  assert.equal((await api('PATCH', `/productos/notas/${n2.id}`, { archivada: true })).status, 403, 'Ventas no archiva');
  como(null);
  prods = (await api('GET', `/records/order/${b.id}/products`)).data;
  assert.equal(prods.items[0].notas, null, 'archivada: ya no avisa');
  lista = (await api('GET', `/productos/notas?q=${encodeURIComponent(RUN)}`)).data.productos;
  assert.deepEqual(lista.map((p) => [p.vigentes, p.total, p.gravedad]), [[1, 1, 'info']], 'sin las archivadas');
  lista = (await api('GET', `/productos/notas?q=${encodeURIComponent(RUN)}&archivadas=1`)).data.productos;
  assert.deepEqual(lista.map((p) => [p.vigentes, p.total, p.gravedad]), [[1, 2, 'info']], 'con las archivadas');
  const ed = await api('PATCH', `/productos/notas/${n2.id}`, { texto: 'En blanco queda mejor, el negro se ve gris', gravedad: 'ojo' });
  assert.equal(ed.status, 200, 'un administrador sí');
  assert.equal(ed.data.gravedad, 'ojo');
  assert.ok(ed.data.updated_at);
  como(ceci.email);
  assert.equal((await api('DELETE', `/productos/notas/${n2.id}`)).status, 200);
  ficha = (await api('GET', `/productos/sku/${encodeURIComponent(AZUL)}`)).data;
  assert.deepEqual(ficha.notas.map((n) => [n.id, !!n.archivada_at]), [[n1.data.id, true]], 'la borrada no se ve; la archivada sí');
});
