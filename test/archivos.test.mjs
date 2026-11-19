// Archivos fuera de la base (src/worker/archivos.ts, auditoría del 19/11/2026): las fotos de los remitos, los adjuntos del
// chat y los PDF de las facturas van al bucket R2 (en desarrollo, el que simula wrangler dev); en la base queda la clave.
// Lo que ya estaba en la base pasa a R2 de a poco (moverAR2) y se sigue viendo igual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const sql = (command) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'formas-crm', '--local', '--json', '--command', command], { stdio: ['ignore', 'pipe', 'pipe'] }).toString())[0].results;
async function api(method, path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${CRM}/api${path}`, { method, headers: { ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  const t = await res.text();
  let data = t;
  try { data = t ? JSON.parse(t) : null; } catch { /* binario */ }
  return { status: res.status, data, res };
}
const bytes = async (path) => new Uint8Array(await (await fetch(`${CRM}/api${path}`)).arrayBuffer());
// Un PNG chico de verdad (el chat mira el contenido, no solo la extensión).
const PNG = Uint8Array.from(Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex'));

test('un adjunto del chat va a R2 y se baja igual', async () => {
  const st = await api('GET', '/integrations/pedidos');
  if (!st.data?.archivos?.r2) return assert.fail(`wrangler dev sin el bucket R2: ${JSON.stringify(st.data?.archivos)}`);
  const pedido = (await api('POST', '/records/order', { props: { hs_order_name: `Archivos ${RUN}` } })).data;
  const form = new FormData();
  form.append('archivo', new File([PNG], 'foto.png', { type: 'image/png' }));
  const sub = await api('POST', `/records/order/${pedido.id}/conversacion/adjuntos`, form);
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const fila = sql(`SELECT r2_key, length(data) AS largo FROM mensaje_adjuntos WHERE id = ${sub.data.id}`)[0];
  assert.match(fila.r2_key, /^adjuntos\//);
  assert.equal(fila.largo, 0, 'en la base no queda el archivo');
  assert.deepEqual(await bytes(`/mensaje-adjuntos/${sub.data.id}`), PNG);
  // Sacarlo antes de mandarlo lo borra también de R2 (y de la base).
  assert.equal((await api('DELETE', `/mensaje-adjuntos/${sub.data.id}`)).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM mensaje_adjuntos WHERE id = ${sub.data.id}`)[0].n, 0);
});

test('lo que estaba en la base pasa a R2 y se sigue viendo igual', async () => {
  const pedido = (await api('POST', '/records/order', { props: { hs_order_name: `Viejo ${RUN}` } })).data;
  const hex = Buffer.from(PNG).toString('hex');
  // Un remito y un adjunto guardados como antes (BLOB en la fila).
  sql(`INSERT INTO remitos (record_id, origen, nombre, mime, size, data, hash, estado) VALUES (${pedido.id}, 'crm', 'viejo.png', 'image/png', ${PNG.length}, X'${hex}', 'viejo-${RUN}', 'ok')`);
  const remito = sql(`SELECT id FROM remitos WHERE hash = 'viejo-${RUN}'`)[0].id;
  sql(`INSERT INTO mensaje_adjuntos (record_id, user_id, nombre, mime, size, data) VALUES (${pedido.id}, 1, 'viejo.png', 'image/png', ${PNG.length}, X'${hex}')`);
  const adj = sql(`SELECT MAX(id) AS id FROM mensaje_adjuntos WHERE record_id = ${pedido.id}`)[0].id;
  sql(`UPDATE mensaje_adjuntos SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1) WHERE id = ${adj}`);
  const antes = (await api('GET', '/integrations/pedidos')).data.archivos.en_base;
  assert.ok(antes.remitos >= 1 && antes.adjuntos >= 1, JSON.stringify(antes));

  for (let i = 0; i < 20 && (await api('GET', '/integrations/pedidos')).data.archivos.en_base.total > 0; i++) {
    const r = await api('POST', '/archivos/mover', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const rem = sql(`SELECT r2_key, data IS NULL AS sin_data FROM remitos WHERE id = ${remito}`)[0];
  assert.match(rem.r2_key, /^remitos\//);
  assert.equal(rem.sin_data, 1, 'el remito ya no ocupa lugar en la base');
  assert.deepEqual(await bytes(`/remitos/${remito}/archivo`), PNG, 'el remito se ve igual');
  const a = sql(`SELECT r2_key, length(data) AS largo FROM mensaje_adjuntos WHERE id = ${adj}`)[0];
  assert.deepEqual([/^adjuntos\//.test(a.r2_key), a.largo], [true, 0]);
  assert.deepEqual(await bytes(`/mensaje-adjuntos/${adj}`), PNG, 'el adjunto se ve igual');
  assert.equal((await api('GET', '/integrations/pedidos')).data.archivos.en_base.total, 0, 'no queda nada en la base');
  // Mover es solo para administradores.
  const v = (await api('POST', '/users', { email: `ventas-r2-${RUN}@example.com`, name: `Ventas R2 ${RUN}`, profile: 'comercial', role: 'member' })).data;
  assert.equal((await api('POST', '/archivos/mover', {}, { 'x-dev-user': `ventas-r2-${RUN}@example.com` })).status, 403, JSON.stringify(v));
});
