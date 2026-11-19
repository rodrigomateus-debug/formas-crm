// Cronograma (cronograma.ts): los movimientos de la semana salen de las fechas de ClickUp; moverlos y marcarlos escribe
// en ClickUp; la ruta del día con sus direcciones. ClickUp, Finnegans, Claude y el buscador de direcciones, simulados
// (puerto 8797; ver .dev.vars.example).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const PDV = String(60000 + Math.floor(Math.random() * 20000));
const PDV_V = String(Number(PDV) + 1);   // un pedido viejo del mismo cliente, ya entregado en otra dirección
const CLIENTE = `Nestle ${RUN} S.A.`;
// El recorrido del chofer es siempre el de hoy (Buenos Aires).
const HOY = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
let asUser = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(asUser ? { 'x-dev-user': asUser } : {}) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

const F = {
  entrega: '10e3d8d0-bbd5-47af-946b-504ef9804428', ingresoProv: '98df51eb-1142-4ff5-b80c-9fd239ea3aac', retiroProv: '7fd568b7-9cfd-45fc-9f05-22864a0b9e9a',
  egresoImp: 'c278fabb-b558-4a28-a6f6-f6b26a8e29eb', retiroImp: '3146d848-4952-4ac8-aac4-971e1361609b', ingresoImp: '3806fa77-1c1c-46d3-b631-0168b139de9d', proveedor: 'fd7010e7-cece-4d06-850a-ce5e948c1f83',
  impresor: '555918b9-e727-4f89-aa67-b97a94dd6136', cantidad: 'eb9f3a13-3f31-4a2f-b924-3cfaec8d376f', unidad: '8dcf7531-1dad-45f5-aff3-bb9e45895c98',
};
const CAMPO = { [F.entrega]: 'entrega', [F.ingresoProv]: 'ingresoProv', [F.retiroProv]: 'retiroProv', [F.egresoImp]: 'egresoImp', [F.retiroImp]: 'retiroImp', [F.ingresoImp]: 'ingresoImp' };
const OP_PROV = [{ id: `prov-zecat-${RUN}`, name: `ZECAT ${RUN}`, orderindex: 0 }];
const OP_IMP = [{ id: `imp-imprefas-${RUN}`, name: `IMPREFAS ${RUN}`, orderindex: 0 }];
const OP_UNIDAD = [{ id: 'u-shop', name: 'FORMAS SHOP', orderindex: 0 }, { id: 'u-corp', name: 'CORPORATE', orderindex: 1 }];
const dd = (id, name, value, options) => ({ id, name, type: 'drop_down', value, type_config: { options } });
const fecha = (id, name, dia) => ({ id, name, type: 'date', value: dia ? String(Date.parse(`${dia}T15:00:00Z`)) : null });

// Corporate: producción todavía lo trabaja en ClickUp, pero el cronograma lo mueve igual.
const ARTS = {
  [`cr${RUN}`]: [
    { nombre: `Termo ${RUN}`, cantidad: 100, status: 'pedido al proveedor', proveedor: OP_PROV[0].id, impresor: OP_IMP[0].id,
      ingresoProv: '2026-11-16', egresoImp: '2026-11-17', retiroImp: '2026-11-18', entrega: '2026-11-18' },
    { nombre: `Mochila ${RUN}`, cantidad: 50, status: 'pedido al proveedor', proveedor: OP_PROV[0].id, retiroProv: '2026-11-17', entrega: null },
    // Para la app del chofer: un retiro de hoy, ya «en el impresor» (marcar su ingreso viejo no lo tiene que volver atrás).
    { nombre: `Gorra ${RUN}`, cantidad: 20, status: 'en el impresor', proveedor: OP_PROV[0].id, impresor: OP_IMP[0].id, ingresoProv: '2026-10-05', retiroImp: HOY, entrega: '2027-03-01' },
    // El impresor trae la bolsa al depósito (INGRESO (IMPRESOR)): no hay que ir a buscarla.
    { nombre: `Bolsa ${RUN}`, cantidad: 30, status: 'en el impresor', impresor: OP_IMP[0].id, egresoImp: '2026-10-07', ingresoImp: '2026-11-25', entrega: '2027-03-02' },
    // Lista para entregar el 24/11: el remito en Finnegans la pasa a «Remitido» (estados de despacho).
    { nombre: `Caja ${RUN}`, cantidad: 40, status: 'listo para entergar', proveedor: OP_PROV[0].id, entrega: '2026-11-24' },
  ],
  [`cv${RUN}`]: [{ nombre: `Lapicera ${RUN}`, cantidad: 10, status: 'entregados', entrega: '2026-10-20' }],
};
const estado = {};      // lo que el CRM cambió en ClickUp, por tarea
const escrito = [];
function articulo(pdvId, i, a) {
  const id = `${pdvId}-a${i}`, e = estado[id] ?? {};
  const f = (k) => (e[k] !== undefined ? e[k] : a[k] ?? null);
  return {
    id, name: `${a.nombre} - Proveedor`, parent: pdvId, url: `https://app.clickup.com/t/${id}`, date_updated: String(e.updated ?? 1), orderindex: String(i),
    status: { status: e.status ?? a.status }, assignees: [], tags: [], text_content: `Producto: ${a.nombre}\nCantidad: ${a.cantidad}`,
    custom_fields: [dd(F.unidad, 'UNIDAD DE NEGOCIO', 'u-corp', OP_UNIDAD), { id: F.cantidad, name: 'CANTIDAD ', type: 'number', value: String(a.cantidad) },
      dd(F.proveedor, 'PROVEEDOR', a.proveedor ?? null, OP_PROV), dd(F.impresor, 'IMPRESOR', a.impresor ?? null, OP_IMP),
      fecha(F.entrega, 'ENTREGAS (FECHA REAL)', f('entrega')), fecha(F.ingresoProv, 'INGRESO (PROVEEDOR)', f('ingresoProv')), fecha(F.retiroProv, 'RETIROS (PROVEEDOR)', f('retiroProv')),
      fecha(F.egresoImp, 'EGRESO (IMPRESOR)', f('egresoImp')), fecha(F.retiroImp, 'RETIRO (IMPRESOR)', f('retiroImp')), fecha(F.ingresoImp, 'INGRESO (IMPRESOR)', f('ingresoImp'))],
  };
}
function pdvTask(id, npdv, entrega) {
  const e = estado[id] ?? {};
  return {
    id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: String(e.updated ?? 1), status: { status: 'pdv' }, assignees: [], tags: [],
    text_content: `Pedido: PEDVTASTP - ${npdv}\nCliente: ${CLIENTE}\nVendedor: Rodrigo Mateus\nEs evento: Sí\nFecha entrega: 25-11-2026`,
    custom_fields: [{ id: 'c0ead31a-5a3e-4a89-b666-f2d282a6f921', name: 'N° PDV', type: 'short_text', value: `PDV - ${npdv}` },
      { id: '55db0f4f-7ab0-4b56-8bde-417e31f44c88', name: 'CLIENTE', type: 'short_text', value: CLIENTE },
      dd(F.unidad, 'UNIDAD DE NEGOCIO', 'u-corp', OP_UNIDAD), fecha(F.entrega, 'ENTREGAS (FECHA REAL)', e.entrega !== undefined ? e.entrega : entrega)],
    subtasks: ARTS[id].map((a, i) => articulo(id, i, a)),
  };
}
const PDVS = () => [pdvTask(`cr${RUN}`, PDV, '2026-11-19'), pdvTask(`cv${RUN}`, PDV_V, '2026-10-20')];
const ESTADOS = ['ingreso de pedido', 'pdv', 'pedido al proveedor', 'en control de depósito', 'en el impresor', 'en revision', 'listo para entergar', 'anulado', 'entregados'];
// Los colores de la lista real: los estados quedan guardados un día y los usan las otras pruebas.
const COLOR = { 'ingreso de pedido': 'var(--cu-status-red)', pdv: '#a18072', 'en revision': '#0f9d9f', 'en el impresor': '#ffc53d', 'listo para entergar': '#008844', anulado: '#8d8d8d', entregados: '#008844' };
// La entrega pactada que dice Finnegans para el pedido (la prueba del final la cambia).
let pactadaFinnegans = null;
let consultasClaude = 0, consultasGeo = 0;
// El remito del pedido en Finnegans (estados de despacho): la prueba lo «hace» a mitad de camino.
let remitoHecho = false, consultasRemito = 0;

