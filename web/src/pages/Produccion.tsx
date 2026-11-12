import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, recordUrl, formatValue, useDebounced, propOf } from '../lib';
import { Avatar, UserAvatar, EtapaPedido, EstadoClickup, estiloEstado, etapaPedidoSlug } from '../components';
import { Select } from '../Select';
import { NombreProveedor } from '../proveedores';
import { RecordPreview } from './RecordPage';

// Un clic en un renglón o una tarjeta abre la vista previa del pedido, salvo que sea en algo que se usa ahí mismo (un
// desplegable, una fecha, un link, los asignados…).
const clicAdentro = (e: React.MouseEvent) =>
  !!(e.target as HTMLElement).closest('a, button, input, select, textarea, label, [role="combobox"], [role="listbox"], [role="option"], .select-pop, .popover');

// Producción (pedido de Rodrigo del 12/11/2026): la vista con la que trabajan Ceci y Sole en ClickUp («Estado PDV CECI»),
// en el CRM. Cada PDV con sus artículos abajo; cada artículo con su estado, quién lo tiene, proveedor, impresor y las
// fechas de ingreso y retiro. Se edita acá y se escribe en ClickUp en el momento. El estado del PDV sale de sus artículos.
// Arranca con Formas Shop; las otras unidades se ven pero se siguen trabajando en ClickUp (lo elige el administrador).

interface Articulo {
  task_id: string; nombre: string; estado: string; cantidad: number | null; cantidad_controlada: number | null; cliente: string | null;
  proveedor: string | null; impresor: string | null; entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null;
  egreso_impresor: string | null; retiro_impresor: string | null; vence: string | null; asignados: number[]; etiquetas: string[]; url: string | null;
  foto?: string | null;
}
interface Pdv extends Articulo {
  npdv: string | null; unidad: string | null; vendedor: string | null; record_id: number | null; pedido: string | null; owner_id: number | null;
  entrega_prometida: string | null; etapa: string | null; etapa_auto: boolean; listos: number; total: number; editable: boolean;
  asignados_todos: number[]; articulos: Articulo[];
}
interface Persona { clickup_id: number; nombre: string; user_id: number | null; foto: string | null }
interface Opcion { campo: 'proveedor' | 'impresor'; option_id: string; nombre: string; color: string | null; orden: number; company_id: number | null; empresa: string | null }
interface Estado { status: string; color: string; type: string }
interface Vista { pdvs: Pdv[]; personas: Persona[]; opciones: Opcion[]; estados: Estado[]; config: { unidades: string[] }; unidades: string[]; puede_editar: boolean }
type Campo = 'estado' | 'asignados' | 'entrega_real' | 'ingreso_proveedor' | 'retiro_proveedor' | 'egreso_impresor' | 'retiro_impresor' | 'proveedor' | 'impresor' | 'cantidad_controlada';

const UNIDADES = [
  { value: 'FORMAS SHOP', label: 'Formas Shop' }, { value: 'CORPORATE', label: 'Corporate' },
  { value: 'NO ESTRÉS', label: 'NoEstres' }, { value: 'MERCADO LIBRE', label: 'Mercado Libre' },
];
const CERRADOS = ['entregados', 'anulado'];

// Preferencias de cada uno en este navegador (vista, unidades, filtro de persona). Si el navegador no deja guardar, no pasa nada.
const PREF = 'produccion:pref';
function leerPref(): { modo?: 'lista' | 'tablero'; unidades?: string[]; persona?: string; colapsado?: boolean } {
  try { return JSON.parse(localStorage.getItem(PREF) ?? '{}'); } catch { return {}; }
}
function guardarPref(p: object) { try { localStorage.setItem(PREF, JSON.stringify({ ...leerPref(), ...p })); } catch { /* sin almacenamiento */ } }

