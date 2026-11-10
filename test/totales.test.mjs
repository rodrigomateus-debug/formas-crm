// Total sin IVA de los pedidos desde Finnegans (scripts/pedidos-totales.mjs y /hooks/pedidos/totales) y el pie de cada
// columna del tablero de pedidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../scripts/pedidos-totales.mjs';
const { totalesPorPedido, clavePedido, filasDeSaldo } = T;

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('total sin IVA por pedido a partir de los renglones del informe', () => {
  const fila = (doc, imp, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: imp, ESTADO: 'Activa', ...extra });
  const t = totalesPorPedido([
    [fila('PEDVTASTP - 31277', 1000), fila('PEDVTASTP - 31277', 250.255), fila('PEDVTAFP - 12', 10), fila('PEDVTAFP - 12', 99, { ESTADO: 'Anulada' }), fila('PDVOBJETIVOS - 1', 5e8)],
    [fila('PEDVTASTP - 00031277', 7), fila('PEDVTANE - 84', 300)],
  ]);
  assert.deepEqual(t, { 'PEDVTASTP - 31277': 1250.26, 'PEDVTAFP - 12': 10, 'PEDVTANE - 84': 300 }, 'Formas primero, sin anulados ni objetivos');
  assert.equal(clavePedido('pedvtastp-00031277'), 'PEDVTASTP - 31277');
  assert.equal(clavePedido('29-10-2026'), null);
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
  const resumen = T.resumenPedidos([[
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
  ]]);
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
