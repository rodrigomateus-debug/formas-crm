import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { Budget } from './budget';
import { createRecord, updateRecord } from './records';
import { API, cu, generalStage, LIST, norm, STAGE, upsertPdv, usuarioPorNombre, type CuTask } from './clickup';
import { fotosDeArticulos } from './productos';

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

// Los campos de la lista PEC que se ven y se editan (id del campo personalizado en ClickUp).
export const CAMPOS = {
  entrega_real: { id: '10e3d8d0-bbd5-47af-946b-504ef9804428', nombre: 'ENTREGAS (FECHA REAL)', tipo: 'date' },
  ingreso_proveedor: { id: '98df51eb-1142-4ff5-b80c-9fd239ea3aac', nombre: 'INGRESO (PROVEEDOR)', tipo: 'date' },
  retiro_proveedor: { id: '7fd568b7-9cfd-45fc-9f05-22864a0b9e9a', nombre: 'RETIROS (PROVEEDOR)', tipo: 'date' },
  egreso_impresor: { id: 'c278fabb-b558-4a28-a6f6-f6b26a8e29eb', nombre: 'EGRESO (IMPRESOR)', tipo: 'date' },
  retiro_impresor: { id: '3146d848-4952-4ac8-aac4-971e1361609b', nombre: 'RETIRO (IMPRESOR)', tipo: 'date' },
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
const FECHAS = ['entrega_real', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor'] as const;
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
const CERRADOS = ['entregados', 'anulado', 'anulada', 'cancelado'];
const LISTOS = ['listo para entergar', 'listo para entregar', 'entregados'];

// ---------- Lectura de las tareas de ClickUp ----------

interface Fila {
  task_id: string; pdv_task: string; es_pdv: number; nombre: string; npdv: string | null; estado: string;
  unidad: string | null; cliente: string | null; vendedor: string | null; cantidad: number | null; cantidad_controlada: number | null;
  proveedor: string | null; impresor: string | null; entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null;
  egreso_impresor: string | null; retiro_impresor: string | null; vence: string | null; asignados: string; etiquetas: string;
  orden: number; url: string | null; actualizado: number;
}

// Una fecha de ClickUp (ms) → AAAA-MM-DD en Buenos Aires.
const diaDe = (v: unknown) => {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return null;
  return new Date(n - 3 * 3600_000).toISOString().slice(0, 10);
};
// AAAA-MM-DD → ms para ClickUp: el mediodía de Buenos Aires, para que no cambie de día con el huso.
const msDe = (dia: string) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d, 15); };

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
    retiro_impresor: diaDe(campoDe(t, 'retiro_impresor')?.value), vence: diaDe(t.due_date),
    asignados: JSON.stringify((t.assignees ?? []).map((a) => a.id).filter((x) => x != null)),
    etiquetas: JSON.stringify((t.tags ?? []).map((x) => x.name).filter(Boolean)),
    orden: Number(t.orderindex ?? 0) || 0, url: t.url ?? null, actualizado: Number(t.date_updated ?? 0) || 0,
  };
}

