import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, Cargando, fmtDate, fmtRelative, recordUrl, userOf, OBJECTS, type Activity, type ObjectType } from '../lib';
import { Avatar } from '../components';
import { TareaPanel } from '../TareaPanel';
import { ConversacionPanel, refrescarNoLeidas, useNoLeidas, type ConvResumen } from '../pages/Conversacion';
import { TareaRapida, useParametro } from './Movil';
import { Fallo, useCarga, useCerrarConAtras, usePuedeEscribir, useVolver } from './base';

// Tareas y Chat en el celular (versión celular, fase 4). Tareas: Hoy (con las vencidas arriba) · Próximas · Hechas, se
// tildan y se pasan de día con un toque, y cada una se abre en el panel de siempre (pasos, colaboradores, comentarios).
// Chat: la bandeja de las conversaciones que sigue (Sin leer · Todas) y cada conversación a pantalla completa.

// ---------- Tareas ----------

type Pestana = 'hoy' | 'proximas' | 'hechas';
const DIA = 86_400_000;
const inicioHoy = () => new Date().setHours(0, 0, 0, 0);
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const hora = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

// Cuándo vence, corto: «10:00» si es hoy, «Vencida ayer», «Mañana 10:00», «Jueves 10:00» o la fecha.
export function cuandoTarea(iso: string | null) {
  if (!iso) return { texto: 'Sin fecha', vencida: false };
  const d = new Date(iso);
  const dias = Math.round((new Date(d).setHours(0, 0, 0, 0) - inicioHoy()) / DIA);
  if (dias < 0) return { texto: dias === -1 ? 'Vencida ayer' : `Vencida hace ${-dias} días`, vencida: true };
  if (dias === 0) return { texto: d.getHours() || d.getMinutes() ? hora(d) : 'Hoy', vencida: false };
  if (dias === 1) return { texto: `Mañana ${hora(d)}`, vencida: false };
  if (dias < 7) return { texto: `${DIAS[d.getDay()].replace(/^./, (c) => c.toUpperCase())} ${hora(d)}`, vencida: false };
  return { texto: fmtDate(iso), vencida: false };
}

// El panel de siempre de una tarea, que en el celular también se cierra con el botón Atrás.
export function PanelTarea({ id, onClose, onChange }: { id: number; onClose: () => void; onChange?: () => void }) {
  useCerrarConAtras(onClose);
  return <TareaPanel id={id} onClose={onClose} onChange={onChange} />;
}

export function useCambiosTarea(sacar: (t: Activity) => void, recargar: () => void) {
  const toast = useToast();
  async function cambiar(t: Activity, patch: Record<string, unknown>, aviso: string, deshacer?: Record<string, unknown>) {
    sacar(t);
    try {
      await http('PATCH', `/activities/${t.id}`, patch);
      toast(aviso, false, deshacer ? { label: 'Deshacer', onClick: () => { http('PATCH', `/activities/${t.id}`, deshacer).then(recargar, (e) => toast((e as Error).message, true)); } } : undefined);
    } catch (e) { toast((e as Error).message, true); recargar(); }
  }
  return {
    completar: (t: Activity) => (t.status === 'COMPLETED'
      ? cambiar(t, { status: 'NOT_STARTED' }, 'Tarea reabierta')
      : cambiar(t, { status: 'COMPLETED' }, 'Tarea completada', { status: t.status ?? 'NOT_STARTED' })),
    posponer: (t: Activity) => {
      const d = new Date(Math.max(Date.now(), Date.parse(t.due_at ?? '') || 0) + DIA);
      return cambiar(t, { due_at: d.toISOString() }, `Pasada al ${fmtDate(d)}`, { due_at: t.due_at });
    },
  };
}

