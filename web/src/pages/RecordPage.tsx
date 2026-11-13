import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  http, qs, useMeta, esVentas, useToast, useAsync, useDebounced, typeFromPath, OBJECTS, propsOf, propOf, formatValue, recordUrl, stageOf, fmtDate, fmtMoney, Icon, ACTIVITY_LABEL, safeUrl, TagChips, type Activity, type CrmRecord, type ObjectType, type Property, missingFor, type Stage, whatsappUrl,
} from '../lib';
import { Avatar, ChatDarwin, CreateRecord, Drawer, EstadoCliente, EtapaPedido, Modal, EstadoClickup, PersonaProd, PropertyInput, QuienProduce, RecordPicker, StageSelect, toLocalInput, UserChip, userOption, ValorEditable, WhatsAppLink, type PersonaProduccion } from '../components';
import { StageProps } from './Board';
import { LogoProducto, LogosCard, useLogos } from './Logos';
import { BocetoChips, BocetosNegocioCard, BocetoVisor, BotonArchivos, SoltarBocetos, useBocetos, useSubirBocetos, type Boceto, type ProductoRef } from './Bocetos';
import { Select } from '../Select';
import { RemitosCard } from './Remitos';
import { ConversacionPanel, useNoLeidosDe } from './Conversacion';

type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;
interface Loaded { record: CrmRecord; associations: Assoc; redirect?: number; produccion?: { asignados: PersonaProduccion[]; listos: number; total: number } }

const RELATED: Record<ObjectType, ObjectType[]> = {
  contact: ['company', 'deal', 'order'],
  company: ['contact', 'deal', 'order', 'company'],
  deal: ['contact', 'company', 'order'],
  order: ['contact', 'deal', 'company'],
};

export default function RecordPage() {
  const { objectPath = 'contacts', id = '0' } = useParams();
  const type = typeFromPath(objectPath);
  const navigate = useNavigate();
  const data = useAsync(() => http<Loaded>('GET', `/records/${type}/${id}`), [type, id]);
  const [tlKey, setTlKey] = useState(0);
  // Perfil Ventas: sin Producción (los remitos de sus pedidos sí, solo para ver y bajar).
  const ventas = esVentas(useMeta().meta.me);
  const [peek, setPeek] = useState<{ type: ObjectType; id: number } | null>(null);
  useEffect(() => { if (data.data?.redirect) navigate(recordUrl(type, data.data.redirect), { replace: true }); }, [data.data, navigate, type]);
  if (data.error) return <div className="content"><div className="empty plain">{data.error} <Link to={`/${objectPath}`}>Volver</Link></div></div>;
  if (!data.data?.record) return <div className="content"><div className="empty plain">Cargando…</div></div>;
  const { record, associations } = data.data;
  const refresh = () => { data.reload(); setTlKey((k) => k + 1); };
  return (
    <div className="content flush record-wrap">
      <div className="record">
        <aside className="left"><LeftPanel type={type} record={record} onChange={refresh} produccion={data.data.produccion} /></aside>
        <section className="center">
          {record.archived && <div className="panel panel-body" style={{ marginBottom: 12, background: 'var(--warn-soft)' }}>Este registro está borrado. <RestoreButton type={type} id={record.id} onDone={refresh} /></div>}
          {type === 'deal' && <StageBar record={record} onChange={refresh} />}
          {type === 'order' || type === 'deal'
            ? <CentroConConversacion type={type} record={record}>
              <Timeline key={tlKey} type={type} record={record} associations={associations} onChange={refresh} />
            </CentroConConversacion>
            : <Timeline key={tlKey} type={type} record={record} associations={associations} onChange={refresh} />}
        </section>
        <aside className="right">
          {type === 'company' && <ComprasCard record={record} />}
          {type === 'company' && <LogosCard companyId={record.id} />}
          {!ventas && type === 'company' && record.props.tipo_de_relacion === 'proveedor' && <ProduccionProveedorCard companyId={record.id} />}
          {type === 'deal' && <FacturarCard record={record} />}
          {type === 'deal' && <BocetosNegocioCard dealId={record.id} />}
          {type === 'order' && <ProductsCard recordId={record.id} max={5} />}
          {type === 'order' && <RemitosCard record={record} onChange={refresh} />}
          {type === 'order' && <FilesCard recordId={record.id} />}
          {RELATED[type].map((t) => <AssocCard key={t} type={type} record={record} toType={t} items={associations?.[t] ?? []} onChange={refresh} onPeek={(pt, pid) => setPeek({ type: pt, id: pid })} />)}
        </aside>
        {peek && <RecordPreview type={peek.type} id={peek.id} onClose={() => setPeek(null)} onChange={refresh} />}
      </div>
    </div>
  );
}

// En pedidos y negocios, el centro de la ficha tiene dos pestañas: la conversación del equipo (con la actividad
// entremezclada, como en ClickUp) y la actividad de siempre (como en HubSpot). Cada uno queda en la que eligió; el link del
// mail de una mención (?conversacion=1) abre la conversación.
function CentroConConversacion({ type, record, children }: { type: ObjectType; record: CrmRecord; children: ReactNode }) {
  const clave = `crm:centro-${type}`;
  const [tab, setTabState] = useState<'conversacion' | 'actividad'>(() => {
    if (new URLSearchParams(window.location.search).has('conversacion')) return 'conversacion';
    try { const v = localStorage.getItem(clave); if (v === 'conversacion' || v === 'actividad') return v; } catch { /* sin memoria */ }
    return type === 'order' ? 'conversacion' : 'actividad';
  });
  const setTab = (t: 'conversacion' | 'actividad') => { setTabState(t); try { localStorage.setItem(clave, t); } catch { /* sin memoria */ } };
  // Desde una notificación o un mail (?conversacion=1&mensaje=…): la conversación, en ese mensaje (también si ya estaba en la ficha).
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const mensaje = Number(params.get('mensaje')) || undefined;
  useEffect(() => { if (params.has('conversacion')) setTabState('conversacion'); }, [loc.search]); // eslint-disable-line react-hooks/exhaustive-deps
  const sinLeer = useNoLeidosDe(record.id);
  return (
    <>
      <div className="tabs centro-tabs">
        <button className={`tab ${tab === 'conversacion' ? 'on' : ''}`} onClick={() => setTab('conversacion')}><Icon name="chat" size={14} />Conversación
          {sinLeer ? <span className={`count nuevo${sinLeer.menciones ? ' mencion' : ''}`}>{sinLeer.no_leidos}</span> : null}</button>
        <button className={`tab ${tab === 'actividad' ? 'on' : ''}`} onClick={() => setTab('actividad')}><Icon name="history" size={14} />Actividad</button>
      </div>
      {tab === 'conversacion' ? <ConversacionPanel type={type} recordId={record.id} className="en-ficha" mensaje={mensaje} /> : children}
    </>
  );
}

function RestoreButton({ type, id, onDone }: { type: ObjectType; id: number; onDone: () => void }) {
  const toast = useToast();
  return <button className="btn sm" onClick={async () => { await http('POST', `/records/${type}/${id}/restore`); toast('Restaurado'); onDone(); }}>Restaurar</button>;
}

// ---------- Columna izquierda: cabecera y propiedades ----------

const KEY_PROPS: Record<ObjectType, string[]> = {
  contact: ['email', 'phone', 'mobilephone', 'jobtitle', 'owner_id', 'lifecyclestage', 'hs_lead_status', 'origen_del_contacto', 'tipo_de_origen'],
  company: ['domain', 'phone', 'owner_id', 'industry', 'city', 'lifecyclestage', 'tipo_de_empresa_cotizacion', 'objetivo_economico_anual', 'cuit'],
  deal: ['amount', 'closedate', 'pipeline', 'dealstage', 'owner_id', 'producto', 'cantidad', 'tipo_de_producto', 'origen_del_negocio', 'hs_next_step'],
  order: ['pdv_finnegans', 'hs_pipeline_stage', 'hs_total_price', 'owner_id', 'hs_billing_address_email', 'hs_billing_address_phone'],
};

// «Acerca de» de cada objeto: lo elegido en «Elegir datos» o, si nadie eligió, lo de siempre.
function keyPropsFor(meta: ReturnType<typeof useMeta>['meta'], type: ObjectType) {
  const chosen = meta.key_props?.[type];
  return chosen?.length ? chosen : KEY_PROPS[type];
}

