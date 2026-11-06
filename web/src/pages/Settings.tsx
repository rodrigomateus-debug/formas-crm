import { useEffect, useState, type CSSProperties } from 'react';
import { http, qs, useMeta, useToast, useAsync, propsOf, OBJECTS, fmtDate, TagChips, type Filter, type ObjectType, type Option, type Pipeline, type Property, type Stage, type Tag, canSeePipeline, userTeams, PROFILE_LABEL, ROLE_LABEL } from '../lib';
import { FilterRow, Modal, MultiPick, describeFilter, filterableProps, opsFor } from '../components';
import { Select } from '../Select';

const TABS: Array<[string, string]> = [['users', 'Usuarios'], ['properties', 'Propiedades'], ['pipelines', 'Pipelines'], ['tags', 'Etiquetas'], ['integrations', 'Integraciones y Claude'], ['inbound', 'Registro de entradas']];
const TYPES: Array<[string, string]> = [['string', 'Texto corto'], ['text', 'Texto largo'], ['number', 'Número'], ['currency', 'Moneda'], ['date', 'Fecha'], ['datetime', 'Fecha y hora'], ['enum', 'Lista desplegable'], ['multienum', 'Selección múltiple'], ['bool', 'Sí / No'], ['email', 'Email'], ['phone', 'Teléfono'], ['url', 'Link'], ['owner', 'Usuario']];

export default function Settings() {
  const [tab, setTab] = useState('users');
  return (
    <div className="content">
      <div className="page-head"><h1>Configuración</h1></div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'users' && <Users />}
      {tab === 'properties' && <Properties />}
      {tab === 'pipelines' && <Pipelines />}
      {tab === 'tags' && <Tags />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'inbound' && <Inbound />}
    </div>
  );
}

