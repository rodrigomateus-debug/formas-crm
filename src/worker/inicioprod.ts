import type { Ctx } from './env';
import { HttpError } from './env';
import { UNIDADES, ORDER_READY } from './records';
import { esVentas } from './alcance';

// Inicio de Producción (pedido de Rodrigo del 18/11/2026): para los perfiles Producción y Logística (y Admin y Dirección),
// números informativos de los pedidos en el período elegido:
// - pedidos ingresados (por la fecha del pedido en Finnegans), entregados y en curso hoy, por etapa;
// - cumplimiento de la fecha pactada: de los entregados, cuántos a tiempo y cuántos días tarde (fecha de entrega vs. entregado el);
// - tiempos de entrega (mediana y percentil 75, en días corridos): desde el pedido hasta la entrega y desde que quedó listo para
//   producción hasta la entrega (el pase a producción sale del historial de etapas, así que existe para los pedidos que
//   pasaron por ahí desde que están en el CRM);
// - lo mismo por unidad de negocio; los pedidos atrasados hoy, las entregas pactadas de los próximos 7 días y los remitos
//   que faltan.

const ENTREGADO = '1237498998';
const PARCIAL = 'entregado_parcial';
const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
// Etapas desde las que el pedido está en manos de producción (la primera vez que entró a alguna).
const EN_PRODUCCION = [ORDER_READY, 'esperando_boceto', '1237498994'];
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const UNIDAD_DE: Record<string, string> = Object.fromEntries(Object.entries(UNIDADES).flatMap(([k, u]) => u.pedido.map((p) => [p, k])));

const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
// Fecha (AAAA-MM-DD) de Argentina de un instante ISO.
const diaAr = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);
function cuantil(xs: number[], q: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 10) / 10;
}
const resumen = (xs: number[]) => ({ n: xs.length, mediana: cuantil(xs, 0.5), p75: cuantil(xs, 0.75), promedio: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null });

interface Fila {
  id: number; name: string; owner_id: number | null; amount: number | null; unidad: string | null; etapa: string | null; cliente: string | null;
  fecha_pedido: string | null; pactada: string | null; entregado: string | null; estado_entrega: string | null; tipo: string | null; inicio_prod: string | null;
}

