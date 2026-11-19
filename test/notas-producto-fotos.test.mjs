// Notas de producto con varias fotos (notasproducto.ts): se cargan varias al crear la nota, se agregan o sacan después
// (quien la escribió o un administrador) y cada una se ve por su id. Drive simulado en el puerto 8799 (test/google-falso.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { googleFalso } from './google-falso.mjs';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const SKU = `IMP_F${RUN.toUpperCase()}.010.03`;
let asUser = null;
const cab = () => (asUser ? { 'x-dev-user': asUser } : {});
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...cab() }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
async function formulario(path, campos, fotos) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const [nombre, tipo, bytes] of fotos) fd.append('foto', new Blob([bytes], { type: tipo }), nombre);
  const res = await fetch(`${BASE}/api${path}`, { method: 'POST', body: fd, headers: cab() });
  return { status: res.status, data: await res.json() };
}
const png = (n) => ['foto.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])];

let g;
before(async () => { g = await googleFalso(); });
after(async () => { await g?.cerrar(); });

test('notas de producto: varias fotos por nota', async (t) => {
  asUser = null;
  const cfg0 = (await api('GET', '/integrations/bocetos')).data;
  if (!cfg0.cuenta_de_servicio) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (node test/gmail-dev-vars.mjs)'); return; }
  await api('PUT', '/integrations/bocetos', { carpeta: 'https://drive.google.com/drive/folders/0ARaizDeNotas123', usuario: 'rodrigo.mateus@formaspublicitarias.com' });

  // 1. Una nota nueva con tres fotos: quedan las tres, en orden, en la carpeta del SKU.
  const n = await formulario(`/productos/sku/${encodeURIComponent(SKU)}/notas`, { texto: 'La serigrafía se sale', tipo: 'serigrafia', gravedad: 'ojo' },
    [png(1), ['b.jpg', 'image/jpeg', new Uint8Array([0xff, 0xd8, 2])], png(3)]);
  assert.equal(n.status, 201, JSON.stringify(n.data));
  assert.equal(n.data.fotos.length, 3);
  assert.deepEqual([...n.data.fotos].sort((a, b) => a - b), n.data.fotos, 'en el orden en que se cargaron');
  const subidas = g.drive.archivos.filter((f) => f.name.startsWith(`${SKU} `));
  assert.equal(subidas.length, 3);
  assert.equal(g.drive.carpetas.find((c) => c.id === subidas[0].parent).name, SKU);

  // 2. Cada foto se ve por su id; la dirección de antes da la primera.
  const f2 = await fetch(`${BASE}/api/productos/notas/fotos/${n.data.fotos[1]}`);
  assert.equal(f2.status, 200);
  assert.equal(f2.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await f2.arrayBuffer())], [0xff, 0xd8, 2]);
  const primera = await fetch(`${BASE}/api/productos/notas/${n.data.id}/foto`);
  assert.deepEqual([...new Uint8Array(await primera.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 1]);

  // 3. Si una no es imagen no se guarda nada (ni la nota ni las otras fotos).
  const antes = g.drive.archivos.length;
  const mala = await formulario(`/productos/sku/${encodeURIComponent(SKU)}/notas`, { texto: 'Otra' }, [png(4), ['x.pdf', 'application/pdf', new Uint8Array([1])]]);
  assert.equal(mala.status, 400);
  assert.match(mala.data.error, /x\.pdf/);
  assert.equal(g.drive.archivos.length, antes);
  assert.equal((await api('GET', `/productos/sku/${encodeURIComponent(SKU)}`)).data.notas.length, 1);

  // 4. Agregar dos más y sacar una: la ficha muestra las que quedan.
  const mas = await formulario(`/productos/notas/${n.data.id}/fotos`, {}, [png(5), png(6)]);
  assert.equal(mas.status, 201, JSON.stringify(mas.data));
  assert.equal(mas.data.fotos.length, 5);
  const sacada = await api('DELETE', `/productos/notas/fotos/${n.data.fotos[0]}`);
  assert.equal(sacada.status, 200);
  assert.deepEqual(sacada.data.fotos, mas.data.fotos.slice(1));
  assert.equal((await fetch(`${BASE}/api/productos/notas/fotos/${n.data.fotos[0]}`)).status, 404, 'la sacada ya no se ve');
  const ficha = (await api('GET', `/productos/sku/${encodeURIComponent(SKU)}`)).data;
  assert.deepEqual(ficha.notas[0].fotos, mas.data.fotos.slice(1));

  // 5. Hasta diez por nota.
  const muchas = await formulario(`/productos/notas/${n.data.id}/fotos`, {}, Array.from({ length: 7 }, (_, i) => png(10 + i)));
  assert.equal(muchas.status, 400);
  assert.match(muchas.data.error, /hasta 10 fotos \(ya tiene 4\)/);

  // 6. Otra persona de Producción ve las fotos pero no las cambia.
  const otra = (await api('POST', '/users', { email: `prod.fotos.${RUN}@formas.ar`, name: `Prod ${RUN}`, profile: 'produccion', role: 'member' })).data;
  asUser = otra.email;
  assert.equal((await api('GET', `/productos/sku/${encodeURIComponent(SKU)}`)).data.notas[0].fotos.length, 4);
  assert.equal((await formulario(`/productos/notas/${n.data.id}/fotos`, {}, [png(20)])).status, 403);
  assert.equal((await api('DELETE', `/productos/notas/fotos/${ficha.notas[0].fotos[0]}`)).status, 403);
  asUser = null;
  await api('DELETE', `/productos/notas/${n.data.id}`);
});
