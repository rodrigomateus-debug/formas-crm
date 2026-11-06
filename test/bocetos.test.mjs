// Bocetos de producción: se suben a Drive (simulado en el puerto 8799, test/google-falso.mjs) en una carpeta por empresa y
// por negocio o pedido; versiones, tipo, aprobado y, los de un negocio, usados después en el pedido de la misma empresa.
// El adjunto en ClickUp al aprobar se prueba en test/pedidos.test.mjs (ahí está el ClickUp simulado).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { googleFalso } from './google-falso.mjs';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body instanceof FormData || body === undefined ? {} : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const PDF = Buffer.from(`%PDF-1.4\n% Boceto de producción ${RUN}\nPRODUCTO\nAbanico Standard\n%%EOF`);
const form = (campos, archivo = PDF, nombre = `Formas - Boceto ${RUN} - Abanico.pdf`, tipo = 'application/pdf') => {
  const fd = new FormData();
  fd.append('archivo', new File([archivo], nombre, { type: tipo }));
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  return fd;
};

let g;
before(async () => { g = await googleFalso(); });
after(async () => { await g.cerrar(); });

test('bocetos en el negocio y después en el pedido, guardados en Drive', async (t) => {
  const cfg0 = (await api('GET', '/integrations/bocetos')).data;
  if (!cfg0.cuenta_de_servicio) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (node test/gmail-dev-vars.mjs)'); return; }
  const cfg = (await api('PUT', '/integrations/bocetos', { carpeta: 'https://drive.google.com/drive/folders/0ARaizDeBocetos123?usp=sharing', usuario: 'Rodrigo.Mateus@formaspublicitarias.com' })).data;
  assert.deepEqual([cfg.carpeta, cfg.usuario], ['0ARaizDeBocetos123', 'rodrigo.mateus@formaspublicitarias.com'], 'del link queda el id de la carpeta');
  const prueba = (await api('GET', '/integrations/bocetos/probar')).data;
  assert.deepEqual([prueba.ok, prueba.unidad_compartida, prueba.error], [true, true, null], JSON.stringify(prueba));

  const emp = (await api('POST', '/records/company', { props: { name: `Illumin ${RUN}` } })).data;
  const deal = (await api('POST', '/records/deal', { props: { dealname: `Abanicos ${RUN}` }, associations: [emp.id] })).data;

  // 1. En el negocio, antes del pedido: el técnico y una referencia (foto).
  const b1 = await api('POST', `/records/deal/${deal.id}/bocetos`, form({ producto_nombre: 'Abanico Standard' }));
  assert.equal(b1.status, 201, JSON.stringify(b1.data));
  assert.deepEqual([b1.data.tipo, b1.data.estado, b1.data.version, b1.data.producto_nombre], ['tecnico', 'para_aprobar', 1, 'Abanico Standard']);
  const foto = await api('POST', `/records/deal/${deal.id}/bocetos`, form({ producto_nombre: 'Abanico Standard' }, Buffer.from([0xff, 0xd8, 0xff]), 'referencia.jpg', 'image/jpeg'));
  assert.deepEqual([foto.data.tipo, foto.data.version], ['referencia', 2], 'una foto es referencia; misma producto, versión siguiente');
  assert.equal((await api('POST', `/records/deal/${deal.id}/bocetos`, form({}, Buffer.from('hola'), 'nota.txt', 'text/plain'))).status, 400, 'solo PDF o imágenes');

  // En Drive: <raíz>/<empresa>/<Negocio …>, con el usuario y el permiso de Drive.
  const archivo = g.drive.archivos.find((f) => f.name === `Formas - Boceto ${RUN} - Abanico.pdf`);
  const carpeta = g.drive.carpetas.find((c) => c.id === archivo.parent);
  const empresa = g.drive.carpetas.find((c) => c.id === carpeta.parent);
  assert.deepEqual([empresa.parent, empresa.name, carpeta.name], ['0ARaizDeBocetos123', `Illumin ${RUN}`, `Negocio Abanicos ${RUN}`]);
  assert.ok(g.drive.tokens.some((x) => x.sub === 'rodrigo.mateus@formaspublicitarias.com' && x.scope === 'https://www.googleapis.com/auth/drive'));
  const bajado = await api('GET', `/bocetos/${b1.data.id}/archivo`);
  assert.equal(bajado.status, 200);
  assert.equal(Buffer.compare(bajado.data, PDF), 0, 'se ve el mismo archivo');

  // 2. Aprobar en el negocio.
  assert.equal((await api('PATCH', `/bocetos/${b1.data.id}`, { estado: 'aprobado' })).data.estado, 'aprobado');
  assert.equal((await api('PATCH', `/bocetos/${b1.data.id}`, { estado: 'otro' })).status, 400);

  // 3. Llega el pedido de la misma empresa: los bocetos del negocio aparecen para usarlos en un producto.
  const ord = (await api('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN}` }, associations: [emp.id] })).data;
  let lista = (await api('GET', `/records/order/${ord.id}/bocetos`)).data;
  assert.deepEqual(lista.de_negocios.map((b) => b.id).sort(), [b1.data.id, foto.data.id].sort());
  const usado = await api('POST', `/bocetos/${b1.data.id}/usar`, { order_id: ord.id, producto: 'ABAN-01', producto_nombre: 'Abanico Standard' });
  assert.equal(usado.status, 201);
  assert.deepEqual([usado.data.record_id, usado.data.producto, usado.data.estado, usado.data.origen_id, usado.data.drive_id], [ord.id, 'ABAN-01', 'aprobado', b1.data.id, b1.data.drive_id]);
  lista = (await api('GET', `/records/order/${ord.id}/bocetos`)).data;
  assert.deepEqual(lista.bocetos.map((b) => b.id), [usado.data.id]);
  assert.deepEqual(lista.de_negocios.map((b) => b.id), [foto.data.id], 'el ya usado no se ofrece de nuevo');

  // 4. En el pedido, otro boceto del mismo producto es la versión 2; cambiar de producto lo deja en la versión de ese.
  const v2 = (await api('POST', `/records/order/${ord.id}/bocetos`, form({ producto: 'ABAN-01', producto_nombre: 'Abanico Standard' }))).data;
  assert.equal(v2.version, 2);
  const otro = (await api('PATCH', `/bocetos/${v2.id}`, { producto: 'GORRA-1', producto_nombre: 'Gorra' })).data;
  assert.deepEqual([otro.producto, otro.producto_nombre, otro.version], ['GORRA-1', 'Gorra', 1]);
  assert.equal(g.drive.carpetas.find((c) => c.id === g.drive.archivos.at(-1).parent).name, `PDV ${RUN}`, 'en el pedido: la carpeta del pedido');

  // 5. Quitar: deja de verse (el archivo queda en Drive).
  assert.equal((await api('DELETE', `/bocetos/${otro.id}`)).status, 200);
  assert.ok(!(await api('GET', `/records/order/${ord.id}/bocetos`)).data.bocetos.some((b) => b.id === otro.id));
  assert.equal((await api('GET', `/bocetos/${otro.id}/archivo`)).status, 404);
});
