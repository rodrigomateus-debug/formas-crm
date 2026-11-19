import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UnidadFilter } from './QuickFilters';
import { http, qs, useMeta, useAsync, fmtMoney, fmtDate, recordUrl, propOf, UNIDADES, type Activity } from '../lib';
import { EstadoEntrega, UnidadBadge, UserChip } from '../components';
import { usePeriodo, corto, pct, plural } from './Periodo';

// Inicio de Producción (pedido de Rodrigo del 18/11/2026; src/worker/inicioprod.ts). Para Producción y Logística: números
// informativos de los pedidos en el período elegido (ingresados, entregados, cumplimiento de la fecha pactada, tiempos de
// entrega) y lo de hoy (en curso por etapa, atrasados, entregas de los próximos 7 días), más sus tareas.

interface Resumen { n: number; mediana: number | null; p75: number | null; promedio: number | null }
interface Tiempos { pedido_a_entrega: Resumen; produccion_a_entrega: Resumen; pedido_a_produccion: Resumen }
interface Pedido { id: number; name: string; cliente: string | null; owner_id: number | null; unidad: string | null; etapa: string | null; pactada: string | null; fecha_pedido: string | null; evento: boolean; dias_tarde?: number }
interface Unidad extends Tiempos { unidad: string; ingresados: number; entregados: number; abiertos: number; atrasados: number; con_pactada: number; a_tiempo: number; tarde: number; dias_tarde: Resumen }
interface Datos {
  desde: string; hasta: string; hoy: string;
  kpis: { ingresados: number; ingresados_monto: number; sin_fecha_pedido: number; entregados: number; entregados_monto: number; parciales: number; abiertos: number;
    atrasados: number; proximos7: number; con_pactada: number; a_tiempo: number; tarde: number; dias_tarde: Resumen };
  tiempos: Tiempos; por_unidad: Unidad[]; etapas: Array<{ etapa: string; n: number; monto: number; unidades: Record<string, { n: number; monto: number }> }>;
  atrasados: Pedido[]; proximas: Pedido[]; remitos: Array<{ estado: string; n: number }>;
}

const d1 = (x: number | null) => (x == null ? '—' : `${String(x).replace('.', ',')} ${x === 1 ? 'día' : 'días'}`);

