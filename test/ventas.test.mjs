// Perfil Ventas (src/worker/alcance.ts): una vendedora (perfil Comercial, no administradora) ve lo suyo, lo que no tiene
// propietario y lo asociado a lo suyo; no ve lo de otra vendedora, ni Producción, ni Entregas, ni exporta ni importa.
// Lo mismo con Claude (MCP). Los demás perfiles siguen viendo todo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const crear = async (type, props, associations) => {
  const r = await call('POST', `/records/${type}`, { props, associations });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const ids = (list) => list.map((r) => r.id);

test('perfil Ventas: lo suyo, lo sin dueño y lo asociado; nada de otra vendedora', async () => {
  const vera = (await call('POST', '/users', { email: `vera.${RUN}@formas.ar`, name: `Vera ${RUN}`, profile: 'comercial', role: 'manager' })).data;
  const olga = (await call('POST', '/users', { email: `olga.${RUN}@formas.ar`, name: `Olga ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const pia = (await call('POST', '/users', { email: `pia.${RUN}@formas.ar`, name: `Pia ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const V = { 'x-dev-user': vera.email };
  const deal = (name, owner, associations) => crear('deal', { dealname: `${name} ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: owner }, associations);

  // De Olga: una empresa con su negocio, su contacto y su pedido; otra empresa suelta.
  const empOlga = await crear('company', { name: `Empresa Olga ${RUN}`, owner_id: olga.id });
  const contOlga = await crear('contact', { firstname: 'Carla', lastname: `Olga ${RUN}`, email: `carla.${RUN}@cliente.com`, owner_id: olga.id }, [empOlga.id]);
  const negOlga = await deal('Negocio Olga', olga.id, [empOlga.id]);
  const pedOlga = await crear('order', { hs_order_name: `Pedido Olga ${RUN}`, owner_id: olga.id }, [negOlga.id]);
  const suelta = await crear('company', { name: `Suelta Olga ${RUN}`, domain: `suelta-${RUN}.com`, owner_id: olga.id });
  // De Vera: su empresa, y un negocio con la empresa de Olga (cliente compartido) con un pedido que cargó Olga.
  const empVera = await crear('company', { name: `Empresa Vera ${RUN}`, owner_id: vera.id });
  const negVera = await deal('Negocio Vera', vera.id, [empOlga.id]);
  const pedVera = await crear('order', { hs_order_name: `Pedido Vera ${RUN}`, owner_id: olga.id }, [negVera.id]);
  // Sin propietario: un lead para tomar.
  const libre = await crear('contact', { firstname: 'Lead', lastname: `Libre ${RUN}` });
  assert.equal((await call('PATCH', `/records/contact/${libre.id}`, { props: { owner_id: null } })).data.props.owner_id ?? null, null);

  // Listas y tableros: lo suyo, lo sin dueño y lo asociado a lo suyo.
  const empresas = ids((await call('GET', `/records/company?q=${RUN}`, undefined, V)).data.results);
  assert.ok(empresas.includes(empVera.id) && empresas.includes(empOlga.id), 'la suya y la de su negocio');
  assert.ok(!empresas.includes(suelta.id), 'no la de otra vendedora');
  const negocios = ids((await call('GET', `/records/deal?q=${RUN}`, undefined, V)).data.results);
  assert.deepEqual([negocios.includes(negVera.id), negocios.includes(negOlga.id)], [true, false], 'un negocio ajeno no se ve aunque sea de una empresa que ve');
  const pedidos = ids((await call('GET', `/records/order?q=${RUN}`, undefined, V)).data.results);
  assert.deepEqual([pedidos.includes(pedVera.id), pedidos.includes(pedOlga.id)], [true, false], 'los pedidos de sus negocios');
  const contactos = ids((await call('GET', `/records/contact?q=${RUN}`, undefined, V)).data.results);
  assert.deepEqual([contactos.includes(libre.id), contactos.includes(contOlga.id)], [true, false], 'el lead sin dueño sí; el contacto de Olga no');
  const tablero = (await call('GET', '/board?pipeline=default', undefined, V)).data;
  assert.ok(!tablero.columns.flatMap((c) => ids(c.deals)).includes(negOlga.id), 'tampoco en el tablero');

  // La ficha: lo ajeno no se abre (ni su actividad, historial o conversación) y lo que ve no muestra lo ajeno asociado.
  const ajeno = await call('GET', `/records/deal/${negOlga.id}`, undefined, V);
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.data.ajeno, true);
  assert.match(ajeno.data.error, new RegExp(`es de Olga ${RUN}`));
  for (const sub of ['timeline', 'history', 'conversacion']) assert.equal((await call('GET', `/records/deal/${negOlga.id}/${sub}`, undefined, V)).status, 403, sub);
  assert.equal((await call('GET', `/records/order/${pedOlga.id}`, undefined, V)).status, 403);
  const ficha = (await call('GET', `/records/company/${empOlga.id}`, undefined, V)).data;
  assert.deepEqual(ids(ficha.associations.deal), [negVera.id], 'en la empresa, solo su negocio');
  assert.deepEqual(ids(ficha.associations.contact), [], 'y no el contacto de Olga');
  assert.equal((await call('GET', `/records/order/${pedVera.id}`, undefined, V)).status, 200);

  // La actividad de lo ajeno no se suma en la empresa que comparten.
  const nota = (await call('POST', '/activities', { type: 'note', body: `Nota Olga ${RUN}`, links: [negOlga.id] })).data;
  const tlVera = (await call('GET', `/records/company/${empOlga.id}/timeline`, undefined, V)).data;
  assert.ok(!ids(tlVera.activities).includes(nota.id), 'Vera no ve la nota del negocio de Olga');
  assert.ok(ids((await call('GET', `/records/company/${empOlga.id}/timeline`)).data.activities).includes(nota.id), 'un admin sí');
  assert.equal((await call('GET', `/activities/${nota.id}`, undefined, V)).status, 403);

  // Tareas: las suyas y las de sus registros, aunque las tenga otra.
  const tOlga = (await call('POST', '/activities', { type: 'task', subject: `Tarea Olga ${RUN}`, owner_id: olga.id, links: [negOlga.id] })).data;
  const tEnLoDeVera = (await call('POST', '/activities', { type: 'task', subject: `Tarea en lo de Vera ${RUN}`, owner_id: olga.id, links: [empVera.id] })).data;
  const tareas = ids((await call('GET', `/tasks?owner=all&status=all&q=${RUN}`, undefined, V)).data.results);
  assert.deepEqual([tareas.includes(tEnLoDeVera.id), tareas.includes(tOlga.id)], [true, false]);

  // Cambiar, asociar o anotar en lo ajeno: no.
  assert.equal((await call('PATCH', `/records/deal/${negOlga.id}`, { props: { amount: 1 } }, V)).status, 403);
  assert.equal((await call('POST', '/associations', { from_id: negVera.id, to_id: suelta.id }, V)).status, 403);
  assert.equal((await call('POST', '/activities', { type: 'note', body: 'x', links: [suelta.id] }, V)).status, 403);
  assert.equal((await call('POST', '/records/deal/batch', { ids: [negVera.id, negOlga.id], props: { amount: 5000 } }, V)).data.failed.map((f) => f.id).join(), String(negOlga.id));
  // Tomar un lead sin dueño: queda de ella.
  assert.equal((await call('PATCH', `/records/contact/${libre.id}`, { props: { owner_id: vera.id } }, V)).status, 200);
  // Lo que crea queda a su nombre; si ya existe y es de otra, se le dice de quién.
  const nuevo = (await call('POST', '/records/company', { props: { name: `Nueva Vera ${RUN}` } }, V)).data;
  assert.equal(Number(nuevo.props.owner_id), vera.id);
  const dup = await call('POST', '/records/company', { props: { name: 'Dup', domain: `suelta-${RUN}.com` } }, V);
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, new RegExp(`de Olga ${RUN}`));

  // El buscador avisa que ya existe (solo nombre y de quién es) sin dejarlo abrir.
  const busqueda = (await call('GET', `/search?q=${encodeURIComponent(`Suelta Olga ${RUN}`)}`, undefined, V)).data;
  const marca = busqueda.company.find((r) => r.id === suelta.id);
  assert.equal(marca?.ajeno, true);
  assert.deepEqual(marca.props, { owner_id: olga.id }, 'sin el dominio ni otros datos');
  assert.ok(!busqueda.deal.length);

  // Inicio: sus números, no los del equipo.
  assert.equal((await call('GET', '/dashboard?owner=all', undefined, V)).status, 200);

  // Pantallas que no tiene: Producción, Entregas, importar y exportar.
  for (const [m, p] of [['GET', '/produccion'], ['GET', '/remitos/revisar'], ['GET', '/remitos/revisar/cuantos'], ['POST', `/records/order/${pedVera.id}/entrega/finalizar`],
    ['GET', '/export/company'], ['POST', '/import/company'], ['GET', '/choferes']]) {
    const r = await call(m, p, m === 'POST' ? { rows: [] } : undefined, V);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.data.error, /no está en el perfil Ventas/);
  }
  assert.equal((await call('GET', `/records/order/${pedVera.id}`, undefined, V)).data.produccion, undefined, 'tampoco quién lo tiene en producción');

  // Los remitos de sus pedidos sí: los ve y los baja para mandárselos al cliente. Cargarlos y revisarlos es de Logística.
  const subir = async (pedido) => {
    const f = new FormData();
    f.append('archivo', new Blob([`\xff\xd8\xff\xe0 remito ${pedido} ${RUN}`], { type: 'image/jpeg' }), `remito-${pedido}.jpg`);
    const r = await fetch(`${CRM}/api/records/order/${pedido}/remitos`, { method: 'POST', body: f });
    assert.ok(r.ok, await r.text());
    return (await (await fetch(`${CRM}/api/records/order/${pedido}/remitos`)).json()).remitos.find((x) => x.record_id === pedido);
  };
  const remVera = await subir(pedVera.id);
  const remOlga = await subir(pedOlga.id);
  const susRemitos = (await call('GET', `/records/order/${pedVera.id}/remitos`, undefined, V)).data;
  assert.ok(ids(susRemitos.remitos).includes(remVera.id), 've los remitos de su pedido');
  assert.equal(susRemitos.puede_finalizar, false);
  const bajada = await fetch(`${CRM}/api/remitos/${remVera.id}/archivo?descargar=1`, { headers: V });
  assert.equal(bajada.status, 200);
  assert.match(bajada.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${CRM}/api/remitos/${remOlga.id}/archivo`, { headers: V })).status, 403, 'no el de un pedido de otra');
  assert.equal((await call('GET', `/records/order/${pedOlga.id}/remitos`, undefined, V)).status, 403);
  assert.equal((await call('POST', `/remitos/${remVera.id}/revisar`, { accion: 'descartar' }, V)).status, 403, 'revisar es de Logística');

  // Los administradores siguen viendo todo; Producción, los negocios no (abajo, su propia prueba).
  assert.equal((await call('GET', `/records/deal/${negOlga.id}`)).status, 200);
  assert.equal((await call('GET', `/records/deal/${negOlga.id}`, undefined, { 'x-dev-user': pia.email })).status, 403);
  assert.equal((await call('GET', '/export/company?q=x')).status, 200);

  // Con Claude (MCP), lo mismo.
  const tok = (await call('POST', '/tokens', { name: `Vera ${RUN}`, source: 'mcp', user_id: vera.id })).data.token;
  const mcp = async (name, args) => {
    const res = await fetch(`${CRM}/mcp/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  assert.equal((await mcp('get_record', { id: negOlga.id })).isError, true);
  assert.equal((await mcp('get_record', { id: negVera.id })).isError, undefined);
  const encontrados = (await mcp('search_records', { object_type: 'company', query: RUN })).structuredContent;
  const lista = encontrados.results ?? encontrados.records ?? [];
  assert.ok(!JSON.stringify(lista).includes(`Suelta Olga ${RUN}`), 'la búsqueda de Claude tampoco la trae');
  assert.equal((await mcp('upsert_bundle', { contact: { email: `carla.${RUN}@cliente.com` } })).isError, true);
  assert.equal((await mcp('get_activity', { id: nota.id })).isError, true);
  // Y la API compatible con HubSpot no la deja entrar.
  const compat = await fetch(`${CRM}/crm/v3/objects/deals/${negOlga.id}`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal(compat.status, 403);
});

// Perfil Producción (alcance.ts): los pedidos sí; negocios no; de contactos y empresas, solo los proveedores y los que
// están en algún pedido. Producción, Entregas y Cronograma, como siempre.
test('perfil Producción: pedidos y proveedores; nada de la parte comercial', async () => {
  const R = `${RUN}p`;
  const pia = (await call('POST', '/users', { email: `pia.prod.${R}@formas.ar`, name: `Pia Prod ${R}`, profile: 'produccion', role: 'member' })).data;
  const P = { 'x-dev-user': pia.email };
  const cliente = await crear('company', { name: `Cliente Prod ${R}` });
  const contacto = await crear('contact', { firstname: 'Ana', lastname: `Cliente ${R}` }, [cliente.id]);
  const pedido = await crear('order', { hs_order_name: `PDV Prod ${R}` }, [cliente.id, contacto.id]);
  const negocio = await crear('deal', { dealname: `Negocio Prod ${R}`, pipeline: 'default', dealstage: 'appointmentscheduled' }, [cliente.id]);
  const proveedor = await crear('company', { name: `Imprenta Prod ${R}`, tipo_de_relacion: 'proveedor' });
  const prospecto = await crear('company', { name: `Prospecto Prod ${R}` });
  const suelto = await crear('contact', { firstname: 'Beto', lastname: `Prospecto ${R}` }, [prospecto.id]);

  // Los pedidos, todos; el cliente y el contacto del pedido y el proveedor se abren.
  assert.ok(ids((await call('GET', `/records/order?q=${R}`, undefined, P)).data.results).includes(pedido.id));
  for (const [t, r] of [['order', pedido], ['company', cliente], ['contact', contacto], ['company', proveedor]]) {
    assert.equal((await call('GET', `/records/${t}/${r.id}`, undefined, P)).status, 200, `${t} ${r.name}`);
  }
  // Negocios y lo que no tiene que ver con un pedido, no.
  const neg = await call('GET', `/records/deal/${negocio.id}`, undefined, P);
  assert.deepEqual([neg.status, neg.data.error], [403, 'Los negocios no están en el perfil Producción.']);
  assert.equal((await call('GET', `/records/deal?q=${R}`, undefined, P)).data.total, 0);
  assert.equal((await call('GET', `/records/company/${prospecto.id}`, undefined, P)).status, 403);
  assert.equal((await call('GET', `/records/contact/${suelto.id}`, undefined, P)).status, 403);
  assert.deepEqual(ids((await call('GET', `/records/company?q=${R}`, undefined, P)).data.results).sort(), [cliente.id, proveedor.id].sort());
  // En la ficha del cliente no aparece el negocio; la búsqueda tampoco lo trae.
  assert.deepEqual((await call('GET', `/records/company/${cliente.id}`, undefined, P)).data.associations.deal, []);
  const busqueda = (await call('GET', `/search?q=${encodeURIComponent(`Prod ${R}`)}`, undefined, P)).data;
  assert.deepEqual([busqueda.deal.length, busqueda.order.length], [0, 1]);
  assert.ok(!busqueda.company.some((c) => c.id === prospecto.id));
  // No crea negocios.
  assert.equal((await call('POST', '/records/deal', { props: { dealname: 'x', pipeline: 'default', dealstage: 'appointmentscheduled' } }, P)).status, 403);
  // Sus pantallas de trabajo siguen.
  for (const p of ['/produccion', '/remitos/revisar', '/cronograma?desde=2026-11-09&hasta=2026-11-15']) {
    assert.equal((await call('GET', p, undefined, P)).status, 200, p);
  }
});
