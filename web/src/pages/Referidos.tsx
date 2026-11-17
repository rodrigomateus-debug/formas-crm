import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useAsync, useMeta, useDebounced, recordUrl, esVentas, fmtDate, fmtMoney } from '../lib';
import { Select } from '../Select';
import { UserChip, userOption } from '../components';

// Referidos (pedido de Rodrigo del 17/11/2026; referidos.ts): quién nos recomendó a quién y cómo le fue a cada negocio. Se
// cargan desde el pedido de referidos del Workspace de Formas Shop o desde la ficha del cliente («Nos recomendó a…»). Los
// de antes (cargados en HubSpot) salen también, con quien los recomendó si se puede leer del negocio.

export interface ReferidoVista {
  id: number | null; fecha: string; origen: string; cargado_por: string | null; nota: string | null; pdvs: string[];
  referidor: { nombre: string; empresa: { id: number; name: string } | null; contacto: { id: number; name: string } | null };
  contacto: { id: number; name: string } | null; empresa: { id: number; name: string } | null;
  negocio: { id: number; name: string; etapa: string | null; abierto: boolean; ganado: boolean; monto: number | null } | null;
  owner_id: number | null;
}
interface Datos { referidos: ReferidoVista[]; resumen: { total: number; abiertos: number; ganados: number; perdidos: number; monto_ganado: number } }

export const ORIGEN: Record<string, string> = { tablero: 'Workspace', crm: 'Hub', antes: 'Antes (HubSpot)' };

export function EstadoNegocio({ n }: { n: ReferidoVista['negocio'] }) {
  if (!n) return <span className="tag">Sin negocio</span>;
  return <span className={`tag ${n.ganado ? 'ok' : n.abierto ? 'info' : 'bad'}`}>{n.ganado ? 'Ganado' : n.abierto ? n.etapa ?? 'En curso' : 'Perdido'}</span>;
}

export function QuienRecomendo({ r }: { r: ReferidoVista }) {
  const { empresa, contacto, nombre } = r.referidor;
  const pdv = r.pdvs.length ? <span className="small muted"> · PDV {r.pdvs.join(', ')}</span> : null;
  if (empresa) return <><Link to={recordUrl('company', empresa.id)}>{empresa.name}</Link>{contacto && <span className="small muted"> · <Link to={recordUrl('contact', contacto.id)}>{contacto.name}</Link></span>}{pdv}</>;
  if (contacto) return <><Link to={recordUrl('contact', contacto.id)}>{contacto.name}</Link>{pdv}</>;
  return nombre ? <><span>{nombre}</span>{pdv}</> : <span className="muted">Sin dato</span>;
}

const ESTADOS = [['', 'Todos'], ['abiertos', 'En curso'], ['ganados', 'Ganados'], ['perdidos', 'Perdidos']] as const;

