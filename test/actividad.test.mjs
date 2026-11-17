// «Última actividad» nunca vacía (pedido de Rodrigo del 16/11/2026): cargar el negocio ya es actividad, y también cuentan
// el cambio de etapa y la conversación (que antes se perdía al recalcular por una nota). Y la tarjeta del tablero trae el
// celular del contacto para el botón de WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const ultima = async (id) => (await api('GET', `/records/deal/${id}`)).data.record.props.notes_last_updated;
const espera = () => new Promise((r) => setTimeout(r, 20));

test('última actividad: alta, cambio de etapa y conversación; celular en la tarjeta', async () => {
  const contacto = (await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Wapp', lastname: RUN, mobilephone: '11 5555-0199' } })).data;
  const neg = await api('POST', '/records/deal', { props: { dealname: `Actividad ${RUN}`, pipeline: 'default', dealstage: 'appointmentscheduled' }, associations: [contacto.id] });
  assert.equal(neg.status, 201, JSON.stringify(neg.data));
  const id = neg.data.id;

  // Recién cargado: la última actividad es el alta, no «Sin actividad».
  const alta = await ultima(id);
  assert.equal(alta, neg.data.props.createdate);

  // Mover de etapa cuenta.
  await espera();
  const mov = await api('PATCH', `/records/deal/${id}`, { props: { dealstage: 'presentationscheduled', amount: 1000 } });
  assert.equal(mov.status, 200, JSON.stringify(mov.data));
  const trasEtapa = await ultima(id);
  assert.ok(trasEtapa > alta, `${trasEtapa} > ${alta}`);

  // Un mensaje en la conversación cuenta, y una nota vieja (que recalcula todo) no lo pisa.
  await espera();
  const m = await api('POST', `/records/deal/${id}/conversacion`, { body: `Hola ${RUN}` });
  assert.equal(m.status, 201, JSON.stringify(m.data));
  const trasMensaje = await ultima(id);
  assert.ok(trasMensaje > trasEtapa, `${trasMensaje} > ${trasEtapa}`);
  const nota = await api('POST', '/activities', { type: 'note', body: 'De antes', occurred_at: '2020-01-01T00:00:00.000Z', links: [id] });
  assert.equal(nota.status, 201, JSON.stringify(nota.data));
  assert.equal(await ultima(id), trasMensaje, 'la nota vieja no la hace retroceder');

  // La tarjeta del tablero trae el celular del contacto (para el botón de WhatsApp).
  const tablero = (await api('GET', '/board?pipeline=default')).data;
  const card = tablero.columns.flatMap((c) => c.deals).find((d) => d.id === id);
  assert.ok(card, 'el negocio está en el tablero');
  assert.equal(card.card.contact.id, contacto.id);
  assert.match(String(card.card.contact.phone), /5555/);
});
