import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { http, useMeta, useToast, Icon, verComo, type ObjectType } from '../lib';
import { Avatar, CreateRecord } from '../components';
import { TEMAS, useTema } from '../theme';
import { Campanita } from '../Notificaciones';
import { GlobalSearch } from '../Buscador';
import NotasProductosPage from '../pages/NotasProductos';
import { useNoLeidas } from '../pages/Conversacion';
import { usarVersionCompleta, type PerfilMovil } from './modo';
import { useCerrarConAtras, usePuedeEscribir, useVolver } from './base';
import Hoy from './Hoy';
import { RecorridosMovil, EncargoAsistente } from './RecorridosMovil';
import { ClientesLista, FichaCliente, AltaCliente, PreguntaLlamada } from './ClientesMovil';
import { NegociosLista, FichaNegocio, AltaNegocio, PedidosLista, FichaPedido } from './VentasMovil';
import { TareasMovil, ChatMovil, ChatAbierto } from './TareasChatMovil';
import { HoyLogistica, DiaMovil, EntregasMovil, ChoferesMovil } from './LogisticaMovil';
import { HoyProduccion, ProduccionLista, FichaPdv } from './ProduccionMovil';
import Chispin from '../Chispin';
import './movil.css';

// Versión celular del Hub (pedido de Rodrigo del 18/11/2026): en el teléfono, los perfiles Ventas, Logística y Producción
// no ven el CRM de escritorio achicado sino una app simple, con lo esencial de cada uno. Misma dirección, mismo login y la
// misma API; lo que no está acá se abre con «Ver versión completa». Barra abajo, Ventas: Hoy · Clientes · ＋ · Ventas ·
// Chat; Logística: Hoy · Día · ＋ · Entregas · Chat (LogisticaMovil.tsx); Producción: Hoy · Producción · ＋ · Pedidos ·
// Chat (ProduccionMovil.tsx).
// Raiz.tsx decide cuál se dibuja (modo.ts). Ver docs/MOVIL.md.

// Las fichas: arriba, en vez del avatar, la flecha para volver a su lista.
const FICHAS: Array<[RegExp, string]> = [[/^\/produccion\/[^/]+$/, '/produccion'], [/^\/companies\/\d+$/, '/companies'], [/^\/contacts\/\d+$/, '/contacts'], [/^\/deals\/\d+$/, '/deals'], [/^\/orders\/\d+$/, '/orders']];
// Las pantallas con lista ya tienen su buscador: arriba va el nombre, no un segundo buscador.
const TITULOS: Array<[RegExp, string]> = [[/^\/(companies|contacts)$/, 'Clientes'], [/^\/deals$/, 'Ventas'], [/^\/orders$/, 'Pedidos'], [/^\/tasks$/, 'Tareas'],
  [/^\/conversaciones$/, 'Chat'], [/^\/recorridos$/, 'Recorridos'], [/^\/productos$/, 'Notas de productos'], [/^\/cronograma$/, 'Día'], [/^\/entregas$/, 'Entregas'],
  [/^\/choferes$/, 'Choferes'], [/^\/produccion$/, 'Producción']];
const TIPO_DE: Record<string, ObjectType> = { companies: 'company', contacts: 'contact', deals: 'deal', orders: 'order' };

