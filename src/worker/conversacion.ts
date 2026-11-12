import type { Ctx } from './env';
import { HttpError, now } from './env';
import { estadosPec } from './produccion';
import { visibleSql } from './alcance';

// Conversación de un pedido (o de un negocio), como los comentarios de una tarea de ClickUp (pedido de Rodrigo del
// 12/11/2026): un chat grupal entre el vendedor, producción y logística, con @menciones, que queda registrado. Entre los
// mensajes se ve la actividad del pedido, leída de donde ya está (no se copia):
// - cambios de etapa, propietario, monto, fecha de entrega, factura… (tabla changes)
// - cambios de estado de cada artículo en producción (produccion_cambios: los de ClickUp y los del CRM)
// - bocetos subidos y aprobados (bocetos)
// - remitos subidos (remitos)
// - notas, mails, llamadas, reuniones, tareas y WhatsApp del registro (activities)
//
// Quiénes la siguen (conversacion_participantes): quien escribe, a quien mencionan, el propietario y quien lo tiene
// asignado en producción. A ellos se les cuentan los mensajes sin leer (el globito del menú y de la tarjeta); a quien
// mencionan, además, le llega un aviso por mail si lo tiene prendido (avisos.ts).
//
// La pantalla la tiene abierta y pide las novedades cada tanto (`desde`): son pocas filas por índice.

// Las menciones van en el texto como @[Nombre](id). Así el texto se entiende solo (en el mail, en Claude) y el id no se
// pierde si cambia el nombre.
const MENCION = /@\[([^\]\n]{1,80})\]\((\d{1,15})\)/g;
const MAX = 5000;
// Imágenes: achicadas en el navegador (lado mayor 2000 px); acá, el tope de una fila de D1 y cuántas por mensaje.
const IMAGENES_POR_MENSAJE = 10;   // imágenes y archivos
const MIMES_IMAGEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function mencionesDe(body: string) {
  return [...new Set([...body.matchAll(MENCION)].map((m) => Number(m[2])))];
}
// El texto sin la marca de las menciones («@Ceci Dachary»), para el mail y las vistas previas.
export const textoPlano = (body: string) => body.replace(MENCION, '@$1');

// Lo que se muestra de cada cambio del registro.
const PROPS_CAMBIO = ['hs_pipeline_stage', 'dealstage', 'pipeline', 'owner_id', 'amount', 'hs_total_price', 'closedate', 'fecha_de_entrega',
  'estado_entrega', 'factura_numero', 'archived', 'merged'];

export interface Mensaje {
  id: number; record_id: number; user_id: number | null; body: string; menciones: number[]; responde_a: number | null;
  source: string; editado_at: string | null; borrado_at: string | null; created_at: string; adjuntos: Adjunto[];
}
export interface Adjunto { id: number; mensaje_id: number | null; nombre: string; mime: string; size: number; ancho: number | null; alto: number | null }
const COLS_ADJUNTO = 'id, mensaje_id, nombre, mime, size, ancho, alto';
interface MensajeRow extends Omit<Mensaje, 'menciones' | 'adjuntos'> { menciones: string }
const mensaje = (r: MensajeRow, adjuntos: Adjunto[] = []): Mensaje => ({
  ...r, menciones: JSON.parse(r.menciones || '[]'), body: r.borrado_at ? '' : r.body, adjuntos: r.borrado_at ? [] : adjuntos,
});

export type Item =
  | ({ key: string; kind: 'mensaje'; at: string } & Mensaje)
  | { key: string; kind: 'cambio'; at: string; prop: string; antes: string | null; despues: string | null; user_id: number | null; actor: string | null; source: string }
  | { key: string; kind: 'articulo'; at: string; articulo: string; es_pdv: boolean; antes: string | null; despues: string | null; user_id: number | null; actor: string | null; source: string }
  | { key: string; kind: 'boceto'; at: string; accion: 'subido' | 'aprobado'; boceto_id: number; nombre: string; producto: string | null; version: number; tipo: string; mime: string | null; user_id: number | null }
  | { key: string; kind: 'remito'; at: string; remito_id: number; numero: string | null; estado: string; origen: string; chofer: string | null; user_id: number | null }
  | { key: string; kind: 'actividad'; at: string; activity_id: number; tipo: string; subject: string; body: string; direction: string | null; status: string | null; due_at: string | null; user_id: number | null };

