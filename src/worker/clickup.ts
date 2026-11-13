import type { Ctx, Env, User } from './env';
import { Meta } from './meta';
import { createRecord, updateRecord, ORDER_CONFIRMED } from './records';
import { associate } from './associations';
import { finnegansPedido, finnegansToken } from './finnegans';
import { Budget, OutOfBudget } from './budget';
import { bajarArchivo } from './drive';
import { encolarLogo, logoDelProducto } from './logos';
import { tareaPostEntrega } from './postentrega';
import { montosDesdePedidos } from './montos';
import { recalcularEntrega } from './remitos';
import { completarProveedores, enlazarPedido, guardarTareas, leerEstados, podarArticulos, vincularOpciones } from './produccion';
import { articulosServicio, relecturasPedidas } from './servicios';
import { vincularPedido } from './vinculos';

// Pedidos desde ClickUp (pedido de Rodrigo del 30/10/2026). La lista PEC («Producciones en curso → Produccion Merch»)
// tiene una tarea por PDV y una subtarea por artículo, cada una con su estado. Cada 10 minutos se leen las tareas que
// cambiaron y, por cada PDV, el CRM crea el pedido si no existe y le pone el estado general que corresponde. Cada corrida
// tiene un tope de consultas (budget.ts): la lista de PDV por revisar queda guardada y sigue en la próxima.
//
// - El estado sale de los ARTÍCULOS, no del PDV (regla de Rodrigo: el del PDV no es certero).
// - Antes de producción lo mueven a mano las vendedoras y el backoffice («Pedido confirmado», «$ Pendiente de Anticipo»,
//   «Pendiente Boceto Digital» y «Listo para producción»): mientras los artículos no arrancan, esto no lo toca. Lo demás
//   lo mueve esto.
// - Cuando el PDV está entregado, la foto del remito que suben a la tarea del PDV queda en el pedido (tabla `files`).
// - ClickUp casi solo se lee: lo que el CRM escribe está abajo («Lo que el CRM escribe en ClickUp») y en produccion.ts.
// - Cada tarea que se lee (PDV y artículos) también queda en la vista de Producción (produccion.ts).

export const LIST = '901326159292';
export const API = (env: Env) => env.CLICKUP_API_URL ?? 'https://api.clickup.com/api/v2';
const POR_PDV = 5;    // consultas que puede llevar un PDV: la tarea y, si el pedido es nuevo, el token, el pedido y el cliente en Finnegans
const LISTADO = 20;   // la lectura de la lista deja al menos esto para revisar PDV en la misma corrida

export const STAGE = {
  confirmado: ORDER_CONFIRMED,
  listo_produccion: '3725360f-519b-4b18-a593-494d60a29c9f',
  boceto: 'esperando_boceto',
  produccion: '1237498994',
  listo_entregar: '1237498996',
  parcial: 'entregado_parcial',
  entregado: '1237498998',
  anulado: '3c85a297-e9ce-400b-b42e-9f16853d69d6',
};
const ANULADOS = ['anulado', 'anulada', 'cancelado'];
const NO_ARRANCO = ['ingreso de pedido', 'pdv', 'personales'];
const ESPERA = ['boceto pendiente', 'en espera de confirmación', 'en espera de confirmacion'];
// Unidades de negocio de ClickUp que tienen pedidos en el CRM (Mercado Libre no tiene vendedora).
const UNIDADES: Record<string, string> = { 'FORMAS SHOP': 'FORMAS SHOP', CORPORATE: 'CORPORATE', 'NO ESTRÉS': 'NO ESTRÉS', 'NO ESTRES': 'NO ESTRÉS' };
// El VENDEDOR de ClickUp se carga a mano y tiene apodos (como CLICKUP_ALIAS del tablero de Formas Shop).
const ALIAS: Record<string, string> = { eli: 'elizabeth reynoso', elizabeth: 'elizabeth reynoso', lucia: 'lucia senini', luli: 'lucia senini', jorgelina: 'jorgelina carrasco' };

// Estado general del pedido a partir del estado de cada artículo. null = todavía no arrancó la producción (queda lo que
// haya puesto la vendedora).
export function generalStage(statuses: string[]): string | null {
  const s = statuses.map((x) => x.toLowerCase().trim()).filter(Boolean);
  if (!s.length) return null;
  const live = s.filter((x) => !ANULADOS.includes(x));
  if (!live.length) return STAGE.anulado;
  if (live.every((x) => x === 'entregados')) return STAGE.entregado;
  if (live.some((x) => x === 'entregados' || x === 'parcial entregado')) return STAGE.parcial;
  if (live.every((x) => x.startsWith('listo para ent'))) return STAGE.listo_entregar;
  if (live.some((x) => ESPERA.includes(x))) return STAGE.boceto;
  if (live.some((x) => !NO_ARRANCO.includes(x))) return STAGE.produccion;
  return null;
}

export interface CuTask {
  id: string; name: string; parent?: string | null; url: string; date_updated?: string; text_content?: string; description?: string;
  status?: { status: string; type?: string };
  due_date?: string | null; orderindex?: string | number; tags?: Array<{ name: string }>;
  assignees?: Array<{ id?: number; username?: string | null; email?: string | null; profilePicture?: string | null; initials?: string | null; color?: string | null }>;
  custom_fields?: Array<{ id?: string; name: string; type: string; value?: unknown; type_config?: { options?: Array<{ id: string; name: string; orderindex?: number; color?: string }> } }>;
  subtasks?: CuTask[];
  attachments?: Array<{ id: string; title?: string; extension?: string; mimetype?: string; size?: number; date?: string }>;
}