function KeyPropsModal({ type, onClose }: { type: ObjectType; onClose: () => void }) {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const [sel, setSel] = useState<string[]>(keyPropsFor(meta, type));
  const [f, setF] = useState('');
  const all = propsOf(meta, type);
  const move = (i: number, d: number) => { const n = [...sel]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSel(n); };
  return (
    <Modal title={`«Acerca de» de ${OBJECTS[type].plural.toLowerCase()}`} onClose={onClose} footer={<>
      <button className="btn" onClick={() => setSel(KEY_PROPS[type])}>Restablecer</button>
      <button className="btn primary" onClick={async () => {
        try { await http('PUT', `/key-props/${type}`, { props: sel }); toast('Listo: se ve así para todos'); reload(); onClose(); } catch (e) { toast((e as Error).message, true); }
      }}>Guardar</button>
    </>}>
      <p className="muted small" style={{ margin: 0 }}>Lo que se ve arriba de la ficha y en la vista previa, para todo el equipo.</p>
      <div className="grid-2">
        <div className="stack">
          <input className="input" placeholder="Buscar propiedad…" value={f} onChange={(e) => setF(e.target.value)} />
          <div className="stack" style={{ maxHeight: 320, overflow: 'auto', gap: 0 }}>
            {all.filter((p) => p.label.toLowerCase().includes(f.toLowerCase())).map((p) => (
              <label key={p.name} className="row small" style={{ padding: '3px 0' }}>
                <input type="checkbox" checked={sel.includes(p.name)} onChange={(e) => setSel(e.target.checked ? [...sel, p.name] : sel.filter((x) => x !== p.name))} />{p.label}
              </label>
            ))}
          </div>
        </div>
        <div className="stack">
          <b className="small">En este orden ({sel.length})</b>
          {sel.map((n, i) => (
            <div key={n} className="row small">
              <span className="grow ellipsis">{propOf(meta, type, n)?.label ?? n}</span>
              <button className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">↑</button>
              <button className="btn ghost sm" disabled={i === sel.length - 1} onClick={() => move(i, 1)} aria-label="Bajar">↓</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function subtitle(meta: ReturnType<typeof useMeta>['meta'], type: ObjectType, r: CrmRecord) {
  if (type === 'contact') return [r.props.jobtitle, r.props.company].filter(Boolean).join(' · ') || r.props.email;
  if (type === 'company') return r.props.domain;
  if (type === 'deal') return [fmtMoney(r.props.amount, r.props.deal_currency_code), stageOf(meta, r.props.dealstage)?.stage.label].filter(Boolean).join(' · ');
  return r.props.pdv_finnegans ? `PDV ${r.props.pdv_finnegans}` : '';
}

function LeftPanel({ type, record, onChange, produccion }: { type: ObjectType; record: CrmRecord; onChange: () => void; produccion?: Loaded['produccion'] }) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const props = propsOf(meta, type);
  const [hist, setHist] = useState<string | null>(null);
  const [merge, setMerge] = useState(false);
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, Property[]>();
    for (const p of props) {
      if (filter && !p.label.toLowerCase().includes(filter.toLowerCase())) continue;
      m.set(p.group_name, [...(m.get(p.group_name) ?? []), p]);
    }
    return [...m.entries()];
  }, [props, filter]);
  const save = async (name: string, value: unknown) => {
    try {
      await http('PATCH', `/records/${type}/${record.id}`, { props: { [name]: value } });
      toast('Guardado');
      onChange();
    } catch (e) { toast((e as Error).message, true); throw e; }
  };
  const quick = (t: Activity['type']) => window.dispatchEvent(new CustomEvent('crm:compose', { detail: t }));
  const pipeKeys = type === 'deal' ? meta.pipelines.find((p) => p.id === record.props.pipeline)?.config.key_props : undefined;
  // El «Link a Darwin» no se repite como texto: está el botón «Chat en Darwin» (sigue en la lista completa, por si hay que corregirlo).
  const keyProps = ((pipeKeys?.length ? pipeKeys : keyPropsFor(meta, type)).map((n) => propOf(meta, type, n)).filter(Boolean) as Property[])
    .filter((p) => !(type === 'deal' && p.name === 'link_a_darwin'));
  const [cfgKeys, setCfgKeys] = useState(false);
  return (
    <>
      <div className="rec-head">
        <div className="crumb"><Link to={`/${OBJECTS[type].path}`}>← {OBJECTS[type].plural}</Link></div>
        <div className="title"><Avatar name={record.name} type={type} size="lg" domain={record.props.domain} email={record.props.email} />
          <div className="grow"><h1>{record.name}</h1>
            {type === 'deal'
              ? <div className="muted small rec-valor"><ValorEditable record={record} onSaved={onChange} />{stageOf(meta, record.props.dealstage) ? ` · ${stageOf(meta, record.props.dealstage)!.stage.label}` : ''}</div>
              : <div className="muted small">{subtitle(meta, type, record)}</div>}
            {/* Pedidos: la etapa y quién lo tiene en producción, igual que en la vista previa y en la tarjeta del tablero. */}
            {type === 'order' && (record.props.hs_pipeline_stage || produccion) && (
              <div className="rec-prod">
                {record.props.hs_pipeline_stage && <EtapaPedido value={record.props.hs_pipeline_stage} label={formatValue(meta, 'order', 'hs_pipeline_stage', record.props.hs_pipeline_stage)} />}
                {produccion && <QuienProduce {...produccion} />}
              </div>
            )}
            <TagChips meta={meta} ids={record.tags} /></div></div>
        <div className="rec-actions">
          {(['note', 'email', 'call', 'task', 'meeting', 'whatsapp'] as const).map((t) => (
            <button key={t} className="act-btn" onClick={() => quick(t)}><span className="ic"><Icon name={t} /></span>{ACTIVITY_LABEL[t]}</button>
          ))}
        </div>
        <div className="row wrap">
          {type === 'contact' && whatsappUrl(record.props.mobilephone || record.props.phone) && <a className="btn sm wa-link" href={whatsappUrl(record.props.mobilephone || record.props.phone)} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14} />Abrir WhatsApp</a>}
          {type === 'contact' && record.props.email && <a className="btn sm" href={`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(record.props.email)}`} target="_blank" rel="noreferrer">Escribir mail</a>}
          {type === 'deal' && <ChatDarwin url={record.props.link_a_darwin} />}
          {type === 'order' && safeUrl(record.props.url_clickup) && <a className="btn sm" href={safeUrl(record.props.url_clickup)} target="_blank" rel="noreferrer">PDV en ClickUp</a>}
          {type !== 'order' && (
            <a className="btn sm" title="Abre Claude con el pedido listo: usa el conector Formas Hub para juntar compras, deuda, pedidos y mails, y arma el resumen y un mail de seguimiento"
              href={`https://claude.ai/new?q=${encodeURIComponent(`Prepará mi reunión con ${record.name} (${OBJECTS[type].single.toLowerCase()} ${record.id} de Formas Hub). Usá la herramienta preparar_reunion del conector Formas Hub y armame: un resumen corto de la relación, qué compró y cuándo, los temas abiertos, los riesgos (deuda vencida, si está en riesgo o perdido, pedidos atrasados), los próximos pasos y un borrador de mail de seguimiento en castellano rioplatense.`)}`}
              target="_blank" rel="noreferrer">Preparar reunión con Claude</a>
          )}
          <button className="btn sm ghost" onClick={() => setMerge(true)}><Icon name="merge" size={14} />Combinar</button>
          {type === 'deal' && meta.me.role !== 'viewer' && (
            <button className="btn sm ghost" title="Crea una copia con los mismos datos y asociaciones, en la primera etapa" onClick={async () => {
              try { const r = await http<CrmRecord>('POST', `/records/deal/${record.id}/clone`); toast('Negocio clonado'); navigate(recordUrl('deal', r.id)); }
              catch (e) { toast((e as Error).message, true); }
            }}>Clonar</button>
          )}
          {['admin', 'manager'].includes(meta.me.role) && !record.archived && (
            <button className="btn sm ghost danger" onClick={async () => {
              if (!confirm(`¿Borrar «${record.name}»? Se puede restaurar.`)) return;
              await http('DELETE', `/records/${type}/${record.id}`); toast('Borrado'); navigate(`/${OBJECTS[type].path}`);
            }}><Icon name="trash" size={14} />Borrar</button>
          )}
        </div>
      </div>
      <details className="prop-group" open>
        <summary>Acerca de {type === 'deal' ? 'este negocio' : type === 'company' ? 'esta empresa' : type === 'order' ? 'este pedido' : 'este contacto'}
          {meta.me.role === 'admin' && type !== 'deal' && <button className="btn ghost sm" style={{ marginLeft: 'auto' }} title="Elegir qué datos se ven acá y en la vista previa" onClick={(e) => { e.preventDefault(); setCfgKeys(true); }}>Elegir datos</button>}
        </summary>
        <div className="prop-list">{keyProps.map((p) => <PropRow key={p.name} type={type} prop={p} record={record} onSave={save} onHistory={setHist} />)}</div>
      </details>
      <div style={{ padding: '10px 16px 4px' }}><input className="input" placeholder="Buscar propiedad…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      {groups.map(([g, list]) => (
        <details key={g} className="prop-group" open={!!filter}>
          <summary>{g} <span className="muted small">({list.length})</span></summary>
          <div className="prop-list">{list.map((p) => <PropRow key={p.name} type={type} prop={p} record={record} onSave={save} onHistory={setHist} />)}</div>
        </details>
      ))}
      {hist && <HistoryModal type={type} id={record.id} prop={hist} onClose={() => setHist(null)} />}
      {merge && <MergeModal type={type} record={record} onClose={() => setMerge(false)} onDone={() => { setMerge(false); onChange(); }} />}
      {cfgKeys && <KeyPropsModal type={type} onClose={() => setCfgKeys(false)} />}
    </>
  );
}

