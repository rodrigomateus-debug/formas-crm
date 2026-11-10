import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useDebounced, propsOf, propOf, recordUrl, OBJECTS, initials, Icon, type CrmRecord, type Filter, type ObjectType, type Property, type Meta, defaultPipeline, missingFor, UNIDADES, type UnidadKey,
  userOf, userName, type User, safeUrl, whatsappUrl, fmtMoney,
} from './lib';
import { Select } from './Select';

// Las empresas muestran el favicon de su dominio y los contactos la foto de su mail, como en HubSpot; los usuarios, la
// de su cuenta de Google (`photo`). Si no hay, las iniciales.
const sinImagen = new Set<string>();
export function Avatar({ name, type, size, domain, email, photo }: { name: string; type?: ObjectType; size?: 'lg' | 'sm' | 'xs'; domain?: string | null; email?: string | null; photo?: string | null }) {
  const src = photo ? photo
    : type === 'company' && domain ? `/api/favicon/${encodeURIComponent(String(domain).trim().toLowerCase())}`
    : type === 'contact' && email ? `/api/avatar/${encodeURIComponent(String(email).trim().toLowerCase())}` : '';
  const [failed, setFailed] = useState(() => !src || sinImagen.has(src));
  useEffect(() => { setFailed(!src || sinImagen.has(src)); }, [src]);
  const cls = `avatar ${type && type !== 'contact' ? type : ''} ${size ?? ''}`;
  if (!failed) {
    // Las fotos de Google (lh3.googleusercontent.com) a veces no cargan si el pedido lleva de qué página viene.
    return <span className={`${cls} ${type === 'company' && !photo ? 'logo' : 'photo'}`}><img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { sinImagen.add(src); setFailed(true); }} /></span>;
  }
  return <span className={cls}>{initials(name)}</span>;
}

// Un usuario del CRM (propietario, responsable, quien hizo un cambio) con la foto de su cuenta de Google.
export function UserAvatar({ id, size }: { id: unknown; size?: 'lg' | 'sm' | 'xs' }) {
  const { meta } = useMeta();
  const u = userOf(meta, id);
  return <Avatar name={u?.name ?? userName(meta, id)} photo={u?.photo_url} size={size} />;
}

// Foto y nombre juntos (tablas, fichas, tareas). Sin usuario, `empty`. El chico (xs) va dentro de una línea de texto
// (actividad, historial): ahí el nombre se corta con «…» como el resto de la línea.
export function UserChip({ id, name, empty = 'Sin asignar', size = 'sm' }: { id: unknown; name?: string | null; empty?: ReactNode; size?: 'sm' | 'xs' }) {
  const { meta } = useMeta();
  if (id == null || id === '') return <>{empty}</>;
  const u = userOf(meta, id);
  const n = u?.name ?? name ?? userName(meta, id);
  if (size === 'xs') return <span className="user-inline"><Avatar name={n} photo={u?.photo_url} size="xs" />{n}</span>;
  return <span className="user-chip" title={n}><Avatar name={n} photo={u?.photo_url} size={size} /><span className="ellipsis">{n}</span></span>;
}

// Contenido de un <option> de usuario en los desplegables (Select): la foto y el nombre. Va como fragmento para que el
// buscador del desplegable siga encontrando por nombre.
export const userOption = (u: User, extra = '') => <><Avatar name={u.name} photo={u.photo_url} size="xs" />{u.name}{extra}</>;

// «Chat en Darwin»: va directo a la conversación de WhatsApp del negocio en Darwin (su «Link a Darwin»). Con el ícono de
// WhatsApp para que se entienda adónde lleva; es lo único que se muestra del link (no se repite como texto).
export function ChatDarwin({ url, className = 'btn sm', label = 'Chat en Darwin' }: { url: unknown; className?: string; label?: string }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a className={`${className} chat-darwin`} href={href} target="_blank" rel="noreferrer" title="Chat en Darwin: abrir la conversación de WhatsApp"
      onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}><Icon name="whatsapp" size={14} />{label}</a>
  );
}