export async function cu<T>(env: Env, path: string, params: Record<string, string | number> = {}, b?: Budget): Promise<T> {
  b?.take();
  const url = new URL(API(env) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: env.CLICKUP_TOKEN! } });
  if (!res.ok) throw new Error(`ClickUp ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Campos personalizados de una tarea → { nombre: valor legible } (desplegables por nombre, fechas como AAAA-MM-DD).
function fields(t: CuTask) {
  const out: Record<string, string> = {};
  for (const c of t.custom_fields ?? []) {
    let v = c.value as unknown;
    if (v == null || v === '') continue;
    if (c.type === 'drop_down') {
      const ops = c.type_config?.options ?? [];
      const o = typeof v === 'object' ? (v as { name?: string }) : ops.find((x) => x.id === v || x.orderindex === Number(v));
      v = o?.name ?? v;
    } else if (c.type === 'date') {
      const d = new Date(Number(v) - 3 * 3600_000);   // hora de Buenos Aires
      v = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : v;
    }
    out[(c.name ?? '').trim()] = String(v).trim();
  }
  return out;
}

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Nombre de empresa para comparar: sin la forma societaria del final ("Memes Games SRL" = "MEMES GAMES S.R.L.").
export const companyKey = (s: string) => norm(s).replace(/[.,]/g, '').replace(/(\s(s ?r ?l|s ?a ?s|s ?a ?u|s ?a ?i ?c|s ?a ?c ?i ?f|s ?a|s ?h))+$/, '').trim();

// El pedido de Finnegans del PDV: la línea «Pedido: PEDVTASTP - 31277» (al principio de la línea; no «Fecha pedido: …»).
// Los PDV más viejos no la tienen y traen «Tipo de Documento: PEDVTAFP»: el pedido es ese tipo con el número del PDV.
export function pedidoDe(text: string, npdv: string) {
  const linea = text.match(/^[ \t]*Pedido:[ \t]*(.+)$/im)?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
  if (/PEDVTA/i.test(linea)) return linea;
  const tipo = text.match(/^[ \t]*Tipo de Documento:[ \t]*(PEDVTA[A-Z]*)/im)?.[1]?.toUpperCase();
  return tipo && npdv ? `${tipo} - ${npdv}` : '';
}

// Los artículos de un PDV (sus subtareas): producto, código de Finnegans, cantidad y estado de producción. Son los
// productos del pedido cuando Finnegans no tiene los renglones.
export interface Articulo { task_id: string; name: string; code: string | null; quantity: number | null; status: string }
export function leerArticulo(s: CuTask): Articulo {
  const f = fields(s);
  const text = s.text_content || s.description || '';
  const line = (k: string) => text.match(new RegExp(`^[ \\t]*${k}:[ \\t]*(.*)$`, 'im'))?.[1]?.trim() ?? '';
  const nombre = line('Producto') || s.name.split(/\r?\n/)[0].replace(/\s+-\s+[^-]+$/, '').trim() || s.name;
  const q = Number(String(f.CANTIDAD ?? line('Cantidad')).replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return { task_id: s.id, name: nombre, code: line('Código').replace(/\\/g, '') || null, quantity: Number.isFinite(q) && q > 0 ? q : null, status: s.status?.status ?? '' };
}
// Los artículos con una sola consulta (sin leer cada subtarea): nombre, estado y, si la lista lo trae, el código. Alcanza
// para saber el estado de cada producto de un pedido que vino de Finnegans y a qué subtarea va su boceto.
export async function articulosLivianos(env: Env, taskId: string, b?: Budget): Promise<Articulo[]> {
  if (!env.CLICKUP_TOKEN) return [];
  const t = await cu<CuTask>(env, `/task/${encodeURIComponent(taskId)}`, { include_subtasks: 'true' }, b);
  return (t.subtasks ?? []).slice(0, 60).map(leerArticulo);
}

export async function articulosDelPdv(env: Env, taskId: string, b?: Budget): Promise<Articulo[]> {
  if (!env.CLICKUP_TOKEN) return [];
  const t = await cu<CuTask>(env, `/task/${encodeURIComponent(taskId)}`, { include_subtasks: 'true' }, b);
  const out: Articulo[] = [];
  for (const s0 of (t.subtasks ?? []).slice(0, 40)) {
    // Si la lista de subtareas no trae la descripción ni los campos, se lee cada artículo.
    const s = s0.text_content || s0.custom_fields?.length ? s0 : await cu<CuTask>(env, `/task/${encodeURIComponent(s0.id)}`, {}, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return s0; });
    out.push(leerArticulo(s));
  }
  return out;
}

// ---------- Lo que el CRM escribe en ClickUp ----------
// Solo dos cosas, por pedido de Rodrigo: (1) al pasar el pedido a «Listo para producción», el PDV y sus artículos que
// siguen en «ingreso de pedido» pasan a «pdv» (4/11/2026; lo que ya avanzó no se toca); (2) el boceto aprobado de un
// producto se adjunta a la subtarea de ese artículo (6/11/2026; solo adjunta, no cambia estados).
const INGRESO = 'ingreso de pedido';
const PDV_STATUS = 'pdv';

export async function pasarAPdv(env: Env, taskId: string, b?: Budget) {
  const t = await cu<CuTask>(env, `/task/${encodeURIComponent(taskId)}`, { include_subtasks: 'true' }, b);
  let movidas = 0;
  for (const x of [t, ...(t.subtasks ?? [])]) {
    if ((x.status?.status ?? '').toLowerCase().trim() !== INGRESO) continue;
    b?.take();
    const res = await fetch(`${API(env)}/task/${encodeURIComponent(x.id)}`, {
      method: 'PUT', headers: { Authorization: env.CLICKUP_TOKEN!, 'content-type': 'application/json' }, body: JSON.stringify({ status: PDV_STATUS }),
    });
    if (!res.ok) throw new Error(`ClickUp no cambió el estado de ${x.name}: HTTP ${res.status}`);
    movidas++;
  }
  return movidas;
}

// Bocetos aprobados en pedidos que ya tienen su PDV en ClickUp y todavía no se adjuntaron: a la cola (también los que se
// aprobaron antes de que existiera el PDV).
export async function encolarBocetos(db: D1Database) {
  await db.prepare(`INSERT INTO clickup_salida (record_id, action, user_id, ref)
    SELECT b.record_id, 'adjuntar_boceto', b.user_id, CAST(b.id AS TEXT) FROM bocetos b JOIN records r ON r.id = b.record_id
    WHERE b.estado = 'aprobado' AND b.archived = 0 AND b.clickup_at IS NULL AND r.object_type = 'order' AND r.archived = 0
      AND json_extract(r.props, '$.url_clickup') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM clickup_salida s WHERE s.action = 'adjuntar_boceto' AND s.ref = CAST(b.id AS TEXT) AND s.done_at IS NULL)`).run();
}

const normProd = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Adjunta el boceto a la subtarea del artículo (por código del producto o, si no, por nombre); si el PDV no tiene ese
// artículo, al PDV.
async function adjuntarBoceto(env: Env, taskId: string, bocetoId: number, b: Budget) {
  const db = env.DB;
  const bo = await db.prepare('SELECT id, record_id, producto, producto_nombre, nombre, mime, drive_id, estado, archived, clickup_at FROM bocetos WHERE id = ?').bind(bocetoId)
    .first<{ id: number; record_id: number; producto: string | null; producto_nombre: string | null; nombre: string; mime: string | null; drive_id: string; estado: string; archived: number; clickup_at: string | null }>();
  if (!bo || bo.archived || bo.estado !== 'aprobado') return { omitido: 'ya no está aprobado' };
  if (bo.clickup_at) return { omitido: 'ya estaba adjunto' };
  const guardada = await db.prepare('SELECT clickup_task FROM line_items WHERE record_id = ? AND clickup_task IS NOT NULL AND (code = ? OR name = ?) LIMIT 1')
    .bind(bo.record_id, bo.producto ?? '', bo.producto_nombre ?? '').first<{ clickup_task: string }>();
  let destino = guardada?.clickup_task ?? null;
  if (!destino) {
    const arts = await articulosDelPdv(env, taskId, b);
    const cod = normProd(bo.producto);
    const nom = normProd(bo.producto_nombre);
    destino = arts.find((a) => cod && normProd(a.code) === cod)?.task_id
      ?? arts.find((a) => nom && (normProd(a.name) === nom || normProd(a.name).includes(nom) || nom.includes(normProd(a.name))))?.task_id
      ?? (arts.length === 1 ? arts[0].task_id : null);
  }
  const target = destino ?? taskId;
  const adj = await adjuntarArchivo(env, target, bo.drive_id, bo.nombre, bo.mime ?? 'application/pdf', b);
  await db.prepare('UPDATE bocetos SET clickup_task = ?, clickup_adjunto = ?, clickup_at = ? WHERE id = ?').bind(target, adj, new Date().toISOString(), bo.id).run();
  // El logo original del producto va con el boceto (logos.ts); si no alcanza el presupuesto, queda en la cola.
  if (bo.producto) {
    if (b.left() >= 3) await adjuntarLogo(env, bo.record_id, bo.producto, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return encolarLogo(db, bo.record_id, bo.producto!, null); });
    else await encolarLogo(db, bo.record_id, bo.producto, null);
  }
  return { adjunto: target, en: destino ? 'artículo' : 'PDV' };
}

// Baja el archivo de Drive y lo adjunta a la tarea de ClickUp; devuelve el id del adjunto.
async function adjuntarArchivo(env: Env, target: string, driveId: string, nombre: string, mime: string, b: Budget) {
  b.take();
  const datos = await (await bajarArchivo(env, driveId)).arrayBuffer();
  const fd = new FormData();
  fd.append('attachment', new Blob([datos], { type: mime }), nombre);
  b.take();
  const res = await fetch(`${API(env)}/task/${encodeURIComponent(target)}/attachment`, { method: 'POST', headers: { Authorization: env.CLICKUP_TOKEN! }, body: fd });
  if (!res.ok) throw new Error(`ClickUp no aceptó «${nombre}»: HTTP ${res.status}`);
  return ((await res.json().catch(() => ({}))) as { id?: string }).id ?? null;
}

// El logo que va en el producto, a la tarea donde está su boceto (si ese logo todavía no está ahí).
async function adjuntarLogo(env: Env, orderId: number, producto: string, b: Budget) {
  const db = env.DB;
  const bo = await db.prepare(`SELECT clickup_task FROM bocetos WHERE record_id = ? AND producto = ? AND archived = 0 AND clickup_task IS NOT NULL
    ORDER BY clickup_at DESC LIMIT 1`).bind(orderId, producto).first<{ clickup_task: string }>();
  if (!bo) return { omitido: 'el boceto todavía no está en ClickUp' };
  const logo = await logoDelProducto(db, orderId, producto);
  if (!logo) return { omitido: 'la empresa no tiene logo' };
  if (await db.prepare('SELECT 1 FROM logos_clickup WHERE logo_id = ? AND task_id = ?').bind(logo.id, bo.clickup_task).first()) return { omitido: 'ya estaba adjunto' };
  const adj = await adjuntarArchivo(env, bo.clickup_task, logo.drive_id, logo.nombre, logo.mime ?? 'application/octet-stream', b);
  await db.prepare('INSERT OR IGNORE INTO logos_clickup (logo_id, task_id, adjunto) VALUES (?, ?, ?)').bind(logo.id, bo.clickup_task, adj).run();
  return { logo: logo.id, adjunto: bo.clickup_task };
}

export async function procesarSalidaClickup(env: Env, b: Budget = Budget.of(env)) {
  if (!env.CLICKUP_TOKEN) return { skipped: 'Falta CLICKUP_TOKEN.' };
  const db = env.DB;
  await encolarBocetos(db);
  const { results } = await db.prepare(`SELECT s.id, s.record_id, s.action, s.ref, json_extract(r.props, '$.url_clickup') AS url FROM clickup_salida s
    JOIN records r ON r.id = s.record_id WHERE s.done_at IS NULL AND s.attempts < 6 ORDER BY s.id LIMIT 10`).all<{ id: number; record_id: number; action: string; ref: string | null; url: string | null }>();
  let hechas = 0;
  for (const row of results) {
    if (b.left() < 6) break;
    const taskId = String(row.url ?? '').match(/\/t\/([A-Za-z0-9]+)/)?.[1];
    try {
      if (!taskId) throw new Error('El pedido no tiene PDV de ClickUp.');
      const result = row.action === 'adjuntar_boceto' ? await adjuntarBoceto(env, taskId, Number(row.ref), b)
        : row.action === 'adjuntar_logo' ? await adjuntarLogo(env, row.record_id, row.ref ?? '', b)
        : { movidas: await pasarAPdv(env, taskId, b) };
      await db.prepare('UPDATE clickup_salida SET done_at = ?, result = ?, error = NULL, attempts = attempts + 1 WHERE id = ?')
        .bind(new Date().toISOString(), JSON.stringify(result), row.id).run();
      hechas++;
    } catch (e) {
      if (e instanceof OutOfBudget) break;
      await db.prepare('UPDATE clickup_salida SET error = ?, attempts = attempts + 1 WHERE id = ?').bind((e as Error).message.slice(0, 300), row.id).run();
    }
  }
  return { hechas, pendientes: results.length - hechas };
}

// Datos del PDV que necesita el pedido.
// `servicios`: los artículos que son un servicio (envío, setup, un adicional: servicios.ts). No se producen ni se entregan,
// así que no pesan en el estado del pedido (un adicional en «ingreso de pedido» no deja el PDV en «Entregado parcial»).
export function readPdv(t: CuTask, servicios: Set<string> = new Set()) {
  const f = fields(t);
  const text = t.text_content || t.description || '';
  const line = (k: string) => text.match(new RegExp(`${k}:\\s*(.+)`, 'i'))?.[1]?.trim() ?? '';
  const npdv = (f['N° PDV'] || t.name).match(/(\d+)/)?.[1] ?? '';
  const unidad = UNIDADES[(f['UNIDAD DE NEGOCIO'] ?? '').trim().toUpperCase()];
  const fe = line('Fecha entrega').match(/(\d{2})-(\d{2})-(\d{4})/);
  const reales = (t.subtasks ?? []).filter((x) => !servicios.has(x.id));
  // Si todo el PDV son servicios, vale el estado de la tarea del PDV.
  const items = reales.length ? reales : [t];
  const statuses = ANULADOS.includes((t.status?.status ?? '').toLowerCase()) ? ['anulado'] : items.map((x) => x.status?.status ?? '');
  const count = new Map<string, number>();
  for (const st of statuses) count.set(st, (count.get(st) ?? 0) + 1);
  return {
    npdv, unidad, url: t.url,
    pedido: pedidoDe(text, npdv),
    cliente: f.CLIENTE || line('Cliente'),
    vendedor: f['🧑‍💻 VENDEDOR'] || f.VENDEDOR || line('Vendedor'),
    mailVendedor: f['MAIL VENDEDOR'] ?? '',
    evento: f['🎫 EVENTO'] === 'true' || /^s[ií]/i.test(line('Es evento')),
    entrega: fe ? `${fe[3]}-${fe[2]}-${fe[1]}` : null,
    entregado: f['ENTREGAS (FECHA REAL)'] ?? null,
    stage: generalStage(statuses),
    detalle: [...count.entries()].sort((a, b) => b[1] - a[1]).map(([st, n]) => `${n} ${st}`).join(' · '),
  };
}

export async function systemCtx(env: Env): Promise<Ctx> {
  const u = await env.DB.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<User>();
  return { user: u!, source: 'clickup', sourceDetail: 'Lista PEC' };
}

async function ownerFor(db: D1Database, vendedor: string, mail: string) {
  const users = (await db.prepare('SELECT id, name, email FROM users WHERE active = 1').all<{ id: number; name: string; email: string }>()).results;
  return usuarioPorNombre(users, vendedor, mail);
}

// Un usuario por su nombre como lo escriben ClickUp o Finnegans: «Lucia Senini», «Luli» (apodo), «Senini Lucia» o
// «SENINI, LUCIA» (el apellido primero), o por su mail.
export function usuarioPorNombre(users: Array<{ id: number; name: string; email: string }>, nombre: string, mail = '') {
  const v = norm(nombre ?? '').replace(/[,.;]/g, ' ').replace(/\s+/g, ' ').trim();
  const want = ALIAS[v] ?? v;
  const palabras = (x: string) => x.split(' ').filter((w) => w.length > 1);
  const mismasPalabras = (a: string, b: string) => { const A = palabras(a), B = palabras(b); return A.length >= 2 && A.length === B.length && A.every((w) => B.includes(w)); };
  return users.find((u) => norm(u.name) === want)?.id
    ?? users.find((u) => want && norm(u.name).startsWith(want))?.id
    ?? users.find((u) => want && mismasPalabras(norm(u.name), want))?.id
    ?? users.find((u) => mail && u.email.toLowerCase() === mail.toLowerCase())?.id
    ?? null;
}

// Quién mueve el pedido en ClickUp: el asignado del PDV (Sole, Ceci…) o, si el PDV no tiene, el primero de sus artículos.
// Los cambios que trae la sincronización quedan a su nombre en el historial (pedido de Rodrigo del 10/11/2026); si tiene
// usuario en el CRM (por mail o por nombre), con su usuario.
const titulo = (s: string) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));
export async function responsableClickup(db: D1Database, t: CuTask): Promise<{ name: string; userId: number | null } | null> {
  const a = t.assignees?.find((x) => x.username || x.email) ?? t.subtasks?.flatMap((x) => x.assignees ?? []).find((x) => x.username || x.email);
  if (!a) return null;
  const users = (await db.prepare('SELECT id, name, email FROM users WHERE deleted_at IS NULL').all<{ id: number; name: string; email: string }>()).results;
  const mail = (a.email ?? '').toLowerCase();
  const name = norm(a.username ?? '');
  const u = (mail && users.find((x) => x.email.toLowerCase() === mail)) || (name && users.find((x) => norm(x.name) === name)) || null;
  return { name: u?.name ?? titulo(a.username || mail.split('@')[0]), userId: u?.id ?? null };
}

// Pedidos que entraron sin vendedora (todavía no tenía usuario en el CRM): se completan con el VENDEDOR que ya trae la
// lista de ClickUp, sin volver a pedir cada PDV. «Revisar todo» relee la lista entera y así los completa en un par de corridas.
async function ownersFromList(db: D1Database, ctx: Ctx, tasks: CuTask[]) {
  const pdvs = new Map(tasks.filter((t) => !t.parent && t.url && /PDV/i.test(t.name)).map((t) => [t.url!, t]));
  if (!pdvs.size) return 0;
  const { results } = await db.prepare(`SELECT id, json_extract(props, '$.url_clickup') AS url FROM records
    WHERE object_type = 'order' AND archived = 0 AND owner_id IS NULL AND json_extract(props, '$.url_clickup') IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...pdvs.keys()])).all<{ id: number; url: string }>();
  let n = 0;
  for (const r of results) {
    const pdv = readPdv(pdvs.get(r.url)!);
    const o = await ownerFor(db, pdv.vendedor, pdv.mailVendedor);
    const resp = o ? await responsableClickup(db, pdvs.get(r.url)!) : null;
    if (o) { await updateRecord(db, resp ? { ...ctx, actor: resp } : ctx, 'order', r.id, { owner_id: o }, { system: true, strict: false }); n++; }
  }
  return n;
}

