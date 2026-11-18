import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { http, useMeta, useToast, Icon, esVentas, type ObjectType, type User } from '../lib';
import { Avatar, CreateRecord } from '../components';
import { TEMAS, useTema } from '../theme';
import { Campanita } from '../Notificaciones';
import ObjectIndex from '../pages/ObjectIndex';
import RecordPage from '../pages/RecordPage';
import './movil.css';
import Tasks from '../pages/Tasks';
import NotasProductosPage from '../pages/NotasProductos';
import ConversacionesPage, { useNoLeidas } from '../pages/Conversacion';
import Hoy from './Hoy';
import { RecorridosMovil, EncargoAsistente } from './RecorridosMovil';
import { ClientesLista, FichaCliente, AltaCliente } from './ClientesMovil';

// Versión celular del Hub (pedido de Rodrigo del 18/11/2026): en una pantalla angosta, el perfil Ventas no ve el CRM de
// escritorio achicado sino una app simple, con lo esencial para cargar desde la calle. Misma dirección, mismo login y la
// misma API; lo que no está acá se abre con «Ver versión completa». Barra abajo: Hoy · Clientes · ＋ · Ventas · Chat.
// Fase 1: el esqueleto, Hoy y Recorridos (encargo en tres pasos). Fase 2: Clientes (ClientesMovil.tsx). Ventas, Tareas y
// Chat abren, por ahora, las pantallas de siempre dentro de este esqueleto (docs/MOVIL.md).

const ANGOSTO = '(max-width: 760px)';
const CLAVE_COMPLETA = 'crm-version-completa';

const leerCompleta = () => { try { return localStorage.getItem(CLAVE_COMPLETA) === '1'; } catch { return false; } };
// Pasar a la versión completa (o volver a la del celular): se recuerda en este navegador.
export function usarVersionCompleta(si: boolean) {
  try { if (si) localStorage.setItem(CLAVE_COMPLETA, '1'); else localStorage.removeItem(CLAVE_COMPLETA); } catch { /* ignorar */ }
  window.location.assign('/');
}

