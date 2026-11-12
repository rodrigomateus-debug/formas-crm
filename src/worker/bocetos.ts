import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { primaryCompanyId } from './associations';
import { subirArchivo } from './drive';

// Bocetos de producción (pedido de Rodrigo del 6/11/2026): por producto del pedido, PDF o imagen. A veces se hacen antes
// del pedido (en el negocio) y a veces después; primero puede ir una referencia rápida (una foto) y después el técnico con
// las medidas finales. El archivo vive en Drive (drive.ts); al aprobar uno en un pedido, el CRM lo adjunta a la subtarea
// del artículo en ClickUp (clickup.ts, adjuntarBoceto), donde trabaja producción.

export const TIPOS = ['referencia', 'tecnico'] as const;
export const ESTADOS = ['para_aprobar', 'aprobado'] as const;
const MIMES = /^(application\/pdf|image\/(jpeg|png|webp|gif|heic))$/;
const MAX = 40 * 1024 * 1024;

export interface Boceto {
  id: number; record_id: number; producto: string | null; producto_nombre: string | null; tipo: string; estado: string; version: number;
  nombre: string; mime: string | null; size: number | null; drive_id: string; drive_link: string | null; origen_id: number | null;
  clickup_task: string | null; clickup_at: string | null; user_id: number | null; created_at: string;
}

const COLS = `b.id, b.record_id, b.producto, b.producto_nombre, b.tipo, b.estado, b.version, b.nombre, b.mime, b.size, b.drive_id, b.drive_link,
  b.origen_id, b.clickup_task, b.clickup_at, b.user_id, b.created_at`;

export async function bocetosDe(db: D1Database, recordId: number) {
  const { results } = await db.prepare(`SELECT ${COLS} FROM bocetos b WHERE b.record_id = ? AND b.archived = 0 ORDER BY b.producto_nombre, b.version DESC, b.id DESC`)
    .bind(recordId).all<Boceto>();
  return results;
}

// En un pedido: los bocetos de los negocios de su empresa que todavía no se usaron en este pedido (los que se hicieron antes).
export async function bocetosDeNegocios(db: D1Database, orderId: number) {
  const company = await primaryCompanyId(db, orderId);
  if (!company) return [];
  const { results } = await db.prepare(`SELECT ${COLS}, r.name AS negocio FROM bocetos b JOIN records r ON r.id = b.record_id AND r.archived = 0
    WHERE r.object_type = 'deal' AND b.archived = 0
      AND b.record_id IN (SELECT from_id FROM associations WHERE to_id = ? AND from_type = 'deal')
      AND b.id NOT IN (SELECT origen_id FROM bocetos WHERE record_id = ? AND origen_id IS NOT NULL AND archived = 0)
    ORDER BY b.created_at DESC LIMIT 50`).bind(company, orderId).all<Boceto & { negocio: string }>();
  return results;
}

async function siguienteVersion(db: D1Database, recordId: number, producto: string | null) {
  const r = await db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM bocetos WHERE record_id = ? AND COALESCE(producto, \'\') = ? AND archived = 0')
    .bind(recordId, producto ?? '').first<{ v: number }>();
  return r?.v ?? 1;
}

// Carpeta en Drive: <empresa>/<PDV 31277 | Negocio …>.
async function rutaDrive(db: D1Database, rec: { id: number; object_type: string; name: string; props: string }) {
  const company = await primaryCompanyId(db, rec.id);
  const emp = company ? await db.prepare('SELECT name FROM records WHERE id = ?').bind(company).first<{ name: string }>() : null;
  const p = JSON.parse(rec.props) as Record<string, unknown>;
  const donde = rec.object_type === 'order' ? (p.pdv_finnegans ? `PDV ${p.pdv_finnegans}` : rec.name) : `Negocio ${rec.name}`;
  return [emp?.name ?? 'Sin empresa', donde];
}

