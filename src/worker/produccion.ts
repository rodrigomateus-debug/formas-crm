import { logosDeArticulos } from './logos';
import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { Budget, OutOfBudget } from './budget';
import { createRecord, updateRecord, ORDER_ANTICIPO } from './records';
import { API, cu, generalStage, leerArticulo, LIST, norm, STAGE, upsertPdv, usuarioPorNombre, type CuTask } from './clickup';
import { fotosDeArticulos } from './productos';
import { TAREAS_SERVICIO_SQL, tareasServicio } from './servicios';
import { admiteNotas, resumenNotas, skusDeArticulos, type ResumenNotas } from './notasproducto';
import { costosLogoDeArticulos, type CostoLogo } from './costoslogo';
import { ocsDeCodigo, ocsDePedidos, sinCodigos, type OcRef } from './ordenescompra';
import { recalcularTallesPdvs } from './tallesdb';
import { compararTalles, costoLogoDeGrupo, nombreSinTalle, raizTalle, talleCanonico, TALLES_VERSION, type CostoLogoTalles } from './talles';

// Producción en el CRM (pedido de Rodrigo del 12/11/2026). Producción (Ceci y Sole) trabaja en ClickUp con la vista «Estado
// PDV CECI»: cada PDV con sus artículos abiertos abajo, y en cada artículo su estado, proveedor, impresor y las fechas de
// ingreso y retiro. Esto la trae al CRM y la deja editar:
//
// - ClickUp sigue siendo la fuente de verdad. Lo que se edita en el CRM se escribe en ClickUp en el momento (si ClickUp no
//   lo acepta, no cambia nada); lo que cambian en ClickUp llega con la sincronización de cada 10 minutos (clickup.ts lee
//   la lista y guarda cada tarea acá, sin consultas de más).
// - Es un camino de a poco: arranca con Formas Shop. Las unidades que se editan desde el CRM se eligen (settings
//   `produccion`); las otras se ven pero se siguen trabajando en ClickUp.
// - El estado del PDV sale de la combinación de sus artículos (generalStage, la misma regla que el estado del pedido).
// - Los desplegables PROVEEDOR e IMPRESOR de ClickUp quedan atados a empresas del CRM con tipo de relación «Proveedor»,
//   con las opciones repetidas («FYR SA» y «FYRSA») en la misma empresa.
// - El proveedor que falta sale del SKU del artículo (completarProveedores): ZEC Zecat, IMP Promoproductos…

// Los campos de la lista PEC que se ven y se editan (id del campo personalizado en ClickUp).
export const CAMPOS = {
  entrega_real: { id: '10e3d8d0-bbd5-47af-946b-504ef9804428', nombre: 'ENTREGAS (FECHA REAL)', tipo: 'date' },
  ingreso_proveedor: { id: '98df51eb-1142-4ff5-b80c-9fd239ea3aac', nombre: 'INGRESO (PROVEEDOR)', tipo: 'date' },
  retiro_proveedor: { id: '7fd568b7-9cfd-45fc-9f05-22864a0b9e9a', nombre: 'RETIROS (PROVEEDOR)', tipo: 'date' },
  egreso_impresor: { id: 'c278fabb-b558-4a28-a6f6-f6b26a8e29eb', nombre: 'EGRESO (IMPRESOR)', tipo: 'date' },
  retiro_impresor: { id: '3146d848-4952-4ac8-aac4-971e1361609b', nombre: 'RETIRO (IMPRESOR)', tipo: 'date' },
  // El impresor trae lo que hizo al depósito, en vez de ir a retirarlo (pedido de Producción del 19/11/2026). Pasa poco.
  ingreso_impresor: { id: '3806fa77-1c1c-46d3-b631-0168b139de9d', nombre: 'INGRESO (IMPRESOR)', tipo: 'date' },
  proveedor: { id: 'fd7010e7-cece-4d06-850a-ce5e948c1f83', nombre: 'PROVEEDOR', tipo: 'drop_down' },
  impresor: { id: '555918b9-e727-4f89-aa67-b97a94dd6136', nombre: 'IMPRESOR', tipo: 'drop_down' },
  cantidad: { id: 'eb9f3a13-3f31-4a2f-b924-3cfaec8d376f', nombre: 'CANTIDAD', tipo: 'number' },
  cantidad_controlada: { id: '20709bfe-0f0b-465c-8ac6-95407a254f50', nombre: 'CANTIDAD CONTROLADA', tipo: 'number' },
  cliente: { id: '55db0f4f-7ab0-4b56-8bde-417e31f44c88', nombre: 'CLIENTE', tipo: 'short_text' },
  vendedor: { id: '5e014e79-3d11-4106-aa55-91eb0aec9f32', nombre: '🧑‍💻 VENDEDOR', tipo: 'short_text' },
  unidad: { id: '8dcf7531-1dad-45f5-aff3-bb9e45895c98', nombre: 'UNIDAD DE NEGOCIO', tipo: 'drop_down' },
  npdv: { id: 'c0ead31a-5a3e-4a89-b666-f2d282a6f921', nombre: 'N° PDV', tipo: 'short_text' },
} as const;
type Campo = keyof typeof CAMPOS;
const FECHAS = ['entrega_real', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor', 'ingreso_impresor'] as const;
// Lo que se puede editar desde el CRM.
export const EDITABLES = ['estado', 'asignados', ...FECHAS, 'proveedor', 'impresor', 'cantidad_controlada'] as const;
type Editable = (typeof EDITABLES)[number];

// Los estados de la lista PEC, en orden, con su color de ClickUp. La sincronización los vuelve a leer una vez por día
// (por si suman uno); estos son los de noviembre de 2026.
export const ESTADOS_PEC: Array<{ status: string; color: string; type: string }> = [
  { status: 'ingreso de pedido', color: '#d33d44', type: 'open' },
  { status: 'pdv', color: '#a18072', type: 'unstarted' },
  { status: 'en espera de confirmación', color: '#f76808', type: 'custom' },
  { status: 'personales', color: '#646464', type: 'custom' },
  { status: 'boceto pendiente', color: '#e5484d', type: 'custom' },
  { status: 'pedido al proveedor', color: '#1090e0', type: 'custom' },
  { status: 'ingreso proveedor/ stock', color: '#ab4aba', type: 'custom' },
  { status: 'en control de depósito', color: '#1090e0', type: 'custom' },
  { status: 'en el impresor', color: '#ffc53d', type: 'custom' },
  { status: 'impresión aprobada', color: '#f708b4', type: 'custom' },
  { status: 'articulo con logo', color: '#1090e0', type: 'custom' },
  { status: 'en revision', color: '#0f9d9f', type: 'custom' },
  { status: 'parcial entregado', color: '#30a46c', type: 'custom' },
  { status: 'listo para entergar', color: '#008844', type: 'custom' },
  { status: 'anulado', color: '#8d8d8d', type: 'done' },
  { status: 'entregados', color: '#008844', type: 'closed' },
];
// «Pendiente de anticipo» (pedido de Rodrigo del 19/11/2026): un estado que no existe en ClickUp. Lo tienen, en la vista
// de Producción, el PDV y los artículos que todavía no arrancaron («ingreso de pedido» o «pdv») de un pedido que está en
// «$ Pendiente de Anticipo»: lo que está por entrar pero todavía no se pagó. Sale de la etapa del pedido, no se elige:
// cuando la vendedora lo pasa a «Listo para producción» (o producción mueve el artículo), vuelve el estado de ClickUp.
export const PENDIENTE_ANTICIPO = 'pendiente de anticipo';
const SIN_ARRANCAR = ['ingreso de pedido', 'pdv'];
// La lista de estados con ese, antes de «en espera de confirmación».
export function conAnticipo<T extends { status: string }>(estados: T[]): Array<T | { status: string; color: string; type: string }> {
  if (estados.some((e) => e.status === PENDIENTE_ANTICIPO)) return estados;
  const i = estados.findIndex((e) => e.status.startsWith('en espera de confirmaci'));
  const en = i >= 0 ? i : Math.max(0, estados.findIndex((e) => !SIN_ARRANCAR.includes(e.status)));
  return [...estados.slice(0, en), { status: PENDIENTE_ANTICIPO, color: '#12a594', type: 'custom' }, ...estados.slice(en)];
}
export const CERRADOS = ['entregados', 'anulado', 'anulada', 'cancelado'];
const LISTOS = ['listo para entergar', 'listo para entregar', 'entregados'];

// ---------- Lectura de las tareas de ClickUp ----------

interface Fila {
  task_id: string; pdv_task: string; es_pdv: number; nombre: string; npdv: string | null; estado: string;
  unidad: string | null; cliente: string | null; vendedor: string | null; cantidad: number | null; cantidad_controlada: number | null;
  proveedor: string | null; impresor: string | null; entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null;
  egreso_impresor: string | null; retiro_impresor: string | null; ingreso_impresor: string | null; vence: string | null; asignados: string; etiquetas: string;
  orden: number; url: string | null; actualizado: number; codigo: string | null;
  creado: string | null;   // alta de la tarea en ClickUp (date_created), AAAA-MM-DD
}

// Una fecha de ClickUp (ms) → AAAA-MM-DD en Buenos Aires.
const diaDe = (v: unknown) => {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return null;
  return new Date(n - 3 * 3600_000).toISOString().slice(0, 10);
};
// AAAA-MM-DD → ms para ClickUp: el mediodía de Buenos Aires, para que no cambie de día con el huso.
export const msDe = (dia: string) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d, 15); };

