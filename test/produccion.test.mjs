// Producción en el CRM (produccion.ts): la vista de los PDV con sus artículos, contra un ClickUp simulado (puerto 8797).
// Necesita en .dev.vars las variables de .dev.vars.example (CLICKUP_* apuntando a localhost:8797).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const PDV = String(40000 + Math.floor(Math.random() * 20000));
const PDV_C = String(Number(PDV) + 1);   // de Corporate: se ve, pero se sigue trabajando en ClickUp
const PDV_Z = String(Number(PDV) + 2);   // de Formas Shop, con artículos sin proveedor: sale del SKU
let asUser = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

// ---------- ClickUp simulado ----------
const F = {
  entrega: '10e3d8d0-bbd5-47af-946b-504ef9804428', ingresoProv: '98df51eb-1142-4ff5-b80c-9fd239ea3aac', retiroProv: '7fd568b7-9cfd-45fc-9f05-22864a0b9e9a',
  egresoImp: 'c278fabb-b558-4a28-a6f6-f6b26a8e29eb', retiroImp: '3146d848-4952-4ac8-aac4-971e1361609b', proveedor: 'fd7010e7-cece-4d06-850a-ce5e948c1f83',
  impresor: '555918b9-e727-4f89-aa67-b97a94dd6136', cantidad: 'eb9f3a13-3f31-4a2f-b924-3cfaec8d376f', unidad: '8dcf7531-1dad-45f5-aff3-bb9e45895c98',
};
// Opciones con repetidas (como en la lista real): STOCK SUR / STOCKSUR, FYR SA / FYRSA, y STOCK que no es una empresa.
const OP_PROV = [{ id: `prov-stocksur-${RUN}`, name: `STOCK SUR ${RUN}`, orderindex: 0 }, { id: `prov-stock-${RUN}`, name: 'STOCK', orderindex: 1 }, { id: `prov-zecat-${RUN}`, name: `ZECAT ${RUN}`, orderindex: 2 }];
const OP_IMP = [{ id: `imp-fyr-${RUN}`, name: `FYR ${RUN} SA`, orderindex: 0 }, { id: `imp-fyrsa-${RUN}`, name: `FYR ${RUN} S.A.`, orderindex: 1 }, { id: `imp-stocksur-${RUN}`, name: `STOCKSUR ${RUN}`, orderindex: 2 }];
const OP_UNIDAD = [{ id: 'u-shop', name: 'FORMAS SHOP', orderindex: 0 }, { id: 'u-corp', name: 'CORPORATE ', orderindex: 1 }];
const dd = (id, name, value, options) => ({ id, name, type: 'drop_down', value, type_config: { options } });
const fecha = (id, name, dia) => ({ id, name, type: 'date', value: dia ? String(Date.parse(`${dia}T15:00:00Z`)) : null });
const FOTO_NEC = `https://example.com/necessaire-${RUN}.jpg`;
const CECI = { id: 9001, username: `Ceci ${RUN}`, email: `ceci.${RUN}@formas.ar`, initials: 'CE', color: '#7b68ee', profilePicture: null };
const SOLE = { id: 9002, username: `Sole ${RUN}`, email: `sole.${RUN}@formas.ar`, initials: 'SO', color: '#e5484d', profilePicture: 'https://example.com/sole.png' };