// ¿Esta pantalla va con la versión celular? Angosta, perfil Ventas y sin haber pedido la completa.
export function useModoMovil(me: Pick<User, 'profile' | 'role'>) {
  const [angosto, setAngosto] = useState(() => typeof matchMedia === 'function' && matchMedia(ANGOSTO).matches);
  useEffect(() => {
    const m = matchMedia(ANGOSTO);
    const h = () => setAngosto(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  const ventas = esVentas(me);
  const completa = leerCompleta();
  return { movil: angosto && ventas && !completa, puedeVolver: angosto && ventas && completa };
}

export default function AppMovil({ buscador }: { buscador: ReactNode }) {
  const loc = useLocation();
  const [mas, setMas] = useState(false);
  const [crear, setCrear] = useState(false);
  useEffect(() => { setMas(false); setCrear(false); }, [loc.pathname]);
  // Los modales del escritorio (crear, ficha de un encargo) ocupan toda la pantalla (styles.css, body.movil).
  useEffect(() => { document.body.classList.add('movil'); return () => document.body.classList.remove('movil'); }, []);
  const sinLeer = useNoLeidas();
  const asistente = loc.pathname === '/recorridos/nuevo';
  const activo = (rutas: string[]) => rutas.some((r) => loc.pathname === r || loc.pathname.startsWith(`${r}/`));
  return (
    <div className={`m-shell${asistente ? ' m-full' : ''}`}>
      {!asistente && (
        <header className="m-top">
          <button type="button" className="m-yo" onClick={() => setMas(true)} aria-label="Menú: tareas, recorridos, tema y más"><MiAvatar /></button>
          <div className="m-buscar">{buscador}</div>
          <Campanita />
        </header>
      )}
      <main className="m-main">
        <Routes>
          <Route path="/" element={<Hoy />} />
          <Route path="/recorridos" element={<RecorridosMovil />} />
          <Route path="/recorridos/nuevo" element={<EncargoAsistente />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/conversaciones" element={<ConversacionesPage />} />
          <Route path="/productos" element={<NotasProductosPage />} />
          <Route path="/companies" element={<ClientesLista key="company" tipo="company" />} />
          <Route path="/contacts" element={<ClientesLista key="contact" tipo="contact" />} />
          <Route path="/companies/:id" element={<FichaCliente key="company" tipo="company" />} />
          <Route path="/contacts/:id" element={<FichaCliente key="contact" tipo="contact" />} />
          <Route path="/:objectPath" element={<ObjectIndex />} />
          <Route path="/:objectPath/:id" element={<RecordPage />} />
        </Routes>
      </main>
      <div id="barra-vista" />
      {!asistente && (
        <nav className="m-tabs" aria-label="Menú principal">
          <NavLink to="/" end className="m-tab"><Icon name="home" size={22} /><span>Hoy</span></NavLink>
          <NavLink to="/companies" className={`m-tab${activo(['/companies', '/contacts']) ? ' active' : ''}`}><Icon name="company" size={22} /><span>Clientes</span></NavLink>
          <button type="button" className="m-tab m-mas" onClick={() => setCrear(true)} aria-label="Cargar algo nuevo"><span className="m-mas-btn"><Icon name="plus" size={24} /></span></button>
          <NavLink to="/deals" className={`m-tab${activo(['/deals', '/orders']) ? ' active' : ''}`}><Icon name="deal" size={22} /><span>Ventas</span></NavLink>
          <NavLink to="/conversaciones" className="m-tab"><Icon name="chat" size={22} /><span>Chat</span>
            {sinLeer.no_leidos ? <span className={`m-badge${sinLeer.menciones ? ' mencion' : ''}`}>{sinLeer.no_leidos}</span> : null}</NavLink>
        </nav>
      )}
      {crear && <MenuCrear onClose={() => setCrear(false)} />}
      {mas && <MenuMas onClose={() => setMas(false)} />}
    </div>
  );
}

function MiAvatar() {
  const { meta } = useMeta();
  return <Avatar name={meta.me.name} photo={meta.me.photo_url} />;
}

// ---------- Hoja que sube desde abajo ----------

export function Hoja({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="m-hoja-fondo" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="m-hoja" role="dialog" aria-label={titulo}>
        <div className="m-hoja-cab"><span className="m-hoja-asa" aria-hidden="true" /><h2>{titulo}</h2>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={20} /></button></div>
        <div className="m-hoja-cuerpo">{children}</div>
      </div>
    </div>
  );
}

// ＋: lo que un vendedor carga en la calle.
function MenuCrear({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState<ObjectType | null>(null);
  const [tarea, setTarea] = useState(false);
  if (tipo === 'company' || tipo === 'contact') return <AltaCliente tipo={tipo} onClose={onClose} />;
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
        {op('deal', 'Negocio', 'Una oportunidad nueva', () => setTipo('deal'))}
        {op('company', 'Empresa', 'Un cliente nuevo', () => setTipo('company'))}
        {op('contact', 'Contacto', 'Una persona', () => setTipo('contact'))}
      </div>
    </Hoja>
  );
}

// Tarea en dos toques: qué y cuándo.
const DIA = 86_400_000;
function a10(dias: number) { const d = new Date(Date.now() + dias * DIA); d.setHours(10, 0, 0, 0); return d; }
function lunesQueViene() { const d = new Date(); const n = ((8 - d.getDay()) % 7) || 7; return a10(n); }
export function TareaRapida({ onClose, onCreada, linkId, sobre }: { onClose: () => void; onCreada?: () => void; linkId?: number; sobre?: string }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const opciones: Array<[string, Date]> = [['Hoy', a10(0)], ['Mañana', a10(1)], ['Pasado', a10(2)], ['El lunes', lunesQueViene()]];
  const [cuando, setCuando] = useState(1);
  const [ocupado, setOcupado] = useState(false);
  async function crear() {
    if (!texto.trim()) return;
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
        <input className="input" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Llamar a…, mandar la cotización…" aria-label="Qué hay que hacer" maxLength={300} />
        <div className="m-chips" role="group" aria-label="Para cuándo">
          {opciones.map(([t], i) => <button key={t} type="button" className={`chip${cuando === i ? ' on' : ''}`} aria-pressed={cuando === i} onClick={() => setCuando(i)}>{t}</button>)}
        </div>
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !texto.trim()}>Crear tarea</button>
      </form>
    </Hoja>
  );
}

// El menú del avatar: lo que no entra en la barra de abajo.
function MenuMas({ onClose }: { onClose: () => void }) {
  const { meta } = useMeta();
  const { tema, elegir } = useTema();
  const navigate = useNavigate();
  const ir = (a: string) => { onClose(); navigate(a); };
  return (
    <Hoja titulo={meta.me.name} onClose={onClose}>
      <div className="m-lista-menu">
        <button type="button" onClick={() => ir('/tasks')}><Icon name="task" size={18} />Tareas</button>
        <button type="button" onClick={() => ir('/recorridos')}><Icon name="route" size={18} />Recorridos</button>
        <button type="button" onClick={() => ir('/contacts')}><Icon name="contact" size={18} />Contactos</button>
        <button type="button" onClick={() => ir('/orders')}><Icon name="order" size={18} />Pedidos</button>
        <button type="button" onClick={() => ir('/productos')}><Icon name="alert" size={18} />Notas de productos</button>
      </div>
      <div className="m-sub">Tema</div>
      <div className="m-chips">
        {TEMAS.map(([k, l]) => <button key={k} type="button" className={`chip${tema === k ? ' on' : ''}`} aria-pressed={tema === k} onClick={() => elegir(k)}>{l}</button>)}
      </div>
      <div className="m-lista-menu">
        <button type="button" onClick={() => usarVersionCompleta(true)}><Icon name="table" size={18} />Ver versión completa</button>
        <a href="/auth/salir"><Icon name="logout" size={18} />Cerrar sesión</a>
      </div>
    </Hoja>
  );
}
