// Referidos (referidos.ts): lo que manda el pedido de referidos del Workspace (/hooks/referidos), la carga desde la ficha
// del cliente (/api/referidos), la pantalla Referidos, la tarjeta de la ficha y la tarea de agradecer al ganar.
// Contra un `wrangler dev` corriendo, como el resto.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const NUM = String(Date.now()).slice(-7);

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const api = (m, p, b) => call(m, `/api${p}`, b);
const s = {};

test('preparación: el cliente que recomienda (empresa, contacto y su pedido) y el token del tablero', async () => {
  const me = (await api('GET', '/me')).data;
  s.me = me;
  const emp = await api('POST', '/records/company', { props: { name: `Distribuidora Andina ${RUN}` } });
  assert.equal(emp.status, 201, JSON.stringify(emp.data));
  s.empresa = emp.data.id;
  const ct = await api('POST', '/records/contact', { props: { origen_del_contacto: 'Linkedin', firstname: 'Fio', lastname: `Antonelli ${RUN}`, email: `fio-${RUN}@andina.com.ar` }, associations: [s.empresa] });
  assert.equal(ct.status, 201, JSON.stringify(ct.data));
  s.contacto = ct.data.id;
  s.pdv = `9${NUM.slice(-4)}`;
  const ped = await api('POST', '/records/order', { props: { hs_order_name: `PDV - ${s.pdv}`, pdv_finnegans: `PDV - ${s.pdv}` }, associations: [s.empresa, s.contacto] });
  assert.equal(ped.status, 201, JSON.stringify(ped.data));
  const tok = await api('POST', '/tokens', { name: `Tablero ${RUN}`, source: 'api' });
  assert.equal(tok.status, 201);
  s.h = { authorization: `Bearer ${tok.data.token}` };
});

test('el tablero carga un referido: contacto, negocio en Lead, nota en las dos puntas y tarea para la vendedora', async () => {
  assert.equal((await call('POST', '/hooks/referidos', { referido: { nombre: 'X' } })).status, 401, 'sin token, nada');
  const cuerpo = {
    clave: `carolina|grupo patagonia|${RUN}|shop:${s.pdv}`, owner_email: s.me.email.replace(/@.*/, '@formas.ar'), cargado_por: 'eli@formas.ar',
    referido: { nombre: `Carolina Sosa ${RUN}`, empresa: `Grupo Patagonia ${RUN}`, contacto: `011 15 4${NUM}` },
    referidor: { nombre: 'DISTRIBUIDORA ANDINA S.R.L.', pdvs: [`shop:${s.pdv}`] }, nota: 'Necesita 200 termos para fin de año',
  };
  const r = await call('POST', '/hooks/referidos', cuerpo, s.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ya_estaba, false);
  assert.equal(r.data.nuevo_contacto, true);
  assert.equal(r.data.referidor.empresa?.id, s.empresa, 'quien lo recomendó, por el N° de PDV');
  assert.equal(r.data.referidor.contacto?.id, s.contacto, 'y su contacto, el del pedido');
  s.ref = r.data;

  const c = (await api('GET', `/records/contact/${r.data.contacto.id}`)).data;
  assert.equal(c.record.props.mobilephone, `549114${NUM}`, 'el teléfono, listo para WhatsApp (sin 0 ni 15)');
  assert.equal(c.record.props.tipo_de_origen, 'Referido');
  assert.equal(c.record.props.origen_del_contacto, 'Ejecutiva de cuentas');
  assert.equal(c.record.props.owner_id, s.me.id, 'a nombre de la vendedora aunque mande el mail con otro dominio de Formas');
  assert.ok(c.associations.company.some((x) => x.name === `Grupo Patagonia ${RUN}`), 'con su empresa');

  const d = (await api('GET', `/records/deal/${r.data.negocio.id}`)).data;
  assert.equal(d.record.props.dealname, `Carolina Sosa ${RUN} (Grupo Patagonia ${RUN}) - Referido de DISTRIBUIDORA ANDINA S.R.L.`);
  assert.equal(d.record.props.pipeline, 'default');
  assert.equal(d.record.props.dealstage, '1000604528', 'en Lead');
  assert.equal(d.record.props.tipo_de_origen, 'Referido');
  assert.equal(d.record.props.origen_del_negocio, 'Ejecutiva de cuentas');
  assert.equal(d.record.props.owner_id, s.me.id);
  assert.match(d.record.props.description, new RegExp(`Referido de DISTRIBUIDORA ANDINA S.R.L. \\(PDV ${s.pdv}\\)\\. Lo cargó eli@formas.ar`));
  assert.deepEqual(d.associations.contact.map((x) => x.id), [r.data.contacto.id]);

  const tl = (await api('GET', `/records/company/${s.empresa}/timeline?rollup=0`)).data;
  assert.ok(tl.activities.some((a) => a.type === 'note' && a.body.includes(`nos recomendó a Carolina Sosa ${RUN}`) && a.body.includes('200 termos')), 'la nota en el cliente que lo recomendó');
  const tlr = (await api('GET', `/records/contact/${r.data.contacto.id}/timeline?rollup=0`)).data;
  assert.ok(tlr.activities.some((a) => a.type === 'note' && a.body.includes('DISTRIBUIDORA ANDINA')), 'y en el referido');
  const tarea = tlr.activities.find((a) => a.type === 'task' && a.subject.startsWith(`Contactar a Carolina Sosa ${RUN}`));
  assert.ok(tarea, 'la tarea de contactarlo');
  assert.equal(tarea.owner_id, s.me.id);
  assert.equal(tarea.task_type, 'call');
  const dia = new Date(tarea.due_at);
  assert.ok(dia > new Date() && ![0, 6].includes(dia.getUTCDay()), 'el día hábil siguiente');
});