// Un teléfono (celular o fijo) que abre el chat de WhatsApp con ese número, con el ícono para que se entienda adónde lleva.
// Si el número no alcanza para armar el link, queda el texto solo.
export function WhatsAppLink({ phone, children }: { phone: unknown; children?: ReactNode }) {
  const href = whatsappUrl(phone);
  const text = children ?? String(phone ?? '');
  if (!href) return <>{text}</>;
  return (
    <a className="wa-link" href={href} target="_blank" rel="noreferrer" title="Abrir el chat de WhatsApp"
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}><Icon name="whatsapp" size={13} /><span className="ellipsis">{text}</span></a>
  );
}

// Valor del negocio con el lápiz al lado (vista previa y ficha): se cambia ahí mismo, con Enter o Guardar.
export function ValorEditable({ record, onSaved }: { record: CrmRecord; onSaved: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  const [saving, setSaving] = useState(false);
  const shown = fmtMoney(record.props.amount, record.props.deal_currency_code);
  if (edit) {
    return (
      <form className="valor-edit" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          const r = await http<CrmRecord>('PATCH', `/records/deal/${record.id}`, { props: { amount: v === '' ? null : Number(v) } });
          // Con pedidos, el monto sigue su total; cambiarlo a mano lo deja fijo (el servidor marca «Monto a mano»).
          toast(r.props.monto_a_mano === 'true' && record.props.monto_a_mano !== 'true'
            ? 'Valor guardado. Queda «Monto a mano»: el total de los pedidos ya no lo cambia.' : 'Valor guardado');
          setEdit(false);
          onSaved();
        } catch (err) { toast((err as Error).message, true); } finally { setSaving(false); }
      }}>
        <input className="input sm num" type="number" min="0" step="any" autoFocus value={v} aria-label="Valor del negocio" placeholder="Valor"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }} />
        <button className="btn sm primary" disabled={saving}>Guardar</button>
        <button type="button" className="btn sm" onClick={() => setEdit(false)}>Cancelar</button>
      </form>
    );
  }
  return (
    <span className="valor">
      {shown || <span className="muted">Sin valor</span>}
      {meta.me.role !== 'viewer' && (
        <button type="button" className="valor-lapiz" title="Cambiar el valor" aria-label="Cambiar el valor del negocio"
          onClick={(e) => { e.stopPropagation(); setV(record.props.amount == null ? '' : String(record.props.amount)); setEdit(true); }}><Icon name="edit" size={14} /></button>
      )}
    </span>
  );
}

// La vista previa no deja ver la página de atrás bloqueada: la rueda del mouse fuera del panel desplaza lo que está debajo.
function scrollBehind(e: React.WheelEvent<HTMLDivElement>) {
  const overlay = e.currentTarget;
  overlay.style.pointerEvents = 'none';
  let el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  overlay.style.pointerEvents = '';
  while (el && el !== document.body) {
    const st = getComputedStyle(el);
    const canY = /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight;
    const canX = /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth;
    if ((canY && e.deltaY) || (canX && (e.deltaX || e.shiftKey))) { el.scrollBy({ left: e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, top: e.shiftKey ? 0 : e.deltaY }); return; }
    el = el.parentElement;
  }
}

