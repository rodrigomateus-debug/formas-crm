import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useAsync, precargar, useDebounced, typeFromPath, OBJECTS, propsOf, propOf, formatValue, fmtMoneyExact, recordUrl, Icon, defaultPipeline, TagChips,
  type Activity, type CrmRecord, type Filter, type ObjectType, unidadesDe, unidadDeEquipo, type UnidadKey,
} from '../lib';
import { Avatar, CreateRecord, Drawer, FilterRow, Modal, PropertyInput, StageSelect, describeFilter, filterableProps, opsFor } from '../components';
import Board from './Board';
import PropBoard, { urlTableroProp } from './PropBoard';
import ImportModal from './Import';
import { RecordPreview } from './RecordPage';
import { ColumnWidths, EstadoCliente, EtapaPedido, UnidadBadge, useColumnResize } from '../components';
import { BulkBar } from './Bulk';
import { QuickFilterBar, quickFilters } from './QuickFilters';
import { Select, useFloating } from '../Select';

const PIPE_KEY = 'crm.deals.pipeline';

const DEFAULT_COLUMNS: Record<ObjectType, string[]> = {
  contact: ['email', 'phone', '__company', 'owner_id', '__unidad', 'lifecyclestage', 'notes_last_updated', 'createdate'],
  company: ['domain', 'owner_id', '__unidad', 'estado_cliente', 'fecha_ultima_compra', 'compra_12m_usd', 'saldo_vencido', 'notes_last_updated'],
  deal: ['dealstage', 'amount', '__company', 'closedate', 'owner_id', '__unidad', 'notes_last_updated', 'createdate'],
  order: ['pdv_finnegans', 'hs_pipeline_stage', 'unidad_de_negocio', 'hs_total_price', 'owner_id', 'createdate'],
};

// `owner` es de las vistas viejas (un solo propietario); ahora van `owners` (varios) y `dates` (filtros rápidos de fecha).
interface ViewConfig {
  q?: string; groups: Filter[][]; columns: string[]; sort: string; dir: 'asc' | 'desc'; owner?: string; owners?: string[]; dates?: Record<string, string>; tags?: string[]; unidades?: string[];
  pipeline?: string; mode?: 'table' | 'board'; boardProp?: string; cardProps?: string[];
  widths?: Record<string, number>;   // ancho de cada columna (se arrastra el borde del encabezado)
}
const withOwners = (v: ViewConfig): ViewConfig => (v.owner && !v.owners ? { ...v, owners: [v.owner], owner: undefined } : v);
interface SavedView { id: number; name: string; shared: number; team_id: number | null; user_id: number; config: ViewConfig }
// Vista que se abre al entrar a cada lista (elegida por cada uno, en este navegador).
const defaultViewKey = (t: ObjectType) => `crm.view.default.${t}`;
const readDefault = (t: ObjectType) => { try { return localStorage.getItem(defaultViewKey(t)); } catch { return null; } };

const storeKey = (t: ObjectType) => `crm.view.${t}`;
// Filtros de una vista: los avanzados (grupos O) más los rápidos (propietarios, fechas, etiquetas, unidades) en cada grupo.
function gruposDeVista(c: ViewConfig) {
  const quick = quickFilters(c.owners, c.dates, c.tags, c.unidades);
  return (c.groups?.length ? c.groups : [[]]).map((g) => [...g, ...quick]).filter((g) => g.length);
}
const urlLista = (type: ObjectType, q: string, groups: Filter[][], c: ViewConfig, limit: number, offset: number) => `/records/${type}${qs({
  q, groups: groups.length ? groups : undefined, sort: c.sort, dir: c.dir, limit, offset, with: c.columns.includes('__company') ? 'company' : undefined,
})}`;
function loadLocal(t: ObjectType): ViewConfig {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(t)) ?? '');
    if (v && Array.isArray(v.columns)) return withOwners(v);
  } catch { /* sin vista guardada */ }
  return { groups: [], columns: DEFAULT_COLUMNS[t], sort: 'hs_lastmodifieddate', dir: 'desc' };
}

export default function ObjectIndex() {
  const { objectPath = 'contacts' } = useParams();
  const type = typeFromPath(objectPath);
  return <IndexFor key={type} type={type} />;
}

