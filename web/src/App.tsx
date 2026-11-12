import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { http, qs, useMeta, useDebounced, recordUrl, registrarRuta, OBJECTS, Icon, type CrmRecord, type ObjectType } from './lib';
import { Avatar, CreateRecord } from './components';
import Home from './pages/Home';
import ObjectIndex from './pages/ObjectIndex';
import RecordPage from './pages/RecordPage';
import Tasks from './pages/Tasks';
import Settings from './pages/Settings';
import RemitosPage from './pages/Remitos';
import ProduccionPage from './pages/Produccion';
import { TEMAS, useTema } from './theme';

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
  useEffect(() => {
    http<{ total: number }>('GET', '/remitos/revisar/cuantos').then((r) => setRemitos(r.total)).catch(() => {});
  }, [loc.pathname]);

  return (
    <div className="shell">
      <nav className={`sidebar${menu ? ' open' : ''}`} aria-label="Menú principal">
        <div className="brand"><img src="/formas-logo-white.png" alt="Formas" /><span>CRM</span></div>
        <NavLink to="/" end className="nav-link"><Icon name="home" />Inicio</NavLink>
        <NavLink to="/tasks" className="nav-link"><Icon name="task" />Tareas{tasks ? <span className="count">{tasks}</span> : null}</NavLink>
        <div className="nav-group">CRM</div>
        <NavLink to="/contacts" className="nav-link"><Icon name="contact" />Contactos</NavLink>
        <NavLink to="/companies" className="nav-link"><Icon name="company" />Empresas</NavLink>
        <NavLink to="/deals" className="nav-link"><Icon name="deal" />Negocios</NavLink>
        <NavLink to="/orders" className="nav-link"><Icon name="order" />Pedidos</NavLink>
        <NavLink to="/produccion" className="nav-link"><Icon name="printer" />Producción</NavLink>
        <NavLink to="/entregas" className="nav-link"><Icon name="truck" />Entregas{remitos ? <span className="count">{remitos}</span> : null}</NavLink>
        {/* Abajo de todo, aparte del resto del menú: Configuración, justo arriba del usuario. */}
        <div className="nav-bottom">
          {meta.me.role === 'admin' && <NavLink to="/settings" className="nav-link"><Icon name="settings" />Configuración</NavLink>}
        </div>
        <UserMenu name={meta.me.name} email={meta.me.email} photo={meta.me.photo_url} />
      </nav>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setMenu(!menu)} aria-label="Abrir menú"><Icon name="menu" size={20} /></button>
          <GlobalSearch />
          <span className="grow" />
          <CreateMenu />
        </header>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/entregas" element={<RemitosPage />} />
          <Route path="/produccion" element={<ProduccionPage />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/:objectPath" element={<ObjectIndex />} />
          <Route path="/:objectPath/:id" element={<RecordPage />} />
        </Routes>
      </div>
    </div>
  );
}

// En el buscador se encuentra todo; los que no son clientes llevan su marca (tipo de relación, relacion.ts).
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
  const all = res ? (Object.entries(res) as Array<[ObjectType, CrmRecord[]]>).filter(([, l]) => l.length) : [];
  return (
    <div className="gsearch" ref={ref}>
      <div className="search"><Icon name="search" />
        <input ref={input} className="input" placeholder="Buscar contactos, empresas, negocios… (Ctrl+K)" value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && all[0]) go(all[0][0], all[0][1][0].id); }} />
      </div>
      {open && res && (
        <div className="popover">
          {!all.length && <div className="opt muted">Sin resultados para «{dq}»</div>}
          {all.map(([t, list]) => (
            <div key={t}>
              <div className="grp">{OBJECTS[t].plural}</div>
              {list.map((r) => (
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
function UserMenu({ name, email, photo }: { name: string; email: string; photo?: string | null }) {
  const { tema, elegir } = useTema();
  const [open, setOpen] = useState(false);
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
      {open && (
        <div className="popover me-menu" role="menu" aria-label="Tema">
          <div className="grp">Tema</div>
          {TEMAS.map(([k, l]) => (
            <div key={k} className={`opt${tema === k ? ' on' : ''}`} role="menuitemradio" aria-checked={tema === k} tabIndex={0}
              onClick={() => { elegir(k); setOpen(false); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(k); setOpen(false); } }}>
              {l}{k === 'auto' && <span className="small muted">como el sistema</span>}
              {tema === k && <span className="check"><Icon name="check" size={16} /></span>}
            </div>
          ))}
        </div>
      )}
      <button type="button" className="me" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Tema y usuario">
        <Avatar name={name} photo={photo} /><div><b>{name}</b>{email}</div><Icon name="updown" size={16} />
      </button>
    </div>
  );
}
