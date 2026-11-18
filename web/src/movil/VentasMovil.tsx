import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useDebounced, Icon, Cargando, fmtDate, fmtMoney, fmtRelative, formatValue, propOf, recordUrl, stageOf, canSeePipeline, defaultPipeline,
  missingFor, faltaDato, type CrmRecord, type ObjectType, type Pipeline, type Property, type Stage,
} from '../lib';
import { EtapaPedido } from '../components';
import { keyPropsFor } from '../pages/RecordPage';
import { ConversacionPanel, useNoLeidosDe } from '../pages/Conversacion';
import { LogosCard } from '../pages/Logos';
import type { DestinoOpcion } from '../pages/Recorridos';
import { Hoja, TareaRapida } from './Movil';
import { Actividad, CampoMovil, EditarDato, ElegirEmpresa, Registrar, TarjetaCliente } from './ClientesMovil';

// Ventas en el celular (versión celular, fase 3): Negocios | Pedidos. Los negocios se ven por etapa, se crean con lo
// mínimo y se pasan de etapa (pidiendo lo que la etapa exige, como en el escritorio). Los pedidos no se crean desde acá:
// se consultan (estado, entrega, artículos, logos, factura) y se conversa con el equipo, con archivos y menciones.

type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;
type Con = CrmRecord & { company?: { id: number; name: string } | null };

function Segmento() {
  return (
    <div className="m-seg" role="tablist" aria-label="Ventas">
      <NavLink to="/deals" role="tab" className="m-seg-op">Negocios</NavLink>
      <NavLink to="/orders" role="tab" className="m-seg-op">Pedidos</NavLink>
    </div>
  );
}

// Los pipelines de negocios que ve (los suyos, si tiene elegidos).
function usePipelines() {
  const { meta } = useMeta();
  return useMemo(() => {
    const elegidos = meta.me.deal_pipelines;
    return meta.pipelines.filter((p) => (elegidos?.length ? elegidos.includes(p.id) : canSeePipeline(meta.me, p)));
  }, [meta]);
}

// ---------- Negocios ----------

