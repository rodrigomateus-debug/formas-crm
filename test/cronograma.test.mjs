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
  egresoImp: 'c278fabb-b558-4a28-a6f6-f6b26a8e29eb', retiroImp: '3146d848-4952-4ac8-aac4-971e1361609b', proveedor: 'fd7010e7-cece-4d06-850a-ce5e948c1f83',
  impresor: '555918b9-e727-4f89-aa67-b97a94dd6136', cantidad: 'eb9f3a13-3f31-4a2f-b924-3cfaec8d376f', unidad: '8dcf7531-1dad-45f5-aff3-bb9e45895c98',
};
const CAMPO = { [F.entrega]: 'entrega', [F.ingresoProv]: 'ingresoProv', [F.retiroProv]: 'retiroProv', [F.egresoImp]: 'egresoImp', [F.retiroImp]: 'retiroImp' };
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
      fecha(F.egresoImp, 'EGRESO (IMPRESOR)', f('egresoImp')), fecha(F.retiroImp, 'RETIRO (IMPRESOR)', f('retiroImp'))],
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
let consultasClaude = 0, consultasGeo = 0;

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
      if (p === '/geo') {
        consultasGeo++;
        const q = url.searchParams.get('q') ?? '';
        assert.ok(!/unidad 180/i.test(q), 'la unidad no va al buscador');
        if (/Roca 4250/.test(q)) return send([{ lat: '-34.5361', lon: '-58.5152' }]);
        if (/Matienzo 1308/.test(q)) return send([{ lat: '-34.5345', lon: '-58.5170' }]);
        if (q.includes(`Libertador ${PDV}`)) return send([{ lat: '-34.5270', lon: '-58.4760' }]);
        if (q.includes(`Nicaragua ${PDV_V}`)) return send([{ lat: '-34.6790', lon: '-58.3460' }]);
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
      if (p === '/fin/oauth/token') { res.setHeader('content-type', 'application/json'); return res.end('"token-de-prueba"'); }
      if (p.startsWith('/fin/pedidoVenta/')) return send({ Cliente: `C-${RUN}`, Items: [], DireccionEntrega: p.includes(PDV_V) ? `Nicaragua ${PDV_V}, Sarandí` : `Av. Libertador ${PDV} Piso 4, Vicente López` });
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
const T = `cr${RUN}-a0`, M = `cr${RUN}-a1`;

test('cronograma: los movimientos salen de las fechas de ClickUp, con sus avisos', async (t) => {
  asUser = null;
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }
  await sync(); await sync();
  const v = await semana();
  assert.equal(v.puede_editar, true);
  const propios = v.movimientos.filter((m) => m.npdv === PDV);
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
  assert.deepEqual(escrito.map((e) => e.task), [`cr${RUN}`], 'se escribió en la tarea del PDV');
  v = await semana();
  assert.equal(mov(v, 'entrega', 'Mochila').fecha, '2026-11-20');
  assert.equal(mov(v, 'entrega', 'Termo').fecha, '2026-11-18', 'el termo tiene su propia fecha: no se movió');
  // Quien solo mira no puede.
  await api('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vende ${RUN}`, profile: 'comercial' });
  asUser = `vende.${RUN}@formas.ar`;
  assert.equal((await api('POST', '/cronograma/mover', { ids: [T], tipo: 'egreso', fecha: '2026-11-17' })).status, 403);
  assert.equal((await semana()).puede_editar, false);
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
  assert.deepEqual(r.data, { cambiados: 1, estado: 'en el impresor' });
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
  // Entregado: todo lo anterior queda hecho, y marcar un retiro ya no vuelve el estado para atrás.
  r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'entrega', hecho: true });
  assert.deepEqual(r.data, { cambiados: 1, estado: 'entregados' });
  r = await api('POST', '/cronograma/hecho', { ids: [T], tipo: 'retiro_impresor', hecho: true });
  assert.equal(r.data.cambiados, 0);
  v = await semana();
  assert.ok(['ingreso', 'egreso', 'retiro_impresor', 'entrega'].every((tipo) => mov(v, tipo, 'Termo').hecho));
  assert.equal(mov(v, 'entrega', 'Termo').estado, 'entregados');
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

  // El 18/11: el retiro del impresor, con su dirección y su horario; el ingreso no es una parada.
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const imp = r.paradas.find((p) => p.company_id === imprefas);
  assert.equal(imp.direccion, `Cnel. Sayos ${PDV}, Lanús`);
  assert.deepEqual(imp.horario, [540, 780]);
  assert.equal(imp.lat, -34.699);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-16')).data;
  assert.ok(r.llegan.some((m) => m.npdv === PDV && m.tipo === 'ingreso'));
  assert.ok(!r.paradas.some((p) => p.movimientos.some((m) => m.npdv === PDV)));

  // Correr un punto en el mapa: queda ahí y no se vuelve a buscar.
  const geoAntes = consultasGeo;
  assert.equal((await api('PUT', '/cronograma/punto', { direccion: `Cnel. Sayos ${PDV}, Lanús`, lat: -34.7, lng: -58.39 })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const corrido = r.paradas.find((p) => p.company_id === imprefas);
  assert.deepEqual([corrido.lat, corrido.lng, corrido.punto_manual], [-34.7, -58.39, true]);
  assert.equal(consultasGeo, geoAntes);

  // Los recorridos del día: dos choferes, cada uno con su orden y su depósito.
  assert.equal(r.guardada, false);
  const claves = r.paradas.map((p) => p.clave);
  const ch = (await api('POST', '/choferes', { name: `Juan ${RUN}` })).data;
  const g = await api('PUT', '/cronograma/ruta', { fecha: '2026-11-18', rutas: [{ chofer: `Juan ${RUN}`, base: 'matienzo', salida: 480, orden: claves.slice(0, 1) }, { chofer: null, base: 'roca', salida: 540, orden: claves.slice(1) }] });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  assert.equal(r.guardada, true);
  assert.deepEqual(r.rutas.map((x) => [x.n, x.chofer, x.base, x.salida]), [[1, `Juan ${RUN}`, 'matienzo', 480], [2, null, 'roca', 540]]);
  assert.deepEqual(r.rutas[0].orden, claves.slice(0, 1));

  // El chofer ve su recorrido en la app de los remitos: solo el suyo, con sus paradas en orden.
  const suya = await fetch(`${BASE}/hooks/chofer/api/ruta?fecha=2026-11-18`, { headers: { authorization: `Bearer ${ch.token}` } });
  assert.equal(suya.status, 200);
  const rc = await suya.json();
  assert.equal(rc.recorridos.length, 1);
  assert.equal(rc.recorridos[0].base.nombre, 'Oficina Matienzo');
  assert.equal(rc.recorridos[0].salida, 480);
  assert.deepEqual(rc.recorridos[0].paradas.map((p) => p.clave), claves.slice(0, 1));
  assert.ok(rc.recorridos[0].paradas[0].movimientos.length >= 1);
  assert.equal((await fetch(`${BASE}/hooks/chofer/api/ruta`)).status, 401, 'sin el link del chofer no se ve');
  // El chofer marca la parada: no había nadie (queda a la vista de Logística) y después, hecha (cambia el estado en ClickUp).
  const marcar = async (cuerpo, token = ch.token) => { const x = await fetch(`${BASE}/hooks/chofer/api/ruta/parada`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ fecha: '2026-11-18', clave: claves[0], ...cuerpo }) }); return { status: x.status, data: await x.json() }; };
  assert.equal((await marcar({ resultado: 'no_se_pudo' })).status, 400, 'falta el motivo');
  assert.equal((await marcar({ resultado: 'no_se_pudo', motivo: 'nadie', nota: 'Vuelvo a las 15' })).status, 200);
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const vis = r.paradas.find((p) => p.clave === claves[0]).visita;
  assert.deepEqual([vis.resultado, vis.motivo, vis.nota, vis.chofer], ['no_se_pudo', 'nadie', 'Vuelvo a las 15', `Juan ${RUN}`]);
  escrito.length = 0;
  const pendientes = r.paradas.find((p) => p.clave === claves[0]).movimientos.filter((m) => !m.hecho).length;
  const hecha = await marcar({ resultado: 'hecho' });
  assert.equal(hecha.status, 200, JSON.stringify(hecha.data));
  r = (await api('GET', '/cronograma/ruta?fecha=2026-11-18')).data;
  const ya = r.paradas.find((p) => p.clave === claves[0]);
  assert.equal(ya.visita.resultado, 'hecho');
  assert.ok(ya.movimientos.every((m) => m.hecho), 'todo lo de la parada quedó hecho');
  assert.equal((await (await fetch(`${BASE}/hooks/chofer/api/ruta?fecha=2026-11-18`, { headers: { authorization: `Bearer ${ch.token}` } })).json()).recorridos[0].paradas[0].visita.resultado, 'hecho');
  assert.ok(pendientes === 0 || escrito.length > 0, 'lo pendiente cambió de estado en ClickUp');
  const otro = (await api('POST', '/choferes', { name: `Pedro ${RUN}` })).data;
  const nada = await (await fetch(`${BASE}/hooks/chofer/api/ruta?fecha=2026-11-18`, { headers: { authorization: `Bearer ${otro.token}` } })).json();
  assert.deepEqual(nada.recorridos, [], 'otro chofer no ve ese recorrido');
  assert.equal((await marcar({ resultado: 'hecho' }, otro.token)).status, 404, 'ni puede marcar una parada que no es suya');
});
