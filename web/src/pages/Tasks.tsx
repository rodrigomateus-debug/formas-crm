import { useState } from 'react';
import { Link } from 'react-router-dom';
import { http, qs, useMeta, useToast, useAsync, useDebounced, fmtDate, recordUrl, Icon, unidadesDe, type Activity } from '../lib';
import { ColumnWidths, UnidadBadge, useColumnResize } from '../components';
import { UnidadFilter } from './QuickFilters';
import { EditActivity } from './RecordPage';
import { Select } from '../Select';

const TABS: Array<[string, string]> = [['overdue', 'Vencidas'], ['today', 'Para hoy'], ['week', 'Esta semana'], ['upcoming', 'Próximas'], ['all', 'Todas abiertas'], ['done', 'Completadas']];
const PRIORITY: Record<string, [string, string]> = { high: ['Alta', 'bad'], medium: ['Media', 'warn'], low: ['Baja', 'info'] };
const TASK_TYPE: Record<string, string> = { todo: 'Por hacer', call: 'Llamar', email: 'Mail', whatsapp: 'WhatsApp', meeting: 'Reunión' };

export default function Tasks() {
  const { meta } = useMeta();
  const toast = useToast();
  const [tab, setTab] = useState('today');
  const [owner, setOwner] = useState<string>(String(meta.me.id));
  const [q, setQ] = useState('');
  const [unidades, setUnidades] = useState<string[]>([]);
  // Ancho de las columnas: se arrastra el borde del encabezado y queda guardado en este navegador.
  const [widths, setWidths] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem('crm.tasks.widths') ?? '{}'); } catch { return {}; } });
  const resize = useColumnResize(widths, (w) => { setWidths(w); try { localStorage.setItem('crm.tasks.widths', JSON.stringify(w)); } catch { /* ignorar */ } });
  const dq = useDebounced(q, 300);
  const [edit, setEdit] = useState<Activity | null>(null);
  const list = useAsync(() => http<{ results: Activity[]; total: number }>('GET', `/tasks${qs({
    owner, status: tab === 'done' ? 'done' : 'open', due: tab === 'done' ? 'all' : tab, q: dq, limit: 200, unidades: unidades.length ? unidades.join(',') : undefined,
  })}`), [tab, owner, dq, unidades.join(',')]);
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
  const cols: Array<[string, string]> = [['tarea', 'Tarea'], ['asociada', 'Asociada a'], ['vence', 'Vence'], ['tipo', 'Tipo'], ['prioridad', 'Prioridad'],
    ...(owner === 'all' ? [['responsable', 'Responsable'] as [string, string]] : []), ['unidad', 'Unidad']];
  return (
    <div className="content list-fixed">
      <div className="page-head"><h1>Tareas</h1>
        <Select className="input" style={{ width: 220 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Responsable">
          <option value={String(meta.me.id)}>Mis tareas</option>
          <option value="all">Todo el equipo</option>
          {meta.users.filter((u) => u.active && u.id !== meta.me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
      </div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="toolbar">
        <div className="search" style={{ width: 320 }}><Icon name="search" /><input className="input" placeholder="Buscar en título o detalle (ej. Prospectar)…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <UnidadFilter value={unidades} onChange={setUnidades} />
        <span className="muted small">{list.data ? `${list.data.total} tareas` : ''}</span>
      </div>
      <div className="table-wrap">
        <ColumnWidths scope="grid-tasks" order={['__check', ...cols.map(([k]) => k)]} widths={resize.widths} />
        <table className="grid grid-tasks">
          <thead><tr><th className="check nosort" />
            {cols.map(([k, l]) => <th key={k} className="nosort">{l}{resize.handle(k)}</th>)}
            <th className="nosort" /></tr></thead>
          <tbody>
            {list.data?.results.map((a) => {
              const overdue = a.status !== 'COMPLETED' && a.due_at && Date.parse(a.due_at) < Date.now();
              return (
                <tr key={a.id}>
                  <td className="check"><button className={`check-round${a.status === 'COMPLETED' ? ' on' : ''}`} onClick={() => toggle(a)} aria-label="Completar">{a.status === 'COMPLETED' && <Icon name="check" />}</button></td>
                  <td style={{ maxWidth: resize.widths.tarea ? undefined : 420 }}><button className="btn ghost" style={{ height: 'auto', padding: 0, fontWeight: 500 }} onClick={() => setEdit(a)}>{a.subject}</button>
                    {a.body && <div className="small muted ellipsis" style={{ maxWidth: resize.widths.tarea ? '100%' : 400 }}>{a.body.split('\n')[0]}</div>}</td>
                  <td>{a.links.slice(0, 2).map((l) => <Link key={l.id} className="chip" style={{ marginRight: 4 }} to={recordUrl(l.type, l.id)}>{l.name}</Link>)}</td>
                  <td className={overdue ? 'overdue' : ''}>{fmtDate(a.due_at, true)}</td>
                  <td>{TASK_TYPE[a.task_type ?? 'todo'] ?? a.task_type}</td>
                  <td>{a.priority && PRIORITY[a.priority] ? <span className={`tag ${PRIORITY[a.priority][1]}`}>{PRIORITY[a.priority][0]}</span> : <span className="muted">—</span>}</td>
                  {owner === 'all' && <td>{meta.users.find((u) => u.id === a.owner_id)?.name}</td>}
                  <td><span className="unidades">{unidadesDe(meta, 'task', { owner_id: a.owner_id }).map((k) => <UnidadBadge key={k} k={k} compact />)}</span></td>
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