const PAGINA = 30;
export function NegociosLista() {
  const { meta } = useMeta();
  const pipes = usePipelines();
  const [pid, setPid] = useState(() => (pipes.find((p) => p.id === defaultPipeline(meta)?.id) ?? pipes[0])?.id ?? '');
  const pipe = pipes.find((p) => p.id === pid);
  const [etapa, setEtapa] = useState<string>('abiertos');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [lista, setLista] = useState<Con[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasta, setHasta] = useState(PAGINA);
  const [alta, setAlta] = useState(false);
  const abiertas = pipe?.stages.filter((s) => !s.is_closed) ?? [];
  const cerradas = pipe?.stages.filter((s) => s.is_closed) ?? [];
  useEffect(() => { setHasta(PAGINA); }, [pid, etapa, dq]);
  useEffect(() => {
    if (!pipe) { setLista([]); return; }
    let vivo = true;
    const ids = etapa === 'abiertos' ? abiertas.map((s) => s.id) : etapa === 'cerrados' ? cerradas.map((s) => s.id) : [etapa];
    const filters = [{ prop: 'pipeline', op: 'eq', value: pipe.id }, { prop: 'owner_id', op: 'eq', value: meta.me.id }, { prop: 'dealstage', op: 'in', values: ids }];
    http<{ results: Con[]; total: number }>('GET', `/records/deal${qs({ q: dq.trim() || undefined, filters, sort: etapa === 'cerrados' ? 'closedate' : 'hs_lastmodifieddate', dir: 'desc', limit: hasta, with: 'company' })}`)
      .then((r) => { if (vivo) { setLista(r.results); setTotal(r.total); } }, () => { if (vivo) setLista([]); });
    return () => { vivo = false; };
  }, [pipe?.id, etapa, dq, hasta, meta.me.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const suma = (lista ?? []).reduce((a, r) => a + (Number(r.props.amount) || 0), 0);
  return (
    <div className="m-pag">
      <Segmento />
      {pipes.length > 1 && (
        <select className="input" value={pid} onChange={(e) => { setPid(e.target.value); setEtapa('abiertos'); }} aria-label="Pipeline">
          {pipes.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      )}
      <div className="search"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar negocio…" aria-label="Buscar negocio" /></div>
      <div className="m-chips m-chips-scroll" role="group" aria-label="Etapa">
        <button type="button" className={`chip${etapa === 'abiertos' ? ' on' : ''}`} aria-pressed={etapa === 'abiertos'} onClick={() => setEtapa('abiertos')}>Abiertos</button>
        {abiertas.map((s) => <button key={s.id} type="button" className={`chip${etapa === s.id ? ' on' : ''}`} aria-pressed={etapa === s.id} onClick={() => setEtapa(s.id)}>{s.label}</button>)}
        <button type="button" className={`chip${etapa === 'cerrados' ? ' on' : ''}`} aria-pressed={etapa === 'cerrados'} onClick={() => setEtapa('cerrados')}>Cerrados</button>
      </div>
      <div className="m-fila">
        <span className="small muted">{lista ? `${total} ${total === 1 ? 'negocio' : 'negocios'}${suma ? ` · ${fmtMoney(suma)}${total > lista.length ? ' en los que se ven' : ''}` : ''}` : ''}</span>
        <span className="grow" />
        <button type="button" className="m-link" onClick={() => setAlta(true)}><Icon name="plus" size={14} />Negocio</button>
      </div>
      {!lista && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{dq ? `No hay negocios con «${dq}».` : 'No hay negocios acá.'}</div>}
      {lista && lista.length > 0 && (
        <div className="m-sec">
          {lista.map((r) => <TarjetaNegocio key={r.id} r={r} />)}
          {total > lista.length && <button type="button" className="m-ver" onClick={() => setHasta((h) => h + PAGINA)}>Ver más ({total - lista.length})</button>}
        </div>
      )}
      {alta && <AltaNegocio pipelineId={pipe?.id} onClose={() => setAlta(false)} />}
    </div>
  );
}

function TarjetaNegocio({ r }: { r: Con }) {
  const { meta } = useMeta();
  const s = stageOf(meta, r.props.dealstage)?.stage;
  const sin = useNoLeidosDe(r.id);
  return (
    <Link to={recordUrl('deal', r.id)} className="m-item m-item-link">
      <div className="m-item-txt">
        <b>{r.name}{sin ? <span className="m-pill nuevo">{sin.menciones ? '@' : ''}{sin.no_leidos}</span> : null}</b>
        <small className="muted">{[r.company?.name, s?.label].filter(Boolean).join(' · ')}</small>
      </div>
      <span className="m-monto"><b className="num">{fmtMoney(r.props.amount) || '—'}</b>{r.props.notes_last_updated && <small className="muted">{fmtRelative(r.props.notes_last_updated, true)}</small>}</span>
    </Link>
  );
}

export function FichaNegocio() {
  const { id = '0' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [datos, setDatos] = useState<{ record: CrmRecord; associations: Assoc; redirect?: number } | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<'resumen' | 'conversacion'>('resumen');
  const [hoja, setHoja] = useState<null | 'etapa' | 'registrar' | 'tarea' | { editar: Property }>(null);
  const sin = useNoLeidosDe(Number(id));
  useEffect(() => {
    http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/deal/${id}`)
      .then((d) => { if (d.redirect) navigate(recordUrl('deal', d.redirect), { replace: true }); else { setDatos(d); setError(''); } }, (e) => setError((e as Error).message));
  }, [id, version, navigate]);
  const cambio = () => setVersion((v) => v + 1);
  if (error) return <div className="m-pag"><div className="m-vacio m-vacio-solo">{error} <Link to="/deals">Volver</Link></div></div>;
  if (!datos) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = datos;
  const pipe = meta.pipelines.find((p) => p.id === r.props.pipeline);
  const etapa = stageOf(meta, r.props.dealstage)?.stage;
  const claves = (pipe?.config.key_props?.length ? pipe.config.key_props : keyPropsFor(meta, 'deal'))
    .filter((n) => !['dealstage', 'pipeline', 'link_a_darwin'].includes(n)).map((n) => propOf(meta, 'deal', n)).filter((p): p is Property => !!p);
  const editable = meta.me.role !== 'viewer';
  return (
    <div className={`m-pag m-ficha${tab === 'conversacion' ? ' m-con-chat' : ''}`}>
      <div className="m-ficha-tit">
        <h1>{r.name}</h1>
        <p className="m-negocio-sub"><b className="num">{fmtMoney(r.props.amount) || 'Sin monto'}</b>{pipe && <span className="muted"> · {pipe.label}</span>}</p>
      </div>
      <button type="button" className={`m-etapa${etapa?.is_closed ? (etapa.is_won ? ' ganado' : ' perdido') : ''}`} disabled={!editable} onClick={() => setHoja('etapa')}>
        <span><small>Etapa</small><b>{etapa?.label ?? 'Sin etapa'}</b></span>
        {pipe && etapa && <span className="m-etapa-barra" aria-hidden="true">{pipe.stages.filter((s) => !s.is_closed).map((s) => <i key={s.id} className={s.display_order <= etapa.display_order ? 'on' : ''} />)}</span>}
        {editable && <span className="m-link">Cambiar</span>}
      </button>
      <Pestanas tab={tab} setTab={(t) => setTab(t as 'resumen' | 'conversacion')} sin={sin?.no_leidos} primera="resumen" />
      {tab === 'conversacion' ? <ConversacionPanel type="deal" recordId={r.id} className="en-ficha m-conv" /> : <>
        <div className="m-rapidas">
          <button type="button" className="btn" onClick={() => setHoja('registrar')}><Icon name="note" size={16} />Registrar</button>
          <button type="button" className="btn" onClick={() => setHoja('tarea')}><Icon name="task" size={16} />Tarea</button>
        </div>
        {(a.company?.length || a.contact?.length) ? (
          <section className="m-sec">
            <div className="m-sec-cab"><h2>Cliente</h2></div>
            {a.company?.map((c) => <TarjetaCliente key={c.id} tipo="company" r={c} />)}
            {a.contact?.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
          </section>
        ) : null}
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Datos</h2></div>
          <dl className="m-datos">
            {claves.map((p) => {
              const v = r.props[p.name];
              const vacio = v == null || v === '';
              const puede = editable && !p.read_only;
              return (
                <button key={p.name} type="button" className="m-dato" disabled={!puede} onClick={() => setHoja({ editar: p })}>
                  <dt>{p.label}</dt><dd className={vacio ? 'muted' : ''}>{vacio ? (puede ? 'Agregar' : '—') : formatValue(meta, 'deal', p.name, v, r.props)}</dd>
                </button>
              );
            })}
          </dl>
        </section>
        {(a.order?.length ?? 0) > 0 && (
          <section className="m-sec">
            <div className="m-sec-cab"><h2>Pedidos</h2></div>
            {a.order.map((o) => <TarjetaPedido key={o.id} r={o} />)}
          </section>
        )}
        <Actividad tipo="deal" id={r.id} version={version} />
      </>}
      {hoja === 'etapa' && pipe && <CambiarEtapa deal={r} pipe={pipe} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'registrar' && <Registrar record={r} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'tarea' && <TareaRapida linkId={r.id} sobre={r.name} onClose={() => setHoja(null)} onCreada={cambio} />}
      {hoja && typeof hoja === 'object' && <EditarDato tipo="deal" record={r} prop={hoja.editar} onClose={() => setHoja(null)} onListo={cambio} />}
    </div>
  );
}

function Pestanas({ tab, setTab, sin, primera }: { tab: string; setTab: (t: string) => void; sin?: number; primera: 'resumen' | 'detalle' }) {
  const set = setTab;
  const ops: Array<[string, string]> = primera === 'resumen' ? [['resumen', 'Resumen'], ['conversacion', 'Conversación']] : [['conversacion', 'Conversación'], ['detalle', 'Detalle']];
  return (
    <div className="m-seg" role="tablist">
      {ops.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={`m-seg-op${tab === k ? ' active' : ''}`} onClick={() => set(k)}>
          {l}{k === 'conversacion' && sin ? <span className="m-pill nuevo">{sin}</span> : null}
        </button>
      ))}
    </div>
  );
}

// Cambiar de etapa: la lista entera de etapas del pipeline; si la elegida pide datos (el monto para «Envío de
// cotización», el motivo para «Perdido»), se piden ahí mismo antes de guardar.
function CambiarEtapa({ deal, pipe, onClose, onListo }: { deal: CrmRecord; pipe: Pipeline; onClose: () => void; onListo: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [pide, setPide] = useState<{ stage: Stage; missing: string[] } | null>(null);
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [ocupado, setOcupado] = useState(false);
  async function ir(stage: Stage, extra: Record<string, unknown> = {}) {
    const missing = missingFor(stage, { ...deal.props, ...extra }, extra);
    if (missing.length) { setPide({ stage, missing }); return; }
    setOcupado(true);
    try { await http('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: stage.id, ...extra } }); toast(`Pasó a «${stage.label}»`); onListo(); onClose(); }
    catch (e) {
      const m = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      if (m?.length) setPide({ stage, missing: m }); else toast((e as Error).message, true);
      setOcupado(false);
    }
  }
  if (pide) {
    const { stage } = pide;
    const props = pide.missing.map((m) => propOf(meta, 'deal', m)).filter((p): p is Property => !!p);
    const opcional = (p: Property) => !(stage.config?.required_props ?? []).includes(p.name) && (stage.config?.ask_props ?? []).includes(p.name);
    const listo = props.every((p) => opcional(p) || !faltaDato(p.name, vals[p.name]));
    return (
      <Hoja titulo={`Pasar a «${stage.label}»`} onClose={onClose}>
        <form className="m-form" onSubmit={(e) => { e.preventDefault(); if (listo) ir(stage, { ...Object.fromEntries(props.filter(opcional).map((p) => [p.name, ''])), ...vals }); }}>
          <p className="muted small" style={{ margin: 0 }}>{props.every(opcional) ? 'Si ya lo tenés:' : 'Para pasar a esta etapa hay que completar:'}</p>
          {props.map((p, i) => (
            <div key={p.name} className="field">{p.label}{opcional(p) ? ' (opcional)' : ''}
              <CampoMovil prop={p} tipo="deal" valor={vals[p.name]} onChange={(v) => setVals((x) => ({ ...x, [p.name]: v }))} autoFocus={i === 0} /></div>
          ))}
          <button type="submit" className="btn primary m-grande" disabled={!listo || ocupado}>Guardar y pasar</button>
        </form>
      </Hoja>
    );
  }
  return (
    <Hoja titulo="Cambiar etapa" onClose={onClose}>
      <div className="m-etapas">
        {pipe.stages.map((s) => (
          <button key={s.id} type="button" disabled={ocupado} className={`${s.id === deal.props.dealstage ? 'on' : ''}${s.is_closed ? (s.is_won ? ' ganado' : ' perdido') : ''}`}
            onClick={() => (s.id === deal.props.dealstage ? onClose() : ir(s))}>
            <span className="m-etapa-punto" aria-hidden="true" />{s.label}
            {s.id === deal.props.dealstage && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
    </Hoja>
  );
}

// Alta corta de un negocio: nombre, empresa, monto y etapa (más lo que pida la etapa elegida).
export function AltaNegocio({ pipelineId, empresa, onClose }: { pipelineId?: string; empresa?: { id: number; name: string }; onClose: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const pipes = usePipelines();
  const inicial = pipes.find((p) => p.id === pipelineId) ?? pipes.find((p) => p.id === defaultPipeline(meta)?.id) ?? pipes[0];
  const primeras = (p?: Pipeline) => { const ok = p?.config.rules?.create_stages ?? []; return (ok.length ? p?.stages.filter((s) => ok.includes(s.id)) : p?.stages.filter((s) => !s.is_closed)) ?? []; };
  const [pid, setPid] = useState(inicial?.id ?? '');
  const pipe = pipes.find((p) => p.id === pid);
  const [sid, setSid] = useState(primeras(inicial)[0]?.id ?? '');
  const stage = pipe?.stages.find((s) => s.id === sid);
  const [f, setF] = useState<Record<string, unknown>>({});
  const [emp, setEmp] = useState<{ id: number; name: string } | null>(empresa ?? null);
  const [ocupado, setOcupado] = useState(false);
  const propios = ['dealname', 'amount', 'producto', 'cantidad', 'pipeline', 'dealstage', 'owner_id'];
  const extra = useMemo(() => {
    const req = meta.properties.filter((p) => p.object_type === 'deal' && p.required && !p.read_only && !propios.includes(p.name));
    const deEtapa = (stage?.config.required_props ?? []).filter((n) => !propios.includes(n) || n === 'amount').map((n) => propOf(meta, 'deal', n)).filter((p): p is Property => !!p && p.name !== 'amount');
    return [...req, ...deEtapa.filter((p) => !req.includes(p))];
  }, [meta, stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const montoObligatorio = (stage?.config.required_props ?? []).includes('amount');
  const pideEmpresa = !!pipe?.config.rules?.require_company;
  const listo = !!String(f.dealname ?? '').trim() && !!stage && (!montoObligatorio || Number(f.amount) > 0) && (!pideEmpresa || !!emp)
    && extra.every((p) => !faltaDato(p.name, f[p.name]));
  async function crear() {
    if (!listo || !pipe || !stage) return;
    setOcupado(true);
    try {
      const props = Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== ''));
      const r = await http<CrmRecord>('POST', '/records/deal', { props: { ...props, pipeline: pipe.id, dealstage: stage.id, owner_id: meta.me.id }, associations: emp ? [emp.id] : [] });
      toast('Negocio creado');
      onClose();
      navigate(recordUrl('deal', r.id));
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Hoja titulo="Nuevo negocio" onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); crear(); }}>
        <label className="field">Nombre del negocio<input className="input" autoFocus value={String(f.dealname ?? '')} onChange={(e) => set('dealname', e.target.value)} placeholder="Termos con logo para fin de año" /></label>
        {empresa ? <div className="small muted">Para {empresa.name}.</div> : <ElegirEmpresa valor={emp} onElegir={setEmp} />}
        {pideEmpresa && !emp && <div className="small muted">En «{pipe?.label}» el negocio tiene que tener una empresa.</div>}
        <div className="m-2">
          <label className="field">Monto{montoObligatorio ? '' : ' (opcional)'}<input className="input num" inputMode="decimal" value={String(f.amount ?? '')} onChange={(e) => set('amount', e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="$" /></label>
          <label className="field">Cantidad<input className="input" inputMode="numeric" value={String(f.cantidad ?? '')} onChange={(e) => set('cantidad', e.target.value)} /></label>
        </div>
        <label className="field">Producto<input className="input" value={String(f.producto ?? '')} onChange={(e) => set('producto', e.target.value)} placeholder="Termos, mochilas, gorras…" /></label>
        {pipes.length > 1 && (
          <label className="field">Pipeline
            <select className="input" value={pid} onChange={(e) => { const p = pipes.find((x) => x.id === e.target.value); setPid(e.target.value); setSid(primeras(p)[0]?.id ?? ''); }}>
              {pipes.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select></label>
        )}
        <div className="field">Etapa
          <div className="m-chips" role="group" aria-label="Etapa">
            {primeras(pipe).map((s) => <button key={s.id} type="button" className={`chip sm${sid === s.id ? ' on' : ''}`} aria-pressed={sid === s.id} onClick={() => setSid(s.id)}>{s.label}</button>)}
          </div>
        </div>
        {extra.map((p) => (
          <div key={p.name} className="field">{p.label}<CampoMovil prop={p} tipo="deal" valor={f[p.name]} onChange={(v) => set(p.name, v)} /></div>
        ))}
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !listo}>Crear negocio</button>
      </form>
    </Hoja>
  );
}

// ---------- Pedidos ----------

export function PedidosLista() {
  const { meta } = useMeta();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [mios, setMios] = useState(true);
  const [lista, setLista] = useState<Con[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasta, setHasta] = useState(PAGINA);
  useEffect(() => { setHasta(PAGINA); }, [dq, mios]);
  useEffect(() => {
    let vivo = true;
    const filters = mios ? [{ prop: 'owner_id', op: 'eq', value: meta.me.id }] : [];
    http<{ results: Con[]; total: number }>('GET', `/records/order${qs({ q: dq.trim() || undefined, filters, sort: 'hs_lastmodifieddate', dir: 'desc', limit: hasta, with: 'company' })}`)
      .then((r) => { if (vivo) { setLista(r.results); setTotal(r.total); } }, () => { if (vivo) setLista([]); });
    return () => { vivo = false; };
  }, [dq, mios, hasta, meta.me.id]);
  return (
    <div className="m-pag">
      <Segmento />
      <div className="search"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PDV, cliente…" aria-label="Buscar pedido" /></div>
      <div className="m-chips" role="group" aria-label="De quién">
        <button type="button" className={`chip${mios ? ' on' : ''}`} aria-pressed={mios} onClick={() => setMios(true)}>Míos</button>
        <button type="button" className={`chip${!mios ? ' on' : ''}`} aria-pressed={!mios} onClick={() => setMios(false)}>Todos los que veo</button>
      </div>
      {!lista && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{dq ? `No hay pedidos con «${dq}».` : 'No hay pedidos.'}</div>}
      {lista && lista.length > 0 && (
        <div className="m-sec">
          {lista.map((r) => <TarjetaPedido key={r.id} r={r} />)}
          {total > lista.length && <button type="button" className="m-ver" onClick={() => setHasta((h) => h + PAGINA)}>Ver más ({total - lista.length})</button>}
        </div>
      )}
    </div>
  );
}

function TarjetaPedido({ r }: { r: Con }) {
  const { meta } = useMeta();
  const sin = useNoLeidosDe(r.id);
  const etapa = formatValue(meta, 'order', 'hs_pipeline_stage', r.props.hs_pipeline_stage);
  return (
    <Link to={recordUrl('order', r.id)} className="m-item m-item-link">
      <div className="m-item-txt">
        <b>{r.name}{sin ? <span className="m-pill nuevo">{sin.menciones ? '@' : ''}{sin.no_leidos}</span> : null}</b>
        <small className="muted">{[r.company?.name, r.props.fecha_de_entrega ? `Entrega ${fmtDate(r.props.fecha_de_entrega)}` : null].filter(Boolean).join(' · ') || 'Sin datos'}</small>
      </div>
      {etapa && <span className="m-etapa-chip"><EtapaPedido value={r.props.hs_pipeline_stage} label={etapa} /></span>}
    </Link>
  );
}

interface Renglon { code: string | null; name: string; image_url: string | null; quantity: number | null; status?: string | null; status_color?: string | null; tipo?: 'producto' | 'servicio' }
interface Archivo { id: number; kind: string; name: string; ready: boolean; meta: Record<string, any>; created_at: string }

export function FichaPedido() {
  const { id = '0' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [datos, setDatos] = useState<{ record: CrmRecord; associations: Assoc; redirect?: number } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'conversacion' | 'detalle'>(() => (new URLSearchParams(window.location.search).has('detalle') ? 'detalle' : 'conversacion'));
  const sin = useNoLeidosDe(Number(id));
  useEffect(() => {
    http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/order/${id}`)
      .then((d) => { if (d.redirect) navigate(recordUrl('order', d.redirect), { replace: true }); else { setDatos(d); setError(''); } }, (e) => setError((e as Error).message));
  }, [id, navigate]);
  if (error) return <div className="m-pag"><div className="m-vacio m-vacio-solo">{error} <Link to="/orders">Volver</Link></div></div>;
  if (!datos) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = datos;
  const empresa = a.company?.find((c) => c.primary) ?? a.company?.[0];
  const etapa = formatValue(meta, 'order', 'hs_pipeline_stage', r.props.hs_pipeline_stage);
  const destino: DestinoOpcion | null = empresa ? {
    tipo: 'empresa', key: `c:${empresa.id}`, nombre: empresa.name, direccion: [empresa.props.address, empresa.props.city].filter(Boolean).join(', ') || null,
    detalle: null, lugar_id: null, company_id: empresa.id, record_id: r.id,
  } : null;
  return (
    <div className={`m-pag m-ficha${tab === 'conversacion' ? ' m-con-chat' : ''}`}>
      <div className="m-ficha-tit">
        <h1>{r.name}</h1>
        <p className="muted">{[r.props.pdv_finnegans && !r.name.includes(String(r.props.pdv_finnegans)) ? `PDV ${r.props.pdv_finnegans}` : null, empresa?.name].filter(Boolean).join(' · ')}</p>
        <div className="m-pedido-estado">
          {etapa && <EtapaPedido value={r.props.hs_pipeline_stage} label={etapa} />}
          {r.props.fecha_de_entrega && <span className="small muted">Entrega {fmtDate(r.props.fecha_de_entrega)}</span>}
        </div>
      </div>
      <Pestanas tab={tab} setTab={(t) => setTab(t as 'conversacion' | 'detalle')} sin={sin?.no_leidos} primera="detalle" />
      {tab === 'conversacion'
        ? <ConversacionPanel type="order" recordId={r.id} className="en-ficha m-conv" />
        : <DetallePedido r={r} a={a} empresa={empresa} destino={destino} />}
    </div>
  );
}

function DetallePedido({ r, a, empresa, destino }: { r: CrmRecord; a: Assoc; empresa?: CrmRecord; destino: DestinoOpcion | null }) {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [items, setItems] = useState<Renglon[] | null>(null);
  const [archivos, setArchivos] = useState<Archivo[] | null>(null);
  useEffect(() => {
    http<{ items: Renglon[] }>('GET', `/records/order/${r.id}/products`).then((x) => setItems(x.items), () => setItems([]));
    http<Archivo[]>('GET', `/records/order/${r.id}/files`).then(setArchivos, () => setArchivos([]));
  }, [r.id]);
  const entrega = ['estado_entrega', 'direccion_entrega', 'falta_entregar', 'entregado_el'].map((n) => propOf(meta, 'order', n)).filter((p): p is Property => !!p && r.props[p.name] != null && r.props[p.name] !== '');
  return (
    <>
      {destino && (
        <div className="m-rapidas">
          <button type="button" className="btn" onClick={() => navigate('/recorridos/nuevo', { state: { destino } })}><Icon name="route" size={16} />Encargo para este pedido</button>
        </div>
      )}
      <section className="m-sec">
        <div className="m-sec-cab"><h2>Artículos</h2><span className="muted small">{items?.length || ''}</span></div>
        {!items && <Cargando chico />}
        {items && !items.length && <div className="m-vacio">Todavía no hay artículos cargados.</div>}
        {items?.map((it, i) => (
          <div key={`${it.code}-${i}`} className="m-item">
            {it.image_url ? <img className="m-art-img" src={it.image_url} alt="" loading="lazy" /> : <span className="m-art-img vacia"><Icon name="bag" size={18} /></span>}
            <div className="m-item-txt"><b className="m-art-nombre">{it.name}</b>
              <small className="muted">{[it.quantity != null ? `${it.quantity} u.` : null, it.code].filter(Boolean).join(' · ')}</small></div>
            {it.status && it.tipo !== 'servicio' && <span className="m-art-estado" style={it.status_color ? { ['--c' as string]: it.status_color } : undefined}>{it.status}</span>}
          </div>
        ))}
      </section>
      {entrega.length > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Entrega</h2></div>
          <dl className="m-datos">{entrega.map((p) => <div key={p.name} className="m-dato"><dt>{p.label}</dt><dd>{formatValue(meta, 'order', p.name, r.props[p.name], r.props)}</dd></div>)}</dl>
        </section>
      )}
      {empresa && <div className="m-logos"><LogosCard companyId={empresa.id} /></div>}
      {archivos && archivos.length > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Factura y remitos</h2></div>
          {archivos.map((f) => (
            <a key={f.id} className="m-item m-item-link" href={f.ready ? `/api/files/${f.id}` : undefined} target="_blank" rel="noreferrer">
              <Icon name={f.kind === 'factura' ? 'receipt' : 'truck'} size={18} />
              <div className="m-item-txt"><b>{f.kind === 'factura' ? `Factura ${f.meta.numero ?? ''}` : f.kind === 'remito' ? 'Remito' : f.name}</b>
                <small className="muted">{f.ready ? fmtDate(f.meta.fecha ?? f.meta.date ?? f.created_at) : 'En camino'}</small></div>
            </a>
          ))}
        </section>
      )}
      {(a.contact?.length ?? 0) > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Contactos</h2></div>
          {a.contact.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
        </section>
      )}
      {(a.deal?.length ?? 0) > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Negocio</h2></div>
          {a.deal.map((d) => <TarjetaNegocio key={d.id} r={d} />)}
        </section>
      )}
    </>
  );
}
