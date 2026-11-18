import type { Ctx } from './env';
import { HttpError } from './env';
import { UNIDADES } from './records';

// Inicio de Dirección (pedido de Rodrigo del 18/11/2026): para los usuarios marcados «Dirección» en Configuración → Usuarios
// (Rodrigo, Martín y Wanda), un resumen orientado a resultados de todo el equipo, aunque su perfil sea Ventas. Sin tareas.
// Todo es de un período elegido (mes en curso, último mes, 90 días, YTD, un año, un mes o un rango a mano):
// - ganados, nuevos, perdidos y conversión del período; negocios abiertos (hoy);
// - ganado por vendedora con los pedidos de esos negocios (cantidad y total sin IVA), para ver si está todo cargado;
// - embudo de cada pipeline que tuvo algún negocio creado en los últimos 90 días: de los negocios creados en el período,
//   cuántos y cuánto monto pasaron por cada etapa (por el historial de etapas) y el porcentaje de conversión;
// - motivos de pérdida, ranking por empresa y negocios abiertos sin actividad hace 14 días.

const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';   // etapa «Anulado» de pedidos (montos.ts)
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export const esDireccion = (u: { direccion?: number | null }) => !!u.direccion;

// Un día de Argentina (UTC-3) en UTC: «2026-11-01» → 2026-11-01T03:00:00.000Z.
const inicioAr = (dia: string) => `${dia}T03:00:00.000Z`;
const diaSiguiente = (dia: string) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

interface Etapa { id: string; pipeline_id: string; label: string; display_order: number; is_closed: number; is_won: number }

