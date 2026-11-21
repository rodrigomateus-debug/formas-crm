// Inicio de Ventas (pedido de Rodrigo del 19/11/2026): estimación de ventas de la próxima semana y del próximo mes según los
// negocios abiertos de la vendedora, su tasa de cierre y su lag time (cuánto tardan sus negocios en cerrarse), y lo que tiene
// en marcha: negocios abiertos, pedidos abiertos y en producción y producciones en curso hoy.
//
// La estimación, negocio por negocio: para un negocio abierto que está hace `a` días en la etapa E se miran los negocios
// cerrados del último año del mismo pipeline que pasaron por E y seguían abiertos `a` días después de entrar a E (los que
// «estaban igual que este»). De esos:
//   - probabilidad de ganarlo en los próximos N días = los que se ganaron dentro de esos N días / todos;
//   - monto esperado = monto del negocio × esa probabilidad.
// Así la tasa de cierre y el lag time salen juntos y dependen de la etapa y de cuánto hace que está quieto (un negocio
// estancado vale menos que uno que acaba de avanzar). Se usan los cerrados de la vendedora si hay al menos 8 parecidos; si
// no, los del equipo (mismo pipeline); si tampoco hay 5, la probabilidad de la etapa sin lag (no suma a la semana ni al mes).

const DIA = 86_400_000;
const MIN_VENDEDORA = 8, MIN_EQUIPO = 5;
const VENTANAS = { semana: 7, mes: 30 } as const;
// Estados de la lista PEC (produccion.ts) en los que un artículo se está produciendo: ya se pidió y todavía no está listo.
// No cuentan los que no arrancaron (ingreso de pedido, pdv, personales), los que esperan (confirmación, boceto) ni los
// listos, entregados o anulados.
export const PRODUCCION_ACTIVA = ['pedido al proveedor', 'ingreso proveedor/ stock', 'en control de depósito', 'en el impresor', 'impresión aprobada',
  'articulo con logo', 'en revision'];
const ENTREGADO = '1237498998', PARCIAL = 'entregado_parcial', ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const GRUPO_PEDIDO: Record<string, 'previos' | 'produccion' | 'listos'> = {
  '4b27b500-f031-4927-9811-68a0b525cbae': 'previos', '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03': 'previos', 'aa99e8d0-c1d5-4071-b915-d240bbb1aed9': 'previos',
  '3725360f-519b-4b18-a593-494d60a29c9f': 'previos', esperando_boceto: 'produccion', '1237498994': 'produccion', '1237498996': 'listos',
};

interface Historico { owner_id: number | null; pipeline_id: string; won: number; cierre: number; entradas: Map<string, number> }

// Fecha de cierre (AAAA-MM-DD) a las 12 de Argentina.
const alMediodia = (d: string) => Date.parse(`${d.slice(0, 10)}T15:00:00Z`);

