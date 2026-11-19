// Auditoría del 19/11/2026, inconsistencias de datos: lo que reprodujeron los agentes, cerrado.
// - Dos cambios a la vez sobre el mismo registro se pisaban (records.ts, updateRecord: se guarda solo si nadie lo cambió en el medio).
// - «0.125» se guardaba como 125 (records.ts, numeroEscrito). La fecha de cierre salía en UTC (env.ts, hoyEnBuenosAires).
// - Combinar dejaba la conversación y lo demás en el archivado (records.ts, REFERENCIAS_A_REGISTRO).
// - Archivar un pedido no cambiaba el monto de su negocio (api.ts → montos.ts).
// - La sincronización con HubSpot reactivaba usuarios, pisaba registros de otro tipo y aceptaba ids de los propios (migrate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* texto */ }
  return { status: res.status, data };
}
const props = async (type, id) => (await api('GET', `/records/${type}/${id}`)).data.record.props;

test('diez cambios a la vez sobre el mismo registro: no se pierde ninguno', async () => {
  const c = (await api('POST', '/records/contact', { props: { firstname: 'Carrera', lastname: RUN, origen_del_contacto: 'Llamada entrante' } })).data;
  assert.ok(c.id, JSON.stringify(c));
  const campos = { jobtitle: 'Compras', city: 'Córdoba', state: 'Córdoba', country: 'Argentina', address: 'San Martín 100', zip: '5000', company: `Carrera SA ${RUN}`,
    website: `https://carrera-${RUN}.com.ar`, industry: 'Textil', prospect_source: 'Feria' };
  const res = await Promise.all(Object.entries(campos).map(([k, v]) => api('PATCH', `/records/contact/${c.id}`, { props: { [k]: v } })));
  const ok = Object.keys(campos).filter((_, i) => res[i].status === 200);
  assert.ok(res.every((r) => [200, 409].includes(r.status)), JSON.stringify(res.map((r) => r.status)));
  assert.ok(ok.length >= 8, `la mayoría entra sola, con reintentos (${ok.length}/10)`);
  const guardado = await props('contact', c.id);
  for (const k of ok) assert.equal(guardado[k], campos[k], `«${k}» respondió 200 y quedó guardado`);
  // El historial dice lo mismo que el dato: un cambio por campo guardado, ninguno de más.
  const hist = (await api('GET', `/records/contact/${c.id}/history`)).data;
  for (const k of Object.keys(campos)) assert.equal(hist.filter((h) => h.prop === k).length, ok.includes(k) ? 1 : 0, `historial de «${k}»`);
});

