import { useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, useDebounced, fmtDate, recordUrl, Icon, type Activity } from '../lib';
import { EditActivity } from './RecordPage';

const TABS: Array<[string, string]> = [['overdue', 'Vencidas'], ['today', 'Para hoy'], ['week', 'Esta semana'], ['upcoming', 'Próximas'], ['all', 'Todas abiertas'], ['done', 'Completadas']];
const PRIORITY: Record<string, [string, string]> = { high: ['Alta', 'bad'], medium: ['Media', 'warn'], low: ['Baja', 'info'] };
const TASK_TYPE: Record<string, string> = { todo: 'Por hacer', call: 'Llamar', email: 'Mail', whatsapp: 'WhatsApp', meeting: 'Reunión' };

export default function Tasks() {
  const { meta } = useMeta();
  const toast = useToast();
  const [tab, setTab] = useState('today');
  const [owner, setOwner] = useState<string>(String(meta.me.id));
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [edit, setEdit] = useState<Activity | null>(null);
  const list = useAsync(() => http<{ results: Activity[]; total: number }>('GET', `/tasks${qs({
    owner, status: tab === 'done' ? 'done' : 'open', due: tab === 'done' ? 'all' : tab, q: dq, limit: 200,
  })}`), [tab, owner, dq]);
  const toggle = async (a: Activity) => {
    try {
      await http('PATCH', `/activities/${a.id}`, { status: a.status === 'COMPLETED' ? 'NOT_STARTED' : 'COMPLETED' });
      toast(a.status === 'COMPLETED' ? 'Tarea reabierta' : 'Tarea completada');
      list.reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  const postpone = async (a: Activity, days: number) => {
    const d = new Date(Math.max(Date.now(), Date.parse(a.due_at ?? '') || 0) + days * 86_400_000);
    await http('PATCH', `/activities/${a.id}`, { due_at: d.toISOString() });
    toast(`Pasada al ${fmtDate(d)}`);
    list.reload();
  };
  return (
    <div className="content">
      <div className="page-head"><h1>Tareas</h1>
        <select className="input" style={{ width: 220 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsable">
          <option value={String(meta.me.id)}>Mis tareas</option>
          <option value="all">Todo el equipo</option>
          {meta.users.filter((u) => u.active && u.id !== meta.me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="toolbar">
        <div className="search" style={{ width: 320 }}><Icon name="search" /><input className="input" placeholder="Buscar en título o detalle (ej. Prospectar)…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="muted small">{list.data ? `${list.data.total} tareas` : ''}</span>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th className="check nosort" /><th className="nosort">Tarea</th><th className="nosort">Asociada a</th><th className="nosort">Vence</th><th className="nosort">Tipo</th><th className="nosort">Prioridad</th>{owner === 'all' && <th className="nosort">Responsable</th>}<th className="nosort" /></tr></thead>
          <tbody>
            {list.data?.results.map((a) => {
              const overdue = a.status !== 'COMPLETED' && a.due_at && Date.parse(a.due_at) < Date.now();
              return (
                <tr key={a.id}>
                  <td className="check"><button className={`check-round${a.status === 'COMPLETED' ? ' on' : ''}`} onClick={() => toggle(a)} aria-label="Completar">{a.status === 'COMPLETED' && <Icon name="check" />}</button></td>
                  <td style={{ maxWidth: 420 }}><button className="btn ghost" style={{ height: 'auto', padding: 0, fontWeight: 500 }} onClick={() => setEdit(a)}>{a.subject}</button>
                    {a.body && <div className="small muted ellipsis" style={{ maxWidth: 400 }}>{a.body.split('\n')[0]}</div>}</td>
                  <td>{a.links.slice(0, 2).map((l) => <Link key={l.id} className="chip" style={{ marginRight: 4 }} to={recordUrl(l.type, l.id)}>{l.name}</Link>)}</td>
                  <td className={overdue ? 'overdue' : ''}>{fmtDate(a.due_at, true)}</td>
                  <td>{TASK_TYPE[a.task_type ?? 'todo'] ?? a.task_type}</td>
                  <td>{a.priority && PRIORITY[a.priority] ? <span className={`tag ${PRIORITY[a.priority][1]}`}>{PRIORITY[a.priority][0]}</span> : <span className="muted">—</span>}</td>
                  {owner === 'all' && <td>{meta.users.find((u) => u.id === a.owner_id)?.name}</td>}
                  <td>{a.status !== 'COMPLETED' && <span className="row"><button className="btn sm ghost" onClick={() => postpone(a, 1)}>+1 día</button><button className="btn sm ghost" onClick={() => postpone(a, 7)}>+1 semana</button></span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.data && !list.data.results.length && <div className="empty">{tab === 'overdue' ? 'No hay tareas vencidas.' : 'No hay tareas acá.'}</div>}
      </div>
      {edit && <EditActivity a={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}
