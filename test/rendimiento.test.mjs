// Rendimiento de los choferes (rendimiento.ts): el plan y lo que pasó en cada recorrido, en km y en tiempo. La salida y la
// llegada que avisa la app del chofer (botón o GPS), el punto al marcar cada parada, las estimaciones cuando no avisa, la
// corrección a mano de Logística, propios y externos, y qué pasa si el servicio de rutas no contesta. El servicio de rutas
// (OSRM), simulado en el puerto 8797 (ver .dev.vars.example).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const N = (parseInt(RUN.slice(-5), 36) % 8000) + 1000;
const HOY = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
async function api(method, path, body, user) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(user ? { 'x-dev-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

// El servicio de rutas simulado: cada tramo mide la diferencia de latitud y longitud (0,01° = 1 km) y se hace a 36 km/h.
// Con `caido`, no contesta.
let server, caido = false, pedidos = 0;
const tramoKm = (a, b) => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * 100;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const m = url.pathname.match(/^\/osrm\/route\/v1\/driving\/(.+)$/);
    if (!m) return send([], url.pathname === '/geo' ? 200 : 404);
    pedidos++;
    if (caido) return send({ code: 'Error' }, 500);
    const pts = decodeURIComponent(m[1]).split(';').map((x) => { const [lng, lat] = x.split(',').map(Number); return { lat, lng }; });
    send({ code: 'Ok', routes: [{ legs: pts.slice(1).map((p, i) => { const km = tramoKm(pts[i], p); return { distance: km * 1000, duration: km * 100 }; }) }] });
  });
  await new Promise((r) => server.listen(8797, r));
});
after(async () => { await new Promise((r) => server.close(r)); });