export default function AppMovil({ perfil }: { perfil: PerfilMovil }) {
  const logistica = perfil === 'logistica';
  const produccion = perfil === 'produccion';
  const operaciones = logistica || produccion;
  const { meta } = useMeta();
  const loc = useLocation();
  const volver = useVolver();
  const puede = usePuedeEscribir();
  const [mas, setMas] = useState(false);
  const [crear, setCrear] = useState(false);
  useEffect(() => { setMas(false); setCrear(false); }, [loc.pathname]);
  // Los modales del escritorio que se usan acá (un encargo, el panel de una tarea) ocupan toda la pantalla (body.movil).
  useEffect(() => { document.body.classList.add('movil'); return () => document.body.classList.remove('movil'); }, []);
  useAltoVisible();
  const sinLeer = useNoLeidas();
  // Logística: cuántos remitos hay para revisar (el número de la pestaña Entregas), al moverse por la app.
  const [remitos, setRemitos] = useState(0);
  useEffect(() => { if (logistica) http<{ total: number }>('GET', '/remitos/revisar/cuantos').then((r) => setRemitos(r.total), () => undefined); }, [logistica, loc.pathname]);

  // El link de una mención (campanita o mail: …/deals/123?conversacion=1&mensaje=45) abre la conversación, en el mensaje.
  const sp = new URLSearchParams(loc.search);
  const ficha = loc.pathname.match(/^\/(companies|contacts|deals|orders)\/(\d+)$/);
  if (ficha && sp.has('conversacion')) {
    const m = sp.get('mensaje');
    return <Navigate replace to={`/conversaciones/${TIPO_DE[ficha[1]]}/${ficha[2]}${m ? `?mensaje=${m}` : ''}`} />;
  }

  // A pantalla completa, sin las barras: el asistente del encargo y una conversación abierta.
  const completa = loc.pathname === '/recorridos/nuevo' || loc.pathname.startsWith('/conversaciones/');
  const enFicha = FICHAS.find(([r]) => r.test(loc.pathname));
  const titulo = TITULOS.find(([r]) => r.test(loc.pathname))?.[1];
  const activo = (rutas: string[]) => rutas.some((r) => loc.pathname === r || loc.pathname.startsWith(`${r}/`));
  return (
    <div className={`m-shell${completa ? ' m-full' : ''}`}>
      {meta.real_user && <MirandoComo />}
      {!completa && (
        <header className="m-top">
          {enFicha
            ? <button type="button" className="btn ghost icon m-atras" onClick={() => volver(enFicha[1])} aria-label="Volver"><Icon name="chevron" size={24} /></button>
            : <button type="button" className="m-yo" onClick={() => setMas(true)} aria-label="Menú: tareas, recorridos, tema y más"><MiAvatar /></button>}
          {titulo ? <b className="m-top-tit">{titulo}</b> : <div className="m-buscar"><GlobalSearch corto /></div>}
          <Campanita />
        </header>
      )}
      <main className="m-main">
        <Routes>
          <Route path="/" element={logistica ? <HoyLogistica /> : produccion ? <HoyProduccion /> : <Hoy />} />
          {operaciones && <Route path="/cronograma" element={<DiaMovil />} />}
          {produccion && <Route path="/produccion" element={<ProduccionLista />} />}
          {produccion && <Route path="/produccion/:task" element={<FichaPdv />} />}
          {logistica && <Route path="/entregas" element={<EntregasMovil />} />}
          {logistica && <Route path="/choferes" element={<ChoferesMovil />} />}
          <Route path="/recorridos" element={<RecorridosMovil />} />
          <Route path="/recorridos/nuevo" element={<EncargoAsistente />} />
          <Route path="/tasks" element={<TareasMovil />} />
          <Route path="/conversaciones" element={<ChatMovil />} />
          <Route path="/conversaciones/:tipo/:id" element={<ConKey><ChatAbierto /></ConKey>} />
          <Route path="/productos" element={<NotasProductosPage />} />
          {!operaciones && <Route path="/companies" element={<ClientesLista key="company" tipo="company" />} />}
          {!operaciones && <Route path="/contacts" element={<ClientesLista key="contact" tipo="contact" />} />}
          <Route path="/companies/:id" element={<ConKey><FichaCliente tipo="company" /></ConKey>} />
          <Route path="/contacts/:id" element={<ConKey><FichaCliente tipo="contact" /></ConKey>} />
          {!operaciones && <Route path="/deals" element={<NegociosLista />} />}
          {!operaciones && <Route path="/deals/:id" element={<ConKey><FichaNegocio /></ConKey>} />}
          <Route path="/orders" element={<PedidosLista />} />
          <Route path="/orders/:id" element={<ConKey><FichaPedido /></ConKey>} />
          {/* La orden de trabajo, en el celular: la ficha de su pedido, que tiene todo (productos, chat, remitos). */}
          <Route path="/work-orders/:id" element={<OTAlPedido />} />
          <Route path="*" element={<EnLaCompleta />} />
        </Routes>
      </main>
      {!completa && (
        <nav className={`m-tabs${puede ? '' : ' sin-mas'}`} aria-label="Menú principal">
          <NavLink to="/" end className="m-tab"><Icon name="home" size={22} /><span>Hoy</span></NavLink>
          {logistica
            ? <NavLink to="/cronograma" className="m-tab"><Icon name="calendar" size={22} /><span>Día</span></NavLink>
            : produccion ? <NavLink to="/produccion" className="m-tab"><Icon name="printer" size={22} /><span>Producción</span></NavLink>
            : <NavLink to="/companies" className={`m-tab${activo(['/companies', '/contacts']) ? ' active' : ''}`}><Icon name="company" size={22} /><span>Clientes</span></NavLink>}
          {puede && <button type="button" className="m-tab m-mas" onClick={() => setCrear(true)} aria-label="Cargar algo nuevo"><span className="m-mas-btn"><Icon name="plus" size={24} /></span></button>}
          {logistica
            ? <NavLink to="/entregas" className="m-tab"><Icon name="truck" size={22} /><span>Entregas</span>
                {remitos ? <span className="m-badge" aria-label={`${remitos} remitos para revisar`}>{remitos}</span> : null}</NavLink>
            : produccion ? <NavLink to="/orders" className="m-tab"><Icon name="order" size={22} /><span>Pedidos</span></NavLink>
            : <NavLink to="/deals" className={`m-tab${activo(['/deals', '/orders']) ? ' active' : ''}`}><Icon name="deal" size={22} /><span>Ventas</span></NavLink>}
          <NavLink to="/conversaciones" className="m-tab"><Icon name="chat" size={22} /><span>Chat</span>
            {sinLeer.no_leidos ? <span className={`m-badge${sinLeer.menciones ? ' mencion' : ''}`} aria-label={`${sinLeer.no_leidos} sin leer`}>{sinLeer.no_leidos}</span> : null}</NavLink>
        </nav>
      )}
      {crear && <MenuCrear perfil={perfil} onClose={() => setCrear(false)} />}
      {mas && <MenuMas perfil={perfil} onClose={() => setMas(false)} />}
      {puede && !operaciones && <PreguntaLlamada />}
      {/* Chispín, el buzón de ideas (Chispin.tsx): arriba de la barra de abajo, salvo donde se escribe (un chat, un encargo). */}
      {!completa && !/^\/conversaciones\/|\/nuevo$/.test(loc.pathname) && <Chispin />}
    </div>
  );
}

