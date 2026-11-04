import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useAsync, fmtMoney, fmtDate, fmtRelative, recordUrl, userName, Icon, missingFor, formatValue, propOf, safeUrl, ACTIVITY_LABEL, TagChips,
  type Activity, type CrmRecord, type Stage, type Pipeline, type Property, type Filter,
} from '../lib';
import { Avatar, Modal, PropertyInput } from '../components';
import { Select } from '../Select';

// Lo que el servidor agrega a cada tarjeta: contacto y empresa asociados y la próxima actividad.
export interface CardInfo { contact?: { id: number; name: string }; company?: { id: number; name: string }; next?: { type: string; subject: string; at: string } }
type Card = CrmRecord & { card?: CardInfo };
interface Column { stage: Stage; total: number; amount: number; weighted: number; deals: Card[] }

// «Ordenar por» del tablero (como en HubSpot). Se guarda en la vista junto con el orden de la tabla.
export const BOARD_SORTS: Array<[string, string]> = [
  ['hs_lastmodifieddate', 'Última modificación'], ['closedate', 'Fecha de cierre'], ['amount', 'Monto'],
  ['createdate', 'Fecha de creación'], ['notes_last_updated', 'Última actividad'], ['hs_v2_date_entered_current_stage', 'Entrada a la etapa'],
];

// Columnas achicadas de cada tablero, recordadas en este navegador.
export function useCollapsed(key: string) {
  const load = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set<string>(); } };
  const [set, setSet] = useState<Set<string>>(load);
  useEffect(() => { setSet(load()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  const toggle = (id: string) => setSet((cur) => {
    const next = new Set(cur);
    next.has(id) ? next.delete(id) : next.add(id);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* ignorar */ }
    return next;
  });
  return [set, toggle] as const;
}

// El tablero ocupa el alto que queda en la pantalla (aunque la barra de filtros ocupe dos renglones), así el pie de
// cada columna siempre se ve y cada columna se desplaza por dentro.
export function useFillHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number>();
  useLayoutEffect(() => {
    const calc = () => { const el = ref.current; if (el) setH(Math.max(360, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 12))); };
    calc();
    window.addEventListener('resize', calc);
    const ro = new ResizeObserver(calc);
    const prev = ref.current?.previousElementSibling;
    if (prev) ro.observe(prev);
    return () => { window.removeEventListener('resize', calc); ro.disconnect(); };
  }, []);
  return [ref, h ? { height: h } : undefined] as const;
}

export function SortPick({ type, sort, dir, onSort }: { type: 'deal' | 'contact' | 'company' | 'order'; sort?: string; dir?: 'asc' | 'desc'; onSort: (sort: string, dir: 'asc' | 'desc') => void }) {
  const { meta } = useMeta();
  const opts = type === 'deal' ? BOARD_SORTS : BOARD_SORTS.filter(([k]) => ['hs_lastmodifieddate', 'createdate', 'notes_last_updated'].includes(k));
  const cur = sort ?? 'hs_lastmodifieddate';
  const all = opts.some(([k]) => k === cur) ? opts : [...opts, [cur, propOf(meta, type, cur)?.label ?? cur] as [string, string]];
  return (
    <div className="row" style={{ gap: 4 }}>
      <Select className="input sm" style={{ width: 220 }} value={cur} aria-label="Ordenar por" onChange={(e) => onSort(e.target.value, dir ?? 'desc')}>
        {all.map(([k, l]) => <option key={k} value={k}>Ordenar: {l}</option>)}
      </Select>
      <button className="btn sm icon" style={{ width: 32 }} title={dir === 'asc' ? 'De menor a mayor' : 'De mayor a menor'} aria-label="Cambiar el sentido del orden"
        onClick={() => onSort(cur, dir === 'asc' ? 'desc' : 'asc')}>{dir === 'asc' ? '↑' : '↓'}</button>
    </div>
  );
}

