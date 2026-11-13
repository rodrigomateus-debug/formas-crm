import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { esVentas, visibleSql } from './alcance';
import { norm } from './clickup';
import { CERRADOS } from './produccion';
import { serviceToken } from './google';
import {
  SELECT_ENC, aEncargo, actualizarLugares, anfitrion, avisarEncargo, claveCalle, claveEncargo, claveParada, cronogramaConfig, diaSemana, direccionLugar, encargosEntre,
  esDeLaParada, esDia, hoyBsAs, infoLugar, lugaresPara, lugaresPorId, mismoSitio, movimientos, puedeEditarCronograma, reindexarLugares, sumarDias, unicoLugar,
  type EncargoDia, type EncargoFila, type EstadoEnc, type ItemEnc, type Lugar, type Sitio,
} from './cronograma';
import { direccionesDePedidos } from './direcciones';

// Recorridos (pedido de Rodrigo del 13/11/2026): reemplaza la planilla «Recorridos» de Logística. Vendedoras, backoffice,
// producción, compras y administración cargan lo que el chofer tiene que llevar o retirar un día (muestras, sobres,
// mercadería, un trámite): un **encargo**. El destino se elige de una sola base de destinos (la libreta, que ahora es del
// Hub, más las empresas del CRM, los expresos y los depósitos). Al cargarlo, el Hub dice si ese día (o el siguiente, o la
// semana que viene) ya se va a ese lugar, para sumarlo ahí, y qué días se suele ir. Logística lo ve en el cronograma, en
// la parada de ese lugar, y lo mete en el recorrido de un chofer; el chofer lo marca en su app. Ver docs/RECORRIDOS.md.

// ---------- Quién puede ----------

// Cargar un encargo: todos los que editan algo. Organizar (mover cualquiera, marcarlo hecho, cancelar el de otro): los que
// editan el cronograma (Logística, Producción y los administradores).
export const puedePedir = (u: User) => u.role !== 'viewer';
export const organiza = puedeEditarCronograma;
const exigirPedir = (ctx: Ctx) => { if (!puedePedir(ctx.user)) throw new HttpError(403, 'Con permiso «Solo mira» no se cargan encargos.'); };

// ---------- Lo que se carga ----------

const ESTADOS: EstadoEnc[] = ['pendiente', 'hecho', 'no_se_pudo', 'cancelado'];
const MAX_ITEMS = 30;
// Los renglones de «llevar» o «retirar»: cantidad (opcional), qué, y el PDV si es de un pedido.
export function limpiarItems(v: unknown): ItemEnc[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ITEMS).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    // «2,5», «1.500» (mil quinientos), «1.500,5»: como se escribe en Argentina.
    let t = String(o.cant ?? '').trim();
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    const cant = Number(t);
    return {
      cant: Number.isFinite(cant) && cant > 0 ? Math.round(cant * 100) / 100 : null,
      que: String(o.que ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      pdv: String(o.pdv ?? '').replace(/^\s*pdv\s*[-:]?\s*/i, '').replace(/\s+/g, '').slice(0, 20) || null,
    };
  }).filter((x) => x.que || x.pdv);
}
const texto = (v: unknown, max: number) => (v == null ? null : String(v).replace(/[ \t]+/g, ' ').trim().slice(0, max) || null);

export async function encargoPorId(db: D1Database, id: number) {
  const r = await db.prepare(`${SELECT_ENC} WHERE e.id = ?`).bind(id).first<EncargoFila>();
  if (!r) throw new HttpError(404, 'Ese encargo ya no está.');
  return aEncargo(r);
}

// Quiénes de Logística se enteran cuando alguien carga o cambia algo para un día que ya tiene el recorrido armado (o
// para hoy): se les avisa en la campanita.
async function avisarLogistica(db: D1Database, ctx: Ctx, e: EncargoDia, que: string) {
  const armado = e.fecha === hoyBsAs() || !!(await db.prepare('SELECT 1 FROM cronograma_rutas WHERE fecha = ? LIMIT 1').bind(e.fecha).first());
  if (!armado) return;
  const { results } = await db.prepare("SELECT id FROM users WHERE active = 1 AND deleted_at IS NULL AND profile = 'logistica'").all<{ id: number }>();
  await avisarEncargo(db, results.map((u) => u.id), e.id, `${ctx.user.name} ${que} para el ${fechaCorta(e.fecha)}, que ya tiene el recorrido armado.`, ctx.user.id);
}
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const fechaCorta = (d: string) => `${DIAS[diaSemana(d)]} ${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;

// El destino que se eligió: un lugar de la libreta, una empresa del CRM, un expreso, un depósito de Formas o una
// dirección suelta. Si no está en la libreta (una empresa, o una dirección que se quiere guardar), se suma: así la base
// de destinos es una sola y la próxima vez aparece con su horario y su contacto.
interface DestinoInput { lugar_id?: unknown; company_id?: unknown; nombre?: unknown; direccion?: unknown; guardar?: unknown }
async function resolverDestino(env: Env, ctx: Ctx, d: DestinoInput) {
  const db = env.DB;
  const lugarId = Number(d.lugar_id) || null, companyId = Number(d.company_id) || null;
  if (lugarId) {
    const l = await db.prepare('SELECT * FROM lugares WHERE id = ?').bind(lugarId).first<Lugar & { company_id: number | null }>();
    if (!l) throw new HttpError(400, 'Ese destino ya no está en la libreta.');
    return { lugar_id: l.id, company_id: l.company_id ?? companyId, destino: l.nombre, direccion: l.direccion ? direccionLugar(l) : texto(d.direccion, 300) };
  }
  if (companyId) {
    // Una empresa que la persona ve (para Ventas, las suyas) o un proveedor o impresor.
    const c = await db.prepare(`SELECT id, name, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city FROM records r
      WHERE r.id = ? AND r.object_type = 'company' AND r.archived = 0 AND (${visibleSql('r', ctx.user)} OR json_extract(r.props, '$.tipo_de_relacion') = 'proveedor')`)
      .bind(companyId).first<{ id: number; name: string; address: string | null; city: string | null }>();
    if (!c) throw new HttpError(400, 'Esa empresa no está (o no la ves).');
    const dir = texto(d.direccion, 300) ?? ([c.address, c.city].filter(Boolean).join(', ') || null);
    // Si ya hay un destino de esa empresa en esa dirección, ese; si no, se suma a la libreta.
    const ya = (await db.prepare('SELECT * FROM lugares WHERE company_id = ? AND activo = 1').bind(c.id).all<Lugar>()).results
      .find((l) => !dir || !l.direccion || claveCalle(l.direccion) === claveCalle(dir));
    if (ya) return { lugar_id: ya.id, company_id: c.id, destino: ya.nombre, direccion: dir ?? (ya.direccion ? direccionLugar(ya) : null) };
    const nuevo = dir ? await crearLugar(db, ctx, { nombre: c.name, direccion: dir, company_id: c.id }) : null;
    return { lugar_id: nuevo, company_id: c.id, destino: c.name, direccion: dir };
  }
  const nombre = texto(d.nombre, 160), direccion = texto(d.direccion, 300);
  if (!nombre && !direccion) throw new HttpError(400, 'Falta a dónde va: elegí un destino o escribí la dirección.');
  const lugar = d.guardar && nombre && direccion ? await crearLugar(db, ctx, { nombre, direccion }) : null;
  return { lugar_id: lugar, company_id: null, destino: nombre ?? direccion!, direccion };
}
async function crearLugar(db: D1Database, ctx: Ctx, l: { nombre: string; direccion: string; company_id?: number | null; localidad?: string | null; horario?: string | null; contacto?: string | null; telefono?: string | null; observaciones?: string | null }) {
  const r = await db.prepare(`INSERT INTO lugares (nombre, direccion, localidad, horario, contacto, telefono, observaciones, clave_dir, origen, activo, company_id, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hub', 1, ?, ?, ?) RETURNING id`)
    .bind(l.nombre.slice(0, 160), l.direccion.slice(0, 300), l.localidad ?? null, l.horario ?? null, l.contacto ?? null, l.telefono ?? null, l.observaciones ?? null,
      claveCalle(l.direccion) || null, l.company_id ?? null, ctx.user.id, now()).first<{ id: number }>();
  await reindexarLugares(db, [r!.id]);
  return r!.id;
}

export interface EncargoInput extends DestinoInput {
  fecha?: unknown; llevar?: unknown; retirar?: unknown; desde?: unknown; hacia?: unknown; horario?: unknown; contacto?: unknown; notas?: unknown;
  urgente?: unknown; record_id?: unknown; destino?: DestinoInput;
}
async function base(db: D1Database, v: unknown) {
  if (v == null || v === '') return null;
  const cfg = await cronogramaConfig(db);
  return cfg.bases.some((b) => b.id === v) ? String(v) : null;
}