test('rendimiento: plan, lo que pasó, salida y llegada, estimaciones, corrección y propios', async () => {
  // Un punto de salida propio de la prueba (para no tocar los depósitos) y tres paradas en línea, a 1 km una de otra.
  const P = { base: { lat: -34.5, lng: -58.5 }, a: { lat: -34.51, lng: -58.5 }, b: { lat: -34.52, lng: -58.5 }, c: { lat: -34.53, lng: -58.5 } };
  const dir = { base: `Salida de prueba ${N}, Florida`, a: `Calle A ${N}, Munro`, b: `Calle B ${N}, Olivos`, c: `Calle C ${N}, Martínez` };
  const encargo = async (k) => {
    const r = await api('POST', '/recorridos/encargos', { fecha: HOY, destino: { nombre: `Parada ${k.toUpperCase()} ${RUN}`, direccion: dir[k] }, llevar: [{ que: 'Muestra' }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const enc = { a: await encargo('a'), b: await encargo('b'), c: await encargo('c') };
  let ruta = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  const parada = (k) => ruta.paradas.find((p) => p.encargos.some((e) => e.id === enc[k].id));
  for (const k of ['a', 'b', 'c']) {
    assert.ok(parada(k), `el encargo ${k} es una parada`);
    assert.equal((await api('PUT', '/cronograma/punto', { direccion: parada(k).direccion, ...P[k] })).status, 200);
  }
  assert.equal((await api('PUT', '/cronograma/punto', { direccion: dir.base, ...P.base })).status, 200);
  const clave = { a: parada('a').clave, b: parada('b').clave, c: parada('c').clave };

  // El recorrido: el segundo del día (lo de otras pruebas que quede suelto va al primero), ordenado a mano A, B, C.
  const nombre = `Chofer Rinde ${RUN}`;
  const ch = (await api('POST', '/choferes', { name: nombre })).data;
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: HOY, rutas: [
    { chofer: null, base: 'roca', salida: 510, orden: [] },
    { chofer: nombre, base: 'otro', base_otro: { nombre: 'Salida de prueba', direccion: dir.base }, salida: 540, a_mano: true, orden: [clave.a, clave.b, clave.c] },
  ] })).status, 200);
  const chofer = (camino, cuerpo, token = ch.token) => fetch(`${BASE}/hooks/chofer/api${camino}`, {
    method: cuerpo ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const evento = async (cuerpo, token) => { const r = await chofer('/ruta/evento', cuerpo, token); return { status: r.status, data: await r.json() }; };

  // ---------- La app del chofer: todavía no avisó nada ----------
  let rc = await (await chofer('/ruta')).json();
  const suyo = rc.recorridos.find((x) => x.paradas.some((p) => p.clave === clave.a));
  assert.equal(suyo.n, 2);
  assert.deepEqual(suyo.medicion, { salida_at: null, llegada_at: null });

  // ---------- Sale: vale la primera salida; la de otro chofer no entra ----------
  const antes = Date.now();
  let r = await evento({ n: 2, tipo: 'salida', origen: 'boton', ...P.base });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const salio = r.data.medicion.salida_at;
  assert.ok(Date.parse(salio) >= antes - 2000 && Date.parse(salio) <= Date.now() + 2000);
  r = await evento({ n: 2, tipo: 'salida', origen: 'gps', at: new Date(Date.now() + 1000).toISOString(), ...P.base });
  assert.equal(r.data.medicion.salida_at, salio, 'una salida posterior no pisa la primera');
  const otro = (await api('POST', '/choferes', { name: `Otro Chofer ${RUN}` })).data;
  assert.equal((await evento({ n: 2, tipo: 'salida', origen: 'boton' }, otro.token)).status, 404, 'el recorrido de otro chofer no se toca');
  assert.equal((await evento({ n: 2, tipo: 'paseo' })).status, 400);

  // ---------- Hace B primero y después A no se puede; C no la visita ----------
  const marcar = async (k, cuerpo) => { const x = await chofer('/ruta/parada', { clave: clave[k], ...cuerpo }); assert.equal(x.status, 200, await x.text()); };
  await marcar('b', { resultado: 'hecho', lat: P.b.lat - 0.0001, lng: P.b.lng });   // a unos 11 metros de la parada
  await new Promise((x) => setTimeout(x, 30));
  await marcar('a', { resultado: 'no_se_pudo', motivo: 'cerrado' });
  r = await evento({ n: 2, tipo: 'llegada', origen: 'gps', ...P.base });
  assert.ok(r.data.medicion.llegada_at >= salio);
  rc = await (await chofer('/ruta')).json();
  assert.equal(rc.recorridos.find((x) => x.n === 2).medicion.salida_at, salio, 'la app sabe que ya avisó la salida');

  // ---------- Se mide el día ----------
  r = await api('POST', '/rendimiento/medir', { fecha: HOY });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.recorridos >= 1);
  const fila = async () => { const x = await api('GET', `/rendimiento?desde=${HOY}&hasta=${HOY}`); assert.equal(x.status, 200, JSON.stringify(x.data)); return x.data.filas.find((f) => f.chofer === nombre); };
  let f = await fila();
  assert.ok(f, 'el recorrido quedó medido');
  assert.deepEqual([f.plan_paradas, f.hechas, f.no_se_pudo, f.sin_visitar], [3, 1, 1, 1]);
  assert.equal(f.plan_km, 6, 'el plan: salida → A → B → C → vuelta');
  assert.ok(f.plan_min > 0);
  assert.equal(f.km, 4, 'lo que hizo: salida → B → A → vuelta, por calles');
  assert.equal(f.estimado, false);
  assert.deepEqual([f.salida_origen, f.llegada_origen], ['boton', 'gps']);
  assert.equal(f.salida_at, salio);
  assert.ok(f.min != null && f.min >= 0);
  const paso = (k) => f.pasos.find((p) => p.clave === clave[k]);
  assert.deepEqual([paso('b').orden, paso('a').orden, paso('c').orden], [1, 2, null], 'en el orden en que las marcó');
  assert.deepEqual([paso('b').resultado, paso('a').resultado, paso('c').resultado], ['hecho', 'no_se_pudo', 'sin_visitar']);
  assert.deepEqual([paso('b').km, paso('a').km], [2, 1], 'los km de cada tramo');
  assert.ok(paso('b').lejos != null && paso('b').lejos < 50, `marcó a metros de la parada: ${paso('b').lejos}`);
  assert.equal(paso('a').lejos, null, 'sin ubicación al marcar, no se dice');
  // Volver a medir no vuelve a consultar el servicio de rutas: lo que ya se pidió queda guardado.
  const consultas = pedidos;
  await api('POST', '/rendimiento/medir', { fecha: HOY });
  assert.equal(pedidos, consultas);

  // ---------- Sin el aviso de llegada: se estima con la última parada más la vuelta ----------
  r = await evento({ n: 2, tipo: 'llegada', quitar: true });
  assert.equal(r.data.medicion.llegada_at, null);
  await api('POST', '/rendimiento/medir', { fecha: HOY });
  f = await fila();
  assert.equal(f.llegada_origen, 'estimada');
  assert.ok(f.llegada_at > paso('a').at, 'después de la última marca');

  // ---------- Logística corrige la salida: la app ya no la pisa ----------
  r = await api('PATCH', `/rendimiento/${HOY}/2`, { salida: '00:05' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.salida_origen, r.data.salida_at, r.data.corregido], ['manual', `${HOY}T03:05:00.000Z`, true]);
  await evento({ n: 2, tipo: 'salida', origen: 'boton' });
  f = await fila();
  assert.deepEqual([f.salida_origen, f.salida_at], ['manual', `${HOY}T03:05:00.000Z`]);
  assert.equal((await api('PATCH', `/rendimiento/${HOY}/2`, { salida: 'a las ocho' })).status, 400);
  // Vaciarla la devuelve a la estimación (primera marca, menos el tiempo en la parada y el viaje).
  r = await api('PATCH', `/rendimiento/${HOY}/2`, { salida: '' });
  assert.equal(r.data.salida_origen, 'estimada');
  assert.ok(r.data.salida_at < paso('b').at);

  // ---------- El servicio de rutas no contesta: en línea recta, y el día queda como estimado ----------
  caido = true;
  await marcar('c', { resultado: 'hecho' });
  await api('POST', '/rendimiento/medir', { fecha: HOY });
  caido = false;
  f = await fila();
  assert.equal(f.estimado, true);
  assert.ok(f.km > 0 && f.sin_visitar === 0);

  // ---------- Propios y externos ----------
  let x = await api('GET', `/rendimiento?desde=${HOY}&hasta=${HOY}`);
  assert.equal(x.data.choferes.find((c) => c.nombre === nombre).propio, false);
  assert.equal((await api('PUT', '/rendimiento/chofer', { nombre, propio: true })).status, 200);
  x = await api('GET', `/rendimiento?desde=${HOY}&hasta=${HOY}`);
  assert.equal(x.data.choferes.find((c) => c.nombre === nombre).propio, true);

  // ---------- Lo ven Logística, Producción y los administradores ----------
  const vera = (await api('POST', '/users', { email: `vera.rinde.${RUN}@formas.ar`, name: `Vera Rinde ${RUN}`, profile: 'comercial', role: 'member' })).data;
  assert.equal((await api('GET', '/rendimiento', undefined, vera.email)).status, 403);
  assert.equal((await api('POST', '/rendimiento/medir', { fecha: HOY }, vera.email)).status, 403);
  assert.equal((await api('POST', '/rendimiento/medir', { fecha: '2099-01-01' })).status, 400, 'un día que no llegó');
});