const estado = { arts: {}, pdv: {} };   // lo que el CRM cambió en ClickUp
const escrito = [];                      // cada escritura que recibió ClickUp
function articulo(pdvId, i, unidad, base) {
  const id = `${pdvId}-a${i}`;
  const e = estado.arts[id] ?? {};
  return {
    id, name: `${base.nombre} - Proveedor`, parent: pdvId, url: `https://app.clickup.com/t/${id}`, date_updated: String(e.updated ?? base.updated), orderindex: String(i),
    status: { status: e.status ?? base.status }, assignees: e.assignees ?? base.assignees ?? [], tags: [],
    text_content: `Producto: ${base.nombre}\nCantidad: ${base.cantidad}\nCódigo: ${base.codigo}`,
    custom_fields: [
      dd(F.unidad, 'UNIDAD DE NEGOCIO', unidad === 'CORPORATE' ? 'u-corp' : 'u-shop', OP_UNIDAD),
      { id: F.cantidad, name: 'CANTIDAD ', type: 'number', value: String(base.cantidad) },
      dd(F.proveedor, 'PROVEEDOR', e.proveedor !== undefined ? e.proveedor : base.proveedor ?? null, OP_PROV),
      dd(F.impresor, 'IMPRESOR', base.impresor ?? null, OP_IMP),
      fecha(F.entrega, 'ENTREGAS (FECHA REAL)', 'miercoles' in base ? base.miercoles : '2026-11-18'),
      fecha(F.ingresoProv, 'INGRESO (PROVEEDOR)', base.ingresoProv ?? null),
      fecha(F.retiroProv, 'RETIROS (PROVEEDOR)', null),
      fecha(F.egresoImp, 'EGRESO (IMPRESOR)', e.egresoImp !== undefined ? e.egresoImp : null),
      fecha(F.retiroImp, 'RETIRO (IMPRESOR)', null),
    ],
  };
}
const ARTS = {
  shop: [
    { nombre: `Necessaire ${RUN}`, codigo: `NEC_${RUN}`, cantidad: 600, status: 'en revision', proveedor: OP_PROV[0].id, impresor: OP_IMP[0].id, assignees: [CECI], ingresoProv: '2026-11-10', updated: 0 },
    { nombre: `Pelota ${RUN}`, codigo: 'PEL_1', cantidad: 600, status: 'listo para entergar', proveedor: OP_PROV[1].id, impresor: OP_IMP[1].id, assignees: [SOLE], updated: 0 },
    { nombre: `Set pinturas ${RUN}`, codigo: 'SET_1', cantidad: 250, status: 'listo para entergar', proveedor: OP_PROV[0].id, assignees: [], updated: 0 },
    { nombre: `Taza anulada ${RUN}`, codigo: 'TAZ_1', cantidad: 10, status: 'anulado', updated: 0 },
  ],
  corp: [{ nombre: `Mochila ${RUN}`, codigo: 'MOC_1', cantidad: 100, status: 'en revision', impresor: OP_IMP[2].id, assignees: [CECI], updated: 0 },
    { nombre: `Remera ${RUN}`, codigo: `ZEC-R${RUN}`, cantidad: 5, status: 'pdv', updated: 0 }],
  // El proveedor por el SKU: ZEC es Zecat (hay opción); MYA es Maya (no hay opción); el que ya tiene proveedor, el
  // anulado y el que no empieza con un prefijo de importador no se tocan.
  sku: [
    { nombre: `Mochila Zecat ${RUN}`, codigo: `ZEC-${RUN}`, cantidad: 50, status: 'pdv', updated: 0 },
    { nombre: `Botella Maya ${RUN}`, codigo: `MYA\\_${RUN}`, cantidad: 20, status: 'pdv', updated: 0 },
    { nombre: `Gorro ${RUN}`, codigo: `ZEC-G${RUN}`, cantidad: 30, status: 'pdv', proveedor: OP_PROV[1].id, updated: 0 },
    { nombre: `Lapicera ${RUN}`, codigo: `ZEC-L${RUN}`, cantidad: 10, status: 'anulado', updated: 0 },
    { nombre: `Taza ${RUN}`, codigo: `TAZ_Z${RUN}`, cantidad: 10, status: 'pdv', updated: 0 },
  ],
};
function pdvTask(id, npdv, unidad, arts) {
  const updated = Date.now();
  const subtasks = arts.map((a, i) => articulo(id, i, unidad, { ...a, updated: a.updated || updated }));
  return {
    id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: String(estado.pdv[id]?.updated ?? updated), status: { status: 'pdv' },
    assignees: estado.pdv[id]?.assignees ?? [CECI], tags: [{ name: 'urgente' }],
    text_content: `Pedido: PEDVTASTP - ${npdv}\nCliente: Gador ${RUN} S.A.\nVendedor: Rodrigo Mateus\nEs evento: No\nFecha entrega: 25-11-2026`,
    custom_fields: [{ id: 'c0ead31a-5a3e-4a89-b666-f2d282a6f921', name: 'N° PDV', type: 'short_text', value: `PDV - ${npdv}` },
      { id: '55db0f4f-7ab0-4b56-8bde-417e31f44c88', name: 'CLIENTE', type: 'short_text', value: `Gador ${RUN} S.A.` },
      { name: '🧑‍💻 VENDEDOR', type: 'short_text', value: 'Rodrigo Mateus' },
      dd(F.unidad, 'UNIDAD DE NEGOCIO', unidad === 'CORPORATE' ? 'u-corp' : 'u-shop', OP_UNIDAD), fecha(F.entrega, 'ENTREGAS (FECHA REAL)', '2026-11-18')],
    subtasks,
  };
}
const PDVS = () => [pdvTask(`pa${RUN}`, PDV, 'FORMAS SHOP', ARTS.shop), pdvTask(`pc${RUN}`, PDV_C, 'CORPORATE', ARTS.corp), pdvTask(`pz${RUN}`, PDV_Z, 'FORMAS SHOP', ARTS.sku)];

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
      const tarea = p.match(/^\/clickup\/task\/([^/]+)/)?.[1];
      if (tarea && req.method !== 'GET') {
        escrito.push({ method: req.method, task: tarea, path: p, body: json });
        const e = (estado.arts[tarea] ??= {});
        e.updated = Date.now();
        if (json?.status) e.status = json.status;
        if (json?.assignees) {
          const actual = (tarea.startsWith('p') && !tarea.includes('-a') ? estado.pdv[tarea]?.assignees ?? [CECI] : e.assignees ?? []);
          const nuevos = [...actual.filter((a) => !json.assignees.rem.includes(a.id)), ...[CECI, SOLE].filter((a) => json.assignees.add.includes(a.id))];
          if (tarea.includes('-a')) e.assignees = nuevos; else estado.pdv[tarea] = { ...(estado.pdv[tarea] ?? {}), assignees: nuevos, updated: Date.now() };
        }
        if (p.endsWith(`/field/${F.proveedor}`)) e.proveedor = req.method === 'DELETE' ? null : json.value;
        if (p.endsWith(`/field/${F.egresoImp}`)) e.egresoImp = req.method === 'DELETE' ? null : new Date(json.value - 3 * 3600_000).toISOString().slice(0, 10);
        return send({});
      }
      // «ingreso de pedido» viene con un color con nombre de ClickUp, no en hex.
      if (p === '/clickup/list/901326159292') return send({ statuses: [{ status: 'ingreso de pedido', color: 'var(--cu-status-red)', type: 'open' }, { status: 'pdv', color: '#a18072', type: 'unstarted' }, { status: 'en revision', color: '#0f9d9f', type: 'custom' },
        { status: 'en el impresor', color: '#ffc53d', type: 'custom' }, { status: 'listo para entergar', color: '#008844', type: 'custom' },
        { status: 'anulado', color: '#8d8d8d', type: 'done' }, { status: 'entregados', color: '#008844', type: 'closed' }] });
      if (p === '/clickup/list/901326159292/task') {
        const since = Number(url.searchParams.get('date_updated_gt') ?? 0);
        const tasks = PDVS().flatMap((t) => [t, ...t.subtasks]).filter((t) => Number(t.date_updated) > since);
        return send({ tasks, last_page: true });
      }
      // Finnegans: el pedido sin renglones, así los productos salen de los artículos de ClickUp.
      if (p === '/fin/oauth/token') { res.setHeader('content-type', 'application/json'); return res.end('"token-de-prueba"'); }
      if (p.startsWith('/fin/pedidoVenta/')) return send({ Items: [] });
      // La ficha del Necessaire tiene foto: es la que se ve en el pedido y en Producción.
      if (p === `/fin/producto/NEC_${RUN}`) return send({ Nombre: 'Necessaire', ProductoImagen: FOTO_NEC });
      if (p.startsWith('/fin/producto/')) return send({ Nombre: 'Producto' });
      const t = PDVS().find((x) => x.id === tarea);
      if (t) return send(t);
      return send({ err: 'no' }, 404);
    });
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => server?.close());

