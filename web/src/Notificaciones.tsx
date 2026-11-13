import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { http, qs, useMeta, Icon, recordUrl, fmtDate, fmtRelative, userOf, type ObjectType } from './lib';
import { UserAvatar } from './components';
import { refrescarNoLeidas } from './pages/Conversacion';

// La campanita de arriba a la derecha (pedido de Rodrigo del 13/11/2026; src/worker/notificaciones.ts): lo último que te
// pasó en el CRM —te mencionaron, te respondieron, te asignaron una tarea o un registro, faltan entregas— con lo no leído
// marcado. Un clic lleva al mensaje (o a la tarea, o al pedido) y la marca leída. Se actualiza sola cada 45 segundos.

export interface Notificacion {
  id: number; kind: 'mencion' | 'respuesta' | 'tarea' | 'registro' | 'entrega' | string; record_id: number | null; object_type: ObjectType | null;
  name: string | null; activity_id: number | null; subject: string | null; mensaje_id: number | null; texto: string | null; by_user: number | null;
  created_at: string; leido_at: string | null;
  encargo_id?: number | null; encargo_destino?: string | null; encargo_fecha?: string | null;
}
interface Res { no_leidas: number; items: Notificacion[] }

let estado: Res = { no_leidas: 0, items: [] };
const oyentes = new Set<(r: Res) => void>();
let pidiendo: Promise<void> | null = null;
export function refrescarNotificaciones() {
  pidiendo ??= http<Res>('GET', `/notificaciones${qs({ limite: 40 })}`)
    .then((r) => { estado = r; oyentes.forEach((f) => f(r)); }, () => undefined)
    .finally(() => { pidiendo = null; });
  return pidiendo;
}
const publicar = (r: Res) => { estado = r; oyentes.forEach((f) => f(r)); };
let reloj: ReturnType<typeof setInterval> | null = null;
export function useNotificaciones() {
  const [v, setV] = useState(estado);
  useEffect(() => {
    oyentes.add(setV);
    if (!reloj) {
      refrescarNotificaciones();
      reloj = setInterval(() => { if (document.visibilityState === 'visible') refrescarNotificaciones(); }, 45_000);
    }
    return () => { oyentes.delete(setV); };
  }, []);
  return v;
}

// Qué dice cada una y adónde lleva.
function describir(n: Notificacion, quien: string): { titulo: ReactNode; detalle: string | null; icono: string; destino: string } {
  const reg = <b>{n.name ?? 'un registro'}</b>;
  const aReg = n.record_id && n.object_type ? recordUrl(n.object_type, n.record_id) : '/';
  switch (n.kind) {
    case 'mencion': return { titulo: <><b>{quien}</b> te mencionó en {reg}</>, detalle: n.texto, icono: 'at', destino: `${aReg}?conversacion=1&mensaje=${n.mensaje_id ?? ''}` };
    case 'respuesta': return { titulo: <><b>{quien}</b> te respondió en {reg}</>, detalle: n.texto, icono: 'reply', destino: `${aReg}?conversacion=1&mensaje=${n.mensaje_id ?? ''}` };
    case 'tarea': return { titulo: <><b>{quien}</b> te asignó una tarea</>, detalle: n.subject, icono: 'task', destino: '/tasks' };
    case 'encargo': return { titulo: <>Tu encargo a <b>{n.encargo_destino ?? 'un destino'}</b>{n.encargo_fecha ? ` (${Number(n.encargo_fecha.slice(8))}/${Number(n.encargo_fecha.slice(5, 7))})` : ''}</>, detalle: n.texto, icono: 'route', destino: `/recorridos?tab=encargos&encargo=${n.encargo_id ?? ''}` };
    case 'entrega': return { titulo: <>Faltan entregas en {reg}</>, detalle: 'Según los remitos, todavía falta entregar algo.', icono: 'truck', destino: aReg };
    default: return { titulo: <><b>{quien}</b> te asignó {reg}</>, detalle: null, icono: n.object_type ?? 'note', destino: aReg };
  }
}