export default function InicioProduccion({ tareas = true }: { tareas?: boolean }) {
  const { meta } = useMeta();
  const { p, controles } = usePeriodo();
  const [unidades, setUnidades] = useState<string[]>([]);
  const u = unidades.length ? unidades.join(',') : undefined;
  const res = useAsync(() => http<Datos>('GET', `/dashboard/pedidos${qs({ desde: p.desde, hasta: p.hasta, unidades: u })}`), [p.desde, p.hasta, u]);
  const tasks = useAsync(() => tareas ? http<{ results: Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 8 })}`) : Promise.resolve({ results: [] as Activity[] }), [tareas]);
  const d = res.data, k = d?.kpis;
  const etapaOpts = propOf(meta, 'order', 'hs_pipeline_stage')?.options ?? [];
  const etapa = (v: string | null) => etapaOpts.find((o) => o.value === v)?.label ?? (v || 'Sin etapa');
  const orden = (v: string) => { const i = etapaOpts.findIndex((o) => o.value === v); return i < 0 ? 99 : i; };
  const t = d?.tiempos;

  const fila = (o: Pedido, derecha: React.ReactNode) => (
    <div key={o.id} className="assoc-item">
      <div className="grow" style={{ minWidth: 0 }}>
        <Link to={`${recordUrl('order', o.id)}?ot=1`} className="ellipsis" style={{ display: 'block' }}>{o.name}</Link>
        <div className="small muted row" style={{ gap: 6, flexWrap: 'wrap' }}>{o.unidad && <UnidadBadge k={o.unidad as never} compact />}{etapa(o.etapa)}{o.evento ? ' · Evento' : ''} · <UserChip id={o.owner_id} size="xs" /></div>
      </div>
      {derecha}
    </div>
  );

  return (
    <div className="content">
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h1 className="grow">Hola, {meta.me.name.split(' ')[0]}</h1>
        {controles}
        <UnidadFilter value={unidades} onChange={setUnidades} />
      </div>
      <p className="muted small" style={{ marginTop: -8 }}>Pedidos de {p.nombre} · del {corto(p.desde)} al {corto(p.hasta)}{res.loading ? ' · cargando…' : ''}</p>
      {res.error && <p className="danger-text">{res.error}</p>}

      <div className="kpis">
        <div className="panel kpi" title="Por la fecha del pedido en Finnegans"><div className="label">Pedidos ingresados</div><div className="value">{k?.ingresados ?? '–'}</div><div className="small muted">{fmtMoney(k?.ingresados_monto ?? 0) || '$ 0'}</div></div>
        <div className="panel kpi"><div className="label">Entregados</div><div className="value">{k?.entregados ?? '–'}</div><div className="small muted">{k ? `${fmtMoney(k.entregados_monto) || '$ 0'} · ${plural(k.parciales, 'parcial hoy', 'parciales hoy')}` : ''}</div></div>
        <div className="panel kpi" title="Entregados el día pactado o antes, sobre los entregados del período que tienen fecha pactada"><div className="label">Entregados a tiempo</div>
          <div className="value">{k ? pct(k.con_pactada ? k.a_tiempo / k.con_pactada : null) : '–'}</div><div className="small muted">{k ? `${k.a_tiempo} de ${k.con_pactada} con fecha pactada` : ''}</div></div>
        <div className="panel kpi" title="De los entregados tarde: días entre la fecha pactada y la entrega (mediana)"><div className="label">Demora de los tardíos</div>
          <div className="value">{k ? d1(k.dias_tarde.mediana) : '–'}</div><div className="small muted">{k ? `${plural(k.tarde, 'pedido tarde', 'pedidos tarde')} · mediana` : ''}</div></div>
        <div className="panel kpi" title="Hoy: pedidos no entregados con la fecha pactada vencida"><div className="label">Atrasados hoy</div>
          <div className={`value${k?.atrasados ? ' overdue' : ''}`}>{k?.atrasados ?? '–'}</div><div className="small muted">{k ? `de ${k.abiertos} en curso · ${k.proximos7} pactados en 7 días` : ''}</div></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Pedidos en curso hoy</h2><span className="small muted">No entregados (o entregados en parte), por etapa y unidad de negocio</span></div>
        <div className="panel-body" style={{ overflowX: 'auto' }}>
          {d?.etapas.length ? (() => {
            const cols = [...UNIDADES.filter((x) => !unidades.length || unidades.includes(x.key)).map((x) => ({ k: x.key as string })), ...(d.etapas.some((e) => e.unidades.otra) ? [{ k: 'otra' }] : [])];
            const filas = [...d.etapas].sort((a, b) => orden(a.etapa) - orden(b.etapa));
            const tot = (k: string) => filas.reduce((s, e) => ({ n: s.n + (e.unidades[k]?.n ?? 0), monto: s.monto + (e.unidades[k]?.monto ?? 0) }), { n: 0, monto: 0 });
            const celda = (x?: { n: number; monto: number }) => x?.n ? <><b>{x.n}</b> <span className="small muted">{fmtMoney(x.monto) || '$ 0'}</span></> : <span className="muted">—</span>;
            return <table className="dir-tabla">
              <thead><tr><th>Etapa</th>{cols.map((c) => <th key={c.k} className="num">{c.k === 'otra' ? 'Sin unidad' : <UnidadBadge k={c.k as never} />}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {filas.map((e) => <tr key={e.etapa}><td>{etapa(e.etapa)}</td>{cols.map((c) => <td key={c.k} className="num">{celda(e.unidades[c.k])}</td>)}<td className="num">{celda(e)}</td></tr>)}
                <tr className="dir-total"><td>Total</td>{cols.map((c) => <td key={c.k} className="num">{celda(tot(c.k))}</td>)}<td className="num">{celda({ n: k?.abiertos ?? 0, monto: filas.reduce((s, e) => s + e.monto, 0) })}</td></tr>
              </tbody>
            </table>;
          })() : <div className="muted">{res.loading ? 'Cargando…' : 'No hay pedidos en curso.'}</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Tiempos de entrega</h2><span className="small muted">Pedidos entregados en el período · días corridos</span></div>
        <div className="panel-body" style={{ overflowX: 'auto' }}>
          <table className="dir-tabla">
            <thead><tr><th>Tramo</th><th className="num">Mediana</th><th className="num" title="El 75 % de los pedidos tardó esto o menos">Percentil 75</th><th className="num">Promedio</th><th className="num">Pedidos con el dato</th></tr></thead>
            <tbody>
              {t && ([['Desde el pedido hasta la entrega', t.pedido_a_entrega], ['Desde listo para producción hasta la entrega', t.produccion_a_entrega], ['Desde el pedido hasta listo para producción', t.pedido_a_produccion]] as Array<[string, Resumen]>).map(([l, r]) => (
                <tr key={l}><td>{l}</td><td className="num"><b>{d1(r.mediana)}</b></td><td className="num">{d1(r.p75)}</td><td className="num">{d1(r.promedio)}</td><td className="num muted">{r.n} de {k?.entregados ?? 0}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: '8px 0 0' }}>«Listo para producción» es la primera vez que el pedido pasó a Listo para producción, Esperando boceto o En producción, según el historial del CRM (existe para los pedidos que pasaron por ahí desde que están en el CRM). La fecha del pedido es la de Finnegans.</p>
        </div>
      </div>

      {d && d.por_unidad.length > 0 && <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Por unidad de negocio</h2></div>
        <div className="panel-body" style={{ overflowX: 'auto' }}>
          <table className="dir-tabla">
            <thead><tr><th>Unidad</th><th className="num">Ingresados</th><th className="num">Entregados</th><th className="num">A tiempo</th><th className="num">Demora tardíos</th><th className="num">Pedido → entrega</th><th className="num">Producción → entrega</th><th className="num">En curso</th><th className="num">Atrasados</th></tr></thead>
            <tbody>
              {d.por_unidad.map((x) => (
                <tr key={x.unidad}>
                  <td><UnidadBadge k={x.unidad as never} /></td>
                  <td className="num">{x.ingresados}</td><td className="num">{x.entregados}</td>
                  <td className="num" title={`${x.a_tiempo} de ${x.con_pactada}`}>{pct(x.con_pactada ? x.a_tiempo / x.con_pactada : null)}</td>
                  <td className="num">{d1(x.dias_tarde.mediana)}</td>
                  <td className="num" title={`p75 ${d1(x.pedido_a_entrega.p75)} · ${x.pedido_a_entrega.n} pedidos`}>{d1(x.pedido_a_entrega.mediana)}</td>
                  <td className="num" title={`p75 ${d1(x.produccion_a_entrega.p75)} · ${x.produccion_a_entrega.n} pedidos`}>{d1(x.produccion_a_entrega.mediana)}</td>
                  <td className="num">{x.abiertos}</td><td className={`num${x.atrasados ? ' danger-text' : ''}`}>{x.atrasados}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Atrasados hoy</h2><span className={`small ${k?.atrasados ? 'danger-text' : 'muted'}`}>{k ? `${k.atrasados}` : ''}</span></div>
          {d?.atrasados.length ? d.atrasados.map((o) => fila(o, <span className="small num danger-text" title={`Pactado para el ${corto(o.pactada!)}`}>{plural(o.dias_tarde ?? 0, 'día', 'días')} tarde</span>))
            : <div className="empty plain">{res.loading ? 'Cargando…' : 'Nada atrasado.'}</div>}
          {k && k.atrasados > (d?.atrasados.length ?? 0) && <div className="small muted" style={{ padding: '8px 20px' }}>Y {k.atrasados - d!.atrasados.length} más.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Entregas pactadas en los próximos 7 días</h2><span className="small muted">{k?.proximos7 ?? ''}</span></div>
          {d?.proximas.length ? d.proximas.map((o) => fila(o, <span className="small num">{corto(o.pactada!)}</span>))
            : <div className="empty plain">{res.loading ? 'Cargando…' : 'No hay entregas pactadas para esta semana.'}</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Remitos de lo entregado</h2><span className="small muted">Entregados en el período</span></div>
          <div className="panel-body stack" style={{ gap: 8 }}>
            {d?.remitos.length ? d.remitos.map((r) => <div key={r.estado} className="row"><span className="grow"><EstadoEntrega value={r.estado} /></span><b className="num">{r.n}</b></div>)
              : <div className="muted">{res.loading ? 'Cargando…' : 'Sin datos de remitos en el período.'}</div>}
          </div>
        </div>
        {tareas && <div className="panel">
          <div className="panel-head"><h2>Tareas para hoy y vencidas</h2><Link to="/tasks" className="small">Todas</Link></div>
          {tasks.data?.results.length ? tasks.data.results.map((x) => (
            <div key={x.id} className="assoc-item">
              <div className="grow"><div className="ellipsis">{x.subject}</div><div className="small muted">{x.links.map((l) => l.name).join(' · ')}</div></div>
              <span className={`small${x.due_at && Date.parse(x.due_at) < Date.now() ? ' overdue' : ' muted'}`}>{fmtDate(x.due_at, true)}</span>
            </div>
          )) : <div className="empty">Nada pendiente para hoy.</div>}
        </div>}
      </div>
      {k && k.sin_fecha_pedido > 0 && <p className="small muted" style={{ marginTop: 12 }}>{plural(k.sin_fecha_pedido, 'pedido todavía no tiene', 'pedidos todavía no tienen')} la fecha del pedido de Finnegans (se completa con la corrida diaria de totales): no cuentan como ingresados ni en los tiempos desde el pedido.</p>}
    </div>
  );
}