// Tablero de negocios por pipeline: arrastrar una tarjeta a otra columna cambia la etapa.
export default function Board({ pipelineId, q, groups, sort, dir, onSort, tools, search, onSearch, openId, onOpen, reloadKey, selected, onSelect, onTotal, onCreate }: {
  pipelineId: string; q: string; groups?: Filter[][]; sort?: string; dir?: 'asc' | 'desc'; onSort: (sort: string, dir: 'asc' | 'desc') => void;
  tools?: ReactNode; search: string; onSearch: (s: string) => void;
  openId?: number | null; onOpen?: (id: number, compose?: Activity['type']) => void; reloadKey?: number;
  selected?: Set<number>; onSelect?: (id: number) => void; onTotal?: (n: number) => void; onCreate?: (defaults: Record<string, unknown>) => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [closedDays, setClosedDays] = useState(90);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ deal: CrmRecord; stage: Stage; missing: string[] } | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [collapsed, toggleCol] = useCollapsed(`crm.board.collapsed.${pipelineId}`);
  const [boardRef, boardStyle] = useFillHeight();
  const params = { pipeline: pipelineId, q, closed_days: closedDays, groups: groups?.length ? groups : undefined, sort, dir };
  const board = useAsync(() => http<{ pipeline: Pipeline; columns: Column[] }>('GET', `/board${qs(params)}`),
    [pipelineId, q, closedDays, JSON.stringify(groups ?? []), sort, dir, reloadKey]);
  const [cols, setCols] = useState<Column[]>([]);
  const pipe = meta.pipelines.find((p) => p.id === pipelineId);
  const cardProps = pipe?.config.card_props?.length ? pipe.config.card_props : ['amount', 'closedate'];
  useEffect(() => { if (board.data) setCols(board.data.columns); }, [board.data]);
  const sum = cols.reduce((a, c) => ({ n: a.n + c.total, amount: a.amount + c.amount, weighted: a.weighted + c.weighted }), { n: 0, amount: 0, weighted: 0 });
  useEffect(() => { if (board.data) onTotal?.(sum.n); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sum.n, board.data]);

  const move = async (dealId: number, stage: Stage, extra: Record<string, unknown> = {}) => {
    const from = cols.find((c) => c.deals.some((d) => d.id === dealId));
    const deal = from?.deals.find((d) => d.id === dealId);
    if (!from || !deal || from.stage.id === stage.id) return;
    // Lo que la etapa pide para entrar (por ejemplo, el motivo al perder), como las propiedades condicionales de HubSpot.
    const missing = missingFor(stage, { ...deal.props, ...extra });
    if (missing.length) { setAsk({ deal, stage, missing }); return; }
    const amt = Number(deal.props.amount || 0);
    setCols((cs) => cs.map((c) => c.stage.id === from.stage.id
      ? { ...c, deals: c.deals.filter((d) => d.id !== dealId), total: c.total - 1, amount: c.amount - amt, weighted: c.weighted - amt * c.stage.probability }
      : c.stage.id === stage.id ? {
        ...c, deals: [{ ...deal, props: { ...deal.props, dealstage: stage.id, hs_v2_date_entered_current_stage: new Date().toISOString() } }, ...c.deals],
        total: c.total + 1, amount: c.amount + amt, weighted: c.weighted + amt * c.stage.probability,
      } : c));
    try {
      await http('PATCH', `/records/deal/${dealId}`, { props: { dealstage: stage.id, ...extra } });
      toast(`«${deal.name}» pasó a ${stage.label}`);
    } catch (e) {
      const missing = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      if (missing?.length) setAsk({ deal, stage, missing }); else toast((e as Error).message, true);
      board.reload();
    }
  };

  // «Cargar más»: las siguientes tarjetas de esa columna, con el mismo filtro y orden.
  const loadMore = async (c: Column) => {
    setLoadingMore(c.stage.id);
    try {
      const r = await http<{ deals: Card[] }>('GET', `/board${qs({ ...params, stage: c.stage.id, offset: c.deals.length })}`);
      setCols((cs) => cs.map((x) => (x.stage.id === c.stage.id ? { ...x, deals: [...x.deals, ...r.deals.filter((d) => !x.deals.some((y) => y.id === d.id))] } : x)));
    } catch (e) { toast((e as Error).message, true); } finally { setLoadingMore(null); }
  };

  const drop = (c: Column) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(c.stage.id); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.stage.id ? null : o)); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); if (dragId) move(dragId, c.stage); setDragId(null); },
  });

  return (
    <>
      <div className="toolbar">
        <div className="search" style={{ width: 220 }}><Icon name="search" /><input className="input sm" placeholder="Buscar negocios…" value={search} onChange={(e) => onSearch(e.target.value)} /></div>
        <Select className="input sm" style={{ width: 170 }} value={closedDays} onChange={(e) => setClosedDays(Number(e.target.value))} aria-label="Cerrados" title="Negocios cerrados que se muestran">
          <option value={30}>Cerrados: 30 días</option>
          <option value={90}>Cerrados: 90 días</option>
          <option value={365}>Cerrados: 1 año</option>
        </Select>
        <SortPick type="deal" sort={sort} dir={dir} onSort={onSort} />
        {tools}
        {board.loading && <span className="muted small">Actualizando…</span>}
        <span className="board-sum">
          <b className="num">{sum.n.toLocaleString('es-AR')}</b> {sum.n === 1 ? 'negocio' : 'negocios'}
          <span className="sep">·</span>Total <b className="num">{fmtMoney(sum.amount) || '$ 0'}</b>
          <span className="sep">·</span>Ponderado <b className="num">{fmtMoney(sum.weighted) || '$ 0'}</b>
        </span>
      </div>
      <div className={`board${boardStyle ? ' fill' : ''}`} ref={boardRef} style={boardStyle}>
        {cols.map((c) => (collapsed.has(c.stage.id) ? (
          <div key={c.stage.id} className={`col collapsed${over === c.stage.id ? ' over' : ''}`} {...drop(c)} onClick={() => toggleCol(c.stage.id)}
            title={`${c.stage.label}: ${c.total} · ${fmtMoney(c.amount) || '$ 0'}. Clic para mostrar.`} role="button" aria-label={`Mostrar la columna ${c.stage.label}`}>
            <Icon name="chevron" size={14} />
            <span className="n num">{c.total}</span>
            <span className="vlabel">{c.stage.label}</span>
          </div>
        ) : (
          <div key={c.stage.id} className={`col${over === c.stage.id ? ' over' : ''}`} {...drop(c)}>
            <div className="col-head">
              <div className="t">
                <span className="ellipsis">{c.stage.label}</span><span className="n num">{c.total}</span>
                {onCreate && <button className="col-fold" title={`Crear un negocio en «${c.stage.label}»`} aria-label={`Crear un negocio en ${c.stage.label}`} onClick={() => onCreate({ pipeline: pipelineId, dealstage: c.stage.id })}><Icon name="plus" size={14} /></button>}
                <button className="col-fold" title="Achicar la columna" aria-label={`Achicar la columna ${c.stage.label}`} onClick={() => toggleCol(c.stage.id)}><Icon name="chevron" size={14} /></button>
              </div>
              <div className="prob" title={`Probabilidad ${Math.round(c.stage.probability * 100)}%`}><i style={{ width: `${c.stage.probability * 100}%` }} /></div>
            </div>
            <div className="col-body">
              {c.deals.map((d) => <DealCard key={d.id} d={d} cardProps={cardProps} on={openId === d.id} dragging={dragId === d.id} onOpen={onOpen}
                sel={!!selected?.has(d.id)} selecting={!!selected?.size} onSelect={onSelect}
                onDragStart={() => setDragId(d.id)} onDragEnd={() => setDragId(null)} />)}
              {c.total > c.deals.length && (
                <button className="btn sm ghost more" disabled={loadingMore === c.stage.id} onClick={() => loadMore(c)}>
                  {loadingMore === c.stage.id ? 'Cargando…' : `Cargar más (quedan ${(c.total - c.deals.length).toLocaleString('es-AR')})`}
                </button>
              )}
            </div>
            <div className="col-foot">
              <div><b className="num">{fmtMoney(c.amount) || '$ 0'}</b> <span className="muted">total</span></div>
              <div><span className="num">{fmtMoney(c.weighted) || '$ 0'}</span> <span className="muted">ponderado ({Math.round(c.stage.probability * 100)}%)</span></div>
            </div>
          </div>
        )))}
      </div>
      {ask && <StageProps deal={ask.deal} stage={ask.stage} missing={ask.missing} onClose={() => setAsk(null)} onSave={(extra) => { const a = ask; setAsk(null); move(a.deal.id, a.stage, extra); }} />}
    </>
  );
}

