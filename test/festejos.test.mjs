// Festejos de Chispín (festejos.ts): la vendedora ve sus pedidos que pasaron a «Listo para entregar» (la caja) o a
// «Entregado» (el camión), con sus productos, y también quien los movió; los de otra vendedora que no movió, los que
// siguen en otra etapa o se anularon, no.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
let asUser = null;
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const como = (u) => { asUser = u; };
const EN_PRODUCCION = '1237498994', LISTO = '1237498996', ENTREGADO = '1237498998', ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';

test('festejos de pedidos: listo para entregar y entregado, los suyos y los que movió', async () => {
  como(null);
  const vero = (await api('POST', '/users', { email: `vero.festejos.${RUN}@formas.ar`, name: `Vero ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const otra = (await api('POST', '/users', { email: `otra.festejos.${RUN}@formas.ar`, name: `Otra ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const pedido = async (nombre, owner) => (await api('POST', '/records/order', { props: { hs_order_name: `${nombre} ${RUN}`, hs_pipeline_stage: EN_PRODUCCION, hs_total_price: 1000, owner_id: owner } })).data;
  // Anular desde la pantalla pide confirmar: se manda ya confirmado (como repite la pantalla).
  const mover = (id, etapa) => api('PATCH', `/records/order/${id}`, { props: { hs_pipeline_stage: etapa } }, etapa === ANULADO ? { 'x-confirmar': 'anular' } : {});

  const listo = await pedido('Listo', vero.id);
  const entregado = await pedido('Entregado', vero.id);
  const anulado = await pedido('Anulado', vero.id);
  const quieto = await pedido('Quieto', vero.id);
  const ajeno = await pedido('Ajeno', otra.id);
  assert.equal((await mover(listo.id, LISTO)).status, 200);
  await mover(entregado.id, LISTO);
  await mover(entregado.id, ENTREGADO);
  await mover(anulado.id, LISTO);
  await mover(anulado.id, ANULADO);   // pasó por listo, pero ya no está ahí
  await mover(ajeno.id, LISTO);

  como(vero.email);
  const r = await api('GET', '/pedidos/festejos');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const de = (id) => r.data.pedidos.find((p) => p.id === id);
  assert.equal(de(listo.id)?.etapa, 'listo');
  assert.equal(de(entregado.id)?.etapa, 'entregado');
  assert.ok(Array.isArray(de(listo.id).articulos) && Array.isArray(de(listo.id).hizo));
  assert.equal(de(anulado.id), undefined, 'anulado no se festeja');
  assert.equal(de(quieto.id), undefined, 'sigue en producción');
  assert.equal(de(ajeno.id), undefined, 'es de otra vendedora');

  // La otra vendedora ve el suyo.
  como(otra.email);
  assert.ok((await api('GET', '/pedidos/festejos')).data.pedidos.some((p) => p.id === ajeno.id));

  // Quien lo movió también lo ve, aunque no sea suyo (acá, el usuario de desarrollo que movió todos), con la dueña.
  como(null);
  const mio = (await api('GET', '/pedidos/festejos')).data.pedidos.find((p) => p.id === ajeno.id);
  assert.ok(mio, 'quien lo movió lo ve');
  assert.equal(mio.duenio_id, otra.id);
});
