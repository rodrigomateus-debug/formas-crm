import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { esVentas, visibleSql } from './alcance';
import { norm } from './clickup';
import { CERRADOS } from './produccion';
import { serviceToken } from './google';
import {
  SELECT_ENC, aEncargo, actualizarLugares, anfitrion, avisarEncargo, claveCalle, claveEncargo, claveParada, cronogramaConfig, diaSemana, direccionLugar, encargosEntre,
  esDeLaParada, esDia, hoyBsAs, infoLugar, claveDireccion, ubicar, lugaresPara, lugaresPorId, mismoSitio, movimientos, puedeEditarCronograma, reindexarLugares, sumarDias, unicoLugar,
  type EncargoDia, type EncargoFila, type EstadoEnc, type ItemEnc, type Lugar, type Sitio,
} from './cronograma';
import { direccionesDePedidos, lugar as lugarGoogle } from './direcciones';
import { esTipo } from './destinos';
import { zonaDe, type Zona } from '../../web/src/zonas';

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
async function crearLugar(db: D1Database, ctx: Ctx, l: { nombre: string; direccion: string; company_id?: number | null; localidad?: string | null; provincia?: string | null; horario?: string | null; contacto?: string | null; telefono?: string | null; observaciones?: string | null }) {
  const r = await db.prepare(`INSERT INTO lugares (nombre, direccion, localidad, provincia, horario, contacto, telefono, observaciones, clave_dir, origen, activo, company_id, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hub', 1, ?, ?, ?) RETURNING id`)
    .bind(l.nombre.slice(0, 160), l.direccion.slice(0, 300), l.localidad ?? null, l.provincia ?? null, l.horario ?? null, l.contacto ?? null, l.telefono ?? null, l.observaciones ?? null,
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
  // Los próximos días que el recorrido pasa cerca (a menos de RADIO_CERCA metros) sin ir justo ahí.
  cerca?: Cerca[];
  dominio?: string | null; zona?: Zona | null;   // para el logo y para agrupar por zona
}
const opcionLugar = (l: Lugar & { company_id?: number | null }, extra: Partial<DestinoOpcion> = {}): DestinoOpcion => ({
  tipo: 'lugar', key: `l:${l.id}`, nombre: l.nombre, direccion: l.direccion ? direccionLugar(l) : null, detalle: [l.horario, l.contacto].filter(Boolean).join(' · ') || null,
  lugar_id: l.id, company_id: l.company_id ?? null, horario: l.horario, contacto: [l.contacto, l.telefono].filter(Boolean).join(' · ') || null,
  zona: zonaDe({ zona: l.zona, localidad: l.localidad, direccion: l.direccion }), ...extra,
});
// El logo (dominio de la empresa) y la zona de cada destino, para que se reconozcan de un vistazo.
async function decorar(db: D1Database, destinos: DestinoOpcion[]) {
  const dom = await dominios(db, destinos.map((d) => d.company_id));
  for (const d of destinos) {
    if (d.company_id && dom.has(d.company_id)) d.dominio = dom.get(d.company_id);
    if (d.zona === undefined || d.zona === null) d.zona = d.tipo === 'base' ? null : zonaDe({ direccion: d.direccion });
  }
  return destinos;
}

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
  return { destinos: await decorar(db, out.slice(0, 30)) };
}

