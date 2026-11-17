import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { http, useMeta, useToast, Icon } from './lib';
import { Select, useFloating } from './Select';

// Vistas guardadas (tabla `views`, src/worker/api.ts): las pestañas de Contactos, Empresas, Negocios y Pedidos
// (pages/ObjectIndex.tsx) y las de Producción (pages/Produccion.tsx). Cada una guarda su configuración (filtros, modo…)
// y se comparte con nadie, con un equipo o con todos.
export interface VistaGuardada<C = unknown> { id: number; name: string; shared: number; team_id: number | null; user_id: number; config: C }

// Con quién se comparte una vista: solo yo, todos, o un equipo (Corporate, Formas Shop, NOESTRES).
export const shareBody = (v: string) => (v === 'all' ? { shared: true, team_id: null } : v === 'me' ? { shared: false, team_id: null } : { shared: false, team_id: Number(v) });
export const shareOf = (v: VistaGuardada) => (v.shared ? 'all' : v.team_id ? String(v.team_id) : 'me');
export function ShareSelect({ value, onChange, compacto }: { value: string; onChange: (v: string) => void; compacto?: boolean }) {
  const { meta } = useMeta();
  const opciones = <>
    <option value="me">{compacto ? 'La ve: solo yo' : 'Solo yo'}</option>
    <option value="all">{compacto ? 'La ve: todo el equipo' : 'Todo el equipo'}</option>
    {meta.teams.map((t) => <option key={t.id} value={t.id}>{compacto ? 'La ve: equipo ' : 'Equipo '}{t.name}</option>)}
  </>;
  if (compacto) return <Select className="input sm" style={{ width: 190 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Quién la ve">{opciones}</Select>;
  return (
    <label className="field">Quién la ve
      <Select className="input" value={value} onChange={(e) => onChange(e.target.value)}>{opciones}</Select>
    </label>
  );
}

// Menú de la vista abierta (como ⚙ «Ver configuración» de HubSpot): renombrar y compartir (en la barra de abajo), copiar el link,
// abrirla por defecto (la pasa primera) y borrarla. Cambiar o borrar una vista ajena solo puede un administrador.
export function ViewMenu({ type, view, onDeleted, onRenombrar, onMover, puedeIzq, puedeDer, primera, onPrimera }: {
  type: string; view: VistaGuardada; onDeleted: () => void; onRenombrar: () => void; onMover?: (d: -1 | 1) => void; puedeIzq?: boolean; puedeDer?: boolean;
  primera: boolean; onPrimera: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // El menú flota por encima de la fila de pestañas (si no, la fila lo recorta y parece que el botón no hace nada).
  const { style: popStyle } = useFloating(btn, pop, open, () => setOpen(false), 300);
  const mine = view.user_id === meta.me.id || meta.me.role === 'admin';
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="view-menu" ref={ref}>
      <button ref={btn} className={`view-menu-btn${open ? ' on' : ''}`} aria-label={`Opciones de la vista ${view.name}`} aria-haspopup="menu" aria-expanded={open}
        title="Opciones de la vista: renombrar, compartir, abrir por defecto, borrar" onClick={() => setOpen(!open)}><Icon name="down" size={14} /></button>
      {open && (
        <div ref={pop} className="popover" role="menu" style={{ ...popStyle, minWidth: 220, maxWidth: 320 }}>
          {mine && <div className="opt" onClick={() => { onRenombrar(); setOpen(false); }}>Renombrar o compartir…</div>}
          <div className="opt" onClick={() => { setOpen(false); (navigator.clipboard?.writeText(window.location.href) ?? Promise.reject()).then(() => toast('Link copiado'), () => toast('El navegador no dejó copiar: copiá el link de la barra de direcciones.', true)); }}>Copiar link</div>
          <div className="opt" title="Se abre la primera pestaña al entrar" onClick={() => { if (!primera) onPrimera(); setOpen(false); }}>{primera ? '✓ Se abre por defecto' : 'Abrir por defecto (pasarla primera)'}</div>
          {onMover && puedeIzq && <div className="opt" onClick={() => { onMover(-1); setOpen(false); }}>Mover a la izquierda</div>}
          {onMover && puedeDer && <div className="opt" onClick={() => { onMover(1); setOpen(false); }}>Mover a la derecha</div>}
          {mine && <div className="opt danger-text" onClick={async () => {
            setOpen(false);
            if (!confirm(`¿Borrar la vista «${view.name}»? A quienes la ven compartida también les desaparece.`)) return;
            try { await http('DELETE', `/views/${type}/${view.id}`); toast('Vista borrada'); onDeleted(); } catch (e) { toast((e as Error).message, true); }
          }}>Borrar vista</div>}
        </div>
      )}
    </div>
  );
}

// ---------- La barra de abajo de las vistas (como la de HubSpot) ----------
// Siempre a la vista al pie de la pantalla, sin ventanas que se abran: cuántos hay, el paginado de la tabla, actualizar,
// exportar (a quien puede), descartar los cambios, duplicar la vista con otro nombre y guardar (pedido de Rodrigo del
// 17/11/2026). Duplicar, guardar una vista nueva y renombrar o compartir (desde el menú de la pestaña) piden el nombre
// ahí mismo, en la barra. Se dibuja en el hueco que
// App deja al pie (#barra-vista), así queda abajo de todo y el resto de la página ocupa lo que sobra.
export type CrearVista = '' | 'nueva' | 'duplicar' | 'renombrar';
export function BarraVista<C>({ tipo, total, centro, abierta, cambiada, filtrosCambiados, puedeGuardar, onDescartar, onGuardar, actual, onCreada,
  crear, setCrear, onRecargar, onExportar, ayudaGuardar, onRenombrada }: {
  tipo: string; total?: ReactNode; centro?: ReactNode; abierta?: VistaGuardada; cambiada: boolean; filtrosCambiados: boolean; puedeGuardar: boolean;
  onDescartar: () => void; onGuardar: () => void; actual: C; onCreada: (id: number) => void;
  crear: CrearVista; setCrear: (c: CrearVista) => void; onRecargar?: () => void; onExportar?: () => void; ayudaGuardar?: string;
  onRenombrada: () => void;
}) {
  const toast = useToast();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('barra-vista')); }, []);
  const [nombre, setNombre] = useState('');
  const [share, setShare] = useState('me');
  const [yendo, setYendo] = useState(false);
  // Al abrir el nombre: vacío para una vista nueva; para duplicar, el de la vista con «(copia)» y compartida igual; para
  // renombrar, el que tiene.
  useEffect(() => {
    if (!crear) return;
    setNombre(!abierta || crear === 'nueva' ? '' : crear === 'duplicar' ? `${abierta.name} (copia)` : abierta.name);
    setShare(abierta && crear !== 'nueva' ? shareOf(abierta) : 'me');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crear]);
  // Al pasar a otra pestaña se cierra lo que se estaba nombrando de la anterior (renombrar o duplicar).
  useEffect(() => { if (crear === 'renombrar' || crear === 'duplicar') setCrear(''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [abierta?.id]);
  const hayCambios = cambiada || filtrosCambiados;
  const crearla = async () => {
    if (!nombre.trim() || yendo) return;
    setYendo(true);
    try {
      if (crear === 'renombrar' && abierta) {
        await http('PATCH', `/views/${tipo}/${abierta.id}`, { name: nombre.trim(), ...shareBody(share) });
        toast('Vista actualizada');
        setCrear('');
        onRenombrada();
        return;
      }
      const v = await http<{ id: number }>('POST', `/views/${tipo}`, { name: nombre.trim(), ...shareBody(share), config: actual });
      toast(crear === 'duplicar' ? `Vista duplicada como «${nombre.trim()}»` : `Vista «${nombre.trim()}» guardada`);
      setCrear('');
      onCreada(v.id);
    } catch (e) { toast((e as Error).message, true); } finally { setYendo(false); }
  };
  const guardar = () => (cambiada ? onGuardar() : setCrear('nueva'));
  const barra = (
    <div className={`barra-vista${hayCambios ? ' con-cambios' : ''}`} role="region" aria-label="Vista: guardar, duplicar y exportar">
      {total != null && <span className="bv-total">{total}</span>}
      {crear ? (
        <form className="bv-crear" onSubmit={(e) => { e.preventDefault(); crearla(); }} onKeyDown={(e) => { if (e.key === 'Escape') setCrear(''); }}>
          <span className="bv-crear-t">{crear === 'duplicar' && abierta ? <>Duplicar <b>{abierta.name}</b> como</> : crear === 'renombrar' && abierta ? <>Renombrar o compartir <b>{abierta.name}</b></> : 'Nueva vista'}</span>
          <input className="input sm" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} aria-label="Nombre de la vista"
            placeholder="Nombre, ej.: Corporate sin actividad 30 días"
            title={ayudaGuardar ?? `Guarda filtros, propietario, columnas, orden, búsqueda y si se ve en tabla o tablero${tipo === 'deal' ? ', con el pipeline' : ''}.`} />
          <ShareSelect value={share} onChange={setShare} compacto />
          <button type="button" className="btn sm ghost" onClick={() => setCrear('')}>Cancelar</button>
          <button type="submit" className="btn sm primary" disabled={!nombre.trim() || yendo}>{crear === 'duplicar' ? 'Duplicar' : crear === 'renombrar' ? 'Guardar' : 'Crear vista'}</button>
        </form>
      ) : <>
        {centro && <div className="bv-centro">{centro}</div>}
        <span className="bv-estado" aria-live="polite">{cambiada && abierta ? <>Cambios sin guardar en <b>{abierta.name}</b></> : filtrosCambiados ? 'Filtros sin guardar' : ''}</span>
        <div className="bv-acciones">
          {onRecargar && <button type="button" className="btn sm icon" title="Actualizar" aria-label="Actualizar" onClick={onRecargar}><Icon name="refresh" size={15} /></button>}
          {onExportar && <button type="button" className="btn sm" onClick={onExportar} title="Descarga lo que ves (con estos filtros y columnas) en un CSV"><Icon name="download" size={15} />Exportar</button>}
          <div className="btn-group bv-grupo" role="group" aria-label="Guardar la vista">
            <button type="button" className="btn sm icon" disabled={!hayCambios} onClick={onDescartar}
              title={hayCambios ? 'Descartar los cambios (vuelve a como estaba guardada)' : 'No hay cambios para descartar'} aria-label="Descartar los cambios"><Icon name="undo" size={15} /></button>
            <button type="button" className="btn sm icon" onClick={() => setCrear(abierta ? 'duplicar' : 'nueva')}
              title={abierta ? `Duplicar «${abierta.name}» con otro nombre (con lo que ves ahora)` : 'Guardar lo que ves como una vista nueva'} aria-label="Duplicar la vista"><Icon name="copy" size={15} /></button>
            <button type="button" className={`btn sm${hayCambios ? ' primary' : ''}`} onClick={guardar}
              disabled={!hayCambios || (cambiada && !puedeGuardar)}
              title={!hayCambios ? 'No hay cambios para guardar' : cambiada && !puedeGuardar ? 'Solo quien creó la vista (o un administrador) la puede cambiar: duplicala para guardar tus cambios' : cambiada ? `Guardar los cambios en «${abierta?.name}»` : 'Guardar estos filtros como una vista nueva'}>
              Guardar</button>
          </div>
        </div>
      </>}
    </div>
  );
  return slot ? createPortal(barra, slot) : null;
}

