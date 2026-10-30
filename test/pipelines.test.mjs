// Pipelines como en HubSpot: crear y copiar, reglas (no saltear, no volver atrás, empresa obligatoria),
// propiedades obligatorias por etapa, tarea automática al entrar a una etapa y borrar etapas moviendo negocios.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
let asUser = null; // x-dev-user: en desarrollo, entra como otro usuario
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const s = {};

test('crear un pipeline copiando Corporate trae etapas y reglas', async () => {
  const copy = await api('POST', '/pipelines', { label: `Copia Corporate ${RUN}`, copy_from: '674405796' });
  assert.equal(copy.status, 201, JSON.stringify(copy.data));
  const meta = (await api('GET', '/meta')).data;
  const p = meta.pipelines.find((x) => x.id === copy.data.id);
  const corp = meta.pipelines.find((x) => x.id === '674405796');
  assert.deepEqual(p.stages.map((x) => x.label), corp.stages.map((x) => x.label));
  assert.equal(p.config.rules.require_company, true);
  assert.deepEqual(p.stages.find((x) => x.is_closed && !x.is_won).config.required_props, ['motivo_de_cierre_perdido']);
  assert.equal((await api('DELETE', `/pipelines/${copy.data.id}`)).status, 200, 'sin negocios se puede borrar');
});

test('pipeline nuevo con reglas, propiedades obligatorias y tarea automática', async () => {
  const created = await api('POST', '/pipelines', { label: `Eventos ${RUN}` });
  assert.equal(created.status, 201);
  s.pid = created.data.id;
  const p = (await api('GET', '/meta')).data.pipelines.find((x) => x.id === s.pid);
  const st = p.stages.map((x) => ({ ...x }));
  st[1].config = { required_props: ['amount'] };
  st[2].config = { task: { subject: 'Seguimiento de {negocio}', due_days: 2, task_type: 'call' } };
  const put = await api('PUT', `/pipelines/${s.pid}`, { label: p.label, team_id: 57132078, config: { rules: { no_skip: true, no_backward: true }, card_props: ['amount', 'producto'] }, stages: st });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  s.stages = (await api('GET', '/meta')).data.pipelines.find((x) => x.id === s.pid).stages;
  assert.equal(s.stages[2].config.task.due_days, 2);

  // Las reglas de movimiento valen para miembros (los administradores las pueden saltear, como en HubSpot).
  const member = await api('POST', '/users', { email: `vende.${RUN}@formas.ar`, name: `Vende ${RUN}`, role: 'member' });
  assert.equal(member.status, 201);
  asUser = `vende.${RUN}@formas.ar`;
  const deal = await api('POST', '/records/deal', { props: { dealname: `Stand ${RUN}`, pipeline: s.pid } });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  s.deal = deal.data.id;
  const skip = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[2].id } });
  assert.equal(skip.status, 400);
  assert.match(skip.data.error, /no se saltean/);
  const missing = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[1].id } });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.data.missing, ['amount'], 'la pantalla sabe qué pedir');
  const ok = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[1].id, amount: 500000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const next = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[2].id } });
  assert.equal(next.status, 200);
  const tasks = await api('GET', `/tasks?record=${s.deal}&owner=all`);
  assert.equal(tasks.data.total, 1);
  assert.equal(tasks.data.results[0].subject, `Seguimiento de Stand ${RUN}`);
  assert.equal(tasks.data.results[0].task_type, 'call');
  assert.ok(Date.parse(tasks.data.results[0].due_at) > Date.now() + 86_400_000, 'vence en 2 días');
  const back = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[1].id } });
  assert.equal(back.status, 400);
  assert.match(back.data.error, /no vuelve/);
  const lost = s.stages.find((x) => x.is_closed && !x.is_won);
  const lostNoReason = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: lost.id } });
  assert.deepEqual(lostNoReason.data.missing, ['motivo_de_cierre_perdido']);
  asUser = null;
  const admin = await api('PATCH', `/records/deal/${s.deal}`, { props: { dealstage: s.stages[1].id } });
  assert.equal(admin.status, 200, 'el administrador puede volver atrás');
});

