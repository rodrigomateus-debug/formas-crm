import type { Ctx, User } from './env';
import { HttpError } from './env';
import type { RecordRow } from './records';
import type { Meta } from './meta';
import { assertDealVisible } from './pipelines';
import { UNIDADES } from './records';

// Perfil Ventas (perfil «comercial» que no es administrador). Pedido de Rodrigo del 12/11/2026: qué ve una vendedora.
//
// Registros (contactos, empresas, negocios y pedidos):
//   - lo suyo (propietario ella),
//   - lo que no tiene propietario (para poder tomarlo: leads de Darwin, LinkedIn, formularios),
//   - lo asociado a lo suyo: la empresa y los contactos de sus negocios, contactos y empresas; los pedidos de sus negocios.
//   Un negocio de otra vendedora no se ve nunca por estar asociado a algo suyo (por ejemplo, a una empresa de ella).
//   «Lo suyo» se puede ampliar en Configuración → Usuarios → Qué ve (su equipo, todo o personas elegidas; ver `vistos`):
//   lo de esas personas lo ve como lo suyo, pero no lo edita.
//   Encima de esto siguen los pipelines por equipo (pipelines.ts).
// Pantallas: no ve Producción (ni quién tiene el pedido en producción), la bandeja de Entregas ni el ranking del equipo en
// Inicio. Sí ve el saldo y la deuda del cliente (Finnegans) y los remitos de sus pedidos, para verlos y descargarlos.
// No exporta ni importa listas.
// Tareas, actividad y conversaciones: las suyas y las de los registros que ve.
//
// Todo se controla acá, en el servidor (pantalla, API, Claude por MCP y la API compatible con HubSpot).
//
// Perfil Producción (pedido de Rodrigo del 13/11/2026): trabaja con los pedidos, no con la parte comercial.
//   - Pedidos: todos.
//   - Negocios: ninguno.
//   - Contactos y empresas: no tiene sus listas; abre solo los que necesita para trabajar: los proveedores e impresores
//     (tipo de relación «proveedor») y los que están en algún pedido (el cliente y sus contactos).
//   - Tareas, actividad y conversaciones: las suyas y las de lo que ve.
//   - Producción, Entregas y Cronograma, como siempre.
// Logística (pedido de Rodrigo del 16/11/2026), lo mismo que Producción: Producción, Pedidos, Entregas, Recorridos y
// Cronograma, sin la parte comercial. Cada uno sigue editando lo suyo (Producción, la pantalla de Producción; Logística,
// los remitos y las entregas; los dos, el cronograma y los recorridos).

export const esVentas = (u: User) => u.profile === 'comercial' && u.role !== 'admin';
export const esProduccion = (u: User) => u.profile === 'produccion' && u.role !== 'admin';
export const esLogistica = (u: User) => u.profile === 'logistica' && u.role !== 'admin';
// Producción y Logística: los perfiles de operaciones, que ven los pedidos y no la parte comercial.
export const esOperaciones = (u: User) => esProduccion(u) || esLogistica(u);
export const nombrePerfil = (u: User) => (esLogistica(u) ? 'Logística' : esProduccion(u) ? 'Producción' : 'Ventas');
// Perfiles que no ven todo el CRM (cada uno con su regla, abajo).
export const restringido = (u: User) => esVentas(u) || esOperaciones(u);

// Gerencia (pedido de Rodrigo del 18/11/2026: «Wanda es la gerenta, debería poder ver y editar todo lo que corresponde a
// Corporate»). Una vendedora con `gerencia_team` (Configuración → Usuarios → Gerencia de) ve y edita como si fuera suyo lo de
// ese equipo: los registros cuyo propietario es del equipo (equipo principal o extra), los negocios de los pipelines del
// equipo y los pedidos de su unidad de negocio; y puede asignárselos a cualquiera del equipo. Lo demás, como Ventas.
export const gerenciaDe = (u: User) => (esVentas(u) && u.gerencia_team ? Number(u.gerencia_team) : null);

