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
