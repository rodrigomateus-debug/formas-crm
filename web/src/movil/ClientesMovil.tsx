import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useDebounced, Icon, Cargando, fmtRelative, fmtMoney, formatValue, propOf, recordUrl, stageOf, whatsappUrl, ACTIVITY_LABEL,
  type Activity, type CrmRecord, type ObjectType, type Property,
} from '../lib';
import { Avatar, PropertyInput } from '../components';
import { keyPropsFor } from '../pages/RecordPage';
import type { DestinoOpcion } from '../pages/Recorridos';
import { Hoja, TareaRapida } from './Movil';

// Clientes en el celular (versión celular, fase 2): empresas y contactos como tarjetas, una ficha con lo que se usa en la
// calle (Llamar · WhatsApp · Mail · Cómo llegar, registrar lo que pasó, una tarea, un encargo) y un alta corta. La ficha
// completa, con todos los datos y las tarjetas de escritorio, sigue en la versión completa.

type Tipo = 'company' | 'contact';
type Con = CrmRecord & { company?: { id: number; name: string } | null };
type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;

const tel = (v: unknown) => { const d = String(v ?? '').replace(/[^\d+]/g, ''); return d.length >= 6 ? `tel:${d}` : undefined; };
const mapa = (r: CrmRecord) => {
  const dir = [r.props.address, r.props.city].filter(Boolean).join(', ');
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : undefined;
};
const telDe = (r: CrmRecord) => r.props.mobilephone || r.props.phone;
const sinHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- Lista ----------

const PAGINA = 30;
export function ClientesLista({ tipo }: { tipo: Tipo }) {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [mios, setMios] = useState(true);
  const [lista, setLista] = useState<Con[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasta, setHasta] = useState(PAGINA);
  const [alta, setAlta] = useState(false);
  useEffect(() => { setHasta(PAGINA); }, [tipo, dq, mios]);
  useEffect(() => {
    let vivo = true;
    const filters = [{ prop: '__relacion', op: 'in', values: ['cliente'] }, ...(mios ? [{ prop: 'owner_id', op: 'eq', value: meta.me.id }] : [])];
    http<{ results: Con[]; total: number }>('GET', `/records/${tipo}${qs({ q: dq.trim() || undefined, filters, sort: 'notes_last_updated', dir: 'desc', limit: hasta, with: tipo === 'contact' ? 'company' : undefined })}`)
      .then((r) => { if (vivo) { setLista(r.results); setTotal(r.total); } }, () => { if (vivo) setLista([]); });
    return () => { vivo = false; };
  }, [tipo, dq, mios, hasta, meta.me.id]);
  const palabra = tipo === 'company' ? 'empresas' : 'contactos';
  return (
    <div className="m-pag">
      <div className="m-seg" role="tablist" aria-label="Clientes">
        <NavLink to="/companies" role="tab" className="m-seg-op">Empresas</NavLink>
        <NavLink to="/contacts" role="tab" className="m-seg-op">Contactos</NavLink>
      </div>
      <div className="search"><Icon name="search" />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tipo === 'company' ? 'Nombre, dominio, CUIT…' : 'Nombre, mail, teléfono…'} aria-label={`Buscar ${palabra}`} />
      </div>
      <div className="m-fila">
        <div className="m-chips" role="group" aria-label="De quién">
          <button type="button" className={`chip${mios ? ' on' : ''}`} aria-pressed={mios} onClick={() => setMios(true)}>Míos</button>
          <button type="button" className={`chip${!mios ? ' on' : ''}`} aria-pressed={!mios} onClick={() => setMios(false)}>Todos los que veo</button>
        </div>
        <span className="grow" />
        <button type="button" className="m-link" onClick={() => setAlta(true)}><Icon name="plus" size={14} />{tipo === 'company' ? 'Empresa' : 'Contacto'}</button>
      </div>
      {!lista && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{dq ? `No hay ${palabra} con «${dq}».` : mios ? `Todavía no tenés ${palabra} a tu nombre.` : `No hay ${palabra}.`}</div>}
      {lista && lista.length > 0 && (
        <div className="m-sec">
          {lista.map((r) => <TarjetaCliente key={r.id} tipo={tipo} r={r} />)}
          {total > lista.length && <button type="button" className="m-ver" onClick={() => setHasta((h) => h + PAGINA)}>Ver más ({total - lista.length})</button>}
        </div>
      )}
      {alta && <AltaCliente tipo={tipo} onClose={() => setAlta(false)} onCreado={(r) => navigate(recordUrl(tipo, r.id))} />}
    </div>
  );
}

