import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, useDebounced, fmtDate, Icon, unidadesDe, userOf, Cargando, type Activity, type Meta } from '../lib';
import { ColumnWidths, UnidadBadge, useColumnResize, userOption } from '../components';
import { UnidadFilter } from './QuickFilters';
import { Select } from '../Select';
import { ElegirColumnas } from '../vistaControles';
import { ChipRelacion, ESTADOS, EquipoTarea, EstadoTarea, NuevaTarea, PRIORIDADES, TIPOS, TareaPanel, pasosDe } from '../TareaPanel';

// Tareas, como en ClickUp y Asana (pedido de Rodrigo del 18/11/2026): una lista por vencimiento (la de siempre) y un
// tablero que se agrupa por estado, vencimiento, prioridad o responsable, donde se arrastran las tarjetas. Cada tarea se
// abre en un panel con su equipo (responsable y colaboradores), con qué está relacionada, pasos y su conversación.
// «Mis tareas» son las que tengo de responsable y en las que colaboro.

const TABS: Array<[string, string]> = [['overdue', 'Vencidas'], ['today', 'Para hoy'], ['week', 'Esta semana'], ['upcoming', 'Próximas'], ['all', 'Todas abiertas'], ['done', 'Completadas']];
type Vista = 'lista' | 'tablero';
type Agrupar = 'estado' | 'vence' | 'prioridad' | 'responsable';
const AGRUPAR: Array<[Agrupar, string]> = [['estado', 'Estado'], ['vence', 'Vencimiento'], ['prioridad', 'Prioridad'], ['responsable', 'Responsable']];
const OBJETO: Array<[string, string]> = [['', 'Relacionadas con todo'], ['order', 'Con pedidos'], ['deal', 'Con negocios'], ['company', 'Con empresas'], ['contact', 'Con contactos'], ['none', 'Sin relacionar']];

const leer = <T extends string>(k: string, def: T, ok: readonly T[]): T => { try { const v = localStorage.getItem(k) as T; return ok.includes(v) ? v : def; } catch { return def; } };
const guardarLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignorar */ } };

// ---------- Columnas del tablero ----------

interface Columna { key: string; label: string; cls?: string; tareas: Activity[]; cambio?: (t: Activity) => Record<string, unknown> | null; nueva?: Partial<Activity> }

const DIA = 86_400_000;
function hoyInicio() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
// La misma hora de la tarea (o las 10) en el día `dias` desde hoy.
function enDia(t: Activity | null, dias: number) {
  const d = hoyInicio(); d.setDate(d.getDate() + dias);
  const h = t?.due_at ? new Date(t.due_at) : null;
  d.setHours(h ? h.getHours() : 10, h ? h.getMinutes() : 0, 0, 0);
  return d.toISOString();
}

