import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UnidadFilter } from './QuickFilters';
import { http, qs, useMeta, useAsync, fmtMoney, recordUrl, stageOf } from '../lib';
import { UserChip, userOption } from '../components';
import { Select } from '../Select';
import { usePeriodo, corto, pct, plural } from './Periodo';

// Inicio de Dirección (pedido de Rodrigo del 18/11/2026; src/worker/direccion.ts). Para los usuarios marcados «Dirección»:
// resultados de todo el equipo en el período elegido, sin tareas. Arriba los números del período; después ganado por
// vendedora con los pedidos de esos negocios (para ver si está todo cargado), negocios sin actividad, el embudo de cada
// pipeline activo, los motivos de pérdida y el ranking por empresa.

interface Ganado { owner_id: number | null; n: number; monto: number; pedidos: number; pedidos_monto: number; sin_pedido: number }
interface EtapaEmbudo { id: string; label: string; ganada: boolean; n: number; monto: number }
interface Embudo { id: string; label: string; creados: number; monto: number; etapas: EtapaEmbudo[]; perdidos: { n: number; monto: number }; abiertos: { n: number; monto: number } }
interface Empresa { cid: number | null; name: string | null; oportunidades: number; oportunidades_monto: number; ganados: number; ganados_monto: number; perdidos: number; abiertos: number; abiertos_monto: number }
interface Suelto { id: number; name: string; owner_id: number | null; amount: number | null; created_at: string; pedido: string | null }
interface Datos {
  desde: string; hasta: string; hoy: string;
  kpis: { nuevos: number | null; nuevos_monto: number | null; ganados: number | null; ganados_monto: number | null; perdidos: number | null; perdidos_monto: number | null; abiertos: number; abiertos_monto: number };
  ganado: Ganado[]; perdidos: Array<{ motivo: string | null; n: number; monto: number }>; embudos: Embudo[]; empresas: Empresa[];
  sin_negocio: { negocios: Suelto[]; por_duenio: Array<{ owner_id: number | null; n: number; monto: number }>; historico: number };
  quietos: { total: number; monto: number; negocios: Array<{ id: number; name: string; stage_id: string; owner_id: number | null; amount: number | null }> };
}