let server;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    let body = '';
    req.on('data', (ch) => { body += ch; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      if (p === '/anthropic/v1/messages') {
        const contenido = json.messages[0].content;
        let l;
        if (typeof contenido === 'string') {
          // La revisión de la dirección: el pedido dice Libertador y las últimas entregas fueron a Sarandí.
          consultasClaude++;
          assert.ok(contenido.includes(`Libertador ${PDV}`));
          assert.ok(contenido.includes(`Nicaragua ${PDV_V}`));
          l = { mismo_lugar: false, direccion_sugerida: `Nicaragua ${PDV_V}, Sarandí, Avellaneda`, motivo: `Las últimas entregas fueron a Nicaragua ${PDV_V}, Sarandí.` };
        } else {
          l = { es_remito: true, legible: true, problemas_foto: [], repetir_foto: false, motivo_repetir: null, fecha: '2026-10-20', direccion_entrega: `Nicaragua ${PDV_V}, Sarandí`,
            orden_compra: null, bultos: 1, firmado: true, sello_recepcion: null, fecha_recepcion: '2026-10-20', aclaracion_firma: null, recibido_con_reservas: false, notas: null,
            otros_remitos_en_foto: false, dudas: [], numero_remito: `R-0001-000${PDV_V}`, pdv_pedido_web: PDV_V, pdv_observaciones: PDV_V, cliente: CLIENTE, cuit_cliente: null,
            items: [{ codigo: null, descripcion: `Lapicera ${RUN}`, cantidad: 10, cantidad_texto: '10.00' }] };
        }
        return send({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(l) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } });
      }
      // La planilla de la libreta de direcciones, publicada como CSV (con comillas, comas y un salto de línea adentro).
      if (p === '/lugares.csv') {
        res.setHeader('content-type', 'text/csv');
        return res.end(['PROVEEDOR,DIRECCION,H. ATENCION,TELEFONO,LOCALIDAD,ZONA,CONTACTO 1,CONTACTO 2,OBSERVACIONES,Datps Coordinación,Datos de Entrega',
          `ZECAT ${RUN} (DEPOSITO),JOSE INGENIEROS ${PDV},9 A 17,11-5555-0000,RICARDO ROJAS ,NORTE,NATALIA,,"Tocar el timbre del ""portón"" gris, al fondo",,`,
          `Nestle ${RUN} SARANDI," Nicaragua ${PDV_V}, CP:1872",8 a 12,,SARANDI,SUR,,,,"Pedir turno por mail.\nVa palletizado",ACTUALIZADO`,
          `IMPREFAS ${RUN},CALLE 23 Y DIAGONAL 78,,,SAN ANDRES,NORTE,,,,,`,
          ',,,,,,,,,,'].join('\r\n'));
      }
      if (p === '/geo') {
        consultasGeo++;
        const q = url.searchParams.get('q') ?? '';
        assert.ok(!/unidad 180/i.test(q), 'la unidad no va al buscador');
        if (/Roca 4250/.test(q)) return send([{ lat: '-34.5361', lon: '-58.5152' }]);
        if (/Matienzo 1308/.test(q)) return send([{ lat: '-34.5345', lon: '-58.5170' }]);
        if (q.includes(`Libertador ${PDV}`)) return send([{ lat: '-34.5270', lon: '-58.4760' }]);
        if (q.includes(`Nicaragua ${PDV_V}`)) return send([{ lat: '-34.6790', lon: '-58.3460' }]);
        if (q.includes(`JOSE INGENIEROS ${PDV}`)) return send([{ lat: '-34.5140', lon: '-58.4970' }]);
        if (q.includes(`Cnel. Sayos ${PDV}`)) return send([{ lat: '-34.6990', lon: '-58.3930' }]);
        return send([]);
      }
      const tarea = p.match(/^\/clickup\/task\/([^/]+)/)?.[1];
      if (tarea && req.method !== 'GET') {
        escrito.push({ method: req.method, task: tarea, path: p, body: json });
        const e = (estado[tarea] ??= {});
        e.updated = Date.now();
        if (json?.status) e.status = json.status;
        const campo = CAMPO[p.split('/field/')[1]];
        if (campo) e[campo] = req.method === 'DELETE' ? null : new Date(json.value - 3 * 3600_000).toISOString().slice(0, 10);
        return send({});
      }
      if (p === '/clickup/list/901326159292') return send({ statuses: ESTADOS.map((status) => ({ status, color: COLOR[status] ?? '#1090e0', type: status === 'entregados' ? 'closed' : 'custom' })) });
      if (p === '/clickup/list/901326159292/task') return send({ tasks: PDVS().flatMap((t) => [t, ...t.subtasks]), last_page: true });
      if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') {
        const ie = url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen') ?? '';
        if (!ie.includes(String(Number(PDV)).padStart(8, '0'))) return send([]);
        consultasRemito++;
        return send(remitoHecho ? [{ TIPODOCUMENTO: 'REMVTA', CATEGORIATIPODOCUMENTO: -9, DESTINONOMBRE: `FPREMVTA - 000${PDV}`, DESTINOIDENTIFICACIONEXTERNA: `REM-${PDV}`,
          DESTINOFECHA: '2026-11-19T00:00:00', DESTINOTRANSACCIONID: 1, DESTINOIMPORTETOTAL: 0, OBTUVOCAE: 'NO' }] : []);
      }
      if (p === '/fin/oauth/token') { res.setHeader('content-type', 'application/json'); return res.end('"token-de-prueba"'); }
      if (p.startsWith('/fin/pedidoVenta/')) return send({ Cliente: `C-${RUN}`, Items: [], ...(pactadaFinnegans && !p.includes(PDV_V) ? { FechaEntrega: pactadaFinnegans } : {}), DireccionEntrega: p.includes(PDV_V) ? `Nicaragua ${PDV_V}, Sarandí` : `Av. Libertador ${PDV} Piso 4, Vicente López` });
      if (p.startsWith('/fin/cliente/')) return send({ RazonSocial: CLIENTE });
      const t = PDVS().find((x) => x.id === tarea);
      if (t) return send(t);
      return send({ err: 'no' }, 404);
    });
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server?.close());

const sync = () => api('POST', '/integrations/clickup/sync', { full: true });
const semana = async () => (await api('GET', '/cronograma?desde=2026-11-16&hasta=2026-11-22&rd=2026-10-12&rh=2026-12-20')).data;
const mov = (v, tipo, articulo) => v.movimientos.find((m) => m.tipo === tipo && m.articulo.startsWith(articulo) && m.npdv === PDV);
const T = `cr${RUN}-a0`, M = `cr${RUN}-a1`, B = `cr${RUN}-a3`;

test('cronograma: los movimientos salen de las fechas de ClickUp, con sus avisos', async (t) => {
  asUser = null;
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }
  await sync(); await sync();
  const v = await semana();
  assert.equal(v.puede_editar, true);
  const propios = v.movimientos.filter((m) => m.npdv === PDV && !m.articulo.startsWith('Gorra') && !m.articulo.startsWith('Bolsa'));
  assert.deepEqual(propios.map((m) => `${m.fecha} ${m.tipo}`).sort(), [
    '2026-11-16 ingreso', '2026-11-17 egreso', '2026-11-17 retiro_proveedor', '2026-11-18 entrega', '2026-11-18 retiro_impresor', '2026-11-19 entrega']);
  const ing = mov(v, 'ingreso', 'Termo');
  assert.equal(ing.cantidad, 100);
  assert.equal(ing.unidad, 'CORPORATE');
  assert.equal(ing.cliente, CLIENTE);
  assert.match(ing.lugar, /ZECAT/, 'el ingreso es del proveedor');
  assert.ok(ing.company_id, 'atado a la empresa del proveedor');
  assert.match(mov(v, 'egreso', 'Termo').lugar, /IMPREFAS/, 'el egreso va al impresor');
  assert.equal(ing.evento, true, 'el pedido es para un evento');
  assert.equal(ing.hecho, false);
  // El termo se retira del impresor y se entrega el mismo día; la mochila no tiene fecha propia: usa la del PDV.
  assert.deepEqual(mov(v, 'entrega', 'Termo').avisos, ['Se retira y se entrega el mismo día']);
  assert.equal(mov(v, 'entrega', 'Mochila').fecha, '2026-11-19');
  assert.deepEqual(mov(v, 'entrega', 'Mochila').avisos, []);
  // La barra de semanas: cuánto hay y cuánto falta cada día; lo entregado en octubre cuenta como hecho.
  assert.ok(v.dias['2026-11-17'].total >= 2 && v.dias['2026-11-17'].pendientes >= 2);
  assert.ok(v.dias['2026-10-20'].total >= 1);
  const viejo = (await api('GET', '/cronograma?desde=2026-10-19&hasta=2026-10-25')).data.movimientos.find((m) => m.npdv === PDV_V);
  assert.equal(viejo.hecho, true, 'un artículo entregado es una entrega hecha');
});

test('cronograma: estados de despacho, con lo que falta y a quién le toca', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  let v = await semana();
  // El termo se entrega el 18/11, pero el ingreso de ZECAT del 16/11 no se marcó y el artículo sigue «pedido al proveedor».
  const ent = mov(v, 'entrega', 'Termo').despacho;
  assert.equal(ent.estado, 'nollego');
  assert.equal(ent.quien, 'proveedor');
  assert.match(ent.lugar, /ZECAT/);
  assert.deepEqual(ent.checks.map((c) => `${c.k}:${c.v}`), ['prod:no', 'dep:no', 'pago:ok', 'remito:pend']);
  assert.equal(mov(v, 'ingreso', 'Termo').despacho.estado, 'nollego', 'el ingreso del 16/11 no llegó');
  assert.equal(mov(v, 'egreso', 'Termo').despacho.estado, 'nollego', 'sin la mercadería no se puede llevar al impresor');
  // La mochila: el retiro del 17/11 no se hizo.
  assert.equal(mov(v, 'entrega', 'Mochila').despacho.estado, 'nollego');
  // Lo que el impresor trae después: programado.
  assert.equal((await api('GET', '/cronograma?desde=2026-11-24&hasta=2026-11-27')).data.movimientos.find((m) => m.npdv === PDV && m.articulo.startsWith('Bolsa') && m.tipo === 'ingreso_impresor').despacho.estado, 'prog');

  // La caja está lista para el 24/11: «Listo para despachar», le toca a Logística.
  const otra = async () => (await api('GET', '/cronograma?desde=2026-11-24&hasta=2026-11-27')).data;
  let caja = mov(await otra(), 'entrega', 'Caja').despacho;
  assert.deepEqual([caja.estado, caja.quien], ['listo', 'logistica']);
  // Con saldo en Finnegans (lo que falta facturar cuenta): «No pagó», le toca a Ventas.
  const tok = (await api('POST', '/tokens', { name: `Despacho ${RUN}`, source: 'api' })).data.token;
  const saldo = (n) => fetch(`${BASE}/hooks/pedidos/saldos`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ filas: [], porFacturar: { [`PEDVTASTP - ${PDV}`]: n } }) });
  assert.equal((await saldo(1500)).status, 200);
  caja = mov(await otra(), 'entrega', 'Caja').despacho;
  assert.deepEqual([caja.estado, caja.quien], ['nopago', 'ventas']);
  assert.match(caja.checks.find((c) => c.k === 'pago').t, /Saldo de \$ 1\.500 en Finnegans/);
  await saldo(0);

  // El remito: Finnegans no lo tiene todavía; cuando aparece, «Remitido».
  const sync = () => api('POST', '/integrations/finnegans/sync', { barrido: false });
  let r = await sync();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(consultasRemito >= 1, 'se le preguntó a Finnegans por el remito del pedido listo');
  assert.equal(mov(await otra(), 'entrega', 'Caja').despacho.estado, 'listo');
  // Se hace el remito («Sincronizar» vuelve a preguntar sin esperar las 2 horas de la tarea automática).
  remitoHecho = true;
  for (let i = 0; i < 4 && mov(await otra(), 'entrega', 'Caja').despacho.estado !== 'remitido'; i++) await sync();
  caja = mov(await otra(), 'entrega', 'Caja').despacho;
  assert.equal(caja.estado, 'remitido');
  assert.equal(caja.checks.find((c) => c.k === 'remito').v, 'ok');
  const pedido = (await api('GET', `/records/order/${mov(await otra(), 'entrega', 'Caja').record_id}`)).data.record.props;
  assert.equal(pedido.remito_finnegans, `FPREMVTA - 000${PDV}`);
  assert.equal(pedido.remito_finnegans_fecha, '2026-11-19');
});

