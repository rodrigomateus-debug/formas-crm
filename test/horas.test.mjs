// Hora fijada a mano en una parada de la ruta del día (cronograma.ts, guardarHora; pedido de Rodrigo del 16/11/2026): «a
// las 12:00», «antes de las…», «desde las…». El recorrido se ordena solo para cumplirla, junto con las demás. Tres paradas
// en línea a 2, 5 y 10 km del depósito (el buscador de direcciones, simulado en el puerto 8797, las ubica siempre igual).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { simular } from '../web/src/ruta.ts';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const N = (parseInt(RUN.slice(-5), 36) % 8000) + 1000;
// Un lunes propio de cada corrida, para no compartir recorridos con otras.
const DIA = new Date(Date.UTC(2028, 0, 3) + 7 * (N % 300) * 86_400_000).toISOString().slice(0, 10);
async function api(method, path, body, user) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(user ? { 'x-dev-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() };
}

const PUNTOS = { roca: [-34.5361, -58.5152], matienzo: [-34.5345, -58.5170], uno: [-34.5181, -58.5152], dos: [-34.4911, -58.5152], tres: [-34.4461, -58.5152] };
let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (url.pathname === '/geo') {
      const q = url.searchParams.get('q') ?? '';
      const k = /Roca 4250/.test(q) ? 'roca' : /Matienzo 1308/.test(q) ? 'matienzo' : /Uno/.test(q) ? 'uno' : /Dos/.test(q) ? 'dos' : /Tres/.test(q) ? 'tres' : null;
      return send(k ? [{ lat: String(PUNTOS[k][0]), lon: String(PUNTOS[k][1]) }] : []);
    }
    // La planilla de la libreta no contesta: queda la copia que había.
    send({ error: 'no simulado' }, 503);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => new Promise((r) => server.close(r)));

// La ruta del día, cuando ya ubicó todas las direcciones.
async function ruta() {
  let r = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  for (let i = 0; i < 8 && r.buscando > 0; i++) { await new Promise((x) => setTimeout(x, 300)); r = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data; }
  return r;
}
const orden = (r, claves) => r.rutas[0].orden.filter((c) => claves.includes(c));
const llegadas = (r) => {
  const base = r.bases.find((b) => b.id === r.rutas[0].base), porClave = new Map(r.paradas.map((p) => [p.clave, p]));
  return simular({ lat: base.lat, lng: base.lng }, r.rutas[0].orden.map((c) => porClave.get(c)), r.rutas[0].salida, null, 'ultima');
};

test('ruta del día: la hora fijada a mano ordena el recorrido', async () => {
  const cargar = async (letra, calle, extra = {}) => {
    const r = await api('POST', '/recorridos/encargos', { fecha: DIA, destino: { nombre: `Parada ${letra} ${RUN}`, direccion: `Calle ${calle} ${N}, Florida` }, llevar: [{ que: 'Muestras' }], ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const [a, b, c] = [await cargar('A', 'Uno'), await cargar('B', 'Dos'), await cargar('C', 'Tres', { horario: 'antes de las 14 hs' })];
  // El recorrido termina en la última parada (no vuelve): así el más corto es uno solo.
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: DIA, rutas: [{ chofer: null, base: 'roca', salida: 510, orden: [], a_mano: false, fin: 'ultima' }] })).status, 200);
  let r = await ruta();
  assert.equal(r.buscando, 0);
  const clave = (e) => r.paradas.find((p) => p.encargos.some((x) => x.id === e.id)).clave;
  const [A, B, C] = [clave(a), clave(b), clave(c)];
  // Sin horas fijadas: el más corto, de la más cerca a la más lejos.
  assert.deepEqual(orden(r, [A, B, C]), [A, B, C]);
  // El horario escrito en el encargo («antes de las 14 hs») es su horario.
  assert.deepEqual(r.paradas.find((p) => p.clave === C).horario, [0, 14 * 60]);

  // C antes de las 9:15: pasa primera, aunque el recorrido quede más largo.
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: C, modo: 'antes', hora: '9:15' })).status, 200);
  r = await ruta();
  const pc = r.paradas.find((p) => p.clave === C);
  assert.equal(pc.pactada.texto, 'Antes de las 9:15');
  assert.equal(pc.estricto, true);
  assert.deepEqual(pc.horario, [0, 9 * 60 + 15], 'cumple la hora fijada y el horario del encargo');
  assert.equal(orden(r, [A, B, C])[0], C, 'la que tiene que llegar antes de las 9:15 va primera');
  assert.equal(llegadas(r).tarde, 0, 'nadie llega tarde');

  // Ordenado a mano, y después B a las 10:00: el recorrido vuelve a ordenarse solo y cumple las dos horas.
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: DIA, rutas: [{ chofer: null, base: 'roca', salida: 510, orden: [A, B, C], a_mano: true, fin: 'ultima' }] })).status, 200);
  assert.equal((await ruta()).rutas[0].a_mano, true);
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: B, modo: 'a_las', hora: '10:00' })).status, 200);
  r = await ruta();
  assert.equal(r.rutas[0].a_mano, false, 'vuelve a ordenarse solo');
  assert.equal(orden(r, [A, B, C])[0], C);
  const sim = llegadas(r);
  assert.equal(sim.tarde, 0, JSON.stringify(sim.paradas.map((p) => [p.clave, Math.round(p.llega)])));
  const llegaB = sim.paradas.find((p) => p.clave === B);
  assert.ok(llegaB.llega + llegaB.espera >= 9 * 60 + 45 && llegaB.llega + llegaB.espera <= 10 * 60 + 15, 'B entre 9:45 y 10:15');

  // En la semana, la tarjeta dice la hora.
  const semana = (await api('GET', `/cronograma?desde=${DIA}&hasta=${DIA}`)).data;
  assert.equal(semana.encargos.find((e) => e.id === c.id).hora, 'Antes de las 9:15');
  assert.equal(semana.encargos.find((e) => e.id === b.id).hora, 'A las 10:00');

  // Validaciones, sacar la hora y quién puede.
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: B, modo: 'a_las', hora: '25:00' })).status, 400);
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: B, modo: 'cuando', hora: '10:00' })).status, 400);
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: B, modo: null })).status, 200);
  r = await ruta();
  assert.equal(r.paradas.find((p) => p.clave === B).pactada ?? null, null);
  const vende = (await api('POST', '/users', { email: `vende.horas.${RUN}@formas.ar`, name: `Vende Horas ${RUN}`, profile: 'comercial', role: 'member' })).data;
  assert.equal((await api('PUT', '/cronograma/hora', { fecha: DIA, clave: B, modo: 'a_las', hora: '11:00' }, vende.email)).status, 403);
});