// Cada ficha se arma de cero al cambiar de registro (de una empresa a otra desde el buscador): nada del anterior queda a la
// vista ni recibe lo que se escribe.
function ConKey({ children }: { children: ReactNode }) {
  const { id, tipo } = useParams();
  return <div key={`${tipo ?? ''}-${id}`} className="m-ruta">{children}</div>;
}

// El alto que se ve de verdad (con el teclado abierto, en iPhone y Android): la app y las hojas se achican a ese alto, así
// el botón para guardar y lo que se escribe no quedan debajo del teclado.
function useAltoVisible() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const raiz = document.documentElement;
    const poner = () => { raiz.style.setProperty('--vvh', `${vv.height}px`); raiz.style.setProperty('--vvt', `${vv.offsetTop}px`); };
    poner();
    vv.addEventListener('resize', poner);
    vv.addEventListener('scroll', poner);
    return () => { vv.removeEventListener('resize', poner); vv.removeEventListener('scroll', poner); raiz.style.removeProperty('--vvh'); raiz.style.removeProperty('--vvt'); };
  }, []);
}

// Un superadmin mirando como otra persona: siempre a la vista, con la vuelta a su usuario (en el celular no había forma).
function MirandoComo() {
  const { meta } = useMeta();
  return (
    <div className="m-mirando" role="status">
      <Icon name="eye" size={16} /><span>Mirando como <b>{meta.me.name}</b> · solo para ver</span>
      <button type="button" className="btn sm" onClick={() => verComo(null)}>Volver a {meta.real_user?.name.split(' ')[0]}</button>
    </div>
  );
}

// Lo que no está en el celular (Configuración, Analíticas, Cronograma…): se abre en la versión completa.
function EnLaCompleta() {
  const loc = useLocation();
  return (
    <div className="m-pag">
      <div className="m-al-dia"><span className="m-al-dia-ico neutro"><Icon name="table" size={22} /></span>
        <b>Esto se ve en la versión completa</b>
        <small className="muted">En el celular está lo esencial para la calle.</small>
        <button type="button" className="btn primary" onClick={() => usarVersionCompleta(true, loc.pathname + loc.search)}>Abrir la versión completa</button>
        <NavLink to="/" className="m-link">Volver a Hoy</NavLink>
      </div>
    </div>
  );
}

function MiAvatar() {
  const { meta } = useMeta();
  return <Avatar name={meta.me.name} photo={meta.me.photo_url} />;
}

// ---------- Hoja que sube desde abajo ----------

