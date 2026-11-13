import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, Icon, recordUrl, formatValue, useDebounced, propOf, userOf } from '../lib';
import { PestanasVistas, esFija, useOrdenPestanas, type VistaGuardada } from '../vistas';
import { Avatar, UserAvatar, EtapaPedido, EstadoClickup, estiloEstado, etapaPedidoSlug } from '../components';
import { Select } from '../Select';
import { SelectorFecha } from '../Fecha';
import { cumple, FiltroEncabezado, FiltrosActivos, hayFiltros, limpiar, type ColFiltro, type Ctx as CtxFiltros, type FiltrosCol } from './ProduccionFiltros';
import { NombreProveedor } from '../proveedores';
import { RecordPreview } from './RecordPage';
import { BotonVacias, useColapso } from './Board';

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
  logo?: string | null;   // ok, textos, no_vectorial, sin_verificar o falta (logos.ts)
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
// Las que se ofrecen para filtrar y configurar: Mercado Libre hoy no hace falta (su nombre queda para los PDV que la tengan).
const UNIDADES_VISIBLES = UNIDADES.filter((u) => u.value !== 'MERCADO LIBRE');
const CERRADOS = ['entregados', 'anulado'];

// Lo que guarda una vista de Producción (pestañas, como en Pedidos): búsqueda, unidades, a quién está asignado, vendedor,
// cliente, si se ven los entregados y lista o tablero.
// También los filtros por columna (ProduccionFiltros.tsx: estado, cantidad, fechas, proveedor, impresor).
interface ConfigProd { q: string; unidades: string[]; persona: string; vendedor?: string; cliente?: string; cerrados: boolean; modo: 'lista' | 'tablero'; columnas?: FiltrosCol;
  vacias?: boolean }   // tablero: colapsar las columnas vacías (Board.tsx, useColapso)
const normCols = (f?: FiltrosCol) => JSON.stringify(Object.entries(limpiar(f ?? {})).map(([k, x]) => [k, Array.isArray(x) ? [...x].sort() : x]));
const normConfig = (c: Partial<ConfigProd>) => JSON.stringify([(c.q ?? '').trim(), [...(c.unidades ?? [])].sort(), c.persona ?? '', c.vendedor ?? '', c.cliente ?? '', !!c.cerrados, c.modo ?? 'lista', normCols(c.columnas), !!c.vacias]);

// Quién vende el PDV (pedido de Rodrigo del 12/11/2026, con su foto y como filtro): el propietario del pedido en el CRM
// y, si el PDV no tiene pedido, el VENDEDOR de ClickUp.
const claveVendedor = (p: { owner_id: number | null; vendedor: string | null }) => (p.owner_id ? `u${p.owner_id}` : p.vendedor ? `n:${p.vendedor}` : '');
function Vendedor({ p }: { p: { owner_id: number | null; vendedor: string | null } }) {
  const { meta } = useMeta();
  const u = p.owner_id ? userOf(meta, p.owner_id) : null;
  const nombre = u?.name ?? p.vendedor;
  if (!nombre) return null;
  return <span className="prod-vende" title={`Vende ${nombre}`}>{u ? <UserAvatar id={u.id} size="xs" /> : <Avatar name={nombre} size="xs" />}{nombre}</span>;
}