// Empresa del pedido: por CUIT (leyendo el pedido en Finnegans, si hay credenciales) o por razón social.
async function companyFor(env: Env, pdv: ReturnType<typeof readPdv>, fin: string | null, b?: Budget) {
  const db = env.DB;
  if (fin && pdv.pedido) {
    const c = await finnegansPedido(env, fin, pdv.pedido, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
    const cuit = c?.cuit?.replace(/\D/g, '');
    if (cuit) {
      const hit = await db.prepare(`SELECT id FROM records WHERE object_type = 'company' AND archived = 0
        AND replace(replace(COALESCE(json_extract(props, '$.cuit'), ''), '-', ''), ' ', '') = ? LIMIT 1`).bind(cuit).first<{ id: number }>();
      if (hit) return hit.id;
    }
  }
  const key = companyKey(pdv.cliente);
  if (key.length < 3) return null;
  const { results } = await db.prepare("SELECT id, name FROM records WHERE object_type = 'company' AND archived = 0 AND name LIKE ? LIMIT 50")
    .bind(`%${key.split(' ')[0]}%`).all<{ id: number; name: string }>();
  return results.find((r) => companyKey(r.name) === key)?.id ?? null;
}

async function findOrder(db: D1Database, pdv: ReturnType<typeof readPdv>) {
  const { results } = await db.prepare(`SELECT id, props FROM records WHERE object_type = 'order' AND archived = 0
    AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) IN (?, ?, ?)`).bind(pdv.npdv, `PDV - ${pdv.npdv}`, `PDV ${pdv.npdv}`).all<{ id: number; props: string }>();
  if (results.length <= 1) return results[0];
  // El mismo número en dos unidades (talonarios distintos): el de la misma unidad o el del mismo pedido de Finnegans.
  return results.find((r) => { const p = JSON.parse(r.props); return p.pedido_finnegans === pdv.pedido || p.unidad_de_negocio === pdv.unidad; }) ?? results[0];
}

// Un PDV de ClickUp → su pedido en el CRM. Devuelve qué hizo.
// `actor`: quién hizo el cambio, cuando se sabe (lo que se edita en la vista de Producción del CRM).
export async function upsertPdv(env: Env, ctx: Ctx, t: CuTask, fin: string | null, b?: Budget, actor?: { name: string; userId: number | null }): Promise<'creado' | 'actualizado' | 'igual' | 'omitido'> {
  const db = env.DB;
  let pdv = readPdv(t);
  if (!pdv.npdv || !pdv.unidad) return 'omitido';
  // Lo que cambia ClickUp en este pedido queda a nombre de quien tiene asignado el PDV, no del usuario de la sincronización.
  const resp = actor ?? await responsableClickup(db, t);
  const pctx: Ctx = resp ? { ...ctx, actor: resp } : ctx;
  const existing = await findOrder(db, pdv);
  // Los artículos que son un servicio no pesan en el estado (por el renglón del pedido o por el código del artículo).
  const servicios = t.subtasks?.length ? await articulosServicio(db, existing?.id ?? null, t.subtasks.map((s) => ({ task_id: s.id, code: leerArticulo(s).code }))) : new Set<string>();
  if (servicios.size) pdv = readPdv(t, servicios);
  let id: number;
  let result: 'creado' | 'actualizado' | 'igual' = 'igual';
  let entregadoAhora = false;   // pasó a «Entregado» en esta lectura: va la tarea post-entrega
  let owner: number | null = null;
  const synced: Record<string, unknown> = {
    unidad_de_negocio: pdv.unidad, cliente_clickup: pdv.cliente || null, pedido_finnegans: pdv.pedido || null, url_clickup: pdv.url,
    detalle_produccion: pdv.detalle, entregado_el: pdv.stage === STAGE.entregado || pdv.stage === STAGE.parcial ? pdv.entregado : null,
  };
  if (!existing) {
    const pipeline = (await new Meta(db).property('order', 'hs_pipeline'))?.options[0]?.value;
    const row = await createRecord(db, pctx, 'order', {
      ...synced, hs_order_name: `PDV ${pdv.npdv}${pdv.cliente ? ` · ${pdv.cliente}` : ''}`, pdv_finnegans: pdv.npdv,
      hs_pipeline_stage: pdv.stage ?? STAGE.confirmado, hs_pipeline: pipeline ?? null, tipo_de_pedido: pdv.evento ? 'EVENTO' : 'PEDIDO NORMAL',
      fecha_de_entrega: pdv.entrega, owner_id: (owner = (await ownerFor(db, pdv.vendedor, pdv.mailVendedor)) ?? null),
    }, { system: true, strict: false });
    id = row.id;
    await enlazarPedido(db, t.id, id);
    entregadoAhora = pdv.stage === STAGE.entregado;
    const company = await companyFor(env, pdv, fin, b);
    if (company) await associate(db, ctx, id, company, { primary: true }).catch(() => undefined);
    // Con su negocio: el que tiene este N° de PDV o el único de su empresa que espera pedido (vinculos.ts).
    await vincularPedido(db, ctx, id).catch((e) => console.error('negocio del pedido', pdv.npdv, (e as Error).message));
    result = 'creado';
  } else {
    id = existing.id;
    const cur = JSON.parse(existing.props) as Record<string, unknown>;
    const change: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(synced)) if (v != null && String(v) !== String(cur[k] ?? '')) change[k] = v;
    if (pdv.stage && pdv.stage !== cur.hs_pipeline_stage) change.hs_pipeline_stage = pdv.stage;
    if (!cur.fecha_de_entrega && pdv.entrega) change.fecha_de_entrega = pdv.entrega;
    if (!cur.tipo_de_pedido) change.tipo_de_pedido = pdv.evento ? 'EVENTO' : 'PEDIDO NORMAL';
    if (cur.owner_id == null) { const o = await ownerFor(db, pdv.vendedor, pdv.mailVendedor); if (o) change.owner_id = o; }
    owner = (change.owner_id ?? cur.owner_id ?? null) as number | null;
    entregadoAhora = change.hs_pipeline_stage === STAGE.entregado;
    if (Object.keys(change).length) { await updateRecord(db, pctx, 'order', id, change, { system: true, strict: false }); result = 'actualizado'; }
    // Anulado (o desanulado) en ClickUp: el monto de su negocio se vuelve a sumar sin este pedido (montos.ts).
    if ('hs_pipeline_stage' in change && (change.hs_pipeline_stage === STAGE.anulado || cur.hs_pipeline_stage === STAGE.anulado)) await montosDesdePedidos(db, [id], ctx);
    // Cambió el pedido de Finnegans: los productos se vuelven a leer al abrir el pedido.
    if ('pedido_finnegans' in change) await db.prepare('DELETE FROM line_item_sync WHERE record_id = ?').bind(id).run();
    // Sin empresa (por ejemplo, entró antes de que la empresa estuviera en el CRM): se vuelve a buscar.
    const hasCompany = await db.prepare(`SELECT 1 FROM associations WHERE (from_id = ? AND to_type = 'company') OR (to_id = ? AND from_type = 'company') LIMIT 1`).bind(id, id).first();
    if (!hasCompany) {
      const company = await companyFor(env, pdv, fin, b);
      if (company) { await associate(db, ctx, id, company, { primary: true }).catch(() => undefined); result = 'actualizado'; }
    }
  }
  // Lo que ClickUp cambió antes de esto (a nombre de la sincronización) pasa a quien tiene asignado el PDV.
  if (resp && !actor) {
    await db.prepare("UPDATE changes SET user_id = ?, actor = ? WHERE record_id = ? AND source = 'clickup' AND actor IS NULL").bind(resp.userId, resp.name, id).run();
  }
  if (entregadoAhora) {
    await tareaPostEntrega(db, ctx, id, { npdv: pdv.npdv, cliente: pdv.cliente, vendedor: pdv.vendedor, recibido: pdv.entregado, ownerId: owner })
      .catch((e) => console.error('post-entrega', pdv.npdv, (e as Error).message));
  }
  // El remito: lo que suben a la tarea del PDV cuando lo entregan (una foto del remito firmado). Si lo suben al artículo
  // (pasa seguido), se busca al abrir el pedido (clickupRemitos), para no gastar consultas en cada PDV entregado.
  const remitosNuevos = (pdv.stage === STAGE.entregado || pdv.stage === STAGE.parcial) ? await saveRemitos(db, id, t, pdv.npdv) : 0;
  if (remitosNuevos && result === 'igual') result = 'actualizado';
  // El estado de entrega (remitos.ts): cambió la etapa o llegó un remito (ClickUp no se toca; el remito se lee aparte).
  if (remitosNuevos || pdv.stage !== (existing ? JSON.parse(existing.props).hs_pipeline_stage : null)) {
    await recalcularEntrega(env, id).catch((e) => console.error('entrega', pdv.npdv, (e as Error).message));
  }
  return result;
}