export async function crearEncargo(env: Env, ctx: Ctx, b: EncargoInput) {
  exigirPedir(ctx);
  const db = env.DB;
  if (!esDia(b.fecha)) throw new HttpError(400, 'Falta el día.');
  if (b.fecha < hoyBsAs() && !organiza(ctx.user)) throw new HttpError(400, 'Ese día ya pasó.');
  const llevar = limpiarItems(b.llevar), retirar = limpiarItems(b.retirar), notas = texto(b.notas, 1000);
  if (!llevar.length && !retirar.length && !notas) throw new HttpError(400, 'Decí qué hay que llevar o retirar (o qué hay que hacer, en las notas).');
  const d = await resolverDestino(env, ctx, b.destino ?? b);
  const recordId = await registroValido(db, ctx.user, b.record_id);
  const ts = now();
  const r = await db.prepare(`INSERT INTO encargos (fecha, user_id, lugar_id, company_id, destino, direccion, llevar, retirar, desde, hacia, horario, contacto, notas, urgente, record_id,
      estado, origen, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 'hub', ?, ?, ?) RETURNING id`)
    .bind(b.fecha, ctx.user.id, d.lugar_id, d.company_id, d.destino, d.direccion, JSON.stringify(llevar), JSON.stringify(retirar),
      await base(db, b.desde), await base(db, b.hacia), texto(b.horario, 120), texto(b.contacto, 200), notas, b.urgente ? 1 : 0, recordId, ts, ts, ctx.user.id).first<{ id: number }>();
  const e = await encargoPorId(db, r!.id);
  await avisarLogistica(db, ctx, e, `cargó un encargo a ${e.destino}`);
  return e;
}

// El pedido o negocio al que corresponde: tiene que ser uno que la persona ve.
async function registroValido(db: D1Database, user: User, v: unknown) {
  const id = Number(v) || null;
  if (!id) return null;
  const ok = await db.prepare(`SELECT 1 FROM records r WHERE r.id = ? AND r.object_type IN ('order', 'deal') AND r.archived = 0 AND ${visibleSql('r', user)}`).bind(id).first();
  if (!ok) throw new HttpError(400, 'Ese pedido o negocio no está (o no lo ves).');
  return id;
}