export default function InicioDireccion() {
  const { meta } = useMeta();
  const { p, controles } = usePeriodo();
  const [owner, setOwner] = useState('all');
  const [unidades, setUnidades] = useState<string[]>([]);
  const [todasEmpresas, setTodasEmpresas] = useState(false);
  const u = unidades.length ? unidades.join(',') : undefined;
  const res = useAsync(() => http<Datos>('GET', `/dashboard/direccion${qs({ desde: p.desde, hasta: p.hasta, owner, unidades: u })}`), [p.desde, p.hasta, owner, u]);
  const d = res.data;
  const k = d?.kpis;

  const ganados = Number(k?.ganados ?? 0), perdidos = Number(k?.perdidos ?? 0);
  const vendedoras = meta.users.filter((x) => x.active && x.profile === 'comercial');
  const empresas = d?.empresas ?? [];
  const sueltos = d?.sin_negocio;
  const nSueltos = (sueltos?.por_duenio ?? []).reduce((a, x) => a + x.n, 0);
  const montoSueltos = (sueltos?.por_duenio ?? []).reduce((a, x) => a + x.monto, 0);
  const sueltosDe = (o: number | null) => sueltos?.por_duenio.find((x) => x.owner_id === o);
  // Vendedoras con pedidos sin negocio pero sin ganados en el período: también van en la tabla.
  const filasGanado: Ganado[] = [...(d?.ganado ?? []), ...(sueltos?.por_duenio ?? []).filter((x) => !d?.ganado.some((g) => g.owner_id === x.owner_id))
    .map((x) => ({ owner_id: x.owner_id, n: 0, monto: 0, pedidos: 0, pedidos_monto: 0, sin_pedido: 0 }))];

  return (
    <div className="content">
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h1 className="grow">Hola, {meta.me.name.split(' ')[0]}</h1>
        {controles}
        <UnidadFilter value={unidades} onChange={setUnidades} />
        <Select className="input" style={{ width: 210 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Ver datos de">
          <option value="all">Todo el equipo</option>
          {vendedoras.map((x) => <option key={x.id} value={x.id}>{userOption(x)}</option>)}
        </Select>
      </div>
      <p className="muted small" style={{ marginTop: -8 }}>Resultados de {p.nombre} · del {corto(p.desde)} al {corto(p.hasta)}{res.loading ? ' · cargando…' : ''}</p>
      {res.error && <p className="danger-text">{res.error}</p>}
      {nSueltos > 0 && <a href="#sin-negocio" className="dir-alerta"><span aria-hidden>⚠</span>
        <span><b>{plural(nSueltos, 'pedido', 'pedidos')} del período sin negocio</b> ({fmtMoney(montoSueltos) || '$ 0'}). Todo pedido tiene que estar en un negocio: asocialos para que el ganado cuadre.</span></a>}

      <div className="kpis">
        <div className="panel kpi"><div className="label">Ganado</div><div className="value">{k ? fmtMoney(k.ganados_monto ?? 0) || '$ 0' : '–'}</div><div className="small muted">{plural(ganados, 'negocio', 'negocios')}</div></div>
        <div className="panel kpi"><div className="label">Negocios nuevos</div><div className="value">{k?.nuevos ?? '–'}</div><div className="small muted">{fmtMoney(k?.nuevos_monto ?? 0)}</div></div>
        <div className="panel kpi" title="Ganados sobre cerrados (ganados + perdidos) en el período"><div className="label">Conversión</div><div className="value">{k ? pct(ganados + perdidos ? ganados / (ganados + perdidos) : null) : '–'}</div>
          <div className="small muted">{ganados} ganados · {perdidos} perdidos</div></div>
        <div className="panel kpi"><div className="label">Perdido</div><div className="value">{k ? fmtMoney(k.perdidos_monto ?? 0) || '$ 0' : '–'}</div><div className="small muted">{plural(perdidos, 'negocio', 'negocios')}</div></div>
        <div className="panel kpi" title="Hoy, sin importar el período"><div className="label">Negocios abiertos</div><div className="value">{k?.abiertos ?? '–'}</div><div className="small muted">{fmtMoney(k?.abiertos_monto ?? 0)}</div></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Ganado por vendedora</h2><span className="small muted" title="Pedidos (no anulados) asociados a los negocios ganados en el período">negocios / pedidos</span></div>
          <div className="panel-body" style={{ overflowX: 'auto' }}>
            {filasGanado.length ? <table className="dir-tabla"><tbody>
              {filasGanado.map((g) => {
                const suelto = sueltosDe(g.owner_id);
                const descuadre = g.sin_pedido > 0 || Math.abs(g.pedidos_monto - g.monto) > Math.max(1, g.monto * 0.01);
                return (
                  <tr key={String(g.owner_id)}>
                    <td style={{ maxWidth: 200 }}><UserChip id={g.owner_id} /></td>
                    <td className="num small muted">{plural(g.n, 'negocio', 'negocios')}</td><td className="num"><b>{fmtMoney(g.monto)}</b></td>
                    <td className="muted">/</td>
                    <td className={`num small ${descuadre ? 'warn-text' : 'muted'}`} title={g.sin_pedido ? `${plural(g.sin_pedido, 'negocio ganado sin pedido', 'negocios ganados sin pedido')}` : descuadre ? 'El total de los pedidos no coincide con el de los negocios' : 'Cuadra con los pedidos'}>
                      {plural(g.pedidos, 'pedido', 'pedidos')}</td>
                    <td className={`num ${descuadre ? 'warn-text' : ''}`}><b>{fmtMoney(g.pedidos_monto) || '$ 0'}</b>{descuadre && <span title={g.sin_pedido ? `${g.sin_pedido} sin pedido` : 'No coincide'}> ⚠</span>}</td>
                    <td className="num small">{suelto ? <a href="#sin-negocio" className="danger-text" title={`Pedidos cargados en el período que no están en ningún negocio (${fmtMoney(suelto.monto) || '$ 0'})`}>+{plural(suelto.n, 'pedido', 'pedidos')} sin negocio</a> : null}</td>
                  </tr>
                );
              })}
              <tr className="dir-total"><td>Total</td><td className="num small muted">{plural(ganados, 'negocio', 'negocios')}</td><td className="num"><b>{fmtMoney((d?.ganado ?? []).reduce((s, g) => s + g.monto, 0)) || '$ 0'}</b></td><td className="muted">/</td>
                <td className="num small muted">{plural((d?.ganado ?? []).reduce((s, g) => s + g.pedidos, 0), 'pedido', 'pedidos')}</td><td className="num"><b>{fmtMoney((d?.ganado ?? []).reduce((s, g) => s + g.pedidos_monto, 0)) || '$ 0'}</b></td>
                <td className="num small">{nSueltos ? <a href="#sin-negocio" className="danger-text">+{plural(nSueltos, 'pedido', 'pedidos')} sin negocio</a> : null}</td></tr>
            </tbody></table> : <div className="muted">{res.loading ? 'Cargando…' : 'No hay negocios ganados en el período.'}</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Negocios sin actividad hace 14 días</h2><span className="muted small">{d ? `${d.quietos.total} · ${fmtMoney(d.quietos.monto)}` : ''}</span></div>
          {d?.quietos.negocios.length ? d.quietos.negocios.map((r) => (
            <div key={r.id} className="assoc-item">
              <div className="grow" style={{ minWidth: 0 }}><Link to={recordUrl('deal', r.id)} className="ellipsis" style={{ display: 'block' }}>{r.name}</Link>
                <div className="small muted">{stageOf(meta, r.stage_id)?.stage.label} · <UserChip id={r.owner_id} size="xs" /></div></div>
              <span className="small num">{fmtMoney(r.amount)}</span>
            </div>
          )) : <div className="empty">{res.loading ? 'Cargando…' : 'Todo con movimiento.'}</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Embudo por pipeline</h2><span className="small muted">Pipelines con negocios creados en los últimos 90 días · negocios creados en el período</span></div>
        <div className="panel-body dir-embudos">
          {d?.embudos.map((e) => {
            const base = e.etapas[0]?.n ?? 0;
            return (
              <div key={e.id} className="dir-embudo">
                <div className="row"><b className="grow">{e.label}</b><span className="small num">{plural(e.creados, 'negocio', 'negocios')} · {fmtMoney(e.monto) || '$ 0'}</span></div>
                {e.creados ? <table className="dir-tabla">
                  <thead><tr><th>Etapa</th><th /><th className="num">Negocios</th><th className="num">Monto</th><th className="num" title="Sobre los que entraron a la primera etapa">Del total</th><th className="num" title="Sobre la etapa anterior">Vs. ant.</th></tr></thead>
                  <tbody>
                    {e.etapas.map((s, i) => (
                      <tr key={s.id} className={s.ganada ? 'dir-ganada' : ''}>
                        <td className="ellipsis" style={{ maxWidth: 190 }} title={s.label}>{s.label}</td>
                        <td style={{ width: '22%' }}><span className="dir-barra"><i style={{ width: `${base ? (s.n / base) * 100 : 0}%` }} /></span></td>
                        <td className="num">{s.n}</td><td className="num">{fmtMoney(s.monto) || '$ 0'}</td>
                        <td className="num">{pct(base ? s.n / base : null)}</td>
                        <td className="num muted">{i === 0 ? '' : pct(e.etapas[i - 1].n ? s.n / e.etapas[i - 1].n : null)}</td>
                      </tr>
                    ))}
                    <tr className="muted small"><td>Perdidos</td><td /><td className="num">{e.perdidos.n}</td><td className="num">{fmtMoney(e.perdidos.monto) || '$ 0'}</td><td className="num">{pct(e.creados ? e.perdidos.n / e.creados : null)}</td><td /></tr>
                    <tr className="muted small"><td>Siguen abiertos</td><td /><td className="num">{e.abiertos.n}</td><td className="num">{fmtMoney(e.abiertos.monto) || '$ 0'}</td><td className="num">{pct(e.creados ? e.abiertos.n / e.creados : null)}</td><td /></tr>
                  </tbody>
                </table> : <div className="small muted">Sin negocios creados en el período.</div>}
              </div>
            );
          })}
          {d && !d.embudos.length && <div className="muted">Ningún pipeline tuvo negocios nuevos en los últimos 90 días.</div>}
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Motivos de pérdida</h2><span className="small muted">{plural(perdidos, 'negocio', 'negocios')} · {fmtMoney(k?.perdidos_monto ?? 0) || '$ 0'}</span></div>
          <div className="panel-body">
            {d?.perdidos.length ? <table className="dir-tabla"><tbody>
              {d.perdidos.map((l) => (
                <tr key={l.motivo ?? 'x'}><td>{l.motivo ?? <span className="muted">Sin motivo cargado</span>}</td>
                  <td style={{ width: '30%' }}><span className="dir-barra"><i style={{ width: `${perdidos ? (l.n / perdidos) * 100 : 0}%` }} /></span></td>
                  <td className="num">{l.n}</td><td className="num muted small">{pct(perdidos ? l.n / perdidos : null)}</td><td className="num">{fmtMoney(l.monto) || '$ 0'}</td></tr>
              ))}
            </tbody></table> : <div className="muted">No hay negocios perdidos en el período.</div>}
          </div>
        </div>
        <div className="panel" id="sin-negocio">
          <div className="panel-head"><h2>Pedidos sin negocio</h2><span className={`small ${nSueltos ? 'danger-text' : 'muted'}`}>{d ? `${nSueltos} en el período · ${fmtMoney(montoSueltos) || '$ 0'}` : ''}</span></div>
          {sueltos?.negocios.length ? sueltos.negocios.map((o) => (
            <div key={o.id} className="assoc-item">
              <div className="grow" style={{ minWidth: 0 }}><Link to={recordUrl('order', o.id)} className="ellipsis" style={{ display: 'block' }}>{o.name}</Link>
                <div className="small muted">{o.pedido ? `${o.pedido} · ` : ''}cargado el {corto(o.created_at.slice(0, 10))} · <UserChip id={o.owner_id} size="xs" /></div></div>
              <span className="small num">{fmtMoney(o.amount)}</span>
            </div>
          )) : <div className="empty plain">{res.loading ? 'Cargando…' : 'Todos los pedidos del período están en un negocio.'}</div>}
          {sueltos && nSueltos > sueltos.negocios.length && <div className="small muted" style={{ padding: '8px 20px' }}>Y {nSueltos - sueltos.negocios.length} más en el período.</div>}
          {sueltos && sueltos.historico > nSueltos && <div className="small muted" style={{ padding: '8px 20px' }}>En total hay {plural(sueltos.historico, 'pedido', 'pedidos')} sin negocio (contando los de antes del período).</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Ranking de ventas por empresa</h2><span className="small muted">{empresas.length ? `${empresas.length}${empresas.length >= 60 ? '+' : ''} empresas` : ''}</span></div>
        <div className="panel-body" style={{ overflowX: 'auto' }}>
          {empresas.length ? <table className="dir-tabla dir-empresas">
            <thead><tr><th>#</th><th>Empresa</th><th className="num">Oportunidades</th><th className="num">Monto oport.</th><th className="num">Ganados</th><th className="num">Monto ganado</th><th className="num">Perdidos</th><th className="num">Conversión</th><th className="num">Ticket prom.</th><th className="num">Abiertos</th></tr></thead>
            <tbody>
              {(todasEmpresas ? empresas : empresas.slice(0, 15)).map((e, i) => (
                <tr key={String(e.cid)}>
                  <td className="muted">{i + 1}</td>
                  <td className="ellipsis" style={{ maxWidth: 260 }}>{e.cid ? <Link to={recordUrl('company', e.cid)}>{e.name || 'Empresa sin nombre'}</Link> : <span className="muted">Sin empresa</span>}</td>
                  <td className="num">{e.oportunidades}</td><td className="num">{fmtMoney(e.oportunidades_monto) || '$ 0'}</td>
                  <td className="num">{e.ganados}</td><td className="num"><b>{fmtMoney(e.ganados_monto) || '$ 0'}</b></td>
                  <td className="num">{e.perdidos}</td><td className="num">{pct(e.ganados + e.perdidos ? e.ganados / (e.ganados + e.perdidos) : null)}</td>
                  <td className="num">{e.ganados ? fmtMoney(e.ganados_monto / e.ganados) : '—'}</td>
                  <td className="num">{e.abiertos ? `${e.abiertos} · ${fmtMoney(e.abiertos_monto) || '$ 0'}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table> : <div className="muted">{res.loading ? 'Cargando…' : 'Sin negocios en el período.'}</div>}
          {empresas.length > 15 && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setTodasEmpresas(!todasEmpresas)}>{todasEmpresas ? 'Ver las primeras 15' : `Ver las ${empresas.length}`}</button>}
        </div>
      </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h2>Cómo leer este Inicio</h2></div>
          <div className="panel-body small muted stack" style={{ gap: 6 }}>
            <span><b>Ganado / perdido:</b> negocios con fecha de cierre en el período. <b>Nuevos:</b> creados en el período. <b>Abiertos:</b> hoy.</span>
            <span><b>Pedidos:</b> los pedidos (no anulados) asociados a los negocios ganados. En naranja ⚠ cuando a algún ganado le falta el pedido o los totales no coinciden.</span>
            <span><b>Embudo:</b> de los negocios creados en el período, cuántos y cuánto monto llegaron a cada etapa (según el historial de etapas), con la conversión desde la primera y desde la anterior.</span>
            <span><b>Pedidos sin negocio:</b> pedidos no anulados cargados en el período que no están asociados a ningún negocio. No debería haber ninguno.</span>
            <span><b>Empresas:</b> conversión = ganados / (ganados + perdidos) en el período; ticket = monto ganado / ganados.</span>
          </div>
        </div>
    </div>
  );
}