// ¿Es el remito de ese PDV? En ClickUp, además del remito firmado, suben fotos del producto, capturas y bocetos (también
// los que adjunta el CRM). El remito se sube con el número del PDV como nombre: «PDV 31167.jpeg», «PDV 31224 - 1.jpg»,
// «PDV NE 36.jpg», «pdv28888.PNG» o, en los más viejos, «28924.JPG». Lo demás («image.png», «Captura de pantalla…»,
// «chomba.jpg», «BOCETO….pdf») no es remito. Si se sabe el número del PDV, tiene que ser ese.
export function esRemito(nombre: string | null | undefined, npdv?: string | null) {
  const m = String(nombre ?? '').trim().match(/^(?:remito\s*)?(?:pdv\s*-?\s*)?(?:ne\s*-?\s*)?0*(\d+)(?:\s*[-_]\s*\d{1,2}|\s*\(\d{1,2}\))?\s*\.(?:jpe?g|png|heic|heif|webp|pdf)$/i);
  if (!m) return false;
  return !npdv || Number(m[1]) === Number(npdv);
}

async function saveRemitos(db: D1Database, recordId: number, t: CuTask, npdv: string) {
  let added = 0;
  for (const a of (t.attachments ?? []).filter((x) => esRemito(x.title, npdv))) {
    const r = await db.prepare(`INSERT OR IGNORE INTO files (record_id, kind, name, mime, size, source, source_ref, meta)
      VALUES (?, 'remito', ?, ?, ?, 'clickup', ?, ?)`).bind(recordId, a.title || `Remito PDV ${npdv}`, a.mimetype ?? null, a.size ?? null, `${t.id}:${a.id}`,
      JSON.stringify({ task: t.id, attachment: a.id, date: a.date ? new Date(Number(a.date)).toISOString() : null })).run();
    added += r.meta.changes;
    // También a la lista de remitos del pedido (remitos.ts), para leerlo y contarlo en la entrega.
    if (r.meta.changes) {
      await db.prepare(`INSERT OR IGNORE INTO remitos (record_id, origen, file_id, nombre, mime, size, created_at, updated_at)
        SELECT record_id, 'clickup', id, name, mime, size, created_at, created_at FROM files WHERE source = 'clickup' AND source_ref = ? AND record_id = ?`)
        .bind(`${t.id}:${a.id}`, recordId).run();
    }
  }
  return added;
}