export function Drawer({ title, onClose, children, footer, clear }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; clear?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    // Clic fuera del panel: se cierra (en todas las vistas previas y en los paneles laterales). Afuera, el mouse muestra
    // un círculo con una cruz. La rueda sigue moviendo la lista o el tablero de atrás.
    <div className={`overlay drawer-overlay${clear ? ' clear' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onWheel={clear ? (e) => { if (e.target === e.currentTarget) scrollBehind(e) } : undefined}>
      <div className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head"><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={18} /></button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={18} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Campo de edición según el tipo de propiedad.
export function PropertyInput({ prop, value, onChange, autoFocus, type }: {
  prop: Property; value: any; onChange: (v: any) => void; autoFocus?: boolean; type: ObjectType;
}) {
  const { meta } = useMeta();
  const v = value ?? '';
  if (prop.name === 'pipeline' && type === 'deal') {
    return (
      <Select className="input" value={v} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
        {meta.pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </Select>
    );
  }
  switch (prop.type) {
    case 'owner':
      return (
        <Select className="input" value={v} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} autoFocus={autoFocus}>
          <option value="">Sin asignar</option>
          {meta.users.filter((u) => u.active || u.id === Number(v)).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
        </Select>
      );
    case 'enum':
    case 'bool':
      return (
        <Select className="input" value={v} onChange={(e) => onChange(e.target.value || null)} autoFocus={autoFocus}>
          <option value="">—</option>
          {(prop.type === 'bool' && !prop.options.length ? [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }] : prop.options)
            .map((o) => <option key={o.value} value={o.value}>{type === 'order' && prop.name === 'hs_pipeline_stage' ? <><EtapaIcono value={o.value} />{o.label}</> : o.label}</option>)}
        </Select>
      );
    case 'multienum': {
      const sel = new Set(String(v).split(';').filter(Boolean));
      return (
        <div className="stack" style={{ maxHeight: 180, overflow: 'auto' }}>
          {prop.options.map((o) => (
            <label key={o.value} className="row small">
              <input type="checkbox" checked={sel.has(o.value)} onChange={(e) => {
                e.target.checked ? sel.add(o.value) : sel.delete(o.value);
                onChange([...sel].join(';') || null);
              }} />{o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'number':
    case 'currency':
      return <input className="input num" type="number" step="any" value={v} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} autoFocus={autoFocus} />;
    case 'date':
      return <input className="input" type="date" value={String(v).slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} autoFocus={autoFocus} />;
    case 'datetime':
      return <input className="input" type="datetime-local" value={v ? toLocalInput(v) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} autoFocus={autoFocus} />;
    case 'text':
      return <textarea className="input" value={v} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />;
    default:
      if (prop.name === 'dealstage') return <StageSelect value={v} onChange={onChange} />;
      return <input className="input" type={prop.type === 'email' ? 'email' : prop.type === 'url' ? 'url' : 'text'} value={v} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />;
  }
}

export function toLocalInput(v: string) {
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StageSelect({ value, onChange, pipelineId, only }: { value: string; onChange: (v: string) => void; pipelineId?: string; only?: string[] }) {
  const { meta } = useMeta();
  const pipes = (pipelineId ? meta.pipelines.filter((p) => p.id === pipelineId) : meta.pipelines)
    .map((p) => (only?.length ? { ...p, stages: p.stages.filter((s) => only.includes(s.id)) } : p));
  return (
    <Select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {pipes.map((p) => (
        <optgroup key={p.id} label={p.label}>
          {p.stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

// Buscador de registros para asociar.
export function RecordPicker({ type, onPick, exclude = [], placeholder }: { type: ObjectType; onPick: (r: CrmRecord) => void; exclude?: number[]; placeholder?: string }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [res, setRes] = useState<CrmRecord[]>([]);
  useEffect(() => {
    let alive = true;
    http<{ results: CrmRecord[] }>('GET', `/records/${type}${qs({ q: dq, limit: 8, sort: dq ? 'name' : undefined, dir: 'asc' })}`)
      .then((r) => alive && setRes(r.results)).catch(() => {});
    return () => { alive = false; };
  }, [dq, type]);
  return (
    <div className="stack">
      <div className="search"><Icon name="search" /><input className="input" autoFocus placeholder={placeholder ?? `Buscar ${OBJECTS[type].plural.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="stack" style={{ gap: 2 }}>
        {res.filter((r) => !exclude.includes(r.id)).map((r) => (
          <button key={r.id} className="btn ghost" style={{ justifyContent: 'flex-start', height: 'auto', padding: '6px 8px' }} onClick={() => onPick(r)}>
            <Avatar name={r.name} type={type} domain={r.props.domain} email={r.props.email} />
            <span className="stack" style={{ gap: 0, alignItems: 'flex-start', minWidth: 0 }}>
              <span className="ellipsis">{r.name}</span>
              <span className="small muted ellipsis">{r.props.email || r.props.domain || r.props.amount || ''}</span>
            </span>
          </button>
        ))}
        {!res.length && <div className="muted small">Sin resultados.</div>}
      </div>
    </div>
  );
}

// Alta de registro: propiedades del formulario de creación y asociación opcional.
export function CreateRecord({ type, onClose, onCreated, associateWith, defaults }: {
  type: ObjectType; onClose: () => void; onCreated?: (r: CrmRecord) => void; associateWith?: number; defaults?: Record<string, any>;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const firstStage = (pid: string) => {
    const p = meta.pipelines.find((x) => x.id === pid);
    const allowed = p?.config.rules?.create_stages ?? [];
    return (allowed.length ? p?.stages.find((s) => allowed.includes(s.id)) : p?.stages[0])?.id;
  };
  const [form, setForm] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = { owner_id: meta.me.id, ...defaults };
    if (type === 'deal') {
      init.pipeline = defaults?.pipeline ?? defaultPipeline(meta)?.id;
      init.dealstage = defaults?.dealstage ?? firstStage(init.pipeline);
    }
    return init;
  });
  const pipeline = type === 'deal' ? meta.pipelines.find((p) => p.id === form.pipeline) : undefined;
  const stage = pipeline?.stages.find((s) => s.id === form.dealstage);
  const needsCompany = !!pipeline?.config.rules?.require_company && !associateWith;
  // Campos del alta + los que pide la etapa elegida (propiedades condicionales).
  const fields = useMemo(() => {
    const base = propsOf(meta, type).filter((p) => p.in_create_form || p.required);
    const extra = (stage?.config.required_props ?? []).map((n) => propOf(meta, type, n)).filter((p): p is Property => !!p && !base.includes(p));
    return [...base, ...extra];
  }, [meta, type, stage]);
  const [busy, setBusy] = useState(false);
  const [company, setCompany] = useState<CrmRecord | null>(null);
  const [pickCompany, setPickCompany] = useState(false);
  const set = (k: string, v: any) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === 'pipeline') next.dealstage = firstStage(v);
    return next;
  });
  const save = async (openAfter: boolean) => {
    if (needsCompany && !company) { toast(`En «${pipeline!.label}» el negocio tiene que tener una empresa asociada.`, true); return; }
    const missing = stage ? missingFor(stage, form) : [];
    if (missing.length) { toast(`Para crear en «${stage!.label}» falta: ${missing.map((m) => propOf(meta, type, m)?.label ?? m).join(', ')}.`, true); return; }
    setBusy(true);
    try {
      const assoc = [associateWith, company?.id].filter(Boolean) as number[];
      const rec = await http<CrmRecord>('POST', `/records/${type}`, { props: form, associations: assoc });
      toast(`${OBJECTS[type].single} creado`);
      onCreated?.(rec);
      onClose();
      if (openAfter) navigate(recordUrl(type, rec.id));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title={OBJECTS[type].create} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn" disabled={busy} onClick={() => save(false)}>Crear</button>
      <button className="btn primary" disabled={busy} onClick={() => save(true)}>Crear y abrir</button>
    </>}>
      {fields.map((p) => (
        <label key={p.name} className="field">{p.label}{p.required || stage?.config.required_props?.includes(p.name) ? ' *' : ''}
          {p.name === 'dealstage'
            ? <StageSelect value={form.dealstage} onChange={(v) => set('dealstage', v)} pipelineId={form.pipeline} only={pipeline?.config.rules?.create_stages} />
            : <PropertyInput prop={p} type={type} value={form[p.name]} onChange={(v) => set(p.name, v)} />}
        </label>
      ))}
      {type !== 'company' && !associateWith && (
        <div className="field">
          <span className="small muted">Empresa asociada{needsCompany ? ' * (obligatoria en este pipeline)' : ''}</span>
          {company
            ? <div className="row"><Avatar name={company.name} type="company" domain={company.props?.domain} /><span className="grow">{company.name}</span><button className="btn sm ghost" onClick={() => setCompany(null)}>Quitar</button></div>
            : pickCompany ? <RecordPicker type="company" onPick={(r) => { setCompany(r); setPickCompany(false); }} />
              : <button className="btn sm" onClick={() => setPickCompany(true)}>Asociar empresa</button>}
        </div>
      )}
    </Drawer>
  );
}

