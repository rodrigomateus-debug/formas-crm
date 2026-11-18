import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { http, qs, useDebounced, Icon, Cargando, fmtDate, fmtRelative, recordUrl } from '../lib';
import { Select } from '../Select';

// Consultas de los clientes por WhatsApp (pedido de Rodrigo del 18/11/2026; src/worker/darwin.ts). A la madrugada el Hub resume
// el día de cada conversación de Darwin (Maru y cada vendedora) y guarda cada producto consultado con datos fijos: así se
// encuentra «quién consultó por botellas», «más de 100 unidades para fin de año» o «consultó y no compró».
// - Analíticas → «Consultas por WhatsApp» (ConsultasPanel): los números (lo más consultado, por semana, cuántos compraron
//   después, por vendedora) y el buscador con el listado.
// - Inicio (SinRespuestaInicio): los clientes que escribieron y nadie les contestó, para la vendedora.
// - La ficha del contacto y de la empresa (ConsultasCard): sus últimas consultas.

interface Fila {
  id: number; dia: string; contact_id: number; contacto: string; company_id: number | null; empresa: string | null; deal_id: number | null; atendio: string | null;
  categoria: string; tipo: string; producto: string | null; cantidad: number | null; precio_unitario: number | null; presupuesto_total: number | null;
  fecha_necesaria: string | null; ocasion: string | null; personalizacion: string | null; pidio_muestra: boolean; pidio_boceto: boolean; objecion: string | null;
  competidor: string | null; entrega: string | null; link: string | null;
}
interface Grupo { clave: string | null; n: number; clientes: number; con_venta: number; unidades: number | null }
interface Datos { consultas: Fila[]; total: number; clientes: number; unidades: number; por_tipo: Array<{ tipo: string; n: number }>; catalogo: Record<string, string[]>; ocasiones: string[];
  con_venta?: number; por_categoria?: Grupo[]; por_vendedora?: Grupo[]; por_semana?: Grupo[] }
interface Pendiente { conversation_id: string; titulo: string | null; link: string | null; asignada_a: string | null; ultima_respuesta_cliente: string; ultima_actividad_equipo: string | null; contact_id: number | null; contacto: string | null }

const n = (v: number) => v.toLocaleString('es-AR');
const pesos = (v: number | null) => (v == null ? '' : `$ ${Math.round(v).toLocaleString('es-AR')}`);

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '–');

// La pestaña de Analíticas.
export function ConsultasPanel() {
  return (
    <>
      <p className="muted" style={{ margin: '0 0 12px', maxWidth: 780 }}>
        Lo que los clientes consultan por WhatsApp, con Maru y con cada vendedora. Cada noche el Hub lee el día en Darwin, deja un resumen en el contacto y anota acá cada producto que pidieron.
      </p>
      <ListaConsultas />
    </>
  );
}

// Una barra horizontal por fila (un solo color: la serie es una sola). El número va en texto, al lado.
function Barras({ filas, onElegir }: { filas: Array<{ etiqueta: string; n: number; detalle?: string }>; onElegir?: (etiqueta: string) => void }) {
  const max = Math.max(1, ...filas.map((f) => f.n));
  return (
    <div className="cq-barras">
      {filas.map((f) => (
        <button key={f.etiqueta} type="button" className="cq-barra" onClick={() => onElegir?.(f.etiqueta)} disabled={!onElegir}
          title={`${f.etiqueta}: ${n(f.n)} ${f.n === 1 ? 'consulta' : 'consultas'}${f.detalle ? ` · ${f.detalle}` : ''}`}>
          <span className="cq-et ellipsis">{f.etiqueta}</span>
          <span className="cq-pista"><i style={{ width: `${(f.n / max) * 100}%` }} /></span>
          <span className="cq-val num">{n(f.n)}</span>
        </button>
      ))}
    </div>
  );
}

// Consultas por semana: columnas, la más nueva a la derecha.
function Semanas({ filas }: { filas: Grupo[] }) {
  const max = Math.max(1, ...filas.map((f) => f.n));
  const corta = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  return (
    <div className="cq-semanas" role="img" aria-label={`Consultas por semana: ${filas.map((f) => `semana del ${corta(f.clave)}, ${f.n}`).join('; ')}`}>
      {filas.map((f) => (
        <div key={f.clave} className="cq-col" title={`Semana del ${corta(f.clave)}: ${n(f.n)} consultas de ${n(f.clientes)} clientes`}>
          <span className="cq-col-val num">{n(f.n)}</span>
          <span className="cq-col-pista"><i style={{ height: `${(f.n / max) * 100}%` }} /></span>
          <span className="cq-col-et">{corta(f.clave)}</span>
        </div>
      ))}
    </div>
  );
}