// Cerrados del último año de esos pipelines, con cuándo entró a cada etapa. Se guarda unos minutos por pipeline (es lo mismo
// para todas las vendedoras y cambia poco), así abrir el Inicio no relee el historial cada vez.
const cache = new Map<string, { at: number; filas: Historico[] }>();
async function historico(db: D1Database, pipelines: string[]) {
  const out: Historico[] = [];
  const faltan = pipelines.filter((p) => !(cache.get(p) && Date.now() - cache.get(p)!.at < 10 * 60_000));
  if (faltan.length) {
    const desde = new Date(Date.now() - 365 * DIA).toISOString().slice(0, 10);
    const { results } = await db.prepare(`SELECT r.owner_id, r.pipeline_id, s.is_won AS won, r.close_date, r.created_at,
        (SELECT json_group_array(json_array(c.new_value, c.changed_at)) FROM changes c WHERE c.record_id = r.id AND c.prop = 'dealstage') AS etapas,
        (SELECT st.id FROM stages st WHERE st.pipeline_id = r.pipeline_id ORDER BY st.display_order LIMIT 1) AS primera
      FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE r.object_type = 'deal' AND r.archived = 0 AND s.is_closed = 1 AND r.close_date >= ?
        AND r.pipeline_id IN (SELECT value FROM json_each(?))`).bind(desde, JSON.stringify(faltan))
      .all<{ owner_id: number | null; pipeline_id: string; won: number; close_date: string; created_at: string; etapas: string | null; primera: string | null }>();
    const por = new Map<string, Historico[]>(faltan.map((p) => [p, []]));
    for (const r of results) {
      const entradas = new Map<string, number>();
      let lista: Array<[string, string]> = [];
      try { lista = JSON.parse(r.etapas ?? '[]'); } catch { /* sin historial */ }
      for (const [st, at] of lista) { const t = Date.parse(at); if (st && Number.isFinite(t) && !(entradas.get(st)! <= t)) entradas.set(st, t); }
      if (r.primera && !entradas.has(r.primera)) entradas.set(r.primera, Date.parse(r.created_at));
      por.get(r.pipeline_id)?.push({ owner_id: r.owner_id, pipeline_id: r.pipeline_id, won: r.won, cierre: alMediodia(r.close_date), entradas });
    }
    for (const [p, filas] of por) cache.set(p, { at: Date.now(), filas });
  }
  for (const p of pipelines) out.push(...(cache.get(p)?.filas ?? []));
  return out;
}