const sync = () => api('POST', '/integrations/clickup/sync', { full: true });
const vista = async (q = '') => (await api('GET', `/produccion${q}`)).data;
const pdvDe = (v, npdv) => v.pdvs.find((x) => x.npdv === npdv);

test('producción: los PDV con sus artículos, el estado general sale de los artículos y los proveedores son empresas', async (t) => {
  asUser = null;
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }
  // Ceci tiene usuario en el CRM (perfil Producción): en la vista sale con su usuario.
  await api('POST', '/users', { email: CECI.email, name: `Ceci ${RUN}`, profile: 'produccion' });
  await sync();
  await sync();   // la segunda vuelta ata las opciones de proveedor e impresor a sus empresas
  const v = await vista();
  assert.deepEqual(v.unidades, ['FORMAS SHOP'], 'arranca con Formas Shop');
  // Los colores de los estados, los de ClickUp (también los que tienen nombre).
  assert.equal(v.estados.find((e) => e.status === 'en revision')?.color, '#0f9d9f');
  assert.equal(v.estados.find((e) => e.status === 'ingreso de pedido')?.color, '#d33d44');
  const pdv = pdvDe(v, PDV);
  assert.ok(pdv, 'está el PDV de Formas Shop');
  assert.ok(!pdvDe(v, PDV_C), 'el de Corporate no, salvo que se pida');
  assert.equal(pdv.editable, true);
  assert.equal(pdv.etapa, '1237498994', 'algo en revisión: en producción');
  assert.equal(pdv.etapa_auto, true);
  assert.deepEqual([pdv.listos, pdv.total], [2, 3], 'dos listos de tres (el anulado no cuenta)');
  assert.equal(pdv.articulos.length, 3, 'el anulado no se muestra');
  assert.ok(pdv.record_id, 'atado a su pedido del CRM');
  assert.equal(pdv.entrega_real, '2026-11-18');
  assert.deepEqual(pdv.etiquetas, ['urgente']);
  const nec = pdv.articulos.find((a) => a.nombre.startsWith('Necessaire'));
  assert.equal(nec.estado, 'en revision');
  assert.equal(nec.cantidad, 600);
  assert.equal(nec.proveedor, OP_PROV[0].id);
  assert.equal(nec.ingreso_proveedor, '2026-11-10');
  assert.deepEqual(nec.asignados, [CECI.id]);
  assert.deepEqual(new Set(pdv.asignados_todos), new Set([CECI.id, SOLE.id]), 'el PDV junta a quienes tienen sus artículos');
  // La gente: Ceci con su usuario del CRM; Sole, que no tiene, con su foto de ClickUp.
  const ceci = v.personas.find((x) => x.clickup_id === CECI.id);
  assert.ok(ceci.user_id, 'Ceci con su usuario');
  assert.equal(v.personas.find((x) => x.clickup_id === SOLE.id).foto, SOLE.profilePicture);
  // Proveedores e impresores: las repetidas en la misma empresa; STOCK sin empresa.
  const op = (campo, id) => v.opciones.find((o) => o.campo === campo && o.option_id === id);
  assert.ok(op('impresor', OP_IMP[0].id).company_id);
  assert.equal(op('impresor', OP_IMP[0].id).company_id, op('impresor', OP_IMP[1].id).company_id, 'FYR SA y FYR S.A. son la misma');
  assert.equal(op('proveedor', OP_PROV[0].id).company_id, op('impresor', OP_IMP[2].id).company_id, 'STOCK SUR y STOCKSUR son la misma');
  assert.equal(op('proveedor', OP_PROV[1].id).company_id, null, 'STOCK no es una empresa');
  const stockSur = (await api('GET', `/records/company/${op('proveedor', OP_PROV[0].id).company_id}`)).data.record;
  assert.equal(stockSur.props.tipo_de_relacion, 'proveedor');
  assert.deepEqual(stockSur.props.proveedor_de.split(';').sort(), ['articulos', 'impresion'], 'da artículos y también imprime');
  // En la ficha de la empresa, lo que tiene en producción.
  const deStock = (await api('GET', `/records/company/${stockSur.id}/produccion`)).data;
  assert.ok(deStock.articulos.some((a) => a.nombre.startsWith('Necessaire') && a.rol === 'proveedor'));
  // Corporate, si se pide.
  const corp = pdvDe(await vista('?unidades=CORPORATE'), PDV_C);
  assert.ok(corp);
  assert.equal(corp.editable, false, 'Corporate se sigue trabajando en ClickUp');
});

