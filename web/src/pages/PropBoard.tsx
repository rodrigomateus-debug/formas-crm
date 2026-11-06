import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, olvidarMemoria, fmtMoney, fmtMoneyExact, fmtRelative, recordUrl, userName, propsOf, propOf, formatValue, Icon, unidadesDe, type Activity, type CrmRecord, type ObjectType, type Filter, type Meta } from '../lib';
import { Avatar, EtapaIcono, MultiPick, UnidadBadge, etapaPedidoSlug } from '../components';
import { SortPick, useCollapsed, useFillHeight, type CardActions } from './Board';
import { Select } from '../Select';

// amount: suma del monto de la columna (en pedidos, el total sin IVA); sin_monto: cuántas tarjetas no lo tienen.
interface Column { value: string; label: string; total: number; amount: number; sin_monto: number; records: CrmRecord[] }

// Fecha de entrega de un pedido contada desde hoy, como «7 días a partir de ahora» en HubSpot.
const daysTo = (v: string) => { const d = new Date(`${String(v).slice(0, 10)}T00:00:00`); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d.getTime() - t.getTime()) / 86_400_000); };
const ENTREGADO = '1237498998';
const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const shortDate = (v: string) => new Date(`${String(v).slice(0, 10)}T12:00:00`).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace('.', '');

// La línea del pedido en la tarjeta: «Evento» (los normales no llevan marca) y la entrega. Uno ya entregado dice cuándo se
// entregó; uno anulado, nada; el resto, cuánto falta para la fecha prometida (en rojo si ya pasó, en ámbar si es hoy o mañana).
function OrderLine({ r }: { r: CrmRecord }) {
  const { meta } = useMeta();
  const p = r.props;
  const evento = p.tipo_de_pedido === 'EVENTO';
  let when: { text: string; cls: string; title: string } | null = null;
  if (p.hs_pipeline_stage === ENTREGADO) {
    if (p.entregado_el) when = { text: `Entregado el ${shortDate(p.entregado_el)}`, cls: '', title: 'Fecha real de entrega' };
  } else if (p.hs_pipeline_stage !== ANULADO && p.fecha_de_entrega) {
    const n = daysTo(p.fecha_de_entrega);
    when = {
      text: n === 0 ? 'Entrega hoy' : n === 1 ? 'Entrega mañana' : n > 1 ? `Entrega en ${n} días` : `Vencida hace ${-n} ${n === -1 ? 'día' : 'días'}`,
      cls: n < 0 ? ' late' : n <= 1 ? ' soon' : '',
      title: `Entrega prometida: ${shortDate(p.fecha_de_entrega)}`,
    };
  }
  const unidad = unidadesDe(meta, 'order', p)[0];
  if (!evento && !when && !unidad) return null;
  return (
    <div className="meta order-line">
      {unidad && <UnidadBadge k={unidad} compact />}
      {evento && <span className="chip-evento">Evento</span>}
      {when && <span className={`when${when.cls}`} title={when.title}><Icon name="meeting" size={13} /><span className="ellipsis">{when.text}</span></span>}
    </div>
  );
}