type CampoCu = NonNullable<CuTask['custom_fields']>[number];
const campoDe = (t: CuTask, c: Campo): CampoCu | undefined => {
  const def = CAMPOS[c];
  return t.custom_fields?.find((f) => f.id === def.id) ?? t.custom_fields?.find((f) => (f.name ?? '').trim() === def.nombre.trim());
};
// El id de la opción elegida de un desplegable (ClickUp da el id, o el orderindex en los desplegables viejos).
function opcionDe(f: CampoCu | undefined): string | null {
  const v = f?.value as unknown;
  if (v == null || v === '') return null;
  const ops = f!.type_config?.options ?? [];
  if (typeof v === 'object') {
    const o = v as { id?: string; name?: string };
    return o.id ?? ops.find((x) => x.name === o.name)?.id ?? o.name ?? null;
  }
  return ops.find((x) => x.id === v || x.orderindex === Number(v))?.id ?? String(v);
}
function nombreOpcion(f: CampoCu | undefined): string | null {
  const id = opcionDe(f);
  if (!id) return null;
  const v = f!.value as { name?: string } | unknown;
  return f!.type_config?.options?.find((x) => x.id === id)?.name ?? (typeof v === 'object' ? (v as { name?: string }).name ?? null : null) ?? id;
}
const texto = (f: CampoCu | undefined) => (f?.value == null || f.value === '' ? null : String(f.value).trim() || null);
const numero = (f: CampoCu | undefined) => {
  if (f?.value == null || f.value === '') return null;
  const n = Number(String(f.value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Una tarea → su fila. `campos: false` cuando ClickUp no mandó los campos personalizados (las subtareas que vienen
// dentro de la tarea del PDV): esa vez no se pisan.
function filaDe(t: CuTask, pdvTask: string): Fila & { campos: boolean } {
  const es_pdv = t.id === pdvTask ? 1 : 0;
  const nombre = (t.name ?? '').split(/\r?\n/)[0].trim();
  return {
    task_id: t.id, pdv_task: pdvTask, es_pdv, nombre, campos: Array.isArray(t.custom_fields),
    npdv: (texto(campoDe(t, 'npdv')) ?? (es_pdv ? nombre : ''))?.match(/(\d+)/)?.[1] ?? null,
    estado: (t.status?.status ?? '').toLowerCase().trim(),
    unidad: nombreOpcion(campoDe(t, 'unidad'))?.trim().toUpperCase() ?? null,
    cliente: texto(campoDe(t, 'cliente')), vendedor: texto(campoDe(t, 'vendedor')),
    cantidad: numero(campoDe(t, 'cantidad')), cantidad_controlada: numero(campoDe(t, 'cantidad_controlada')),
    proveedor: opcionDe(campoDe(t, 'proveedor')), impresor: opcionDe(campoDe(t, 'impresor')),
    entrega_real: diaDe(campoDe(t, 'entrega_real')?.value), ingreso_proveedor: diaDe(campoDe(t, 'ingreso_proveedor')?.value),
    retiro_proveedor: diaDe(campoDe(t, 'retiro_proveedor')?.value), egreso_impresor: diaDe(campoDe(t, 'egreso_impresor')?.value),
    retiro_impresor: diaDe(campoDe(t, 'retiro_impresor')?.value), ingreso_impresor: diaDe(campoDe(t, 'ingreso_impresor')?.value), vence: diaDe(t.due_date),
    asignados: JSON.stringify((t.assignees ?? []).map((a) => a.id).filter((x) => x != null)),
    etiquetas: JSON.stringify((t.tags ?? []).map((x) => x.name).filter(Boolean)),
    orden: Number(t.orderindex ?? 0) || 0, url: t.url ?? null, actualizado: Number(t.date_updated ?? 0) || 0, creado: diaDe(t.date_created),
    // El SKU: la línea «Código:» de la descripción del artículo (si la tarea no trajo la descripción, queda el que estaba).
    codigo: es_pdv || !(t.text_content || t.description) ? null : leerArticulo(t).code?.trim() || null,
  };
}

const COLS = ['task_id', 'pdv_task', 'es_pdv', 'nombre', 'npdv', 'estado', 'unidad', 'cliente', 'vendedor', 'cantidad', 'cantidad_controlada', 'proveedor',
  'impresor', 'entrega_real', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor', 'ingreso_impresor', 'vence', 'asignados', 'etiquetas', 'orden', 'url', 'actualizado',
  'codigo', 'creado'] as const;
// Sin los campos personalizados se actualiza solo lo que trae siempre la tarea (y el código, si vino la descripción).
const SIEMPRE = ['nombre', 'estado', 'vence', 'asignados', 'etiquetas', 'orden', 'url', 'actualizado', 'codigo', 'creado'];

// Guarda las tareas que trajo ClickUp: los PDV (tareas de la lista con «PDV» en el nombre) y sus artículos (subtareas).
// Lo más viejo no pisa lo más nuevo. También guarda la gente asignada y las opciones de PROVEEDOR e IMPRESOR.
export async function guardarTareas(db: D1Database, tasks: CuTask[]) {
  const filas: Array<Fila & { campos: boolean }> = [];
  for (const t of tasks) {
    if (t.parent) filas.push(filaDe(t, t.parent));
    else if (/PDV/i.test(t.name ?? '')) filas.push(filaDe(t, t.id));
  }
  if (!filas.length) return 0;
  // Cómo estaban antes, para anotar los cambios de estado en la conversación del pedido (conversacion.ts).
  const antes = new Map((await db.prepare('SELECT task_id, estado, actualizado, record_id FROM produccion WHERE task_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(filas.map((f) => f.task_id))).all<{ task_id: string; estado: string; actualizado: number; record_id: number | null }>()).results.map((r) => [r.task_id, r]));
  const stmts: D1PreparedStatement[] = [];
  for (const f of filas) {
    const set = (f.campos ? COLS.filter((c) => c !== 'task_id' && c !== 'pdv_task' && c !== 'es_pdv') : SIEMPRE)
      .map((c) => (c === 'codigo' || c === 'creado' ? `${c} = COALESCE(excluded.${c}, produccion.${c})` : `${c} = excluded.${c}`));
    stmts.push(db.prepare(`INSERT INTO produccion (${COLS.join(', ')}, record_id, leido_at) VALUES (${COLS.map(() => '?').join(', ')},
        (SELECT record_id FROM produccion WHERE task_id = ?), ?)
      ON CONFLICT(task_id) DO UPDATE SET ${set.join(', ')}, pdv_task = excluded.pdv_task, leido_at = excluded.leido_at
      WHERE excluded.actualizado >= produccion.actualizado`).bind(...COLS.map((c) => f[c] ?? null), f.pdv_task, now()));
  }
  await db.batch(stmts);
  await guardarPersonas(db, tasks);
  await guardarOpciones(db, tasks);
  await enlazarPedidos(db, [...new Set(filas.map((f) => f.pdv_task))]);
  // El talle de cada artículo y los talles que van juntos (talles.ts): con los nombres y códigos que acaban de llegar.
  await recalcularTallesPdvs(db, [...new Set(filas.map((f) => f.pdv_task))]);
  const cambios = filas.filter((f) => { const a = antes.get(f.task_id); return a && a.record_id && f.estado && a.estado !== f.estado && f.actualizado >= a.actualizado; });
  if (cambios.length) await anotarCambiosDeEstado(db, cambios.map((f) => ({ ...f, record_id: antes.get(f.task_id)!.record_id!, antes: antes.get(f.task_id)!.estado })));
  return filas.length;
}

// Los cambios de estado que vinieron de ClickUp, a nombre de quien tiene asignada la tarea (como el historial del pedido).
async function anotarCambiosDeEstado(db: D1Database, cambios: Array<Fila & { record_id: number; antes: string }>) {
  const ids = [...new Set(cambios.flatMap((c) => lista(c.asignados).map(Number)))];
  const personas = new Map(ids.length ? (await db.prepare('SELECT clickup_id, nombre, user_id FROM clickup_personas WHERE clickup_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all<{ clickup_id: number; nombre: string; user_id: number | null }>()).results.map((p) => [p.clickup_id, p]) : []);
  const ts = now();
  await db.batch(cambios.map((c) => {
    const quien = lista(c.asignados).map((x) => personas.get(Number(x))).find(Boolean);
    return db.prepare(`INSERT INTO produccion_cambios (record_id, task_id, articulo, es_pdv, campo, antes, despues, user_id, actor, source, at)
      VALUES (?, ?, ?, ?, 'estado', ?, ?, ?, ?, 'clickup', ?)`).bind(c.record_id, c.task_id, c.nombre, c.es_pdv, c.antes, c.estado,
      quien?.user_id ?? null, quien && !quien.user_id ? quien.nombre : null, ts);
  }));
}

// Cada PDV con su pedido del CRM (por el link de ClickUp del pedido), y sus artículos también.
async function enlazarPedidos(db: D1Database, pdvs: string[]) {
  const sin = (await db.prepare(`SELECT task_id, url FROM produccion WHERE es_pdv = 1 AND record_id IS NULL AND task_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(pdvs)).all<{ task_id: string; url: string | null }>()).results;
  const urls = sin.map((s) => s.url ?? `https://app.clickup.com/t/${s.task_id}`);
  const pedidos = urls.length ? (await db.prepare(`SELECT id, json_extract(props, '$.url_clickup') AS url FROM records
      WHERE object_type = 'order' AND archived = 0 AND json_extract(props, '$.url_clickup') IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(urls)).all<{ id: number; url: string }>()).results : [];
  const porUrl = new Map(pedidos.map((p) => [p.url, p.id]));
  const stmts = sin.map((s) => [s.task_id, porUrl.get(s.url ?? `https://app.clickup.com/t/${s.task_id}`)] as const).filter(([, id]) => id)
    .map(([task, id]) => db.prepare('UPDATE produccion SET record_id = ? WHERE pdv_task = ?').bind(id, task));
  // Los artículos que llegaron antes que su PDV tenga pedido, o que llegaron después.
  stmts.push(db.prepare(`UPDATE produccion SET record_id = (SELECT p.record_id FROM produccion p WHERE p.task_id = produccion.pdv_task)
    WHERE es_pdv = 0 AND record_id IS NULL AND pdv_task IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pdvs)));
  await db.batch(stmts);
}
// Cuando la sincronización crea el pedido de un PDV, lo engancha con su fila.
export async function enlazarPedido(db: D1Database, pdvTask: string, recordId: number) {
  await db.prepare('UPDATE produccion SET record_id = ? WHERE pdv_task = ? AND (record_id IS NULL OR record_id != ?)').bind(recordId, pdvTask, recordId).run();
}

// Saca los artículos que ya no están en el PDV (los borraron o los movieron a otro PDV). `ids`: el PDV y sus subtareas.
export async function podarArticulos(db: D1Database, pdvTask: string, ids: string[]) {
  const r = await db.prepare('DELETE FROM produccion WHERE pdv_task = ? AND task_id NOT IN (SELECT value FROM json_each(?))').bind(pdvTask, JSON.stringify(ids)).run();
  // Sin ese artículo, los talles que quedan pueden dejar de ser un grupo.
  if (r.meta?.changes) await recalcularTallesPdvs(db, [pdvTask]);
}

async function guardarPersonas(db: D1Database, tasks: CuTask[]) {
  const vistas = new Map<number, NonNullable<CuTask['assignees']>[number]>();
  for (const t of tasks) for (const a of t.assignees ?? []) if (a.id != null && (a.username || a.email)) vistas.set(Number(a.id), a);
  if (!vistas.size) return;
  const users = (await db.prepare('SELECT id, name, email FROM users WHERE deleted_at IS NULL').all<{ id: number; name: string; email: string }>()).results;
  await db.batch([...vistas.values()].map((a) => {
    const nombre = a.username || String(a.email ?? '').split('@')[0];
    const user = usuarioPorNombre(users, nombre, a.email ?? '');
    return db.prepare(`INSERT INTO clickup_personas (clickup_id, nombre, email, foto, iniciales, color, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clickup_id) DO UPDATE SET nombre = excluded.nombre, email = excluded.email, foto = excluded.foto, iniciales = excluded.iniciales,
        color = excluded.color, user_id = excluded.user_id`)
      .bind(Number(a.id), nombre, a.email ?? null, a.profilePicture ?? null, a.initials ?? null, a.color ?? null, user);
  }));
}

// Las opciones de PROVEEDOR e IMPRESOR (vienen en cada tarea): solo se escriben si cambiaron.
async function guardarOpciones(db: D1Database, tasks: CuTask[]) {
  for (const campo of ['proveedor', 'impresor'] as const) {
    const ops = tasks.map((t) => campoDe(t, campo)?.type_config?.options).find((o) => o?.length);
    if (!ops) continue;
    const firma = `${ops.length}:${ops.map((o) => `${o.id}=${o.name}`).join('|')}`;
    const clave = `produccion_opciones:${campo}`;
    const antes = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(clave).first<{ value: string }>();
    if (antes?.value === firma) continue;
    await db.batch([
      ...ops.map((o, i) => db.prepare(`INSERT INTO produccion_opciones (campo, option_id, nombre, color, orden) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(campo, option_id) DO UPDATE SET nombre = excluded.nombre, color = excluded.color, orden = excluded.orden,
          vinculada = CASE WHEN produccion_opciones.nombre = excluded.nombre THEN produccion_opciones.vinculada ELSE 0 END`)
        .bind(campo, o.id, String(o.name ?? '').trim(), (o as { color?: string }).color ?? null, o.orderindex ?? i)),
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(clave, firma),
    ]);
  }
}

// ---------- Proveedores e impresores: empresas del CRM ----------

// Las opciones que no son una empresa.
const NO_EMPRESA = ['stock', 'sinlogo', 'impresoradefinir', 'adefinir'];
// Repetidas con otro nombre (las que se ve que son la misma; las dudosas quedan separadas y se juntan combinando las
// empresas en el CRM).
const MISMA: Record<string, string> = { fyr: 'fyrsa', alemansilla: 'alejandramansilla', toallaseas: 'toallasseas', publios: 'publio' };
// Para comparar nombres: sin forma societaria, sin signos ni espacios («Articulos Promocionales S.A.» = «ARTICULOS PROMOCIONALES»).
export function claveProveedor(nombre: string) {
  const k = norm(nombre).replace(/[.,]/g, '').replace(/(\s(s ?r ?l|s ?a ?s|s ?a ?u|s ?a ?i ?c|s ?a ?c ?i ?f|s ?a|s ?h))+$/, '').replace(/[^a-z0-9]+/g, '');
  return MISMA[k] ?? k;
}
// El nombre de la empresa nueva: como está en ClickUp, sin espacios de más.
const nombreEmpresa = (s: string) => s.replace(/\s+/g, ' ').trim();
const RUBRO = { proveedor: 'articulos', impresor: 'impresion' } as const;

// Ata cada opción nueva a su empresa: la de otra opción con el mismo nombre, una empresa proveedora que ya está en el CRM
// o, si no, una nueva (tipo de relación «Proveedor»). Pocas por vez para no pasarse de consultas; sigue en la próxima.
export async function vincularOpciones(db: D1Database, ctx: Ctx, max = 10) {
  const pendientes = (await db.prepare('SELECT campo, option_id, nombre FROM produccion_opciones WHERE vinculada = 0 ORDER BY orden LIMIT ?').bind(max * 3)
    .all<{ campo: 'proveedor' | 'impresor'; option_id: string; nombre: string }>()).results;
  if (!pendientes.length) return { vinculadas: 0, creadas: 0 };
  const yaAtadas = (await db.prepare('SELECT nombre, company_id FROM produccion_opciones WHERE company_id IS NOT NULL').all<{ nombre: string; company_id: number }>()).results;
  const empresas = (await db.prepare(`SELECT id, name, props FROM records WHERE object_type = 'company' AND archived = 0
      AND json_extract(props, '$.tipo_de_relacion') IN ('proveedor', 'equipo')`).all<{ id: number; name: string; props: string }>()).results;
  const porClave = new Map<string, number>();
  for (const e of empresas) porClave.set(claveProveedor(e.name), e.id);
  for (const o of yaAtadas) porClave.set(claveProveedor(o.nombre), o.company_id);
  const rubros = new Map(empresas.map((e) => [e.id, String(JSON.parse(e.props).proveedor_de ?? '').split(';').filter(Boolean)]));
  let creadas = 0, vinculadas = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const o of pendientes) {
    const k = claveProveedor(o.nombre);
    let company: number | null = null;
    if (k && !NO_EMPRESA.includes(k)) {
      company = porClave.get(k) ?? null;
      if (!company) {
        if (creadas >= max) continue;
        const row = await createRecord(db, ctx, 'company', { name: nombreEmpresa(o.nombre), tipo_de_relacion: 'proveedor', proveedor_de: RUBRO[o.campo] },
          { system: true, strict: false, skipDedupe: true });
        company = row.id;
        porClave.set(k, company);
        rubros.set(company, [RUBRO[o.campo]]);
        creadas++;
      } else {
        const tiene = rubros.get(company) ?? [];
        if (!tiene.includes(RUBRO[o.campo])) {
          const nuevo = [...tiene, RUBRO[o.campo]];
          await updateRecord(db, ctx, 'company', company, { proveedor_de: nuevo.join(';') }, { system: true, strict: false }).catch(() => undefined);
          rubros.set(company, nuevo);
        }
      }
    }
    stmts.push(db.prepare('UPDATE produccion_opciones SET company_id = ?, vinculada = 1 WHERE campo = ? AND option_id = ?').bind(company, o.campo, o.option_id));
    vinculadas++;
  }
  if (stmts.length) await db.batch(stmts);
  return { vinculadas, creadas };
}

// Si se combinan dos empresas proveedoras en el CRM, sus opciones pasan a la que queda.
export async function opcionesAEmpresa(db: D1Database, de: number[], a: number) {
  await db.prepare('UPDATE produccion_opciones SET company_id = ? WHERE company_id IN (SELECT value FROM json_each(?))').bind(a, JSON.stringify(de)).run();
}

// ---------- El proveedor por el SKU ----------

// Pedido de Rodrigo del 13/11/2026: si un artículo no tiene PROVEEDOR en ClickUp y su SKU empieza con el prefijo de un
// importador, se le pone ese. `claves`: cómo puede llamarse en el desplegable de ClickUp o su empresa en el CRM, como las
// compara claveProveedor (los mismos nombres que web/src/proveedores.tsx).
export const PROVEEDOR_POR_SKU: Record<string, { nombre: string; claves: string[] }> = {
  ZEC: { nombre: 'Zecat', claves: ['zecat', 'articulospromocionales'] },
  IMP: { nombre: 'Promoproductos', claves: ['promoproductos', 'improm'] },
  CDO: { nombre: 'Stocksur', claves: ['stocksur', 'cdo', 'cdostocksur', 'stocksurcdo'] },
  ZOM: { nombre: 'Irion', claves: ['irion', 'zom', 'irionzom'] },
  NFM: { nombre: 'Nuevas Formas', claves: ['nuevasformas', 'eneformas'] },
  XTR: { nombre: 'X-Trade', claves: ['xtrade', 'xtradeonline'] },
  MYA: { nombre: 'Maya', claves: ['maya'] },
};
export const prefijoSku = (sku: string | null | undefined) => {
  const s = String(sku ?? '').trim().toUpperCase();
  return Object.keys(PROVEEDOR_POR_SKU).find((p) => s.startsWith(p)) ?? null;
};
// La opción del desplegable PROVEEDOR de cada prefijo: la primera con ese nombre o, si no, la primera atada a esa empresa.
// Igual o, si la clave es larga, que empiece así («STOCKSUR SOCIEDAD ANONIMA», «XTRADEONLINE»).
async function opcionesPorPrefijo(db: D1Database) {
  const ops = (await db.prepare(`SELECT o.option_id, o.nombre, r.name AS empresa FROM produccion_opciones o
      LEFT JOIN records r ON r.id = o.company_id AND r.archived = 0 WHERE o.campo = 'proveedor' ORDER BY o.orden`)
    .all<{ option_id: string; nombre: string; empresa: string | null }>()).results;
  const out = new Map<string, string>();
  for (const [pre, m] of Object.entries(PROVEEDOR_POR_SKU)) {
    const es = (n: string | null) => {
      const k = n ? claveProveedor(n) : '';
      return !!k && m.claves.some((c) => k === c || (c.length >= 5 && k.startsWith(c)));
    };
    const o = ops.find((x) => es(x.nombre)) ?? ops.find((x) => es(x.empresa));
    if (o) out.set(pre, o.option_id);
  }
  return out;
}

// En cada sincronización de ClickUp, de a pocos (cada uno es una escritura en ClickUp): los artículos abiertos de las
// unidades que se trabajan desde el CRM, sin proveedor y que el CRM todavía no completó. El SKU es el de la subtarea
// («Código:») o, si no lo tiene, el del renglón del pedido atado a ese artículo. Se escribe en ClickUp, así se ve igual
// en los dos lados; lo que eligió una persona no se toca, y si después lo cambian o lo vacían, el CRM no lo vuelve a
// poner. Si el desplegable no tiene opción para ese importador, no se hace nada. `reserva`: consultas que deja libres.
export async function completarProveedores(env: Env, b: Budget, opts: { max?: number; reserva?: number } = {}) {
  const db = env.DB;
  const max = opts.max ?? 5, reserva = opts.reserva ?? 0;
  if (!env.CLICKUP_TOKEN || b.left() <= reserva) return { completados: 0 };
  const { unidades } = await produccionConfig(db);
  const candidatos = (await db.prepare(`SELECT task_id, sku FROM (
      SELECT a.task_id, a.actualizado, COALESCE(a.codigo,
          (SELECT TRIM(li.code) FROM line_items li WHERE li.clickup_task = a.task_id AND TRIM(COALESCE(li.code, '')) != '' LIMIT 1)) AS sku
        FROM produccion a LEFT JOIN produccion p ON p.task_id = a.pdv_task
        WHERE a.es_pdv = 0 AND a.proveedor IS NULL AND a.proveedor_auto IS NULL AND a.estado NOT IN (SELECT value FROM json_each(?1))
          AND COALESCE(p.unidad, a.unidad, '') IN (SELECT value FROM json_each(?2)))
      WHERE UPPER(SUBSTR(sku, 1, 3)) IN (SELECT value FROM json_each(?3)) ORDER BY actualizado DESC LIMIT 100`)
    .bind(JSON.stringify(CERRADOS), JSON.stringify(unidades), JSON.stringify(Object.keys(PROVEEDOR_POR_SKU)))
    .all<{ task_id: string; sku: string }>()).results;
  if (!candidatos.length) return { completados: 0 };
  const porPrefijo = await opcionesPorPrefijo(db);
  let completados = 0, intentos = 0;
  for (const c of candidatos) {
    const op = porPrefijo.get(prefijoSku(c.sku) ?? '');
    if (!op) continue;
    if (intentos >= max || b.left() <= reserva) break;
    intentos++;
    b.take();
    try {
      await escribir(env, 'POST', `/task/${encodeURIComponent(c.task_id)}/field/${CAMPOS.proveedor.id}`, { value: op });
    } catch (e) {
      const msg = (e as Error).message;
      console.error('proveedor por SKU', c.task_id, msg);
      // Si ClickUp no lo acepta (la tarea ya no está, la opción tampoco), no se insiste; si fue un corte o el límite de
      // ClickUp, se reintenta en la próxima.
      if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) await db.prepare("UPDATE produccion SET proveedor_auto = 'error' WHERE task_id = ?").bind(c.task_id).run();
      continue;
    }
    await db.prepare('UPDATE produccion SET proveedor = COALESCE(proveedor, ?1), proveedor_auto = ?1 WHERE task_id = ?2').bind(op, c.task_id).run();
    completados++;
  }
  return { completados };
}

// ---------- Configuración: qué unidades se trabajan desde el CRM ----------

export interface ProduccionConfig { unidades: string[] }
export const UNIDADES_PEC = ['FORMAS SHOP', 'CORPORATE', 'NO ESTRÉS', 'MERCADO LIBRE'];
export async function produccionConfig(db: D1Database): Promise<ProduccionConfig> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'produccion'").first<{ value: string }>();
  try { const c = r ? JSON.parse(r.value) : null; if (c && Array.isArray(c.unidades)) return { unidades: c.unidades }; } catch { /* rota: la de siempre */ }
  return { unidades: ['FORMAS SHOP'] };
}
export async function guardarProduccionConfig(db: D1Database, cfg: ProduccionConfig) {
  const unidades = (cfg.unidades ?? []).map((u) => String(u).trim().toUpperCase()).filter((u) => UNIDADES_PEC.includes(u));
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('produccion', ?)").bind(JSON.stringify({ unidades })).run();
  return { unidades };
}
// Producción (el perfil) y los administradores editan; los de «Solo mira», no.
export const puedeEditarProduccion = (u: User) => u.role !== 'viewer' && (u.role === 'admin' || u.profile === 'produccion');

// El color de un estado como lo pinta ClickUp: hex, o uno de sus colores con nombre («var(--cu-status-red)», como
// «ingreso de pedido»). Si no se reconoce, el que tenía ese estado en la lista de noviembre de 2026.
const CU_COLORES: Record<string, string> = {
  red: '#d33d44', orange: '#f76808', yellow: '#ffc53d', green: '#008844', teal: '#0f9d9f', blue: '#1090e0', purple: '#7b68ee',
  pink: '#f708b4', gray: '#87909e', grey: '#87909e', black: '#2a2e34',
};
export function colorCu(color: string | null | undefined, status = '') {
  const c = String(color ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c;
  const nombre = c.match(/--cu-(?:status-)?([a-z]+)/i)?.[1]?.toLowerCase();
  return (nombre && CU_COLORES[nombre]) || ESTADOS_PEC.find((e) => e.status === status.toLowerCase())?.color || '#87909e';
}

export async function estadosPec(db: D1Database) {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'clickup_estados'").first<{ value: string }>();
  try { const e = r ? JSON.parse(r.value).estados : null; if (Array.isArray(e) && e.length) return e as typeof ESTADOS_PEC; } catch { /* los de siempre */ }
  return ESTADOS_PEC;
}
// Una vez por día, los estados de la lista (una consulta).
export async function leerEstados(env: Env, b: Budget) {
  const db = env.DB;
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'clickup_estados'").first<{ value: string }>();
  const at = r ? Number(JSON.parse(r.value).at) || 0 : 0;
  if (Date.now() - at < 86_400_000 || b.left() < 25) return;
  const l = await cu<{ statuses?: Array<{ status: string; color: string; type: string; orderindex?: number }> }>(env, `/list/${LIST}`, {}, b);
  const estados = (l.statuses ?? []).map((s) => ({ status: s.status.toLowerCase(), color: colorCu(s.color, s.status), type: s.type }));
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clickup_estados', ?)").bind(JSON.stringify({ at: Date.now(), estados: estados.length ? estados : ESTADOS_PEC })).run();
  // La gente del espacio de ClickUp (una consulta): así quien entra a Producción se puede asignar aunque todavía no
  // tenga nada asignado en ClickUp.
  if (b.left() < 25) return;
  try {
    const t = await cu<{ teams?: Array<{ members?: Array<{ user?: NonNullable<CuTask['assignees']>[number] }> }> }>(env, '/team', {}, b);
    const gente = (t.teams ?? []).flatMap((x) => x.members ?? []).map((m) => m.user).filter((u): u is NonNullable<typeof u> => !!u);
    await guardarPersonas(db, [{ assignees: gente } as CuTask]);
  } catch (e) {
    if (e instanceof OutOfBudget) throw e;
    console.error('produccion: gente de ClickUp', (e as Error).message);
  }
}

// ---------- La vista de Producción ----------

export type FilaDb = Fila & { record_id: number | null; proveedor_auto?: string | null;
  talle?: string | null; grupo_talle?: string | null; talles_v?: number };   // talles.ts (migración 0105)
export interface ArticuloVista {
  task_id: string; nombre: string; estado: string; cantidad: number | null; cantidad_controlada: number | null; cliente: string | null;
  proveedor: string | null; impresor: string | null; entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null;
  egreso_impresor: string | null; retiro_impresor: string | null; ingreso_impresor: string | null; vence: string | null; asignados: number[]; etiquetas: string[]; url: string | null;
  foto?: string | null;   // la foto del producto, la misma que en el pedido (fotosDeArticulos en productos.ts)
  logo?: string | null;   // cómo está el logo del producto: ok, textos, no_vectorial, sin_verificar o falta (logos.ts)
  proveedor_sku: string | null;   // el SKU, si el proveedor lo puso el CRM por el SKU y sigue ese (completarProveedores)
  sku?: string | null;             // el SKU del artículo, si puede llevar notas de producto (no los genéricos)
  notas?: ResumenNotas | null;     // las notas vigentes de ese SKU (notasproducto.ts)
  costo_logo?: CostoLogo | null;   // lo que se tomó para el logo en la cotización del STP, por unidad (costoslogo.ts)
  oc?: OcRef[];                    // sus órdenes de compra de Finnegans (ordenescompra.ts)
  talle?: string | null;           // su talle, si es una prenda con talles (talles.ts)
  grupo?: string | null;           // los talles del mismo producto comparten esta clave (vienen juntos, en el orden de los talles)
}
// Un producto con talles: el nombre sin el talle y lo que se tomó para el logo del producto entero (con el setup una sola
// vez, aunque el STP lo prorratee en cada talle).
export interface GrupoVista { nombre: string; costo_logo: CostoLogoTalles | null }
export interface PdvVista extends ArticuloVista {
  npdv: string | null; unidad: string | null; vendedor: string | null; record_id: number | null; pedido: string | null; owner_id: number | null;
  entrega_prometida: string | null; etapa: string | null; etapa_auto: boolean; listos: number; total: number; editable: boolean;
  asignados_todos: number[]; articulos: ArticuloVista[];
  ocs?: OcRef[];   // todas las órdenes de compra del pedido (también las que no se pudieron atar a un producto)
  creado: string | null;   // fecha de creación del PDV, AAAA-MM-DD (SELECT_PDV)
  grupos: Record<string, GrupoVista>;   // los productos con talles de sus artículos, por la clave del grupo
}

export const lista = (s: string | null | undefined) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const articulo = (f: FilaDb): ArticuloVista => ({
  task_id: f.task_id, nombre: f.nombre, estado: f.estado, cantidad: f.cantidad, cantidad_controlada: f.cantidad_controlada, cliente: f.cliente,
  proveedor: f.proveedor, impresor: f.impresor, entrega_real: f.entrega_real, ingreso_proveedor: f.ingreso_proveedor, retiro_proveedor: f.retiro_proveedor,
  egreso_impresor: f.egreso_impresor, retiro_impresor: f.retiro_impresor, ingreso_impresor: f.ingreso_impresor, vence: f.vence, asignados: lista(f.asignados).map(Number), etiquetas: lista(f.etiquetas).map(String),
  url: f.url, proveedor_sku: f.proveedor && f.proveedor === f.proveedor_auto ? f.codigo : null, talle: f.talle ?? null, grupo: f.grupo_talle ?? null,
});

// Cuántos productos tiene y cuántos están listos: un producto con talles es uno solo, listo cuando lo están todos sus talles.
export function contarProductos(arts: Array<{ task_id: string; pdv_task?: string; grupo_talle?: string | null; estado: string }>) {
  const productos = new Map<string, boolean>();
  for (const a of arts) {
    const k = a.grupo_talle ? `${a.pdv_task ?? ''}|${a.grupo_talle}` : a.task_id;
    productos.set(k, (productos.get(k) ?? true) && LISTOS.includes(a.estado));
  }
  return { total: productos.size, listos: [...productos.values()].filter(Boolean).length };
}

// Los artículos en el orden del PDV, con los talles de cada producto juntos (donde va el primero) y en el orden de los
// talles (XS S M L XL…).
function ordenarArticulos<T extends FilaDb>(arts: T[]) {
  const pos = new Map<string, number>();
  for (const a of arts) if (a.grupo_talle) pos.set(a.grupo_talle, Math.min(pos.get(a.grupo_talle) ?? Infinity, a.orden));
  const p = (a: T) => (a.grupo_talle ? pos.get(a.grupo_talle)! : a.orden);
  return [...arts].sort((a, b) => p(a) - p(b) || (a.grupo_talle ?? '').localeCompare(b.grupo_talle ?? '')
    || compararTalles(talleCanonico(a.talle), talleCanonico(b.talle)) || a.orden - b.orden || a.nombre.localeCompare(b.nombre));
}

// El estado del PDV: el de la combinación de sus artículos (como el estado del pedido). Si la producción todavía no
// arrancó, el que tiene el pedido (lo que puso la vendedora).
export function etapaPdv(pdvEstado: string, estados: string[], etapaPedido: string | null) {
  const auto = CERRADOS.slice(1).includes(pdvEstado) ? STAGE.anulado : generalStage(estados.length ? estados : [pdvEstado]);
  return { etapa: auto ?? etapaPedido ?? null, auto: !!auto };
}

type FilaPdv = FilaDb & { pedido: string | null; owner_id: number | null; etapa_pedido: string | null; entrega_prometida: string | null; creado_pdv: string | null };
function armarPdv(p: FilaPdv, arts: FilaDb[], editables: string[], verCerrados: boolean,
  fotos: Map<string, string>, logos: Map<string, string> = new Map(), servicios: Set<string> = new Set(), notas: NotasArt = { skus: new Map(), resumen: new Map() },
  costos: Map<string, CostoLogo> = new Map(), ocs: Awaited<ReturnType<typeof ocsDePedidos>> = new Map()): PdvVista {
  // Los artículos que son un servicio (envío, setup, un adicional: servicios.ts) no se producen: no se listan, no cuentan
  // y no pesan en el estado del PDV.
  arts = arts.filter((a) => !servicios.has(a.task_id));
  const vivos = arts.filter((a) => !CERRADOS.slice(1).includes(a.estado));
  const { etapa, auto } = etapaPdv(p.estado, arts.map((a) => a.estado), p.etapa_pedido);
  const visibles = verCerrados ? arts : arts.filter((a) => !CERRADOS.includes(a.estado));
  // El pedido espera el anticipo y la producción no arrancó: lo que sigue sin arrancar se ve «pendiente de anticipo».
  const anticipo = !auto && p.etapa_pedido === ORDER_ANTICIPO;
  const ver = (e: string) => (anticipo && SIN_ARRANCAR.includes(e) ? PENDIENTE_ANTICIPO : e);
  const todos = new Set<number>(lista(p.asignados).map(Number));
  for (const a of vivos) for (const x of lista(a.asignados)) todos.add(Number(x));
  const { listos, total } = contarProductos(vivos);
  // Cada producto con talles: su nombre sin el talle y el costo del logo del producto entero.
  const grupos: Record<string, GrupoVista> = {};
  for (const a of ordenarArticulos(arts)) {
    if (!a.grupo_talle || grupos[a.grupo_talle]) continue;
    const suyos = arts.filter((x) => x.grupo_talle === a.grupo_talle);
    grupos[a.grupo_talle] = { nombre: nombreSinTalle(a.nombre), costo_logo: costoLogoDeGrupo(suyos.map((x) => costos.get(x.task_id)), suyos.map((x) => x.cantidad)) };
  }
  return {
    ...articulo(p), estado: ver(p.estado), npdv: p.npdv, unidad: p.unidad, vendedor: p.vendedor, record_id: p.record_id, pedido: p.pedido, owner_id: p.owner_id,
    entrega_prometida: p.entrega_prometida, creado: p.creado_pdv, etapa, etapa_auto: auto, editable: editables.includes(p.unidad ?? ''),
    listos, total, asignados_todos: [...todos], grupos,
    articulos: ordenarArticulos(visibles).map((a) => ({ ...articulo(a), estado: ver(a.estado), foto: fotos.get(a.task_id) ?? null,
      // El aviso del logo, solo mientras falta producirlo (ya listo, entregado o anulado no importa).
      logo: LISTOS.includes(a.estado) || CERRADOS.includes(a.estado) ? null : logos.get(a.task_id) ?? null, ...notasDe(notas, a.task_id),
      costo_logo: costos.get(a.task_id) ?? null, oc: ocsDeCodigo(ocs.get(p.record_id ?? -1), notas.skus.get(a.task_id)) })),
    ocs: sinCodigos(ocs.get(p.record_id ?? -1)),
  };
}

// El SKU de cada artículo y las notas de producto de esos SKU (notasproducto.ts).
interface NotasArt { skus: Map<string, string>; resumen: Map<string, ResumenNotas> }
// El costo del logo de cada artículo, con el SKU que ya se buscó para las notas.
const costosDe = (db: D1Database, arts: Array<FilaDb & { record_id: number | null }>, n: NotasArt) => costosLogoDeArticulos(db, arts, n.skus);
async function notasDeArticulos(db: D1Database, arts: FilaDb[]): Promise<NotasArt> {
  const skus = await skusDeArticulos(db, arts);
  // Con la raíz de cada talle (talles.ts): las notas de una prenda valen para todos sus talles.
  return { skus, resumen: await resumenNotas(db, arts.map((a) => ({ sku: skus.get(a.task_id), raiz: raizTalle(skus.get(a.task_id), a.talle, a.grupo_talle) }))) };
}
function notasDe(n: NotasArt, taskId: string) {
  const sku = n.skus.get(taskId);
  return admiteNotas(sku) ? { sku, notas: n.resumen.get(sku!) ?? null } : { sku: null, notas: null };
}

// La fecha de creación del PDV: la del pedido de venta en Finnegans (fecha_pedido, la misma de Inicio de Producción); si
// todavía no la tiene, el alta de la tarea en ClickUp y, si el pedido no vino de ClickUp (que se dieron de alta todos
// juntos el 2/11/2026), su alta en el CRM.
const SELECT_PDV = `SELECT p.*, r.name AS pedido, r.owner_id, json_extract(r.props, '$.hs_pipeline_stage') AS etapa_pedido,
    json_extract(r.props, '$.fecha_de_entrega') AS entrega_prometida,
    COALESCE(json_extract(r.props, '$.fecha_pedido'), p.creado, CASE WHEN r.source NOT LIKE 'clickup%' THEN substr(r.created_at, 1, 10) END) AS creado_pdv
  FROM produccion p LEFT JOIN records r ON r.id = p.record_id AND r.archived = 0`;

export async function vistaProduccion(db: D1Database, user: User, q: { unidades?: string[]; cerrados?: boolean }) {
  const cfg = await produccionConfig(db);
  const unidades = q.unidades?.length ? q.unidades.map((u) => u.toUpperCase()) : cfg.unidades;
  const desde = Date.now() - 30 * 86_400_000;
  // Los PDV abiertos (con algún artículo que no está entregado ni anulado); con «ver entregados», también los de los
  // últimos 30 días. Si el pedido del CRM se borró, el PDV no se ve (aunque la tarea siga en ClickUp); si se restaura, vuelve.
  const pdvs = (await db.prepare(`${SELECT_PDV} WHERE p.es_pdv = 1 AND COALESCE(p.unidad, '') IN (SELECT value FROM json_each(?1))
      AND NOT EXISTS (SELECT 1 FROM records x WHERE x.id = p.record_id AND x.archived = 1)
      AND (EXISTS (SELECT 1 FROM produccion a WHERE a.pdv_task = p.task_id AND a.es_pdv = 0 AND a.estado NOT IN ('entregados', 'anulado'))
        OR (NOT EXISTS (SELECT 1 FROM produccion a WHERE a.pdv_task = p.task_id AND a.es_pdv = 0) AND p.estado NOT IN ('entregados', 'anulado'))
        OR (?2 = 1 AND p.actualizado > ?3))`)
    .bind(JSON.stringify(unidades), q.cerrados ? 1 : 0, desde).all<FilaPdv>()).results;
  // Los PDV que todavía no tienen los talles calculados (o con reglas viejas): antes de mostrarlos (tallesdb.ts).
  const viejos = pdvs.filter((p) => (p.talles_v ?? 0) < TALLES_VERSION).map((p) => p.task_id);
  if (viejos.length) await recalcularTallesPdvs(db, viejos);
  const arts = pdvs.length ? (await db.prepare('SELECT * FROM produccion WHERE es_pdv = 0 AND pdv_task IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(pdvs.map((p) => p.task_id))).all<FilaDb>()).results : [];
  const dePdv = new Map<string, FilaDb[]>();
  for (const a of arts) { const l = dePdv.get(a.pdv_task) ?? []; l.push(a); dePdv.set(a.pdv_task, l); }
  const pedidoDe = new Map(pdvs.map((p) => [p.task_id, p.record_id]));
  const conPedido = arts.map((a) => ({ ...a, record_id: a.record_id ?? pedidoDe.get(a.pdv_task) ?? null }));
  const [fotos, logos, servicios, notas] = await Promise.all([fotosDeArticulos(db, conPedido), logosDeArticulos(db, conPedido), tareasServicio(db, pdvs.map((p) => p.record_id)),
    notasDeArticulos(db, arts)]);
  const [costos, ocs] = await Promise.all([costosDe(db, conPedido, notas), ocsDePedidos(db, pdvs.map((p) => p.record_id))]);
  // Un PDV al que solo le queda abierto un servicio (o que es todo servicios) no tiene nada para producir: no se ve.
  const conTrabajo = (p: FilaDb) => {
    const suyos = dePdv.get(p.task_id) ?? [];
    if (q.cerrados || !suyos.some((a) => servicios.has(a.task_id))) return true;
    return suyos.some((a) => !servicios.has(a.task_id) && !CERRADOS.includes(a.estado));
  };
  const out = pdvs.filter(conTrabajo).map((p) => armarPdv(p, dePdv.get(p.task_id) ?? [], cfg.unidades, !!q.cerrados, fotos, logos, servicios, notas, costos, ocs))
    .sort((a, b) => (a.entrega_real ?? a.entrega_prometida ?? '9999').localeCompare(b.entrega_real ?? b.entrega_prometida ?? '9999') || Number(a.npdv) - Number(b.npdv));
  return { pdvs: out, ...(await referencias(db)), config: cfg, unidades, puede_editar: puedeEditarProduccion(user) };
}

// A quién se le asigna en Producción (pedido de Rodrigo del 17/11/2026): a las usuarias con perfil Producción que
// tienen usuario en ClickUp (Ceci, Sole y quien entre después). Sobre `u`, el usuario del CRM de la persona de ClickUp.
const ES_PRODUCCION_SQL = "u.id IS NOT NULL AND u.active = 1 AND u.profile = 'produccion' AND u.role != 'viewer'";
async function personasProduccion(db: D1Database) {
  const { results } = await db.prepare(`SELECT cp.clickup_id FROM clickup_personas cp JOIN users u ON u.id = cp.user_id AND u.deleted_at IS NULL WHERE ${ES_PRODUCCION_SQL}`)
    .all<{ clickup_id: number }>();
  return new Set(results.map((r) => r.clickup_id));
}

// Lo que necesita la pantalla para mostrar las filas: la gente de ClickUp, las opciones de los desplegables (con su
// empresa) y los estados.
export async function referencias(db: D1Database) {
  const [personas, opciones] = await db.batch([
    db.prepare(`SELECT cp.clickup_id, COALESCE(u.name, cp.nombre) AS nombre, cp.user_id, COALESCE(u.photo_url, cp.foto) AS foto, cp.iniciales, cp.color,
        CASE WHEN ${ES_PRODUCCION_SQL} THEN 1 ELSE 0 END AS produccion
      FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id AND u.deleted_at IS NULL ORDER BY nombre`),
    db.prepare(`SELECT o.campo, o.option_id, o.nombre, o.color, o.orden, o.company_id, r.name AS empresa
      FROM produccion_opciones o LEFT JOIN records r ON r.id = o.company_id AND r.archived = 0 ORDER BY o.campo, o.orden`),
  ]);
  return { personas: personas.results, opciones: opciones.results, estados: conAnticipo(await estadosPec(db)) };
}

async function pdvVista(db: D1Database, pdvTask: string) {
  const cfg = await produccionConfig(db);
  const p = await db.prepare(`${SELECT_PDV} WHERE p.task_id = ?`).bind(pdvTask)
    .first<FilaPdv>();
  if (!p) return null;
  if ((p.talles_v ?? 0) < TALLES_VERSION) await recalcularTallesPdvs(db, [pdvTask]);
  const arts = (await db.prepare('SELECT * FROM produccion WHERE es_pdv = 0 AND pdv_task = ?').bind(pdvTask).all<FilaDb>()).results;
  const conPedido = arts.map((a) => ({ ...a, record_id: a.record_id ?? p.record_id }));
  const [fotos, logos, servicios, notas] = await Promise.all([fotosDeArticulos(db, conPedido), logosDeArticulos(db, conPedido), tareasServicio(db, [p.record_id]),
    notasDeArticulos(db, arts)]);
  return armarPdv(p, arts, cfg.unidades, false, fotos, logos, servicios, notas, await costosDe(db, conPedido, notas), await ocsDePedidos(db, [p.record_id]));
}

// ---------- Editar: se escribe en ClickUp y después en el CRM ----------

async function escribir(env: Env, method: string, path: string, body?: unknown) {
  if (!env.CLICKUP_TOKEN) throw new HttpError(503, 'Falta conectar ClickUp (CLICKUP_TOKEN).');
  const res = await fetch(API(env) + path, {
    method, headers: { Authorization: env.CLICKUP_TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const det = ((await res.json().catch(() => null)) as { err?: string } | null)?.err;
    throw new HttpError(502, `ClickUp no aceptó el cambio (HTTP ${res.status}${det ? `: ${det}` : ''}). No se cambió nada.`);
  }
}

// `libre`: desde el cronograma (cronograma.ts), que ya controló quién puede y vale para todas las unidades: Logística
// mueve fechas y marca lo hecho también en los PDV que producción sigue trabajando en ClickUp. `sinRefrescar`: quien
// llama relee el PDV una sola vez al final.
export async function editarProduccion(env: Env, ctx: Ctx, taskId: string, campo: string, valor: unknown, opts: { libre?: boolean; sinRefrescar?: boolean } = {}) {
  const db = env.DB;
  if (!opts.libre && !puedeEditarProduccion(ctx.user)) throw new HttpError(403, 'Producción la editan las usuarias con perfil Producción y los administradores.');
  if (!(EDITABLES as readonly string[]).includes(campo)) throw new HttpError(400, `No se puede editar «${campo}» desde el CRM.`);
  const fila = await db.prepare('SELECT * FROM produccion WHERE task_id = ?').bind(taskId).first<FilaDb>();
  if (!fila) throw new HttpError(404, 'No está esa tarea de producción (puede que la hayan borrado en ClickUp).');
  const pdv = fila.es_pdv ? fila : await db.prepare('SELECT * FROM produccion WHERE task_id = ?').bind(fila.pdv_task).first<FilaDb>();
  const cfg = await produccionConfig(db);
  // Reasignar se puede en todas las unidades (pedido de Rodrigo del 17/11/2026); el resto, solo en las que se editan acá.
  if (!opts.libre && campo !== 'asignados' && !cfg.unidades.includes(pdv?.unidad ?? fila.unidad ?? '')) {
    throw new HttpError(409, `Los PDV de ${pdv?.unidad ?? fila.unidad ?? 'esta unidad'} todavía se trabajan en ClickUp. Desde el CRM se editan: ${cfg.unidades.join(', ') || 'ninguna unidad'}.`);
  }
  const c = campo as Editable;
  const path = `/task/${encodeURIComponent(taskId)}`;
  let local: Record<string, unknown> = {};
  if (c === 'estado') {
    const v = String(valor ?? '').toLowerCase().trim();
    if (v === PENDIENTE_ANTICIPO) throw new HttpError(400, '«Pendiente de anticipo» no se elige: sale del pedido, mientras está en «$ Pendiente de Anticipo».');
    const estados = await estadosPec(db);
    if (!estados.some((e) => e.status === v)) throw new HttpError(400, `«${valor}» no es un estado de la lista de producción.`);
    await escribir(env, 'PUT', path, { status: v });
    local = { estado: v };
  } else if (c === 'asignados') {
    const nuevos = [...new Set((Array.isArray(valor) ? valor : []).map(Number).filter(Number.isFinite))];
    const conocidos = new Set((await db.prepare('SELECT clickup_id FROM clickup_personas').all<{ clickup_id: number }>()).results.map((p) => p.clickup_id));
    const raro = nuevos.find((n) => !conocidos.has(n));
    if (raro != null) throw new HttpError(400, 'Esa persona no está en ClickUp.');
    const antes = lista(fila.asignados).map(Number);
    // Se suma solo a quien tiene perfil Producción (los que ya estaban se pueden dejar o sacar). Si todavía no hay nadie
    // de Producción con usuario de ClickUp, vale cualquiera de ClickUp, como antes.
    const prod = await personasProduccion(db);
    if (prod.size && nuevos.some((n) => !antes.includes(n) && !prod.has(n))) {
      throw new HttpError(400, 'Los pedidos se asignan a quienes tienen perfil Producción.');
    }
    const add = nuevos.filter((n) => !antes.includes(n));
    const rem = antes.filter((n) => !nuevos.includes(n));
    if (add.length || rem.length) await escribir(env, 'PUT', path, { assignees: { add, rem } });
    local = { asignados: JSON.stringify(nuevos) };
    // Reasignar el PDV pasa también sus artículos abiertos a las mismas personas (sin los servicios, que no se producen).
    // Cada artículo se puede cambiar aparte después.
    if (fila.es_pdv) await reasignarArticulos(env, fila, nuevos);
  } else if ((FECHAS as readonly string[]).includes(c)) {
    const v = valor == null ? '' : String(valor).slice(0, 10);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'La fecha tiene que ser AAAA-MM-DD.');
    const campoCu = CAMPOS[c as (typeof FECHAS)[number]].id;
    if (v) await escribir(env, 'POST', `${path}/field/${campoCu}`, { value: msDe(v), value_options: { time: false } });
    else await escribir(env, 'DELETE', `${path}/field/${campoCu}`);
    local = { [c]: v || null };
  } else if (c === 'proveedor' || c === 'impresor') {
    const v = valor == null ? '' : String(valor);
    if (v && !(await db.prepare('SELECT 1 FROM produccion_opciones WHERE campo = ? AND option_id = ?').bind(c, v).first())) {
      throw new HttpError(400, `Esa opción no está en el desplegable ${CAMPOS[c].nombre} de ClickUp.`);
    }
    if (v) await escribir(env, 'POST', `${path}/field/${CAMPOS[c].id}`, { value: v });
    else await escribir(env, 'DELETE', `${path}/field/${CAMPOS[c].id}`);
    local = { [c]: v || null };
  } else if (c === 'cantidad_controlada') {
    const v = valor == null || valor === '' ? null : Number(valor);
    if (v != null && !Number.isFinite(v)) throw new HttpError(400, 'La cantidad tiene que ser un número.');
    if (v != null) await escribir(env, 'POST', `${path}/field/${CAMPOS.cantidad_controlada.id}`, { value: v });
    else await escribir(env, 'DELETE', `${path}/field/${CAMPOS.cantidad_controlada.id}`);
    local = { cantidad_controlada: v };
  }
  const cols = Object.keys(local);
  await db.prepare(`UPDATE produccion SET ${cols.map((k) => `${k} = ?`).join(', ')}, leido_at = ? WHERE task_id = ?`).bind(...cols.map((k) => local[k] ?? null), now(), taskId).run();
  // El cambio de estado, en la conversación del pedido, a nombre de quien lo hizo.
  if (c === 'estado' && fila.record_id && local.estado !== fila.estado) {
    // Si lo hizo otro por el usuario (el chofer, desde su app: ctx.actor), queda a nombre de quien lo hizo y con su origen
    // («chofer»: en la conversación se lee «Gabriel (app del chofer)»).
    await db.prepare(`INSERT INTO produccion_cambios (record_id, task_id, articulo, es_pdv, campo, antes, despues, user_id, actor, source) VALUES (?, ?, ?, ?, 'estado', ?, ?, ?, ?, ?)`)
      .bind(fila.record_id, taskId, fila.nombre, fila.es_pdv, fila.estado, local.estado, ctx.actor ? ctx.actor.userId : ctx.user.id, ctx.actor && !ctx.actor.userId ? ctx.actor.name : null,
        ctx.actor?.via ?? 'crm').run();
  }
  // El estado (o la fecha real de entrega) del PDV cambia el pedido: se relee el PDV y se actualiza ya, sin esperar la
  // sincronización. Si falla, queda para la próxima corrida.
  if (!opts.sinRefrescar && (c === 'estado' || (c === 'entrega_real' && fila.es_pdv))) {
    await refrescarPdv(env, ctx, fila.pdv_task).catch((e) => console.error('produccion: refrescar', fila.pdv_task, (e as Error).message));
  }
  return pdvVista(db, fila.pdv_task);
}

// Un producto con talles (talles.ts) se edita entero, desde su renglón: el mismo cambio en cada talle (cada uno es su
// subtarea en ClickUp, se escriben a la vez). Si ClickUp no acepta alguno, los otros quedan cambiados y se avisa cuántos
// no; la pantalla muestra cómo quedó. Después, cada talle se puede cambiar aparte desde la rama.
export async function editarProduccionGrupo(env: Env, ctx: Ctx, tareas: unknown, campo: string, valor: unknown) {
  const db = env.DB;
  const ids = [...new Set((Array.isArray(tareas) ? tareas : []).map((t) => String(t ?? '').trim()).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Faltan los talles del producto.');
  if (ids.length > 40) throw new HttpError(400, 'Son demasiados artículos juntos.');
  const filas = (await db.prepare('SELECT task_id, pdv_task, es_pdv FROM produccion WHERE task_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids))
    .all<{ task_id: string; pdv_task: string; es_pdv: number }>()).results;
  if (filas.length !== ids.length) throw new HttpError(404, 'Algún talle ya no está en ClickUp: actualizá la pantalla.');
  const pdvTask = filas[0].pdv_task;
  if (filas.some((f) => f.es_pdv || f.pdv_task !== pdvTask)) throw new HttpError(400, 'Los talles tienen que ser artículos del mismo PDV.');
  const res = await Promise.allSettled(ids.map((id) => editarProduccion(env, ctx, id, campo, valor, { sinRefrescar: true })));
  const fallas = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  // Si no se pudo ninguno (sin permiso, otra unidad, un valor que no va), el mismo error que con uno solo.
  if (fallas.length === ids.length) throw fallas[0].reason;
  if (campo === 'estado' || campo === 'entrega_real') await refrescarPdv(env, ctx, pdvTask).catch((e) => console.error('produccion: refrescar', pdvTask, (e as Error).message));
  const error = fallas.length
    ? `${fallas.length === 1 ? 'Un talle quedó' : `${fallas.length} talles quedaron`} como estaba${fallas.length === 1 ? '' : 'n'}: ${(fallas[0].reason as Error).message}`
    : null;
  return { pdv: await pdvVista(db, pdvTask), error };
}

// Los artículos abiertos del PDV, a las mismas personas que el PDV. Se escriben en ClickUp de a varios a la vez; los que
// ClickUp acepta quedan cambiados y, si alguno no, se avisa cuántos quedaron como estaban.
async function reasignarArticulos(env: Env, pdv: FilaDb, nuevos: number[]) {
  const db = env.DB;
  const arts = (await db.prepare('SELECT task_id, estado, asignados FROM produccion WHERE es_pdv = 0 AND pdv_task = ?').bind(pdv.task_id)
    .all<{ task_id: string; estado: string; asignados: string }>()).results;
  const servicios = await tareasServicio(db, [pdv.record_id]);
  const cambiar = arts.filter((a) => !CERRADOS.includes(a.estado) && !servicios.has(a.task_id)).map((a) => {
    const antes = lista(a.asignados).map(Number);
    return { task_id: a.task_id, add: nuevos.filter((n) => !antes.includes(n)), rem: antes.filter((n) => !nuevos.includes(n)) };
  }).filter((a) => a.add.length || a.rem.length);
  const res = await Promise.allSettled(cambiar.map((a) => escribir(env, 'PUT', `/task/${encodeURIComponent(a.task_id)}`, { assignees: { add: a.add, rem: a.rem } })));
  const ok = cambiar.filter((_, i) => res[i].status === 'fulfilled');
  if (ok.length) {
    await db.batch(ok.map((a) => db.prepare('UPDATE produccion SET asignados = ?, leido_at = ? WHERE task_id = ?').bind(JSON.stringify(nuevos), now(), a.task_id)));
  }
  const fallaron = cambiar.length - ok.length;
  if (fallaron) {
    // El PDV ya quedó reasignado: se guarda antes de avisar.
    await db.prepare('UPDATE produccion SET asignados = ?, leido_at = ? WHERE task_id = ?').bind(JSON.stringify(nuevos), now(), pdv.task_id).run();
    throw new HttpError(502, `El PDV quedó reasignado, pero ClickUp no aceptó el cambio en ${fallaron === 1 ? '1 artículo' : `${fallaron} artículos`}. Probá de nuevo o cambialos uno por uno.`);
  }
}

export async function refrescarPdv(env: Env, ctx: Ctx, pdvTask: string) {
  const b = Budget.of(env);
  const t = await cu<CuTask>(env, `/task/${encodeURIComponent(pdvTask)}`, { include_subtasks: 'true' }, b);
  await guardarTareas(env.DB, [t, ...(t.subtasks ?? []).map((s) => ({ ...s, parent: s.parent ?? t.id }))]);
  await upsertPdv(env, { ...ctx, source: 'clickup', sourceDetail: 'Producción (CRM)' }, t, null, b, ctx.actor ?? { name: ctx.user.name, userId: ctx.user.id });
}

// ---------- En otras pantallas ----------

// Lo que está en producción con un proveedor o impresor (la ficha de su empresa).
export async function produccionDeEmpresa(db: D1Database, companyId: number) {
  // Con el talle y la clave del producto (talles.ts): la ficha muestra una prenda en varios talles en un renglón.
  const { results } = await db.prepare(`SELECT a.task_id, a.nombre, a.estado, a.cantidad, a.proveedor, a.impresor, a.ingreso_proveedor, a.retiro_proveedor,
      a.talle, CASE WHEN a.grupo_talle IS NOT NULL THEN a.pdv_task || '|' || a.grupo_talle END AS grupo,
      a.egreso_impresor, a.retiro_impresor, a.ingreso_impresor, a.url, p.npdv, COALESCE(a.cliente, p.cliente) AS cliente, p.record_id, p.entrega_real,
      CASE WHEN op.company_id = ?1 THEN 'proveedor' ELSE 'impresor' END AS rol
    FROM produccion a JOIN produccion p ON p.task_id = a.pdv_task
      LEFT JOIN produccion_opciones op ON op.campo = 'proveedor' AND op.option_id = a.proveedor
      LEFT JOIN produccion_opciones oi ON oi.campo = 'impresor' AND oi.option_id = a.impresor
    WHERE a.es_pdv = 0 AND a.estado NOT IN ('entregados', 'anulado') AND (op.company_id = ?1 OR oi.company_id = ?1)
    ORDER BY COALESCE(p.entrega_real, '9999'), p.npdv LIMIT 200`).bind(companyId).all<{ nombre: string; grupo: string | null }>();
  return { articulos: results.map((a) => ({ ...a, producto: a.grupo ? nombreSinTalle(a.nombre) : null })), estados: await estadosPec(db) };
}

// Quién tiene asignado cada artículo del pedido y el PDV entero (los productos del pedido, en su ficha).
export interface Persona { id: number; nombre: string; user_id: number | null; foto: string | null }
export async function produccionDePedido(db: D1Database, recordId: number) {
  // Sin los artículos que son un servicio (servicios.ts): no cuentan en «2/3 listos».
  const { results } = await db.prepare(`SELECT p.task_id, p.pdv_task, p.es_pdv, p.estado, p.asignados, p.grupo_talle FROM produccion p WHERE p.record_id = ?1
      AND p.task_id NOT IN ${TAREAS_SERVICIO_SQL('?1')}`).bind(recordId)
    .all<{ task_id: string; pdv_task: string; es_pdv: number; estado: string; asignados: string; grupo_talle: string | null }>();
  if (!results.length) return null;
  const ids = [...new Set(results.flatMap((r) => lista(r.asignados).map(Number)))];
  const personas = ids.length ? (await db.prepare(`SELECT cp.clickup_id AS id, COALESCE(u.name, cp.nombre) AS nombre, cp.user_id, COALESCE(u.photo_url, cp.foto) AS foto
      FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id WHERE cp.clickup_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Persona>()).results : [];
  const de = (s: string) => lista(s).map((x) => personas.find((p) => p.id === Number(x))).filter((p): p is Persona => !!p);
  const pdv = results.find((r) => r.es_pdv);
  const arts = results.filter((r) => !r.es_pdv);
  const vivos = arts.filter((a) => !CERRADOS.slice(1).includes(a.estado));
  const todos = new Map<number, Persona>();
  for (const r of [...(pdv ? [pdv] : []), ...vivos.filter((a) => !CERRADOS.includes(a.estado))]) for (const p of de(r.asignados)) todos.set(p.id, p);
  // Un producto con talles cuenta una vez (talles.ts).
  return {
    asignados: [...todos.values()], ...contarProductos(vivos),
    porTarea: new Map(arts.map((a) => [a.task_id, de(a.asignados)])),
  };
}

// Un producto de Producción: el artículo o, si es un talle de una prenda, la prenda entera (talles.ts). Listo, si están
// listos todos sus talles.
export const PRODUCTO_SQL = (a: string) => `COALESCE(${a}.pdv_task || '|' || ${a}.grupo_talle, ${a}.task_id)`;
// Para la tarjeta del tablero de pedidos (productos.ts, adjuntosSql): quién lo tiene asignado en producción (el PDV y
// sus artículos abiertos) y cuántos artículos están listos. Los artículos que son un servicio no cuentan.
export const PRODUCCION_TARJETA_SQL = `,
      (SELECT json_group_array(json_object('id', cp.clickup_id, 'nombre', COALESCE(u.name, cp.nombre), 'user_id', cp.user_id, 'foto', COALESCE(u.photo_url, cp.foto)))
        FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id
        WHERE cp.clickup_id IN (SELECT j.value FROM produccion pr, json_each(pr.asignados) j
          WHERE pr.record_id = r.id AND (pr.es_pdv = 1 OR pr.estado NOT IN ('entregados', 'anulado')) AND pr.task_id NOT IN ${TAREAS_SERVICIO_SQL('r.id')})) AS prod_asignados,
      (SELECT COUNT(DISTINCT ${PRODUCTO_SQL('pr')}) FROM produccion pr WHERE pr.record_id = r.id AND pr.es_pdv = 0 AND pr.estado NOT IN ('anulado', 'anulada', 'cancelado')
        AND pr.task_id NOT IN ${TAREAS_SERVICIO_SQL('r.id')}) AS prod_total,
      (SELECT COUNT(DISTINCT ${PRODUCTO_SQL('pr')}) FROM produccion pr WHERE pr.record_id = r.id AND pr.es_pdv = 0 AND pr.estado NOT IN ('anulado', 'anulada', 'cancelado')
        AND pr.task_id NOT IN ${TAREAS_SERVICIO_SQL('r.id')})
      - (SELECT COUNT(DISTINCT ${PRODUCTO_SQL('pr')}) FROM produccion pr WHERE pr.record_id = r.id AND pr.es_pdv = 0 AND pr.estado NOT IN ('anulado', 'anulada', 'cancelado')
        AND pr.estado NOT IN ('listo para entergar', 'listo para entregar', 'entregados') AND pr.task_id NOT IN ${TAREAS_SERVICIO_SQL('r.id')}) AS prod_listos`;
