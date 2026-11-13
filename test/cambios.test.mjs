// Pedidos compartidos (src/worker/compartidos.ts) y avisos de cambios al vendedor (src/worker/cambios.ts), pedido de Rodrigo
// del 13/11/2026: Vera (vendedora) le comparte su pedido a Bea (su backoffice, también perfil Ventas), y Ceci (Producción)
// cambia la fecha y la dirección de entrega, sube y aprueba un boceto y sube un logo: a Vera y a Bea les llega a la
// campanita (y por mail, si lo tienen prendido) qué cambió y quién. Drive y Gmail simulados en el puerto 8799
// (test/google-falso.mjs); sin la cuenta de servicio de prueba se saltean los bocetos, los logos y el mail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { googleFalso } from './google-falso.mjs';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function call(method, path, body, headers = {}) {
  const form = body instanceof FormData;
  const res = await fetch(`${CRM}${path.startsWith('/hooks') ? '' : '/api'}${path}`, { method,
    headers: { ...(body === undefined || form ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const archivo = (nombre, contenido, campos = {}) => {
  const fd = new FormData();
  fd.append('archivo', new File([Buffer.from(contenido, 'latin1')], nombre, nombre.endsWith('.pdf') ? { type: 'application/pdf' } : {}));
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  return fd;
};
const decode = (raw) => raw.split(/--fcrm\w+/).map((part) => {
  const [head, ...rest] = part.split('\r\n\r\n');
  return /base64/.test(head) ? Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64').toString() : '';
}).join('\n');
const asunto = (raw) => {
  const m = raw.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m);
  return m ? Buffer.from(m[1], 'base64').toString() : '';
};

let g;
before(async () => { g = await googleFalso(); });
after(async () => { await g.cerrar(); });

test('pedido compartido con el backoffice y avisos de lo que cambia producción', async (t) => {
  const usuario = async (nombre, profile) => {
    const u = (await call('POST', '/users', { email: `${nombre.toLowerCase()}.cc.${RUN}@formas.ar`, name: `${nombre} ${RUN}`, profile, role: 'member' })).data;
    const tok = (await call('POST', '/tokens', { name: `${nombre} ${RUN}`, source: 'api', user_id: u.id })).data.token;
    return { ...u, H: { authorization: `Bearer ${tok}` } };
  };
  const vera = await usuario('Vera', 'comercial');
  const bea = await usuario('Bea', 'comercial');
  const ceci = await usuario('Ceci', 'produccion');
  const emp = (await call('POST', '/records/company', { props: { name: `Cliente CC ${RUN}`, owner_id: vera.id } })).data;
  const pedido = (await call('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN} · Compartido`, owner_id: vera.id }, associations: [emp.id] })).data;
  const url = `/records/order/${pedido.id}`;
  const avisos = async (u, kind) => (await call('GET', '/notificaciones?limite=100', undefined, u.H)).data.items
    .filter((n) => (n.record_id === pedido.id || n.record_id === emp.id) && (!kind || n.kind === kind));

  // 1. Bea (perfil Ventas) no ve el pedido de Vera; el aviso le dice que se lo pida.
  let r = await call('GET', url, undefined, bea.H);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /que te lo comparta/);

  // 2. Vera se lo comparte. El propietario no cuenta (ya lo ve); alguien que no es usuario del CRM, no.
  r = await call('PUT', `${url}/compartidos`, { users: [vera.id, bea.id] }, vera.H);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.compartidos, [bea.id]);
  assert.equal((await call('PUT', `${url}/compartidos`, { users: [bea.id, 987654321] }, vera.H)).status, 400);
  r = await call('GET', url, undefined, bea.H);
  assert.equal(r.status, 200, 'ahora lo ve');
  assert.deepEqual(r.data.compartidos, [bea.id]);
  assert.equal((await call('GET', `/records/company/${emp.id}`, undefined, bea.H)).status, 200, 'y al cliente del pedido');
  const mios = (await call('POST', '/records/order/search', { filters: [{ prop: 'owner_id', op: 'in', values: ['me'] }], limit: 200 }, bea.H)).data;
  assert.ok(mios.results.some((x) => x.id === pedido.id), 'en «Míos» le aparece');
  assert.deepEqual((await avisos(bea)).map((n) => [n.kind, n.by_user]), [['compartido', vera.id]], 'le avisa que se lo compartieron');
  let conv = (await call('GET', `${url}/conversacion`, undefined, bea.H)).data;
  assert.equal(conv.items.find((i) => i.kind === 'cambio' && i.prop === 'compartido_con')?.despues, bea.name, 'queda en la conversación');
  assert.ok(conv.participantes.some((p) => p.user_id === bea.id && p.siguiendo), 'y la sigue');

  // 3. Producción cambia la fecha y la dirección de entrega: a Vera y a Bea, un solo aviso con los dos cambios; a Ceci, nada.
  assert.equal((await call('PATCH', url, { props: { fecha_de_entrega: '2026-11-18' } }, ceci.H)).status, 200);
  const dir = { direcciones: [{ direccion: 'Av. Corrientes 1234, CABA', detalle: 'Piso 3' }] };
  r = await call('PUT', `${url}/direcciones`, dir, ceci.H);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const esperado = ['Cambió la fecha de entrega a mié 18/11/2026', 'Cambió la dirección de entrega a «Av. Corrientes 1234, CABA (Piso 3)»'];
  for (const u of [vera, bea]) {
    const ns = await avisos(u, 'cambio');
    assert.deepEqual(ns.map((n) => [n.by_user, n.detalle]), [[ceci.id, esperado]], u.name);
  }
  assert.deepEqual(await avisos(ceci), [], 'a quien hizo el cambio, no');
  // Guardar la misma dirección no es un cambio.
  await call('PUT', `${url}/direcciones`, { direcciones: [{ id: r.data.direcciones[0].id, direccion: 'Av. Corrientes 1234, CABA', detalle: 'Piso 3' }] }, ceci.H);
  assert.deepEqual((await avisos(vera, 'cambio'))[0].detalle, esperado);

  // 4. Lo que cambia la vendedora no le avisa a ella; a Bea sí (aparte: es de otra persona).
  await call('PATCH', url, { props: { fecha_de_entrega: '2026-11-20' } }, vera.H);
  assert.equal((await avisos(vera, 'cambio')).length, 1);
  assert.deepEqual((await avisos(bea, 'cambio')).filter((n) => n.by_user === vera.id).map((n) => n.detalle), [['Cambió la fecha de entrega a vie 20/11/2026']]);

  // 5. Leído el aviso, el próximo cambio va en uno nuevo.
  await call('POST', '/notificaciones/leidas', {}, vera.H);
  await call('PATCH', url, { props: { fecha_de_entrega: null } }, ceci.H);
  let nv = await avisos(vera, 'cambio');
  assert.deepEqual(nv.map((n) => [n.detalle, !!n.leido_at]), [[['Quitó la fecha de entrega'], false], [esperado, true]]);

  // 6. Bocetos y logos (Drive simulado) y el mail.
  if (!(await call('GET', '/integrations/bocetos')).data.cuenta_de_servicio) { t.diagnostic('sin GOOGLE_SA_JSON de prueba: sin bocetos, logos ni mail'); }
  else {
    await call('PUT', '/integrations/bocetos', { carpeta: '0ARaizDeBocetos123', usuario: 'rodrigo.mateus@formaspublicitarias.com' });
    await call('POST', '/notificaciones/leidas', {}, vera.H);
    const pdf = `%PDF-1.4\n% Boceto ${RUN}\n%%EOF`;
    const prod = { producto: 'TAZA-01', producto_nombre: 'Taza térmica' };
    const b = await call('POST', `${url}/bocetos`, archivo(`Boceto ${RUN}.pdf`, pdf, { ...prod, tipo: 'tecnico' }), ceci.H);
    assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.equal((await call('PATCH', `/bocetos/${b.data.id}`, { estado: 'aprobado' }, ceci.H)).status, 200);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>';
    const l = await call('POST', `${url}/logos`, archivo(`Logo ${RUN}.svg`, svg, prod), ceci.H);
    assert.equal(l.status, 201, JSON.stringify(l.data));
    assert.equal((await call('PUT', `${url}/logos/producto`, { ...prod, logo_id: null }, ceci.H)).status, 200);
    assert.equal((await call('DELETE', `/bocetos/${b.data.id}`, undefined, ceci.H)).status, 200);
    nv = await avisos(vera, 'cambio');
    assert.deepEqual(nv[0].detalle, [
      `Subió el boceto «Boceto ${RUN}.pdf» de Taza térmica`,
      `Aprobó el boceto «Boceto ${RUN}.pdf» de Taza térmica`,
      `Subió el logo «Logo ${RUN}.svg» para Taza térmica`,
      'Dejó el logo principal de la empresa para Taza térmica',
      `Quitó el boceto «Boceto ${RUN}.pdf» de Taza térmica`,
    ]);
    // Cambiar el logo principal se avisa en la empresa (a su propietaria).
    const l2 = (await call('POST', `/records/company/${emp.id}/logos`, archivo(`Negativo ${RUN}.svg`, svg, { etiqueta: 'Negativo' }), ceci.H)).data;
    await call('PATCH', `/logos/${l2.id}`, { principal: true }, ceci.H);
    assert.deepEqual((await avisos(vera, 'cambio')).find((n) => n.record_id === emp.id)?.detalle,
      [`Subió el logo «Negativo · Negativo ${RUN}.svg»`, `Cambió el logo principal a «Negativo · Negativo ${RUN}.svg»`]);

    // El mail: a Vera (con «Avisos por mail» prendido) le llega qué cambió en su pedido y quién lo cambió.
    const adm = { authorization: `Bearer ${(await call('POST', '/tokens', { name: `Avisos CC ${RUN}`, source: 'api' })).data.token}` };
    await call('PATCH', `/users/${vera.id}`, { avisos_mail: true });
    await call('PUT', '/hooks/avisos', { enabled: true }, adm);
    g.mails.length = 0;
    await call('POST', '/hooks/avisos/enviar', undefined, adm);
    const mail = g.mails.find((m) => m.raw.includes(`<${vera.email}>`));
    assert.ok(mail, 'le llega el mail a Vera');
    // Junto con lo que le asignaron (el pedido y la empresa, al crearlos a su nombre): «Novedades».
    assert.match(asunto(mail.raw), /^Novedades en Formas Hub \(\d+\)$/);
    const txt = decode(mail.raw);
    assert.match(txt, /estas son tus novedades en Formas Hub/);
    assert.match(txt, /Cambios en tus pedidos \(los hizo otra persona\)/);
    assert.match(txt, /Asignado a vos/);
    assert.match(txt, new RegExp(`${ceci.name}: Subió el boceto «Boceto ${RUN}\\.pdf» de Taza térmica · Aprobó el boceto`));
    assert.ok(txt.includes(`/orders/${pedido.id}`), 'con el link al pedido');
    // Lo que ya salió por mail no se junta: el próximo cambio es un aviso nuevo.
    await call('PATCH', url, { props: { fecha_de_entrega: '2026-11-25' } }, ceci.H);
    assert.deepEqual((await avisos(vera, 'cambio'))[0].detalle, ['Cambió la fecha de entrega a mié 25/11/2026']);
  }

  // 7. Dejar de compartirlo: Bea deja de verlo (y sus avisos de ese pedido también), y deja de seguir la conversación.
  r = await call('PUT', `${url}/compartidos`, { users: [] }, vera.H);
  assert.deepEqual(r.data.compartidos, []);
  assert.equal((await call('GET', url, undefined, bea.H)).status, 403);
  assert.deepEqual(await avisos(bea), []);
  conv = (await call('GET', `${url}/conversacion`)).data;
  assert.ok(!conv.participantes.some((p) => p.user_id === bea.id), 'ya no la sigue');
  const ev = conv.items.filter((i) => i.kind === 'cambio' && i.prop === 'compartido_con').at(-1);
  assert.deepEqual([ev.antes, ev.despues], [bea.name, null]);
  // Ventas no lo puede compartir si no lo ve.
  assert.equal((await call('PUT', `${url}/compartidos`, { users: [bea.id] }, bea.H)).status, 403);
});
