import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../lib';
import { EstadoClickup } from '../components';
import { useFloating } from '../Select';
import { SelectorFecha, isoDia } from '../Fecha';

// Filtros por columna de Producción (pedido de Rodrigo del 12/11/2026): cada columna de la lista tiene el suyo (el embudo
// del encabezado) y también se agregan desde «+ Filtro» (sirve en el tablero). Filtran PRODUCTOS: se ven solo los que
// cumplen, cada uno con su PDV; los PDV que se quedan sin productos no se ven. Se guardan en las vistas.

export type Rango = '' | 'vencidas' | 'hoy' | 'semana' | 'proximos' | 'con' | 'sin' | { desde?: string; hasta?: string };
export interface FiltrosCol {
  estado?: string[];
  cantidad?: { min?: number | null; max?: number | null };
  proveedor?: string[];   // id de la opción de ClickUp; '' = sin proveedor
  impresor?: string[];
  entrega_real?: Rango; ingreso_proveedor?: Rango; retiro_proveedor?: Rango; egreso_impresor?: Rango; retiro_impresor?: Rango;
}
export type ColFiltro = keyof FiltrosCol;
type ColFecha = 'entrega_real' | 'ingreso_proveedor' | 'retiro_proveedor' | 'egreso_impresor' | 'retiro_impresor';
const FECHAS: ColFecha[] = ['entrega_real', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor'];
export const NOMBRE_COL: Record<ColFiltro, string> = {
  estado: 'Estado', cantidad: 'Cantidad', proveedor: 'Proveedor', impresor: 'Impresor', entrega_real: 'Entrega',
  ingreso_proveedor: 'Ingreso prov.', retiro_proveedor: 'Retiro prov.', egreso_impresor: 'Egreso imp.', retiro_impresor: 'Retiro imp.',
};
const COLUMNAS: ColFiltro[] = ['estado', 'cantidad', 'entrega_real', 'proveedor', 'impresor', 'ingreso_proveedor', 'retiro_proveedor', 'egreso_impresor', 'retiro_impresor'];

// Lo que necesita saber de un producto.
export interface ArticuloFiltrable {
  estado: string; cantidad: number | null; proveedor: string | null; impresor: string | null;
  entrega_real: string | null; ingreso_proveedor: string | null; retiro_proveedor: string | null; egreso_impresor: string | null; retiro_impresor: string | null;
}
export interface Ctx {
  estados: Array<{ status: string; color: string }>;
  opciones: { proveedor: Array<{ value: string; label: string }>; impresor: Array<{ value: string; label: string }> };
  // Para el proveedor o impresor elegidos: las opciones repetidas de ClickUp que son la misma empresa.
  mismaEmpresa: (campo: 'proveedor' | 'impresor', id: string) => string[];
  cuenta: (col: ColFiltro, valor: string) => number;
}

export const activo = (f: FiltrosCol, c: ColFiltro) => {
  const x = f[c];
  if (Array.isArray(x)) return x.length > 0;
  if (c === 'cantidad') { const r = x as FiltrosCol['cantidad']; return r?.min != null || r?.max != null; }
  return !!x && (typeof x === 'string' || !!(x as { desde?: string }).desde || !!(x as { hasta?: string }).hasta);
};
export const hayFiltros = (f: FiltrosCol) => COLUMNAS.some((c) => activo(f, c));
// Para comparar vistas: sin lo vacío.
export const limpiar = (f: FiltrosCol): FiltrosCol => Object.fromEntries(COLUMNAS.filter((c) => activo(f, c)).map((c) => [c, f[c]])) as FiltrosCol;

function enRango(fecha: string | null, r: Rango, hoy: string) {
  if (!r) return true;
  if (r === 'sin') return !fecha;
  if (r === 'con') return !!fecha;
  if (!fecha) return false;
  if (r === 'vencidas') return fecha < hoy;
  if (r === 'hoy') return fecha === hoy;
  const d = new Date(`${hoy}T12:00:00`);
  if (r === 'proximos') { const h = new Date(d); h.setDate(h.getDate() + 7); return fecha >= hoy && fecha <= isoDia(h); }
  if (r === 'semana') {
    const lunes = new Date(d); lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const domingo = new Date(lunes); domingo.setDate(lunes.getDate() + 6);
    return fecha >= isoDia(lunes) && fecha <= isoDia(domingo);
  }
  return (!r.desde || fecha >= r.desde) && (!r.hasta || fecha <= r.hasta);
}

export function cumple(a: ArticuloFiltrable, f: FiltrosCol, ctx: Pick<Ctx, 'mismaEmpresa'>, hoy = isoDia(new Date())) {
  if (f.estado?.length && !f.estado.includes(a.estado)) return false;
  const c = f.cantidad;
  if (c?.min != null && (a.cantidad ?? 0) < c.min) return false;
  if (c?.max != null && (a.cantidad ?? 0) > c.max) return false;
  for (const campo of ['proveedor', 'impresor'] as const) {
    const sel = f[campo];
    if (!sel?.length) continue;
    const ok = sel.some((id) => (id === '' ? !a[campo] : !!a[campo] && ctx.mismaEmpresa(campo, id).includes(a[campo]!)));
    if (!ok) return false;
  }
  for (const k of FECHAS) if (f[k] && !enRango(a[k], f[k]!, hoy)) return false;
  return true;
}

// Cómo se lee un filtro en su chip.
const RANGOS: Array<[Exclude<Rango, object>, string]> = [['vencidas', 'Ya pasó'], ['hoy', 'Hoy'], ['semana', 'Esta semana'], ['proximos', 'Próximos 7 días'], ['con', 'Con fecha'], ['sin', 'Sin fecha']];
const ddmm = (s?: string) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '');
export function resumen(f: FiltrosCol, c: ColFiltro, ctx: Ctx) {
  const x = f[c];
  if (c === 'estado') return (x as string[]).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
  if (c === 'proveedor' || c === 'impresor') return (x as string[]).map((id) => (id === '' ? `Sin ${c}` : ctx.opciones[c].find((o) => o.value === id)?.label ?? id)).join(', ');
  if (c === 'cantidad') { const r = x as NonNullable<FiltrosCol['cantidad']>; return r.min != null && r.max != null ? `${r.min} a ${r.max}` : r.min != null ? `${r.min} o más` : `hasta ${r.max}`; }
  if (typeof x === 'string') return RANGOS.find(([k]) => k === x)?.[1] ?? x;
  const r = x as { desde?: string; hasta?: string };
  return r.desde && r.hasta ? `${ddmm(r.desde)} al ${ddmm(r.hasta)}` : r.desde ? `desde ${ddmm(r.desde)}` : `hasta ${ddmm(r.hasta)}`;
}