const COLS = ['task_id', 'pdv_task', 'es_pdv', 'nombre', 'npdv', 'estado', 'unidad', 'cliente', 'vendedor', 'cantidad', 'cantidad_controlada', 'proveedor',
  'impresor', 'entrega_real', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor', 'vence', 'asignados', 'etiquetas', 'orden', 'url', 'actualizado'] as const;
// Sin los campos personalizados se actualiza solo lo que trae siempre la tarea.
const SIEMPRE = ['nombre', 'estado', 'vence', 'asignados', 'etiquetas', 'orden', 'url', 'actualizado'];

// Guarda las tareas que trajo ClickUp: los PDV (tareas de la lista con «PDV» en el nombre) y sus artículos (subtareas).
// Lo más viejo no pisa lo más nuevo. También guarda la gente asignada y las opciones de PROVEEDOR e IMPRESOR.
export async function guardarTareas(db: D1Database, tasks: CuTask[]) {
  const filas: Array<Fila & { campos: boolean }> = [];
  for (const t of tasks) {
    if (t.parent) filas.push(filaDe(t, t.parent));
    else if (/PDV/i.test(t.name ?? '')) filas.push(filaDe(t, t.id));
  }
  if (!filas.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const f of filas) {
    const set = (f.campos ? COLS.filter((c) => c !== 'task_id' && c !== 'pdv_task' && c !== 'es_pdv') : SIEMPRE).map((c) => `${c} = excluded.${c}`);
    stmts.push(db.prepare(`INSERT INTO produccion (${COLS.join(', ')}, record_id, leido_at) VALUES (${COLS.map(() => '?').join(', ')},
        (SELECT record_id FROM produccion WHERE task_id = ?), ?)
      ON CONFLICT(task_id) DO UPDATE SET ${set.join(', ')}, pdv_task = excluded.pdv_task, leido_at = excluded.leido_at
      WHERE excluded.actualizado >= produccion.actualizado`).bind(...COLS.map((c) => f[c] ?? null), f.pdv_task, now()));
  }
  await db.batch(stmts);
  await guardarPersonas(db, tasks);
  await guardarOpciones(db, tasks);
  await enlazarPedidos(db, [...new Set(filas.map((f) => f.pdv_task))]);
  return filas.length;
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
  await db.prepare('DELETE FROM produccion WHERE pdv_task = ? AND task_id NOT IN (SELECT value FROM json_each(?))').bind(pdvTask, JSON.stringify(ids)).run();
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
}

// ---------- La vista de Producción ----------

type FilaDb = Fila & { record_id: number | null };
export interface ArticuloVista {
  task_id: string; nombre: string; estado: string; cantidad: number | null; cantidad_controlada: number | null; cliente: string | null;
  proveedor: string | null; impresor: string | null; entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null;
  egreso_impresor: string | null; retiro_impresor: string | null; vence: string | null; asignados: number[]; etiquetas: string[]; url: string | null;
  foto?: string | null;   // la foto del producto, la misma que en el pedido (fotosDeArticulos en productos.ts)
}
export interface PdvVista extends ArticuloVista {
  npdv: string | null; unidad: string | null; vendedor: string | null; record_id: number | null; pedido: string | null; owner_id: number | null;
  entrega_prometida: string | null; etapa: string | null; etapa_auto: boolean; listos: number; total: number; editable: boolean;
  asignados_todos: number[]; articulos: ArticuloVista[];
}

const lista = (s: string | null | undefined) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const articulo = (f: FilaDb): ArticuloVista => ({
  task_id: f.task_id, nombre: f.nombre, estado: f.estado, cantidad: f.cantidad, cantidad_controlada: f.cantidad_controlada, cliente: f.cliente,
  proveedor: f.proveedor, impresor: f.impresor, entrega_real: f.entrega_real, ingreso_proveedor: f.ingreso_proveedor, retiro_proveedor: f.retiro_proveedor,
  egreso_impresor: f.egreso_impresor, retiro_impresor: f.retiro_impresor, vence: f.vence, asignados: lista(f.asignados).map(Number), etiquetas: lista(f.etiquetas).map(String),
  url: f.url,
});

// El estado del PDV: el de la combinación de sus artículos (como el estado del pedido). Si la producción todavía no
// arrancó, el que tiene el pedido (lo que puso la vendedora).
export function etapaPdv(pdvEstado: string, estados: string[], etapaPedido: string | null) {
  const auto = CERRADOS.slice(1).includes(pdvEstado) ? STAGE.anulado : generalStage(estados.length ? estados : [pdvEstado]);
  return { etapa: auto ?? etapaPedido ?? null, auto: !!auto };
}

function armarPdv(p: FilaDb & { pedido: string | null; owner_id: number | null; etapa_pedido: string | null; entrega_prometida: string | null }, arts: FilaDb[], editables: string[], verCerrados: boolean,
  fotos: Map<string, string>): PdvVista {
  const vivos = arts.filter((a) => !CERRADOS.slice(1).includes(a.estado));
  const { etapa, auto } = etapaPdv(p.estado, arts.map((a) => a.estado), p.etapa_pedido);
  const visibles = verCerrados ? arts : arts.filter((a) => !CERRADOS.includes(a.estado));
  const todos = new Set<number>(lista(p.asignados).map(Number));
  for (const a of vivos) for (const x of lista(a.asignados)) todos.add(Number(x));
  return {
    ...articulo(p), npdv: p.npdv, unidad: p.unidad, vendedor: p.vendedor, record_id: p.record_id, pedido: p.pedido, owner_id: p.owner_id,
    entrega_prometida: p.entrega_prometida, etapa, etapa_auto: auto, editable: editables.includes(p.unidad ?? ''),
    listos: vivos.filter((a) => LISTOS.includes(a.estado)).length, total: vivos.length, asignados_todos: [...todos],
    articulos: visibles.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)).map((a) => ({ ...articulo(a), foto: fotos.get(a.task_id) ?? null })),
  };
}