test('números escritos a mano: «0.125» no es 125, y «1.500» sigue siendo mil quinientos', async () => {
  const d = (await api('POST', '/records/deal', { props: { dealname: `Números ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled' } })).data;
  for (const [escrito, valor] of [['0.125', 0.125], ['1.500', 1500], ['1.234.567,89', 1234567.89], ['1234.567', 1234.567], ['12,5', 12.5], ['$ 2.000', 2000]]) {
    const r = await api('PATCH', `/records/deal/${d.id}`, { props: { amount: escrito } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await props('deal', d.id)).amount, valor, `«${escrito}»`);
  }
  assert.equal((await api('PATCH', `/records/deal/${d.id}`, { props: { amount: 'mucho' } })).status, 400, 'un texto sin números no es 0');
});

test('la fecha de cierre que se completa sola es la de Buenos Aires, y queda en el historial', async () => {
  const d = (await api('POST', '/records/deal', { props: { dealname: `Cierre ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 1000 } })).data;
  const r = await api('PATCH', `/records/deal/${d.id}`, { props: { dealstage: 'closedwon' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const hoyAr = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  assert.equal((await props('deal', d.id)).closedate, hoyAr);
  const hist = (await api('GET', `/records/deal/${d.id}/history`)).data;
  assert.ok(hist.some((h) => h.prop === 'closedate' && h.new_value === hoyAr), 'queda en el historial');
});

test('combinar pasa la conversación al que queda', async () => {
  const queda = (await api('POST', '/records/order', { props: { hs_order_name: `Queda ${RUN}` } })).data;
  const sale = (await api('POST', '/records/order', { props: { hs_order_name: `Sale ${RUN}` } })).data;
  const msg = await api('POST', `/records/order/${sale.id}/conversacion`, { body: `Mensaje del duplicado ${RUN}` });
  assert.ok([200, 201].includes(msg.status), JSON.stringify(msg.data));
  assert.equal((await api('POST', `/records/order/${queda.id}/merge`, { other_id: sale.id })).status, 200);
  const conv = JSON.stringify((await api('GET', `/records/order/${queda.id}/conversacion`)).data);
  assert.ok(conv.includes(`Mensaje del duplicado ${RUN}`), 'el mensaje está en el que queda');
});

test('archivar un pedido saca su total del monto del negocio', async () => {
  const deal = (await api('POST', '/records/deal', { props: { dealname: `Monto ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled', amount: 1 } })).data;
  const o1 = (await api('POST', '/records/order', { props: { hs_order_name: `Monto ${RUN} 1`, hs_total_price: 400 } })).data;
  const o2 = (await api('POST', '/records/order', { props: { hs_order_name: `Monto ${RUN} 2`, hs_total_price: 100 } })).data;
  for (const o of [o1, o2]) await api('POST', '/associations', { from_id: deal.id, to_id: o.id });
  assert.equal((await props('deal', deal.id)).amount, 500);
  assert.equal((await api('DELETE', `/records/order/${o2.id}`)).status, 200);
  assert.equal((await props('deal', deal.id)).amount, 400, 'el archivado deja de contar');
  assert.equal((await api('POST', `/records/order/${o2.id}/restore`, {})).status, 200);
  assert.equal((await props('deal', deal.id)).amount, 500, 'restaurado, vuelve a contar');
});

test('la sincronización con HubSpot no reactiva usuarios, no mezcla tipos ni pisa ids propios', async () => {
  const hs = String(Date.now()).slice(-9);
  const email = `sync-${RUN}@formas.ar`;
  const usuario = (activo) => api('POST', '/migrate', { kind: 'users', items: [{ hs_owner_id: hs, email, name: `Sync ${RUN}`, active: activo }] });
  assert.equal((await usuario(true)).status, 200);
  const u = (await api('GET', '/users')).data.find((x) => x.email === email);
  assert.ok(u, 'se creó');
  assert.equal((await api('PATCH', `/users/${u.id}`, { active: false })).status, 200, 'se desactiva en el CRM');
  await usuario(true);
  assert.equal((await api('GET', '/users')).data.find((x) => x.id === u.id).active, 0, 'HubSpot no lo vuelve a activar');

  const id = 71_000_000_000 + (Date.now() % 1e8);
  const ts = new Date().toISOString();
  const cargar = (type, p) => api('POST', '/migrate', { kind: 'records', items: [{ type, hs_id: id, props: p, created_at: ts, updated_at: ts }] });
  assert.equal((await cargar('contacts', { firstname: 'Contacto', lastname: `Sync ${RUN}` })).status, 200);
  assert.equal((await cargar('companies', { name: `Empresa Sync ${RUN}`, domain: `sync-${RUN}.com.ar` })).status, 200);
  const c = (await api('GET', `/records/contact/${id}`)).data.record;
  assert.equal(c.name, `Contacto Sync ${RUN}`, 'el contacto no tomó los datos de la empresa');
  assert.equal(c.props.domain ?? null, null);

  const propio = (await api('POST', '/records/company', { props: { name: `Propia ${RUN}` } })).data;
  const pisar = await api('POST', '/migrate', { kind: 'records', items: [{ type: 'companies', hs_id: propio.id, props: { name: 'PISADA' }, created_at: ts, updated_at: ts }] });
  assert.equal(pisar.data.rechazados, 1, JSON.stringify(pisar.data));
  assert.equal((await api('GET', `/records/company/${propio.id}`)).data.record.name, `Propia ${RUN}`);
});
