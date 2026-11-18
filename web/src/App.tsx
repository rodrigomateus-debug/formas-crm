import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { http, qs, useMeta, useDebounced, recordUrl, registrarRuta, OBJECTS, Icon, verComo, esVentas, esOperaciones, PROFILE_LABEL, ROLE_LABEL, type CrmRecord, type ObjectType, type User } from './lib';
import { Avatar, CreateRecord, Modal, UserChip } from './components';
import Home from './pages/Home';
import ObjectIndex from './pages/ObjectIndex';
import RecordPage from './pages/RecordPage';
import Tasks from './pages/Tasks';
import Settings from './pages/Settings';
import RemitosPage from './pages/Remitos';
import ProduccionPage from './pages/Produccion';
import CronogramaPage from './pages/Cronograma';
import RecorridosPage from './pages/Recorridos';
import AnaliticasPage, { analiticasDe } from './pages/Analiticas';
import NotasProductosPage from './pages/NotasProductos';
import ChoferesPage from './pages/Choferes';
import ConsultasPage from './pages/Consultas';
import ConversacionesPage, { useNoLeidas } from './pages/Conversacion';
import { TEMAS, useTema } from './theme';
import { BotonConectarClaude } from './ConectarClaude';
import { Campanita } from './Notificaciones';
import { GlobalSearch } from './Buscador';
import { usarVersionCompleta } from './movil/modo';

// Pantalla con la que abre cada perfil (pedido de Rodrigo del 16/11/2026); el resto, Inicio.
const PANTALLA_INICIAL: Record<string, string> = { produccion: '/produccion', logistica: '/cronograma' };