function Users() {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const users = useAsync(() => http<Array<{ id: number; email: string; name: string; role: string; profile: string; team_id: number | null; active: number; hs_owner_id: string | null }>>('GET', '/users'), []);
  const [add, setAdd] = useState(false);
  // Resumen corto: «Todos», «Todos menos: …» o la lista de los que ve.
  const pipelinesSummary = (u: Parameters<typeof canSeePipeline>[0]) => {
    if (u.role === 'admin') return 'Todos (administrador)';
    const sees = meta.pipelines.filter((p) => canSeePipeline(u, p));
    const hidden = meta.pipelines.filter((p) => !canSeePipeline(u, p));
    if (!hidden.length) return 'Todos';
    if (!sees.length) return 'Ninguno';
    return hidden.length <= sees.length ? `Todos menos: ${hidden.map((p) => p.label).join(', ')}` : sees.map((p) => p.label).join(', ');
  };
  const [f, setF] = useState({ email: '', name: '', profile: 'comercial', role: 'member', team_id: '' });
  const profileSelect = (value: string, onChange: (v: string) => void, cls = 'input sm') => (
    <Select className={cls} style={{ minWidth: 116 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Perfil">
      {Object.entries(PROFILE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
  );
  const roleSelect = (value: string, onChange: (v: string) => void, cls = 'input sm') => (
    <Select className={cls} style={{ minWidth: 124 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Permisos">
      {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
  );
  const patch = async (id: number, body: Record<string, unknown>) => {
    try { await http('PATCH', `/users/${id}`, body); users.reload(); reload(); toast('Guardado'); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="toolbar"><span className="muted small grow">Entra al CRM quien está en esta lista y activo, con su mail de Formas (login de Cloudflare Access). Para dar acceso, agregalo; para sacarlo, desactivalo.</span>
        <button className="btn primary" onClick={() => setAdd(true)}>Agregar usuario</button></div>
      <div className="table-wrap" style={{ overflow: 'visible' }}><table className="grid">
        <thead><tr><th className="nosort">Nombre</th><th className="nosort">Email</th><th className="nosort">Perfil</th><th className="nosort">Permisos</th><th className="nosort">Equipo</th><th className="nosort">Otros equipos</th><th className="nosort">Pipelines que ve</th><th className="nosort">Activo</th></tr></thead>
        <tbody>{users.data?.map((u) => (
          <tr key={u.id}>
            <td style={{ maxWidth: 160 }} title={u.name}>{u.name}</td><td style={{ maxWidth: 180 }} title={u.email}>{u.email}</td>
            <td>{profileSelect(u.profile, (v) => patch(u.id, { profile: v }))}</td>
            <td>{u.role === 'admin' ? <span className="small muted">Todo</span> : roleSelect(u.role, (v) => patch(u.id, { role: v }))}</td>
            <td><Select className="input sm" style={{ minWidth: 150, maxWidth: 170 }} value={u.team_id ?? ''} onChange={(e) => patch(u.id, { team_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></td>
            <td style={{ minWidth: 140, maxWidth: 160, overflow: 'visible' }}><MultiPick small options={meta.teams.filter((t) => t.id !== u.team_id).map((t) => ({ value: String(t.id), label: t.name }))}
              values={[...userTeams(u)].filter((t) => t !== u.team_id).map(String)} onChange={(v) => patch(u.id, { extra_teams: v.map(Number) })} /></td>
            <td className="small" style={{ maxWidth: 150, whiteSpace: 'normal' }}>{pipelinesSummary(u)}</td>
            <td><input type="checkbox" checked={!!u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} aria-label="Activo" /></td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">Perfiles: Admin ve y puede todo, incluida esta configuración. Comercial, Producción y Logística por ahora también ven todo; más adelante cada perfil va a ver lo suyo.
        Permisos (para los que no son Admin): «Edita» crea y edita, «Edita y borra» además borra y restaura registros, y «Solo mira» no cambia nada.</p>
      {add && <Modal title="Agregar usuario" onClose={() => setAdd(false)} footer={<button className="btn primary" onClick={async () => {
        try { await http('POST', '/users', { ...f, team_id: f.team_id ? Number(f.team_id) : null }); setAdd(false); users.reload(); reload(); toast('Usuario agregado'); } catch (e) { toast((e as Error).message, true); }
      }}>Agregar</button>}>
        <label className="field">Nombre<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Email<input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field">Perfil{profileSelect(f.profile, (v) => setF({ ...f, profile: v }), 'input')}</label>
        {f.profile !== 'admin' && <label className="field">Permisos{roleSelect(f.role, (v) => setF({ ...f, role: v }), 'input')}</label>}
        <label className="field">Equipo<Select className="input" value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}><option value="">—</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
      </Modal>}
    </>
  );
}

function Properties() {
  const { meta, reload } = useMeta();
  const [type, setType] = useState<ObjectType>('deal');
  const [edit, setEdit] = useState<Property | 'new' | null>(null);
  const [f, setF] = useState('');
  const list = propsOf(meta, type).filter((p) => !f || p.label.toLowerCase().includes(f.toLowerCase()) || p.name.includes(f.toLowerCase()));
  return (
    <>
      <div className="toolbar">
        <Select className="input" style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value as ObjectType)}>{(Object.keys(OBJECTS) as ObjectType[]).map((t) => <option key={t} value={t}>{OBJECTS[t].plural}</option>)}</Select>
        <input className="input" style={{ width: 260 }} placeholder="Buscar propiedad…" value={f} onChange={(e) => setF(e.target.value)} />
        <span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}>Crear propiedad</button>
      </div>
      <div className="table-wrap"><table className="grid">
        <thead><tr><th className="nosort">Etiqueta</th><th className="nosort">Nombre interno</th><th className="nosort">Tipo</th><th className="nosort">Grupo</th><th className="nosort">Opciones</th><th className="nosort">En el alta</th></tr></thead>
        <tbody>{list.map((p) => (
          <tr key={p.name} onClick={() => !p.read_only && setEdit(p)} style={{ cursor: p.read_only ? 'default' : 'pointer' }}>
            <td>{p.label}{p.system ? <span className="tag" style={{ marginLeft: 6 }}>sistema</span> : null}</td>
            <td className="muted small">{p.name}</td><td>{TYPES.find(([k]) => k === p.type)?.[1] ?? p.type}</td><td>{p.group_name}</td>
            <td className="small">{p.options.length || ''}</td><td>{p.in_create_form ? 'Sí' : ''}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {edit && <PropertyEditor type={type} prop={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function PropertyEditor({ type, prop, onClose, onSaved }: { type: ObjectType; prop: Property | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ label: prop?.label ?? '', type: prop?.type ?? 'string', group_name: prop?.group_name ?? 'Información', description: prop?.description ?? '', in_create_form: !!prop?.in_create_form, required: !!prop?.required });
  const [opts, setOpts] = useState<Option[]>(prop?.options ?? []);
  const save = async (archived = false) => {
    try {
      if (prop) await http('PATCH', `/properties/${type}/${prop.name}`, { ...f, options: opts, archived });
      else await http('POST', `/properties/${type}`, { ...f, options: opts });
      toast(archived ? 'Propiedad archivada' : 'Propiedad guardada');
      onSaved();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal title={prop ? `Editar «${prop.label}»` : 'Nueva propiedad'} onClose={onClose} footer={<>
      {prop && !prop.system && <button className="btn danger" onClick={() => confirm('¿Archivar la propiedad? Los valores quedan guardados.') && save(true)}>Archivar</button>}
      <span className="grow" /><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => save()}>Guardar</button>
    </>}>
      <label className="field">Etiqueta<input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
      <label className="field">Tipo<Select className="input" disabled={!!prop} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
      <label className="field">Grupo<input className="input" value={f.group_name} onChange={(e) => setF({ ...f, group_name: e.target.value })} /></label>
      <label className="field">Descripción<input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="row small"><input type="checkbox" checked={f.in_create_form} onChange={(e) => setF({ ...f, in_create_form: e.target.checked })} />Mostrar en el formulario de alta</label>
      <label className="row small"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} />Obligatoria</label>
      {['enum', 'multienum'].includes(f.type) && (
        <div className="stack">
          <b className="small">Opciones</b>
          {opts.map((o, i) => (
            <div key={i} className="row">
              <input className="input" placeholder="Etiqueta" value={o.label} onChange={(e) => setOpts(opts.map((x, j) => j === i ? { label: e.target.value, value: prop && x.value ? x.value : e.target.value } : x))} />
              <span className="small muted" style={{ width: 160 }} title="Valor interno">{o.value}</span>
              <button className="btn ghost sm" onClick={() => setOpts(opts.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpts([...opts, { value: '', label: '' }])}>+ Opción</button>
        </div>
      )}
    </Modal>
  );
}

type StageDraft = Stage & { _new?: boolean };

// Pipelines como en HubSpot: etapas (orden, probabilidad, tipo), lo que pide cada etapa, tarea automática,
// reglas del pipeline, datos de las tarjetas del tablero y de «Acerca de este negocio».
function Pipelines() {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const [selId, setSelId] = useState<string | null>(meta.pipelines[0]?.id ?? null);
  const [draft, setDraft] = useState<(Omit<Pipeline, 'stages'> & { stages: StageDraft[] }) | null>(null);
  const [removed, setRemoved] = useState<Array<{ id: string; label: string; move_to: string }>>([]);
  const [creating, setCreating] = useState(false);
  const dealProps = propsOf(meta, 'deal').filter((p) => !p.read_only);
  const propOpts = dealProps.map((p) => ({ value: p.name, label: p.label }));
  useEffect(() => {
    const p = meta.pipelines.find((x) => x.id === selId);
    setDraft(p ? JSON.parse(JSON.stringify(p)) : null);
    setRemoved([]);
  }, [selId, meta]);
  if (!draft) return null;
  const rules = draft.config.rules ?? {};
  const setRules = (patch: Partial<NonNullable<typeof rules>>) => setDraft({ ...draft, config: { ...draft.config, rules: { ...rules, ...patch } } });
  const setStage = (i: number, patch: Partial<StageDraft>) => setDraft({ ...draft, stages: draft.stages.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const moveStage = (i: number, d: number) => {
    const st = [...draft.stages];
    [st[i], st[i + d]] = [st[i + d], st[i]];
    setDraft({ ...draft, stages: st });
  };
  const removeStage = (i: number) => {
    const st = draft.stages[i];
    const rest = draft.stages.filter((_, j) => j !== i);
    if (!st._new) setRemoved([...removed, { id: st.id, label: st.label, move_to: (rest[Math.max(0, i - 1)] ?? rest[0]).id }]);
    setDraft({ ...draft, stages: rest });
  };
  const save = async () => {
    try {
      await http('PUT', `/pipelines/${draft.id}`, {
        label: draft.label, team_id: draft.team_id, config: draft.config,
        stages: draft.stages.map((s) => ({ id: s._new ? undefined : s.id, label: s.label, probability: s.probability, is_closed: !!s.is_closed, is_won: !!s.is_won, config: s.config ?? {} })),
        remove: removed.map((r) => ({ id: r.id, move_to: r.move_to })),
      });
      toast('Pipeline guardado');
      await reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap">
        <Select className="input" style={{ width: 300 }} value={selId ?? ''} onChange={(e) => setSelId(e.target.value)} aria-label="Pipeline">
          {meta.pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}{p.team_id ? ` · ${meta.teams.find((t) => t.id === p.team_id)?.name ?? ''}` : ''}</option>)}
        </Select>
        <button className="btn" onClick={() => setCreating(true)}>+ Crear pipeline</button>
        <span className="grow" />
        <button className="btn danger" onClick={async () => {
          if (!confirm(`¿Borrar el pipeline «${draft.label}»? Solo se puede si no tiene negocios.`)) return;
          try { await http('DELETE', `/pipelines/${draft.id}`); toast('Pipeline borrado'); await reload(); setSelId(meta.pipelines.find((p) => p.id !== draft.id)?.id ?? null); }
          catch (e) { toast((e as Error).message, true); }
        }}>Borrar pipeline</button>
        <button className="btn primary" onClick={save}>Guardar cambios</button>
      </div>

      <div className="grid-2">
        <div className="panel"><div className="panel-head"><h2>General</h2></div><div className="panel-body stack">
          <label className="field">Nombre<input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          <label className="field">Equipo (arranca en este pipeline)<Select className="input" value={draft.team_id ?? ''} onChange={(e) => setDraft({ ...draft, team_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Ninguno</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
          <div className="field">Quién lo ve
            <div className="row wrap">
              <label className="row small" style={{ fontWeight: 400 }}><input type="radio" name="vis" checked={!draft.config.visible_teams?.length} onChange={() => setDraft({ ...draft, config: { ...draft.config, visible_teams: [] } })} />Todos</label>
              <label className="row small" style={{ fontWeight: 400 }}><input type="radio" name="vis" checked={!!draft.config.visible_teams?.length} onChange={() => setDraft({ ...draft, config: { ...draft.config, visible_teams: draft.team_id ? [draft.team_id] : meta.teams.slice(0, 1).map((t) => t.id) } })} />Solo estos equipos</label>
            </div>
            {!!draft.config.visible_teams?.length && <MultiPick options={meta.teams.map((t) => ({ value: String(t.id), label: t.name }))} values={draft.config.visible_teams.map(String)} onChange={(v) => setDraft({ ...draft, config: { ...draft.config, visible_teams: v.map(Number) } })} />}
            <span className="small muted" style={{ fontWeight: 400 }}>Lo ven: {draft.config.visible_teams?.length
              ? meta.users.filter((u) => u.active && canSeePipeline(u, draft as unknown as Pipeline)).map((u) => u.name).join(', ')
              : 'todos los usuarios'}. Los administradores ven siempre todos los pipelines.</span>
          </div>
          <label className="field">Datos de las tarjetas del tablero<MultiPick options={propOpts} values={draft.config.card_props ?? ['amount', 'closedate']} onChange={(v) => setDraft({ ...draft, config: { ...draft.config, card_props: v } })} /></label>
          <label className="field">«Acerca de este negocio» en la ficha<MultiPick options={propOpts} values={draft.config.key_props ?? []} onChange={(v) => setDraft({ ...draft, config: { ...draft.config, key_props: v } })} /></label>
          <span className="small muted">Si no elegís nada, se usan los datos de siempre.</span>
        </div></div>
        <div className="panel"><div className="panel-head"><h2>Reglas</h2></div><div className="panel-body stack">
          <label className="row"><input type="checkbox" checked={!!rules.no_skip} onChange={(e) => setRules({ no_skip: e.target.checked })} />No saltear etapas (hay que pasar por cada etapa abierta)</label>
          <label className="row"><input type="checkbox" checked={!!rules.no_backward} onChange={(e) => setRules({ no_backward: e.target.checked })} />No volver a una etapa anterior ni reabrir negocios cerrados</label>
          <label className="row"><input type="checkbox" checked={!!rules.require_company} onChange={(e) => setRules({ require_company: e.target.checked })} />El negocio tiene que tener una empresa asociada</label>
          <label className="field">Los negocios se crean solo en<MultiPick options={draft.stages.filter((s) => !s._new).map((s) => ({ value: s.id, label: s.label }))} values={rules.create_stages ?? []} onChange={(v) => setRules({ create_stages: v })} /></label>
          <span className="small muted">Vacío = en cualquier etapa. Los administradores pueden saltear las reglas de movimiento (como en HubSpot); los datos obligatorios de cada etapa valen para todos.</span>
        </div></div>
      </div>

      <div className="panel"><div className="panel-head"><h2>Etapas</h2>
        <button className="btn sm" onClick={() => setDraft({ ...draft, stages: [...draft.stages.filter((s) => !s.is_closed), { id: `nueva-${Date.now()}`, _new: true, pipeline_id: draft.id, label: 'Nueva etapa', display_order: 0, probability: 0.5, is_closed: 0, is_won: 0, config: {} }, ...draft.stages.filter((s) => s.is_closed)] })}>+ Etapa</button></div>
        <div className="table-wrap" style={{ border: 0, overflow: 'visible' }}><table className="grid">
          <thead><tr><th className="nosort" /><th className="nosort">Etapa</th><th className="nosort">Probabilidad</th><th className="nosort">Tipo</th><th className="nosort">Para entrar pide</th><th className="nosort">Tarea automática al entrar</th><th className="nosort" /></tr></thead>
          <tbody>{draft.stages.map((s, i) => (
            <tr key={s.id}>
              <td style={{ whiteSpace: 'nowrap' }}><button className="btn ghost sm" disabled={i === 0} onClick={() => moveStage(i, -1)} aria-label="Subir">↑</button><button className="btn ghost sm" disabled={i === draft.stages.length - 1} onClick={() => moveStage(i, 1)} aria-label="Bajar">↓</button></td>
              <td><input className="input" style={{ minWidth: 200 }} value={s.label} onChange={(e) => setStage(i, { label: e.target.value })} /></td>
              <td><input className="input num" style={{ width: 80 }} type="number" min={0} max={100} value={Math.round(s.probability * 100)} onChange={(e) => setStage(i, { probability: Number(e.target.value) / 100 })} /></td>
              <td><Select className="input" style={{ width: 120 }} value={s.is_closed ? (s.is_won ? 'won' : 'lost') : 'open'} onChange={(e) => setStage(i, { is_closed: e.target.value === 'open' ? 0 : 1, is_won: e.target.value === 'won' ? 1 : 0, probability: e.target.value === 'won' ? 1 : e.target.value === 'lost' ? 0 : s.probability })}>
                <option value="open">Abierta</option><option value="won">Ganada</option><option value="lost">Perdida</option></Select></td>
              <td style={{ minWidth: 220, overflow: 'visible' }}><MultiPick options={propOpts} values={s.config?.required_props ?? []} onChange={(v) => setStage(i, { config: { ...s.config, required_props: v } })} /></td>
              <td style={{ minWidth: 300 }}><div className="row">
                <input className="input" placeholder="Ej.: Seguimiento de {negocio}" value={s.config?.task?.subject ?? ''} onChange={(e) => setStage(i, { config: { ...s.config, task: e.target.value ? { ...(s.config?.task ?? {}), subject: e.target.value } : null } })} />
                <input className="input num" style={{ width: 70 }} type="number" min={0} title="Vence en días" value={s.config?.task?.due_days ?? 1} disabled={!s.config?.task?.subject} onChange={(e) => setStage(i, { config: { ...s.config, task: { ...(s.config?.task ?? { subject: '' }), due_days: Number(e.target.value) } } })} />
                <span className="small muted">días</span>
              </div></td>
              <td><button className="btn ghost sm danger" disabled={draft.stages.filter((x) => !x.is_closed).length <= 1 && !s.is_closed} onClick={() => removeStage(i)}>Borrar</button></td>
            </tr>
          ))}</tbody>
        </table></div>
        {removed.length > 0 && <div className="panel-body stack">
          <b className="small">Etapas que se borran al guardar</b>
          {removed.map((r, i) => (
            <div key={r.id} className="row small">«{r.label}»: si tiene negocios, pasan a
              <Select className="input sm" style={{ width: 240 }} value={r.move_to} onChange={(e) => setRemoved(removed.map((x, j) => (j === i ? { ...x, move_to: e.target.value } : x)))}>
                {draft.stages.filter((s) => !s._new).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
              <button className="btn ghost sm" onClick={() => { const st = meta.pipelines.find((p) => p.id === draft.id)!.stages.find((x) => x.id === r.id)!; setRemoved(removed.filter((_, j) => j !== i)); setDraft({ ...draft, stages: [...draft.stages, st] }); }}>No borrar</button>
            </div>
          ))}
        </div>}
        <div className="panel-body small muted">En la tarea automática, {'{negocio}'} se reemplaza por el nombre del negocio. Se le asigna al propietario del negocio.</div>
      </div>
      {creating && <NewPipeline onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await reload(); setSelId(id); }} />}
    </div>
  );
}

function NewPipeline({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [f, setF] = useState({ label: '', team_id: '', copy_from: '' });
  return (
    <Modal title="Crear pipeline" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!f.label.trim()} onClick={async () => {
        try {
          const r = await http<{ id: string }>('POST', '/pipelines', { label: f.label, team_id: f.team_id ? Number(f.team_id) : null, copy_from: f.copy_from || undefined });
          toast('Pipeline creado'); onCreated(r.id);
        } catch (e) { toast((e as Error).message, true); }
      }}>Crear</button>
    </>}>
      <label className="field">Nombre<input className="input" autoFocus value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ej.: Licitaciones" /></label>
      <label className="field">Equipo<Select className="input" value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}>
        <option value="">Ninguno</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
      <label className="field">Etapas<Select className="input" value={f.copy_from} onChange={(e) => setF({ ...f, copy_from: e.target.value })}>
        <option value="">Etapas básicas (oportunidad, cotización, negociación, ganado, perdido)</option>
        {meta.pipelines.map((p) => <option key={p.id} value={p.id}>Copiar de «{p.label}» (etapas y reglas)</option>)}</Select></label>
    </Modal>
  );
}

// Pedidos: ClickUp (estado, cada 10 minutos) y Finnegans (facturas, cada hora). Solo leen; acá se ve cómo vienen.
interface SyncState { configured: boolean; at?: string; error?: string | null; creados?: number; actualizados?: number; pendientes?: number; leyendo_lista?: boolean; revisados?: number; facturas?: number; pdf_pendientes?: number }
function Pedidos() {
  const toast = useToast();
  const st = useAsync(() => http<{ clickup: SyncState; finnegans: SyncState }>('GET', '/integrations/pedidos'), []);
  const [busy, setBusy] = useState('');
  const go = async (what: string, path: string, body?: unknown) => {
    setBusy(what);
    try { const r = await http<SyncState & { skipped?: string }>('POST', path, body ?? {}); toast(r.skipped ?? (r.error ? `Error: ${r.error}` : 'Listo')); st.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(''); }
  };
  const c = st.data?.clickup;
  const f = st.data?.finnegans;
  const when = (s?: SyncState) => (s?.at ? fmtDate(s.at, true) : 'nunca');
  return (
    <div className="panel"><div className="panel-head"><h2>Pedidos: ClickUp y Finnegans</h2></div><div className="panel-body stack small">
      <p style={{ margin: 0 }}>Los pedidos salen de la lista PEC de ClickUp: cada PDV nuevo crea su pedido y su estado se mueve solo según los artículos. La vendedora solo lo pasa de «Pedido confirmado» a «Listo para producción». Cuando la factura de Finnegans tiene CAE se adjunta sola, y el remito cuando lo suben a ClickUp al entregar. ClickUp y Finnegans solo se leen.</p>
      <div className="row wrap">
        <b style={{ width: 90 }}>ClickUp</b>
        {c?.configured ? <span className="grow">Última vez: {when(c)}{c.at ? ` · ${c.creados ?? 0} creados, ${c.actualizados ?? 0} actualizados${c.pendientes ? `, ${c.pendientes} PDV para las próximas corridas` : ''}${c.leyendo_lista ? ' · todavía leyendo la lista' : ''}` : ''}{c.error ? <span className="danger-text"> · {c.error}</span> : null}</span>
          : <span className="grow muted">Falta el secreto CLICKUP_TOKEN en el repo (se carga en el próximo despliegue).</span>}
        <button className="btn sm" disabled={!c?.configured || !!busy} onClick={() => go('cu', '/integrations/clickup/sync')}>{busy === 'cu' ? 'Sincronizando…' : 'Sincronizar ahora'}</button>
        <button className="btn sm ghost" disabled={!c?.configured || !!busy} onClick={() => go('cufull', '/integrations/clickup/sync', { full: true })} title="Revisa todos los PDV abiertos y los entregados de los últimos 45 días">Revisar todo</button>
      </div>
      <div className="row wrap">
        <b style={{ width: 90 }}>Finnegans</b>
        {f?.configured ? <span className="grow">Última vez: {when(f)}{f.at ? ` · ${f.revisados ?? 0} pedidos revisados, ${f.facturas ?? 0} facturas nuevas` : ''}{f.pdf_pendientes ? ` · ${f.pdf_pendientes} PDF por bajar` : ''}{f.error ? <span className="danger-text"> · {f.error}</span> : null}</span>
          : <span className="grow muted">Faltan los secretos FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET en el repo.</span>}
        <button className="btn sm" disabled={!f?.configured || !!busy} onClick={() => go('fin', '/integrations/finnegans/sync')}>{busy === 'fin' ? 'Buscando…' : 'Buscar facturas ahora'}</button>
      </div>
    </div></div>
  );
}

// Dónde se guardan los bocetos de producción: una unidad compartida (o carpeta) de Drive de Formas, y el usuario con el que
// entra el CRM (necesita el permiso de Drive en la delegación de la cuenta de servicio).
function BocetosDrive() {
  const toast = useToast();
  const cfg = useAsync(() => http<{ carpeta: string | null; usuario: string | null; cuenta_de_servicio: boolean }>('GET', '/integrations/bocetos'), []);
  const [f, setF] = useState<{ carpeta: string; usuario: string } | null>(null);
  const v = f ?? { carpeta: cfg.data?.carpeta ?? '', usuario: cfg.data?.usuario ?? '' };
  return (
    <div className="panel"><div className="panel-head"><h2>Bocetos en Drive</h2>
      {cfg.data?.carpeta && cfg.data.usuario ? <span className="tag ok">Configurado</span> : <span className="tag warn">Sin configurar</span>}</div>
      <div className="panel-body stack">
        <p className="small muted" style={{ margin: 0 }}>Los bocetos de producción (PDF o fotos) se guardan en una unidad compartida de Drive, con una carpeta por
          empresa y, adentro, una por pedido o negocio. Pegá el link de la unidad compartida (o de una carpeta) y el mail con el que entra el CRM, que tiene que
          poder editar ahí.{!cfg.data?.cuenta_de_servicio && ' Falta la cuenta de servicio de Google (GOOGLE_SA_JSON).'}</p>
        <div className="row wrap">
          <input className="input" style={{ width: 380 }} placeholder="Link de la unidad compartida o carpeta de Drive" value={v.carpeta} onChange={(e) => setF({ ...v, carpeta: e.target.value })} />
          <input className="input" style={{ width: 260 }} placeholder="Mail con el que entra (ej. rodrigo.mateus@…)" value={v.usuario} onChange={(e) => setF({ ...v, usuario: e.target.value })} />
          <button className="btn primary" disabled={!f} onClick={async () => {
            try { await http('PUT', '/integrations/bocetos', v); toast('Carpeta de bocetos guardada'); setF(null); cfg.reload(); } catch (e) { toast((e as Error).message, true); }
          }}>Guardar</button>
          <button className="btn" disabled={!!f || !cfg.data?.carpeta} onClick={async () => {
            try {
              const r = await http<{ ok: boolean; carpeta: string | null; unidad_compartida: boolean; error: string | null }>('GET', '/integrations/bocetos/probar');
              toast(r.ok ? `Anda: el CRM puede guardar en «${r.carpeta}»${r.unidad_compartida ? ' (unidad compartida)' : ''}.` : r.error ?? 'No anda.', !r.ok);
            } catch (e) { toast((e as Error).message, true); }
          }}>Probar acceso</button>
        </div>
      </div>
    </div>
  );
}

function Integrations() {
  const toast = useToast();
  const tokens = useAsync(() => http<Array<{ id: number; name: string; source: string; created_at: string; last_used_at: string | null; revoked: number; user_name: string }>>('GET', '/tokens'), []);
  const [fresh, setFresh] = useState<{ token: string; source: string } | null>(null);
  const [f, setF] = useState({ name: '', source: 'mcp' });
  const origin = window.location.origin;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Pedidos />
      <BocetosDrive />
      <Gmail />
      <OutboundHooks />
      <div className="panel"><div className="panel-head"><h2>Claude (MCP)</h2></div><div className="panel-body stack">
        <p style={{ margin: 0 }}>Para que Claude y Cowork lean y actualicen el CRM: creá un token de tipo «Claude (MCP)» y cargá esta URL como conector personalizado en claude.ai (Configuración → Conectores → Agregar conector personalizado):</p>
        <code className="panel panel-body small">{origin}/mcp/&lt;token&gt;</code>
        <p className="muted small" style={{ margin: 0 }}>Herramientas: buscar, traer ficha con actividad, crear, actualizar, alta inteligente (contacto + empresa + negocio), asociar, registrar actividad, crear y listar tareas, combinar duplicados, reportes, propiedades, pipelines y usuarios. Todo queda en el historial con origen «mcp».</p>
      </div></div>
      <div className="panel"><div className="panel-head"><h2>Webhooks y API</h2></div><div className="panel-body stack small">
        <div><b>Darwin (WhatsApp, hoy por Pipedream):</b> <code>POST {origin}/hooks/darwin</code> con <code>Authorization: Bearer &lt;token&gt;</code>. Arma el negocio «Nombre - Producto - Cantidad - Darwin» en Formas Shop (Inbound) / Lead calificado.</div>
        <div><b>Prospección por LinkedIn (reemplaza a Zapier):</b> <code>POST {origin}/hooks/linkedin</code> con el lead (URL del perfil, nombre, empresa, cargo). No duplica el mismo perfil.</div>
        <div><b>Cualquier otra integración:</b> <code>POST {origin}/hooks/bundle</code> con {'{ contact, company, deal, note, task, owner_email }'}. Busca antes de crear y asocia todo.</div>
        <div><b>Formularios web:</b> <code>POST {origin}/hooks/form/&lt;formulario&gt;</code> (público, se configura en la base).</div>
        <div><b>Tableros (compatibilidad HubSpot):</b> cambiar <code>https://api.hubapi.com</code> por <code>{origin}/hubspot</code> y usar un token de tipo «API».</div>
      </div></div>
      <div className="panel"><div className="panel-head"><h2>Tokens</h2></div><div className="panel-body stack">
        <div className="row wrap">
          <input className="input" style={{ width: 260 }} placeholder="Nombre (ej. Cowork Rodrigo)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select className="input" style={{ width: 200 }} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="mcp">Claude (MCP)</option><option value="darwin">Darwin</option><option value="linkedin">LinkedIn</option><option value="api">API / tableros</option>
          </Select>
          <button className="btn primary" disabled={!f.name.trim()} onClick={async () => {
            try { const r = await http<{ token: string }>('POST', '/tokens', f); setFresh({ token: r.token, source: f.source }); setF({ name: '', source: f.source }); tokens.reload(); } catch (e) { toast((e as Error).message, true); }
          }}>Crear token</button>
        </div>
        {fresh && <div className="panel panel-body" style={{ background: 'var(--ok-soft)' }}>
          <b>Copiá el token ahora: no se vuelve a mostrar.</b>
          <code style={{ display: 'block', wordBreak: 'break-all', margin: '6px 0' }}>{fresh.source === 'mcp' ? `${origin}/mcp/${fresh.token}` : fresh.token}</code>
          <button className="btn sm" onClick={() => { navigator.clipboard.writeText(fresh.source === 'mcp' ? `${origin}/mcp/${fresh.token}` : fresh.token); toast('Copiado'); }}>Copiar</button>
        </div>}
        <div className="table-wrap"><table className="grid">
          <thead><tr><th className="nosort">Nombre</th><th className="nosort">Tipo</th><th className="nosort">Usuario</th><th className="nosort">Creado</th><th className="nosort">Último uso</th><th className="nosort" /></tr></thead>
          <tbody>{tokens.data?.map((t) => (
            <tr key={t.id} style={{ opacity: t.revoked ? 0.5 : 1 }}>
              <td>{t.name}</td><td>{t.source}</td><td>{t.user_name}</td><td>{fmtDate(t.created_at)}</td><td>{t.last_used_at ? fmtDate(t.last_used_at, true) : '—'}</td>
              <td>{!t.revoked ? <button className="btn sm danger" onClick={async () => { if (confirm('¿Revocar el token? Lo que lo use deja de andar.')) { await http('DELETE', `/tokens/${t.id}`); tokens.reload(); } }}>Revocar</button> : 'revocado'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div></div>
    </div>
  );
}

function Inbound() {
  const log = useAsync(() => http<Array<{ id: number; source: string; received_at: string; payload: string; result: string; ok: number }>>('GET', '/inbound'), []);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="table-wrap"><table className="grid">
      <thead><tr><th className="nosort">Cuándo</th><th className="nosort">Origen</th><th className="nosort">Resultado</th><th className="nosort" /></tr></thead>
      <tbody>{log.data?.map((l) => (
        <tr key={l.id} onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: 'pointer' }}>
          <td>{fmtDate(l.received_at, true)}</td><td>{l.source}</td>
          <td style={{ whiteSpace: open === l.id ? 'pre-wrap' : undefined, maxWidth: 600 }}>{l.ok ? <span className="tag ok">ok</span> : <span className="tag bad">error</span>} {open === l.id ? `${l.result}\n\n${l.payload}` : l.result}</td><td />
        </tr>
      ))}</tbody>
    </table>{log.data && !log.data.length && <div className="empty">Todavía no entró nada por integraciones.</div>}</div>
  );
}

interface GmailStatus {
  config: { enabled: boolean; internal_domains: string[]; ignore_domains: string[]; create_contacts_on_sent: boolean; users: string[] | 'all' };
  has_credentials: boolean;
  state: Record<string, { at?: string; logged?: number; seen?: number; pending?: number; out?: Array<{ mailbox?: string; error?: string; logged?: number }> }>;
}

function Gmail() {
  const toast = useToast();
  const st = useAsync(() => http<GmailStatus>('GET', '/gmail'), []);
  const [busy, setBusy] = useState(false);
  if (!st.data) return null;
  const cfg = st.data.config;
  const save = async (patch: Partial<GmailStatus['config']>) => {
    try { await http('PUT', '/gmail', patch); st.reload(); toast('Guardado'); } catch (e) { toast((e as Error).message, true); }
  };
  const last = st.data.state.gmail_last_run as { at?: string; out?: Array<{ mailbox?: string; error?: string; logged?: number; skipped?: string }> } | undefined;
  return (
    <div className="panel"><div className="panel-head"><h2>Mails (Gmail)</h2>
      {st.data.has_credentials ? <span className={`tag ${cfg.enabled ? 'ok' : ''}`}>{cfg.enabled ? 'Activo' : 'Apagado'}</span> : <span className="tag warn">Falta la cuenta de servicio</span>}</div>
      <div className="panel-body stack">
        <p style={{ margin: 0 }}>Cada 10 minutos registra en el CRM los mails del equipo con contactos (como la conexión de bandeja de HubSpot). Los recibidos se guardan si el remitente ya es contacto; los enviados pueden crear el contacto.</p>
        {!st.data.has_credentials && <p className="small muted" style={{ margin: 0 }}>Hace falta cargar el secreto GOOGLE_SA_JSON (cuenta de servicio con delegación de dominio y permiso gmail.readonly). Ver README, «Gmail».</p>}
        <label className="row"><input type="checkbox" checked={cfg.enabled} disabled={!st.data.has_credentials} onChange={(e) => save({ enabled: e.target.checked })} />Registrar mails automáticamente</label>
        <label className="row"><input type="checkbox" checked={cfg.create_contacts_on_sent} onChange={(e) => save({ create_contacts_on_sent: e.target.checked })} />Crear el contacto cuando le escribimos a alguien nuevo</label>
        <label className="field">Dominios propios (no se registran)<input className="input" defaultValue={cfg.internal_domains.join(', ')} onBlur={(e) => save({ internal_domains: e.target.value.split(/[,\s]+/).filter(Boolean) })} /></label>
        <label className="field">Dominios que nunca se registran (proveedores, avisos)<input className="input" defaultValue={cfg.ignore_domains.join(', ')} onBlur={(e) => save({ ignore_domains: e.target.value.split(/[,\s]+/).filter(Boolean) })} /></label>
        <div className="row">
          <button className="btn" disabled={busy || !st.data.has_credentials || !cfg.enabled} onClick={async () => {
            setBusy(true);
            try { const r = await http<Array<{ mailbox?: string; logged?: number; error?: string }>>('POST', '/gmail/sync'); toast(`Listo: ${r.reduce((n, x) => n + (x.logged ?? 0), 0)} mails registrados`); st.reload(); }
            catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
          }}>Sincronizar ahora</button>
          {last?.at && <span className="small muted">Última pasada: {fmtDate(last.at, true)}</span>}
        </div>
        {last?.out?.some((o) => o.error) && <div className="small" style={{ color: 'var(--bad)' }}>{last.out.filter((o) => o.error).map((o) => `${o.mailbox}: ${o.error}`).join(' · ')}</div>}
      </div>
    </div>
  );
}

interface Hook { event: 'deal.won' | 'deal.stage_changed'; url: string; name?: string; secret?: string }

function OutboundHooks() {
  const toast = useToast();
  const hooks = useAsync(() => http<Hook[]>('GET', '/webhooks'), []);
  const [draft, setDraft] = useState<Hook[] | null>(null);
  const list = draft ?? hooks.data ?? [];
  const set = (i: number, patch: Partial<Hook>) => setDraft(list.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  return (
    <div className="panel"><div className="panel-head"><h2>Avisos a otros sistemas</h2>
      {draft && <button className="btn sm primary" onClick={async () => {
        try { await http('PUT', '/webhooks', draft); setDraft(null); hooks.reload(); toast('Guardado'); } catch (e) { toast((e as Error).message, true); }
      }}>Guardar</button>}</div>
      <div className="panel-body stack">
        <p className="small muted" style={{ margin: 0 }}>Cuando un negocio se gana (o cambia de etapa) el CRM le avisa a esta URL con el negocio, el monto, los contactos y el hilo de WhatsApp. Sirve para que Darwin marque la venta y registre el ingreso. Lo enviado queda en «Registro de entradas».</p>
        {list.map((h, i) => (
          <div key={i} className="row wrap">
            <input className="input" style={{ width: 140 }} placeholder="Nombre" value={h.name ?? ''} onChange={(e) => set(i, { name: e.target.value })} />
            <Select className="input" style={{ width: 200 }} value={h.event} onChange={(e) => set(i, { event: e.target.value as Hook['event'] })}>
              <option value="deal.won">Negocio ganado</option><option value="deal.stage_changed">Cambio de etapa</option>
            </Select>
            <input className="input grow" style={{ minWidth: 240 }} placeholder="https://…" value={h.url} onChange={(e) => set(i, { url: e.target.value })} />
            <input className="input" style={{ width: 160 }} placeholder="Clave para firmar (opcional)" value={h.secret ?? ''} onChange={(e) => set(i, { secret: e.target.value || undefined })} />
            <button className="btn ghost sm" onClick={() => setDraft(list.filter((_, j) => j !== i))}>Quitar</button>
          </div>
        ))}
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft([...list, { event: 'deal.won', url: '', name: 'Darwin' }])}>+ Aviso</button>
      </div>
    </div>
  );
}

// Etiquetas de color con regla, como las «Etiquetas de negocio» de HubSpot: se ponen solas a los registros que cumplen
// la regla (en los pipelines elegidos). Se ven en las tarjetas, como columna y como filtro rápido.
const TAG_COLORS = ['#2f7d32', '#1565c0', '#6a1b9a', '#c62828', '#ef6c00', '#5d4037', '#00838f', '#ad1457', '#455a64', '#9e9d24'];

function Tags() {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const [edit, setEdit] = useState<Partial<Tag> | null>(null);
  const admin = meta.me.role === 'admin';
  return (
    <div className="stack">
      <div className="row">
        <p className="muted small grow" style={{ margin: 0 }}>Cada etiqueta tiene una regla: los negocios (o contactos, empresas, pedidos) que la cumplen la muestran solos, sin cargarla a mano.</p>
        {admin && <button className="btn primary" onClick={() => setEdit({ name: '', color: TAG_COLORS[0], object_type: 'deal', description: '', rule: { groups: [[]], pipelines: [] } })}>Crear etiqueta</button>}
      </div>
      <div className="panel">
        {(meta.tags ?? []).map((t) => <TagRow key={t.id} t={t} onEdit={admin ? () => setEdit(t) : undefined} onDelete={admin ? async () => {
          if (!confirm(`¿Borrar la etiqueta «${t.name}»? Deja de verse en todos lados.`)) return;
          await http('DELETE', `/tags/${t.id}`); toast('Etiqueta borrada'); reload();
        } : undefined} />)}
        {!meta.tags?.length && <div className="panel-body muted">Todavía no hay etiquetas.</div>}
      </div>
      {edit && <TagEditor tag={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function TagRow({ t, onEdit, onDelete }: { t: Tag; onEdit?: () => void; onDelete?: () => void }) {
  const { meta } = useMeta();
  const count = useAsync(() => http<{ total: number }>('GET', `/records/${t.object_type}${qs({ limit: 1, groups: [[{ prop: '__tag', op: 'eq', value: String(t.id) }]] })}`), [t.id, JSON.stringify(t.rule)]);
  const pipes = t.rule.pipelines?.length ? t.rule.pipelines.map((id) => meta.pipelines.find((p) => p.id === id)?.label ?? id).join(', ') : 'Todos los pipelines';
  const rule = (t.rule.groups ?? []).map((g) => g.map((f) => describeFilter(meta, t.object_type, f)).join(' y ')).join(' — o — ');
  return (
    <div className="assoc-item" style={{ alignItems: 'center' }}>
      <TagChips meta={meta} ids={[t.id]} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="small"><b>{OBJECTS[t.object_type].plural}</b>{t.object_type === 'deal' ? ` · ${pipes}` : ''}</div>
        <div className="small muted">{rule || 'Sin regla'}{t.description ? ` · ${t.description}` : ''}</div>
      </div>
      <span className="small muted num" style={{ whiteSpace: 'nowrap' }}>{count.data ? `${count.data.total.toLocaleString('es-AR')} con la etiqueta` : ''}</span>
      {onEdit && <button className="btn sm" onClick={onEdit}>Editar</button>}
      {onDelete && <button className="btn sm ghost danger" onClick={onDelete}>Borrar</button>}
    </div>
  );
}

function TagEditor({ tag, onClose, onSaved }: { tag: Partial<Tag>; onClose: () => void; onSaved: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [t, setT] = useState<Partial<Tag>>(tag);
  const type = (t.object_type ?? 'deal') as ObjectType;
  const groups: Filter[][] = t.rule?.groups?.length ? t.rule.groups : [[]];
  const first = filterableProps(meta, type).find((p) => p.name !== '__tag')!;
  const blank = (): Filter => ({ prop: first.name, op: opsFor(first)[0][0] });
  const setGroups = (g: Filter[][]) => setT((x) => ({ ...x, rule: { ...x.rule, groups: g } }));
  return (
    <Modal title={tag.id ? `Etiqueta «${tag.name}»` : 'Nueva etiqueta'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={!t.name?.trim()} onClick={async () => {
        try {
          const body = { name: t.name, color: t.color, object_type: type, description: t.description, rule: { groups: groups.map((g) => g.filter((f) => f.prop)).filter((g) => g.length), pipelines: type === 'deal' ? t.rule?.pipelines ?? [] : [] } };
          await http(tag.id ? 'PUT' : 'POST', tag.id ? `/tags/${tag.id}` : '/tags', body);
          toast('Etiqueta guardada'); onSaved();
        } catch (e) { toast((e as Error).message, true); }
      }}>Guardar</button>
    </>}>
      <div className="row wrap">
        <label className="field" style={{ flex: 2 }}>Nombre<input className="input" autoFocus value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>De
          <Select className="input" value={type} onChange={(e) => setT({ ...t, object_type: e.target.value as ObjectType, rule: { groups: [[]], pipelines: [] } })}>
            {(['deal', 'company', 'contact', 'order'] as ObjectType[]).map((o) => <option key={o} value={o}>{OBJECTS[o].plural}</option>)}
          </Select>
        </label>
      </div>
      <div className="field">Color
        <div className="row wrap" style={{ gap: 6 }}>
          {TAG_COLORS.map((c) => <button key={c} type="button" aria-label={`Color ${c}`} className={`swatch${t.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setT({ ...t, color: c })} />)}
          <span className="tag-chip" style={{ '--tag': t.color } as CSSProperties}>{t.name || 'Vista previa'}</span>
        </div>
      </div>
      {type === 'deal' && (
        <div className="field">Pipelines (vacío = todos)
          <MultiPick options={meta.pipelines.map((p) => ({ value: p.id, label: p.label }))} values={t.rule?.pipelines ?? []} onChange={(v) => setT({ ...t, rule: { ...t.rule, pipelines: v } })} />
        </div>
      )}
      <div className="field">Regla: se pone a los que cumplen
        {groups.map((g, gi) => (
          <div key={gi} className="panel" style={{ marginTop: 6 }}>
            <div className="panel-body stack">
              {gi > 0 && <b className="small">o bien</b>}
              {g.map((f, fi) => (
                <FilterRow key={fi} type={type} f={f} onChange={(nf) => setGroups(groups.map((gg, i) => i === gi ? gg.map((x, j) => j === fi ? nf : x) : gg))}
                  onRemove={() => setGroups(groups.map((gg, i) => i === gi ? gg.filter((_, j) => j !== fi) : gg))} />
              ))}
              <div className="row">
                <button className="btn sm" onClick={() => setGroups(groups.map((gg, i) => i === gi ? [...gg, blank()] : gg))}>+ Agregar filtro (y)</button>
                {gi === groups.length - 1 && <button className="btn sm ghost" onClick={() => setGroups([...groups, [blank()]])}>+ Otro grupo (o)</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <label className="field">Descripción<input className="input" value={t.description ?? ''} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder="Para qué sirve o de dónde sale" /></label>
    </Modal>
  );
}
