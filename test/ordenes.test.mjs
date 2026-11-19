// Orden de trabajo (ordenes.ts, docs/ORDENES.md): nace con el pedido, copia su etapa, datos y relaciones, comparte la
// conversación y la actividad, se borra y restaura con él, no se toca a mano y la vendedora ve solo la de sus pedidos.
// Con `npm run dev` corriendo (base local con las migraciones aplicadas).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const N = 700000 + Math.floor(Math.random() * 90000);   // números de PDV de esta corrida
const CONFIRMADO = '4b27b500-f031-4927-9811-68a0b525cbae';
const LISTO = '3725360f-519b-4b18-a593-494d60a29c9f';
const ENTREGADO = '1237498998';

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path.startsWith('/hooks') ? '' : '/api'}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const como = (email) => ({ 'x-dev-user': email });
const ficha = async (type, id, h) => (await api('GET', `/records/${type}/${id}`, undefined, h)).data;
const ids = (list) => (list ?? []).map((r) => r.id).sort();
const nuevoPedido = async (n, props = {}, associations = [], h) => (await api('POST', '/records/order', {
  props: { hs_order_name: `PDV ${n} · Cliente ${RUN}`, pdv_finnegans: String(n), unidad_de_negocio: 'FORMAS SHOP', ...props }, associations,
}, h)).data;