export async function resumenDireccion(db: D1Database, ctx: Ctx, q: Record<string, string | undefined>) {
  if (!esDireccion(ctx.user)) throw new HttpError(403, 'El Inicio de Dirección es para los usuarios marcados «Dirección» en Configuración → Usuarios.');
  const hoy = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  const desde = DIA.test(q.desde ?? '') ? q.desde! : `${hoy.slice(0, 7)}-01`;
  const hasta = DIA.test(q.hasta ?? '') ? q.hasta! : hoy;
  if (desde > hasta) throw new HttpError(400, 'La fecha «desde» es posterior a «hasta».');
  const ci = inicioAr(desde), cf = inicioAr(diaSiguiente(hasta));   // creados: [ci, cf)
  const owner = q.owner && q.owner !== 'all' && Number.isFinite(Number(q.owner)) ? Number(q.owner) : null;
  const teams = (q.unidades ?? '').split(',').filter((k) => UNIDADES[k]).map((k) => UNIDADES[k].team);
  const f = `${owner ? ' AND r.owner_id = ?' : ''}${teams.length ? ` AND r.pipeline_id IN (SELECT id FROM pipelines WHERE team_id IN (${teams.map(() => '?').join(', ')}))` : ''}`;
  const fb = [...(owner ? [owner] : []), ...teams];
  const base = `r.object_type = 'deal' AND r.archived = 0${f}`;
  const cerradoEn = "substr(r.close_date, 1, 10) BETWEEN ? AND ?";
  const hace90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const hace14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const empresa = "(SELECT a.to_id FROM associations a WHERE a.from_id = r.id AND a.to_type = 'company' ORDER BY a.is_primary DESC, a.created_at LIMIT 1)";

  const [kpis, abiertos, ganado, perdidos, etapas, pipes, cohorte, empresas, quietos, quietosN] = await db.batch([
    db.prepare(`SELECT
        SUM(CASE WHEN r.created_at >= ? AND r.created_at < ? THEN 1 ELSE 0 END) AS nuevos,
        SUM(CASE WHEN r.created_at >= ? AND r.created_at < ? THEN COALESCE(r.amount, 0) ELSE 0 END) AS nuevos_monto,
        SUM(CASE WHEN s.is_won = 1 AND ${cerradoEn} THEN 1 ELSE 0 END) AS ganados,
        SUM(CASE WHEN s.is_won = 1 AND ${cerradoEn} THEN COALESCE(r.amount, 0) ELSE 0 END) AS ganados_monto,
        SUM(CASE WHEN s.is_closed = 1 AND s.is_won = 0 AND ${cerradoEn} THEN 1 ELSE 0 END) AS perdidos,
        SUM(CASE WHEN s.is_closed = 1 AND s.is_won = 0 AND ${cerradoEn} THEN COALESCE(r.amount, 0) ELSE 0 END) AS perdidos_monto
      FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${base}`)
      .bind(ci, cf, ci, cf, desde, hasta, desde, hasta, desde, hasta, desde, hasta, ...fb),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS monto FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${base} AND s.is_closed = 0`).bind(...fb),
    // Ganado por vendedora y los pedidos (no anulados) de esos negocios: así se ve si a algún ganado le falta el pedido.
    db.prepare(`WITH g AS (SELECT r.id, r.owner_id, r.amount FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${base} AND s.is_won = 1 AND ${cerradoEn}),
        p AS (SELECT g.id AS deal_id, o.id AS order_id, o.amount FROM g JOIN associations a ON a.from_id = g.id AND a.to_type = 'order'
          JOIN records o ON o.id = a.to_id AND o.object_type = 'order' AND o.archived = 0 AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '') != ?)
      SELECT g.owner_id, COUNT(*) AS n, COALESCE(SUM(g.amount), 0) AS monto,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM p WHERE p.deal_id = g.id) THEN 1 ELSE 0 END) AS sin_pedido,
        (SELECT COUNT(DISTINCT p.order_id) FROM p JOIN g g2 ON g2.id = p.deal_id WHERE g2.owner_id IS g.owner_id) AS pedidos,
        (SELECT COALESCE(SUM(x.amount), 0) FROM (SELECT DISTINCT p.order_id, p.amount FROM p JOIN g g2 ON g2.id = p.deal_id WHERE g2.owner_id IS g.owner_id) x) AS pedidos_monto
      FROM g GROUP BY g.owner_id ORDER BY monto DESC`).bind(...fb, desde, hasta, ANULADO),
    db.prepare(`SELECT json_extract(r.props, '$.motivo_de_cierre_perdido') AS motivo, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS monto
      FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${base} AND s.is_closed = 1 AND s.is_won = 0 AND ${cerradoEn} GROUP BY motivo ORDER BY n DESC`).bind(...fb, desde, hasta),
    db.prepare(`SELECT s.id, s.pipeline_id, s.label, s.display_order, s.is_closed, s.is_won FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.archived = 0 AND p.archived = 0 AND p.object_type = 'deal' ORDER BY s.pipeline_id, s.display_order`),
    // Pipelines con algún negocio creado en los últimos 90 días (fijo, no depende del período).
    db.prepare(`SELECT p.id, p.label FROM pipelines p WHERE p.archived = 0 AND p.object_type = 'deal'
      AND EXISTS (SELECT 1 FROM records r WHERE r.pipeline_id = p.id AND ${base} AND r.created_at >= ?) ORDER BY p.display_order, p.label`).bind(...fb, hace90),
    // Los negocios creados en el período, con todas las etapas por las que pasaron (historial de etapas).
    db.prepare(`SELECT r.id, r.pipeline_id, r.stage_id, COALESCE(r.amount, 0) AS monto,
        (SELECT json_group_array(DISTINCT c.new_value) FROM changes c WHERE c.record_id = r.id AND c.prop = 'dealstage') AS etapas
      FROM records r WHERE ${base} AND r.created_at >= ? AND r.created_at < ?`).bind(...fb, ci, cf),
    db.prepare(`WITH d AS (SELECT r.id, r.amount, r.created_at, r.close_date, s.is_closed, s.is_won, ${empresa} AS cid
        FROM records r JOIN stages s ON s.id = r.stage_id WHERE ${base} AND ((r.created_at >= ? AND r.created_at < ?) OR (s.is_closed = 1 AND ${cerradoEn})))
      SELECT d.cid, c.name,
        SUM(CASE WHEN d.created_at >= ? AND d.created_at < ? THEN 1 ELSE 0 END) AS oportunidades,
        SUM(CASE WHEN d.created_at >= ? AND d.created_at < ? THEN COALESCE(d.amount, 0) ELSE 0 END) AS oportunidades_monto,
        SUM(CASE WHEN d.is_won = 1 AND substr(d.close_date, 1, 10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS ganados,
        SUM(CASE WHEN d.is_won = 1 AND substr(d.close_date, 1, 10) BETWEEN ? AND ? THEN COALESCE(d.amount, 0) ELSE 0 END) AS ganados_monto,
        SUM(CASE WHEN d.is_closed = 1 AND d.is_won = 0 AND substr(d.close_date, 1, 10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS perdidos,
        SUM(CASE WHEN d.is_closed = 0 THEN 1 ELSE 0 END) AS abiertos,
        SUM(CASE WHEN d.is_closed = 0 THEN COALESCE(d.amount, 0) ELSE 0 END) AS abiertos_monto
      FROM d LEFT JOIN records c ON c.id = d.cid GROUP BY d.cid ORDER BY ganados_monto DESC, oportunidades_monto DESC LIMIT 60`)
      .bind(...fb, ci, cf, desde, hasta, ci, cf, ci, cf, desde, hasta, desde, hasta, desde, hasta),
    db.prepare(`SELECT r.id, r.name, r.stage_id, r.owner_id, r.amount FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE ${base} AND s.is_closed = 0 AND COALESCE(r.last_activity_at, r.created_at) < ? ORDER BY r.amount DESC NULLS LAST LIMIT 8`).bind(...fb, hace14),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS monto FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE ${base} AND s.is_closed = 0 AND COALESCE(r.last_activity_at, r.created_at) < ?`).bind(...fb, hace14),
  ]);

  const st = etapas.results as unknown as Etapa[];
  const filas = cohorte.results as Array<{ id: number; pipeline_id: string; stage_id: string; monto: number; etapas: string | null }>;
  const embudos = (pipes.results as Array<{ id: string; label: string }>).map((p) => {
    const delPipe = st.filter((s) => s.pipeline_id === p.id);
    // El camino: las etapas abiertas en orden y al final la ganada (las perdidas se cuentan aparte).
    const camino = [...delPipe.filter((s) => !s.is_closed), ...delPipe.filter((s) => s.is_won)];
    const pos = new Map(camino.map((s, i) => [s.id, i]));
    const perdida = new Set(delPipe.filter((s) => s.is_closed && !s.is_won).map((s) => s.id));
    const negocios = filas.filter((r) => r.pipeline_id === p.id);
    const llego = camino.map(() => ({ n: 0, monto: 0 }));
    let perdidosN = 0, perdidosMonto = 0, abiertosN = 0, abiertosMonto = 0;
    for (const r of negocios) {
      let ids: string[] = [];
      try { ids = JSON.parse(r.etapas ?? '[]'); } catch { /* sin historial */ }
      // La etapa más avanzada a la que llegó (por el historial o la actual); si no tiene ninguna del camino, la primera.
      const max = Math.max(0, ...[...ids, r.stage_id].map((id) => pos.get(id) ?? -1));
      for (let i = 0; i <= max && i < llego.length; i++) { llego[i].n++; llego[i].monto += r.monto; }
      if (perdida.has(r.stage_id)) { perdidosN++; perdidosMonto += r.monto; }
      else if (!delPipe.find((s) => s.id === r.stage_id)?.is_won) { abiertosN++; abiertosMonto += r.monto; }
    }
    return {
      id: p.id, label: p.label, creados: negocios.length, monto: negocios.reduce((s, r) => s + r.monto, 0),
      etapas: camino.map((s, i) => ({ id: s.id, label: s.label, ganada: !!s.is_won, ...llego[i] })),
      perdidos: { n: perdidosN, monto: perdidosMonto }, abiertos: { n: abiertosN, monto: abiertosMonto },
    };
  });

  return {
    desde, hasta, hoy,
    kpis: { ...(kpis.results[0] as Record<string, number | null>), abiertos: (abiertos.results[0] as { n: number }).n, abiertos_monto: (abiertos.results[0] as { monto: number }).monto },
    ganado: ganado.results, perdidos: perdidos.results, embudos, empresas: empresas.results,
    quietos: { total: (quietosN.results[0] as { n: number }).n, monto: (quietosN.results[0] as { monto: number }).monto, negocios: quietos.results },
  };
}