test('Corporate pide empresa; la toma del contacto si tiene una principal', async () => {
  const noCompany = await api('POST', '/records/deal', { props: { dealname: `Sin empresa ${RUN}`, pipeline: '674405796' } });
  assert.equal(noCompany.status, 400);
  assert.match(noCompany.data.error, /empresa asociada/);
  const comp = await api('POST', '/records/company', { props: { name: `Corp ${RUN}`, domain: `corp-${RUN}.com.ar` } });
  const contact = await api('POST', '/records/contact', { props: { firstname: 'Ceci', email: `ceci@corp-${RUN}.com.ar` } });
  const deal = await api('POST', '/records/deal', { props: { dealname: `Con contacto ${RUN}`, pipeline: '674405796' }, associations: [contact.data.id] });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  const rec = await api('GET', `/records/deal/${deal.data.id}`);
  assert.equal(rec.data.associations.company[0].id, comp.data.id, 'asociada sola a la empresa del contacto');
  // Pasar a Corporate un negocio sin empresa tampoco se puede.
  const shop = await api('POST', '/records/deal', { props: { dealname: `Shop ${RUN}`, pipeline: 'default' } });
  const move = await api('PATCH', `/records/deal/${shop.data.id}`, { props: { pipeline: '674405796' } });
  assert.equal(move.status, 400);
});

test('borrar una etapa con negocios obliga a moverlos', async () => {
  const p = (await api('GET', '/meta')).data.pipelines.find((x) => x.id === s.pid);
  const without = p.stages.filter((x) => x.id !== s.stages[1].id);
  const refused = await api('PUT', `/pipelines/${s.pid}`, { label: p.label, team_id: p.team_id, config: p.config, stages: without });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /tiene 1 negocios/);
  const moved = await api('PUT', `/pipelines/${s.pid}`, { label: p.label, team_id: p.team_id, config: p.config, stages: without, remove: [{ id: s.stages[1].id, move_to: s.stages[0].id }] });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const deal = await api('GET', `/records/deal/${s.deal}`);
  assert.equal(deal.data.record.props.dealstage, s.stages[0].id);
  const del = await api('DELETE', `/pipelines/${s.pid}`);
  assert.equal(del.status, 409, 'con negocios no se borra');
});

test('tablero de empresas por etapa del ciclo de vida (y por propietario)', async () => {
  const comp = await api('POST', '/records/company', { props: { name: `Tablero ${RUN}`, domain: `tablero-${RUN}.com.ar`, lifecyclestage: 'opportunity' } });
  const board = await api('GET', `/board-prop/company?prop=lifecyclestage&q=${encodeURIComponent(`Tablero ${RUN}`)}`);
  assert.equal(board.status, 200, JSON.stringify(board.data));
  const labels = board.data.columns.map((c) => c.label);
  assert.deepEqual(labels.slice(0, 2), ['Listado de Empresas S/A', 'Prospect'], 'en el orden de las etapas');
  const col = board.data.columns.find((c) => c.value === 'opportunity');
  assert.equal(col.total, 1);
  assert.equal(col.records[0].id, comp.data.id);
  // Arrastrar a otra columna = cambiar la propiedad.
  await api('PATCH', `/records/company/${comp.data.id}`, { props: { lifecyclestage: 'customer' } });
  const after = await api('GET', `/board-prop/company?prop=lifecyclestage&q=${encodeURIComponent(`Tablero ${RUN}`)}`);
  assert.equal(after.data.columns.find((c) => c.value === 'customer').total, 1);
  const byOwner = await api('GET', `/board-prop/company?prop=owner_id&q=${encodeURIComponent(`Tablero ${RUN}`)}`);
  assert.equal(byOwner.status, 200);
  const bad = await api('GET', '/board-prop/company?prop=name');
  assert.equal(bad.status, 400);
});