// ---------- Filtros ----------

export const OPS: Record<string, Array<[string, string]>> = {
  text: [['contains', 'contiene'], ['eq', 'es igual a'], ['neq', 'no es'], ['not_contains', 'no contiene'], ['known', 'tiene valor'], ['unknown', 'está vacío']],
  enum: [['in', 'es alguno de'], ['not_in', 'no es ninguno de'], ['known', 'tiene valor'], ['unknown', 'está vacío']],
  number: [['gte', 'mayor o igual a'], ['lte', 'menor o igual a'], ['eq', 'igual a'], ['between', 'entre'], ['known', 'tiene valor'], ['unknown', 'está vacío']],
  date: [['within_last', 'en los últimos (días)'], ['within_next', 'en los próximos (días)'], ['before_days_ago', 'hace más de (días)'], ['gte', 'desde'], ['lte', 'hasta'], ['known', 'tiene valor'], ['unknown', 'está vacío']],
};
// Operadores que pueden venir de reglas o de la API aunque no estén en el desplegable de ese tipo de propiedad.
const OP_WORDS: Record<string, string> = { eq: 'es', neq: 'no es', gt: 'mayor a', lt: 'menor a', gte: 'desde', lte: 'hasta', in: 'es alguno de', not_in: 'no es ninguno de' };
export function opsFor(p?: { type: string; name: string }) {
  if (!p) return OPS.text;
  if (['enum', 'bool', 'owner', 'multienum'].includes(p.type) || p.name === 'dealstage' || p.name === 'pipeline') return OPS.enum;
  if (['number', 'currency'].includes(p.type)) return OPS.number;
  if (['date', 'datetime'].includes(p.type)) return OPS.date;
  return OPS.text;
}

