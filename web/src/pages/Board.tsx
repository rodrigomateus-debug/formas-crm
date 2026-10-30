import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, fmtMoney, fmtDate, fmtRelative, recordUrl, userName, Icon, type CrmRecord, type Stage, type Pipeline, missingFor, formatValue, propOf, type Property } from '../lib';
import { Avatar, Modal, PropertyInput } from '../components';

interface Column { stage: Stage; total: number; amount: number; deals: CrmRecord[] }


// Tablero de negocios por pipeline: arrastrar una tarjeta a otra columna cambia la etapa.
export default function Board({ pipelineId, q, owner, onOwner, search, onSearch }: { pipelineId: string; q: string; owner?: string; onOwner: (o?: string) => void; search: string; onSearch: (s: string) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [closedDays, setClosedDays] = useState(90);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ deal: CrmRecord; stage: Stage; missing: string[] } | null>(null);
  const board = useAsync(() => http<{ pipeline: Pipeline; columns: Column[] }>('GET', `/board${qs({ pipeline: pipelineId, owner, q, closed_days: closedDays })}`), [pipelineId, owner, q, closedDays]);
  const [cols, setCols] = useState<Column[]>([]);
  const pipe = meta.pipelines.find((p) => p.id === pipelineId);
  const cardProps = pipe?.config.card_props?.length ? pipe.config.card_props : ['amount', 'closedate'];
  useEffect(() => { if (board.data) setCols(board.data.columns); }, [board.data]);

  const move = async (dealId: number, stage: Stage, extra: Record<string, unknown> = {}) => {
    const from = cols.find((c) => c.deals.some((d) => d.id === dealId));
    const deal = from?.deals.find((d) => d.id === dealId);
    if (!from || !deal || from.stage.id === stage.id) return;
    // Lo que la etapa pide para entrar (por ejemplo, el motivo al perder), como las propiedades condicionales de HubSpot.
    const missing = missingFor(stage, { ...deal.props, ...extra });
    if (missing.length) { setAsk({ deal, stage, missing }); return; }
    setCols((cs) => cs.map((c) => c.stage.id === from.stage.id
      ? { ...c, deals: c.deals.filter((d) => d.id !== dealId), total: c.total - 1, amount: c.amount - Number(deal.props.amount || 0) }
      : c.stage.id === stage.id ? { ...c, deals: [{ ...deal, props: { ...deal.props, dealstage: stage.id } }, ...c.deals], total: c.total + 1, amount: c.amount + Number(deal.props.amount || 0) } : c));
    try {
      await http('PATCH', `/records/deal/${dealId}`, { props: { dealstage: stage.id, ...extra } });
      toast(`«${deal.name}» pasó a ${stage.label}`);
    } catch (e) {
      const missing = (e as Error & { data?: { missing?: string[] } }).data?.missing;
      if (missing?.length) setAsk({ deal, stage, missing }); else toast((e as Error).message, true);
      board.reload();
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="search" style={{ width: 240 }}><Icon name="search" /><input className="input" placeholder="Buscar negocios…" value={search} onChange={(e) => onSearch(e.target.value)} /></div>
        <select className="input" style={{ width: 190 }} value={owner ?? ''} onChange={(e) => onOwner(e.target.value || undefined)} aria-label="Propietario">
          <option value="">Todos los propietarios</option>
          <option value="me">Mis negocios</option>
          {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="input" style={{ width: 200 }} value={closedDays} onChange={(e) => setClosedDays(Number(e.target.value))} aria-label="Cerrados">
          <option value={30}>Cerrados: últimos 30 días</option>
          <option value={90}>Cerrados: últimos 90 días</option>
          <option value={365}>Cerrados: último año</option>
        </select>
        {board.loading && <span className="muted small">Actualizando…</span>}
      </div>
      <div className="board">
        {cols.map((c) => (
          <div key={c.stage.id} className={`col${over === c.stage.id ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(c.stage.id); }}
            onDragLeave={() => setOver((o) => (o === c.stage.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) move(dragId, c.stage); setDragId(null); }}>
            <div className="col-head">
              <div className="t"><span className="ellipsis">{c.stage.label}</span><span className="n num">{c.total}</span></div>
              <div className="amt num">{fmtMoney(c.amount)}</div>
              <div className="prob" title={`Probabilidad ${Math.round(c.stage.probability * 100)}%`}><i style={{ width: `${c.stage.probability * 100}%` }} /></div>
            </div>
            <div className="col-body">
              {c.deals.map((d) => {
                const stale = d.props.notes_last_updated && Date.now() - Date.parse(d.props.notes_last_updated) > 14 * 86_400_000;
                return (
                  <div key={d.id} className={`card${dragId === d.id ? ' dragging' : ''}`} draggable
                    onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragId(null)}>
                    <Link className="t" to={recordUrl('deal', d.id)} draggable={false}>{d.name}</Link>
                    {cardProps.map((k) => {
                      const v = k === 'amount' ? fmtMoney(d.props.amount, d.props.deal_currency_code) || 'Sin monto' : formatValue(meta, 'deal', k, d.props[k], d.props);
                      if (!v) return null;
                      return <div key={k} className="meta"><span className={k === 'amount' ? 'amount num' : 'ellipsis'} title={propOf(meta, 'deal', k)?.label}>{k === 'closedate' ? `Cierre ${v}` : v}</span></div>;
                    })}
                    <div className="meta">
                      <Avatar name={userName(meta, d.props.owner_id)} />
                      <span className={`grow ellipsis${stale ? ' stale' : ''}`} title="Última actividad">
                        {d.props.notes_last_updated ? `Actividad ${fmtRelative(d.props.notes_last_updated)}` : 'Sin actividad'}
                      </span>
                    </div>
                  </div>
                );
              })}
              {c.total > c.deals.length && <div className="muted small" style={{ textAlign: 'center' }}>y {c.total - c.deals.length} más (usá la tabla o filtrá)</div>}
            </div>
          </div>
        ))}
      </div>
      {ask && <StageProps deal={ask.deal} stage={ask.stage} missing={ask.missing} onClose={() => setAsk(null)} onSave={(extra) => { const a = ask; setAsk(null); move(a.deal.id, a.stage, extra); }} />}
    </>
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
