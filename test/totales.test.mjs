// Total sin IVA de los pedidos desde Finnegans (scripts/pedidos-totales.mjs y /hooks/pedidos/totales) y el pie de cada
// columna del tablero de pedidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../scripts/pedidos-totales.mjs';
const { totalesPorPedido, clavePedido, filasDeSaldo, vendedoresPorPedido } = T;

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('total sin IVA por pedido a partir de los renglones del informe', () => {
  const fila = (doc, imp, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: imp, ESTADO: 'Activa', ...extra });
  const t = totalesPorPedido([
    { emp: 'EMPRE01', filas: [fila('PEDVTASTP - 31277', 1000), fila('PEDVTASTP - 31277', 250.255), fila('PEDVTAFP - 12', 10), fila('PEDVTAFP - 12', 99, { ESTADO: 'Anulada' }), fila('PDVOBJETIVOS - 1', 5e8)] },
    { emp: '7', filas: [fila('PEDVTASTP - 00031277', 7), fila('PEDVTANE - 84', 300)] },
  ]);
  assert.deepEqual(t, { 'PEDVTASTP - 31277': 1250.26, 'PEDVTAFP - 12': 10, 'DEMO PEDVTASTP - 31277': 7, 'DEMO PEDVTANE - 84': 300 },
    'sin anulados ni objetivos; los de FP DEMO aparte, aunque tengan el mismo número');
  assert.equal(clavePedido('pedvtastp-00031277'), 'PEDVTASTP - 31277');
  assert.equal(clavePedido('29-10-2026'), null);
});

test('el vendedor de cada pedido: el que más se repite en sus renglones, sin STP ni objetivos', () => {
  const fila = (doc, v) => ({ DOCNROINT: doc, VENDEDOR: v, ESTADO: 'Activa' });
  const v = vendedoresPorPedido([
    { emp: 'EMPRE01', filas: [fila('PEDVTAFP - 2402', 'SENINI, LUCIA'), fila('PEDVTAFP - 2402', 'SENINI, LUCIA'), fila('PEDVTAFP - 2402', 'Otro'), fila('PEDVTASTP - 9', 'STP'), fila('PDVOBJETIVOS - 1', 'X')] },
    { emp: '7', filas: [fila('PEDVTAFP - 00002402', 'Otra empresa'), fila('PEDVTANE - 5', ' Elizabeth Reynoso ')] },
  ]);
  assert.deepEqual(v, { 'PEDVTAFP - 2402': 'SENINI, LUCIA', 'DEMO PEDVTAFP - 2402': 'Otra empresa', 'DEMO PEDVTANE - 5': 'Elizabeth Reynoso' },
    'sin STP ni objetivos; los de FP DEMO aparte');
});

test('el hook de totales pide token de administrador y valida el cuerpo', async () => {
  assert.equal((await call('POST', '/hooks/pedidos/totales', { totales: {} })).status, 401, 'sin token no');
  const tok = (await call('POST', '/tokens', { name: `Totales ${RUN}`, source: 'api' })).data.token;
  const H = { authorization: `Bearer ${tok}` };
  assert.equal((await call('POST', '/hooks/pedidos/totales', { nada: 1 }, H)).status, 400);
  const r = (await call('POST', '/hooks/pedidos/totales', { totales: { 'PEDVTASTP - 1': 5, 'no es un pedido': 3 } }, H)).data;
  assert.equal(r.recibidos, 1, 'solo los números de pedido válidos');
  // Los pedidos con su número de Finnegans los crea la sincronización de ClickUp: la prueba de punta a punta está en
  // test/pedidos.test.mjs («total sin IVA de Finnegans…»).
});