test('quién ve cada pipeline: por equipo (principal o extra); los administradores ven todo', async () => {
  asUser = null;
  const p = await api('POST', '/pipelines', { label: `Solo Corporate ${RUN}`, team_id: 58079782 });
  const def = (await api('GET', '/meta')).data.pipelines.find((x) => x.id === p.data.id);
  await api('PUT', `/pipelines/${p.data.id}`, { label: def.label, team_id: 58079782, config: { visible_teams: [58079782] }, stages: def.stages });
  const comp = await api('POST', '/records/company', { props: { name: `Visible ${RUN}`, domain: `visible-${RUN}.com.ar` } });
  const deal = await api('POST', '/records/deal', { props: { dealname: `Oculto ${RUN}`, pipeline: p.data.id }, associations: [comp.data.id] });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  await api('POST', '/activities', { type: 'note', body: `nota del negocio oculto ${RUN}`, links: [deal.data.id] });

  const shop = await api('POST', '/users', { email: `shop.${RUN}@formas.ar`, name: `Shop ${RUN}`, role: 'member', team_id: 57132078 });
  asUser = `shop.${RUN}@formas.ar`;
  const meta = (await api('GET', '/meta')).data;
  assert.ok(!meta.pipelines.some((x) => x.id === p.data.id), 'no aparece en su lista de pipelines');
  assert.equal((await api('GET', `/records/deal?q=${encodeURIComponent(`Oculto ${RUN}`)}`)).data.total, 0, 'ni en la búsqueda');
  assert.equal((await api('GET', `/records/deal/${deal.data.id}`)).status, 403, 'ni abriendo la ficha');
  assert.equal((await api('GET', `/board?pipeline=${p.data.id}`)).status, 403);
  assert.equal((await api('PATCH', `/records/deal/${deal.data.id}`, { props: { amount: 1 } })).status, 403);
  assert.equal((await api('POST', '/records/deal', { props: { dealname: 'x', pipeline: p.data.id } })).status, 403);
  const company = (await api('GET', `/records/company/${comp.data.id}`)).data;
  assert.equal(company.associations.deal.length, 0, 'la empresa no muestra el negocio oculto');
  const tl = (await api('GET', `/records/company/${comp.data.id}/timeline`)).data;
  assert.ok(!tl.activities.some((a) => a.body.includes(`nota del negocio oculto ${RUN}`)), 'ni su actividad');

  asUser = null;
  await api('PATCH', `/users/${shop.data.id}`, { extra_teams: [58079782] });
  asUser = `shop.${RUN}@formas.ar`;
  assert.ok((await api('GET', '/meta')).data.pipelines.some((x) => x.id === p.data.id), 'con el equipo extra, lo ve');
  assert.equal((await api('GET', `/records/deal/${deal.data.id}`)).status, 200);
  asUser = null;
});

test('entra solo quien está en la lista de usuarios y activo', async () => {
  asUser = `nuevo.${RUN}@formas.ar`;
  const denied = await api('GET', '/me');
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /no tiene usuario en el CRM/);
  asUser = null;
  const u = await api('POST', '/users', { email: `nuevo.${RUN}@formas.ar`, name: `Nuevo ${RUN}`, role: 'member' });
  asUser = `nuevo.${RUN}@formas.ar`;
  assert.equal((await api('GET', '/me')).status, 200, 'agregado: entra');
  asUser = null;
  await api('PATCH', `/users/${u.data.id}`, { active: false });
  asUser = `nuevo.${RUN}@formas.ar`;
  assert.equal((await api('GET', '/me')).status, 403, 'desactivado: no entra');
  asUser = null;
});

test('sin equipo, Negocios arranca en el pipeline donde tiene más negocios', async () => {
  const u = await api('POST', '/users', { email: `sinequipo.${RUN}@formas.ar`, name: `Sin equipo ${RUN}`, role: 'member' });
  for (const pipeline of ['740095901', '740095901', '687889576']) {
    const d = await api('POST', '/records/deal', { props: { dealname: `Mío ${pipeline} ${RUN}`, pipeline, owner_id: u.data.id } });
    assert.equal(d.status, 201, JSON.stringify(d.data));
  }
  asUser = `sinequipo.${RUN}@formas.ar`;
  assert.deepEqual((await api('GET', '/meta')).data.me.deal_pipelines, ['740095901', '687889576']);
  asUser = null;
});

test('acciones masivas: todos los filtrados, tareas en lote y errores parciales sin cortar la tanda', async () => {
  asUser = null;
  const tag = `Masivo ${RUN}`;
  const pipe = (await api('GET', '/meta')).data.pipelines.find((p) => p.id === 'default');
  const lost = pipe.stages.find((s) => s.is_closed && !s.is_won);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await api('POST', '/records/deal', { props: { dealname: `${tag} ${i}`, pipeline: 'default', amount: 100 } })).data.id);
  await api('PATCH', `/records/deal/${ids[0]}`, { props: { motivo_de_cierre_perdido: (await api('GET', '/meta')).data.properties.find((p) => p.object_type === 'deal' && p.name === 'motivo_de_cierre_perdido').options[0].value } });
  const all = (await api('GET', `/records/deal/ids?q=${encodeURIComponent(tag)}`)).data.ids;
  assert.deepEqual([...all].sort(), [...ids].sort());
  // Pasar a perdido: el que tiene motivo pasa, los otros dos se informan y no frenan la tanda.
  const r = (await api('POST', '/records/deal/batch', { ids: all, props: { dealstage: lost.id } })).data;
  assert.equal(r.updated, 1);
  assert.equal(r.failed.length, 2);
  assert.ok(r.failed.every((f) => f.name.startsWith(tag) && f.error));
  const t = (await api('POST', '/records/deal/batch', { ids: all, task: { subject: 'Seguimiento: {nombre}', due_at: new Date().toISOString() } })).data;
  assert.equal(t.tasks, 3);
  const tasks = (await api('GET', `/records/deal/${ids[1]}/timeline?types=task`)).data.activities;
  assert.ok(tasks.some((a) => a.subject === `Seguimiento: ${tag} 1`));
  assert.equal((await api('POST', '/records/deal/batch', { ids: Array.from({ length: 201 }, (_, i) => i + 1), props: {} })).status, 400, 'más de 200 por pedido');
});