// ---------- Los controles de cada columna ----------

function Lista({ opciones, sel, onChange, buscar, cuenta, render }: {
  opciones: Array<{ value: string; label: string }>; sel: string[]; onChange: (v: string[]) => void; buscar?: boolean; cuenta: (v: string) => number;
  render?: (o: { value: string; label: string }) => ReactNode;
}) {
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const vis = opciones.filter((o) => !q || norm(o.label).includes(norm(q)));
  return (
    <div className="fcol-lista">
      {buscar && <input className="input sm" autoFocus placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="fcol-ops">
        {vis.map((o) => {
          const n = cuenta(o.value);
          return (
            <label key={o.value} className={`opt small${n ? '' : ' cero'}`}>
              <input type="checkbox" checked={sel.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...sel, o.value] : sel.filter((x) => x !== o.value))} />
              <span className="grow ellipsis">{render ? render(o) : o.label}</span><span className="fcol-n">{n}</span>
            </label>
          );
        })}
        {!vis.length && <div className="opt small muted">Nada coincide.</div>}
      </div>
    </div>
  );
}

function Control({ col, f, set, ctx }: { col: ColFiltro; f: FiltrosCol; set: (x: FiltrosCol[ColFiltro] | undefined) => void; ctx: Ctx }) {
  if (col === 'estado') {
    return <Lista opciones={ctx.estados.map((e) => ({ value: e.status, label: e.status }))} sel={f.estado ?? []} onChange={set} cuenta={(v) => ctx.cuenta('estado', v)}
      render={(o) => <EstadoClickup estado={o.value} color={ctx.estados.find((e) => e.status === o.value)?.color} />} />;
  }
  if (col === 'proveedor' || col === 'impresor') {
    return <Lista buscar opciones={[{ value: '', label: `Sin ${col}` }, ...ctx.opciones[col]]} sel={f[col] ?? []} onChange={set} cuenta={(v) => ctx.cuenta(col, v)} />;
  }
  if (col === 'cantidad') {
    const r = f.cantidad ?? {};
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    return (
      <div className="row" style={{ gap: 8 }}>
        <label className="field small" style={{ flex: 1 }}>Desde<input className="input sm" type="number" min={0} autoFocus value={r.min ?? ''} onChange={(e) => set({ ...r, min: num(e.target.value) })} /></label>
        <label className="field small" style={{ flex: 1 }}>Hasta<input className="input sm" type="number" min={0} value={r.max ?? ''} onChange={(e) => set({ ...r, max: num(e.target.value) })} /></label>
      </div>
    );
  }
  const r = f[col as ColFecha] ?? '';
  const rango = typeof r === 'object' ? r : null;
  return (
    <div className="fcol-ops">
      {RANGOS.map(([k, l]) => (
        <label key={k} className="opt small"><input type="radio" name={`r-${col}`} checked={r === k} onChange={() => set(k)} /><span className="grow">{l}</span>
          <span className="fcol-n">{ctx.cuenta(col, k)}</span></label>
      ))}
      <label className="opt small"><input type="radio" name={`r-${col}`} checked={!!rango} onChange={() => set({ desde: isoDia(new Date()) })} /><span className="grow">Entre fechas</span></label>
      {rango && (
        <div className="row fcol-entre">
          <SelectorFecha valor={rango.desde ?? null} onElegir={(d) => set({ ...rango, desde: d || undefined })} label="Desde" className="fecha-btn">{rango.desde ? ddmm(rango.desde) : 'Desde'}</SelectorFecha>
          <span className="muted small">al</span>
          <SelectorFecha valor={rango.hasta ?? null} onElegir={(d) => set({ ...rango, hasta: d || undefined })} label="Hasta" className="fecha-btn">{rango.hasta ? ddmm(rango.hasta) : 'Hasta'}</SelectorFecha>
        </div>
      )}
    </div>
  );
}

