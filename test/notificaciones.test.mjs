// La campanita (src/worker/notificaciones.ts) y la bandeja de conversaciones: menciones y respuestas, tareas asignadas,
// leído / no leído (y que leer la conversación las marque leídas), «marcar como no leída» una conversación y crear una
// tarea con un mensaje. Dos personas: Rodrigo (el usuario de desarrollo) y Ceci (con un token a su nombre).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('notificaciones: menciones, respuestas, tareas y leído / no leído', async () => {
  const yo = (await call('GET', '/meta')).data.me;
  const ceci = (await call('POST', '/users', { email: `ceci.n.${RUN}@formas.ar`, name: `Ceci N ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const tok = (await call('POST', '/tokens', { name: `Ceci N ${RUN}`, source: 'api', user_id: ceci.id })).data.token;
  const C = { authorization: `Bearer ${tok}` };
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN} · Campanita`, owner_id: yo.id } })).data;
  const url = `/records/order/${pedido.id}/conversacion`;
  const deCeci = async () => (await call('GET', '/notificaciones', undefined, C)).data;
  const mias = async () => (await call('GET', '/notificaciones?limite=100')).data.items.filter((n) => n.record_id === pedido.id);

  assert.deepEqual(await deCeci(), { no_leidas: 0, items: [] }, 'arranca vacía');

  // 1. Rodrigo menciona a Ceci: le llega a la campanita, con quién, dónde y el texto.
  const m1 = (await call('POST', url, { body: `@[${ceci.name}](${ceci.id}) ya está listo el boceto de la funda` })).data;
  let n = await deCeci();
  assert.equal(n.no_leidas, 1);
  assert.deepEqual([n.items[0].kind, n.items[0].record_id, n.items[0].object_type, n.items[0].name, n.items[0].by_user, n.items[0].mensaje_id, n.items[0].leido_at],
    ['mencion', pedido.id, 'order', pedido.name, yo.id, m1.id, null]);
  assert.match(n.items[0].texto, /ya está listo el boceto/);

  // 2. Ceci le responde (sin mencionarlo): a Rodrigo le llega «te respondió»; si lo menciona en la respuesta, solo la mención.
  const r1 = (await call('POST', url, { body: 'Dale, lo miro', responde_a: m1.id }, C)).data;
  let mi = await mias();
  assert.deepEqual(mi.map((x) => [x.kind, x.mensaje_id, x.by_user]), [['respuesta', r1.id, ceci.id]]);
  const r2 = (await call('POST', url, { body: `@[${yo.name}](${yo.id}) falta el pie de máquina`, responde_a: m1.id }, C)).data;
  mi = await mias();
  assert.deepEqual(mi.map((x) => x.kind), ['mencion', 'respuesta'], 'la respuesta con mención no se duplica');
  assert.equal(mi[0].mensaje_id, r2.id);
  // Responderse a uno mismo no avisa.
  await call('POST', url, { body: 'Me corrijo', responde_a: r1.id }, C);
  assert.equal((await mias()).length, 2);

  // 3. Leer la conversación marca leídas las menciones y respuestas hasta ahí.
  await call('POST', `${url}/leido`, { hasta: r2.id });
  assert.ok((await mias()).every((x) => x.leido_at), 'leídas al leer la conversación');

  // 4. Marcar no leída y leída, una o todas; solo las propias.
  const idCeci = (await deCeci()).items[0].id;
  await call('POST', '/notificaciones/leidas', { ids: [idCeci] }, C);
  assert.equal((await deCeci()).no_leidas, 0);
  await call('POST', '/notificaciones/no-leidas', { ids: [idCeci] }, C);
  assert.equal((await deCeci()).no_leidas, 1);
  await call('POST', '/notificaciones/leidas', { ids: [idCeci] });
  assert.equal((await deCeci()).no_leidas, 1, 'Rodrigo no puede marcar las de Ceci');
  await call('POST', '/notificaciones/leidas', {}, C);
  assert.equal((await deCeci()).no_leidas, 0, 'todas');

  // 5. Una tarea que le asignan: «te asignó una tarea».
  const tarea = (await call('POST', '/activities', { type: 'task', subject: `Revisar funda ${RUN}`, owner_id: ceci.id, links: [pedido.id], meta: { mensaje_id: m1.id } })).data;
  n = await deCeci();
  assert.deepEqual([n.no_leidas, n.items[0].kind, n.items[0].activity_id, n.items[0].subject], [1, 'tarea', tarea.id, `Revisar funda ${RUN}`]);
  // La tarea creada con el mensaje queda en la conversación del pedido.
  const conv = (await call('GET', url)).data;
  assert.ok(conv.items.some((i) => i.kind === 'actividad' && i.activity_id === tarea.id), 'la tarea, en la conversación');
  assert.equal(conv.nombre, pedido.name);
  // Borrada la tarea, deja de aparecer.
  await call('DELETE', `/activities/${tarea.id}`);
  assert.ok(!(await deCeci()).items.some((x) => x.kind === 'tarea' && x.activity_id === tarea.id));

  // 6. Un mensaje borrado no queda en la campanita.
  const m2 = (await call('POST', url, { body: `@[${ceci.name}](${ceci.id}) otra cosa` })).data;
  assert.ok((await deCeci()).items.some((x) => x.mensaje_id === m2.id));
  await call('DELETE', `/mensajes/${m2.id}`);
  assert.ok(!(await deCeci()).items.some((x) => x.mensaje_id === m2.id));
});

test('bandeja: marcar una conversación como no leída', async () => {
  const yo = (await call('GET', '/meta')).data.me;
  const ceci = (await call('POST', '/users', { email: `ceci.b.${RUN}@formas.ar`, name: `Ceci B ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const tok = (await call('POST', '/tokens', { name: `Ceci B ${RUN}`, source: 'api', user_id: ceci.id })).data.token;
  const C = { authorization: `Bearer ${tok}` };
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN} · Bandeja`, owner_id: yo.id } })).data;
  const url = `/records/order/${pedido.id}/conversacion`;
  const sinLeer = async () => (await call('GET', '/conversaciones?no_leidas=1')).data.conversaciones.find((c) => c.record_id === pedido.id);

  // Solo mensajes míos: no hay nada para dejar sin leer.
  const mio = (await call('POST', url, { body: 'Arranco yo' })).data;
  assert.equal((await call('POST', `${url}/no-leido`)).status, 400);
  // Escribe Ceci: queda sin leer; leída; y otra vez no leída (desde su último mensaje, no los míos).
  await call('POST', url, { body: 'Te contesto', responde_a: mio.id }, C);
  assert.equal((await sinLeer())?.no_leidos, 1);
  const ultimo = (await call('GET', url)).data.items.filter((i) => i.kind === 'mensaje').at(-1).id;
  await call('POST', `${url}/leido`, { hasta: ultimo });
  assert.equal(await sinLeer(), undefined);
  await call('POST', url, { body: 'Y otra cosa mía' });
  const r = await call('POST', `${url}/no-leido`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await sinLeer())?.no_leidos, 1, 'vuelve a quedar pendiente el mensaje de Ceci');
});
