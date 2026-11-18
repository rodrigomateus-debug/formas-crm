// Destinos (src/worker/destinos.ts): tipos, empresas con varias sucursales, la lista con el mapa y la dirección elegida de
// Google. Y completados con IA (src/worker/destinosia.ts): Claude propone la dirección, la localidad y la provincia de
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
    if (req.url.startsWith('/places/places/ChIJ_zecat_pilar')) {
      return res.end(JSON.stringify({ id: 'ChIJ_zecat_pilar', formattedAddress: 'Ruta 8 Km 50 1234, B1629 Pilar, Provincia de Buenos Aires, Argentina', location: { latitude: -34.45, longitude: -58.91 },
        types: ['street_address'], addressComponents: [{ longText: 'Ruta 8 Km 50', types: ['route'] }, { longText: '1234', types: ['street_number'] }, { longText: 'Pilar', types: ['locality'] },
          { longText: 'Provincia de Buenos Aires', types: ['administrative_area_level_1'] }, { longText: 'B1629', types: ['postal_code'] }] }));
    }
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
  assert.equal(taller.localidad ?? null, null);
  assert.equal(taller.ia_estado, 'dudoso');
  assert.equal(taller.ia_sugerida.localidad, 'Avellaneda');

  // Lo que ya se revisó no se vuelve a revisar (si nadie lo cambia).
  const otra = await call('POST', '/recorridos/libreta/ia', {});
  assert.ok(!otra.data.corregidos.some((c) => Object.values(ids).includes(c.id)));
  assert.ok(!otra.data.dudosos.some((c) => Object.values(ids).includes(c.id)));

  // Corregido a mano: deja de estar «Para revisar».
  await call('PATCH', `/recorridos/libreta/${ids[`Taller ${RUN}`]}`, { localidad: 'Avellaneda', provincia: 'Buenos Aires' });
  const t2 = (await call('GET', `/recorridos/libreta?q=${RUN}`)).data.destinos.find((d) => d.id === ids[`Taller ${RUN}`]);
  assert.equal(t2.ia_estado ?? null, null);
  assert.equal(t2.provincia, 'Buenos Aires');
});

