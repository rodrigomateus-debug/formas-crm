// Auditoría del 19/11/2026: lo que encontraron los agentes en los perfiles, cada caso como lo reprodujeron, ahora cerrado.
// - El id de un registro escrito de otra forma («123.0», «+123», « 123») salteaba el alcance (api.ts, RUTA_REGISTRO).
// - Ventas borraba, combinaba, clonaba y creaba a nombre de otra vendedora (api.ts, soloLoSuyoVentas).
// - Producción y Logística importaban y exportaban (api.ts). Logística «Solo mira» creaba links de chofer (remitos.ts, puedeFinalizar).
// - «Ver como» escribía fuera de /api (auth.ts, verComo). resumen_reunion de Claude pisaba reuniones ajenas (mcp.ts).
// - El login y el formulario público mandaban a otro sitio; el formulario cargaba cualquier propiedad (login.ts, hooks.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const A = `aud-a-${RUN}@example.com`, B = `aud-b-${RUN}@example.com`, P = `aud-p-${RUN}@example.com`, L = `aud-l-${RUN}@example.com`;
const ids = {};
const sql = (command) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'formas-crm', '--local', '--command', command], { stdio: 'pipe' });

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path}`, { method, redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* HTML o texto */ }
  return { status: res.status, data, headers: res.headers };
}
const como = (email) => ({ 'x-dev-user': email });
const crear = async (type, props, email, associations) => {
  const r = await call('POST', `/api/records/${type}`, { props, ...(associations ? { associations } : {}) }, email ? como(email) : {});
  assert.equal(r.status, 201, `se crea el ${type}: ${JSON.stringify(r.data)}`);
  return r.data;
};

before(async () => {
  // A: vendedora con «Edita y borra»; B: otra vendedora; P: Producción; L: Logística con «Solo mira».
  for (const [k, email, profile, role] of [['A', A, 'comercial', 'manager'], ['B', B, 'comercial', 'member'], ['P', P, 'produccion', 'member'], ['L', L, 'logistica', 'viewer']]) {
    const r = await call('POST', '/api/users', { email, name: `Aud ${k} ${RUN}`, profile, role });
    assert.ok(r.data?.id, `se crea ${k}: ${JSON.stringify(r.data)}`);
    ids[k] = r.data.id;
  }
});

test('un id escrito de otra forma no saltea el alcance', async () => {
  const deB = await crear('deal', { dealname: `Negocio de B ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: ids.B });
  assert.equal((await call('GET', `/api/records/deal/${deB.id}`, undefined, como(A))).status, 403, 'con el id normal, A no lo ve');
  for (const raro of [`${deB.id}.0`, `+${deB.id}`, `%20${deB.id}`, `${deB.id}%20`, `0x${deB.id.toString(16)}`]) {
    for (const sub of ['', '/timeline', '/history', '/facturar']) {
      const r = await call('GET', `/api/records/deal/${raro}${sub}`, undefined, como(A));
      assert.equal(r.status, 400, `GET /records/deal/${raro}${sub} → ${r.status}`);
    }
  }
  assert.equal((await call('GET', `/api/records/deal/${deB.id}.0`, undefined, como(P))).status, 400, 'Producción tampoco');
  assert.equal((await call('POST', `/api/records/deal/${deB.id}.0/clone`, {}, como(A))).status, 400);
  assert.equal((await call('DELETE', `/api/records/deal/${deB.id}.0`, undefined, como(A))).status, 400);
  assert.equal((await call('PUT', `/api/records/order/${deB.id}.0/direcciones`, {}, como(A))).status, 400);
  // El administrador sigue igual, y las rutas sin id (buscar, seleccionar los N) también.
  assert.equal((await call('GET', `/api/records/deal/${deB.id}`)).status, 200);
  assert.equal((await call('POST', '/api/records/deal/search', { limit: 1 }, como(A))).status, 200);
  assert.equal((await call('GET', `/api/records/deal/${deB.id}`)).data.record.archived, false, 'sigue sin archivar');
});

