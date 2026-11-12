// Conversación del pedido (src/worker/conversacion.ts): un chat grupal con @menciones entre el vendedor y producción, que
// queda registrado, con la actividad del pedido entremezclada; los no leídos de cada uno, seguir o no, editar y borrar.
// Dos personas: Rodrigo (el usuario de desarrollo) y Ceci (con un token a su nombre).
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

test('conversación del pedido: mensajes, menciones, no leídos y actividad', async () => {
  const yo = (await call('GET', '/meta')).data.me;
  const ceci = (await call('POST', '/users', { email: `ceci.${RUN}@formas.ar`, name: `Ceci ${RUN}`, role: 'member' })).data;
  const sole = (await call('POST', '/users', { email: `sole.${RUN}@formas.ar`, name: `Sole ${RUN}`, role: 'member' })).data;
  const tok = (await call('POST', '/tokens', { name: `Ceci ${RUN}`, source: 'api', user_id: ceci.id })).data.token;
  const C = { authorization: `Bearer ${tok}` };
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN} · Crockett`, owner_id: yo.id } })).data;
  const url = `/records/order/${pedido.id}/conversacion`;

  // Vacía al principio; un mensaje vacío no se manda.
  const c0 = (await call('GET', url)).data;
  assert.equal(c0.items.filter((i) => i.kind === 'mensaje').length, 0);
  assert.ok(Array.isArray(c0.estados) && c0.estados.length, 'los estados de producción, para pintar los cambios de los artículos');
  assert.equal((await call('POST', url, { body: '   ' })).status, 400);

  // Rodrigo le escribe a Ceci (la menciona).
  const m1 = await call('POST', url, { body: `@[${ceci.name}](${ceci.id}) ¿cuándo entra al impresor la mochila?` });
  assert.equal(m1.status, 201, JSON.stringify(m1.data));
  assert.deepEqual(m1.data.menciones, [ceci.id]);
  // Una mención de alguien que no existe no cuenta.
  const m1b = (await call('POST', url, { body: 'Y el gorro @[Nadie](999999)' })).data;
  assert.deepEqual(m1b.menciones, []);

  // Ceci la sigue (la mencionaron) y tiene sin leer solo desde la mención.
  const bandejaCeci = (await call('GET', '/conversaciones?no_leidas=1', undefined, C)).data;
  const deEste = bandejaCeci.conversaciones.find((c) => c.record_id === pedido.id);
  assert.ok(deEste, JSON.stringify(bandejaCeci));
  assert.deepEqual([deEste.no_leidos, deEste.menciones], [2, 1]);
  assert.match(deEste.ultimo.body, /Y el gorro @Nadie/);
  // Rodrigo escribió: no tiene nada sin leer.
  assert.ok(!(await call('GET', '/conversaciones?no_leidas=1')).data.conversaciones.some((c) => c.record_id === pedido.id));

  // Ceci responde (y menciona a Sole, que pasa a seguirla).
  const m2 = await call('POST', url, { body: `Mañana. @[${sole.name}](${sole.id}) lo pasa a control`, responde_a: m1.data.id }, C);
  assert.equal(m2.status, 201, JSON.stringify(m2.data));
  assert.equal(m2.data.responde_a, m1.data.id);
  assert.equal((await call('POST', url, { body: 'x', responde_a: 999999999 }, C)).status, 400, 'no se responde a un mensaje de otra conversación');
  // Ceci escribió: ya leyó todo. Rodrigo (propietario y autor) tiene uno sin leer.
  assert.ok(!(await call('GET', '/conversaciones?no_leidas=1', undefined, C)).data.conversaciones.some((c) => c.record_id === pedido.id));
  const miBandeja = (await call('GET', '/conversaciones?no_leidas=1')).data.conversaciones.find((c) => c.record_id === pedido.id);
  assert.equal(miBandeja?.no_leidos, 1);
  const conv = (await call('GET', url)).data;
  assert.equal(conv.leido_hasta, m1b.id, 'Rodrigo leyó hasta lo que escribió');
  assert.deepEqual(conv.participantes.map((p) => [p.user_id, p.motivo]).sort((a, b) => a[0] - b[0]),
    [[yo.id, 'escribio'], [ceci.id, 'mencion'], [sole.id, 'mencion']].sort((a, b) => a[0] - b[0]));
  assert.equal((await call('POST', `${url}/leido`, { hasta: m2.data.id })).status, 200);
  assert.ok(!(await call('GET', '/conversaciones?no_leidas=1')).data.conversaciones.some((c) => c.record_id === pedido.id), 'leído');

  // Editar: solo quien lo escribió; borrar: quien lo escribió o un admin. Queda «editado» y «borrado».
  assert.equal((await call('PATCH', `/mensajes/${m2.data.id}`, { body: 'otra cosa' })).status, 403);
  const ed = (await call('PATCH', `/mensajes/${m2.data.id}`, { body: `Pasado mañana. @[${sole.name}](${sole.id}) lo pasa a control` }, C)).data;
  assert.ok(ed.editado_at);
  assert.equal((await call('DELETE', `/mensajes/${m1b.id}`, undefined, C)).status, 403);
  assert.equal((await call('DELETE', `/mensajes/${m1b.id}`)).status, 200);
  // Lo nuevo desde hace un rato: lo editado y lo borrado vienen de nuevo (la pantalla lo pide cada tanto).
  const nov = (await call('GET', `${url}?desde=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).data;
  const borrado = nov.items.find((i) => i.key === `m${m1b.id}`);
  assert.ok(borrado?.borrado_at && borrado.body === '', 'el texto de un borrado no se manda');
  assert.match(nov.items.find((i) => i.key === `m${m2.data.id}`).body, /Pasado mañana/);
  assert.equal(nov.estados, undefined, 'los estados vienen solo al abrir');

  // La actividad del pedido entremezclada: una nota y un cambio de etapa.
  await call('POST', '/activities', { type: 'note', body: `Nota ${RUN}`, links: [pedido.id] });
  const meta = (await call('GET', '/meta')).data;
  const etapas = meta.properties.find((p) => p.object_type === 'order' && p.name === 'hs_pipeline_stage').options;
  await call('PATCH', `/records/order/${pedido.id}`, { props: { hs_pipeline_stage: etapas[1].value } });
  const todo = (await call('GET', url)).data.items;
  assert.ok(todo.some((i) => i.kind === 'actividad' && i.tipo === 'note' && i.body === `Nota ${RUN}`), 'la nota');
  assert.ok(todo.some((i) => i.kind === 'cambio' && i.prop === 'hs_pipeline_stage' && i.despues === etapas[1].value), 'el cambio de etapa');
  assert.deepEqual(todo.map((i) => i.at), [...todo.map((i) => i.at)].sort(), 'en orden');

  // Dejar de seguir: no le cuentan más; una mención la vuelve a sumar.
  assert.equal((await call('PUT', `${url}/seguir`, { siguiendo: false }, C)).data.siguiendo, false);
  await call('POST', url, { body: 'Sin mención' });
  assert.ok(!(await call('GET', '/conversaciones?no_leidas=1', undefined, C)).data.conversaciones.some((c) => c.record_id === pedido.id));
  await call('POST', url, { body: `@[${ceci.name}](${ceci.id}) ¿llegó?` });
  assert.equal((await call('GET', '/conversaciones?no_leidas=1', undefined, C)).data.conversaciones.find((c) => c.record_id === pedido.id)?.menciones, 1);

  // Imágenes: se suben al elegirlas y van con el mensaje (puede ir sin texto). Solo imágenes de verdad, hasta 1,9 MB.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const subir = async (bytes, nombre, tipo, headers = {}) => {
    const fd = new FormData();
    fd.append('archivo', new File([bytes], nombre, { type: tipo }));
    fd.append('ancho', '1'); fd.append('alto', '1');
    const res = await fetch(`${CRM}/api${url}/imagenes`, { method: 'POST', body: fd, headers });
    return { status: res.status, data: await res.json() };
  };
  const img = await subir(PNG, 'captura.png', 'image/png');
  assert.equal(img.status, 201, JSON.stringify(img.data));
  assert.deepEqual([img.data.mime, img.data.size, img.data.ancho, img.data.mensaje_id], ['image/png', PNG.length, 1, null]);
  assert.equal((await subir(Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png')).status, 415, 'se mira el contenido, no el nombre');
  assert.equal((await subir(Buffer.concat([PNG, Buffer.alloc(1_950_000)]), 'grande.png', 'image/png')).status, 413);
  // Mientras no se manda, la ve solo quien la subió; nadie más la puede usar en su mensaje.
  assert.equal((await fetch(`${CRM}/api/mensaje-adjuntos/${img.data.id}`, { headers: C })).status, 404);
  assert.equal((await call('POST', url, { body: 'mía', adjuntos: [img.data.id] }, C)).status, 400);
  const conImg = await call('POST', url, { body: '', adjuntos: [img.data.id] });
  assert.equal(conImg.status, 201, JSON.stringify(conImg.data));
  assert.deepEqual([conImg.data.body, conImg.data.adjuntos.map((a) => a.id)], ['', [img.data.id]]);
  assert.equal((await call('POST', url, { body: '', adjuntos: [img.data.id] })).status, 400, 'ya es de otro mensaje');
  const bajada = await fetch(`${CRM}/api/mensaje-adjuntos/${img.data.id}`, { headers: C });
  assert.equal(bajada.status, 200);
  assert.equal(bajada.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.compare(Buffer.from(await bajada.arrayBuffer()), PNG), 0);
  assert.deepEqual((await call('GET', url)).data.items.find((i) => i.key === `m${conImg.data.id}`).adjuntos.map((a) => a.id), [img.data.id]);
  assert.equal((await call('GET', '/conversaciones', undefined, C)).data.conversaciones.find((c) => c.record_id === pedido.id).ultimo.body, '📷 Imagen');
  // Una subida que se saca antes de mandar se borra; las de un mensaje borrado, también.
  const suelta = await subir(PNG, 'otra.png', 'image/png');
  await call('DELETE', `/mensaje-adjuntos/${suelta.data.id}`);
  assert.equal((await call('POST', url, { body: 'x', adjuntos: [suelta.data.id] })).status, 400);
  await call('DELETE', `/mensajes/${conImg.data.id}`);
  assert.equal((await fetch(`${CRM}/api/mensaje-adjuntos/${img.data.id}`)).status, 404);

  // La tarjeta del tablero cuenta los mensajes (sin los borrados).
  const lista = (await call('GET', `/board-prop/order?prop=hs_pipeline_stage&q=${encodeURIComponent(RUN)}`)).data;
  const tarjeta = lista.columns?.flatMap((c) => c.records).find((r) => r.id === pedido.id);
  if (tarjeta) assert.equal(tarjeta.adjuntos.mensajes, 4);
});