export function Campanita() {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const res = useNotificaciones();
  const [abierto, setAbierto] = useState(false);
  const [soloSinLeer, setSoloSinLeer] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!abierto) return;
    refrescarNotificaciones();
    const fuera = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); window.removeEventListener('keydown', esc); };
  }, [abierto]);
  // Cambia enseguida en pantalla y después se confirma con el servidor.
  const marcar = async (ids: number[] | null, leidas: boolean) => {
    const ahora = new Date().toISOString();
    const cambian = res.items.filter((n) => (!ids || ids.includes(n.id)) && !n.leido_at === leidas).length;
    publicar({
      no_leidas: ids ? Math.max(0, res.no_leidas + (leidas ? -cambian : cambian)) : 0,
      items: res.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, leido_at: leidas ? n.leido_at ?? ahora : null } : n)),
    });
    try { await http('POST', leidas ? '/notificaciones/leidas' : '/notificaciones/no-leidas', ids ? { ids } : {}); } catch { /* se corrige solo en la próxima vuelta */ }
    refrescarNotificaciones();
  };
  const abrir = (n: Notificacion, destino: string) => {
    setAbierto(false);
    if (!n.leido_at) marcar([n.id], true);
    navigate(destino);
    setTimeout(() => refrescarNoLeidas(), 1500);
  };
  const lista = soloSinLeer ? res.items.filter((n) => !n.leido_at) : res.items;
  const hay = res.no_leidas;
  return (
    <div ref={ref} className="campanita">
      <button type="button" className={`btn ghost icon campanita-btn${hay ? ' con' : ''}`} onClick={() => setAbierto(!abierto)} aria-haspopup="dialog" aria-expanded={abierto}
        aria-label={hay ? `Notificaciones: ${hay} sin leer` : 'Notificaciones'} title={hay ? `${hay} sin leer` : 'Notificaciones'}>
        <Icon name="bell" size={20} />
        {hay > 0 && <span className="campanita-n">{hay > 99 ? '99+' : hay}</span>}
      </button>
      {abierto && (
        <div className="popover notif-pop" role="dialog" aria-label="Notificaciones">
          <div className="notif-head">
            <b>Notificaciones</b>
            <span className="grow" />
            <div className="seg sm" role="group" aria-label="Cuáles">
              <button className={!soloSinLeer ? 'on' : ''} onClick={() => setSoloSinLeer(false)}>Todas</button>
              <button className={soloSinLeer ? 'on' : ''} onClick={() => setSoloSinLeer(true)}>Sin leer{hay ? ` (${hay})` : ''}</button>
            </div>
          </div>
          <div className="notif-lista">
            {!lista.length && (
              <div className="notif-vacio"><Icon name="bell" size={22} /><div>{soloSinLeer ? 'Estás al día: no tenés nada sin leer.' : 'Todavía no hay notificaciones.'}</div>
                <div className="small muted">Acá aparece cuando te mencionan, te responden o te asignan algo.</div></div>
            )}
            {lista.map((n) => {
              const quien = n.by_user ? userOf(meta, n.by_user)?.name.split(' ')[0] ?? 'Alguien' : 'El CRM';
              const d = describir(n, quien);
              return (
                <div key={n.id} className={`notif${n.leido_at ? '' : ' nueva'}`}>
                  <button type="button" className="notif-cuerpo" onClick={() => abrir(n, d.destino)}>
                    <span className="notif-av">
                      {n.by_user ? <UserAvatar id={n.by_user} size="sm" /> : <span className="notif-ic"><Icon name={d.icono as 'bell'} size={16} /></span>}
                      <span className={`notif-tipo ${n.kind}`}><Icon name={d.icono as 'bell'} size={10} /></span>
                    </span>
                    <span className="notif-texto">
                      <span className="notif-titulo">{d.titulo}</span>
                      {d.detalle && <span className="notif-detalle">{d.detalle}</span>}
                      <span className="notif-hora" title={fmtDate(n.created_at, true)}>{fmtRelative(n.created_at, true)}</span>
                    </span>
                  </button>
                  <button type="button" className="notif-punto" onClick={() => marcar([n.id], !n.leido_at)}
                    title={n.leido_at ? 'Marcar como no leída' : 'Marcar como leída'} aria-label={n.leido_at ? 'Marcar como no leída' : 'Marcar como leída'}>
                    <span />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="notif-pie">
            <button type="button" className="btn ghost sm" disabled={!hay} onClick={() => marcar(null, true)}><Icon name="check" size={14} />Marcar todas como leídas</button>
            <span className="grow" />
            <button type="button" className="btn ghost sm" onClick={() => { setAbierto(false); navigate('/conversaciones'); }}>Ver conversaciones</button>
          </div>
        </div>
      )}
    </div>
  );
}
