import { useState } from 'react';
import { http, qs, useMeta, useToast, propsOf, propOf, stageOf, faltanObligatorias, OBJECTS, Icon, type Filter, type ObjectType, type Property } from '../lib';
import { Modal, PropertyInput, StageSelect, userOption } from '../components';
import { Select } from '../Select';

// Acciones masivas, como la barra de selección de HubSpot: Asignar, Editar, Crear tareas y Borrar, en la tabla y en el
// tablero. Con «Seleccionar los N» se trabaja sobre todo lo filtrado (no solo la página). Se manda de a 200 y, al final,
// se informa cuántos se hicieron y cuáles no y por qué (un negocio sin el dato que pide la etapa no frena al resto).

export type Selection = { ids: Set<number>; all: boolean };
type Failed = { id: number; name?: string; error: string };
type Kind = '' | 'assign' | 'edit' | 'tasks' | 'result';

export function BulkBar({ type, sel, total, query, onClear, onSelectAll, onDone }: {
  type: ObjectType; sel: Selection; total?: number; query: { q?: string; groups?: Filter[][] };
  onClear: () => void; onSelectAll?: () => void; onDone: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [show, setShow] = useState<Kind>('');
  const [progress, setProgress] = useState<string>('');
  const [result, setResult] = useState<{ done: number; failed: Failed[]; verb: string } | null>(null);
  const count = sel.all && total != null ? total : sel.ids.size;
  const word = count === 1 ? OBJECTS[type].single.toLowerCase() : OBJECTS[type].plural.toLowerCase();

  const ids = async () => (sel.all ? (await http<{ ids: number[] }>('GET', `/records/${type}/ids${qs({ q: query.q, groups: query.groups?.length ? query.groups : undefined })}`)).ids : [...sel.ids]);

  const run = async (verb: string, body: Record<string, unknown>) => {
    setShow('');
    try {
      const all = await ids();
      let done = 0;
      const failed: Failed[] = [];
      for (let i = 0; i < all.length; i += 200) {
        setProgress(`${verb}: ${Math.min(i + 200, all.length).toLocaleString('es-AR')} de ${all.length.toLocaleString('es-AR')}…`);
        const r = await http<{ updated?: number; tasks?: number; archived?: number; failed: Failed[] }>('POST', `/records/${type}/batch`, { ids: all.slice(i, i + 200), ...body });
        done += (r.updated ?? 0) + (r.tasks ?? 0) + (r.archived ?? 0);
        failed.push(...(r.failed ?? []));
      }
      setProgress('');
      if (failed.length) { setResult({ done, failed, verb }); setShow('result'); } else toast(`${verb}: ${done.toLocaleString('es-AR')} listos`);
      onDone();
    } catch (e) { setProgress(''); toast((e as Error).message, true); }
  };

  return (
    <div className="bulkbar">
      <b>{count.toLocaleString('es-AR')} {word} seleccionados</b>
      {!sel.all && onSelectAll && total != null && total > sel.ids.size && (
        <button className="btn sm ghost" onClick={onSelectAll}>Seleccionar los {total.toLocaleString('es-AR')}</button>
      )}
      {progress ? <span className="small muted">{progress}</span> : <>
        {propOf(meta, type, 'owner_id') && <button className="btn sm" onClick={() => setShow('assign')}>Asignar</button>}
        <button className="btn sm" onClick={() => setShow('edit')}>Editar</button>
        <button className="btn sm" onClick={() => setShow('tasks')}>Crear tareas</button>
        {['admin', 'manager'].includes(meta.me.role) && (
          <button className="btn sm danger" onClick={() => {
            if (confirm(`¿Borrar ${count.toLocaleString('es-AR')} ${word}? Se pueden restaurar desde la ficha.`)) run('Borrados', { archive: true });
          }}><Icon name="trash" size={14} />Borrar</button>
        )}
        <button className="btn sm ghost" onClick={onClear}>Deseleccionar</button>
      </>}
      {show === 'assign' && <AssignModal count={count} onClose={() => setShow('')} onSave={(owner) => run('Asignados', { props: { owner_id: owner } })} />}
      {show === 'edit' && <BulkEdit type={type} count={count} onClose={() => setShow('')} onSave={(props) => run('Actualizados', { props })} />}
      {show === 'tasks' && <TasksModal type={type} count={count} onClose={() => setShow('')} onSave={(task) => run('Tareas creadas', { task })} />}
      {show === 'result' && result && (
        <Modal title={`${result.verb}: ${result.done.toLocaleString('es-AR')} listos, ${result.failed.length.toLocaleString('es-AR')} no`} onClose={() => setShow('')}
          footer={<button className="btn primary" onClick={() => setShow('')}>Entendido</button>}>
          <p className="muted small" style={{ margin: 0 }}>Estos no se cambiaron (el resto sí):</p>
          <div className="stack" style={{ gap: 4, maxHeight: 360, overflow: 'auto' }}>
            {result.failed.slice(0, 100).map((f) => <div key={f.id} className="small"><b>{f.name ?? f.id}</b>: {f.error}</div>)}
            {result.failed.length > 100 && <div className="small muted">y {result.failed.length - 100} más.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function AssignModal({ count, onClose, onSave }: { count: number; onClose: () => void; onSave: (owner: number | null) => void }) {
  const { meta } = useMeta();
  const [owner, setOwner] = useState<string>(String(meta.me.id));
  return (
    <Modal title={`Asignar ${count.toLocaleString('es-AR')}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" onClick={() => onSave(owner ? Number(owner) : null)}>Asignar</button>
    </>}>
      <label className="field">Propietario
        <Select className="input" value={owner} onChange={(e) => setOwner(e.target.value)} autoFocus>
          <option value="">Sin asignar</option>
          {meta.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{userOption(u, u.id === meta.me.id ? ' (yo)' : '')}</option>)}
        </Select>
      </label>
    </Modal>
  );
}

// Editar una propiedad para todos. Si es la etapa de negocios, pide de una vez lo que esa etapa exige para entrar.
function BulkEdit({ type, count, onClose, onSave }: { type: ObjectType; count: number; onClose: () => void; onSave: (props: Record<string, unknown>) => void }) {
  const { meta } = useMeta();
  const editable = propsOf(meta, type).filter((p) => !p.read_only && !['name', 'dealname', 'email', 'hs_order_name', 'pipeline'].includes(p.name));
  const [prop, setProp] = useState(editable.find((p) => p.name === (type === 'deal' ? 'dealstage' : 'lifecyclestage'))?.name ?? editable[0].name);
  const [value, setValue] = useState<any>(null);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const p = editable.find((x) => x.name === prop)!;
  const stage = type === 'deal' && prop === 'dealstage' && value ? stageOf(meta, value)?.stage : undefined;
  const needs = stage ? faltanObligatorias(stage, {}).map((n) => propOf(meta, 'deal', n)).filter(Boolean) as Property[] : [];
  const ready = value != null && value !== '' ? needs.every((n) => extra[n.name] != null && extra[n.name] !== '') : true;
  return (
    <Modal title={`Editar ${count.toLocaleString('es-AR')}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!ready} onClick={() => onSave({ [prop]: value, ...extra })}>Actualizar</button>
    </>}>
      <label className="field">Propiedad
        <Select className="input" value={prop} onChange={(e) => { setProp(e.target.value); setValue(null); setExtra({}); }}>
          {editable.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
        </Select>
      </label>
      <label className="field">Nuevo valor
        {prop === 'dealstage' ? <StageSelect value={value ?? ''} onChange={(v) => { setValue(v); setExtra({}); }} /> : <PropertyInput prop={p} type={type} value={value} onChange={setValue} />}
      </label>
      {needs.length > 0 && <p className="muted small" style={{ margin: 0 }}>Para pasar a «{stage!.label}» hay que completar:</p>}
      {needs.map((n) => (
        <label key={n.name} className="field">{n.label} *<PropertyInput prop={n} type="deal" value={extra[n.name]} onChange={(v) => setExtra((x) => ({ ...x, [n.name]: v }))} /></label>
      ))}
      {prop === 'dealstage' && <p className="muted small" style={{ margin: 0 }}>Si a alguno no se lo puede mover (por las reglas del pipeline), te lo muestro al final y el resto se mueve igual.</p>}
    </Modal>
  );
}

function TasksModal({ type, count, onClose, onSave }: { type: ObjectType; count: number; onClose: () => void; onSave: (task: Record<string, unknown>) => void }) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const [f, setF] = useState({ subject: `Seguimiento: {nombre}`, due: tomorrow.toISOString().slice(0, 10), task_type: 'todo', priority: 'none', owner: 'record', body: '' });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={`Crear una tarea en cada uno (${count.toLocaleString('es-AR')})`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!f.subject.trim()} onClick={() => onSave({
        subject: f.subject, due_at: new Date(`${f.due}T10:00:00`).toISOString(), task_type: f.task_type, priority: f.priority, owner: f.owner, body: f.body,
      })}>Crear tareas</button>
    </>}>
      <label className="field">Título<input className="input" value={f.subject} onChange={(e) => set('subject', e.target.value)} autoFocus /></label>
      <p className="muted small" style={{ margin: 0 }}>{'{nombre}'} se reemplaza por el nombre de cada {OBJECTS[type].single.toLowerCase()}.</p>
      <div className="row wrap">
        <label className="field" style={{ flex: 1 }}>Vence<input className="input" type="date" value={f.due} onChange={(e) => set('due', e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Tipo
          <Select className="input" value={f.task_type} onChange={(e) => set('task_type', e.target.value)}>
            <option value="todo">Por hacer</option><option value="call">Llamada</option><option value="email">Mail</option>
          </Select>
        </label>
        <label className="field" style={{ flex: 1 }}>Prioridad
          <Select className="input" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
          </Select>
        </label>
      </div>
      <label className="field">Responsable
        <Select className="input" value={f.owner} onChange={(e) => set('owner', e.target.value)}>
          <option value="record">El propietario de cada registro</option><option value="me">Yo</option>
        </Select>
      </label>
      <label className="field">Notas<textarea className="input" value={f.body} onChange={(e) => set('body', e.target.value)} /></label>
    </Modal>
  );
}