// Miniaturas de los productos del pedido (solo si alguno tiene foto): hasta 3, una al lado de la otra, y «+X» si tiene más
// productos. Un clic abre la vista previa del pedido, con la lista de productos.
function Fotos({ r, onOpen }: { r: CrmRecord; onOpen: () => void }) {
  const { fotos, productos } = r as CrmRecord & { fotos?: string[]; productos?: number };
  const [rotas, setRotas] = useState<string[]>([]);
  const ok = (fotos ?? []).filter((u) => !rotas.includes(u));
  if (!ok.length) return null;
  const mas = Math.max(0, (productos ?? ok.length) - ok.length);
  return (
    <button type="button" className="card-fotos" title={`Ver ${productos === 1 ? 'el producto' : `los ${productos} productos`}`}
      aria-label={`Ver los productos de ${r.name}`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      {ok.map((u) => <span key={u} className="thumb"><img src={u} alt="" loading="lazy" draggable={false} onError={() => setRotas((x) => [...x, u])} /></span>)}
      {mas > 0 && <span className="thumb more">+{mas}</span>}
    </button>
  );
}

// Tarjeta del tablero (empresas, contactos o pedidos). No se vuelve a dibujar si no cambió: lo que hace al tocarla lo lee
// de `acciones`, que el tablero actualiza en cada vuelta.
const subtitleDe = (type: ObjectType, r: CrmRecord) => (type === 'company' ? [r.props.domain, r.props.city].filter(Boolean).join(' · ')
    // El PDV solo si el nombre no lo dice ya; mientras se produce, cómo vienen los artículos («2 en el impresor · 1 listo…»).
    : type === 'order' ? [r.props.hs_total_price != null && r.props.hs_total_price !== '' && fmtMoney(r.props.hs_total_price, r.props.hs_currency_code),
      r.props.pdv_finnegans && !r.name.includes(String(r.props.pdv_finnegans)) && `PDV ${r.props.pdv_finnegans}`,
      ![ENTREGADO, ANULADO].includes(r.props.hs_pipeline_stage) && r.props.detalle_produccion].filter(Boolean).join(' · ')
      : [r.props.jobtitle, r.props.company || r.props.email].filter(Boolean).join(' · '));;

const PropCard = memo(function PropCard({ r, type, cardProps, dragging, on, sel, selecting, canSelect, acciones }: {
  r: CrmRecord; type: ObjectType; cardProps?: string[]; dragging: boolean; on: boolean; sel: boolean; selecting: boolean; canSelect: boolean; acciones: { current: CardActions };
}) {
  const { meta } = useMeta();
  const onOpen = (id: number, t?: Activity['type']) => acciones.current.onOpen?.(id, t);
  const stale = r.props.notes_last_updated && Date.now() - Date.parse(r.props.notes_last_updated) > 30 * 86_400_000;
  const act = (e: React.MouseEvent, t: Activity['type']) => { e.stopPropagation(); onOpen(r.id, t); };
  const subtitle = subtitleDe(type, r);
  return (
    <div className={`card${dragging ? ' dragging' : ''}${on ? ' on' : ''}${sel ? ' sel' : ''}`} draggable
      onClick={(e) => (canSelect && (e.metaKey || e.ctrlKey || e.shiftKey || selecting) ? acciones.current.onSelect?.(r.id) : onOpen(r.id))}
      onDragStart={(e) => { acciones.current.setDragId?.(r.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => acciones.current.setDragId?.(null)}>
      {canSelect && <input type="checkbox" className="card-check" checked={sel} aria-label={`Seleccionar ${r.name}`} onClick={(e) => e.stopPropagation()} onChange={() => acciones.current.onSelect?.(r.id)} />}
      <Link className="t" to={recordUrl(type, r.id)} draggable={false} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault(); }}>{r.name}</Link>
      {cardProps?.length
        ? cardProps.map((k) => { const v = formatValue(meta, type, k, r.props[k], r.props); return v ? <div key={k} className="meta" title={propOf(meta, type, k)?.label}><span className="ellipsis">{v}</span></div> : null; })
        : subtitle && <div className="meta"><span className="ellipsis">{subtitle}</span></div>}
      {type === 'order' && !cardProps?.length && <OrderLine r={r} />}
      {type === 'order' && <Fotos r={r} onOpen={() => onOpen(r.id)} />}
      <div className="meta">
        <Avatar name={userName(meta, r.props.owner_id) || '—'} />
        <span className="ellipsis grow" title="Propietario">{userName(meta, r.props.owner_id) || 'Sin propietario'}</span>
      </div>
      <div className="card-actions">
        <button className="btn ghost sm icon" title="Registrar una nota" aria-label={`Nota en ${r.name}`} onClick={(e) => act(e, 'note')}><Icon name="note" size={14} /></button>
        <button className="btn ghost sm icon" title="Crear una tarea" aria-label={`Tarea en ${r.name}`} onClick={(e) => act(e, 'task')}><Icon name="task" size={14} /></button>
        <span className={`grow small${stale ? ' stale' : ' muted'}`} style={{ textAlign: 'right' }} title="Última actividad">
          {r.props.notes_last_updated ? fmtRelative(r.props.notes_last_updated) : 'Sin actividad'}
        </span>
      </div>
    </div>
  );
});

// La dirección del tablero por propiedad: la misma para pedirlo y para precargarlo desde las otras pestañas.
export function urlTableroProp(meta: Meta, type: ObjectType, propIn: string | undefined, q: string, groups: Filter[][] | undefined, sort?: string, dir?: string) {
  const groupable = propsOf(meta, type).filter((p) => ['enum', 'bool', 'owner'].includes(p.type) && !p.read_only);
  const prop = propIn && groupable.some((p) => p.name === propIn) ? propIn
    : groupable.some((p) => p.name === DEFAULT_BOARD_PROP[type]) ? DEFAULT_BOARD_PROP[type] : groupable[0]?.name ?? 'owner_id';
  return { prop, groupable, url: `/board-prop/${type}${qs({ prop, q, groups: groups?.length ? groups : undefined, sort, dir })}` };
}

// Por qué propiedad se agrupa cada tablero si la vista no dice otra cosa: los pedidos por su etapa, el resto por ciclo de vida.
export const DEFAULT_BOARD_PROP: Record<ObjectType, string> = { contact: 'lifecyclestage', company: 'lifecyclestage', deal: 'dealstage', order: 'hs_pipeline_stage' };

// Tablero de empresas, contactos o pedidos agrupado por una propiedad (etapa del ciclo de vida, etapa del pedido…).
// Arrastrar una tarjeta a otra columna cambia esa propiedad, como en el tablero de negocios.
export default function PropBoard({ type, prop: propIn, onProp, cardProps, onCardProps, q, groups, sort, dir, onSort, tools, search, onSearch, openId, onOpen, reloadKey, selected, onSelect, onTotal, onCreate }: {
  type: ObjectType; prop?: string; onProp: (p: string) => void; cardProps?: string[]; onCardProps: (p: string[]) => void; q: string; groups?: Filter[][];
  sort?: string; dir?: 'asc' | 'desc'; onSort: (sort: string, dir: 'asc' | 'desc') => void;
  tools?: ReactNode; search: string; onSearch: (s: string) => void;
  openId?: number | null; onOpen?: (id: number, compose?: Activity['type']) => void; reloadKey?: number;
  selected?: Set<number>; onSelect?: (id: number) => void; onTotal?: (n: number) => void; onCreate?: (defaults: Record<string, unknown>) => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const { prop, groupable, url } = urlTableroProp(meta, type, propIn, q, groups, sort, dir);
  const params = { prop, q, groups: groups?.length ? groups : undefined, sort, dir };
  const board = useAsync(() => http<{ columns: Column[]; activos: number | null; activos_monto: number | null }>('GET', url), [type, prop, q, JSON.stringify(groups ?? []), sort, dir, reloadKey], url);
  const [cols, setCols] = useState<Column[]>([]);
  const [activos, setActivos] = useState<number | null>(null);
  const [montoActivos, setMontoActivos] = useState<number | null>(null);
  useEffect(() => { if (board.data) { setCols(board.data.columns); setActivos(board.data.activos ?? null); setMontoActivos(board.data.activos_monto ?? null); } }, [board.data]);
  const [dragId, setDragId] = useState<number | null>(null);
  const acciones = useRef<CardActions>({});
  acciones.current = { onOpen, onSelect, setDragId };
  const [over, setOver] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [collapsed, toggleCol] = useCollapsed(`crm.board.collapsed.${type}.${prop}`);
  const [boardRef, boardStyle] = useFillHeight();
  const def = groupable.find((p) => p.name === prop);
  const total = cols.reduce((n, c) => n + c.total, 0);
  // Pedidos: el total sin IVA abajo de cada columna y arriba, el del tablero (como el monto en el tablero de negocios).
  const conMonto = type === 'order';
  // Pedidos agrupados por etapa: cada columna con el ícono y el color suave de su etapa.
  const etapa = (v: string) => (type === 'order' && prop === 'hs_pipeline_stage' ? etapaPedidoSlug(v) : undefined);
  const activo = (stage: string) => ![ENTREGADO, ANULADO].includes(stage);
  const montoDe = (r: CrmRecord) => { const v = r.props.hs_total_price; return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
  useEffect(() => { if (board.data) onTotal?.(total); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [total, board.data]);

  const move = async (id: number, to: Column) => {
    const from = cols.find((c) => c.records.some((r) => r.id === id));
    const rec = from?.records.find((r) => r.id === id);
    if (!from || !rec || from.value === to.value) return;
    const m = montoDe(rec);
    // Al mover entre etapas, un pedido puede dejar de estar activo (entregado, anulado) o volver a estarlo.
    if (type === 'order' && prop === 'hs_pipeline_stage') {
      const d = (activo(to.value) ? 1 : 0) - (activo(from.value) ? 1 : 0);
      setActivos((n) => (n == null ? n : n + d));
      setMontoActivos((n) => (n == null ? n : n + d * (m ?? 0)));
    }
    setCols((cs) => cs.map((c) => (c.value === from.value ? { ...c, records: c.records.filter((r) => r.id !== id), total: c.total - 1, amount: c.amount - (m ?? 0), sin_monto: c.sin_monto - (m == null ? 1 : 0) }
      : c.value === to.value ? { ...c, records: [{ ...rec, props: { ...rec.props, [prop]: to.value } }, ...c.records], total: c.total + 1, amount: c.amount + (m ?? 0), sin_monto: c.sin_monto + (m == null ? 1 : 0) } : c)));
    try {
      const value = to.value === '' ? null : def?.type === 'owner' ? Number(to.value) : to.value;
      await http('PATCH', `/records/${type}/${id}`, { props: { [prop]: value } });
      olvidarMemoria('/board-prop');
      toast(`«${rec.name}» pasó a ${to.label}`);
    } catch (e) {
      toast((e as Error).message, true);
      board.reload();
    }
  };

  const loadMore = async (c: Column) => {
    setLoadingMore(c.value);
    try {
      const r = await http<{ records: CrmRecord[] }>('GET', `/board-prop/${type}${qs({ ...params, value: c.value, offset: c.records.length })}`);
      setCols((cs) => cs.map((x) => (x.value === c.value ? { ...x, records: [...x.records, ...r.records.filter((d) => !x.records.some((y) => y.id === d.id))] } : x)));
    } catch (e) { toast((e as Error).message, true); } finally { setLoadingMore(null); }
  };

  const drop = (c: Column) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(c.value); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.value ? null : o)); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); if (dragId) move(dragId, c); setDragId(null); },
  });


  return (
    <>
      <div className="toolbar">
        <label className="row small" style={{ fontWeight: 600 }}>Agrupar por
          <Select className="input" style={{ width: 240 }} value={prop} onChange={(e) => onProp(e.target.value)} aria-label="Agrupar por">
            {groupable.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
          </Select>
        </label>
        <div className="search" style={{ width: 220 }}><Icon name="search" /><input className="input" placeholder="Buscar…" value={search} onChange={(e) => onSearch(e.target.value)} /></div>
        <SortPick type={type} sort={sort} dir={dir} onSort={onSort} />
        <div className="row small" title="Datos que muestra cada tarjeta (se guarda en la vista)">
          <span style={{ fontWeight: 600 }}>Tarjeta</span>
          <MultiPick small options={propsOf(meta, type).filter((p) => !['name', 'hs_order_name'].includes(p.name)).map((p) => ({ value: p.name, label: p.label }))}
            values={cardProps ?? []} onChange={(v) => onCardProps(v.slice(0, 5))} />
        </div>
        {tools}
        {board.loading && <span className="muted small">Actualizando…</span>}
        <span className="board-sum"><b className="num">{total.toLocaleString('es-AR')}</b> en el tablero
          {activos != null && <><span className="sep">·</span><b className="num" title="Ni entregados ni anulados">{activos.toLocaleString('es-AR')}</b> {activos === 1 ? 'activo' : 'activos'}</>}
          {/* Arriba, el total de los activos (lo que está en curso); el de cada etapa va abajo de su columna. */}
          {conMonto && montoActivos != null && <><span className="sep">·</span>Total activos sin IVA <b className="num" title={fmtMoneyExact(montoActivos, 'ARS')}>{fmtMoney(montoActivos, 'ARS') || '$ 0'}</b></>}</span>
      </div>
      <div className={`board${boardStyle ? ' fill' : ''}${board.fresh ? '' : ' cargando'}`} aria-busy={board.loading} ref={boardRef} style={boardStyle}>
        {cols.map((c) => (collapsed.has(c.value) ? (
          <div key={c.value || 'vacio'} className={`col collapsed${over === c.value ? ' over' : ''}${etapa(c.value) ? ` etapa-col e-${etapa(c.value)}` : ''}`} {...drop(c)} onClick={() => toggleCol(c.value)}
            title={`${c.label}: ${c.total}${conMonto ? ` · ${fmtMoneyExact(c.amount, 'ARS')} sin IVA` : ''}. Clic para mostrar.`} role="button" aria-label={`Mostrar la columna ${c.label}`}>
            <Icon name="chevron" size={14} />
            {etapa(c.value) && <EtapaIcono value={c.value} size={15} />}
            <span className="n num">{c.total}</span>
            <span className="vlabel">{c.label}</span>
          </div>
        ) : (
          <div key={c.value || 'vacio'} className={`col${over === c.value ? ' over' : ''}`} {...drop(c)}>
            <div className={`col-head${etapa(c.value) ? ` etapa-col e-${etapa(c.value)}` : ''}`}>
              <div className="t">
                {etapa(c.value) && <EtapaIcono value={c.value} size={15} />}
                <span className="ellipsis">{c.label}</span><span className="n num">{c.total}</span>
                {onCreate && c.value !== '' && def?.type !== 'owner' && <button className="col-fold" title={`Crear en «${c.label}»`} aria-label={`Crear en ${c.label}`} onClick={() => onCreate({ [prop]: c.value })}><Icon name="plus" size={14} /></button>}
                <button className="col-fold" title="Achicar la columna" aria-label={`Achicar la columna ${c.label}`} onClick={() => toggleCol(c.value)}><Icon name="chevron" size={14} /></button>
              </div>
            </div>
            <div className="col-body">
              {c.records.map((r) => <PropCard key={r.id} r={r} type={type} cardProps={cardProps} dragging={dragId === r.id} on={openId === r.id}
                sel={!!selected?.has(r.id)} selecting={!!selected?.size} canSelect={!!onSelect} acciones={acciones} />)}
              {c.total > c.records.length && (
                <button className="btn sm ghost more" disabled={loadingMore === c.value} onClick={() => loadMore(c)}>
                  {loadingMore === c.value ? 'Cargando…' : `Cargar más (quedan ${(c.total - c.records.length).toLocaleString('es-AR')})`}
                </button>
              )}
              {!c.total && <div className="muted small" style={{ textAlign: 'center', padding: '8px 0' }}>Vacío</div>}
            </div>
            {conMonto && (
              <div className="col-foot" title={`${fmtMoneyExact(c.amount, 'ARS')} sin IVA`}>
                <div><b className="num">{fmtMoney(c.amount, 'ARS') || '$ 0'}</b> <span className="muted">total sin IVA</span></div>
                {c.sin_monto > 0 && <div className="muted">{c.sin_monto.toLocaleString('es-AR')} {c.sin_monto === 1 ? 'pedido' : 'pedidos'} sin monto</div>}
              </div>
            )}
          </div>
        )))}
      </div>
    </>
  );
}