// Lo que se puede filtrar: las propiedades del objeto, «Etiqueta» (si tiene) y datos del asociado
// («Empresa · Tipo de empresa», «Contacto · Origen»…), como el bloque «Asociación» de los filtros de HubSpot.
const ASSOC_FILTERS: Partial<Record<ObjectType, Array<[ObjectType, string]>>> = {
  deal: [['company', 'Empresa'], ['contact', 'Contacto']], contact: [['company', 'Empresa']], company: [['deal', 'Negocio'], ['contact', 'Contacto']], order: [['contact', 'Contacto'], ['company', 'Empresa']],
};
export function filterableProps(meta: Meta, type: ObjectType) {
  const own = propsOf(meta, type).filter((p) => !['source'].includes(p.name));
  const tags = meta.tags?.filter((t) => t.object_type === type) ?? [];
  const tagProp: Property[] = tags.length ? [{ ...own[0], name: '__tag', label: 'Etiqueta', type: 'enum', options: tags.map((t) => ({ value: String(t.id), label: t.name })), group_name: 'Etiquetas' }] : [];
  const assoc = (ASSOC_FILTERS[type] ?? []).flatMap(([t, l]) => propsOf(meta, t)
    .filter((p) => !['source', 'pipeline', 'dealstage'].includes(p.name) && !p.name.startsWith('num_'))
    .map((p) => ({ ...p, name: `${t}.${p.name}`, label: `${l} · ${p.label}`, group_name: `${l} asociada` })));
  const unidadProp: Property = { ...own[0], name: '__unidad', label: 'Unidad de negocio', type: 'enum', options: UNIDADES.map((u) => ({ value: u.key, label: u.label })), group_name: 'Unidad de negocio' };
  return [...own, unidadProp, ...tagProp, ...assoc];
}

export function optionsFor(meta: Meta, type: ObjectType, p: Property) {
  if (p.type === 'owner') return [{ value: 'me', label: 'Yo' }, ...meta.users.map((u) => ({ value: String(u.id), label: u.name }))];
  if (p.name === 'pipeline') return meta.pipelines.map((x) => ({ value: x.id, label: x.label }));
  if (p.name === 'dealstage') return meta.pipelines.flatMap((x) => x.stages.map((s) => ({ value: s.id, label: `${s.label} · ${x.label}` })));
  if (p.type === 'bool' && !p.options.length) return [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }];
  void type;
  return p.options;
}