function columnas(meta: Meta, tareas: Activity[], agrupar: Agrupar, ownerSel: string): Columna[] {
  if (agrupar === 'estado') {
    return ESTADOS.map((e) => ({ key: e.k, label: e.label, cls: e.cls, tareas: tareas.filter((t) => (t.status ?? 'NOT_STARTED') === e.k),
      cambio: (t) => (t.status === e.k ? null : { status: e.k }), nueva: e.k === 'COMPLETED' ? undefined : { status: e.k } }));
  }
  if (agrupar === 'prioridad') {
    return PRIORIDADES.map((p) => ({ key: p.k, label: p.label, cls: `prio-${p.k}`, tareas: tareas.filter((t) => (t.priority ?? 'none') === p.k),
      cambio: (t) => ((t.priority ?? 'none') === p.k ? null : { priority: p.k }), nueva: { priority: p.k } }));
  }
  if (agrupar === 'responsable') {
    const ids = [...new Set([...(ownerSel !== 'all' ? [Number(ownerSel)] : [meta.me.id]), ...tareas.map((t) => t.owner_id).filter((x): x is number => x != null)])];
    const cols: Columna[] = ids.map((id) => ({ key: String(id), label: userOf(meta, id)?.name ?? `Usuario ${id}`, tareas: tareas.filter((t) => t.owner_id === id),
      cambio: (t) => (t.owner_id === id ? null : { owner_id: id }), nueva: { owner_id: id } }));
    const sin = tareas.filter((t) => t.owner_id == null);
    if (sin.length) cols.push({ key: 'sin', label: 'Sin responsable', tareas: sin });
    return cols;
  }
  // Vencimiento: solo las abiertas; las hechas, al final.
  const ini = hoyInicio().getTime();
  const finSemana = (() => { const d = hoyInicio(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + 1); return d.getTime(); })();   // el lunes que viene
  const abiertas = tareas.filter((t) => t.status !== 'COMPLETED');
  const due = (t: Activity) => (t.due_at ? Date.parse(t.due_at) : Infinity);
  const cuantosHastaViernes = Math.max(2, (5 - new Date().getDay() + 7) % 7);
  return [
    { key: 'vencidas', label: 'Vencidas', cls: 'vencidas', tareas: abiertas.filter((t) => due(t) < ini) },
    { key: 'hoy', label: 'Hoy', tareas: abiertas.filter((t) => due(t) >= ini && due(t) < ini + DIA), cambio: (t) => ({ due_at: enDia(t, 0) }), nueva: { due_at: enDia(null, 0) } },
    { key: 'manana', label: 'Mañana', tareas: abiertas.filter((t) => due(t) >= ini + DIA && due(t) < ini + 2 * DIA), cambio: (t) => ({ due_at: enDia(t, 1) }), nueva: { due_at: enDia(null, 1) } },
    { key: 'semana', label: 'Esta semana', tareas: abiertas.filter((t) => due(t) >= ini + 2 * DIA && due(t) < finSemana), cambio: (t) => ({ due_at: enDia(t, cuantosHastaViernes) }), nueva: { due_at: enDia(null, cuantosHastaViernes) } },
    { key: 'despues', label: 'Más adelante', tareas: abiertas.filter((t) => due(t) >= Math.max(finSemana, ini + 2 * DIA)), cambio: (t) => ({ due_at: enDia(t, 7) }), nueva: { due_at: enDia(null, 7) } },
    { key: 'hechas', label: 'Hechas (14 días)', cls: 'hecha', tareas: tareas.filter((t) => t.status === 'COMPLETED'), cambio: (t) => (t.status === 'COMPLETED' ? null : { status: 'COMPLETED' }) },
  ];
}

// ---------- Tarjeta ----------

const TareaCard = memo(function TareaCard({ t, on, dragging, onOpen, onToggle, onDrag }: {
  t: Activity; on: boolean; dragging: boolean; onOpen: (id: number) => void; onToggle: (t: Activity) => void; onDrag: (id: number | null) => void;
}) {
  const hecha = t.status === 'COMPLETED';
  const vencida = !hecha && t.due_at && Date.parse(t.due_at) < Date.now();
  const pasos = pasosDe(t);
  const prio = PRIORIDADES.find((p) => p.k === t.priority && p.k !== 'none');
  return (
    <div className={`card tarea-card${hecha ? ' hecha' : ''}${on ? ' on' : ''}${dragging ? ' dragging' : ''}`} draggable onClick={() => onOpen(t.id)}
      onDragStart={(e) => { onDrag(t.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => onDrag(null)}>
      <div className="tarea-card-t">
        <button type="button" className={`check-round${hecha ? ' on' : ''}`} aria-label={hecha ? 'Reabrir' : 'Completar'} onClick={(e) => { e.stopPropagation(); onToggle(t); }}>{hecha && <Icon name="check" />}</button>
        <span className="t">{t.subject}</span>
      </div>
      {t.links.length > 0 && <div className="tarea-card-rels">{t.links.slice(0, 2).map((l) => <ChipRelacion key={l.id} l={l} />)}{t.links.length > 2 && <span className="muted small">+{t.links.length - 2}</span>}</div>}
      <div className="tarea-card-pie">
        {t.due_at && <span className={`tarea-vence${vencida ? ' overdue' : ''}`} title={`Vence ${fmtDate(t.due_at, true)}`}><Icon name="calendar" size={12} />{fmtDate(t.due_at)}</span>}
        {prio && <span className={`tag ${prio.cls}`}>{prio.label}</span>}
        {pasos.length > 0 && <span className="muted small tarea-cuenta" title="Pasos hechos"><Icon name="check" size={12} />{pasos.filter((p) => p.hecho).length}/{pasos.length}</span>}
        {!!t.comentarios && <span className={`tarea-cuenta${t.sin_leer ? ' sin-leer' : ' muted small'}`} title={t.sin_leer ? `${t.sin_leer} sin leer` : 'Comentarios'}><Icon name="chat" size={12} />{t.comentarios}</span>}
        <span className="grow" />
        <EquipoTarea owner={t.owner_id} colaboradores={t.colaboradores} />
      </div>
    </div>
  );
});

function AgregarEnColumna({ col, onCrear }: { col: Columna; onCrear: (subject: string, col: Columna) => Promise<void> }) {
  const [abierto, setAbierto] = useState(false);
  const [v, setV] = useState('');
  if (!col.nueva) return null;
  if (!abierto) return <button type="button" className="btn ghost sm tarea-agregar" onClick={() => setAbierto(true)}><Icon name="plus" size={13} />Agregar tarea</button>;
  return (
    <input className="input tarea-agregar-input" autoFocus placeholder="Título y Enter" value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (!v.trim()) setAbierto(false); }}
      onKeyDown={async (e) => {
        if (e.key === 'Escape') { setV(''); setAbierto(false); }
        if (e.key === 'Enter' && v.trim()) { await onCrear(v.trim(), col); setV(''); }
      }} />
  );
}

