import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, Cargando, fmtDate, fmtRelative, recordUrl, userOf, OBJECTS, type Activity, type ObjectType } from '../lib';
import { Avatar } from '../components';
import { TareaPanel } from '../TareaPanel';
import { ConversacionPanel, refrescarNoLeidas, useNoLeidas, type ConvResumen } from '../pages/Conversacion';
import { TareaRapida } from './Movil';

// Tareas y Chat en el celular (versión celular, fase 4). Tareas: Hoy (con las vencidas arriba) · Próximas · Hechas, se
// tildan y se pasan de día con un toque, y cada una se abre en el panel de siempre (pasos, colaboradores, comentarios).
// Chat: la bandeja de las conversaciones que sigue (Sin leer · Todas) y cada conversación a pantalla completa.

// ---------- Tareas ----------

type Pestana = 'hoy' | 'proximas' | 'hechas';
const DIA = 86_400_000;
const inicioHoy = () => new Date().setHours(0, 0, 0, 0);

export function TareasMovil() {
  const toast = useToast();
  const [pestana, setPestana] = useState<Pestana>('hoy');
  const [tareas, setTareas] = useState<Activity[] | null>(null);
  const [version, setVersion] = useState(0);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [nueva, setNueva] = useState(false);
  useEffect(() => {
    setTareas(null);
    const q = pestana === 'hechas' ? { status: 'done', limit: 50 } : { due: pestana === 'hoy' ? 'today' : 'upcoming', limit: 100 };
    http<{ results: Activity[] }>('GET', `/tasks${qs(q)}`).then((r) => setTareas(r.results), () => setTareas([]));
  }, [pestana, version]);
  const recargar = () => setVersion((v) => v + 1);

  async function cambiar(t: Activity, patch: Record<string, unknown>, aviso: string, deshacer?: Record<string, unknown>) {
    setTareas((ts) => ts?.filter((x) => x.id !== t.id) ?? null);
    try {
      await http('PATCH', `/activities/${t.id}`, patch);
      toast(aviso, false, deshacer ? { label: 'Deshacer', onClick: () => { http('PATCH', `/activities/${t.id}`, deshacer).then(recargar, () => undefined); } } : undefined);
    } catch (e) { toast((e as Error).message, true); recargar(); }
  }
  const completar = (t: Activity) => (t.status === 'COMPLETED'
    ? cambiar(t, { status: 'NOT_STARTED' }, 'Tarea reabierta')
    : cambiar(t, { status: 'COMPLETED' }, 'Tarea completada', { status: t.status ?? 'NOT_STARTED' }));
  const posponer = (t: Activity) => {
    const d = new Date(Math.max(Date.now(), Date.parse(t.due_at ?? '') || 0) + DIA);
    cambiar(t, { due_at: d.toISOString() }, `Pasada al ${fmtDate(d)}`, { due_at: t.due_at });
  };

  // Hoy: las vencidas primero, aparte. Próximas: por día.
  const grupos: Array<[string, Activity[], boolean?]> = [];
  if (tareas) {
    if (pestana === 'hoy') {
      const venc = tareas.filter((t) => t.due_at && Date.parse(t.due_at) < inicioHoy());
      const hoy = tareas.filter((t) => !venc.includes(t));
      if (venc.length) grupos.push(['Vencidas', venc, true]);
      if (hoy.length) grupos.push(['Hoy', hoy]);
    } else if (pestana === 'proximas') {
      for (const t of tareas) {
        const g = t.due_at ? diaLindo(t.due_at) : 'Sin fecha';
        const ult = grupos[grupos.length - 1];
        if (ult && ult[0] === g) ult[1].push(t); else grupos.push([g, [t]]);
      }
    } else grupos.push(['Completadas en los últimos días', tareas]);
  }
  return (
    <div className="m-pag">
      <div className="m-pag-cab"><h1>Tareas</h1><span className="grow" />
        <button type="button" className="btn primary" onClick={() => setNueva(true)}><Icon name="plus" size={16} />Nueva</button></div>
      <div className="m-seg m-seg-3" role="tablist" aria-label="Cuáles">
        {([['hoy', 'Hoy'], ['proximas', 'Próximas'], ['hechas', 'Hechas']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={pestana === k} className={`m-seg-op${pestana === k ? ' active' : ''}`} onClick={() => setPestana(k)}>{l}</button>
        ))}
      </div>
      {!tareas && <Cargando />}
      {tareas && !tareas.length && (
        <div className="m-al-dia"><span><Icon name="check" size={22} /></span><b>{pestana === 'hoy' ? 'Nada pendiente para hoy' : pestana === 'proximas' ? 'No hay tareas próximas' : 'Todavía no completaste tareas'}</b></div>
      )}
      {grupos.map(([titulo, ts, mal]) => (
        <section key={titulo} className="m-sec">
          <div className="m-sec-cab"><h2 className={mal ? 'overdue' : ''}>{titulo}</h2><span className="muted small">{ts.length}</span></div>
          {ts.map((t) => <FilaTarea key={t.id} t={t} onCheck={() => completar(t)} onPosponer={pestana === 'hechas' ? undefined : () => posponer(t)} onAbrir={() => setAbierta(t.id)} />)}
        </section>
      ))}
      {abierta && <TareaPanel id={abierta} onClose={() => { setAbierta(null); recargar(); }} onChange={recargar} />}
      {nueva && <TareaRapida onClose={() => setNueva(false)} onCreada={recargar} />}
    </div>
  );
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function diaLindo(iso: string) {
  const d = new Date(iso); const ini = new Date(d); ini.setHours(0, 0, 0, 0);
  const n = Math.round((ini.getTime() - inicioHoy()) / DIA);
  if (n === 1) return 'Mañana';
  if (n > 1 && n < 7) return DIAS[d.getDay()].replace(/^./, (c) => c.toUpperCase());
  return fmtDate(iso);
}

export function FilaTarea({ t, onCheck, onPosponer, onAbrir }: { t: Activity; onCheck: () => void; onPosponer?: () => void; onAbrir: () => void }) {
  const hecha = t.status === 'COMPLETED';
  const vencida = !hecha && t.due_at && Date.parse(t.due_at) < inicioHoy();
  const link = t.links[0];
  return (
    <div className="m-item">
      <button type="button" className={`check-round m-check${hecha ? ' on' : ''}`} onClick={onCheck} aria-label={hecha ? `Reabrir: ${t.subject}` : `Completar: ${t.subject}`}>{hecha && <Icon name="check" />}</button>
      <button type="button" className="m-item-txt m-tarea-txt" onClick={onAbrir}>
        <b className={hecha ? 'tachada' : ''}>{t.subject}</b>
        <small className={vencida ? 'overdue' : 'muted'}>
          {hecha ? `Hecha ${fmtRelative(t.completed_at ?? t.due_at)}` : t.due_at ? fmtDate(t.due_at, true) : 'Sin fecha'}
          {link ? ` · ${link.name}` : ''}{t.comentarios ? ` · ${t.comentarios} coment.` : ''}
        </small>
      </button>
      {t.sin_leer ? <span className="m-pill nuevo">{t.sin_leer}</span> : null}
      {onPosponer && <button type="button" className="btn ghost sm" onClick={onPosponer} aria-label={`Pasar un día: ${t.subject}`}>+1 día</button>}
    </div>
  );
}

// ---------- Chat ----------

export function ChatMovil() {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const sinLeer = useNoLeidas();
  const [solo, setSolo] = useState(() => sinLeer.no_leidos > 0);
  const [lista, setLista] = useState<ConvResumen[] | null>(null);
  useEffect(() => {
    http<{ conversaciones: ConvResumen[] }>('GET', `/conversaciones${qs({ no_leidas: solo ? 1 : undefined, limite: 100 })}`)
      .then((r) => setLista(r.conversaciones), () => setLista([]));
  }, [solo, sinLeer.no_leidos]);
  return (
    <div className="m-pag">
      <div className="m-pag-cab"><h1>Chat</h1></div>
      <div className="m-seg" role="tablist" aria-label="Cuáles">
        <button type="button" role="tab" aria-selected={solo} className={`m-seg-op${solo ? ' active' : ''}`} onClick={() => setSolo(true)}>
          Sin leer{sinLeer.no_leidos ? <span className="m-pill nuevo">{sinLeer.no_leidos}</span> : null}</button>
        <button type="button" role="tab" aria-selected={!solo} className={`m-seg-op${!solo ? ' active' : ''}`} onClick={() => setSolo(false)}>Todas</button>
      </div>
      {!lista && <Cargando />}
      {lista && !lista.length && (solo
        ? <div className="m-al-dia"><span><Icon name="check" size={22} /></span><b>Estás al día</b><small className="muted">No tenés mensajes sin leer.</small>
            <button type="button" className="btn" onClick={() => setSolo(false)}>Ver todas</button></div>
        : <div className="m-vacio m-vacio-solo">Todavía no seguís ninguna conversación. Se siguen al escribir en un pedido o negocio, o cuando te mencionan.</div>)}
      {lista && lista.length > 0 && (
        <div className="m-sec">
          {lista.map((c) => {
            const autor = c.ultimo ? (c.ultimo.user_id === meta.me.id ? 'Vos' : userOf(meta, c.ultimo.user_id)?.name.split(' ')[0] ?? 'Alguien') : null;
            return (
              <button key={`${c.object_type}-${c.record_id}`} type="button" className={`m-conv-fila${c.no_leidos ? ' sin-leer' : ''}`} onClick={() => navigate(`/conversaciones/${c.object_type}/${c.record_id}`)}>
                <Avatar name={c.name} type={c.object_type} />
                <span className="m-item-txt">
                  <b>{c.name}</b>
                  <small>{c.menciones > 0 && <span className="m-mencion">@ </span>}{c.ultimo ? <><em>{autor}:</em> {c.ultimo.body.replace(/\s+/g, ' ')}</> : OBJECTS[c.object_type]?.single}</small>
                </span>
                <span className="m-conv-lado">
                  {c.ultimo && <small className="muted">{fmtRelative(c.ultimo.created_at, true)}</small>}
                  {c.no_leidos > 0 && <span className={`m-badge-fila${c.menciones ? ' mencion' : ''}`}>{c.no_leidos}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Una conversación a pantalla completa: arriba, volver y el nombre (que lleva a la ficha); al abrirla queda leída.
export function ChatAbierto() {
  const { tipo = 'order', id = '0' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const type = tipo as ObjectType;
  const [nombre, setNombre] = useState('');
  useEffect(() => {
    http<{ record: { name: string } }>('GET', `/records/${type}/${id}`).then((r) => setNombre(r.record.name), () => setNombre(OBJECTS[type]?.single ?? ''));
  }, [type, id]);
  const noLeida = async () => {
    try { await http('POST', `/records/${type}/${id}/conversacion/no-leido`); refrescarNoLeidas(); toast('Marcada como no leída'); navigate('/conversaciones'); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="m-chat">
      <header className="m-asis-cab">
        <button type="button" className="btn ghost icon" onClick={() => { refrescarNoLeidas(); navigate(-1); }} aria-label="Volver"><Icon name="chevron" size={22} /></button>
        <Link to={recordUrl(type, Number(id))} className="m-asis-tit m-chat-tit"><b>{nombre || '…'}</b><small>{OBJECTS[type]?.single} · ver la ficha</small></Link>
        <button type="button" className="btn ghost icon" onClick={noLeida} aria-label="Marcar como no leída" title="Marcar como no leída"><Icon name="eye" size={20} /></button>
      </header>
      <ConversacionPanel type={type} recordId={Number(id)} className="en-ficha m-conv m-conv-full" />
    </div>
  );
}