test('cronograma: mover a otro día escribe la fecha en ClickUp, también en Corporate', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  escrito.length = 0;
  let r = await api('POST', '/cronograma/mover', { ids: [T], tipo: 'egreso', fecha: '2026-11-19' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.escritos, 1);
  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].task, T);
  assert.ok(escrito[0].path.endsWith(`/field/${F.egresoImp}`));
  let v = await semana();
  assert.equal(mov(v, 'egreso', 'Termo').fecha, '2026-11-19');
  assert.deepEqual(mov(v, 'retiro_impresor', 'Termo').avisos, ['El retiro del impresor es anterior al egreso']);
  // La entrega de la mochila es la del PDV: se mueve la fecha del PDV.
  escrito.length = 0;
  r = await api('POST', '/cronograma/mover', { ids: [M], tipo: 'entrega', fecha: '2026-11-20' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(escrito.map((e) => e.task), [M], 'la fecha queda en el artículo: mover uno no arrastra a los demás del PDV');
  v = await semana();
  assert.equal(mov(v, 'entrega', 'Mochila').fecha, '2026-11-20');
  assert.equal(mov(v, 'entrega', 'Termo').fecha, '2026-11-18', 'el termo tiene su propia fecha: no se movió');
  // El perfil Ventas no entra al cronograma (como a Producción y Entregas).
  await api('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vende ${RUN}`, profile: 'comercial' });
  asUser = `vende.${RUN}@formas.ar`;
  assert.equal((await api('POST', '/cronograma/mover', { ids: [T], tipo: 'egreso', fecha: '2026-11-17' })).status, 403);
  assert.equal((await api('GET', '/cronograma?desde=2026-11-16&hasta=2026-11-22')).status, 403, 'el perfil Ventas no ve el cronograma');
  // Logística sí.
  asUser = null;
  await api('POST', '/users', { email: `logi.${RUN}@formas.ar`, name: `Logi ${RUN}`, profile: 'logistica' });
  asUser = `logi.${RUN}@formas.ar`;
  assert.equal((await api('POST', '/cronograma/mover', { ids: [T], tipo: 'egreso', fecha: '2026-11-17' })).status, 200);
  asUser = null;
  assert.equal((await api('POST', '/cronograma/mover', { ids: [T], tipo: 'egreso', fecha: 'mañana' })).status, 400);
});

test('cronograma: marcar hecho cambia el estado en ClickUp y se puede deshacer', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  escrito.length = 0;
  let r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'egreso', hecho: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.cambiados, r.data.estado, r.data.marcados], [1, 'en el impresor', [T]]);
  assert.deepEqual(escrito.map((e) => [e.method, e.task, e.body]), [['PUT', T, { status: 'en el impresor' }]]);
  let v = await semana();
  assert.equal(mov(v, 'egreso', 'Termo').hecho, true);
  assert.equal(mov(v, 'egreso', 'Termo').estado, 'en el impresor');
  assert.equal(mov(v, 'ingreso', 'Termo').hecho, false, 'solo ese movimiento');
  // Deshacer: vuelve al estado que tenía.
  r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'egreso', hecho: false });
  assert.equal(r.data.cambiados, 1);
  v = await semana();
  assert.equal(mov(v, 'egreso', 'Termo').hecho, false);
  assert.equal(mov(v, 'egreso', 'Termo').estado, 'pedido al proveedor');
  // La gorra ya está «en el impresor»: marcar su ingreso viejo como hecho no la vuelve a «en control de depósito».
  escrito.length = 0;
  r = await api('POST', '/cronograma/hecho', { ids: [`cr${RUN}-a2`], tipo: 'ingreso', hecho: true });
  assert.deepEqual([r.data.cambiados, escrito.length], [0, 0], 'el estado no retrocede');
  // Entregado: todo lo anterior queda hecho, y marcar un retiro ya no vuelve el estado para atrás.
  r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'entrega', hecho: true });
  assert.deepEqual([r.data.cambiados, r.data.estado], [1, 'entregados']);
  r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'retiro_impresor', hecho: true });
  assert.equal(r.data.cambiados, 0);
  v = await semana();
  assert.ok(['ingreso', 'egreso', 'retiro_impresor', 'entrega'].every((tipo) => mov(v, tipo, 'Termo').hecho));
  assert.equal(mov(v, 'entrega', 'Termo').estado, 'entregados');
});

test('cronograma: el ingreso del impresor (lo trae él al depósito)', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  // Fuera de la semana de las otras pruebas, para no cambiarles las cuentas.
  const otra = async () => (await api('GET', '/cronograma?desde=2026-11-24&hasta=2026-11-27')).data;
  let v = await otra();
  const ing = mov(v, 'ingreso_impresor', 'Bolsa');
  assert.ok(ing, 'sale de INGRESO (IMPRESOR)');
  assert.equal(ing.fecha, '2026-11-25');
  assert.match(ing.lugar, /IMPREFAS/, 'el lugar es el impresor');
  assert.ok(ing.company_id);
  assert.equal(ing.parada, undefined, 'llega solo: no es parada de ningún recorrido');
  assert.deepEqual(ing.avisos, []);
  // En la ruta del día va con lo que llega al depósito, no como parada.
  const r = (await api('GET', '/cronograma/ruta?fecha=2026-11-25')).data;
  assert.ok(r.llegan.some((m) => m.tipo === 'ingreso_impresor' && m.task_id === B));
  assert.ok(!r.paradas.some((p) => p.movimientos.some((m) => m.task_id === B)));
  // Se mueve como las otras fechas: se escribe en INGRESO (IMPRESOR) de ClickUp.
  escrito.length = 0;
  let x = await api('POST', '/cronograma/mover', { ids: [B], tipo: 'ingreso_impresor', fecha: '2026-11-26' });
  assert.equal(x.status, 200, JSON.stringify(x.data));
  assert.deepEqual(escrito.map((e) => [e.task, e.path.split('/field/')[1]]), [[B, F.ingresoImp]]);
  v = await otra();
  assert.equal(mov(v, 'ingreso_impresor', 'Bolsa').fecha, '2026-11-26');
  // Marcarlo hecho la pasa a «en revision», como el retiro del impresor.
  escrito.length = 0;
  x = await api('POST', '/cronograma/hecho', { ids: [B], tipo: 'ingreso_impresor', hecho: true });
  assert.equal(x.status, 200, JSON.stringify(x.data));
  assert.deepEqual([x.data.cambiados, x.data.estado], [1, 'en revision']);
  assert.equal(mov(await otra(), 'ingreso_impresor', 'Bolsa').hecho, true);
  x = await api('POST', '/cronograma/hecho', { ids: [B], tipo: 'ingreso_impresor', hecho: false });
  assert.equal(x.data.cambiados, 1);
  // Con retiro e ingreso del impresor a la vez, avisa: es uno o el otro.
  await api('POST', '/cronograma/mover', { ids: [B], tipo: 'retiro_impresor', fecha: '2026-11-24' });
  v = await otra();
  assert.deepEqual(mov(v, 'ingreso_impresor', 'Bolsa').avisos, ['Tiene ingreso y retiro del impresor: es uno o el otro']);
  assert.deepEqual(mov(v, 'retiro_impresor', 'Bolsa').avisos, ['Tiene ingreso y retiro del impresor: es uno o el otro']);
  await api('POST', '/cronograma/mover', { ids: [B], tipo: 'retiro_impresor', fecha: '' });
  // También se ve y se edita en Producción.
  const art = (await api('GET', '/produccion?unidades=CORPORATE&cerrados=1')).data.pdvs.find((p) => p.npdv === PDV).articulos.find((a) => a.task_id === B);
  assert.equal(art.ingreso_impresor, '2026-11-26');
});

test('cronograma: notas del día y feriados', async () => {
  asUser = null;
  const n = await api('POST', '/cronograma/notas', { fecha: '2026-11-17', texto: `Llevar el sobre a Matienzo ${RUN}` });
  assert.equal(n.status, 200);
  assert.equal((await api('POST', '/cronograma/notas', { fecha: '2026-11-17', texto: ' ' })).status, 400);
  let v = await semana();
  const nota = v.notas.find((x) => x.id === n.data.id);
  assert.equal(nota.texto, `Llevar el sobre a Matienzo ${RUN}`);
  await api('PATCH', `/cronograma/notas/${n.data.id}`, { hecho: true });
  assert.equal((await semana()).notas.find((x) => x.id === n.data.id).hecho, 1);
  await api('DELETE', `/cronograma/notas/${n.data.id}`);
  assert.ok(!(await semana()).notas.some((x) => x.id === n.data.id));
  // Un feriado: lo que cae ese día queda avisado.
  await api('PUT', '/cronograma/feriados', { fecha: '2026-11-16', nombre: 'Feriado de prueba' });
  v = await semana();
  assert.equal(v.feriados['2026-11-16'], 'Feriado de prueba');
  await api('PUT', '/cronograma/feriados', { fecha: '2026-11-16', nombre: '' });
  assert.ok(!(await semana()).feriados['2026-11-16']);
});