// Cambiar un encargo. Quien lo pidió lo cambia mientras no esté hecho; Logística (y quien edita el cronograma), siempre.
// Si lo cambia otro (pasarlo a otro día, cancelarlo, marcarlo), se le avisa a quien lo pidió.
export async function editarEncargo(env: Env, ctx: Ctx, id: number, b: EncargoInput & { estado?: unknown; motivo?: unknown }) {
  exigirPedir(ctx);
  const db = env.DB;
  const e = await encargoPorId(db, id);
  const esSuyo = e.user_id === ctx.user.id, org = organiza(ctx.user);
  if (!esSuyo && !org) throw new HttpError(403, 'Ese encargo lo cambia quien lo pidió o Logística.');
  if (e.origen !== 'hub') throw new HttpError(400, 'Es del historial de la planilla: no se cambia.');
  // Quien lo pidió (sin organizar): mientras está pendiente o no se pudo, lo cambia o lo cancela; cancelado, solo lo vuelve
  // a pendiente; hecho, ya no se toca.
  if (!org) {
    if (e.estado === 'hecho') throw new HttpError(400, 'Ya está hecho: no se cambia.');
    if (e.estado === 'cancelado' && b.estado !== 'pendiente') throw new HttpError(400, 'Está cancelado: para cambiarlo, volvelo a pendiente.');
  }
  // Lo que tiene que quedar para hacer, antes de tocar nada.
  const llevarN = b.llevar !== undefined ? limpiarItems(b.llevar) : e.llevar, retirarN = b.retirar !== undefined ? limpiarItems(b.retirar) : e.retirar;
  const notasN = b.notas !== undefined ? texto(b.notas, 1000) : e.notas;
  if (!llevarN.length && !retirarN.length && !notasN) throw new HttpError(400, 'Tiene que quedar algo para llevar o retirar (o qué hay que hacer, en las notas).');
  if (b.fecha !== undefined && b.fecha !== e.fecha) {
    if (!esDia(b.fecha)) throw new HttpError(400, 'La fecha tiene que ser AAAA-MM-DD.');
    if (b.fecha < hoyBsAs() && !org) throw new HttpError(400, 'Ese día ya pasó.');
  }
  const recordN = b.record_id !== undefined && (Number(b.record_id) || null) !== e.record_id ? await registroValido(db, ctx.user, b.record_id) : undefined;
  const sets: string[] = [], vals: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  const cambios: string[] = [];
  if (b.estado !== undefined) {
    const estado = String(b.estado) as EstadoEnc;
    if (!ESTADOS.includes(estado)) throw new HttpError(400, 'Estado desconocido.');
    // Quien lo pidió puede cancelarlo (o volverlo a pendiente si lo había cancelado); hecho y «no se pudo» lo marcan
    // Logística y el chofer.
    if (!org && !['pendiente', 'cancelado'].includes(estado)) throw new HttpError(403, 'Marcarlo hecho es de Logística (o del chofer, desde su app).');
    if (!org && estado === 'pendiente' && e.estado !== 'cancelado' && e.estado !== 'pendiente') throw new HttpError(403, 'Volverlo a pendiente es de Logística.');
    if (estado !== e.estado) {
      set('estado', estado);
      set('motivo', ['no_se_pudo', 'cancelado'].includes(estado) ? texto(b.motivo, 300) : null);
      set('hecho_por', estado === 'hecho' ? ctx.user.id : null); set('hecho_chofer', null); set('hecho_at', estado === 'hecho' ? now() : null);
      cambios.push(estado === 'hecho' ? 'lo marcó hecho' : estado === 'cancelado' ? `lo canceló${texto(b.motivo, 300) ? `: ${texto(b.motivo, 300)}` : ''}`
        : estado === 'no_se_pudo' ? `marcó que no se pudo${texto(b.motivo, 300) ? `: ${texto(b.motivo, 300)}` : ''}` : 'lo volvió a pendiente');
    }
  }
  if (b.fecha !== undefined && b.fecha !== e.fecha) {
    set('fecha', b.fecha as string);
    // Pasarlo a otro día lo deja pendiente otra vez (si no se pudo, se vuelve a intentar).
    if (e.estado === 'no_se_pudo' && b.estado === undefined) { set('estado', 'pendiente'); set('motivo', null); }
    cambios.push(`lo pasó al ${fechaCorta(b.fecha)}`);
  }
  if (b.destino !== undefined || b.lugar_id !== undefined || b.company_id !== undefined || b.nombre !== undefined) {
    const d = await resolverDestino(env, ctx, b.destino ?? b);
    set('lugar_id', d.lugar_id); set('company_id', d.company_id); set('destino', d.destino); set('direccion', d.direccion);
    if (d.destino !== e.destino) cambios.push(`cambió el destino a ${d.destino}`);
  }
  if (b.llevar !== undefined) set('llevar', JSON.stringify(llevarN));
  if (b.retirar !== undefined) set('retirar', JSON.stringify(retirarN));
  if (b.desde !== undefined) set('desde', await base(db, b.desde));
  if (b.hacia !== undefined) set('hacia', await base(db, b.hacia));
  for (const [k, max] of [['horario', 120], ['contacto', 200]] as const) if (b[k] !== undefined) set(k, texto(b[k], max));
  if (b.notas !== undefined) set('notas', notasN);
  if (b.urgente !== undefined) set('urgente', b.urgente ? 1 : 0);
  if (recordN !== undefined) set('record_id', recordN);
  if (!sets.length) return e;
  set('updated_at', now()); set('updated_by', ctx.user.id);
  await db.prepare(`UPDATE encargos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  const nuevo = await encargoPorId(db, id);
  if (!esSuyo && cambios.length) await avisarEncargo(db, [e.user_id], id, `${ctx.user.name} ${cambios.join(' y ')}.`, ctx.user.id);
  if (esSuyo && !org) await avisarLogistica(db, ctx, nuevo, nuevo.estado === 'cancelado' ? `canceló su encargo a ${nuevo.destino}` : `cambió su encargo a ${nuevo.destino}`);
  return nuevo;
}

// ---------- Listas ----------

// Los encargos de un rango de días: los propios o (quien organiza) los de todos. Con `estado`, solo esos.
export async function listarEncargos(db: D1Database, user: User, q: { desde?: string; hasta?: string; todos?: boolean; estado?: string; usuario?: number }) {
  const desde = esDia(q.desde) ? q.desde : sumarDias(hoyBsAs(), -30), hasta = esDia(q.hasta) ? q.hasta : sumarDias(hoyBsAs(), 60);
  const conds = ['e.fecha BETWEEN ? AND ?'], vals: unknown[] = [desde, hasta];
  if (!(q.todos && organiza(user))) { conds.push('e.user_id = ?'); vals.push(user.id); }
  else if (q.usuario) { conds.push('e.user_id = ?'); vals.push(q.usuario); }
  if (q.estado && ESTADOS.includes(q.estado as EstadoEnc)) { conds.push('e.estado = ?'); vals.push(q.estado); }
  const { results } = await db.prepare(`${SELECT_ENC} WHERE ${conds.join(' AND ')} ORDER BY e.fecha DESC, e.id DESC LIMIT 400`).bind(...vals).all<EncargoFila>();
  return { desde, hasta, encargos: results.map(aEncargo) };
}

// ---------- Destinos: una sola base ----------

export interface DestinoOpcion {
  tipo: 'lugar' | 'empresa' | 'expreso' | 'base' | 'suelto'; key: string; nombre: string; direccion: string | null; detalle: string | null;
  lugar_id: number | null; company_id: number | null; record_id?: number | null; motivo?: string | null; horario?: string | null; contacto?: string | null;
  // Para las sugerencias: cuándo ya se va (los próximos días) y qué días se suele ir.
  proximos?: Array<{ fecha: string; que: string[] }>; habitual?: Habitual | null; veces?: number;
}
const opcionLugar = (l: Lugar & { company_id?: number | null }, extra: Partial<DestinoOpcion> = {}): DestinoOpcion => ({
  tipo: 'lugar', key: `l:${l.id}`, nombre: l.nombre, direccion: l.direccion ? direccionLugar(l) : null, detalle: [l.horario, l.contacto].filter(Boolean).join(' · ') || null,
  lugar_id: l.id, company_id: l.company_id ?? null, horario: l.horario, contacto: [l.contacto, l.telefono].filter(Boolean).join(' · ') || null, ...extra,
});

// Buscar un destino: en la libreta, en las empresas del CRM (las que la persona ve, más los proveedores e impresores), en
// los expresos y en los depósitos de Formas. Si una empresa ya es un lugar de la libreta, sale una vez.
export async function buscarDestinos(env: Env, user: User, q: string) {
  const db = env.DB;
  await actualizarLugares(env, organiza(user));
  const t = norm(q).replace(/[%_]/g, ' ').trim();
  if (t.length < 2) return { destinos: [] as DestinoOpcion[] };
  const like = `%${t}%`, empieza = `${t}%`;
  const [lugares, empresas, expresos, cfg] = await Promise.all([
    db.prepare(`SELECT * FROM lugares WHERE activo = 1 AND (lower(nombre) LIKE ?1 OR lower(COALESCE(direccion, '')) LIKE ?1 OR lower(COALESCE(localidad, '')) LIKE ?1)
      ORDER BY (lower(nombre) LIKE ?2) DESC, nombre LIMIT 20`).bind(like, empieza).all<Lugar & { company_id: number | null }>(),
    db.prepare(`SELECT r.id, r.name, json_extract(r.props, '$.address') AS address, json_extract(r.props, '$.city') AS city, json_extract(r.props, '$.tipo_de_relacion') AS rel,
        json_extract(r.props, '$.horario_recepcion') AS horario FROM records r
      WHERE r.object_type = 'company' AND r.archived = 0 AND lower(r.name) LIKE ?1
        AND (${visibleSql('r', user)} OR json_extract(r.props, '$.tipo_de_relacion') = 'proveedor')
      ORDER BY (lower(r.name) LIKE ?2) DESC, r.name LIMIT 10`).bind(like, empieza).all<{ id: number; name: string; address: string | null; city: string | null; rel: string | null; horario: string | null }>(),
    db.prepare("SELECT id, nombre, direccion FROM transportistas WHERE activo = 1 AND tipo = 'expreso' AND lower(nombre) LIKE ? LIMIT 5").bind(like).all<{ id: number; nombre: string; direccion: string | null }>(),
    cronogramaConfig(db),
  ]);
  const out: DestinoOpcion[] = [];
  for (const b of cfg.bases) if (norm(`${b.nombre} formas ${b.direccion}`).includes(t)) out.push({ tipo: 'base', key: `b:${b.id}`, nombre: b.nombre, direccion: b.direccion, detalle: 'De Formas', lugar_id: null, company_id: null });
  for (const l of lugares.results) out.push(opcionLugar(l));
  const conLugar = new Set(lugares.results.map((l) => l.company_id).filter(Boolean));
  for (const c of empresas.results) {
    if (conLugar.has(c.id)) continue;
    const dir = [c.address, c.city].filter(Boolean).join(', ') || null;
    // Una empresa con el mismo nombre y la misma dirección que un lugar de la libreta es ese lugar.
    if (out.some((o) => o.tipo === 'lugar' && mismoSitio({ nombre: o.nombre, direccion: o.direccion }, { nombre: c.name, direccion: dir }) && (!dir || !o.direccion || claveCalle(dir) === claveCalle(o.direccion)))) continue;
    out.push({ tipo: 'empresa', key: `c:${c.id}`, nombre: c.name, direccion: dir, detalle: c.rel === 'proveedor' ? 'Proveedor' : 'Empresa del CRM', lugar_id: null, company_id: c.id, horario: c.horario });
  }
  for (const x of expresos.results) out.push({ tipo: 'expreso', key: `x:${x.id}`, nombre: x.nombre, direccion: x.direccion, detalle: 'Expreso', lugar_id: null, company_id: null });
  return { destinos: out.slice(0, 30) };
}

// Agregar o corregir un destino de la libreta desde el Hub. Lo que se corrige acá la planilla ya no lo pisa.
export async function guardarDestino(env: Env, ctx: Ctx, id: number | null, b: Record<string, unknown>) {
  exigirPedir(ctx);
  const db = env.DB;
  const nombre = texto(b.nombre, 160), direccion = texto(b.direccion, 300);
  const campos = { localidad: texto(b.localidad, 80), horario: texto(b.horario, 160), contacto: texto(b.contacto, 160), telefono: texto(b.telefono, 60), observaciones: texto(b.observaciones, 600) };
  if (id == null) {
    if (!nombre || !direccion) throw new HttpError(400, 'El destino necesita el nombre y la dirección.');
    const nuevo = await crearLugar(db, ctx, { nombre, direccion, ...campos, company_id: organiza(ctx.user) ? Number(b.company_id) || null : null });
    return { id: nuevo };
  }
  const l = await db.prepare('SELECT id, origen, created_by FROM lugares WHERE id = ?').bind(id).first<{ id: number; origen: string; created_by: number | null }>();
  if (!l) throw new HttpError(404, 'Ese destino ya no está.');
  // La libreta la corrige Logística (y quien edita el cronograma); los demás, los destinos que cargaron ellos.
  if (!organiza(ctx.user) && !(l.origen === 'hub' && l.created_by === ctx.user.id)) throw new HttpError(403, 'Los destinos de la libreta los corrige Logística. Si algo está mal, avisale.');
  const sets: string[] = [], vals: unknown[] = [];
  if (b.nombre !== undefined) { if (!nombre) throw new HttpError(400, 'El nombre no puede quedar vacío.'); sets.push('nombre = ?'); vals.push(nombre); }
  if (b.direccion !== undefined) { sets.push('direccion = ?', 'clave_dir = ?'); vals.push(direccion, direccion ? claveCalle(direccion) || null : null); }
  for (const k of Object.keys(campos) as Array<keyof typeof campos>) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  if (b.company_id !== undefined && organiza(ctx.user)) { sets.push('company_id = ?'); vals.push(Number(b.company_id) || null); }
  if (b.activo !== undefined) { if (!organiza(ctx.user)) throw new HttpError(403, 'Sacar un destino de la libreta es de Logística.'); sets.push('activo = ?'); vals.push(b.activo ? 1 : 0); }
  if (!sets.length) return { id };
  await db.prepare(`UPDATE lugares SET ${sets.join(', ')}, editado = 1, updated_at = ? WHERE id = ?`).bind(...vals, now(), id).run();
  await reindexarLugares(db, [id]);
  return { id };
}

// La libreta para la pestaña «Destinos»: buscar, con cuántas veces se fue a cada uno en los últimos 6 meses.
export async function listarDestinos(env: Env, user: User, q: string) {
  const db = env.DB;
  const cfg = await actualizarLugares(env, organiza(user));
  const t = norm(q).replace(/[%_]/g, ' ').trim();
  const desde = sumarDias(hoyBsAs(), -182);
  const { results } = await db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM encargos e WHERE e.lugar_id = l.id AND e.fecha >= ?2 AND e.estado <> 'cancelado') AS veces
    FROM lugares l WHERE l.activo = 1 ${t ? "AND (lower(l.nombre) LIKE ?1 OR lower(COALESCE(l.direccion, '')) LIKE ?1 OR lower(COALESCE(l.localidad, '')) LIKE ?1)" : ''}
    ORDER BY veces DESC, l.nombre LIMIT 100`).bind(`%${t}%`, desde).all<Lugar & { company_id: number | null; origen: string; editado: number; veces: number; localidad: string | null; zona: string | null; telefono: string | null; created_by: number | null }>();
  const total = await db.prepare('SELECT COUNT(*) AS n FROM lugares WHERE activo = 1').first<{ n: number }>();
  return {
    total: total?.n ?? 0, copia: { at: cfg.at, filas: cfg.filas, error: cfg.error ?? null },
    destinos: results.map((l) => ({ id: l.id, nombre: l.nombre, direccion: l.direccion, localidad: l.localidad, zona: l.zona, horario: l.horario, contacto: l.contacto,
      telefono: l.telefono, observaciones: l.observaciones, company_id: l.company_id, origen: l.origen, editado: !!l.editado, veces: l.veces,
      puede_editar: organiza(user) || (l.origen === 'hub' && l.created_by === user.id) })),
  };
}

// ---------- Cuándo se va a cada lugar ----------