export default function ReferidosPage() {
  const { meta } = useMeta();
  const ventas = esVentas(meta.me);
  const [owner, setOwner] = useState('');
  const [estado, setEstado] = useState<(typeof ESTADOS)[number][0]>('');
  const [buscar, setBuscar] = useState('');
  const q = useDebounced(buscar.trim().toLowerCase(), 150);
  const datos = useAsync(() => http<Datos>('GET', `/referidos${qs({ owner: owner || undefined })}`), [owner]);
  const filas = useMemo(() => (datos.data?.referidos ?? []).filter((r) => {
    if (estado === 'abiertos' && !r.negocio?.abierto) return false;
    if (estado === 'ganados' && !r.negocio?.ganado) return false;
    if (estado === 'perdidos' && !(r.negocio && !r.negocio.abierto && !r.negocio.ganado)) return false;
    if (!q) return true;
    return [r.contacto?.name, r.empresa?.name, r.negocio?.name, r.referidor.nombre, r.referidor.empresa?.name, r.referidor.contacto?.name, r.pdvs.join(' ')]
      .some((t) => t && t.toLowerCase().includes(q));
  }), [datos.data, estado, q]);
  const s = datos.data?.resumen;
  return (
    <div className="content">
      <div className="page-head">
        <h1>Referidos {s && <span className="muted small num">{s.total.toLocaleString('es-AR')}</span>}</h1>
        {!ventas && <Select className="input" style={{ width: 220 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Ejecutiva">
          <option value="">Todo el equipo</option>
          {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
        </Select>}
      </div>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16, maxWidth: 760 }}>
        Quién nos recomendó a quién y cómo le fue a cada negocio. Se cargan desde el pedido de referidos del Workspace o desde la ficha del
        cliente («Nos recomendó a…»). Cada uno crea el contacto, un negocio en Lead y la tarea de contactarlo; cuando se gana, llega la tarea
        de agradecerle a quien lo recomendó.
      </p>
      <div className="kpis">
        <div className="panel kpi"><div className="label">Referidos</div><div className="value">{s?.total ?? '–'}</div></div>
        <div className="panel kpi"><div className="label">En curso</div><div className="value">{s?.abiertos ?? '–'}</div></div>
        <div className="panel kpi"><div className="label">Ganados</div><div className="value">{s?.ganados ?? '–'}</div>{s && s.total > 0 && <div className="small muted">{Math.round((s.ganados / s.total) * 100)} % de los referidos</div>}</div>
        <div className="panel kpi"><div className="label">Ganado con referidos</div><div className="value">{s ? fmtMoney(s.monto_ganado) : '–'}</div></div>
      </div>
      <div className="toolbar">
        <input className="input search" placeholder="Buscar por referido, cliente o PDV" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
        <div className="row" role="group" aria-label="Estado" style={{ gap: 6 }}>
          {ESTADOS.map(([k, l]) => <button key={k} type="button" className={`btn sm${estado === k ? ' primary' : ''}`} aria-pressed={estado === k} onClick={() => setEstado(k)}>{l}</button>)}
        </div>
      </div>
      {datos.error && <div className="tag bad">{datos.error}</div>}
      {!datos.data && !datos.error && <div className="empty plain">Cargando…</div>}
      {datos.data && !filas.length && (
        <div className="panel"><div className="panel-body muted">
          {q || estado ? 'No hay referidos con esos filtros.' : 'Todavía no hay referidos. Se cargan desde el pedido de referidos del Workspace o desde la ficha de un cliente: «Nos recomendó a…».'}
        </div></div>
      )}
      {filas.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr>
              <th className="nosort">Fecha</th><th className="nosort">Referido</th><th className="nosort">Lo recomendó</th>
              <th className="nosort">Negocio</th><th className="nosort">Ejecutiva</th><th className="nosort">Cargado desde</th>
            </tr></thead>
            <tbody>
              {filas.map((r) => (
                <tr key={`${r.id ?? 'n'}-${r.negocio?.id ?? r.contacto?.id}`} style={{ cursor: 'default' }}>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.fecha)}</td>
                  <td>
                    {r.contacto ? <Link to={recordUrl('contact', r.contacto.id)}><b>{r.contacto.name}</b></Link> : <span className="muted">—</span>}
                    {r.empresa && <div className="small muted"><Link to={recordUrl('company', r.empresa.id)}>{r.empresa.name}</Link></div>}
                  </td>
                  <td><QuienRecomendo r={r} /></td>
                  <td>
                    {r.negocio ? <Link to={recordUrl('deal', r.negocio.id)} className="ellipsis" style={{ display: 'block', maxWidth: 320 }}>{r.negocio.name}</Link> : null}
                    <div className="row" style={{ gap: 6, marginTop: 2 }}><EstadoNegocio n={r.negocio} />{r.negocio?.monto ? <span className="small num">{fmtMoney(r.negocio.monto)}</span> : null}</div>
                  </td>
                  <td><UserChip id={r.owner_id} size="xs" /></td>
                  <td className="small">{ORIGEN[r.origen] ?? r.origen}{r.cargado_por && <div className="muted">{r.cargado_por}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