// ---------- Pantalla ----------

export default function Tasks() {
  const { meta } = useMeta();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const abierta = Number(params.get('tarea')) || null;
  const abrir = (id: number | null) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('tarea', String(id)); else n.delete('tarea'); return n; }, { replace: !id });
  const [vista, setVista] = useState<Vista>(() => leer('crm.tasks.vista', 'tablero', ['lista', 'tablero'] as const));
  const [agrupar, setAgrupar] = useState<Agrupar>(() => leer('crm.tasks.agrupar', 'estado', ['estado', 'vence', 'prioridad', 'responsable'] as const));
  // Las columnas que se sacaron de la tabla (pedido de Rodrigo del 20/11/2026: todas las tablas con «Columnas»).
  const [ocultas, setOcultas] = useState<string[]>(() => { try { return (localStorage.getItem('crm.tasks.ocultas') ?? '').split(',').filter(Boolean); } catch { return []; } });
  const [tab, setTab] = useState('today');
  const [owner, setOwner] = useState<string>(String(meta.me.id));
  const [objeto, setObjeto] = useState('');
  const [q, setQ] = useState('');
  const [unidades, setUnidades] = useState<string[]>([]);
  const [nueva, setNueva] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem('crm.tasks.widths') ?? '{}'); } catch { return {}; } });
  const resize = useColumnResize(widths, (w) => { setWidths(w); guardarLocal('crm.tasks.widths', JSON.stringify(w)); });
  const dq = useDebounced(q, 300);
  const filtros = { owner, participa: owner !== 'all' ? 1 : undefined, objeto: objeto || undefined, q: dq || undefined, unidades: unidades.length ? unidades.join(',') : undefined };
  const list = useAsync(() => http<{ results: Activity[]; total: number }>('GET', `/tasks${qs(vista === 'tablero'
    ? { ...filtros, status: 'board', due: 'all', limit: 500 }
    : { ...filtros, status: tab === 'done' ? 'done' : 'open', due: tab === 'done' ? 'all' : tab, limit: 200 })}`), [vista, tab, owner, objeto, dq, unidades.join(',')]);
  // La lista que se ve (con los cambios del tablero aplicados enseguida, antes de que conteste el servidor).
  const [tareas, setTareas] = useState<Activity[]>([]);
  useEffect(() => { if (list.data) setTareas(list.data.results); }, [list.data]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const recarga = useRef(list.reload);
  recarga.current = list.reload;

  const cambiar = async (t: Activity, patch: Record<string, unknown>, aviso?: string) => {
    setTareas((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...patch } as Activity : x)));
    try { await http('PATCH', `/activities/${t.id}`, patch); if (aviso) toast(aviso); }
    catch (e) { toast((e as Error).message, true); recarga.current(); }
  };
  const toggle = (t: Activity) => cambiar(t, { status: t.status === 'COMPLETED' ? 'NOT_STARTED' : 'COMPLETED' }, t.status === 'COMPLETED' ? 'Tarea reabierta' : 'Tarea completada');
  const postpone = (t: Activity, days: number) => {
    const d = new Date(Math.max(Date.now(), Date.parse(t.due_at ?? '') || 0) + days * DIA);
    cambiar(t, { due_at: d.toISOString() }, `Pasada al ${fmtDate(d)}`);
  };
  const crearEn = async (subject: string, col: Columna) => {
    const manana = enDia(null, 1);
    const base = { type: 'task', subject, owner_id: owner !== 'all' ? Number(owner) : meta.me.id, due_at: manana, status: 'NOT_STARTED', priority: 'none', task_type: 'todo' };
    try { const t = await http<Activity>('POST', '/activities', { ...base, ...col.nueva }); setTareas((ts) => [...ts, { ...t, colaboradores: [], comentarios: 0, sin_leer: 0 }]); }
    catch (e) { toast((e as Error).message, true); }
  };
  const cols = useMemo(() => columnas(meta, tareas, agrupar, owner), [meta, tareas, agrupar, owner]);
  const soltar = (c: Columna) => ({
    onDragOver: (e: React.DragEvent) => { if (!c.cambio) return; e.preventDefault(); setOver(c.key); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.key ? null : o)); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setOver(null);
      const t = tareas.find((x) => x.id === dragId);
      setDragId(null);
      const patch = t && c.cambio?.(t);
      if (t && patch) cambiar(t, patch);
    },
  });
  const todasCols: Array<[string, string]> = [['tarea', 'Tarea'], ['asociada', 'Relacionada con'], ['vence', 'Vence'], ['estado', 'Estado'], ['prioridad', 'Prioridad'], ['equipo', 'Equipo'], ['unidad', 'Unidad']];
  const listCols = todasCols.filter(([k]) => !ocultas.includes(k));
  const ver = (k: string) => !ocultas.includes(k);
  const total = list.data?.total;
  return (
    <div className={`content${vista === 'lista' ? ' list-fixed' : ' tareas-tablero'}`}>
      <div className="page-head">
        <h1>Tareas {total != null && <span className="muted small num">{total.toLocaleString('es-AR')}</span>}</h1>
        <div className="seg" role="group" aria-label="Vista">
          <button type="button" className={vista === 'lista' ? 'on' : ''} aria-pressed={vista === 'lista'} onClick={() => { setVista('lista'); guardarLocal('crm.tasks.vista', 'lista'); }}><Icon name="table" size={14} />Tabla</button>
          <button type="button" className={vista === 'tablero' ? 'on' : ''} aria-pressed={vista === 'tablero'} onClick={() => { setVista('tablero'); guardarLocal('crm.tasks.vista', 'tablero'); }}><Icon name="board" size={14} />Tablero</button>
        </div>
        <button className="btn primary" onClick={() => setNueva(true)}><Icon name="plus" size={16} />Nueva tarea</button>
      </div>
      {vista === 'lista' && <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>}
      <div className="toolbar">
        <div className="search"><Icon name="search" /><input className="input" placeholder="Buscar en título o detalle…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" /></div>
        <UnidadFilter value={unidades} onChange={setUnidades} />
        <div className="bar-select">
          <Select className={`input${owner !== String(meta.me.id) ? ' on' : ''}`} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="De quién">
            <option value={String(meta.me.id)}>Mis tareas</option>
            <option value="all">Todo el equipo</option>
            {meta.users.filter((u) => u.active && !u.deleted_at && u.id !== meta.me.id).map((u) => <option key={u.id} value={u.id}>{userOption(u)}</option>)}
          </Select>
        </div>
        <div className="bar-select">
          <Select className={`input${objeto ? ' on' : ''}`} value={objeto} onChange={(e) => setObjeto(e.target.value)} aria-label="Relacionadas con">
            {OBJETO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </div>
      </div>
      {/* Los controles de vista, en su propia fila (como en el resto de los módulos). */}
      <div className="toolbar vista">
        {vista === 'tablero' && (
          <label className="row small tarea-agrupar">Agrupar por
            <Select className="input" value={agrupar} onChange={(e) => { setAgrupar(e.target.value as Agrupar); guardarLocal('crm.tasks.agrupar', e.target.value); }} aria-label="Agrupar por">
              {AGRUPAR.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </label>
        )}
        {vista === 'lista' && <ElegirColumnas columnas={todasCols} ocultas={ocultas} fijas={['tarea']} onChange={(x) => { setOcultas(x); guardarLocal('crm.tasks.ocultas', x.join(',')); }} />}
      </div>

      {vista === 'tablero' ? (
        <div className={`board tareas${list.loading && list.data ? ' cargando' : ''}`} aria-busy={list.loading}>
          {!list.data && !list.error && <Cargando />}
          {list.data && cols.map((c) => (
            <div key={c.key} className={`col tarea-col ${c.cls ?? ''}${over === c.key ? ' over' : ''}`} {...soltar(c)}>
              <div className="col-head"><div className="t">{agrupar === 'estado' && <i className={`estado-punto ${c.cls}`} />}<span className="ellipsis">{c.label}</span><span className="n num">{c.tareas.length}</span></div></div>
              <div className="col-body">
                <AgregarEnColumna col={c} onCrear={crearEn} />
                {c.tareas.map((t) => <TareaCard key={t.id} t={t} on={abierta === t.id} dragging={dragId === t.id} onOpen={abrir} onToggle={toggle} onDrag={setDragId} />)}
                {!c.tareas.length && <div className="muted small tarea-vacia">{c.cambio ? 'Arrastrá tareas acá' : 'Nada'}</div>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <ColumnWidths scope="grid-tasks" order={['__check', ...listCols.map(([k]) => k)]} widths={resize.widths} />
          <table className="grid grid-tasks">
            <thead><tr><th className="check nosort" />
              {listCols.map(([k, l]) => <th key={k} className="nosort">{l}{resize.handle(k)}</th>)}
              <th className="nosort" /></tr></thead>
            <tbody>
              {tareas.map((a) => {
                const overdue = a.status !== 'COMPLETED' && a.due_at && Date.parse(a.due_at) < Date.now();
                const prio = PRIORIDADES.find((p) => p.k === a.priority && p.k !== 'none');
                return (
                  <tr key={a.id} className={abierta === a.id ? 'sel' : ''}>
                    <td className="check"><button className={`check-round${a.status === 'COMPLETED' ? ' on' : ''}`} onClick={() => toggle(a)} aria-label="Completar">{a.status === 'COMPLETED' && <Icon name="check" />}</button></td>
                    <td style={{ maxWidth: resize.widths.tarea ? undefined : 420 }}>
                      <button className="btn ghost tarea-link" onClick={() => abrir(a.id)}>{a.subject}</button>
                      {!!a.comentarios && <span className={`tarea-cuenta${a.sin_leer ? ' sin-leer' : ' muted small'}`} title={a.sin_leer ? `${a.sin_leer} sin leer` : 'Comentarios'}><Icon name="chat" size={12} />{a.comentarios}</span>}
                      {a.body && <div className="small muted ellipsis" style={{ maxWidth: resize.widths.tarea ? '100%' : 400 }}>{a.body.split('\n')[0]}</div>}
                    </td>
                    {ver('asociada') && <td><span className="tarea-card-rels">{a.links.slice(0, 2).map((l) => <ChipRelacion key={l.id} l={l} />)}</span></td>}
                    {ver('vence') && <td className={overdue ? 'overdue' : ''}>{fmtDate(a.due_at, true)}<div className="small muted">{TIPOS[a.task_type ?? 'todo'] ?? a.task_type}</div></td>}
                    {ver('estado') && <td><EstadoTarea status={a.status} /></td>}
                    {ver('prioridad') && <td>{prio ? <span className={`tag ${prio.cls}`}>{prio.label}</span> : <span className="muted">—</span>}</td>}
                    {ver('equipo') && <td><EquipoTarea owner={a.owner_id} colaboradores={a.colaboradores} max={4} /></td>}
                    {ver('unidad') && <td><span className="unidades">{unidadesDe(meta, 'task', { owner_id: a.owner_id }).map((k) => <UnidadBadge key={k} k={k} compact />)}</span></td>}
                    <td>{a.status !== 'COMPLETED' && <span className="row"><button className="btn sm ghost" onClick={() => postpone(a, 1)}>+1 día</button><button className="btn sm ghost" onClick={() => postpone(a, 7)}>+1 semana</button></span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.data && !tareas.length && <div className="empty">{tab === 'overdue' ? 'No hay tareas vencidas.' : 'No hay tareas acá.'}</div>}
        </div>
      )}
      {abierta && <TareaPanel id={abierta} onClose={() => abrir(null)} onChange={() => recarga.current()} />}
      {nueva && <NuevaTarea onClose={() => setNueva(false)} inicial={owner !== 'all' ? { owner_id: Number(owner) } : undefined}
        onCreated={(t) => { setNueva(false); list.reload(); abrir(t.id); }} />}
    </div>
  );
}