test('cronograma: la ruta del día, con las direcciones y la sugerencia si las últimas entregas fueron a otro lado', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  const v = await semana();
  const pedido = mov(v, 'entrega', 'Mochila').record_id;
  assert.ok(pedido, 'el PDV tiene su pedido');
  // El pedido viejo del mismo cliente tiene un remito leído, entregado en Sarandí.
  const viejo = (await api('GET', '/cronograma?desde=2026-10-19&hasta=2026-10-25')).data.movimientos.find((m) => m.npdv === PDV_V).record_id;
  const f = new FormData();
  f.append('archivo', new Blob([`\xff\xd8\xff\xe0 remito ${RUN}`], { type: 'image/jpeg' }), 'remito.jpg');
  const rem = await api('POST', `/records/order/${viejo}/remitos`, f);
  assert.equal(rem.status, 201, JSON.stringify(rem.data));
  // El impresor tiene su dirección y su horario en la ficha de la empresa.
  const imprefas = mov(v, 'retiro_impresor', 'Termo').company_id;
  assert.equal((await api('PUT', '/cronograma/direccion', { company_id: imprefas, direccion: `Cnel. Sayos ${PDV}, Lanús`, horario: '9 a 13' })).status, 200);
  assert.equal((await api('PUT', '/cronograma/direccion', { company_id: imprefas, horario: 'a la tarde' })).status, 400);

  // El 20/11 se entrega la mochila. La dirección sale de Finnegans (sin el piso para buscarla en el mapa).
  let r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  for (let i = 0; i < 6 && r.buscando > 0; i++) r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.equal(r.buscando, 0);
  assert.deepEqual(r.bases.map((b) => [b.id, b.lat]), [['roca', -34.5361], ['matienzo', -34.5345]], 'los dos depósitos de Florida Oeste, ubicados');
  const entrega = r.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV));
  assert.equal(entrega.nombre, CLIENTE);
  assert.equal(entrega.direccion, `Av. Libertador ${PDV} Piso 4, Vicente López`);
  assert.equal(entrega.origen, 'finnegans');
  assert.deepEqual([entrega.lat, entrega.lng], [-34.527, -58.476]);
  // Las últimas entregas fueron a otro lado: Claude lo avisa, una sola vez.
  assert.deepEqual(entrega.sugerencia, { record_id: pedido, sugerida: `Nicaragua ${PDV_V}, Sarandí, Avellaneda`, motivo: `Las últimas entregas fueron a Nicaragua ${PDV_V}, Sarandí.` });
  const antes = consultasClaude;
  assert.ok(antes >= 1);
  await api('GET', '/cronograma/ruta?fecha=2026-11-20');
  assert.equal(consultasClaude, antes, 'no vuelve a consultar por lo mismo');
  // Se acepta: queda como dirección de entrega del pedido, y la parada pasa ahí.
  assert.equal((await api('POST', '/cronograma/sugerencia', { record_id: pedido, aceptar: true })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  const nueva = r.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV));
  assert.equal(nueva.direccion, `Nicaragua ${PDV_V}, Sarandí, Avellaneda`);
  assert.equal(nueva.origen, 'pedido');
  assert.equal(nueva.sugerencia, null);
  assert.equal(nueva.lat, -34.679);
  assert.equal((await api('GET', `/records/order/${pedido}`)).data.record.props.direccion_entrega, `Nicaragua ${PDV_V}, Sarandí, Avellaneda`);
  // En la tarjeta de la semana: la misma dirección, con el tilde de ubicada en el mapa, y se corrige en el pedido.
  let dirs = (await api('GET', '/cronograma/direcciones?desde=2026-11-16&hasta=2026-11-22')).data;
  assert.deepEqual(dirs.direcciones[`2026-11-20|${nueva.clave}`] && { ...dirs.direcciones[`2026-11-20|${nueva.clave}`], nombre: undefined, horario: undefined, company_id: undefined, detalle: undefined, observaciones: undefined },
    { direccion: `Nicaragua ${PDV_V}, Sarandí, Avellaneda`, origen: 'pedido', estado: 'ok', record_ids: [pedido], expreso: false, otras: 0, nombre: undefined, horario: undefined, company_id: undefined, detalle: undefined, observaciones: undefined });
  assert.equal((await api('GET', '/cronograma/direcciones?desde=2026-11-16')).status, 400);
  // Piso, depto, puerta o unidad y las observaciones de entrega: quedan en la dirección del pedido, sin cambiarla, y se ven
  // en la tarjeta y en la parada.
  assert.equal((await api('PUT', '/cronograma/direccion', { record_id: pedido, direccion: `Nicaragua ${PDV_V}, Sarandí, Avellaneda`, detalle: 'Piso 4 B', observaciones: 'Tocar timbre de recepción' })).status, 200);
  dirs = (await api('GET', '/cronograma/direcciones?desde=2026-11-16&hasta=2026-11-22')).data;
  const conExtra = dirs.direcciones[`2026-11-20|${nueva.clave}`];
  assert.deepEqual([conExtra.direccion, conExtra.detalle, conExtra.observaciones, conExtra.estado], [`Nicaragua ${PDV_V}, Sarandí, Avellaneda`, 'Piso 4 B', 'Tocar timbre de recepción', 'ok']);
  const parada = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data.paradas.find((p) => p.clave === nueva.clave);
  assert.deepEqual([parada.detalle, parada.observaciones], ['Piso 4 B', 'Tocar timbre de recepción']);
  // Cambiar solo la dirección no las borra.
  assert.equal((await api('PUT', '/cronograma/direccion', { record_id: pedido, direccion: `Nicaragua ${PDV_V}, Sarandí, Avellaneda` })).status, 200);
  assert.equal((await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data.paradas.find((p) => p.clave === nueva.clave).observaciones, 'Tocar timbre de recepción');
  // En un proveedor o impresor, en la ficha de la empresa.
  assert.equal((await api('PUT', '/cronograma/direccion', { company_id: imprefas, detalle: 'Nave 3', observaciones: 'Entrar por el portón de atrás' })).status, 200);
  const emp = (await api('GET', `/records/company/${imprefas}`)).data.record.props;
  assert.deepEqual([emp.direccion_detalle, emp.observaciones_entrega, emp.address], ['Nave 3', 'Entrar por el portón de atrás', `Cnel. Sayos ${PDV}, Lanús`]);

  // Retira en Formas (tarjeta «Entrega»): no es una parada del chofer; va aparte, en «Retiran en Formas».
  const dirsUrl = `/records/order/${pedido}/direcciones`;
  const previas = (await api('GET', dirsUrl)).data.direcciones;
  const deEste = (x) => x.retiran.filter((m) => m.npdv === PDV);
  const esParada = (x) => x.paradas.some((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV));
  assert.equal((await api('PUT', dirsUrl, { direcciones: [{ retira: 'matienzo', detalle: 'Retira Ana' }] })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.equal(esParada(r), false, 'no es una parada');
  assert.ok(deEste(r).length && deEste(r).every((m) => m.retira_en === 'Oficina Matienzo' && !m.parcial), JSON.stringify(r.retiran));
  // En la semana la tarjeta lo dice, y no tiene chofer para elegir.
  const ret = mov(await semana(), 'entrega', 'Mochila');
  assert.deepEqual([ret.retira_en, ret.chofer ?? null], ['Oficina Matienzo', null]);
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: ret.fecha, ids: [ret.id], chofer: `Juan ${RUN}` })).status, 400, 'no es una parada de nadie');
  // Parte retira y parte se envía: la parada del envío sigue, y el retiro va aparte.
  assert.equal((await api('PUT', dirsUrl, { direcciones: [{ retira: 'roca' }, { direccion: previas[0].direccion }] })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.equal(r.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV))?.direccion, previas[0].direccion);
  assert.ok(deEste(r).length && deEste(r).every((m) => m.retira_en === 'Depósito Gral. Roca' && m.parcial));
  // Como estaba.
  assert.equal((await api('PUT', dirsUrl, { direcciones: previas.map((x) => ({ direccion: x.direccion, detalle: x.detalle })) })).status, 200);
  assert.ok(esParada((await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data));

  // El 18/11: el retiro del impresor, con su dirección y su horario; el ingreso no es una parada.
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const imp = r.paradas.find((p) => p.company_id === imprefas);
  assert.equal(imp.direccion, `Cnel. Sayos ${PDV}, Lanús`);
  assert.deepEqual(imp.horario, [540, 780]);
  assert.equal(imp.lat, -34.699);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-16')).data;
  assert.ok(r.llegan.some((m) => m.npdv === PDV && m.tipo === 'ingreso'));
  // (Solo el ingreso: el retiro de la gorra es de hoy, y hoy puede ser el 16/11.)
  assert.ok(!r.paradas.some((p) => p.movimientos.some((m) => m.npdv === PDV && m.tipo === 'ingreso')));

  // Correr un punto en el mapa: queda ahí y no se vuelve a buscar.
  const geoAntes = consultasGeo;
  assert.equal((await api('PUT', '/cronograma/punto', { direccion: `Cnel. Sayos ${PDV}, Lanús`, lat: -34.7, lng: -58.39 })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const corrido = r.paradas.find((p) => p.company_id === imprefas);
  assert.deepEqual([corrido.lat, corrido.lng, corrido.punto_manual], [-34.7, -58.39, true]);
  assert.equal(consultasGeo, geoAntes);
  // Se saca la corrección: la dirección se vuelve a buscar en el mapa.
  assert.equal((await api('DELETE', `/cronograma/punto?direccion=${encodeURIComponent(`Cnel. Sayos ${PDV}, Lanús`)}`)).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  for (let i = 0; i < 6 && r.buscando > 0; i++) r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const devuelta = r.paradas.find((p) => p.company_id === imprefas);
  assert.deepEqual([devuelta.lat, devuelta.punto_manual], [-34.699, false]);
  assert.ok(consultasGeo > geoAntes);

  // Los recorridos del día: dos choferes, cada uno con su orden y su depósito.
  const claves = r.paradas.map((p) => p.clave);
  const ch = (await api('POST', '/choferes', { name: `Juan ${RUN}` })).data;
  const g = await api('PUT', '/cronograma/ruta', { fecha: '2026-11-18', rutas: [{ chofer: `Juan ${RUN}`, base: 'matienzo', salida: 480, orden: claves.slice(0, 1) }, { chofer: null, base: 'roca', salida: 540, orden: claves.slice(1) }] });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  assert.equal(r.guardada, true);
  assert.deepEqual(r.rutas.map((x) => [x.n, x.chofer, x.base, x.salida]), [[1, `Juan ${RUN}`, 'matienzo', 480], [2, null, 'roca', 540]]);
  assert.deepEqual(r.rutas[0].orden, claves.slice(0, 1));

  // No puede haber dos links activos con el mismo nombre: el recorrido se asigna por nombre.
  assert.equal((await api('POST', '/choferes', { name: `juan  ${RUN.toUpperCase()}` })).status, 409);

  // ---------- La app del chofer: su recorrido de hoy ----------
  const chofer = (ruta, token, opts = {}) => fetch(`${BASE}/hooks/chofer/api${ruta}`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...opts });
  let hoy = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  const gorra = hoy.paradas.find((p) => p.movimientos.some((m) => m.npdv === PDV && m.articulo.startsWith('Gorra')));
  assert.ok(gorra, 'el retiro de la gorra es una parada de hoy');
  assert.equal(gorra.clave, `e:${imprefas}`, 'la clave de la parada es la empresa, no su dirección');
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: HOY, rutas: [{ chofer: `Juan ${RUN}`, base: 'matienzo', salida: 480, orden: [gorra.clave] }] })).status, 200);
  const rc = await (await chofer('/ruta', ch.token)).json();
  assert.equal(rc.fecha, HOY);
  assert.equal(rc.recorridos.length, 1);
  assert.equal(rc.recorridos[0].base.nombre, 'Oficina Matienzo');
  assert.ok(rc.recorridos[0].paradas.some((p) => p.clave === gorra.clave));
  assert.equal((await fetch(`${BASE}/hooks/chofer/api/ruta`)).status, 401, 'sin el link del chofer no se ve');
  // Corregir la dirección del impresor no saca la parada del recorrido del chofer.
  await api('PUT', '/cronograma/direccion', { company_id: imprefas, direccion: `Cnel. Sayos ${PDV}, Lanús Oeste` });
  assert.ok((await (await chofer('/ruta', ch.token)).json()).recorridos[0].paradas.some((p) => p.clave === gorra.clave));
  // Otro chofer no ve ese recorrido ni puede marcar sus paradas.
  const otro = (await api('POST', '/choferes', { name: `Pedro ${RUN}` })).data;
  assert.deepEqual((await (await chofer('/ruta', otro.token)).json()).recorridos, []);
  const marcar = async (cuerpo, token = ch.token) => { const x = await chofer('/ruta/parada', token, { method: 'POST', body: JSON.stringify({ clave: gorra.clave, ...cuerpo }) }); return { status: x.status, data: await x.json() }; };
  assert.equal((await marcar({ resultado: 'hecho' }, otro.token)).status, 404);
  // No había nadie: queda a la vista de Logística, sin tocar ClickUp.
  escrito.length = 0;
  assert.equal((await marcar({ resultado: 'no_se_pudo' })).status, 400, 'falta el motivo');
  assert.equal((await marcar({ resultado: 'no_se_pudo', motivo: 'nadie', nota: 'Vuelvo a las 15' })).status, 200);
  hoy = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  const vis = hoy.paradas.find((p) => p.clave === gorra.clave).visita;
  assert.deepEqual([vis.resultado, vis.motivo, vis.nota, vis.chofer], ['no_se_pudo', 'nadie', 'Vuelvo a las 15', `Juan ${RUN}`]);
  assert.equal(escrito.length, 0);
  // Hecha: el artículo cambia de estado en ClickUp. Repetirlo no escribe de nuevo.
  const G = `cr${RUN}-a2`;
  assert.equal((await marcar({ resultado: 'hecho' })).status, 200);
  assert.deepEqual(escrito.filter((e) => e.body?.status).map((e) => [e.task, e.body.status]), [[G, 'en revision']], 'el retiro del impresor pasa el artículo a «en revision»');
  escrito.length = 0;
  assert.equal((await marcar({ resultado: 'hecho' })).status, 200);
  assert.equal(escrito.length, 0, 'marcar lo mismo otra vez no escribe nada');
  hoy = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  const ya = hoy.paradas.find((p) => p.clave === gorra.clave);
  assert.equal(ya.visita.resultado, 'hecho');
  assert.ok(ya.movimientos.filter((m) => m.npdv === PDV).every((m) => m.hecho));
  // Deshacer: vuelve al estado que tenía.
  assert.equal((await marcar({ resultado: '' })).status, 200);
  assert.deepEqual(escrito.filter((e) => e.body?.status).map((e) => [e.task, e.body.status]), [[G, 'en el impresor']]);
  hoy = (await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data;
  assert.equal(hoy.paradas.find((p) => p.clave === gorra.clave).visita, null);

  // ---------- La foto del remito en un retiro (pedido de Rodrigo del 16/11/2026): remito interno ----------
  // Queda en los pedidos de la parada, no se lee y no cuenta para la entrega al cliente; Ventas no lo ve.
  assert.equal(hoy.paradas.find((p) => p.clave === gorra.clave).fotos, 0);
  const claudeAntes = consultasClaude;
  const fd = new FormData();
  fd.append('archivo', new Blob([`\xff\xd8\xff\xe0 interno ${RUN}`], { type: 'image/jpeg' }), 'remito.jpg');
  fd.append('parada', gorra.clave); fd.append('clave', `interno-${RUN}`); fd.append('tomada_el', new Date().toISOString());
  const subida = await fetch(`${BASE}/hooks/chofer/api/remitos`, { method: 'POST', headers: { authorization: `Bearer ${ch.token}` }, body: fd });
  assert.equal(subida.status, 201);
  const sub = await subida.json();
  assert.equal(sub.estado, 'ok');
  assert.match(sub.mensaje, /pedidos de esa parada/);
  assert.equal(consultasClaude, claudeAntes, 'un remito interno no se lee con Claude');
  const pedidoGorra = gorra.movimientos.find((m) => m.npdv === PDV).record_id;
  let rems = (await api('GET', `/records/order/${pedidoGorra}/remitos`)).data;
  const interno = rems.remitos.find((r) => r.id === sub.id);
  assert.deepEqual([interno.tipo, interno.fecha_parada, interno.parada], ['interno', HOY, gorra.clave]);
  assert.equal(rems.entrega.remitos_ok, rems.remitos.filter((r) => r.tipo === 'entrega' && r.estado === 'ok' && !r.duplicado_de).length, 'no cuenta para la entrega');
  // La ruta del día y la app del chofer saben que esa parada ya tiene su foto.
  assert.equal((await api('GET', `/cronograma/ruta?fecha=${HOY}`)).data.paradas.find((p) => p.clave === gorra.clave).fotos, 1);
  assert.equal((await (await chofer('/ruta', ch.token)).json()).recorridos[0].paradas.find((p) => p.clave === gorra.clave).fotos, 1);
  // Ventas no lo ve (ni la lista ni el archivo).
  await api('POST', '/users', { email: `vende.int.${RUN}@formas.ar`, name: `Vende Int ${RUN}`, profile: 'comercial', role: 'member' });
  asUser = `vende.int.${RUN}@formas.ar`;
  const deVentas = await api('GET', `/records/order/${pedidoGorra}/remitos`);
  if (deVentas.status === 200) assert.ok(!deVentas.data.remitos.some((r) => r.tipo === 'interno'));
  assert.equal((await api('GET', `/remitos/${sub.id}/archivo`)).status, 403);
  asUser = null;
  // Logística lo puede pasar a remito de entrega (se lee) y volverlo a interno.
  assert.equal((await api('PATCH', `/remitos/${sub.id}/tipo`, { tipo: 'entrega' })).data.remito.tipo, 'entrega');
  assert.equal((await api('PATCH', `/remitos/${sub.id}/tipo`, { tipo: 'interno' })).data.remito.tipo, 'interno');
  assert.equal((await api('PATCH', `/remitos/${sub.id}/tipo`, { tipo: 'otro' })).status, 400);

  // ---------- El remito de traslado de un egreso: lo que va al impresor ese día, una hoja A4 ----------
  const rt = await api('POST', '/cronograma/remito-traslado', { fecha: '2026-11-17', clave: `e:${imprefas}` });
  assert.equal(rt.status, 200, JSON.stringify(rt.data));
  assert.equal((await api('POST', '/cronograma/remito-traslado', { fecha: '2026-11-17', clave: `e:${imprefas}` })).data.numero, rt.data.numero, 'el mismo número');
  const html = (await api('GET', `/cronograma/remito-traslado/${rt.data.id}`)).data;
  assert.match(html, new RegExp(`Termo ${RUN}`));
  assert.match(html, new RegExp(String(rt.data.numero).padStart(9, '0')));
  assert.equal(html.split('<main class="hoja">').length - 1, 1, 'una sola hoja por remito');
  assert.equal((await api('POST', '/cronograma/remito-traslado', { fecha: '2026-11-17', clave: 'e:999999999' })).status, 404);
  assert.equal((await api('POST', '/cronograma/remito-traslado', { fecha: '2026-11-17', clave: `e:${imprefas}` }, undefined)).status, 200);
});

