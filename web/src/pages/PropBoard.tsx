import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, fmtRelative, recordUrl, userName, propsOf, Icon, type CrmRecord, type ObjectType } from '../lib';
import { Avatar } from '../components';

interface Column { value: string; label: string; total: number; records: CrmRecord[] }

// Tablero de empresas o contactos agrupado por una propiedad (por defecto, la etapa del ciclo de vida).
// Arrastrar una tarjeta a otra columna cambia esa propiedad, como en el tablero de negocios.
export default function PropBoard({ type, q, owner, onOwner, search, onSearch }: {
  type: ObjectType; q: string; owner?: string; onOwner: (o?: string) => void; search: string; onSearch: (s: string) => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const key = `crm.board.prop.${type}`;
  const groupable = propsOf(meta, type).filter((p) => ['enum', 'bool', 'owner'].includes(p.type) && !p.read_only);
  const [prop, setProp] = useState(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(key); } catch { /* sin preferencia guardada */ }
    return saved && groupable.some((p) => p.name === saved) ? saved : 'lifecyclestage';
  });
  useEffect(() => { try { localStorage.setItem(key, prop); } catch { /* ignorar */ } }, [key, prop]);
  const board = useAsync(() => http<{ columns: Column[] }>('GET', `/board-prop/${type}${qs({ prop, q, owner })}`), [type, prop, q, owner]);
  const [cols, setCols] = useState<Column[]>([]);
  useEffect(() => { if (board.data) setCols(board.data.columns); }, [board.data]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const def = groupable.find((p) => p.name === prop);

  const move = async (id: number, to: Column) => {
    const from = cols.find((c) => c.records.some((r) => r.id === id));
    const rec = from?.records.find((r) => r.id === id);
    if (!from || !rec || from.value === to.value) return;
    setCols((cs) => cs.map((c) => (c.value === from.value ? { ...c, records: c.records.filter((r) => r.id !== id), total: c.total - 1 }
      : c.value === to.value ? { ...c, records: [{ ...rec, props: { ...rec.props, [prop]: to.value } }, ...c.records], total: c.total + 1 } : c)));
    try {
      const value = to.value === '' ? null : def?.type === 'owner' ? Number(to.value) : to.value;
      await http('PATCH', `/records/${type}/${id}`, { props: { [prop]: value } });
      toast(`«${rec.name}» pasó a ${to.label}`);
    } catch (e) {
      toast((e as Error).message, true);
      board.reload();
    }
  };

  const subtitle = (r: CrmRecord) => (type === 'company'
    ? [r.props.domain, r.props.city].filter(Boolean).join(' · ')
    : [r.props.jobtitle, r.props.company || r.props.email].filter(Boolean).join(' · '));

  return (
    <>
      <div className="toolbar">
        <label className="row small" style={{ fontWeight: 600 }}>Agrupar por
          <select className="input" style={{ width: 260 }} value={prop} onChange={(e) => setProp(e.target.value)} aria-label="Agrupar por">
            {groupable.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
        </label>
        <div className="search" style={{ width: 240 }}><Icon name="search" /><input className="input" placeholder="Buscar…" value={search} onChange={(e) => onSearch(e.target.value)} /></div>
        {prop !== 'owner_id' && (
          <select className="input" style={{ width: 215 }} value={owner ?? ''} onChange={(e) => onOwner(e.target.value || undefined)} aria-label="Propietario">
            <option value="">Todos los propietarios</option>
            <option value="me">Míos</option>
            <option value="none">Sin asignar</option>
            {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        {board.loading && <span className="muted small">Actualizando…</span>}
      </div>
      <div className="board">
        {cols.map((c) => (
          <div key={c.value || 'vacio'} className={`col${over === c.value ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(c.value); }}
            onDragLeave={() => setOver((o) => (o === c.value ? null : o))}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) move(dragId, c); setDragId(null); }}>
            <div className="col-head">
              <div className="t"><span className="ellipsis">{c.label}</span><span className="n num">{c.total}</span></div>
            </div>
            <div className="col-body">
              {c.records.map((r) => {
                const stale = r.props.notes_last_updated && Date.now() - Date.parse(r.props.notes_last_updated) > 30 * 86_400_000;
                return (
                  <div key={r.id} className={`card${dragId === r.id ? ' dragging' : ''}`} draggable
                    onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragId(null)}>
                    <Link className="t" to={recordUrl(type, r.id)} draggable={false}>{r.name}</Link>
                    {subtitle(r) && <div className="meta"><span className="ellipsis">{subtitle(r)}</span></div>}
                    <div className="meta">
                      <Avatar name={userName(meta, r.props.owner_id)} />
                      <span className={`grow ellipsis${stale ? ' stale' : ''}`} title="Última actividad">
                        {r.props.notes_last_updated ? `Actividad ${fmtRelative(r.props.notes_last_updated)}` : 'Sin actividad'}
                      </span>
                    </div>
                  </div>
                );
              })}
              {c.total > c.records.length && <div className="muted small" style={{ textAlign: 'center' }}>y {c.total - c.records.length} más (usá la tabla o filtrá)</div>}
              {!c.total && <div className="muted small" style={{ textAlign: 'center', padding: '8px 0' }}>Vacío</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