export function TareasMovil() {
  const puede = usePuedeEscribir();
  const [pestana, setPestana] = useState<Pestana>('hoy');
  const [tareaParam, sacarParam] = useParametro('tarea');
  const [abierta, setAbierta] = useState<number | null>(Number(tareaParam) || null);
  const [nueva, setNueva] = useState(false);
  const carga = useCarga(() => {
    const q = pestana === 'hechas' ? { status: 'done', limit: 50 } : { due: pestana === 'hoy' ? 'today' : 'upcoming', limit: 100 };
    return http<{ results: Activity[] }>('GET', `/tasks${qs(q)}`).then((r) => r.results);
  }, [pestana]);
  const { completar, posponer } = useCambiosTarea((t) => carga.setDatos((ts) => ts?.filter((x) => x.id !== t.id) ?? null), carga.recargar);
  const tareas = carga.datos;

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
        const g = t.due_at ? cuandoTarea(t.due_at).texto.replace(/ \d+:\d+$/, '') : 'Sin fecha';
        const ult = grupos[grupos.length - 1];
        if (ult && ult[0] === g) ult[1].push(t); else grupos.push([g, [t]]);
      }
    } else grupos.push(['Completadas en los últimos días', tareas]);
  }
  return (
    <div className="m-pag">
      <div className="m-pag-cab"><h1>Tareas</h1><span className="grow" />
        {puede && <button type="button" className="btn primary" onClick={() => setNueva(true)}><Icon name="plus" size={16} />Nueva</button>}</div>
      <div className="m-seg m-seg-3" role="tablist" aria-label="Qué tareas">
        {([['hoy', 'Hoy'], ['proximas', 'Próximas'], ['hechas', 'Hechas']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={pestana === k} className={`m-seg-op${pestana === k ? ' active' : ''}`} onClick={() => setPestana(k)}>{l}</button>
        ))}
      </div>
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!tareas && !carga.error && <Cargando />}
      {tareas && !tareas.length && (
        <div className="m-al-dia"><span className="m-al-dia-ico"><Icon name="check" size={22} /></span><b>{pestana === 'hoy' ? 'Nada pendiente para hoy' : pestana === 'proximas' ? 'No hay tareas próximas' : 'Todavía no completaste tareas'}</b></div>
      )}
      {grupos.map(([titulo, ts, mal]) => (
        <section key={titulo} className="m-sec" aria-label={titulo}>
          <div className="m-sec-cab"><h2 className={mal ? 'overdue' : ''}>{titulo}</h2><span className="muted small">{ts.length}</span></div>
          {ts.map((t) => <FilaTarea key={t.id} t={t} puede={puede} onCheck={() => completar(t)} onPosponer={pestana === 'hechas' ? undefined : () => posponer(t)} onAbrir={() => setAbierta(t.id)} />)}
        </section>
      ))}
      {abierta && <PanelTarea id={abierta} onClose={() => { setAbierta(null); sacarParam(); carga.recargar(); }} onChange={carga.recargar} />}
      {nueva && <TareaRapida onClose={() => setNueva(false)} onCreada={carga.recargar} />}
    </div>
  );
}

export function FilaTarea({ t, puede, onCheck, onPosponer, onAbrir }: { t: Activity; puede: boolean; onCheck: () => void; onPosponer?: () => void; onAbrir: () => void }) {
  const hecha = t.status === 'COMPLETED';
  const cuando = hecha ? { texto: `Hecha ${fmtRelative(t.completed_at ?? t.due_at)}`, vencida: false } : cuandoTarea(t.due_at);
  const link = t.links[0];
  return (
    <div className="m-item m-tarea">
      {puede
        ? <button type="button" className="m-check-zona" onClick={onCheck} aria-label={hecha ? `Reabrir: ${t.subject}` : `Completar: ${t.subject}`}>
            <span className={`check-round m-check${hecha ? ' on' : ''}`} aria-hidden="true">{hecha && <Icon name="check" />}</span></button>
        : <span className="m-check-zona" aria-hidden="true"><span className={`check-round m-check${hecha ? ' on' : ''}`} /></span>}
      <button type="button" className="m-item-txt m-tarea-txt" onClick={onAbrir}>
        <b className={hecha ? 'tachada' : ''}>{t.subject}</b>
        <small><span className={cuando.vencida ? 'overdue' : 'muted'}>{cuando.texto}</span>
          {link && <span className="m-tarea-link"> · {link.name}</span>}
          {t.comentarios ? <span className="muted"> · {t.comentarios} coment.</span> : null}</small>
      </button>
      {t.sin_leer ? <span className="m-pill nuevo" aria-label={`${t.sin_leer} comentarios sin leer`}>{t.sin_leer}</span> : null}
      {puede && onPosponer && <button type="button" className="btn ghost m-mas-dia" onClick={onPosponer} aria-label={`Pasar un día: ${t.subject}`}>+1 día</button>}
    </div>
  );
}

