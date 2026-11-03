// Compras de clientes: el cálculo del estado (scripts/clientes.mjs, sin red) y la aplicación en las empresas (/hooks/clientes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcular, compraDePedido, cruzar, armarClientes, mepPorFecha } from '../scripts/clientes.mjs';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const HOY = '2026-11-03';
const c = (fecha, usd = 1000, vendedor = 'Eli') => ({ fecha, usd, vendedor, unidad: 'Formas Shop' });

test('estado del cliente con los umbrales del tablero', () => {
  assert.equal(calcular([c('2026-09-01')], HOY).estado_cliente, 'Nuevo', 'primera compra en los últimos 12 meses');
  assert.equal(calcular([c('2024-03-01'), c('2026-08-01')], HOY).estado_cliente, 'Recuperado', 'volvió después de más de 12 meses');
  assert.equal(calcular([c('2025-06-01'), c('2025-12-01'), c('2026-10-01')], HOY).estado_cliente, 'Activo');
  // Compra cada ~30 días y lleva 120 sin comprar: más de 90 y de 2,5 × 30.
  const seguido = ['2024-07-01', '2024-08-01', '2024-09-01', '2024-10-01', '2024-11-01', '2024-12-01', '2025-01-01', '2025-02-01', '2025-03-01',
    '2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01'].map((f) => c(f));
  assert.equal(calcular(seguido, '2025-10-29').estado_cliente, 'En riesgo');
  assert.equal(calcular(seguido, '2025-08-15').estado_cliente, 'Activo', 'todavía dentro de su ritmo');
  assert.equal(calcular([c('2025-06-01')], HOY).estado_cliente, 'Perdido', 'más de 12 meses sin comprar');
  assert.equal(calcular([c('2023-06-01')], HOY).estado_cliente, 'Dormido', 'más de 2 años');
  const r = calcular([c('2025-01-10', 1000, 'Lucia'), c('2026-02-01', 3000, 'Eli'), c('2026-05-01', -500, 'Eli')], HOY);
  assert.equal(r.cantidad_de_compras, 2, 'la nota de crédito no es una compra');
  assert.equal(r.compra_historica_usd, 3500);
  assert.equal(r.compra_12m_usd, 2500);
  assert.equal(r.ticket_promedio_usd, 1750);
  assert.equal(r.fecha_ultima_compra, '2026-02-01');
  assert.equal(r.vendedora_finnegans, 'Eli');
  assert.equal(calcular([c('2026-05-01', -100)], HOY), null, 'solo notas de crédito: sin compras');
});

test('qué pedidos cuentan como compra', () => {
  const linea = (extra) => ({ EMPRESA: 'EMPRE01', DOCNROINT: 'PEDVTAFP - 1', FECHA: '05-10-2026', CLIENTE: 'ACME SA', NRODEIDENTIFICACION: '30-71234567-1',
    VENDEDOR: 'Carmen Donoso', IMPORTE: 1000, TRANSACCONSUBTIPONOMBRE: 'Pedido de Venta - FP', ESTADO: 'Activa', ...extra });
  const p = compraDePedido([linea(), linea({ IMPORTE: 500, FECHA: '03-10-2026' })]);
  assert.deepEqual([p.fecha, p.importe, p.unidad, p.cuit], ['2026-10-03', 1500, 'Corporate', '30712345671']);
  assert.equal(compraDePedido([linea({ USRNUMOC: 'Beneficios al personal' })]), null);
  assert.equal(compraDePedido([linea({ CLIENTE: 'FORMAS PUBLICITARIAS S.A.' })]), null, 'ventas a Formas');
  assert.ok(compraDePedido([linea({ CLIENTE: 'FORMAS PUBLICITARIAS S.A.', DESCITEM: 'Pelotita antiestrés' })]), 'salvo los antiestrés');
  assert.equal(compraDePedido([linea({ TRANSACCONSUBTIPONOMBRE: 'Pedido de Venta - Meli' })]), null, 'Mercado Libre no tiene cliente');
  assert.equal(compraDePedido([linea({ TRANSACCONSUBTIPONOMBRE: 'OBJETIVOS DE VENTA' })]), null);
  assert.equal(compraDePedido([linea({ USRNUMOC: 'kit noestres' })]).unidad, 'NoEstres');
});

