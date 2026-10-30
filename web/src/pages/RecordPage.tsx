import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useAsync, typeFromPath, OBJECTS, propsOf, propOf, formatValue, recordUrl, userName, stageOf, fmtDate, fmtMoney, Icon, ACTIVITY_LABEL, safeUrl, type Activity, type CrmRecord, type ObjectType, type Property, missingFor, type Stage,
} from '../lib';
import { Avatar, CreateRecord, Drawer, Modal, PropertyInput, RecordPicker, toLocalInput } from '../components';
import { StageProps } from './Board';

type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;
interface Loaded { record: CrmRecord; associations: Assoc; redirect?: number }

const RELATED: Record<ObjectType, ObjectType[]> = {
  contact: ['company', 'deal', 'order'],
  company: ['contact', 'deal', 'company'],
  deal: ['contact', 'company', 'order'],
  order: ['contact', 'deal', 'company'],
};

export default function RecordPage() {
  const { objectPath = 'contacts', id = '0' } = useParams();
  const type = typeFromPath(objectPath);
  const navigate = useNavigate();
  const data = useAsync(() => http<Loaded>('GET', `/records/${type}/${id}`), [type, id]);
  const [tlKey, setTlKey] = useState(0);
  useEffect(() => { if (data.data?.redirect) navigate(recordUrl(type, data.data.redirect), { replace: true }); }, [data.data, navigate, type]);
  if (data.error) return <div className="content"><div className="empty">{data.error} <Link to={`/${objectPath}`}>Volver</Link></div></div>;
  if (!data.data?.record) return <div className="content"><div className="empty">Cargando…</div></div>;
  const { record, associations } = data.data;
  const refresh = () => { data.reload(); setTlKey((k) => k + 1); };
  return (
    <div className="content flush record-wrap">
      <div className="record">
        <aside className="left"><LeftPanel type={type} record={record} onChange={refresh} /></aside>
        <section className="center">
          {record.archived && <div className="panel panel-body" style={{ marginBottom: 12, background: 'var(--warn-soft)' }}>Este registro está borrado. <RestoreButton type={type} id={record.id} onDone={refresh} /></div>}
          {type === 'deal' && <StageBar record={record} onChange={refresh} />}
          <Timeline key={tlKey} type={type} record={record} associations={associations} onChange={refresh} />
        </section>
        <aside className="right">
          {RELATED[type].map((t) => <AssocCard key={t} type={type} record={record} toType={t} items={associations?.[t] ?? []} onChange={refresh} />)}
        </aside>
      </div>
    </div>
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
  order: ['pdv_finnegans', 'hs_total_price', 'owner_id', 'hs_order_status', 'hs_billing_address_email', 'hs_billing_address_phone'],
};

function subtitle(meta: ReturnType<typeof useMeta>['meta'], type: ObjectType, r: CrmRecord) {
  if (type === 'contact') return [r.props.jobtitle, r.props.company].filter(Boolean).join(' · ') || r.props.email;
  if (type === 'company') return r.props.domain;
  if (type === 'deal') return [fmtMoney(r.props.amount, r.props.deal_currency_code), stageOf(meta, r.props.dealstage)?.stage.label].filter(Boolean).join(' · ');
  return r.props.pdv_finnegans ? `PDV ${r.props.pdv_finnegans}` : '';
}

function LeftPanel({ type, record, onChange }: { type: ObjectType; record: CrmRecord; onChange: () => void }) {
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
  const keyProps = (pipeKeys?.length ? pipeKeys : KEY_PROPS[type]).map((n) => propOf(meta, type, n)).filter(Boolean) as Property[];
  return (
    <>
      <div className="rec-head">
        <div className="crumb"><Link to={`/${OBJECTS[type].path}`}>← {OBJECTS[type].plural}</Link></div>
        <div className="title"><Avatar name={record.name} type={type} size="lg" domain={record.props.domain} email={record.props.email} />
          <div className="grow"><h1>{record.name}</h1><div className="muted small">{subtitle(meta, type, record)}</div></div></div>
        <div className="rec-actions">
          {(['note', 'email', 'call', 'task', 'meeting', 'whatsapp'] as const).map((t) => (
            <button key={t} className="act-btn" onClick={() => quick(t)}><span className="ic"><Icon name={t} /></span>{ACTIVITY_LABEL[t]}</button>
          ))}
        </div>
        <div className="row wrap">
          {type === 'contact' && record.props.mobilephone && <a className="btn sm" href={`https://wa.me/${String(record.props.mobilephone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer">Abrir WhatsApp</a>}
          {type === 'contact' && record.props.email && <a className="btn sm" href={`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(record.props.email)}`} target="_blank" rel="noreferrer">Escribir mail</a>}
          {type === 'deal' && safeUrl(record.props.link_a_darwin) && <a className="btn sm" href={safeUrl(record.props.link_a_darwin)} target="_blank" rel="noreferrer">Chat en Darwin</a>}
          <button className="btn sm ghost" onClick={() => setMerge(true)}><Icon name="merge" size={14} />Combinar</button>
          {['admin', 'manager'].includes(meta.me.role) && !record.archived && (
            <button className="btn sm ghost danger" onClick={async () => {
              if (!confirm(`¿Borrar «${record.name}»? Se puede restaurar.`)) return;
              await http('DELETE', `/records/${type}/${record.id}`); toast('Borrado'); navigate(`/${OBJECTS[type].path}`);
            }}><Icon name="trash" size={14} />Borrar</button>
          )}
        </div>
      </div>
      <details className="prop-group" open>
        <summary>Acerca de {type === 'deal' ? 'este negocio' : type === 'company' ? 'esta empresa' : type === 'order' ? 'este pedido' : 'este contacto'}</summary>
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
            : shown || '—'}
      </div>
    </div>
  );
}

function HistoryModal({ type, id, prop, onClose }: { type: ObjectType; id: number; prop: string; onClose: () => void }) {
  const { meta } = useMeta();
  const h = useAsync(() => http<Array<{ old_value: string; new_value: string; changed_at: string; user_name: string; source: string }>>('GET', `/records/${type}/${id}/history${qs({ prop })}`), [id, prop]);
  return (
    <Modal title={`Historial: ${propOf(meta, type, prop)?.label ?? prop}`} onClose={onClose}>
      {h.data?.length ? h.data.map((c, i) => (
        <div key={i} className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
          <div className="grow"><b>{formatValue(meta, type, prop, c.new_value) || '(vacío)'}</b>
            <div className="small muted">antes: {formatValue(meta, type, prop, c.old_value) || '(vacío)'}</div></div>
          <div className="small muted" style={{ textAlign: 'right' }}>{fmtDate(c.changed_at, true)}<br />{c.user_name ?? '—'} · {c.source}</div>
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
        <select className="input sm" style={{ width: 240 }} value={pipe.id} onChange={async (e) => {
          try { await http('PATCH', `/records/deal/${record.id}`, { props: { pipeline: e.target.value } }); onChange(); } catch (er) { toast((er as Error).message, true); }
        }}>{meta.pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
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
const CHANGE_LABEL: Record<string, string> = { dealstage: 'Etapa', pipeline: 'Pipeline', owner_id: 'Propietario', lifecyclestage: 'Ciclo de vida', amount: 'Monto', archived: 'Borrado', merged: 'Combinado con' };

function Timeline({ type, record, associations, onChange }: { type: ObjectType; record: CrmRecord; associations: Assoc; onChange: () => void }) {
  const { meta } = useMeta();
  const [filter, setFilter] = useState('');
  const [rollup, setRollup] = useState(true);
  const [compose, setCompose] = useState<Activity['type'] | null>(null);
  const [limit, setLimit] = useState(50);
  const tl = useAsync(() => http<{ activities: Activity[]; changes: Array<{ prop: string; old_value: string; new_value: string; changed_at: string; user_name: string; source: string }>; counts: Record<string, number> }>(
    'GET', `/records/${type}/${record.id}/timeline${qs({ types: filter || undefined, rollup: rollup ? undefined : 0, limit })}`), [record.id, filter, rollup, limit]);
  useEffect(() => {
    const h = (e: Event) => setCompose((e as CustomEvent).detail);
    window.addEventListener('crm:compose', h);
    return () => window.removeEventListener('crm:compose', h);
  }, []);
  const items = useMemo(() => {
    const acts = (tl.data?.activities ?? []).map((a) => ({ kind: 'a' as const, at: a.type === 'task' && a.status !== 'COMPLETED' ? '9999' : (a.type === 'task' ? a.completed_at ?? a.due_at ?? a.occurred_at : a.occurred_at), a }));
    const chs = filter ? [] : (tl.data?.changes ?? []).map((c) => ({ kind: 'c' as const, at: c.changed_at, c }));
    return [...acts, ...chs].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  }, [tl.data, filter]);
  const reload = () => { tl.reload(); onChange(); };
  let lastDay = '';
  return (
    <>
      <div className="tabs">
        {FILTERS.map(([k, l]) => (
          <button key={k} className={`tab ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}{k && tl.data?.counts[k] ? <span className="x">{tl.data.counts[k]}</span> : null}</button>
        ))}
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
      {!tl.loading && !items.length && <div className="empty panel">Todavía no hay actividad registrada.</div>}
      {items.map((it) => {
        const day = it.at === '9999' ? 'Pendientes' : new Date(it.at).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const head = day !== lastDay ? <div className="tl-day">{day}</div> : null;
        lastDay = day;
        if (it.kind === 'c') {
          const c = it.c;
          const val = (v: string) => (c.prop === 'merged' ? v : formatValue(meta, type, c.prop, v) || '—');
          return <div key={`c${c.changed_at}${c.prop}`}>{head}<div className="tl-change">{CHANGE_LABEL[c.prop] ?? c.prop}: {c.old_value != null && c.prop !== 'merged' ? `${val(c.old_value)} → ` : ''}<b>{c.prop === 'merged' ? c.new_value : val(c.new_value)}</b> · {c.user_name ?? 'sistema'}{c.source !== 'crm' ? ` (${c.source})` : ''} · {new Date(c.changed_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</div></div>;
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
  return (
    <div className={`tl-item ${a.type}${done ? ' done' : ''}`}>
      <div className="h">
        {a.type === 'task'
          ? <button className={`check-round${done ? ' on' : ''}`} onClick={toggle} aria-label={done ? 'Marcar pendiente' : 'Completar'}>{done && <Icon name="check" />}</button>
          : <span className="ic"><Icon name={a.type} /></span>}
        <span className="subj grow ellipsis"><b>{title}</b> <span className="muted">· {userName(meta, a.owner_id)}{a.source !== 'crm' ? ` · ${a.source}` : ''}</span></span>
        <span className={`when${overdue ? ' overdue' : ''}`}>{a.type === 'task' ? `Vence ${fmtDate(a.due_at, true)}` : fmtDate(a.occurred_at, true)}</span>
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
      <label className="field">Responsable<select className="input" value={f.owner_id ?? ''} onChange={(e) => setF({ ...f, owner_id: Number(e.target.value) })}>
        {meta.users.filter((u) => u.active || u.id === f.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      {a.type === 'task' && <label className="field">Prioridad<select className="input" value={f.priority ?? 'none'} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select></label>}
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
            <select className="input" style={{ width: 150 }} value={f.direction ?? 'out'} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option value="out">{type === 'call' ? 'Saliente' : 'Enviado'}</option><option value="in">{type === 'call' ? 'Entrante' : 'Recibido'}</option>
            </select>
          )}
          {type === 'call' && <select className="input" style={{ width: 170 }} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>}
          {type === 'task' ? <>
            <label className="row small">Vence<input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(f.due_at)} onChange={(e) => setF({ ...f, due_at: new Date(e.target.value).toISOString() })} /></label>
            <select className="input" style={{ width: 140 }} value={f.task_type} onChange={(e) => setF({ ...f, task_type: e.target.value })}>
              <option value="todo">Por hacer</option><option value="call">Llamar</option><option value="email">Mail</option><option value="whatsapp">WhatsApp</option><option value="meeting">Reunión</option>
            </select>
            <select className="input" style={{ width: 150 }} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
            </select>
          </> : (
            <label className="row small">{type === 'meeting' ? 'Empieza' : 'Fecha'}<input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(f.occurred_at)} onChange={(e) => setF({ ...f, occurred_at: new Date(e.target.value).toISOString() })} /></label>
          )}
          <select className="input" style={{ width: 190 }} value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: Number(e.target.value) })} aria-label="Responsable">
            {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
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

function AssocCard({ type, record, toType, items, onChange }: { type: ObjectType; record: CrmRecord; toType: ObjectType; items: Array<CrmRecord & { primary: boolean; label: string | null }>; onChange: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [mode, setMode] = useState<'' | 'pick' | 'create'>('');
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  const title = toType === type ? 'Empresas relacionadas' : OBJECTS[toType].plural;
  const add = async (r: CrmRecord) => {
    try { await http('POST', '/associations', { from_id: record.id, to_id: r.id }); toast('Asociado'); setMode(''); onChange(); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="panel assoc-card">
      <div className="panel-head"><h3>{title} <span className="muted small">({items.length})</span></h3>
        <button className="btn sm" onClick={() => setMode(mode ? '' : 'pick')}>+ Agregar</button></div>
      {mode === 'pick' && (
        <div className="panel-body stack">
          <RecordPicker type={toType} exclude={[record.id, ...items.map((i) => i.id)]} onPick={add} />
          <button className="btn sm" onClick={() => setMode('create')}>Crear {OBJECTS[toType].single.toLowerCase()} nuevo</button>
        </div>
      )}
      {mode === 'create' && <CreateRecord type={toType} associateWith={record.id} onClose={() => setMode('')} onCreated={() => onChange()} />}
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
      {!items.length && mode === '' && <div className="panel-body muted small">Nada asociado todavía.</div>}
      {items.length > 5 && <div className="panel-body"><button className="btn sm ghost" onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver los ${items.length}`}</button></div>}
    </div>
  );
}

// Vista previa en un panel lateral, como al hacer clic en una tarjeta del tablero de HubSpot: lo principal del
// registro, las acciones rápidas, «Acerca de» editable, con quién está asociado y la última actividad.
export function RecordPreview({ type, id, onClose, onChange }: { type: ObjectType; id: number; onClose: () => void; onChange?: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const data = useAsync(() => http<Loaded>('GET', `/records/${type}/${id}`), [type, id]);
  const tl = useAsync(() => http<{ activities: Activity[] }>('GET', `/records/${type}/${id}/timeline${qs({ limit: 5 })}`), [type, id]);
  const [compose, setCompose] = useState<Activity['type'] | null>(null);
  const [hist, setHist] = useState<string | null>(null);
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
  const keyProps = ((pipeKeys?.length ? pipeKeys : KEY_PROPS[type]).map((n) => propOf(meta, type, n)).filter(Boolean) as Property[])
    .filter((p) => !(type === 'deal' && ['amount', 'closedate', 'pipeline', 'dealstage'].includes(p.name)));
  const summary: Array<[string, ReactNode]> = !record ? [] : type === 'deal' ? [
    ['Valor', fmtMoney(record.props.amount, record.props.deal_currency_code) || '—'],
    ['Fecha de cierre', record.props.closedate ? fmtDate(record.props.closedate) : '—'],
    ['Pipeline', meta.pipelines.find((p) => p.id === record.props.pipeline)?.label ?? '—'],
    ['Etapa', stageOf(meta, record.props.dealstage)?.stage.label ?? '—'],
  ] : type === 'company' ? [
    ['Dominio', record.props.domain || '—'],
    ['Propietario', userName(meta, record.props.owner_id) || '—'],
  ] : type === 'contact' ? [
    ['Email', record.props.email || '—'],
    ['Celular', record.props.mobilephone || record.props.phone || '—'],
    ['Propietario', userName(meta, record.props.owner_id) || '—'],
  ] : [['PDV', record.props.pdv_finnegans || '—']];
  return (
    <Drawer clear title={`Vista previa · ${OBJECTS[type].single}`} onClose={onClose}
      footer={<Link className="btn primary" style={{ flex: 1, justifyContent: 'center' }} to={recordUrl(type, id)}>Ver registro</Link>}>
      {!record ? <div className="muted">{data.error ?? 'Cargando…'}</div> : <>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Avatar name={record.name} type={type} size="lg" domain={record.props.domain} email={record.props.email} />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.3 }}><Link to={recordUrl(type, id)}>{record.name}</Link></h2>
            <div className="preview-sum">
              {summary.map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {v}</div>)}
            </div>
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
        {RELATED[type].filter((t) => associations?.[t]?.length).map((t) => (
          <div key={t} className="panel">
            <div className="panel-head"><h3>{OBJECTS[t].plural} <span className="muted small">({associations![t].length})</span></h3></div>
            {associations![t].slice(0, 5).map((r) => (
              <div key={r.id} className="assoc-item">
                <Avatar name={r.name} type={t} domain={r.props.domain} email={r.props.email} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <Link to={recordUrl(t, r.id)} className="ellipsis" style={{ display: 'block' }}>{r.name}</Link>
                  <div className="small muted ellipsis">{t === 'deal' ? stageOf(meta, r.props.dealstage)?.stage.label : t === 'contact' ? r.props.email || r.props.mobilephone : t === 'company' ? r.props.domain : r.props.pdv_finnegans}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="panel">
          <div className="panel-head"><h3>Última actividad</h3></div>
          <div className="panel-body stack">
            {tl.data?.activities.length ? tl.data.activities.map((a) => <ActivityItem key={a.id} a={a} currentId={id} onChange={changed} />)
              : <div className="muted small">{tl.loading ? 'Cargando…' : 'Todavía no hay actividad registrada.'}</div>}
          </div>
        </div>
      </>}
      {hist && <HistoryModal type={type} id={id} prop={hist} onClose={() => setHist(null)} />}
    </Drawer>
  );
}