test('clonar negocio: mismos datos y asociaciones, en la primera etapa', async () => {
  asUser = null;
  const comp = (await api('POST', '/records/company', { props: { name: `Clon ${RUN}`, domain: `clon-${RUN}.com.ar` } })).data;
  const won = (await api('GET', '/meta')).data.pipelines.find((p) => p.id === 'default').stages.find((s) => s.is_won);
  const d = (await api('POST', '/records/deal', { props: { dealname: `Pedido ${RUN}`, pipeline: 'default', dealstage: won.id, amount: 5000, producto: 'Mochilas' }, associations: [comp.id] })).data;
  const c = await api('POST', `/records/deal/${d.id}/clone`);
  assert.equal(c.status, 201);
  assert.equal(c.data.name, `Pedido ${RUN} (copia)`);
  assert.equal(c.data.props.producto, 'Mochilas');
  assert.equal(c.data.props.amount, 5000);
  assert.notEqual(c.data.props.dealstage, won.id);
  assert.ok(!c.data.props.closedate);
  assert.equal((await api('GET', `/records/deal/${c.data.id}`)).data.associations.company[0].id, comp.id);
});

test('exportar se lee como en pantalla: propietario, etapa, pipeline y empresa', async () => {
  asUser = null;
  const comp = (await api('POST', '/records/company', { props: { name: `Expo ${RUN}`, domain: `expo-${RUN}.com.ar` } })).data;
  await api('POST', '/records/deal', { props: { dealname: `Export ${RUN}`, pipeline: 'default' }, associations: [comp.id] });
  const res = await fetch(`${BASE}/api/export/deal?q=${encodeURIComponent(`Export ${RUN}`)}&columns=dealstage,pipeline,owner_id,__company`);
  const csv = await res.text();
  const row = csv.split('\n')[1];
  const pipe = (await api('GET', '/meta')).data.pipelines.find((p) => p.id === 'default');
  assert.ok(row.includes(pipe.stages[0].label) && row.includes(pipe.label) && row.includes(`Expo ${RUN}`), row);
  assert.ok(!/,\d+,/.test(row.split(',').slice(1).join(',')), 'sin ids internos');
});

test('vistas compartidas con un equipo: las ve ese equipo y nadie más', async () => {
  asUser = null;
  const v = (await api('POST', '/views/company', { name: `Solo Corporate ${RUN}`, team_id: 58079782, config: { groups: [], columns: [], sort: 'createdate', dir: 'desc' } })).data;
  await api('POST', '/users', { email: `corp.${RUN}@formas.ar`, name: `Corp ${RUN}`, role: 'member', team_id: 58079782 });
  await api('POST', '/users', { email: `otro.${RUN}@formas.ar`, name: `Otro ${RUN}`, role: 'member', team_id: 57132078 });
  asUser = `corp.${RUN}@formas.ar`;
  assert.ok((await api('GET', '/views/company')).data.some((x) => x.id === v.id));
  asUser = `otro.${RUN}@formas.ar`;
  assert.ok(!(await api('GET', '/views/company')).data.some((x) => x.id === v.id));
  assert.equal((await api('PATCH', `/views/company/${v.id}`, { name: 'x' })).status, 403);
  asUser = null;
});