test('Ventas no borra, combina, clona ni crea a nombre de otra lo que ve por estar asociado a lo suyo', async () => {
  const empB = await crear('company', { name: `Empresa de B ${RUN}`, owner_id: ids.B });
  const empA = await crear('company', { name: `Empresa de A ${RUN}`, owner_id: ids.A }, A);
  // Un negocio de A en la empresa de B: A ve la empresa de B (asociada a lo suyo), pero no es suya.
  await crear('deal', { dealname: `Negocio de A ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: ids.A }, undefined, [empB.id]);
  assert.equal((await call('GET', `/api/records/company/${empB.id}`, undefined, como(A))).status, 200, 'la ve');

  const borrar = await call('DELETE', `/api/records/company/${empB.id}`, undefined, como(A));
  assert.equal(borrar.status, 403, `no la borra (${JSON.stringify(borrar.data)})`);
  assert.match(borrar.data.error, /es de Aud B/);
  assert.equal((await call('POST', '/api/records/company/batch', { ids: [empB.id], archive: true }, como(A))).status, 403, 'ni en el borrado masivo');
  const combinar = await call('POST', `/api/records/company/${empA.id}/merge`, { other_id: empB.id }, como(A));
  assert.equal(combinar.status, 403, `no se queda con ella combinándola (${JSON.stringify(combinar.data)})`);
  assert.equal((await call('POST', `/api/records/company/${empB.id}/merge`, { other_id: empA.id }, como(A))).status, 403, 'ni al revés');
  assert.equal((await call('POST', `/api/records/company/${empB.id}/clone`, {}, como(A))).status, 403, 'ni la clona');
  const empresaB = (await call('GET', `/api/records/company/${empB.id}`)).data.record;
  assert.deepEqual([empresaB.archived, empresaB.props.owner_id], [false, ids.B], 'la empresa de B sigue igual');

  // A nombre de otra vendedora, no; a su nombre, sí.
  const ajeno = await call('POST', '/api/records/deal', { props: { dealname: `Inflado ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 999999, owner_id: ids.B } }, como(A));
  assert.equal(ajeno.status, 403, `no crea a nombre de B (${JSON.stringify(ajeno.data)})`);
  const propio = await crear('company', { name: `Otra de A ${RUN}`, owner_id: ids.A }, A);

  // Lo suyo sí lo borra, y uno combinado no se restaura (quedaría duplicado y sin sus asociaciones).
  assert.equal((await call('DELETE', `/api/records/company/${propio.id}`, undefined, como(A))).status, 200);
  assert.equal((await call('POST', `/api/records/company/${propio.id}/restore`, {}, como(A))).status, 200);
  assert.equal((await call('POST', `/api/records/company/${empA.id}/merge`, { other_id: propio.id }, como(A))).status, 200, 'combina lo suyo');
  const restaurar = await call('POST', `/api/records/company/${propio.id}/restore`, {});
  assert.equal(restaurar.status, 409, `un combinado no se restaura (${JSON.stringify(restaurar.data)})`);
  // Borrar con el tipo equivocado en la ruta no archiva otra cosa.
  assert.equal((await call('DELETE', `/api/records/contact/${empA.id}`)).status, 404);
});

test('Producción y Logística no importan ni exportan; Logística «Solo mira» no crea links de chofer', async () => {
  for (const email of [P, L]) {
    const imp = await call('POST', '/api/import/deal', { rows: [{ dealname: `Importado ${RUN}`, pipeline: 'default', amount: 999 }] }, como(email));
    assert.equal(imp.status, 403, `no importa (${email}: ${JSON.stringify(imp.data)})`);
    assert.equal((await call('POST', '/api/import/contact', { rows: [{ email: `x-${RUN}@example.com` }] }, como(email))).status, 403);
    assert.equal((await call('GET', '/api/export/contact', undefined, como(email))).status, 403, 'no exporta');
  }
  const link = await call('POST', '/api/choferes', { name: `Chofer Fantasma ${RUN}` }, como(L));
  assert.equal(link.status, 403, `Solo mira no crea links (${JSON.stringify(link.data)})`);
  assert.equal((await call('GET', '/api/choferes', undefined, como(L))).status, 200, 'la lista (sin links ni códigos) la sigue viendo');
  assert.equal((await call('GET', `/api/choferes/por-nombre?nombre=${encodeURIComponent('Alguien')}`, undefined, como(L))).status, 403, 'ni el link ni el código');
  // El administrador sí.
  const admin = await call('POST', '/api/choferes', { name: `Chofer Aud ${RUN}` });
  assert.equal(admin.status, 201);
  await call('DELETE', `/api/choferes/${admin.data.id}`);
});

