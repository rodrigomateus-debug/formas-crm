// Recorridos (recorridos.ts): la base de destinos (la libreta del Hub, que se sigue copiando de la planilla sin pisar lo
// que se corrige), los encargos al recorrido de un día, cuándo ya se va a cada lugar, el cronograma y la ruta del día, la
// app del chofer, los avisos, el remito de traslado y el historial de la planilla vieja. La planilla publicada como CSV,
// el buscador de direcciones y la Sheets API, simulados (puerto 8797; ver .dev.vars.example). El token de Google, el de
// test/google-falso.mjs (puerto 8799, con `node test/gmail-dev-vars.mjs`); sin eso se saltea lo del historial.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { googleFalso } from './google-falso.mjs';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
// Una altura distinta en cada corrida: dos lugares en la misma calle y altura son la misma parada.
const N = (parseInt(RUN.slice(-5), 36) % 8000) + 1000;
const HOY = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const dia = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const habil = (d) => { let x = dia(d, 1); while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = dia(x, 1); return x; };
const MANANA = habil(HOY), PASADO = habil(MANANA);
let asUser = null;
async function api(method, path, body, user = asUser) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(user ? { 'x-dev-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

// La planilla DESTINOS (la libreta). `sacar` la deja sin un lugar, como si lo hubieran borrado de la planilla.
const LUGARES = [
  ['PROVEEDOR', 'DIRECCION', 'H. ATENCION', 'TELEFONO', 'LOCALIDAD', 'ZONA', 'CONTACTO 1', 'CONTACTO 2', 'OBSERVACIONES'],
  [`IMPREFAS ${RUN}`, `Av. Mitre ${N}`, '8 a 16', '15-4041-0635', 'SAN ANDRES', 'NORTE', 'Juan', '', ''],
  [`MAD / DIMILITO ${RUN}`, 'Alvear 1691', '9 a 17', '', 'FLORIDA', 'NORTE', '', '', 'Tocar timbre'],
  [`CERAMICA ${RUN}`, 'Azcuenaga 4104', '', '', 'VILLA LYNCH', 'NORTE', '', '', ''],
  [`CERAMICA ${RUN}`, 'Azcuenaga 4104', '', '', 'VILLA LYNCH', 'NORTE', '', '', ''],   // repetida: es el mismo lugar
];
let sacar = null;
const csv = () => LUGARES.filter((f) => f[0] !== sacar).map((f) => f.map((c) => `"${c}"`).join(',')).join('\n');

// La planilla «Recorridos» vieja: una pestaña por mes. MAD va todos los jueves de las últimas 8 semanas; una fila está
// copiada en las dos pestañas (pasa en la planilla real).
const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const pestaña = (d) => `${MESES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const fechaPlanilla = (d) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}/${d.slice(0, 4)}`;
const CAB = ['FECHA', 'ENTREGA', 'PRIORIDAD', 'COSTO', 'X', 'RESPONSABLE', 'ORDEN', 'DESDE', 'DESTINO', 'DIRECCION', 'LOCALIDAD', 'HORARIO', 'DEJA (EGRESOS)', 'RETIRA', 'OBSERVACIONES'];
const filasPlanilla = () => {
  const out = [];
  let jueves = dia(HOY, -1);
  while (new Date(`${jueves}T12:00:00Z`).getUTCDay() !== 4) jueves = dia(jueves, -1);
  for (let i = 0; i < 8; i++) {
    const d = dia(jueves, -7 * i);
    out.push([fechaPlanilla(d), 'RETIRADO', '', '', 'CRISTIAN', 'GONZA', '', 'DEPOSITO FORMAS ', `MAD / DIMILITO ${RUN}`, 'Alvear 1691', 'FLORIDA', '', '', `${100 + i} paletas`, '']);
  }
  const ayer = dia(HOY, -1);
  out.push([fechaPlanilla(ayer), 'ENTREGADO', 'ALTA', '', 'MOTO FACE', `WANDA${RUN}`, '', 'OFICINA FORMAS', `CERAMICA ${RUN}`, 'Azcuenaga 4104', 'VILLA LYNCH', 'luego del mediodia', 'Muestras de tazas', '', 'Para Delfina']);
  out.push([fechaPlanilla(ayer), 'NO HABIA QUE IR', '', '', 'GABY', `WANDA${RUN}`, '', 'DEPOSITO FORMAS ', '', `Gorriti ${N + 1}`, 'CABA', '', 'Sobre', '', '']);
  // Lo de hoy en adelante no se trae (todavía se puede estar cargando en la planilla).
  out.push([fechaPlanilla(HOY), '', '', '', 'GABY', `WANDA${RUN}`, '', '', `CERAMICA ${RUN}`, 'Azcuenaga 4104', '', '', 'Hoy', '', '']);
  return out;
};
const pestañas = () => {
  const m = new Map();
  for (const f of filasPlanilla()) {
    const [d, mm, y] = f[0].split('/');
    const t = pestaña(`${y}-${mm.padStart(2, '0')}-${d.padStart(2, '0')}`);
    m.set(t, [...(m.get(t) ?? [CAB]), f]);
  }
  // La primera fila de MAD, copiada también en otra pestaña.
  const titulos = [...m.keys()];
  if (titulos.length > 1) m.get(titulos[1]).push(m.get(titulos[0])[1]); else m.get(titulos[0]).push(m.get(titulos[0])[1]);
  return m;
};

let server, g = null;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (b, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (url.pathname === '/lugares.csv') return send(csv(), 200, 'text/csv');
    if (url.pathname === '/geo') {
      // Los depósitos, donde los ubica también test/cronograma.test.mjs (cada dirección se busca una sola vez y queda guardada).
      const q = url.searchParams.get('q') ?? '';
      if (/Roca 4250/.test(q)) return send([{ lat: '-34.5361', lon: '-58.5152' }]);
      if (/Matienzo 1308/.test(q)) return send([{ lat: '-34.5345', lon: '-58.5170' }]);
      return send([{ lat: String(-34.5 - Math.random() / 10), lon: String(-58.5 - Math.random() / 10) }]);
    }
    if (url.pathname.startsWith('/sheets/')) {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer tok:')) return send({ error: 'sin token' }, 401);
      const ps = pestañas();
      const resto = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
      if (!resto) return send({ sheets: [...ps.keys(), 'DESTINOS', 'REMITOS DE TRASLADO'].map((title) => ({ properties: { title } })) });
      const titulo = resto.match(/^values\/'(.+)'!/)?.[1];
      return send({ values: ps.get(titulo) ?? [] });
    }
    // Lo demás de 8797 (ClickUp, Finnegans) no lo usa esta prueba: vacío.
    if (url.pathname.includes('clickup')) return send({ tasks: [], last_page: true });
    send({}, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(async () => { await new Promise((r) => server.close(r)); if (g) await g.cerrar(); });

test('recorridos: destinos, encargos, cronograma, chofer, avisos, remito e historial', async (t) => {
  // ---------- La libreta es del Hub: la copia de la planilla suma y actualiza, no borra ----------
  let r = await api('POST', '/cronograma/lugares/actualizar');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.error, null);
  const buscar = async (q) => (await api('GET', `/recorridos/destinos?q=${encodeURIComponent(q)}`)).data.destinos;
  const imprefas = (await buscar(`imprefas ${RUN}`)).find((d) => d.tipo === 'lugar');
  assert.ok(imprefas, 'el lugar de la planilla está en la base de destinos');
  assert.match(imprefas.direccion, /San Andres/i);
  assert.equal((await buscar(`ceramica ${RUN}`)).filter((d) => d.tipo === 'lugar').length, 1, 'la fila repetida de la planilla es un solo lugar');
  // Corregido en el Hub: la próxima copia no lo pisa. Y el id no cambia.
  assert.equal((await api('PATCH', `/recorridos/libreta/${imprefas.lugar_id}`, { horario: '7 a 15', observaciones: 'Portón verde' })).status, 200);
  sacar = `CERAMICA ${RUN}`;
  r = await api('POST', '/cronograma/lugares/actualizar');
  assert.equal(r.data.error, null);
  const imp2 = (await buscar(`imprefas ${RUN}`)).find((d) => d.tipo === 'lugar');
  assert.equal(imp2.lugar_id, imprefas.lugar_id, 'el lugar conserva su id');
  assert.equal(imp2.horario, '7 a 15', 'lo corregido en el Hub queda');
  assert.equal((await buscar(`ceramica ${RUN}`)).filter((d) => d.tipo === 'lugar').length, 0, 'lo que la planilla sacó deja de ofrecerse');
  sacar = null;
  await api('POST', '/cronograma/lugares/actualizar');
  const ceramica = (await buscar(`ceramica ${RUN}`)).find((d) => d.tipo === 'lugar');
  assert.ok(ceramica, 'y vuelve si la planilla lo vuelve a tener');
  const mad = (await buscar(`dimilito ${RUN}`)).find((d) => d.tipo === 'lugar');

  // ---------- Usuarios: una vendedora y alguien de Logística ----------
  const vera = (await api('POST', '/users', { email: `vera.rc.${RUN}@formas.ar`, name: `Vera Rc ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const lola = (await api('POST', '/users', { email: `lola.rc.${RUN}@formas.ar`, name: `Lola Logistica ${RUN}`, profile: 'logistica', role: 'member' })).data;
  const wanda = (await api('POST', '/users', { email: `wanda.rc.${RUN}@formas.ar`, name: `Wanda${RUN} Prueba`, profile: 'comercial', role: 'member' })).data;
  assert.ok(vera.id && lola.id && wanda.id);

  // ---------- Encargos ----------
  asUser = vera.email;
  assert.equal((await api('POST', '/recorridos/encargos', { fecha: MANANA, lugar_id: imprefas.lugar_id })).status, 400, 'sin nada que llevar o retirar');
  assert.equal((await api('POST', '/recorridos/encargos', { fecha: dia(HOY, -1), lugar_id: imprefas.lugar_id, llevar: [{ que: 'x' }] })).status, 400, 'un día que ya pasó');
  r = await api('POST', '/recorridos/encargos', { fecha: MANANA, lugar_id: imprefas.lugar_id, llevar: [{ cant: '3', que: 'Muestras de termos', pdv: 'PDV 31406' }], retirar: [{ que: 'Bolsas falladas' }],
    contacto: 'Juan 1155556666', urgente: true, desde: 'matienzo' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e1 = r.data;
  assert.equal(e1.destino, `IMPREFAS ${RUN}`);
  assert.deepEqual(e1.llevar, [{ cant: 3, que: 'Muestras de termos', pdv: '31406' }]);
  r = await api('POST', '/recorridos/encargos', { fecha: MANANA, lugar_id: imprefas.lugar_id, llevar: [{ cant: '2,5', que: 'Metros de lona' }, { cant: '1.500', que: 'Bolígrafos' }] });
  assert.deepEqual(r.data.llevar.map((i) => i.cant), [2.5, 1500], 'las cantidades como se escriben acá');
  assert.equal((await api('PATCH', `/recorridos/encargos/${r.data.id}`, { estado: 'cancelado' })).status, 200);
  assert.equal(e1.desde, 'matienzo');
  assert.equal(e1.estado, 'pendiente');
  // A una dirección suelta, guardándola en Destinos.
  r = await api('POST', '/recorridos/encargos', { fecha: MANANA, destino: { nombre: `Casa de Juana ${RUN}`, direccion: `Gorriti ${N} piso 4, CABA`, guardar: true }, llevar: [{ que: 'Sobre' }] });
  assert.equal(r.status, 200);
  assert.ok(r.data.lugar_id, 'la dirección nueva quedó en la base de destinos');
  assert.ok((await buscar(`juana ${RUN}`)).some((d) => d.lugar_id === r.data.lugar_id));
  const e2 = r.data;

  // Logística carga otro para el mismo lugar el mismo día, con una empresa del CRM que es ese lugar.
  asUser = null;
  const empresa = (await api('POST', '/records/company', { props: { name: `IMPREFAS ${RUN}`, address: `Av. Mitre ${N}`, city: 'San Andrés' } })).data;
  r = await api('POST', '/recorridos/encargos', { fecha: MANANA, company_id: empresa.id, retirar: [{ cant: 100, que: 'Cajas de vino' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e3 = r.data;
  assert.equal(e3.company_id, empresa.id);
  assert.ok(e3.lugar_id, 'la empresa quedó como destino en la libreta');

  // ---------- Cuándo ya se va a cada lugar ----------
  asUser = vera.email;
  r = await api('GET', `/recorridos/destino?lugar_id=${imprefas.lugar_id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const dm = r.data.dias.find((d) => d.fecha === MANANA);
  assert.ok(dm.viajes.includes('Tu encargo'), JSON.stringify(dm));
  assert.ok(dm.viajes.some((v) => v.startsWith('Encargo de')), 'el de Logística al mismo lugar también cuenta');
  assert.equal(r.data.lugar.coordinacion, null, 'cómo se coordina lo ve solo quien organiza');
  // Sus destinos frecuentes.
  r = await api('GET', '/recorridos/sugerencias');
  const frec = r.data.frecuentes.find((d) => d.lugar_id === imprefas.lugar_id);
  assert.ok(frec, JSON.stringify(r.data.frecuentes));
  assert.equal(frec.proximos[0].fecha, MANANA, 'dice que mañana ya se va');
  assert.ok(r.data.bases.some((b) => b.id === 'matienzo'));

  // ---------- La agenda: lo de otros clientes no dice de quién es (perfil Ventas) ----------
  asUser = null;
  const cliente = (await api('POST', '/records/company', { props: { name: `Cliente Secreto ${RUN}`, address: `Av. Libertador ${N}`, city: 'Vicente López' } })).data;
  assert.equal((await api('POST', '/recorridos/encargos', { fecha: PASADO, company_id: cliente.id, llevar: [{ que: 'Muestras' }] })).status, 200);
  r = await api('GET', `/recorridos/agenda?desde=${PASADO}&dias=1`, undefined, vera.email);
  const anon = r.data.dias[0].paradas.find((p) => p.localidad === 'Vicente López');
  assert.ok(anon, JSON.stringify(r.data.dias[0].paradas));
  assert.equal(anon.nombre, 'Un cliente');
  assert.equal(anon.encargos.length, 0);
  r = await api('GET', `/recorridos/agenda?desde=${PASADO}&dias=1`);
  assert.ok(r.data.dias[0].paradas.some((p) => p.nombre === `Cliente Secreto ${RUN}`), 'Logística lo ve con su nombre');

  // ---------- Permisos ----------
  assert.equal((await api('GET', `/recorridos/encargos/${e3.id}`, undefined, vera.email)).status, 403, 'la vendedora no abre el de otro');
  assert.equal((await api('PATCH', `/recorridos/encargos/${e3.id}`, { notas: 'x' }, vera.email)).status, 403);
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { estado: 'hecho' }, vera.email)).status, 403, 'hecho lo marca Logística o el chofer');
  assert.equal((await api('PATCH', `/recorridos/encargos/${e2.id}`, { estado: 'cancelado', motivo: 'Lo llevo yo' }, vera.email)).data.estado, 'cancelado');
  // Un error de validación no deja nada cambiado a medias.
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { fecha: PASADO, llevar: [], retirar: [], notas: '' }, vera.email)).status, 400);
  assert.equal((await api('GET', `/recorridos/encargos/${e1.id}`, undefined, vera.email)).data.fecha, MANANA);
  // Una empresa que no ve no la puede usar de destino (ni ver su dirección).
  assert.equal((await api('POST', '/recorridos/encargos', { fecha: PASADO, company_id: cliente.id, llevar: [{ que: 'x' }] }, vera.email)).status, 400);
  // Los destinos de la libreta los corrige Logística; los que cargó ella, ella.
  assert.equal((await api('PATCH', `/recorridos/libreta/${imprefas.lugar_id}`, { horario: '1 a 2' }, vera.email)).status, 403);
  assert.equal((await api('PATCH', `/recorridos/libreta/${e2.lugar_id}`, { horario: '9 a 12' }, vera.email)).status, 200);
  // Lo de ella que cae en la parada de un cliente ajeno no lo destapa.
  const deVera = (await api('POST', '/recorridos/encargos', { fecha: PASADO, destino: { nombre: `Oficina de Vera ${RUN}`, direccion: `Av. Libertador ${N}, Vicente López` }, llevar: [{ que: 'Catálogo' }] }, vera.email)).data;
  r = await api('GET', `/recorridos/agenda?desde=${PASADO}&dias=1`, undefined, vera.email);
  const junta = r.data.dias[0].paradas.find((p) => p.encargos.some((e) => e.id === deVera.id));
  assert.equal(junta.tipos.encargo, 2, 'va en la misma parada que el del cliente ajeno');
  assert.equal(junta.nombre, `Oficina de Vera ${RUN}`, 'con el nombre que le puso ella');
  assert.ok(!JSON.stringify(r.data).includes(`Cliente Secreto ${RUN}`), 'sin el nombre del cliente ajeno');

  // ---------- El cronograma: van en la parada de ese lugar ----------
  asUser = null;
  r = await api('GET', `/cronograma/ruta?fecha=${MANANA}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const parada = r.data.paradas.find((p) => p.encargos.some((e) => e.id === e1.id));
  assert.ok(parada, 'el encargo es una parada de la ruta');
  assert.ok([e1.id, e3.id].every((id) => parada.encargos.some((e) => e.id === id)), 'los dos encargos a Imprefas van en la misma parada');
  assert.ok(!r.data.paradas.some((p) => p.encargos.some((e) => e.id === e2.id)), 'el cancelado no va');
  assert.equal(parada.lugar.observaciones, 'Portón verde');
  const semana = (await api('GET', `/cronograma?desde=${MANANA}&hasta=${MANANA}`)).data;
  assert.ok(semana.encargos.some((e) => e.id === e1.id && e.parada === parada.clave));
  assert.ok(semana.dias[MANANA].total >= 2);
  // El chofer desde la tarjeta: pasa toda la parada. (Los recorridos de ese día, de cero: la prueba se repite sobre la misma base.)
  await api('PUT', '/cronograma/ruta', { fecha: MANANA, rutas: [{ chofer: null, base: 'roca', salida: 510, orden: [] }] });
  r = await api('PUT', '/cronograma/chofer', { fecha: MANANA, ids: [`enc:${e1.id}`], chofer: `Gaby ${RUN}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.movimientos >= 2, 'va toda la parada');
  const s2 = (await api('GET', `/cronograma?desde=${MANANA}&hasta=${MANANA}`)).data;
  assert.equal(s2.encargos.find((e) => e.id === e3.id).chofer, `Gaby ${RUN}`);
  // Pasarlo a otro día le avisa a quien lo pidió.
  r = await api('PATCH', `/recorridos/encargos/${e1.id}`, { fecha: HOY });
  assert.equal(r.data.fecha, HOY);
  let notifs = (await api('GET', '/notificaciones', undefined, vera.email)).data.items;
  assert.ok(notifs.some((n) => n.kind === 'encargo' && n.encargo_id === e1.id && /lo pasó al/.test(n.texto)), JSON.stringify(notifs.slice(0, 3)));

  // ---------- La app del chofer ----------
  const ch = (await api('POST', '/choferes', { name: `Gaby ${RUN}` })).data;
  const hoyRuta = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  const p1 = hoyRuta.paradas.find((p) => p.encargos.some((e) => e.id === e1.id));
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: HOY, rutas: [{ chofer: `Gaby ${RUN}`, base: 'roca', salida: 510, orden: [p1.clave] }] })).status, 200);
  const chofer = (ruta, opts = {}) => fetch(`${BASE}/hooks/chofer/api${ruta}`, { headers: { authorization: `Bearer ${ch.token}`, 'content-type': 'application/json' }, ...opts });
  const rc = await (await chofer('/ruta')).json();
  const pc = rc.recorridos[0].paradas.find((p) => p.clave === p1.clave);
  assert.equal(pc.encargos[0].llevar[0].que, 'Muestras de termos');
  assert.equal(pc.encargos[0].desde, 'Oficina Matienzo', 'dice dónde buscar lo que lleva');
  assert.equal(pc.encargos[0].contacto, 'Juan 1155556666');
  const marcar = async (cuerpo) => (await chofer('/ruta/parada', { method: 'POST', body: JSON.stringify({ clave: p1.clave, ...cuerpo }) })).status;
  assert.equal(await marcar({ resultado: 'no_se_pudo', motivo: 'cerrado', nota: 'Persiana baja' }), 200);
  let enc = (await api('GET', `/recorridos/encargos/${e1.id}`)).data;
  assert.equal(enc.estado, 'no_se_pudo');
  assert.match(enc.motivo, /cerrado.*Persiana baja/i);
  assert.equal(await marcar({ resultado: 'hecho' }), 200);
  enc = (await api('GET', `/recorridos/encargos/${e1.id}`)).data;
  assert.equal(enc.estado, 'hecho');
  assert.equal(enc.hecho_chofer, `Gaby ${RUN}`);
  notifs = (await api('GET', '/notificaciones', undefined, vera.email)).data.items;
  assert.ok(notifs.some((n) => n.encargo_id === e1.id && /hecho/.test(n.texto)), 'a quien lo pidió le llega el aviso');
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { estado: 'pendiente' }, vera.email)).status, 400, 'hecho: quien lo pidió ya no lo reabre');
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { estado: 'cancelado' }, vera.email)).status, 400, 'ni lo cancela');
  assert.equal(await marcar({ resultado: null }), 200, 'deshacer');
  assert.equal((await api('GET', `/recorridos/encargos/${e1.id}`)).data.estado, 'pendiente', 'vuelve a como estaba antes del chofer');
  // Si Logística lo corrigió después, deshacer en la app no lo pisa.
  assert.equal(await marcar({ resultado: 'hecho' }), 200);
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { estado: 'no_se_pudo', motivo: 'Lo devolvieron' })).status, 200);
  assert.equal(await marcar({ resultado: null }), 200);
  assert.equal((await api('GET', `/recorridos/encargos/${e1.id}`)).data.estado, 'no_se_pudo');
  assert.equal((await api('PATCH', `/recorridos/encargos/${e1.id}`, { estado: 'pendiente' })).status, 200);

  // Dos sucursales de la misma empresa el mismo día: dos paradas, cada una con su dirección.
  const suc1 = (await api('POST', '/recorridos/libreta', { nombre: `Nestle ${RUN} (Vicente López)`, direccion: `Av. Libertador ${N + 2}`, localidad: 'Vicente López', company_id: cliente.id })).data.id;
  const suc2 = (await api('POST', '/recorridos/libreta', { nombre: `Nestle ${RUN} (Florida)`, direccion: `Av. San Martín ${N + 3}`, localidad: 'Florida', company_id: cliente.id })).data.id;
  const s1 = (await api('POST', '/recorridos/encargos', { fecha: PASADO, lugar_id: suc1, llevar: [{ que: 'Muestras' }] })).data;
  const s2b = (await api('POST', '/recorridos/encargos', { fecha: PASADO, lugar_id: suc2, llevar: [{ que: 'Muestras' }] })).data;
  r = (await api('GET', `/cronograma/ruta?fecha=${PASADO}`)).data;
  const ps1 = r.paradas.find((p) => p.encargos.some((e) => e.id === s1.id)), ps2 = r.paradas.find((p) => p.encargos.some((e) => e.id === s2b.id));
  assert.notEqual(ps1.clave, ps2.clave, 'cada sucursal es su parada');
  assert.match(ps2.direccion, /San Martín/);
  // Lo que Logística sacó de la libreta no vuelve con la copia de la planilla.
  assert.equal((await api('PATCH', `/recorridos/libreta/${mad.lugar_id}`, { activo: false })).status, 200);
  await api('POST', '/cronograma/lugares/actualizar');
  assert.ok(!(await buscar(`dimilito ${RUN}`)).some((d) => d.lugar_id === mad.lugar_id), 'sigue afuera');
  assert.equal((await api('PATCH', `/recorridos/libreta/${mad.lugar_id}`, { activo: true })).status, 200);

  // ---------- El remito de traslado ----------
  const n1 = (await api('POST', `/recorridos/encargos/${e1.id}/remito`, {}, vera.email)).data.remito;
  const n3 = (await api('POST', `/recorridos/encargos/${e3.id}/remito`)).data.remito;
  assert.equal(n3, n1 + 1, 'los números siguen');
  assert.equal((await api('POST', `/recorridos/encargos/${e1.id}/remito`, {}, vera.email)).data.remito, n1, 'el mismo encargo, el mismo número');
  r = await api('GET', `/recorridos/encargos/${e1.id}/remito`, undefined, vera.email);
  assert.equal(r.status, 200);
  assert.match(r.data, new RegExp(String(n1).padStart(9, '0')));
  assert.match(r.data, /Muestras de termos/);
  assert.match(r.data, /Recibí conforme/);
  assert.equal((await api('GET', `/recorridos/encargos/${e3.id}/remito`, undefined, vera.email)).status, 403);

  // ---------- El historial de la planilla vieja ----------
  const cfg = (await api('GET', '/integrations/bocetos')).data;
  if (!cfg.cuenta_de_servicio) { t.diagnostic('wrangler dev sin GOOGLE_SA_JSON de prueba (node test/gmail-dev-vars.mjs): se saltea el historial'); return; }
  g = await googleFalso();
  const gonza = (await api('POST', '/users', { email: `gonza.rc.${RUN}@formas.ar`, name: `Gonzalo Rc ${RUN}`, profile: 'logistica', role: 'member' })).data;
  assert.equal((await api('POST', '/recorridos/historial', {}, vera.email)).status, 403, 'lo trae un administrador');
  r = await api('POST', '/recorridos/historial', { meses: 3, alias: { GONZA: gonza.id } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.filas, 11, 'las 8 de MAD, la copiada y las dos de ayer; la de hoy no');
  assert.equal(r.data.quienes.find((q) => q.nombre === `WANDA${RUN.toUpperCase()}`)?.user_id, wanda.id, 'reconoce a Wanda por el nombre');
  const antes = r.data.en_el_hub;
  r = await api('POST', '/recorridos/historial', { meses: 3 });
  assert.equal(r.data.en_el_hub, antes, 'volver a traerlo no duplica');
  // Qué días se suele ir a MAD: los jueves.
  r = await api('GET', `/recorridos/destino?lugar_id=${mad.lugar_id}`);
  assert.ok(r.data.habitual, JSON.stringify(r.data));
  assert.deepEqual(r.data.habitual.dias, [4]);
  assert.match(r.data.habitual.texto, /jueves/);
  assert.ok(r.data.dias.filter((d) => new Date(`${d.fecha}T12:00:00Z`).getUTCDay() === 4).every((d) => d.habitual));
  // Lo de la planilla es historial: no aparece en el cronograma.
  const ayer = dia(HOY, -1);
  const vieja = (await api('GET', `/cronograma?desde=${ayer}&hasta=${ayer}`)).data;
  assert.ok(!vieja.encargos.some((e) => e.destino === `CERAMICA ${RUN}`));
  // Y cuenta para los frecuentes de quien lo pidió.
  r = await api('GET', '/recorridos/sugerencias', undefined, wanda.email);
  assert.ok(r.data.frecuentes.some((d) => d.lugar_id === ceramica.lugar_id), JSON.stringify(r.data.frecuentes));
  const suyos = (await api('GET', `/recorridos/encargos?desde=${dia(HOY, -10)}&hasta=${HOY}`, undefined, wanda.email)).data.encargos;
  assert.ok(suyos.some((e) => e.estado === 'cancelado' && e.origen === 'planilla'), '«NO HABIA QUE IR» queda cancelado');
  const urgente = suyos.find((e) => e.destino === `CERAMICA ${RUN}`);
  assert.equal(urgente.urgente, true);
  assert.equal(urgente.desde, 'matienzo');
  assert.equal(urgente.horario, 'luego del mediodia');
});