// ---------- Pestañas de vistas (Producción; la lista de Pedidos y los demás objetos tienen las suyas en ObjectIndex) ----------

// Pestañas: «all» (Todos), «mine» (Míos) y el id de cada vista guardada, en el orden de cada uno (se arrastran; la
// primera es la que se abre al entrar). El orden recién cambiado vale hasta recargar la página (que lo trae en /meta).
const FIJAS = ['all', 'mine'];
export const esFija = (k: string) => FIJAS.includes(k);
const ordenNuevo = new Map<string, string[]>();
export function ordenDePestanas(guardado: string[] | null, vistas: VistaGuardada[] | undefined) {
  const existe = (k: string) => esFija(k) || !vistas || vistas.some((v) => String(v.id) === k);
  const o = (guardado ?? []).filter((k, i, a) => existe(k) && a.indexOf(k) === i);
  for (const k of FIJAS) if (!o.includes(k)) o.push(k);
  for (const v of vistas ?? []) if (!o.includes(String(v.id))) o.push(String(v.id));
  return o;
}
// El orden de las pestañas de un tipo, como lo dejó cada uno.
export function useOrdenPestanas(tipo: string, vistas: VistaGuardada[] | undefined) {
  const { meta } = useMeta();
  const toast = useToast();
  const [guardado, setGuardado] = useState<string[] | null>(() => ordenNuevo.get(tipo)
    ?? ((meta.orden_vistas as Record<string, Array<number | string>> | undefined)?.[tipo]?.map(String) ?? null));
  const pestanas = ordenDePestanas(guardado, vistas);
  const guardar = async (ids: string[]) => {
    const antes = guardado;
    setGuardado(ids);
    ordenNuevo.set(tipo, ids);
    try { await http('PUT', `/views/${tipo}/orden`, { ids: ids.map((k) => (esFija(k) ? k : Number(k))) }); }
    catch (e) { toast((e as Error).message, true); setGuardado(antes); if (antes) ordenNuevo.set(tipo, antes); else ordenNuevo.delete(tipo); }
  };
  return { pestanas, guardar };
}