test('«Ver como» no escribe por ninguna entrada', async () => {
  // Mirando como otro administrador (la API compatible ya rechaza los perfiles Ventas, Producción y Logística).
  const otro = (await call('POST', '/api/users', { email: `aud-admin-${RUN}@example.com`, name: `Aud Admin ${RUN}`, profile: 'admin', role: 'admin' })).data;
  assert.ok(otro?.id, JSON.stringify(otro));
  const emp = await crear('company', { name: `Para ver como ${RUN}` });
  const V = { 'x-ver-como': String(otro.id) };
  const compat = await call('PATCH', `/crm/v3/objects/companies/${emp.id}`, { properties: { city: 'Mirando' } }, V);
  assert.equal(compat.status, 403, `API compatible (${JSON.stringify(compat.data)})`);
  assert.equal(compat.data.ver_como, true);
  assert.equal((await call('POST', '/crm/v3/objects/companies', { properties: { name: `Como B ${RUN}` } }, V)).status, 403);
  assert.equal((await call('PATCH', `/hubspot/crm/v3/objects/companies/${emp.id}`, { properties: { city: 'Mirando' } }, V)).status, 403);
  assert.equal((await call('POST', '/api/records/company', { props: { name: `Api como B ${RUN}` } }, V)).status, 403, '/api, como antes');
  // Mirar sigue andando.
  assert.equal((await call('GET', `/crm/v3/objects/companies/${emp.id}`, undefined, V)).status, 200);
  assert.equal((await call('GET', `/api/records/company/${emp.id}`)).data.record.props.city ?? null, null, 'no cambió');
});