function PropRow({ type, prop, record, onSave, onHistory }: { type: ObjectType; prop: Property; record: CrmRecord; onSave: (n: string, v: unknown) => Promise<void>; onHistory: (n: string) => void }) {
  const { meta } = useMeta();
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState<unknown>(record.props[prop.name]);
  const shown = formatValue(meta, type, prop.name, record.props[prop.name], record.props);
  const ro = !!prop.read_only || prop.name === 'dealstage' || prop.name === 'pipeline';
  if (edit) {
    return (
      <div className="prop prop-edit">
        <div className="k">{prop.label}</div>
        <PropertyInput prop={prop} type={type} value={val} onChange={setVal} autoFocus />
        <div className="row">
          <button className="btn sm primary" onClick={async () => { try { await onSave(prop.name, val); setEdit(false); } catch { /* el aviso ya se mostró */ } }}>Guardar</button>
          <button className="btn sm" onClick={() => { setVal(record.props[prop.name]); setEdit(false); }}>Cancelar</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`prop${ro ? ' ro' : ''}`} onClick={() => !ro && (setVal(record.props[prop.name]), setEdit(true))} title={prop.description || undefined}>
      <div className="k">{prop.label}<button className="hist btn ghost sm" style={{ height: 18, padding: '0 4px' }} onClick={(e) => { e.stopPropagation(); onHistory(prop.name); }}>Historial</button></div>
      <div className={`v${shown ? '' : ' blank'}`}>
        {shown && prop.type === 'url' && safeUrl(record.props[prop.name]) ? <a href={safeUrl(record.props[prop.name])} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{shown}</a>
          : shown && prop.type === 'email' ? <a href={`mailto:${shown}`} onClick={(e) => e.stopPropagation()}>{shown}</a>
          : shown && prop.type === 'phone' ? <WhatsAppLink phone={record.props[prop.name]}>{shown}</WhatsAppLink>
            : shown && type === 'order' && prop.name === 'hs_pipeline_stage' ? <EtapaPedido value={record.props[prop.name]} label={shown} />
              : shown && prop.type === 'owner' ? <UserChip id={record.props[prop.name]} />
                : shown || '—'}
      </div>
    </div>
  );
}

function HistoryModal({ type, id, prop, onClose }: { type: ObjectType; id: number; prop: string; onClose: () => void }) {
  const { meta } = useMeta();
  const h = useAsync(() => http<Array<{ old_value: string; new_value: string; changed_at: string; user_id: number | null; user_name: string; source: string }>>('GET', `/records/${type}/${id}/history${qs({ prop })}`), [id, prop]);
  return (
    <Modal title={`Historial: ${propOf(meta, type, prop)?.label ?? prop}`} onClose={onClose}>
      {h.data?.length ? h.data.map((c, i) => (
        <div key={i} className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
          <div className="grow"><b>{formatValue(meta, type, prop, c.new_value) || '(vacío)'}</b>
            <div className="small muted">antes: {formatValue(meta, type, prop, c.old_value) || '(vacío)'}</div></div>
          <div className="small muted" style={{ textAlign: 'right' }}>{fmtDate(c.changed_at, true)}<br /><UserChip id={c.user_id} name={c.user_name} empty="—" size="xs" /> · {c.source}</div>
        </div>
      )) : <div className="muted">Sin cambios registrados.</div>}
    </Modal>
  );
}

