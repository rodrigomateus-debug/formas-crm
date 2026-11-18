import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  esOperaciones, http, qs, useMeta, useToast, useDebounced, Icon, Cargando, fmtDate, fmtMoney, fmtMoneyExact, fmtRelative, formatValue, propOf, recordUrl, stageOf, canSeePipeline, defaultPipeline,
  missingFor, faltaDato, keyPropsFor, type CrmRecord, type ObjectType, type Pipeline, type Property, type Stage,
} from '../lib';
import { EtapaPedido } from '../components';
import { useNoLeidosDe } from '../pages/Conversacion';
import { LogosCard } from '../pages/Logos';
import type { DestinoOpcion } from '../pages/Recorridos';
import { Hoja, TareaRapida } from './Movil';
import { Actividad, CampoMovil, Datos, EditarDato, ElegirEmpresa, Registrar, TarjetaCliente } from './ClientesMovil';
import { Fallo, useCarga, useCerrarConAtras, usePuedeEscribir } from './base';

// Ventas en el celular (versión celular, fase 3): Negocios | Pedidos. Los negocios se ven por etapa, se crean con lo
// mínimo y se pasan de etapa (pidiendo lo que la etapa exige, como en el escritorio). Los pedidos no se crean desde acá:
// se consultan (estado, entrega, artículos, logos, factura) y se conversa con el equipo, con archivos y menciones. La
// conversación se abre a pantalla completa (/conversaciones/…): dentro de la ficha, con el teclado abierto, no se veía.

type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;
type Con = CrmRecord & { company?: { id: number; name: string } | null };
type Ref = { id: number; name: string };

function Segmento() {
  const [sp] = useSearchParams();
  const { meta } = useMeta();
  const q = sp.get('q');
  // Producción y Logística no ven negocios: solo Pedidos.
  if (esOperaciones(meta.me)) return null;
  return (
    <nav className="m-seg" aria-label="Negocios o pedidos">
      <NavLink to={`/deals${q ? `?q=${encodeURIComponent(q)}` : ''}`} className="m-seg-op">Negocios</NavLink>
      <NavLink to={`/orders${q ? `?q=${encodeURIComponent(q)}` : ''}`} className="m-seg-op">Pedidos</NavLink>
    </nav>
  );
}

// Los pipelines de negocios que puede ver (la misma regla que el servidor). El de arranque: donde más trabaja.
function usePipelines() {
  const { meta } = useMeta();
  return useMemo(() => {
    const pipes = meta.pipelines.filter((p) => canSeePipeline(meta.me, p));
    const inicial = pipes.find((p) => p.id === meta.me.deal_pipelines?.[0]) ?? pipes.find((p) => p.id === defaultPipeline(meta)?.id) ?? pipes[0];
    return { pipes, inicial };
  }, [meta]);
}

// «1.500.000», «1500000,50», «$ 2.300»: el monto como número (o null si no se entiende).
export function leerMonto(s: string): number | null {
  let t = s.replace(/[^\d.,]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t) || (t.match(/\./g)?.length ?? 0) > 1) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------- Negocios ----------