// Agregar o corregir un destino de la libreta desde el Hub. Lo que se corrige acá la planilla ya no lo pisa.
export async function guardarDestino(env: Env, ctx: Ctx, id: number | null, b: Record<string, unknown>) {
  exigirPedir(ctx);
  const db = env.DB;
  const nombre = texto(b.nombre, 160), direccion = texto(b.direccion, 300);
  const campos = { localidad: texto(b.localidad, 80), provincia: texto(b.provincia, 80), codigo_postal: texto(b.codigo_postal, 12), sucursal: texto(b.sucursal, 120),
    horario: texto(b.horario, 160), contacto: texto(b.contacto, 160), telefono: texto(b.telefono, 60), whatsapp: texto(b.whatsapp, 60), email: texto(b.email, 160),
    observaciones: texto(b.observaciones, 600) };
  if (campos.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(campos.email)) throw new HttpError(400, 'El mail no parece válido.');
  // Elegida de Google Maps: el servidor le vuelve a pedir el lugar a Google (calle y altura, localidad, provincia, CP y el punto).
  let google: Awaited<ReturnType<typeof lugarGoogle>> | null = null;
  const placeId = typeof b.place_id === 'string' && b.place_id ? b.place_id : null;
  if (placeId) {
    const previo = id != null ? await db.prepare('SELECT place_id FROM lugares WHERE id = ?').bind(id).first<{ place_id: string | null }>() : null;
    if (previo?.place_id !== placeId) google = await lugarGoogle(env, placeId, typeof b.sesion === 'string' ? b.sesion : undefined);
  }
  const dirFinal = google ? (google.calle || google.direccion.split(',')[0]) : direccion;
  if (google) { campos.localidad = google.localidad ?? campos.localidad; campos.provincia = google.provincia ?? campos.provincia; campos.codigo_postal = google.codigo_postal ?? campos.codigo_postal; }
  const tipo = b.tipo === undefined ? undefined : esTipo(b.tipo) ? b.tipo : null;
  if (id == null) {
    if (!nombre || !dirFinal) throw new HttpError(400, 'El destino necesita el nombre y la dirección.');
    const nuevo = await crearLugar(db, ctx, { nombre, direccion: dirFinal, ...campos, company_id: organiza(ctx.user) ? Number(b.company_id) || null : null });
    const extra: string[] = [], vals: unknown[] = [];
    for (const k of ['codigo_postal', 'sucursal', 'whatsapp', 'email'] as const) if (campos[k]) { extra.push(`${k} = ?`); vals.push(campos[k]); }
    if (tipo) { extra.push("tipo = ?", "tipo_origen = 'manual'"); vals.push(tipo); }
    if (google) { extra.push('place_id = ?'); vals.push(google.place_id); }
    if (organiza(ctx.user) && Number(b.grupo_id)) { extra.push('grupo_id = ?'); vals.push(Number(b.grupo_id)); }
    if (extra.length) await db.prepare(`UPDATE lugares SET ${extra.join(', ')} WHERE id = ?`).bind(...vals, nuevo).run();
    if (google) await puntoDeGoogle(db, nuevo, google);
    return { id: nuevo };
  }
  const l = await db.prepare('SELECT id, origen, created_by FROM lugares WHERE id = ?').bind(id).first<{ id: number; origen: string; created_by: number | null }>();
  if (!l) throw new HttpError(404, 'Ese destino ya no está.');
  // La libreta la corrige Logística (y quien edita el cronograma); los demás, los destinos que cargaron ellos.
  if (!organiza(ctx.user) && !(l.origen === 'hub' && l.created_by === ctx.user.id)) throw new HttpError(403, 'Los destinos de la libreta los corrige Logística. Si algo está mal, avisale.');
  const sets: string[] = [], vals: unknown[] = [];
  if (b.nombre !== undefined) { if (!nombre) throw new HttpError(400, 'El nombre no puede quedar vacío.'); sets.push('nombre = ?'); vals.push(nombre); }
  if (b.direccion !== undefined || google) { sets.push('direccion = ?', 'clave_dir = ?'); vals.push(dirFinal, dirFinal ? claveCalle(dirFinal) || null : null); }
  for (const k of Object.keys(campos) as Array<keyof typeof campos>) if (b[k] !== undefined || (google && ['localidad', 'provincia', 'codigo_postal'].includes(k))) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  if (google) { sets.push('place_id = ?'); vals.push(google.place_id); }
  else if (b.direccion !== undefined && b.place_id === null) sets.push('place_id = NULL');
  if (tipo !== undefined) { sets.push('tipo = ?', 'tipo_origen = ?'); vals.push(tipo, tipo ? 'manual' : null); }
  if (b.grupo_id !== undefined) { if (!organiza(ctx.user)) throw new HttpError(403, 'Agrupar destinos es de Logística.'); sets.push('grupo_id = ?'); vals.push(Number(b.grupo_id) || null); }
  if (b.company_id !== undefined && organiza(ctx.user)) { sets.push('company_id = ?'); vals.push(Number(b.company_id) || null); }
  // Borrar (o recuperar) un destino: Logística cualquiera; los demás, los que cargaron ellos en el Hub (ya pasaron el control de arriba).
  if (b.activo !== undefined) { sets.push('activo = ?'); vals.push(b.activo ? 1 : 0); }
  if (!sets.length) return { id };
  // Corregido a mano: lo que había dicho la IA ya no vale (si quedó incompleto, la IA lo vuelve a mirar).
  if (b.direccion !== undefined || b.localidad !== undefined || b.provincia !== undefined || google) sets.push('ia_estado = NULL', 'ia_nota = NULL', 'ia_sugerida = NULL');
  await db.prepare(`UPDATE lugares SET ${sets.join(', ')}, editado = 1, updated_at = ? WHERE id = ?`).bind(...vals, now(), id).run();
  if (google) await puntoDeGoogle(db, id, google);
  if (b.grupo_id !== undefined) await db.prepare('DELETE FROM destino_grupos WHERE id NOT IN (SELECT grupo_id FROM lugares WHERE grupo_id IS NOT NULL)').run();
  await reindexarLugares(db, [id]);
  return { id };
}