// Preferencias de cada uno en este navegador (lista o tablero, colapsado). Si el navegador no deja guardar, no pasa nada.
const PREF = 'produccion:pref';
function leerPref(): { modo?: 'lista' | 'tablero'; unidades?: string[]; persona?: string; colapsado?: boolean; vacias?: boolean } {
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
  // Pestañas de vistas (vistas.tsx): «Todos», «Míos» y las guardadas, en el orden de cada uno. Se abre la del link o la primera.
  const [params, setParams] = useSearchParams();
  const vistas = useAsync(() => http<Array<VistaGuardada<ConfigProd>>>('GET', '/views/produccion'), []);
  const { pestanas, guardar: guardarOrden } = useOrdenPestanas('produccion', vistas.data);
  const [activa, setActiva] = useState(() => params.get('v') ?? pestanas[0]);
  const [modo, setModo] = useState<'lista' | 'tablero'>(pref.modo ?? 'lista');
  // Tablero: colapsar las columnas vacías. En «Todos» y «Míos» queda en este navegador; en una vista, con la vista.
  const [vacias, setVacias] = useState(!!pref.vacias);
  // Sin unidades elegidas: las que se trabajan desde el CRM (las manda el servidor; quedan en `base`).
  const [unidades, setUnidades] = useState<string[] | null>(null);
  const [base, setBase] = useState<string[] | null>(null);
  const [persona, setPersona] = useState(activa === 'mine' ? 'yo' : '');
  const [vendedor, setVendedor] = useState('');
  const [cliente, setCliente] = useState('');
  const [columnas, setColumnas] = useState<FiltrosCol>({});
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
      if (!unidades) { setUnidades(d.unidades); setBase(d.unidades); }
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
  // Lo que necesitan los filtros por columna: estados, opciones y cuántos productos hay con cada valor.
  const ctxFiltros = useMemo<CtxFiltros>(() => {
    // Una opción por empresa y, las que no son empresa («STOCK», repetida en ClickUp), una por nombre.
    const unicas = (campo: 'proveedor' | 'impresor') => (v ? opcionesDe(v, campo) : []).filter((o, i, a) => a.findIndex((x) => x.label.trim().toLowerCase() === o.label.trim().toLowerCase()) === i);
    const ops = { proveedor: unicas('proveedor'), impresor: unicas('impresor') };
    const mismaEmpresa = (campo: 'proveedor' | 'impresor', id: string) => {
      const o = v?.opciones.find((x) => x.campo === campo && x.option_id === id);
      if (!o) return [id];
      const nombre = (o.empresa ?? o.nombre).trim().toLowerCase();
      return (v?.opciones ?? []).filter((x) => x.campo === campo && (o.company_id ? x.company_id === o.company_id : (x.empresa ?? x.nombre).trim().toLowerCase() === nombre)).map((x) => x.option_id);
    };
    const arts = (v?.pdvs ?? []).flatMap((p) => p.articulos);
    const cache = new Map<string, number>();
    const cuenta = (col: ColFiltro, valor: string) => {
      const k = `${col}:${valor}`;
      if (!cache.has(k)) cache.set(k, arts.filter((a) => cumple(a, { [col]: ['estado', 'proveedor', 'impresor'].includes(col) ? [valor] : valor } as FiltrosCol, { mismaEmpresa })).length);
      return cache.get(k)!;
    };
    // Los estados de la lista y, por si alguno no está (se sumó en ClickUp después de leerla), los que tienen los productos.
    const conocidos = v?.estados ?? [];
    const otros = [...new Set(arts.map((a) => a.estado))].filter((s) => s && !conocidos.some((e) => e.status === s)).map((s) => ({ status: s, color: '#87909e' }));
    return { estados: [...conocidos, ...otros], opciones: ops, mismaEmpresa, cuenta };
  }, [v]);
  const filtrados = useMemo(() => {
    if (!v) return [];
    const t = q.trim().toLowerCase();
    // Con filtros por columna, de cada PDV quedan solo los productos que cumplen (y el PDV, si le queda alguno).
    const porColumna = hayFiltros(columnas);
    const pdvs = porColumna ? v.pdvs.map((p) => ({ ...p, articulos: p.articulos.filter((a) => cumple(a, columnas, ctxFiltros)) })).filter((p) => p.articulos.length) : v.pdvs;
    return pdvs.filter((p) => {
      if (persona === 'nadie' && p.asignados_todos.length) return false;
      // «Míos»: lo que tengo asignado en producción o los pedidos que son míos (para quien vende).
      if (persona === 'yo' && !((yo && p.asignados_todos.includes(yo.clickup_id)) || p.owner_id === meta.me.id)) return false;
      if (persona && persona !== 'nadie' && persona !== 'yo' && !p.asignados_todos.includes(Number(persona))) return false;
      if (vendedor && claveVendedor(p) !== vendedor) return false;
      if (cliente && (p.cliente ?? '') !== cliente) return false;
      if (!t) return true;
      return [p.npdv, p.cliente, p.vendedor, p.pedido, ...p.articulos.map((a) => a.nombre)].some((x) => String(x ?? '').toLowerCase().includes(t));
    });
  }, [v, q, persona, vendedor, cliente, columnas, ctxFiltros, yo?.clickup_id, meta.me.id]);
  // Las opciones de vendedor y cliente: las que hay en los PDV que se ven (con las unidades y «entregados» elegidos).
  const vendedores = useMemo(() => {
    const m = new Map<string, { clave: string; nombre: string; p: Pdv }>();
    for (const p of v?.pdvs ?? []) {
      const k = claveVendedor(p);
      if (k && !m.has(k)) m.set(k, { clave: k, nombre: (p.owner_id ? userOf(meta, p.owner_id)?.name : null) ?? p.vendedor ?? '', p });
    }
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [v, meta]);
  const clientes = useMemo(() => [...new Set((v?.pdvs ?? []).map((p) => p.cliente).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, 'es')), [v]);

  const cambiarUnidades = (u: string[]) => setUnidades(u);
  const cambiarPersona = (p: string) => setPersona(p);
  const cambiarModo = (m: 'lista' | 'tablero') => { setModo(m); guardarPref({ modo: m }); };
  const cambiarVacias = (x: boolean) => { setVacias(x); if (esFija(activa)) guardarPref({ vacias: x }); };

  // Abrir una pestaña: «Todos» y «Míos» limpias (las unidades de siempre, sin entregados); una vista, como está guardada.
  const vistaDe = (k: string) => vistas.data?.find((x) => String(x.id) === k);
  const elegir = (k: string) => {
    setActiva(k);
    setParams((p) => { if (k === pestanas[0]) p.delete('v'); else p.set('v', k); return p; }, { replace: true });
    const vista = vistaDe(k);
    if (esFija(k)) { setUnidades(base); setPersona(k === 'mine' ? 'yo' : ''); setVendedor(''); setCliente(''); setColumnas({}); setCerrados(false); setBuscar(''); }
    else if (vista) {
      const c = vista.config;
      setUnidades(c.unidades?.length ? c.unidades : base); setPersona(c.persona ?? ''); setVendedor(c.vendedor ?? ''); setCliente(c.cliente ?? '');
      setCerrados(!!c.cerrados); setBuscar(c.q ?? ''); setColumnas(c.columnas ?? {});
      if (c.modo) setModo(c.modo);
      setVacias(!!c.vacias);
    }
    if (esFija(k)) setVacias(!!leerPref().vacias);
    // Una vista recién guardada que todavía no llegó: queda como se ve (es lo que se guardó).
  };
  // Al llegar las vistas: se aplica la que se abrió (del link o la primera); si ya no existe, la primera pestaña.
  const aplicada = useRef(false);
  useEffect(() => {
    if (!vistas.data || aplicada.current) return;
    aplicada.current = true;
    if (!esFija(activa)) { if (vistaDe(activa)) elegir(activa); else elegir(pestanas[0]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vistas.data]);
  const actual: ConfigProd = { q: buscar, unidades: unidades ?? base ?? [], persona, vendedor, cliente, cerrados, modo, ...(hayFiltros(columnas) ? { columnas: limpiar(columnas) } : {}), ...(vacias ? { vacias: true } : {}) };
  const filtrosCambiados = !!base && normConfig({ ...actual, q: '', modo: 'lista', vacias: false })
    !== normConfig({ q: '', unidades: base, persona: activa === 'mine' ? 'yo' : '', cerrados: false, modo: 'lista' });
  const articulos = filtrados.reduce((n, p) => n + p.articulos.length, 0);
  const soloLectura = v && !v.puede_editar;

  return (
    // En lista, como Pedidos y Tareas (list-fixed): la tabla ocupa el resto de la pantalla y se desplaza adentro, con las
    // barras (también la de los costados) siempre a la vista.
    <div className={`content prod-page${modo === 'lista' ? ' list-fixed' : ''}`}>
      <div className="page-head">
        <h1>Producción {v && <span className="muted small">{filtrados.length} PDV · {articulos} artículos</span>}</h1>
        <div className="seg" role="group" aria-label="Vista">
          <button type="button" className={modo === 'lista' ? 'on' : ''} aria-pressed={modo === 'lista'} onClick={() => cambiarModo('lista')}><Icon name="table" size={14} />Lista</button>
          <button type="button" className={modo === 'tablero' ? 'on' : ''} aria-pressed={modo === 'tablero'} onClick={() => cambiarModo('tablero')}><Icon name="board" size={14} />Tablero</button>
        </div>
      </div>
      <PestanasVistas tipo="produccion" vistas={vistas.data} pestanas={pestanas} guardarOrden={guardarOrden} activa={activa} onElegir={elegir}
        recargar={vistas.reload} actual={actual} igual={(a, b) => normConfig(a) === normConfig({ ...b, unidades: b.unidades?.length ? b.unidades : base ?? [] })}
        filtrosCambiados={filtrosCambiados} ayudaGuardar="Guarda la búsqueda, las unidades, a quién está asignado, el vendedor, el cliente, los filtros por columna, si se ven los entregados y si se ve en lista o tablero." />
      {/* La barra de filtros, igual en todos los módulos: buscar, filtros, «Filtros» y, a la derecha, lo que es de la vista. */}
      <div className="toolbar">
        <div className="search"><Icon name="search" />
          <input className="input" placeholder="Buscar PDV, cliente o producto" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
        </div>
        <div className="btn-group" role="group" aria-label="Unidades de negocio">
          {UNIDADES_VISIBLES.map((u) => {
            const on = (unidades ?? []).includes(u.value);
            return <button key={u.value} type="button" className={`btn qf-btn${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => cambiarUnidades(on ? (unidades ?? []).filter((x) => x !== u.value) : [...(unidades ?? []), u.value])}>{u.label}</button>;
          })}
        </div>
        <div className="bar-select">
          <Select value={persona} onChange={(e) => cambiarPersona(e.target.value)} aria-label="Asignado a" className={`input${persona ? ' on' : ''}`}>
            <option value="">Asignado: todos</option>
            <option value="yo">{yo ? personaOpcion(yo, ' (yo)') : 'Míos (mis pedidos)'}</option>
            {personas.filter((p) => p !== yo).map((p) => <option key={p.clickup_id} value={String(p.clickup_id)}>{personaOpcion(p)}</option>)}
            <option value="nadie">Sin asignar</option>
          </Select>
        </div>
        <div className="bar-select">
          <Select value={vendedor} onChange={(e) => setVendedor(e.target.value)} aria-label="Vendedor" className={`input${vendedor ? ' on' : ''}`}>
            <option value="">Vendedor: todos</option>
            {vendedor && !vendedores.some((x) => x.clave === vendedor) && <option value={vendedor}>{vendedor.replace(/^n:|^u/, '')}</option>}
            {vendedores.map((x) => <option key={x.clave} value={x.clave}><Vendedor p={x.p} /></option>)}
          </Select>
        </div>
        <div className="bar-select">
          <Select value={cliente} onChange={(e) => setCliente(e.target.value)} aria-label="Cliente" className={`input${cliente ? ' on' : ''}`}>
            <option value="">Cliente: todos</option>
            {cliente && !clientes.includes(cliente) && <option value={cliente}>{cliente}</option>}
            {clientes.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <button type="button" className={`btn qf-btn${cerrados ? ' on' : ''}`} aria-pressed={cerrados} onClick={() => setCerrados(!cerrados)}
          title="Suma los PDV entregados o anulados en los últimos 30 días">Ver entregados (30 días)</button>
        {v && <FiltrosActivos f={columnas} onChange={setColumnas} ctx={ctxFiltros} />}
        <div className="bar-end">
          {modo === 'tablero' && <BotonVacias value={vacias} onChange={cambiarVacias} />}
          {modo === 'lista' && (
            <button type="button" className="btn ghost" onClick={() => cambiarColapsado(!colapsado)} aria-pressed={colapsado}
              title={colapsado ? 'Mostrar los artículos de cada PDV' : 'Ver solo los PDV, sin sus artículos'}>
              <Flecha abierto={!colapsado} />{colapsado ? 'Expandir todo' : 'Colapsar todo'}
            </button>
          )}
          {meta.me.role === 'admin' && v && <ConfigUnidades config={v.config} onGuardado={cargar} />}
        </div>
      </div>
      {v && <AvisoUnidades v={v} unidades={unidades ?? []} />}
      {soloLectura && <div className="aviso info small" style={{ marginBottom: 12 }}>Ves la producción para saber cómo vienen los pedidos. La editan las usuarias con perfil Producción.</div>}
      {error && <div className="aviso warn small" style={{ marginBottom: 12 }}>{error}</div>}
      {!v && cargando && <div className="empty plain">Cargando la producción…</div>}
      {v && !filtrados.length && !cargando && (
        <div className="empty plain">{v.pdvs.length ? 'Ningún PDV con esos filtros.' : 'No hay PDV en producción para estas unidades. Si recién se instaló, la primera lectura de ClickUp tarda unas corridas (cada 10 minutos).'}</div>
      )}
      {v && filtrados.length > 0 && (modo === 'lista'
        ? <Lista pdvs={filtrados} v={v} editar={editar} filtros={{ f: columnas, onChange: setColumnas, ctx: ctxFiltros }} abierto={(id) => colapsado === excepciones.has(id)} onAbrir={abrir} sel={preview}
            onToggle={(id) => setExcepciones((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onTodos={(abrir) => cambiarColapsado(!abrir)} />
        : <Tablero pdvs={filtrados} v={v} editar={editar} onAbrir={abrir} sel={preview} vacias={vacias} />)}
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
      <button type="button" className="btn ghost" onClick={() => setOpen(!open)} aria-expanded={open}><Icon name="settings" size={15} />Qué se edita acá</button>
      {open && (
        <div className="popover" style={{ right: 0, top: 36, minWidth: 260 }}>
          <div className="grp">Se trabaja desde el CRM</div>
          {UNIDADES_VISIBLES.map((u) => (
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
// En la fila del PDV: los que tienen algún artículo pero no el PDV («+ Sole en artículos»).
function OtrosEnArticulos({ p, personas }: { p: Pdv; personas: Persona[] }) {
  const otros = p.asignados_todos.filter((id) => !p.asignados.includes(id)).map((id) => personas.find((x) => x.clickup_id === id)).filter((x): x is Persona => !!x);
  if (!otros.length) return null;
  return <span className="small muted ellipsis" title={`También en artículos: ${otros.map((x) => x.nombre).join(', ')}`}>+ {otros.map((x) => primerNombre(x.nombre)).join(', ')} en artículos</span>;
}

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
// Una fecha editable: la celda queda igual (sin campo del navegador que ensanche la columna) y el calendario del CRM se
// abre flotando (Fecha.tsx). Elegir un día lo guarda; «Quitar fecha» la borra.
function FechaCelda({ valor, editable, onChange, label, alerta }: { valor: string | null; editable: boolean; onChange: (v: string) => void; label: string; alerta?: boolean }) {
  const texto = dia(valor);
  if (!editable) return <span className={alerta ? 'fecha-alerta' : undefined}>{texto || <span className="muted">—</span>}</span>;
  return (
    <SelectorFecha valor={valor} onElegir={onChange} className={`fecha-btn${alerta ? ' fecha-alerta' : ''}${texto ? '' : ' vacia'}`}
      label={`${label}: ${texto || 'sin fecha'}. Cambiar`} title={alerta ? 'Ya pasó y no está listo' : 'Cambiar la fecha'}>
      <span>{texto || '—'}</span><Icon name="meeting" size={13} />
    </SelectorFecha>
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

function Lista({ pdvs, v, editar, abierto, onToggle, onTodos, onAbrir, sel, filtros }: {
  filtros: { f: FiltrosCol; onChange: (f: FiltrosCol) => void; ctx: CtxFiltros };
  pdvs: Pdv[]; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; abierto: (id: string) => boolean; onToggle: (id: string) => void; onTodos: (abrir: boolean) => void; onAbrir: (p: Pdv) => void; sel: number | null;
}) {
  const provs = useMemo(() => opcionesDe(v, 'proveedor').map((o) => <option key={o.value} value={o.value}><NombreProveedor>{o.label}</NombreProveedor></option>), [v.opciones]);   // eslint-disable-line react-hooks/exhaustive-deps
  const imps = useMemo(() => opcionesDe(v, 'impresor').map((o) => <option key={o.value} value={o.value}><NombreProveedor>{o.label}</NombreProveedor></option>), [v.opciones]);    // eslint-disable-line react-hooks/exhaustive-deps
  const todosAbiertos = pdvs.every((p) => abierto(p.task_id));
  // El embudo de cada columna (ProduccionFiltros.tsx).
  const fil = (c: ColFiltro) => <FiltroEncabezado col={c} f={filtros.f} onChange={filtros.onChange} ctx={filtros.ctx} />;
  return (
    <div className="table-wrap prod-wrap">
      <table className="grid prod-grid">
        <thead>
          <tr>
            <th className="nosort prod-nombre">
              <button type="button" className="btn ghost xs" onClick={() => onTodos(!todosAbiertos)} aria-label={todosAbiertos ? 'Cerrar todos' : 'Abrir todos'} title={todosAbiertos ? 'Cerrar todos' : 'Abrir todos'}>
                <Flecha abierto={todosAbiertos} /></button>
              PDV / artículo</th>
            <th className="nosort"><span className="th-f">Estado{fil('estado')}</span></th>
            <th className="nosort">Asignado</th>
            <th className="nosort numcol"><span className="th-f">Cantidad{fil('cantidad')}</span></th>
            <th className="nosort" title="ENTREGAS (FECHA REAL) en ClickUp"><span className="th-f">Entrega{fil('entrega_real')}</span></th>
            <th className="nosort"><span className="th-f">Proveedor{fil('proveedor')}</span></th>
            <th className="nosort"><span className="th-f">Impresor{fil('impresor')}</span></th>
            <th className="nosort" title="Llega del proveedor"><span className="th-f">Ingreso prov.{fil('ingreso_proveedor')}</span></th>
            <th className="nosort" title="Se retira del proveedor"><span className="th-f">Retiro prov.{fil('retiro_proveedor')}</span></th>
            <th className="nosort" title="Va al impresor"><span className="th-f">Egreso imp.{fil('egreso_impresor')}</span></th>
            <th className="nosort" title="Se retira del impresor"><span className="th-f">Retiro imp.{fil('retiro_impresor')}</span></th>
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
                <Vendedor p={p} />
                {[(p.owner_id || p.vendedor) ? '' : null, p.entrega_prometida ? `Prometido ${dia(p.entrega_prometida.slice(0, 10))}` : null, p.unidad ? UNIDADES.find((u) => u.value === p.unidad)?.label ?? null : null]
                  .filter((x): x is string => x != null).join(' · ')}
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
        {/* Quién tiene el PDV (editable ahí mismo); si algún artículo lo tiene otra persona, se aclara al lado. */}
        <td>{ed ? <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <Asignados ids={p.asignados} personas={v.personas} editable label={`PDV ${p.npdv}`} onChange={(ids) => editar(p, p.task_id, 'asignados', ids)} />
          <OtrosEnArticulos p={p} personas={v.personas} />
        </span> : <Asignados ids={p.asignados_todos} personas={v.personas} editable={false} label={`PDV ${p.npdv}`} />}</td>
        <td className="numcell muted">{p.articulos.length > 1 ? `${p.articulos.length} art.` : ''}</td>
        <td><FechaCelda valor={p.entrega_real} editable={ed} label={`Entrega del PDV ${p.npdv}`} alerta={atrasado(p.entrega_real)} onChange={(x) => editar(p, p.task_id, 'entrega_real', x)} /></td>
        <td colSpan={6} className="small muted">
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
      <td className="prod-nombre"><div className="prod-art-t" title={a.nombre}><FotoProducto url={a.foto} nombre={a.nombre} /><span className="ellipsis">{a.nombre}</span><AvisoLogo estado={a.logo} /></div></td>
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

// Si el logo del producto no está listo para producir (falta, tiene textos sin curvas o no es vectorial), un aviso al lado
// del nombre; se resuelve en el pedido (Productos → Logo).
const AVISOS_LOGO: Record<string, string> = {
  falta: 'Falta el logo original en curvas (cargalo en el pedido o en la empresa)',
  textos: 'El logo tiene textos sin pasar a curvas',
  no_vectorial: 'El logo no es vectorial (es una imagen)',
};
function AvisoLogo({ estado }: { estado?: string | null }) {
  const t = estado ? AVISOS_LOGO[estado] : null;
  if (!t) return null;
  return <span className={`prod-logo-aviso${estado === 'falta' ? '' : ' mal'}`} title={t} aria-label={t}><Icon name="vector" size={12} />{estado === 'falta' ? 'Sin logo' : 'Logo'}</span>;
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

function Tablero({ pdvs, v, editar, onAbrir, sel, vacias }: {
  pdvs: Pdv[]; v: Vista; editar: (p: Pdv, task: string, c: Campo, valor: unknown) => void; onAbrir: (p: Pdv) => void; sel: number | null; vacias: boolean;
}) {
  const { meta } = useMeta();
  // Columnas angostas: a mano (la flechita) o, con «Colapsar vacías», las que no tienen nada (se abren solas).
  const colapso = useColapso('crm.board.collapsed.produccion', vacias);
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
        if (colapso.cerrada(c.value, lista.length)) return (
          <div key={c.value} className={`col collapsed${slug ? ` etapa-col e-${slug}` : ''}`} onClick={() => colapso.alternar(c.value, lista.length)}
            title={`${c.label}: ${lista.length}. Clic para mostrar.`} role="button" aria-label={`Mostrar la columna ${c.label}`}>
            <Icon name="chevron" size={14} />
            <span className="n num">{lista.length}</span>
            <span className="vlabel">{c.label}</span>
          </div>
        );
        return (
          <div key={c.value} className="col">
            <div className={`col-head etapa-col${slug ? ` e-${slug}` : ''}`}>
              <div className="t">{slug ? <EtapaPedido value={c.value} label={c.label} /> : <span>{c.label}</span>}<span className="n">{lista.length}</span>
                <button className="col-fold" title="Achicar la columna" aria-label={`Achicar la columna ${c.label}`} onClick={() => colapso.alternar(c.value, lista.length)}><Icon name="chevron" size={14} /></button></div>
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
          <Vendedor p={p} />{p.entrega_prometida && `${p.owner_id || p.vendedor ? ' · ' : ''}Prometido ${dia(p.entrega_prometida.slice(0, 10))}`}
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
          <div className="prod-hijo-t" title={a.nombre}>{a.nombre}<AvisoLogo estado={a.logo} /></div>
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
