// Total sin IVA de los pedidos desde Finnegans (scripts/pedidos-totales.mjs y /hooks/pedidos/totales) y el pie de cada
// columna del tablero de pedidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalesPorPedido, clavePedido, filasDeSaldo, resumenPedidos, facturadosDe, porFacturarDe } from '../scripts/pedidos-totales.mjs';

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
  assert.deepEqual(f, [{ ie: 'FCVTAELECT - 2583', doc: 'FCVTAELECT - 2583', desc: '31089 / SIN OC', importe: 1210.5, vto: '20-11-2026' }]);
  assert.deepEqual(filasDeSaldo(null), []);
});

test('por facturar: todo si no tiene factura (ni directa ni por remito), y lo pendiente si se facturó en parte', () => {
  const r = (doc, neto, pend, total, extra = {}) => ({ DOCNROINT: doc, IMPORTEMONPRINCIPAL: neto, IMPORTEPENDIENTEDESTINO: pend, TOTAL: total, ESTADO: 'Activa', ...extra });
  const resumen = resumenPedidos([
    [r('PEDVTASTP - 00031277', 1000, 0, 1210), r('PEDVTAFP - 2413', 600, 0, 1452), r('PEDVTAFP - 2413', 600, 0, 1452), r('PEDVTAFP - 2414', 1000, 0, 1210),
      r('PEDVTAFP - 2415', 1000, 400, 1210), r('PEDVTAFP - 2416', 1000, 1000, 1210), r('PEDVTAFP - 2417', 1000, 0, 1210), r('PDVOBJETIVOS - 1', 9e9, 0, 9e9)],
    [r('PEDVTASTP - 31277', 5, 5, 5)],   // FP DEMO: el de Formas va primero
  ]);
  assert.deepEqual([...resumen.keys()].sort(), ['PEDVTAFP - 2413', 'PEDVTAFP - 2414', 'PEDVTAFP - 2415', 'PEDVTAFP - 2416', 'PEDVTAFP - 2417', 'PEDVTASTP - 31277']);
  const fact = facturadosDe([
    { TRANSACCIONSUBTIPOCODIGO: 'PEDVTASTP', IDENTIFICACIONEXTERNA: 'PEDVTASTP - 00031277' },
    { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 1979', DESCRIPCION: 'pdv 2414' },
    { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 1980', DESCRIPCION: 'PDV 2415' },
    { TRANSACCIONSUBTIPOCODIGO: 'FPREMVTA', IDENTIFICACIONEXTERNA: 'FPREMVTA - 1981', DESCRIPCION: '' },
  ]);
  assert.ok(fact.remitos.has('FPREMVTA - 1981'));
  // 2417: el remito facturado no dice el PDV, pero se encontró mirando los remitos del pedido.
  assert.deepEqual(porFacturarDe(resumen, fact, new Set(['PEDVTAFP - 2417'])), {
    'PEDVTASTP - 31277': 0, 'PEDVTAFP - 2413': 1452, 'PEDVTAFP - 2414': 0, 'PEDVTAFP - 2415': 484, 'PEDVTAFP - 2416': 1210, 'PEDVTAFP - 2417': 0,
  });
});