// ---------- Chat ----------

export function ChatMovil() {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const sinLeer = useNoLeidas();
  const [solo, setSolo] = useState(() => sinLeer.no_leidos > 0);
  const carga = useCarga(() => http<{ conversaciones: ConvResumen[] }>('GET', `/conversaciones${qs({ no_leidas: solo ? 1 : undefined, limite: 100 })}`).then((r) => r.conversaciones),
    [solo, sinLeer.no_leidos]);
  const lista = carga.datos;
  return (
    <div className="m-pag">
      <div className="m-seg" role="tablist" aria-label="Qué conversaciones">
        <button type="button" role="tab" aria-selected={solo} className={`m-seg-op${solo ? ' active' : ''}`} onClick={() => setSolo(true)}>
          Sin leer{sinLeer.no_leidos ? <span className="m-pill nuevo">{sinLeer.no_leidos}</span> : null}</button>
        <button type="button" role="tab" aria-selected={!solo} className={`m-seg-op${!solo ? ' active' : ''}`} onClick={() => setSolo(false)}>Todas</button>
      </div>
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!lista && !carga.error && <Cargando />}
      {lista && !lista.length && (solo
        ? <div className="m-al-dia"><span className="m-al-dia-ico"><Icon name="check" size={22} /></span><b>Estás al día</b><small className="muted">No tenés mensajes sin leer.</small>
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
                  {c.no_leidos > 0 && <span className={`m-badge-fila${c.menciones ? ' mencion' : ''}`} aria-label={`${c.no_leidos} sin leer`}>{c.no_leidos}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Una conversación a pantalla completa: arriba, volver y el nombre (que lleva a la ficha); al abrirla queda leída. Con
// ?mensaje=… (el link de una mención) va directo a ese mensaje.
export function ChatAbierto() {
  const { tipo = 'order', id = '0' } = useParams();
  const navigate = useNavigate();
  const volver = useVolver();
  const toast = useToast();
  const type = tipo as ObjectType;
  const [mensaje] = useParametro('mensaje');
  const carga = useCarga(() => http<{ record: { name: string } }>('GET', `/records/${type}/${id}`).then((r) => r.record.name), [type, id]);
  const noLeida = async () => {
    try { await http('POST', `/records/${type}/${id}/conversacion/no-leido`); refrescarNoLeidas(); toast('Queda como no leída: la retomás desde Chat'); navigate('/conversaciones'); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="m-chat">
      <header className="m-asis-cab">
        <button type="button" className="btn ghost icon" onClick={() => { refrescarNoLeidas(); volver('/conversaciones'); }} aria-label="Volver"><Icon name="chevron" size={22} /></button>
        <Link to={recordUrl(type, Number(id))} className="m-asis-tit m-chat-tit"><b>{carga.datos ?? (carga.error ? OBJECTS[type]?.single : '…')}</b><small>{OBJECTS[type]?.single} · ver la ficha</small></Link>
        <button type="button" className="btn ghost m-no-leida" onClick={noLeida} title="Marcar como no leída, para retomarla después"><Icon name="eye" size={18} /><span>No leída</span></button>
      </header>
      <ConversacionPanel type={type} recordId={Number(id)} className="en-ficha m-conv m-conv-full" mensaje={Number(mensaje) || undefined} />
    </div>
  );
}
