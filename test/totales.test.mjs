// Total sin IVA de los pedidos desde Finnegans (scripts/pedidos-totales.mjs y /hooks/pedidos/totales) y el pie de cada
// columna del tablero de pedidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalesPorPedido, clavePedido } from '../scripts/pedidos-totales.mjs';

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