// «mié 18/11»: el día de la semana ayuda a ver qué es de esta semana (en ClickUp se ve «miércoles»).
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function dia(v: string | null) {
  if (!v) return '';
  const [y, m, d] = v.split('-').map(Number);
  const f = new Date(y, m - 1, d);
  const hoy = new Date();
  const año = f.getFullYear() !== hoy.getFullYear() ? `/${String(y).slice(2)}` : '';
  return `${DIAS[f.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}${año}`;
}
const hoyIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function ProduccionPage() {
  const { meta } = useMeta();
  const toast = useToast();
  const pref = useMemo(leerPref, []);
  const [modo, setModo] = useState<'lista' | 'tablero'>(pref.modo ?? 'lista');
  const [unidades, setUnidades] = useState<string[] | null>(pref.unidades ?? null);
  const [persona, setPersona] = useState(pref.persona ?? '');
  const [cerrados, setCerrados] = useState(false);
  const [buscar, setBuscar] = useState('');
  const q = useDebounced(buscar, 150);
  const [v, setV] = useState<Vista | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  // Colapsar o expandir todo (queda guardado; por defecto, expandido). Cada PDV se puede abrir o cerrar aparte: esas
  // excepciones duran mientras se está en la pantalla.
  const [colapsado, setColapsado] = useState(!!pref.colapsado);
  const [excepciones, setExcepciones] = useState<Set<string>>(new Set());
  const cambiarColapsado = (c: boolean) => { setColapsado(c); setExcepciones(new Set()); guardarPref({ colapsado: c }); };
  // La vista previa del pedido (la misma de Pedidos: datos, productos, comentarios y actividad), al hacer clic en un PDV.
  const [preview, setPreview] = useState<number | null>(null);
  const abrir = useCallback((p: Pdv) => { if (p.record_id) setPreview(p.record_id); }, []);

  const cargar = async () => {
    setCargando(true);
    try {
      const d = await http<Vista>('GET', `/produccion${qs({ unidades: unidades?.join(','), cerrados: cerrados ? 1 : undefined })}`);
      setV(d); setError(null);
      if (!unidades) setUnidades(d.unidades);
    } catch (e) { setError((e as Error).message); }
    setCargando(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [unidades?.join(','), cerrados]);

  // Editar: se ve el cambio enseguida y se manda a ClickUp; si ClickUp no lo acepta, vuelve como estaba.
  const editar = async (pdv: Pdv, taskId: string, campo: Campo, valor: unknown) => {
    const antes = v;
    setV((cur) => cur && { ...cur, pdvs: cur.pdvs.map((p) => (p.task_id !== pdv.task_id ? p : aplicar(p, taskId, campo, valor))) });
    try {
      const r = await http<{ pdv: Pdv | null }>('PATCH', `/produccion/${encodeURIComponent(taskId)}`, { campo, valor });
      if (r.pdv) setV((cur) => cur && { ...cur, pdvs: cur.pdvs.map((p) => (p.task_id === r.pdv!.task_id ? r.pdv! : p)) });
    } catch (e) {
      setV(antes);
      toast((e as Error).message, true);
    }
  };

  const personas = v?.personas ?? [];
  const yo = personas.find((p) => p.user_id === meta.me.id);
  const filtrados = useMemo(() => {
    if (!v) return [];
    const t = q.trim().toLowerCase();
    return v.pdvs.filter((p) => {
      if (persona === 'nadie' && p.asignados_todos.length) return false;
      if (persona && persona !== 'nadie' && !p.asignados_todos.includes(Number(persona === 'yo' ? yo?.clickup_id : persona))) return false;
      if (!t) return true;
      return [p.npdv, p.cliente, p.vendedor, p.pedido, ...p.articulos.map((a) => a.nombre)].some((x) => String(x ?? '').toLowerCase().includes(t));
    });
  }, [v, q, persona, yo?.clickup_id]);

  const cambiarUnidades = (u: string[]) => { setUnidades(u); guardarPref({ unidades: u }); };
  const cambiarPersona = (p: string) => { setPersona(p); guardarPref({ persona: p }); };
  const cambiarModo = (m: 'lista' | 'tablero') => { setModo(m); guardarPref({ modo: m }); };
  const articulos = filtrados.reduce((n, p) => n + p.articulos.length, 0);
  const soloLectura = v && !v.puede_editar;

  return (
    <div className="content prod-page">
      <div className="page-head">
        <h1>Producción {v && <span className="muted small">{filtrados.length} PDV · {articulos} artículos</span>}</h1>
        <div className="row" role="group" aria-label="Vista">
          <button type="button" className={`btn sm${modo === 'lista' ? ' primary' : ''}`} aria-pressed={modo === 'lista'} onClick={() => cambiarModo('lista')}><Icon name="table" size={14} />Lista</button>
          <button type="button" className={`btn sm${modo === 'tablero' ? ' primary' : ''}`} aria-pressed={modo === 'tablero'} onClick={() => cambiarModo('tablero')}><Icon name="board" size={14} />Tablero</button>
        </div>
      </div>
      <div className="toolbar">
        <div className="search" style={{ minWidth: 220, flex: '0 1 280px' }}><Icon name="search" />
          <input className="input" placeholder="Buscar PDV, cliente o producto" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Unidades de negocio">
          {UNIDADES.map((u) => {
            const on = (unidades ?? []).includes(u.value);
            return <button key={u.value} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => cambiarUnidades(on ? (unidades ?? []).filter((x) => x !== u.value) : [...(unidades ?? []), u.value])}>{u.label}</button>;
          })}
        </div>
        <div style={{ minWidth: 190 }}>
          <Select value={persona} onChange={(e) => cambiarPersona(e.target.value)} aria-label="Asignado a" className="input sm">
            <option value="">Asignado: todos</option>
            {yo && <option value="yo">{personaOpcion(yo, ' (yo)')}</option>}
            {personas.filter((p) => p !== yo).map((p) => <option key={p.clickup_id} value={String(p.clickup_id)}>{personaOpcion(p)}</option>)}
            <option value="nadie">Sin asignar</option>
          </Select>
        </div>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={cerrados} onChange={(e) => setCerrados(e.target.checked)} />Ver entregados (30 días)</label>
        {modo === 'lista' && (
          <button type="button" className="btn sm" onClick={() => cambiarColapsado(!colapsado)} aria-pressed={colapsado}
            title={colapsado ? 'Mostrar los artículos de cada PDV' : 'Ver solo los PDV, sin sus artículos'}>
            <Flecha abierto={!colapsado} />{colapsado ? 'Expandir todo' : 'Colapsar todo'}
          </button>
        )}
        <span className="grow" />
        {meta.me.role === 'admin' && v && <ConfigUnidades config={v.config} onGuardado={cargar} />}
      </div>
      {v && <AvisoUnidades v={v} unidades={unidades ?? []} />}
      {soloLectura && <div className="aviso info small" style={{ marginBottom: 12 }}>Ves la producción para saber cómo vienen los pedidos. La editan las usuarias con perfil Producción.</div>}
      {error && <div className="aviso warn small" style={{ marginBottom: 12 }}>{error}</div>}
      {!v && cargando && <div className="empty plain">Cargando la producción…</div>}
      {v && !filtrados.length && !cargando && (
        <div className="empty plain">{v.pdvs.length ? 'Ningún PDV con esos filtros.' : 'No hay PDV en producción para estas unidades. Si recién se instaló, la primera lectura de ClickUp tarda unas corridas (cada 10 minutos).'}</div>
      )}
      {v && filtrados.length > 0 && (modo === 'lista'
        ? <Lista pdvs={filtrados} v={v} editar={editar} abierto={(id) => colapsado === excepciones.has(id)} onAbrir={abrir} sel={preview}
            onToggle={(id) => setExcepciones((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onTodos={(abrir) => cambiarColapsado(!abrir)} />
        : <Tablero pdvs={filtrados} v={v} editar={editar} onAbrir={abrir} sel={preview} />)}
      {preview && <RecordPreview key={preview} type="order" id={preview} onClose={() => setPreview(null)} onChange={cargar} />}
    </div>
  );
}

// Lo editado, en la fila, antes de que conteste ClickUp.
function aplicar(p: Pdv, taskId: string, campo: Campo, valor: unknown): Pdv {
  const v = campo === 'asignados' ? (valor as number[]) : valor === '' ? null : valor;
  if (p.task_id === taskId) return { ...p, [campo]: v };
  return { ...p, articulos: p.articulos.map((a) => (a.task_id === taskId ? { ...a, [campo]: v } : a)) };
}

function AvisoUnidades({ v, unidades }: { v: Vista; unidades: string[] }) {
  const fuera = unidades.filter((u) => !v.config.unidades.includes(u));
  if (!fuera.length) return null;
  const nombre = (u: string) => UNIDADES.find((x) => x.value === u)?.label ?? u;
  return <div className="aviso info small" style={{ marginBottom: 12 }}>{fuera.map(nombre).join(', ')}: se ve{fuera.length > 1 ? 'n' : ''} acá, pero se sigue{fuera.length > 1 ? 'n' : ''} trabajando en ClickUp. Desde el CRM se edita{v.config.unidades.length > 1 ? 'n' : ''}: {v.config.unidades.map(nombre).join(', ') || 'ninguna'}.</div>;
}

// Para el administrador: qué unidades se trabajan desde el CRM (el resto, en ClickUp).
function ConfigUnidades({ config, onGuardado }: { config: { unidades: string[] }; onGuardado: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const guardar = async (u: string[]) => {
    try { await http('PUT', '/produccion/config', { unidades: u }); toast('Listo'); onGuardado(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(!open)} aria-expanded={open}><Icon name="settings" size={15} />Qué se edita acá</button>
      {open && (
        <div className="popover" style={{ right: 0, top: 36, minWidth: 260 }}>
          <div className="grp">Se trabaja desde el CRM</div>
          {UNIDADES.map((u) => (
            <label key={u.value} className="opt small">
              <input type="checkbox" checked={config.unidades.includes(u.value)}
                onChange={(e) => guardar(e.target.checked ? [...config.unidades, u.value] : config.unidades.filter((x) => x !== u.value))} />{u.label}
            </label>
          ))}
          <div className="small muted" style={{ padding: '6px 10px 4px' }}>Las otras se ven, pero se editan en ClickUp.</div>
        </div>
      )}
    </div>
  );
}

// ---------- Gente ----------

function PersonaAvatar({ p, size = 'sm' }: { p: Persona; size?: 'sm' | 'xs' }) {
  return p.user_id ? <UserAvatar id={p.user_id} size={size} /> : <Avatar name={p.nombre} photo={p.foto} size={size} />;
}
const personaOpcion = (p: Persona, extra = '') => <><PersonaAvatar p={p} size="xs" />{p.nombre}{extra}</>;

// Quién lo tiene: las fotos una arriba de la otra y, si es una sola persona, su nombre. Con permiso, un clic abre la lista
// para sumar o sacar gente (se escribe en ClickUp).
function Asignados({ ids, personas, editable, onChange, label }: { ids: number[]; personas: Persona[]; editable: boolean; onChange?: (ids: number[]) => void; label: string }) {
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
  const quienes = ids.map((id) => personas.find((p) => p.clickup_id === id)).filter((p): p is Persona => !!p);
  const nombres = quienes.map((p) => p.nombre).join(', ');
  const cara = (
    <span className="asignados">
      {quienes.length ? <span className="avatar-stack">{quienes.slice(0, 3).map((p) => <PersonaAvatar key={p.clickup_id} p={p} />)}</span> : <span className="muted small">Sin asignar</span>}
      {quienes.length === 1 && <span className="ellipsis small">{primerNombre(quienes[0].nombre)}</span>}
      {quienes.length > 3 && <span className="small muted">+{quienes.length - 3}</span>}
    </span>
  );
  if (!editable) return <span title={nombres || undefined}>{cara}</span>;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="asignados-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true"
        aria-label={`${label}: ${nombres || 'sin asignar'}. Cambiar`} title={nombres || 'Asignar'}>{cara}</button>
      {open && (
        <div className="popover" style={{ top: 34, left: 0, minWidth: 220 }}>
          <div className="grp">Asignado en ClickUp</div>
          {personas.map((p) => (
            <label key={p.clickup_id} className="opt small">
              <input type="checkbox" checked={ids.includes(p.clickup_id)}
                onChange={(e) => onChange?.(e.target.checked ? [...ids, p.clickup_id] : ids.filter((x) => x !== p.clickup_id))} />
              <PersonaAvatar p={p} size="xs" />{p.nombre}
            </label>
          ))}
          {!personas.length && <div className="opt small muted">Todavía no apareció nadie asignado en ClickUp.</div>}
        </div>
      )}
    </div>
  );
}
const primerNombre = (n: string) => n.split(' ')[0];

// ---------- Celdas ----------

function EstadoPec({ estado, estados }: { estado: string; estados: Estado[] }) {
  return <EstadoClickup estado={estado} color={estados.find((x) => x.status === estado)?.color} />;
}

function EstadoCelda({ a, v, editable, onChange }: { a: Articulo; v: Vista; editable: boolean; onChange: (s: string) => void }) {
  const lista = useOpcionesEstado(v.estados);
  if (!editable) return <EstadoPec estado={a.estado} estados={v.estados} />;
  // Un estado que no está en la lista (la sacaron o se sumó en ClickUp después de leerla) se ve igual, no el primero.
  const conocido = v.estados.some((x) => x.status === a.estado);
  const opciones = conocido ? lista : <>{lista}<option value={a.estado}><EstadoClickup estado={a.estado} color={null} /></option></>;
  // El desplegable también va pintado del color del estado, como en ClickUp.
  return <Select value={a.estado} onChange={(e) => onChange(e.target.value)} className="input sm st-select" style={estiloEstado(v.estados.find((x) => x.status === a.estado)?.color)}
    aria-label={`Estado de ${a.nombre}`}>{opciones}</Select>;
}
const cacheEstados = new WeakMap<Estado[], ReactNode>();
function useOpcionesEstado(estados: Estado[]) {
  if (!cacheEstados.has(estados)) {
    cacheEstados.set(estados, estados.map((e) => <option key={e.status} value={e.status}><EstadoClickup estado={e.status} color={e.color} /></option>));
  }
  return cacheEstados.get(estados);
}

// La fecha se ve como texto («mié 18/11»); con permiso, un clic abre el calendario y se guarda al elegir. Vacía se borra.
function FechaCelda({ valor, editable, onChange, label, alerta }: { valor: string | null; editable: boolean; onChange: (v: string) => void; label: string; alerta?: boolean }) {
  const [editando, setEditando] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hecho = useRef(false);   // ya se cerró (con Enter o Escape): el blur que viene después no vuelve a guardar
  useEffect(() => {
    if (!editando) return;
    hecho.current = false;
    input.current?.focus();
    try { input.current?.showPicker?.(); } catch { /* algunos navegadores no lo dejan abrir solo */ }
  }, [editando]);
  const texto = dia(valor);
  if (!editable) return <span className={alerta ? 'fecha-alerta' : undefined}>{texto || <span className="muted">—</span>}</span>;
  // Se guarda al salir del campo (o con Enter), no mientras se escribe el año; Escape deja la que estaba.
  if (editando) {
    const cerrar = (guardar: boolean) => {
      if (hecho.current) return;
      hecho.current = true;
      const x = input.current;
      setEditando(false);
      if (!guardar || !x || x.validity.badInput) return;
      if (x.value !== (valor ?? '') && (!x.value || x.value >= '2000-01-01')) onChange(x.value);
    };
    return (
      <input ref={input} type="date" className="input sm fecha-input" defaultValue={valor ?? ''} aria-label={label}
        onBlur={() => cerrar(true)} onKeyDown={(e) => { if (e.key === 'Enter') cerrar(true); if (e.key === 'Escape') cerrar(false); }} />
    );
  }
  return (
    <button type="button" className={`fecha-btn${alerta ? ' fecha-alerta' : ''}${texto ? '' : ' vacia'}`} onClick={() => setEditando(true)}
      aria-label={`${label}: ${texto || 'sin fecha'}. Cambiar`} title={alerta ? 'Ya pasó y no está listo' : 'Cambiar la fecha'}>
      {texto || '—'}
    </button>
  );
}

// Proveedor o impresor: una opción por empresa (las repetidas de ClickUp juntas) y las que no son empresas («STOCK»).
function opcionesDe(v: Vista, campo: 'proveedor' | 'impresor') {
  const ops = v.opciones.filter((o) => o.campo === campo);
  const vistas = new Set<number>();
  const lista: Array<{ value: string; label: string }> = [];
  for (const o of ops) {
    if (o.company_id) {
      if (vistas.has(o.company_id)) continue;
      vistas.add(o.company_id);
      lista.push({ value: o.option_id, label: o.empresa ?? o.nombre });
    } else lista.push({ value: o.option_id, label: o.nombre });
  }
  return lista.sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
// El valor elegido, como se ve: el nombre de su empresa.
const etiquetaOpcion = (v: Vista, campo: 'proveedor' | 'impresor', id: string | null) => {
  if (!id) return null;
  const o = v.opciones.find((x) => x.campo === campo && x.option_id === id);
  return o ? { label: o.empresa ?? o.nombre, company: o.company_id } : { label: id, company: null };
};

function OpcionCelda({ v, campo, valor, editable, onChange, opciones, label }: {
  v: Vista; campo: 'proveedor' | 'impresor'; valor: string | null; editable: boolean; onChange: (x: string) => void; opciones: ReactNode; label: string;
}) {
  const et = etiquetaOpcion(v, campo, valor);
  if (!editable) {
    if (!et) return <span className="muted">—</span>;
    const nombre = <NombreProveedor>{et.label}</NombreProveedor>;
    return et.company ? <Link to={recordUrl('company', et.company)} className="ellipsis">{nombre}</Link> : <span className="ellipsis">{nombre}</span>;
  }
  // Si lo elegido es una opción repetida (la otra de la misma empresa), se muestra como la de la empresa.
  const o = valor ? v.opciones.find((x) => x.campo === campo && x.option_id === valor) : null;
  const visible = o?.company_id ? v.opciones.find((x) => x.campo === campo && x.company_id === o.company_id && opcionesDe(v, campo).some((y) => y.value === x.option_id))?.option_id ?? valor : valor;
  return (
    <Select value={visible ?? ''} onChange={(e) => onChange(e.target.value)} className="input sm" aria-label={label} placeholder="—">
      <option value="">—</option>
      {opciones}
    </Select>
  );
}

// ---------- Lista: el PDV y abajo sus artículos ----------

// La flecha de abrir y cerrar, como en ClickUp: para abajo si está abierto, para la derecha si está cerrado.
const Flecha = ({ abierto }: { abierto: boolean }) => <span className={`flecha${abierto ? '' : ' cerrada'}`}><Icon name="down" size={14} /></span>;

function Lista({ pdvs, v, editar, abierto, onToggle, onTodos, onAbrir, sel }: {
  pdvs: Pdv[]; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; abierto: (id: string) => boolean; onToggle: (id: string) => void; onTodos: (abrir: boolean) => void; onAbrir: (p: Pdv) => void; sel: number | null;
}) {
  const provs = useMemo(() => opcionesDe(v, 'proveedor').map((o) => <option key={o.value} value={o.value}><NombreProveedor>{o.label}</NombreProveedor></option>), [v.opciones]);   // eslint-disable-line react-hooks/exhaustive-deps
  const imps = useMemo(() => opcionesDe(v, 'impresor').map((o) => <option key={o.value} value={o.value}><NombreProveedor>{o.label}</NombreProveedor></option>), [v.opciones]);    // eslint-disable-line react-hooks/exhaustive-deps
  const todosAbiertos = pdvs.every((p) => abierto(p.task_id));
  return (
    <div className="table-wrap prod-wrap">
      <table className="grid prod-grid">
        <thead>
          <tr>
            <th className="nosort prod-nombre">
              <button type="button" className="btn ghost xs" onClick={() => onTodos(!todosAbiertos)} aria-label={todosAbiertos ? 'Cerrar todos' : 'Abrir todos'} title={todosAbiertos ? 'Cerrar todos' : 'Abrir todos'}>
                <Flecha abierto={todosAbiertos} /></button>
              PDV / artículo</th>
            <th className="nosort">Estado</th>
            <th className="nosort">Asignado</th>
            <th className="nosort numcol">Cantidad</th>
            <th className="nosort" title="ENTREGAS (FECHA REAL) en ClickUp">Entrega</th>
            <th className="nosort">Proveedor</th>
            <th className="nosort">Impresor</th>
            <th className="nosort" title="Llega del proveedor">Ingreso prov.</th>
            <th className="nosort" title="Se retira del proveedor">Retiro prov.</th>
            <th className="nosort" title="Va al impresor">Egreso imp.</th>
            <th className="nosort" title="Se retira del impresor">Retiro imp.</th>
            <th className="nosort" aria-label="ClickUp" />
          </tr>
        </thead>
        <tbody>
          {pdvs.map((p) => <GrupoPdv key={p.task_id} p={p} v={v} editar={editar} abierto={abierto(p.task_id)} onToggle={onToggle} provs={provs} imps={imps} onAbrir={onAbrir} elegido={!!p.record_id && p.record_id === sel} />)}
        </tbody>
      </table>
    </div>
  );
}

const GrupoPdv = memo(function GrupoPdv({ p, v, editar, abierto, onToggle, provs, imps, onAbrir, elegido }: {
  p: Pdv; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; abierto: boolean; onToggle: (id: string) => void; provs: ReactNode; imps: ReactNode;
  onAbrir: (p: Pdv) => void; elegido: boolean;
}) {
  const clic = p.record_id ? (e: React.MouseEvent) => { if (!clicAdentro(e)) onAbrir(p); } : undefined;
  const cls = `${p.record_id ? ' abre' : ''}${elegido ? ' sel' : ''}`;
  const { meta } = useMeta();
  const ed = v.puede_editar && p.editable;
  const etapa = p.etapa ? formatValue(meta, 'order', 'hs_pipeline_stage', p.etapa) : '';
  const listo = p.total > 0 && p.listos >= p.total;
  const atrasado = (f: string | null) => !!f && f < hoyIso() && !listo;
  return (
    <>
      <tr className={`prod-pdv${cls}`} onClick={clic} title={p.record_id ? `Ver el pedido del PDV ${p.npdv}` : undefined}>
        <td className="prod-nombre">
          <div className="row" style={{ gap: 6, minWidth: 0 }}>
            <button type="button" className="btn ghost xs" onClick={() => onToggle(p.task_id)} aria-expanded={abierto} aria-label={`${abierto ? 'Cerrar' : 'Abrir'} PDV ${p.npdv}`}>
              <Flecha abierto={abierto} /></button>
            <Icon name="order" size={15} />
            <div className="prod-pdv-t">
              <div className="ellipsis">
                {p.record_id ? <Link to={recordUrl('order', p.record_id)}><b>PDV {p.npdv}</b></Link> : <b>PDV {p.npdv}</b>}
                <span className="muted"> · {p.cliente ?? 'Sin cliente'}</span>
              </div>
              <div className="small muted ellipsis">
                {[p.vendedor && `Vende ${p.vendedor}`, p.entrega_prometida && `Prometido ${dia(p.entrega_prometida.slice(0, 10))}`, p.unidad && UNIDADES.find((u) => u.value === p.unidad)?.label]
                  .filter(Boolean).join(' · ')}
                {p.etiquetas.map((t) => <span key={t} className="tag" style={{ marginLeft: 6, height: 18 }}>{t}</span>)}
              </div>
            </div>
          </div>
        </td>
        <td>
          <div className="row" style={{ gap: 6 }}>
            {etapa ? <EtapaPedido value={p.etapa} label={etapa} /> : <span className="muted small">Sin arrancar</span>}
            {p.total > 0 && <span className={`prod-avance${listo ? ' ok' : ''}`} title={`${p.listos} de ${p.total} artículos listos`}>{p.listos}/{p.total}</span>}
          </div>
        </td>
        <td><Asignados ids={p.asignados_todos} personas={v.personas} editable={false} label={`PDV ${p.npdv}`} /></td>
        <td className="numcell muted">{p.articulos.length > 1 ? `${p.articulos.length} art.` : ''}</td>
        <td><FechaCelda valor={p.entrega_real} editable={ed} label={`Entrega del PDV ${p.npdv}`} alerta={atrasado(p.entrega_real)} onChange={(x) => editar(p, p.task_id, 'entrega_real', x)} /></td>
        <td colSpan={6} className="small muted">
          {ed && <span className="row" style={{ gap: 6 }}>Asignado al PDV: <Asignados ids={p.asignados} personas={v.personas} editable label={`Asignado al PDV ${p.npdv}`} onChange={(ids) => editar(p, p.task_id, 'asignados', ids)} /></span>}
          {!ed && !p.editable && <span>Se trabaja en ClickUp</span>}
        </td>
        <td>{p.url && <a href={p.url} target="_blank" rel="noreferrer" className="btn ghost xs" title="Abrir en ClickUp" aria-label={`Abrir PDV ${p.npdv} en ClickUp`}><Icon name="external" size={14} /></a>}</td>
      </tr>
      {abierto && p.articulos.map((a) => (
        <FilaArticulo key={a.task_id} a={a} p={p} v={v} ed={ed} editar={editar} provs={provs} imps={imps} listo={listo} clic={clic} cls={cls} />
      ))}
      {abierto && !p.articulos.length && <tr className="prod-art"><td colSpan={12} className="small muted prod-vacio">Sin artículos abiertos.</td></tr>}
    </>
  );
});

function FilaArticulo({ a, p, v, ed, editar, provs, imps, listo, clic, cls }: {
  a: Articulo; p: Pdv; v: Vista; ed: boolean; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; provs: ReactNode; imps: ReactNode; listo: boolean;
  clic?: (e: React.MouseEvent) => void; cls: string;
}) {
  const set = (c: Campo) => (x: unknown) => editar(p, a.task_id, c, x);
  const artListo = ['listo para entergar', 'entregados'].includes(a.estado);
  const atras = (f: string | null) => !!f && f < hoyIso() && !artListo && !listo;
  return (
    <tr className={`prod-art${CERRADOS.includes(a.estado) ? ' cerrado' : ''}${cls}`} onClick={clic}>
      <td className="prod-nombre"><div className="prod-art-t" title={a.nombre}><FotoProducto url={a.foto} nombre={a.nombre} /><span className="ellipsis">{a.nombre}</span></div></td>
      <td><EstadoCelda a={a} v={v} editable={ed} onChange={set('estado')} /></td>
      <td><Asignados ids={a.asignados} personas={v.personas} editable={ed} onChange={set('asignados')} label={a.nombre} /></td>
      <td className="numcell">{a.cantidad != null ? a.cantidad.toLocaleString('es-AR') : <span className="muted">—</span>}</td>
      <td><FechaCelda valor={a.entrega_real} editable={ed} onChange={set('entrega_real')} label={`Entrega de ${a.nombre}`} alerta={atras(a.entrega_real)} /></td>
      <td className="opcion-cell"><OpcionCelda v={v} campo="proveedor" valor={a.proveedor} editable={ed} onChange={set('proveedor')} opciones={provs} label={`Proveedor de ${a.nombre}`} /></td>
      <td className="opcion-cell"><OpcionCelda v={v} campo="impresor" valor={a.impresor} editable={ed} onChange={set('impresor')} opciones={imps} label={`Impresor de ${a.nombre}`} /></td>
      <td><FechaCelda valor={a.ingreso_proveedor} editable={ed} onChange={set('ingreso_proveedor')} label={`Ingreso del proveedor de ${a.nombre}`} /></td>
      <td><FechaCelda valor={a.retiro_proveedor} editable={ed} onChange={set('retiro_proveedor')} label={`Retiro del proveedor de ${a.nombre}`} /></td>
      <td><FechaCelda valor={a.egreso_impresor} editable={ed} onChange={set('egreso_impresor')} label={`Egreso al impresor de ${a.nombre}`} /></td>
      <td><FechaCelda valor={a.retiro_impresor} editable={ed} onChange={set('retiro_impresor')} label={`Retiro del impresor de ${a.nombre}`} /></td>
      <td>{a.url && <a href={a.url} target="_blank" rel="noreferrer" className="btn ghost xs" title="Abrir en ClickUp" aria-label={`Abrir ${a.nombre} en ClickUp`}><Icon name="external" size={14} /></a>}</td>
    </tr>
  );
}

// La foto del producto a la izquierda del nombre, como en los productos del pedido (la misma foto). Un clic la abre
// grande; sin foto, el ícono de producto.
const fotosRotas = new Set<string>();
function FotoProducto({ url, nombre, grande }: { url?: string | null; nombre: string; grande?: boolean }) {
  const [rota, setRota] = useState(() => !url || fotosRotas.has(url));
  useEffect(() => { setRota(!url || fotosRotas.has(url)); }, [url]);
  const cls = `prod-foto${grande ? ' grande' : ''}`;
  if (rota || !url) return <span className={`${cls} vacia`} aria-hidden><Icon name="order" size={grande ? 18 : 14} /></span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cls} title={`Ver la foto de ${nombre}`} onClick={(e) => e.stopPropagation()} draggable={false}>
      <img src={url} alt="" loading="lazy" draggable={false} onError={() => { fotosRotas.add(url); setRota(true); }} />
    </a>
  );
}

// ---------- Tablero: una columna por etapa del pedido, una tarjeta por PDV con sus artículos adentro ----------

// Pedido de Rodrigo del 12/11/2026: el PDV es la tarjeta y sus productos van como hijos, cada uno con su estado. Las
// columnas son la etapa general del PDV (la misma de la lista y de Pedidos), que sale sola de sus artículos.
const SIN_ETAPA = '__sin_etapa';
// Las etapas de producción se ven siempre, aunque estén vacías; las demás, solo si tienen algún PDV.
const SIEMPRE = ['esperando_boceto', '1237498994', '1237498996'];
const MAX_ARTICULOS = 4;

function Tablero({ pdvs, v, editar, onAbrir, sel }: {
  pdvs: Pdv[]; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; onAbrir: (p: Pdv) => void; sel: number | null;
}) {
  const { meta } = useMeta();
  const etapas = propOf(meta, 'order', 'hs_pipeline_stage')?.options ?? [];
  const deEtapa = (e: string) => pdvs.filter((p) => (p.etapa ?? SIN_ETAPA) === e);
  const conocidas = new Set(etapas.map((o) => o.value));
  const otras = [...new Set(pdvs.map((p) => p.etapa ?? SIN_ETAPA))].filter((e) => e !== SIN_ETAPA && !conocidas.has(e));
  const cols = [
    ...(pdvs.some((p) => !p.etapa) ? [{ value: SIN_ETAPA, label: 'Sin arrancar' }] : []),
    ...etapas.map((o) => ({ value: o.value, label: o.label })),
    ...otras.map((e) => ({ value: e, label: e })),
  ].filter((c) => SIEMPRE.includes(c.value) || deEtapa(c.value).length);
  return (
    <div className="board prod-board">
      {cols.map((c) => {
        const lista = deEtapa(c.value);
        const slug = etapaPedidoSlug(c.value);
        return (
          <div key={c.value} className="col">
            <div className={`col-head etapa-col${slug ? ` e-${slug}` : ''}`}>
              <div className="t">{slug ? <EtapaPedido value={c.value} label={c.label} /> : <span>{c.label}</span>}<span className="n">{lista.length}</span></div>
            </div>
            <div className="col-body">
              {lista.map((p) => <TarjetaPdv key={p.task_id} p={p} v={v} editar={editar} onAbrir={onAbrir} elegido={!!p.record_id && p.record_id === sel} />)}
              {!lista.length && <div className="small muted" style={{ padding: '4px 4px 8px' }}>—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TarjetaPdv = memo(function TarjetaPdv({ p, v, editar, onAbrir, elegido }: {
  p: Pdv; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; onAbrir: (p: Pdv) => void; elegido: boolean;
}) {
  const [todos, setTodos] = useState(false);
  const ed = v.puede_editar && p.editable;
  const listo = p.total > 0 && p.listos >= p.total;
  const arts = todos ? p.articulos : p.articulos.slice(0, MAX_ARTICULOS);
  const resto = p.articulos.length - arts.length;
  const atrasada = !!p.entrega_real && p.entrega_real < hoyIso() && !listo;
  return (
    <div className={`card prod-pdv-card${p.record_id ? ' abre' : ''}${elegido ? ' sel' : ''}`}
      onClick={(e) => { if (p.record_id && !clicAdentro(e)) onAbrir(p); }} title={p.record_id ? `Ver el pedido del PDV ${p.npdv}` : undefined}>
      <div className="prod-pdv-card-head">
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          {p.record_id ? <Link to={recordUrl('order', p.record_id)} className="prod-npdv">PDV {p.npdv}</Link> : <span className="prod-npdv">PDV {p.npdv}</span>}
          <span className="grow" />
          {p.total > 0 && <span className={`prod-avance${listo ? ' ok' : ''}`} title={`${p.listos} de ${p.total} artículos listos`}>{p.listos}/{p.total}</span>}
        </div>
        <div className="prod-cliente ellipsis" title={p.cliente ?? undefined}>{p.cliente ?? 'Sin cliente'}</div>
        <div className="small muted ellipsis">
          {[p.vendedor && `Vende ${p.vendedor}`, p.entrega_prometida && `Prometido ${dia(p.entrega_prometida.slice(0, 10))}`].filter(Boolean).join(' · ')}
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'space-between', minWidth: 0 }}>
          <Asignados ids={p.asignados_todos} personas={v.personas} editable={false} label={`PDV ${p.npdv}`} />
          {p.entrega_real && <span className={`small${atrasada ? ' fecha-alerta' : ' muted'}`} title="Entrega">Entrega {dia(p.entrega_real)}</span>}
        </div>
      </div>
      <div className="prod-hijos">
        {arts.map((a) => <HijoArticulo key={a.task_id} a={a} p={p} v={v} ed={ed} editar={editar} />)}
        {!p.articulos.length && <div className="small muted prod-hijo">Sin artículos abiertos.</div>}
        {(resto > 0 || todos) && p.articulos.length > MAX_ARTICULOS && (
          <button type="button" className="btn ghost xs prod-mas" onClick={() => setTodos(!todos)}>
            {todos ? 'Ver menos' : `+ ${resto} producto${resto === 1 ? '' : 's'} más`}
          </button>
        )}
      </div>
    </div>
  );
});

function HijoArticulo({ a, p, v, ed, editar }: { a: Articulo; p: Pdv; v: Vista; ed: boolean; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void }) {
  const prov = etiquetaOpcion(v, 'proveedor', a.proveedor);
  const imp = etiquetaOpcion(v, 'impresor', a.impresor);
  return (
    <div className={`prod-hijo${CERRADOS.includes(a.estado) ? ' cerrado' : ''}`}>
      <div className="row" style={{ gap: 8, minWidth: 0, alignItems: 'flex-start' }}>
        <FotoProducto url={a.foto} nombre={a.nombre} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="prod-hijo-t" title={a.nombre}>{a.nombre}</div>
          <div className="small muted ellipsis prod-card-provs">
            {[a.cantidad != null && `${a.cantidad.toLocaleString('es-AR')} u.`, prov && <NombreProveedor>{prov.label}</NombreProveedor>, imp && <>imp. <NombreProveedor>{imp.label}</NombreProveedor></>]
              .filter(Boolean).map((x, i) => <Fragment key={i}>{i > 0 && ' · '}{x}</Fragment>)}
          </div>
        </div>
      </div>
      <div className="row prod-hijo-pie">
        <EstadoCelda a={a} v={v} editable={ed} onChange={(s) => editar(p, a.task_id, 'estado', s)} />
        <Asignados ids={a.asignados} personas={v.personas} editable={ed} onChange={(ids) => editar(p, a.task_id, 'asignados', ids)} label={a.nombre} />
      </div>
    </div>
  );
}