test('reintentar con la misma clave no duplica; el mismo teléfono usa el contacto que ya está', async () => {
  const again = await call('POST', '/hooks/referidos', { clave: s.ref.clave, referido: { nombre: 'Otro', contacto: 'otro@x.com' }, referidor: { nombre: 'Otro' } }, s.h);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.ya_estaba, true);
  assert.equal(again.data.negocio.id, s.ref.negocio.id);
  const mismo = await call('POST', '/hooks/referidos', { clave: `otra-${RUN}`, referido: { nombre: 'Caro', contacto: `+54 9 11 4${NUM}` }, referidor: { nombre: `Distribuidora Andina ${RUN}` } }, s.h);
  assert.equal(mismo.status, 200, JSON.stringify(mismo.data));
  assert.equal(mismo.data.nuevo_contacto, false);
  assert.equal(mismo.data.contacto.id, s.ref.contacto.id, 'mismo teléfono, mismo contacto');
  assert.equal(mismo.data.referidor.empresa?.id, s.empresa, 'quien recomienda, por el nombre de la empresa');
  assert.notEqual(mismo.data.negocio.id, s.ref.negocio.id, 'un negocio nuevo');
  const sin = await call('POST', '/hooks/referidos', { referido: { nombre: 'Sin datos' }, referidor: { nombre: 'X' } }, s.h);
  assert.equal(sin.status, 400);
  assert.match(sin.data.error, /teléfono o el mail/);
});

test('la ficha del cliente: a quién recomendó, y «Nos recomendó a…» desde el Hub', async () => {
  const f = (await api('GET', `/records/company/${s.empresa}/referidos`)).data;
  assert.ok(f.recomendo.some((x) => x.negocio?.id === s.ref.negocio.id && x.contacto?.id === s.ref.contacto.id));
  const del = (await api('GET', `/records/contact/${s.ref.contacto.id}/referidos`)).data;
  assert.equal(del.lo_recomendo[0]?.referidor.empresa?.id, s.empresa, 'el referido sabe quién lo recomendó');
  const r = await api('POST', '/referidos', { referidor_id: s.contacto, nombre: `Mario ${RUN}`, contacto: `mario-${RUN}@gmail.com`, nota: 'Lo conoce del club' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.referidor.contacto?.id, s.contacto);
  assert.equal(r.data.referidor.empresa?.id, s.empresa, 'la empresa principal del contacto que recomienda');
  const d = (await api('GET', `/records/deal/${r.data.negocio.id}`)).data;
  assert.equal(d.record.props.tipo_de_origen, 'Referido');
  assert.match(d.record.props.description, /desde el Hub/);
  s.hub = r.data;
  assert.equal((await api('POST', '/referidos', { referidor_id: s.ref.negocio.id, nombre: 'X', contacto: 'x@y.com' })).status, 400, 'recomienda una empresa o un contacto');
});

test('la pantalla Referidos: los nuevos y los de antes (HubSpot), con el resumen', async () => {
  const viejo = await api('POST', '/records/deal', { props: { dealname: `Pedro ${RUN} - Referido de Viejo Cliente SA`, pipeline: 'default', dealstage: '1000604528',
    tipo_de_origen: 'Referido', description: `Referido de Viejo Cliente ${RUN} (PDV 30001). Lo cargó jorgelina@formas.ar desde el Workspace el 20/10/2026.` } });
  assert.equal(viejo.status, 201, JSON.stringify(viejo.data));
  const l = (await api('GET', '/referidos')).data;
  const nuevo = l.referidos.find((x) => x.negocio?.id === s.ref.negocio.id);
  assert.equal(nuevo?.origen, 'tablero');
  assert.equal(nuevo?.referidor.empresa?.name, `Distribuidora Andina ${RUN}`);
  const antes = l.referidos.find((x) => x.negocio?.id === viejo.data.id);
  assert.equal(antes?.origen, 'antes');
  assert.equal(antes?.referidor.nombre, `Viejo Cliente ${RUN}`, 'quien lo recomendó, leído del negocio');
  assert.deepEqual(antes?.pdvs, ['30001']);
  assert.ok(l.resumen.total >= 4 && l.resumen.abiertos >= 4);
});

test('al ganar el negocio del referido, la tarea de agradecerle a quien lo recomendó (una sola vez)', async () => {
  const id = s.ref.negocio.id;
  const g = await api('PATCH', `/records/deal/${id}`, { props: { dealstage: 'closedwon', amount: 350000 } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const tl = (await api('GET', `/records/company/${s.empresa}/timeline?rollup=0`)).data;
  const gracias = tl.activities.filter((a) => a.type === 'task' && a.subject.startsWith('Agradecerle a DISTRIBUIDORA ANDINA S.R.L.'));
  assert.equal(gracias.length, 1, JSON.stringify(tl.activities.map((a) => a.subject)));
  assert.equal(gracias[0].owner_id, s.me.id);
  await api('PATCH', `/records/deal/${id}`, { props: { dealstage: 'contractsent' } });
  await api('PATCH', `/records/deal/${id}`, { props: { dealstage: 'closedwon' } });
  const tl2 = (await api('GET', `/records/company/${s.empresa}/timeline?rollup=0`)).data;
  assert.equal(tl2.activities.filter((a) => a.type === 'task' && a.subject.startsWith('Agradecerle a DISTRIBUIDORA')).length, 1, 'no se repite');
  const l = (await api('GET', '/referidos')).data;
  assert.ok(l.resumen.ganados >= 1 && l.resumen.monto_ganado >= 350000);
});
