// Direcciones de entrega del pedido (src/worker/direcciones.ts): una por defecto con todo el pedido; varias con cuánto de
// cada producto va a cada una, sin pasar del total; validadas con Google Maps (simulado en el puerto 8793, ver
// .dev.vars.example), y el servidor no le cree a la pantalla: la dirección validada la arma Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
// Los renglones del pedido llegan de Finnegans o ClickUp; acá se cargan directo en la base local de wrangler dev.
const sql = (command) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'formas-crm', '--local', '--command', command], { stdio: 'pipe' });

// ---------- Google Maps simulado ----------
const LUGARES = {
  'ChIJ_nicaragua_1651': { id: 'ChIJ_nicaragua_1651', formattedAddress: 'Nicaragua 1651, B1872 Sarandí, Provincia de Buenos Aires, Argentina',
    location: { latitude: -34.67, longitude: -58.33 }, types: ['street_address'],
    addressComponents: [{ longText: '1651', types: ['street_number'] }, { longText: 'Sarandí', types: ['locality'] }, { longText: 'Provincia de Buenos Aires', types: ['administrative_area_level_1'] }, { longText: 'B1872', types: ['postal_code'] }] },
  'ChIJ_corrientes_1234': { id: 'ChIJ_corrientes_1234', formattedAddress: 'Av. Corrientes 1234, C1043 CABA, Argentina',
    location: { latitude: -34.60, longitude: -58.38 }, types: ['street_address'], addressComponents: [{ longText: '1234', types: ['street_number'] }, { longText: 'Buenos Aires', types: ['locality'] }] },
  'ChIJ_solo_la_calle_': { id: 'ChIJ_solo_la_calle_', formattedAddress: 'Av. Santa Fe, CABA, Argentina', location: { latitude: -34.59, longitude: -58.40 }, types: ['route'], addressComponents: [] },
};
let maps;
const pedidosGoogle = [];
before(async () => {
  maps = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    pedidosGoogle.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/places/places:autocomplete')) {
      const q = JSON.parse(body).input.toLowerCase();
      const sug = Object.values(LUGARES).filter((l) => l.formattedAddress.toLowerCase().includes(q.split(' ')[0]))
        .map((l) => ({ placePrediction: { placeId: l.id, text: { text: l.formattedAddress }, structuredFormat: { mainText: { text: l.formattedAddress.split(',')[0] }, secondaryText: { text: 'Argentina' } } } }));
      return res.end(JSON.stringify({ suggestions: sug }));
    }
    const m = req.url.match(/^\/places\/places\/([^?]+)/);
    const l = m && LUGARES[decodeURIComponent(m[1])];
    if (!l) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'Not found' } })); }
    res.end(JSON.stringify(l));
  });
  await new Promise((r) => maps.listen(8793, r));
});
after(() => maps?.close());

