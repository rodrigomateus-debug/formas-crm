import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, fmtDate, fmtRelative, recordUrl, userOf, Icon, OBJECTS, Cargando, type Activity, type ObjectType, type Meta } from './lib';
import { Avatar, Drawer, Modal, MultiPick, RecordPicker, UserAvatar, toLocalInput, userOption } from './components';
import { Cuerpo, Escribir, textoPlano } from './pages/Conversacion';
import { Select } from './Select';

// Tareas en equipo, como en ClickUp y Asana (pedido de Rodrigo del 18/11/2026). Una tarea tiene un responsable principal
// y colaboradores, se relaciona con pedidos, negocios, empresas y contactos (y aparece en la actividad y la conversación
// de cada uno, como siempre), tiene pasos (checklist) y una conversación del equipo con @menciones.

export const ESTADOS: Array<{ k: string; label: string; cls: string }> = [
  { k: 'NOT_STARTED', label: 'Por hacer', cls: 'por-hacer' },
  { k: 'IN_PROGRESS', label: 'En curso', cls: 'en-curso' },
  { k: 'WAITING', label: 'En espera', cls: 'en-espera' },
  { k: 'COMPLETED', label: 'Hecha', cls: 'hecha' },
];
export const estadoDe = (k: string | null) => ESTADOS.find((e) => e.k === k) ?? ESTADOS[0];
export const PRIORIDADES: Array<{ k: string; label: string; cls: string }> = [
  { k: 'high', label: 'Alta', cls: 'bad' }, { k: 'medium', label: 'Media', cls: 'warn' }, { k: 'low', label: 'Baja', cls: 'info' }, { k: 'none', label: 'Sin prioridad', cls: '' },
];
export const TIPOS: Record<string, string> = { todo: 'Por hacer', call: 'Llamar', email: 'Mail', whatsapp: 'WhatsApp', meeting: 'Reunión' };
export interface Paso { id: string; texto: string; hecho: boolean }
export const pasosDe = (t: Activity): Paso[] => (Array.isArray(t.meta?.checklist) ? t.meta.checklist : []);
const TIPOS_REL: ObjectType[] = ['order', 'deal', 'company', 'contact'];
const usuariosActivos = (meta: Meta) => meta.users.filter((u) => u.active && !u.deleted_at);

export function EstadoTarea({ status }: { status: string | null }) {
  const e = estadoDe(status);
  return <span className={`estado-tarea ${e.cls}`}>{e.label}</span>;
}

// El equipo de la tarea: el principal primero (con aro) y los colaboradores encimados.
export function EquipoTarea({ owner, colaboradores = [], max = 3 }: { owner: number | null; colaboradores?: number[]; max?: number }) {
  const { meta } = useMeta();
  const todos = [owner, ...colaboradores].filter((x): x is number => x != null);
  if (!todos.length) return <span className="muted small">Sin asignar</span>;
  const nombres = todos.map((id, i) => `${userOf(meta, id)?.name ?? `Usuario ${id}`}${i === 0 && owner != null ? ' (principal)' : ''}`).join(', ');
  return (
    <span className="equipo-tarea" title={nombres}>
      {todos.slice(0, max).map((id, i) => <span key={id} className={i === 0 && owner != null ? 'principal' : ''}><UserAvatar id={id} size="sm" /></span>)}
      {todos.length > max && <span className="mas">+{todos.length - max}</span>}
    </span>
  );
}

// Relacionar con un pedido, negocio, empresa o contacto: el tipo y el buscador.
function Relacionar({ excluir, onPick, onCancel }: { excluir: number[]; onPick: (l: Activity['links'][number]) => void; onCancel: () => void }) {
  const [tipo, setTipo] = useState<ObjectType>('order');
  return (
    <div className="tarea-relacionar">
      <div className="row">
        <div className="seg sm" role="group" aria-label="Tipo de registro">
          {TIPOS_REL.map((t) => <button key={t} type="button" className={tipo === t ? 'on' : ''} aria-pressed={tipo === t} onClick={() => setTipo(t)}><Icon name={t} size={13} />{OBJECTS[t].single}</button>)}
        </div>
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancelar</button>
      </div>
      <RecordPicker key={tipo} type={tipo} exclude={excluir} onPick={(r) => onPick({ id: r.id, type: tipo, name: r.name })} />
    </div>
  );
}

