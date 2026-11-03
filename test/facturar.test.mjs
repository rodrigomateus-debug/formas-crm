// Datos para facturar al ganar un negocio, con la lista de empresas grandes de ARCA simulada (ARCA_FCE_URL en .dev.vars).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const GRANDE = '30677423141';   // un CUIT válido (Robert Bosch, que está en la lista real)
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
let server;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ d: JSON.stringify([{ Cuit: Number(GRANDE), Denominacion: 'EMPRESA GRANDE SA' }, { Cuit: 30500010912, Denominacion: 'OTRA' }]) }));
  });
  await new Promise((r) => server.listen(8796, r));
});
after(() => server.close());

test('al ganar el negocio: tarea si faltan datos para facturar y aviso de FCE', async (t) => {
  const tok = (await call('POST', '/tokens', { name: `Facturar ${RUN}`, source: 'api' })).data.token;
  const fce = await call('POST', '/hooks/arca/fce', undefined, { authorization: `Bearer ${tok}` });
  if (fce.status !== 200) { t.skip(`sin ARCA_FCE_URL de prueba en wrangler dev (${JSON.stringify(fce.data)})`); return; }
  assert.equal(fce.data.empresas_grandes, 2);
  const pipe = (await call('GET', '/meta')).data.pipelines.find((p) => p.id === 'default');
  const won = pipe.stages.find((s) => s.is_won);
  const open = pipe.stages.find((s) => !s.is_closed);

  // Sin CUIT ni razón social: al ganarlo, tarea para hoy.
  const sin = (await call('POST', '/records/company', { props: { name: `Sin datos ${RUN}` } })).data;
  const d1 = (await call('POST', '/records/deal', { props: { dealname: `Gana ${RUN}`, pipeline: 'default', dealstage: open.id, amount: 1000, producto: 'Mochilas' }, associations: [sin.id] })).data;
  assert.ok((await call('GET', `/records/deal/${d1.id}/facturar`)).data.faltan.length >= 2);
  await call('PATCH', `/records/deal/${d1.id}`, { props: { dealstage: won.id } });
  const tareas = (await call('GET', `/records/deal/${d1.id}/timeline?types=task`)).data.activities.filter((a) => /^Completar datos para facturar/.test(a.subject));
  assert.equal(tareas.length, 1);
  assert.match(tareas[0].body, /CUIT/);
  assert.match(tareas[0].body, /razón social/);

  // CUIT mal escrito: no pasa el dígito verificador.
  await call('PATCH', `/records/company/${sin.id}`, { props: { cuit: '30-67742314-2', razon_social: 'SIN DATOS SA' } });
  assert.match((await call('GET', `/records/deal/${d1.id}/facturar`)).data.faltan.join(' '), /no es válido/);

  // Completa y empresa grande: sin faltantes, con aviso de FCE y de cliente nuevo.
  const ok = (await call('POST', '/records/company', { props: { name: `Grande ${RUN}`, cuit: '30-67742314-1', razon_social: 'GRANDE SA' } })).data;
  const d2 = (await call('POST', '/records/deal', { props: { dealname: `Gana bien ${RUN}`, pipeline: 'default', dealstage: open.id, amount: 1000, producto: 'Mochilas' }, associations: [ok.id] })).data;
  await call('PATCH', `/records/deal/${d2.id}`, { props: { dealstage: won.id } });
  const ctl = (await call('GET', `/records/deal/${d2.id}/facturar`)).data;
  assert.deepEqual(ctl.faltan, []);
  assert.match(ctl.avisos.join(' '), /Factura de Crédito Electrónica/);
  assert.match(ctl.avisos.join(' '), /cliente nuevo en Finnegans/);
  assert.equal((await call('GET', `/records/deal/${d2.id}/timeline?types=task`)).data.activities.filter((a) => /^Completar datos/.test(a.subject)).length, 0);
});