test('direcciones de entrega: una con todo el pedido, o varias repartiendo sin pasar del total', async (t) => {
  const meta = (await call('GET', '/meta')).data;
  const empresa = (await call('POST', '/records/company', { props: { name: `Cliente Entregas ${RUN}`, address: 'Nicaragua 1651', city: 'Sarandí' } })).data;
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV Entregas ${RUN}` } }, {})).data;
  await call('POST', '/associations', { from_id: pedido.id, to_id: empresa.id });
  const url = `/records/order/${pedido.id}/direcciones`;

  // Sin dirección todavía: sugiere la de la empresa (para confirmarla con Google).
  let d = (await call('GET', url)).data;
  assert.equal(d.direcciones.length, 0);
  assert.equal(d.sugerida, 'Nicaragua 1651, Sarandí');
  if (!d.maps) { t.skip('wrangler dev sin GOOGLE_MAPS_API_KEY de prueba (ver .dev.vars.example)'); return; }

  // Las sugerencias vienen de Google, con la clave del servidor (la pantalla no la ve).
  const sug = (await call('GET', `/maps/sugerencias?q=${encodeURIComponent('nicaragua 1651')}&sesion=s1`)).data;
  assert.deepEqual(sug.sugerencias.map((s) => s.place_id), ['ChIJ_nicaragua_1651']);
  assert.equal(pedidosGoogle.at(-1).key, 'prueba');

  // Una sola dirección elegida de Google: validada, con altura, y lo que la pantalla diga del texto no cuenta.
  d = (await call('PUT', url, { direcciones: [{ place_id: 'ChIJ_nicaragua_1651', direccion: 'cualquier cosa', detalle: 'Recibe Juan, de 9 a 17' }] })).data;
  assert.equal(d.direcciones.length, 1);
  assert.deepEqual([d.direcciones[0].direccion, d.direcciones[0].validada, d.direcciones[0].precisa, d.direcciones[0].localidad, d.direcciones[0].detalle],
    ['Nicaragua 1651, B1872 Sarandí, Provincia de Buenos Aires, Argentina', true, true, 'Sarandí', 'Recibe Juan, de 9 a 17']);
  assert.match(d.direcciones[0].maps, /google\.com\/maps.*query_place_id=ChIJ_nicaragua_1651/);
  const ficha = (await call('GET', `/records/order/${pedido.id}`)).data.record;
  assert.equal(ficha.props.direccion_entrega, 'Nicaragua 1651, B1872 Sarandí, Provincia de Buenos Aires, Argentina', 'el resumen queda en el pedido');
  // Un lugar que Google no conoce no se guarda; uno sin altura se guarda pero avisa.
  assert.equal((await call('PUT', url, { direcciones: [{ place_id: 'ChIJ_no_existe_xx' }] })).status, 502);
  const calle = (await call('PUT', url, { direcciones: [{ place_id: 'ChIJ_solo_la_calle_' }] })).data;
  assert.deepEqual([calle.direcciones[0].validada, calle.direcciones[0].precisa], [true, false]);
  // A mano (sin Google): queda sin validar; vacía, no.
  const mano = (await call('PUT', url, { direcciones: [{ direccion: 'Ruta 3 km 45, galpón 2' }] })).data;
  assert.deepEqual([mano.direcciones[0].validada, mano.direcciones[0].place_id], [false, null]);
  assert.equal((await call('PUT', url, { direcciones: [{ direccion: 'x' }] })).status, 400);

  // Con productos: con una dirección, todo va ahí.
  sql(`INSERT INTO line_items (record_id, position, code, name, quantity) VALUES (${pedido.id}, 0, 'GOR1', 'Gorra bordada', 100), (${pedido.id}, 1, 'MOC2', 'Mochila', 40), (${pedido.id}, 2, 'GOR1', 'Gorra bordada (otro color)', 10)`);
  d = (await call('PUT', url, { direcciones: [{ place_id: 'ChIJ_nicaragua_1651' }] })).data;
  assert.deepEqual(d.productos.map((p) => [p.clave, p.total, p.asignado, p.quedan]), [['GOR1', 100, 100, 0], ['MOC2', 40, 40, 0], ['GOR1#2', 10, 10, 0]]);
  assert.equal(d.sin_repartir, 0);

  // Varias: cada una con su parte; lo que falta se ve.
  const dos = [{ place_id: 'ChIJ_nicaragua_1651' }, { place_id: 'ChIJ_corrientes_1234', detalle: 'Piso 3' }];
  d = (await call('PUT', url, { direcciones: dos, cantidades: [{ direccion: 0, clave: 'GOR1', cantidad: 60 }, { direccion: 1, clave: 'GOR1', cantidad: 40 }, { direccion: 0, clave: 'MOC2', cantidad: 30 }] })).data;
  assert.equal(d.varias, true);
  assert.deepEqual(d.productos.map((p) => [p.clave, p.asignado, p.quedan]), [['GOR1', 100, 0], ['MOC2', 30, 10], ['GOR1#2', 0, 10]]);
  assert.equal(d.sin_repartir, 2);
  assert.match((await call('GET', `/records/order/${pedido.id}`)).data.record.props.direccion_entrega, /^2 direcciones: Nicaragua 1651.* · Av\. Corrientes 1234/);

  // No se puede entregar más que lo pedido (y si falla, no cambia nada).
  const mas = await call('PUT', url, { direcciones: dos, cantidades: [{ direccion: 0, clave: 'MOC2', cantidad: 30 }, { direccion: 1, clave: 'MOC2', cantidad: 11 }] });
  assert.equal(mas.status, 400);
  assert.match(mas.data.error, /De «Mochila» repartiste 41 y el pedido tiene 40/);
  assert.deepEqual((await call('GET', url)).data.productos.map((p) => p.asignado), [100, 30, 0], 'quedó como estaba');
  assert.equal((await call('PUT', url, { direcciones: dos, cantidades: [{ direccion: 0, clave: 'NOEXISTE', cantidad: 1 }] })).status, 400);
  assert.equal((await call('PUT', url, { direcciones: dos, cantidades: [{ direccion: 5, clave: 'GOR1', cantidad: 1 }] })).status, 400);
  assert.equal((await call('PUT', url, { direcciones: dos, cantidades: [{ direccion: 0, clave: 'GOR1', cantidad: -3 }] })).status, 400);
  assert.equal((await call('PUT', url, { direcciones: [dos[0], dos[0]] })).status, 400, 'la misma dirección dos veces, sin detalle que las distinga');

  // Desde la parada del cronograma: con varias direcciones, se cambian en la tarjeta del pedido.
  const ruta = await call('PUT', '/cronograma/direccion', { record_id: pedido.id, direccion: 'Av. Mitre 500, Avellaneda' });
  assert.equal(ruta.status, 409);
  assert.match(ruta.data.error, /varias direcciones/);

  // Volver a una sola: todo a esa, sin reparto guardado.
  d = (await call('PUT', url, { direcciones: [{ id: d.direcciones[1].id, place_id: 'ChIJ_corrientes_1234', detalle: 'Piso 3' }] })).data;
  assert.deepEqual([d.varias, d.cantidades.length, d.productos.every((p) => p.quedan === 0)], [false, 0, true]);
  const llamadas = pedidosGoogle.length;
  await call('PUT', url, { direcciones: [{ id: d.direcciones[0].id, place_id: 'ChIJ_corrientes_1234', detalle: 'Piso 4' }] });
  assert.equal(pedidosGoogle.length, llamadas, 'la misma dirección ya validada no se vuelve a pedir a Google');

  // Con una sola, cambiarla desde la parada la cambia en la tarjeta (escrita: queda sin validar, con el mismo detalle).
  assert.equal((await call('PUT', '/cronograma/direccion', { record_id: pedido.id, direccion: 'Av. Mitre 500, Avellaneda' })).status, 200);
  d = (await call('GET', url)).data;
  assert.deepEqual(d.direcciones.map((x) => [x.direccion, x.validada, x.detalle]), [['Av. Mitre 500, Avellaneda', false, 'Piso 4']]);
  assert.equal((await call('GET', `/records/order/${pedido.id}`)).data.record.props.direccion_entrega, 'Av. Mitre 500, Avellaneda');
  // El campo del pedido es de solo lectura: se cambia desde la tarjeta.
  await call('PATCH', `/records/order/${pedido.id}`, { props: { direccion_entrega: 'Otra cosa 123' } });
  assert.equal((await call('GET', `/records/order/${pedido.id}`)).data.record.props.direccion_entrega, 'Av. Mitre 500, Avellaneda');

  // Una vendedora: en sus pedidos sí; en los de otra, no.
  const vera = (await call('POST', '/users', { email: `vera.dir.${RUN}@formas.ar`, name: `Vera Dir ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const V = { 'x-dev-user': vera.email };
  assert.equal((await call('GET', url, undefined, V)).status, 403);
  const suyo = (await call('POST', '/records/order', { props: { hs_order_name: `PDV Vera ${RUN}`, owner_id: vera.id } })).data;
  assert.equal((await call('PUT', `/records/order/${suyo.id}/direcciones`, { direcciones: [{ place_id: 'ChIJ_nicaragua_1651' }] }, V)).status, 200);
  assert.ok(meta.me.id);
});