// Un popover flotante con el filtro de una columna, anclado a lo que lo abrió (el embudo, el chip o «+ Filtro»).
function Pop({ ancla, col, f, onChange, ctx, onClose }: { ancla: React.RefObject<HTMLElement | null>; col: ColFiltro; f: FiltrosCol; onChange: (f: FiltrosCol) => void; ctx: Ctx; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const { style } = useFloating(ancla, pop, true, onClose, 460);
  useEffect(() => {
    // Fuera del filtro (y del calendario que abre adentro), se cierra.
    const fuera = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!pop.current?.contains(t) && !ancla.current?.contains(t) && !t.closest('.cal-pop')) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.cal-pop')) { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', fuera); window.removeEventListener('keydown', esc, true); };
  }, [ancla, onClose]);
  const set = (x: FiltrosCol[ColFiltro] | undefined) => onChange({ ...f, [col]: x });
  return createPortal(
    <div ref={pop} className="popover fcol-pop" role="dialog" aria-label={`Filtrar por ${NOMBRE_COL[col]}`} style={{ ...style, minWidth: 260 }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="fcol-head"><b>{NOMBRE_COL[col]}</b><span className="grow" />
        {activo(f, col) && <button type="button" className="btn ghost sm" onClick={() => set(undefined)}>Quitar filtro</button>}</div>
      <Control col={col} f={f} set={set} ctx={ctx} />
    </div>,
    document.body,
  );
}