function TarjetaCliente({ tipo, r }: { tipo: Tipo; r: Con }) {
  const { meta } = useMeta();
  const sub = tipo === 'contact'
    ? [r.props.jobtitle, r.company?.name].filter(Boolean).join(' · ') || r.props.email
    : [r.props.city, r.props.industry ? formatValue(meta, 'company', 'industry', r.props.industry) : null].filter(Boolean).join(' · ') || r.props.domain;
  const fono = telDe(r);
  return (
    <div className="m-item">
      <Link to={recordUrl(tipo, r.id)} className="m-item-cuerpo">
        <Avatar name={r.name} type={tipo} domain={r.props.domain} email={r.props.email} />
        <div className="m-item-txt"><b>{r.name}</b><small className="muted">{sub || (r.props.notes_last_updated ? `Actividad ${fmtRelative(r.props.notes_last_updated)}` : 'Sin datos')}</small></div>
      </Link>
      {fono && whatsappUrl(fono) && <a className="m-ico-btn wa" href={whatsappUrl(fono)} target="_blank" rel="noreferrer" aria-label={`WhatsApp a ${r.name}`}><Icon name="whatsapp" size={18} /></a>}
      {fono && tel(fono) && <a className="m-ico-btn" href={tel(fono)} aria-label={`Llamar a ${r.name}`}><Icon name="call" size={18} /></a>}
    </div>
  );
}

// ---------- Ficha ----------