// El CRM de escritorio. La versión celular (movil/) la elige Raiz.tsx.
export default function App({ puedeVolver = false }: { puedeVolver?: boolean }) {
  const { meta } = useMeta();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  // Antes de dibujar la pantalla nueva: así cada lista sabe si se vuelve a ella desde una ficha o se entra de cero.
  registrarRuta(loc.pathname);
  useEffect(() => setMenu(false), [loc.pathname]);
  const [tasks, setTasks] = useState<number | null>(null);
  useEffect(() => {
    http<{ total: number }>('GET', `/tasks${qs({ due: 'today', limit: 1 })}`).then((r) => setTasks(r.total)).catch(() => {});
  }, [loc.pathname]);
  // Remitos para revisar (bandeja de Logística, pestaña «Entregas»).
  const [remitos, setRemitos] = useState<number | null>(null);
  const ventas = esVentas(meta.me);
  // Perfiles Producción y Logística: sin la parte comercial (contactos, empresas y negocios).
  const produccion = esOperaciones(meta.me);   // Producción y Logística: sin la parte comercial
  const logistica = meta.me.profile === 'logistica';   // la barra lateral de Logística suma Choferes
  useEffect(() => {
    if (ventas) { setRemitos(null); return; }
    http<{ total: number }>('GET', '/remitos/revisar/cuantos').then((r) => setRemitos(r.total)).catch(() => {});
  }, [loc.pathname, ventas]);

  // Al abrir el Hub (no al tocar «Inicio»): el perfil Producción arranca en Producción y Logística en el Cronograma.
  const navigate = useNavigate();
  useEffect(() => {
    const inicio = PANTALLA_INICIAL[meta.me.profile];
    if (inicio && loc.pathname === '/') navigate(inicio, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mensajes sin leer en las conversaciones que sigue (y si lo mencionaron).
  const sinLeer = useNoLeidas();
  return (
    <div className="shell">
      <nav className={`sidebar${menu ? ' open' : ''}`} aria-label="Menú principal">
        <div className="brand"><img src="/formas-logo-white.png" alt="Formas" /><span>Hub</span></div>
        <NavLink to="/" end className="nav-link"><Icon name="home" />Inicio</NavLink>
        <NavLink to="/tasks" className="nav-link"><Icon name="task" />Tareas{tasks ? <span className="count">{tasks}</span> : null}</NavLink>
        <NavLink to="/conversaciones" className="nav-link"><Icon name="chat" />Conversaciones
          {sinLeer.no_leidos ? <span className={`count badge${sinLeer.menciones ? ' mencion' : ''}`} title={sinLeer.menciones ? `${sinLeer.no_leidos} sin leer · te mencionaron` : `${sinLeer.no_leidos} sin leer`}>{sinLeer.menciones ? '@ ' : ''}{sinLeer.no_leidos}</span> : null}</NavLink>
        {/* Cada grupo, con una línea sutil arriba (pedido de Rodrigo del 16/11/2026): CRM y, aparte, Operaciones. */}
        <div className="nav-group">CRM</div>
        {!produccion && <NavLink to="/contacts" className="nav-link"><Icon name="contact" />Contactos</NavLink>}
        {!produccion && <NavLink to="/companies" className="nav-link"><Icon name="company" />Empresas</NavLink>}
        {!produccion && <NavLink to="/deals" className="nav-link"><Icon name="deal" />Negocios</NavLink>}
        <NavLink to="/orders" className="nav-link"><Icon name="order" />Pedidos</NavLink>
        {/* Consultas por WhatsApp (darwin.ts): quién consultó por qué producto, y quién espera respuesta. */}
        {!produccion && <NavLink to="/consultas" className="nav-link"><Icon name="whatsapp" />Consultas</NavLink>}
        {/* Operaciones, en el orden del trabajo: Producción, Cronograma, Recorridos y Entregas (y Choferes en Logística), y las
            Notas de productos. Perfil Ventas: Recorridos y las Notas de productos. */}
        <div className="nav-group">Operaciones</div>
        {!ventas && <NavLink to="/produccion" className="nav-link"><Icon name="printer" />Producción</NavLink>}
        {!ventas && <NavLink to="/cronograma" className="nav-link"><Icon name="calendar" />Cronograma</NavLink>}
        {/* Recorridos: todos cargan lo que el chofer tiene que llevar o retirar (recorridos.ts). */}
        <NavLink to="/recorridos" className="nav-link"><Icon name="route" />Recorridos</NavLink>
        {!ventas && <NavLink to="/entregas" className="nav-link"><Icon name="truck" />Entregas{remitos ? <span className="count">{remitos}</span> : null}</NavLink>}
        {/* Perfil Logística: el código de cada chofer para su app, a mano (los administradores, en Entregas → Choferes). */}
        {logistica && <NavLink to="/choferes" className="nav-link"><Icon name="volante" />Choferes</NavLink>}
        {/* Notas de productos (notasproducto.ts): las ven todos; las escriben Producción y los administradores. */}
        <NavLink to="/productos" className="nav-link"><Icon name="alert" />Notas de productos</NavLink>
        {/* Analíticas (pedido de Rodrigo del 18/11/2026): los números de cada área en una sola entrada, aparte de los módulos de
            trabajo. Adentro, una pestaña por tema según el perfil (Analiticas.tsx); sin ninguna, no aparece. */}
        {analiticasDe(meta.me).length > 0 && <>
          <div className="nav-group nav-solo" aria-hidden="true" />
          <NavLink to="/analiticas" className="nav-link"><Icon name="chart" />Analíticas</NavLink>
        </>}
        {/* Abajo de todo, aparte del resto del menú: Configuración, justo arriba del usuario. */}
        <div className="nav-bottom">
          {meta.me.role === 'admin' && <NavLink to="/settings" className="nav-link"><Icon name="settings" />Configuración</NavLink>}
          {/* Arriba del nombre: conectar Claude con el CRM (ConectarClaude.tsx). */}
          <BotonConectarClaude />
        </div>
        <UserMenu name={meta.me.name} email={meta.me.email} photo={meta.me.photo_url} superadmin={!!meta.superadmin} mirando={!!meta.real_user} />
      </nav>
      <div className="main">
        {meta.real_user && <VerComoCartel />}
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setMenu(!menu)} aria-label="Abrir menú"><Icon name="menu" size={20} /></button>
          <GlobalSearch />
          <span className="grow" />
          {/* Notificaciones (Notificaciones.tsx): menciones, respuestas, asignaciones y faltantes de entrega. */}
          <Campanita />
          {puedeVolver && <button type="button" className="btn" onClick={() => usarVersionCompleta(false)}>Versión celular</button>}
          <CreateMenu />
        </header>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/conversaciones" element={<ConversacionesPage />} />
          {!ventas && <Route path="/entregas" element={<RemitosPage />} />}
          {!ventas && <Route path="/produccion" element={<ProduccionPage />} />}
          {!ventas && <Route path="/cronograma" element={<CronogramaPage />} />}
          <Route path="/recorridos" element={<RecorridosPage />} />
          {analiticasDe(meta.me).length > 0 && <Route path="/analiticas" element={<AnaliticasPage />} />}
          {/* El link de antes de que existiera Analíticas. */}
          <Route path="/rendimiento" element={<Navigate to="/analiticas" replace />} />
          <Route path="/productos" element={<NotasProductosPage />} />
          {!produccion && <Route path="/consultas" element={<ConsultasPage />} />}
          {(logistica || meta.me.role === 'admin') && <Route path="/choferes" element={<ChoferesPage />} />}
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/:objectPath" element={produccion ? <SoloPedidos /> : <ObjectIndex />} />
          <Route path="/:objectPath/:id" element={<RecordPage />} />
        </Routes>
        {/* Al pie: la barra de las vistas (BarraVista en vistas.tsx) se dibuja acá cuando la pantalla tiene vistas. */}
        <div id="barra-vista" />
      </div>
    </div>
  );
}

// Perfiles Producción y Logística: de las listas, solo Pedidos (las fichas de un cliente o proveedor se abren desde el pedido).
function SoloPedidos() {
  const { objectPath } = useParams();
  return objectPath === 'orders' ? <ObjectIndex /> : <Navigate to="/orders" replace />;
}

function CreateMenu() {
  const produccion = esOperaciones(useMeta().meta.me);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ObjectType | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn primary" onClick={() => setOpen(!open)}><Icon name="plus" size={16} />Crear</button>
      {open && (
        <div className="popover" style={{ right: 0, top: 42 }}>
          {(Object.keys(OBJECTS) as ObjectType[]).filter((t) => !produccion || t === 'order').map((t) => (
            <div key={t} className="opt" onClick={() => { setType(t); setOpen(false); }}><Icon name={t} size={16} />{OBJECTS[t].single}</div>
          ))}
        </div>
      )}
      {type && <CreateRecord type={type} onClose={() => setType(null)} />}
    </div>
  );
}

// Usuario, abajo en el menú: desde acá cada uno elige el tema (Automático, Claro, Oscuro o Alto contraste).
// Mirando como otro usuario: arriba de todo, siempre a la vista, quién es y cómo volver.
function VerComoCartel() {
  const { meta } = useMeta();
  const u = meta.me;
  return (
    <div className="ver-como-cartel" role="status">
      <Icon name="eye" size={16} />
      <span className="grow">Estás viendo el CRM como <b>{u.name}</b> <span className="ver-como-quien">({PROFILE_LABEL[u.profile] ?? u.profile}{u.role !== 'admin' ? ` · ${ROLE_LABEL[u.role] ?? u.role}` : ''})</span>.
        {' '}Es solo para mirar: no se puede cambiar nada.</span>
      <button className="btn sm" onClick={() => verComo(null)}>Volver a {meta.real_user?.name.split(' ')[0] ?? 'mi usuario'}</button>
    </div>
  );
}

// Elegir a quién mirar: los usuarios activos, buscando por nombre, mail, perfil o equipo.
function VerComoModal({ onClose }: { onClose: () => void }) {
  const { meta } = useMeta();
  const [q, setQ] = useState('');
  const yo = meta.real_user?.id ?? meta.me.id;
  const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const equipo = (u: User) => meta.teams.find((t) => t.id === u.team_id)?.name ?? '';
  const lista = meta.users.filter((u) => u.active && !u.deleted_at && u.id !== yo)
    .filter((u) => !q || norm(`${u.name} ${u.email} ${PROFILE_LABEL[u.profile] ?? ''} ${equipo(u)}`).includes(norm(q)));
  return (
    <Modal title="Ver el CRM como…" onClose={onClose}>
      <p className="muted small" style={{ margin: 0 }}>Ves lo mismo que ve esa persona (sus pipelines, sus tareas, sus conversaciones y lo que puede hacer), sin salir de tu sesión.
        Es solo para mirar: mientras tanto no se puede cambiar nada. Arriba queda el botón para volver a tu usuario.</p>
      <input className="input" autoFocus placeholder="Buscar por nombre, mail, perfil o equipo…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && lista.length === 1) verComo(lista[0].id); }} />
      <div className="ver-como-lista">
        {lista.map((u) => (
          <button key={u.id} type="button" className="ver-como-fila" onClick={() => verComo(u.id)}>
            <Avatar name={u.name} photo={u.photo_url} />
            <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{u.name}</b><span className="small muted ellipsis" style={{ display: 'block' }}>{u.email}</span></span>
            <span className="small muted">{[PROFILE_LABEL[u.profile] ?? u.profile, equipo(u)].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {!lista.length && <div className="muted small" style={{ padding: 12 }}>Nadie coincide con «{q}».</div>}
      </div>
    </Modal>
  );
}

function UserMenu({ name, email, photo, superadmin, mirando }: { name: string; email: string; photo?: string | null; superadmin: boolean; mirando: boolean }) {
  const { tema, elegir } = useTema();
  const [open, setOpen] = useState(false);
  const [elegirUsuario, setElegirUsuario] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="me-wrap" ref={ref}>
      {/* Fuera del menú lateral: si no, hereda su letra blanca. */}
      {elegirUsuario && createPortal(<VerComoModal onClose={() => setElegirUsuario(false)} />, document.body)}
      {open && (
        <div className="popover me-menu" role="menu" aria-label="Tu usuario">
          {superadmin && <>
            <div className="grp">Superadmin</div>
            <div className="opt" role="menuitem" tabIndex={0} onClick={() => { setOpen(false); setElegirUsuario(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setOpen(false); setElegirUsuario(true); } }}><Icon name="eye" size={16} />{mirando ? 'Ver como otro usuario…' : 'Ver como…'}</div>
            {mirando && <div className="opt" role="menuitem" tabIndex={0} onClick={() => verComo(null)} onKeyDown={(e) => { if (e.key === 'Enter') verComo(null); }}>
              <Icon name="x" size={16} />Volver a mi usuario</div>}
          </>}
          <div className="grp">Tema</div>
          {TEMAS.map(([k, l]) => (
            <div key={k} className={`opt${tema === k ? ' on' : ''}`} role="menuitemradio" aria-checked={tema === k} tabIndex={0}
              onClick={() => { elegir(k); setOpen(false); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(k); setOpen(false); } }}>
              {l}{k === 'auto' && <span className="small muted">como el sistema</span>}
              {tema === k && <span className="check"><Icon name="check" size={16} /></span>}
            </div>
          ))}
          {/* Cerrar sesión (login con Google, login.ts): borra la sesión y vuelve a la pantalla de ingreso. */}
          <div className="sep" role="separator" />
          <a className="opt salir" role="menuitem" href="/auth/salir"><Icon name="logout" size={16} />Cerrar sesión</a>
        </div>
      )}
      <button type="button" className="me" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Tu usuario: tema y cerrar sesión">
        <Avatar name={name} photo={photo} /><div><b>{name}</b>{email}</div><Icon name="updown" size={16} />
      </button>
    </div>
  );
}
