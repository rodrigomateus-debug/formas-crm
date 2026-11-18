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
// Los ids de usuario que «son suyos»: ella y, si es gerenta, los del equipo (subconsulta SQL).
function propios(user: User) {
  const id = Number(user.id), t = gerenciaDe(user);
  if (!Number.isInteger(id) || (t != null && !Number.isInteger(t))) throw new HttpError(500, 'Usuario inválido.');
  return t == null ? `(${id})` : `(SELECT gu.id FROM users gu WHERE gu.id = ${id} OR gu.team_id = ${t}
    OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(gu.extra_teams) THEN gu.extra_teams ELSE '[]' END) WHERE value = ${t}))`;
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
  if (!esVentas(user)) return '1';
  const mios = propios(user);
  const unidad = gerenciaDe(user) == null ? '' : ` OR ${deLaUnidad(al, user)} OR ${al}.id IN (SELECT ua.to_id FROM associations ua
    WHERE ua.to_type != 'deal' AND (ua.to_type != 'order' OR ua.from_type = 'deal') AND ua.from_id IN (SELECT uo.id FROM records uo WHERE ${deLaUnidad('uo', user)}))`;
  return `(${al}.owner_id IN ${mios} OR ${al}.owner_id IS NULL${unidad} OR ${al}.id IN (SELECT va.to_id FROM associations va
    WHERE va.to_type != 'deal' AND (va.to_type != 'order' OR va.from_type = 'deal')
      AND va.from_id IN (SELECT vo.id FROM records vo WHERE vo.object_type IN ('contact', 'company', 'deal', 'order') AND vo.owner_id IN ${mios})))`;
}

// Lo mismo para una actividad (nota, mail, tarea…) `al`: la ve si es suya (la tiene asignada o la cargó ella) o si está en
// algún registro que ve.
export function actividadVisibleSql(al: string, user: User) {
  if (!restringido(user)) return '1';
  const id = Number(user.id);
  return `(${al}.owner_id = ${id} OR ${al}.created_by = ${id} OR EXISTS (SELECT 1 FROM tarea_colaboradores vc WHERE vc.activity_id = ${al}.id AND vc.user_id = ${id})
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
  if (!esVentas(user) || row.owner_id == null || Number(row.owner_id) === user.id) return true;
  if (row.object_type === 'deal' && gerenciaDe(user) == null) return false;
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
  throw new HttpError(403, `${NOMBRE[row.object_type] ?? 'Este registro'} es de ${de ?? 'otra vendedora'}: lo ven ${de ? 'ella' : 'quien lo tiene'} y los administradores. Si lo necesitás, pedile a un administrador que te lo pase.`, { ajeno: true });
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