const PAGINA = 30;
type Quien = 'mios' | 'libres' | 'todos';
export function NegociosLista() {
  const { meta } = useMeta();
  const puede = usePuedeEscribir();
  const { pipes, inicial } = usePipelines();
  // Pipeline, etapa, búsqueda y de quién quedan en la dirección: al volver de una ficha siguen ahí.
  const [sp, setSp] = useSearchParams();
  const cambiar = (cambios: Record<string, string | null>) => setSp((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(cambios)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });
  const pipe = pipes.find((p) => p.id === sp.get('pipeline')) ?? inicial;
  const etapa = sp.get('etapa') ?? 'abiertos';
  const quien = (['mios', 'libres', 'todos'] as const).find((x) => x === sp.get('quien')) ?? 'mios';
  const q = sp.get('q') ?? '';
  const [texto, setTexto] = useState(q);
  const dq = useDebounced(texto, 250);
  useEffect(() => { if (dq.trim() !== q) cambiar({ q: dq.trim() || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hasta, setHasta] = useState(PAGINA);
  const [alta, setAlta] = useState(false);
  const abiertas = pipe?.stages.filter((s) => !s.is_closed) ?? [];
  const cerradas = pipe?.stages.filter((s) => s.is_closed) ?? [];
  useEffect(() => { setHasta(PAGINA); }, [pipe?.id, etapa, q, quien]);
  const carga = useCarga(async () => {
    if (!pipe) return { results: [] as Con[], total: 0 };
    const ids = etapa === 'abiertos' ? abiertas.map((s) => s.id) : etapa === 'cerrados' ? cerradas.map((s) => s.id) : [etapa];
    const dueno = quien === 'mios' ? [{ prop: 'owner_id', op: 'eq', value: meta.me.id }] : quien === 'libres' ? [{ prop: 'owner_id', op: 'unknown' }] : [];
    const filters = [{ prop: 'pipeline', op: 'eq', value: pipe.id }, ...dueno, { prop: 'dealstage', op: 'in', values: ids }];
    return http<{ results: Con[]; total: number }>('GET', `/records/deal${qs({ q: q || undefined, filters, sort: etapa === 'cerrados' ? 'closedate' : 'hs_lastmodifieddate', dir: 'desc', limit: hasta, with: 'company' })}`);
  }, [pipe?.id, etapa, q, quien, hasta, meta.me.id]);
  const lista = carga.datos?.results ?? null;
  const total = carga.datos?.total ?? 0;
  const suma = (lista ?? []).reduce((a, r) => a + (Number(r.props.amount) || 0), 0);
  return (
    <div className="m-pag">
      <Segmento />
      {pipes.length > 1 && (
        <select className="input" value={pipe?.id ?? ''} onChange={(e) => cambiar({ pipeline: e.target.value, etapa: null })} aria-label="Pipeline">
          {pipes.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      )}
      <div className="search"><Icon name="search" /><input className="input" type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Buscar negocio…" aria-label="Buscar negocio" enterKeyHint="search" /></div>
      <div className="m-chips m-chips-scroll" role="group" aria-label="Etapa">
        <button type="button" className={`chip${etapa === 'abiertos' ? ' on' : ''}`} aria-pressed={etapa === 'abiertos'} onClick={() => cambiar({ etapa: null })}>Abiertos</button>
        {abiertas.map((s) => <button key={s.id} type="button" className={`chip${etapa === s.id ? ' on' : ''}`} aria-pressed={etapa === s.id} onClick={() => cambiar({ etapa: s.id })}>{s.label}</button>)}
        <button type="button" className={`chip${etapa === 'cerrados' ? ' on' : ''}`} aria-pressed={etapa === 'cerrados'} onClick={() => cambiar({ etapa: 'cerrados' })}>Cerrados</button>
      </div>
      <div className="m-chips" role="group" aria-label="De quién">
        {([['mios', 'Míos'], ['libres', 'Sin dueño'], ['todos', 'Todos los que veo']] as Array<[Quien, string]>).map(([k, l]) => (
          <button key={k} type="button" className={`chip sm${quien === k ? ' on' : ''}`} aria-pressed={quien === k} onClick={() => cambiar({ quien: k === 'mios' ? null : k })}>{l}</button>
        ))}
      </div>
      <div className="m-fila">
        <span className="small muted">{lista ? `${total} ${total === 1 ? 'negocio' : 'negocios'}${suma ? ` · ${fmtMoney(suma)}${total > lista.length ? ' en los que se ven' : ''}` : ''}` : ''}</span>
        <span className="grow" />
        {puede && <button type="button" className="m-link" onClick={() => setAlta(true)}><Icon name="plus" size={14} />Negocio</button>}
      </div>
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!lista && !carga.error && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{q ? `No hay negocios con «${q}».` : quien === 'libres' ? 'No hay negocios sin dueño acá.' : 'No hay negocios acá.'}</div>}
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
        <b>{r.name}{sin ? <span className="m-pill nuevo" aria-label={`${sin.no_leidos} mensajes sin leer`}>{sin.menciones ? '@' : ''}{sin.no_leidos}</span> : null}</b>
        <small className="muted">{[r.company?.name, s?.label].filter(Boolean).join(' · ')}</small>
      </div>
      <span className="m-monto"><b className="num">{fmtMoney(r.props.amount) || '—'}</b>{r.props.notes_last_updated && <small className="muted">{fmtRelative(r.props.notes_last_updated, true)}</small>}</span>
    </Link>
  );
}

// El botón que abre la conversación del equipo a pantalla completa, con cuántos mensajes hay sin leer.
export function BotonConversacion({ tipo, id }: { tipo: ObjectType; id: number }) {
  const sin = useNoLeidosDe(id);
  return (
    <Link to={`/conversaciones/${tipo}/${id}`} className={`m-conv-boton${sin ? ' nuevo' : ''}`}>
      <Icon name="chat" size={20} />
      <span><b>Conversación del equipo</b><small>{sin ? `${sin.no_leidos} sin leer${sin.menciones ? ' · te mencionaron' : ''}` : 'Comentar, avisar con @, subir fotos y archivos'}</small></span>
      {sin ? <span className="m-badge-fila">{sin.no_leidos}</span> : <Icon name="chevron" size={16} />}
    </Link>
  );
}

export function FichaNegocio() {
  const { id = '0' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const puede = usePuedeEscribir();
  const carga = useCarga(() => http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/deal/${id}`), [id]);
  const [version, setVersion] = useState(0);
  const [todos, setTodos] = useState(false);
  const [hoja, setHoja] = useState<null | 'etapa' | 'registrar' | 'tarea' | { editar: Property }>(null);
  const cambio = () => { carga.recargar(); setVersion((v) => v + 1); };
  useEffect(() => { if (carga.datos?.redirect) navigate(recordUrl('deal', carga.datos.redirect), { replace: true }); }, [carga.datos, navigate]);
  if (carga.error) return <div className="m-pag"><Fallo error={carga.error} onReintentar={carga.recargar} /></div>;
  if (!carga.datos?.record) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = carga.datos;
  const pipe = meta.pipelines.find((p) => p.id === r.props.pipeline);
  const etapa = stageOf(meta, r.props.dealstage)?.stage;
  const claves = (pipe?.config.key_props?.length ? pipe.config.key_props : keyPropsFor(meta, 'deal')).filter((n) => !['dealstage', 'pipeline', 'link_a_darwin'].includes(n));
  // Lo que exige la etapa en la que está (el monto en «Envío de cotización»): no se puede vaciar.
  const obligatorios = etapa?.config?.required_props ?? [];
  return (
    <div className="m-pag m-ficha">
      <div className="m-ficha-tit">
        <h1>{r.name}</h1>
        <p className="m-negocio-sub"><b className="num">{fmtMoney(r.props.amount) || 'Sin monto'}</b>{pipe && <span className="muted"> · {pipe.label}</span>}</p>
      </div>
      <button type="button" className={`m-etapa${etapa?.is_closed ? (etapa.is_won ? ' ganado' : ' perdido') : ''}`} disabled={!puede} onClick={() => setHoja('etapa')}
        aria-label={`Etapa: ${etapa?.label ?? 'sin etapa'}${puede ? '. Cambiar' : ''}`}>
        <span><small>Etapa</small><b>{etapa?.label ?? 'Sin etapa'}</b></span>
        {pipe && etapa && <span className="m-etapa-barra" aria-hidden="true">{pipe.stages.filter((s) => !s.is_closed).map((s) => <i key={s.id} className={s.display_order <= etapa.display_order ? 'on' : ''} />)}</span>}
        {puede && <span className="m-link">Cambiar</span>}
      </button>
      <BotonConversacion tipo="deal" id={r.id} />
      {puede && (
        <div className="m-rapidas">
          <button type="button" className="btn" onClick={() => setHoja('registrar')}><Icon name="note" size={16} />Registrar</button>
          <button type="button" className="btn" onClick={() => setHoja('tarea')}><Icon name="task" size={16} />Tarea</button>
        </div>
      )}
      {(a.company?.length || a.contact?.length) ? (
        <section className="m-sec" aria-label="Cliente">
          <div className="m-sec-cab"><h2>Cliente</h2></div>
          {a.company?.map((c) => <TarjetaCliente key={c.id} tipo="company" r={c} />)}
          {a.contact?.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
        </section>
      ) : null}
      {(a.order?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Pedidos">
          <div className="m-sec-cab"><h2>Pedidos</h2></div>
          {a.order.map((o) => <TarjetaPedido key={o.id} r={o} />)}
        </section>
      )}
      <Datos tipo="deal" record={r} claves={claves} todos={todos} onTodos={() => setTodos(!todos)} onEditar={(p) => setHoja({ editar: p })} onCambio={cambio} obligatorios={obligatorios} />
      <Actividad tipo="deal" id={r.id} version={version} />
      {hoja === 'etapa' && pipe && <CambiarEtapa deal={r} pipe={pipe} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'registrar' && <Registrar record={{ id: r.id, name: r.name }} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'tarea' && <TareaRapida linkId={r.id} sobre={r.name} onClose={() => setHoja(null)} onCreada={cambio} />}
      {hoja && typeof hoja === 'object' && <EditarDato tipo="deal" record={r} prop={hoja.editar} obligatorio={obligatorios.includes(hoja.editar.name)} onClose={() => setHoja(null)} onListo={cambio} />}
    </div>
  );
}

// Cambiar de etapa: la lista entera de etapas del pipeline; si la elegida pide datos (el monto para «Envío de
// cotización», el motivo para «Perdido»), se piden ahí mismo antes de guardar. En una etapa perdida se puede sumar el
// detalle del motivo, como en el escritorio (StageProps en Board.tsx).
function CambiarEtapa({ deal, pipe, onClose, onListo }: { deal: CrmRecord; pipe: Pipeline; onClose: () => void; onListo: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [pide, setPide] = useState<{ stage: Stage; missing: string[] } | null>(null);
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [ocupado, setOcupado] = useState(false);
  const detalle = propOf(meta, 'deal', 'closed_lost_reason');
  async function ir(stage: Stage, extra: Record<string, unknown> = {}) {
    const missing = missingFor(stage, { ...deal.props, ...extra }, extra);
    const perdida = !!stage.is_closed && !stage.is_won;
    if (missing.length || (perdida && detalle && !('closed_lost_reason' in extra) && !pide)) { setPide({ stage, missing }); return; }
    setOcupado(true);
    try { await http('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: stage.id, ...extra } }); toast(`Pasó a «${stage.label}»`); onListo(); onClose(); }
    catch (e) {
      const m = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      // Si el servidor pide algo que la pantalla no sabe mostrar, se dice (antes la hoja quedaba vacía, en un bucle).
      if (m?.length && m.every((n) => propOf(meta, 'deal', n))) setPide({ stage, missing: m }); else toast((e as Error).message, true);
      setOcupado(false);
    }
  }
  if (pide) {
    const { stage } = pide;
    const props = pide.missing.map((m) => propOf(meta, 'deal', m)).filter((p): p is Property => !!p);
    const opcional = (p: Property) => !(stage.config?.required_props ?? []).includes(p.name) && (stage.config?.ask_props ?? []).includes(p.name);
    const perdida = !!stage.is_closed && !stage.is_won;
    const conDetalle = perdida && detalle && !pide.missing.includes('closed_lost_reason');
    const listo = props.every((p) => opcional(p) || !faltaDato(p.name, vals[p.name]));
    return (
      <Hoja titulo={`Pasar a «${stage.label}»`} onClose={onClose}>
        <form className="m-form" onSubmit={(e) => {
          e.preventDefault();
          if (listo) ir(stage, { ...Object.fromEntries(props.filter(opcional).map((p) => [p.name, ''])), ...(conDetalle ? { closed_lost_reason: vals.closed_lost_reason ?? '' } : {}), ...vals });
        }}>
          {props.length > 0 && <p className="muted small" style={{ margin: 0 }}>{props.every(opcional) ? 'Si ya lo tenés:' : 'Para pasar a esta etapa hay que completar:'}</p>}
          {props.map((p, i) => (
            <div key={p.name} className="field">{p.label}{opcional(p) ? ' (opcional)' : ' *'}{p.description && opcional(p) ? <small className="muted"> · {p.description}</small> : null}
              <CampoMovil prop={p} tipo="deal" valor={vals[p.name]} onChange={(v) => setVals((x) => ({ ...x, [p.name]: v }))} autoFocus={i === 0} obligatorio={!opcional(p)} /></div>
          ))}
          {conDetalle && (
            <label className="field">{detalle!.label} (opcional)
              <textarea className="input" rows={2} value={String(vals.closed_lost_reason ?? '')} onChange={(e) => setVals((x) => ({ ...x, closed_lost_reason: e.target.value }))} placeholder="Qué pasó, para aprender de esto" /></label>
          )}
          <button type="submit" className="btn primary m-grande" disabled={!listo || ocupado}>Guardar y pasar</button>
        </form>
      </Hoja>
    );
  }
  return (
    <Hoja titulo="Cambiar etapa" onClose={onClose}>
      <div className="m-etapas" role="radiogroup" aria-label="Etapa">
        {pipe.stages.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={s.id === deal.props.dealstage} disabled={ocupado} className={`${s.id === deal.props.dealstage ? 'on' : ''}${s.is_closed ? (s.is_won ? ' ganado' : ' perdido') : ''}`}
            onClick={() => (s.id === deal.props.dealstage ? onClose() : ir(s))}>
            <span className="m-etapa-punto" aria-hidden="true" />{s.label}
            {s.id === deal.props.dealstage && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
    </Hoja>
  );
}

// Alta corta de un negocio: nombre, empresa, monto y etapa (más lo que pida la etapa elegida). Desde la ficha de un
// contacto, el negocio queda asociado a ese contacto (y el servidor suma su empresa principal).
export function AltaNegocio({ pipelineId, empresa, asociar = [], onClose }: { pipelineId?: string; empresa?: Ref; asociar?: number[]; onClose: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const { pipes, inicial: porDefecto } = usePipelines();
  const inicial = pipes.find((p) => p.id === pipelineId) ?? porDefecto;
  const primeras = (p?: Pipeline) => { const ok = p?.config.rules?.create_stages ?? []; return (ok.length ? p?.stages.filter((s) => ok.includes(s.id)) : p?.stages.filter((s) => !s.is_closed)) ?? []; };
  const [pid, setPid] = useState(inicial?.id ?? '');
  const pipe = pipes.find((p) => p.id === pid);
  const [sid, setSid] = useState(primeras(inicial)[0]?.id ?? '');
  const stage = pipe?.stages.find((s) => s.id === sid);
  const [f, setF] = useState<Record<string, unknown>>({});
  const [montoTxt, setMontoTxt] = useState('');
  const [emp, setEmp] = useState<Ref | null>(empresa ?? null);
  const [ocupado, setOcupado] = useState(false);
  const propios = ['dealname', 'amount', 'producto', 'cantidad', 'pipeline', 'dealstage', 'owner_id'];
  const extra = useMemo(() => {
    const req = meta.properties.filter((p) => p.object_type === 'deal' && p.required && !p.read_only && !propios.includes(p.name));
    const deEtapa = (stage?.config.required_props ?? []).filter((n) => !propios.includes(n)).map((n) => propOf(meta, 'deal', n)).filter((p): p is Property => !!p);
    return [...req, ...deEtapa.filter((p) => !req.includes(p))];
  }, [meta, stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const monto = leerMonto(montoTxt);
  const montoObligatorio = (stage?.config.required_props ?? []).includes('amount');
  // Con un contacto, el servidor resuelve la empresa (la principal del contacto).
  const pideEmpresa = !!pipe?.config.rules?.require_company && !asociar.length;
  const faltan = [
    !String(f.dealname ?? '').trim() && 'el nombre',
    !stage && 'la etapa',
    montoObligatorio && !(monto && monto > 0) && 'el monto',
    montoTxt && monto == null && 'un monto válido',
    pideEmpresa && !emp && 'la empresa',
    ...extra.filter((p) => faltaDato(p.name, f[p.name])).map((p) => p.label.toLowerCase()),
  ].filter(Boolean) as string[];
  async function crear() {
    if (faltan.length || !pipe || !stage || ocupado) return;
    setOcupado(true);
    try {
      const props = Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== ''));
      const r = await http<CrmRecord>('POST', '/records/deal', {
        props: { ...props, ...(monto != null ? { amount: monto } : {}), pipeline: pipe.id, dealstage: stage.id, owner_id: meta.me.id },
        associations: [...new Set([...(emp ? [emp.id] : []), ...asociar])],
      });
      toast('Negocio creado');
      onClose();
      navigate(recordUrl('deal', r.id));
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Hoja titulo="Nuevo negocio" onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); crear(); }}>
        <label className="field">Nombre del negocio<input className="input" autoFocus value={String(f.dealname ?? '')} onChange={(e) => set('dealname', e.target.value)} placeholder="Termos con logo para fin de año" enterKeyHint="next" /></label>
        {empresa ? <div className="small muted">Para {empresa.name}.</div> : <ElegirEmpresa valor={emp} onElegir={setEmp} />}
        {pideEmpresa && !emp && <div className="small muted">En «{pipe?.label}» el negocio tiene que tener una empresa.</div>}
        <div className="m-2">
          <label className="field">Monto{montoObligatorio ? ' *' : ' (opcional)'}<input className="input num" inputMode="decimal" value={montoTxt} onChange={(e) => setMontoTxt(e.target.value)} placeholder="$ 1.500.000" enterKeyHint="next" />
            {monto != null && montoTxt && <small className="muted">{fmtMoneyExact(monto)}</small>}</label>
          <label className="field">Cantidad<input className="input" inputMode="numeric" value={String(f.cantidad ?? '')} onChange={(e) => set('cantidad', e.target.value)} enterKeyHint="next" /></label>
        </div>
        <label className="field">Producto<input className="input" value={String(f.producto ?? '')} onChange={(e) => set('producto', e.target.value)} placeholder="Termos, mochilas, gorras…" /></label>
        {pipes.length > 1 && (
          <label className="field">Pipeline
            <select className="input" value={pid} onChange={(e) => { const p = pipes.find((x) => x.id === e.target.value); setPid(e.target.value); setSid(primeras(p)[0]?.id ?? ''); }}>
              {pipes.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select></label>
        )}
        <div className="field">Etapa
          <div className="m-chips" role="radiogroup" aria-label="Etapa">
            {primeras(pipe).map((s) => <button key={s.id} type="button" role="radio" className={`chip sm${sid === s.id ? ' on' : ''}`} aria-checked={sid === s.id} onClick={() => setSid(s.id)}>{s.label}</button>)}
          </div>
        </div>
        {extra.map((p) => (
          <div key={p.name} className="field">{p.label} *<CampoMovil prop={p} tipo="deal" valor={f[p.name]} onChange={(v) => set(p.name, v)} obligatorio /></div>
        ))}
        <button type="submit" className="btn primary m-grande" disabled={ocupado || faltan.length > 0}>{faltan.length ? `Falta ${faltan.join(', ')}` : 'Crear negocio'}</button>
      </form>
    </Hoja>
  );
}

// ---------- Pedidos ----------

export function PedidosLista() {
  const { meta } = useMeta();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  // Producción y Logística trabajan con todos los pedidos (no son suyos): sin «Míos».
  const operaciones = esOperaciones(meta.me);
  const mios = !operaciones && sp.get('todos') !== '1';
  const cambiar = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const [texto, setTexto] = useState(q);
  const dq = useDebounced(texto, 250);
  useEffect(() => { if (dq.trim() !== q) cambiar('q', dq.trim() || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hasta, setHasta] = useState(PAGINA);
  useEffect(() => { setHasta(PAGINA); }, [q, mios]);
  const carga = useCarga(() => {
    const filters = mios ? [{ prop: 'owner_id', op: 'eq', value: meta.me.id }] : [];
    return http<{ results: Con[]; total: number }>('GET', `/records/order${qs({ q: q || undefined, filters, sort: 'hs_lastmodifieddate', dir: 'desc', limit: hasta, with: 'company' })}`);
  }, [q, mios, hasta, meta.me.id]);
  const lista = carga.datos?.results ?? null;
  const total = carga.datos?.total ?? 0;
  return (
    <div className="m-pag">
      <Segmento />
      <div className="search"><Icon name="search" /><input className="input" type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="PDV, cliente…" aria-label="Buscar pedido" enterKeyHint="search" /></div>
      {!operaciones && (
        <div className="m-chips" role="group" aria-label="De quién">
          <button type="button" className={`chip${mios ? ' on' : ''}`} aria-pressed={mios} onClick={() => cambiar('todos', null)}>Míos</button>
          <button type="button" className={`chip${!mios ? ' on' : ''}`} aria-pressed={!mios} onClick={() => cambiar('todos', '1')}>Todos los que veo</button>
        </div>
      )}
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!lista && !carga.error && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{q ? `No hay pedidos con «${q}».` : 'No hay pedidos.'}</div>}
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
        <b>{r.name}{sin ? <span className="m-pill nuevo" aria-label={`${sin.no_leidos} mensajes sin leer`}>{sin.menciones ? '@' : ''}{sin.no_leidos}</span> : null}</b>
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
  const puede = usePuedeEscribir();
  const carga = useCarga(() => http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/order/${id}`), [id]);
  useEffect(() => { if (carga.datos?.redirect) navigate(recordUrl('order', carga.datos.redirect), { replace: true }); }, [carga.datos, navigate]);
  if (carga.error) return <div className="m-pag"><Fallo error={carga.error} onReintentar={carga.recargar} /></div>;
  if (!carga.datos?.record) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = carga.datos;
  const empresa = a.company?.find((c) => c.primary) ?? a.company?.[0];
  const etapa = formatValue(meta, 'order', 'hs_pipeline_stage', r.props.hs_pipeline_stage);
  const destino: DestinoOpcion | null = empresa ? {
    tipo: 'empresa', key: `c:${empresa.id}`, nombre: empresa.name, direccion: [empresa.props.address, empresa.props.city].filter(Boolean).join(', ') || null,
    detalle: null, lugar_id: null, company_id: empresa.id, record_id: r.id,
  } : null;
  return (
    <div className="m-pag m-ficha">
      <div className="m-ficha-tit">
        <h1>{r.name}</h1>
        <p className="muted">{[r.props.pdv_finnegans && !r.name.includes(String(r.props.pdv_finnegans)) ? `PDV ${r.props.pdv_finnegans}` : null, empresa?.name].filter(Boolean).join(' · ')}</p>
        <div className="m-pedido-estado">
          {etapa && <EtapaPedido value={r.props.hs_pipeline_stage} label={etapa} />}
          {r.props.fecha_de_entrega && <span className="small muted">Entrega {fmtDate(r.props.fecha_de_entrega)}</span>}
        </div>
      </div>
      <BotonConversacion tipo="order" id={r.id} />
      {destino && puede && (
        <div className="m-rapidas">
          <button type="button" className="btn" onClick={() => navigate('/recorridos/nuevo', { state: { destino } })}><Icon name="route" size={16} />Encargo para este pedido</button>
        </div>
      )}
      <DetallePedido r={r} a={a} empresa={empresa} />
    </div>
  );
}

function DetallePedido({ r, a, empresa }: { r: CrmRecord; a: Assoc; empresa?: CrmRecord }) {
  const { meta } = useMeta();
  const items = useCarga(() => http<{ items: Renglon[] }>('GET', `/records/order/${r.id}/products`).then((x) => x.items), [r.id]);
  const archivos = useCarga(() => http<Archivo[]>('GET', `/records/order/${r.id}/files`), [r.id]);
  const [ver, setVer] = useState<Archivo | null>(null);
  const entrega = ['estado_entrega', 'direccion_entrega', 'falta_entregar', 'entregado_el'].map((n) => propOf(meta, 'order', n)).filter((p): p is Property => !!p && r.props[p.name] != null && r.props[p.name] !== '');
  return (
    <>
      <section className="m-sec" aria-label="Artículos">
        <div className="m-sec-cab"><h2>Artículos</h2><span className="muted small">{items.datos?.length || ''}</span></div>
        {items.error && <Fallo chico error={items.error} onReintentar={items.recargar} />}
        {!items.datos && !items.error && <Cargando chico />}
        {items.datos && !items.datos.length && <div className="m-vacio">Todavía no hay artículos cargados.</div>}
        {items.datos?.map((it, i) => (
          <div key={`${it.code}-${i}`} className="m-item">
            {it.image_url ? <img className="m-art-img" src={it.image_url} alt="" loading="lazy" /> : <span className="m-art-img vacia"><Icon name="bag" size={18} /></span>}
            <div className="m-item-txt"><b className="m-art-nombre">{it.name}</b>
              <small className="muted">{[it.quantity != null ? `${it.quantity} u.` : null, it.code].filter(Boolean).join(' · ')}</small></div>
            {it.status && it.tipo !== 'servicio' && <span className="m-art-estado" style={it.status_color ? { ['--c' as string]: it.status_color } : undefined}>{it.status}</span>}
          </div>
        ))}
      </section>
      {entrega.length > 0 && (
        <section className="m-sec" aria-label="Entrega">
          <div className="m-sec-cab"><h2>Entrega</h2></div>
          <div className="m-datos">{entrega.map((p) => <div key={p.name} className="m-dato m-dato-fijo"><span className="m-dato-et">{p.label}</span><span className="m-dato-val">{formatValue(meta, 'order', p.name, r.props[p.name], r.props)}</span></div>)}</div>
        </section>
      )}
      {empresa && <div className="m-logos"><LogosCard companyId={empresa.id} /></div>}
      {(archivos.datos?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Factura y remitos">
          <div className="m-sec-cab"><h2>Factura y remitos</h2></div>
          {archivos.datos!.map((f) => (
            <button key={f.id} type="button" className="m-item m-item-link m-item-boton" disabled={!f.ready} onClick={() => setVer(f)}>
              <Icon name={f.kind === 'factura' ? 'receipt' : 'truck'} size={18} />
              <span className="m-item-txt"><b>{f.kind === 'factura' ? `Factura ${f.meta.numero ?? ''}` : f.kind === 'remito' ? 'Remito' : f.name}</b>
                <small className="muted">{f.ready ? fmtDate(f.meta.fecha ?? f.meta.date ?? f.created_at) : 'En camino'}</small></span>
            </button>
          ))}
        </section>
      )}
      {(a.contact?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Contactos">
          <div className="m-sec-cab"><h2>Contactos</h2></div>
          {a.contact.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
        </section>
      )}
      {(a.deal?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Negocio">
          <div className="m-sec-cab"><h2>Negocio</h2></div>
          {a.deal.map((d) => <TarjetaNegocio key={d.id} r={d} />)}
        </section>
      )}
      {ver && <VerArchivo url={`/api/files/${ver.id}`} nombre={ver.kind === 'factura' ? `Factura ${ver.meta.numero ?? ''}`.trim() : ver.name} onClose={() => setVer(null)} />}
    </>
  );
}

// Un archivo (factura, remito) abierto dentro de la app: en el iPhone, la app instalada no comparte la sesión con
// Safari, así que abrirlo afuera pedía el login de nuevo. Se baja con la sesión de acá y se muestra; con «Compartir» se
// manda por WhatsApp o se guarda.
export function VerArchivo({ url, nombre, onClose }: { url: string; nombre: string; onClose: () => void }) {
  useCerrarConAtras(onClose);
  const toast = useToast();
  const carga = useCarga(async () => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('No se pudo abrir el archivo.');
    const blob = await res.blob();
    return { blob, src: URL.createObjectURL(blob) };
  }, [url]);
  useEffect(() => () => { if (carga.datos) URL.revokeObjectURL(carga.datos.src); }, [carga.datos]);
  const d = carga.datos;
  const ext = d?.blob.type.includes('pdf') ? 'pdf' : d?.blob.type.split('/')[1] ?? 'pdf';
  const compartir = async () => {
    if (!d) return;
    const archivo = new File([d.blob], `${nombre || 'archivo'}.${ext}`, { type: d.blob.type });
    try {
      if (navigator.canShare?.({ files: [archivo] })) await navigator.share({ files: [archivo], title: nombre });
      else { const a = document.createElement('a'); a.href = d.src; a.download = archivo.name; a.click(); }
    } catch (e) { if ((e as Error).name !== 'AbortError') toast('No se pudo compartir el archivo.', true); }
  };
  return (
    <div className="m-visor" role="dialog" aria-modal="true" aria-label={nombre}>
      <header className="m-asis-cab">
        <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={22} /></button>
        <div className="m-asis-tit"><b>{nombre}</b></div>
        <button type="button" className="btn ghost" onClick={compartir} disabled={!d}><Icon name="upload" size={18} />Compartir</button>
      </header>
      <div className="m-visor-cuerpo">
        {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
        {!d && !carga.error && <Cargando />}
        {d && (d.blob.type.startsWith('image/') ? <img src={d.src} alt={nombre} /> : <iframe src={d.src} title={nombre} />)}
      </div>
    </div>
  );
}