test('destinos: tipo, sucursales agrupadas, contacto y la dirección elegida de Google Maps', async () => {
  const crear = async (b) => { const r = await call('POST', '/recorridos/libreta', b); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
  const ofi = await crear({ nombre: `ZTK${RUN} Oficina`, direccion: 'Av. Corrientes 1234', localidad: 'CABA', provincia: 'Ciudad Autónoma de Buenos Aires', contacto: 'Marcela', whatsapp: '11 5555-1234' });
  const dep = await crear({ nombre: `ZTK${RUN} Deposito`, direccion: 'x', place_id: 'ChIJ_zecat_pilar', sucursal: 'Depósito Pilar', tipo: 'proveedor' });
  const imp = await crear({ nombre: `Imprenta Sol ${RUN}`, direccion: 'Mitre 10', localidad: 'Avellaneda' });

  let l = (await call('GET', '/recorridos/libreta')).data;
  const d = (id) => l.destinos.find((x) => x.id === id);
  // Elegida de Google: calle y altura, localidad, provincia y CP en partes, con el punto en el mapa.
  assert.equal(d(dep).direccion, 'Ruta 8 Km 50 1234');
  assert.equal(d(dep).localidad, 'Pilar');
  assert.equal(d(dep).provincia, 'Buenos Aires');   // como en el listado de provincias (Georef)
  assert.equal(d(dep).codigo_postal, 'B1629');
  assert.equal(d(dep).mapa, 'ok');
  assert.equal(d(dep).lat, -34.45);
  assert.equal(d(dep).tipo, 'proveedor');
  assert.equal(d(dep).tipo_origen, 'manual');
  // El tipo por el nombre; lo que falta, a la vista.
  assert.equal(d(imp).tipo, 'impresor');
  assert.equal(d(imp).tipo_origen, 'nombre');
  assert.ok(d(imp).faltan.includes('contacto'));
  // La provincia sale de la localidad (Avellaneda está en Buenos Aires).
  assert.equal(d(imp).provincia, 'Buenos Aires');
  assert.equal(d(ofi).whatsapp, '11 5555-1234');
  assert.deepEqual(d(ofi).viajes, { seis: 0, total: 0, ultimo: null, proximo: null });
  // Sugiere juntar las dos de ZTK (mismo nombre).
  const sug = l.sugeridos.find((s) => s.ids.includes(ofi));
  assert.ok(sug && sug.ids.includes(dep), JSON.stringify(l.sugeridos));

  // Agrupar como una empresa: el tipo del grupo pasa a sus direcciones.
  const g = await call('POST', '/recorridos/grupos', { nombre: `ZTK ${RUN}`, ids: [ofi, dep], tipo: 'proveedor' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(ofi).grupo_id, g.data.grupo_id);
  assert.equal(d(ofi).tipo, 'proveedor');
  assert.equal(l.grupos.find((x) => x.id === g.data.grupo_id).n, 2);
  assert.ok(!l.sugeridos.some((s) => s.ids.includes(ofi)), 'lo agrupado ya no se sugiere');

  // Un viaje hecho cuenta.
  const enc = await call('POST', '/recorridos/encargos', { fecha: '2026-11-02', destino: { lugar_id: ofi }, llevar: [{ que: 'Muestras' }] });
  assert.equal(enc.status, 200, JSON.stringify(enc.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(ofi).viajes.total, 1);
  assert.equal(d(ofi).viajes.ultimo, '2026-11-02');

  // Sacar uno del grupo deja al otro solo; deshacerlo borra el grupo.
  await call('POST', `/recorridos/grupos/${g.data.grupo_id}/sacar`, { ids: [dep] });
  await call('POST', `/recorridos/grupos/${g.data.grupo_id}/sacar`, {});
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(ofi).grupo_id ?? null, null);
  assert.ok(!l.grupos.some((x) => x.id === g.data.grupo_id));

  // Borrar: deja de estar en la lista, pero el encargo que lo nombra no cambia.
  assert.equal(d(ofi).puede_borrar, true);
  const b = await call('PATCH', `/recorridos/libreta/${ofi}`, { activo: false });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(ofi), undefined);
  const e = (await call('GET', `/recorridos/encargos/${enc.data.id}`)).data;
  assert.equal(e.lugar_id ?? e.encargo?.lugar_id, ofi);
});

test('destinos: se relacionan solos con su empresa del CRM (por el nombre) y lo hecho a mano queda', async () => {
  const empresa = async (props) => { const r = await call('POST', '/records/company', { props }); assert.ok(r.status < 300, JSON.stringify(r.data)); return r.data.id; };
  const crear = async (b) => { const r = await call('POST', '/recorridos/libreta', b); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
  // Dos empresas que se llaman igual: gana la que es cliente (la otra es proveedor).
  const prov = await empresa({ name: `Gdr${RUN}`, tipo_de_relacion: 'proveedor' });
  const cliente = await empresa({ name: `GDR${RUN} S.A.`, domain: `gdr-${RUN}.com.ar` });
  const otra = await empresa({ name: `Otra ${RUN} SRL`, domain: `otra-${RUN}.com.ar` });
  assert.notEqual(prov, cliente);

  const igual = await crear({ nombre: `GDR${RUN}`, direccion: 'Darwin 429', localidad: 'CABA' });
  const conParentesis = await crear({ nombre: `Gdr${RUN} (DEPÓSITO)`, direccion: 'Av. Juan B. Justo 2500', localidad: 'CABA' });
  const conLugar = await crear({ nombre: `Depósito gdr${RUN}`, direccion: 'Ruta 8 km 60', localidad: 'Pilar' });
  const pilar = await crear({ nombre: `Planta Pilar ${RUN}`, direccion: 'Ruta 8 km 61', localidad: 'Pilar' });
  const nada = await crear({ nombre: `Casa de Juan ${RUN}`, direccion: 'Mitre 1', localidad: 'CABA' });

  let l = (await call('GET', '/recorridos/libreta')).data;
  const d = (id) => l.destinos.find((x) => x.id === id);
  for (const id of [igual, conParentesis, conLugar]) {
    assert.equal(d(id).company_id, cliente, `${d(id).nombre}: la empresa cliente`);
    assert.equal(d(id).empresa, `GDR${RUN} S.A.`);
    assert.equal(d(id).dominio, `gdr-${RUN}.com.ar`, 'el dominio, para el logo');
    assert.equal(d(id).empresa_origen, 'nombre');
    assert.equal(d(id).tipo, 'cliente', 'y con la empresa, el tipo');
  }
  assert.equal(d(pilar).company_id ?? null, null);
  assert.equal(d(nada).company_id ?? null, null);

  // Un grupo que se llama como la empresa queda relacionado, y sus direcciones (aunque se llamen distinto) también.
  const g = (await call('POST', '/recorridos/grupos', { nombre: `gdr${RUN}`, ids: [igual, pilar] })).data.grupo_id;
  l = (await call('GET', '/recorridos/libreta')).data;
  const grupo = () => l.grupos.find((x) => x.id === g);
  assert.equal(grupo().company_id, cliente);
  assert.equal(grupo().dominio, `gdr-${RUN}.com.ar`);
  assert.equal(d(pilar).company_id, cliente);
  assert.equal(d(pilar).empresa_origen, 'grupo');

  // Quitada a mano: no se vuelve a relacionar sola.
  let r = await call('PATCH', `/recorridos/libreta/${conLugar}`, { company_id: null });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(conLugar).company_id ?? null, null, 'lo que se quitó a mano no vuelve');
  // Elegida a mano: queda esa.
  r = await call('PATCH', `/recorridos/libreta/${nada}`, { company_id: otra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(nada).company_id, otra);
  assert.equal(d(nada).empresa_origen, 'manual');
  assert.equal((await call('PATCH', `/recorridos/libreta/${nada}`, { company_id: 999999999 })).status, 404);

  // Cambiar la empresa del grupo pasa a sus direcciones; sacar una del grupo le suelta la que tenía por el grupo.
  r = await call('PATCH', `/recorridos/grupos/${g}`, { company_id: otra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(grupo().company_id, otra);
  assert.equal(d(igual).company_id, otra);
  assert.equal(d(pilar).company_id, otra);
  await call('POST', `/recorridos/grupos/${g}/sacar`, { ids: [pilar] });
  l = (await call('GET', '/recorridos/libreta')).data;
  assert.equal(d(pilar).grupo_id ?? null, null);
  assert.equal(d(pilar).company_id ?? null, null, 'fuera del grupo ya no es de esa empresa');
  assert.equal(d(igual).company_id, otra, 'la que sigue en el grupo, sí');
});

test('destinos: la localidad y la provincia quedan escritas como en el listado de Georef', async () => {
  const crear = async (b) => { const r = await call('POST', '/recorridos/libreta', b); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
  const a = await crear({ nombre: `Georef A ${RUN}`, direccion: 'Nicaragua 1651', localidad: 'SARANDI', provincia: 'Pcia de Buenos Aires' });
  const b = await crear({ nombre: `Georef B ${RUN}`, direccion: 'Pueyrredón 100', localidad: 'ONCE', provincia: 'Capital Federal' });
  const c = await crear({ nombre: `Georef C ${RUN}`, direccion: 'Uruguay 882', localidad: 'Parlermo', provincia: '' });
  const l = (await call('GET', '/recorridos/libreta')).data;
  const d = (id) => l.destinos.find((x) => x.id === id);
  assert.deepEqual([d(a).localidad, d(a).provincia], ['Sarandí', 'Buenos Aires']);
  assert.deepEqual([d(b).localidad, d(b).provincia], ['Balvanera', 'Ciudad Autónoma de Buenos Aires']);
  // Un error de tipeo se corrige y la provincia sale del barrio.
  assert.deepEqual([d(c).localidad, d(c).provincia], ['Palermo', 'Ciudad Autónoma de Buenos Aires']);
  // Al editar, lo mismo.
  assert.equal((await call('PATCH', `/recorridos/libreta/${a}`, { localidad: 'martinez', provincia: 'buenos aires' })).status, 200);
  const l2 = (await call('GET', '/recorridos/libreta')).data;
  assert.deepEqual([l2.destinos.find((x) => x.id === a).localidad, l2.destinos.find((x) => x.id === a).provincia], ['Martínez', 'Buenos Aires']);
});
