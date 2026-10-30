import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useAsync, useDebounced, typeFromPath, OBJECTS, propsOf, propOf, formatValue, recordUrl, Icon, defaultPipeline,
  type CrmRecord, type Filter, type ObjectType,
} from '../lib';
import { Avatar, CreateRecord, Drawer, FilterRow, Modal, PropertyInput, StageSelect, describeFilter, filterableProps, opsFor } from '../components';
import Board from './Board';
import PropBoard from './PropBoard';
import ImportModal from './Import';
import { RecordPreview } from './RecordPage';

const PIPE_KEY = 'crm.deals.pipeline';

const DEFAULT_COLUMNS: Record<ObjectType, string[]> = {
  contact: ['email', 'phone', '__company', 'owner_id', 'lifecyclestage', 'notes_last_updated', 'createdate'],
  company: ['domain', 'owner_id', 'city', 'lifecyclestage', 'tipo_de_empresa_cotizacion', 'notes_last_updated', 'createdate'],
  deal: ['dealstage', 'amount', '__company', 'closedate', 'owner_id', 'notes_last_updated', 'createdate'],
  order: ['pdv_finnegans', 'hs_total_price', 'owner_id', 'hs_order_status', 'createdate'],
};

interface ViewConfig { q?: string; groups: Filter[][]; columns: string[]; sort: string; dir: 'asc' | 'desc'; owner?: string; pipeline?: string; mode?: 'table' | 'board' }
interface SavedView { id: number; name: string; shared: number; user_id: number; config: ViewConfig }