// Accesible (revisión del 18/11/2026): es un diálogo modal, el foco entra al abrir, Tab no se escapa al fondo, al
// cerrar vuelve a donde estaba; y se cierra con el botón Atrás del teléfono sin perder la pantalla de abajo.
export function Hoja({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const caja = useRef<HTMLDivElement>(null);
  useCerrarConAtras(onClose);
  useEffect(() => {
    const antes = document.activeElement as HTMLElement | null;
    // El foco, al primer campo con autoFocus o, si no hay, al título (sin abrir el teclado).
    window.setTimeout(() => {
      if (!caja.current?.contains(document.activeElement)) caja.current?.querySelector<HTMLElement>('h2')?.focus();
    }, 0);
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !caja.current) return;
      const foco = [...caja.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!foco.length) return;
      const [primero, ultimo] = [foco[0], foco[foco.length - 1]];
      if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); if (antes?.isConnected) antes.focus({ preventScroll: true }); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="m-hoja-fondo" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="m-hoja" role="dialog" aria-modal="true" aria-labelledby={id} ref={caja}>
        <div className="m-hoja-cab"><span className="m-hoja-asa" aria-hidden="true" /><h2 id={id} tabIndex={-1}>{titulo}</h2>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={20} /></button></div>
        <div className="m-hoja-cuerpo">{children}</div>
      </div>
    </div>
  );
}

// ＋: lo que un vendedor carga en la calle.
function MenuCrear({ perfil, onClose }: { perfil: PerfilMovil; onClose: () => void }) {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState<ObjectType | null>(null);
  const [tarea, setTarea] = useState(false);
  if (tipo === 'company' || tipo === 'contact') return <AltaCliente tipo={tipo} onClose={onClose} />;
  if (tipo === 'deal') return <AltaNegocio onClose={onClose} />;
  if (tipo) return <CreateRecord type={tipo} onClose={onClose} />;
  if (tarea) return <TareaRapida onClose={onClose} />;
  const op = (icono: string, titulo: string, sub: string, fn: () => void) => (
    <button type="button" className="m-op" onClick={fn}><span className="m-op-ico"><Icon name={icono} size={20} /></span><span><b>{titulo}</b><small>{sub}</small></span></button>
  );
  return (
    <Hoja titulo="Cargar" onClose={onClose}>
      <div className="m-ops">
        {op('route', 'Encargo al recorrido', 'Que el chofer lleve o retire algo', () => navigate('/recorridos/nuevo'))}
        {op('task', 'Tarea', 'Un recordatorio para vos', () => setTarea(true))}
        {perfil === 'ventas' && <>
          {op('deal', 'Negocio', 'Una oportunidad nueva', () => setTipo('deal'))}
          {op('company', 'Empresa', 'Un cliente nuevo', () => setTipo('company'))}
          {op('contact', 'Contacto', 'Una persona', () => setTipo('contact'))}
        </>}
      </div>
    </Hoja>
  );
}

// Tarea en dos toques: qué y cuándo. «Hoy» es a las 10 o, si ya pasaron, en dos horas (antes quedaba vencida al crearla).
const DIA = 86_400_000;
function a10(dias: number) { const d = new Date(Date.now() + dias * DIA); d.setHours(10, 0, 0, 0); return d; }
function hoyHora() {
  const d = new Date();
  if (d.getHours() < 9) return a10(0);
  d.setHours(Math.min(d.getHours() + 2, 21), 0, 0, 0);
  return d;
}
function lunesQueViene() { const d = new Date(); const n = ((8 - d.getDay()) % 7) || 7; return a10(n); }
export function TareaRapida({ onClose, onCreada, linkId, sobre }: { onClose: () => void; onCreada?: () => void; linkId?: number; sobre?: string }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const hoy = hoyHora();
  const opciones: Array<[string, Date]> = [[`Hoy ${hoy.getHours()}:00`, hoy], ['Mañana', a10(1)], ['Pasado', a10(2)], ['El lunes', lunesQueViene()]];
  const [cuando, setCuando] = useState(1);
  const [ocupado, setOcupado] = useState(false);
  async function crear() {
    if (!texto.trim() || ocupado) return;
    setOcupado(true);
    try {
      await http('POST', '/activities', { type: 'task', subject: texto.trim(), owner_id: meta.me.id, due_at: opciones[cuando][1].toISOString(), status: 'NOT_STARTED', priority: 'none', task_type: 'todo', ...(linkId ? { links: [linkId] } : {}) });
      toast(`Tarea para ${opciones[cuando][0].toLowerCase()}.`);
      onCreada?.();
      onClose();
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  return (
    <Hoja titulo={sobre ? `Tarea sobre ${sobre}` : 'Nueva tarea'} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); crear(); }}>
        <input className="input" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Llamar a…, mandar la cotización…" aria-label="Qué hay que hacer" maxLength={300} enterKeyHint="done" />
        <div className="m-chips" role="group" aria-label="Para cuándo">
          {opciones.map(([t], i) => <button key={t} type="button" className={`chip${cuando === i ? ' on' : ''}`} aria-pressed={cuando === i} onClick={() => setCuando(i)}>{t}</button>)}
        </div>
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !texto.trim()}>Crear tarea</button>
      </form>
    </Hoja>
  );
}

