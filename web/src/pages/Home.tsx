import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UnidadFilter } from './QuickFilters';
import { http, qs, useMeta, useAsync, fmtMoney, fmtDate, recordUrl, userName, stageOf, type Activity, type CrmRecord } from '../lib';

interface Dash {
  open: Array<{ pipeline_id: string; stage_id: string; n: number; amount: number }>;
  won: Array<{ owner_id: number; pipeline_id: string; n: number; amount: number }>;
  created: Array<{ pipeline_id: string; n: number }>;
  lost: Array<{ motivo: string | null; n: number }>;
  tasks: { overdue: number; today: number; open: number };
}

export default function Home() {
  const { meta } = useMeta();
  const [owner, setOwner] = useState(meta.me.role === 'admin' || meta.me.role === 'manager' ? 'all' : 'me');
  const [unidades, setUnidades] = useState<string[]>([]);
  const u = unidades.length ? unidades.join(',') : undefined;
  const dash = useAsync(() => http<Dash>('GET', `/dashboard${qs({ owner, unidades: u })}`), [owner, u]);
  const tasks = useAsync(() => http<{ results: Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 8, unidades: u })}`), [u]);
  const closed = meta.pipelines.flatMap((p) => p.stages.filter((s) => s.is_closed).map((s) => s.id));
  const stale = useAsync(() => http<{ results: CrmRecord[]; total: number }>('GET', `/records/deal${qs({
    filters: [
      ...(owner === 'all' ? [] : [{ prop: 'owner_id', op: 'eq', value: owner }]),
      ...(unidades.length ? [{ prop: '__unidad', op: 'in', values: unidades }] : []),
      { prop: 'dealstage', op: 'not_in', values: closed },
      { prop: 'notes_last_updated', op: 'before_days_ago', value: 14 },
    ],
    sort: 'amount', dir: 'desc', limit: 8,
  })}`), [owner, u]);
  const d = dash.data;
  const sum = (xs: Array<{ n: number; amount?: number }> = [], k: 'n' | 'amount' = 'n') => xs.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  const month = new Date().toLocaleDateString('es-AR', { month: 'long' });
  const openOnly = (d?.open ?? []).filter((x) => !stageOf(meta, x.stage_id)?.stage.is_closed);
  const byPipe = meta.pipelines.map((p) => ({ p, rows: openOnly.filter((x) => x.pipeline_id === p.id) })).filter((x) => x.rows.length);
  return (
    <div className="content">
      <div className="page-head">
        <h1>Hola, {meta.me.name.split(' ')[0]}</h1>
        <UnidadFilter value={unidades} onChange={setUnidades} />
        <select className="input" style={{ width: 220 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Ver datos de">
          <option value="me">Mis números</option>
          <option value="all">Todo el equipo</option>
          {meta.users.filter((u) => u.active && u.id !== meta.me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div className="kpis">
        <div className="panel kpi"><div className="label">Tareas vencidas</div><div className={`value${d?.tasks.overdue ? ' overdue' : ''}`}>{d?.tasks.overdue ?? '–'}</div><Link className="small" to="/tasks">Ver tareas</Link></div>
        <div className="panel kpi"><div className="label">Para hoy</div><div className="value">{d?.tasks.today ?? '–'}</div></div>
        <div className="panel kpi"><div className="label">Negocios abiertos</div><div className="value">{sum(openOnly)}</div><div className="small muted">{fmtMoney(sum(openOnly, 'amount'))}</div></div>
        <div className="panel kpi"><div className="label">Ganado en {month}</div><div className="value">{fmtMoney(sum(d?.won, 'amount'))}</div><div className="small muted">{sum(d?.won)} {sum(d?.won) === 1 ? 'negocio' : 'negocios'}</div></div>
        <div className="panel kpi"><div className="label">Negocios nuevos en {month}</div><div className="value">{sum(d?.created)}</div></div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Tareas para hoy y vencidas</h2><Link to="/tasks" className="small">Todas</Link></div>
          {tasks.data?.results.length ? tasks.data.results.map((t) => (
            <div key={t.id} className="assoc-item">
              <div className="grow"><div className="ellipsis">{t.subject}</div><div className="small muted">{t.links.map((l) => l.name).join(' · ')}</div></div>
              <span className={`small${t.due_at && Date.parse(t.due_at) < Date.now() ? ' overdue' : ' muted'}`}>{fmtDate(t.due_at, true)}</span>
            </div>
          )) : <div className="empty">Nada pendiente para hoy.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Negocios sin actividad hace 14 días</h2><span className="muted small">{stale.data?.total ?? ''}</span></div>
          {stale.data?.results.length ? stale.data.results.map((r) => (
            <div key={r.id} className="assoc-item">
              <div className="grow" style={{ minWidth: 0 }}><Link to={recordUrl('deal', r.id)} className="ellipsis" style={{ display: 'block' }}>{r.name}</Link>
                <div className="small muted">{stageOf(meta, r.props.dealstage)?.stage.label} · {userName(meta, r.props.owner_id)}</div></div>
              <span className="small num">{fmtMoney(r.props.amount)}</span>
            </div>
          )) : <div className="empty">Todo con movimiento.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Pipeline abierto</h2></div>
          <div className="panel-body stack">
            {byPipe.map(({ p, rows }) => (
              <div key={p.id}>
                <div className="row"><b className="grow">{p.label}</b><span className="small num">{sum(rows)} · {fmtMoney(sum(rows, 'amount'))}</span></div>
                {p.stages.filter((s) => !s.is_closed).map((s) => {
                  const r = rows.find((x) => x.stage_id === s.id);
                  if (!r) return null;
                  const max = Math.max(...rows.map((x) => x.n));
                  return (
                    <Link key={s.id} to={`/deals?view=board`} className="row small" style={{ color: 'inherit', padding: '2px 0' }}>
                      <span style={{ width: 170 }} className="ellipsis">{s.label}</span>
                      <span className="grow" style={{ background: 'var(--sunken)', borderRadius: 3, height: 8 }}><i style={{ display: 'block', height: 8, borderRadius: 3, background: 'var(--navy)', width: `${(r.n / max) * 100}%` }} /></span>
                      <span className="num" style={{ width: 34, textAlign: 'right' }}>{r.n}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
            {!byPipe.length && <div className="muted">Sin negocios abiertos.</div>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Ganado en {month} por vendedora</h2></div>
          <div className="panel-body stack">
            {Object.entries((d?.won ?? []).reduce<Record<string, { n: number; amount: number }>>((acc, w) => {
              const k = String(w.owner_id); acc[k] = { n: (acc[k]?.n ?? 0) + w.n, amount: (acc[k]?.amount ?? 0) + w.amount }; return acc;
            }, {})).sort((a, b) => b[1].amount - a[1].amount).map(([o, v]) => (
              <div key={o} className="row"><span className="grow">{userName(meta, o)}</span><span className="small muted">{v.n} {v.n === 1 ? 'negocio' : 'negocios'}</span><b className="num">{fmtMoney(v.amount)}</b></div>
            ))}
            {!d?.won.length && <div className="muted">Todavía no hay cierres ganados este mes.</div>}
            {d?.lost.length ? <>
              <h3 style={{ marginTop: 10 }}>Motivos de pérdida en {month}</h3>
              {d.lost.map((l) => <div key={l.motivo ?? 'x'} className="row small"><span className="grow">{l.motivo ?? 'Sin motivo cargado'}</span><span className="num">{l.n}</span></div>)}
            </> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