// Remitos subidos a los artículos del PDV (no a la tarea del PDV): se buscan al abrir un pedido entregado que todavía no
// tiene remito, como mucho cada 30 minutos, y de fondo con remitosPendientes. Devuelve cuántos encontró.
export async function clickupRemitos(env: Env, recordId: number, props: Record<string, unknown>, opts: { budget?: Budget; cada?: number } = {}) {
  const db = env.DB;
  const stage = props.hs_pipeline_stage;
  const taskId = String(props.url_clickup ?? '').match(/\/t\/([\w-]+)/)?.[1];
  if (!env.CLICKUP_TOKEN || !taskId || (stage !== STAGE.entregado && stage !== STAGE.parcial)) return 0;
  if (await db.prepare("SELECT 1 FROM files WHERE record_id = ? AND kind = 'remito' LIMIT 1").bind(recordId).first()) return 0;
  const key = `remito_check:${recordId}`;
  const last = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (last && Date.now() - Number(last.value) < (opts.cada ?? 30 * 60_000)) return 0;
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, String(Date.now())).run();
  const b = opts.budget ?? Budget.of(env);
  try {
    const t = await cu<CuTask>(env, `/task/${taskId}`, { include_subtasks: 'true' }, b);
    const npdv = readPdv(t).npdv;
    let n = await saveRemitos(db, recordId, t, npdv);
    for (const s of t.subtasks ?? []) {
      if (b.left() < 1) throw new OutOfBudget();
      const full = await cu<CuTask>(env, `/task/${s.id}`, {}, b).catch((e) => { if (frenar(e)) throw e; return null; });
      if (full) n += await saveRemitos(db, recordId, full, npdv);
    }
    return n;
  } catch (e) {
    // Si no se pudo revisar entero (se acabó el tope o ClickUp pidió esperar), no queda como revisado.
    if (frenar(e)) await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    throw e;
  }
}
export const frenar = (e: unknown) => e instanceof OutOfBudget || /HTTP 429/.test((e as Error)?.message ?? '');