export async function inicioProduccion(db: D1Database, ctx: Ctx, q: Record<string, string | undefined>) {
  if (esVentas(ctx.user) && !ctx.user.direccion) throw new HttpError(403, 'El Inicio de Producción no está en el perfil Ventas.');
  const hoy = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  const desde = DIA.test(q.desde ?? '') ? q.desde! : `${hoy.slice(0, 7)}-01`;
  const hasta = DIA.test(q.hasta ?? '') ? q.hasta! : hoy;
  if (desde > hasta) throw new HttpError(400, 'La fecha «desde» es posterior a «hasta».');
  const unidades = (q.unidades ?? '').split(',').filter((k) => UNIDADES[k]).flatMap((k) => UNIDADES[k].pedido);
  const en7 = new Date(Date.parse(`${hoy}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);

  // Los pedidos que importan: ingresados o entregados en el período, o abiertos hoy.
  const { results } = await db.prepare(`SELECT r.id, r.name, r.owner_id, r.amount,
      UPPER(json_extract(r.props, '$.unidad_de_negocio')) AS unidad, json_extract(r.props, '$.hs_pipeline_stage') AS etapa,
      json_extract(r.props, '$.cliente_clickup') AS cliente,
      COALESCE(json_extract(r.props, '$.fecha_pedido'), CASE WHEN r.source NOT LIKE 'clickup%' THEN substr(r.created_at, 1, 10) END) AS fecha_pedido,
      substr(json_extract(r.props, '$.fecha_de_entrega'), 1, 10) AS pactada, substr(json_extract(r.props, '$.entregado_el'), 1, 10) AS entregado,
      json_extract(r.props, '$.estado_entrega') AS estado_entrega, json_extract(r.props, '$.tipo_de_pedido') AS tipo,
      (SELECT MIN(c.changed_at) FROM changes c WHERE c.record_id = r.id AND c.prop = 'hs_pipeline_stage' AND c.new_value IN (${EN_PRODUCCION.map(() => '?').join(', ')})) AS inicio_prod
    FROM records r
    WHERE r.object_type = 'order' AND r.archived = 0 AND COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') != ?
      ${unidades.length ? `AND UPPER(COALESCE(json_extract(r.props, '$.unidad_de_negocio'), '')) IN (${unidades.map(() => '?').join(', ')})` : ''}
      AND (COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') NOT IN (?, ?)
        OR substr(json_extract(r.props, '$.entregado_el'), 1, 10) BETWEEN ? AND ?
        OR COALESCE(json_extract(r.props, '$.fecha_pedido'), CASE WHEN r.source NOT LIKE 'clickup%' THEN substr(r.created_at, 1, 10) END) BETWEEN ? AND ?)`)
    .bind(...EN_PRODUCCION, ANULADO, ...unidades, ENTREGADO, PARCIAL, desde, hasta, desde, hasta).all<Fila>();

  const enPeriodo = (d: string | null) => !!d && d >= desde && d <= hasta;
  const ingresados = results.filter((r) => enPeriodo(r.fecha_pedido));
  const entregados = results.filter((r) => r.etapa === ENTREGADO && enPeriodo(r.entregado));
  const abiertos = results.filter((r) => r.etapa !== ENTREGADO && r.etapa !== PARCIAL);

  // Cumplimiento de lo pactado, en los entregados del período que tienen fecha pactada.
  const conPactada = entregados.filter((r) => r.pactada && r.entregado);
  const demoras = conPactada.map((r) => dias(r.pactada!, r.entregado!));
  const tarde = demoras.filter((d) => d > 0);
  // Tiempos (días corridos).
  const tiempos = (xs: Fila[]) => ({
    pedido_a_entrega: resumen(xs.filter((r) => r.fecha_pedido && r.entregado && r.entregado >= r.fecha_pedido).map((r) => dias(r.fecha_pedido!, r.entregado!))),
    produccion_a_entrega: resumen(xs.filter((r) => r.inicio_prod && r.entregado && r.entregado >= diaAr(r.inicio_prod)).map((r) => dias(diaAr(r.inicio_prod!), r.entregado!))),
    pedido_a_produccion: resumen(xs.filter((r) => r.inicio_prod && r.fecha_pedido && diaAr(r.inicio_prod) >= r.fecha_pedido).map((r) => dias(r.fecha_pedido!, diaAr(r.inicio_prod!)))),
  });
  const cumplimiento = (xs: Fila[]) => {
    const c = xs.filter((r) => r.pactada && r.entregado);
    const d = c.map((r) => dias(r.pactada!, r.entregado!));
    return { con_pactada: c.length, a_tiempo: d.filter((x) => x <= 0).length, tarde: d.filter((x) => x > 0).length, dias_tarde: resumen(d.filter((x) => x > 0)) };
  };

  const porUnidad = Object.entries(UNIDADES).map(([k]) => {
    const de = (r: Fila) => UNIDAD_DE[r.unidad ?? ''] === k;
    const ent = entregados.filter(de);
    return { unidad: k, ingresados: ingresados.filter(de).length, entregados: ent.length, abiertos: abiertos.filter(de).length,
      atrasados: abiertos.filter((r) => de(r) && r.pactada && r.pactada < hoy).length, ...cumplimiento(ent), ...tiempos(ent) };
  }).filter((u) => u.ingresados || u.entregados || u.abiertos);

  const etapas = new Map<string, { n: number; monto: number }>();
  for (const r of abiertos) { const e = etapas.get(r.etapa ?? '') ?? { n: 0, monto: 0 }; e.n++; e.monto += Number(r.amount ?? 0); etapas.set(r.etapa ?? '', e); }
  const lista = (r: Fila) => ({ id: r.id, name: r.name, cliente: r.cliente, owner_id: r.owner_id, unidad: UNIDAD_DE[r.unidad ?? ''] ?? null, etapa: r.etapa,
    pactada: r.pactada, fecha_pedido: r.fecha_pedido, evento: r.tipo === 'EVENTO' });
  const atrasados = abiertos.filter((r) => r.pactada && r.pactada < hoy).map((r) => ({ ...lista(r), dias_tarde: dias(r.pactada!, hoy) }))
    .sort((a, b) => b.dias_tarde - a.dias_tarde);
  const proximas = abiertos.filter((r) => r.pactada && r.pactada >= hoy && r.pactada <= en7).map(lista).sort((a, b) => a.pactada!.localeCompare(b.pactada!));
  const remitos = new Map<string, number>();
  for (const r of results.filter((x) => (x.etapa === ENTREGADO || x.etapa === PARCIAL) && enPeriodo(x.entregado) && x.estado_entrega)) {
    remitos.set(r.estado_entrega!, (remitos.get(r.estado_entrega!) ?? 0) + 1);
  }

  return {
    desde, hasta, hoy,
    kpis: {
      ingresados: ingresados.length, ingresados_monto: ingresados.reduce((s, r) => s + Number(r.amount ?? 0), 0),
      sin_fecha_pedido: results.filter((r) => !r.fecha_pedido).length,
      entregados: entregados.length, entregados_monto: entregados.reduce((s, r) => s + Number(r.amount ?? 0), 0),
      parciales: results.filter((r) => r.etapa === PARCIAL).length,
      abiertos: abiertos.length, atrasados: atrasados.length, proximos7: proximas.length,
      con_pactada: conPactada.length, a_tiempo: demoras.filter((d) => d <= 0).length, tarde: tarde.length, dias_tarde: resumen(tarde),
    },
    tiempos: tiempos(entregados),
    por_unidad: porUnidad,
    etapas: [...etapas].map(([etapa, v]) => ({ etapa, ...v })),
    atrasados: atrasados.slice(0, 20),
    proximas: proximas.slice(0, 20),
    remitos: [...remitos].map(([estado, n]) => ({ estado, n })).sort((a, b) => b.n - a.n),
  };
}