test('cronograma: la libreta de direcciones se copia de la planilla y completa las paradas', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  const act = await api('POST', '/cronograma/lugares/actualizar');
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.deepEqual([act.data.filas, act.data.error], [3, null], 'tres lugares (la fila vacía no cuenta)');
  // Buscar un lugar para una parada: por calle, y los de ese proveedor aunque no se escriba nada.
  let b = (await api('GET', '/cronograma/lugares?q=ingenieros')).data.lugares;
  const zecat = b.find((l) => l.nombre === `ZECAT ${RUN} (DEPOSITO)`);
  assert.equal(zecat.direccion, `JOSE INGENIEROS ${PDV}, Ricardo Rojas, Buenos Aires`);
  b = (await api('GET', `/cronograma/lugares?de=${encodeURIComponent(`ZECAT ${RUN}`)}`)).data.lugares;
  assert.deepEqual(b.map((l) => l.nombre), [`ZECAT ${RUN} (DEPOSITO)`]);
  // El cliente «Nestle … S.A.» no se llama igual que «Nestle … SARANDI»: se ofrece para elegir, pero no se usa solo.
  b = (await api('GET', `/cronograma/lugares?de=${encodeURIComponent(CLIENTE)}`)).data.lugares;
  assert.ok(b.some((l) => l.nombre === `Nestle ${RUN} SARANDI`));

  // El proveedor no tiene dirección en su ficha: la parada usa la de la libreta, con su horario, contacto y observación.
  let r = (await api('GET', '/cronograma/ruta?fecha=2026-11-17')).data;
  for (let i = 0; i < 6 && r.buscando > 0; i++) r = (await api('GET', '/cronograma/ruta?fecha=2026-11-17')).data;
  const prov = r.paradas.find((p) => p.movimientos.some((m) => m.npdv === PDV && m.tipo === 'retiro_proveedor'));
  assert.equal(prov.direccion, `JOSE INGENIEROS ${PDV}, Ricardo Rojas, Buenos Aires`);
  assert.equal(prov.origen, 'libreta');
  assert.deepEqual(prov.horario, [540, 1020]);
  assert.equal(prov.lugar.contacto, 'NATALIA');
  assert.equal(prov.lugar.observaciones, 'Tocar el timbre del "portón" gris, al fondo');
  assert.equal(prov.lat, -34.514);
  // La entrega va a Nicaragua (la dirección cargada en el pedido): la libreta reconoce la calle y suma el horario y cómo
  // se coordina, aunque esté escrita distinto.
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  const ent = r.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV));
  assert.equal(ent.origen, 'pedido');
  assert.equal(ent.lugar.nombre, `Nestle ${RUN} SARANDI`);
  assert.deepEqual(ent.horario, [480, 720]);
  assert.equal(ent.lugar.coordinacion, 'Pedir turno por mail. Va palletizado');
  // Quien solo mira no ve cómo se coordina la entrega ni puede actualizar la libreta.
  await api('POST', '/users', { email: `mira.${RUN}@formas.ar`, name: `Mira ${RUN}`, profile: 'produccion', role: 'viewer' });
  asUser = `mira.${RUN}@formas.ar`;
  const mira = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  if (mira.puede_editar === false) {
    assert.equal(mira.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV)).lugar.coordinacion, null);
    assert.equal((await api('POST', '/cronograma/lugares/actualizar')).status, 403);
  }
  asUser = null;
});

test('cronograma: choferes y expresos, una entrega por expreso con su guía y un recorrido que sale de otro lugar', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  // La lista de choferes y expresos, desde el desplegable de la ruta.
  assert.equal((await api('POST', '/cronograma/transportistas', { nombre: ' ', tipo: 'chofer' })).status, 400);
  assert.equal((await api('POST', '/cronograma/transportistas', { nombre: `Carlos ${RUN}`, tipo: 'chofer' })).status, 200);
  const ex = await api('POST', '/cronograma/transportistas', { nombre: `Expreso ${RUN}`, tipo: 'expreso', direccion: `Vélez Sarsfield ${PDV}, Barracas, CABA` });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  let r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.ok(r.choferes.includes(`Carlos ${RUN}`), 'el chofer nuevo está en el desplegable');
  assert.ok(r.choferes.includes(`Juan ${RUN}`), 'y los que tienen link de la app');
  assert.deepEqual(r.expresos.filter((x) => x.nombre === `Expreso ${RUN}`).map((x) => x.direccion), [`Vélez Sarsfield ${PDV}, Barracas, CABA`]);

  // La entrega de la mochila va por expreso: la parada pasa a ser el expreso, para ese cliente.
  const antes = r.paradas.find((p) => p.movimientos.some((m) => m.tipo === 'entrega' && m.npdv === PDV));
  assert.equal(antes.nombre, CLIENTE);
  assert.equal((await api('PUT', '/cronograma/expreso', { clave: 'e:1', expreso: 'x' })).status, 400, 'solo una entrega va por expreso');
  assert.equal((await api('PUT', '/cronograma/expreso', { clave: antes.clave, record_id: antes.record_id, expreso: `Expreso ${RUN}` })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  let par = r.paradas.find((p) => p.clave === antes.clave);
  assert.equal(par.nombre, `Expreso ${RUN}`);
  assert.deepEqual(par.expreso, { nombre: `Expreso ${RUN}`, guia: null, cliente: CLIENTE });
  assert.deepEqual([par.direccion, par.origen], [`Vélez Sarsfield ${PDV}, Barracas, CABA`, 'expreso']);
  // La guía se carga después, y se ve también en la semana.
  assert.equal((await api('PUT', '/cronograma/expreso', { clave: antes.clave, record_id: antes.record_id, expreso: `Expreso ${RUN}`, guia: 'A-000123' })).status, 200);
  const sem = await semana();
  assert.deepEqual(mov(sem, 'entrega', 'Mochila').expreso, { nombre: `Expreso ${RUN}`, guia: 'A-000123' });
  // El expreso es del PDV: vale para todas sus entregas.
  assert.equal(mov(sem, 'entrega', 'Termo').expreso.nombre, `Expreso ${RUN}`);
  assert.equal(mov(sem, 'retiro_proveedor', 'Mochila').expreso ?? null, null, 'solo las entregas');
  // Vuelve a ir directo.
  assert.equal((await api('PUT', '/cronograma/expreso', { clave: antes.clave, expreso: '' })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  par = r.paradas.find((p) => p.clave === antes.clave);
  assert.deepEqual([par.nombre, par.expreso ?? null], [CLIENTE, null]);

  // Un recorrido que sale de otro lugar, elegido de la libreta: queda con su nombre, su dirección y su punto en el mapa.
  const otro = { nombre: `ZECAT ${RUN} (DEPOSITO)`, direccion: `JOSE INGENIEROS ${PDV}, RICARDO ROJAS, Buenos Aires` };
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: '2026-11-20', rutas: [{ chofer: `Carlos ${RUN}`, base: 'otro', base_otro: otro, salida: 540, orden: r.paradas.map((p) => p.clave) }] })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  for (let i = 0; i < 6 && r.buscando > 0; i++) r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.equal(r.rutas[0].base, 'otro');
  assert.deepEqual(r.rutas[0].base_otro, { ...otro, lat: -34.514, lng: -58.497 });
  assert.equal(r.rutas[0].chofer, `Carlos ${RUN}`);
  // Volver a un depósito de Formas saca el otro lugar.
  await api('PUT', '/cronograma/ruta', { fecha: '2026-11-20', rutas: [{ chofer: null, base: 'roca', salida: 540, orden: [] }] });
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-20')).data;
  assert.deepEqual([r.rutas[0].base, r.rutas[0].base_otro ?? null], ['roca', null]);
});

test('cronograma: la entrega pactada viene de Finnegans y avisa cuando la real quedó para después', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  let v = await semana();
  const pedido = mov(v, 'entrega', 'Termo').record_id;
  // El PDV se creó con entrega para el 25/11: la real del termo (18/11) es anterior, sin aviso.
  assert.equal((await api('GET', `/records/order/${pedido}`)).data.record.props.fecha_de_entrega, '2026-11-25');
  assert.ok(!mov(v, 'entrega', 'Termo').avisos.some((a) => a.startsWith('Pactada')));
  // En Finnegans el comercial la cambió al 17/11 (viene como DD/MM/AAAA): al releer el pedido queda en el CRM.
  pactadaFinnegans = '17/11/2026';
  assert.equal((await api('GET', `/records/order/${pedido}/products?refresh=1`)).status, 200);
  assert.equal((await api('GET', `/records/order/${pedido}`)).data.record.props.fecha_de_entrega, '2026-11-17');
  // La real del termo (18/11) ahora es posterior a la pactada: el cronograma lo avisa.
  v = await semana();
  assert.ok(mov(v, 'entrega', 'Termo').avisos.includes('Pactada para el 17/11'));
  // Producción ve las dos: la pactada del PDV y la real de cada artículo.
  const prod = (await api('GET', '/produccion?unidades=CORPORATE&cerrados=1')).data.pdvs.find((x) => x.npdv === PDV);
  assert.equal(prod.entrega_prometida, '2026-11-17');
  // Si Finnegans no manda la fecha, la del CRM queda como estaba.
  pactadaFinnegans = null;
  await api('GET', `/records/order/${pedido}/products?refresh=1`);
  assert.equal((await api('GET', `/records/order/${pedido}`)).data.record.props.fecha_de_entrega, '2026-11-17');
});