test('producción: editar desde el CRM escribe en ClickUp y cambia el pedido', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  const pdv = pdvDe(await vista(), PDV);
  const nec = pdv.articulos.find((a) => a.nombre.startsWith('Necessaire'));
  // Una vendedora no edita producción.
  const vende = `vende.${RUN}@formas.ar`;
  await api('POST', '/users', { email: vende, name: `Vende ${RUN}` });
  asUser = vende;
  assert.equal((await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'estado', valor: 'listo para entergar' })).status, 403);
  // Ceci (perfil Producción) sí.
  asUser = CECI.email;
  escrito.length = 0;
  // El estado: a ClickUp y, como ya están todos listos, el pedido pasa a «Listo para entregar».
  let r = await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'estado', valor: 'listo para entergar' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(escrito[0], { method: 'PUT', task: nec.task_id, path: `/clickup/task/${nec.task_id}`, body: { status: 'listo para entergar' } });
  assert.equal(r.data.pdv.articulos.find((a) => a.task_id === nec.task_id).estado, 'listo para entergar');
  assert.equal(r.data.pdv.etapa, '1237498996');
  const pedido = (await api('GET', `/records/order/${pdv.record_id}`)).data.record;
  assert.equal(pedido.props.hs_pipeline_stage, '1237498996', 'el pedido ya está «Listo para entregar», sin esperar la sincronización');
  // En la conversación del pedido: el cambio del artículo, a nombre de Ceci, una sola vez (la sincronización no lo repite).
  await sync();
  const conv = (await api('GET', `/records/order/${pdv.record_id}/conversacion`)).data;
  const cambios = conv.items.filter((i) => i.kind === 'articulo' && i.articulo === nec.nombre && i.despues === 'listo para entergar');
  assert.equal(cambios.length, 1, JSON.stringify(conv.items.filter((i) => i.kind === 'articulo')));
  assert.equal(cambios[0].source, 'crm');
  // Un estado que no existe no va.
  assert.equal((await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'estado', valor: 'inventado' })).status, 400);
  // Fecha: al mediodía de Buenos Aires; vacía, se borra.
  escrito.length = 0;
  r = await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'egreso_impresor', valor: '2026-11-13' });
  assert.equal(r.status, 200);
  assert.equal(escrito[0].method, 'POST');
  assert.equal(escrito[0].path, `/clickup/task/${nec.task_id}/field/${F.egresoImp}`);
  assert.equal(escrito[0].body.value, Date.UTC(2026, 10, 13, 15));
  assert.equal(r.data.pdv.articulos.find((a) => a.task_id === nec.task_id).egreso_impresor, '2026-11-13');
  r = await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'egreso_impresor', valor: '' });
  assert.equal(escrito[1].method, 'DELETE');
  assert.equal(r.data.pdv.articulos.find((a) => a.task_id === nec.task_id).egreso_impresor, null);
  // Proveedor: la opción de ClickUp.
  escrito.length = 0;
  r = await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'proveedor', valor: OP_PROV[2].id });
  assert.equal(r.status, 200);
  assert.deepEqual(escrito[0].body, { value: OP_PROV[2].id });
  assert.equal((await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'proveedor', valor: 'no-existe' })).status, 400);
  // Asignados: se suma Sole y se saca Ceci.
  escrito.length = 0;
  r = await api('PATCH', `/produccion/${nec.task_id}`, { campo: 'asignados', valor: [SOLE.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(escrito[0].body, { assignees: { add: [SOLE.id], rem: [CECI.id] } });
  assert.deepEqual(r.data.pdv.articulos.find((a) => a.task_id === nec.task_id).asignados, [SOLE.id]);
  // Lo que se cambió en el CRM no se pierde con la próxima sincronización (ClickUp ya lo tiene).
  asUser = null;
  await sync();
  const despues = pdvDe(await vista(), PDV).articulos.find((a) => a.task_id === nec.task_id);
  assert.deepEqual([despues.estado, despues.proveedor, despues.asignados], ['listo para entergar', OP_PROV[2].id, [SOLE.id]]);
  // Un cambio hecho en ClickUp llega con la sincronización y queda en la conversación del pedido.
  const pelota = pdvDe(await vista(), PDV).articulos.find((a) => a.nombre.startsWith(`Pelota ${RUN}`));
  estado.arts[pelota.task_id] = { ...(estado.arts[pelota.task_id] ?? {}), status: 'en el impresor', updated: Date.now() };
  await sync();
  const enConv = (await api('GET', `/records/order/${pdv.record_id}/conversacion`)).data.items.filter((i) => i.kind === 'articulo' && i.source === 'clickup');
  assert.deepEqual(enConv.map((i) => [i.antes, i.despues]), [['listo para entergar', 'en el impresor']], JSON.stringify(enConv));
  estado.arts[pelota.task_id] = { ...estado.arts[pelota.task_id], status: 'listo para entergar', updated: Date.now() + 1 };
  await sync();
  // Corporate no se edita desde el CRM… hasta que el administrador lo habilita.
  const corp = pdvDe(await vista('?unidades=CORPORATE'), PDV_C);
  asUser = CECI.email;
  r = await api('PATCH', `/produccion/${corp.articulos[0].task_id}`, { campo: 'estado', valor: 'en el impresor' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /ClickUp/);
  assert.equal((await api('PUT', '/produccion/config', { unidades: ['FORMAS SHOP', 'CORPORATE'] })).status, 403, 'la configuración es del administrador');
  asUser = null;
  assert.deepEqual((await api('PUT', '/produccion/config', { unidades: ['FORMAS SHOP', 'CORPORATE', 'inventada'] })).data, { unidades: ['FORMAS SHOP', 'CORPORATE'] });
  asUser = CECI.email;
  assert.equal((await api('PATCH', `/produccion/${corp.articulos[0].task_id}`, { campo: 'estado', valor: 'en el impresor' })).status, 200);
  asUser = null;
  await api('PUT', '/produccion/config', { unidades: ['FORMAS SHOP'] });
});

test('producción: la vendedora ve quién lo tiene asignado, en la tarjeta y en cada producto', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  const pdv = pdvDe(await vista(), PDV);
  const prods = (await api('GET', `/records/order/${pdv.record_id}/products?refresh=1`)).data;
  assert.ok(prods.produccion, 'el resumen de producción del pedido');
  assert.ok(prods.produccion.asignados.some((p) => p.nombre === `Ceci ${RUN}` && p.user_id), 'Ceci, con su usuario');
  assert.deepEqual([prods.produccion.listos, prods.produccion.total], [3, 3]);
  assert.ok(prods.items.some((i) => i.status === 'listo para entergar' && i.status_color === '#008844'), 'cada producto con el color de su estado');
  const conAsignado = prods.items.filter((i) => i.asignados?.length);
  assert.ok(conAsignado.length, 'cada producto con quien lo tiene');
  // En Producción, cada artículo con la foto de su producto en el pedido.
  const conFoto = pdvDe(await vista(), PDV).articulos;
  assert.equal(conFoto.find((a) => a.nombre.startsWith('Necessaire')).foto, FOTO_NEC, 'la misma foto que en el pedido');
  assert.equal(conFoto.find((a) => a.nombre.startsWith('Pelota')).foto, null, 'sin foto, sin foto');
  // La tarjeta del tablero de pedidos.
  const tablero = (await api('GET', `/board-prop/order?prop=hs_pipeline_stage&q=${PDV}`)).data;
  const card = tablero.columns.flatMap((c) => c.records).find((r) => r.id === pdv.record_id);
  assert.ok(card?.adjuntos?.produccion, 'la tarjeta trae producción');
  assert.ok(card.adjuntos.produccion.asignados.some((p) => p.nombre === `Ceci ${RUN}`));
});

test('producción: el proveedor que falta sale del SKU y se escribe en ClickUp', async (t) => {
  asUser = null;
  if (!(await api('GET', '/integrations/pedidos')).data.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba'); return; }
  await sync();
  const z = pdvDe(await vista(), PDV_Z);
  assert.ok(z, 'está el PDV');
  const art = (n) => z.articulos.find((a) => a.nombre.startsWith(n));
  const moch = art('Mochila Zecat');
  assert.match(moch.proveedor ?? '', /^prov-zecat-/, 'ZEC: la opción de Zecat');
  assert.equal(estado.arts[moch.task_id]?.proveedor, moch.proveedor, 'escrito en ClickUp');
  assert.equal(moch.proveedor_sku, `ZEC-${RUN}`, 'se ve que salió del SKU');
  assert.equal(art('Botella Maya').proveedor, null, 'Maya no tiene opción en el desplegable: queda vacío');
  assert.equal(estado.arts[art('Botella Maya').task_id]?.proveedor, undefined);
  assert.equal(art('Gorro').proveedor, OP_PROV[1].id, 'lo que eligió una persona no se toca');
  assert.equal(art('Gorro').proveedor_sku, null);
  assert.equal(art('Taza').proveedor, null, 'sin prefijo de importador');
  assert.equal(estado.arts[`pz${RUN}-a3`]?.proveedor, undefined, 'el anulado no');
  const remera = pdvDe(await vista('?unidades=CORPORATE'), PDV_C).articulos.find((a) => a.nombre.startsWith('Remera'));
  assert.equal(remera.proveedor, null, 'Corporate se sigue trabajando en ClickUp');
  // Si en ClickUp lo vacían (o lo cambian), el CRM no lo vuelve a poner.
  estado.arts[moch.task_id] = { ...estado.arts[moch.task_id], proveedor: null, updated: Date.now() };
  await sync();
  const despues = pdvDe(await vista(), PDV_Z).articulos.find((a) => a.task_id === moch.task_id);
  assert.equal(despues.proveedor, null);
  assert.equal(estado.arts[moch.task_id].proveedor, null);
  assert.equal(despues.proveedor_sku, null);
});