function MergeModal({ type, record, onClose, onDone }: { type: ObjectType; record: CrmRecord; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [other, setOther] = useState<CrmRecord | null>(null);
  return (
    <Modal title={`Combinar «${record.name}» con otro registro`} onClose={onClose} footer={other ? <>
      <button className="btn" onClick={() => setOther(null)}>Elegir otro</button>
      <button className="btn primary" onClick={async () => {
        try { await http('POST', `/records/${type}/${record.id}/merge`, { other_id: other.id }); toast('Registros combinados'); onDone(); }
        catch (e) { toast((e as Error).message, true); }
      }}>Combinar</button>
    </> : undefined}>
      {other ? (
        <p style={{ margin: 0 }}>Se queda <b>{record.name}</b> (este registro). <b>{other.name}</b> se archiva y sus contactos, negocios, actividades y datos que acá estén vacíos pasan a este.</p>
      ) : <RecordPicker type={type} exclude={[record.id]} onPick={setOther} placeholder="Buscar el duplicado…" />}
    </Modal>
  );
}

// ---------- Barra de etapas del negocio ----------

function StageBar({ record, onChange }: { record: CrmRecord; onChange: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const pipe = meta.pipelines.find((p) => p.id === record.props.pipeline);
  const [ask, setAsk] = useState<{ stage: Stage; missing: string[] } | null>(null);
  if (!pipe) return null;
  const curIdx = pipe.stages.findIndex((s) => s.id === record.props.dealstage);
  const cur = pipe.stages[curIdx];
  const go = async (stage: Stage, extra: Record<string, unknown> = {}) => {
    const missing = missingFor(stage, { ...record.props, ...extra });
    if (missing.length) { setAsk({ stage, missing }); return; }
    try { await http('PATCH', `/records/deal/${record.id}`, { props: { dealstage: stage.id, ...extra } }); toast('Etapa actualizada'); onChange(); }
    catch (e) {
      const m = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      if (m?.length) setAsk({ stage, missing: m }); else toast((e as Error).message, true);
    }
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="small muted">Pipeline</span>
        <Select className="input sm" style={{ width: 240 }} value={pipe.id} onChange={async (e) => {
          try { await http('PATCH', `/records/deal/${record.id}`, { props: { pipeline: e.target.value } }); onChange(); } catch (er) { toast((er as Error).message, true); }
        }}>{meta.pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
        <span className="grow" />
        {record.props.hs_v2_date_entered_current_stage && <span className="small muted">En esta etapa desde {fmtDate(record.props.hs_v2_date_entered_current_stage)}</span>}
      </div>
      <div className="stagebar">
        {pipe.stages.map((s, i) => {
          const cls = s.id === cur?.id ? (s.is_closed ? (s.is_won ? 'won' : 'lost') : 'cur') : !s.is_closed && i < curIdx && !cur?.is_closed ? 'done' : '';
          return <button key={s.id} className={cls} title={`${s.label} · ${Math.round(s.probability * 100)}%`}
            onClick={() => s.id !== cur?.id && go(s)}>{s.label}</button>;
        })}
      </div>
      {ask && <StageProps deal={record} stage={ask.stage} missing={ask.missing} onClose={() => setAsk(null)} onSave={(extra) => { const a = ask; setAsk(null); go(a.stage, extra); }} />}
    </>
  );
}

// ---------- Línea de tiempo y registro de actividades ----------

const FILTERS: Array<[string, string]> = [['', 'Actividad'], ['note', 'Notas'], ['email', 'Emails'], ['call', 'Llamadas'], ['task', 'Tareas'], ['meeting', 'Reuniones'], ['whatsapp', 'WhatsApp']];
// De dónde vino un cambio, como se lee en el historial.
const SOURCE_LABEL: Record<string, string> = { clickup: 'ClickUp', finnegans: 'Finnegans', mcp: 'Claude', hubspot: 'HubSpot', api: 'API' };
const CHANGE_LABEL: Record<string, string> = { dealstage: 'Etapa', pipeline: 'Pipeline', owner_id: 'Propietario', lifecyclestage: 'Ciclo de vida', amount: 'Monto', archived: 'Borrado', merged: 'Combinado con', hs_pipeline_stage: 'Estado del pedido', factura_numero: 'Factura' };

function Timeline({ type, record, associations, onChange }: { type: ObjectType; record: CrmRecord; associations: Assoc; onChange: () => void }) {
  const { meta } = useMeta();
  const [filter, setFilter] = useState('');
  const [rollup, setRollup] = useState(true);
  const [compose, setCompose] = useState<Activity['type'] | null>(null);
  const [limit, setLimit] = useState(50);
  // Buscar en la actividad y filtrar por responsable (con 3.000 a 5.000 mails por mes, la de una empresa se hace larga).
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search, 300);
  const [owner, setOwner] = useState('');
  const tl = useAsync(() => http<{ activities: Activity[]; changes: Array<{ prop: string; old_value: string; new_value: string; changed_at: string; user_id: number | null; user_name: string; source: string }>; counts: Record<string, number> }>(
    'GET', `/records/${type}/${record.id}/timeline${qs({ types: filter || undefined, rollup: rollup ? undefined : 0, limit, q: dsearch || undefined, owner: owner || undefined })}`), [record.id, filter, rollup, limit, dsearch, owner]);
  useEffect(() => {
    const h = (e: Event) => setCompose((e as CustomEvent).detail);
    window.addEventListener('crm:compose', h);
    return () => window.removeEventListener('crm:compose', h);
  }, []);
  const items = useMemo(() => {
    const acts = (tl.data?.activities ?? []).map((a) => ({ kind: 'a' as const, at: a.meta?.pinned ? 'ZZZZ' : a.type === 'task' && a.status !== 'COMPLETED' ? '9999' : (a.type === 'task' ? a.completed_at ?? a.due_at ?? a.occurred_at : a.occurred_at), a }));
    const chs = filter || dsearch || owner ? [] : (tl.data?.changes ?? []).map((c) => ({ kind: 'c' as const, at: c.changed_at, c }));
    return [...acts, ...chs].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  }, [tl.data, filter, dsearch, owner]);
  const reload = () => { tl.reload(); onChange(); };
  let lastDay = '';
  return (
    <>
      <div className="tabs">
        {FILTERS.map(([k, l]) => (
          <button key={k} className={`tab ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}{k && tl.data?.counts[k] ? <span className="count">{tl.data.counts[k]}</span> : null}</button>
        ))}
      </div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <div className="search grow" style={{ minWidth: 180 }}><Icon name="search" /><input className="input sm" placeholder="Buscar en la actividad…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <Select className="input sm" style={{ width: 200 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsable">
          <option value="">Todos los responsables</option>
          {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
        </Select>
      </div>
      {type !== 'contact' && (
        <label className="row small muted" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={rollup} onChange={(e) => setRollup(e.target.checked)} />
          Incluir la actividad de {type === 'company' ? 'sus contactos y negocios' : 'sus contactos'}
        </label>
      )}
      {compose && <Composer type={compose} record={record} associations={associations} onClose={() => setCompose(null)} onSaved={() => { setCompose(null); reload(); }} />}
      {!compose && (
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {(['note', 'email', 'call', 'task', 'meeting', 'whatsapp'] as const).map((t) => <button key={t} className="btn sm" onClick={() => setCompose(t)}><Icon name={t} size={14} />{ACTIVITY_LABEL[t]}</button>)}
        </div>
      )}
      {tl.loading && !tl.data && <div className="muted">Cargando actividad…</div>}
      {!tl.loading && !items.length && <div className="empty panel">{dsearch || owner ? 'Nada coincide con la búsqueda.' : 'Todavía no hay actividad registrada.'}</div>}
      {items.map((it) => {
        const day = it.at === 'ZZZZ' ? 'Fijadas' : it.at === '9999' ? 'Pendientes' : new Date(it.at).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const head = day !== lastDay ? <div className="tl-day">{day}</div> : null;
        lastDay = day;
        if (it.kind === 'c') {
          const c = it.c;
          const val = (v: string) => (c.prop === 'merged' ? v : formatValue(meta, type, c.prop, v) || '—');
          // La hora a la izquierda, en su columna, y a la derecha qué cambió y quién (lo que viene de ClickUp, a nombre de
          // quien tiene asignado el PDV).
          return (
            <div key={`c${c.changed_at}${c.prop}`}>{head}
              <div className="tl-change">
                <time className="tl-hora" dateTime={c.changed_at}>{new Date(c.changed_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                <span>{CHANGE_LABEL[c.prop] ?? c.prop}: {c.old_value != null && c.prop !== 'merged' ? `${val(c.old_value)} → ` : ''}<b>{c.prop === 'merged' ? c.new_value : val(c.new_value)}</b>
                  {' · '}<UserChip id={c.user_id} name={c.user_name} empty="sistema" size="xs" />{c.source !== 'crm' ? ` (${SOURCE_LABEL[c.source] ?? c.source})` : ''}</span>
              </div>
            </div>
          );
        }
        return <div key={`a${it.a.id}`}>{head}<ActivityItem a={it.a} currentId={record.id} onChange={reload} /></div>;
      })}
      {(tl.data?.activities.length ?? 0) >= limit && <button className="btn" onClick={() => setLimit(limit + 50)}>Ver más</button>}
    </>
  );
}

function ActivityItem({ a, currentId, onChange }: { a: Activity; currentId: number; onChange: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const done = a.status === 'COMPLETED';
  const overdue = a.type === 'task' && !done && a.due_at && Date.parse(a.due_at) < Date.now();
  const title = a.type === 'task' ? a.subject
    : a.type === 'email' ? `${a.direction === 'in' ? 'Email recibido' : 'Email enviado'}${a.subject ? `: ${a.subject}` : ''}`
      : a.type === 'call' ? `Llamada${a.outcome ? ` · ${a.outcome}` : ''}`
        : a.type === 'meeting' ? `Reunión${a.subject ? `: ${a.subject}` : ''}`
          : a.type === 'whatsapp' ? `WhatsApp ${a.direction === 'in' ? 'recibido' : 'enviado'}`
            : `Nota`;
  const toggle = async () => {
    try { await http('PATCH', `/activities/${a.id}`, { status: done ? 'NOT_STARTED' : 'COMPLETED' }); onChange(); } catch (e) { toast((e as Error).message, true); }
  };
  // Fijar una actividad arriba de todo (como «Actividad anclada» de HubSpot).
  const pin = async () => {
    try { await http('PATCH', `/activities/${a.id}`, { meta: { pinned: !a.meta?.pinned } }); toast(a.meta?.pinned ? 'Desfijada' : 'Fijada arriba'); onChange(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className={`tl-item ${a.type}${done ? ' done' : ''}`}>
      <div className="h">
        {a.type === 'task'
          ? <button className={`check-round${done ? ' on' : ''}`} onClick={toggle} aria-label={done ? 'Marcar pendiente' : 'Completar'}>{done && <Icon name="check" />}</button>
          : <span className="ic"><Icon name={a.type} /></span>}
        <span className="subj grow ellipsis"><b>{title}</b> <span className="muted">· <UserChip id={a.owner_id} size="xs" />{a.source !== 'crm' ? ` · ${a.source}` : ''}</span></span>
        <span className={`when${overdue ? ' overdue' : ''}`}>{a.type === 'task' ? `Vence ${fmtDate(a.due_at, true)}` : fmtDate(a.occurred_at, true)}</span>
        <button className="btn ghost sm" onClick={pin} title={a.meta?.pinned ? 'Desfijar' : 'Fijar arriba de todo'}>{a.meta?.pinned ? 'Desfijar' : 'Fijar'}</button>
        <button className="btn ghost sm" onClick={() => setEdit(true)}>Editar</button>
      </div>
      {a.type === 'email' && (a.meta.from || a.meta.to) && <div className="small muted" style={{ marginTop: 4 }}>De {a.meta.from} · Para {a.meta.to}{a.meta.cc ? ` · CC ${a.meta.cc}` : ''}</div>}
      {a.body && <div className={`b${open ? ' open' : ''}`} onClick={() => setOpen(true)}>{a.body}</div>}
      {a.links.filter((l) => l.id !== currentId).length > 0 && (
        <div className="links">{a.links.filter((l) => l.id !== currentId).map((l) => <Link key={l.id} className="chip" to={recordUrl(l.type, l.id)}>{l.name}</Link>)}</div>
      )}
      {edit && <EditActivity a={a} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChange(); }} />}
    </div>
  );
}

export function EditActivity({ a, onClose, onSaved }: { a: Activity; onClose: () => void; onSaved: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [f, setF] = useState({ subject: a.subject, body: a.body, due_at: a.due_at, occurred_at: a.occurred_at, owner_id: a.owner_id, priority: a.priority, outcome: a.outcome });
  return (
    <Modal title={`Editar ${ACTIVITY_LABEL[a.type].toLowerCase()}`} onClose={onClose} footer={<>
      <button className="btn danger" onClick={async () => { if (!confirm('¿Borrar esta actividad?')) return; await http('DELETE', `/activities/${a.id}`); toast('Borrada'); onSaved(); }}>Borrar</button>
      <span className="grow" />
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" onClick={async () => { try { await http('PATCH', `/activities/${a.id}`, f); toast('Guardado'); onSaved(); } catch (e) { toast((e as Error).message, true); } }}>Guardar</button>
    </>}>
      {a.type !== 'note' && a.type !== 'whatsapp' && <label className="field">Título<input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>}
      {a.type === 'task'
        ? <label className="field">Vence<input className="input" type="datetime-local" value={f.due_at ? toLocalInput(f.due_at) : ''} onChange={(e) => setF({ ...f, due_at: new Date(e.target.value).toISOString() })} /></label>
        : <label className="field">Fecha<input className="input" type="datetime-local" value={toLocalInput(f.occurred_at)} onChange={(e) => setF({ ...f, occurred_at: new Date(e.target.value).toISOString() })} /></label>}
      <label className="field">Responsable<Select className="input" value={f.owner_id ?? ''} onChange={(e) => setF({ ...f, owner_id: Number(e.target.value) })}>
        {meta.users.filter((u) => u.active || u.id === f.owner_id).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}</Select></label>
      {a.type === 'task' && <label className="field">Prioridad<Select className="input" value={f.priority ?? 'none'} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></Select></label>}
      <label className="field">Detalle<textarea className="input" rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
    </Modal>
  );
}

const OUTCOMES = ['Conectada', 'Ocupado', 'No atendió', 'Dejó mensaje', 'Número equivocado'];

function Composer({ type, record, associations, onClose, onSaved }: {
  type: Activity['type']; record: CrmRecord; associations: Assoc; onClose: () => void; onSaved: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000); tomorrow.setHours(10, 0, 0, 0);
  const [f, setF] = useState<Record<string, any>>({
    subject: '', body: '', direction: type === 'email' || type === 'whatsapp' ? 'out' : undefined, outcome: type === 'call' ? 'Conectada' : undefined,
    occurred_at: now.toISOString(), due_at: tomorrow.toISOString(), owner_id: meta.me.id, priority: 'none', task_type: 'todo',
  });
  // Registros asociados que también reciben la actividad (como en HubSpot al registrar).
  const related = [...(associations?.company ?? []), ...(associations?.deal ?? []), ...(associations?.contact ?? [])];
  const openDeals = (associations?.deal ?? []).filter((d) => !stageOf(meta, d.props.dealstage)?.stage.is_closed);
  const [links, setLinks] = useState<Set<number>>(() => new Set([
    ...(associations?.company ?? []).filter((c) => c.primary).map((c) => c.id),
    ...(openDeals.length === 1 ? [openDeals[0].id] : []),
  ]));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (type === 'task' && !f.subject.trim()) { toast('La tarea necesita un título', true); return; }
    if (type !== 'task' && !f.body.trim() && !f.subject.trim()) { toast('Escribí algo para registrar', true); return; }
    setBusy(true);
    try {
      await http('POST', '/activities', { ...f, type, links: [record.id, ...links], meta: f.meta });
      toast(`${ACTIVITY_LABEL[type]} registrada`);
      onSaved();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="panel composer">
      <div className="panel-head"><h3>{type === 'task' ? 'Crear tarea' : `Registrar ${ACTIVITY_LABEL[type].toLowerCase()}`}</h3><button className="btn ghost sm" onClick={onClose}>Cancelar</button></div>
      <div className="panel-body">
        {(type === 'task' || type === 'email' || type === 'meeting') && (
          <input className="input" autoFocus placeholder={type === 'task' ? 'Título de la tarea' : type === 'email' ? 'Asunto' : 'Título de la reunión'} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        )}
        <div className="row wrap">
          {(type === 'email' || type === 'whatsapp' || type === 'call') && (
            <Select className="input" style={{ width: 150 }} value={f.direction ?? 'out'} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option value="out">{type === 'call' ? 'Saliente' : 'Enviado'}</option><option value="in">{type === 'call' ? 'Entrante' : 'Recibido'}</option>
            </Select>
          )}
          {type === 'call' && <Select className="input" style={{ width: 170 }} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</Select>}
          {type === 'task' ? <>
            <label className="row small">Vence<input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(f.due_at)} onChange={(e) => setF({ ...f, due_at: new Date(e.target.value).toISOString() })} /></label>
            <Select className="input" style={{ width: 140 }} value={f.task_type} onChange={(e) => setF({ ...f, task_type: e.target.value })}>
              <option value="todo">Por hacer</option><option value="call">Llamar</option><option value="email">Mail</option><option value="whatsapp">WhatsApp</option><option value="meeting">Reunión</option>
            </Select>
            <Select className="input" style={{ width: 150 }} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
            </Select>
          </> : (
            <label className="row small">{type === 'meeting' ? 'Empieza' : 'Fecha'}<input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(f.occurred_at)} onChange={(e) => setF({ ...f, occurred_at: new Date(e.target.value).toISOString() })} /></label>
          )}
          <Select className="input" style={{ width: 190 }} value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: Number(e.target.value) })} aria-label="Responsable">
            {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
          </Select>
        </div>
        {type === 'meeting' && <input className="input" placeholder="Lugar o link" value={f.meta?.location ?? ''} onChange={(e) => setF({ ...f, meta: { ...f.meta, location: e.target.value } })} />}
        <textarea className="input" autoFocus={type === 'note' || type === 'call' || type === 'whatsapp'} rows={5} placeholder={type === 'task' ? 'Detalle (opcional)' : 'Qué pasó…'} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        {related.length > 0 && (
          <div className="row wrap small">
            <span className="muted">También asociar a:</span>
            {related.map((r) => (
              <label key={r.id} className={`chip${links.has(r.id) ? ' on' : ''}`}>
                <input type="checkbox" style={{ display: 'none' }} checked={links.has(r.id)} onChange={() => { const s = new Set(links); s.has(r.id) ? s.delete(r.id) : s.add(r.id); setLinks(s); }} />
                {r.name}
              </label>
            ))}
          </div>
        )}
        <div className="row"><span className="grow" /><button className="btn primary" disabled={busy} onClick={save}>{type === 'task' ? 'Crear tarea' : 'Registrar'}</button></div>
      </div>
    </div>
  );
}

// ---------- Columna derecha: asociaciones ----------

// Factura (de Finnegans, cuando tiene CAE) y remito (la foto que suben a ClickUp al entregar), adjuntados solos.
interface ProductRow { code: string | null; name: string; description: string | null; image_url: string | null; quantity: number | null; unit_price: number | null; discount: number; currency: string; subtotal: number | null; status?: string | null; status_color?: string | null; asignados?: PersonaProduccion[] }
interface OrderProducts { pedido: string | null; configured: boolean; clickup?: boolean; source?: 'finnegans' | 'clickup' | null; error: string | null; items: ProductRow[]; total: number; currency: string; tax_included: boolean; cotizacion_fotos?: string[];
  produccion?: { asignados: PersonaProduccion[]; listos: number; total: number } | null }
// Productos del pedido, de Finnegans: foto, nombre, descripción, cantidad y precio. Si Finnegans no tiene los renglones,
// los artículos del PDV de ClickUp (producto, cantidad, código y estado de producción, sin precio).
// En la vista previa se ven los primeros 3 productos y en la ficha los primeros 5; «Ver más» despliega el resto.
// El total es siempre el de todos.
function ProductsCard({ recordId, max }: { recordId: number; max: number }) {
  const res = useAsync(() => http<OrderProducts>('GET', `/records/order/${recordId}/products`), [recordId]);
  const [all, setAll] = useState(false);
  const d = res.data;
  const items = d?.items ?? [];
  const shown = all ? items : items.slice(0, max);
  // Bocetos de cada producto (PDF o foto en Drive); se suben con el botón o soltándolos encima del recuadro.
  const toast = useToast();
  const bo = useBocetos('order', recordId);
  const [ver, setVer] = useState<Boceto | null>(null);
  const productos: ProductoRef[] = items.map((it) => ({ key: it.code || it.name, nombre: it.name }));
  const sub = useSubirBocetos('order', recordId, productos, () => bo.reload());
  // El logo original de cada producto (logos.ts): el elegido o el principal de la empresa.
  const lg = useLogos('order', recordId);
  const bocetos = bo.data?.bocetos ?? [];
  const deProducto = (k: string) => bocetos.filter((b) => b.producto === k);
  const sinProducto = bocetos.filter((b) => !productos.some((p) => p.key === b.producto));
  const puedeSubir = !!bo.data?.configurado;
  const usar = async (b: Boceto, key: string) => {
    const p = productos.find((x) => x.key === key);
    try { await http('POST', `/bocetos/${b.id}/usar`, { order_id: recordId, producto: p?.key ?? null, producto_nombre: p?.nombre ?? b.producto_nombre }); toast('Boceto agregado al pedido'); bo.reload(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const qty = (n: number | null) => (n == null ? '' : n.toLocaleString('es-AR', { maximumFractionDigits: 2 }));
  const deClickup = d?.source === 'clickup';
  const empty = res.loading ? 'Buscando los productos…'
    : res.error ? res.error
    : d?.error ? `No se pudieron leer los productos: ${d.error}`
    : !d?.pedido && !d?.clickup ? 'Este pedido no tiene pedido de Finnegans ni PDV de ClickUp asociado.'
    : !d?.configured && !d?.clickup ? 'Falta conectar Finnegans (Configuración → Integraciones).'
    : 'Ni Finnegans ni ClickUp tienen productos para este pedido (pasa con los anulados).';
  return (
    <SoltarBocetos className="panel assoc-card soltar" onArchivos={(f) => (puedeSubir ? sub.elegir(f) : toast('Para subir bocetos falta elegir la carpeta de Drive (Configuración → Integraciones).', true))}>
      <div className="panel-head"><h3>Productos <span className="muted small">({items.length})</span></h3>
        {puedeSubir && items.length > 0 && <BotonArchivos onArchivos={sub.elegir} title="Subir bocetos (PDF o fotos); también podés soltarlos encima">{sub.subiendo ? 'Subiendo…' : '+ Bocetos'}</BotonArchivos>}
      </div>
      {/* Quién lo tiene en producción (asignado en ClickUp), con su foto: a quién preguntarle cómo viene. */}
      {deClickup && items.length > 0 && <div className="panel-body small muted" style={{ paddingTop: 0 }}>Según ClickUp: {d?.pedido ? `el pedido ${d.pedido} no tiene renglones en Finnegans` : 'este PDV no tiene pedido de Finnegans'}, así que van sin precio.</div>}
      {shown.map((it, i) => (
        <div key={i} className="assoc-item product-item">
          {it.image_url
            ? <a href={it.image_url} target="_blank" rel="noreferrer" className="product-img" title="Ver la foto"><img src={it.image_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).classList.add('broken'); }} /></a>
            : <span className="product-img none" aria-hidden><Icon name="order" size={18} /></span>}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="product-name">{it.name}</div>
            <div className="small muted">{it.unit_price != null
              ? <>{qty(it.quantity)} × {fmtMoney(it.unit_price, it.currency)}{it.discount ? ` · ${qty(it.discount)} % de descuento` : ''}</>
              : it.quantity != null ? `${qty(it.quantity)} unidades` : 'Cantidad sin cargar'}{it.code && it.code !== it.name ? ` · ${it.code}` : ''}</div>
            {(it.status || (it.asignados?.length ?? 0) > 0) && (
              <div className="small row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {it.status && <EstadoClickup estado={it.status} color={it.status_color} />}
                {it.asignados?.map((p) => <span key={p.id} className="user-inline" title={`Lo tiene ${p.nombre}`}><PersonaProd p={p} size="xs" />{p.nombre.split(' ')[0]}</span>)}
              </div>
            )}
            {it.description && <div className="small muted clamp-2" title={it.description}>{it.description}</div>}
            <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <BocetoChips lista={deProducto(it.code || it.name)} onAbrir={setVer} />
              <LogoProducto type="order" recordId={recordId} producto={it.code || it.name} productoNombre={it.name} res={lg.data} onCambio={() => lg.reload()} />
              {puedeSubir && <BotonArchivos className="btn ghost sm boceto-mas" multiple={false} title={`Subir un boceto de ${it.name}`}
                onArchivos={(f) => sub.elegir(f, { key: it.code || it.name, nombre: it.name })}>+ Boceto</BotonArchivos>}
            </div>
          </div>
          {it.subtotal != null && <b className="num" style={{ whiteSpace: 'nowrap' }}>{fmtMoney(it.subtotal, it.currency)}</b>}
        </div>
      ))}
      {(d?.cotizacion_fotos?.length ?? 0) > 0 && (
        <div className="assoc-item" style={{ flexDirection: 'column', gap: 6 }}>
          <div className="small muted">{items.length ? 'Fotos de la cotización del STP que no se pudieron atribuir a un producto' : 'Fotos de la cotización del STP'}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {d!.cotizacion_fotos!.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="product-img" title="Ver la foto"><img src={u} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).classList.add('broken'); }} /></a>
            ))}
          </div>
        </div>
      )}
      {items.length > max && (
        <div className="panel-body"><button className="btn sm ghost" onClick={() => setAll(!all)} aria-expanded={all}>{all ? 'Ver menos' : `Ver más (${items.length - max})`}</button></div>
      )}
      {items.length > 0 && !deClickup && (
        <div className="assoc-item product-total">
          <span className="grow">Total{d!.tax_included ? '' : ' sin IVA'}</span>
          <b className="num">{fmtMoney(d!.total, d!.currency)}</b>
        </div>
      )}
      {!items.length && <div className="panel-body muted small">{empty}</div>}
      {sinProducto.length > 0 && (
        <div className="assoc-item" style={{ flexDirection: 'column', gap: 4 }}>
          <div className="small muted">Bocetos sin producto (abrilos para elegir a cuál van)</div>
          <BocetoChips lista={sinProducto} onAbrir={setVer} />
        </div>
      )}
      {(bo.data?.de_negocios.length ?? 0) > 0 && (
        <div className="assoc-item" style={{ flexDirection: 'column', gap: 6 }}>
          <div className="small muted">Bocetos de negocios de esta empresa (hechos antes del pedido)</div>
          {bo.data!.de_negocios.map((b) => (
            <div key={b.id} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <BocetoChips lista={[b]} onAbrir={setVer} />
              <span className="small ellipsis grow" title={`Negocio: ${b.negocio}`}>{b.producto_nombre || b.nombre} · {b.negocio}</span>
              <Select className="input sm" style={{ width: 170 }} value="" aria-label="Usar en el producto" onChange={(e) => e.target.value && usar(b, e.target.value)}>
                <option value="">Usar para…</option>
                {productos.map((p) => <option key={p.key} value={p.key}>{p.nombre}</option>)}
              </Select>
            </div>
          ))}
        </div>
      )}
      {bo.data && !puedeSubir && items.length > 0 && <div className="panel-body small muted">Para subir bocetos falta elegir la carpeta de Drive (Configuración → Integraciones).</div>}
      {sub.cuadro}
      {ver && <BocetoVisor b={ver} esPedido productos={productos} onClose={() => setVer(null)} onCambio={() => bo.reload()}
        logos={{ type: 'order', recordId, res: lg.data, onCambio: () => lg.reload() }} />}
    </SoltarBocetos>
  );
}

interface FileRow { id: number; kind: string; name: string; source: string; created_at: string; ready: boolean; meta: Record<string, any> }
// Compras de la empresa en Finnegans (las calcula el CRM cada noche): estado, última compra, cuánto compra y cuánto debe.
// Proveedor o impresor (produccion.ts): lo que tiene ahora en producción, con las fechas de ingreso y retiro.
interface ArticuloProveedor { task_id: string; nombre: string; estado: string; cantidad: number | null; npdv: string | null; cliente: string | null; record_id: number | null;
  rol: 'proveedor' | 'impresor'; ingreso_proveedor: string | null; retiro_proveedor: string | null; egreso_impresor: string | null; retiro_impresor: string | null }
function ProduccionProveedorCard({ companyId }: { companyId: number }) {
  const res = useAsync(() => http<{ articulos: ArticuloProveedor[] }>('GET', `/records/company/${companyId}/produccion`), [companyId]);
  const arts = res.data?.articulos ?? [];
  if (!arts.length) return null;
  const f = (v: string | null) => (v ? fmtDate(v) : null);
  return (
    <div className="panel assoc-card">
      <div className="panel-head"><h3>En producción <span className="muted small">({arts.length})</span></h3><Link className="btn sm ghost" to="/produccion">Ver producción</Link></div>
      {arts.slice(0, 12).map((a) => {
        const fechas = (a.rol === 'impresor'
          ? [f(a.egreso_impresor) && `fue ${f(a.egreso_impresor)}`, f(a.retiro_impresor) && `retiro ${f(a.retiro_impresor)}`]
          : [f(a.ingreso_proveedor) && `ingreso ${f(a.ingreso_proveedor)}`, f(a.retiro_proveedor) && `retiro ${f(a.retiro_proveedor)}`]).filter(Boolean);
        return (
          <div key={a.task_id} className="assoc-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
            <div className="ellipsis" title={a.nombre}>{a.nombre}</div>
            <div className="small muted ellipsis">
              {a.record_id ? <Link to={recordUrl('order', a.record_id)}>PDV {a.npdv}</Link> : `PDV ${a.npdv}`}
              {` · ${a.cliente ?? '—'} · ${a.rol === 'impresor' ? 'imprime' : 'provee'} · ${a.estado}`}{fechas.length ? ` · ${fechas.join(', ')}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ComprasCard({ record }: { record: CrmRecord }) {
  const p = record.props;
  if (!p.estado_cliente && p.saldo_pendiente == null) return null;
  const dias = p.fecha_ultima_compra ? Math.round((Date.now() - Date.parse(`${p.fecha_ultima_compra}T12:00:00Z`)) / 86_400_000) : null;
  const fila = (label: string, value: React.ReactNode, hint?: string) => (value == null || value === '' ? null
    : <div className="compras-row" title={hint}><span className="muted">{label}</span><span>{value}</span></div>);
  const usd = (v: unknown) => (v == null || v === '' ? null : fmtMoney(v, 'USD'));
  return (
    <div className="panel">
      <div className="panel-head"><h3>Compras</h3>{p.estado_cliente && <EstadoCliente value={String(p.estado_cliente)} />}</div>
      <div className="panel-body compras">
        {fila('Última compra', p.fecha_ultima_compra && `${fmtDate(p.fecha_ultima_compra)}${dias != null ? ` · hace ${dias} días` : ''}`)}
        {fila('Compra cada', p.cada_cuanto_compra != null && `${p.cada_cuanto_compra} días`, 'Mediana de los días entre una compra y la siguiente')}
        {fila('Últimos 12 meses', usd(p.compra_12m_usd), 'Neto sin IVA, al dólar MEP del día de cada compra')}
        {fila('Compra histórica', usd(p.compra_historica_usd), p.fecha_primera_compra ? `Desde ${fmtDate(p.fecha_primera_compra)}` : undefined)}
        {fila('Ticket promedio', usd(p.ticket_promedio_usd))}
        {fila('Compras', p.cantidad_de_compras)}
        {fila('Saldo pendiente', p.saldo_pendiente != null && fmtMoney(p.saldo_pendiente), 'Con IVA, en cuenta corriente de Finnegans')}
        {Number(p.saldo_vencido) > 0 && <div className="compras-row bad"><span>Vencido</span><span>{fmtMoney(p.saldo_vencido)}</span></div>}
        {fila('Vendedora', p.vendedora_finnegans)}
        {fila('Unidad', p.unidad_finnegans)}
      </div>
    </div>
  );
}

// Datos para facturar: lo que administración necesita (CUIT válido, razón social) y lo que conviene saber antes.
function FacturarCard({ record }: { record: CrmRecord }) {
  const c = useAsync(() => http<{ empresa: { id: number; name: string } | null; faltan: string[]; avisos: string[]; listo: string[] }>('GET', `/records/deal/${record.id}/facturar`),
    [record.id, record.updated_at]);
  if (!c.data) return null;
  const { faltan, avisos, listo } = c.data;
  return (
    <div className="panel">
      <div className="panel-head"><h3>Datos para facturar</h3>{!faltan.length && <span className="tag ok">Completos</span>}</div>
      <div className="panel-body facturar">
        {faltan.map((f) => <div key={f} className="fact-row bad">✗ {f}</div>)}
        {avisos.map((a) => <div key={a} className="fact-row warn">! {a}</div>)}
        {listo.map((l) => <div key={l} className="fact-row ok">✓ {l}</div>)}
      </div>
    </div>
  );
}

function FilesCard({ recordId }: { recordId: number }) {
  const files = useAsync(() => http<FileRow[]>('GET', `/records/order/${recordId}/files`), [recordId]);
  // Los remitos van en su propia tarjeta (Entrega y remitos), con lo que se leyó de cada uno.
  const list = (files.data ?? []).filter((f) => f.kind !== 'remito');
  const label = (f: FileRow) => (f.kind === 'factura' ? 'Factura' : 'Archivo');
  return (
    <div className="panel assoc-card">
      <div className="panel-head"><h3>Factura <span className="muted small">({list.length})</span></h3></div>
      {list.map((f) => (
        <div key={f.id} className="assoc-item">
          <span className={`tag ${f.kind === 'factura' ? 'info' : 'ok'}`}>{label(f)}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis">{f.kind === 'factura' ? f.meta.numero ?? f.name : f.name}</div>
            <div className="small muted ellipsis">
              {f.kind === 'factura'
                ? [f.meta.fecha && fmtDate(f.meta.fecha), f.meta.total != null && fmtMoney(f.meta.total), f.meta.cae && `CAE ${f.meta.cae}`].filter(Boolean).join(' · ')
                : `ClickUp · ${fmtDate(f.meta.date ?? f.created_at)}`}
            </div>
          </div>
          {f.ready ? <a className="btn sm" href={`/api/files/${f.id}`} target="_blank" rel="noreferrer">Ver</a>
            : <span className="small muted" title="Se baja sola de Finnegans en la próxima hora">PDF en camino</span>}
        </div>
      ))}
      {!list.length && <div className="panel-body muted small">{files.loading ? 'Cargando…' : 'Cuando Finnegans tenga la factura con CAE, aparece acá sola.'}</div>}
    </div>
  );
}

function AssocCard({ type, record, toType, items, onChange, onPeek }: {
  type: ObjectType; record: CrmRecord; toType: ObjectType; items: Array<CrmRecord & { primary: boolean; label: string | null }>; onChange: () => void; onPeek?: (t: ObjectType, id: number) => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [mode, setMode] = useState<'' | 'pick' | 'create'>('');
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  const title = toType === type ? 'Empresas relacionadas' : OBJECTS[toType].plural;
  // Un pedido va en un solo negocio (el servidor tampoco deja un segundo): con uno ya no se ofrece «Agregar».
  const pedidoNegocio = type === 'order' && toType === 'deal';
  const lleno = pedidoNegocio && items.length >= 1;
  const add = async (r: CrmRecord) => {
    try { await http('POST', '/associations', { from_id: record.id, to_id: r.id }); toast('Asociado'); setMode(''); onChange(); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="panel assoc-card">
      <div className="panel-head"><h3>{title} <span className="muted small">({items.length})</span></h3>
        {!lleno && <button className="btn sm" onClick={() => setMode(mode ? '' : 'pick')}>+ Agregar</button>}</div>
      {mode === 'pick' && (
        <div className="panel-body stack">
          <RecordPicker type={toType} exclude={[record.id, ...items.map((i) => i.id)]} onPick={add} />
          <button className="btn sm" onClick={() => setMode('create')}>Crear {OBJECTS[toType].single.toLowerCase()} nuevo</button>
        </div>
      )}
      {mode === 'create' && <CreateRecord type={toType} associateWith={record} onClose={() => setMode('')} onCreated={() => onChange()} />}
      {shown.map((r) => (
        <div key={r.id} className="assoc-item">
          <Avatar name={r.name} type={toType} domain={r.props.domain} email={r.props.email} />
          <div className="grow" style={{ minWidth: 0 }}>
            <Link to={recordUrl(toType, r.id)} className="ellipsis" style={{ display: 'block' }}>{r.name}</Link>
            <div className="small muted ellipsis">
              {toType === 'deal' ? [fmtMoney(r.props.amount, r.props.deal_currency_code), stageOf(meta, r.props.dealstage)?.stage.label].filter(Boolean).join(' · ')
                : toType === 'contact' ? [r.props.jobtitle, r.props.email || r.props.mobilephone || r.props.phone].filter(Boolean).join(' · ')
                  : toType === 'company' ? r.props.domain : r.props.pdv_finnegans}
            </div>
            {r.primary && toType === 'company' && <span className="tag info">Principal</span>}
          </div>
          <div className="x row">
            {onPeek && <button className="btn ghost sm" title="Vista previa" aria-label={`Vista previa de ${r.name}`} onClick={() => onPeek(toType, r.id)}>Ver</button>}
            {toType === 'company' && !r.primary && type !== 'company' && (
              <button className="btn ghost sm" title="Marcar como principal" onClick={async () => { await http('POST', '/associations', { from_id: record.id, to_id: r.id, primary: true }); onChange(); }}>★</button>
            )}
            <button className="btn ghost sm" aria-label="Quitar asociación" onClick={async () => {
              if (!confirm(`¿Quitar la asociación con «${r.name}»?`)) return;
              await http('DELETE', '/associations', { from_id: record.id, to_id: r.id }); onChange();
            }}>×</button>
          </div>
        </div>
      ))}
      {!items.length && mode === '' && (pedidoNegocio
        ? <div className="panel-body small warn-text">Sin negocio asociado: asocialo para que el monto del negocio siga al total de este pedido.</div>
        : <div className="panel-body muted small">Nada asociado todavía.</div>)}
      {items.length > 5 && <div className="panel-body"><button className="btn sm ghost" onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver los ${items.length}`}</button></div>}
    </div>
  );
}

// Vista previa en un panel lateral, como al hacer clic en una tarjeta del tablero de HubSpot: lo principal del
// registro, las acciones rápidas, «Acerca de» editable, con quién está asociado y la última actividad.
export function RecordPreview({ type, id, compose, onClose, onChange }: { type: ObjectType; id: number; compose?: Activity['type']; onClose: () => void; onChange?: () => void }) {
  // Desde la vista previa se puede abrir la de un asociado (contacto, empresa…) y volver, como en HubSpot.
  const [stack, setStack] = useState<Array<{ type: ObjectType; id: number }>>([]);
  const cur = stack[stack.length - 1] ?? { type, id };
  return (
    <PreviewBody key={`${cur.type}-${cur.id}`} type={cur.type} id={cur.id} compose={stack.length ? undefined : compose} onClose={onClose} onChange={onChange}
      onBack={stack.length ? () => setStack((s) => s.slice(0, -1)) : undefined} onPeek={(t, i) => setStack((s) => [...s, { type: t, id: i }])} />
  );
}

function PreviewBody({ type, id, compose: composeIn, onClose, onChange, onBack, onPeek }: {
  type: ObjectType; id: number; compose?: Activity['type']; onClose: () => void; onChange?: () => void; onBack?: () => void; onPeek: (t: ObjectType, id: number) => void;
}) {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [ask, setAsk] = useState<{ stage: Stage; missing: string[] } | null>(null);
  const toast = useToast();
  const data = useAsync(() => http<Loaded>('GET', `/records/${type}/${id}`), [type, id]);
  const tl = useAsync(() => http<{ activities: Activity[] }>('GET', `/records/${type}/${id}/timeline${qs({ limit: 5 })}`), [type, id]);
  const [compose, setCompose] = useState<Activity['type'] | null>(composeIn ?? null);
  const [hist, setHist] = useState<string | null>(null);
  // La conversación del pedido (o negocio), a la izquierda de la vista previa. Queda abierta o cerrada como la dejó cada uno;
  // en pantallas angostas arranca cerrada y se abre encima.
  const conChat = type === 'order' || type === 'deal';
  const [chat, setChatState] = useState(() => {
    try { const v = localStorage.getItem('crm:preview-chat'); return v ? v === '1' : window.innerWidth >= 1100; } catch { return true; }
  });
  const setChat = (v: boolean) => { setChatState(v); try { localStorage.setItem('crm:preview-chat', v ? '1' : '0'); } catch { /* sin memoria */ } };
  const sinLeer = useNoLeidosDe(id);
  const record = data.data?.record;
  const associations = data.data?.associations;
  const changed = () => { data.reload(); tl.reload(); onChange?.(); };
  const save = async (name: string, value: unknown) => {
    try {
      await http('PATCH', `/records/${type}/${id}`, { props: { [name]: value } });
      toast('Guardado');
      changed();
    } catch (e) { toast((e as Error).message, true); throw e; }
  };
  const pipeKeys = type === 'deal' ? meta.pipelines.find((p) => p.id === record?.props.pipeline)?.config.key_props : undefined;
  const keyProps = ((pipeKeys?.length ? pipeKeys : keyPropsFor(meta, type)).map((n) => propOf(meta, type, n)).filter(Boolean) as Property[])
    .filter((p) => !(type === 'deal' && ['amount', 'closedate', 'pipeline', 'dealstage', 'link_a_darwin'].includes(p.name)) && !(type === 'order' && ['hs_total_price', 'pdv_finnegans', 'hs_pipeline_stage'].includes(p.name)));
  // Cambiar la etapa desde la vista previa; si la etapa pide datos (motivo de pérdida…), se piden antes.
  const moveTo = async (stageId: string, extra: Record<string, unknown> = {}) => {
    const st = stageOf(meta, stageId)?.stage;
    if (!record || !st || stageId === record.props.dealstage) return;
    const missing = missingFor(st, { ...record.props, ...extra });
    if (missing.length) { setAsk({ stage: st, missing }); return; }
    try {
      await http('PATCH', `/records/deal/${id}`, { props: { dealstage: stageId, ...extra } });
      toast(`Pasó a ${st.label}`);
      changed();
    } catch (e) {
      const m = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      if (m?.length) setAsk({ stage: st, missing: m }); else toast((e as Error).message, true);
    }
  };
  const clone = async () => {
    try {
      const r = await http<CrmRecord>('POST', `/records/${type}/${id}/clone`);
      toast('Negocio clonado');
      onChange?.();
      navigate(recordUrl(type, r.id));
    } catch (e) { toast((e as Error).message, true); }
  };
  const next = record?.props.notes_next_activity_date;
  const summary: Array<[string, ReactNode]> = !record ? [] : type === 'deal' ? [
    ['Valor', <ValorEditable key="valor" record={record} onSaved={changed} />],
    ['Fecha de cierre', record.props.closedate ? fmtDate(record.props.closedate) : '—'],
    ['Pipeline', meta.pipelines.find((p) => p.id === record.props.pipeline)?.label ?? '—'],
    ['Etapa', <StageSelect key="st" value={record.props.dealstage} pipelineId={record.props.pipeline} onChange={(v) => moveTo(v)} />],
    ['Próxima actividad', next ? fmtDate(next) : <span className="warn-text">Sin próximas actividades</span>],
  ] : type === 'company' ? [
    ['Dominio', record.props.domain || '—'],
    ['Propietario', <UserChip key="owner" id={record.props.owner_id} empty="—" />],
  ] : type === 'contact' ? [
    ['Email', record.props.email || '—'],
    ['Celular', record.props.mobilephone || record.props.phone ? <WhatsAppLink key="cel" phone={record.props.mobilephone || record.props.phone} /> : '—'],
    ['Propietario', <UserChip key="owner" id={record.props.owner_id} empty="—" />],
  ] : [
    ['Total sin IVA', fmtMoney(record.props.hs_total_price, record.props.hs_currency_code) || '—'],
    ['Etapa', record.props.hs_pipeline_stage ? <EtapaPedido key="etapa" value={record.props.hs_pipeline_stage} label={formatValue(meta, 'order', 'hs_pipeline_stage', record.props.hs_pipeline_stage)} /> : '—'],
    // Quién lo tiene en producción (asignados en ClickUp), como en la tarjeta del tablero y en la ficha.
    ...(data.data?.produccion ? [['Producción', <QuienProduce key="prod" {...data.data.produccion} />] as [string, ReactNode]] : []),
    ['Tipo', record.props.tipo_de_pedido || '—'],
    ['Entrega', record.props.fecha_de_entrega ? fmtDate(record.props.fecha_de_entrega) : '—'],
    ['PDV', safeUrl(record.props.url_pdv_finnegans) ? <a key="pdv" href={safeUrl(record.props.url_pdv_finnegans)} target="_blank" rel="noreferrer">{record.props.pdv_finnegans || 'Abrir en Finnegans'}</a> : record.props.pdv_finnegans || '—'],
    ['Comprador', [record.props.hs_billing_address_firstname, record.props.hs_billing_address_lastname].filter(Boolean).join(' ') || associations?.contact?.[0]?.name || '—'],
    // De Finnegans, con IVA: lo facturado que falta cobrar más lo que falta facturar.
    ['Saldo pendiente', saldoPedido(record.props)],
  ];
  return (
    <Drawer clear title={`Vista previa · ${OBJECTS[type].single}`} onClose={onClose}
      aside={conChat && chat ? <ConversacionPanel type={type} recordId={id} onClose={() => setChat(false)} /> : undefined}
      actions={conChat && !chat ? <button className="btn sm conv-abrir" onClick={() => setChat(true)} title="Abrir la conversación del equipo sobre este registro">
        <Icon name="chat" size={14} />Conversación{sinLeer ? <span className={`count${sinLeer.menciones ? ' mencion' : ''}`}>{sinLeer.no_leidos}</span> : null}</button> : undefined}
      footer={<>
        {onBack && <button className="btn" onClick={onBack}>← Volver</button>}
        {type === 'deal' && meta.me.role !== 'viewer' && <button className="btn" onClick={clone} title="Crea una copia con los mismos datos y asociaciones">Clonar</button>}
        <Link className="btn primary" style={{ flex: 1, justifyContent: 'center' }} to={recordUrl(type, id)}>Ver registro</Link>
      </>}>
      {!record ? <div className="muted">{data.error ?? 'Cargando…'}</div> : <>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Avatar name={record.name} type={type} size="lg" domain={record.props.domain} email={record.props.email} />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.3 }}><Link to={recordUrl(type, id)}>{record.name}</Link></h2>
            <TagChips meta={meta} ids={record.tags} />
            <div className="preview-sum">
              {summary.map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {v}</div>)}
            </div>
            {type === 'deal' && <div style={{ marginTop: 8 }}><ChatDarwin url={record.props.link_a_darwin} /></div>}
          </div>
        </div>
        <div className="rec-actions">
          {(['note', 'email', 'call', 'task', 'meeting', 'whatsapp'] as const).map((t) => (
            <button key={t} className="act-btn" onClick={() => setCompose(t)}><span className="ic"><Icon name={t} /></span>{ACTIVITY_LABEL[t]}</button>
          ))}
        </div>
        {compose && <Composer type={compose} record={record} associations={associations!} onClose={() => setCompose(null)} onSaved={() => { setCompose(null); changed(); }} />}
        <div className="panel">
          <div className="panel-head"><h3>Acerca de {type === 'deal' ? 'este negocio' : type === 'company' ? 'esta empresa' : type === 'order' ? 'este pedido' : 'este contacto'}</h3></div>
          <div className="prop-list">{keyProps.map((p) => <PropRow key={p.name} type={type} prop={p} record={record} onSave={save} onHistory={setHist} />)}</div>
        </div>
        {type === 'company' && <ComprasCard record={record} />}
        {type === 'company' && <LogosCard companyId={record.id} />}
        {!esVentas(meta.me) && type === 'company' && record.props.tipo_de_relacion === 'proveedor' && <ProduccionProveedorCard companyId={record.id} />}
        {type === 'deal' && <FacturarCard record={record} />}
        {type === 'order' && <ProductsCard recordId={id} max={3} />}
        {/* Los remitos y qué falta entregar, igual que en la ficha (el camioncito de la tarjeta del tablero los cuenta). */}
        {type === 'order' && <RemitosCard record={record} onChange={changed} />}
        {type === 'order' && <FilesCard recordId={id} />}
        {/* Las mismas tarjetas de la ficha: buscar y asociar, crear uno nuevo ya asociado, quitar, marcar principal. */}
        {RELATED[type].map((t) => <AssocCard key={t} type={type} record={record} toType={t} items={associations?.[t] ?? []} onChange={changed} onPeek={onPeek} />)}
        <div className="panel">
          <div className="panel-head"><h3>Última actividad</h3></div>
          <div className="panel-body stack">
            {tl.data?.activities.length ? tl.data.activities.map((a) => <ActivityItem key={a.id} a={a} currentId={id} onChange={changed} />)
              : <div className="muted small">{tl.loading ? 'Cargando…' : 'Todavía no hay actividad registrada.'}</div>}
          </div>
        </div>
      </>}
      {hist && <HistoryModal type={type} id={id} prop={hist} onClose={() => setHist(null)} />}
      {ask && record && <StageProps deal={record} stage={ask.stage} missing={ask.missing} onClose={() => setAsk(null)} onSave={(extra) => { const a = ask; setAsk(null); moveTo(a.stage.id, extra); }} />}
    </Drawer>
  );
}

// El saldo pendiente del pedido (Finnegans, con IVA) y, si una parte todavía no se facturó, cuánto.
function saldoPedido(p: Record<string, any>) {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const saldo = num(p.saldo_pendiente_de_pago_mxn), pf = num(p.importe_por_facturar);
  if (saldo == null) return '—';
  if (saldo <= 0) return 'Cobrado';
  if (!pf) return fmtMoney(saldo);
  return `${fmtMoney(saldo)} · ${pf >= saldo - 1 ? 'sin facturar' : `${fmtMoney(pf)} sin facturar`}`;
}