const mediana = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function inicioVendedora(db: D1Database, ownerId: number | null) {
  const ahora = Date.now();
  const ow = ownerId ? 'AND r.owner_id = ?' : '';
  const ob = ownerId ? [ownerId] : [];
  const [abiertos, pedidos, prods] = await db.batch([
    db.prepare(`SELECT r.id, r.name, r.owner_id, r.pipeline_id, r.stage_id, COALESCE(r.amount, 0) AS amount, r.created_at,
        COALESCE(r.stage_entered_at, (SELECT MAX(c.changed_at) FROM changes c WHERE c.record_id = r.id AND c.prop = 'dealstage'), r.created_at) AS entro,
        s.probability FROM records r JOIN stages s ON s.id = r.stage_id
      WHERE r.object_type = 'deal' AND r.archived = 0 AND s.is_closed = 0 ${ow}`).bind(...ob),
    db.prepare(`SELECT json_extract(r.props, '$.hs_pipeline_stage') AS etapa, COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS monto FROM records r
      WHERE r.object_type = 'order' AND r.archived = 0 ${ow}
        AND COALESCE(json_extract(r.props, '$.hs_pipeline_stage'), '') NOT IN (?, ?, ?) GROUP BY etapa`).bind(...ob, ENTREGADO, PARCIAL, ANULADO),
    // Una prenda en varios talles cuenta una vez (talles.ts).
    db.prepare(`SELECT COUNT(DISTINCT COALESCE(p.pdv_task || '|' || p.grupo_talle, p.task_id)) AS articulos, COUNT(DISTINCT p.pdv_task) AS pedidos FROM produccion p JOIN records r ON r.id = p.record_id
      WHERE p.es_pdv = 0 AND LOWER(p.estado) IN (SELECT value FROM json_each(?)) ${ow}`).bind(JSON.stringify(PRODUCCION_ACTIVA), ...ob),
  ]);
  const deals = abiertos.results as Array<{ id: number; name: string; owner_id: number | null; pipeline_id: string; stage_id: string; amount: number; created_at: string; entro: string; probability: number }>;
  const hist = await historico(db, [...new Set(deals.map((d) => d.pipeline_id).filter(Boolean))]);

  let semana = 0, mes = 0, nSemana = 0, nMes = 0, deVendedora = 0, deEquipo = 0, sinHistorial = 0;
  const negocios = deals.map((d) => {
    const a = Math.max(0, ahora - Date.parse(d.entro));
    const parecidos = (h: Historico) => h.pipeline_id === d.pipeline_id && h.entradas.has(d.stage_id) && h.cierre - h.entradas.get(d.stage_id)! >= a;
    const propios = hist.filter((h) => h.owner_id === d.owner_id && parecidos(h));
    const base = propios.length >= MIN_VENDEDORA ? propios : hist.filter(parecidos);
    const fuente = propios.length >= MIN_VENDEDORA ? 'vendedora' : base.length >= MIN_EQUIPO ? 'equipo' : 'etapa';
    const ganados = base.filter((h) => h.won);
    // Días que le faltan a cada ganado parecido para cerrarse, contando desde hoy.
    const faltan = ganados.map((h) => Math.max(0, (h.cierre - h.entradas.get(d.stage_id)! - a) / DIA));
    const p = fuente === 'etapa' ? Number(d.probability ?? 0) : ganados.length / base.length;
    const p7 = fuente === 'etapa' ? 0 : faltan.filter((x) => x <= VENTANAS.semana).length / base.length;
    const p30 = fuente === 'etapa' ? 0 : faltan.filter((x) => x <= VENTANAS.mes).length / base.length;
    if (fuente === 'vendedora') deVendedora++; else if (fuente === 'equipo') deEquipo++; else sinHistorial++;
    semana += d.amount * p7; mes += d.amount * p30;
    if (p7 > 0) nSemana++;
    if (p30 > 0) nMes++;
    const lag = mediana(faltan);
    return { id: d.id, name: d.name, owner_id: d.owner_id, stage_id: d.stage_id, amount: d.amount, dias_en_etapa: Math.floor(a / DIA),
      p: Math.round(p * 100) / 100, p7: Math.round(p7 * 100) / 100, p30: Math.round(p30 * 100) / 100, esperado_mes: Math.round(d.amount * p30),
      cierre_estimado: lag == null ? null : new Date(ahora + lag * DIA - 3 * 3_600_000).toISOString().slice(0, 10), fuente, parecidos: base.length };
  });

  // Tasa de cierre y lag time del último año (de la vendedora, o de todas si es el equipo), para mostrar al lado.
  const suyos = hist.filter((h) => !ownerId || h.owner_id === ownerId);
  const ganadosSuyos = suyos.filter((h) => h.won);
  const lags = ganadosSuyos.map((h) => { const ini = Math.min(...h.entradas.values()); return Number.isFinite(ini) ? (h.cierre - ini) / DIA : null; }).filter((x): x is number => x != null && x >= 0);

  const grupos = { previos: { n: 0, monto: 0 }, produccion: { n: 0, monto: 0 }, listos: { n: 0, monto: 0 } };
  for (const r of pedidos.results as Array<{ etapa: string | null; n: number; monto: number }>) {
    const g = grupos[GRUPO_PEDIDO[r.etapa ?? ''] ?? 'previos'];
    g.n += r.n; g.monto += r.monto;
  }
  const pr = prods.results[0] as { articulos: number; pedidos: number } | undefined;
  return {
    estimacion: {
      semana: Math.round(semana), mes: Math.round(mes), negocios_semana: nSemana, negocios_mes: nMes,
      tasa_cierre: suyos.length ? ganadosSuyos.length / suyos.length : null, cerrados: suyos.length, lag_mediana: mediana(lags),
      fuentes: { vendedora: deVendedora, equipo: deEquipo, etapa: sinHistorial },
      negocios: negocios.filter((n) => n.esperado_mes > 0).sort((a, b) => b.esperado_mes - a.esperado_mes).slice(0, 8),
    },
    negocios_abiertos: { n: deals.length, monto: deals.reduce((s, d) => s + d.amount, 0) },
    pedidos: { abiertos: grupos.previos.n + grupos.produccion.n + grupos.listos.n, monto: grupos.previos.monto + grupos.produccion.monto + grupos.listos.monto, ...grupos },
    producciones: { articulos: pr?.articulos ?? 0, pedidos: pr?.pedidos ?? 0 },
  };
}