// Saca los «remitos» guardados antes de que se miraran los nombres (fotos de producto, capturas, bocetos): solo en el CRM,
// en ClickUp no se toca nada.
export async function limpiarRemitos(db: D1Database) {
  const { results } = await db.prepare(`SELECT f.id, f.name, json_extract(r.props, '$.pdv_finnegans') AS pdv FROM files f JOIN records r ON r.id = f.record_id
    WHERE f.kind = 'remito' AND f.source = 'clickup'`).all<{ id: number; name: string; pdv: string | number | null }>();
  const malos = results.filter((f) => !esRemito(f.name, f.pdv == null ? null : String(f.pdv).match(/\d+/)?.[0])).map((f) => f.id);
  if (malos.length) {
    const lista = JSON.stringify(malos);
    await db.batch([
      db.prepare('DELETE FROM remito_items WHERE remito_id IN (SELECT id FROM remitos WHERE file_id IN (SELECT value FROM json_each(?)))').bind(lista),
      db.prepare('UPDATE remitos SET duplicado_de = NULL WHERE duplicado_de IN (SELECT id FROM remitos WHERE file_id IN (SELECT value FROM json_each(?)))').bind(lista),
      db.prepare('DELETE FROM remitos WHERE file_id IN (SELECT value FROM json_each(?))').bind(lista),
      db.prepare('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))').bind(lista),
    ]);
  }
  return { revisados: results.length, borrados: malos.length };
}

