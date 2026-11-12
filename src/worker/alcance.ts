import type { Ctx, User } from './env';
import { HttpError } from './env';
import type { RecordRow } from './records';
import type { Meta } from './meta';
import { assertDealVisible } from './pipelines';

// Perfil Ventas (perfil «comercial» que no es administrador). Pedido de Rodrigo del 12/11/2026: qué ve una vendedora.
//
// Registros (contactos, empresas, negocios y pedidos):
//   - lo suyo (propietario ella),
//   - lo que no tiene propietario (para poder tomarlo: leads de Darwin, LinkedIn, formularios),
//   - lo asociado a lo suyo: la empresa y los contactos de sus negocios, contactos y empresas; los pedidos de sus negocios.
//   Un negocio de otra vendedora no se ve nunca por estar asociado a algo suyo (por ejemplo, a una empresa de ella).
//   Encima de esto siguen los pipelines por equipo (pipelines.ts).
// Pantallas: no ve Producción ni Entregas (ni los remitos, ni quién tiene el pedido en producción), ni el ranking del
// equipo en Inicio. Sí ve el saldo y la deuda del cliente (Finnegans).
// No exporta ni importa listas.
// Tareas, actividad y conversaciones: las suyas y las de los registros que ve.
//
// Todo se controla acá, en el servidor (pantalla, API, Claude por MCP y la API compatible con HubSpot).
// Los perfiles Producción y Logística, por ahora, siguen viendo todo.

export const esVentas = (u: User) => u.profile === 'comercial' && u.role !== 'admin';

// Condición SQL «el registro `al` lo ve la vendedora». El id va escrito en la consulta (es un entero de la base, no un
// dato del pedido): así sirve igual en consultas con ? que con ?1, ?2… La subconsulta no depende de la fila: SQLite la
// arma una sola vez (sus registros y lo asociado a ellos), que es poco aunque la lista sea de miles.
export function visibleSql(al: string, user: User) {
  if (!esVentas(user)) return '1';
  const id = Number(user.id);
  if (!Number.isInteger(id)) throw new HttpError(500, 'Usuario inválido.');
  return `(${al}.owner_id = ${id} OR ${al}.owner_id IS NULL OR ${al}.id IN (SELECT va.to_id FROM associations va
    WHERE va.to_type != 'deal' AND (va.to_type != 'order' OR va.from_type = 'deal')
      AND va.from_id IN (SELECT vo.id FROM records vo WHERE vo.object_type IN ('contact', 'company', 'deal', 'order') AND vo.owner_id = ${id})))`;
}

// Lo mismo para una actividad (nota, mail, tarea…) `al`: la ve si es suya (la tiene asignada o la cargó ella) o si está en
// algún registro que ve.
export function actividadVisibleSql(al: string, user: User) {
  if (!esVentas(user)) return '1';
  const id = Number(user.id);
  return `(${al}.owner_id = ${id} OR ${al}.created_by = ${id} OR EXISTS (SELECT 1 FROM activity_links vl
    JOIN records vr ON vr.id = vl.record_id WHERE vl.activity_id = ${al}.id AND ${visibleSql('vr', user)}))`;
}

async function duenio(db: D1Database, ownerId: number | null) {
  if (ownerId == null) return null;
  return (await db.prepare('SELECT name FROM users WHERE id = ?').bind(ownerId).first<{ name: string }>())?.name ?? null;
}

const NOMBRE: Record<string, string> = { contact: 'Este contacto', company: 'Esta empresa', deal: 'Este negocio', order: 'Este pedido' };

export async function puedeVer(db: D1Database, user: User, row: Pick<RecordRow, 'id' | 'object_type' | 'owner_id'>) {
  if (!esVentas(user) || row.owner_id == null || Number(row.owner_id) === user.id) return true;
  if (row.object_type === 'deal') return false;
  return !!(await db.prepare(`SELECT 1 FROM records r WHERE r.id = ? AND ${visibleSql('r', user)}`).bind(row.id).first());
}

// El registro lo puede ver (y tocar) quien hace el pedido: pipelines por equipo y, en Ventas, lo suyo.
export async function assertVisible(db: D1Database, meta: Meta, user: User, row: RecordRow) {
  if (row.object_type === 'deal') await assertDealVisible(meta, user, row.pipeline_id);
  if (await puedeVer(db, user, row)) return;
  const de = await duenio(db, row.owner_id);
  throw new HttpError(403, `${NOMBRE[row.object_type] ?? 'Este registro'} es de ${de ?? 'otra vendedora'}: lo ven ${de ? 'ella' : 'quien lo tiene'} y los administradores. Si lo necesitás, pedile a un administrador que te lo pase.`, { ajeno: true });
}

// De una lista de ids, los que la vendedora ve (para filtrar bandejas y listas armadas por otro lado).
export async function idsVisibles(db: D1Database, user: User, ids: number[]) {
  if (!esVentas(user) || !ids.length) return new Set(ids);
  const { results } = await db.prepare(`SELECT r.id FROM records r WHERE r.id IN (SELECT value FROM json_each(?)) AND ${visibleSql('r', user)}`)
    .bind(JSON.stringify(ids)).all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

export async function assertActividadVisible(db: D1Database, user: User, activityId: number) {
  if (!esVentas(user)) return;
  const ok = await db.prepare(`SELECT 1 FROM activities a WHERE a.id = ? AND ${actividadVisibleSql('a', user)}`).bind(activityId).first();
  if (!ok) throw new HttpError(403, 'Esta actividad es de registros de otra vendedora.', { ajeno: true });
}

// Pantallas y funciones que Ventas no tiene.
export function sinVentas(ctx: Ctx, que: string) {
  if (esVentas(ctx.user)) throw new HttpError(403, `${que} no está en el perfil Ventas.`);
}
