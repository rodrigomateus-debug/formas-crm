import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  http, qs, useMeta, useToast, useDebounced, Icon, Cargando, fmtRelative, fmtMoney, formatValue, propOf, recordUrl, stageOf, whatsappUrl, ACTIVITY_LABEL, keyPropsFor, userOf,
  type Activity, type CrmRecord, type ObjectType, type Property,
} from '../lib';
import { Avatar, PropertyInput } from '../components';
import type { DestinoOpcion } from '../pages/Recorridos';
import { Hoja, TareaRapida } from './Movil';
import { AltaNegocio } from './VentasMovil';
import { Fallo, useCarga, usePuedeEscribir } from './base';

// Clientes en el celular (versión celular, fase 2): empresas y contactos como tarjetas, una ficha con lo que se usa en la
// calle (Llamar · WhatsApp · Mail · Cómo llegar, registrar lo que pasó, una tarea, un encargo) y un alta corta. La ficha
// completa, con todos los datos y las tarjetas de escritorio, sigue en la versión completa.

type Tipo = 'company' | 'contact';
type Con = CrmRecord & { company?: { id: number; name: string } | null };
type Assoc = Record<ObjectType, Array<CrmRecord & { label: string | null; primary: boolean }>>;
type Ref = { id: number; name: string };

export const tel = (v: unknown) => { const d = String(v ?? '').replace(/[^\d+]/g, ''); return d.length >= 6 ? `tel:${d}` : undefined; };
const mapa = (r: CrmRecord) => {
  const dir = [r.props.address, r.props.city].filter(Boolean).join(', ');
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : undefined;
};
export const telDe = (r: CrmRecord) => r.props.mobilephone || r.props.phone;
const sinHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- «¿Cómo salió la llamada?» ----------

// Al tocar Llamar o WhatsApp se anota con quién; cuando la vendedora vuelve a la app (dentro de la media hora), se le
// pregunta cómo salió, con el tipo ya puesto: registrar una llamada pasa de 5 toques a 2 (revisión del 18/11/2026).
type Pendiente = { ref: Ref; tipo: 'call' | 'whatsapp'; at: number };
let pendiente: Pendiente | null = null;
const oyentesLlamada = new Set<(p: Pendiente) => void>();
export function marcarContacto(ref: Ref, tipo: 'call' | 'whatsapp') { pendiente = { ref, tipo, at: Date.now() }; }
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !pendiente) return;
    const p = pendiente;
    pendiente = null;
    if (Date.now() - p.at < 30 * 60_000) oyentesLlamada.forEach((f) => f(p));
  });
}
export function PreguntaLlamada() {
  const [p, setP] = useState<Pendiente | null>(null);
  useEffect(() => { oyentesLlamada.add(setP); return () => { oyentesLlamada.delete(setP); }; }, []);
  if (!p) return null;
  return <Registrar record={p.ref} tipoInicial={p.tipo} pregunta onClose={() => setP(null)} onListo={() => window.dispatchEvent(new Event('crm:actividad'))} />;
}

// ---------- Lista ----------