// De fondo (scripts/pedidos-productos.mjs): los pedidos entregados sin remito, para que la tarjeta del tablero sepa si lo
// tiene aunque nadie haya abierto el pedido. Cada uno se vuelve a revisar como mucho una vez por semana.
const REMITOS_WHERE = `r.object_type = 'order' AND r.archived = 0 AND json_extract(r.props, '$.hs_pipeline_stage') IN (?1, ?2)
    AND json_extract(r.props, '$.url_clickup') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM files f WHERE f.record_id = r.id AND f.kind = 'remito')
    AND COALESCE((SELECT CAST(s.value AS INTEGER) FROM settings s WHERE s.key = 'remito_check:' || r.id), 0) < ?3`;
export async function remitosPendientes(env: Env, limit = 20) {
  if (!env.CLICKUP_TOKEN) return { revisados: 0, encontrados: 0, quedan: 0, skipped: 'Falta CLICKUP_TOKEN.' };
  const db = env.DB;
  const b = Budget.of(env);
  const SEMANA = 7 * 86_400_000;
  const binds = [STAGE.entregado, STAGE.parcial, Date.now() - SEMANA];
  const { results } = await db.prepare(`SELECT r.id, r.props FROM records r WHERE ${REMITOS_WHERE} ORDER BY r.updated_at DESC LIMIT ?4`)
    .bind(...binds, limit).all<{ id: number; props: string }>();
  let revisados = 0, encontrados = 0;
  for (const r of results) {
    if (b.left() < 10) break;   // un PDV puede tener varios artículos: no se empieza si no alcanza
    try { encontrados += await clickupRemitos(env, r.id, JSON.parse(r.props), { budget: b, cada: SEMANA }); } catch (e) {
      if (frenar(e)) break;
      console.error('remito', r.id, (e as Error).message);   // queda anotado como revisado: se reintenta la semana que viene
    }
    revisados++;
  }
  const quedan = await db.prepare(`SELECT COUNT(*) AS n FROM records r WHERE ${REMITOS_WHERE}`).bind(...binds).first<{ n: number }>();
  return { revisados, encontrados, quedan: quedan?.n ?? 0 };
}

export interface ClickupState {
  last?: number;                    // cuándo empezó la última lectura completa de la lista (la próxima pide lo cambiado desde ahí)
  scan?: { full: boolean; step: number; page: number; since: number; started: number } | null;   // lectura en curso
  queue?: Array<[string, number]>;  // PDV por revisar: [tarea, última modificación]
  at?: string; creados?: number; actualizados?: number; error?: string | null; pendientes?: number;
  produccion?: number;              // 1: ya se hizo la lectura completa que llena la vista de Producción (produccion.ts)
}

export async function clickupState(db: D1Database): Promise<ClickupState> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'clickup_state'").first<{ value: string }>();
  return r ? JSON.parse(r.value) : {};
}
// Lo que se muestra en Configuración → Integraciones (sin la lista de PDV por revisar).
export async function clickupStatus(db: D1Database) {
  const { queue: _q, scan, ...st } = await clickupState(db);
  return { ...st, leyendo_lista: !!scan };
}