const storeKey = (t: ObjectType) => `crm.view.${t}`;
function loadLocal(t: ObjectType): ViewConfig {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(t)) ?? '');
    if (v && Array.isArray(v.columns)) return v;
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
  const mode = type !== 'order' && params.get('view') === 'board' ? 'board' : 'table';
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
  const [activeView, setActiveView] = useState<string>(params.get('v') ?? 'all');
  const [q, setQ] = useState(cfg.q ?? '');
  const dq = useDebounced(q, 300);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Vista previa al costado (clic en una tarjeta del tablero o «Vista previa» en la tabla), como en HubSpot.
  const [preview, setPreview] = useState<number | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [show, setShow] = useState<'' | 'filters' | 'columns' | 'create' | 'bulk' | 'save' | 'import'>('');
  const views = useAsync(() => http<SavedView[]>('GET', `/views/${type}`), [type]);

  useEffect(() => { try { localStorage.setItem(storeKey(type), JSON.stringify({ ...cfg, q })); } catch { /* ignorar */ } }, [cfg, q, type]);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [dq, cfg.groups, cfg.owner, cfg.sort, cfg.dir, pipelineSel]);

  const groups = useMemo(() => {
    const base = cfg.groups.length ? cfg.groups : [[]];
    const own: Filter[] = cfg.owner ? [{ prop: 'owner_id', op: cfg.owner === 'none' ? 'unknown' : 'eq', value: cfg.owner }] : [];
    const pipe: Filter[] = type === 'deal' && pipelineSel !== 'all' ? [{ prop: 'pipeline', op: 'eq', value: pipelineSel }] : [];
    return base.map((g) => [...g, ...own, ...pipe]).filter((g) => g.length);
  }, [cfg.groups, cfg.owner, pipelineSel, type]);
  // Con «Todos los pipelines» la tabla muestra de qué pipeline es cada negocio.
  const columns = type === 'deal' && pipelineSel === 'all' && !cfg.columns.includes('pipeline') ? ['pipeline', ...cfg.columns] : cfg.columns;

  const list = useAsync(() => http<{ results: Array<CrmRecord & { company?: { id: number; name: string } | null }>; total: number }>('GET', `/records/${type}${qs({
    q: dq, groups: groups.length ? groups : undefined, sort: cfg.sort, dir: cfg.dir, limit: pageSize, offset: page * pageSize,
    with: cfg.columns.includes('__company') ? 'company' : undefined,
  })}`), [type, dq, JSON.stringify(groups), cfg.sort, cfg.dir, page, pageSize, cfg.columns.includes('__company'), mode]);

  const applyView = (key: string) => {
    setActiveView(key);
    const v = views.data?.find((x) => String(x.id) === key);
    const pipe = type === 'deal' && v?.config.pipeline && (v.config.pipeline === 'all' || meta.pipelines.some((p) => p.id === v.config.pipeline)) ? v.config.pipeline : null;
    if (pipe) { setPipelineSelRaw(pipe); try { localStorage.setItem(PIPE_KEY, pipe); } catch { /* ignorar */ } }
    // Un solo cambio del link: la vista, su modo (tabla o tablero) y su pipeline.
    setParams((p) => {
      key === 'all' ? p.delete('v') : p.set('v', key);
      if (v?.config.mode) v.config.mode === 'board' ? p.set('view', 'board') : p.delete('view');
      if (pipe) p.set('pipeline', pipe);
      return p;
    }, { replace: true });
    if (key === 'all') setCfg((c) => ({ ...c, groups: [], owner: undefined }));
    else if (key === 'mine') setCfg((c) => ({ ...c, groups: [], owner: 'me' }));
    else if (v) { setCfg({ ...loadLocal(type), ...v.config }); setQ(v.config.q ?? ''); }
  };
  // Lo que se ve ahora, para guardar en una vista y saber si la vista abierta tiene cambios sin guardar (como HubSpot).
  const current: ViewConfig = { q, groups: cfg.groups, columns: cfg.columns, sort: cfg.sort, dir: cfg.dir, owner: cfg.owner, mode, ...(type === 'deal' ? { pipeline: pipelineSel } : {}) };
  const activeSaved = views.data?.find((v) => String(v.id) === activeView);
  const norm = (c: ViewConfig, base: ViewConfig) => JSON.stringify([
    c.q ?? '', c.groups ?? [], c.columns ?? base.columns, c.sort ?? base.sort, c.dir ?? base.dir, c.owner ?? '', c.mode ?? base.mode, type === 'deal' ? c.pipeline ?? base.pipeline : '',
  ]);
  const dirty = !!activeSaved && norm(current, current) !== norm(activeSaved.config, current);
  const canSaveView = !!activeSaved && (activeSaved.user_id === meta.me.id || meta.me.role === 'admin');
  const saveView = async () => {
    if (!activeSaved) return;
    try {
      await http('PATCH', `/views/${type}/${activeSaved.id}`, { config: current });
      toast(`Vista «${activeSaved.name}» guardada`);
      views.reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  useEffect(() => { if (views.data && activeView !== 'all' && activeView !== 'mine') applyView(activeView); /* eslint-disable-next-line */ }, [views.data]);

  const sortBy = (col: string) => {
    const prop = col === '__name' ? (type === 'contact' || type === 'company' ? 'name' : OBJECTS[type].nameProp) : col;
    setCfg((c) => ({ ...c, sort: prop, dir: c.sort === prop && c.dir === 'desc' ? 'asc' : 'desc' }));
  };
  const label = (col: string) => col === '__company' ? 'Empresa' : propOf(meta, type, col)?.label ?? col;
  const nFilters = cfg.groups.reduce((n, g) => n + g.length, 0);
  // Lo editado en las celdas se ve enseguida, sin recargar la lista (ni cambiar el orden).
  const [patched, setPatched] = useState<Record<number, CrmRecord>>({});
  useEffect(() => { setPatched({}); }, [list.data]);
  const rows = (list.data?.results ?? []).map((r) => (patched[r.id] ? { ...r, ...patched[r.id] } : r));
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const filterButton = <button className="btn" onClick={() => setShow('filters')}><Icon name="filter" size={16} />Filtros{nFilters ? ` (${nFilters})` : ''}</button>;
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
    const url = `/api/export/${type}${qs({ q: dq, groups: groups.length ? groups : undefined, sort: cfg.sort, dir: cfg.dir, columns: cfg.columns.filter((c) => !c.startsWith('__')).join(',') })}`;
    window.location.href = url;
  };

  return (
    <div className="content">
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
        {type !== 'order' && (
          <div className="row" role="group" aria-label="Vista">
            <button className={`btn sm ${mode === 'table' ? 'primary' : ''}`} onClick={() => setParams((p) => { p.delete('view'); return p; })}><Icon name="table" size={14} />Tabla</button>
            <button className={`btn sm ${mode === 'board' ? 'primary' : ''}`} onClick={() => setParams((p) => { p.set('view', 'board'); return p; })}><Icon name="board" size={14} />Tablero</button>
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
        {views.data?.map((v) => (
          <button key={v.id} className={`tab ${activeView === String(v.id) ? 'on' : ''}`} onClick={() => applyView(String(v.id))}>
            {v.name}{v.shared ? <span className="x">(equipo)</span> : null}
          </button>
        ))}
        <button className="tab" onClick={() => setShow('save')}>+ Guardar vista</button>
        {dirty && (
          <div className="view-dirty">
            <span className="small muted">Cambios sin guardar</span>
            <button className="btn sm ghost" onClick={() => applyView(activeView)}>Descartar</button>
            <button className="btn sm" onClick={() => setShow('save')}>Guardar como nueva</button>
            {canSaveView
              ? <button className="btn sm primary" onClick={saveView}>Guardar</button>
              : <button className="btn sm primary" disabled title="Solo quien creó la vista (o un administrador) la puede cambiar">Guardar</button>}
          </div>
        )}
      </div>

      {mode === 'board' && type === 'deal' ? <Board pipelineId={boardPipeline} openId={preview} onOpen={setPreview} reloadKey={boardKey} q={dq} owner={cfg.owner} groups={cfg.groups} tools={<>{filterButton}{filterChips}</>} onSearch={setQ} search={q} onOwner={(o) => setCfg((c) => ({ ...c, owner: o }))} />
        : mode === 'board' ? <PropBoard type={type} openId={preview} onOpen={setPreview} reloadKey={boardKey} q={dq} owner={cfg.owner} groups={cfg.groups} tools={<>{filterButton}{filterChips}</>} onSearch={setQ} search={q} onOwner={(o) => setCfg((c) => ({ ...c, owner: o }))} /> : <>
        <div className="toolbar">
          <div className="search" style={{ width: 280 }}><Icon name="search" /><input className="input" placeholder="Buscar nombre, mail, teléfono…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select className="input" style={{ width: 215 }} value={cfg.owner ?? ''} onChange={(e) => setCfg((c) => ({ ...c, owner: e.target.value || undefined }))} aria-label="Propietario">
            <option value="">Todos los propietarios</option>
            <option value="me">Yo</option>
            <option value="none">Sin asignar</option>
            {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {filterButton}
          <button className="btn" onClick={() => setShow('columns')}><Icon name="columns" size={16} />Columnas</button>
          {filterChips}
        </div>

        {selected.size > 0 && (
          <div className="bulkbar">
            <b>{selected.size} seleccionados</b>
            <button className="btn sm" onClick={() => setShow('bulk')}>Editar</button>
            {['admin', 'manager'].includes(meta.me.role) && (
              <button className="btn sm danger" onClick={async () => {
                if (!confirm(`¿Borrar ${selected.size} registros? Se pueden restaurar desde la ficha.`)) return;
                await http('POST', `/records/${type}/batch`, { ids: [...selected], archive: true });
                toast('Registros borrados'); setSelected(new Set()); list.reload();
              }}><Icon name="trash" size={14} />Borrar</button>
            )}
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Deseleccionar</button>
          </div>
        )}

        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="check nosort"><input type="checkbox" aria-label="Seleccionar todo" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <th onClick={() => sortBy('__name')}>Nombre{['name', OBJECTS[type].nameProp].includes(cfg.sort) && <span className="sort-ind">{cfg.dir === 'asc' ? '▲' : '▼'}</span>}</th>
                {columns.map((col) => (
                  <th key={col} className={col.startsWith('__') ? 'nosort' : ''} onClick={() => !col.startsWith('__') && sortBy(col)}>
                    {label(col)}{cfg.sort === col && <span className="sort-ind">{cfg.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'sel' : ''}>
                  <td className="check"><input type="checkbox" aria-label={`Seleccionar ${r.name}`} checked={selected.has(r.id)} onChange={() => {
                    const s = new Set(selected); s.has(r.id) ? s.delete(r.id) : s.add(r.id); setSelected(s);
                  }} /></td>
                  <td className="name">{type === 'company' || type === 'contact'
                    ? <Link to={recordUrl(type, r.id)} className="with-logo"><Avatar name={r.name} type={type} domain={r.props.domain} email={r.props.email} />{r.name}</Link>
                    : <Link to={recordUrl(type, r.id)}>{r.name}</Link>}
                    <button className="btn sm peek" onClick={() => setPreview(r.id)}>Vista previa</button></td>
                  {columns.map((col) => (col === '__company'
                    ? <td key={col}>{r.company ? <Link to={recordUrl('company', r.company.id)}>{r.company.name}</Link> : <span className="muted">—</span>}</td>
                    : <EditCell key={col} type={type} record={r} col={col} onSaved={(nr) => setPatched((p) => ({ ...p, [r.id]: nr }))} />))}
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && !rows.length && <div className="empty">No hay {OBJECTS[type].plural.toLowerCase()} con estos filtros.</div>}
          {list.error && <div className="empty">{list.error}</div>}
        </div>
        <div className="pager">
          <span>Por página</span>
          <select className="input sm" style={{ width: 84 }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
            {[25, 50, 100, 200].map((n) => <option key={n}>{n}</option>)}
          </select>
          <span className="num">{list.data ? `${Math.min(page * pageSize + 1, list.data.total)}–${Math.min((page + 1) * pageSize, list.data.total)} de ${list.data.total}` : ''}</span>
          <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
          <button className="btn sm" disabled={!list.data || (page + 1) * pageSize >= list.data.total} onClick={() => setPage(page + 1)}>Siguiente</button>
        </div>
      </>}

      {preview && <RecordPreview type={type} id={preview} onClose={() => setPreview(null)} onChange={() => { setBoardKey((k) => k + 1); list.reload(); }} />}
      {show === 'create' && <CreateRecord type={type} onClose={() => setShow('')} onCreated={() => list.reload()} defaults={type === 'deal' ? { pipeline: boardPipeline } : undefined} />}
      {show === 'filters' && <FiltersDrawer type={type} groups={cfg.groups} onClose={() => setShow('')} onApply={(g) => { setCfg((c) => ({ ...c, groups: g })); setShow(''); }} />}
      {show === 'columns' && <ColumnsModal type={type} columns={cfg.columns} onClose={() => setShow('')} onApply={(columns) => { setCfg((c) => ({ ...c, columns })); setShow(''); }} />}
      {show === 'bulk' && <BulkEdit type={type} ids={[...selected]} onClose={() => setShow('')} onDone={() => { setShow(''); setSelected(new Set()); list.reload(); }} />}
      {show === 'import' && <ImportModal type={type} onClose={() => { setShow(''); list.reload(); }} />}
      {show === 'save' && <SaveView type={type} config={current} onClose={() => setShow('')} onSaved={(id) => { setShow(''); views.reload(); setActiveView(String(id)); }} />}
    </div>
  );
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
  const shown = formatValue(meta, type, col, record.props[col], record.props) || <span className="muted">—</span>;
  if (meta.me.role === 'viewer' || !prop || prop.read_only || col === 'pipeline') return <td>{shown}</td>;
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
    <td className="editable" onDoubleClick={open}>
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

function FiltersDrawer({ type, groups, onClose, onApply }: { type: ObjectType; groups: Filter[][]; onClose: () => void; onApply: (g: Filter[][]) => void }) {
  const { meta } = useMeta();
  const [draft, setDraft] = useState<Filter[][]>(groups.length ? groups : [[]]);
  const first = filterableProps(meta, type)[0];
  const blank = (): Filter => ({ prop: first.name, op: opsFor(first)[0][0] });
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
  const options = [...(type === 'contact' || type === 'deal' ? [{ name: '__company', label: 'Empresa asociada' }] : []), ...propsOf(meta, type).filter((p) => !['name', 'dealname', 'hs_order_name'].includes(p.name))];
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

function BulkEdit({ type, ids, onClose, onDone }: { type: ObjectType; ids: number[]; onClose: () => void; onDone: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const editable = propsOf(meta, type).filter((p) => !p.read_only && !['name', 'dealname', 'email', 'hs_order_name'].includes(p.name));
  const [prop, setProp] = useState(editable.find((p) => p.name === 'owner_id')?.name ?? editable[0].name);
  const [value, setValue] = useState<any>(null);
  const p = editable.find((x) => x.name === prop)!;
  return (
    <Modal title={`Editar ${ids.length} registros`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" onClick={async () => {
        try { await http('POST', `/records/${type}/batch`, { ids, props: { [prop]: value } }); toast('Listo'); onDone(); }
        catch (e) { toast((e as Error).message, true); }
      }}>Actualizar</button>
    </>}>
      <label className="field">Propiedad
        <select className="input" value={prop} onChange={(e) => { setProp(e.target.value); setValue(null); }}>
          {editable.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
        </select>
      </label>
      <label className="field">Nuevo valor<PropertyInput prop={p} type={type} value={value} onChange={setValue} /></label>
    </Modal>
  );
}

function SaveView({ type, config, onClose, onSaved }: { type: ObjectType; config: ViewConfig; onClose: () => void; onSaved: (id: number) => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const toast = useToast();
  return (
    <Modal title="Guardar vista" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!name.trim()} onClick={async () => {
        try { const v = await http<{ id: number }>('POST', `/views/${type}`, { name, shared, config }); toast('Vista guardada'); onSaved(v.id); }
        catch (e) { toast((e as Error).message, true); }
      }}>Guardar</button>
    </>}>
      <label className="field">Nombre<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Corporate sin actividad 30 días" /></label>
      <label className="row small"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Compartir con todo el equipo</label>
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
        {cur?.team_id && !cur.label.toLowerCase().startsWith(String(team(cur.team_id)).toLowerCase().split(' ')[0]) && <span className="team">{team(cur.team_id)}</span>}
        <span aria-hidden="true" className="caret">▾</span>
      </button>
      {open && (
        <div className="popover pipe-menu" role="listbox" style={{ top: 48, left: 0 }}>
          {allowAll && <div className={`opt${value === 'all' ? ' on' : ''}`} role="option" aria-selected={value === 'all'} onClick={() => pick('all')}><b>Todos los pipelines</b></div>}
          {groups.map((g) => (
            <div key={String(g)}>
              <div className="grp">{team(g) ?? 'Sin equipo'}</div>
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