async function registro(db: D1Database, recordId: number) {
  const r = await db.prepare('SELECT id, object_type, name, owner_id FROM records WHERE id = ?').bind(recordId)
    .first<{ id: number; object_type: string; name: string; owner_id: number | null }>();
  if (!r) throw new HttpError(404, `No existe el registro ${recordId}.`);
  return r;
}

// La conversación entera (los últimos `limite` de cada cosa) o, con `desde`, lo que cambió después.
export async function conversacion(db: D1Database, ctx: Ctx, recordId: number, opts: { desde?: string | null; limite?: number } = {}) {
  await registro(db, recordId);
  const ahora = now();
  const desde = opts.desde && !Number.isNaN(Date.parse(opts.desde)) ? new Date(opts.desde).toISOString() : '';
  const lim = Math.min(Math.max(opts.limite ?? 300, 1), 500);
  const [msgs, chs, arts, bocs, rems, acts, parts, adjs] = await db.batch([
    db.prepare(`SELECT * FROM (SELECT * FROM mensajes WHERE record_id = ? AND COALESCE(borrado_at, editado_at, created_at) > ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .bind(recordId, desde, lim),
    db.prepare(`SELECT id, prop, old_value, new_value, changed_at, user_id, actor, source FROM changes
      WHERE record_id = ? AND changed_at > ? AND prop IN (SELECT value FROM json_each(?)) ORDER BY changed_at DESC LIMIT ?`)
      .bind(recordId, desde, JSON.stringify(PROPS_CAMBIO), lim),
    db.prepare('SELECT * FROM produccion_cambios WHERE record_id = ? AND at > ? ORDER BY at DESC LIMIT ?').bind(recordId, desde, lim),
    db.prepare(`SELECT id, nombre, producto_nombre, producto, version, tipo, mime, user_id, created_at, aprobado_at, aprobado_por FROM bocetos
      WHERE record_id = ?1 AND archived = 0 AND (created_at > ?2 OR aprobado_at > ?2) ORDER BY id DESC LIMIT 200`).bind(recordId, desde),
    db.prepare(`SELECT id, numero, estado, origen, chofer, subido_por, created_at FROM remitos
      WHERE record_id = ? AND created_at > ? AND estado NOT IN ('duplicado', 'descartado') ORDER BY id DESC LIMIT 100`).bind(recordId, desde),
    db.prepare(`SELECT a.id, a.type, a.subject, substr(a.body, 1, 600) AS body, a.direction, a.status, a.due_at, a.occurred_at, a.created_at, a.owner_id, a.created_by
      FROM activities a JOIN activity_links l ON l.activity_id = a.id AND l.record_id = ?
      WHERE a.archived = 0 AND (CASE WHEN a.type = 'task' THEN a.created_at ELSE a.occurred_at END) > ?
      ORDER BY a.id DESC LIMIT 150`).bind(recordId, desde),
    db.prepare('SELECT user_id, leido_hasta, siguiendo, motivo FROM conversacion_participantes WHERE record_id = ?').bind(recordId),
    // Las imágenes de los mensajes (sin el archivo: se baja aparte, /api/mensaje-adjuntos/:id).
    db.prepare(`SELECT ${COLS_ADJUNTO} FROM mensaje_adjuntos WHERE record_id = ? AND mensaje_id IS NOT NULL ORDER BY id`).bind(recordId),
  ]);
  const adjuntosDe = new Map<number, Adjunto[]>();
  for (const a of adjs.results as unknown as Adjunto[]) adjuntosDe.set(a.mensaje_id!, [...(adjuntosDe.get(a.mensaje_id!) ?? []), a]);
  const items: Item[] = [];
  for (const m of msgs.results as unknown as MensajeRow[]) items.push({ key: `m${m.id}`, kind: 'mensaje', at: m.created_at, ...mensaje(m, adjuntosDe.get(m.id)) });
  for (const c of chs.results as Array<{ id: number; prop: string; old_value: string | null; new_value: string | null; changed_at: string; user_id: number | null; actor: string | null; source: string }>) {
    items.push({ key: `c${c.id}`, kind: 'cambio', at: c.changed_at, prop: c.prop, antes: c.old_value, despues: c.new_value, user_id: c.user_id, actor: c.actor, source: c.source });
  }
  for (const a of arts.results as Array<{ id: number; articulo: string; es_pdv: number; antes: string | null; despues: string | null; user_id: number | null; actor: string | null; source: string; at: string }>) {
    items.push({ key: `p${a.id}`, kind: 'articulo', at: a.at, articulo: a.articulo, es_pdv: !!a.es_pdv, antes: a.antes, despues: a.despues, user_id: a.user_id, actor: a.actor, source: a.source });
  }
  for (const b of bocs.results as Array<{ id: number; nombre: string; producto_nombre: string | null; producto: string | null; version: number; tipo: string; mime: string | null; user_id: number | null; created_at: string; aprobado_at: string | null; aprobado_por: number | null }>) {
    const base = { boceto_id: b.id, nombre: b.nombre, producto: b.producto_nombre ?? b.producto, version: b.version, tipo: b.tipo, mime: b.mime };
    if (b.created_at > desde) items.push({ key: `b${b.id}`, kind: 'boceto', at: b.created_at, accion: 'subido', ...base, user_id: b.user_id });
    if (b.aprobado_at && b.aprobado_at > desde) items.push({ key: `ba${b.id}`, kind: 'boceto', at: b.aprobado_at, accion: 'aprobado', ...base, user_id: b.aprobado_por });
  }
  for (const r of rems.results as Array<{ id: number; numero: string | null; estado: string; origen: string; chofer: string | null; subido_por: number | null; created_at: string }>) {
    items.push({ key: `r${r.id}`, kind: 'remito', at: r.created_at, remito_id: r.id, numero: r.numero, estado: r.estado, origen: r.origen, chofer: r.chofer, user_id: r.subido_por });
  }
  for (const a of acts.results as Array<{ id: number; type: string; subject: string; body: string; direction: string | null; status: string | null; due_at: string | null; occurred_at: string; created_at: string; owner_id: number | null; created_by: number | null }>) {
    items.push({ key: `a${a.id}`, kind: 'actividad', at: a.type === 'task' ? a.created_at : a.occurred_at, activity_id: a.id, tipo: a.type, subject: a.subject, body: a.body,
      direction: a.direction, status: a.status, due_at: a.due_at, user_id: a.type === 'task' ? (a.created_by ?? a.owner_id) : a.owner_id });
  }
  items.sort((x, y) => x.at.localeCompare(y.at) || x.key.localeCompare(y.key));
  const participantes = (parts.results as Array<{ user_id: number; leido_hasta: number; siguiendo: number; motivo: string | null }>).map((p) => ({ ...p, siguiendo: !!p.siguiendo }));
  const yo = participantes.find((p) => p.user_id === ctx.user.id);
  // Los estados de producción con su color de ClickUp, para pintar los cambios de los artículos (solo al abrirla).
  const estados = desde ? undefined : (await estadosPec(db)).map((e) => ({ status: e.status, color: e.color }));
  return { ahora, items, participantes, siguiendo: !!yo?.siguiendo, leido_hasta: yo?.leido_hasta ?? 0, ...(estados ? { estados } : {}) };
}

// Quiénes tienen asignado el pedido en producción y son usuarios del CRM (Ceci, Sole…).
async function deProduccion(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT DISTINCT cp.user_id FROM produccion pr, json_each(pr.asignados) j
      JOIN clickup_personas cp ON cp.clickup_id = j.value
    WHERE pr.record_id = ? AND cp.user_id IS NOT NULL AND (pr.es_pdv = 1 OR pr.estado NOT IN ('entregados', 'anulado'))`).bind(recordId).all<{ user_id: number }>();
  return results.map((r) => r.user_id);
}

async function validarMenciones(db: D1Database, ids: number[]) {
  if (!ids.length) return [];
  const { results } = await db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND active = 1 AND deleted_at IS NULL')
    .bind(JSON.stringify(ids)).all<{ id: number }>();
  return results.map((r) => r.id);
}

function limpiar(body: unknown) {
  const s = String(body ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!s) throw new HttpError(400, 'El mensaje está vacío.');
  if (s.length > MAX) throw new HttpError(400, `El mensaje es muy largo (máximo ${MAX} caracteres).`);
  return s;
}

export async function escribir(db: D1Database, ctx: Ctx, recordId: number, input: { body: unknown; responde_a?: number | null; adjuntos?: unknown }) {
  const rec = await registro(db, recordId);
  // Las imágenes ya subidas (subirImagen): de este registro, de quien escribe y todavía sin mensaje.
  const pedidos = [...new Set((Array.isArray(input.adjuntos) ? input.adjuntos : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (pedidos.length > IMAGENES_POR_MENSAJE) throw new HttpError(400, `Van hasta ${IMAGENES_POR_MENSAJE} imágenes por mensaje.`);
  const sueltos = pedidos.length ? (await db.prepare(`SELECT id FROM mensaje_adjuntos WHERE id IN (SELECT value FROM json_each(?)) AND record_id = ? AND user_id = ? AND mensaje_id IS NULL`)
    .bind(JSON.stringify(pedidos), recordId, ctx.user.id).all<{ id: number }>()).results.map((r) => r.id) : [];
  if (sueltos.length !== pedidos.length) throw new HttpError(400, 'Alguna imagen no se terminó de subir o ya es de otro mensaje: volvé a adjuntarla.');
  // Con imágenes, el texto puede ir vacío.
  const body = sueltos.length && !String(input.body ?? '').trim() ? '' : limpiar(input.body);
  let respondeA: number | null = null;
  if (input.responde_a) {
    const r = await db.prepare('SELECT id FROM mensajes WHERE id = ? AND record_id = ?').bind(Number(input.responde_a), recordId).first<{ id: number }>();
    if (!r) throw new HttpError(400, 'El mensaje al que respondés no es de esta conversación.');
    respondeA = r.id;
  }
  const menciones = await validarMenciones(db, mencionesDe(body));
  const ts = now();
  const row = await db.prepare(`INSERT INTO mensajes (record_id, user_id, body, menciones, responde_a, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(recordId, ctx.user.id, body, JSON.stringify(menciones), respondeA, ctx.source === 'mcp' ? 'mcp' : 'crm', ts).first<MensajeRow>();
  const id = row!.id;
  const prod = await deProduccion(db, recordId);
  const stmts: D1PreparedStatement[] = [
    // Quien escribe la sigue y ya leyó hasta acá.
    db.prepare(`INSERT INTO conversacion_participantes (record_id, user_id, leido_hasta, siguiendo, motivo) VALUES (?, ?, ?, 1, 'escribio')
      ON CONFLICT(record_id, user_id) DO UPDATE SET leido_hasta = MAX(leido_hasta, excluded.leido_hasta), siguiendo = 1`).bind(recordId, ctx.user.id, id),
    // A quien mencionan: la vuelve a seguir aunque la haya dejado.
    // Los que entran ahora tienen por leer desde este mensaje (no toda la conversación de antes).
    ...menciones.filter((u) => u !== ctx.user.id).map((u) => db.prepare(`INSERT INTO conversacion_participantes (record_id, user_id, leido_hasta, motivo) VALUES (?, ?, ?, 'mencion')
      ON CONFLICT(record_id, user_id) DO UPDATE SET siguiendo = 1`).bind(recordId, u, id - 1)),
    // El propietario y producción: si no la dejaron de seguir antes.
    ...[[rec.owner_id, 'propietario'] as const, ...prod.map((u) => [u, 'produccion'] as const)].filter(([u]) => u && u !== ctx.user.id)
      .map(([u, motivo]) => db.prepare('INSERT OR IGNORE INTO conversacion_participantes (record_id, user_id, leido_hasta, motivo) VALUES (?, ?, ?, ?)').bind(recordId, u, id - 1, motivo)),
    // Aviso por mail a los mencionados (sale con los demás avisos, si lo tienen prendido).
    ...(['crm', 'mcp'].includes(ctx.source) ? menciones.filter((u) => u !== ctx.user.id).map((u) =>
      db.prepare("INSERT INTO avisos (user_id, kind, record_id, by_user, mensaje_id) VALUES (?, 'mencion', ?, ?, ?)").bind(u, recordId, ctx.user.id, id)) : []),
    // Las imágenes quedan del mensaje.
    ...(sueltos.length ? [db.prepare('UPDATE mensaje_adjuntos SET mensaje_id = ? WHERE id IN (SELECT value FROM json_each(?))').bind(id, JSON.stringify(sueltos))] : []),
    // La conversación cuenta como actividad del registro.
    db.prepare('UPDATE records SET last_activity_at = ? WHERE id = ?').bind(ts, recordId),
  ];
  await db.batch(stmts);
  const adjuntos = sueltos.length ? (await db.prepare(`SELECT ${COLS_ADJUNTO} FROM mensaje_adjuntos WHERE mensaje_id = ? ORDER BY id`).bind(id).all<Adjunto>()).results : [];
  return mensaje(row!, adjuntos);
}

async function propio(db: D1Database, ctx: Ctx, id: number) {
  const m = await db.prepare('SELECT * FROM mensajes WHERE id = ?').bind(id).first<MensajeRow>();
  if (!m || m.borrado_at) throw new HttpError(404, 'No existe el mensaje.');
  return m;
}

// Solo quien lo escribió lo edita; lo borra quien lo escribió o un administrador. Se ve que fue editado o borrado.
export async function editarMensaje(db: D1Database, ctx: Ctx, id: number, body: unknown) {
  const m = await propio(db, ctx, id);
  if (m.user_id !== ctx.user.id) throw new HttpError(403, 'Solo quien escribió el mensaje lo puede editar.');
  const adjuntos = (await db.prepare(`SELECT ${COLS_ADJUNTO} FROM mensaje_adjuntos WHERE mensaje_id = ? ORDER BY id`).bind(id).all<Adjunto>()).results;
  // Un mensaje con imágenes puede quedar sin texto.
  const texto = adjuntos.length && !String(body ?? '').trim() ? '' : limpiar(body);
  if (texto === m.body) return mensaje(m, adjuntos);
  const antes = JSON.parse(m.menciones || '[]') as number[];
  const menciones = await validarMenciones(db, mencionesDe(texto));
  const row = await db.prepare('UPDATE mensajes SET body = ?, menciones = ?, editado_at = ? WHERE id = ? RETURNING *').bind(texto, JSON.stringify(menciones), now(), id).first<MensajeRow>();
  // Los que se mencionan recién ahora también se enteran.
  const nuevos = menciones.filter((u) => !antes.includes(u) && u !== ctx.user.id);
  if (nuevos.length) {
    await db.batch(nuevos.flatMap((u) => [
      db.prepare(`INSERT INTO conversacion_participantes (record_id, user_id, leido_hasta, motivo) VALUES (?, ?, ?, 'mencion')
        ON CONFLICT(record_id, user_id) DO UPDATE SET siguiendo = 1, leido_hasta = MIN(leido_hasta, excluded.leido_hasta)`).bind(m.record_id, u, id - 1),
      db.prepare("INSERT INTO avisos (user_id, kind, record_id, by_user, mensaje_id) VALUES (?, 'mencion', ?, ?, ?)").bind(u, m.record_id, ctx.user.id, id),
    ]));
  }
  return mensaje(row!, adjuntos);
}

export async function borrarMensaje(db: D1Database, ctx: Ctx, id: number) {
  const m = await propio(db, ctx, id);
  if (m.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Solo quien escribió el mensaje (o un administrador) lo puede borrar.');
  // Las imágenes de un mensaje borrado no se ven más: se borran (y liberan lugar en la base).
  await db.batch([
    db.prepare('UPDATE mensajes SET borrado_at = ? WHERE id = ?').bind(now(), id),
    borrarPartes(db, 'mensaje_id = ?', id),
    db.prepare('DELETE FROM mensaje_adjuntos WHERE mensaje_id = ?').bind(id),
  ]);
  return { ok: true };
}

export async function marcarLeido(db: D1Database, ctx: Ctx, recordId: number, hasta: number) {
  await db.prepare('UPDATE conversacion_participantes SET leido_hasta = MAX(leido_hasta, ?) WHERE record_id = ? AND user_id = ?')
    .bind(Math.max(0, Math.floor(Number(hasta) || 0)), recordId, ctx.user.id).run();
  return { ok: true };
}

export async function seguir(db: D1Database, ctx: Ctx, recordId: number, si: boolean) {
  await registro(db, recordId);
  const ultimo = await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mensajes WHERE record_id = ?').bind(recordId).first<{ id: number }>();
  await db.prepare(`INSERT INTO conversacion_participantes (record_id, user_id, leido_hasta, siguiendo, motivo) VALUES (?, ?, ?, ?, 'manual')
    ON CONFLICT(record_id, user_id) DO UPDATE SET siguiendo = excluded.siguiendo`).bind(recordId, ctx.user.id, ultimo?.id ?? 0, si ? 1 : 0).run();
  return { siguiendo: si };
}

// Las conversaciones que sigue el usuario, la más reciente primero, con cuántos mensajes no leyó (y en cuántos lo
// mencionan) y el último mensaje. Con `noLeidas`, solo las que tienen algo sin leer (el globito del menú).
export async function bandeja(db: D1Database, ctx: Ctx, opts: { noLeidas?: boolean; limite?: number } = {}) {
  const lim = Math.min(opts.limite ?? 50, 200);
  const { results } = await db.prepare(`SELECT * FROM (SELECT p.record_id, r.object_type, r.name, p.leido_hasta,
      (SELECT COUNT(*) FROM mensajes m WHERE m.record_id = p.record_id AND m.id > p.leido_hasta AND m.borrado_at IS NULL AND COALESCE(m.user_id, 0) != p.user_id) AS no_leidos,
      (SELECT COUNT(*) FROM mensajes m, json_each(m.menciones) j WHERE m.record_id = p.record_id AND m.id > p.leido_hasta AND m.borrado_at IS NULL AND j.value = p.user_id) AS menciones,
      (SELECT MAX(m.id) FROM mensajes m WHERE m.record_id = p.record_id AND m.borrado_at IS NULL) AS ultimo_id
    FROM conversacion_participantes p JOIN records r ON r.id = p.record_id AND r.archived = 0
    WHERE p.user_id = ? AND p.siguiendo = 1 AND ${visibleSql('r', ctx.user)}) WHERE ultimo_id IS NOT NULL ${opts.noLeidas ? 'AND no_leidos > 0' : ''}
    ORDER BY ultimo_id DESC LIMIT ?`).bind(ctx.user.id, lim)
    .all<{ record_id: number; object_type: string; name: string; leido_hasta: number; no_leidos: number; menciones: number; ultimo_id: number }>();
  const ultimos = results.length ? new Map((await db.prepare('SELECT id, user_id, body, created_at FROM mensajes WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(results.map((r) => r.ultimo_id))).all<{ id: number; user_id: number | null; body: string; created_at: string }>()).results.map((m) => [m.id, m])) : new Map();
  const conversaciones = results.map((r) => {
    const u = ultimos.get(r.ultimo_id);
    return { ...r, ultimo: u ? { ...u, body: textoPlano(u.body).slice(0, 240) || '📎 Adjunto' } : null };
  });
  return {
    no_leidos: conversaciones.reduce((s, c) => s + c.no_leidos, 0),
    menciones: conversaciones.reduce((s, c) => s + c.menciones, 0),
    conversaciones,
  };
}

// ---------- Imágenes y archivos ----------

const esGif = (b: Uint8Array) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
const esJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const esPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const esWebp = (b: Uint8Array) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45;
const esPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;   // %PDF

// Hasta 20 MB por archivo, en pedazos de 1,5 MB (una fila de D1 no puede pasar de 2 MB).
const ARCHIVO_MAX = 20 * 1024 * 1024;
const PEDAZO = 1_500_000;
// Los demás archivos que se pueden adjuntar (se descargan; no se abren en el CRM): planillas, documentos, presentaciones,
// texto, comprimidos y archivos de diseño.
const OTROS: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint', txt: 'text/plain',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  ai: 'application/postscript', eps: 'application/postscript', psd: 'image/vnd.adobe.photoshop', cdr: 'application/vnd.corel-draw', svg: 'image/svg+xml',
  dxf: 'image/vnd.dxf', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', mp4: 'video/mp4', mov: 'video/quicktime',
};
// Lo que se muestra en el CRM (el resto se descarga).
export const seVe = (mime: string) => MIMES_IMAGEN.includes(mime) || mime === 'application/pdf';

const borrarPartes = (db: D1Database, where: string, ...binds: unknown[]) =>
  db.prepare(`DELETE FROM mensaje_adjunto_partes WHERE adjunto_id IN (SELECT id FROM mensaje_adjuntos WHERE ${where})`).bind(...binds);

// Sube un archivo para el próximo mensaje (queda sin mensaje hasta que se manda). Se mira el contenido, no solo lo que dice
// el navegador: una imagen o un PDF tienen que serlo de verdad; lo demás va por la extensión y se baja como archivo.
export async function subirAdjunto(db: D1Database, ctx: Ctx, recordId: number, archivo: File, medidas: { ancho?: unknown; alto?: unknown } = {}) {
  await registro(db, recordId);
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, 'El archivo está vacío.');
  if (bytes.length > ARCHIVO_MAX) throw new HttpError(413, 'El archivo es muy pesado (más de 20 MB). Comprimilo o compartí el link de Drive.');
  const ext = (archivo.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toLowerCase();
  const mime = esJpeg(bytes) ? 'image/jpeg' : esPng(bytes) ? 'image/png' : esWebp(bytes) ? 'image/webp' : esGif(bytes) ? 'image/gif'
    : esPdf(bytes) ? 'application/pdf' : OTROS[ext] ?? null;
  if (!mime) throw new HttpError(415, `No se pueden adjuntar archivos .${ext || 'sin extensión'}. Van imágenes, PDF, planillas, documentos, ZIP y archivos de diseño.`);
  const dim = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n < 20000 ? n : null; };
  const nombre = (archivo.name || (mime === 'application/pdf' ? 'documento.pdf' : 'imagen')).replace(/[\r\n]/g, ' ').slice(0, 160);
  // De paso, los que alguien subió y nunca mandó (de hace más de un día).
  const viejo = new Date(Date.now() - 86_400_000).toISOString();
  await db.batch([
    borrarPartes(db, 'user_id = ? AND mensaje_id IS NULL AND created_at < ?', ctx.user.id, viejo),
    db.prepare('DELETE FROM mensaje_adjuntos WHERE user_id = ? AND mensaje_id IS NULL AND created_at < ?').bind(ctx.user.id, viejo),
  ]);
  const row = await db.prepare(`INSERT INTO mensaje_adjuntos (record_id, user_id, nombre, mime, size, ancho, alto, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLS_ADJUNTO}`).bind(recordId, ctx.user.id, nombre, mime, bytes.length, MIMES_IMAGEN.includes(mime) ? dim(medidas.ancho) : null,
    MIMES_IMAGEN.includes(mime) ? dim(medidas.alto) : null, bytes.subarray(0, PEDAZO)).first<Adjunto>();
  for (let n = 1; n * PEDAZO < bytes.length; n++) {
    await db.prepare('INSERT INTO mensaje_adjunto_partes (adjunto_id, n, data) VALUES (?, ?, ?)').bind(row!.id, n, bytes.subarray(n * PEDAZO, (n + 1) * PEDAZO)).run();
  }
  return row!;
}

// Sacar un archivo subido que todavía no se mandó.
export async function quitarAdjunto(db: D1Database, ctx: Ctx, id: number) {
  await db.batch([
    borrarPartes(db, 'id = ? AND user_id = ? AND mensaje_id IS NULL', id, ctx.user.id),
    db.prepare('DELETE FROM mensaje_adjuntos WHERE id = ? AND user_id = ? AND mensaje_id IS NULL').bind(id, ctx.user.id),
  ]);
  return { ok: true };
}

// El archivo entero (los pedazos, en orden): el de un mensaje (no borrado) o, mientras no se mandó, solo para quien lo subió.
export async function adjunto(db: D1Database, ctx: Ctx, id: number) {
  const a = await db.prepare(`SELECT a.record_id, a.mensaje_id, a.user_id, a.nombre, a.mime, a.size, a.data FROM mensaje_adjuntos a
      LEFT JOIN mensajes m ON m.id = a.mensaje_id WHERE a.id = ? AND (a.mensaje_id IS NULL OR m.borrado_at IS NULL)`)
    .bind(id).first<{ record_id: number; mensaje_id: number | null; user_id: number | null; nombre: string; mime: string; size: number; data: ArrayBuffer | number[] }>();
  if (!a || (a.mensaje_id == null && a.user_id !== ctx.user.id)) throw new HttpError(404, 'No existe el archivo.');
  const aBytes = (d: ArrayBuffer | number[]) => (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d));
  const primero = aBytes(a.data);
  let bytes = primero;
  if (a.size > primero.length) {
    const { results } = await db.prepare('SELECT data FROM mensaje_adjunto_partes WHERE adjunto_id = ? ORDER BY n').bind(id).all<{ data: ArrayBuffer | number[] }>();
    bytes = new Uint8Array(a.size);
    bytes.set(primero, 0);
    let pos = primero.length;
    for (const r of results) { const p = aBytes(r.data); bytes.set(p, pos); pos += p.length; }
  }
  return { record_id: a.record_id, nombre: a.nombre, mime: a.mime, bytes };
}