export function FichaCliente({ tipo }: { tipo: Tipo }) {
  const { id = '0' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [datos, setDatos] = useState<{ record: CrmRecord; associations: Assoc; redirect?: number } | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [hoja, setHoja] = useState<null | 'registrar' | 'tarea' | 'contacto' | { editar: Property }>(null);
  const [todos, setTodos] = useState(false);
  useEffect(() => {
    http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/${tipo}/${id}`)
      .then((d) => { if (d.redirect) navigate(recordUrl(tipo, d.redirect), { replace: true }); else { setDatos(d); setError(''); } }, (e) => setError((e as Error).message));
  }, [tipo, id, version, navigate]);
  const cambio = () => setVersion((v) => v + 1);

  if (error) return <div className="m-pag"><div className="m-vacio m-vacio-solo">{error} <Link to={`/${tipo === 'company' ? 'companies' : 'contacts'}`}>Volver</Link></div></div>;
  if (!datos) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = datos;
  const empresa = tipo === 'contact' ? (a.company ?? []).find((c) => c.primary) ?? a.company?.[0] : undefined;
  const fono = telDe(r) || (empresa ? telDe(empresa) : undefined);
  const donde = mapa(r) ?? (empresa ? mapa(empresa) : undefined);
  const destino: DestinoOpcion | null = tipo === 'company' || empresa ? {
    tipo: 'empresa', key: `c:${tipo === 'company' ? r.id : empresa!.id}`, nombre: tipo === 'company' ? r.name : empresa!.name,
    direccion: [(tipo === 'company' ? r : empresa!).props.address, (tipo === 'company' ? r : empresa!).props.city].filter(Boolean).join(', ') || null,
    detalle: null, lugar_id: null, company_id: tipo === 'company' ? r.id : empresa!.id,
  } : null;

  const clave = keyPropsFor(meta, tipo).map((n) => propOf(meta, tipo, n)).filter((p): p is Property => !!p);
  const visibles = todos
    ? meta.properties.filter((p) => p.object_type === tipo && (r.props[p.name] != null && r.props[p.name] !== '' || clave.includes(p)))
    : clave;
  const negocios = [...(a.deal ?? [])].sort((x, y) => Number(!!stageOf(meta, x.props.dealstage)?.stage.is_closed) - Number(!!stageOf(meta, y.props.dealstage)?.stage.is_closed));

  return (
    <div className="m-pag m-ficha">
      <div className="m-ficha-cab">
        <Avatar name={r.name} type={tipo} size="lg" domain={r.props.domain} email={r.props.email} />
        <div className="m-ficha-tit">
          <h1>{r.name}</h1>
          <p className="muted">{tipo === 'contact'
            ? <>{r.props.jobtitle}{r.props.jobtitle && empresa ? ' · ' : ''}{empresa && <Link to={recordUrl('company', empresa.id)}>{empresa.name}</Link>}</>
            : [r.props.city, r.props.domain].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      <div className="m-acciones">
        <Accion icono="call" texto="Llamar" href={tel(fono)} />
        <Accion icono="whatsapp" texto="WhatsApp" href={whatsappUrl(fono)} nueva />
        <Accion icono="email" texto="Mail" href={r.props.email ? `mailto:${r.props.email}` : undefined} />
        <Accion icono="pin" texto="Cómo llegar" href={donde} nueva />
      </div>

      <div className="m-rapidas">
        <button type="button" className="btn" onClick={() => setHoja('registrar')}><Icon name="note" size={16} />Registrar</button>
        <button type="button" className="btn" onClick={() => setHoja('tarea')}><Icon name="task" size={16} />Tarea</button>
        {destino && <button type="button" className="btn" onClick={() => navigate('/recorridos/nuevo', { state: { destino } })}><Icon name="route" size={16} />Encargo</button>}
      </div>

      <section className="m-sec">
        <div className="m-sec-cab"><h2>Datos</h2></div>
        <dl className="m-datos">
          {visibles.map((p) => {
            const v = r.props[p.name];
            const vacio = v == null || v === '';
            const editable = !p.read_only && meta.me.role !== 'viewer';
            return (
              <button key={p.name} type="button" className="m-dato" disabled={!editable} onClick={() => setHoja({ editar: p })}>
                <dt>{p.label}</dt>
                <dd className={vacio ? 'muted' : ''}>{vacio ? (editable ? 'Agregar' : '—') : formatValue(meta, tipo, p.name, v, r.props)}</dd>
              </button>
            );
          })}
        </dl>
        <button type="button" className="m-ver" onClick={() => setTodos(!todos)}>{todos ? 'Ver solo los principales' : 'Ver todos los datos cargados'}</button>
      </section>

      {tipo === 'company' && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Contactos</h2><span className="muted small">{a.contact?.length || ''}</span><span className="grow" />
            <button type="button" className="m-link" onClick={() => setHoja('contacto')} aria-label="Agregar contacto"><Icon name="plus" size={14} />Agregar</button></div>
          {!a.contact?.length && <div className="m-vacio">Sin contactos todavía.</div>}
          {a.contact?.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
        </section>
      )}
      {tipo === 'contact' && (a.company?.length ?? 0) > 1 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Empresas</h2></div>
          {a.company.map((c) => <TarjetaCliente key={c.id} tipo="company" r={c} />)}
        </section>
      )}

      <section className="m-sec">
        <div className="m-sec-cab"><h2>Negocios</h2><span className="muted small">{negocios.length || ''}</span></div>
        {!negocios.length && <div className="m-vacio">Sin negocios.</div>}
        {negocios.slice(0, 8).map((d) => {
          const etapa = stageOf(meta, d.props.dealstage)?.stage;
          return (
            <Link key={d.id} to={recordUrl('deal', d.id)} className="m-item m-item-link">
              <div className="m-item-txt"><b>{d.name}</b><small className={etapa?.is_closed ? 'muted' : ''}>{etapa?.label ?? 'Sin etapa'}</small></div>
              <span className="num small">{fmtMoney(d.props.amount)}</span>
            </Link>
          );
        })}
      </section>

      {(a.order?.length ?? 0) > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Pedidos</h2><span className="muted small">{a.order.length}</span></div>
          {a.order.slice(0, 8).map((o) => (
            <Link key={o.id} to={recordUrl('order', o.id)} className="m-item m-item-link">
              <div className="m-item-txt"><b>{o.name}</b><small className="muted">{formatValue(meta, 'order', 'hs_pipeline_stage', o.props.hs_pipeline_stage) || 'Sin estado'}</small></div>
            </Link>
          ))}
        </section>
      )}

      <Actividad tipo={tipo} id={r.id} version={version} />

      {hoja === 'registrar' && <Registrar record={r} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'tarea' && <TareaRapida linkId={r.id} sobre={r.name} onClose={() => setHoja(null)} onCreada={cambio} />}
      {hoja === 'contacto' && <AltaCliente tipo="contact" empresa={{ id: r.id, name: r.name }} onClose={() => setHoja(null)} onCreado={() => cambio()} />}
      {hoja && typeof hoja === 'object' && <EditarDato tipo={tipo} record={r} prop={hoja.editar} onClose={() => setHoja(null)} onListo={cambio} />}
    </div>
  );
}

function Accion({ icono, texto, href, nueva }: { icono: string; texto: string; href?: string; nueva?: boolean }) {
  if (!href) return <span className="m-accion off" aria-disabled="true" title={`Sin ${texto === 'Mail' ? 'mail' : texto === 'Cómo llegar' ? 'dirección' : 'teléfono'} cargado`}><span><Icon name={icono} size={20} /></span>{texto}</span>;
  return <a className={`m-accion${icono === 'whatsapp' ? ' wa' : ''}`} href={href} {...(nueva ? { target: '_blank', rel: 'noreferrer' } : {})}><span><Icon name={icono} size={20} /></span>{texto}</a>;
}

// Lo último que pasó con el cliente: notas, llamadas, mails, reuniones, WhatsApp y tareas.
function Actividad({ tipo, id, version }: { tipo: Tipo; id: number; version: number }) {
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [cuantas, setCuantas] = useState(10);
  useEffect(() => {
    http<{ activities: Activity[] }>('GET', `/records/${tipo}/${id}/timeline${qs({ limit: cuantas })}`).then((r) => setActs(r.activities), () => setActs([]));
  }, [tipo, id, version, cuantas]);
  return (
    <section className="m-sec">
      <div className="m-sec-cab"><h2>Actividad</h2></div>
      {!acts && <Cargando chico />}
      {acts && !acts.length && <div className="m-vacio">Todavía no hay nada registrado.</div>}
      {acts?.map((x) => {
        const texto = sinHtml(x.body || '');
        const hecha = x.type === 'task' && x.status === 'COMPLETED';
        return (
          <div key={x.id} className="m-act">
            <span className={`m-act-ico t-${x.type}`}><Icon name={x.type} size={15} /></span>
            <div className="m-item-txt">
              <b className={hecha ? 'tachada' : ''}>{x.subject || ACTIVITY_LABEL[x.type]}</b>
              {texto && <p className="m-act-txt">{texto}</p>}
              <small className="muted">{ACTIVITY_LABEL[x.type]} · {fmtRelative(x.type === 'task' ? x.due_at ?? x.occurred_at : x.occurred_at)}</small>
            </div>
          </div>
        );
      })}
      {acts && acts.length >= cuantas && <button type="button" className="m-ver" onClick={() => setCuantas((n) => n + 20)}>Ver más</button>}
    </section>
  );
}

// ---------- Hojas ----------

const TIPOS_REG: Array<[Activity['type'], string]> = [['note', 'Nota'], ['call', 'Llamada'], ['whatsapp', 'WhatsApp'], ['meeting', 'Reunión'], ['email', 'Mail']];
const RESULTADOS = ['Conectada', 'Sin respuesta', 'Dejé mensaje', 'Ocupado', 'Número equivocado'];

function Registrar({ record, onClose, onListo }: { record: CrmRecord; onClose: () => void; onListo: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [tipo, setTipo] = useState<Activity['type']>('note');
  const [texto, setTexto] = useState('');
  const [resultado, setResultado] = useState(RESULTADOS[0]);
  const [ocupado, setOcupado] = useState(false);
  async function guardar() {
    if (!texto.trim() && tipo !== 'call') return;
    setOcupado(true);
    try {
      await http('POST', '/activities', {
        type: tipo, body: texto.trim(), subject: tipo === 'meeting' ? `Reunión con ${record.name}` : tipo === 'email' ? `Mail con ${record.name}` : '',
        occurred_at: new Date().toISOString(), owner_id: meta.me.id, direction: ['call', 'whatsapp', 'email'].includes(tipo) ? 'out' : undefined,
        outcome: tipo === 'call' ? resultado : undefined, links: [record.id],
      });
      toast(`${ACTIVITY_LABEL[tipo]} registrada`);
      onListo(); onClose();
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  return (
    <Hoja titulo={`Registrar en ${record.name}`} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <div className="m-chips" role="group" aria-label="Qué fue">
          {TIPOS_REG.map(([k, l]) => <button key={k} type="button" className={`chip${tipo === k ? ' on' : ''}`} aria-pressed={tipo === k} onClick={() => setTipo(k)}>{l}</button>)}
        </div>
        {tipo === 'call' && (
          <div className="m-chips" role="group" aria-label="Cómo salió">
            {RESULTADOS.map((x) => <button key={x} type="button" className={`chip sm${resultado === x ? ' on' : ''}`} aria-pressed={resultado === x} onClick={() => setResultado(x)}>{x}</button>)}
          </div>
        )}
        <textarea className="input" rows={4} autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Qué pasó"
          placeholder={tipo === 'call' ? '¿De qué hablaron? (opcional)' : tipo === 'meeting' ? 'Qué se habló, próximos pasos…' : 'Qué pasó, qué quedó pendiente…'} />
        <button type="submit" className="btn primary m-grande" disabled={ocupado || (!texto.trim() && tipo !== 'call')}>Guardar</button>
      </form>
    </Hoja>
  );
}

function EditarDato({ tipo, record, prop, onClose, onListo }: { tipo: Tipo; record: CrmRecord; prop: Property; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const [valor, setValor] = useState<unknown>(record.props[prop.name] ?? '');
  const [ocupado, setOcupado] = useState(false);
  async function guardar() {
    setOcupado(true);
    try { await http('PATCH', `/records/${tipo}/${record.id}`, { props: { [prop.name]: valor === '' ? null : valor } }); toast('Guardado'); onListo(); onClose(); }
    catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  return (
    <Hoja titulo={prop.label} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <PropertyInput prop={prop} value={valor} onChange={setValor} type={tipo} autoFocus />
        <button type="submit" className="btn primary m-grande" disabled={ocupado}>Guardar</button>
      </form>
    </Hoja>
  );
}

// Alta corta: lo mínimo para no perder a alguien que conociste. El resto se completa después.
export function AltaCliente({ tipo, empresa, onClose, onCreado }: { tipo: Tipo; empresa?: { id: number; name: string }; onClose: () => void; onCreado?: (r: CrmRecord) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState<Record<string, string>>({});
  const [emp, setEmp] = useState<{ id: number; name: string } | null>(empresa ?? null);
  const [ocupado, setOcupado] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  // Los obligatorios que el CRM pide además de los de acá (en contactos, el canal de contacto): se piden siempre.
  const propios = tipo === 'company' ? ['name', 'domain', 'phone', 'address', 'city'] : ['firstname', 'lastname', 'mobilephone', 'email', 'jobtitle'];
  const requeridas = meta.properties.filter((p) => p.object_type === tipo && p.required && !p.read_only && !propios.includes(p.name) && p.name !== 'owner_id');
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const falta = requeridas.some((p) => extra[p.name] == null || extra[p.name] === '');
  const listo = !falta && (tipo === 'company' ? !!f.name?.trim() : !!(f.firstname?.trim() || f.lastname?.trim() || f.email?.trim()));
  async function crear() {
    if (!listo) return;
    setOcupado(true);
    const props = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    try {
      const r = await http<CrmRecord>('POST', `/records/${tipo}`, { props: { ...props, ...extra, owner_id: meta.me.id }, associations: emp ? [emp.id] : [] });
      toast(`${tipo === 'company' ? 'Empresa' : 'Contacto'} creado`);
      onClose();
      if (onCreado) onCreado(r); else navigate(recordUrl(tipo, r.id));
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  return (
    <Hoja titulo={tipo === 'company' ? 'Nueva empresa' : 'Nuevo contacto'} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); crear(); }}>
        {tipo === 'company' ? <>
          <label className="field">Nombre<input className="input" autoFocus value={f.name ?? ''} onChange={set('name')} placeholder="Razón social o nombre de fantasía" /></label>
          <label className="field">Sitio web<input className="input" inputMode="url" autoCapitalize="none" value={f.domain ?? ''} onChange={set('domain')} placeholder="empresa.com.ar" /></label>
          <label className="field">Teléfono<input className="input" type="tel" value={f.phone ?? ''} onChange={set('phone')} /></label>
          <label className="field">Dirección<input className="input" value={f.address ?? ''} onChange={set('address')} placeholder="Calle y altura" /></label>
          <label className="field">Ciudad<input className="input" value={f.city ?? ''} onChange={set('city')} /></label>
        </> : <>
          <div className="m-2">
            <label className="field">Nombre<input className="input" autoFocus value={f.firstname ?? ''} onChange={set('firstname')} autoComplete="off" /></label>
            <label className="field">Apellido<input className="input" value={f.lastname ?? ''} onChange={set('lastname')} autoComplete="off" /></label>
          </div>
          <label className="field">Celular<input className="input" type="tel" value={f.mobilephone ?? ''} onChange={set('mobilephone')} placeholder="11 5555 5555" /></label>
          <label className="field">Mail<input className="input" type="email" autoCapitalize="none" value={f.email ?? ''} onChange={set('email')} /></label>
          <label className="field">Cargo<input className="input" value={f.jobtitle ?? ''} onChange={set('jobtitle')} placeholder="Compras, Marketing, RR. HH.…" /></label>
          {empresa ? <div className="small muted">Va en {empresa.name}.</div> : <ElegirEmpresa valor={emp} onElegir={setEmp} />}
        </>}
        {requeridas.map((p) => (
          <div key={p.name} className="field">{p.label}
            {p.type === 'enum' && p.options.length <= 16
              ? <div className="m-chips" role="group" aria-label={p.label}>{p.options.map((o) => (
                <button key={o.value} type="button" className={`chip sm${extra[p.name] === o.value ? ' on' : ''}`} aria-pressed={extra[p.name] === o.value} onClick={() => setExtra((x) => ({ ...x, [p.name]: o.value }))}>{o.label}</button>))}</div>
              : <PropertyInput prop={p} value={extra[p.name] ?? ''} onChange={(v) => setExtra((x) => ({ ...x, [p.name]: v }))} type={tipo} />}
          </div>
        ))}
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !listo}>Crear {tipo === 'company' ? 'empresa' : 'contacto'}</button>
      </form>
    </Hoja>
  );
}

function ElegirEmpresa({ valor, onElegir }: { valor: { id: number; name: string } | null; onElegir: (e: { id: number; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [res, setRes] = useState<CrmRecord[]>([]);
  useEffect(() => {
    if (dq.trim().length < 2) { setRes([]); return; }
    http<{ results: CrmRecord[] }>('GET', `/records/company${qs({ q: dq, limit: 6 })}`).then((r) => setRes(r.results), () => setRes([]));
  }, [dq]);
  const opciones = useMemo(() => res.filter((r) => r.id !== valor?.id), [res, valor]);
  if (valor) return <div className="m-elegida"><span className="small muted">Empresa</span><b>{valor.name}</b><button type="button" className="m-link" onClick={() => onElegir(null)}>Cambiar</button></div>;
  return (
    <div className="field">Empresa
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscá la empresa (opcional)" aria-label="Empresa" />
      {opciones.length > 0 && <div className="m-opciones">{opciones.map((r) => <button key={r.id} type="button" onClick={() => { onElegir({ id: r.id, name: r.name }); setQ(''); }}>{r.name}</button>)}</div>}
    </div>
  );
}
