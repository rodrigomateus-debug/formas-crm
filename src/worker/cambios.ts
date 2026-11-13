import type { Ctx } from './env';
import { compartidosDe } from './compartidos';

// Avisos de cambios sensibles al vendedor (pedido de Rodrigo del 13/11/2026). Producción sube logos y bocetos, cambia
// direcciones y fechas de entrega…: cuando lo hace otra persona, el vendedor se tiene que enterar. Le llega a la campanita
// (notificaciones.ts) y, si tiene «Avisos por mail» prendido, por mail (avisos.ts), con qué cambió y quién.
//
// Qué avisa (en un pedido, al propietario y a quienes lo tienen compartido —compartidos.ts—; en un negocio o una empresa, a
// su propietario):
// - bocetos: subido, aprobado o vuelto a «para aprobar», pasado a otro producto, quitado (api.ts);
// - logos: subido, elegido para un producto, cambiado el principal, quitado (api.ts);
// - dirección de entrega y su reparto (direcciones.ts, también desde la parada del cronograma);
// - fecha de entrega y etapa del pedido cambiadas a mano (records.ts), y la fecha de entrega de Producción (produccion.ts).
// No avisa a quien hizo el cambio, ni lo que mueven las integraciones o la sincronización con ClickUp (solo personas:
// pantalla, Claude o la API con el token de alguien).
//
// Los cambios seguidos de la misma persona en el mismo pedido (dentro de 15 minutos, mientras el aviso no se leyó ni salió
// por mail) se juntan en un solo aviso con la lista de lo que cambió, para no llenar la campanita al subir varios bocetos.

const FUENTES_PERSONA = ['crm', 'mcp', 'api'];
const JUNTAR_MS = 15 * 60_000;
const MAX_DETALLE = 20;

export async function avisarCambio(db: D1Database, ctx: Ctx, recordId: number | null | undefined, texto: string) {
  try {
    if (!recordId || !FUENTES_PERSONA.includes(ctx.source) || !texto.trim()) return;
    const rec = await db.prepare('SELECT id, object_type, owner_id FROM records WHERE id = ?').bind(recordId)
      .first<{ id: number; object_type: string; owner_id: number | null }>();
    if (!rec || !['order', 'deal', 'company'].includes(rec.object_type)) return;
    const autor = ctx.actor ? ctx.actor.userId : ctx.user.id;
    const yo = new Set([ctx.user.id, ctx.actor?.userId].filter((x): x is number => x != null));
    const candidatos = [...new Set([rec.owner_id, ...(rec.object_type === 'order' ? await compartidosDe(db, rec.id) : [])]
      .filter((u): u is number => u != null && !yo.has(Number(u))).map(Number))];
    if (!candidatos.length) return;
    const { results } = await db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND active = 1 AND deleted_at IS NULL')
      .bind(JSON.stringify(candidatos)).all<{ id: number }>();
    if (!results.length) return;
    const t = texto.replace(/\s+/g, ' ').trim().slice(0, 300);
    const desde = new Date(Date.now() - JUNTAR_MS).toISOString();
    // El aviso abierto al que se suma (si hay): de la misma persona y el mismo registro, reciente, sin leer ni mandar.
    const abierto = `SELECT id FROM avisos WHERE user_id = ?2 AND kind = 'cambio' AND record_id = ?3 AND by_user IS ?4 AND sent_at IS NULL
      AND leido_at IS NULL AND created_at > ?5 AND json_array_length(COALESCE(detalle, '[]')) < ${MAX_DETALLE} ORDER BY id DESC LIMIT 1`;
    await db.batch(results.flatMap(({ id: u }) => [
      // Se suma a la lista (si no estaba ya ese mismo cambio)…
      db.prepare(`UPDATE avisos SET detalle = json_insert(COALESCE(detalle, '[]'), '$[#]', ?1) WHERE id = (${abierto})
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(avisos.detalle, '[]')) WHERE value = ?1)`).bind(t, u, rec.id, autor, desde),
      // …o es un aviso nuevo.
      db.prepare(`INSERT INTO avisos (user_id, kind, record_id, by_user, detalle) SELECT ?2, 'cambio', ?3, ?4, json_array(?1)
        WHERE NOT EXISTS (${abierto})`).bind(t, u, rec.id, autor, desde),
    ]));
  } catch (e) {
    // El aviso nunca frena el cambio.
    console.error('avisar cambio', recordId, (e as Error).message);
  }
}

// ---------- Cómo se cuenta cada cambio ----------

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// «mié 18/11/2026» (las fechas del CRM son AAAA-MM-DD o ISO; las de solo día van al mediodía para no cambiar por el huso).
export function fechaCorta(v: unknown) {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return `${DIAS[d.getUTCDay()]} ${m[3]}/${m[2]}/${m[1]}`;
}

const de = (producto: string | null | undefined) => (producto ? ` de ${producto}` : '');
const comillas = (s: string | null | undefined) => `«${(s ?? '').trim() || 'sin nombre'}»`;

export const textoBoceto = {
  subido: (b: { nombre: string; tipo: string; version: number; producto_nombre: string | null; producto: string | null }) =>
    `Subió ${b.tipo === 'referencia' ? 'una referencia' : 'el boceto'} ${comillas(b.nombre)}${de(b.producto_nombre ?? b.producto)}${b.version > 1 ? ` (versión ${b.version})` : ''}`,
  aprobado: (b: { nombre: string; producto_nombre: string | null; producto: string | null }) => `Aprobó el boceto ${comillas(b.nombre)}${de(b.producto_nombre ?? b.producto)}`,
  paraAprobar: (b: { nombre: string; producto_nombre: string | null; producto: string | null }) =>
    `Volvió a «para aprobar» el boceto ${comillas(b.nombre)}${de(b.producto_nombre ?? b.producto)}`,
  otroProducto: (b: { nombre: string; producto_nombre: string | null; producto: string | null }) =>
    `Pasó el boceto ${comillas(b.nombre)} a ${b.producto_nombre ?? b.producto ?? 'ningún producto'}`,
  tipo: (b: { nombre: string; tipo: string }) => `Marcó el boceto ${comillas(b.nombre)} como ${b.tipo === 'referencia' ? 'referencia' : 'técnico'}`,
  quitado: (b: { nombre: string; producto_nombre: string | null; producto: string | null }) => `Quitó el boceto ${comillas(b.nombre)}${de(b.producto_nombre ?? b.producto)}`,
  usado: (b: { nombre: string; producto_nombre: string | null; producto: string | null }) =>
    `Sumó el boceto ${comillas(b.nombre)} del negocio${de(b.producto_nombre ?? b.producto)}`,
};

const nombreLogo = (l: { etiqueta: string | null; nombre: string }) => comillas(l.etiqueta ? `${l.etiqueta} · ${l.nombre}` : l.nombre);
export const textoLogo = {
  subido: (l: { etiqueta: string | null; nombre: string }, producto?: string | null) => `Subió el logo ${nombreLogo(l)}${producto ? ` para ${producto}` : ''}`,
  elegido: (l: { etiqueta: string | null; nombre: string } | null, producto: string) =>
    l ? `Eligió el logo ${nombreLogo(l)} para ${producto}` : `Dejó el logo principal de la empresa para ${producto}`,
  principal: (l: { etiqueta: string | null; nombre: string }) => `Cambió el logo principal a ${nombreLogo(l)}`,
  quitado: (l: { etiqueta: string | null; nombre: string }) => `Quitó el logo ${nombreLogo(l)}`,
};