// Qué ve (pedido de Rodrigo del 20/11/2026: «que se pueda elegir qué ve cada usuario: solo lo suyo, lo de todos o elegir de
// qué usuarios; Carmen debería poder ver lo suyo, lo de Mili y lo de Sonia»). Como lo hacen los CRM grandes: el «Ver» de
// HubSpot (todo, su equipo o lo suyo; si está en varios equipos, cuentan todos) y las reglas para compartir de Salesforce
// (lo de tal persona lo ve también tal otra: solo suman, nunca restan). En Configuración → Usuarios → Qué ve:
//   - `ve`: 'suyo' (lo de siempre), 'equipo' (lo de quienes comparten alguno de sus equipos) o 'todos';
//   - `ve_usuarios`: además, lo de estas personas (con 'todos' no hace falta).
// Ver lo de otra persona es ver sus registros y lo asociado a ellos, sus negocios incluidos, y sus tareas, como si fuera
// suyo; editarlo, no (como en Salesforce, la regla es de solo lectura): eso sigue siendo lo suyo y, si es gerenta, lo de su
// equipo. Encima siguen valiendo los pipelines que ve: un negocio de un pipeline que no ve no aparece.
export type Ve = 'suyo' | 'equipo' | 'todos';
export const VE: readonly Ve[] = ['suyo', 'equipo', 'todos'];
export const veModo = (u: User): Ve => ((VE as readonly string[]).includes(String(u.ve)) ? u.ve as Ve : 'suyo');
// Vendedora que ve todo (para ver es como un administrador; para editar, como Ventas).
export const veTodo = (u: User) => esVentas(u) && veModo(u) === 'todos';
export function veUsuarios(u: User): number[] {
  try {
    const a = JSON.parse(u.ve_usuarios || '[]');
    return Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n !== Number(u.id)))] : [];
  } catch { return []; }
}
export function equiposDe(u: Pick<User, 'team_id' | 'extra_teams'>): number[] {
  let extra: unknown[] = [];
  try { const a = JSON.parse(u.extra_teams || '[]'); if (Array.isArray(a)) extra = a; } catch { /* sin equipos extra */ }
  return [...new Set([u.team_id, ...extra].map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}
const enteros = (ns: number[]) => {
  if (ns.some((n) => !Number.isInteger(n))) throw new HttpError(500, 'Usuario inválido.');
  return ns.join(', ');
};
// El usuario `al` es de alguno de esos equipos (principal o extra).
const deLosEquipos = (al: string, ts: number[]) => `(${al}.team_id IN (${enteros(ts)})
    OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${al}.extra_teams) THEN ${al}.extra_teams ELSE '[]' END) WHERE value IN (${enteros(ts)})))`;
// Los ids de usuario que «son suyos» para editar: ella y, si es gerenta, los del equipo (subconsulta SQL).
function propios(user: User) {
  const id = Number(user.id), t = gerenciaDe(user);
  return t == null ? `(${enteros([id])})` : `(SELECT gu.id FROM users gu WHERE gu.id = ${enteros([id])} OR ${deLosEquipos('gu', [t])})`;
}
// Los ids de usuario cuyo trabajo ve (no vale para «todos», que no filtra): los suyos para editar, los de sus equipos si ve
// lo del equipo y las personas elegidas.
function vistos(user: User) {
  const g = gerenciaDe(user);
  const ts = [...new Set([...(veModo(user) === 'equipo' ? equiposDe(user) : []), ...(g == null ? [] : [g])])];
  const ids = enteros([Number(user.id), ...veUsuarios(user)]);
  return ts.length ? `(SELECT gv.id FROM users gv WHERE gv.id IN (${ids}) OR ${deLosEquipos('gv', ts)})` : `(${ids})`;
}
// ¿Ve algo más que lo suyo? (para no sumar condiciones de más en las consultas).
const veDeOtros = (u: User) => esVentas(u) && (veModo(u) !== 'suyo' || veUsuarios(u).length > 0 || gerenciaDe(u) != null);
// Los ids de los usuarios cuyo trabajo ve, para las cuentas que se hacen fuera de SQL; null: todo (no es Ventas o ve todo).
export async function duenosVistos(db: D1Database, user: User): Promise<Set<number> | null> {
  if (!esVentas(user) || veTodo(user)) return null;
  if (!veDeOtros(user)) return new Set([Number(user.id)]);
  const { results } = await db.prepare(`SELECT id FROM users WHERE id IN ${vistos(user)}`).all<{ id: number }>();
  return new Set([Number(user.id), ...results.map((r) => r.id)]);
}
// Lo de la unidad que no depende del propietario: negocios de los pipelines del equipo y pedidos de la unidad.
function deLaUnidad(al: string, user: User) {
  const t = gerenciaDe(user);
  if (t == null) return '0';
  const ped = (Object.values(UNIDADES).find((u) => u.team === t)?.pedido ?? []).map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return `((${al}.object_type = 'deal' AND ${al}.pipeline_id IN (SELECT id FROM pipelines WHERE team_id = ${t}))${ped
    ? ` OR (${al}.object_type = 'order' AND UPPER(COALESCE(json_extract(${al}.props, '$.unidad_de_negocio'), '')) IN (${ped}))` : ''})`;
}
// ¿Lo puede editar como suyo? (propietario ella o de su equipo, o de la unidad que gerencia). Sin propietario, también.
export async function esSuyo(db: D1Database, user: User, row: { id?: number; owner_id: number | null }) {
  if (row.owner_id == null || Number(row.owner_id) === user.id) return true;
  if (gerenciaDe(user) == null) return false;
  if (await esDeSuEquipo(db, user, row.owner_id)) return true;
  return row.id != null && !!(await db.prepare(`SELECT 1 FROM records r WHERE r.id = ? AND ${deLaUnidad('r', user)}`).bind(row.id).first());
}
// ¿Ese usuario es ella o de su equipo? (para asignar propietario).
export async function esDeSuEquipo(db: D1Database, user: User, ownerId: unknown) {
  if (ownerId == null || ownerId === '' || Number(ownerId) === user.id) return true;
  if (gerenciaDe(user) == null) return false;
  return !!(await db.prepare(`SELECT 1 WHERE ? IN ${propios(user)}`).bind(Number(ownerId)).first());
}

// Condición SQL «el registro `al` lo ve la vendedora». El id va escrito en la consulta (es un entero de la base, no un
// dato del pedido): así sirve igual en consultas con ? que con ?1, ?2… La subconsulta no depende de la fila: SQLite la
// arma una sola vez (sus registros y lo asociado a ellos), que es poco aunque la lista sea de miles.
export function visibleSql(al: string, user: User) {
  // Producción y Logística: los pedidos; de contactos y empresas, los proveedores y los que están en algún pedido (por el
  // índice de asociaciones de cada registro: es una búsqueda corta por fila).
  if (esOperaciones(user)) {
    return `(${al}.object_type = 'order' OR (${al}.object_type IN ('company', 'contact') AND (json_extract(${al}.props, '$.tipo_de_relacion') = 'proveedor'
      OR EXISTS (SELECT 1 FROM associations pa WHERE pa.to_id = ${al}.id AND pa.from_type = 'order'))))`;
  }
  if (!esVentas(user) || veTodo(user)) return '1';
  // Lo suyo, lo de su equipo si es gerenta y lo de quienes eligió ver (Qué ve).
  const mios = vistos(user);
  const unidad = gerenciaDe(user) == null ? '' : ` OR ${deLaUnidad(al, user)} OR ${al}.id IN (SELECT ua.to_id FROM associations ua
    WHERE ua.to_type != 'deal' AND (ua.to_type != 'order' OR ua.from_type = 'deal') AND ua.from_id IN (SELECT uo.id FROM records uo WHERE ${deLaUnidad('uo', user)}))`;
  return `(${al}.owner_id IN ${mios} OR ${al}.owner_id IS NULL${unidad} OR ${al}.id IN (SELECT va.to_id FROM associations va
    WHERE va.to_type != 'deal' AND (va.to_type != 'order' OR va.from_type = 'deal')
      AND va.from_id IN (SELECT vo.id FROM records vo WHERE vo.object_type IN ('contact', 'company', 'deal', 'order') AND vo.owner_id IN ${mios})))`;
}

// Lo mismo para una actividad (nota, mail, tarea…) `al`: la ve si es suya (la tiene asignada o la cargó ella) o si está en
// algún registro que ve.
export function actividadVisibleSql(al: string, user: User) {
  if (!restringido(user) || veTodo(user)) return '1';
  const id = Number(user.id);
  // Las tareas de las personas cuyo trabajo ve (Qué ve, o su equipo si es gerenta), aunque no estén en ningún registro.
  const deOtros = veDeOtros(user) ? ` OR ${al}.owner_id IN ${vistos(user)}` : '';
  return `(${al}.owner_id = ${id}${deOtros} OR ${al}.created_by = ${id} OR EXISTS (SELECT 1 FROM tarea_colaboradores vc WHERE vc.activity_id = ${al}.id AND vc.user_id = ${id})
    OR EXISTS (SELECT 1 FROM activity_links vl
    JOIN records vr ON vr.id = vl.record_id WHERE vl.activity_id = ${al}.id AND ${visibleSql('vr', user)}))`;
}

async function duenio(db: D1Database, ownerId: number | null) {
  if (ownerId == null) return null;
  return (await db.prepare('SELECT name FROM users WHERE id = ?').bind(ownerId).first<{ name: string }>())?.name ?? null;
}

const NOMBRE: Record<string, string> = { contact: 'Este contacto', company: 'Esta empresa', deal: 'Este negocio', order: 'Este pedido' };

export async function puedeVer(db: D1Database, user: User, row: Pick<RecordRow, 'id' | 'object_type' | 'owner_id'>) {
  if (esOperaciones(user)) {
    if (row.object_type === 'order') return true;
    if (row.object_type === 'deal') return false;
    return !!(await db.prepare(`SELECT 1 FROM records r WHERE r.id = ? AND ${visibleSql('r', user)}`).bind(row.id).first());
  }
  if (!esVentas(user) || veTodo(user) || row.owner_id == null || Number(row.owner_id) === user.id || veUsuarios(user).includes(Number(row.owner_id))) return true;
  if (row.object_type === 'deal' && !veDeOtros(user)) return false;
  return !!(await db.prepare(`SELECT 1 FROM records r WHERE r.id = ? AND ${visibleSql('r', user)}`).bind(row.id).first());
}

// El registro lo puede ver (y tocar) quien hace el pedido: pipelines por equipo y, en Ventas, lo suyo.
export async function assertVisible(db: D1Database, meta: Meta, user: User, row: RecordRow) {
  if (row.object_type === 'deal') await assertDealVisible(meta, user, row.pipeline_id);
  if (await puedeVer(db, user, row)) return;
  if (esOperaciones(user)) {
    throw new HttpError(403, row.object_type === 'deal' ? `Los negocios no están en el perfil ${nombrePerfil(user)}.`
      : `${NOMBRE[row.object_type] ?? 'Este registro'} no está en ningún pedido ni es un proveedor: no está en el perfil ${nombrePerfil(user)}.`, { ajeno: true });
  }
  const de = await duenio(db, row.owner_id);
  throw new HttpError(403, `${NOMBRE[row.object_type] ?? 'Este registro'} es de ${de ?? 'otra vendedora'}: lo ven ${de ? 'ella' : 'quien lo tiene'}, quienes tienen permiso para ver lo suyo y los administradores. Si lo necesitás, pedile a un administrador que te lo pase.`, { ajeno: true });
}

// De una lista de ids, los que la vendedora ve (para filtrar bandejas y listas armadas por otro lado).
export async function idsVisibles(db: D1Database, user: User, ids: number[]) {
  if (!restringido(user) || !ids.length) return new Set(ids);
  const { results } = await db.prepare(`SELECT r.id FROM records r WHERE r.id IN (SELECT value FROM json_each(?)) AND ${visibleSql('r', user)}`)
    .bind(JSON.stringify(ids)).all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

export async function assertActividadVisible(db: D1Database, user: User, activityId: number) {
  if (!restringido(user)) return;
  const ok = await db.prepare(`SELECT 1 FROM activities a WHERE a.id = ? AND ${actividadVisibleSql('a', user)}`).bind(activityId).first();
  if (!ok) throw new HttpError(403, esOperaciones(user) ? `Esta actividad es de registros que no están en el perfil ${nombrePerfil(user)}.` : 'Esta actividad es de registros de otra vendedora.', { ajeno: true });
}

// Pantallas y funciones que Ventas no tiene.
export function sinVentas(ctx: Ctx, que: string) {
  if (esVentas(ctx.user)) throw new HttpError(403, `${que} no está en el perfil Ventas.`);
}