export function FilterRow({ type, f, onChange, onRemove }: { type: ObjectType; f: Filter; onChange: (f: Filter) => void; onRemove: () => void }) {
  const { meta } = useMeta();
  const props = filterableProps(meta, type);
  const p = props.find((x) => x.name === f.prop);
  const ops = opsFor(p);
  const needsValue = !['known', 'unknown'].includes(f.op);
  const opts = p ? optionsFor(meta, type, p) : [];
  return (
    <div className="filter-row">
      <Select className="input" value={f.prop} onChange={(e) => {
        const np = props.find((x) => x.name === e.target.value);
        onChange({ prop: e.target.value, op: opsFor(np)[0][0] });
      }}>
        {props.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
      </Select>
      <Select className="input" value={f.op} onChange={(e) => onChange({ ...f, op: e.target.value })}>
        {ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {needsValue ? (
        (f.op === 'in' || f.op === 'not_in') ? (
          <MultiPick options={opts} values={(f.values ?? []).map(String)} onChange={(values) => onChange({ ...f, values })} />
        ) : f.op === 'between' ? (
          <div className="row"><input className="input" value={String(f.value ?? '')} onChange={(e) => onChange({ ...f, value: e.target.value })} /><input className="input" value={String(f.high ?? '')} onChange={(e) => onChange({ ...f, high: e.target.value })} /></div>
        ) : (
          <input className="input" type={p && ['date', 'datetime'].includes(p.type) && ['gte', 'lte'].includes(f.op) ? 'date' : 'text'} value={String(f.value ?? '')} onChange={(e) => onChange({ ...f, value: e.target.value })} />
        )
      ) : <span />}
      <button className="btn ghost icon" onClick={onRemove} aria-label="Quitar filtro"><Icon name="x" size={16} /></button>
    </div>
  );
}

export function MultiPick({ options, values, onChange, small }: { options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const label = values.length ? values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : 'Elegir…';
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`input select-like ellipsis${small ? ' sm' : ''}${values.length ? '' : ' placeholder'}`} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>{label}</button>
      {open && (
        <div className="popover" style={{ top: 38, left: 0 }}>
          {options.map((o) => (
            <label key={o.value} className="opt small">
              <input type="checkbox" checked={values.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function describeFilter(meta: Meta, type: ObjectType, f: Filter) {
  const p = propOf(meta, type, f.prop) ?? filterableProps(meta, type).find((x) => x.name === f.prop);
  const op = opsFor(p).find(([v]) => v === f.op)?.[1] ?? OP_WORDS[f.op] ?? f.op;
  const opts = p ? optionsFor(meta, type, p) : [];
  const val = f.values ? f.values.map((v) => opts.find((o) => o.value === String(v))?.label ?? v).join(', ') : f.value ?? '';
  return `${p?.label ?? f.prop} ${op} ${val}`.trim();
}

// Estado del cliente (lo calcula el CRM con las compras de Finnegans) como etiqueta de color.
export function EstadoCliente({ value }: { value: string }) {
  const slug = value.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '-');
  return <span className={`estado-cliente ec-${slug}`}>{value}</span>;
}

// Estado de entrega del pedido según sus remitos leídos (remitos.ts).
const ENTREGA: Record<string, [string, string]> = {
  completa: ['Completa', 'ok'], parcial: ['Faltan entregas', 'warn'], diferencias: ['Con diferencias', 'bad'],
  cerrada_con_faltante: ['Finalizada con faltante', 'info'], falta_remito: ['Falta el remito', 'warn'], por_revisar: ['Remito por revisar', 'info'],
};
export function EstadoEntrega({ value, title }: { value: unknown; title?: string }) {
  const e = ENTREGA[String(value ?? '')];
  if (!e) return null;
  return <span className={`tag ${e[1]} estado-entrega`} title={title}>{e[0]}</span>;
}

// Unidad de negocio con su ícono y su color.
export function UnidadBadge({ k, compact }: { k: UnidadKey; compact?: boolean }) {
  const u = UNIDADES.find((x) => x.key === k);
  if (!u) return null;
  return (
    <span className={`unidad u-${u.key}${compact ? ' compact' : ''}`} title={u.label}>
      <Icon name={u.icon} size={compact ? 12 : 13} />{!compact && u.label}
    </span>
  );
}

// Ancho de las columnas, como en HubSpot: se arrastra el borde derecho del encabezado; doble clic vuelve al automático.
// `onCommit` recibe los anchos nuevos al soltar (las listas los guardan en la vista).
export function useColumnResize(widths: Record<string, number> | undefined, onCommit: (w: Record<string, number>) => void) {
  const [live, setLive] = useState<{ col: string; w: number } | null>(null);
  const eff = live ? { ...(widths ?? {}), [live.col]: live.w } : widths ?? {};
  const start = (col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th');
    if (!th) return;
    const x0 = e.clientX;
    const w0 = th.getBoundingClientRect().width;
    let last = w0;
    const move = (ev: MouseEvent) => { last = Math.max(60, Math.min(900, Math.round(w0 + ev.clientX - x0))); setLive({ col, w: last }); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      setLive(null);
      if (Math.abs(last - w0) >= 2) onCommit({ ...(widths ?? {}), [col]: last });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.classList.add('col-resizing');
  };
  const reset = (col: string) => { const n = { ...(widths ?? {}) }; delete n[col]; onCommit(n); };
  const handle = (col: string) => (
    <span className="col-resize" role="separator" aria-orientation="vertical" aria-label="Cambiar el ancho de la columna"
      title="Arrastrá para cambiar el ancho · doble clic: automático"
      onMouseDown={(e) => start(col, e)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); reset(col); }} />
  );
  return { widths: eff, handle };
}

// Los anchos se aplican por posición de columna, sin tocar cada celda.
export function ColumnWidths({ scope, order, widths }: { scope: string; order: string[]; widths: Record<string, number> }) {
  const css = order.map((col, i) => (widths[col] ? `table.${scope} > thead > tr > th:nth-child(${i + 1}), table.${scope} > tbody > tr > td:nth-child(${i + 1}) {
    width: ${widths[col]}px; min-width: ${widths[col]}px; max-width: ${widths[col]}px; box-sizing: border-box; }` : '')).join('\n');
  return css ? <style>{css}</style> : null;
}

// Etapas de los pedidos (solo pedidos): cada una con un ícono propio y un color suave (styles.css, .e-*), en el tablero,
// la lista, la ficha, la vista previa y el desplegable para cambiarla.
const ETAPAS_PEDIDO: Record<string, { slug: string; d: string }> = {
  // Pedido confirmado: la planilla con el tilde.
  '4b27b500-f031-4927-9811-68a0b525cbae': { slug: 'confirmado', d: 'M9 3.5h6v3H9zM15 5h3v16H6V5h3M9 13.5l2 2 4-4.5' },
  // Listo para producción: la bandera de largada.
  '3725360f-519b-4b18-a593-494d60a29c9f': { slug: 'listo-produccion', d: 'M5 21V4M5 4h12l-2.5 4L17 12H5' },
  // Esperando boceto o confirmación: el reloj de arena.
  esperando_boceto: { slug: 'esperando', d: 'M7 3h10M7 21h10M8 3v3a4 4 0 0 0 8 0V3M8 21v-3a4 4 0 0 1 8 0v3M12 10v4' },
  // En producción: el engranaje.
  '1237498994': { slug: 'produccion', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' },
  // Listo para entregar: la caja cerrada.
  '1237498996': { slug: 'listo-entregar', d: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9' },
  // Entregado parcial: el camión en viaje.
  entregado_parcial: { slug: 'parcial', d: 'M2 6h11v10H2zM13 9h4l3 3.5V16h-7M8 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM18.5 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z' },
  // Entregado: el círculo con el tilde.
  '1237498998': { slug: 'entregado', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.8 2.8L16 10' },
  // Anulado: el círculo tachado.
  '3c85a297-e9ce-400b-b42e-9f16853d69d6': { slug: 'anulado', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.7 5.7l12.6 12.6' },
};
export const etapaPedidoSlug = (value: unknown) => ETAPAS_PEDIDO[String(value ?? '')]?.slug;

export function EtapaIcono({ value, size = 14 }: { value: unknown; size?: number }) {
  const e = ETAPAS_PEDIDO[String(value ?? '')];
  if (!e) return null;
  return (
    <span className={`etapa-ic e-${e.slug}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d={e.d} /></svg>
    </span>
  );
}

export function EtapaPedido({ value, label }: { value: unknown; label: string }) {
  const slug = etapaPedidoSlug(value);
  if (!slug) return <>{label}</>;
  return <span className={`etapa e-${slug}`}><EtapaIcono value={value} size={13} />{label}</span>;
}
