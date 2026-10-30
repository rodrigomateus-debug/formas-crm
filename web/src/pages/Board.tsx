import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, fmtMoney, fmtDate, fmtRelative, recordUrl, userName, Icon, type CrmRecord, type Stage, type Pipeline } from '../lib';
import { Avatar, Modal, PropertyInput } from '../components';

interface Column { stage: Stage; total: number; amount: number; deals: CrmRecord[] }

const PIPE_KEY = 'crm.board.pipeline';

// Tablero de negocios por pipeline: arrastrar una tarjeta a otra columna cambia la etapa.
export default function Board({ q, owner, onOwner, search, onSearch }: { q: string; owner?: string; onOwner: (o?: string) => void; search: string; onSearch: (s: string) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [pipelineId, setPipelineId] = useState(() => {
    try { return localStorage.getItem(PIPE_KEY) || meta.pipelines[0].id; } catch { return meta.pipelines[0].id; }
  });
  const [closedDays, setClosedDays] = useState(90);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lost, setLost] = useState<{ deal: CrmRecord; stage: Stage } | null>(null);
  useEffect(() => { try { localStorage.setItem(PIPE_KEY, pipelineId); } catch { /* ignorar */ } }, [pipelineId]);
  const board = useAsync(() => http<{ pipeline: Pipeline; columns: Column[] }>('GET', `/board${qs({ pipeline: pipelineId, owner, q, closed_days: closedDays })}`), [pipelineId, owner, q, closedDays]);
  const [cols, setCols] = useState<Column[]>([]);
  useEffect(() => { if (board.data) setCols(board.data.columns); }, [board.data]);

  const move = async (dealId: number, stage: Stage, extra: Record<string, unknown> = {}) => {
    const from = cols.find((c) => c.deals.some((d) => d.id === dealId));
    const deal = from?.deals.find((d) => d.id === dealId);
    if (!from || !deal || from.stage.id === stage.id) return;
    // Pérdida: se pide el motivo, igual que en HubSpot.
    if (stage.is_closed && !stage.is_won && !extra.motivo_de_cierre_perdido && pipelineId !== '765787061') { setLost({ deal, stage }); return; }
    setCols((cs) => cs.map((c) => c.stage.id === from.stage.id
      ? { ...c, deals: c.deals.filter((d) => d.id !== dealId), total: c.total - 1, amount: c.amount - Number(deal.props.amount || 0) }
      : c.stage.id === stage.id ? { ...c, deals: [{ ...deal, props: { ...deal.props, dealstage: stage.id } }, ...c.deals], total: c.total + 1, amount: c.amount + Number(deal.props.amount || 0) } : c));
    try {
      await http('PATCH', `/records/deal/${dealId}`, { props: { dealstage: stage.id, ...extra } });
      toast(`«${deal.name}» pasó a ${stage.label}`);
    } catch (e) {
      toast((e as Error).message, true);
      board.reload();
    }
  };

  return (
    <>
      <div className="toolbar">
        <select className="input" style={{ width: 260 }} value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline">
          {meta.pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
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
                    <div className="meta"><span className="amount num">{fmtMoney(d.props.amount, d.props.deal_currency_code) || 'Sin monto'}</span>
                      {d.props.closedate && <span>· cierre {fmtDate(d.props.closedate)}</span>}</div>
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
      {lost && <LostReason deal={lost.deal} onClose={() => setLost(null)} onSave={(extra) => { const l = lost; setLost(null); move(l.deal.id, l.stage, extra); }} />}
    </>
  );
}

export function LostReason({ deal, onClose, onSave }: { deal: CrmRecord; onClose: () => void; onSave: (extra: Record<string, unknown>) => void }) {
  const { meta } = useMeta();
  const prop = meta.properties.find((p) => p.object_type === 'deal' && p.name === 'motivo_de_cierre_perdido')!;
  const detail = meta.properties.find((p) => p.object_type === 'deal' && p.name === 'closed_lost_reason')!;
  const [motivo, setMotivo] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  return (
    <Modal title={`Cierre perdido: ${deal.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!motivo} onClick={() => onSave({ motivo_de_cierre_perdido: motivo, ...(texto ? { closed_lost_reason: texto } : {}) })}>Guardar</button>
    </>}>
      <label className="field">{prop.label} *<PropertyInput prop={prop} type="deal" value={motivo} onChange={setMotivo} autoFocus /></label>
      <label className="field">{detail.label}<PropertyInput prop={detail} type="deal" value={texto} onChange={setTexto} /></label>
    </Modal>
  );
}