test('Claude: resumen_reunion no pisa la reunión de otra vendedora', async () => {
  const empB = await crear('company', { name: `Cliente reunión ${RUN}`, owner_id: ids.B });
  await crear('deal', { dealname: `Negocio reunión A ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: ids.A }, undefined, [empB.id]);
  const reunion = await call('POST', '/api/activities', { type: 'meeting', subject: `Reunión confidencial ${RUN}`, occurred_at: new Date().toISOString(), owner_id: ids.B, links: [empB.id] }, como(B));
  assert.equal(reunion.status, 201, JSON.stringify(reunion.data));
  const tokenA = (await call('POST', '/api/tokens', { name: `Claude A ${RUN}`, source: 'mcp', user_id: ids.A })).data.token;
  const tokenB = (await call('POST', '/api/tokens', { name: `Claude B ${RUN}`, source: 'mcp', user_id: ids.B })).data.token;
  const herramienta = async (token, name, args) => (await (await fetch(`${CRM}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;

  const pisar = await herramienta(tokenA, 'resumen_reunion', { id: reunion.data.id, resumen: 'PISADO' });
  assert.ok(pisar.isError && /es de otra persona/.test(pisar.content[0].text), JSON.stringify(pisar));
  assert.equal((await call('GET', `/api/activities/${reunion.data.id}`)).data.meta?.resumen ?? null, null, 'el resumen no cambió');
  const suya = await herramienta(tokenB, 'resumen_reunion', { id: reunion.data.id, resumen: 'Acordamos el presupuesto.' });
  assert.ok(!suya.isError, JSON.stringify(suya));
  assert.equal((await call('GET', `/api/activities/${reunion.data.id}`)).data.meta.resumen, 'Acordamos el presupuesto.', 'la dueña sí');
});

test('el login no manda a otro sitio', async () => {
  for (const volver of ['/%5Cevil.example', '/%09/evil.example', '//evil.example', 'https://evil.example', '/%5C%5Cevil.example']) {
    const ida = await call('GET', `/auth/google?volver=${volver}`);
    const estado = ida.headers.getSetCookie().find((c) => c.startsWith('crm_login='));
    assert.ok(estado, `deja la cookie del ida y vuelta (${volver})`);
    const datos = estado.slice('crm_login='.length).split(';')[0].split('.')[0];
    const { volver: guardado } = JSON.parse(Buffer.from(datos.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.equal(guardado, '/', `${volver} → ${guardado}`);
  }
  const ida = await call('GET', '/auth/google?volver=%2Forders%2F123%3Fx%3D1');
  const datos = ida.headers.getSetCookie().find((c) => c.startsWith('crm_login=')).slice('crm_login='.length).split(';')[0].split('.')[0];
  assert.equal(JSON.parse(Buffer.from(datos.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).volver, '/orders/123?x=1', 'una página del CRM, sí');
});

test('el formulario público carga solo datos de contacto y vuelve solo a sitios de Formas', async () => {
  const slug = `aud-${RUN}`;
  const yo = (await call('GET', '/api/me')).data.id;
  sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('form:${slug}', '${JSON.stringify({ name: `Auditoria ${RUN}`, user_id: yo, contact_defaults: { origen_del_contacto: 'Consulta formas.ar' } })}')`);
  const mail = `lead-${RUN}@cliente.example`;
  const form = (campos) => fetch(`${CRM}/hooks/form/${slug}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos).toString() });

  const fuera = await form({ email: mail, firstname: 'Lead', owner_id: String(ids.L), tipo_de_relacion: 'proveedor', hs_lead_status: 'CONNECTED', redirect: 'https://evil.example/phish' });
  assert.equal(fuera.status, 200, `a otro sitio no redirige: contesta ok (${fuera.status} ${await fuera.clone().text()})`);
  assert.deepEqual(await fuera.json(), { ok: true });
  const contacto = (await call('GET', `/api/search?q=${encodeURIComponent(mail)}`)).data.contact[0];
  const props = (await call('GET', `/api/records/contact/${contacto.id}`)).data.record.props;
  assert.equal(props.firstname, 'Lead', 'los datos de contacto, sí');
  assert.notEqual(props.owner_id, ids.L, 'el propietario no lo elige el visitante');
  assert.equal(props.tipo_de_relacion ?? null, null, 'ni el tipo de relación');
  assert.equal(props.hs_lead_status ?? null, null, 'ni el estado del lead');

  const formas = await form({ email: mail, redirect: 'https://www.formas.ar/gracias' });
  assert.deepEqual([formas.status, formas.headers.get('location')], [303, 'https://www.formas.ar/gracias'], 'a una página de Formas, sí');
  assert.equal((await form({ email: mail, redirect: 'https://formas.ar.evil.example/' })).status, 200, 'un dominio que solo empieza igual, no');
  assert.equal((await form({ email: mail, redirect: 'http://formas.ar/gracias' })).status, 200, 'sin https, no');
  sql(`DELETE FROM settings WHERE key = 'form:${slug}'`);
});

// Segunda tanda (misma auditoría): tokens, actividades ajenas, filtros, administrador principal, CSV.
test('cada token sirve solo en su entrada, y no en la dirección', async () => {
  const mcpA = (await call('POST', '/api/tokens', { name: `Claude tanda2 ${RUN}`, source: 'mcp', user_id: ids.A })).data.token;
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  assert.equal((await call('GET', '/api/me', undefined, bearer(mcpA))).status, 403, 'el de Claude no abre /api');
  const bundle = await call('POST', '/hooks/bundle', { contact: { email: `colado-${RUN}@example.com` } }, bearer(mcpA));
  assert.equal(bundle.status, 403, `ni /hooks/bundle (${JSON.stringify(bundle.data)})`);
  const init = await fetch(`${CRM}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(mcpA) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(init.status, 200, 'en /mcp sí');
  const darwin = (await call('POST', '/api/tokens', { name: `Darwin tanda2 ${RUN}`, source: 'darwin' })).data.token;
  assert.equal((await call('GET', '/api/users', undefined, bearer(darwin))).status, 403, 'el de Darwin (de un administrador) no abre /api');
  assert.equal((await call('GET', `/crm/v3/objects/companies?limit=1`, undefined, bearer(darwin))).status, 403, 'ni la API compatible');
  const api = (await call('POST', '/api/tokens', { name: `API tanda2 ${RUN}`, source: 'api' })).data.token;
  assert.equal((await call('GET', '/api/me', undefined, bearer(api))).status, 200, 'uno de tipo API, en /api sí');
  assert.equal((await call('GET', `/api/me?token=${api}`)).status, 401, 'pero en la dirección, no');
});

test('Ventas no cambia ni borra notas ajenas de un registro que ve', async () => {
  const empB = await crear('company', { name: `Notas de B ${RUN}`, owner_id: ids.B });
  await crear('deal', { dealname: `Negocio notas A ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', owner_id: ids.A }, undefined, [empB.id]);
  const notaB = (await call('POST', '/api/activities', { type: 'note', body: `Nota privada de B ${RUN}`, links: [empB.id] }, como(B))).data;
  assert.ok(notaB?.id, JSON.stringify(notaB));
  const editar = await call('PATCH', `/api/activities/${notaB.id}`, { body: 'PISADO' }, como(A));
  assert.equal(editar.status, 403, `no la edita (${JSON.stringify(editar.data)})`);
  assert.match(editar.data.error, /Aud B/);
  assert.equal((await call('DELETE', `/api/activities/${notaB.id}`, undefined, como(A))).status, 403, 'ni la borra');
  assert.equal((await call('DELETE', `/api/activities/${notaB.id}/links/${empB.id}`, undefined, como(A))).status, 403, 'ni la saca del registro');
  const notaA = (await call('POST', '/api/activities', { type: 'note', body: `Nota de A ${RUN}`, links: [empB.id] }, como(A))).data;
  assert.equal((await call('PATCH', `/api/activities/${notaA.id}`, { body: 'Corregida' }, como(A))).status, 200, 'la suya sí');
});

test('los filtros por datos de un asociado no dicen nada de lo que no se ve', async () => {
  const emp = await crear('company', { name: `Oráculo ${RUN}`, owner_id: ids.B });
  await crear('deal', { dealname: `Chico de A ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 10, owner_id: ids.A }, undefined, [emp.id]);
  await crear('deal', { dealname: `Grande de B ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 7777777, owner_id: ids.B }, undefined, [emp.id]);
  const buscar = async (value, email) => (await call('POST', '/api/records/company/search', { q: `Oráculo ${RUN}`, filters: [{ prop: 'deal.amount', op: 'gt', value }] }, email ? como(email) : {})).data;
  assert.equal((await buscar(5000000, A)).total, 0, 'el monto del negocio de B no aparece');
  assert.equal((await buscar(5, A)).total, 1, 'el suyo sí filtra');
  assert.equal((await buscar(5000000)).total, 1, 'el administrador ve todo');
});

test('otro administrador no deja afuera al administrador principal', async () => {
  const yo = (await call('GET', '/api/me')).data;
  const otro = (await call('POST', '/api/users', { email: `aud-admin2-${RUN}@example.com`, name: `Aud Admin2 ${RUN}`, profile: 'admin', role: 'admin' })).data;
  const como2 = como(`aud-admin2-${RUN}@example.com`);
  const baja = await call('PATCH', `/api/users/${yo.id}`, { active: false }, como2);
  assert.equal(baja.status, 400, JSON.stringify(baja.data));
  assert.equal((await call('PATCH', `/api/users/${yo.id}`, { role: 'member' }, como2)).status, 400);
  assert.equal((await call('GET', '/api/me')).data.role, 'admin', 'sigue administrador y activo');
  // Lo que rebota no deja nada guardado a medias.
  const mal = await call('PATCH', `/api/users/${otro.id}`, { direccion: true, profile: 'no-existe' });
  assert.equal(mal.status, 400);
  assert.ok(!(await call('GET', '/api/users')).data.find((u) => u.id === otro.id).direccion, 'Dirección no quedó guardada');
});

test('el CSV exportado no lleva fórmulas', async () => {
  await crear('company', { name: `=HYPERLINK("https://evil.example","Clic") ${RUN}` });
  const csv = await (await fetch(`${CRM}/api/export/company?q=${encodeURIComponent(RUN)}&columns=name`)).text();
  assert.ok(csv.includes(`'=HYPERLINK`), csv.slice(0, 300));
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(csv), 'ninguna celda empieza con =');
});