export async function subirBoceto(env: Env, ctx: Ctx, rec: { id: number; object_type: string; name: string; props: string }, archivo: File,
  datos: { producto?: string | null; producto_nombre?: string | null; tipo?: string }) {
  if (!['order', 'deal'].includes(rec.object_type)) throw new HttpError(400, 'Los bocetos van en pedidos o negocios.');
  const mime = archivo.type || (/\.pdf$/i.test(archivo.name) ? 'application/pdf' : '');
  if (!MIMES.test(mime)) throw new HttpError(400, 'El boceto tiene que ser un PDF o una imagen (JPG, PNG, WebP).');
  if (archivo.size > MAX) throw new HttpError(400, 'El archivo es muy grande (máximo 40 MB).');
  const tipo = TIPOS.includes(datos.tipo as (typeof TIPOS)[number]) ? datos.tipo! : (mime === 'application/pdf' ? 'tecnico' : 'referencia');
  const producto = datos.producto?.trim() || null;
  const db = env.DB;
  const version = await siguienteVersion(db, rec.id, producto);
  const f = await subirArchivo(env, await rutaDrive(db, rec), archivo.name || `boceto.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`, mime, await archivo.arrayBuffer());
  const row = await db.prepare(`INSERT INTO bocetos (record_id, producto, producto_nombre, tipo, version, nombre, mime, size, drive_id, drive_link, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(rec.id, producto, datos.producto_nombre?.trim() || producto, tipo, version, archivo.name || 'boceto',
    mime, archivo.size, f.id, f.link, ctx.user.id).first<{ id: number }>();
  return (await db.prepare(`SELECT ${COLS} FROM bocetos b WHERE b.id = ?`).bind(row!.id).first<Boceto>())!;
}

export async function bocetoPorId(db: D1Database, id: number) {
  const b = await db.prepare(`SELECT ${COLS}, b.archived FROM bocetos b WHERE b.id = ?`).bind(id).first<Boceto & { archived: number }>();
  if (!b || b.archived) throw new HttpError(404, 'No existe el boceto.');
  return b;
}

// Cambiar estado (aprobado o no), tipo o producto. Aprobar uno en un pedido lo deja listo para ClickUp.
export async function actualizarBoceto(db: D1Database, id: number, cambios: { estado?: string; tipo?: string; producto?: string | null; producto_nombre?: string | null }, userId: number | null = null) {
  const b = await bocetoPorId(db, id);
  if (cambios.estado !== undefined && !ESTADOS.includes(cambios.estado as (typeof ESTADOS)[number])) throw new HttpError(400, `Estado desconocido: ${cambios.estado}.`);
  if (cambios.tipo !== undefined && !TIPOS.includes(cambios.tipo as (typeof TIPOS)[number])) throw new HttpError(400, `Tipo desconocido: ${cambios.tipo}.`);
  const producto = cambios.producto === undefined ? b.producto : cambios.producto?.trim() || null;
  const otroProducto = producto !== b.producto;
  await db.prepare(`UPDATE bocetos SET estado = ?, tipo = ?, producto = ?, producto_nombre = ?, version = ?,
      clickup_task = CASE WHEN ? THEN NULL ELSE clickup_task END, clickup_at = CASE WHEN ? THEN NULL ELSE clickup_at END WHERE id = ?`)
    .bind(cambios.estado ?? b.estado, cambios.tipo ?? b.tipo, producto,
      cambios.producto_nombre === undefined ? (otroProducto ? producto : b.producto_nombre) : cambios.producto_nombre?.trim() || producto,
      otroProducto ? await siguienteVersion(db, b.record_id, producto) : b.version, otroProducto ? 1 : 0, otroProducto ? 1 : 0, id).run();
  // Quién lo aprobó y cuándo (la conversación del pedido lo muestra); al volverlo a «para aprobar», se borra.
  if (cambios.estado && cambios.estado !== b.estado) {
    await db.prepare('UPDATE bocetos SET aprobado_at = ?, aprobado_por = ? WHERE id = ?')
      .bind(cambios.estado === 'aprobado' ? new Date().toISOString() : null, cambios.estado === 'aprobado' ? userId : null, id).run();
  }
  return bocetoPorId(db, id);
}

// Un boceto hecho en el negocio, usado en el pedido: queda en el pedido (mismo archivo de Drive) atado a uno de sus productos.
export async function usarEnPedido(db: D1Database, ctx: Ctx, id: number, orderId: number, producto: string | null, productoNombre: string | null) {
  const b = await bocetoPorId(db, id);
  const ped = await db.prepare("SELECT id FROM records WHERE id = ? AND object_type = 'order' AND archived = 0").bind(orderId).first();
  if (!ped) throw new HttpError(404, 'No existe el pedido.');
  const version = await siguienteVersion(db, orderId, producto);
  const row = await db.prepare(`INSERT INTO bocetos (record_id, producto, producto_nombre, tipo, estado, version, nombre, mime, size, drive_id, drive_link, origen_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(orderId, producto, productoNombre || producto || b.producto_nombre, b.tipo, b.estado, version,
    b.nombre, b.mime, b.size, b.drive_id, b.drive_link, b.id, ctx.user.id).first<{ id: number }>();
  return bocetoPorId(db, row!.id);
}

export async function quitarBoceto(db: D1Database, id: number) {
  await bocetoPorId(db, id);
  await db.prepare('UPDATE bocetos SET archived = 1 WHERE id = ?').bind(id).run();
}
