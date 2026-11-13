import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  // Sin usuario del CRM pero con nombre (por ejemplo, quien tiene asignado el PDV en ClickUp): el nombre con sus iniciales.
  if ((id == null || id === '') && name) return size === 'xs' ? <span className="user-inline"><Avatar name={name} size="xs" />{name}</span>
    : <span className="user-chip" title={name}><Avatar name={name} size={size} /><span className="ellipsis">{name}</span></span>;
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

// Con un cuadro (Modal) encima, Escape cierra el cuadro y no la vista previa de atrás (el visor de bocetos, que se abre
// solo al subir uno, cerraba todo). Los dos escuchan en `window` y el orden depende de cuál se registró último: si el
// lateral va primero, ve que hay un cuadro abierto; si va después, el cuadro ya marcó la tecla (`defaultPrevented`).
let modalesAbiertos = 0;

// `aside`: un panel pegado a la izquierda del lateral (la conversación del pedido en la vista previa). `actions`: botones
// en la cabecera, antes de la cruz.
export function Drawer({ title, onClose, children, footer, clear, aside, actions }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; clear?: boolean; aside?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !modalesAbiertos && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    // Clic fuera del panel: se cierra (en todas las vistas previas y en los paneles laterales). Afuera, el mouse muestra
    // un círculo con una cruz. La rueda sigue moviendo la lista o el tablero de atrás.
    <div className={`overlay drawer-overlay${clear ? ' clear' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onWheel={clear ? (e) => { if (e.target === e.currentTarget) scrollBehind(e) } : undefined}>
      {aside && <div className="drawer-aside">{aside}</div>}
      <div className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head"><h2>{title}</h2>{actions}<button className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={18} /></button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => { modalesAbiertos++; return () => { modalesAbiertos--; }; }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
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

// Al crear algo se lo puede asociar con registros que ya existen de los otros tres objetos (pedido de Rodrigo del 10/11/2026).
const ASOCIABLES: Record<ObjectType, ObjectType[]> = {
  deal: ['company', 'contact', 'order'],
  contact: ['company', 'deal', 'order'],
  company: ['contact', 'deal', 'order'],
  order: ['company', 'contact', 'deal'],
};

// Alta de registro: propiedades del formulario de creación y asociaciones con lo que ya existe. `associateWith` es el
// registro desde cuya ficha se crea: queda asociado siempre y no se puede quitar.
export function CreateRecord({ type, onClose, onCreated, associateWith, defaults }: {
  type: ObjectType; onClose: () => void; onCreated?: (r: CrmRecord) => void; associateWith?: CrmRecord; defaults?: Record<string, any>;
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
  const [picked, setPicked] = useState<Record<ObjectType, CrmRecord[]>>({ contact: [], company: [], deal: [], order: [] });
  const [picking, setPicking] = useState<ObjectType | null>(null);
  const fijo = (t: ObjectType) => (associateWith?.type === t ? [associateWith] : []);
  const elegidos = (t: ObjectType) => [...fijo(t), ...picked[t]];
  const pipeline = type === 'deal' ? meta.pipelines.find((p) => p.id === form.pipeline) : undefined;
  const stage = pipeline?.stages.find((s) => s.id === form.dealstage);
  // Con contactos elegidos decide el servidor: cuenta la empresa principal de cada uno.
  const needsCompany = !!pipeline?.config.rules?.require_company;
  // Campos del alta + los que pide la etapa elegida (propiedades condicionales).
  const fields = useMemo(() => {
    const base = propsOf(meta, type).filter((p) => p.in_create_form || p.required);
    const extra = (stage?.config.required_props ?? []).map((n) => propOf(meta, type, n)).filter((p): p is Property => !!p && !base.includes(p));
    return [...base, ...extra];
  }, [meta, type, stage]);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === 'pipeline') next.dealstage = firstStage(v);
    return next;
  });
  // Un pedido va en un solo negocio: un pedido nuevo admite uno, y a un negocio nuevo no se le suma un pedido que ya está en otro.
  const tope = (t: ObjectType) => (type === 'order' && t === 'deal' ? 1 : Infinity);
  const elegir = async (t: ObjectType, r: CrmRecord) => {
    if (type === 'deal' && t === 'order') {
      const res = await http<{ associations: Record<ObjectType, CrmRecord[]> }>('GET', `/records/order/${r.id}`).catch(() => null);
      const otro = res?.associations.deal[0];
      if (otro) { toast(`El pedido «${r.name}» ya está en el negocio «${otro.name}». Un pedido va en un solo negocio.`, true); return; }
    }
    setPicked((p) => ({ ...p, [t]: [...p[t], r] }));
    if (elegidos(t).length + 1 >= tope(t)) setPicking(null);
  };
  const quitar = (t: ObjectType, id: number) => setPicked((p) => ({ ...p, [t]: p[t].filter((x) => x.id !== id) }));
  const save = async (openAfter: boolean) => {
    if (needsCompany && !elegidos('company').length && !elegidos('contact').length) {
      toast(`En «${pipeline!.label}» el negocio tiene que tener una empresa asociada.`, true); return;
    }
    const missing = stage ? missingFor(stage, form) : [];
    if (missing.length) { toast(`Para crear en «${stage!.label}» falta: ${missing.map((m) => propOf(meta, type, m)?.label ?? m).join(', ')}.`, true); return; }
    setBusy(true);
    try {
      const assoc = [associateWith?.id, ...ASOCIABLES[type].flatMap((t) => picked[t].map((r) => r.id))].filter(Boolean) as number[];
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
      <div className="create-assoc">
        <div className="create-assoc-title">Asociar con</div>
        {ASOCIABLES[type].map((t) => {
          const lista = elegidos(t);
          const obligatoria = t === 'company' && needsCompany;
          return (
            <div key={t} className="create-assoc-group">
              <div className="row">
                <span className="grow">{OBJECTS[t].plural}{obligatoria ? ' *' : ''}
                  {obligatoria && !lista.length && <span className="small muted"> · obligatoria en este pipeline (o un contacto con empresa)</span>}
                  {tope(t) === 1 && <span className="small muted"> · uno solo</span>}</span>
                {lista.length < tope(t) && (
                  <button className="btn sm ghost" onClick={() => setPicking(picking === t ? null : t)}>
                    {picking === t ? 'Cerrar' : <><Icon name="plus" size={14} /> Asociar</>}
                  </button>
                )}
              </div>
              {lista.map((r) => (
                <div key={r.id} className="row create-assoc-item">
                  <Avatar name={r.name} type={t} domain={r.props?.domain} email={r.props?.email} />
                  <span className="grow ellipsis">{r.name}</span>
                  {r.id === associateWith?.id
                    ? <span className="small muted">Desde la ficha</span>
                    : <button className="btn sm ghost" aria-label={`Quitar ${r.name}`} onClick={() => quitar(t, r.id)}>Quitar</button>}
                </div>
              ))}
              {picking === t && (
                <RecordPicker type={t} exclude={lista.map((r) => r.id)} onPick={(r) => elegir(t, r)}
                  placeholder={`Buscar ${OBJECTS[t].plural.toLowerCase()} existentes…`} />
              )}
            </div>
          );
        })}
      </div>
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
  if (p.type === 'owner') return [{ value: 'me', label: 'Yo' }, ...meta.users.filter((u) => !u.deleted_at).map((u) => ({ value: String(u.id), label: u.name }))];
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
      <button type="button" className={`input select-like ellipsis${small ? ' sm' : ''}${values.length ? '' : ' placeholder'}`} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title={values.length ? label : undefined}><span className="select-value">{label}</span></button>
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
  // $ Pendiente de Anticipo: el billete (el «$» ya está en el nombre).
  '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03': { slug: 'anticipo', d: 'M2.5 6.5h19v11h-19zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 9.5v5M18 9.5v5' },
  // Pendiente Boceto Digital: el lápiz.
  'aa99e8d0-c1d5-4071-b915-d240bbb1aed9': { slug: 'boceto-digital', d: 'M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19zM13.5 7l3.5 3.5M4 20h16' },
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

// Quién mueve cada etapa del pedido (pedido de Rodrigo del 10/11/2026): el tablero agrupa sus columnas en un recuadro
// por área. Ventas, hasta que la vendedora lo pasa a producción; Producción, mientras se produce (lo mueve ClickUp según
// los artículos); Logística, la entrega. «Anulado» no es de nadie y queda afuera.
export type AreaPedido = 'ventas' | 'produccion' | 'logistica';
export const AREAS_PEDIDO: Record<AreaPedido, { label: string; nota: string }> = {
  ventas: { label: 'Ventas', nota: 'Las mueven las vendedoras y el backoffice' },
  produccion: { label: 'Producción', nota: 'Las mueve producción en ClickUp' },
  logistica: { label: 'Logística', nota: 'Las mueve logística al entregar' },
};
const AREA_DE_ETAPA: Record<string, AreaPedido> = {
  confirmado: 'ventas', anticipo: 'ventas', 'boceto-digital': 'ventas', 'listo-produccion': 'ventas',
  esperando: 'produccion', produccion: 'produccion', 'listo-entregar': 'produccion',
  parcial: 'logistica', entregado: 'logistica',
};
export const areaPedido = (value: unknown): AreaPedido | null => AREA_DE_ETAPA[etapaPedidoSlug(value) ?? ''] ?? null;

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

// Quién tiene el pedido en producción (asignado en ClickUp, produccion.ts) con su foto, y cuántos artículos están listos.
// Para que las vendedoras sepan a quién preguntar: en la tarjeta del tablero de pedidos y en los productos del pedido.
export interface PersonaProduccion { id: number; nombre: string; user_id: number | null; foto: string | null }
export function PersonaProd({ p, size = 'sm' }: { p: PersonaProduccion; size?: 'sm' | 'xs' }) {
  return p.user_id ? <UserAvatar id={p.user_id} size={size} /> : <Avatar name={p.nombre} photo={p.foto} size={size} />;
}
export function QuienProduce({ asignados, listos, total, conNombre = true }: { asignados: PersonaProduccion[]; listos?: number; total?: number; conNombre?: boolean }) {
  if (!asignados.length && !total) return null;
  const nombres = asignados.map((p) => p.nombre).join(', ');
  const avance = total ? `${listos ?? 0} de ${total} artículos listos` : '';
  return (
    <span className="prod-quien" title={[nombres ? `En producción: ${nombres}` : 'Sin asignar en producción', avance].filter(Boolean).join('. ')}>
      <Icon name="printer" size={13} />
      {asignados.length > 0 && <span className="avatar-stack">{asignados.slice(0, 3).map((p) => <PersonaProd key={p.id} p={p} />)}</span>}
      {conNombre && <span className="ellipsis">{asignados.length ? asignados.map((p) => p.nombre.split(' ')[0]).join(', ') : 'Sin asignar'}</span>}
      {!!total && <span className={`prod-avance${(listos ?? 0) >= total ? ' ok' : ''}`}>{listos ?? 0}/{total}</span>}
    </span>
  );
}

// Estado de un artículo en ClickUp, con el color de ClickUp: una pastilla suave con su ícono (styles.css, .st-pec).
// Producción, los productos del pedido (ficha y vista previa) y la conversación lo muestran igual.
// tintaSobre: la letra que se lee sobre un color lleno (blanca, u oscura si el color es claro).
export function tintaSobre(color: string) {
  const h = color.replace('#', '');
  const x = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Number.isFinite(l) && l > 0.4 ? '#1f2328' : '#ffffff';
}
export const estiloEstado = (color: string | null | undefined) => {
  const e = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#87909e';
  return { ['--e' as string]: e, ['--e-ink' as string]: tintaSobre(e) } as CSSProperties;
};
// Un iconito para cada estado de la lista PEC (trazos de 24 × 24, del color de la letra), para reconocerlos de un
// vistazo. Un estado nuevo de ClickUp que no está acá lleva el circulito de ClickUp.
const ICONOS_ESTADO: Record<string, string> = {
  'ingreso de pedido': 'M4 13h4.5l1.5 2.5h4l1.5-2.5H20M4 13l2.5-8h11L20 13v6H4zM12 4.5v6M9.5 8 12 10.5 14.5 8',   // bandeja que entra
  pdv: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',                                                   // la orden
  'en espera de confirmación': 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9',          // reloj de arena
  'personales': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0',                                    // una persona
  'boceto pendiente': 'M4 20l4-1L19 8a2.1 2.1 0 0 0-3-3L5 16zM14 7l3 3',                                     // lápiz
  'pedido al proveedor': 'M21 3 3 10.5l7 2.5 2.5 7zM10 13 21 3',                                              // avión de papel
  'ingreso proveedor/ stock': 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9',                    // caja
  'en control de depósito': 'M9 3.5h6v3H9zM7.5 5H5v16h14V5h-2.5M9 14l2 2 4-4.5',                             // planilla con tilde
  'en el impresor': 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',                                             // impresora
  'impresión aprobada': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.8 2.8L16.5 9',                         // tilde en círculo
  'articulo con logo': 'M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4zM19 3v4M17 5h4',              // brillo
  'en revision': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8.5 11l2 2 3.5-4',                         // lupa
  'parcial entregado': 'M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7M6.5 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM17 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z', // camión
  'listo para entergar': 'M21 7.5 12 3 3 7.5v9l9 4.5 9-4.5zM8.5 12l2.5 2.5 4.5-5',                             // caja con tilde
  'entregados': 'M2 12.5l4.5 4.5L17 6.5M11 16l1 1L22 6.5',                                                     // doble tilde
  'anulado': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',                                         // prohibido
};
const iconoEstado = (estado: string) => ICONOS_ESTADO[estado.toLowerCase().trim()] ?? ICONOS_ESTADO[estado.toLowerCase().trim().replace('listo para entregar', 'listo para entergar')];
// El estado como se lee: con mayúscula al principio y con los acentos y erratas de los nombres de ClickUp corregidos
// (solo a la vista: en ClickUp se sigue escribiendo el estado tal cual).
const NOMBRE_ESTADO: Record<string, string> = {
  'listo para entergar': 'listo para entregar', 'en revision': 'en revisión', 'articulo con logo': 'artículo con logo',
  'ingreso proveedor/ stock': 'ingreso proveedor / stock', 'impresion aprobada': 'impresión aprobada',
};
export function nombreEstado(estado: string) {
  const t = NOMBRE_ESTADO[estado.toLowerCase().trim()] ?? estado.toLowerCase().trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Sin estado';
}
export function EstadoClickup({ estado, color }: { estado: string; color: string | null | undefined }) {
  const d = iconoEstado(estado ?? '');
  return (
    // El texto va en su propio span: así, si no entra, se corta con «…» (el nombre entero queda en el cartelito).
    <span className={`st-pec${d ? ' con-icono' : ''}`} style={estiloEstado(color)} title={nombreEstado(estado ?? '')}>
      {d && <svg className="st-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>}
      <span className="st-txt">{nombreEstado(estado ?? '')}</span>
    </span>
  );
}