function IndexFor({ type }: { type: ObjectType }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  // Tablero: negocios por etapa del pipeline; empresas y contactos por etapa del ciclo de vida (u otra propiedad).
  // Tabla o tablero: lo que diga el link (o la vista guardada); si no dice nada, lo último que eligió cada uno.
  const [modePref, setModePref] = useState<'table' | 'board'>(() => {
    try { return localStorage.getItem(`crm.mode.${type}`) === 'board' ? 'board' : 'table'; } catch { return 'table'; }
  });
  const viewParam = params.get('view');
  const mode = viewParam === 'board' || viewParam === 'table' ? viewParam : modePref;
  const setMode = (m: 'table' | 'board') => {
    setModePref(m);
    try { localStorage.setItem(`crm.mode.${type}`, m); } catch { /* ignorar */ }
    setParams((p) => { p.set('view', m); return p; });
  };
  // Negocios: en qué pipeline estás. Sale del link (?pipeline=), si no de la última elección, si no del equipo.
  const [pipelineSel, setPipelineSelRaw] = useState<string>(() => {
    const valid = (v: string | null) => !!v && (v === 'all' || meta.pipelines.some((p) => p.id === v));
    let saved: string | null = null;
    try { saved = localStorage.getItem(PIPE_KEY); } catch { /* sin preferencia guardada */ }
    const fromUrl = params.get('pipeline');
    return valid(fromUrl) ? fromUrl! : valid(saved) ? saved! : defaultPipeline(meta).id;
  });
  const boardPipeline = pipelineSel === 'all' ? defaultPipeline(meta).id : pipelineSel;
  const setPipelineSel = (v: string) => {
    setPipelineSelRaw(v);
    try { localStorage.setItem(PIPE_KEY, v); } catch { /* ignorar */ }
    setParams((p) => { p.set('pipeline', v); return p; }, { replace: true });
  };
  useEffect(() => {
    if (type === 'deal' && params.get('pipeline') !== pipelineSel) setParams((p) => { p.set('pipeline', pipelineSel); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [cfg, setCfg] = useState<ViewConfig>(() => loadLocal(type));
  const [activeView, setActiveView] = useState<string>(params.get('v') ?? readDefault(type) ?? 'all');
  const [q, setQ] = useState(cfg.q ?? '');
  const dq = useDebounced(q, 300);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelectedRaw] = useState<Set<number>>(new Set());
  // «Seleccionar los N»: la acción masiva va sobre todo lo filtrado, no solo lo que se ve.
  const [selAll, setSelAll] = useState(false);
  const setSelected = (s: Set<number>) => { setSelectedRaw(s); if (!s.size) setSelAll(false); };
  const toggleSel = (id: number) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); setSelAll(false); };
  const [boardTotal, setBoardTotal] = useState<number>();
  const [createDefaults, setCreateDefaults] = useState<Record<string, unknown> | undefined>();
  const [filterProp, setFilterProp] = useState<string>();
  const createIn = (d: Record<string, unknown>) => { setCreateDefaults(d); setShow('create'); };
  // Vista previa al costado (clic en una tarjeta del tablero o «Vista previa» en la tabla), como en HubSpot.
  const [preview, setPreviewState] = useState<{ id: number; compose?: Activity['type'] } | null>(null);
  const setPreview = (id: number | null, compose?: Activity['type']) => setPreviewState(id ? { id, compose } : null);
  const [boardKey, setBoardKey] = useState(0);
  const [show, setShow] = useState<'' | 'filters' | 'columns' | 'create' | 'save' | 'import'>('');
  const views = useAsync(() => http<SavedView[]>('GET', `/views/${type}`), [type]);
  // Orden de las pestañas: el del servidor (el de cada usuario) o, recién arrastradas, el nuevo mientras se guarda.
  const [orden, setOrden] = useState<number[] | null>(null);
  useEffect(() => setOrden(null), [views.data]);
  const vistas = useMemo(() => {
    const l = views.data ?? [];
    if (!orden) return l;
    const pos = (id: number) => { const i = orden.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    return [...l].sort((a, b) => pos(a.id) - pos(b.id));
  }, [views.data, orden]);
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const [marca, setMarca] = useState<{ id: number; lado: 'antes' | 'despues' } | null>(null);
  const guardarOrden = async (ids: number[]) => {
    setOrden(ids);
    try { await http('PUT', `/views/${type}/orden`, { ids }); } catch (e) { toast((e as Error).message, true); setOrden(null); }
  };
  const soltarVista = (id: number, destino: number, lado: 'antes' | 'despues') => {
    if (id === destino) return;
    const ids = vistas.map((v) => v.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(destino) + (lado === 'despues' ? 1 : 0), 0, id);
    guardarOrden(ids);
  };
  const moverVista = (id: number, d: -1 | 1) => {
    const ids = vistas.map((v) => v.id);
    const i = ids.indexOf(id);
    if (i < 0 || i + d < 0 || i + d >= ids.length) return;
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    guardarOrden(ids);
  };

  useEffect(() => { try { localStorage.setItem(storeKey(type), JSON.stringify({ ...cfg, q })); } catch { /* ignorar */ } }, [cfg, q, type]);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [dq, cfg.groups, cfg.owners, cfg.dates, cfg.tags, cfg.unidades, cfg.sort, cfg.dir, pipelineSel, mode]);

  // Filtros de la vista para el tablero: los avanzados (grupos O) más los rápidos (propietarios y fechas) en cada grupo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewGroups = useMemo(() => gruposDeVista(cfg), [cfg.groups, cfg.owners, cfg.dates, cfg.tags, cfg.unidades]);
  // La tabla además filtra por el pipeline elegido.
  const groups = useMemo(() => {
    const pipe: Filter[] = type === 'deal' && pipelineSel !== 'all' ? [{ prop: 'pipeline', op: 'eq', value: pipelineSel }] : [];
    return (viewGroups.length ? viewGroups : [[]]).map((g) => [...g, ...pipe]).filter((g) => g.length);
  }, [viewGroups, pipelineSel, type]);
  // Con «Todos los pipelines» la tabla muestra de qué pipeline es cada negocio.
  const columns = type === 'deal' && pipelineSel === 'all' && !cfg.columns.includes('pipeline') ? ['pipeline', ...cfg.columns] : cfg.columns;

  type ListRes = { results: Array<CrmRecord & { company?: { id: number; name: string } | null }>; total: number };
  const listUrl = urlLista(type, dq, groups, cfg, pageSize, page * pageSize);
  const list = useAsync(() => (mode === 'board' ? Promise.resolve(undefined as unknown as ListRes) : http<ListRes>('GET', listUrl)),
    [type, dq, JSON.stringify(groups), cfg.sort, cfg.dir, page, pageSize, cfg.columns.includes('__company'), mode], mode === 'board' ? undefined : listUrl);

  const [, startTransition] = useTransition();
  // Al tocar una pestaña se marca enseguida; el resto (filtros, link, tablero o tabla) va después, sin trabar la pantalla.
  const applyView = (key: string) => {
    setActiveView(key);
    startTransition(() => applyViewConfig(key));
  };
  const applyViewConfig = (key: string) => {
    const v = views.data?.find((x) => String(x.id) === key);
    const pipe = type === 'deal' && v?.config.pipeline && (v.config.pipeline === 'all' || meta.pipelines.some((p) => p.id === v.config.pipeline)) ? v.config.pipeline : null;
    if (pipe) { setPipelineSelRaw(pipe); try { localStorage.setItem(PIPE_KEY, pipe); } catch { /* ignorar */ } }
    // Un solo cambio del link: la vista, su modo (tabla o tablero) y su pipeline.
    setParams((p) => {
      key === 'all' ? p.delete('v') : p.set('v', key);
      if (v?.config.mode) p.set('view', v.config.mode);
      if (pipe) p.set('pipeline', pipe);
      return p;
    }, { replace: true });
    if (key === 'all') setCfg((c) => ({ ...c, groups: [], owner: undefined, owners: [], dates: {}, tags: [], unidades: [] }));
    else if (key === 'mine') setCfg((c) => ({ ...c, groups: [], owner: undefined, owners: ['me'], dates: {}, tags: [], unidades: [] }));
    else if (v) { setCfg(withOwners({ ...loadLocal(type), owners: [], dates: {}, tags: [], unidades: [], ...v.config })); setQ(v.config.q ?? ''); }
  };
  // Lo que se ve ahora, para guardar en una vista y saber si la vista abierta tiene cambios sin guardar (como HubSpot).
  const current: ViewConfig = {
    q, groups: cfg.groups, columns: cfg.columns, sort: cfg.sort, dir: cfg.dir, owners: cfg.owners ?? [], dates: cfg.dates ?? {}, tags: cfg.tags ?? [], unidades: cfg.unidades ?? [], mode,
    ...(cfg.boardProp ? { boardProp: cfg.boardProp } : {}), ...(cfg.cardProps?.length ? { cardProps: cfg.cardProps } : {}), ...(type === 'deal' ? { pipeline: pipelineSel } : {}),
    ...(cfg.widths && Object.keys(cfg.widths).length ? { widths: cfg.widths } : {}),
  };
  const activeSaved = views.data?.find((v) => String(v.id) === activeView);
  // Lo recién guardado vale enseguida (la barra se va al guardar, sin esperar a que se recarguen las vistas).
  const [justSaved, setJustSaved] = useState<Record<string, ViewConfig>>({});
  const norm = (c: ViewConfig, base: ViewConfig) => JSON.stringify([
    c.q ?? '', c.groups ?? [], c.columns ?? base.columns, c.sort ?? base.sort, c.dir ?? base.dir, [...(c.owners ?? [])].sort(), c.dates ?? {}, [...(c.tags ?? [])].sort(), [...(c.unidades ?? [])].sort(), c.mode ?? base.mode,
    c.boardProp ?? base.boardProp ?? '', c.cardProps ?? [], type === 'deal' ? c.pipeline ?? base.pipeline : '', c.widths ?? {},
  ]);
  const dirty = !!activeSaved && norm(current, current) !== norm(withOwners(justSaved[activeSaved.id] ?? activeSaved.config), current);
  // En «Todos» y «Míos» no hay qué guardar salvo los filtros: si se cambiaron, se ofrece guardarlos como vista nueva.
  const filtersChanged = (activeView === 'all' || activeView === 'mine') && JSON.stringify([cfg.groups, [...(cfg.owners ?? [])].sort(), cfg.dates ?? {}, cfg.tags ?? [], cfg.unidades ?? []])
    !== JSON.stringify([[], activeView === 'mine' ? ['me'] : [], {}, [], []]);
  const canSaveView = !!activeSaved && (activeSaved.user_id === meta.me.id || meta.me.role === 'admin');
  const saveView = async () => {
    if (!activeSaved) return;
    try {
      await http('PATCH', `/views/${type}/${activeSaved.id}`, { config: current });
      setJustSaved((m) => ({ ...m, [activeSaved.id]: current }));
      toast(`Vista «${activeSaved.name}» guardada`);
      views.reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  useEffect(() => { if (views.data && activeView !== 'all' && activeView !== 'mine') applyView(activeView); /* eslint-disable-next-line */ }, [views.data]);

  // Las otras pestañas (Todos, Míos y las vistas guardadas) se traen en segundo plano, de a una, un rato después de abrir
  // la lista: al tocarlas aparecen al instante (y se actualizan atrás). Negocios no: su tablero depende del pipeline.
  useEffect(() => {
    if (!views.data || type === 'deal') return;
    let vivo = true;
    const t = window.setTimeout(async () => {
      const base: ViewConfig = { ...cfg, q: dq, groups: [], owners: [], dates: {}, tags: [], unidades: [] };
      const otras: Array<[string, ViewConfig, 'board' | 'table']> = [
        ['all', base, mode], ['mine', { ...base, owners: ['me'] }, mode],
        ...views.data!.map((v): [string, ViewConfig, 'board' | 'table'] => {
          const c = withOwners({ ...loadLocal(type), owners: [], dates: {}, tags: [], unidades: [], ...v.config });
          return [String(v.id), c, c.mode === 'board' || c.mode === 'table' ? c.mode : mode];
        }),
      ];
      for (const [key, c, m] of otras) {
        if (!vivo) return;
        if (key === activeView) continue;
        const g = gruposDeVista(c);
        await precargar(m === 'board' ? urlTableroProp(meta, type, c.boardProp, c.q ?? '', g, c.sort, c.dir).url : urlLista(type, c.q ?? '', g, c, pageSize, 0));
      }
    }, 1200);
    return () => { vivo = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views.data, type]);

  const sortBy = (col: string) => {
    const prop = col === '__name' ? (type === 'contact' || type === 'company' ? 'name' : OBJECTS[type].nameProp) : col;
    setCfg((c) => ({ ...c, sort: prop, dir: c.sort === prop && c.dir === 'desc' ? 'asc' : 'desc' }));
  };
  const label = (col: string) => col === '__company' ? 'Empresa' : col === '__tags' ? 'Etiquetas' : col === '__unidad' ? 'Unidad de negocio' : propOf(meta, type, col)?.label ?? col;
  const nFilters = cfg.groups.reduce((n, g) => n + g.length, 0);
  // Lo editado en las celdas se ve enseguida, sin recargar la lista (ni cambiar el orden).
  const [patched, setPatched] = useState<Record<number, CrmRecord>>({});
  useEffect(() => { setPatched({}); }, [list.data]);
  const rows = (list.data?.results ?? []).map((r) => (patched[r.id] ? { ...r, ...patched[r.id] } : r));
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const resize = useColumnResize(cfg.widths, (widths) => setCfg((c) => ({ ...c, widths })));
  const quickBar = (
    <QuickFilterBar type={type} owners={cfg.owners ?? []} dates={cfg.dates ?? {}} tags={cfg.tags ?? []} unidades={cfg.unidades ?? []} extra={cfg.groups.length > 0}
      onOwners={(owners) => setCfg((c) => ({ ...c, owners }))} onDates={(dates) => setCfg((c) => ({ ...c, dates }))} onTags={(tags) => setCfg((c) => ({ ...c, tags }))}
      onUnidades={(unidades) => setCfg((c) => ({ ...c, unidades }))}
      onClear={() => setCfg((c) => ({ ...c, owners: [], dates: {}, tags: [], unidades: [], groups: [] }))} />
  );
  const filterButton = <button className={`btn${mode === 'board' ? ' sm' : ''}`} onClick={() => setShow('filters')}><Icon name="filter" size={16} />Filtros{nFilters ? ` (${nFilters})` : ''}</button>;
  const filterChips = (
    <>
      {cfg.groups.flatMap((g, gi) => g.map((f, fi) => (
        <span key={`${gi}-${fi}`} className="chip on">{gi > 0 && fi === 0 ? 'o ' : ''}{describeFilter(meta, type, f)}
          <button aria-label="Quitar" onClick={() => setCfg((c) => ({ ...c, groups: c.groups.map((gg, i) => i === gi ? gg.filter((_, j) => j !== fi) : gg).filter((gg) => gg.length) }))}>×</button>
        </span>
      )))}
    </>
  );

  const exportCsv = () => {
    const url = `/api/export/${type}${qs({ q: dq, groups: groups.length ? groups : undefined, sort: cfg.sort, dir: cfg.dir, columns: columns.filter((c) => !c.startsWith('__') || c === '__company').join(',') })}`;
    window.location.href = url;
  };

  return (
    // En la tabla, la lista ocupa el alto que queda y se desplaza adentro, con sus dos barras siempre a mano (como HubSpot).
    <div className={`content${mode === 'table' ? ' list-fixed' : ''}`}>
      <div className="page-head">
        {type === 'deal' ? (
          <div className="pipe-head">
            <h1>Negocios</h1>
            <PipelineSwitcher value={mode === 'board' ? boardPipeline : pipelineSel} allowAll={mode === 'table'} onChange={setPipelineSel} />
            {mode === 'table' && <span className="muted small num">{list.data ? `${list.data.total.toLocaleString('es-AR')} negocios` : ''}</span>}
          </div>
        ) : (
          <h1>{OBJECTS[type].plural} <span className="muted small num">{list.data ? list.data.total.toLocaleString('es-AR') : ''}</span></h1>
        )}
        {(
          <div className="row" role="group" aria-label="Vista">
            <button className={`btn sm ${mode === 'table' ? 'primary' : ''}`} onClick={() => setMode('table')}><Icon name="table" size={14} />Tabla</button>
            <button className={`btn sm ${mode === 'board' ? 'primary' : ''}`} onClick={() => setMode('board')}><Icon name="board" size={14} />Tablero</button>
          </div>
        )}
        <button className="btn" onClick={() => setShow('import')}><Icon name="upload" size={16} />Importar</button>
        <button className="btn" onClick={exportCsv}><Icon name="download" size={16} />Exportar</button>
        <button className="btn primary" onClick={() => setShow('create')}><Icon name="plus" size={16} />{OBJECTS[type].create}</button>
      </div>

      {/* Las vistas (Todos, Míos, guardadas) y los filtros valen para la tabla y para el tablero, como en HubSpot. */}
      <div className="tabs">
        <button className={`tab ${activeView === 'all' ? 'on' : ''}`} onClick={() => applyView('all')}>Todos</button>
        <button className={`tab ${activeView === 'mine' ? 'on' : ''}`} onClick={() => applyView('mine')}>Míos</button>
        {vistas.map((v, i) => (
          // Cada uno ordena sus pestañas arrastrándolas (el orden queda en su usuario); con quién se comparte, al pasar el mouse.
          <div key={v.id} className={`tab-wrap${activeView === String(v.id) ? ' on' : ''}${arrastrando === v.id ? ' arrastrando' : ''}${marca?.id === v.id ? ` marca-${marca.lado}` : ''}`}
            draggable onDragStart={(e) => { setArrastrando(v.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(v.id)); }}
            onDragEnd={() => { setArrastrando(null); setMarca(null); }}
            onDragOver={(e) => {
              if (arrastrando == null || arrastrando === v.id) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const lado = e.clientX < r.left + r.width / 2 ? 'antes' : 'despues';
              if (marca?.id !== v.id || marca.lado !== lado) setMarca({ id: v.id, lado });
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMarca((m) => (m?.id === v.id ? null : m)); }}
            onDrop={(e) => { e.preventDefault(); if (arrastrando != null && marca) soltarVista(arrastrando, v.id, marca.lado); setArrastrando(null); setMarca(null); }}>
            <button className={`tab ${activeView === String(v.id) ? 'on' : ''}`} onClick={() => applyView(String(v.id))}
              title={`${v.shared ? 'Compartida con todos' : v.team_id ? `Compartida con ${meta.teams.find((t) => t.id === v.team_id)?.name ?? 'un equipo'}` : 'Solo vos'}. Arrastrala para cambiar el orden.`}>
              {v.config.mode === 'board' && <Icon name="board" size={13} />}{v.name}
            </button>
            {activeView === String(v.id) && <ViewMenu type={type} view={v} onChanged={() => views.reload()} onDeleted={() => { views.reload(); applyView('all'); }}
              onMover={(d) => moverVista(v.id, d)} puedeIzq={i > 0} puedeDer={i < vistas.length - 1} />}
          </div>
        ))}
        <button className="tab" onClick={() => setShow('save')}>+ Agregar vista</button>
      </div>

      {/* Con cambios sin guardar aparece la barra abajo (como en HubSpot); al guardar o descartar, se va. */}
      {(dirty || filtersChanged) && !selected.size && (
        <div className="save-bar" role="region" aria-label="Cambios sin guardar en la vista">
          <span className="grow">{dirty ? <>Cambiaste la vista <b>{activeSaved!.name}</b></> : 'Cambiaste los filtros'}</span>
          <button className="btn sm ghost" onClick={() => applyView(activeView)}>Descartar</button>
          {dirty ? <>
            <button className="btn sm" onClick={() => setShow('save')}>Guardar como nueva</button>
            {canSaveView
              ? <button className="btn sm primary" onClick={saveView}>Guardar</button>
              : <button className="btn sm primary" disabled title="Solo quien creó la vista (o un administrador) la puede cambiar">Guardar</button>}
          </> : <button className="btn sm primary" onClick={() => setShow('save')}>Guardar como vista nueva</button>}
        </div>
      )}

      {selected.size > 0 && (
        <BulkBar type={type} sel={{ ids: selected, all: selAll }} total={mode === 'board' ? boardTotal : list.data?.total}
          query={mode === 'board' ? { q: dq, groups: type === 'deal' ? (viewGroups.length ? viewGroups : [[]]).map((g) => [...g, { prop: 'pipeline', op: 'eq', value: boardPipeline }]) : viewGroups } : { q: dq, groups }}
          onSelectAll={() => setSelAll(true)} onClear={() => setSelected(new Set())}
          onDone={() => { setSelected(new Set()); list.reload(); setBoardKey((k) => k + 1); }} />
      )}
      {mode === 'board' && type === 'deal' ? <Board pipelineId={boardPipeline} openId={preview?.id} onOpen={setPreview} selected={selected} onSelect={toggleSel} onTotal={setBoardTotal} onCreate={createIn} reloadKey={boardKey} q={dq} groups={viewGroups}
        sort={cfg.sort} dir={cfg.dir} onSort={(sort, dir) => setCfg((c) => ({ ...c, sort, dir }))} tools={<>{quickBar}{filterButton}{filterChips}</>} onSearch={setQ} search={q} />
        : mode === 'board' ? <PropBoard type={type} selected={selected} onSelect={toggleSel} onTotal={setBoardTotal} onCreate={createIn} prop={cfg.boardProp}
          cardProps={cfg.cardProps} onCardProps={(cardProps) => setCfg((c) => ({ ...c, cardProps }))} onProp={(boardProp) => setCfg((c) => ({ ...c, boardProp }))} openId={preview?.id} onOpen={setPreview}
          reloadKey={boardKey} q={dq} groups={viewGroups} sort={cfg.sort} dir={cfg.dir} onSort={(sort, dir) => setCfg((c) => ({ ...c, sort, dir }))}
          tools={<>{quickBar}{filterButton}{filterChips}</>} onSearch={setQ} search={q} /> : <>
        <div className="toolbar">
          <div className="search" style={{ width: 280 }}><Icon name="search" /><input className="input" placeholder="Buscar nombre, mail, teléfono…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {quickBar}
          {filterButton}
          <button className="btn" onClick={() => setShow('columns')}><Icon name="columns" size={16} />Columnas</button>
          {filterChips}
        </div>

        <div className={`table-wrap${list.fresh ? '' : ' cargando'}`} aria-busy={list.loading}>
          <ColumnWidths scope="grid-list" order={['__check', '__name', ...columns]} widths={resize.widths} />
          <table className="grid grid-list">
            <thead>
              <tr>
                <th className="check nosort"><input type="checkbox" aria-label="Seleccionar todo" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <th className="namecol" onClick={() => sortBy('__name')}>Nombre{['name', OBJECTS[type].nameProp].includes(cfg.sort) && <span className="sort-ind">{cfg.dir === 'asc' ? '▲' : '▼'}</span>}{resize.handle('__name')}</th>
                {columns.map((col, i) => (
                  <th key={col} className={`${col.startsWith('__') ? 'nosort' : ''} has-menu${['number', 'currency'].includes(propOf(meta, type, col)?.type ?? '') ? ' numcol' : ''}`} onClick={() => !col.startsWith('__') && sortBy(col)}>
                    {label(col)}{cfg.sort === col && <span className="sort-ind">{cfg.dir === 'asc' ? '▲' : '▼'}</span>}
                    <ColMenu label={label(col)} sortable={!col.startsWith('__')} filterable={!col.startsWith('__')}
                      first={i === 0} last={i === columns.length - 1}
                      onSort={(dir) => setCfg((c) => ({ ...c, sort: col, dir }))}
                      onFilter={() => { setFilterProp(col); setShow('filters'); }}
                      onMove={(d) => setCfg((c) => { const n = [...c.columns]; const k = n.indexOf(col); if (k < 0) return c; n.splice(k, 1); n.splice(k + d, 0, col); return { ...c, columns: n }; })}
                      onRemove={() => setCfg((c) => ({ ...c, columns: c.columns.filter((x) => x !== col) }))} />
                    {resize.handle(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'sel' : ''}>
                  <td className="check"><input type="checkbox" aria-label={`Seleccionar ${r.name}`} checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} /></td>
                  <td className="name">{type === 'company' || type === 'contact'
                    ? <Link to={recordUrl(type, r.id)} className="with-logo" title={r.name}><Avatar name={r.name} type={type} domain={r.props.domain} email={r.props.email} /><span className="ellipsis">{r.name}</span></Link>
                    : <Link to={recordUrl(type, r.id)} title={r.name}>{r.name}</Link>}
                    <button className="btn sm peek" onClick={() => setPreview(r.id)}>Vista previa</button></td>
                  {columns.map((col) => (col === '__company'
                    ? <td key={col}>{r.company ? <Link to={recordUrl('company', r.company.id)}>{r.company.name}</Link> : <span className="muted">—</span>}</td>
                    : col === '__tags' ? <td key={col}><TagChips meta={meta} ids={r.tags} small />{!r.tags?.length && <span className="muted">—</span>}</td>
                    : col === '__unidad' ? <td key={col}><Unidades keys={unidadesDe(meta, type, r.props)} /></td>
                    : <EditCell key={col} type={type} record={r} col={col} onSaved={(nr) => setPatched((p) => ({ ...p, [r.id]: nr }))} />))}
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && !rows.length && <div className="empty">No hay {OBJECTS[type].plural.toLowerCase()} con estos filtros.</div>}
          {list.error && <div className="empty plain">{list.error}</div>}
        </div>
        <div className="pager">
          <span>Por página</span>
          <Select className="input sm" style={{ width: 84 }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
            {[25, 50, 100, 200].map((n) => <option key={n}>{n}</option>)}
          </Select>
          <span className="num">{list.data ? `${Math.min(page * pageSize + 1, list.data.total)}–${Math.min((page + 1) * pageSize, list.data.total)} de ${list.data.total}` : ''}</span>
          <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
          <button className="btn sm" disabled={!list.data || (page + 1) * pageSize >= list.data.total} onClick={() => setPage(page + 1)}>Siguiente</button>
        </div>
      </>}

      {preview && <RecordPreview key={`${preview.id}-${preview.compose ?? ''}`} type={type} id={preview.id} compose={preview.compose} onClose={() => setPreview(null)} onChange={() => { setBoardKey((k) => k + 1); list.reload(); }} />}
      {show === 'create' && <CreateRecord type={type} onClose={() => { setShow(''); setCreateDefaults(undefined); }} onCreated={() => { list.reload(); setBoardKey((k) => k + 1); }} defaults={createDefaults ?? (type === 'deal' ? { pipeline: boardPipeline } : undefined)} />}
      {show === 'filters' && <FiltersDrawer type={type} groups={cfg.groups} addProp={filterProp} onClose={() => { setShow(''); setFilterProp(undefined); }} onApply={(g) => { setCfg((c) => ({ ...c, groups: g })); setShow(''); setFilterProp(undefined); }} />}
      {show === 'columns' && <ColumnsModal type={type} columns={cfg.columns} onClose={() => setShow('')} onApply={(columns) => { setCfg((c) => ({ ...c, columns })); setShow(''); }} />}
      {show === 'import' && <ImportModal type={type} onClose={() => { setShow(''); list.reload(); }} />}
      {show === 'save' && <SaveView type={type} config={current} onClose={() => setShow('')} onSaved={(id) => { setShow(''); views.reload(); setActiveView(String(id)); }} />}
    </div>
  );
}

function Unidades({ keys }: { keys: UnidadKey[] }) {
  return keys.length ? <span className="unidades">{keys.map((k) => <UnidadBadge key={k} k={k} />)}</span> : <span className="muted">—</span>;
}

// Edición en la celda, como en HubSpot: el lápiz (o doble clic) abre el campo. Los desplegables guardan al elegir;
// el resto con Guardar o Enter. Quien es de solo lectura no ve el lápiz (y el servidor tampoco lo deja).
function EditCell({ type, record, col, onSaved }: { type: ObjectType; record: CrmRecord; col: string; onSaved: (r: CrmRecord) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const prop = propOf(meta, type, col);
  const [at, setAt] = useState<DOMRect | null>(null);
  const [val, setVal] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const shown = type === 'order' && col === 'hs_pipeline_stage' && record.props[col] ? <EtapaPedido value={record.props[col]} label={formatValue(meta, type, col, record.props[col])} />
    : col === 'unidad_de_negocio' && unidadesDe(meta, 'order', record.props).length ? <Unidades keys={unidadesDe(meta, 'order', record.props)} />
    : formatValue(meta, type, col, record.props[col], record.props) || <span className="muted">—</span>;
  // Montos abreviados en la celda; la cifra exacta, al pasar el mouse.
  const exact = prop?.type === 'currency' && record.props[col] != null && record.props[col] !== ''
    ? fmtMoneyExact(record.props[col], col.endsWith('_usd') ? 'USD' : record.props.deal_currency_code ?? record.props.hs_currency_code) : undefined;
  if (col === 'estado_cliente' && record.props[col]) return <td><EstadoCliente value={String(record.props[col])} /></td>;
  // Números y montos alineados a la derecha, como en la tabla del Design System.
  const numeric = !!prop && ['number', 'currency'].includes(prop.type);
  if (meta.me.role === 'viewer' || !prop || prop.read_only || col === 'pipeline') return <td title={exact} className={numeric ? 'numcell' : undefined}>{shown}</td>;
  const instant = ['owner', 'enum', 'bool'].includes(prop.type) || col === 'dealstage';
  const open = (e: React.MouseEvent) => { setVal(record.props[col]); setAt((e.currentTarget.closest('td') as HTMLElement).getBoundingClientRect()); };
  const save = async (v: unknown) => {
    if (String(v ?? '') === String(record.props[col] ?? '')) { setAt(null); return; }
    setSaving(true);
    try {
      onSaved(await http<CrmRecord>('PATCH', `/records/${type}/${record.id}`, { props: { [col]: v } }));
      setAt(null);
      toast(`${prop.label}: guardado`);
    } catch (e) {
      const missing = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      toast(missing?.length ? `Para esa etapa falta: ${missing.map((m) => propOf(meta, type, m)?.label ?? m).join(', ')}. Completalo desde la ficha o el tablero.` : (e as Error).message, true);
    } finally { setSaving(false); }
  };
  return (
    <td className={`editable${numeric ? ' numcell' : ''}`} onDoubleClick={open} title={exact}>
      <span className="cell-v">{shown}</span>
      <button className="cell-edit" title={`Editar ${prop.label}`} aria-label={`Editar ${prop.label} de ${record.name}`} onClick={open}><Icon name="edit" size={14} /></button>
      {at && createPortal(
        <>
          <div className="cell-veil" onClick={() => setAt(null)} />
          <form className="popover cell-pop" style={{ top: Math.min(at.bottom + 4, window.innerHeight - 220), left: Math.min(at.left, window.innerWidth - 300), minWidth: Math.max(at.width, 280) }}
            onKeyDown={(e) => { if (e.key === 'Escape') setAt(null); }}
            onSubmit={(e) => { e.preventDefault(); save(val); }}>
            <div className="small" style={{ fontWeight: 600 }}>{prop.label}</div>
            {col === 'dealstage'
              ? <StageSelect value={String(val ?? '')} pipelineId={record.props.pipeline} onChange={(v) => save(v)} />
              : <PropertyInput prop={prop} type={type} value={val} autoFocus onChange={(v) => (instant ? save(v) : setVal(v))} />}
            {!instant && (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn sm" onClick={() => setAt(null)}>Cancelar</button>
                <button type="submit" className="btn sm primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
              </div>
            )}
          </form>
        </>, document.body)}
    </td>
  );
}

// Menú del encabezado de una columna (como el ⋮ de HubSpot): ordenar, filtrar por ella, moverla o quitarla.
function ColMenu({ label, sortable, filterable, first, last, onSort, onFilter, onMove, onRemove }: {
  label: string; sortable: boolean; filterable: boolean; first: boolean; last: boolean;
  onSort: (dir: 'asc' | 'desc') => void; onFilter: () => void; onMove: (d: number) => void; onRemove: () => void;
}) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const pick = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setAt(null); fn(); };
  return (
    <>
      <button className="col-menu" aria-label={`Opciones de la columna ${label}`} title="Opciones de la columna"
        onClick={(e) => { e.stopPropagation(); setAt((e.currentTarget as HTMLElement).getBoundingClientRect()); }}>⋮</button>
      {at && createPortal(
        <>
          <div className="cell-veil" onClick={() => setAt(null)} />
          <div className="popover cell-pop" style={{ top: at.bottom + 4, left: Math.min(at.left - 180, window.innerWidth - 240), minWidth: 220, padding: 6 }} onClick={(e) => e.stopPropagation()}>
            {sortable && <div className="opt" onClick={pick(() => onSort('asc'))}>Ordenar de menor a mayor</div>}
            {sortable && <div className="opt" onClick={pick(() => onSort('desc'))}>Ordenar de mayor a menor</div>}
            {filterable && <div className="opt" onClick={pick(onFilter)}>Filtrar por esta columna</div>}
            {!first && <div className="opt" onClick={pick(() => onMove(-1))}>Mover a la izquierda</div>}
            {!last && <div className="opt" onClick={pick(() => onMove(1))}>Mover a la derecha</div>}
            <div className="opt danger-text" onClick={pick(onRemove)}>Quitar columna</div>
          </div>
        </>, document.body)}
    </>
  );
}

function FiltersDrawer({ type, groups, addProp, onClose, onApply }: { type: ObjectType; groups: Filter[][]; addProp?: string; onClose: () => void; onApply: (g: Filter[][]) => void }) {
  const { meta } = useMeta();
  const first = filterableProps(meta, type)[0];
  const blank = (): Filter => ({ prop: first.name, op: opsFor(first)[0][0] });
  // «Filtrar por esta columna» abre el panel con un filtro nuevo de esa propiedad, sumado al primer grupo.
  const [draft, setDraft] = useState<Filter[][]>(() => {
    const base = groups.length ? groups : [[]];
    if (!addProp) return base;
    const p = filterableProps(meta, type).find((x) => x.name === addProp);
    return base.map((g, i) => (i === 0 ? [...g, { prop: addProp, op: opsFor(p)[0][0] }] : g));
  });
  return (
    <Drawer title="Filtros avanzados" onClose={onClose} footer={<>
      <button className="btn" onClick={() => onApply([])}>Limpiar</button>
      <button className="btn primary" onClick={() => onApply(draft.map((g) => g.filter((f) => f.prop)).filter((g) => g.length))}>Aplicar</button>
    </>}>
      <p className="muted small" style={{ margin: 0 }}>Dentro de un grupo se cumplen todos los filtros (Y). Entre grupos alcanza con uno (O).</p>
      {draft.map((g, gi) => (
        <div key={gi} className="panel">
          <div className="panel-head"><h3>Grupo {gi + 1}</h3>
            {draft.length > 1 && <button className="btn sm ghost" onClick={() => setDraft(draft.filter((_, i) => i !== gi))}>Quitar grupo</button>}</div>
          <div className="panel-body stack">
            {g.map((f, fi) => (
              <FilterRow key={fi} type={type} f={f}
                onChange={(nf) => setDraft(draft.map((gg, i) => i === gi ? gg.map((x, j) => j === fi ? nf : x) : gg))}
                onRemove={() => setDraft(draft.map((gg, i) => i === gi ? gg.filter((_, j) => j !== fi) : gg))} />
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft(draft.map((gg, i) => i === gi ? [...gg, blank()] : gg))}>+ Agregar filtro</button>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => setDraft([...draft, [blank()]])}>+ Agregar grupo (O)</button>
    </Drawer>
  );
}

function ColumnsModal({ type, columns, onClose, onApply }: { type: ObjectType; columns: string[]; onClose: () => void; onApply: (c: string[]) => void }) {
  const { meta } = useMeta();
  const [sel, setSel] = useState<string[]>(columns);
  const [f, setF] = useState('');
  const options = [
    ...(type === 'contact' || type === 'deal' ? [{ name: '__company', label: 'Empresa asociada' }] : []),
    ...(meta.tags?.some((t) => t.object_type === type) ? [{ name: '__tags', label: 'Etiquetas' }] : []),
    ...(type !== 'order' ? [{ name: '__unidad', label: 'Unidad de negocio' }] : []),
    ...propsOf(meta, type).filter((p) => !['name', 'dealname', 'hs_order_name'].includes(p.name)),
  ];
  const move = (i: number, d: number) => { const n = [...sel]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSel(n); };
  return (
    <Modal title="Editar columnas" onClose={onClose} footer={<>
      <button className="btn" onClick={() => setSel(DEFAULT_COLUMNS[type])}>Restablecer</button>
      <button className="btn primary" onClick={() => onApply(sel)}>Aplicar</button>
    </>}>
      <div className="grid-2">
        <div className="stack">
          <input className="input" placeholder="Buscar propiedad…" value={f} onChange={(e) => setF(e.target.value)} />
          <div className="stack" style={{ maxHeight: 360, overflow: 'auto', gap: 0 }}>
            {options.filter((p) => p.label.toLowerCase().includes(f.toLowerCase())).map((p) => (
              <label key={p.name} className="row small" style={{ padding: '3px 0' }}>
                <input type="checkbox" checked={sel.includes(p.name)} onChange={(e) => setSel(e.target.checked ? [...sel, p.name] : sel.filter((x) => x !== p.name))} />{p.label}
              </label>
            ))}
          </div>
        </div>
        <div className="stack">
          <b className="small">Columnas elegidas ({sel.length})</b>
          {sel.map((c, i) => (
            <div key={c} className="row small">
              <span className="grow ellipsis">{options.find((o) => o.name === c)?.label ?? c}</span>
              <button className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">↑</button>
              <button className="btn sm ghost" disabled={i === sel.length - 1} onClick={() => move(i, 1)} aria-label="Bajar">↓</button>
              <button className="btn sm ghost" onClick={() => setSel(sel.filter((x) => x !== c))} aria-label="Quitar">×</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// Con quién se comparte una vista: solo yo, todos, o un equipo (Corporate, Formas Shop, NOESTRES).
const shareBody = (v: string) => (v === 'all' ? { shared: true, team_id: null } : v === 'me' ? { shared: false, team_id: null } : { shared: false, team_id: Number(v) });
const shareOf = (v: SavedView) => (v.shared ? 'all' : v.team_id ? String(v.team_id) : 'me');
function ShareSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
// abrirla por defecto y borrarla. Cambiar o borrar una vista ajena solo puede un administrador.
function ViewMenu({ type, view, onChanged, onDeleted, onMover, puedeIzq, puedeDer }: {
  type: ObjectType; view: SavedView; onChanged: () => void; onDeleted: () => void; onMover?: (d: -1 | 1) => void; puedeIzq?: boolean; puedeDer?: boolean;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(view.name);
  const [share, setShare] = useState(shareOf(view));
  const [isDefault, setIsDefault] = useState(readDefault(type) === String(view.id));
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
  const toggleDefault = () => {
    try { isDefault ? localStorage.removeItem(defaultViewKey(type)) : localStorage.setItem(defaultViewKey(type), String(view.id)); } catch { /* ignorar */ }
    setIsDefault(!isDefault);
    toast(isDefault ? 'Ya no se abre por defecto' : `«${view.name}» se abre por defecto`);
  };
  return (
    <div className="view-menu" ref={ref}>
      <button ref={btn} className={`view-menu-btn${open ? ' on' : ''}`} aria-label={`Opciones de la vista ${view.name}`} aria-haspopup="menu" aria-expanded={open}
        title="Opciones de la vista: renombrar, compartir, abrir por defecto, borrar" onClick={() => setOpen(!open)}><Icon name="down" size={14} /></button>
      {open && (
        <div ref={pop} className="popover" role="menu" style={{ ...popStyle, minWidth: 220, maxWidth: 320 }}>
          {mine && <div className="opt" onClick={() => { setEdit(true); setOpen(false); }}>Renombrar o compartir…</div>}
          <div className="opt" onClick={() => { setOpen(false); (navigator.clipboard?.writeText(window.location.href) ?? Promise.reject()).then(() => toast('Link copiado'), () => toast('El navegador no dejó copiar: copiá el link de la barra de direcciones.', true)); }}>Copiar link</div>
          <div className="opt" onClick={() => { toggleDefault(); setOpen(false); }}>{isDefault ? '✓ Se abre por defecto' : 'Abrir por defecto'}</div>
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

function SaveView({ type, config, onClose, onSaved }: { type: ObjectType; config: ViewConfig; onClose: () => void; onSaved: (id: number) => void }) {
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
      <p className="muted small" style={{ margin: 0 }}>Guarda filtros, propietario, columnas, orden, búsqueda y si se ve en tabla o tablero{type === 'deal' ? ', con el pipeline' : ''}.</p>
    </Modal>
  );
}

// Selector de pipeline de la página de negocios: grande y arriba, como en HubSpot, para que siempre se sepa dónde estás.
function PipelineSwitcher({ value, onChange, allowAll }: { value: string; onChange: (v: string) => void; allowAll: boolean }) {
  const { meta } = useMeta();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const team = (id: number | null) => meta.teams.find((t) => t.id === id)?.name;
  const cur = meta.pipelines.find((p) => p.id === value);
  const groups = [...new Set(meta.pipelines.map((p) => p.team_id))];
  const pick = (v: string) => { onChange(v); setOpen(false); };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="pipe-switch" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Cambiar de pipeline">
        <span className="ellipsis">{cur ? cur.label : 'Todos los pipelines'}</span>
        {cur?.team_id && (unidadDeEquipo(cur.team_id) ? <UnidadBadge k={unidadDeEquipo(cur.team_id)!} compact />
          : !cur.label.toLowerCase().startsWith(String(team(cur.team_id)).toLowerCase().split(' ')[0]) && <span className="team">{team(cur.team_id)}</span>)}
        <span aria-hidden="true" className="caret">▾</span>
      </button>
      {open && (
        <div className="popover pipe-menu" role="listbox" style={{ top: 48, left: 0 }}>
          {allowAll && <div className={`opt${value === 'all' ? ' on' : ''}`} role="option" aria-selected={value === 'all'} onClick={() => pick('all')}><b>Todos los pipelines</b></div>}
          {groups.map((g) => (
            <div key={String(g)}>
              <div className="grp">{unidadDeEquipo(g) ? <UnidadBadge k={unidadDeEquipo(g)!} /> : team(g) ?? 'Sin equipo'}</div>
              {meta.pipelines.filter((p) => p.team_id === g).map((p) => (
                <div key={p.id} className={`opt${p.id === value ? ' on' : ''}`} role="option" aria-selected={p.id === value} onClick={() => pick(p.id)}>
                  <span className="grow">{p.label}</span><span className="small muted">{p.stages.length} etapas</span>
                </div>
              ))}
            </div>
          ))}
          {!allowAll && <div className="small muted" style={{ padding: '6px 10px' }}>El tablero muestra un pipeline a la vez.</div>}
        </div>
      )}
    </div>
  );
}
