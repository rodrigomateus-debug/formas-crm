// Tareas en equipo (src/worker/tareas.ts): responsable principal y colaboradores, relacionadas con pedidos, negocios,
// empresas y contactos, el tablero (status=board), la conversación de la tarea con @menciones, los sin leer y los avisos
// de la campanita. Dos personas: Rodrigo (el usuario de desarrollo) y Sole (con un token a su nombre).
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

test('tareas: colaboradores, relaciones, tablero y conversación', async () => {
  const yo = (await call('GET', '/meta')).data.me;
  const sole = (await call('POST', '/users', { email: `sole.t.${RUN}@formas.ar`, name: `Sole T ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const tok = (await call('POST', '/tokens', { name: `Sole T ${RUN}`, source: 'api', user_id: sole.id })).data.token;
  const S = { authorization: `Bearer ${tok}` };
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN} · Tareas`, owner_id: yo.id } })).data;
  const empresa = (await call('POST', '/records/company', { props: { name: `Empresa ${RUN}`, owner_id: yo.id } })).data;

  // 1. Crear con colaboradores y relaciones: Sole se entera («te sumó») y la ve en sus tareas (aunque es de Ventas y el pedido no es suyo).
  const t = (await call('POST', '/activities', { type: 'task', subject: `Armar muestra ${RUN}`, owner_id: yo.id, colaboradores: [sole.id, yo.id],
    links: [pedido.id, empresa.id], status: 'IN_PROGRESS' })).data;
  let det = (await call('GET', `/tasks/${t.id}`)).data;
  assert.deepEqual(det.colaboradores, [sole.id], 'el principal no figura como colaborador');
  assert.deepEqual(det.links.map((l) => l.id).sort(), [pedido.id, empresa.id].sort());
  assert.equal(det.status, 'IN_PROGRESS');
  const deSole = (await call('GET', `/tasks?owner=${sole.id}&participa=1&status=board`, undefined, S)).data;
  assert.ok(deSole.results.some((x) => x.id === t.id), 'en las tareas de Sole, como colaboradora');
  assert.equal((await call('GET', `/tasks?owner=${sole.id}&status=board`, undefined, S)).data.results.some((x) => x.id === t.id), false, 'sin participa, solo las suyas');
  assert.equal((await call('GET', `/tasks/${t.id}`, undefined, S)).status, 200, 'la colaboradora la puede abrir');
  let notif = (await call('GET', '/notificaciones', undefined, S)).data.items.filter((n) => n.activity_id === t.id);
  assert.deepEqual(notif.map((n) => [n.kind, n.texto]), [['tarea', 'colaborador']]);

  // 2. Filtros: relacionadas con pedidos, y la tarea aparece en la actividad del pedido con su equipo.
  assert.ok((await call('GET', `/tasks?owner=all&objeto=order&status=board`)).data.results.some((x) => x.id === t.id));
  assert.equal((await call('GET', `/tasks?owner=all&objeto=none&status=board`)).data.results.some((x) => x.id === t.id), false);
  const tl = (await call('GET', `/records/order/${pedido.id}/timeline`)).data.activities.find((a) => a.id === t.id);
  assert.deepEqual(tl.colaboradores, [sole.id]);

  // 3. Conversación: Rodrigo menciona a Sole; a ella le llega la mención y tiene 1 sin leer.
  const c1 = (await call('POST', `/tasks/${t.id}/comentarios`, { body: `@[${sole.name}](${sole.id}) ¿llegó el logo?` })).data;
  assert.deepEqual(c1.menciones, [sole.id]);
  let fila = (await call('GET', `/tasks?owner=${sole.id}&participa=1&status=board`, undefined, S)).data.results.find((x) => x.id === t.id);
  assert.deepEqual([fila.comentarios, fila.sin_leer], [1, 1]);
  notif = (await call('GET', '/notificaciones', undefined, S)).data.items.filter((n) => n.activity_id === t.id);
  assert.equal(notif[0].kind, 'tarea_mencion');
  assert.match(notif[0].texto, /llegó el logo/);

  // Sole responde (sin mencionar): al principal le llega «comentó»; Sole lo leyó al escribir.
  const c2 = (await call('POST', `/tasks/${t.id}/comentarios`, { body: 'Sí, ya está en curvas', responde_a: c1.id }, S)).data;
  const mias = (await call('GET', '/notificaciones?limite=100')).data.items.filter((n) => n.activity_id === t.id);
  assert.deepEqual(mias.map((n) => [n.kind, n.by_user]), [['tarea_comentario', sole.id]]);
  fila = (await call('GET', `/tasks?owner=${sole.id}&participa=1&status=board`, undefined, S)).data.results.find((x) => x.id === t.id);
  assert.equal(fila.sin_leer, 0, 'al escribir, leyó hasta ahí');
  await call('POST', `/tasks/${t.id}/comentarios`, { body: 'Genial, gracias' });
  fila = (await call('GET', `/tasks?owner=${sole.id}&participa=1&status=board`, undefined, S)).data.results.find((x) => x.id === t.id);
  assert.deepEqual([fila.comentarios, fila.sin_leer], [3, 1]);
  await call('POST', `/tasks/${t.id}/leido`, {}, S);
  fila = (await call('GET', `/tasks?owner=${sole.id}&participa=1&status=board`, undefined, S)).data.results.find((x) => x.id === t.id);
  assert.equal(fila.sin_leer, 0);
  assert.ok((await call('GET', '/notificaciones', undefined, S)).data.items.filter((n) => n.kind === 'tarea_mencion' && n.activity_id === t.id).every((n) => n.leido_at));

  // Editar y borrar: solo lo propio (el admin borra cualquiera).
  assert.equal((await call('PATCH', `/tarea-comentarios/${c2.id}`, { body: 'otra cosa' })).status, 403);
  assert.equal((await call('PATCH', `/tarea-comentarios/${c2.id}`, { body: 'Sí, ya está en curvas (v2)' }, S)).data.editado_at != null, true);
  assert.equal((await call('DELETE', `/tarea-comentarios/${c1.id}`, undefined, S)).status, 403);
  assert.equal((await call('DELETE', `/tarea-comentarios/${c1.id}`)).status, 200);
  const conv = (await call('GET', `/tasks/${t.id}/comentarios`)).data.comentarios;
  assert.deepEqual(conv.slice(0, 2).map((c) => [c.id, !!c.borrado_at, c.body]), [[c1.id, true, ''], [c2.id, false, 'Sí, ya está en curvas (v2)']]);
  assert.equal((await call('GET', '/notificaciones', undefined, S)).data.items.some((n) => n.kind === 'tarea_mencion' && n.activity_id === t.id), false, 'la mención borrada no se muestra');

  // 4. Cambiar colaboradores y pasar a una colaboradora a principal (sale de la lista).
  assert.deepEqual((await call('PUT', `/tasks/${t.id}/colaboradores`, { colaboradores: [] })).data.colaboradores, []);
  await call('PUT', `/tasks/${t.id}/colaboradores`, { colaboradores: [sole.id] });
  await call('PATCH', `/activities/${t.id}`, { owner_id: sole.id });
  det = (await call('GET', `/tasks/${t.id}`)).data;
  assert.deepEqual([det.owner_id, det.colaboradores], [sole.id, []]);
  assert.equal((await call('PUT', `/tasks/${t.id}/colaboradores`, { colaboradores: [99999999] })).status, 400);

  // 5. Tablero: las completadas recientes siguen (columna «Hecha»), las abiertas no completadas en «open».
  await call('PATCH', `/activities/${t.id}`, { status: 'COMPLETED', meta: { checklist: [{ id: 'a', texto: 'Pedir logo', hecho: true }] } });
  const board = (await call('GET', '/tasks?owner=all&status=board&limit=500')).data.results.find((x) => x.id === t.id);
  assert.equal(board.status, 'COMPLETED');
  assert.equal(board.meta.checklist[0].texto, 'Pedir logo');
  assert.equal((await call('GET', '/tasks?owner=all&status=open&limit=500')).data.results.some((x) => x.id === t.id), false);

  // Una nota no es una tarea.
  const nota = (await call('POST', '/activities', { type: 'note', body: 'hola', links: [pedido.id] })).data;
  assert.equal((await call('GET', `/tasks/${nota.id}`)).status, 404);
});
