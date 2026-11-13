import type { Ctx } from './env';
import { HttpError } from './env';
import { associate } from './associations';
import { montosDesdePedidos } from './montos';
import { UNIDADES } from './records';
import { resolverEmpresa } from './razones';

// El negocio y su pedido (pedido de Rodrigo del 13/11/2026): el negocio guarda el N° de PDV (se pide al pasar a «Pasos
// operativos» o, en Corporate, a «Cierre ganado») y con ese número se asocia solo con el pedido:
//   - si el pedido ya está en el CRM, al guardar el número;
//   - si todavía no llegó (de ClickUp o de Finnegans), cuando llega.
// Sin número, un pedido nuevo se asocia solo cuando no hay dudas: su empresa tiene un único negocio esperando pedido
// (en una etapa que pide el PDV, o ganado) en la misma unidad. Si no, queda «Sin negocio» en la lista de pedidos.
// Un pedido va en un solo negocio (associations.ts); el monto del negocio pasa a ser el total de sus pedidos (montos.ts).

// «PDV 31584», «31584», «PEDVTASTP - 00031584», «PDV - 31584» → 31584.
export function numeroPdv(v: unknown): number | null {
  const m = String(v ?? '').match(/(\d{1,8})\s*$/) ?? String(v ?? '').match(/(\d{1,8})/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// La unidad del negocio como la tienen los pedidos («FORMAS SHOP», «CORPORATE», «NO ESTRÉS»), por el equipo de su pipeline.
async function unidadDelNegocio(db: D1Database, pipelineId: string | null) {
  if (!pipelineId) return null;
  const p = await db.prepare('SELECT team_id FROM pipelines WHERE id = ?').bind(pipelineId).first<{ team_id: number | null }>();
  return Object.values(UNIDADES).find((u) => u.team === p?.team_id)?.pedido ?? null;
}
const mismaUnidad = (unidades: string[] | null, unidad: unknown) => !unidades || !unidad || unidades.includes(String(unidad).toUpperCase());

interface Pedido { id: number; name: string; unidad: string | null; negocio: number | null }
async function pedidosConNumero(db: D1Database, n: number) {
  return (await db.prepare(`SELECT r.id, r.name, json_extract(r.props, '$.unidad_de_negocio') AS unidad,
      (SELECT x.to_id FROM associations x JOIN records d ON d.id = x.to_id AND d.archived = 0 WHERE x.from_id = r.id AND x.to_type = 'deal' LIMIT 1) AS negocio
    FROM records r WHERE r.object_type = 'order' AND r.archived = 0
      AND CAST(json_extract(r.props, '$.pdv_finnegans') AS TEXT) IN (?1, 'PDV - ' || ?1, 'PDV ' || ?1)`).bind(String(n)).all<Pedido>()).results;
}

export type Vinculo = { estado: 'sin_numero' | 'esperando' | 'asociado' | 'ya_estaba'; pedido?: { id: number; name: string } };

// Al guardar el N° de PDV en un negocio. Rebota si ese PDV ya es de otro negocio. `valor`: el número que se está por
// guardar; con `soloRevisar` no asocia nada (se llama antes de guardar, para rebotar sin haber cambiado el negocio).
export async function vincularNegocio(db: D1Database, ctx: Ctx, dealId: number, opts: { valor?: unknown; soloRevisar?: boolean } = {}): Promise<Vinculo> {
  const deal = await db.prepare("SELECT id, name, pipeline_id, json_extract(props, '$.pdv_finnegans') AS pdv FROM records WHERE id = ? AND object_type = 'deal'")
    .bind(dealId).first<{ id: number; name: string; pipeline_id: string | null; pdv: string | number | null }>();
  const n = numeroPdv('valor' in opts ? opts.valor : deal?.pdv);
  if (!deal || !n) return { estado: 'sin_numero' };
  const unidades = await unidadDelNegocio(db, deal.pipeline_id);
  // Otro negocio de la misma unidad con ese número: es un error de tipeo o el pedido ya está cargado en otro lado.
  const otros = (await db.prepare(`SELECT id, name, pipeline_id, json_extract(props, '$.pdv_finnegans') AS pdv FROM records WHERE object_type = 'deal' AND archived = 0 AND id != ?1
      AND json_extract(props, '$.pdv_finnegans') IS NOT NULL AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) LIKE '%' || ?2`).bind(dealId, String(n))
    .all<{ id: number; name: string; pipeline_id: string | null; pdv: string }>()).results;
  for (const o of otros) {
    if (numeroPdv(o.pdv) !== n) continue;
    const u = await unidadDelNegocio(db, o.pipeline_id);
    if (!unidades || !u || u.some((x) => unidades.includes(x))) throw new HttpError(409, `El PDV ${n} ya está cargado en el negocio «${o.name}». Un pedido va en un solo negocio.`);
  }
  const candidatos = (await pedidosConNumero(db, n)).filter((p) => mismaUnidad(unidades, p.unidad));
  const pedido = candidatos.find((p) => p.negocio === dealId) ?? candidatos.find((p) => p.negocio == null) ?? candidatos[0];
  if (!pedido) return { estado: 'esperando' };
  if (pedido.negocio === dealId) return { estado: 'ya_estaba', pedido };
  if (pedido.negocio != null) {
    const o = await db.prepare('SELECT name FROM records WHERE id = ?').bind(pedido.negocio).first<{ name: string }>();
    throw new HttpError(409, `El pedido «${pedido.name}» ya está en el negocio «${o?.name ?? pedido.negocio}». Un pedido va en un solo negocio: quitalo de ese para sumarlo a este.`);
  }
  if (opts.soloRevisar) return { estado: 'esperando', pedido };
  await associate(db, ctx, pedido.id, dealId);
  await montosDesdePedidos(db, [dealId], ctx);
  // La empresa del negocio pasa a ser la del pedido, y su razón social, una de las de esa empresa (razones.ts).
  await resolverEmpresa(db, ctx, pedido.id).catch(() => undefined);
  return { estado: 'asociado', pedido };
}

// Cuando entra un pedido (o para los que siguen sin negocio): el negocio que tiene su número; si ninguno lo tiene, el único
// negocio de su empresa que está esperando pedido. Devuelve el negocio al que quedó asociado, si alguno.
export async function vincularPedido(db: D1Database, ctx: Ctx, orderId: number): Promise<number | null> {
  const o = await db.prepare(`SELECT r.id, json_extract(r.props, '$.pdv_finnegans') AS pdv, json_extract(r.props, '$.unidad_de_negocio') AS unidad,
      EXISTS (SELECT 1 FROM associations x JOIN records d ON d.id = x.to_id AND d.archived = 0 WHERE x.from_id = r.id AND x.to_type = 'deal') AS con_negocio,
      (SELECT x.to_id FROM associations x WHERE x.from_id = r.id AND x.to_type = 'company' ORDER BY x.is_primary DESC, x.created_at LIMIT 1) AS empresa
    FROM records r WHERE r.id = ? AND r.object_type = 'order' AND r.archived = 0`).bind(orderId)
    .first<{ id: number; pdv: string | number | null; unidad: string | null; con_negocio: number; empresa: number | null }>();
  if (!o || o.con_negocio) return null;
  const unidadOk = async (pipelineId: string | null) => mismaUnidad(await unidadDelNegocio(db, pipelineId), o.unidad);
  const asociar = async (dealId: number) => {
    await associate(db, { ...ctx, sourceDetail: 'Pedido con su negocio' }, orderId, dealId);
    await montosDesdePedidos(db, [dealId], ctx);
    await resolverEmpresa(db, ctx, orderId).catch(() => undefined);
    return dealId;
  };
  // 1. Por el número de PDV que cargaron en el negocio.
  const n = numeroPdv(o.pdv);
  if (n) {
    const { results } = await db.prepare(`SELECT id, pipeline_id, json_extract(props, '$.pdv_finnegans') AS pdv FROM records WHERE object_type = 'deal' AND archived = 0
        AND json_extract(props, '$.pdv_finnegans') IS NOT NULL AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) LIKE '%' || ?`).bind(String(n))
      .all<{ id: number; pipeline_id: string | null; pdv: string }>();
    const con: number[] = [];
    for (const d of results) if (numeroPdv(d.pdv) === n && await unidadOk(d.pipeline_id)) con.push(d.id);
    if (con.length === 1) return asociar(con[0]);
    if (con.length > 1) return null;   // el mismo número en dos negocios: lo resuelve una persona
  }
  // 2. Sin número: el único negocio de su empresa que espera pedido (etapa que pide el PDV, o ganado), sin pedidos todavía,
  //    de los últimos 90 días y de la misma unidad.
  if (!o.empresa) return null;
  const { results } = await db.prepare(`SELECT d.id, d.pipeline_id FROM associations a JOIN records d ON d.id = a.to_id AND d.object_type = 'deal' AND d.archived = 0
      JOIN stages s ON s.id = d.stage_id
    WHERE a.from_id = ?1 AND a.to_type = 'deal'
      AND (s.is_won = 1 OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(s.config, '$.ask_props'), '[]')) j WHERE j.value = 'pdv_finnegans'))
      AND COALESCE(json_extract(d.props, '$.pdv_finnegans'), '') = ''
      AND NOT EXISTS (SELECT 1 FROM associations x JOIN records p ON p.id = x.to_id AND p.archived = 0 WHERE x.from_id = d.id AND x.to_type = 'order')
      AND d.updated_at >= ?2`).bind(o.empresa, new Date(Date.now() - 90 * 86_400_000).toISOString()).all<{ id: number; pipeline_id: string | null }>();
  const esperan: number[] = [];
  for (const d of results) if (await unidadOk(d.pipeline_id)) esperan.push(d.id);
  return esperan.length === 1 ? asociar(esperan[0]) : null;
}

// Los pedidos recientes que siguen sin negocio (por si el número se cargó después, o el pedido llegó antes que su empresa).
export async function vincularPendientes(db: D1Database, ctx: Ctx, dias = 30, max = 60) {
  const { results } = await db.prepare(`SELECT r.id FROM records r WHERE r.object_type = 'order' AND r.archived = 0 AND r.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM associations x JOIN records d ON d.id = x.to_id AND d.archived = 0 WHERE x.from_id = r.id AND x.to_type = 'deal')
    ORDER BY r.created_at DESC LIMIT ?`).bind(new Date(Date.now() - dias * 86_400_000).toISOString(), max).all<{ id: number }>();
  let asociados = 0;
  for (const r of results) if (await vincularPedido(db, ctx, r.id).catch(() => null)) asociados++;
  return { revisados: results.length, asociados };
}