const PAGINA = 30;
export function ClientesLista({ tipo }: { tipo: Tipo }) {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const puede = usePuedeEscribir();
  // La búsqueda y «Míos/Todos» quedan en la dirección: al volver de una ficha siguen ahí.
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const mios = sp.get('todos') !== '1';
  const cambiar = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const [texto, setTexto] = useState(q);
  const dq = useDebounced(texto, 250);
  useEffect(() => { if (dq.trim() !== q) cambiar('q', dq.trim() || null); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hasta, setHasta] = useState(PAGINA);
  const [alta, setAlta] = useState(false);
  useEffect(() => { setHasta(PAGINA); }, [tipo, q, mios]);
  const carga = useCarga(() => {
    const filters = [{ prop: '__relacion', op: 'in', values: ['cliente'] }, ...(mios ? [{ prop: 'owner_id', op: 'eq', value: meta.me.id }] : [])];
    return http<{ results: Con[]; total: number }>('GET', `/records/${tipo}${qs({ q: q || undefined, filters, sort: 'notes_last_updated', dir: 'desc', limit: hasta, with: tipo === 'contact' ? 'company' : undefined })}`);
  }, [tipo, q, mios, hasta, meta.me.id]);
  const lista = carga.datos?.results ?? null;
  const total = carga.datos?.total ?? 0;
  const palabra = tipo === 'company' ? 'empresas' : 'contactos';
  const filtros = sp.toString() ? `?${sp}` : '';
  return (
    <div className="m-pag">
      <nav className="m-seg" aria-label="Empresas o contactos">
        <NavLink to={`/companies${filtros}`} className="m-seg-op">Empresas</NavLink>
        <NavLink to={`/contacts${filtros}`} className="m-seg-op">Contactos</NavLink>
      </nav>
      <div className="search"><Icon name="search" />
        <input className="input" type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={tipo === 'company' ? 'Nombre, dominio, CUIT…' : 'Nombre, mail, teléfono…'} aria-label={`Buscar ${palabra}`} enterKeyHint="search" />
      </div>
      <div className="m-fila">
        <div className="m-chips" role="group" aria-label="De quién">
          <button type="button" className={`chip${mios ? ' on' : ''}`} aria-pressed={mios} onClick={() => cambiar('todos', null)}>Míos</button>
          <button type="button" className={`chip${!mios ? ' on' : ''}`} aria-pressed={!mios} onClick={() => cambiar('todos', '1')}>Todos los que veo</button>
        </div>
        <span className="grow" />
        {puede && <button type="button" className="m-link" onClick={() => setAlta(true)}><Icon name="plus" size={14} />{tipo === 'company' ? 'Empresa' : 'Contacto'}</button>}
      </div>
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!lista && !carga.error && <Cargando />}
      {lista && !lista.length && <div className="m-vacio m-vacio-solo">{q ? `No hay ${palabra} con «${q}».` : mios ? `Todavía no tenés ${palabra} a tu nombre.` : `No hay ${palabra}.`}</div>}
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

export function TarjetaCliente({ tipo, r }: { tipo: Tipo; r: Con }) {
  const { meta } = useMeta();
  const sub = tipo === 'contact'
    ? [r.props.jobtitle, r.company?.name].filter(Boolean).join(' · ') || r.props.email
    : [r.props.city, r.props.industry ? formatValue(meta, 'company', 'industry', r.props.industry) : null].filter(Boolean).join(' · ') || r.props.domain;
  const fono = telDe(r);
  const ref = { id: r.id, name: r.name };
  return (
    <div className="m-item">
      <Link to={recordUrl(tipo, r.id)} className="m-item-cuerpo">
        <Avatar name={r.name} type={tipo} domain={r.props.domain} email={r.props.email} />
        <div className="m-item-txt"><b>{r.name}</b><small className="muted">{sub || (r.props.notes_last_updated ? `Actividad ${fmtRelative(r.props.notes_last_updated)}` : 'Sin datos')}</small></div>
      </Link>
      {fono && whatsappUrl(fono) && <a className="m-ico-btn wa" href={whatsappUrl(fono)} target="_blank" rel="noreferrer" aria-label={`WhatsApp a ${r.name}`} onClick={() => marcarContacto(ref, 'whatsapp')}><Icon name="whatsapp" size={18} /></a>}
      {fono && tel(fono) && <a className="m-ico-btn" href={tel(fono)} aria-label={`Llamar a ${r.name}`} onClick={() => marcarContacto(ref, 'call')}><Icon name="call" size={18} /></a>}
    </div>
  );
}

// ---------- Ficha ----------

export function FichaCliente({ tipo }: { tipo: Tipo }) {
  const { id = '0' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const puede = usePuedeEscribir();
  const carga = useCarga(() => http<{ record: CrmRecord; associations: Assoc; redirect?: number }>('GET', `/records/${tipo}/${id}`), [tipo, id]);
  const [hoja, setHoja] = useState<null | 'registrar' | 'tarea' | 'contacto' | 'negocio' | { editar: Property }>(null);
  const [todos, setTodos] = useState(false);
  const [version, setVersion] = useState(0);
  const cambio = () => { carga.recargar(); setVersion((v) => v + 1); };
  // Se registró algo desde «¿Cómo salió la llamada?»: la actividad se actualiza.
  useEffect(() => { const h = () => setVersion((v) => v + 1); window.addEventListener('crm:actividad', h); return () => window.removeEventListener('crm:actividad', h); }, []);
  useEffect(() => { if (carga.datos?.redirect) navigate(recordUrl(tipo, carga.datos.redirect), { replace: true }); }, [carga.datos, navigate, tipo]);

  if (carga.error) return <div className="m-pag"><Fallo error={carga.error} onReintentar={carga.recargar} /></div>;
  if (!carga.datos?.record) return <div className="m-pag"><Cargando /></div>;
  const { record: r, associations: a } = carga.datos;
  const ref = { id: r.id, name: r.name };
  const empresa = tipo === 'contact' ? (a.company ?? []).find((c) => c.primary) ?? a.company?.[0] : undefined;
  const fono = telDe(r) || (empresa ? telDe(empresa) : undefined);
  const donde = mapa(r) ?? (empresa ? mapa(empresa) : undefined);
  const lugar = tipo === 'company' ? r : empresa;
  const destino: DestinoOpcion | null = lugar ? {
    tipo: 'empresa', key: `c:${lugar.id}`, nombre: lugar.name, direccion: [lugar.props.address, lugar.props.city].filter(Boolean).join(', ') || null,
    detalle: null, lugar_id: null, company_id: lugar.id,
    contacto: tipo === 'contact' ? [r.name, telDe(r)].filter(Boolean).join(' ') : null,
  } : null;
  const negocios = [...(a.deal ?? [])].sort((x, y) => Number(!!stageOf(meta, x.props.dealstage)?.stage.is_closed) - Number(!!stageOf(meta, y.props.dealstage)?.stage.is_closed));

  return (
    <div className="m-pag m-ficha">
      <div className="m-ficha-cab">
        <Avatar name={r.name} type={tipo} size="lg" domain={r.props.domain} email={r.props.email} />
        <div className="m-ficha-tit">
          <h1>{r.name}</h1>
          <p className="muted">{tipo === 'contact'
            ? <>{r.props.jobtitle}{r.props.jobtitle && empresa ? ' · ' : ''}{empresa && <Link to={recordUrl('company', empresa.id)} className="m-link-empresa">{empresa.name}</Link>}</>
            : [r.props.city, r.props.domain].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      <div className="m-acciones">
        <Accion icono="call" texto="Llamar" falta="Sin teléfono" href={tel(fono)} onClick={() => marcarContacto(ref, 'call')} />
        <Accion icono="whatsapp" texto="WhatsApp" falta="Sin celular" href={whatsappUrl(fono)} nueva onClick={() => marcarContacto(ref, 'whatsapp')} />
        <Accion icono="email" texto="Mail" falta="Sin mail" href={r.props.email ? `mailto:${r.props.email}` : undefined} />
        <Accion icono="pin" texto="Cómo llegar" falta="Sin dirección" href={donde} nueva />
      </div>

      {puede && (
        <div className="m-rapidas">
          <button type="button" className="btn" onClick={() => setHoja('registrar')}><Icon name="note" size={16} />Registrar</button>
          <button type="button" className="btn" onClick={() => setHoja('tarea')}><Icon name="task" size={16} />Tarea</button>
          {destino && <button type="button" className="btn" onClick={() => navigate('/recorridos/nuevo', { state: { destino } })}><Icon name="route" size={16} />Encargo</button>}
        </div>
      )}

      {tipo === 'company' && (
        <section className="m-sec" aria-label="Contactos">
          <div className="m-sec-cab"><h2>Contactos</h2><span className="muted small">{a.contact?.length || ''}</span><span className="grow" />
            {puede && <button type="button" className="m-link" onClick={() => setHoja('contacto')} aria-label="Agregar contacto"><Icon name="plus" size={14} />Agregar</button>}</div>
          {!a.contact?.length && <div className="m-vacio">Sin contactos todavía.</div>}
          {a.contact?.map((c) => <TarjetaCliente key={c.id} tipo="contact" r={c} />)}
        </section>
      )}
      {tipo === 'contact' && (a.company?.length ?? 0) > 1 && (
        <section className="m-sec" aria-label="Empresas">
          <div className="m-sec-cab"><h2>Empresas</h2></div>
          {a.company.map((c) => <TarjetaCliente key={c.id} tipo="company" r={c} />)}
        </section>
      )}

      {(a.order?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Pedidos">
          <div className="m-sec-cab"><h2>Pedidos</h2><span className="muted small">{a.order.length}</span></div>
          {a.order.slice(0, 8).map((o) => (
            <Link key={o.id} to={recordUrl('order', o.id)} className="m-item m-item-link">
              <div className="m-item-txt"><b>{o.name}</b><small className="muted">{formatValue(meta, 'order', 'hs_pipeline_stage', o.props.hs_pipeline_stage) || 'Sin estado'}</small></div>
            </Link>
          ))}
        </section>
      )}

      <section className="m-sec" aria-label="Negocios">
        <div className="m-sec-cab"><h2>Negocios</h2><span className="muted small">{negocios.length || ''}</span><span className="grow" />
          {puede && <button type="button" className="m-link" onClick={() => setHoja('negocio')} aria-label="Nuevo negocio"><Icon name="plus" size={14} />Nuevo</button>}</div>
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

      <Datos tipo={tipo} record={r} claves={keyPropsFor(meta, tipo)} todos={todos} onTodos={() => setTodos(!todos)} onEditar={(p) => setHoja({ editar: p })} onCambio={cambio} />

      <Actividad tipo={tipo} id={r.id} version={version} />

      {hoja === 'registrar' && <Registrar record={ref} onClose={() => setHoja(null)} onListo={cambio} />}
      {hoja === 'tarea' && <TareaRapida linkId={r.id} sobre={r.name} onClose={() => setHoja(null)} onCreada={cambio} />}
      {hoja === 'negocio' && <AltaNegocio empresa={lugar ? { id: lugar.id, name: lugar.name } : undefined} asociar={tipo === 'contact' ? [r.id] : []} onClose={() => setHoja(null)} />}
      {hoja === 'contacto' && <AltaCliente tipo="contact" empresa={{ id: r.id, name: r.name }} onClose={() => setHoja(null)} onCreado={() => cambio()} />}
      {hoja && typeof hoja === 'object' && <EditarDato tipo={tipo} record={r} prop={hoja.editar} onClose={() => setHoja(null)} onListo={cambio} />}
    </div>
  );
}

// Los datos de la ficha: los principales que tienen algo, y lo vacío plegado en «Completar datos (N)». Cada uno se toca
// para editarlo. El propietario no se edita acá: lo que no tiene dueño se toma con «Tomarlo».
export function Datos({ tipo, record: r, claves, todos, onTodos, onEditar, onCambio, obligatorios = [] }: {
  tipo: ObjectType; record: CrmRecord; claves: string[]; todos: boolean; onTodos: () => void; onEditar: (p: Property) => void; onCambio: () => void; obligatorios?: string[];
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const puede = usePuedeEscribir();
  const props = claves.map((n) => propOf(meta, tipo, n)).filter((p): p is Property => !!p && p.name !== 'owner_id');
  const lleno = (p: Property) => r.props[p.name] != null && r.props[p.name] !== '';
  const conDato = props.filter(lleno);
  const vacios = props.filter((p) => !lleno(p) && !p.read_only);
  const extra = todos ? meta.properties.filter((p) => p.object_type === tipo && !claves.includes(p.name) && p.name !== 'owner_id' && lleno(p)) : [];
  const dueno = r.props.owner_id;
  const tomar = async () => {
    try { await http('PATCH', `/records/${tipo}/${r.id}`, { props: { owner_id: meta.me.id } }); toast('Ahora es tuyo'); onCambio(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const fila = (p: Property) => {
    const vacio = !lleno(p);
    const editable = puede && !p.read_only;
    const valor = vacio ? (editable ? 'Agregar' : '—') : formatValue(meta, tipo, p.name, r.props[p.name], r.props);
    return (
      <button key={p.name} type="button" className="m-dato" disabled={!editable} onClick={() => onEditar(p)} aria-label={`${p.label}: ${vacio ? 'sin cargar' : valor}${editable ? ', editar' : ''}`}>
        <span className="m-dato-et">{p.label}{obligatorios.includes(p.name) ? ' *' : ''}</span><span className={`m-dato-val${vacio ? ' vacio' : ''}`}>{valor}</span>
      </button>
    );
  };
  return (
    <section className="m-sec" aria-label="Datos">
      <div className="m-sec-cab"><h2>Datos</h2></div>
      <div className="m-datos">
        {dueno == null
          ? <div className="m-dato m-dato-fijo"><span className="m-dato-et">Propietario</span><span className="m-dato-val">Sin dueño {puede && <button type="button" className="btn sm" onClick={tomar}>Tomarlo</button>}</span></div>
          : Number(dueno) !== meta.me.id && <div className="m-dato m-dato-fijo"><span className="m-dato-et">Propietario</span><span className="m-dato-val">{userOf(meta, dueno)?.name ?? 'Otra persona'}</span></div>}
        {conDato.map(fila)}
        {extra.map(fila)}
        {!conDato.length && !extra.length && <div className="m-vacio">Todavía no hay datos cargados.</div>}
        {todos && vacios.map(fila)}
      </div>
      <button type="button" className="m-ver" onClick={onTodos} aria-expanded={todos}>
        {todos ? 'Ver menos' : vacios.length ? `Completar datos (${vacios.length}) y ver todos` : 'Ver todos los datos cargados'}</button>
    </section>
  );
}

export function Accion({ icono, texto, falta, href, nueva, onClick }: { icono: string; texto: string; falta: string; href?: string; nueva?: boolean; onClick?: () => void }) {
  if (!href) return <span className="m-accion off" aria-disabled="true"><span><Icon name={icono} size={20} /></span>{texto}<small>{falta}</small></span>;
  return <a className={`m-accion${icono === 'whatsapp' ? ' wa' : ''}`} href={href} onClick={onClick} {...(nueva ? { target: '_blank', rel: 'noreferrer' } : {})}><span><Icon name={icono} size={20} /></span>{texto}</a>;
}

// Lo último que pasó con el cliente: notas, llamadas, mails, reuniones, WhatsApp y tareas.
export function Actividad({ tipo, id, version }: { tipo: ObjectType; id: number; version: number }) {
  const [cuantas, setCuantas] = useState(10);
  const carga = useCarga(() => http<{ activities: Activity[] }>('GET', `/records/${tipo}/${id}/timeline${qs({ limit: cuantas })}`).then((r) => r.activities), [tipo, id, version, cuantas]);
  const acts = carga.datos;
  return (
    <section className="m-sec" aria-label="Actividad">
      <div className="m-sec-cab"><h2>Actividad</h2></div>
      {carga.error && <Fallo chico error={carga.error} onReintentar={carga.recargar} />}
      {!acts && !carga.error && <Cargando chico />}
      {acts && !acts.length && <div className="m-vacio">Todavía no hay nada registrado.</div>}
      {acts?.map((x) => {
        const texto = sinHtml(x.body || '');
        const hecha = x.type === 'task' && x.status === 'COMPLETED';
        return (
          <div key={x.id} className="m-act">
            <span className={`m-act-ico t-${x.type}`}><Icon name={x.type} size={15} /></span>
            <div className="m-item-txt">
              <b className={hecha ? 'tachada' : ''}>{x.subject || (x.type === 'call' && x.outcome ? `Llamada · ${x.outcome}` : ACTIVITY_LABEL[x.type])}</b>
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

// Un campo en el celular: si es una lista corta, botones (se ven todas las opciones de una, sin abrir nada); si no, el
// campo de siempre. Si es obligatorio, tocar de nuevo el elegido no lo vacía.
export function CampoMovil({ prop, tipo, valor, onChange, autoFocus, obligatorio }: { prop: Property; tipo: ObjectType; valor: unknown; onChange: (v: unknown) => void; autoFocus?: boolean; obligatorio?: boolean }) {
  if (prop.type === 'enum' && prop.options.length > 0 && prop.options.length <= 16) {
    return (
      <div className="m-chips" role="radiogroup" aria-label={prop.label}>
        {prop.options.map((o) => <button key={o.value} type="button" role="radio" className={`chip sm${valor === o.value ? ' on' : ''}`} aria-checked={valor === o.value}
          onClick={() => onChange(valor === o.value && !obligatorio ? '' : o.value)}>{valor === o.value && <Icon name="check" size={12} />}{o.label}</button>)}
      </div>
    );
  }
  return <PropertyInput prop={prop} value={valor ?? ''} onChange={onChange} type={tipo} autoFocus={autoFocus && prop.type !== 'enum'} />;
}

// Lo que pasó con un cliente. «Visita» primero: es lo que más hace una vendedora en la calle. Los resultados de una
// llamada son los mismos del resto del CRM (CALL_OUTCOMES en activities.ts) y no viene ninguno elegido.
const TIPOS_REG: Array<[string, Activity['type'], string]> = [['visita', 'meeting', 'Visita'], ['call', 'call', 'Llamada'], ['whatsapp', 'whatsapp', 'WhatsApp'],
  ['note', 'note', 'Nota'], ['meeting', 'meeting', 'Reunión'], ['email', 'email', 'Mail']];
const RESULTADOS = ['Conectada', 'Ocupado', 'No atendió', 'Dejó mensaje', 'Número equivocado'];

export function Registrar({ record, tipoInicial = 'visita', pregunta, onClose, onListo }: { record: Ref; tipoInicial?: string; pregunta?: boolean; onClose: () => void; onListo: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [clave, setClave] = useState(tipoInicial);
  const tipo = (TIPOS_REG.find(([k]) => k === clave) ?? TIPOS_REG[0])[1];
  const [texto, setTexto] = useState('');
  const [resultado, setResultado] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const listo = clave === 'call' ? !!resultado : !!texto.trim() || clave === 'visita' || clave === 'whatsapp';
  async function guardar() {
    if (!listo || ocupado) return;
    setOcupado(true);
    try {
      await http('POST', '/activities', {
        type: tipo, body: texto.trim(),
        subject: clave === 'visita' ? `Visita a ${record.name}` : clave === 'meeting' ? `Reunión con ${record.name}` : clave === 'email' ? `Mail con ${record.name}` : '',
        occurred_at: new Date().toISOString(), owner_id: meta.me.id, direction: ['call', 'whatsapp', 'email'].includes(tipo) ? 'out' : undefined,
        outcome: tipo === 'call' ? resultado : undefined, links: [record.id],
      });
      toast(`${clave === 'visita' ? 'Visita' : ACTIVITY_LABEL[tipo]} registrada`);
      onListo(); onClose();
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  const titulo = pregunta ? (clave === 'call' ? `¿Cómo salió la llamada con ${record.name}?` : `¿Qué hablaste con ${record.name}?`) : `Registrar en ${record.name}`;
  return (
    <Hoja titulo={titulo} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        {!pregunta && (
          <div className="m-chips" role="radiogroup" aria-label="Qué fue">
            {TIPOS_REG.map(([k, , l]) => <button key={k} type="button" role="radio" className={`chip${clave === k ? ' on' : ''}`} aria-checked={clave === k} onClick={() => setClave(k)}>{l}</button>)}
          </div>
        )}
        {clave === 'call' && (
          <div className="m-resultados" role="radiogroup" aria-label="Cómo salió">
            {RESULTADOS.map((x) => <button key={x} type="button" role="radio" className={`m-resultado${resultado === x ? ' on' : ''}`} aria-checked={resultado === x} onClick={() => setResultado(x)}>{x}</button>)}
          </div>
        )}
        <textarea className="input" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Qué pasó"
          placeholder={clave === 'call' ? '¿De qué hablaron? (opcional)' : clave === 'visita' ? 'Qué se habló, qué quedó pendiente (opcional)' : 'Qué pasó, qué quedó pendiente…'} />
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !listo}>{clave === 'call' && !resultado ? 'Elegí cómo salió' : 'Guardar'}</button>
        {pregunta && <button type="button" className="btn ghost" onClick={onClose}>No registrar</button>}
      </form>
    </Hoja>
  );
}

export function EditarDato({ tipo, record, prop, obligatorio, onClose, onListo }: { tipo: ObjectType; record: CrmRecord; prop: Property; obligatorio?: boolean; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const [valor, setValor] = useState<unknown>(record.props[prop.name] ?? '');
  const [ocupado, setOcupado] = useState(false);
  const requerido = obligatorio || !!prop.required;
  const vacio = valor == null || valor === '';
  async function guardar() {
    if ((requerido && vacio) || ocupado) return;
    setOcupado(true);
    try { await http('PATCH', `/records/${tipo}/${record.id}`, { props: { [prop.name]: vacio ? null : valor } }); toast('Guardado'); onListo(); onClose(); }
    catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }
  return (
    <Hoja titulo={prop.label} onClose={onClose}>
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <CampoMovil prop={prop} tipo={tipo} valor={valor} onChange={setValor} autoFocus obligatorio={requerido} />
        {requerido && <small className="muted">Es obligatorio: se puede cambiar, no dejar vacío.</small>}
        <button type="submit" className="btn primary m-grande" disabled={ocupado || (requerido && vacio)}>Guardar</button>
      </form>
    </Hoja>
  );
}

// ---------- Duplicados ----------

// Lo que ya existe con ese nombre, mail o dominio (el mismo buscador de arriba): lo suyo se abre; lo de otra vendedora
// dice de quién es, para no cargarlo de nuevo (docs/PERFILES.md).
type Encontrado = CrmRecord & { ajeno?: boolean };
function useYaExiste(tipo: Tipo, texto: string) {
  const dq = useDebounced(texto.trim(), 350);
  const [res, setRes] = useState<Encontrado[]>([]);
  useEffect(() => {
    if (dq.length < 3) { setRes([]); return; }
    let vivo = true;
    http<Record<ObjectType, Encontrado[]>>('GET', `/search${qs({ q: dq })}`).then((r) => { if (vivo) setRes((r[tipo] ?? []).slice(0, 3)); }, () => undefined);
    return () => { vivo = false; };
  }, [dq, tipo]);
  return res;
}
function YaExiste({ tipo, encontrados }: { tipo: Tipo; encontrados: Encontrado[] }) {
  const { meta } = useMeta();
  if (!encontrados.length) return null;
  return (
    <div className="m-ya-existe" role="status">
      <b>Ya hay {tipo === 'company' ? 'empresas' : 'contactos'} parecidos:</b>
      {encontrados.map((r) => r.ajeno
        ? <span key={r.id} className="m-ya-ajeno">{r.name} · es de {userOf(meta, r.props.owner_id)?.name ?? 'otra vendedora'}: pedile a un administrador que te lo pase</span>
        : <Link key={r.id} to={recordUrl(tipo, r.id)}>{r.name} · abrir</Link>)}
    </div>
  );
}

// Alta corta: lo mínimo para no perder a alguien que conociste. El resto se completa después.
export function AltaCliente({ tipo, empresa, onClose, onCreado }: { tipo: Tipo; empresa?: Ref; onClose: () => void; onCreado?: (r: CrmRecord) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState<Record<string, string>>({});
  const [emp, setEmp] = useState<Ref | null>(empresa ?? null);
  const [ocupado, setOcupado] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  // Los obligatorios que el CRM pide además de los de acá (en contactos, el canal de contacto): se piden siempre.
  const propios = tipo === 'company' ? ['name', 'domain', 'phone', 'address', 'city'] : ['firstname', 'lastname', 'mobilephone', 'email', 'jobtitle'];
  const requeridas = meta.properties.filter((p) => p.object_type === tipo && p.required && !p.read_only && !propios.includes(p.name) && p.name !== 'owner_id');
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const falta = requeridas.filter((p) => extra[p.name] == null || extra[p.name] === '');
  const nombre = tipo === 'company' ? (f.name ?? '') : [f.firstname, f.lastname].filter(Boolean).join(' ');
  const parecidos = useYaExiste(tipo, f.email?.includes('@') ? f.email : f.domain || nombre);
  const listo = !falta.length && (tipo === 'company' ? !!f.name?.trim() : !!(f.firstname?.trim() || f.lastname?.trim() || f.email?.trim()));
  async function crear() {
    if (!listo || ocupado) return;
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
          <label className="field">Nombre<input className="input" autoFocus value={f.name ?? ''} onChange={set('name')} placeholder="Razón social o nombre de fantasía" enterKeyHint="next" /></label>
          <label className="field">Sitio web<input className="input" inputMode="url" autoCapitalize="none" value={f.domain ?? ''} onChange={set('domain')} placeholder="empresa.com.ar" enterKeyHint="next" /></label>
          <label className="field">Teléfono<input className="input" type="tel" value={f.phone ?? ''} onChange={set('phone')} enterKeyHint="next" /></label>
          <label className="field">Dirección<input className="input" value={f.address ?? ''} onChange={set('address')} placeholder="Calle y altura" enterKeyHint="next" /></label>
          <label className="field">Ciudad<input className="input" value={f.city ?? ''} onChange={set('city')} enterKeyHint="next" /></label>
        </> : <>
          <div className="m-2">
            <label className="field">Nombre<input className="input" autoFocus value={f.firstname ?? ''} onChange={set('firstname')} autoComplete="off" enterKeyHint="next" /></label>
            <label className="field">Apellido<input className="input" value={f.lastname ?? ''} onChange={set('lastname')} autoComplete="off" enterKeyHint="next" /></label>
          </div>
          <label className="field">Celular<input className="input" type="tel" value={f.mobilephone ?? ''} onChange={set('mobilephone')} placeholder="11 5555 5555" enterKeyHint="next" /></label>
          <label className="field">Mail<input className="input" type="email" autoCapitalize="none" value={f.email ?? ''} onChange={set('email')} enterKeyHint="next" /></label>
          <label className="field">Cargo<input className="input" value={f.jobtitle ?? ''} onChange={set('jobtitle')} placeholder="Compras, Marketing, RR. HH.…" enterKeyHint="next" /></label>
          {empresa ? <div className="small muted">Va en {empresa.name}.</div> : <ElegirEmpresa valor={emp} onElegir={setEmp} />}
        </>}
        <YaExiste tipo={tipo} encontrados={parecidos} />
        {requeridas.map((p) => (
          <div key={p.name} className="field">{p.label} *
            <CampoMovil prop={p} tipo={tipo} valor={extra[p.name]} onChange={(v) => setExtra((x) => ({ ...x, [p.name]: v }))} obligatorio />
          </div>
        ))}
        <button type="submit" className="btn primary m-grande" disabled={ocupado || !listo}>
          {listo ? `Crear ${tipo === 'company' ? 'empresa' : 'contacto'}` : falta.length ? `Falta: ${falta.map((p) => p.label.toLowerCase()).join(', ')}` : tipo === 'company' ? 'Falta el nombre' : 'Falta el nombre o el mail'}</button>
      </form>
    </Hoja>
  );
}

// La empresa de un contacto o negocio. Busca como el buscador de arriba: las de otra vendedora aparecen, sin poder
// elegirse, con de quién son.
export function ElegirEmpresa({ valor, onElegir }: { valor: Ref | null; onElegir: (e: Ref | null) => void }) {
  const { meta } = useMeta();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [res, setRes] = useState<Encontrado[]>([]);
  useEffect(() => {
    if (dq.trim().length < 2) { setRes([]); return; }
    let vivo = true;
    http<Record<ObjectType, Encontrado[]>>('GET', `/search${qs({ q: dq })}`).then((r) => { if (vivo) setRes(r.company ?? []); }, () => { if (vivo) setRes([]); });
    return () => { vivo = false; };
  }, [dq]);
  if (valor) return <div className="m-elegida"><span className="small muted">Empresa</span><b>{valor.name}</b><button type="button" className="m-link" onClick={() => onElegir(null)}>Cambiar</button></div>;
  return (
    <div className="field">Empresa
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscá la empresa (opcional)" aria-label="Empresa" />
      {res.length > 0 && (
        <div className="m-opciones">
          {res.map((r) => r.ajeno
            ? <button key={r.id} type="button" disabled>{r.name} <small>· es de {userOf(meta, r.props.owner_id)?.name ?? 'otra vendedora'}</small></button>
            : <button key={r.id} type="button" onClick={() => { onElegir({ id: r.id, name: r.name }); setQ(''); }}>{r.name}</button>)}
        </div>
      )}
    </div>
  );
}