test('la orden de trabajo nace con el pedido y lo sigue', async () => {
  const empresa = (await api('POST', '/records/company', { props: { name: `OT ${RUN} SA` } })).data;
  const contacto = (await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Ana', lastname: `OT ${RUN}`, email: `ana.${RUN}@ot.test` } })).data;
  const negocio = (await api('POST', '/records/deal', { props: { dealname: `Negocio OT ${RUN}` }, associations: [empresa.id] })).data;
  const pedido = await nuevoPedido(N, { fecha_de_entrega: '2026-12-10', tipo_de_pedido: 'EVENTO' }, [empresa.id, contacto.id, negocio.id]);

  // 1. Nace sola, con el nombre, la etapa y los datos del pedido, y sus mismas relaciones.
  const p = await ficha('order', pedido.id);
  assert.ok(p.ot_id, 'el pedido tiene su orden de trabajo');
  const o = await ficha('work_order', p.ot_id);
  assert.equal(o.record.name, `OT ${N} · Cliente ${RUN}`);
  assert.equal(o.record.props.hs_pipeline_stage, CONFIRMADO);
  assert.equal(o.record.props.pdv_finnegans, String(N));
  assert.equal(o.record.props.fecha_de_entrega, '2026-12-10');
  assert.equal(o.record.props.tipo_de_pedido, 'EVENTO');
  assert.equal(Number(o.record.props.pedido_id), pedido.id);
  assert.equal(o.pedido_id, pedido.id);
  assert.equal(o.pedido.id, pedido.id);
  assert.deepEqual(ids(o.associations.order), [pedido.id]);
  assert.deepEqual(ids(o.associations.company), [empresa.id]);
  assert.ok(o.associations.company[0].primary, 'con la misma empresa principal');
  assert.deepEqual(ids(o.associations.contact), [contacto.id]);
  assert.deepEqual(ids(o.associations.deal), [negocio.id]);
  assert.deepEqual(ids(p.associations.work_order), [p.ot_id]);
  assert.deepEqual(ids((await ficha('company', empresa.id)).associations.work_order), [p.ot_id], 'la empresa la ve entre sus relaciones');

  // 2. La etapa y los datos siguen al pedido; lo que la OT no copia (el total) no la toca.
  await api('PATCH', `/records/order/${pedido.id}`, { props: { hs_pipeline_stage: LISTO, fecha_de_entrega: '2026-12-15' } });
  let ot = (await ficha('work_order', p.ot_id)).record;
  assert.equal(ot.props.hs_pipeline_stage, LISTO);
  assert.equal(ot.props.fecha_de_entrega, '2026-12-15');
  const antes = ot.updated_at;
  await api('PATCH', `/records/order/${pedido.id}`, { props: { hs_total_price: 123456 } });
  assert.equal((await ficha('work_order', p.ot_id)).record.updated_at, antes);

  // 3. Las relaciones del pedido, también en la OT.
  const otro = (await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Beto', lastname: `OT ${RUN}`, email: `beto.${RUN}@ot.test` } })).data;
  assert.equal((await api('POST', '/associations', { from_id: pedido.id, to_id: otro.id })).status, 200);
  assert.deepEqual(ids((await ficha('work_order', p.ot_id)).associations.contact), [contacto.id, otro.id].sort());
  await api('DELETE', '/associations', { from_id: pedido.id, to_id: otro.id });
  assert.deepEqual(ids((await ficha('work_order', p.ot_id)).associations.contact), [contacto.id]);

  // 4. A mano no se toca: ni crear, ni borrar, ni asociar, ni clonar, ni combinar, ni cambiarle la etapa.
  assert.equal((await api('POST', '/records/work_order', { props: { nombre_ot: 'a mano' } })).status, 400);
  assert.equal((await api('DELETE', `/records/work_order/${p.ot_id}`)).status, 400);
  assert.equal((await api('POST', '/associations', { from_id: p.ot_id, to_id: otro.id })).status, 400);
  assert.equal((await api('DELETE', '/associations', { from_id: p.ot_id, to_id: contacto.id })).status, 400);
  assert.equal((await api('POST', `/records/work_order/${p.ot_id}/clone`)).status, 400);
  await api('PATCH', `/records/work_order/${p.ot_id}`, { props: { hs_pipeline_stage: ENTREGADO } });
  assert.equal((await ficha('work_order', p.ot_id)).record.props.hs_pipeline_stage, LISTO, 'la etapa de la OT es la del pedido');

  // 5. Una sola conversación: lo escrito desde la OT queda en el pedido.
  const msg = (await api('POST', `/records/work_order/${p.ot_id}/conversacion`, { body: `Desde la OT ${RUN}` })).data;
  assert.ok(msg.id);
  const conv = (await api('GET', `/records/order/${pedido.id}/conversacion`)).data;
  assert.ok(JSON.stringify(conv).includes(`Desde la OT ${RUN}`), 'el mensaje está en la conversación del pedido');
  const convOT = (await api('GET', `/records/work_order/${p.ot_id}/conversacion`)).data;
  assert.ok(JSON.stringify(convOT).includes(`Desde la OT ${RUN}`), 'y la OT ve la misma');

  // 6. La actividad se comparte: una nota en la OT se ve en el pedido, y al revés.
  await api('POST', '/activities', { type: 'note', body: `Nota en la OT ${RUN}`, links: [p.ot_id] });
  await api('POST', '/activities', { type: 'note', body: `Nota en el pedido ${RUN}`, links: [pedido.id] });
  const tlPedido = JSON.stringify((await api('GET', `/records/order/${pedido.id}/timeline`)).data);
  const tlOT = JSON.stringify((await api('GET', `/records/work_order/${p.ot_id}/timeline`)).data);
  for (const t of [tlPedido, tlOT]) { assert.ok(t.includes(`Nota en la OT ${RUN}`)); assert.ok(t.includes(`Nota en el pedido ${RUN}`)); }

  // 7. El tablero y la búsqueda las conocen (la búsqueda, por el número de PDV).
  const tablero = (await api('GET', `/board-prop/work_order?prop=hs_pipeline_stage&q=${encodeURIComponent(`OT ${N}`)}`)).data;
  assert.ok(tablero.columns.some((c) => c.records.some((r) => r.id === p.ot_id)));
  const buscadas = (await api('GET', `/records/work_order?q=${N}`)).data.results;
  assert.deepEqual(ids(buscadas), [p.ot_id]);

  // 8. Borrar el pedido borra la OT; restaurarlo trae la misma.
  assert.equal((await api('DELETE', `/records/order/${pedido.id}`)).status, 200);
  assert.equal((await ficha('work_order', p.ot_id)).record.archived, true);
  assert.equal((await api('POST', `/records/order/${pedido.id}/restore`)).status, 200);
  const vuelta = await ficha('order', pedido.id);
  assert.equal(vuelta.ot_id, p.ot_id, 'la misma OT, no otra');
  assert.equal((await ficha('work_order', p.ot_id)).record.archived, false);
});

test('pedidos combinados: queda una sola orden de trabajo', async () => {
  const a = await nuevoPedido(N + 1);
  const b = await nuevoPedido(N + 2);
  const otA = (await ficha('order', a.id)).ot_id, otB = (await ficha('order', b.id)).ot_id;
  assert.ok(otA && otB && otA !== otB);
  assert.equal((await api('POST', `/records/order/${a.id}/merge`, { other_id: b.id })).status, 200);
  const queda = await ficha('order', a.id);
  assert.equal(queda.ot_id, otA);
  assert.deepEqual(ids(queda.associations.work_order), [otA]);
  const otra = await ficha('work_order', otB);
  assert.ok(otra.redirect === otA || otra.record.archived, 'la OT del otro pedido se va');
});

test('un pedido que entra ya entregado no crea orden de trabajo', async () => {
  // (Si después se reabre desde ClickUp, que trae su PDV, la crea: sincronizarOT con url_clickup.)
  const p = await nuevoPedido(N + 3, { hs_pipeline_stage: ENTREGADO });
  assert.equal((await ficha('order', p.id)).ot_id, null);
  await api('PATCH', `/records/order/${p.id}`, { props: { tipo_de_pedido: 'EVENTO' } });
  assert.equal((await ficha('order', p.id)).ot_id, null, 'cambiarle algo tampoco la crea');
});

test('la conciliación corre con token de administrador y no cambia lo que ya está al día', async () => {
  const p = await nuevoPedido(N + 4);
  const ot = (await ficha('order', p.id)).ot_id;
  const antes = (await ficha('work_order', ot)).record.updated_at;
  const tok = (await api('POST', '/tokens', { name: `OT ${RUN}`, source: 'api' })).data.token;
  const r = await api('POST', '/hooks/ordenes/conciliar', { limite: 200 }, { authorization: `Bearer ${tok}` });
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.revisadas, 'number');
  assert.equal((await ficha('work_order', ot)).record.updated_at, antes);
  assert.equal((await api('POST', '/hooks/ordenes/conciliar', {})).status, 401, 'sin token, no');
});

test('la vendedora ve la orden de trabajo de sus pedidos y no la de otra', async () => {
  const A = `ot.a.${RUN}@formas.ar`, B = `ot.b.${RUN}@formas.ar`;
  const idA = (await api('POST', '/users', { email: A, name: `Vendedora OT A ${RUN}`, profile: 'comercial', role: 'member' })).data.id;
  await api('POST', '/users', { email: B, name: `Vendedora OT B ${RUN}`, profile: 'comercial', role: 'member' });
  // La empresa es de B; el pedido, de A.
  const empresa = (await api('POST', '/records/company', { props: { name: `Compartida OT ${RUN}` } }, como(B))).data;
  const pedido = await nuevoPedido(N + 5, { owner_id: idA }, [empresa.id]);
  const ot = (await ficha('order', pedido.id)).ot_id;
  assert.ok(ot);
  assert.equal((await api('GET', `/records/work_order/${ot}`, undefined, como(A))).status, 200, 'A ve la OT de su pedido');
  assert.equal((await api('GET', `/records/work_order/${ot}`, undefined, como(B))).status, 403, 'B no, aunque la empresa sea suya');
  const lista = (await api('GET', '/records/work_order?limit=200', undefined, como(B))).data.results;
  assert.ok(!lista.some((r) => r.id === ot));
});
