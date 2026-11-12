import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { http, qs, useMeta, useDebounced, recordUrl, registrarRuta, OBJECTS, Icon, verComo, esVentas, PROFILE_LABEL, ROLE_LABEL, type CrmRecord, type ObjectType, type User } from './lib';
import { Avatar, CreateRecord, Modal, UserChip } from './components';
import Home from './pages/Home';
import ObjectIndex from './pages/ObjectIndex';
import RecordPage from './pages/RecordPage';
import Tasks from './pages/Tasks';
import Settings from './pages/Settings';
import RemitosPage from './pages/Remitos';
import ProduccionPage from './pages/Produccion';
import ConversacionesPage, { useNoLeidas } from './pages/Conversacion';
import { TEMAS, useTema } from './theme';
import { BotonConectarClaude } from './ConectarClaude';

export default function App() {
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
  useEffect(() => {
    if (ventas) { setRemitos(null); return; }
    http<{ total: number }>('GET', '/remitos/revisar/cuantos').then((r) => setRemitos(r.total)).catch(() => {});
  }, [loc.pathname, ventas]);

  // Mensajes sin leer en las conversaciones que sigue (y si lo mencionaron).
  const sinLeer = useNoLeidas();
  return (
    <div className="shell">
      <nav className={`sidebar${menu ? ' open' : ''}`} aria-label="Menú principal">
        <div className="brand"><img src="/formas-logo-white.png" alt="Formas" /><span>CRM</span></div>
        <NavLink to="/" end className="nav-link"><Icon name="home" />Inicio</NavLink>
        <NavLink to="/tasks" className="nav-link"><Icon name="task" />Tareas{tasks ? <span className="count">{tasks}</span> : null}</NavLink>
        <NavLink to="/conversaciones" className="nav-link"><Icon name="chat" />Conversaciones
          {sinLeer.no_leidos ? <span className={`count badge${sinLeer.menciones ? ' mencion' : ''}`} title={sinLeer.menciones ? `${sinLeer.no_leidos} sin leer · te mencionaron` : `${sinLeer.no_leidos} sin leer`}>{sinLeer.menciones ? '@ ' : ''}{sinLeer.no_leidos}</span> : null}</NavLink>
        <div className="nav-group">CRM</div>
        <NavLink to="/contacts" className="nav-link"><Icon name="contact" />Contactos</NavLink>
        <NavLink to="/companies" className="nav-link"><Icon name="company" />Empresas</NavLink>
        <NavLink to="/deals" className="nav-link"><Icon name="deal" />Negocios</NavLink>
        <NavLink to="/orders" className="nav-link"><Icon name="order" />Pedidos</NavLink>
        {/* Perfil Ventas: sin Producción ni Entregas. */}
        {!ventas && <NavLink to="/produccion" className="nav-link"><Icon name="printer" />Producción</NavLink>}
        {!ventas && <NavLink to="/entregas" className="nav-link"><Icon name="truck" />Entregas{remitos ? <span className="count">{remitos}</span> : null}</NavLink>}
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
          <CreateMenu />
        </header>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/conversaciones" element={<ConversacionesPage />} />
          {!ventas && <Route path="/entregas" element={<RemitosPage />} />}
          {!ventas && <Route path="/produccion" element={<ProduccionPage />} />}
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/:objectPath" element={<ObjectIndex />} />
          <Route path="/:objectPath/:id" element={<RecordPage />} />
        </Routes>
      </div>
    </div>
  );
}

// En el buscador se encuentra todo; los que no son clientes llevan su marca (tipo de relación, relacion.ts).
// En el perfil Ventas, los contactos y empresas de otra vendedora vienen marcados «ajeno» (solo el nombre y de quién es).
type Encontrado = CrmRecord & { ajeno?: boolean };
const RELACION_MARCA: Record<string, string> = { proveedor: 'Proveedor', equipo: 'Equipo Formas', otro: 'Otro' };

function GlobalSearch() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Record<ObjectType, CrmRecord[]> | null>(null);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dq.trim().length < 2) { setRes(null); return; }
    http<Record<ObjectType, CrmRecord[]>>('GET', `/search${qs({ q: dq })}`).then(setRes).catch(() => {});
  }, [dq]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, []);
  const go = (t: ObjectType, id: number) => { setOpen(false); setQ(''); navigate(recordUrl(t, id)); };
  const all = res ? (Object.entries(res) as Array<[ObjectType, Encontrado[]]>).filter(([, l]) => l.length) : [];
  const primero = all.flatMap(([t, l]) => l.filter((r) => !r.ajeno).map((r) => [t, r.id] as const))[0];
  return (
    <div className="gsearch" ref={ref}>
      <div className="search"><Icon name="search" />
        <input ref={input} className="input" placeholder="Buscar contactos, empresas, negocios… (Ctrl+K)" value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && primero) go(primero[0], primero[1]); }} />
      </div>
      {open && res && (
        <div className="popover">
          {!all.length && <div className="opt muted">Sin resultados para «{dq}»</div>}
          {all.map(([t, list]) => (
            <div key={t}>
              <div className="grp">{OBJECTS[t].plural}</div>
              {list.map((r) => r.ajeno ? (
                // Perfil Ventas: ya existe, pero es de otra vendedora. No se abre; sirve para no cargarlo de nuevo.
                <div key={r.id} className="opt ajeno" aria-disabled="true" title="Ya existe y es de otra vendedora: pedile a un administrador que te lo pase.">
                  <Avatar name={r.name} type={t} />
                  <div className="grow"><div className="ellipsis">{r.name}</div>
                    <div className="small muted ellipsis row" style={{ gap: 4 }}>Ya existe · es de <UserChip id={r.props.owner_id} size="xs" /></div></div>
                </div>
              ) : (
                <div key={r.id} className="opt" onClick={() => go(t, r.id)}>
                  <Avatar name={r.name} type={t} />
                  <div className="grow"><div className="ellipsis">{r.name}{RELACION_MARCA[String(r.props.tipo_de_relacion ?? '')] && <span className="tag" style={{ marginLeft: 6 }}>{RELACION_MARCA[String(r.props.tipo_de_relacion)]}</span>}</div>
                    <div className="small muted ellipsis">{r.props.email || r.props.domain || r.props.company || ''}</div></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateMenu() {
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
          {(Object.keys(OBJECTS) as ObjectType[]).map((t) => (
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