export function ChipRelacion({ l, onQuitar }: { l: { id: number; type: ObjectType; name: string }; onQuitar?: () => void }) {
  return (
    <span className={`chip rel-chip ${l.type}`} title={`${OBJECTS[l.type]?.single ?? ''}: ${l.name}`}>
      <Icon name={l.type} size={12} />
      <Link to={recordUrl(l.type, l.id)} className="ellipsis" onClick={(e) => e.stopPropagation()}>{l.name}</Link>
      {onQuitar && <button type="button" aria-label={`Quitar la relación con ${l.name}`} onClick={(e) => { e.stopPropagation(); onQuitar(); }}><Icon name="x" size={12} /></button>}
    </span>
  );
}

// ---------- Conversación de la tarea ----------

interface Comentario { id: number; activity_id: number; user_id: number | null; body: string; menciones: number[]; responde_a: number | null; source: string;
  editado_at: string | null; borrado_at: string | null; created_at: string }

function ComentarioVista({ c, meId, esAdmin, citado, onCambio, onResponder }: {
  c: Comentario; meId: number; esAdmin: boolean; citado?: Comentario; onCambio: (c: Comentario) => void; onResponder: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const u = userOf(meta, c.user_id);
  const mio = c.user_id === meId;
  if (c.borrado_at) return <div className="conv-msg borrado"><div className="msg-av" /><div className="msg-main"><span className="muted small">Comentario borrado</span></div></div>;
  return (
    <div className={`conv-msg${mio ? ' mio' : ''}${c.menciones.includes(meId) && !mio ? ' mencionado' : ''}`} id={`com-${c.id}`}>
      <div className="msg-av"><UserAvatar id={c.user_id} /></div>
      <div className="msg-main">
        <div className="msg-head"><b>{u?.name ?? 'Alguien'}</b>{c.source === 'mcp' && <span className="tag">con Claude</span>}
          <time dateTime={c.created_at} title={fmtDate(c.created_at, true)}>{fmtRelative(c.created_at)}</time></div>
        {citado && <div className="msg-cita"><b>{userOf(meta, citado.user_id)?.name ?? 'Alguien'}</b> <span className="ellipsis">{citado.borrado_at ? 'Comentario borrado' : textoPlano(citado.body)}</span></div>}
        {editando
          ? <Escribir inicial={c.body} autoFocus onCancelar={() => setEditando(false)} onEnviar={async (body) => {
            try { onCambio(await http<Comentario>('PATCH', `/tarea-comentarios/${c.id}`, { body })); setEditando(false); return true; }
            catch (e) { toast((e as Error).message, true); return false; }
          }} />
          : <Cuerpo body={c.body} meId={meId} />}
        {c.editado_at && !editando && <div className="msg-pie"><span className="muted" title={fmtDate(c.editado_at, true)}>(editado)</span></div>}
      </div>
      {!editando && (
        <div className="msg-acciones">
          <button className="btn ghost sm icon" title="Responder" aria-label="Responder" onClick={onResponder}><Icon name="reply" size={14} /></button>
          {mio && <button className="btn ghost sm icon" title="Editar" aria-label="Editar" onClick={() => setEditando(true)}><Icon name="edit" size={14} /></button>}
          {(mio || esAdmin) && <button className="btn ghost sm icon" title="Borrar" aria-label="Borrar" onClick={async () => {
            if (!confirm('¿Borrar este comentario?')) return;
            try { await http('DELETE', `/tarea-comentarios/${c.id}`); onCambio({ ...c, borrado_at: new Date().toISOString(), body: '' }); } catch (e) { toast((e as Error).message, true); }
          }}><Icon name="trash" size={14} /></button>}
        </div>
      )}
    </div>
  );
}

function ConversacionTarea({ id, onLeido }: { id: number; onLeido: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [lista, setLista] = useState<Map<number, Comentario> | null>(null);
  const [respondiendo, setRespondiendo] = useState<Comentario | null>(null);
  const desde = useRef('');
  const fin = useRef<HTMLDivElement>(null);
  const leido = useRef(0);
  const traer = useCallback(async () => {
    const r = await http<{ comentarios: Comentario[]; at: string }>('GET', `/tasks/${id}/comentarios${qs({ desde: desde.current || undefined })}`);
    desde.current = r.at;
    if (r.comentarios.length || !lista) setLista((m) => { const n = new Map(m ?? []); for (const c of r.comentarios) n.set(c.id, c); return n; });
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    desde.current = ''; setLista(null);
    traer().catch((e) => toast((e as Error).message, true));
    // Mientras está abierta y a la vista, las novedades cada 15 segundos.
    const t = setInterval(() => { if (document.visibilityState === 'visible') traer().catch(() => {}); }, 15_000);
    return () => clearInterval(t);
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const orden = lista ? [...lista.values()].sort((a, b) => a.id - b.id) : [];
  const ultimo = orden.length ? orden[orden.length - 1].id : 0;
  // Leída hasta el último (y sus avisos), y abajo de todo.
  useEffect(() => {
    if (!lista) return;
    if (ultimo > leido.current) {
      // Al abrir la tarea se queda arriba (el título); lo que llega después, se muestra.
      if (leido.current) fin.current?.scrollIntoView({ block: 'nearest' });
      leido.current = ultimo;
      http('POST', `/tasks/${id}/leido`, { hasta: ultimo }).then(onLeido).catch(() => {});
    }
  }, [ultimo, lista]);   // eslint-disable-line react-hooks/exhaustive-deps
  const cambiar = (c: Comentario) => setLista((m) => new Map(m ?? []).set(c.id, c));
  return (
    <div className="tarea-conv">
      <h3>Conversación <span className="muted small">{orden.filter((c) => !c.borrado_at).length || ''}</span></h3>
      {!lista && <Cargando chico />}
      {lista && !orden.length && <div className="muted small">Todavía no hay comentarios. Escribí para coordinar con el equipo (con @ avisás a alguien).</div>}
      <div className="tarea-conv-lista">
        {orden.map((c) => <ComentarioVista key={c.id} c={c} meId={meta.me.id} esAdmin={meta.me.role === 'admin'} citado={c.responde_a ? lista?.get(c.responde_a) : undefined}
          onCambio={cambiar} onResponder={() => setRespondiendo(c)} />)}
        <div ref={fin} />
      </div>
      <Escribir key={id} respondiendo={respondiendo ? <><b>{userOf(meta, respondiendo.user_id)?.name}</b> {textoPlano(respondiendo.body).slice(0, 120)}</> : undefined}
        onCancelarRespuesta={() => setRespondiendo(null)}
        onEnviar={async (body) => {
          try {
            const c = await http<Comentario>('POST', `/tasks/${id}/comentarios`, { body, responde_a: respondiendo?.id });
            cambiar(c); setRespondiendo(null); leido.current = c.id; onLeido();
            setTimeout(() => fin.current?.scrollIntoView({ block: 'nearest' }), 30);
            return true;
          } catch (e) { toast((e as Error).message, true); return false; }
        }} />
    </div>
  );
}

// ---------- Pasos (checklist) ----------

function Pasos({ pasos, onGuardar }: { pasos: Paso[]; onGuardar: (p: Paso[]) => void }) {
  const [nuevo, setNuevo] = useState('');
  const hechos = pasos.filter((p) => p.hecho).length;
  const agregar = () => { const t = nuevo.trim(); if (!t) return; onGuardar([...pasos, { id: Math.random().toString(36).slice(2, 10), texto: t, hecho: false }]); setNuevo(''); };
  return (
    <div className="tarea-pasos">
      <h3>Pasos {pasos.length > 0 && <span className="muted small num">{hechos}/{pasos.length}</span>}</h3>
      {pasos.length > 0 && <div className="pasos-barra"><i style={{ width: `${(hechos / pasos.length) * 100}%` }} /></div>}
      {pasos.map((p) => (
        <div key={p.id} className={`paso${p.hecho ? ' hecho' : ''}`}>
          <button type="button" className={`check-round${p.hecho ? ' on' : ''}`} aria-label={p.hecho ? 'Marcar pendiente' : 'Marcar hecho'}
            onClick={() => onGuardar(pasos.map((x) => (x.id === p.id ? { ...x, hecho: !x.hecho } : x)))}>{p.hecho && <Icon name="check" />}</button>
          <input className="input bare" defaultValue={p.texto} aria-label="Paso"
            onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== p.texto) onGuardar(pasos.map((x) => (x.id === p.id ? { ...x, texto: t } : x))); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          <button type="button" className="btn ghost sm icon" aria-label="Quitar el paso" onClick={() => onGuardar(pasos.filter((x) => x.id !== p.id))}><Icon name="x" size={13} /></button>
        </div>
      ))}
      <div className="paso nuevo">
        <Icon name="plus" size={14} />
        <input className="input bare" placeholder="Agregar un paso (Enter)" value={nuevo} onChange={(e) => setNuevo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') agregar(); }} onBlur={agregar} />
      </div>
    </div>
  );
}

// ---------- El panel de la tarea ----------

export function TareaPanel({ id, onClose, onChange }: { id: number; onClose: () => void; onChange?: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [t, setT] = useState<Activity | null>(null);
  const [relacionando, setRelacionando] = useState(false);
  const cargar = useCallback(() => http<Activity>('GET', `/tasks/${id}`).then(setT).catch((e) => { toast((e as Error).message, true); onClose(); }), [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setT(null); setRelacionando(false); cargar(); }, [cargar]);
  const guardar = async (patch: Record<string, unknown>) => {
    if (!t) return;
    const antes = t;
    setT({ ...t, ...patch, meta: patch.meta ? { ...t.meta, ...(patch.meta as object) } : t.meta } as Activity);
    try { const r = await http<Activity>('PATCH', `/activities/${id}`, patch); setT((x) => ({ ...r, colaboradores: x?.colaboradores, comentarios: x?.comentarios, sin_leer: x?.sin_leer })); onChange?.(); }
    catch (e) { setT(antes); toast((e as Error).message, true); }
  };
  const colaboradores = async (ids: number[]) => {
    if (!t) return;
    const antes = t;
    setT({ ...t, colaboradores: ids });
    try { const r = await http<{ colaboradores: number[] }>('PUT', `/tasks/${id}/colaboradores`, { colaboradores: ids }); setT((x) => (x ? { ...x, colaboradores: r.colaboradores } : x)); onChange?.(); }
    catch (e) { setT(antes); toast((e as Error).message, true); }
  };
  const relacionar = async (recordId: number) => {
    setRelacionando(false);
    try { await http('PATCH', `/activities/${id}`, { links: [recordId] }); await cargar(); onChange?.(); } catch (e) { toast((e as Error).message, true); }
  };
  const quitarRelacion = async (recordId: number) => {
    try { await http('DELETE', `/activities/${id}/links/${recordId}`); await cargar(); onChange?.(); } catch (e) { toast((e as Error).message, true); }
  };
  const borrar = async () => {
    if (!confirm('¿Borrar esta tarea? Se borra también de la actividad de los registros relacionados.')) return;
    try { await http('DELETE', `/activities/${id}`); toast('Tarea borrada'); onChange?.(); onClose(); } catch (e) { toast((e as Error).message, true); }
  };
  const hecha = t?.status === 'COMPLETED';
  const vencida = t && !hecha && t.due_at && Date.parse(t.due_at) < Date.now();
  const cols = t?.colaboradores ?? [];
  const libres = usuariosActivos(meta).filter((u) => u.id !== t?.owner_id && !cols.includes(u.id));
  return (
    <Drawer title="Tarea" onClose={onClose} actions={t && (
      <button type="button" className={`btn sm${hecha ? '' : ' primary'}`} onClick={() => guardar({ status: hecha ? 'NOT_STARTED' : 'COMPLETED' })}>
        <Icon name="check" size={14} />{hecha ? 'Reabrir' : 'Completar'}
      </button>
    )} footer={t && <>
      <span className="muted small grow">Creada {t.created_by ? <>por {userOf(meta, t.created_by)?.name ?? 'alguien'} </> : null}{fmtRelative(t.occurred_at)}{t.source !== 'crm' ? ` · ${t.source === 'mcp' ? 'con Claude' : t.source}` : ''}</span>
      <button className="btn danger sm" onClick={borrar}><Icon name="trash" size={14} />Borrar</button>
    </>}>
      {!t ? <Cargando /> : (
        <div className="tarea">
          <textarea key={`s${t.id}`} className={`tarea-titulo${hecha ? ' hecha' : ''}`} rows={1} defaultValue={t.subject} aria-label="Título"
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.subject) guardar({ subject: v }); else e.target.value = t.subject; }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          <div className="seg tarea-estados" role="group" aria-label="Estado">
            {ESTADOS.map((e) => <button key={e.k} type="button" className={`${t.status === e.k ? 'on' : ''} ${e.cls}`} aria-pressed={t.status === e.k} onClick={() => guardar({ status: e.k })}>
              <i className={`estado-punto ${e.cls}`} />{e.label}</button>)}
          </div>
          <dl className="tarea-campos">
            <dt>Responsable</dt>
            <dd><Select className="input" value={t.owner_id ?? ''} onChange={(e) => guardar({ owner_id: e.target.value ? Number(e.target.value) : null })} aria-label="Responsable principal">
              {usuariosActivos(meta).concat(meta.users.filter((u) => u.id === t.owner_id && (!u.active || u.deleted_at))).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
            </Select></dd>
            <dt>Colaboradores</dt>
            <dd className="tarea-colabs">
              {cols.map((uid) => {
                const u = userOf(meta, uid);
                return <span key={uid} className="chip colab"><Avatar name={u?.name ?? '?'} photo={u?.photo_url} size="xs" />{u?.name ?? `Usuario ${uid}`}
                  <button type="button" aria-label={`Sacar a ${u?.name ?? uid}`} onClick={() => colaboradores(cols.filter((x) => x !== uid))}><Icon name="x" size={12} /></button></span>;
              })}
              {libres.length > 0 && <Select className="input sumar" value="" onChange={(e) => e.target.value && colaboradores([...cols, Number(e.target.value)])} aria-label="Sumar colaborador">
                <option value="">+ Sumar</option>
                {libres.map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
              </Select>}
            </dd>
            <dt>Vence</dt>
            <dd className="row"><input key={`d${t.due_at}`} className={`input${vencida ? ' overdue' : ''}`} type="datetime-local" defaultValue={t.due_at ? toLocalInput(t.due_at) : ''}
              onBlur={(e) => { if (!e.target.value) return; const v = new Date(e.target.value).toISOString(); if (v !== t.due_at) guardar({ due_at: v }); }} aria-label="Vence" />
              {vencida && <span className="tag bad">Vencida</span>}</dd>
            <dt>Prioridad</dt>
            <dd><Select className="input" value={t.priority ?? 'none'} onChange={(e) => guardar({ priority: e.target.value })} aria-label="Prioridad">
              {PRIORIDADES.map((p) => <option key={p.k} value={p.k}>{p.label}</option>)}</Select></dd>
            <dt>Tipo</dt>
            <dd><Select className="input" value={t.task_type ?? 'todo'} onChange={(e) => guardar({ task_type: e.target.value })} aria-label="Tipo">
              {Object.entries(TIPOS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></dd>
            <dt>Relacionada con</dt>
            <dd className="tarea-rels">
              {t.links.map((l) => <ChipRelacion key={l.id} l={l} onQuitar={() => quitarRelacion(l.id)} />)}
              {!relacionando && <button type="button" className="btn ghost sm" onClick={() => setRelacionando(true)}><Icon name="plus" size={13} />Relacionar</button>}
            </dd>
          </dl>
          {relacionando && <Relacionar excluir={t.links.map((l) => l.id)} onPick={(l) => relacionar(l.id)} onCancel={() => setRelacionando(false)} />}
          <div>
            <h3>Descripción</h3>
            <textarea key={`b${t.id}`} className="input tarea-desc" rows={3} placeholder="Qué hay que hacer, links, datos…" defaultValue={t.body}
              onBlur={(e) => { if (e.target.value !== t.body) guardar({ body: e.target.value }); }} />
          </div>
          <Pasos pasos={pasosDe(t)} onGuardar={(p) => guardar({ meta: { checklist: p } })} />
          <ConversacionTarea id={t.id} onLeido={() => onChange?.()} />
        </div>
      )}
    </Drawer>
  );
}

// ---------- Nueva tarea ----------

export function NuevaTarea({ onClose, onCreated, inicial }: { onClose: () => void; onCreated: (t: Activity) => void; inicial?: { owner_id?: number; links?: Activity['links'] } }) {
  const { meta } = useMeta();
  const toast = useToast();
  const manana = new Date(Date.now() + 86_400_000); manana.setHours(10, 0, 0, 0);
  const [f, setF] = useState({ subject: '', body: '', owner_id: meta.me.id as number, due_at: manana.toISOString(), priority: 'none', task_type: 'todo', status: 'NOT_STARTED', ...(inicial?.owner_id ? { owner_id: inicial.owner_id } : {}) });
  const [cols, setCols] = useState<string[]>([]);
  const [rels, setRels] = useState<Activity['links']>(inicial?.links ?? []);
  const [relacionando, setRelacionando] = useState(false);
  const [busy, setBusy] = useState(false);
  const crear = async () => {
    if (!f.subject.trim()) { toast('La tarea necesita un título', true); return; }
    setBusy(true);
    try {
      const t = await http<Activity>('POST', '/activities', { ...f, type: 'task', links: rels.map((r) => r.id), colaboradores: cols.map(Number) });
      toast('Tarea creada');
      onCreated(t);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nueva tarea" onClose={onClose} wide footer={<>
      <span className="grow" />
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={busy} onClick={crear}>Crear tarea</button>
    </>}>
      <input className="input tarea-titulo-nuevo" autoFocus placeholder="Título de la tarea" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) crear(); }} />
      <div className="tarea-nueva-grid">
        <label className="field">Responsable<Select className="input" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: Number(e.target.value) })}>
          {usuariosActivos(meta).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}</Select></label>
        <label className="field">Colaboradores<MultiPick options={usuariosActivos(meta).filter((u) => u.id !== f.owner_id).map((u) => ({ value: String(u.id), label: u.name }))}
          values={cols.filter((c) => Number(c) !== f.owner_id)} onChange={setCols} resumen="Nadie más" /></label>
        <label className="field">Vence<input className="input" type="datetime-local" value={toLocalInput(f.due_at)} onChange={(e) => e.target.value && setF({ ...f, due_at: new Date(e.target.value).toISOString() })} /></label>
        <label className="field">Prioridad<Select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
          {PRIORIDADES.map((p) => <option key={p.k} value={p.k}>{p.label}</option>)}</Select></label>
        <label className="field">Estado<Select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {ESTADOS.map((e) => <option key={e.k} value={e.k}>{e.label}</option>)}</Select></label>
        <label className="field">Tipo<Select className="input" value={f.task_type} onChange={(e) => setF({ ...f, task_type: e.target.value })}>
          {Object.entries(TIPOS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
      </div>
      <div className="field">Relacionada con
        <div className="tarea-rels">
          {rels.map((l) => <ChipRelacion key={l.id} l={l} onQuitar={() => setRels(rels.filter((x) => x.id !== l.id))} />)}
          {!relacionando && <button type="button" className="btn ghost sm" onClick={() => setRelacionando(true)}><Icon name="plus" size={13} />Pedido, negocio, empresa o contacto</button>}
        </div>
      </div>
      {relacionando && <Relacionar excluir={rels.map((r) => r.id)} onPick={(r) => { setRels([...rels, r]); setRelacionando(false); }} onCancel={() => setRelacionando(false)} />}
      <label className="field">Descripción<textarea className="input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
    </Modal>
  );
}