const AYUDA_ORDEN = 'Arrastrala para cambiar el orden: la primera es la que se abre al entrar.';

// La fila de pestañas, «+ Agregar vista» y la barra de abajo (BarraVista), igual que en Pedidos. Quien la usa dice qué hay ahora (`actual`), cómo comparar dos configuraciones y si en
// «Todos» o «Míos» se cambiaron los filtros.
export function PestanasVistas<C>({ tipo, vistas, pestanas, guardarOrden, activa, onElegir, recargar, actual, igual, filtrosCambiados, ayudaGuardar, total, onActualizar }: {
  tipo: string; vistas: Array<VistaGuardada<C>> | undefined; pestanas: string[]; guardarOrden: (ids: string[]) => void;
  activa: string; onElegir: (key: string) => void; recargar: () => void;
  actual: C; igual: (a: C, b: C) => boolean; filtrosCambiados: boolean; ayudaGuardar?: string;
  total?: ReactNode; onActualizar?: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [crear, setCrear] = useState<CrearVista>('');
  const [recien, setRecien] = useState<Record<number, C>>({});
  const [arrastrando, setArrastrando] = useState<string | null>(null);
  const [marca, setMarca] = useState<{ k: string; lado: 'antes' | 'despues' } | null>(null);
  const vistaDe = (k: string) => vistas?.find((v) => String(v.id) === k);
  const visibles = pestanas.filter((k) => esFija(k) || vistaDe(k));
  const abierta = vistaDe(activa);
  const cambiada = !!abierta && !igual(actual, recien[abierta.id] ?? abierta.config);
  const puedeGuardar = !!abierta && (abierta.user_id === meta.me.id || meta.me.role === 'admin');
  const soltar = (k: string, destino: string, lado: 'antes' | 'despues') => {
    if (k === destino) return;
    const ids = pestanas.filter((x) => x !== k);
    ids.splice(ids.indexOf(destino) + (lado === 'despues' ? 1 : 0), 0, k);
    guardarOrden(ids);
  };
  const mover = (k: string, d: -1 | 1) => { const i = visibles.indexOf(k); const otra = visibles[i + d]; if (otra) soltar(k, otra, d < 0 ? 'antes' : 'despues'); };
  const arrastre = (k: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setArrastrando(k); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); },
    onDragEnd: () => { setArrastrando(null); setMarca(null); },
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (arrastrando == null || arrastrando === k) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const lado = e.clientX < r.left + r.width / 2 ? 'antes' : 'despues';
      if (marca?.k !== k || marca.lado !== lado) setMarca({ k, lado });
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMarca((m) => (m?.k === k ? null : m)); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (arrastrando != null && marca) soltar(arrastrando, k, marca.lado); setArrastrando(null); setMarca(null); },
  });
  const clase = (k: string) => `tab-wrap${activa === k ? ' on' : ''}${arrastrando === k ? ' arrastrando' : ''}${marca?.k === k ? ` marca-${marca.lado}` : ''}`;
  const guardar = async () => {
    if (!abierta) return;
    try {
      await http('PATCH', `/views/${tipo}/${abierta.id}`, { config: actual });
      setRecien((m) => ({ ...m, [abierta.id]: actual }));
      toast(`Vista «${abierta.name}» guardada`);
      recargar();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="tabs">
        {visibles.map((k, i) => {
          const v = vistaDe(k);
          return (
            <div key={k} className={clase(k)} {...arrastre(k)}>
              <button className={`tab ${activa === k ? 'on' : ''}`} onClick={() => onElegir(k)}
                title={v ? `${v.shared ? 'Compartida con todos' : v.team_id ? `Compartida con ${meta.teams.find((t) => t.id === v.team_id)?.name ?? 'un equipo'}` : 'Solo vos'}. ${AYUDA_ORDEN}` : AYUDA_ORDEN}>
                {v ? v.name : k === 'all' ? 'Todos' : 'Míos'}
              </button>
              {v && activa === k && <ViewMenu type={tipo} view={v} onRenombrar={() => setCrear('renombrar')}
                onDeleted={() => { recargar(); onElegir(visibles.find((x) => x !== k) ?? 'all'); }}
                onMover={(d) => mover(k, d)} puedeIzq={i > 0} puedeDer={i < visibles.length - 1}
                primera={i === 0} onPrimera={() => { guardarOrden([k, ...pestanas.filter((x) => x !== k)]); toast(`«${v.name}» quedó primera: se abre al entrar`); }} />}
            </div>
          );
        })}
        <button className="tab add" onClick={() => setCrear('nueva')}>+ Agregar vista</button>
      </div>
      <BarraVista tipo={tipo} total={total} abierta={abierta} cambiada={cambiada} filtrosCambiados={esFija(activa) && filtrosCambiados} puedeGuardar={puedeGuardar}
        onDescartar={() => onElegir(activa)} onGuardar={guardar} actual={actual} onCreada={(id) => { recargar(); onElegir(String(id)); }}
        crear={crear} setCrear={setCrear} onRecargar={onActualizar} ayudaGuardar={ayudaGuardar} onRenombrada={recargar} />
    </>
  );
}
