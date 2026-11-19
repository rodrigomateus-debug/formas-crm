// Buzón de ideas (ideas.ts, Formi): todos proponen y votan, el ranking por votos, los administradores las marcan y la
// campanita avisa a quien la propuso y a los que la votaron.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
let asUser = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-dev-user': asUser } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const como = (u) => { asUser = u; };

test('buzón de ideas: proponer, votar, ranking, marcar y avisos', async () => {
  como(null);
  const sole = (await api('POST', '/users', { email: `sole.ideas.${RUN}@formas.ar`, name: `Sole ${RUN}`, profile: 'produccion', role: 'member' })).data;
  const ceci = (await api('POST', '/users', { email: `ceci.ideas.${RUN}@formas.ar`, name: `Ceci ${RUN}`, profile: 'comercial', role: 'member' })).data;
  const mira = (await api('POST', '/users', { email: `mira.ideas.${RUN}@formas.ar`, name: `Mira ${RUN}`, profile: 'comercial', role: 'viewer' })).data;

  // Sole propone: queda pendiente y ya con su voto.
  como(sole.email);
  const corta = await api('POST', '/ideas', { texto: 'hola' });
  assert.equal(corta.status, 400);
  const a = await api('POST', '/ideas', { texto: `Filtrar pedidos por fecha de entrega ${RUN}` });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.estado, 'pendiente');
  assert.equal(a.data.votos, 1);
  assert.ok(a.data.votada && a.data.puede_editar);
  // La misma idea otra vez (aunque cambien mayúsculas y signos): a votar la que está.
  const repetida = await api('POST', '/ideas', { texto: `filtrar  pedidos por fecha de entrega ${RUN}!` });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.data.idea_id, a.data.id);

  // Ceci propone otra; la de solo lectura también puede proponer y votar.
  como(ceci.email);
  const b = (await api('POST', '/ideas', { texto: `Avisar cuando un cliente no contesta hace 3 días ${RUN}` })).data;
  assert.equal((await api('PATCH', `/ideas/${a.data.id}`, { texto: 'Le cambio la idea a Sole' })).status, 403);
  assert.equal((await api('DELETE', `/ideas/${a.data.id}`)).status, 403);
  como(mira.email);
  assert.equal((await api('PUT', `/ideas/${b.id}/voto`)).data.votos, 2);
  // Votar dos veces no suma dos.
  assert.equal((await api('PUT', `/ideas/${b.id}/voto`)).data.votos, 2);
  como(sole.email);
  const bv = (await api('PUT', `/ideas/${b.id}/voto`)).data;
  assert.equal(bv.votos, 3);
  assert.deepEqual(bv.votantes, [ceci.id, mira.id, sole.id]);
  // Sacarse el voto.
  assert.equal((await api('DELETE', `/ideas/${a.data.id}/voto`)).data.votos, 0);
  assert.equal((await api('PUT', `/ideas/${a.data.id}/voto`)).data.votos, 1);

  // El ranking: la más votada primero.
  const lista = (await api('GET', '/ideas')).data;
  assert.equal(lista.admin, false);
  const mias = lista.ideas.filter((i) => [a.data.id, b.id].includes(i.id)).map((i) => i.id);
  assert.deepEqual(mias, [b.id, a.data.id]);

  // Solo los administradores marcan.
  assert.equal((await api('POST', `/ideas/${b.id}/estado`, { estado: 'hecha' })).status, 403);

  // La autora la corrige mientras está pendiente.
  const corregida = await api('PATCH', `/ideas/${a.data.id}`, { texto: `Filtrar pedidos por fecha de entrega y por vendedora ${RUN}` });
  assert.equal(corregida.status, 200);
  assert.match(corregida.data.texto, /por vendedora/);

  // El administrador: «en marcha» le avisa a quien la propuso; «hecha», también a los que la votaron.
  como(null);
  const admin = (await api('GET', '/ideas')).data;
  assert.equal(admin.admin, true);
  const enMarcha = await api('POST', `/ideas/${b.id}/estado`, { estado: 'en_curso' });
  assert.equal(enMarcha.data.estado, 'en_curso');
  const hecha = await api('POST', `/ideas/${b.id}/estado`, { estado: 'hecha', respuesta: 'Listo: está en Inicio → Pendientes' });
  assert.equal(hecha.data.estado, 'hecha');
  assert.equal(hecha.data.respuesta, 'Listo: está en Inicio → Pendientes');
  assert.ok(hecha.data.estado_at);
  // Hecha: no se vota más.
  como(sole.email);
  assert.equal((await api('DELETE', `/ideas/${b.id}/voto`)).status, 409);

  como(ceci.email);
  const nCeci = (await api('GET', '/notificaciones')).data.items.filter((n) => n.idea_id === b.id).map((n) => n.kind).sort();
  assert.deepEqual(nCeci, ['idea_en_curso', 'idea_hecha']);
  como(mira.email);
  const nMira = (await api('GET', '/notificaciones')).data.items.filter((n) => n.idea_id === b.id);
  assert.deepEqual(nMira.map((n) => n.kind), ['idea_votada_hecha']);
  assert.match(nMira[0].texto, /Inicio → Pendientes/);
  como(sole.email);
  assert.deepEqual((await api('GET', '/notificaciones')).data.items.filter((n) => n.idea_id === b.id).map((n) => n.kind), ['idea_votada_hecha']);

  // Dejó de estar pendiente: Ceci ya no la puede corregir ni borrar.
  como(ceci.email);
  assert.equal((await api('PATCH', `/ideas/${b.id}`, { texto: 'Otra cosa distinta a lo que era' })).status, 403);

  // Los administradores reciben las ideas nuevas en la campanita; si se borra, el aviso desaparece.
  como(null);
  const nuevas = (await api('GET', '/notificaciones')).data.items.filter((n) => n.kind === 'idea_nueva' && n.idea_id === a.data.id);
  assert.equal(nuevas.length, 1);
  como(sole.email);
  assert.equal((await api('DELETE', `/ideas/${a.data.id}`)).status, 200);
  assert.ok(!(await api('GET', '/ideas')).data.ideas.some((i) => i.id === a.data.id));
  como(null);
  assert.ok(!(await api('GET', '/notificaciones')).data.items.some((n) => n.idea_id === a.data.id));
  assert.equal((await api('POST', `/ideas/${a.data.id}/estado`, { estado: 'hecha' })).status, 404);
});
