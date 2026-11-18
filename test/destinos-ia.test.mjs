// Destinos completados con IA (src/worker/destinosia.ts): Claude propone la dirección, la localidad y la provincia de
// cada destino de la libreta y solo se corrige lo que está al menos 90 % seguro y Google Maps ubica en el mismo lugar.
// Claude simulado en el puerto 8797 y Google Maps en el 8793 (ver .dev.vars.example).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// Lo que "contesta" Claude para cada destino, por nombre.
const PROPUESTAS = {
  [`Imprenta ${RUN}`]: { direccion: 'Nicaragua 1651', localidad: 'Sarandí', provincia: 'Buenos Aires', confianza: 95, motivo: 'Nicaragua al 1600 está en Sarandí.' },
  [`Taller ${RUN}`]: { direccion: 'Mitre 500', localidad: 'Avellaneda', provincia: 'Buenos Aires', confianza: 60, motivo: 'Hay calle Mitre en muchas localidades.' },
  [`Deposito ${RUN}`]: { direccion: 'Av. Corrientes 1234', localidad: 'CABA', provincia: 'Ciudad Autónoma de Buenos Aires', confianza: 97, motivo: 'Corrientes 1234 es CABA.' },
};
const GOOGLE = {
  nicaragua: { formattedAddress: 'Nicaragua 1651, B1872 Sarandí, Provincia de Buenos Aires, Argentina', location: { latitude: -34.67, longitude: -58.33 },
    addressComponents: [{ longText: '1651', types: ['street_number'] }, { longText: 'Sarandí', types: ['locality'] }, { longText: 'Provincia de Buenos Aires', types: ['administrative_area_level_1'] }] },
  // Google la ubica en otra altura: aunque Claude esté seguro, no se corrige.
  corrientes: { formattedAddress: 'Av. Corrientes 1200, C1043 CABA, Argentina', location: { latitude: -34.60, longitude: -58.38 },
    addressComponents: [{ longText: '1200', types: ['street_number'] }, { longText: 'Buenos Aires', types: ['locality'] }, { longText: 'Ciudad Autónoma de Buenos Aires', types: ['administrative_area_level_1'] }] },
};
let claude, maps;
before(async () => {
  claude = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    res.setHeader('content-type', 'application/json');
    if (!req.url.startsWith('/anthropic/v1/messages')) { res.statusCode = 404; return res.end('{}'); }
    const pedido = JSON.parse(body);
    const destinos = JSON.parse(pedido.messages[0].content.replace(/^Destinos:\n/, ''));
    const out = destinos.map((d) => ({ id: d.id, ...(PROPUESTAS[d.nombre] ?? { direccion: d.direccion, localidad: '', provincia: '', confianza: 0, motivo: 'No sé.' }) }));
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: pedido.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify({ destinos: out }) }] }));
  });
  maps = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    res.setHeader('content-type', 'application/json');
    if (!req.url.startsWith('/places/places:searchText')) { res.statusCode = 404; return res.end('{}'); }
    const q = JSON.parse(body).textQuery.toLowerCase();
    const g = Object.entries(GOOGLE).find(([k]) => q.includes(k))?.[1];
    res.end(JSON.stringify({ places: g ? [g] : [] }));
  });
  await new Promise((r) => claude.listen(8797, r));
  await new Promise((r) => maps.listen(8793, r));
});
after(() => { claude?.close(); maps?.close(); });

test('destinos: la IA completa solo lo que está ≥ 90 % seguro y Google confirma', async () => {
  const ids = {};
  for (const [nombre, direccion] of [[`Imprenta ${RUN}`, 'nicaragua 1651'], [`Taller ${RUN}`, 'Mitre 500'], [`Deposito ${RUN}`, 'Corrientes 1234']]) {
    const r = await call('POST', '/recorridos/libreta', { nombre, direccion });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids[nombre] = r.data.id;
  }
  const r = await call('POST', '/recorridos/libreta/ia', { ids: Object.values(ids) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.revisados, 3);
  assert.deepEqual(r.data.corregidos.map((c) => c.nombre), [`Imprenta ${RUN}`]);
  assert.deepEqual(r.data.dudosos.map((c) => c.nombre).sort(), [`Deposito ${RUN}`, `Taller ${RUN}`]);
  assert.match(r.data.dudosos.find((d) => d.nombre === `Deposito ${RUN}`).motivo, /no en esa altura/);

  const lista = (await call('GET', `/recorridos/libreta?q=${RUN}`)).data.destinos;
  const imp = lista.find((d) => d.id === ids[`Imprenta ${RUN}`]);
  assert.equal(imp.direccion, 'Nicaragua 1651');
  assert.equal(imp.localidad, 'Sarandí');
  assert.equal(imp.provincia, 'Buenos Aires');
  assert.equal(imp.ia_estado, 'corregido');
  assert.equal(imp.ia_antes.direccion, 'nicaragua 1651', 'guarda cómo estaba para volver atrás');
  const taller = lista.find((d) => d.id === ids[`Taller ${RUN}`]);
  assert.equal(taller.direccion, 'Mitre 500', 'lo dudoso no se toca');
  assert.equal(taller.localidad, null);
  assert.equal(taller.ia_estado, 'dudoso');
  assert.equal(taller.ia_sugerida.localidad, 'Avellaneda');

  // Lo que ya se revisó no se vuelve a revisar (si nadie lo cambia).
  const otra = await call('POST', '/recorridos/libreta/ia', {});
  assert.ok(!otra.data.corregidos.some((c) => Object.values(ids).includes(c.id)));
  assert.ok(!otra.data.dudosos.some((c) => Object.values(ids).includes(c.id)));

  // Corregido a mano: deja de estar «Para revisar».
  await call('PATCH', `/recorridos/libreta/${ids[`Taller ${RUN}`]}`, { localidad: 'Avellaneda', provincia: 'Buenos Aires' });
  const t2 = (await call('GET', `/recorridos/libreta?q=${RUN}`)).data.destinos.find((d) => d.id === ids[`Taller ${RUN}`]);
  assert.equal(t2.ia_estado, null);
  assert.equal(t2.provincia, 'Buenos Aires');
});
