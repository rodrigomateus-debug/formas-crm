import { useEffect, useRef, useState } from 'react';
import { http, useMeta, useToast, Icon } from './lib';
import { Modal } from './components';
import { Select, useFloating } from './Select';

// Vistas guardadas (tabla `views`, src/worker/api.ts): las pestañas de Contactos, Empresas, Negocios y Pedidos
// (pages/ObjectIndex.tsx) y las de Producción (pages/Produccion.tsx). Cada una guarda su configuración (filtros, modo…)
// y se comparte con nadie, con un equipo o con todos.
export interface VistaGuardada<C = unknown> { id: number; name: string; shared: number; team_id: number | null; user_id: number; config: C }

// Con quién se comparte una vista: solo yo, todos, o un equipo (Corporate, Formas Shop, NOESTRES).
export const shareBody = (v: string) => (v === 'all' ? { shared: true, team_id: null } : v === 'me' ? { shared: false, team_id: null } : { shared: false, team_id: Number(v) });
export const shareOf = (v: VistaGuardada) => (v.shared ? 'all' : v.team_id ? String(v.team_id) : 'me');
export function ShareSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { meta } = useMeta();
  return (
    <label className="field">Quién la ve
      <Select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="me">Solo yo</option>
        <option value="all">Todo el equipo</option>
        {meta.teams.map((t) => <option key={t.id} value={t.id}>Equipo {t.name}</option>)}
      </Select>
    </label>
  );
}

// Menú de la vista abierta (como ⚙ «Ver configuración» de HubSpot): renombrar, compartir, copiar el link,
// abrirla por defecto (la pasa primera) y borrarla. Cambiar o borrar una vista ajena solo puede un administrador.
export function ViewMenu({ type, view, onChanged, onDeleted, onMover, puedeIzq, puedeDer, primera, onPrimera }: {
  type: string; view: VistaGuardada; onChanged: () => void; onDeleted: () => void; onMover?: (d: -1 | 1) => void; puedeIzq?: boolean; puedeDer?: boolean;
  primera: boolean; onPrimera: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(view.name);
  const [share, setShare] = useState(shareOf(view));
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
          {mine && <div className="opt" onClick={() => { setEdit(true); setOpen(false); }}>Renombrar o compartir…</div>}
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
      {edit && (
        <Modal title="Vista" onClose={() => setEdit(false)} footer={<>
          <button className="btn" onClick={() => setEdit(false)}>Cancelar</button>
          <button className="btn primary" disabled={!name.trim()} onClick={async () => {
            try { await http('PATCH', `/views/${type}/${view.id}`, { name, ...shareBody(share) }); toast('Vista actualizada'); setEdit(false); onChanged(); }
            catch (e) { toast((e as Error).message, true); }
          }}>Guardar</button>
        </>}>
          <label className="field">Nombre<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <ShareSelect value={share} onChange={setShare} />
        </Modal>
      )}
    </div>
  );
}

export function SaveView({ type, config, onClose, onSaved, ayuda }: { type: string; config: unknown; onClose: () => void; onSaved: (id: number) => void; ayuda?: string }) {
  const [name, setName] = useState('');
  const [share, setShare] = useState('me');
  const toast = useToast();
  return (
    <Modal title="Guardar vista" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!name.trim()} onClick={async () => {
        try { const v = await http<{ id: number }>('POST', `/views/${type}`, { name, ...shareBody(share), config }); toast('Vista guardada'); onSaved(v.id); }
        catch (e) { toast((e as Error).message, true); }
      }}>Guardar</button>
    </>}>
      <label className="field">Nombre<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Corporate sin actividad 30 días" /></label>
      <ShareSelect value={share} onChange={setShare} />
      <p className="muted small" style={{ margin: 0 }}>{ayuda ?? `Guarda filtros, propietario, columnas, orden, búsqueda y si se ve en tabla o tablero${type === 'deal' ? ', con el pipeline' : ''}.`}</p>
    </Modal>
  );
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

// La fila de pestañas, «+ Agregar vista» y, con cambios sin guardar, la barra de abajo (Descartar, Guardar, Guardar como
// nueva), igual que en Pedidos. Quien la usa dice qué hay ahora (`actual`), cómo comparar dos configuraciones y si en
// «Todos» o «Míos» se cambiaron los filtros.
export function PestanasVistas<C>({ tipo, vistas, pestanas, guardarOrden, activa, onElegir, recargar, actual, igual, filtrosCambiados, ayudaGuardar }: {
  tipo: string; vistas: Array<VistaGuardada<C>> | undefined; pestanas: string[]; guardarOrden: (ids: string[]) => void;
  activa: string; onElegir: (key: string) => void; recargar: () => void;
  actual: C; igual: (a: C, b: C) => boolean; filtrosCambiados: boolean; ayudaGuardar?: string;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [guardando, setGuardando] = useState(false);
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
              {v && activa === k && <ViewMenu type={tipo} view={v} onChanged={recargar}
                onDeleted={() => { recargar(); onElegir(visibles.find((x) => x !== k) ?? 'all'); }}
                onMover={(d) => mover(k, d)} puedeIzq={i > 0} puedeDer={i < visibles.length - 1}
                primera={i === 0} onPrimera={() => { guardarOrden([k, ...pestanas.filter((x) => x !== k)]); toast(`«${v.name}» quedó primera: se abre al entrar`); }} />}
            </div>
          );
        })}
        <button className="tab" onClick={() => setGuardando(true)}>+ Agregar vista</button>
      </div>
      {(cambiada || (esFija(activa) && filtrosCambiados)) && (
        <div className="save-bar" role="region" aria-label="Cambios sin guardar en la vista">
          <span className="grow">{cambiada ? <>Cambiaste la vista <b>{abierta!.name}</b></> : 'Cambiaste los filtros'}</span>
          <button className="btn sm ghost" onClick={() => onElegir(activa)}>Descartar</button>
          {cambiada ? <>
            <button className="btn sm" onClick={() => setGuardando(true)}>Guardar como nueva</button>
            {puedeGuardar
              ? <button className="btn sm primary" onClick={guardar}>Guardar</button>
              : <button className="btn sm primary" disabled title="Solo quien creó la vista (o un administrador) la puede cambiar">Guardar</button>}
          </> : <button className="btn sm primary" onClick={() => setGuardando(true)}>Guardar como vista nueva</button>}
        </div>
      )}
      {guardando && <SaveView type={tipo} config={actual} ayuda={ayudaGuardar}
        onClose={() => setGuardando(false)} onSaved={(id) => { setGuardando(false); recargar(); onElegir(String(id)); }} />}
    </>
  );
}