const SELECT_PDV = `SELECT p.*, r.name AS pedido, r.owner_id, json_extract(r.props, '$.hs_pipeline_stage') AS etapa_pedido,
    json_extract(r.props, '$.fecha_de_entrega') AS entrega_prometida
  FROM produccion p LEFT JOIN records r ON r.id = p.record_id AND r.archived = 0`;

export async function vistaProduccion(db: D1Database, user: User, q: { unidades?: string[]; cerrados?: boolean }) {
  const cfg = await produccionConfig(db);
  const unidades = q.unidades?.length ? q.unidades.map((u) => u.toUpperCase()) : cfg.unidades;
  const desde = Date.now() - 30 * 86_400_000;
  // Los PDV abiertos (con algún artículo que no está entregado ni anulado); con «ver entregados», también los de los
  // últimos 30 días.
  const pdvs = (await db.prepare(`${SELECT_PDV} WHERE p.es_pdv = 1 AND COALESCE(p.unidad, '') IN (SELECT value FROM json_each(?1))
      AND (EXISTS (SELECT 1 FROM produccion a WHERE a.pdv_task = p.task_id AND a.es_pdv = 0 AND a.estado NOT IN ('entregados', 'anulado'))
        OR (NOT EXISTS (SELECT 1 FROM produccion a WHERE a.pdv_task = p.task_id AND a.es_pdv = 0) AND p.estado NOT IN ('entregados', 'anulado'))
        OR (?2 = 1 AND p.actualizado > ?3))`)
    .bind(JSON.stringify(unidades), q.cerrados ? 1 : 0, desde).all<FilaDb & { pedido: string | null; owner_id: number | null; etapa_pedido: string | null; entrega_prometida: string | null }>()).results;
  const arts = pdvs.length ? (await db.prepare('SELECT * FROM produccion WHERE es_pdv = 0 AND pdv_task IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(pdvs.map((p) => p.task_id))).all<FilaDb>()).results : [];
  const dePdv = new Map<string, FilaDb[]>();
  for (const a of arts) { const l = dePdv.get(a.pdv_task) ?? []; l.push(a); dePdv.set(a.pdv_task, l); }
  const pedidoDe = new Map(pdvs.map((p) => [p.task_id, p.record_id]));
  const fotos = await fotosDeArticulos(db, arts.map((a) => ({ ...a, record_id: a.record_id ?? pedidoDe.get(a.pdv_task) ?? null })));
  const out = pdvs.map((p) => armarPdv(p, dePdv.get(p.task_id) ?? [], cfg.unidades, !!q.cerrados, fotos))
    .sort((a, b) => (a.entrega_real ?? a.entrega_prometida ?? '9999').localeCompare(b.entrega_real ?? b.entrega_prometida ?? '9999') || Number(a.npdv) - Number(b.npdv));
  return { pdvs: out, ...(await referencias(db)), config: cfg, unidades, puede_editar: puedeEditarProduccion(user) };
}

// Lo que necesita la pantalla para mostrar las filas: la gente de ClickUp, las opciones de los desplegables (con su
// empresa) y los estados.
export async function referencias(db: D1Database) {
  const [personas, opciones] = await db.batch([
    db.prepare(`SELECT cp.clickup_id, COALESCE(u.name, cp.nombre) AS nombre, cp.user_id, COALESCE(u.photo_url, cp.foto) AS foto, cp.iniciales, cp.color
      FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id AND u.deleted_at IS NULL ORDER BY nombre`),
    db.prepare(`SELECT o.campo, o.option_id, o.nombre, o.color, o.orden, o.company_id, r.name AS empresa
      FROM produccion_opciones o LEFT JOIN records r ON r.id = o.company_id AND r.archived = 0 ORDER BY o.campo, o.orden`),
  ]);
  return { personas: personas.results, opciones: opciones.results, estados: await estadosPec(db) };
}

async function pdvVista(db: D1Database, pdvTask: string) {
  const cfg = await produccionConfig(db);
  const p = await db.prepare(`${SELECT_PDV} WHERE p.task_id = ?`).bind(pdvTask)
    .first<FilaDb & { pedido: string | null; owner_id: number | null; etapa_pedido: string | null; entrega_prometida: string | null }>();
  if (!p) return null;
  const arts = (await db.prepare('SELECT * FROM produccion WHERE es_pdv = 0 AND pdv_task = ?').bind(pdvTask).all<FilaDb>()).results;
  const fotos = await fotosDeArticulos(db, arts.map((a) => ({ ...a, record_id: a.record_id ?? p.record_id })));
  return armarPdv(p, arts, cfg.unidades, false, fotos);
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

export async function editarProduccion(env: Env, ctx: Ctx, taskId: string, campo: string, valor: unknown) {
  const db = env.DB;
  if (!puedeEditarProduccion(ctx.user)) throw new HttpError(403, 'Producción la editan las usuarias con perfil Producción y los administradores.');
  if (!(EDITABLES as readonly string[]).includes(campo)) throw new HttpError(400, `No se puede editar «${campo}» desde el CRM.`);
  const fila = await db.prepare('SELECT * FROM produccion WHERE task_id = ?').bind(taskId).first<FilaDb>();
  if (!fila) throw new HttpError(404, 'No está esa tarea de producción (puede que la hayan borrado en ClickUp).');
  const pdv = fila.es_pdv ? fila : await db.prepare('SELECT * FROM produccion WHERE task_id = ?').bind(fila.pdv_task).first<FilaDb>();
  const cfg = await produccionConfig(db);
  if (!cfg.unidades.includes(pdv?.unidad ?? fila.unidad ?? '')) {
    throw new HttpError(409, `Los PDV de ${pdv?.unidad ?? fila.unidad ?? 'esta unidad'} todavía se trabajan en ClickUp. Desde el CRM se editan: ${cfg.unidades.join(', ') || 'ninguna unidad'}.`);
  }
  const c = campo as Editable;
  const path = `/task/${encodeURIComponent(taskId)}`;
  let local: Record<string, unknown> = {};
  if (c === 'estado') {
    const v = String(valor ?? '').toLowerCase().trim();
    const estados = await estadosPec(db);
    if (!estados.some((e) => e.status === v)) throw new HttpError(400, `«${valor}» no es un estado de la lista de producción.`);
    await escribir(env, 'PUT', path, { status: v });
    local = { estado: v };
  } else if (c === 'asignados') {
    const nuevos = (Array.isArray(valor) ? valor : []).map(Number).filter(Number.isFinite);
    const conocidos = new Set((await db.prepare('SELECT clickup_id FROM clickup_personas').all<{ clickup_id: number }>()).results.map((p) => p.clickup_id));
    const raro = nuevos.find((n) => !conocidos.has(n));
    if (raro != null) throw new HttpError(400, 'Esa persona no está en ClickUp.');
    const antes = lista(fila.asignados).map(Number);
    const add = nuevos.filter((n) => !antes.includes(n));
    const rem = antes.filter((n) => !nuevos.includes(n));
    if (add.length || rem.length) await escribir(env, 'PUT', path, { assignees: { add, rem } });
    local = { asignados: JSON.stringify(nuevos) };
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
  // El estado (o la fecha real de entrega) del PDV cambia el pedido: se relee el PDV y se actualiza ya, sin esperar la
  // sincronización. Si falla, queda para la próxima corrida.
  if (c === 'estado' || (c === 'entrega_real' && fila.es_pdv)) {
    await refrescarPdv(env, ctx, fila.pdv_task).catch((e) => console.error('produccion: refrescar', fila.pdv_task, (e as Error).message));
  }
  return pdvVista(db, fila.pdv_task);
}

async function refrescarPdv(env: Env, ctx: Ctx, pdvTask: string) {
  const b = Budget.of(env);
  const t = await cu<CuTask>(env, `/task/${encodeURIComponent(pdvTask)}`, { include_subtasks: 'true' }, b);
  await guardarTareas(env.DB, [t, ...(t.subtasks ?? []).map((s) => ({ ...s, parent: s.parent ?? t.id }))]);
  await upsertPdv(env, { ...ctx, source: 'clickup', sourceDetail: 'Producción (CRM)' }, t, null, b, { name: ctx.user.name, userId: ctx.user.id });
}

// ---------- En otras pantallas ----------

// Lo que está en producción con un proveedor o impresor (la ficha de su empresa).
export async function produccionDeEmpresa(db: D1Database, companyId: number) {
  const { results } = await db.prepare(`SELECT a.task_id, a.nombre, a.estado, a.cantidad, a.proveedor, a.impresor, a.ingreso_proveedor, a.retiro_proveedor,
      a.egreso_impresor, a.retiro_impresor, a.url, p.npdv, COALESCE(a.cliente, p.cliente) AS cliente, p.record_id, p.entrega_real,
      CASE WHEN op.company_id = ?1 THEN 'proveedor' ELSE 'impresor' END AS rol
    FROM produccion a JOIN produccion p ON p.task_id = a.pdv_task
      LEFT JOIN produccion_opciones op ON op.campo = 'proveedor' AND op.option_id = a.proveedor
      LEFT JOIN produccion_opciones oi ON oi.campo = 'impresor' AND oi.option_id = a.impresor
    WHERE a.es_pdv = 0 AND a.estado NOT IN ('entregados', 'anulado') AND (op.company_id = ?1 OR oi.company_id = ?1)
    ORDER BY COALESCE(p.entrega_real, '9999'), p.npdv LIMIT 200`).bind(companyId).all();
  return { articulos: results, estados: await estadosPec(db) };
}

// Quién tiene asignado cada artículo del pedido y el PDV entero (los productos del pedido, en su ficha).
export interface Persona { id: number; nombre: string; user_id: number | null; foto: string | null }
export async function produccionDePedido(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT p.task_id, p.es_pdv, p.estado, p.asignados FROM produccion p WHERE p.record_id = ?`).bind(recordId)
    .all<{ task_id: string; es_pdv: number; estado: string; asignados: string }>();
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
  return {
    asignados: [...todos.values()], listos: vivos.filter((a) => LISTOS.includes(a.estado)).length, total: vivos.length,
    porTarea: new Map(arts.map((a) => [a.task_id, de(a.asignados)])),
  };
}

// Para la tarjeta del tablero de pedidos (productos.ts, adjuntosSql): quién lo tiene asignado en producción (el PDV y
// sus artículos abiertos) y cuántos artículos están listos.
export const PRODUCCION_TARJETA_SQL = `,
      (SELECT json_group_array(json_object('id', cp.clickup_id, 'nombre', COALESCE(u.name, cp.nombre), 'user_id', cp.user_id, 'foto', COALESCE(u.photo_url, cp.foto)))
        FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id
        WHERE cp.clickup_id IN (SELECT j.value FROM produccion pr, json_each(pr.asignados) j
          WHERE pr.record_id = r.id AND (pr.es_pdv = 1 OR pr.estado NOT IN ('entregados', 'anulado')))) AS prod_asignados,
      (SELECT COUNT(*) FROM produccion pr WHERE pr.record_id = r.id AND pr.es_pdv = 0 AND pr.estado NOT IN ('anulado', 'anulada', 'cancelado')) AS prod_total,
      (SELECT COUNT(*) FROM produccion pr WHERE pr.record_id = r.id AND pr.es_pdv = 0 AND pr.estado IN ('listo para entergar', 'listo para entregar', 'entregados')) AS prod_listos`;