// Un viaje previsto (o hecho) a un lugar un día: un movimiento de ClickUp o un encargo.
interface Viaje extends Sitio { fecha: string; tipo: 'entrega' | 'retiro' | 'egreso' | 'encargo'; detalle: string; propio: boolean; encargo_id?: number; record_id?: number | null }
export interface Habitual { texto: string; dias: number[]; por_semana: number }
const SEMANAS = 8;

// Los viajes de los próximos días: lo de ClickUp (entregas, retiros, egresos) y los encargos. Para la vendedora, lo de
// otros clientes no dice de quién es.
async function viajesEntre(db: D1Database, user: User, desde: string, hasta: string) {
  const [{ movs }, encs] = await Promise.all([movimientos(db, desde, hasta), encargosEntre(db, desde, hasta)]);
  const viajes: Viaje[] = [];
  const pedidos = [...new Set(movs.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
  const [dirs, pedidoInfo] = await Promise.all([
    direccionesDePedidos(db, pedidos),
    pedidos.length ? db.prepare(`SELECT r.id, r.owner_id, (SELECT c.id FROM associations s JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END
        AND c.object_type = 'company' AND c.archived = 0 WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS company_id
      FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pedidos)).all<{ id: number; owner_id: number | null; company_id: number | null }>()
      .then((r) => new Map(r.results.map((x) => [x.id, x]))) : Promise.resolve(new Map<number, { id: number; owner_id: number | null; company_id: number | null }>()),
  ]);
  const ventas = esVentas(user);
  for (const m of movs) {
    if (m.tipo === 'ingreso') continue;
    if (m.tipo === 'entrega') {
      const p = m.record_id ? pedidoInfo.get(m.record_id) : undefined;
      const ds = m.record_id ? dirs.get(m.record_id) ?? [] : [];
      if (ds.length && ds.every((d) => d.retira)) continue;
      const suyo = !ventas || (p?.owner_id ?? null) === user.id;
      viajes.push({ fecha: m.fecha, tipo: 'entrega', clave: claveParada(m), nombre: m.cliente ?? '', company_id: p?.company_id ?? null, direccion: ds.find((d) => !d.retira)?.direccion ?? null,
        detalle: suyo ? `Entrega PDV ${m.npdv ?? '—'}` : 'Entrega a un cliente', propio: (p?.owner_id ?? null) === user.id, record_id: suyo ? m.record_id : null });
    } else {
      viajes.push({ fecha: m.fecha, tipo: m.tipo === 'egreso' ? 'egreso' : 'retiro', clave: claveParada(m), nombre: m.lugar ?? '', company_id: m.company_id, direccion: null,
        detalle: `${m.tipo === 'egreso' ? 'Egreso' : 'Retiro'}${ventas ? '' : ` PDV ${m.npdv ?? '—'}`}`, propio: false });
    }
  }
  for (const e of encs) {
    const propio = e.user_id === user.id;
    viajes.push({ fecha: e.fecha, tipo: 'encargo', clave: claveEncargo(e), nombre: e.destino, company_id: e.company_id, lugar_id: e.lugar_id, direccion: e.direccion,
      detalle: propio ? 'Tu encargo' : `Encargo de ${e.quien?.split(' ')[0] ?? 'alguien'}`, propio, encargo_id: e.id });
  }
  return { viajes, movs, encs };
}

// Qué días se fue a cada lugar en las últimas semanas: los encargos (también el historial de la planilla, que tiene todos
// los viajes) y los retiros y egresos de ClickUp. Cuenta días, no filas: lo mismo cargado en los dos lados vale una vez.
async function historial(db: D1Database, hasta: string) {
  const desde = sumarDias(hasta, -SEMANAS * 7);
  const [encs, prod] = await Promise.all([
    db.prepare("SELECT fecha, destino, direccion, lugar_id, company_id FROM encargos WHERE fecha BETWEEN ? AND ? AND estado IN ('hecho', 'pendiente')").bind(desde, hasta)
      .all<{ fecha: string; destino: string; direccion: string | null; lugar_id: number | null; company_id: number | null }>(),
    db.prepare(`SELECT x.d AS fecha, o.nombre, o.company_id FROM (
        SELECT retiro_proveedor AS d, 'proveedor' AS campo, proveedor AS op FROM produccion WHERE retiro_proveedor BETWEEN ?1 AND ?2
        UNION SELECT retiro_impresor, 'impresor', impresor FROM produccion WHERE retiro_impresor BETWEEN ?1 AND ?2
        UNION SELECT egreso_impresor, 'impresor', impresor FROM produccion WHERE egreso_impresor BETWEEN ?1 AND ?2) x
      JOIN produccion_opciones o ON o.campo = x.campo AND o.option_id = x.op`).bind(desde, hasta).all<{ fecha: string; nombre: string; company_id: number | null }>(),
  ]);
  return [...encs.results.map((e) => ({ fecha: e.fecha, nombre: e.destino, direccion: e.direccion, lugar_id: e.lugar_id, company_id: e.company_id })),
    ...prod.results.map((p) => ({ fecha: p.fecha, nombre: p.nombre, company_id: p.company_id, direccion: null }))];
}
const NOMBRE_DIA = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
function habitualDe(dias: Set<string>): Habitual | null {
  if (dias.size < 2) return null;
  const porDia = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dias) porDia[diaSemana(d)]++;
  const porSemana = Math.round((dias.size / SEMANAS) * 10) / 10;
  // Los días que se fue al menos la mitad de las semanas (o, si va poco, los que concentran las visitas).
  const fuertes = [1, 2, 3, 4, 5].filter((i) => porDia[i] >= Math.max(2, SEMANAS / 2) || (porDia[i] >= 2 && porDia[i] >= dias.size * 0.4));
  const lista = (xs: number[]) => xs.map((i) => NOMBRE_DIA[i]).join(', ').replace(/, ([^,]*)$/, ' y $1');
  const texto = porSemana >= 3.5 ? 'Se va casi todos los días'
    : porSemana >= 1 ? `Se va ${Math.round(porSemana) === 1 ? 'una vez' : `unas ${Math.round(porSemana)} veces`} por semana${fuertes.length && fuertes.length < 4 ? `, sobre todo los ${lista(fuertes)}` : ''}`
    : `Se fue ${dias.size} veces en las últimas ${SEMANAS} semanas${fuertes.length ? `, casi siempre los ${lista(fuertes)}` : ''}`;
  return { texto, dias: porSemana >= 3.5 ? [1, 2, 3, 4, 5] : fuertes, por_semana: porSemana };
}

// Para cada destino, los próximos días que ya se va (hasta 3) y qué días se suele ir.
async function enriquecer(db: D1Database, user: User, destinos: DestinoOpcion[], viajes?: Viaje[]) {
  if (!destinos.length) return destinos;
  const hoy = hoyBsAs();
  const vs = viajes ?? (await viajesEntre(db, user, hoy, sumarDias(hoy, 21))).viajes;
  const hist = await historial(db, sumarDias(hoy, -1));
  for (const d of destinos) {
    const yo: Sitio = { nombre: d.nombre, company_id: d.company_id, lugar_id: d.lugar_id, direccion: d.direccion };
    const porDia = new Map<string, string[]>();
    for (const v of vs) if (v.fecha >= hoy && mismoSitio(yo, v)) porDia.set(v.fecha, [...(porDia.get(v.fecha) ?? []), v.detalle]);
    d.proximos = [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 3).map(([fecha, que]) => ({ fecha, que: [...new Set(que)] }));
    d.habitual = habitualDe(new Set(hist.filter((h) => mismoSitio(yo, h)).map((h) => h.fecha)));
  }
  return destinos;
}

// Las sugerencias al cargar un encargo: los destinos a los que más manda esta persona (sus encargos de los últimos 6
// meses, también los de la planilla) y los de sus pedidos y negocios abiertos (el cliente, y el proveedor o el impresor de
// cada artículo que falta). Cada uno con los próximos días que ya se va y qué días se suele ir.
export async function sugerencias(env: Env, user: User) {
  const db = env.DB;
  await actualizarLugares(env, organiza(user));
  const hoy = hoyBsAs();
  const [frec, pedidos, negocios] = await Promise.all([
    db.prepare(`SELECT COALESCE('l' || lugar_id, 'c' || company_id, 'd' || lower(trim(destino))) AS k, MAX(lugar_id) AS lugar_id, MAX(company_id) AS company_id,
        MAX(destino) AS destino, MAX(direccion) AS direccion, COUNT(*) AS n, MAX(fecha) AS ultima
      FROM encargos WHERE user_id = ? AND fecha >= ? AND estado <> 'cancelado' GROUP BY k ORDER BY n DESC, ultima DESC LIMIT 8`).bind(user.id, sumarDias(hoy, -182))
      .all<{ k: string; lugar_id: number | null; company_id: number | null; destino: string; direccion: string | null; n: number; ultima: string }>(),
    // Sus pedidos abiertos (con el PDV en producción): el cliente y los proveedores e impresores de lo que falta.
    db.prepare(`SELECT r.id, r.name, p.npdv, p.cliente,
        (SELECT c.id FROM associations s JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END AND c.object_type = 'company' AND c.archived = 0
          WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS company_id,
        (SELECT json_group_array(DISTINCT o.campo || ':' || o.company_id) FROM produccion a JOIN produccion_opciones o
          ON (o.campo = 'proveedor' AND o.option_id = a.proveedor) OR (o.campo = 'impresor' AND o.option_id = a.impresor)
          WHERE a.pdv_task = p.task_id AND a.es_pdv = 0 AND o.company_id IS NOT NULL AND a.estado NOT IN (SELECT value FROM json_each(?2))) AS ops
      FROM records r JOIN produccion p ON p.record_id = r.id AND p.es_pdv = 1
      WHERE r.object_type = 'order' AND r.owner_id = ?1 AND r.archived = 0 AND p.estado NOT IN (SELECT value FROM json_each(?2))
      ORDER BY r.updated_at DESC LIMIT 12`).bind(user.id, JSON.stringify(CERRADOS)).all<{ id: number; name: string; npdv: string | null; cliente: string | null; company_id: number | null; ops: string | null }>(),
    // Sus negocios abiertos, movidos en los últimos 2 meses: para las muestras.
    db.prepare(`SELECT r.id, r.name, (SELECT c.id FROM associations s JOIN records c ON c.id = CASE WHEN s.from_id = r.id THEN s.to_id ELSE s.from_id END AND c.object_type = 'company' AND c.archived = 0
          WHERE s.from_id = r.id OR s.to_id = r.id ORDER BY s.is_primary DESC LIMIT 1) AS company_id
      FROM records r JOIN stages st ON st.id = r.stage_id WHERE r.object_type = 'deal' AND r.owner_id = ? AND r.archived = 0 AND st.is_closed = 0 AND r.updated_at >= ?
      ORDER BY r.updated_at DESC LIMIT 8`).bind(user.id, sumarDias(hoy, -60)).all<{ id: number; name: string; company_id: number | null }>(),
  ]);

  // Las empresas que aparecen, con su dirección y, si son un lugar de la libreta, ese lugar.
  const ids = new Set<number>();
  for (const p of pedidos.results) { if (p.company_id) ids.add(p.company_id); for (const o of opsDe(p.ops)) ids.add(o.company_id); }
  for (const n of negocios.results) if (n.company_id) ids.add(n.company_id);
  for (const f of frec.results) if (f.company_id) ids.add(f.company_id);
  const empresas = ids.size ? new Map((await db.prepare(`SELECT id, name, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city,
      json_extract(props, '$.horario_recepcion') AS horario FROM records WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...ids]))
    .all<{ id: number; name: string; address: string | null; city: string | null; horario: string | null }>()).results.map((e) => [e.id, e])) : new Map();
  const deEmpresa = ids.size ? (await db.prepare('SELECT * FROM lugares WHERE activo = 1 AND company_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...ids])).all<Lugar & { company_id: number }>()).results : [];
  const porNombre = await lugaresPara(db, [...empresas.values()].map((e) => e.name));
  const lugares = await lugaresPorId(db, frec.results.map((f) => f.lugar_id));
  const empresaOpcion = (id: number, extra: Partial<DestinoOpcion>): DestinoOpcion | null => {
    const e = empresas.get(id);
    if (!e) return null;
    const dir = [e.address, e.city].filter(Boolean).join(', ') || null;
    const l = deEmpresa.find((x) => x.company_id === id) ?? (dir ? null : unicoLugar(porNombre.get(e.name)?.exactos ?? []));
    if (l) return opcionLugar({ ...l, company_id: id }, extra);
    return { tipo: 'empresa', key: `c:${id}`, nombre: e.name, direccion: dir, detalle: null, lugar_id: null, company_id: id, horario: e.horario, ...extra };
  };

  const frecuentes: DestinoOpcion[] = [];
  for (const f of frec.results) {
    const l = f.lugar_id ? lugares.get(f.lugar_id) : null;
    const o = l ? opcionLugar(l as Lugar & { company_id: number | null }) : f.company_id ? empresaOpcion(f.company_id, {}) : null;
    frecuentes.push({ ...(o ?? { tipo: 'suelto', key: `d:${norm(f.destino)}`, nombre: f.destino, direccion: f.direccion, detalle: null, lugar_id: null, company_id: null }), veces: f.n,
      motivo: `${f.n} ${f.n === 1 ? 'vez' : 'veces'} en los últimos 6 meses` });
  }
  const dePedidos: DestinoOpcion[] = [];
  const agregar = (o: DestinoOpcion | null) => {
    if (!o) return;
    const ya = dePedidos.find((x) => x.key === o.key);
    if (ya) { if (o.motivo && !ya.motivo?.includes(o.motivo)) ya.motivo = `${ya.motivo} · ${o.motivo}`; return; }
    dePedidos.push(o);
  };
  for (const p of pedidos.results) {
    const pdv = `PDV ${p.npdv ?? '—'}`;
    if (p.company_id) agregar(empresaOpcion(p.company_id, { motivo: `Cliente de tu ${pdv}`, record_id: p.id }));
    for (const o of opsDe(p.ops)) agregar(empresaOpcion(o.company_id, { motivo: `${o.campo === 'impresor' ? 'Impresor' : 'Proveedor'} de tu ${pdv}`, record_id: p.id }));
  }
  for (const n of negocios.results) if (n.company_id) agregar(empresaOpcion(n.company_id, { motivo: `Negocio abierto: ${n.name}`, record_id: n.id }));
  const { viajes } = await viajesEntre(db, user, hoy, sumarDias(hoy, 21));
  await enriquecer(db, user, [...frecuentes, ...dePedidos], viajes);
  const cfg = await cronogramaConfig(db);
  return { frecuentes, de_pedidos: dePedidos.slice(0, 14), bases: cfg.bases.map((x) => ({ id: x.id, nombre: x.nombre })), organiza: organiza(user) };
}
const opsDe = (s: string | null) => {
  try { return (JSON.parse(s ?? '[]') as string[]).map((x) => { const [campo, id] = String(x).split(':'); return { campo, company_id: Number(id) }; }).filter((x) => x.company_id); }
  catch { return []; }
};

// Un destino elegido: lo que dice la libreta, los próximos días hábiles con lo que ya va ese día a ese lugar y si se suele
// ir, y los últimos encargos a ese lugar (para copiar el contacto o lo que se mandó).
export async function diasDelDestino(env: Env, user: User, q: { lugar_id?: string; company_id?: string; nombre?: string; direccion?: string }) {
  const db = env.DB;
  const hoy = hoyBsAs();
  const lugar = Number(q.lugar_id) ? await db.prepare('SELECT * FROM lugares WHERE id = ?').bind(Number(q.lugar_id)).first<Lugar & { company_id: number | null }>() : null;
  const destino: DestinoOpcion = lugar ? opcionLugar(lugar) : {
    tipo: Number(q.company_id) ? 'empresa' : 'suelto', key: '', nombre: String(q.nombre ?? ''), direccion: q.direccion ? String(q.direccion) : null, detalle: null,
    lugar_id: null, company_id: Number(q.company_id) || null,
  };
  if (!destino.nombre && !destino.direccion) throw new HttpError(400, 'Falta el destino.');
  const hasta = sumarDias(hoy, 21);
  const [{ viajes }, feriados] = await Promise.all([
    viajesEntre(db, user, hoy, hasta),
    db.prepare('SELECT fecha, nombre FROM feriados WHERE fecha BETWEEN ? AND ?').bind(hoy, hasta).all<{ fecha: string; nombre: string }>(),
  ]);
  await enriquecer(db, user, [destino], viajes);
  const yo: Sitio = { nombre: destino.nombre, company_id: destino.company_id, lugar_id: destino.lugar_id, direccion: destino.direccion };
  const fer = new Map(feriados.results.map((f) => [f.fecha, f.nombre]));
  const dias: Array<{ fecha: string; feriado: string | null; viajes: string[]; propios: number; habitual: boolean; cuantos: number }> = [];
  for (let d = hoy; dias.length < 12 && d <= hasta; d = sumarDias(d, 1)) {
    if ([0, 6].includes(diaSemana(d))) continue;
    const delDia = viajes.filter((v) => v.fecha === d);
    const aca = delDia.filter((v) => mismoSitio(yo, v));
    dias.push({ fecha: d, feriado: fer.get(d) ?? null, viajes: [...new Set(aca.map((v) => v.detalle))], propios: aca.filter((v) => v.propio).length,
      habitual: !!destino.habitual?.dias.includes(diaSemana(d)), cuantos: new Set(delDia.map((v) => v.clave)).size });
  }
  const ultimos = (await db.prepare(`${SELECT_ENC} WHERE (e.lugar_id = ?1 OR (?2 IS NOT NULL AND e.company_id = ?2) OR lower(e.destino) = lower(?3)) AND e.estado <> 'cancelado'
      ORDER BY e.fecha DESC LIMIT 25`).bind(destino.lugar_id ?? -1, destino.company_id, destino.nombre).all<EncargoFila>()).results.map(aEncargo)
    .filter((e) => !esVentas(user) || e.user_id === user.id).slice(0, 4);
  // Cómo se coordina la entrega (turnos, seguros) lo ve solo quien organiza, como en la ruta del día.
  const info = lugar ? { ...infoLugar(lugar), localidad: lugar.localidad, coordinacion: organiza(user) ? lugar.coordinacion : null } : null;
  return { destino, lugar: info, dias, habitual: destino.habitual ?? null, ultimos };
}

// ---------- La agenda: a dónde va el recorrido cada día ----------

// Los próximos días hábiles con los lugares a los que se va (lo de ClickUp y los encargos), juntos por lugar como en la
// ruta del día, con el chofer si ya está armado. Sirve para ver «el jueves van a Munro» y sumarse. Para la vendedora, lo de
// clientes que no son suyos dice solo «Un cliente» y la localidad.
export async function agenda(env: Env, user: User, q: { desde?: string; dias?: string }) {
  const db = env.DB;
  const hoy = hoyBsAs();
  const desde = esDia(q.desde) ? q.desde : hoy;
  const n = Math.min(Math.max(Number(q.dias) || 8, 1), 15);
  const habiles: string[] = [];
  for (let d = desde; habiles.length < n; d = sumarDias(d, 1)) if (![0, 6].includes(diaSemana(d))) habiles.push(d);
  const hasta = habiles[habiles.length - 1];
  const [{ viajes, encs }, rutas, feriados] = await Promise.all([
    viajesEntre(db, user, desde, hasta),
    db.prepare('SELECT fecha, chofer, orden FROM cronograma_rutas WHERE fecha BETWEEN ? AND ? ORDER BY fecha, n').bind(desde, hasta).all<{ fecha: string; chofer: string | null; orden: string }>(),
    db.prepare('SELECT fecha, nombre FROM feriados WHERE fecha BETWEEN ? AND ?').bind(desde, hasta).all<{ fecha: string; nombre: string }>(),
  ]);
  const ventas = esVentas(user);
  const lugares = await lugaresPorId(db, encs.map((e) => e.lugar_id));
  // Los días hábiles y, si tienen algo, el sábado y el domingo.
  const fechas: string[] = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) if (habiles.includes(d) || viajes.some((v) => v.fecha === d)) fechas.push(d);
  const out = fechas.map((fecha) => {
    const paradas: Array<{ clave: string; nombre: string; localidad: string | null; direccion: string | null; tipos: Record<string, number>; detalle: string[];
      encargos: EncargoDia[]; anonima: boolean; chofer: string | null; company_id: number | null; lugar_id: number | null; propio?: { nombre: string; direccion: string | null } }> = [];
    const delDia = viajes.filter((v) => v.fecha === fecha);
    // Primero lo de ClickUp (cada parada con su clave) y después los encargos, en la parada del mismo lugar o en una propia.
    for (const v of [...delDia.filter((x) => x.tipo !== 'encargo'), ...delDia.filter((x) => x.tipo === 'encargo')]) {
      let p = paradas.find((x) => x.clave === v.clave);
      if (!p && v.tipo === 'encargo') {
        const e = encs.find((x) => x.id === v.encargo_id)!;
        const host = anfitrion(e, paradas.map((x) => ({ clave: x.clave, nombre: x.nombre, company_id: x.company_id, lugar_id: x.lugar_id, direccion: x.direccion })));
        p = paradas.find((x) => x.clave === host);
      }
      if (!p) {
        const l = v.lugar_id ? lugares.get(v.lugar_id) : null;
        // Se ve el nombre si la arma algo propio o un proveedor o impresor (o, fuera del perfil Ventas, siempre).
        p = { clave: v.clave!, nombre: v.nombre, localidad: l?.localidad ?? localidadDe(v.direccion), direccion: v.direccion ?? null, tipos: {}, detalle: [], encargos: [],
          anonima: ventas && !v.propio && v.tipo !== 'retiro' && v.tipo !== 'egreso', chofer: null, company_id: v.company_id ?? null, lugar_id: v.lugar_id ?? null };
        paradas.push(p);
      }
      p.tipos[v.tipo] = (p.tipos[v.tipo] ?? 0) + 1;
      if (!p.detalle.includes(v.detalle)) p.detalle.push(v.detalle);
      // Un retiro o egreso: es un proveedor o impresor, se ve. Algo propio que cae en la parada de otro cliente no la
      // destapa: se ve con el nombre que le puso ella.
      if (v.tipo === 'retiro' || v.tipo === 'egreso') p.anonima = false;
      else if (v.propio && p.anonima && !p.propio) p.propio = { nombre: v.nombre, direccion: v.direccion ?? null };
      if (v.tipo === 'encargo') { const e = encs.find((x) => x.id === v.encargo_id)!; if (!ventas || e.user_id === user.id) p.encargos.push(e); }
      if (!p.localidad && v.direccion) p.localidad = localidadDe(v.direccion);
    }
    const delDiaRutas = rutas.results.filter((r) => r.fecha === fecha).map((r) => ({ chofer: r.chofer, orden: (JSON.parse(r.orden || '[]') as string[]).map(String) }));
    for (const [i, p] of paradas.entries()) {
      if (delDiaRutas.length) p.chofer = (delDiaRutas.find((r) => r.orden.some((c) => esDeLaParada(c, p.clave))) ?? delDiaRutas[0]).chofer;
      const propio = p.propio;
      delete p.propio;
      if (p.anonima) {
        p.clave = `otro-${i}`;
        p.nombre = propio?.nombre ?? 'Un cliente'; p.direccion = propio?.direccion ?? null; p.company_id = null; p.lugar_id = null; p.detalle = [...new Set(p.detalle.map((d) => (d.startsWith('Entrega') ? 'Entrega' : d.startsWith('Encargo') ? 'Encargo' : d)))]; }
    }
    paradas.sort((a, b) => Number(b.encargos.length > 0) - Number(a.encargos.length > 0) || Number(a.anonima) - Number(b.anonima) || a.nombre.localeCompare(b.nombre));
    return { fecha, feriado: feriados.results.find((f) => f.fecha === fecha)?.nombre ?? null, armado: delDiaRutas.length > 0, paradas };
  });
  return { hoy, dias: out, puede_organizar: organiza(user), puede_pedir: puedePedir(user) };
}
// La localidad de una dirección: lo que va después de la primera coma («Av. Libertador 1855, Vicente López»).
function localidadDe(d: string | null | undefined) {
  const partes = String(d ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return partes.length > 1 ? partes[1].replace(/\b(caba|c\.?a\.?b\.?a\.?)\b/i, 'CABA').slice(0, 40) : null;
}

// ---------- Remito de traslado ----------

export interface RecorridosConfig { remito_pv: string; remito_ultimo: number; planilla_id: string; alias: Record<string, number> }
const PLANILLA = '1a2ZsA3leiyAZu51pQh2yoC184cAUj0drEAKi4r6FRRk';
export async function recorridosConfig(db: D1Database): Promise<RecorridosConfig> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'recorridos'").first<{ value: string }>();
  let c: Partial<RecorridosConfig> = {};
  try { c = r ? JSON.parse(r.value) : {}; } catch { /* rota: la de siempre */ }
  return { remito_pv: String(c.remito_pv ?? '0001'), remito_ultimo: Number(c.remito_ultimo) || 0, planilla_id: String(c.planilla_id || PLANILLA), alias: c.alias && typeof c.alias === 'object' ? c.alias : {} };
}
export async function guardarRecorridosConfig(db: D1Database, ctx: Ctx, b: Partial<RecorridosConfig>) {
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Lo cambia un administrador.');
  const c = await recorridosConfig(db);
  if (b.remito_ultimo !== undefined) { const n = Number(b.remito_ultimo); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'El número tiene que ser entero.'); c.remito_ultimo = n; }
  if (b.remito_pv !== undefined) c.remito_pv = String(b.remito_pv).replace(/\D/g, '').slice(0, 5).padStart(4, '0') || '0001';
  if (b.planilla_id !== undefined) c.planilla_id = String(b.planilla_id).match(/[-\w]{25,}/)?.[0] ?? c.planilla_id;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('recorridos', ?)").bind(JSON.stringify(c)).run();
  return c;
}

// El número del remito de traslado de un encargo: el que tiene o, la primera vez, el siguiente (el mismo número que seguía
// la planilla).
export async function numerarRemito(db: D1Database, ctx: Ctx, id: number) {
  exigirPedir(ctx);
  const e = await encargoPorId(db, id);
  if (e.remito) return { remito: e.remito };
  const r = await db.prepare(`UPDATE settings SET value = json_set(value, '$.remito_ultimo', COALESCE(json_extract(value, '$.remito_ultimo'), 0) + 1)
    WHERE key = 'recorridos' RETURNING json_extract(value, '$.remito_ultimo') AS n`).first<{ n: number }>();
  if (!r) throw new HttpError(500, 'Falta la configuración del remito.');
  // Si otro lo numeró recién, queda el primero.
  await db.prepare('UPDATE encargos SET remito = COALESCE(remito, ?) WHERE id = ?').bind(r.n, id).run();
  return { remito: (await encargoPorId(db, id)).remito };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// El remito de traslado (el informal, «no válido como factura») para imprimir: dos copias en una hoja A4, una queda en el
// destino y la firmada vuelve a Formas. Con la marca de Formas y los datos de la empresa de la planilla.
export async function remitoHtml(db: D1Database, user: User, id: number) {
  const e = await encargoPorId(db, id);
  if (esVentas(user) && e.user_id !== user.id) throw new HttpError(403, 'Es un encargo de otra persona.');
  const cfg = await recorridosConfig(db);
  const numero = e.remito ? `N° ${cfg.remito_pv}-${String(e.remito).padStart(9, '0')}` : 'Sin numerar';
  const [y, m, d] = e.fecha.split('-');
  const filas = (items: ItemEnc[]) => items.map((i) => `<tr><td class="c">${i.cant != null ? esc(new Intl.NumberFormat('es-AR').format(i.cant)) : ''}</td><td class="c">${esc(i.pdv ?? '')}</td><td>${esc(i.que)}</td></tr>`).join('');
  const vacias = (n: number) => Array.from({ length: Math.max(0, n) }, () => '<tr><td>&nbsp;</td><td></td><td></td></tr>').join('');
  const items = e.llevar.length ? e.llevar : e.retirar;
  const titulo = e.llevar.length ? 'Remito de traslado de mercadería' : 'Constancia de retiro de mercadería';
  const copia = (cual: string) => `
  <section class="remito">
    <header>
      <div class="marca"><img src="/login/formas-logo.png" alt="Formas"><div class="empresa"><b>Formas Publicitarias SA</b><span>B. Matienzo 1308 · Florida (1602), Buenos Aires</span><span>Responsable Inscripto · Ing. Brutos CM 901-227475-1 · Inic. Act. 1/1/2007</span></div></div>
      <div class="letra"><b>R</b><span>No válido como factura</span></div>
      <div class="datos"><b>${esc(titulo)}</b><span class="num">${esc(numero)}</span><span>Fecha: ${esc(`${d}/${m}/${y}`)}</span><span class="copia">${esc(cual)}</span></div>
    </header>
    <div class="destino"><div><span>Señor/es</span><b>${esc(e.destino)}</b></div><div><span>Dirección</span><b>${esc(e.direccion ?? '')}</b></div>
      ${e.contacto ? `<div><span>Atención</span><b>${esc(e.contacto)}</b></div>` : ''}</div>
    <table><thead><tr><th style="width:16%">Cantidad</th><th style="width:16%">PDV</th><th>Producto</th></tr></thead>
      <tbody>${filas(items)}${vacias(6 - items.length)}</tbody></table>
    ${e.llevar.length && e.retirar.length ? `<p class="nota"><b>Además se retira:</b> ${esc(e.retirar.map((i) => [i.cant, i.que, i.pdv ? `(PDV ${i.pdv})` : ''].filter(Boolean).join(' ')).join(' · '))}</p>` : ''}
    ${e.notas ? `<p class="nota">${esc(e.notas)}</p>` : ''}
    <footer><div>Recibí conforme<br><span>Firma</span></div><div><br><span>Aclaración</span></div><div><br><span>DNI</span></div></footer>
  </section>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)} ${esc(numero)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef0f6; color: #11143a; font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .hoja { max-width: 190mm; margin: 16px auto; background: #fff; padding: 0; }
  .barra { max-width: 190mm; margin: 16px auto 0; display: flex; gap: 8px; align-items: center; }
  .barra button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: #000085; color: #fff; cursor: pointer; }
  .barra span { color: #4a4e6e; }
  .remito { padding: 9mm 10mm; height: 138mm; display: flex; flex-direction: column; gap: 4mm; }
  .remito + .remito { border-top: 1px dashed #9aa0bf; }
  header { display: grid; grid-template-columns: 1fr auto 1fr; gap: 5mm; align-items: start; border-bottom: 2px solid #000085; padding-bottom: 3mm; }
  .marca { display: flex; gap: 3mm; align-items: center; } .marca img { width: 30mm; }
  .empresa { display: flex; flex-direction: column; font-size: 9.5px; color: #3b3f63; } .empresa b { font-size: 11px; color: #11143a; }
  .letra { border: 1.5px solid #11143a; width: 15mm; text-align: center; padding: 1mm 0; } .letra b { font-size: 22px; display: block; line-height: 1; } .letra span { font-size: 6.5px; display: block; }
  .datos { display: flex; flex-direction: column; align-items: flex-end; text-align: right; } .datos b { text-transform: uppercase; font-size: 11px; letter-spacing: .02em; }
  .num { font-variant-numeric: tabular-nums; font-weight: 600; } .copia { margin-top: 1mm; font-size: 9px; text-transform: uppercase; color: #6a1; font-weight: 700; letter-spacing: .06em; }
  .destino { display: grid; grid-template-columns: 1fr 1.4fr; gap: 1mm 6mm; } .destino div { display: flex; flex-direction: column; } .destino span { font-size: 9px; text-transform: uppercase; color: #6b6f8e; } .destino b { font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 9.5px; text-transform: uppercase; color: #fff; background: #000085; padding: 1.5mm 2mm; }
  td { border-bottom: 1px solid #d9dcea; padding: 1.6mm 2mm; } td.c { text-align: center; font-variant-numeric: tabular-nums; }
  .nota { margin: 0; font-size: 11px; color: #3b3f63; }
  footer { margin-top: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; } footer div { border-top: 1px solid #11143a; padding-top: 1mm; font-size: 10px; } footer span { color: #6b6f8e; }
  @media print { body { background: #fff; } .barra { display: none; } .hoja { margin: 0; max-width: none; } }
</style></head><body>
<div class="barra"><button type="button" onclick="window.print()">Imprimir</button><span>${esc(e.remito ? 'Dos copias: una queda en el destino, la firmada vuelve a Formas.' : 'Todavía sin número: se numera al imprimirlo desde el Hub.')}</span></div>
<main class="hoja">${copia('Original · para el destino')}${copia('Duplicado · vuelve firmado a Formas')}</main>
<script>if (location.hash === '#imprimir') window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body></html>`;
}

// ---------- El historial de la planilla ----------

// Trae el historial de la planilla «Recorridos» (una pestaña por mes) para que las sugerencias funcionen desde el primer
// día: a dónde manda cada uno y qué días se va a cada lugar. Se lee con la Sheets API como quien lo pide (la cuenta de
// servicio con el permiso de Drive de la delegación), así que tiene que poder abrir la planilla. Solo los días que ya
// pasaron; quedan como historial (origen «planilla»): no aparecen en el cronograma, que de esos días ya tiene ClickUp. Se
// puede repetir: lo que ya está no se duplica (las pestañas tienen filas copiadas de otros meses) y completa a quién
// pidió cada uno si se agregó un alias.
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const SHEETS = (env: Env) => env.SHEETS_API_URL ?? 'https://sheets.googleapis.com/v4/spreadsheets';
export async function importarHistorial(env: Env, ctx: Ctx, b: { meses?: unknown; alias?: unknown }) {
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'El historial lo trae un administrador.');
  if (!env.GOOGLE_SA_JSON) throw new HttpError(400, 'Falta la cuenta de servicio de Google (GOOGLE_SA_JSON).');
  const db = env.DB;
  const cfg = await recorridosConfig(db);
  if (b.alias && typeof b.alias === 'object') {
    for (const [k, v] of Object.entries(b.alias as Record<string, unknown>)) { const n = Number(v); if (n) cfg.alias[norm(k).replace(/[^a-z]/g, '')] = n; else delete cfg.alias[norm(k).replace(/[^a-z]/g, '')]; }
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('recorridos', ?)").bind(JSON.stringify(cfg)).run();
  }
  let token: string;
  try { token = await serviceToken(env, ctx.user.email, 'https://www.googleapis.com/auth/drive'); }
  catch (e) { throw new HttpError(400, `Google no dio acceso: ${(e as Error).message}. La cuenta de servicio necesita el permiso de Drive en la delegación de todo el dominio.`); }
  const get = async (path: string) => {
    const res = await fetch(`${SHEETS(env)}/${cfg.planilla_id}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(400, `La planilla no se pudo leer (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}. ¿Tu usuario la puede abrir?`);
    return res.json();
  };
  const meta = await get('?fields=sheets.properties.title') as { sheets?: Array<{ properties: { title: string } }> };
  const hoy = hoyBsAs();
  const pestañas = (meta.sheets ?? []).map((s) => s.properties.title).map((t) => {
    const m = norm(t).match(/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(20\d\d)$/);
    return m ? { titulo: t, mes: MESES.indexOf(m[1]) + 1, anio: Number(m[2]) } : null;
  }).filter((x): x is { titulo: string; mes: number; anio: number } => !!x && `${x.anio}-${String(x.mes).padStart(2, '0')}` <= hoy.slice(0, 7))
    .sort((a, b) => b.anio - a.anio || b.mes - a.mes).slice(0, Math.min(Math.max(Number(b.meses) || 6, 1), 24));
  const [usuarios, lugares] = await Promise.all([
    db.prepare('SELECT id, name FROM users WHERE deleted_at IS NULL').all<{ id: number; name: string }>(),
    db.prepare('SELECT id, nombre, direccion, localidad, zona, company_id FROM lugares').all<{ id: number; nombre: string; direccion: string | null; localidad: string | null; zona: string | null; company_id: number | null }>(),
  ]);
  const porNombre = new Map<string, typeof lugares.results>();
  for (const l of lugares.results) { const k = norm(l.nombre).replace(/\s+/g, ' '); porNombre.set(k, [...(porNombre.get(k) ?? []), l]); }
  const quien = quienEs(usuarios.results, cfg.alias);
  const filas: Array<Record<string, unknown>> = [];
  const nombres = new Map<string, { filas: number; user_id: number | null }>();
  for (const p of pestañas) {
    const r = await get(`/values/${encodeURIComponent(`'${p.titulo}'!A1:Z`)}?valueRenderOption=FORMATTED_VALUE`) as { values?: string[][] };
    const valores = r.values ?? [];
    const cab = (valores.shift() ?? []).map((h) => norm(h));
    const col = (re: RegExp) => cab.findIndex((h) => re.test(h));
    const I = { fecha: col(/^fecha/), estado: col(/^entrega$|^estado/), prioridad: col(/prioridad/), resp: col(/^responsable$/), desde: col(/^desde/), destino: col(/^destino/),
      dir: col(/^direcc/), loc: col(/^localidad/), horario: col(/^horario/), deja: col(/^deja|egreso/), retira: col(/^retira/), obs: col(/observ/) };
    if (I.fecha < 0 || I.destino < 0) continue;
    for (const f of valores) {
      const v = (i: number, max = 600) => (i < 0 ? '' : String(f[i] ?? '').replace(/\s+/g, ' ').trim().slice(0, max));
      const fecha = fechaPlanilla(v(I.fecha), p.mes, p.anio);
      const destinoTxt = v(I.destino, 160), dirTxt = v(I.dir, 300), deja = v(I.deja, 600), retira = v(I.retira, 600), resp = v(I.resp, 60);
      if (!fecha || fecha >= hoy || (!destinoTxt && !dirTxt) || (!deja && !retira && !destinoTxt)) continue;
      const cands = destinoTxt ? porNombre.get(norm(destinoTxt).replace(/\s+/g, ' ')) ?? [] : [];
      const l = cands.length === 1 ? cands[0] : cands.find((x) => dirTxt && x.direccion && claveCalle(x.direccion) === claveCalle(dirTxt)) ?? (cands.length && new Set(cands.map((x) => claveCalle(x.direccion ?? ''))).size === 1 ? cands[0] : null);
      const loc = v(I.loc, 80);
      const direccion = dirTxt ? (loc && !norm(dirTxt).includes(norm(loc)) ? `${dirTxt}, ${loc}` : dirTxt) : l?.direccion ? direccionLugar(l) : null;
      const est = norm(v(I.estado));
      const estado: EstadoEnc = /no habia|cancel/.test(est) ? 'cancelado' : /^no /.test(est) ? 'no_se_pudo' : 'hecho';
      const uid = resp ? quien(resp) : null;
      const kResp = norm(resp).replace(/[^a-z]/g, '');
      if (kResp) { const x = nombres.get(resp.toUpperCase()) ?? { filas: 0, user_id: uid }; x.filas++; nombres.set(resp.toUpperCase(), x); }
      const desdeTxt = norm(v(I.desde));
      filas.push({
        fecha, user_id: uid, pedido_por: resp || null, lugar_id: l?.id ?? null, company_id: l?.company_id ?? null, destino: destinoTxt || dirTxt, direccion,
        llevar: JSON.stringify(deja ? [{ cant: null, que: deja, pdv: null }] : []), retirar: JSON.stringify(retira ? [{ cant: null, que: retira, pdv: null }] : []),
        desde: /oficina/.test(desdeTxt) ? 'matienzo' : /deposito/.test(desdeTxt) ? 'roca' : null, horario: v(I.horario, 120) || null, notas: v(I.obs, 1000) || null,
        urgente: /alta|urgen/.test(norm(v(I.prioridad))) ? 1 : 0, estado, motivo: estado === 'hecho' ? null : v(I.estado, 120) || null,
        clave: [fecha, norm(destinoTxt || dirTxt), norm(deja), norm(retira), kResp].map((x) => x.slice(0, 70)).join('|'),
      });
    }
  }
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < filas.length; i += 300) {
    stmts.push(db.prepare(`INSERT INTO encargos (fecha, user_id, pedido_por, lugar_id, company_id, destino, direccion, llevar, retirar, desde, horario, notas, urgente, estado, motivo,
        origen, planilla_clave, created_at, updated_at)
      SELECT json_extract(value, '$.fecha'), json_extract(value, '$.user_id'), json_extract(value, '$.pedido_por'), json_extract(value, '$.lugar_id'), json_extract(value, '$.company_id'),
        json_extract(value, '$.destino'), json_extract(value, '$.direccion'), json_extract(value, '$.llevar'), json_extract(value, '$.retirar'), json_extract(value, '$.desde'),
        json_extract(value, '$.horario'), json_extract(value, '$.notas'), json_extract(value, '$.urgente'), json_extract(value, '$.estado'), json_extract(value, '$.motivo'),
        'planilla', json_extract(value, '$.clave'), ?2, ?2
      FROM json_each(?1) WHERE true
      ON CONFLICT(planilla_clave) DO UPDATE SET user_id = COALESCE(encargos.user_id, excluded.user_id), lugar_id = COALESCE(encargos.lugar_id, excluded.lugar_id),
        company_id = COALESCE(encargos.company_id, excluded.company_id)`).bind(JSON.stringify(filas.slice(i, i + 300)), ts));
  }
  if (stmts.length) await db.batch(stmts);
  const total = await db.prepare("SELECT COUNT(*) AS n FROM encargos WHERE origen = 'planilla'").first<{ n: number }>();
  return {
    pestañas: pestañas.map((p) => p.titulo), filas: filas.length, en_el_hub: total?.n ?? 0,
    quienes: [...nombres.entries()].sort((a, b) => b[1].filas - a[1].filas).map(([nombre, x]) => ({ nombre, filas: x.filas, user_id: x.user_id })),
  };
}

// La fecha de una fila: viene como «2/11/2026», «04-05-2026», «17/11» (sin año), «18//08» o «21/072026». Sin año, el de la
// pestaña. Si queda lejos del mes de la pestaña, el día con el mes de la pestaña.
export function fechaPlanilla(s: string, mes: number, anio: number) {
  const n = s.match(/\d+/g);
  if (!n || n.length < 2) return null;
  let d = Number(n[0]), m = Number(n[1]), y = n[2] ? Number(n[2]) : anio;
  if (!n[2] && n[1].length > 2) { m = Number(n[1].slice(0, n[1].length - 4)); y = Number(n[1].slice(-4)); }
  // Sin año, el más cercano a la pestaña: «30/12» en la de enero es de diciembre del año anterior.
  else if (!n[2]) y = [anio, anio - 1, anio + 1].sort((a, b) => Math.abs(a * 12 + m - (anio * 12 + mes)) - Math.abs(b * 12 + m - (anio * 12 + mes)))[0];
  if (y < 100) y += 2000;
  const ok = (dd: number, mm: number, yy: number) => { const t = new Date(Date.UTC(yy, mm - 1, dd)); return t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd; };
  const lejos = Math.abs((y * 12 + m) - (anio * 12 + mes)) > 1;
  if (!ok(d, m, y) || lejos) { if (!ok(d, mes, anio)) return null; m = mes; y = anio; }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Quién es cada nombre de la columna RESPONSABLE: por el alias que se haya guardado, o por el nombre de pila (con los
// sobrenombres de siempre: Gonza, Agus, Mili, Ale…) y, si hay más de uno, por el apellido («ALE NOMS», «ALE. SALAS»).
const APODOS: Record<string, string[]> = {
  gonza: ['gonzalo'], agus: ['agustin', 'agustina'], mili: ['milagros', 'micaela', 'emilia', 'milena'], ale: ['alejandro', 'alejandra', 'alexis'], adri: ['adrian', 'adriana'],
  sole: ['soledad'], flor: ['florencia'], juli: ['julieta', 'julian', 'juliana'], caro: ['carolina'], rorro: ['rodrigo'], majo: ['maria jose'], joaco: ['joaquin'],
  edu: ['eduardo'], nico: ['nicolas'], fede: ['federico'], lu: ['lucia', 'luciana'], vicky: ['victoria'], lari: ['larisa', 'larissa'], eli: ['elizabeth', 'eliana', 'elisa'],
  miche: ['michelle', 'micaela'], georgi: ['georgina'], romi: ['romina'], marian: ['mariana'], pato: ['patricia', 'patricio'], santi: ['santiago'], guille: ['guillermo'],
};
export function quienEs(usuarios: Array<{ id: number; name: string }>, alias: Record<string, number> = {}) {
  const us = usuarios.map((u) => ({ id: u.id, partes: norm(u.name).split(/[^a-z]+/).filter(Boolean) }));
  return (nombre: string): number | null => {
    const k = norm(nombre).replace(/[^a-z]/g, '');
    if (alias[k]) return alias[k];
    const t = norm(nombre).split(/[^a-z]+/).filter(Boolean);
    if (!t.length) return null;
    const pila = (p: string) => p === t[0] || (t[0].length >= 3 && p.startsWith(t[0])) || (APODOS[t[0]] ?? []).some((a) => a.split(' ')[0] === p);
    let c = us.filter((u) => u.partes.length && pila(u.partes[0]));
    if (c.length > 1 && t[1]) c = c.filter((u) => u.partes.slice(1).some((p) => p.startsWith(t[1]) || (t[1].length === 1 && p[0] === t[1])));
    return c.length === 1 ? c[0].id : null;
  };
}
