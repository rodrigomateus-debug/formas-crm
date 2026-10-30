import { useState } from 'react';
import { http, useMeta, useToast, useAsync, propsOf, OBJECTS, fmtDate, type ObjectType, type Option, type Pipeline, type Property } from '../lib';
import { Modal } from '../components';

const TABS: Array<[string, string]> = [['users', 'Usuarios'], ['properties', 'Propiedades'], ['pipelines', 'Pipelines'], ['integrations', 'Integraciones y Claude'], ['inbound', 'Registro de entradas']];
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
      {tab === 'integrations' && <Integrations />}
      {tab === 'inbound' && <Inbound />}
    </div>
  );
}

function Users() {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const users = useAsync(() => http<Array<{ id: number; email: string; name: string; role: string; team_id: number | null; active: number; hs_owner_id: string | null }>>('GET', '/users'), []);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ email: '', name: '', role: 'member', team_id: '' });
  const patch = async (id: number, body: Record<string, unknown>) => {
    try { await http('PATCH', `/users/${id}`, body); users.reload(); reload(); toast('Guardado'); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="toolbar"><span className="muted small grow">Entran con su mail de Formas por Cloudflare Access. Quien entra por primera vez queda como «Miembro».</span>
        <button className="btn primary" onClick={() => setAdd(true)}>Agregar usuario</button></div>
      <div className="table-wrap"><table className="grid">
        <thead><tr><th className="nosort">Nombre</th><th className="nosort">Email</th><th className="nosort">Rol</th><th className="nosort">Equipo</th><th className="nosort">Id</th><th className="nosort">Activo</th></tr></thead>
        <tbody>{users.data?.map((u) => (
          <tr key={u.id}>
            <td>{u.name}</td><td>{u.email}</td>
            <td><select className="input" style={{ height: 30 }} value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
              <option value="admin">Administrador</option><option value="manager">Gerente</option><option value="member">Miembro</option><option value="viewer">Solo lectura</option></select></td>
            <td><select className="input" style={{ height: 30 }} value={u.team_id ?? ''} onChange={(e) => patch(u.id, { team_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></td>
            <td className="muted small">{u.id}</td>
            <td><input type="checkbox" checked={!!u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} aria-label="Activo" /></td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">Roles: Administrador ve y cambia todo, incluida esta configuración. Gerente puede además borrar y restaurar registros. Miembro crea y edita. Solo lectura no cambia nada.</p>
      {add && <Modal title="Agregar usuario" onClose={() => setAdd(false)} footer={<button className="btn primary" onClick={async () => {
        try { await http('POST', '/users', { ...f, team_id: f.team_id ? Number(f.team_id) : null }); setAdd(false); users.reload(); reload(); toast('Usuario agregado'); } catch (e) { toast((e as Error).message, true); }
      }}>Agregar</button>}>
        <label className="field">Nombre<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Email<input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field">Rol<select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="member">Miembro</option><option value="manager">Gerente</option><option value="admin">Administrador</option><option value="viewer">Solo lectura</option></select></label>
        <label className="field">Equipo<select className="input" value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}><option value="">—</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
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
        <select className="input" style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value as ObjectType)}>{(Object.keys(OBJECTS) as ObjectType[]).map((t) => <option key={t} value={t}>{OBJECTS[t].plural}</option>)}</select>
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
      <label className="field">Tipo<select className="input" disabled={!!prop} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
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

function Pipelines() {
  const { meta, reload } = useMeta();
  const toast = useToast();
  const [sel, setSel] = useState<Pipeline | null>(null);
  const [draft, setDraft] = useState<Pipeline | null>(null);
  const open = (p: Pipeline) => { setSel(p); setDraft(JSON.parse(JSON.stringify(p))); };
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-head"><h2>Pipelines de negocios</h2>
          <button className="btn sm" onClick={async () => {
            const label = prompt('Nombre del pipeline nuevo');
            if (!label) return;
            await http('POST', '/pipelines', { label, stages: [{ label: 'Nueva oportunidad', probability: 0.1 }, { label: 'Cierre ganado', probability: 1, is_closed: true, is_won: true }, { label: 'Cierre perdido', probability: 0, is_closed: true }] });
            reload(); toast('Pipeline creado');
          }}>+ Pipeline</button></div>
        {meta.pipelines.map((p) => (
          <div key={p.id} className="assoc-item" style={{ cursor: 'pointer', background: sel?.id === p.id ? 'var(--sunken)' : undefined }} onClick={() => open(p)}>
            <div className="grow"><b>{p.label}</b><div className="small muted">{p.stages.length} etapas · {meta.teams.find((t) => t.id === p.team_id)?.name ?? 'sin equipo'}</div></div>
          </div>
        ))}
      </div>
      {draft && (
        <div className="panel">
          <div className="panel-head"><h2>Etapas</h2><button className="btn sm primary" onClick={async () => {
            try { await http('PUT', `/pipelines/${draft.id}`, { label: draft.label, team_id: draft.team_id, stages: draft.stages }); reload(); toast('Pipeline guardado'); } catch (e) { toast((e as Error).message, true); }
          }}>Guardar</button></div>
          <div className="panel-body stack">
            <label className="field">Nombre<input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label className="field">Equipo<select className="input" value={draft.team_id ?? ''} onChange={(e) => setDraft({ ...draft, team_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            {draft.stages.map((s, i) => (
              <div key={s.id ?? i} className="row">
                <input className="input" value={s.label} onChange={(e) => setDraft({ ...draft, stages: draft.stages.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
                <input className="input num" style={{ width: 70 }} type="number" min={0} max={100} value={Math.round(s.probability * 100)} title="Probabilidad %" onChange={(e) => setDraft({ ...draft, stages: draft.stages.map((x, j) => j === i ? { ...x, probability: Number(e.target.value) / 100 } : x) })} />
                <select className="input" style={{ width: 120 }} value={s.is_closed ? (s.is_won ? 'won' : 'lost') : 'open'} onChange={(e) => setDraft({ ...draft, stages: draft.stages.map((x, j) => j === i ? { ...x, is_closed: e.target.value === 'open' ? 0 : 1, is_won: e.target.value === 'won' ? 1 : 0 } : x) })}>
                  <option value="open">Abierta</option><option value="won">Ganada</option><option value="lost">Perdida</option></select>
                <button className="btn ghost sm" disabled={i === 0} onClick={() => { const st = [...draft.stages]; [st[i - 1], st[i]] = [st[i], st[i - 1]]; setDraft({ ...draft, stages: st }); }}>↑</button>
              </div>
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft({ ...draft, stages: [...draft.stages, { id: '', pipeline_id: draft.id, label: 'Nueva etapa', display_order: draft.stages.length, probability: 0.5, is_closed: 0, is_won: 0 }] })}>+ Etapa</button>
            <p className="muted small" style={{ margin: 0 }}>Los ids de etapa no cambian al renombrar, así los tableros y la historia siguen funcionando.</p>
          </div>
        </div>
      )}
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
      <div className="panel"><div className="panel-head"><h2>Claude (MCP)</h2></div><div className="panel-body stack">
        <p style={{ margin: 0 }}>Para que Claude y Cowork lean y actualicen el CRM: creá un token de tipo «Claude (MCP)» y cargá esta URL como conector personalizado en claude.ai (Configuración → Conectores → Agregar conector personalizado):</p>
        <code className="panel panel-body small">{origin}/mcp/&lt;token&gt;</code>
        <p className="muted small" style={{ margin: 0 }}>Herramientas: buscar, traer ficha con actividad, crear, actualizar, alta inteligente (contacto + empresa + negocio), asociar, registrar actividad, crear y listar tareas, combinar duplicados, reportes, propiedades, pipelines y usuarios. Todo queda en el historial con origen «mcp».</p>
      </div></div>
      <div className="panel"><div className="panel-head"><h2>Webhooks y API</h2></div><div className="panel-body stack small">
        <div><b>Darwin (WhatsApp, hoy por Pipedream):</b> <code>POST {origin}/hooks/darwin</code> con <code>Authorization: Bearer &lt;token&gt;</code>. Arma el negocio «Nombre - Producto - Cantidad - Darwin» en Formas Shop (Inbound) / Lead calificado.</div>
        <div><b>Zapier y cualquier integración:</b> <code>POST {origin}/hooks/bundle</code> con {'{ contact, company, deal, note, task, owner_email }'}. Busca antes de crear y asocia todo.</div>
        <div><b>Formularios web:</b> <code>POST {origin}/hooks/form/&lt;formulario&gt;</code> (público, se configura en la base).</div>
        <div><b>Tableros (compatibilidad HubSpot):</b> cambiar <code>https://api.hubapi.com</code> por <code>{origin}/hubspot</code> y usar un token de tipo «API».</div>
      </div></div>
      <div className="panel"><div className="panel-head"><h2>Tokens</h2></div><div className="panel-body stack">
        <div className="row wrap">
          <input className="input" style={{ width: 260 }} placeholder="Nombre (ej. Cowork Rodrigo)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select className="input" style={{ width: 200 }} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="mcp">Claude (MCP)</option><option value="darwin">Darwin</option><option value="zapier">Zapier</option><option value="api">API / tableros</option>
          </select>
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