// El menú del avatar: lo que no entra en la barra de abajo (Contactos y Pedidos ya están en Clientes y Ventas).
function MenuMas({ perfil, onClose }: { perfil: PerfilMovil; onClose: () => void }) {
  const { meta } = useMeta();
  const { tema, elegir } = useTema();
  const navigate = useNavigate();
  const ir = (a: string) => { onClose(); navigate(a); };
  return (
    <Hoja titulo={meta.me.name} onClose={onClose}>
      <div className="m-lista-menu">
        <button type="button" onClick={() => ir('/tasks')}><Icon name="task" size={18} />Tareas</button>
        {perfil === 'produccion' ? <>
          <button type="button" onClick={() => ir('/cronograma')}><Icon name="calendar" size={18} />Cronograma del día</button>
          <button type="button" onClick={() => ir('/recorridos')}><Icon name="route" size={18} />Recorridos y encargos</button>
          <button type="button" onClick={() => usarVersionCompleta(true, '/produccion')}><Icon name="table" size={18} />Producción completa (tablero, OC, filtros)</button>
        </> : perfil === 'logistica' ? <>
          <button type="button" onClick={() => ir('/recorridos')}><Icon name="route" size={18} />Recorridos y encargos</button>
          <button type="button" onClick={() => ir('/choferes')}><Icon name="volante" size={18} />Choferes</button>
          <button type="button" onClick={() => ir('/orders')}><Icon name="order" size={18} />Pedidos</button>
          <button type="button" onClick={() => usarVersionCompleta(true, '/produccion')}><Icon name="printer" size={18} />Producción (en la versión completa)</button>
        </> : <button type="button" onClick={() => ir('/recorridos')}><Icon name="route" size={18} />Recorridos y mis encargos</button>}
        <button type="button" onClick={() => ir('/productos')}><Icon name="alert" size={18} />Notas de productos</button>
      </div>
      <div className="m-sub">Tema</div>
      <div className="m-chips">
        {TEMAS.map(([k, l]) => <button key={k} type="button" className={`chip${tema === k ? ' on' : ''}`} aria-pressed={tema === k} onClick={() => elegir(k)}>{l}</button>)}
      </div>
      <div className="m-lista-menu">
        {meta.real_user && <button type="button" onClick={() => verComo(null)}><Icon name="eye" size={18} />Volver a mi usuario ({meta.real_user.name})</button>}
        <button type="button" onClick={() => usarVersionCompleta(true)}><Icon name="table" size={18} />Ver versión completa</button>
        <a href="/auth/salir"><Icon name="logout" size={18} />Cerrar sesión</a>
      </div>
    </Hoja>
  );
}

// Para que las páginas lean el parámetro sin repetir: ?tarea=123 (links de la campanita y de los mails).
export function useParametro(nombre: string) {
  const [sp, setSp] = useSearchParams();
  const valor = sp.get(nombre);
  const sacar = () => setSp((p) => { const n = new URLSearchParams(p); n.delete(nombre); return n; }, { replace: true });
  return [valor, sacar] as const;
}

// Un link a una orden de trabajo (mail, notificación, buscador) abre en el celular la ficha de su pedido (src/worker/ordenes.ts).
function OTAlPedido() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    http<{ pedido_id?: number | null }>('GET', `/records/work_order/${id}`)
      .then((d) => (d.pedido_id ? navigate(`/orders/${d.pedido_id}`, { replace: true }) : setError('Esta orden de trabajo no tiene su pedido.')))
      .catch((e) => setError((e as Error).message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="m-vacio">{error ?? 'Abriendo…'}</div>;
}