test('cronograma: el chofer se elige desde la tarjeta de la semana', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  const DIA = '2026-11-17';
  // El día arranca con un solo recorrido, sin chofer, que nadie ordenó a mano.
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: DIA, rutas: [{ chofer: null, base: 'roca', salida: 510, orden: [], a_mano: false }] })).status, 200);
  let v = await semana();
  const ret = mov(v, 'retiro_proveedor', 'Mochila'), egr = mov(v, 'egreso', 'Termo');
  assert.deepEqual([ret.fecha, egr.fecha], [DIA, DIA]);
  assert.deepEqual([ret.chofer, egr.chofer], [null, null], 'todavía sin chofer');
  assert.equal(mov(v, 'ingreso', 'Termo').chofer, undefined, 'un ingreso no es una parada: no lleva chofer');
  assert.ok(v.choferes.includes(`Carlos ${RUN}`) && v.choferes.includes(`Juan ${RUN}`), 'los choferes del desplegable');
  assert.ok(v.expresos.includes(`Expreso ${RUN}`), 'y los expresos');

  // Carlos hace el retiro en Zecat: se arma su recorrido, que sale de donde sale el primero.
  let r = await api('PUT', '/cronograma/chofer', { fecha: DIA, ids: [ret.id], chofer: `carlos  ${RUN}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.chofer, `Carlos ${RUN}`, 'con el nombre como está en la lista');
  v = await semana();
  assert.deepEqual([mov(v, 'retiro_proveedor', 'Mochila').chofer, mov(v, 'egreso', 'Termo').chofer], [`Carlos ${RUN}`, null]);
  let ruta = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  const clave = (id) => ruta.paradas.find((p) => p.movimientos.some((m) => m.id === id)).clave;
  const deCarlos = () => ruta.rutas.find((x) => x.chofer === `Carlos ${RUN}`);
  assert.deepEqual([deCarlos().orden, deCarlos().a_mano, deCarlos().base, deCarlos().salida], [[clave(ret.id)], false, 'roca', 510]);
  assert.ok(ruta.rutas.every((x) => x === deCarlos() || !x.orden.includes(clave(ret.id))), 'sale del otro recorrido');

  // El egreso en el impresor también: entra a su recorrido, que se ordena solo por el más corto.
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: DIA, ids: [egr.id], chofer: `Carlos ${RUN}` })).status, 200);
  ruta = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  assert.deepEqual([...deCarlos().orden].sort(), [clave(ret.id), clave(egr.id)].sort());
  assert.ok(ruta.rutas.every((x) => x.chofer || x.orden.length), 'un recorrido sin chofer que quedó vacío se saca');
  assert.equal((await semana()).movimientos.find((m) => m.id === egr.id).chofer, `Carlos ${RUN}`);

  // Ordenado a mano en la Ruta del día: queda en ese orden y lo que entra va donde menos lo alarga.
  const aMano = [clave(egr.id), clave(ret.id)];
  assert.equal((await api('PUT', '/cronograma/ruta', { fecha: DIA, rutas: ruta.rutas.map((x) => (x.chofer === `Carlos ${RUN}` ? { ...x, orden: aMano, a_mano: true } : x)) })).status, 200);
  ruta = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  assert.deepEqual([deCarlos().orden, deCarlos().a_mano], [aMano, true]);
  // Sin chofer: el retiro pasa a un recorrido sin chofer.
  r = await api('PUT', '/cronograma/chofer', { fecha: DIA, ids: [ret.id], chofer: '' });
  assert.deepEqual([r.status, r.data.chofer], [200, null]);
  ruta = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  assert.deepEqual(deCarlos().orden, [clave(egr.id)]);
  assert.ok(ruta.rutas.some((x) => !x.chofer && x.orden.includes(clave(ret.id))));
  assert.equal(mov(await semana(), 'retiro_proveedor', 'Mochila').chofer, null);
  // Vuelve con Carlos: su recorrido sigue ordenado a mano.
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: DIA, ids: [ret.id], chofer: `Carlos ${RUN}` })).status, 200);
  ruta = (await api('GET', `/cronograma/ruta?fecha=${DIA}`)).data;
  assert.deepEqual([[...deCarlos().orden].sort(), deCarlos().a_mano], [[clave(ret.id), clave(egr.id)].sort(), true]);

  // El link de la app del chofer elegido, por su nombre: si no tiene, se crea ahí mismo y desde ahí aparece el suyo.
  let acc = await api('GET', `/choferes/por-nombre?nombre=${encodeURIComponent(`carlos ${RUN}`)}`);
  assert.deepEqual([acc.status, acc.data.existe], [200, false]);
  assert.equal((await api('POST', '/choferes', { name: `Carlos ${RUN}` })).status, 201);
  acc = await api('GET', `/choferes/por-nombre?nombre=${encodeURIComponent(`CARLOS  ${RUN}`)}`);
  assert.equal(acc.data.existe, true);
  assert.equal(acc.data.nombre, `Carlos ${RUN}`);
  assert.match(acc.data.link, /\/hooks\/chofer\/#t=/);
  assert.match(acc.data.codigo, /^\d{8}$/);

  // Lo que no es una parada, un día roto o quien no edita el cronograma: no.
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: '2026-11-16', ids: [mov(v, 'ingreso', 'Termo').id], chofer: `Carlos ${RUN}` })).status, 400);
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: 'mañana', ids: [ret.id], chofer: `Carlos ${RUN}` })).status, 400);
  asUser = `vende.${RUN}@formas.ar`;
  assert.equal((await api('PUT', '/cronograma/chofer', { fecha: DIA, ids: [ret.id], chofer: '' })).status, 403);
  assert.equal((await api('GET', `/choferes/por-nombre?nombre=${encodeURIComponent(`Carlos ${RUN}`)}`)).status, 403, 'el link del chofer, solo Logística');
  asUser = null;
});

test('cronograma: un recorrido puede terminar en otro lugar que de donde sale, o en la última parada', async (t) => {
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('sin ClickUp de prueba'); return; }
  asUser = null;
  const DIA = '2026-11-17';
  const ruta = async (dia = DIA) => { let r = (await api('GET', `/cronograma/ruta?fecha=${dia}`)).data; for (let i = 0; i < 6 && r.buscando > 0; i++) r = (await api('GET', `/cronograma/ruta?fecha=${dia}`)).data; return r; };
  const guardar = async (rec, dia = DIA) => { const g = await api('PUT', '/cronograma/ruta', { fecha: dia, rutas: [{ chofer: null, base: 'roca', salida: 510, orden: [], ...rec }] }); assert.equal(g.status, 200, JSON.stringify(g.data)); return ruta(dia); };
  // Por defecto vuelve a donde sale.
  let r = await guardar({});
  assert.deepEqual([r.rutas[0].fin, r.rutas[0].fin_otro], ['igual', null]);
  // Sale de Roca y termina en Matienzo.
  r = await guardar({ fin: 'matienzo' });
  assert.deepEqual([r.rutas[0].base, r.rutas[0].fin], ['roca', 'matienzo']);
  // Termina en otro lugar de la libreta: queda con su nombre, su dirección y su punto en el mapa.
  const otro = { nombre: `ZECAT ${RUN} (DEPOSITO)`, direccion: `JOSE INGENIEROS ${PDV}, RICARDO ROJAS, Buenos Aires` };
  r = await guardar({ fin: 'otro', fin_otro: otro });
  assert.deepEqual([r.rutas[0].fin, r.rutas[0].fin_otro], ['otro', { ...otro, lat: -34.514, lng: -58.497 }]);
  // En la última parada, sin volver a ningún lado.
  r = await guardar({ fin: 'ultima' });
  assert.deepEqual([r.rutas[0].fin, r.rutas[0].fin_otro], ['ultima', null]);
  // «Otro lugar» sin dirección, o un depósito que no existe: vuelve a donde sale.
  assert.equal((await guardar({ fin: 'otro', fin_otro: null })).rutas[0].fin, 'igual');
  assert.equal((await guardar({ fin: 'galpon-x' })).rutas[0].fin, 'igual');

  // El chofer lo ve en su app: dónde termina, o que termina en la última parada.
  const ch = (await api('POST', '/choferes', { name: `Mara ${RUN}` })).data;
  const app = async () => (await (await fetch(`${BASE}/hooks/chofer/api/ruta`, { headers: { authorization: `Bearer ${ch.token}` } })).json()).recorridos;
  await guardar({ chofer: `Mara ${RUN}`, fin: 'otro', fin_otro: otro }, HOY);
  let rec = await app();
  assert.ok(rec.length && rec[0].paradas.length, 'tiene su recorrido de hoy');
  assert.deepEqual([rec[0].fin?.nombre, rec[0].vuelve], [otro.nombre, false]);
  await guardar({ chofer: `Mara ${RUN}`, fin: 'ultima' }, HOY);
  rec = await app();
  assert.deepEqual([rec[0].fin, rec[0].vuelve], [null, false]);
  await guardar({ chofer: `Mara ${RUN}` }, HOY);
  rec = await app();
  assert.deepEqual([rec[0].fin?.nombre, rec[0].vuelve], ['Depósito Gral. Roca', true]);
});

// Colgados (pedido de Rodrigo del 19/11/2026): lo que no se pudo hacer sale de su día y queda en una columna que está en
// todas las semanas, con el motivo; al responsable del pedido le llega el aviso. Pasarlo a un día lo devuelve.
test('cronograma: lo que no se pudo hacer queda en Colgados con el motivo y avisa al responsable del pedido', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  const rango = '/cronograma?desde=2026-11-16&hasta=2026-11-22&rd=2026-10-12&rh=2026-12-20';
  const m = (await api('GET', rango)).data.movimientos.find((x) => x.npdv === PDV && !x.hecho && x.record_id);
  assert.ok(m, 'hay un movimiento pendiente del PDV');
  // La responsable del pedido: una vendedora.
  const resp = (await api('POST', '/users', { email: `resp.${RUN}@formas.ar`, name: `Resp ${RUN}`, role: 'member' })).data;
  assert.equal((await api('PATCH', `/records/order/${m.record_id}`, { props: { owner_id: resp.id } })).status, 200);
  assert.equal((await api('POST', '/cronograma/colgar', { ids: [m.task_id], tipo: m.tipo, motivo: ' ' })).status, 400, 'sin motivo no');
  const r = await api('POST', '/cronograma/colgar', { ids: [m.task_id], tipo: m.tipo, motivo: 'Fueron y nadie recibió' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { colgados: 1, avisados: [`Resp ${RUN}`] });
  // Sale de su día (también visto desde otra semana) y está en Colgados, con el motivo y el día que tenía.
  let v = (await api('GET', rango)).data;
  assert.ok(!v.movimientos.some((x) => x.id === m.id), 'ya no está en su día');
  const otraSemana = (await api('GET', '/cronograma?desde=2026-12-07&hasta=2026-12-13')).data;
  const c = otraSemana.colgados.find((x) => x.id === m.id);
  assert.ok(c, 'está en Colgados, en cualquier semana');
  assert.deepEqual([c.colgado.motivo, c.colgado.fecha], ['Fueron y nadie recibió', m.fecha]);
  // A la responsable le llega el aviso, con qué era y por qué.
  asUser = `resp.${RUN}@formas.ar`;
  const n = (await api('GET', '/notificaciones')).data.items.find((x) => x.kind === 'colgado' && x.record_id === m.record_id);
  assert.ok(n, 'aviso en la campanita');
  assert.match(n.texto, /Fueron y nadie recibió/);
  assert.equal((await api('POST', '/cronograma/colgar', { ids: [m.task_id], tipo: m.tipo, motivo: 'otra cosa' })).status, 403, 'Ventas no edita el cronograma');
  asUser = null;
  // Pasarlo a un día (el mismo que tenía) lo devuelve al cronograma.
  assert.equal((await api('POST', '/cronograma/mover', { ids: [m.task_id], tipo: m.tipo, fecha: m.fecha })).status, 200);
  v = (await api('GET', rango)).data;
  assert.ok(v.movimientos.some((x) => x.id === m.id), 'volvió a su día');
  assert.ok(!v.colgados.some((x) => x.id === m.id), 'y ya no está en Colgados');
});

// Pedidos de Producción (Rodrigo, 19/11/2026): el horario como rango desde la tarjeta, las anotaciones de logística con
// quién las escribió (para esta vez o para siempre) y la cantidad que realmente se manda (demasía).
test('cronograma: rango horario, anotaciones de logística con autor y cantidad enviada', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  const rango = '/cronograma?desde=2026-11-16&hasta=2026-11-22&rd=2026-10-12&rh=2026-12-20';
  const semana = async () => (await api('GET', rango)).data;
  let v = await semana();
  const ent = v.movimientos.find((x) => x.npdv === PDV && x.tipo === 'entrega' && x.record_id && x.parada);
  const otro = v.movimientos.find((x) => x.npdv === PDV && x.tipo !== 'entrega' && x.company_id && x.cantidad);
  assert.ok(ent && otro, 'hay una entrega y un movimiento con proveedor o impresor');

  // 1. El horario: un rango, que se ve en la tarjeta.
  const hora = (b) => api('PUT', '/cronograma/hora', { fecha: ent.fecha, clave: ent.parada, ...b });
  assert.equal((await hora({ modo: 'entre', hora: '13:00', hasta: '10:00' })).status, 400, 'la segunda hora tiene que ser más tarde');
  assert.equal((await hora({ modo: 'entre', hora: '10:00', hasta: '13:00' })).status, 200);
  assert.equal((await semana()).movimientos.find((x) => x.id === ent.id).hora, 'Entre las 10:00 y las 13:00');
  assert.equal((await hora({ modo: null })).status, 200);

  // 2. Anotaciones. La vendedora, desde su pedido: solo de la entrega, y queda con su nombre.
  const vende = (await api('POST', '/users', { email: `nota.${RUN}@formas.ar`, name: `Nota ${RUN}`, role: 'member' })).data;
  assert.equal((await api('PATCH', `/records/order/${ent.record_id}`, { props: { owner_id: vende.id } })).status, 200);
  asUser = `nota.${RUN}@formas.ar`;
  const n1 = await api('POST', '/logistica/notas', { record_id: ent.record_id, alcance: 'puntual', texto: 'Preguntar por Marta en recepción' });
  assert.equal(n1.status, 201, JSON.stringify(n1.data));
  assert.equal(n1.data.por, `Nota ${RUN}`);
  assert.equal((await api('POST', '/logistica/notas', { record_id: ent.record_id, alcance: 'puntual', texto: ' ' })).status, 400);
  asUser = null;
  // Producción, en la tarjeta de un proveedor o impresor: para siempre en ese lugar.
  const n2 = await api('POST', '/logistica/notas', { record_id: otro.record_id, tipo: otro.tipo, alcance: 'siempre', destino: { company_id: otro.company_id, nombre: otro.lugar }, texto: 'Reciben solo por el portón lateral' });
  assert.equal(n2.status, 201, JSON.stringify(n2.data));
  v = await semana();
  const notasDe = (id) => (v.movimientos.find((x) => x.id === id)?.notas ?? []).map((n) => [n.alcance, n.texto, n.por]);
  assert.deepEqual(notasDe(ent.id), [['puntual', 'Preguntar por Marta en recepción', `Nota ${RUN}`]]);
  assert.ok(notasDe(otro.id).some((n) => n[0] === 'siempre' && n[1] === 'Reciben solo por el portón lateral'), 'la de siempre, en la tarjeta de ese lugar');
  // La de siempre aparece en todo lo de esa empresa; la puntual, solo en la entrega de ese pedido.
  const delLugar = v.movimientos.filter((x) => x.tipo !== 'entrega' && x.company_id === otro.company_id);
  assert.ok(delLugar.every((x) => (x.notas ?? []).some((n) => n.id === n2.data.id)));
  assert.ok(!v.movimientos.some((x) => x.id !== ent.id && x.tipo !== 'entrega' && (x.notas ?? []).some((n) => n.id === n1.data.id)));
  // La vendedora también puede dejarla para todas las entregas a ese cliente: queda en el destino (la empresa del pedido o,
  // si no la tiene, el cliente del PDV) y aparece en sus entregas.
  asUser = `nota.${RUN}@formas.ar`;
  const n3 = await api('POST', '/logistica/notas', { record_id: ent.record_id, alcance: 'siempre', texto: 'Entregar siempre por la cochera' });
  assert.equal(n3.status, 201, JSON.stringify(n3.data));
  assert.ok(n3.data.destino, 'con el nombre del destino');
  asUser = null;
  const conSiempre = (await semana()).movimientos.filter((x) => x.tipo === 'entrega' && x.cliente === ent.cliente);
  assert.ok(conSiempre.length && conSiempre.every((x) => (x.notas ?? []).some((n) => n.id === n3.data.id)), 'en todas las entregas a ese cliente');
  assert.equal((await api('DELETE', `/logistica/notas/${n3.data.id}`)).status, 200);
  // El horario fijado se ve en la ficha del pedido.
  await hora({ modo: 'entre', hora: '10:00', hasta: '13:00' });
  assert.ok(Array.isArray((await api('GET', `/logistica/notas?record_id=${ent.record_id}`)).data.horarios));
  await hora({ modo: null });
  // En la ficha del pedido se leen; la vendedora borra la suya, no la de Producción.
  asUser = `nota.${RUN}@formas.ar`;
  assert.deepEqual((await api('GET', `/logistica/notas?record_id=${ent.record_id}`)).data.notas.filter((n) => n.alcance === 'puntual').map((n) => n.texto), ['Preguntar por Marta en recepción']);
  assert.equal((await api('DELETE', `/logistica/notas/${n2.data.id}`)).status, 403);
  assert.equal((await api('DELETE', `/logistica/notas/${n1.data.id}`)).status, 200);
  asUser = null;
  assert.equal((await api('DELETE', `/logistica/notas/${n2.data.id}`)).status, 200);

  // 3. La demasía: lo que realmente va, sin tocar la cantidad del PDV. No en las entregas.
  assert.equal((await api('POST', '/cronograma/enviado', { id: ent.task_id, tipo: 'entrega', cantidad: 5 })).status, 400);
  const env = await api('POST', '/cronograma/enviado', { id: otro.task_id, tipo: otro.tipo, cantidad: otro.cantidad + 10, motivo: 'Por si sale alguno fallado' });
  assert.equal(env.status, 200, JSON.stringify(env.data));
  const con = (await semana()).movimientos.find((x) => x.id === otro.id);
  assert.deepEqual([con.cantidad, con.enviado.cantidad, con.enviado.motivo], [otro.cantidad, otro.cantidad + 10, 'Por si sale alguno fallado']);
  // La misma cantidad del pedido lo saca.
  assert.equal((await api('POST', '/cronograma/enviado', { id: otro.task_id, tipo: otro.tipo, cantidad: otro.cantidad })).data.enviado, null);
  assert.ok(!(await semana()).movimientos.find((x) => x.id === otro.id).enviado);
});

// Desde la tarjeta de un encargo de Recorridos se anota lo de siempre de ese destino (sin pedido): aparece en los
// encargos a ese lugar, aunque el nombre esté escrito distinto.
test('cronograma: desde un encargo se anota lo de siempre de su destino', async () => {
  asUser = null;
  const hoy = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const lugar = `Estudio Contable ${RUN}`;
  const enc = await api('POST', '/recorridos/encargos', { fecha: hoy, destino: { nombre: lugar, direccion: `Av. Santa Fe ${Math.floor(Math.random() * 3000) + 100}, CABA` }, llevar: [{ cant: 1, que: 'Carpeta' }] });
  assert.equal(enc.status, 200, JSON.stringify(enc.data));
  assert.equal((await api('POST', '/logistica/notas', { alcance: 'puntual', texto: 'Sin pedido no hay «solo esta vez»' })).status, 400);
  const n = await api('POST', '/logistica/notas', { alcance: 'siempre', destino: { lugar_id: enc.data.lugar_id, company_id: enc.data.company_id, nombre: enc.data.destino }, texto: 'Dejar en mesa de entradas, 2° piso' });
  assert.equal(n.status, 201, JSON.stringify(n.data));
  assert.equal(n.data.destino, lugar);
  // Se lee por el destino, también con el nombre en mayúsculas y con «S.A.».
  const q = (nombre) => api('GET', `/logistica/notas?nombre=${encodeURIComponent(nombre)}`);
  assert.deepEqual((await q(`${lugar.toUpperCase()} S.A.`)).data.notas.map((x) => x.texto), ['Dejar en mesa de entradas, 2° piso']);
  assert.deepEqual((await q('Otro lugar cualquiera')).data.notas, []);
  // Y la trae el encargo en la semana.
  const lunes = (() => { const d = new Date(`${hoy}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const dom = new Date(Date.parse(`${lunes}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const e = (await api('GET', `/cronograma?desde=${lunes}&hasta=${dom}`)).data.encargos.find((x) => x.id === enc.data.id);
  assert.deepEqual((e.anotaciones ?? []).map((x) => x.texto), ['Dejar en mesa de entradas, 2° piso']);
  // Quien no edita el cronograma no ve las de un destino suelto.
  await api('POST', '/users', { email: `enc.${RUN}@formas.ar`, name: `Enc ${RUN}`, role: 'member' });
  asUser = `enc.${RUN}@formas.ar`;
  assert.equal((await q(lugar)).status, 403);
  asUser = null;
  assert.equal((await api('DELETE', `/logistica/notas/${n.data.id}`)).status, 200);
  await api('PATCH', `/recorridos/encargos/${enc.data.id}`, { estado: 'cancelado' });
});

// Un pedido que se reparte entre varios lugares (Rodrigo, 19/11/2026: 1.000 kits, 250 a la central, 500 a una sucursal y
// 250 a un depósito): cada lugar con su nombre, su cantidad y su anotación; en la ruta, cada parada con lo suyo.
test('cronograma: un pedido repartido en varias direcciones lleva a cada parada su lugar, su cantidad y su anotación', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  const { execFileSync } = await import('node:child_process');
  const sql = (command) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'formas-crm', '--local', '--command', command], { stdio: 'pipe' });
  const rango = '/cronograma?desde=2026-11-16&hasta=2026-11-22&rd=2026-10-12&rh=2026-12-20';
  const m = (await api('GET', rango)).data.movimientos.find((x) => x.npdv === PDV && x.tipo === 'entrega' && x.record_id && !x.hecho && x.articulo);
  assert.ok(m, 'hay una entrega pendiente del PDV');
  // El renglón del pedido de ese artículo (como cuando los productos llegan de ClickUp): 1.000 kits.
  const codigo = `KIT_${RUN}`.toUpperCase();
  sql(`DELETE FROM line_items WHERE record_id = ${m.record_id}; INSERT INTO line_items (record_id, position, code, name, quantity, source, status, clickup_task) VALUES (${m.record_id}, 0, '${codigo}', 'Kit ${RUN}', 1000, 'clickup', 'pdv', '${m.task_id}');`);
  const url = `/records/order/${m.record_id}/direcciones`;
  const lugares = [{ nombre: 'Central', direccion: `Av. Corrientes ${1000 + Math.floor(Math.random() * 500)}, CABA` },
    { nombre: 'Sucursal Santa Fe', direccion: `Bv. Pellegrini ${2000 + Math.floor(Math.random() * 500)}, Santa Fe`, observaciones: 'Entrar por el portón de atrás, preguntar por Ana' },
    { nombre: 'Depósito de stock', direccion: `Gral. Roca ${4000 + Math.floor(Math.random() * 200)}, Florida Oeste` }];
  const guardar = (cants) => api('PUT', url, { direcciones: lugares, cantidades: cants.map((cantidad, direccion) => ({ direccion, clave: codigo, cantidad })) });
  // Nunca más que el total del pedido.
  assert.equal((await guardar([250, 600, 250])).status, 400, 'no se reparte más de lo pedido');
  // La vendedora del pedido lo carga.
  const vende = (await api('POST', '/users', { email: `rep.${RUN}@formas.ar`, name: `Rep ${RUN}`, role: 'member' })).data;
  assert.equal((await api('PATCH', `/records/order/${m.record_id}`, { props: { owner_id: vende.id } })).status, 200);
  asUser = `rep.${RUN}@formas.ar`;
  const g = await guardar([250, 500, 250]);
  assert.equal(g.status, 200, JSON.stringify(g.data));
  asUser = null;
  const d = (await api('GET', url)).data;
  assert.deepEqual(d.direcciones.map((x) => [x.nombre, x.observaciones, x.obs_por]), [['Central', null, null], ['Sucursal Santa Fe', lugares[1].observaciones, `Rep ${RUN}`], ['Depósito de stock', null, null]]);
  assert.equal(d.sin_repartir, 0);
  // En la ruta de ese día: una parada por lugar, con su nombre, la cantidad que va ahí y su anotación (con quién la escribió).
  const ruta = (await api('GET', `/cronograma/ruta?fecha=${m.fecha}`)).data;
  const paradas = [`p:${m.pdv_task}`, `p:${m.pdv_task}:2`, `p:${m.pdv_task}:3`].map((c) => ruta.paradas.find((p) => p.clave === c));
  assert.ok(paradas.every(Boolean), 'las tres paradas');
  assert.deepEqual(paradas.map((p) => [p.sitio, p.movimientos.find((x) => x.task_id === m.task_id)?.cantidad]), [['Central', 250], ['Sucursal Santa Fe', 500], ['Depósito de stock', 250]]);
  assert.deepEqual(paradas.map((p) => [p.observaciones ?? null, p.observaciones_por ?? null]), [[null, null], [lugares[1].observaciones, `Rep ${RUN}`], [null, null]]);
  // En la tarjeta de la semana, cada lugar con lo que va ahí.
  const dirs = (await api('GET', `/cronograma/direcciones?desde=${m.fecha}&hasta=${m.fecha}`)).data.direcciones[`${m.fecha}|p:${m.pdv_task}`];
  assert.deepEqual(dirs.sitios, ['Central: 250', 'Sucursal Santa Fe: 500', 'Depósito de stock: 250']);
  // Cambiar el reparto sin tocar la anotación la deja con su autora.
  const conId = d.direcciones.map((x, i) => ({ id: x.id, ...lugares[i] }));
  const otra = await api('PUT', url, { direcciones: conId, cantidades: [300, 500, 200].map((cantidad, direccion) => ({ direccion, clave: codigo, cantidad })) });
  assert.equal(otra.status, 200, JSON.stringify(otra.data));
  assert.equal((await api('GET', url)).data.direcciones[1].obs_por, `Rep ${RUN}`, 'la anotación sigue a nombre de quien la escribió');
  // ---- La logística se bifurca: cada lugar con su día, su «hecho» y sus Colgados. La producción sigue siendo una.
  const [central, santaFe, deposito] = (await api('GET', url)).data.direcciones.map((x) => x.id);
  const suyos = async () => (await api('GET', rango)).data.movimientos.filter((x) => x.task_id === m.task_id && x.tipo === 'entrega').sort((a, b) => a.dir - b.dir);
  let ms = await suyos();
  assert.deepEqual(ms.map((x) => [x.dir, x.sitio, x.cantidad, x.fecha]), [[central, 'Central', 300, m.fecha], [santaFe, 'Sucursal Santa Fe', 500, m.fecha], [deposito, 'Depósito de stock', 200, m.fecha]], 'una entrega por lugar, el mismo día');
  // Santa Fe pasa a otro día: los otros dos quedan donde estaban.
  const otroDia = m.fecha === '2026-11-20' ? '2026-11-19' : '2026-11-20';
  assert.equal((await api('POST', '/cronograma/mover', { ids: [m.task_id], dirs: [santaFe], tipo: 'entrega', fecha: otroDia })).status, 200);
  ms = await suyos();
  assert.deepEqual(ms.map((x) => [x.sitio, x.fecha]), [['Central', m.fecha], ['Sucursal Santa Fe', otroDia], ['Depósito de stock', m.fecha]]);
  const clavesDe = async (dia) => (await api('GET', `/cronograma/ruta?fecha=${dia}`)).data.paradas.filter((p) => p.clave.startsWith(`p:${m.pdv_task}`)).map((p) => p.clave).sort();
  assert.deepEqual(await clavesDe(m.fecha), [`p:${m.pdv_task}`, `p:${m.pdv_task}:3`], 'en la ruta de ese día, los dos que quedaron');
  assert.deepEqual(await clavesDe(otroDia), [`p:${m.pdv_task}:2`], 'y Santa Fe, en la del otro día');
  // El depósito queda colgado: solo ese lugar. Pasarlo a un día lo devuelve.
  const col = await api('POST', '/cronograma/colgar', { ids: [m.task_id], dirs: [deposito], tipo: 'entrega', motivo: 'El depósito estaba cerrado' });
  assert.equal(col.status, 200, JSON.stringify(col.data));
  let v2 = (await api('GET', rango)).data;
  assert.deepEqual(v2.movimientos.filter((x) => x.task_id === m.task_id && x.tipo === 'entrega').map((x) => x.sitio).sort(), ['Central', 'Sucursal Santa Fe']);
  assert.deepEqual(v2.colgados.filter((x) => x.task_id === m.task_id).map((x) => [x.sitio, x.colgado.motivo]), [['Depósito de stock', 'El depósito estaba cerrado']]);
  assert.equal((await api('POST', '/cronograma/mover', { ids: [m.task_id], dirs: [deposito], tipo: 'entrega', fecha: m.fecha })).status, 200);
  assert.equal((await suyos()).length, 3, 'volvió al cronograma');
  // Hecho lugar por lugar: con uno, el artículo no está entregado todavía; con todos, sí.
  const hecho = (dirs, h = true) => api('POST', '/cronograma/hecho', { ids: dirs.map(() => m.task_id), dirs, tipo: 'entrega', hecho: h });
  assert.equal((await hecho([central])).status, 200);
  ms = await suyos();
  assert.deepEqual(ms.map((x) => [x.sitio, x.hecho]), [['Central', true], ['Sucursal Santa Fe', false], ['Depósito de stock', false]]);
  assert.notEqual(ms[0].estado, 'entregados', 'el artículo sigue abierto: faltan lugares');
  assert.equal((await hecho([santaFe, deposito])).status, 200);
  ms = await suyos();
  assert.ok(ms.every((x) => x.hecho), 'los tres hechos');
  assert.equal(ms[0].estado, 'entregados', 'con todos los lugares, el artículo queda entregado en ClickUp');
  // Desmarcar uno lo vuelve a abrir.
  assert.equal((await hecho([santaFe], false)).status, 200);
  ms = await suyos();
  assert.deepEqual(ms.map((x) => x.hecho), [true, false, true]);
  assert.notEqual(ms[0].estado, 'entregados');
  await hecho([central, deposito], false);
  // Vuelve a una sola dirección, para no cambiarles el día a las otras pruebas.
  await api('PUT', url, { direcciones: [] });
  await api('POST', '/cronograma/mover', { ids: [m.task_id], tipo: 'entrega', fecha: m.fecha });
  sql(`DELETE FROM line_items WHERE record_id = ${m.record_id};`);
});