test('al combinar el pedido de HubSpot con su PDV de Finnegans quedan el pedido de Finnegans y su fecha', async () => {
  const tok = (await call('POST', '/tokens', { name: `Combinar ${RUN}`, source: 'api' })).data.token;
  const H = { authorization: `Bearer ${tok}` };
  const n = 600000 + Math.floor(Math.random() * 99999);
  // El PDV entra por Finnegans (con su pedido, su fecha y la razón social, que son de solo lectura).
  const alta = (await call('POST', '/hooks/pedidos/totales', { totales: {}, pedidos: { [`PEDVTASTP - ${n}`]: { cliente: `Razón ${RUN}`, cuit: '30711111119', fecha: '2026-11-04' } } }, H)).data;
  assert.equal(alta.nuevos?.creados, 1, JSON.stringify(alta));
  const pdv = (await call('GET', `/records/order?q=${encodeURIComponent(`PDV ${n}`)}`)).data.results[0];
  // El que armó HubSpot al ganar el negocio, sin número de PDV.
  const hs = (await call('POST', '/records/order', { props: { hs_order_name: `Cliente ${RUN}` } })).data;
  const r = await call('POST', `/records/order/${hs.id}/merge`, { other_id: pdv.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data.props;
  assert.equal(p.pdv_finnegans, String(n));
  assert.equal(p.pedido_finnegans, `PEDVTASTP - ${n}`, 'el pedido de Finnegans (solo lectura) no se pierde');
  assert.equal(p.razon_social, `Razón ${RUN}`);
  assert.equal(p.fecha_pedido, '2026-11-04');
});

test('saldos: del informe de composición solo van los deudores, sin datos del cliente', () => {
  const f = filasDeSaldo([
    { CUENTA: 'Deudores en Cta. Cte.', IDENTIFICACIONEXTERNA: 'FCVTAELECT - 2583', DOCUMENTO: 'FCVTAELECT - 2583', DESCRIPCION: '31089 / SIN OC', IMPORTEMONPPAL: '1210.5', FECHAVTO: '20-11-2026', ORGANIZACION: 'CLIENTE SA', CUIT: '30-11111111-1' },
    { CUENTA: 'Proveedores', DOCUMENTO: 'FCCOMPRA - 1', IMPORTEMONPPAL: '-500' },
    { CUENTA: 'Deudores en Cta. Cte.', DOCUMENTO: 'FCVTAELECT - 1', IMPORTEMONPPAL: '0' },
  ]);
  assert.deepEqual(f, [{ emp: 'EMPRE01', ie: 'FCVTAELECT - 2583', doc: 'FCVTAELECT - 2583', desc: '31089 / SIN OC', importe: 1210.5, vto: '20-11-2026' }]);
  assert.deepEqual(filasDeSaldo(null), []);
});

test('el PDV de la descripción de una factura o un remito, como lo escriben', () => {
  for (const [d, n, ne] of [['31089', 31089, false], ['2407 / OC N°: 4400197895', 2407, false], ['PDV:36 NOESTRES', 36, true], ['PDV N° 31512 / OC: 1', 31512, false],
    ['PDV N°: 31512 - OC N°: 9', 31512, false], ['PDV NOESTRES N° 36', 36, true], ['pdv 31089', 31089, false], ['PDV 31224 / SIN OC', 31224, false]]) {
    assert.deepEqual(T.pdvDeDescripcion(d), { n, ne }, d);
  }
  assert.equal(T.pdvDeDescripcion('ROMI ML'), null);
  assert.equal(T.pdvDeDescripcion('PONCHO PAMPA'), null);
});

test('por facturar, sin IVA y al centavo: lo pendiente en Finnegans, los remitos de Corporate, los anticipos y las facturas', () => {
  const ped = (doc, neto, pend, total, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: neto, IMPORTEPENDIENTEDESTINO: pend, TOTAL: total, ESTADO: 'Activa', ...extra });
  const resumen = T.resumenPedidos([{ emp: 'EMPRE01', filas: [
    ped('PEDVTASTP - 00031277', 1000, 0, 1210),       // Formas Shop facturado (y su remito de entrega nunca se factura)
    ped('PEDVTASTP - 31278', 1000, 1000, 1210),       // Formas Shop sin facturar
    ped('PEDVTAFP - 2413', 600, 0, 1452), ped('PEDVTAFP - 2413', 600, 0, 1452),   // Corporate remitido, el remito sin facturar
    ped('PEDVTAFP - 2414', 1000, 400, 1210),          // Corporate: remitió 600 y los facturó; 400 sin remitir
    ped('PEDVTAFP - 2415', 5000, 5000, 6050),         // Corporate con anticipo de 2000 ya facturado
    ped('PEDVTAFP - 2416', 1000, 1000, 1210),         // Finnegans lo da pendiente, pero se facturó sin enlazar al pedido
    ped('PEDVTAFP - 2417', 1000, 0, 1210),            // facturado y después una nota de crédito por un descuento
    ped('PEDVTAFP - 2418', 1000, 1000, 1210, { ESTADO: 'Anulada' }),
    ped('PEDVTAFP - 2419', 3600, 0, 4356),            // facturado directo, anulado con nota y refacturado; un remito sin facturar
    ped('PDVOBJETIVOS - 1', 9e9, 9e9, 9e9),
  ] }]);
  assert.equal(resumen.get('PEDVTAFP - 2413').neto, 1200);
  assert.equal(resumen.has('PDVOBJETIVOS - 1'), false);
  const fac = (doc, neto, total, desc, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: neto, TOTAL: total, DESCRIPCION: desc, ESTADO: 'Activa', IDENTIFICACIONEXTERNA: doc, ...extra });
  const docs = T.docsDeFacturas([{ emp: 'EMPRE01', filas: [
    fac('FCVTAELECT - 1', 1000, 1245, '31277', { IDENTIFICACIONEXTERNA: 'FC PEDVTASTP-00031277 1' }),
    fac('FCVTAELECT - 2', 600, 726, 'pdv 2414', { IDENTIFICACIONEXTERNA: 'FC FPREMVTA-1979 1' }),
    fac('FACTVENANTMASIVO - 3', 2000, 2420, '2415', { PRODUCTO: 'ANTICIPO FINANCIERO' }),
    fac('FCVTAELECT - 4', 1000, 1210, 'PDV N° 2416 / OC: 7'),
    fac('FCVTAELECT - 5', 1000, 1210, '2417'),
    fac('NCVEE - 6', -100, -121, '2417'),
    fac('FCVTAELECT - 7', 300, 363, 'ROMI ML'),
    fac('NCVEE - 8', -1000, -1210, 'NC ANULA FC 4', { IDENTIFICACIONEXTERNA: 'NC FCVTAELECT-4 1' }),
    fac('FCVTAELECT - 9', 1000, 1210, '2416'),
    fac('FCVTAELECT - 10', 3080, 3727, '2419 / OC: 1180/2026', { IDENTIFICACIONEXTERNA: 'FC PEDVTAFP-00002419 1' }),
    fac('NCVEE - 11', -3080, -3727, '2419 / OC: 1180/2026'),
    fac('FCVTAELECT - 12', 3080, 3727, '2419 / OC: 1180/2026'),
  ] }]);
  assert.equal(docs.get('EMPRE01|FACTVENANTMASIVO - 3').anticipo, 2000);
  const orig = T.origenesDe([{ emp: 'EMPRE01', filas: [
    { TRANSACCIONSUBTIPOCODIGO: 'PEDVTASTP', IDENTIFICACIONEXTERNA: 'PEDVTASTP - 00031277', IDENTIFICACIONEXTERNAFACT: 'FC PEDVTASTP-00031277 1' },
    { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 1979', IDENTIFICACIONEXTERNAFACT: 'FC FPREMVTA-1979 1', DESCRIPCION: '' },
  ] }, { emp: '7', filas: [
    // FP DEMO numera igual: su FCVTAELECT - 5 sale de otro pedido y no tiene que pisar a la de Formas.
    { TRANSACCIONSUBTIPOCODIGO: 'PEDVTAFP', IDENTIFICACIONEXTERNA: 'PEDVTAFP - 00000099', IDENTIFICACIONEXTERNAFACT: 'FCVTAELECT - 5' },
  ] }, { emp: 'EMPRE01', filas: [
    // La FCVTAELECT - 9 sale de dos documentos: un pedido ajeno y un remito del 2416, que es lo que dice la factura.
    { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 1990', IDENTIFICACIONEXTERNAFACT: 'FCVTAELECT - 9', DESCRIPCION: 'pdv 2416' },
    { TRANSACCIONSUBTIPOCODIGO: 'PEDVTAFP', IDENTIFICACIONEXTERNA: 'PEDVTAFP - 00002413', IDENTIFICACIONEXTERNAFACT: 'FCVTAELECT - 9' },
  ] }]);
  // El remito facturado no dice el PDV: se encontró buscando los remitos del pedido.
  const asignadas = T.asignarFacturas(docs, orig, resumen, new Map([['FPREMVTA - 1979', 'PEDVTAFP - 2414']]));
  assert.deepEqual(Object.fromEntries([...asignadas].map(([k, v]) => [k.split('|')[1], v])), {
    'FCVTAELECT - 1': 'PEDVTASTP - 31277', 'FCVTAELECT - 2': 'PEDVTAFP - 2414', 'FACTVENANTMASIVO - 3': 'PEDVTAFP - 2415', 'FCVTAELECT - 4': 'PEDVTAFP - 2416',
    'FCVTAELECT - 5': 'PEDVTAFP - 2417', 'NCVEE - 6': 'PEDVTAFP - 2417', 'FCVTAELECT - 7': null, 'NCVEE - 8': 'PEDVTAFP - 2416', 'FCVTAELECT - 9': 'PEDVTAFP - 2416',
    'FCVTAELECT - 10': 'PEDVTAFP - 2419', 'NCVEE - 11': 'PEDVTAFP - 2419', 'FCVTAELECT - 12': 'PEDVTAFP - 2419',
  });
  const remitos = T.remitosPendientes([{ emp: 'EMPRE01', filas: [
    { DOCNROINT: 'FPREMVTA - 2001', IMPORTEPENDIENTEDESTINO: 1200, DESCRIPCION: 'pdv 2413', ESTADO: 'Activa' },
    { DOCNROINT: 'FPREMVTA - 2002', IMPORTEPENDIENTEDESTINO: 1000, DESCRIPCION: 'pdv 31277', ESTADO: 'Activa' },   // de Formas Shop: no cuenta
    { DOCNROINT: 'FPREMVTA - 2003', IMPORTEPENDIENTEDESTINO: 50, DESCRIPCION: '', ESTADO: 'Activa' },
    { DOCNROINT: 'FPREMVTA - 2004', IMPORTEPENDIENTEDESTINO: 520, DESCRIPCION: 'pdv 2419', ESTADO: 'Activa' },
  ] }]);
  const pend = T.pendientePorRemitos(remitos, resumen);
  assert.deepEqual([...pend.porPedido], [['PEDVTAFP - 2413', 1200], ['PEDVTAFP - 2419', 520]]);
  assert.deepEqual(pend.sinPedido.map((r) => r.doc), ['FPREMVTA - 2002', 'FPREMVTA - 2003']);
  const anticipos = T.anticiposDe(docs, asignadas);
  assert.deepEqual([...anticipos], [['PEDVTAFP - 2415', 2000]]);
  assert.deepEqual(T.porFacturarDe(resumen, pend.porPedido, anticipos, T.netoFacturado(docs, asignadas)), {
    'PEDVTASTP - 31277': 0, 'PEDVTASTP - 31278': 1000, 'PEDVTAFP - 2413': 1200, 'PEDVTAFP - 2414': 400, 'PEDVTAFP - 2415': 3000,
    'PEDVTAFP - 2416': 0, 'PEDVTAFP - 2417': 0, 'PEDVTAFP - 2418': 0, 'PEDVTAFP - 2419': 520,
  });
  // Para el CRM: cada comprobante con su pedido y su total/neto exacto.
  const crm = T.facturasParaCrm(docs, asignadas);
  assert.deepEqual(crm['EMPRE01|FCVTAELECT - 1'], { pedido: 'PEDVTASTP - 31277', factor: 1.245 });
  assert.deepEqual(crm['EMPRE01|FCVTAELECT - 7'], { pedido: null, factor: 1.21 });
});

// FP DEMO (la empresa de pruebas, '7') numera igual que Formas y tiene copias de pedidos de verdad con el mismo número
// (PDV 31748, 31544…). Todo lo suyo viaja con «DEMO » adelante, como el pedido de Finnegans de sus pedidos en el CRM.
test('FP DEMO va aparte: con el mismo número que un pedido de Formas, nada se cruza con el de verdad', () => {
  const ped = (doc, neto, pend, total, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: neto, IMPORTEPENDIENTEDESTINO: pend, TOTAL: total, ESTADO: 'Activa',
    FECHA: '05-11-2026', VENDEDOR: 'SENINI, LUCIA', ...extra });
  const pedidos = [
    { emp: 'EMPRE01', filas: [ped('PEDVTASTP - 31748', 1000, 1000, 1210), ped('PEDVTAFP - 2500', 2000, 0, 2420), ped('PEDVTASTP - 31749', 400, 400, 484)] },
    // Copias de pedidos de Formas con el mismo número y uno (31800) que en Formas no existe.
    { emp: '7', filas: [ped('PEDVTASTP - 00031748', 300, 300, 363, { FECHA: '01-11-2026', VENDEDOR: 'Otra' }), ped('PEDVTAFP - 2500', 900, 0, 1089),
      ped('PEDVTASTP - 31800', 50, 50, 60.5)] },
  ];
  assert.deepEqual(T.totalesPorPedido(pedidos), { 'PEDVTASTP - 31748': 1000, 'PEDVTAFP - 2500': 2000, 'PEDVTASTP - 31749': 400,
    'DEMO PEDVTASTP - 31748': 300, 'DEMO PEDVTAFP - 2500': 900, 'DEMO PEDVTASTP - 31800': 50 });
  const vend = T.vendedoresPorPedido(pedidos);
  assert.deepEqual([vend['PEDVTASTP - 31748'], vend['DEMO PEDVTASTP - 31748']], ['SENINI, LUCIA', 'Otra']);
  const fechas = T.fechasPorPedido(pedidos);
  assert.deepEqual([fechas['PEDVTASTP - 31748'], fechas['DEMO PEDVTASTP - 31748'], fechas['PEDVTASTP - 31800']], ['2026-11-05', '2026-11-01', undefined]);
  const resumen = T.resumenPedidos(pedidos);
  assert.deepEqual([resumen.get('PEDVTASTP - 31748').neto, resumen.get('DEMO PEDVTASTP - 31748').neto], [1000, 300]);
  assert.equal(resumen.has('PEDVTASTP - 31800'), false);

  // Facturas: la misma numeración en las dos empresas (hay una FCVTAELECT - 100 en cada una).
  const fac = (doc, neto, total, desc, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: neto, TOTAL: total, DESCRIPCION: desc, ESTADO: 'Activa', IDENTIFICACIONEXTERNA: doc, ...extra });
  const docs = T.docsDeFacturas([
    { emp: 'EMPRE01', filas: [
      fac('FCVTAELECT - 100', 1000, 1210, '31748'),
      fac('FCVTAELECT - 101', 1500, 1815, '', { IDENTIFICACIONEXTERNA: 'FC FPREMVTA-50 1' }),   // de un remito que no dice el PDV
    ] },
    { emp: '7', filas: [
      fac('FCVTAELECT - 100', 300, 363, '31748'),                                                       // por el PDV de la descripción
      fac('FCVTAELECT - 101', 500, 605, 'texto', { IDENTIFICACIONEXTERNA: 'FC PEDVTAFP-00002500 1' }),   // por su identificación
      fac('FCVTAELECT - 102', 400, 484, '31749'),                                                       // el 31749 es solo de Formas: no es de nadie
      fac('FCVTAELECT - 103', 50, 60.5, 'otro texto'),                                                  // por el pedido del que sale
      fac('FCVTAELECT - 104', 10, 12.1, '', { IDENTIFICACIONEXTERNA: 'FC FPREMVTA-50 1' }),              // el remito de Formas con ese número no es suyo
      fac('NCVEE - 7', -100, -121, 'NC ANULA FC 100', { IDENTIFICACIONEXTERNA: 'NC FCVTAELECT-100 1' }),
    ] },
  ]);
  const remito = { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 50', IDENTIFICACIONEXTERNAFACT: 'FC FPREMVTA-50 1', DESCRIPCION: '' };
  const orig = T.origenesDe([{ emp: 'EMPRE01', filas: [remito] }, { emp: '7', filas: [remito,
    { TRANSACCIONSUBTIPOCODIGO: 'PEDVTASTP', IDENTIFICACIONEXTERNA: 'PEDVTASTP - 00031800', IDENTIFICACIONEXTERNAFACT: 'FCVTAELECT - 103' }] }]);
  assert.equal(orig.get('7|FCVTAELECT - 103')[0].pedido, 'DEMO PEDVTASTP - 31800');
  // El FPREMVTA - 50 se encontró buscando los remitos de los pedidos de Formas: solo vale para Formas.
  const remitoAPedido = new Map([['FPREMVTA - 50', 'PEDVTAFP - 2500']]);
  const asignadas = T.asignarFacturas(docs, orig, resumen, remitoAPedido);
  assert.deepEqual(Object.fromEntries(asignadas), {
    'EMPRE01|FCVTAELECT - 100': 'PEDVTASTP - 31748', 'EMPRE01|FCVTAELECT - 101': 'PEDVTAFP - 2500',
    '7|FCVTAELECT - 100': 'DEMO PEDVTASTP - 31748', '7|FCVTAELECT - 101': 'DEMO PEDVTAFP - 2500', '7|FCVTAELECT - 102': null,
    '7|FCVTAELECT - 103': 'DEMO PEDVTASTP - 31800', '7|FCVTAELECT - 104': null, '7|NCVEE - 7': 'DEMO PEDVTASTP - 31748',
  });

  // Remitos de Corporate sin facturar: cada uno al pedido de su empresa.
  const remitos = T.remitosPendientes([
    { emp: 'EMPRE01', filas: [{ DOCNROINT: 'FPREMVTA - 60', IMPORTEPENDIENTEDESTINO: 100, DESCRIPCION: 'pdv 2500', ESTADO: 'Activa' }] },
    { emp: '7', filas: [{ DOCNROINT: 'FPREMVTA - 60', IMPORTEPENDIENTEDESTINO: 30, DESCRIPCION: 'pdv 2500', ESTADO: 'Activa' },
      { DOCNROINT: 'FPREMVTA - 50', IMPORTEPENDIENTEDESTINO: 5, DESCRIPCION: '', ESTADO: 'Activa' }] },
  ]);
  const pend = T.pendientePorRemitos(remitos, resumen, remitoAPedido);
  assert.deepEqual([...pend.porPedido], [['PEDVTAFP - 2500', 100], ['DEMO PEDVTAFP - 2500', 30]]);
  assert.deepEqual(pend.sinPedido.map((r) => `${r.emp}|${r.doc}`), ['7|FPREMVTA - 50']);

  // Por facturar: el 31749 de Formas no se da por facturado con la factura de FP DEMO.
  assert.deepEqual(T.porFacturarDe(resumen, pend.porPedido, T.anticiposDe(docs, asignadas), T.netoFacturado(docs, asignadas)), {
    'PEDVTASTP - 31748': 0, 'PEDVTAFP - 2500': 100, 'PEDVTASTP - 31749': 400,
    'DEMO PEDVTASTP - 31748': 100, 'DEMO PEDVTAFP - 2500': 30, 'DEMO PEDVTASTP - 31800': 0,
  });
  const crm = T.facturasParaCrm(docs, asignadas);
  assert.deepEqual(crm['EMPRE01|FCVTAELECT - 100'], { pedido: 'PEDVTASTP - 31748', factor: 1.21 });
  assert.deepEqual(crm['7|FCVTAELECT - 100'], { pedido: 'DEMO PEDVTASTP - 31748', factor: 1.21 });
  assert.deepEqual(crm['7|FCVTAELECT - 102'], { pedido: null, factor: 1.21 });
  const factores = T.factoresDe(resumen);
  assert.deepEqual([factores['PEDVTASTP - 31748'], factores['DEMO PEDVTASTP - 31800'], factores['PEDVTASTP - 31800']], [1.21, 1.21, undefined]);
  // Los pedidos nuevos y los anulados ya iban así (src/worker/pedidosfin.ts).
  assert.deepEqual(Object.keys(T.pedidosNuevos(pedidos[1].filas, '2026-10-01', 'DEMO ')), ['DEMO PEDVTASTP - 31748', 'DEMO PEDVTAFP - 2500', 'DEMO PEDVTASTP - 31800']);
  // Las filas del informe de saldos dicen de qué empresa son.
  assert.deepEqual(T.filasDeSaldo([{ CUENTA: 'Deudores en Cta. Cte.', EMPRESA: 'FP DEMO', DOCUMENTO: 'FCVTAELECT - 100', IMPORTEMONPPAL: '363' }]).map((f) => f.emp), ['7']);
});