test('cruce con las empresas: código, CUIT o nombre único; el histórico solo antes de los pedidos', () => {
  const mep = mepPorFecha([{ fecha: '2020-01-01', venta: 80 }, { fecha: '2026-01-01', venta: 1500 }]);
  const pedidos = [{ fecha: '2026-03-01', importe: 1_500_000, cliente: 'ACME S.A.', cuit: '30712345671', vendedor: 'Eli', unidad: 'Formas Shop' },
    { fecha: '2026-04-01', importe: 300_000, cliente: 'Beta SRL', cuit: null, vendedor: 'Lucia', unidad: 'Formas Shop' }];
  const historico = [{ fecha: '2021-05-01', cuit: '30-71234567-1', cliente: 'ACME SOCIEDAD ANONIMA', tipo: 'Factura', neto: 80_000 },
    { fecha: '2026-03-01', cuit: '30-71234567-1', cliente: 'ACME S.A.', tipo: 'Factura', neto: 1_500_000 }];   // ya está como pedido
  const clientes = armarClientes({ pedidos, historico, mep, saldos: { porCuit: new Map([['30712345671', { saldo: 1210, vencido: 0 }]]) }, hoy: HOY });
  const acme = clientes.find((x) => x.cuit === '30712345671');
  assert.equal(acme.props.compra_historica_usd, 2000, '1.000 del pedido + 1.000 del histórico de 2021');
  assert.equal(acme.props.estado_cliente, 'Recuperado');
  assert.equal(acme.props.saldo_pendiente, 1210);
  const empresas = [{ id: 1, name: 'Acme', cuit: null, codigo: '77' }, { id: 2, name: 'Otra', cuit: '30-71234567-1' }, { id: 3, name: 'BETA S.R.L.' }, { id: 4, name: 'Nadie' }];
  const { updates, via } = cruzar(empresas, clientes, { codigoDe: new Map([['77', '30712345671']]) });
  assert.deepEqual(updates.map((u) => u.id), [1, 2, 3]);
  assert.deepEqual(via, { codigo: 1, cuit: 1, nombre: 1 });
  assert.equal(updates[0].completar.cuit, '30-71234567-1');
  assert.equal(updates[0].completar.codigo_de_finnegans, '77');
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('las compras se aplican en la empresa, completan lo que falta y se limpian', async () => {
  const tok = (await call('POST', '/tokens', { name: `Clientes ${RUN}`, source: 'api' })).data.token;
  const H = { authorization: `Bearer ${tok}` };
  assert.equal((await call('GET', '/hooks/clientes/empresas')).status, 401);
  const emp = (await call('POST', '/records/company', { props: { name: `Compradora ${RUN}`, razon_social: 'La que puso la vendedora' } })).data;
  const props = { estado_cliente: 'En riesgo', fecha_ultima_compra: '2026-07-01', compra_historica_usd: 12345, compra_12m_usd: 2000, ticket_promedio_usd: 1234, saldo_pendiente: 50000, saldo_vencido: 10000 };
  const r = (await call('POST', '/hooks/clientes/aplicar', { updates: [{ id: emp.id, props, completar: { cuit: '30-71234567-1', razon_social: 'COMPRADORA SA' } }], resumen: { cruzadas: 1 } }, H)).data;
  assert.deepEqual([r.actualizadas, r.completadas], [1, 1]);
  const got = (await call('GET', `/records/company/${emp.id}`)).data.record.props;
  assert.equal(got.estado_cliente, 'En riesgo');
  assert.equal(got.compra_historica_usd, 12345);
  assert.equal(got.cuit, '30-71234567-1', 'completa el CUIT que faltaba');
  assert.equal(got.razon_social, 'La que puso la vendedora', 'no pisa lo que ya estaba');
  assert.equal((await call('PATCH', `/records/company/${emp.id}`, { props: { estado_cliente: 'Activo' } })).data?.record?.props?.estado_cliente ?? 'En riesgo', 'En riesgo', 'es de solo lectura');
  assert.ok((await call('GET', '/hooks/clientes/empresas', undefined, H)).data.some((e) => e.id === emp.id && e.estado === 'En riesgo'));
  await call('POST', '/hooks/clientes/aplicar', { limpiar: [emp.id] }, H);
  assert.equal((await call('GET', `/records/company/${emp.id}`)).data.record.props.estado_cliente, undefined);
  assert.equal((await call('GET', '/hooks/clientes/estado', undefined, H)).data.cruzadas, 1);
});