test('etiquetas por regla: las 7 de HubSpot, se ven en la lista, la ficha y el tablero, y filtran', async () => {
  asUser = null;
  const meta = (await api('GET', '/meta')).data;
  assert.equal(meta.tags.length >= 7, true);
  const imp = meta.tags.find((t) => t.name === 'Productos Importados');
  const net = meta.tags.find((t) => t.name === 'NETWORKING');
  const comp = (await api('POST', '/records/company', { props: { name: `Tag ${RUN}`, domain: `tag-${RUN}.com.ar` } })).data;
  const a = (await api('POST', '/records/deal', { props: { dealname: `Etiq ${RUN} imp`, pipeline: '674405796', tipo_de_producto: 'Productos importados' }, associations: [comp.id] })).data;
  const b = (await api('POST', '/records/deal', { props: { dealname: `Etiq ${RUN} shop`, pipeline: 'default', tipo_de_producto: 'Productos importados', origen: 'Networking' } })).data;
  const list = (await api('GET', `/records/deal?q=${encodeURIComponent(`Etiq ${RUN}`)}`)).data.results;
  assert.deepEqual(list.find((r) => r.id === a.id).tags, [imp.id], 'Corporate + Productos importados');
  assert.deepEqual(list.find((r) => r.id === b.id).tags, [net.id], 'en Formas Shop no lleva la de producto, sí NETWORKING');
  assert.deepEqual((await api('GET', `/records/deal/${b.id}`)).data.record.tags, [net.id]);
  const board = (await api('GET', `/board?pipeline=674405796&q=${encodeURIComponent(`Etiq ${RUN}`)}`)).data;
  assert.deepEqual(board.columns.flatMap((c) => c.deals).find((d) => d.id === a.id).tags, [imp.id]);
  const byTag = (await api('GET', `/records/deal?q=${encodeURIComponent(`Etiq ${RUN}`)}&groups=${encodeURIComponent(JSON.stringify([[{ prop: '__tag', op: 'in', values: [String(imp.id)] }]]))}`)).data;
  assert.deepEqual(byTag.results.map((r) => r.id), [a.id]);
  // Etiqueta nueva desde Configuración, con regla inválida y válida
  assert.equal((await api('POST', '/tags', { name: `Mala ${RUN}`, rule: { groups: [[{ prop: 'no_existe', op: 'eq', value: 1 }]] } })).status, 400);
  const t = await api('POST', '/tags', { name: `Grande ${RUN}`, color: '#c62828', rule: { groups: [[{ prop: 'amount', op: 'gte', value: 1000000 }]] } });
  assert.equal(t.status, 201);
  await api('DELETE', `/tags/${t.data.id}`);
});

test('filtrar por un dato del asociado (negocios de empresas de cierto tipo)', async () => {
  asUser = null;
  const c1 = (await api('POST', '/records/company', { props: { name: `Asoc A ${RUN}`, domain: `asoc-a-${RUN}.com.ar`, city: `Ciudad ${RUN}` } })).data;
  const c2 = (await api('POST', '/records/company', { props: { name: `Asoc B ${RUN}`, domain: `asoc-b-${RUN}.com.ar` } })).data;
  await api('POST', '/records/deal', { props: { dealname: `Por asoc ${RUN} 1`, pipeline: 'default' }, associations: [c1.id] });
  await api('POST', '/records/deal', { props: { dealname: `Por asoc ${RUN} 2`, pipeline: 'default' }, associations: [c2.id] });
  const r = (await api('GET', `/records/deal?q=${encodeURIComponent(`Por asoc ${RUN}`)}&groups=${encodeURIComponent(JSON.stringify([[{ prop: 'company.city', op: 'eq', value: `Ciudad ${RUN}` }]]))}`)).data;
  assert.deepEqual(r.results.map((x) => x.name), [`Por asoc ${RUN} 1`]);
});

test('actividad: buscar, filtrar por responsable y fijar arriba', async () => {
  asUser = null;
  const d = (await api('POST', '/records/deal', { props: { dealname: `Act ${RUN}`, pipeline: 'default' } })).data;
  const n1 = (await api('POST', '/activities', { type: 'note', body: `Presupuesto de mochilas ${RUN}`, links: [d.id], occurred_at: new Date(Date.now() - 86_400_000).toISOString() })).data;
  await api('POST', '/activities', { type: 'note', body: `Llamó por gorras ${RUN}`, links: [d.id] });
  const q = (await api('GET', `/records/deal/${d.id}/timeline?q=mochilas`)).data.activities;
  assert.deepEqual(q.map((a) => a.id), [n1.id]);
  await api('PATCH', `/activities/${n1.id}`, { meta: { pinned: true } });
  const all = (await api('GET', `/records/deal/${d.id}/timeline`)).data.activities;
  assert.equal(all[0].id, n1.id, 'la fijada va primero aunque sea más vieja');
  const users = (await api('GET', '/meta')).data.users;
  const other = users.find((u) => u.active && u.id !== users.find((x) => x.email === 'rodrigo.mateus@formaspublicitarias.com')?.id);
  if (other) assert.equal((await api('GET', `/records/deal/${d.id}/timeline?owner=${other.id}`)).data.activities.length, 0);
});

test('«Acerca de» elegido por objeto', async () => {
  asUser = null;
  const r = await api('PUT', '/key-props/company', { props: ['domain', 'city', 'no_existe'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await api('GET', '/meta')).data.key_props.company, ['domain', 'city']);
  await api('PUT', '/key-props/company', { props: [] });
});