// El embudo del encabezado de una columna (en color si está filtrando).
export function FiltroEncabezado({ col, f, onChange, ctx }: { col: ColFiltro; f: FiltrosCol; onChange: (f: FiltrosCol) => void; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const on = activo(f, col);
  return (
    <>
      <button ref={btn} type="button" className={`fcol-btn${on ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}
        aria-label={`Filtrar por ${NOMBRE_COL[col]}${on ? `: ${resumen(f, col, ctx)}` : ''}`} title={on ? `Filtrando: ${resumen(f, col, ctx)}` : `Filtrar por ${NOMBRE_COL[col].toLowerCase()}`}>
        <Icon name="filter" size={12} />
      </button>
      {open && <Pop ancla={btn} col={col} f={f} onChange={onChange} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

// Los filtros activos como chips (un clic los edita, la ✕ los saca), «+ Filtro» para sumar uno y «Borrar filtros».
export function FiltrosActivos({ f, onChange, ctx, extra }: { f: FiltrosCol; onChange: (f: FiltrosCol) => void; ctx: Ctx; extra?: ReactNode }) {
  const [abierto, setAbierto] = useState<ColFiltro | null>(null);
  const [menu, setMenu] = useState(false);
  const anclas = useRef(new Map<string, HTMLElement | null>());
  const ancla = useMemo(() => ({ get current() { return abierto ? anclas.current.get(abierto) ?? anclas.current.get('+') ?? null : null; } }), [abierto]);
  const mas = useRef<HTMLButtonElement | null>(null);
  const menuPop = useRef<HTMLDivElement>(null);
  const { style } = useFloating(mas, menuPop, menu, () => setMenu(false), 360);
  useEffect(() => {
    if (!menu) return;
    const fuera = (e: MouseEvent) => { if (!menuPop.current?.contains(e.target as Node) && !mas.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [menu]);
  const activos = COLUMNAS.filter((c) => activo(f, c));
  return (
    <div className="fcol-chips" role="group" aria-label="Filtros por columna">
      {activos.map((c) => (
        <span key={c} className="chip on fcol-chip" ref={(el) => { anclas.current.set(c, el); }}>
          <button type="button" onClick={() => setAbierto(c)} title="Cambiar el filtro"><b>{NOMBRE_COL[c]}:</b> <span className="ellipsis">{resumen(f, c, ctx)}</span></button>
          <button type="button" onClick={() => onChange({ ...f, [c]: undefined })} aria-label={`Quitar el filtro de ${NOMBRE_COL[c]}`}><Icon name="x" size={12} /></button>
        </span>
      ))}
      <button ref={(el) => { mas.current = el; anclas.current.set('+', el); }} type="button" className="btn sm ghost" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
        <Icon name="filter" size={14} />+ Filtro
      </button>
      {activos.length > 0 && <button type="button" className="btn sm ghost" onClick={() => onChange({})}>Borrar filtros</button>}
      {extra}
      {menu && createPortal(
        <div ref={menuPop} className="popover" role="menu" style={{ ...style, minWidth: 200 }}>
          <div className="grp">Filtrar productos por</div>
          {COLUMNAS.map((c) => <div key={c} className="opt" role="menuitem" tabIndex={0} onClick={() => { setMenu(false); setAbierto(c); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { setMenu(false); setAbierto(c); } }}>{NOMBRE_COL[c]}{activo(f, c) && <span className="small muted" style={{ marginLeft: 'auto' }}>✓</span>}</div>)}
        </div>,
        document.body,
      )}
      {abierto && <Pop ancla={ancla} col={abierto} f={f} onChange={onChange} ctx={ctx} onClose={() => setAbierto(null)} />}
    </div>
  );
}
