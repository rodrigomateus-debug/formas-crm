import type { Ctx } from './env';
import { createActivity, getActivity, linkActivity, updateActivity } from './activities';

// Después de cada entrega: a los 3 días de que el cliente recibió el pedido, la vendedora le pregunta cómo le fue y, si
// le fue bien, le pide un referido (la misma regla que «PARA HACER URGENTE» del tablero de Formas Shop). El CRM le deja
// una tarea con eso. Un cliente con varios pedidos recibidos en la misma semana lleva una sola tarea.

export const POSTENTREGA_DIAS = 3;
const VENTANA_DIAS = 10;   // entregas más viejas no crean tarea (así la primera lectura de ClickUp no llena la agenda)
const AGRUPA_DIAS = 6;
// Clientes internos o de prueba, y lo que carga la tienda con vendedor «STP» (muestras del equipo).
const INTERNO = /^(formas( publicitarias)?|soutex|cliente ?123)\b/i;

const DAY = 86_400_000;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export interface Entrega { npdv: string; cliente: string; vendedor: string; recibido: string | null; ownerId: number | null }

export async function tareaPostEntrega(db: D1Database, ctx: Ctx, orderId: number, e: Entrega, today = new Date()) {
  if (!e.ownerId || INTERNO.test(e.cliente.trim()) || /^stp$/i.test(e.vendedor.trim())) return null;
  const recibido = e.recibido && /^\d{4}-\d{2}-\d{2}$/.test(e.recibido) ? e.recibido : today.toISOString().slice(0, 10);
  const recibidoMs = Date.parse(`${recibido}T12:00:00Z`);
  if (today.getTime() - recibidoMs > VENTANA_DIAS * DAY) return null;

  const company = await db.prepare(`SELECT r.id, r.name FROM associations a JOIN records r ON r.id = CASE WHEN a.from_id = ?1 THEN a.to_id ELSE a.from_id END
    WHERE (a.from_id = ?1 AND a.to_type = 'company') OR (a.to_id = ?1 AND a.from_type = 'company') ORDER BY a.is_primary DESC LIMIT 1`)
    .bind(orderId).first<{ id: number; name: string }>().catch(() => null);
  const key = company ? `empresa-${company.id}` : `cliente-${norm(e.cliente) || orderId}`;
  // A las 9 de Buenos Aires (12 UTC) del tercer día; si ya pasó, para hoy.
  const due = new Date(Math.max(recibidoMs + POSTENTREGA_DIAS * DAY, Date.parse(`${today.toISOString().slice(0, 10)}T12:00:00Z`)));

  // Ya hay una tarea abierta de este cliente de la misma semana: se le suma el pedido.
  const open = await db.prepare(`SELECT id, subject, meta FROM activities WHERE type = 'task' AND archived = 0 AND status != 'COMPLETED'
    AND external_id LIKE ? AND ABS(julianday(due_at) - julianday(?)) <= ? ORDER BY id DESC LIMIT 1`)
    .bind(`postentrega:${key}:%`, due.toISOString(), AGRUPA_DIAS).first<{ id: number; subject: string; meta: string }>();
  if (open) {
    const meta = JSON.parse(open.meta || '{}') as { pdvs?: string[] };
    const pdvs = [...new Set([...(meta.pdvs ?? []), e.npdv])];
    if (pdvs.length !== (meta.pdvs ?? []).length) {
      await updateActivity(db, ctx, open.id, { subject: asunto(company?.name ?? e.cliente, pdvs), meta: { ...meta, pdvs } });
    }
    await linkActivity(db, open.id, [orderId]);
    return getActivity(db, open.id);
  }

  const pdvs = [e.npdv];
  return createActivity(db, ctx, {
    type: 'task', task_type: 'whatsapp', priority: 'high', owner_id: e.ownerId,
    subject: asunto(company?.name ?? e.cliente, pdvs),
    body: [
      `Recibió el pedido el ${recibido.split('-').reverse().join('/')}.`,
      '1. Preguntale cómo le fue con el pedido.',
      '2. Si le fue bien, pedile un referido: alguien de otra empresa que pueda necesitar regalos o merchandising.',
      '3. Si algo salió mal, registralo y avisale a producción antes de seguir.',
      '4. A los 10 días, pedile la reseña en Google.',
    ].join('\n'),
    due_at: due.toISOString(),
    external_id: `postentrega:${key}:${e.npdv}`,
    meta: { postentrega: true, pdvs, recibido },
    links: company ? [orderId, company.id] : [orderId],
  });
}

function asunto(cliente: string, pdvs: string[]) {
  return `Post-entrega: ${cliente.trim() || 'cliente'} (PDV ${pdvs.join(', ')})`;
}