// Tarjeta de negocio, como en HubSpot: datos del pipeline, con quién es, la próxima actividad, propietario,
// días en la etapa y atajos (Darwin, nota, tarea).
function DealCard({ d, cardProps, on, dragging, onOpen, onDragStart, onDragEnd, sel, selecting, onSelect }: {
  d: Card; cardProps: string[]; on: boolean; dragging: boolean; onOpen?: (id: number, compose?: Activity['type']) => void; onDragStart: () => void; onDragEnd: () => void;
  sel: boolean; selecting: boolean; onSelect?: (id: number) => void;
}) {
  const { meta } = useMeta();
  const day = 86_400_000;
  const stale = d.props.notes_last_updated && Date.now() - Date.parse(d.props.notes_last_updated) > 14 * day;
  const entered = d.props.hs_v2_date_entered_current_stage ? Date.parse(d.props.hs_v2_date_entered_current_stage) : NaN;
  const days = Number.isNaN(entered) ? null : Math.max(0, Math.floor((Date.now() - entered) / day));
  const next = d.card?.next;
  const late = next && Date.parse(next.at) < Date.now();
  const darwin = safeUrl(d.props.link_a_darwin);
  const owner = userName(meta, d.props.owner_id);
  const with_ = [d.card?.contact?.name, d.card?.company?.name].filter(Boolean).join(' · ');
  const act = (e: React.MouseEvent, t: Activity['type']) => { e.stopPropagation(); onOpen?.(d.id, t); };
  return (
    <div className={`card${dragging ? ' dragging' : ''}${on ? ' on' : ''}${sel ? ' sel' : ''}`} draggable
      onClick={(e) => (onSelect && (e.metaKey || e.ctrlKey || e.shiftKey || selecting) ? onSelect(d.id) : onOpen?.(d.id))}
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={onDragEnd}>
      {onSelect && <input type="checkbox" className="card-check" checked={sel} aria-label={`Seleccionar ${d.name}`} onClick={(e) => e.stopPropagation()} onChange={() => onSelect(d.id)} />}
      <Link className="t" to={recordUrl('deal', d.id)} draggable={false} onClick={(e) => { if (onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault(); }}>{d.name}</Link>
      <TagChips meta={meta} ids={d.tags} small />
      {cardProps.map((k) => {
        if (k === 'link_a_darwin') return null;
        const v = k === 'amount' ? fmtMoney(d.props.amount, d.props.deal_currency_code) || 'Sin monto' : formatValue(meta, 'deal', k, d.props[k], d.props);
        if (!v) return null;
        return <div key={k} className="meta"><span className={k === 'amount' ? 'amount num' : 'ellipsis'} title={propOf(meta, 'deal', k)?.label}>{k === 'closedate' ? `Cierre ${v}` : v}</span></div>;
      })}
      {with_ && <div className="meta" title="Contacto y empresa"><Icon name="contact" size={13} /><span className="ellipsis">{with_}</span></div>}
      <div className={`next${next ? '' : ' none'}${late ? ' late' : ''}`} title={next ? `Próxima ${ACTIVITY_LABEL[next.type as Activity['type']]?.toLowerCase() ?? 'actividad'}` : undefined}>
        {next ? <><Icon name={next.type === 'meeting' ? 'meeting' : 'task'} size={13} /><span className="ellipsis grow">{next.subject || ACTIVITY_LABEL[next.type as Activity['type']]}</span><span className="num">{fmtDate(next.at)}</span></>
          : 'Sin próximas actividades'}
      </div>
      <div className="meta">
        <Avatar name={owner || '—'} />
        <span className="ellipsis grow" title="Propietario">{owner || 'Sin propietario'}</span>
        {days != null && <span className="days" title="Días en esta etapa">{days} d</span>}
      </div>
      <div className="card-actions">
        <button className="btn ghost sm icon" title="Registrar una nota" aria-label={`Nota en ${d.name}`} onClick={(e) => act(e, 'note')}><Icon name="note" size={14} /></button>
        <button className="btn ghost sm icon" title="Escribir un mail" aria-label={`Mail en ${d.name}`} onClick={(e) => act(e, 'email')}><Icon name="email" size={14} /></button>
        <button className="btn ghost sm icon" title="Crear una tarea" aria-label={`Tarea en ${d.name}`} onClick={(e) => act(e, 'task')}><Icon name="task" size={14} /></button>
        {darwin && <a className="btn ghost sm" href={darwin} target="_blank" rel="noreferrer" title="Abrir el chat en Darwin" onClick={(e) => e.stopPropagation()}>Darwin</a>}
        <span className={`grow small${stale ? ' stale' : ' muted'}`} style={{ textAlign: 'right' }} title={stale ? 'Inactivo hace más de 14 días' : 'Última actividad'}>
          {stale && <Icon name="timer" size={12} />} {d.props.notes_last_updated ? fmtRelative(d.props.notes_last_updated) : 'Sin actividad'}
        </span>
      </div>
    </div>
  );
}

// Antes de mover un negocio a una etapa que pide datos (motivo de pérdida, monto…), se piden en un cuadro.
export function StageProps({ deal, stage, missing, onClose, onSave }: { deal: CrmRecord; stage: Stage; missing: string[]; onClose: () => void; onSave: (extra: Record<string, unknown>) => void }) {
  const { meta } = useMeta();
  const props = missing.map((m) => propOf(meta, 'deal', m)).filter(Boolean) as Property[];
  const lost = stage.is_closed && !stage.is_won;
  const detail = propOf(meta, 'deal', 'closed_lost_reason');
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const ready = props.every((p) => vals[p.name] != null && vals[p.name] !== '');
  return (
    <Modal title={`${stage.label}: ${deal.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!ready} onClick={() => onSave(vals)}>Guardar</button>
    </>}>
      <p className="muted small" style={{ margin: 0 }}>Para pasar a «{stage.label}» hay que completar:</p>
      {props.map((p, i) => (
        <label key={p.name} className="field">{p.label} *<PropertyInput prop={p} type="deal" value={vals[p.name]} onChange={(v) => setVals((x) => ({ ...x, [p.name]: v }))} autoFocus={i === 0} /></label>
      ))}
      {lost && detail && !missing.includes('closed_lost_reason') && (
        <label className="field">{detail.label}<PropertyInput prop={detail} type="deal" value={vals.closed_lost_reason} onChange={(v) => setVals((x) => ({ ...x, closed_lost_reason: v }))} /></label>
      )}
    </Modal>
  );
}