function Analitica({ d, poner }: { d: Datos; poner: (k: string, v: string) => void }) {
  return (
    <>
      <div className="kpis">
        <div className="panel kpi"><div className="label">Consultas</div><div className="value">{n(d.total)}</div></div>
        <div className="panel kpi"><div className="label">Clientes que consultaron</div><div className="value">{n(d.clientes)}</div></div>
        <div className="panel kpi"><div className="label">Unidades pedidas</div><div className="value">{n(d.unidades)}</div></div>
        <div className="panel kpi"><div className="label">Compraron después</div><div className="value">{pct(d.con_venta ?? 0, d.clientes)}</div>
          <div className="small muted">{n(d.con_venta ?? 0)} de {n(d.clientes)} clientes</div></div>
      </div>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Lo más consultado</h2></div>
          <div className="panel-body"><Barras filas={d.por_tipo.map((t) => ({ etiqueta: t.tipo, n: t.n }))} onElegir={(t) => poner('tipo', t)} /></div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Por categoría</h2></div>
          <div className="panel-body"><Barras filas={(d.por_categoria ?? []).map((g) => ({ etiqueta: g.clave ?? 'Otro', n: g.n, detalle: `${pct(g.con_venta, g.clientes)} compró después` }))}
            onElegir={(c) => poner('categoria', c)} /></div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Consultas por semana</h2></div>
          <div className="panel-body">{(d.por_semana ?? []).length ? <Semanas filas={d.por_semana!} /> : <div className="muted small">Sin datos.</div>}</div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Quién atendió y cuántos compraron</h2></div>
          <div className="panel-body" style={{ overflowX: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Atendió</th><th className="num">Consultas</th><th className="num">Clientes</th><th className="num">Compraron</th></tr></thead>
              <tbody>{(d.por_vendedora ?? []).map((g) => (
                <tr key={g.clave ?? '-'}><td>{g.clave}</td><td className="num">{n(g.n)}</td><td className="num">{n(g.clientes)}</td>
                  <td className="num">{n(g.con_venta)} <span className="muted small">({pct(g.con_venta, g.clientes)})</span></td></tr>
              ))}</tbody>
            </table>
            <p className="small muted" style={{ margin: '8px 0 0' }}>«Compraron» cuenta los clientes con un negocio ganado cerrado el día de la consulta o después.</p>
          </div>
        </div>
      </div>
    </>
  );
}

function ListaConsultas() {
  const [sp, setSp] = useSearchParams();
  const [buscar, setBuscar] = useState(sp.get('q') ?? '');
  const q = useDebounced(buscar, 250);
  const f = { categoria: sp.get('categoria') ?? '', tipo: sp.get('tipo') ?? '', desde: sp.get('desde') ?? '', hasta: sp.get('hasta') ?? '', min_cantidad: sp.get('min') ?? '',
    ocasion: sp.get('ocasion') ?? '', sin_venta: sp.get('sin_venta') === '1', contact_id: sp.get('contact_id') ?? '', company_id: sp.get('company_id') ?? '' };
  const poner = (k: string, v: string) => setSp((p) => { const x = new URLSearchParams(p); if (v) x.set(k, v); else x.delete(k); if (k === 'categoria') x.delete('tipo'); return x; }, { replace: true });
  const deUno = f.contact_id || f.company_id;
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    http<Datos>('GET', `/consultas${qs({ q: q || undefined, categoria: f.categoria || undefined, tipo: f.tipo || undefined, desde: f.desde || undefined, hasta: f.hasta || undefined,
      min_cantidad: f.min_cantidad || undefined, ocasion: f.ocasion || undefined, sin_venta: f.sin_venta ? 1 : undefined, contact_id: f.contact_id || undefined,
      company_id: f.company_id || undefined, analitica: deUno ? undefined : 1, limit: 300 })}`)
      .then((d) => { setDatos(d); setError(''); }, (e) => setError((e as Error).message));
  }, [q, f.categoria, f.tipo, f.desde, f.hasta, f.min_cantidad, f.ocasion, f.sin_venta, f.contact_id, f.company_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tipos = f.categoria ? datos?.catalogo[f.categoria] ?? [] : Object.values(datos?.catalogo ?? {}).flat();
  const filtrado = !!(q || f.categoria || f.tipo || f.desde || f.hasta || f.min_cantidad || f.ocasion || f.sin_venta || f.contact_id || f.company_id);
  return (
    <>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <input className="input search" placeholder="Buscar: botellas, grabado láser, cliente…" value={buscar} onChange={(e) => { setBuscar(e.target.value); poner('q', e.target.value); }} aria-label="Buscar" />
        <Select className="input bar-select" value={f.categoria} onChange={(e) => poner('categoria', e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {Object.keys(datos?.catalogo ?? {}).map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select className="input bar-select" value={f.tipo} onChange={(e) => poner('tipo', e.target.value)} aria-label="Tipo de producto">
          <option value="">Todos los productos</option>
          {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select className="input bar-select" value={f.ocasion} onChange={(e) => poner('ocasion', e.target.value)} aria-label="Ocasión">
          <option value="">Cualquier ocasión</option>
          {(datos?.ocasiones ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
        <label className="row small" style={{ gap: 6 }}>Desde<input className="input" type="date" value={f.desde} onChange={(e) => poner('desde', e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}>Hasta<input className="input" type="date" value={f.hasta} onChange={(e) => poner('hasta', e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}>Mín. unidades<input className="input" type="number" min={0} style={{ width: 90 }} value={f.min_cantidad} onChange={(e) => poner('min', e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.sin_venta} onChange={(e) => poner('sin_venta', e.target.checked ? '1' : '')} />Sin venta después</label>
      </div>
      {deUno && <p className="small">Solo las de {datos?.consultas[0] ? (f.contact_id ? datos.consultas[0].contacto : datos.consultas[0].empresa) : 'este cliente'}.{' '}
        <button type="button" className="link-btn" onClick={() => { poner('contact_id', ''); poner('company_id', ''); }}>Ver todas</button></p>}
      {error && <div className="tag bad">{error}</div>}
      {!datos && !error && <Cargando />}
      {datos?.por_categoria && datos.total > 0 && <Analitica d={datos} poner={poner} />}
      {datos && (
        <p className="small muted" style={{ margin: '4px 0 10px' }}>
          {n(datos.total)} {datos.total === 1 ? 'consulta' : 'consultas'} de {n(datos.clientes)} {datos.clientes === 1 ? 'cliente' : 'clientes'}
          {datos.unidades ? ` · ${n(datos.unidades)} unidades pedidas` : ''}
          {datos.por_tipo.length > 1 && <> · lo más consultado: {datos.por_tipo.slice(0, 5).map((t, i) => (
            <span key={t.tipo}>{i ? ', ' : ''}<button type="button" className="link-btn" onClick={() => poner('tipo', t.tipo)}>{t.tipo}</button> ({t.n})</span>
          ))}</>}
        </p>
      )}
      {datos && !datos.consultas.length && (
        <div className="panel"><div className="panel-body muted">
          {filtrado ? 'No hay consultas con esos filtros.' : 'Todavía no hay consultas. Se cargan solas cada noche con lo que pasó en Darwin el día anterior.'}
        </div></div>
      )}
      {datos && datos.consultas.length > 0 && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Día</th><th>Cliente</th><th>Producto</th><th className="num">Cantidad</th><th>Para</th><th>Detalle</th><th>Atendió</th><th /></tr></thead>
            <tbody>
              {datos.consultas.map((c) => (
                <tr key={c.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.dia)}</td>
                  <td><Link to={recordUrl('contact', c.contact_id)}>{c.contacto}</Link>{c.empresa && c.company_id ? <><br /><Link className="small muted" to={recordUrl('company', c.company_id)}>{c.empresa}</Link></> : null}</td>
                  <td><b>{c.tipo}</b>{c.producto ? <><br /><span className="small muted">{c.producto}</span></> : null}</td>
                  <td className="num">{c.cantidad != null ? n(c.cantidad) : ''}</td>
                  <td className="small">{[c.ocasion, c.fecha_necesaria].filter(Boolean).join(' · ')}</td>
                  <td className="small" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                    {[c.personalizacion, c.precio_unitario != null ? `${pesos(c.precio_unitario)} c/u` : '', c.presupuesto_total != null ? `total ${pesos(c.presupuesto_total)}` : '',
                      c.pidio_muestra ? 'pidió muestra' : '', c.pidio_boceto ? 'pidió boceto' : '', c.objecion ? `objeción: ${c.objecion}` : '', c.competidor ? `compara con ${c.competidor}` : '',
                      c.entrega ? `entrega: ${c.entrega}` : ''].filter(Boolean).join(' · ')}
                  </td>
                  <td className="small">{c.atendio ?? ''}</td>
                  <td>{c.link && <a className="btn ghost sm" href={c.link} target="_blank" rel="noopener noreferrer" title="Abrir la conversación en Darwin"><img src="/darwin.png" alt="" width={13} height={13} />Darwin</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// En Inicio: los clientes que escribieron y nadie les contestó (Maru ya les pasó la conversación). La vendedora ve los suyos.
export function SinRespuestaInicio() {
  const [horas, setHoras] = useState(24);
  const [todos, setTodos] = useState(false);
  const [datos, setDatos] = useState<{ pendientes: Pendiente[] } | null>(null);
  useEffect(() => {
    http<{ pendientes: Pendiente[] }>('GET', `/darwin/pendientes${qs({ horas })}`).then(setDatos, () => setDatos({ pendientes: [] }));
  }, [horas]);
  const lista = datos?.pendientes ?? [];
  const ver = todos ? lista : lista.slice(0, 6);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="grow" title="Clientes que escribieron por WhatsApp y nadie del equipo les contestó">Esperan respuesta {lista.length > 0 && <span className="tag warn">{lista.length}</span>}</h2>
        <Select className="input bar-select" style={{ width: 120 }} value={String(horas)} onChange={(e) => setHoras(Number(e.target.value))} aria-label="Sin respuesta hace más de">
          {[4, 12, 24, 48, 72].map((h) => <option key={h} value={h}>+{h} h</option>)}
        </Select>
      </div>
      {!datos ? <Cargando chico /> : !lista.length ? <div className="empty">Nadie espera respuesta.</div> : <>
        {ver.map((p) => (
          <div key={p.conversation_id} className="assoc-item">
            <div className="grow" style={{ minWidth: 0 }}>
              {p.contact_id ? <Link className="ellipsis" style={{ display: 'block' }} to={recordUrl('contact', p.contact_id)}>{p.contacto ?? p.titulo}</Link> : <span className="ellipsis" style={{ display: 'block' }}>{p.titulo ?? p.conversation_id}</span>}
              <div className="small muted">Escribió {fmtRelative(p.ultima_respuesta_cliente)}{p.asignada_a ? ` · ${p.asignada_a}` : ''}</div>
            </div>
            {p.link && <a className="btn ghost sm" href={p.link} target="_blank" rel="noopener noreferrer" title="Abrir la conversación en Darwin"><img src="/darwin.png" alt="" width={13} height={13} />Darwin</a>}
          </div>
        ))}
        {lista.length > 6 && <div className="panel-body"><button type="button" className="btn sm ghost" onClick={() => setTodos(!todos)}>{todos ? 'Ver menos' : `Ver todos (${lista.length})`}</button></div>}
      </>}
    </div>
  );
}

// En la ficha del contacto o la empresa: las últimas consultas, con el link a todas.
export function ConsultasCard({ type, id }: { type: 'contact' | 'company'; id: number }) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const clave = type === 'contact' ? 'contact_id' : 'company_id';
  useEffect(() => { http<Datos>('GET', `/consultas${qs({ [clave]: id, limit: 5 })}`).then(setDatos, () => setDatos(null)); }, [clave, id]);
  if (!datos?.total) return null;
  return (
    <div className="panel assoc-card">
      <div className="panel-head"><h3>Consultas por WhatsApp <span className="muted small">({datos.total})</span></h3><Link className="btn sm ghost" to={`/analiticas${qs({ t: 'consultas', [clave]: id })}`}>Ver todas</Link></div>
      <div className="panel-body stack" style={{ paddingTop: 0, gap: 6 }}>
        {datos.consultas.map((c) => (
          <div key={c.id} className="small">
            <b>{c.tipo}</b>{c.cantidad != null ? ` · ${n(c.cantidad)} u.` : ''}{c.ocasion ? ` · ${c.ocasion}` : ''}
            <span className="muted"> · {fmtDate(c.dia)}{type === 'company' ? ` · ${c.contacto}` : ''}</span>
            {c.producto && <div className="muted ellipsis">{c.producto}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
