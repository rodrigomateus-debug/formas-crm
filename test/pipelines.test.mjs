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