// Cada corrida: 1) sigue leyendo la lista (lo que cambió desde la última vez; en la carga completa, también los PDV
// cerrados de los últimos 45 días y todos los abiertos) y anota los PDV por revisar; 2) revisa los PDV anotados, primero
// los que cambiaron más recién. Si llega al tope de consultas, lo que falta queda anotado para la próxima.
export async function syncClickup(env: Env, opts: { full?: boolean } = {}) {
  if (!env.CLICKUP_TOKEN) return { skipped: 'Falta CLICKUP_TOKEN.' };
  const db = env.DB;
  const state = await clickupState(db);
  const started = Date.now();
  const b = Budget.of(env);
  const queue = new Map(state.queue ?? []);
  // Los PDV que hay que volver a leer porque cambió qué renglones son un servicio (servicios.ts).
  for (const pid of await relecturasPedidas(db)) queue.set(pid, Math.max(queue.get(pid) ?? 0, started));
  const out: ClickupState = { ...state, at: new Date(started).toISOString(), creados: 0, actualizados: 0, error: null };
  // La vista de Producción necesita una lectura completa de la lista la primera vez (después, lo cambiado alcanza).
  const llenarProduccion = !state.produccion && !state.scan?.full;
  if (opts.full || llenarProduccion || (!state.last && !state.scan)) out.scan = { full: true, step: 0, page: 0, since: started - 45 * 86_400_000, started };
  else if (!state.scan) out.scan = { full: false, step: 0, page: 0, since: state.last! - 5 * 60_000, started };
  try {
    const ctx = await systemCtx(env);
    // 1. La lista, de a páginas de 100 tareas (PDV y artículos).
    while (out.scan && b.left() > LISTADO) {
      const sc = out.scan;
      const params: Record<string, string | number> = sc.step === 0 ? { include_closed: 'true', date_updated_gt: sc.since, order_by: 'updated', reverse: 'true' } : {};
      const d = await cu<{ tasks: CuTask[]; last_page?: boolean }>(env, `/list/${LIST}/task`, { ...params, subtasks: 'true', page: sc.page }, b);
      for (const t of d.tasks) {
        const pid = t.parent || t.id;
        queue.set(pid, Math.max(queue.get(pid) ?? 0, Number(t.date_updated ?? 0)));
      }
      out.actualizados! += await ownersFromList(db, ctx, d.tasks);
      // La lista ya trae cada artículo con sus campos y sus asignados: a la vista de Producción, sin consultas de más.
      await guardarTareas(db, d.tasks);
      if (d.last_page === false && d.tasks.length && sc.page < 200) sc.page++;
      else if (sc.full && sc.step === 0) { sc.step = 1; sc.page = 0; }
      else { out.last = sc.started; if (sc.full) out.produccion = 1; out.scan = null; }
    }
    await leerEstados(env, b).catch((e) => { if (e instanceof OutOfBudget) throw e; console.error('estados', (e as Error).message); });
    await vincularOpciones(db, ctx).catch((e) => console.error('proveedores', (e as Error).message));
    // El PROVEEDOR que falta, por el SKU del artículo (pocos por corrida; deja lugar para revisar PDV).
    await completarProveedores(env, b, { reserva: POR_PDV * 2 }).catch((e) => { if (e instanceof OutOfBudget) throw e; console.error('proveedores por SKU', (e as Error).message); });
    // 2. Los PDV anotados.
    // El CUIT del pedido (dos consultas a Finnegans) solo sirve si hay empresas con CUIT en el CRM; si no, se busca por nombre.
    const conCuit = await db.prepare("SELECT 1 FROM records WHERE object_type = 'company' AND archived = 0 AND COALESCE(json_extract(props, '$.cuit'), '') != '' LIMIT 1").first();
    let fin: string | null | undefined = conCuit ? undefined : null;
    for (const [pid] of [...queue.entries()].sort((x, y) => y[1] - x[1])) {
      if (b.left() < POR_PDV) break;
      let t: CuTask;
      try {
        t = await cu<CuTask>(env, `/task/${pid}`, { include_subtasks: 'true' }, b);
      } catch (e) {
        if (e instanceof OutOfBudget) throw e;
        queue.delete(pid);   // la tarea ya no está (la borraron o la movieron de lista)
        continue;
      }
      if (!t.parent && /PDV/i.test(t.name)) {
        // Producción: el estado y los asignados de cada artículo, y fuera los que ya no están en el PDV.
        await guardarTareas(db, [t, ...(t.subtasks ?? []).map((s) => ({ ...s, parent: s.parent ?? t.id }))]);
        if (t.subtasks) await podarArticulos(db, t.id, [t.id, ...t.subtasks.map((s) => s.id)]);
        if (fin === undefined) fin = await finnegansToken(env, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
        const r = await upsertPdv(env, ctx, t, fin, b);
        if (r === 'creado') out.creados!++;
        if (r === 'actualizado') out.actualizados!++;
      }
      queue.delete(pid);
    }
  } catch (e) {
    if (!(e instanceof OutOfBudget)) out.error = (e as Error).message;
  }
  out.queue = [...queue.entries()];
  out.pendientes = queue.size;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clickup_state', ?)").bind(JSON.stringify(out)).run();
  return clickupStatus(db);
}

// Para abrir un remito: ClickUp da un link nuevo (y de un solo uso si los adjuntos son privados) cada vez que se pide.
export async function clickupAttachment(env: Env, taskId: string, attachmentId: string) {
  if (!env.CLICKUP_TOKEN) return null;
  const t = await cu<{ attachments?: Array<{ id: string; url?: string; url_w_query?: string; title?: string; mimetype?: string }> }>(env, `/task/${taskId}`);
  const a = t.attachments?.find((x) => x.id === attachmentId);
  const url = a?.url_w_query || a?.url;
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: env.CLICKUP_TOKEN } });
  if (!res.ok) return null;
  return { body: res.body, type: res.headers.get('content-type') ?? a?.mimetype ?? 'application/octet-stream', name: a?.title ?? 'remito' };
}