// El punto de Google del destino va al mapa (el de la ruta del cronograma), salvo que alguien lo haya corrido a mano.
async function puntoDeGoogle(db: D1Database, id: number, g: { lat: number | null; lng: number | null }) {
  if (g.lat == null || g.lng == null) return;
  const l = await db.prepare('SELECT direccion, localidad, provincia, zona FROM lugares WHERE id = ?').bind(id).first<{ direccion: string | null; localidad: string | null; provincia: string | null; zona: string | null }>();
  const dir = l ? direccionLugar(l) : '', clave = claveDireccion(dir);
  if (!clave) return;
  await db.prepare(`INSERT INTO geocodigos (clave, direccion, lat, lng, ok, manual, at) VALUES (?, ?, ?, ?, 1, 0, ?)
    ON CONFLICT (clave) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, ok = 1, at = excluded.at WHERE geocodigos.manual = 0`).bind(clave, dir, g.lat, g.lng, now()).run();
}

// ---------- Cuándo se va a cada lugar ----------

// Un viaje previsto (o hecho) a un lugar un día: un movimiento de ClickUp o un encargo.
interface Viaje extends Sitio {
  fecha: string; tipo: 'entrega' | 'retiro' | 'egreso' | 'encargo'; detalle: string; propio: boolean; encargo_id?: number; record_id?: number | null;
  lat?: number | null; lng?: number | null;   // el punto, si ya se sabe (la dirección validada de la tarjeta Entrega)
  anonimo?: boolean;                          // para la vendedora, la entrega a un cliente de otra: no se dice el nombre
}
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
      const dir = ds.find((d) => !d.retira);
      viajes.push({ fecha: m.fecha, tipo: 'entrega', clave: claveParada(m), nombre: m.cliente ?? '', company_id: p?.company_id ?? null, direccion: dir?.direccion ?? null,
        lat: dir?.validada ? dir.lat : null, lng: dir?.validada ? dir.lng : null, anonimo: !suyo,
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
    ...prod.results.map((p) => ({ fecha: p.fecha, nombre: p.nombre, company_id: p.company_id, direccion: null, lugar_id: null as number | null }))];
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

// ---------- Cerca: el recorrido ya pasa al lado ----------

export interface Cerca { fecha: string; nombre: string; metros: number }
// «Cerca» es a menos de 2 km en línea recta de una parada que ya está ese día: en el AMBA es un desvío de 5 a 10 minutos,
// lo que Logística suma sin rearmar el recorrido.
const RADIO_CERCA = 2000;
type Pto = { lat: number; lng: number };
function metrosEntre(a: Pto, b: Pto) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Los retiros y egresos de ClickUp no traen dirección: la de la libreta (con su localidad y su zona) o la de la empresa.
async function direccionesDeViajes(db: D1Database, viajes: Viaje[]) {
  const sinDir = viajes.filter((v) => !v.direccion && v.lat == null);
  const out = new Map<Viaje, { direccion: string; localidad: string | null; zona: string | null }>();
  if (!sinDir.length) return out;
  const ids = [...new Set(sinDir.map((v) => v.company_id).filter((x): x is number => !!x))];
  const [deEmpresa, empresas, porNombre] = await Promise.all([
    ids.length ? db.prepare('SELECT * FROM lugares WHERE activo = 1 AND company_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<Lugar & { company_id: number }>().then((r) => r.results)
      : Promise.resolve([] as Array<Lugar & { company_id: number }>),
    ids.length ? db.prepare("SELECT id, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city FROM records WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids)).all<{ id: number; address: string | null; city: string | null }>().then((r) => new Map(r.results.map((e) => [e.id, e])))
      : Promise.resolve(new Map<number, { id: number; address: string | null; city: string | null }>()),
    lugaresPara(db, [...new Set(sinDir.map((v) => v.nombre).filter(Boolean))]),
  ]);
  for (const v of sinDir) {
    const l = (v.company_id ? deEmpresa.find((x) => x.company_id === v.company_id) : undefined) ?? unicoLugar(porNombre.get(v.nombre)?.exactos ?? []);
    const e = v.company_id ? empresas.get(v.company_id) : undefined;
    if (l?.direccion) out.set(v, { direccion: direccionLugar(l), localidad: l.localidad, zona: l.zona });
    else if (e?.address) out.set(v, { direccion: [e.address, e.city].filter(Boolean).join(', '), localidad: e.city, zona: null });
  }
  return out;
}

// Los dominios de las empresas (para el logo).
async function dominios(db: D1Database, ids: Array<number | null | undefined>) {
  const l = [...new Set(ids.filter((x): x is number => !!x))];
  if (!l.length) return new Map<number, string>();
  const { results } = await db.prepare("SELECT id, NULLIF(json_extract(props, '$.domain'), '') AS d FROM records WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(l)).all<{ id: number; d: string | null }>();
  return new Map(results.filter((r) => r.d).map((r) => [r.id, String(r.d).trim().toLowerCase()]));
}

// Para cada destino, los días que el recorrido pasa cerca sin ir justo ahí (el más cercano de cada día). Usa los puntos que ya
// se ubicaron en el mapa (los de la ruta del día y las direcciones validadas de las entregas); lo que falta se busca en el
// fondo, para la próxima vez que se abra.
async function cercanias(env: Env, destinos: DestinoOpcion[], viajes: Viaje[], enFondo?: (p: Promise<unknown>) => void) {
  if (!destinos.length) return;
  const db = env.DB;
  const hoy = hoyBsAs();
  const futuros = viajes.filter((v) => v.fecha >= hoy);
  const dirDe = await direccionesDeViajes(db, futuros);
  const dirViaje = (v: Viaje) => v.direccion ?? dirDe.get(v)?.direccion ?? null;
  const todas = [...new Set([...destinos.map((d) => d.direccion), ...futuros.filter((v) => v.lat == null).map(dirViaje)].filter((x): x is string => !!x))];
  const { geo } = await ubicar(env, todas, false);
  const faltan = todas.filter((d) => !geo.has(claveDireccion(d)));
  if (faltan.length && enFondo) enFondo(ubicar(env, faltan, true).catch(() => undefined));
  const punto = (dir: string | null): Pto | null => { const g = dir ? geo.get(claveDireccion(dir)) : null; return g ? { lat: g.lat, lng: g.lng } : null; };
  const conPunto = futuros.map((v) => ({ v, p: v.lat != null && v.lng != null ? { lat: v.lat, lng: v.lng } : punto(dirViaje(v)) }))
    .filter((x): x is { v: Viaje; p: Pto } => !!x.p);
  for (const d of destinos) {
    const p = punto(d.direccion);
    d.cerca = [];
    if (!p) continue;
    const yo: Sitio = { nombre: d.nombre, company_id: d.company_id, lugar_id: d.lugar_id, direccion: d.direccion };
    const porDia = new Map<string, Cerca>();
    for (const { v, p: q } of conPunto) {
      if (mismoSitio(yo, v)) continue;
      const m = metrosEntre(p, q);
      if (m > RADIO_CERCA) continue;
      const ya = porDia.get(v.fecha);
      if (!ya || m < ya.metros) porDia.set(v.fecha, { fecha: v.fecha, nombre: v.anonimo ? 'una entrega' : v.nombre, metros: Math.max(100, Math.round(m / 100) * 100) });
    }
    d.cerca = [...porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(0, 6);
  }
}

// Las sugerencias al cargar un encargo: los destinos a los que más manda esta persona (sus encargos de los últimos 6
// meses, también los de la planilla) y los de sus pedidos y negocios abiertos (el cliente, y el proveedor o el impresor de
// cada artículo que falta). Cada uno con los próximos días que ya se va y qué días se suele ir.
export async function sugerencias(env: Env, user: User, enFondo?: (p: Promise<unknown>) => void) {
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
  // Quien todavía no tiene destinos propios (recién empieza, no tiene pedidos abiertos): a dónde más va el recorrido, para
  // todos. A medida que carga encargos y pedidos, se achica hasta desaparecer y queda solo lo suyo.
  const propios = frecuentes.length + Math.min(dePedidos.length, 14);
  const generales = await masVisitados(db, user, new Set([...frecuentes, ...dePedidos].map((d) => d.key)), propios === 0 ? 9 : propios < 4 ? 6 : propios < 8 ? 3 : 0);
  const todos = [...frecuentes, ...dePedidos.slice(0, 14), ...generales];
  const { viajes } = await viajesEntre(db, user, hoy, sumarDias(hoy, 21));
  await enriquecer(db, user, todos, viajes);
  await cercanias(env, todos, viajes, enFondo);
  await decorar(db, todos);
  const cfg = await cronogramaConfig(db);
  return { frecuentes, de_pedidos: dePedidos.slice(0, 14), generales, bases: cfg.bases.map((x) => ({ id: x.id, nombre: x.nombre })), organiza: organiza(user) };
}
// Los lugares a los que más fue el recorrido en las últimas semanas (contando días, de todos): los encargos, el historial de
// la planilla y los retiros y egresos de ClickUp. Para el perfil Ventas, solo lugares de la libreta y proveedores: nunca
// el cliente de otra vendedora.
async function masVisitados(db: D1Database, user: User, excluir: Set<string>, cuantos: number): Promise<DestinoOpcion[]> {
  if (cuantos <= 0) return [];
  const hist = await historial(db, sumarDias(hoyBsAs(), -1));
  const grupos = new Map<string, { lugar_id: number | null; company_id: number | null; nombre: string; dias: Set<string> }>();
  for (const h of hist) {
    const k = h.lugar_id ? `l:${h.lugar_id}` : h.company_id ? `c:${h.company_id}` : `n:${norm(h.nombre)}`;
    const g = grupos.get(k) ?? { lugar_id: h.lugar_id ?? null, company_id: h.company_id ?? null, nombre: h.nombre, dias: new Set<string>() };
    g.dias.add(h.fecha);
    grupos.set(k, g);
  }
  const top = [...grupos.values()].filter((g) => g.dias.size >= 2).sort((a, b) => b.dias.size - a.dias.size).slice(0, 40);
  if (!top.length) return [];
  const ids = [...new Set(top.map((g) => g.company_id).filter((x): x is number => !!x))];
  const [lugares, deEmpresa, empresas, porNombre] = await Promise.all([
    lugaresPorId(db, top.map((g) => g.lugar_id)),
    ids.length ? db.prepare('SELECT * FROM lugares WHERE activo = 1 AND company_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<Lugar & { company_id: number }>().then((r) => r.results)
      : Promise.resolve([] as Array<Lugar & { company_id: number }>),
    ids.length ? db.prepare(`SELECT id, name, json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city, json_extract(props, '$.tipo_de_relacion') AS rel
        FROM records WHERE archived = 0 AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids))
      .all<{ id: number; name: string; address: string | null; city: string | null; rel: string | null }>().then((r) => new Map(r.results.map((e) => [e.id, e])))
      : Promise.resolve(new Map<number, { id: number; name: string; address: string | null; city: string | null; rel: string | null }>()),
    lugaresPara(db, [...new Set(top.filter((g) => !g.lugar_id && !g.company_id).map((g) => g.nombre))]),
  ]);
  const ventas = esVentas(user);
  // Un mismo lugar puede venir como encargo (lugar) y como retiro (empresa): se juntan los días.
  const porOpcion = new Map<string, { o: DestinoOpcion; dias: Set<string> }>();
  for (const g of top) {
    let o: DestinoOpcion | null = null;
    const l = g.lugar_id ? lugares.get(g.lugar_id) : g.company_id ? deEmpresa.find((x) => x.company_id === g.company_id) : unicoLugar(porNombre.get(g.nombre)?.exactos ?? []);
    if (l) o = opcionLugar(l as Lugar & { company_id: number | null });
    else if (g.company_id) {
      const e = empresas.get(g.company_id);
      const dir = e ? [e.address, e.city].filter(Boolean).join(', ') : '';
      if (e && dir && (!ventas || e.rel === 'proveedor')) o = { tipo: 'empresa', key: `c:${e.id}`, nombre: e.name, direccion: dir, detalle: null, lugar_id: null, company_id: e.id };
    }
    if (!o || excluir.has(o.key)) continue;
    const ya = porOpcion.get(o.key);
    if (ya) for (const d of g.dias) ya.dias.add(d); else porOpcion.set(o.key, { o, dias: new Set(g.dias) });
  }
  return [...porOpcion.values()].sort((a, b) => b.dias.size - a.dias.size).slice(0, cuantos)
    .map(({ o, dias }) => ({ ...o, veces: dias.size, motivo: `${dias.size} viajes del recorrido en ${SEMANAS} semanas` }));
}
const opsDe = (s: string | null) => {
  try { return (JSON.parse(s ?? '[]') as string[]).map((x) => { const [campo, id] = String(x).split(':'); return { campo, company_id: Number(id) }; }).filter((x) => x.company_id); }
  catch { return []; }
};

// Un destino elegido: lo que dice la libreta, los próximos días hábiles con lo que ya va ese día a ese lugar y si se suele
// ir, y los últimos encargos a ese lugar (para copiar el contacto o lo que se mandó).
export async function diasDelDestino(env: Env, user: User, q: { lugar_id?: string; company_id?: string; nombre?: string; direccion?: string }, enFondo?: (p: Promise<unknown>) => void) {
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
  await cercanias(env, [destino], viajes, enFondo);
  await decorar(db, [destino]);
  const yo: Sitio = { nombre: destino.nombre, company_id: destino.company_id, lugar_id: destino.lugar_id, direccion: destino.direccion };
  const fer = new Map(feriados.results.map((f) => [f.fecha, f.nombre]));
  const dias: Array<{ fecha: string; feriado: string | null; viajes: string[]; propios: number; habitual: boolean; cuantos: number; cerca: Cerca | null }> = [];
  for (let d = hoy; dias.length < 12 && d <= hasta; d = sumarDias(d, 1)) {
    if ([0, 6].includes(diaSemana(d))) continue;
    const delDia = viajes.filter((v) => v.fecha === d);
    const aca = delDia.filter((v) => mismoSitio(yo, v));
    dias.push({ fecha: d, feriado: fer.get(d) ?? null, viajes: [...new Set(aca.map((v) => v.detalle))], propios: aca.filter((v) => v.propio).length,
      habitual: !!destino.habitual?.dias.includes(diaSemana(d)), cuantos: new Set(delDia.map((v) => v.clave)).size,
      cerca: aca.length ? null : destino.cerca?.find((c) => c.fecha === d) ?? null });
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
  const [lugares, dirDe] = await Promise.all([lugaresPorId(db, encs.map((e) => e.lugar_id)), direccionesDeViajes(db, viajes)]);
  // Los días hábiles y, si tienen algo, el sábado y el domingo.
  const fechas: string[] = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) if (habiles.includes(d) || viajes.some((v) => v.fecha === d)) fechas.push(d);
  const out = fechas.map((fecha) => {
    const paradas: Array<{ clave: string; nombre: string; localidad: string | null; direccion: string | null; tipos: Record<string, number>; detalle: string[];
      encargos: EncargoDia[]; anonima: boolean; chofer: string | null; company_id: number | null; lugar_id: number | null; propio?: { nombre: string; direccion: string | null };
      zona: Zona | null; dominio: string | null; zona_libreta?: string | null }> = [];
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
        const otra = dirDe.get(v);
        // Se ve el nombre si la arma algo propio o un proveedor o impresor (o, fuera del perfil Ventas, siempre).
        p = { clave: v.clave!, nombre: v.nombre, localidad: l?.localidad ?? otra?.localidad ?? localidadDe(v.direccion ?? otra?.direccion), direccion: v.direccion ?? otra?.direccion ?? null,
          tipos: {}, detalle: [], encargos: [], anonima: ventas && !v.propio && v.tipo !== 'retiro' && v.tipo !== 'egreso', chofer: null, company_id: v.company_id ?? null,
          lugar_id: v.lugar_id ?? null, zona: null, dominio: null, zona_libreta: l?.zona ?? otra?.zona ?? null };
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
    for (const p of paradas) { p.zona = zonaDe({ zona: p.zona_libreta, localidad: p.localidad, direccion: p.direccion }); delete p.zona_libreta; }
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
  const dom = await dominios(db, out.flatMap((d) => d.paradas.map((p) => p.company_id)));
  for (const d of out) for (const p of d.paradas) p.dominio = p.company_id ? dom.get(p.company_id) ?? null : null;
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
// El número siguiente de los remitos de traslado (el que seguía la planilla), para un encargo o un egreso.
async function siguienteNumero(db: D1Database) {
  const r = await db.prepare(`UPDATE settings SET value = json_set(value, '$.remito_ultimo', COALESCE(json_extract(value, '$.remito_ultimo'), 0) + 1)
    WHERE key = 'recorridos' RETURNING json_extract(value, '$.remito_ultimo') AS n`).first<{ n: number }>();
  if (!r) throw new HttpError(500, 'Falta la configuración del remito.');
  return r.n;
}
export async function numerarRemito(db: D1Database, ctx: Ctx, id: number) {
  exigirPedir(ctx);
  const e = await encargoPorId(db, id);
  if (e.remito) return { remito: e.remito };
  const n = await siguienteNumero(db);
  // Si otro lo numeró recién, queda el primero.
  await db.prepare('UPDATE encargos SET remito = COALESCE(remito, ?) WHERE id = ?').bind(n, id).run();
  return { remito: (await encargoPorId(db, id)).remito };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export interface DatosRemito {
  titulo: string; numero: number | null; fecha: string; destino: string; direccion: string | null; contacto: string | null;
  items: ItemEnc[]; ademas?: string | null; notas?: string | null;
}
// El remito de traslado (el informal, «no válido como factura») para imprimir: una hoja A4 por remito (pedido de Rodrigo
// del 16/11/2026); se imprime dos veces, una copia queda en el destino y la firmada vuelve a Formas. Con la marca de Formas
// y los datos de la empresa de la planilla.
export async function htmlRemito(db: D1Database, d: DatosRemito) {
  const cfg = await recorridosConfig(db);
  const numero = d.numero ? `N° ${cfg.remito_pv}-${String(d.numero).padStart(9, '0')}` : 'Sin numerar';
  const [y, m, dd] = d.fecha.split('-');
  const filas = d.items.map((i) => `<tr><td class="c">${i.cant != null ? esc(new Intl.NumberFormat('es-AR').format(i.cant)) : ''}</td><td class="c">${esc(i.pdv ?? '')}</td><td>${esc(i.que)}</td></tr>`).join('');
  const vacias = Array.from({ length: Math.max(0, 14 - d.items.length) }, () => '<tr><td>&nbsp;</td><td></td><td></td></tr>').join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.titulo)} ${esc(numero)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef0f6; color: #11143a; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .barra { max-width: 186mm; margin: 16px auto 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .barra button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: #000085; color: #fff; cursor: pointer; }
  .barra span { color: #4a4e6e; }
  .hoja { max-width: 186mm; min-height: 273mm; margin: 16px auto; background: #fff; padding: 12mm; display: flex; flex-direction: column; gap: 6mm; }
  header { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6mm; align-items: start; border-bottom: 2.5px solid #000085; padding-bottom: 4mm; }
  .marca { display: flex; flex-direction: column; gap: 2mm; } .marca img { width: 40mm; }
  .empresa { display: flex; flex-direction: column; font-size: 10.5px; color: #3b3f63; } .empresa b { font-size: 12.5px; color: #11143a; }
  .letra { border: 2px solid #11143a; width: 18mm; text-align: center; padding: 1.5mm 0; } .letra b { font-size: 28px; display: block; line-height: 1; } .letra span { font-size: 7.5px; display: block; }
  .datos { display: flex; flex-direction: column; align-items: flex-end; text-align: right; gap: 1mm; } .datos b { text-transform: uppercase; font-size: 13px; letter-spacing: .02em; }
  .num { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 15px; }
  .destino { display: grid; grid-template-columns: 1fr 1.4fr; gap: 3mm 8mm; padding: 4mm; border: 1px solid #d9dcea; border-radius: 2mm; }
  .destino div { display: flex; flex-direction: column; } .destino span { font-size: 10px; text-transform: uppercase; color: #6b6f8e; letter-spacing: .04em; } .destino b { font-size: 14px; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 10.5px; text-transform: uppercase; color: #fff; background: #000085; padding: 2mm 3mm; }
  td { border-bottom: 1px solid #d9dcea; padding: 2.2mm 3mm; font-size: 13px; } td.c { text-align: center; font-variant-numeric: tabular-nums; }
  .nota { margin: 0; font-size: 12.5px; color: #3b3f63; }
  footer { margin-top: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10mm; padding-top: 14mm; }
  footer div { border-top: 1px solid #11143a; padding-top: 1.5mm; font-size: 11px; } footer span { color: #6b6f8e; }
  .recibi { margin-top: auto; font-weight: 700; font-size: 12px; }
  @media print { body { background: #fff; } .barra { display: none; } .hoja { margin: 0; max-width: none; min-height: 271mm; padding: 0; } }
</style></head><body>
<div class="barra"><button type="button" onclick="window.print()">Imprimir</button><span>${esc(d.numero ? 'Una hoja A4 por remito. Imprimilo dos veces: una copia queda en el destino y la firmada vuelve a Formas.' : 'Todavía sin número: se numera al imprimirlo desde el Hub.')}</span></div>
<main class="hoja">
  <header>
    <div class="marca"><img src="/login/formas-logo.png" alt="Formas"><div class="empresa"><b>Formas Publicitarias SA</b><span>B. Matienzo 1308 · Florida (1602), Buenos Aires</span><span>Responsable Inscripto</span><span>Ing. Brutos CM 901-227475-1 · Inic. Act. 1/1/2007</span></div></div>
    <div class="letra"><b>R</b><span>No válido como factura</span></div>
    <div class="datos"><b>${esc(d.titulo)}</b><span class="num">${esc(numero)}</span><span>Fecha: ${esc(`${dd}/${m}/${y}`)}</span></div>
  </header>
  <div class="destino"><div><span>Señor/es</span><b>${esc(d.destino)}</b></div><div><span>Dirección</span><b>${esc(d.direccion ?? '')}</b></div>
    ${d.contacto ? `<div><span>Atención</span><b>${esc(d.contacto)}</b></div>` : ''}</div>
  <table><thead><tr><th style="width:16%">Cantidad</th><th style="width:16%">PDV</th><th>Producto</th></tr></thead>
    <tbody>${filas}${vacias}</tbody></table>
  ${d.ademas ? `<p class="nota"><b>Además se retira:</b> ${esc(d.ademas)}</p>` : ''}
  ${d.notas ? `<p class="nota">${esc(d.notas)}</p>` : ''}
  <div class="recibi">Recibí conforme</div>
  <footer><div><br><span>Firma</span></div><div><br><span>Aclaración</span></div><div><br><span>DNI</span></div></footer>
</main>
<script>if (location.hash === '#imprimir') window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body></html>`;
}

// El remito de traslado de un encargo: lo que se lleva (o, si solo retira, lo que se retira).
export async function remitoHtml(db: D1Database, user: User, id: number) {
  const e = await encargoPorId(db, id);
  if (esVentas(user) && e.user_id !== user.id) throw new HttpError(403, 'Es un encargo de otra persona.');
  const texto = (i: ItemEnc) => [i.cant, i.que, i.pdv ? `(PDV ${i.pdv})` : ''].filter(Boolean).join(' ');
  return htmlRemito(db, {
    titulo: e.llevar.length ? 'Remito de traslado de mercadería' : 'Constancia de retiro de mercadería', numero: e.remito, fecha: e.fecha,
    destino: e.destino, direccion: e.direccion, contacto: e.contacto, items: e.llevar.length ? e.llevar : e.retirar,
    ademas: e.llevar.length && e.retirar.length ? e.retirar.map(texto).join(' · ') : null, notas: e.notas,
  });
}

// ---------- El remito de traslado de un egreso (cronograma) ----------

// Lo que se le lleva al impresor ese día, de todos los PDV de esa parada (pedido de Rodrigo del 16/11/2026): se arma con
// los egresos de ClickUp, se numera la primera vez (el mismo número que los de Recorridos) y se vuelve a armar si cambian.
export async function remitoEgreso(env: Env, ctx: Ctx, b: { fecha?: unknown; clave?: unknown }) {
  if (!organiza(ctx.user)) throw new HttpError(403, 'El remito de traslado de un egreso lo imprime Logística (o Producción).');
  if (!esDia(b.fecha)) throw new HttpError(400, 'Falta el día.');
  const clave = String(b.clave ?? '');
  const db = env.DB;
  const egresos = (await movimientos(db, b.fecha, b.fecha)).movs.filter((m) => m.tipo === 'egreso' && claveParada(m) === clave);
  if (!egresos.length) throw new HttpError(404, 'Ese día no hay egresos para ese impresor.');
  const items: ItemEnc[] = egresos.map((m) => ({ cant: m.cantidad, que: m.articulo || 'Artículo', pdv: m.npdv }));
  const destino = egresos[0].lugar ?? 'Impresor';
  // La dirección: la de la ficha del impresor o, si no tiene, la de la libreta si hay un lugar que se llama igual.
  const emp = egresos[0].company_id ? await db.prepare("SELECT json_extract(props, '$.address') AS address, json_extract(props, '$.city') AS city FROM records WHERE id = ?")
    .bind(egresos[0].company_id).first<{ address: string | null; city: string | null }>() : null;
  const libreta = emp?.address ? null : unicoLugar((await lugaresPara(db, [destino])).get(destino)?.exactos ?? []);
  const direccion = emp?.address ? [emp.address, emp.city].filter(Boolean).join(', ') : libreta?.direccion ? direccionLugar(libreta) : null;
  const ya = await db.prepare('SELECT id, numero FROM remitos_traslado WHERE fecha = ? AND clave = ?').bind(b.fecha, clave).first<{ id: number; numero: number }>();
  if (ya) {
    await db.prepare('UPDATE remitos_traslado SET destino = ?, direccion = ?, items = ?, updated_at = ? WHERE id = ?').bind(destino, direccion, JSON.stringify(items), now(), ya.id).run();
    return { id: ya.id, numero: ya.numero };
  }
  const numero = await siguienteNumero(db);
  const r = await db.prepare(`INSERT INTO remitos_traslado (numero, fecha, clave, destino, direccion, items, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fecha, clave) DO UPDATE SET items = excluded.items, updated_at = excluded.created_at RETURNING id, numero`)
    .bind(numero, b.fecha, clave, destino, direccion, JSON.stringify(items), ctx.user.id).first<{ id: number; numero: number }>();
  return { id: r!.id, numero: r!.numero };
}
export async function remitoEgresoHtml(db: D1Database, user: User, id: number) {
  if (!organiza(user)) throw new HttpError(403, 'El remito de traslado de un egreso lo ven Logística y Producción.');
  const r = await db.prepare('SELECT * FROM remitos_traslado WHERE id = ?').bind(id).first<{ numero: number; fecha: string; destino: string; direccion: string | null; items: string }>();
  if (!r) throw new HttpError(404, 'Ese remito ya no está.');
  return htmlRemito(db, { titulo: 'Remito de traslado de mercadería', numero: r.numero, fecha: r.fecha, destino: r.destino, direccion: r.direccion, contacto: null,
    items: (() => { try { return JSON.parse(r.items) as ItemEnc[]; } catch { return []; } })() });
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
