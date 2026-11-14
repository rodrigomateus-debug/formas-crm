import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, fmtRelative } from '../lib';
import { Modal } from '../components';
import { Select } from '../Select';
import { SelectorFecha } from '../Fecha';
import { lindo } from './Cronograma';

// Recorridos (pedido de Rodrigo del 13/11/2026; src/worker/recorridos.ts, docs/RECORRIDOS.md): reemplaza la planilla
// «Recorridos» de Logística. Cualquiera carga un encargo al recorrido de un día —llevar o retirar muestras, un sobre,
// mercadería— eligiendo el destino de una sola base de destinos. Al elegirlo, el Hub dice si ese día (o el siguiente, o la
// semana que viene) ya se va a ese lugar, para sumarlo ahí, y qué días se suele ir. Logística lo ve en el cronograma y lo
// mete en el recorrido de un chofer.

export interface ItemEnc { cant: number | null; que: string; pdv: string | null }
export type EstadoEnc = 'pendiente' | 'hecho' | 'no_se_pudo' | 'cancelado';
export interface Encargo {
  id: number; fecha: string; user_id: number | null; quien: string | null; destino: string; direccion: string | null; lugar_id: number | null; company_id: number | null;
  record_id: number | null; llevar: ItemEnc[]; retirar: ItemEnc[]; desde: string | null; hacia: string | null; horario: string | null; contacto: string | null;
  notas: string | null; urgente: boolean; estado: EstadoEnc; motivo: string | null; remito: number | null; hecho_chofer: string | null; hecho_por: number | null;
  origen: string; created_at: string; chofer?: string | null; parada?: string;
}
interface Habitual { texto: string; dias: number[]; por_semana: number }
export interface DestinoOpcion {
  tipo: 'lugar' | 'empresa' | 'expreso' | 'base' | 'suelto'; key: string; nombre: string; direccion: string | null; detalle: string | null;
  lugar_id: number | null; company_id: number | null; record_id?: number | null; motivo?: string | null; horario?: string | null; contacto?: string | null;
  proximos?: Array<{ fecha: string; que: string[] }>; habitual?: Habitual | null; veces?: number;
}
interface Base { id: string; nombre: string }

// ---------- Fechas ----------

const D = (iso: string) => new Date(`${iso}T12:00:00`);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sumar = (dia: string, n: number) => { const d = D(dia); d.setDate(d.getDate() + n); return iso(d); };
const hoyIso = () => iso(new Date());
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const corto = (dia: string) => `${DIAS[D(dia).getDay()].slice(0, 3)} ${D(dia).getDate()}/${D(dia).getMonth() + 1}`;
// «Hoy», «Mañana», «El lunes 17/11».
export function cuando(dia: string, hoy = hoyIso()) {
  if (dia === hoy) return 'Hoy';
  if (dia === sumar(hoy, 1)) return 'Mañana';
  const d = D(dia);
  return `El ${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}
// El primer día hábil después de hoy: lo que se carga es, en general, para el día siguiente.
function proximoHabil(desde = hoyIso()) { let d = sumar(desde, 1); while ([0, 6].includes(D(d).getDay())) d = sumar(d, 1); return d; }

const num = new Intl.NumberFormat('es-AR');
export const itemTexto = (i: ItemEnc) => [i.cant != null ? num.format(i.cant) : '', i.que, i.pdv ? `(PDV ${i.pdv})` : ''].filter(Boolean).join(' ');
export const ESTADO: Record<EstadoEnc, { nombre: string; clase: string }> = {
  pendiente: { nombre: 'Pendiente', clase: '' }, hecho: { nombre: 'Hecho', clase: 'ok' }, no_se_pudo: { nombre: 'No se pudo', clase: 'mal' }, cancelado: { nombre: 'Cancelado', clase: 'off' },
};

// El remito de traslado: se numera (la primera vez) y se abre para imprimir. La ventana se abre en el mismo clic, si no el
// navegador la bloquea.
export async function abrirRemito(id: number, toast: (m: string, e?: boolean) => void) {
  const w = window.open('about:blank', '_blank');
  try {
    await http('POST', `/recorridos/encargos/${id}/remito`);
    if (w) w.location.href = `/api/recorridos/encargos/${id}/remito#imprimir`; else window.location.href = `/api/recorridos/encargos/${id}/remito`;
  } catch (e) { w?.close(); toast((e as Error).message, true); }
}

// ---------- La página ----------

type Pestaña = 'agenda' | 'encargos' | 'destinos';
export default function RecorridosPage() {
  const [sp, setSp] = useSearchParams();
  const { meta } = useMeta();
  const tab: Pestaña = (['agenda', 'encargos', 'destinos'] as const).find((t) => t === sp.get('tab')) ?? 'agenda';
  const abierto = Number(sp.get('encargo')) || null;
  const [nuevo, setNuevo] = useState<{ destino?: DestinoOpcion | null; fecha?: string } | null>(sp.get('nuevo') ? {} : null);
  const [version, setVersion] = useState(0);
  const ir = (cambios: Record<string, string | null>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(cambios)) { if (v == null) n.delete(k); else n.set(k, v); } return n; }, { replace: true });
  const cambio = useCallback(() => setVersion((v) => v + 1), []);
  const puede = meta.me.role !== 'viewer';
  return (
    <div className="content rc-page">
      <div className="page-head">
        <h1>Recorridos</h1>
        {puede && <button type="button" className="btn primary" onClick={() => setNuevo({})}><Icon name="plus" size={16} />Nuevo encargo</button>}
      </div>
      <p className="rc-intro muted">Lo que necesitás que el chofer lleve o retire un día: muestras, un sobre, mercadería, un trámite. Elegí el destino y te decimos si ese día ya se va ahí.</p>
      <div className="tabs" role="tablist">
        {([['agenda', 'Próximos días'], ['encargos', 'Encargos'], ['destinos', 'Destinos']] as const).map(([k, t]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => ir({ tab: k === 'agenda' ? null : k })}>{t}</button>
        ))}
      </div>
      {tab === 'agenda' && <Agenda version={version} puede={puede} onNuevo={(destino, fecha) => setNuevo({ destino, fecha })} onAbrir={(id) => ir({ encargo: String(id) })} />}
      {tab === 'encargos' && <ListaEncargos version={version} onAbrir={(id) => ir({ encargo: String(id) })} />}
      {tab === 'destinos' && <Destinos />}
      {nuevo && <EncargoModal inicial={nuevo} onClose={() => { setNuevo(null); ir({ nuevo: null }); }} onListo={() => { setNuevo(null); ir({ nuevo: null }); cambio(); }} />}
      {abierto && <EncargoModal id={abierto} onClose={() => ir({ encargo: null })} onListo={() => { ir({ encargo: null }); cambio(); }} />}
    </div>
  );
}

// ---------- Próximos días ----------

interface ParadaAgenda { clave: string; nombre: string; localidad: string | null; direccion: string | null; tipos: Record<string, number>; detalle: string[]; encargos: Encargo[];
  anonima: boolean; chofer: string | null; company_id: number | null; lugar_id: number | null }
interface DiaAgenda { fecha: string; feriado: string | null; armado: boolean; paradas: ParadaAgenda[] }
const TIPOS: Array<[string, string, string]> = [['encargo', 'Encargo', 'X'], ['entrega', 'Entrega', 'E'], ['retiro', 'Retiro', 'R'], ['egreso', 'Egreso', 'G']];

function Agenda({ version, puede, onNuevo, onAbrir }: { version: number; puede: boolean; onNuevo: (d: DestinoOpcion | null, fecha: string) => void; onAbrir: (id: number) => void }) {
  const [datos, setDatos] = useState<{ hoy: string; dias: DiaAgenda[] } | null>(null);
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');
  useEffect(() => { http<{ hoy: string; dias: DiaAgenda[] }>('GET', `/recorridos/agenda${qs({ dias: 8 })}`).then((d) => { setDatos(d); setError(''); }, (e) => setError((e as Error).message)); }, [version]);
  if (error) return <div className="aviso warn small">{error}</div>;
  if (!datos) return <div className="empty plain">Cargando los próximos días…</div>;
  const q = buscar.trim().toLowerCase();
  const filtra = (p: ParadaAgenda) => !q || [p.nombre, p.localidad, p.direccion, ...p.detalle].some((x) => (x ?? '').toLowerCase().includes(q));
  return (
    <>
      <div className="toolbar">
        <div className="search" style={{ minWidth: 220, flex: '0 1 320px' }}><Icon name="search" />
          <input className="input" placeholder="Buscar un lugar o una localidad" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar en los próximos días" />
        </div>
        <span className="grow" />
        <div className="cr-leyenda small">{TIPOS.map(([, n, k]) => <span key={k} className={`cr-k-${k}`}><i />{n}</span>)}</div>
      </div>
      <div className="rc-dias">
        {datos.dias.map((d) => {
          const ps = d.paradas.filter(filtra);
          return (
            <section key={d.fecha} className={`rc-dia${d.fecha === datos.hoy ? ' hoy' : ''}${d.feriado ? ' feriado' : ''}`}>
              <header>
                <div><b>{cuando(d.fecha, datos.hoy)}</b>{!['Hoy', 'Mañana'].includes(cuando(d.fecha, datos.hoy)) ? null : <span className="muted"> · {corto(d.fecha)}</span>}</div>
                <span className="muted small">{d.feriado ? `Feriado: ${d.feriado}` : ps.length ? `${ps.length} lugar${ps.length === 1 ? '' : 'es'}` : 'Nada todavía'}{d.armado ? ' · recorrido armado' : ''}</span>
              </header>
              <ul>
                {ps.map((p) => (
                  <li key={p.clave} className={p.encargos.length ? 'mio' : ''}>
                    <div className="rc-p-cab">
                      <div className="rc-p-nombre"><b>{p.anonima ? p.nombre : lindo(p.nombre)}</b>{p.localidad && <span>{lindo(p.localidad)}</span>}</div>
                      {p.chofer && <span className="rc-chofer" title="Chofer"><Icon name="truck" size={12} />{p.chofer}</span>}
                    </div>
                    <div className="rc-p-tipos">
                      {TIPOS.filter(([t]) => p.tipos[t]).map(([t, n, k]) => <span key={t} className={`rc-tipo cr-k-${k}`}>{p.tipos[t] > 1 ? `${p.tipos[t]} ` : ''}{p.tipos[t] > 1 ? `${n.toLowerCase()}s` : n}</span>)}
                    </div>
                    {p.encargos.map((e) => (
                      <button key={e.id} type="button" className="rc-p-enc" onClick={() => onAbrir(e.id)}>
                        <span className={`rc-estado ${ESTADO[e.estado].clase}`}>{ESTADO[e.estado].nombre}</span>
                        <span>{resumen(e)}</span>{e.quien && <span className="muted"> · {e.quien.split(' ')[0]}</span>}
                      </button>
                    ))}
                    {puede && !p.anonima && d.fecha >= datos.hoy && (
                      <button type="button" className="cr-link rc-sumar" onClick={() => onNuevo({ tipo: p.lugar_id ? 'lugar' : p.company_id ? 'empresa' : 'suelto', key: p.clave, nombre: p.nombre,
                        direccion: p.direccion, detalle: null, lugar_id: p.lugar_id, company_id: p.company_id }, d.fecha)}><Icon name="plus" size={12} />Sumar algo acá</button>
                    )}
                  </li>
                ))}
                {!ps.length && <li className="vacio muted small">{q ? 'Nada que coincida.' : 'Todavía no hay nada para este día.'}</li>}
              </ul>
              {puede && d.fecha >= datos.hoy && !d.feriado && <button type="button" className="cr-agregar" onClick={() => onNuevo(null, d.fecha)}><Icon name="plus" size={12} />Encargo para {cuando(d.fecha, datos.hoy).toLowerCase()}</button>}
            </section>
          );
        })}
      </div>
    </>
  );
}
export const resumen = (e: Pick<Encargo, 'llevar' | 'retirar' | 'notas'>) => [
  e.llevar.length ? `Lleva ${e.llevar.map(itemTexto).join(', ')}` : '', e.retirar.length ? `Retira ${e.retirar.map(itemTexto).join(', ')}` : '',
].filter(Boolean).join(' · ') || e.notas || '';

// ---------- La lista de encargos ----------

function ListaEncargos({ version, onAbrir }: { version: number; onAbrir: (id: number) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const organiza = meta.me.role === 'admin' || (meta.me.role !== 'viewer' && ['logistica', 'produccion'].includes(meta.me.profile));
  const [todos, setTodos] = useState(false);
  const [estado, setEstado] = useState('');
  const [historial, setHistorial] = useState(false);
  const [datos, setDatos] = useState<Encargo[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const hoy = hoyIso();
    http<{ encargos: Encargo[] }>('GET', `/recorridos/encargos${qs({ todos: todos ? '1' : undefined, estado: estado || undefined, desde: historial ? sumar(hoy, -182) : sumar(hoy, -14), hasta: sumar(hoy, 90) })}`)
      .then((r) => { setDatos(r.encargos); setError(''); }, (e) => setError((e as Error).message));
  }, [todos, estado, historial, version]);
  const hoy = hoyIso();
  const grupos = useMemo(() => {
    const m = new Map<string, Encargo[]>();
    for (const e of [...(datos ?? [])].sort((a, b) => (a.fecha >= hoy) === (b.fecha >= hoy) ? (a.fecha >= hoy ? a.fecha.localeCompare(b.fecha) : b.fecha.localeCompare(a.fecha)) : a.fecha >= hoy ? -1 : 1)) {
      m.set(e.fecha, [...(m.get(e.fecha) ?? []), e]);
    }
    return [...m.entries()];
  }, [datos, hoy]);
  return (
    <>
      <div className="toolbar">
        {organiza && (
          <div className="row" role="group" aria-label="De quién">
            <button type="button" className={`chip${!todos ? ' on' : ''}`} aria-pressed={!todos} onClick={() => setTodos(false)}>Los míos</button>
            <button type="button" className={`chip${todos ? ' on' : ''}`} aria-pressed={todos} onClick={() => setTodos(true)}>De todos</button>
          </div>
        )}
        <div className="row" role="group" aria-label="Estado">
          {([['', 'Todos'], ['pendiente', 'Pendientes'], ['no_se_pudo', 'No se pudo'], ['hecho', 'Hechos'], ['cancelado', 'Cancelados']] as const).map(([k, t]) => (
            <button key={k} type="button" className={`chip${estado === k ? ' on' : ''}`} aria-pressed={estado === k} onClick={() => setEstado(k)}>{t}</button>
          ))}
        </div>
        <span className="grow" />
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={historial} onChange={(e) => setHistorial(e.target.checked)} />Últimos 6 meses</label>
      </div>
      {error && <div className="aviso warn small">{error}</div>}
      {!datos && !error && <div className="empty plain">Cargando…</div>}
      {datos && !datos.length && <div className="empty plain">{todos ? 'No hay encargos con ese filtro.' : 'Todavía no cargaste encargos. Con «Nuevo encargo» le pedís algo al recorrido de un día.'}</div>}
      <div className="rc-lista">
        {grupos.map(([fecha, es]) => (
          <section key={fecha}>
            <h3 className={fecha < hoy ? 'pasado' : ''}>{cuando(fecha, hoy)}{['Hoy', 'Mañana'].includes(cuando(fecha, hoy)) ? <span className="muted"> · {corto(fecha)}</span> : null}</h3>
            {es.map((e) => (
              <article key={e.id} className={`rc-enc${e.estado === 'cancelado' ? ' off' : ''}`} onClick={(ev) => { if (!(ev.target as HTMLElement).closest('button, a')) onAbrir(e.id); }}>
                <div className="rc-enc-cab">
                  <b>{lindo(e.destino)}</b>
                  {e.urgente && <span className="cr-tag late">Urgente</span>}
                  <span className={`rc-estado ${ESTADO[e.estado].clase}`}>{ESTADO[e.estado].nombre}</span>
                  {e.origen === 'planilla' && <span className="cr-tag" title="Traído de la planilla vieja">Planilla</span>}
                </div>
                <div className="rc-enc-que">{resumen(e)}</div>
                <div className="rc-enc-pie muted small">
                  {e.direccion && <span>{e.direccion}</span>}
                  {todos && e.quien && <span>Pidió {e.quien}</span>}
                  {e.motivo && <span className="rc-motivo">{e.motivo}</span>}
                  {e.hecho_chofer && e.estado === 'hecho' && <span>Lo hizo {e.hecho_chofer}</span>}
                  <span className="grow" />
                  {e.origen === 'hub' && e.llevar.length + e.retirar.length > 0 && <button type="button" className="cr-link" onClick={() => abrirRemito(e.id, toast)}><Icon name="printer" size={12} />{e.remito ? `Remito ${e.remito}` : 'Remito de traslado'}</button>}
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

// ---------- Destinos ----------

interface DestinoFila { id: number; nombre: string; direccion: string | null; localidad: string | null; zona: string | null; horario: string | null; contacto: string | null;
  telefono: string | null; observaciones: string | null; company_id: number | null; origen: string; editado: boolean; veces: number; puede_editar: boolean }
function Destinos() {
  const { meta } = useMeta();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [datos, setDatos] = useState<{ total: number; copia: { at: number; filas: number; error: string | null }; destinos: DestinoFila[] } | null>(null);
  const [editando, setEditando] = useState<DestinoFila | 'nuevo' | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    let vivo = true;
    const t = window.setTimeout(() => http<NonNullable<typeof datos>>('GET', `/recorridos/libreta${qs({ q })}`).then((d) => { if (vivo) setDatos(d); }, (e) => toast((e as Error).message, true)), q ? 250 : 0);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [q, v, toast]);
  const organiza = meta.me.role === 'admin' || (meta.me.role !== 'viewer' && ['logistica', 'produccion'].includes(meta.me.profile));
  const actualizar = async () => {
    try { const r = await http<{ filas: number; error: string | null }>('POST', '/cronograma/lugares/actualizar'); toast(r.error ? `No se pudo traer la planilla: ${r.error}` : `Listo: ${r.filas} destinos de la planilla.`, !!r.error); setV((x) => x + 1); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="toolbar">
        <div className="search" style={{ minWidth: 220, flex: '0 1 320px' }}><Icon name="search" />
          <input className="input" placeholder="Buscar por nombre, calle o localidad" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar destinos" />
        </div>
        <span className="grow" />
        {meta.me.role !== 'viewer' && <button type="button" className="btn sm" onClick={() => setEditando('nuevo')}><Icon name="plus" size={14} />Nuevo destino</button>}
      </div>
      {datos && (
        <p className="muted small rc-intro">Una sola base de destinos para el Hub: la libreta de Logística (que se sigue copiando de la planilla DESTINOS una vez por día, sin pisar lo que se corrige acá),
          los destinos nuevos que se cargan con los encargos y las empresas del CRM. {datos.total} destinos.
          {datos.copia.at > 0 && ` Última copia de la planilla: ${fmtRelative(new Date(datos.copia.at).toISOString())}.`}{datos.copia.error ? ` (${datos.copia.error})` : ''}
          {organiza && <> <button type="button" className="cr-link" onClick={actualizar}>Traer la planilla ahora</button></>}</p>
      )}
      {!datos && <div className="empty plain">Cargando…</div>}
      {datos && (
        <div className="table-wrap rc-tabla">
          <table className="grid">
            <thead><tr><th className="nosort">Destino</th><th className="nosort">Dirección</th><th className="nosort">Horario</th><th className="nosort">Contacto</th><th className="nosort numcol">Viajes (6 meses)</th></tr></thead>
            <tbody>
              {datos.destinos.map((d) => (
                <tr key={d.id} onClick={() => d.puede_editar && setEditando(d)} style={d.puede_editar ? undefined : { cursor: 'default' }} title={d.puede_editar ? undefined : 'Los destinos de la libreta los corrige Logística'}>
                  <td><b>{lindo(d.nombre)}</b>{d.origen === 'hub' && <span className="cr-tag" style={{ marginLeft: 6 }}>Nuevo en el Hub</span>}{d.editado && d.origen !== 'hub' && <span className="cr-tag" style={{ marginLeft: 6 }} title="Lo que se corrigió acá la planilla ya no lo pisa">Corregido</span>}</td>
                  <td>{[d.direccion, d.localidad].filter(Boolean).join(', ')}</td>
                  <td>{d.horario}</td>
                  <td>{[d.contacto, d.telefono].filter(Boolean).join(' · ')}</td>
                  <td className="numcell">{d.veces || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editando && <EditarDestino d={editando === 'nuevo' ? null : editando} puedeSacar={organiza} onClose={() => setEditando(null)} onListo={() => { setEditando(null); setV((x) => x + 1); }} />}
      {meta.me.role === 'admin' && <AdminRecorridos />}
    </>
  );
}

function EditarDestino({ d, puedeSacar, onClose, onListo }: { d: DestinoFila | null; puedeSacar: boolean; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ nombre: d?.nombre ?? '', direccion: d?.direccion ?? '', localidad: d?.localidad ?? '', horario: d?.horario ?? '', contacto: d?.contacto ?? '', telefono: d?.telefono ?? '', observaciones: d?.observaciones ?? '' });
  const [ocupado, setOcupado] = useState(false);
  const guardar = async (extra: Record<string, unknown> = {}) => {
    setOcupado(true);
    try { await http(d ? 'PATCH' : 'POST', d ? `/recorridos/libreta/${d.id}` : '/recorridos/libreta', { ...f, ...extra }); toast(extra.activo === false ? 'Destino sacado de la libreta.' : 'Destino guardado.'); onListo(); }
    catch (e) { toast((e as Error).message, true); setOcupado(false); }
  };
  const campo = (k: keyof typeof f, label: string, ph = '') => <label className="field">{label}<input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></label>;
  return (
    <Modal title={d ? lindo(d.nombre) : 'Nuevo destino'} onClose={onClose} footer={<>
      {d && puedeSacar && <button type="button" className="btn ghost danger" disabled={ocupado} onClick={() => guardar({ activo: false })}>Sacar de la libreta</button>}
      <span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={ocupado || !f.nombre.trim() || !f.direccion.trim()} onClick={() => guardar()}>Guardar</button></>}>
      <div className="rc-form">
        {campo('nombre', 'Nombre', 'IMPREFAS, Nestlé (Vicente López)…')}
        {campo('direccion', 'Dirección', 'Calle y altura')}
        <div className="rc-2">{campo('localidad', 'Localidad')}{campo('horario', 'Horario de atención', '9 a 13')}</div>
        <div className="rc-2">{campo('contacto', 'Contacto')}{campo('telefono', 'Teléfono')}</div>
        {campo('observaciones', 'Observaciones para el chofer', 'Tocar timbre 2, entrar por el portón gris…')}
        {d && d.origen !== 'hub' && <p className="muted small">Viene de la planilla DESTINOS. Lo que cambies acá queda en el Hub y la copia de la planilla ya no lo pisa.</p>}
      </div>
    </Modal>
  );
}

// Para los administradores: el número del remito de traslado y traer el historial de la planilla.
function AdminRecorridos() {
  const toast = useToast();
  const { meta } = useMeta();
  const [cfg, setCfg] = useState<{ remito_pv: string; remito_ultimo: number } | null>(null);
  const [ultimo, setUltimo] = useState('');
  const [meses, setMeses] = useState('6');
  const [res, setRes] = useState<{ pestañas: string[]; filas: number; en_el_hub: number; quienes: Array<{ nombre: string; filas: number; user_id: number | null }> } | null>(null);
  const [alias, setAlias] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { http<{ remito_pv: string; remito_ultimo: number }>('GET', '/recorridos/config').then((c) => { setCfg(c); setUltimo(String(c.remito_ultimo)); }, () => undefined); }, []);
  const traer = async () => {
    setOcupado(true);
    try {
      const r = await http<NonNullable<typeof res>>('POST', '/recorridos/historial', { meses: Number(meses), alias: Object.fromEntries(Object.entries(alias).filter(([, v]) => v !== '')) });
      setRes(r); toast(`Historial: ${r.filas} filas leídas de ${r.pestañas.length} pestañas.`);
    } catch (e) { toast((e as Error).message, true); }
    setOcupado(false);
  };
  if (!cfg) return null;
  return (
    <details className="rc-admin">
      <summary>Configuración (administradores)</summary>
      <div className="rc-form">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="field">Último número de remito de traslado usado<input className="input" inputMode="numeric" value={ultimo} onChange={(e) => setUltimo(e.target.value.replace(/\D/g, ''))} style={{ width: 160 }} /></label>
          <button type="button" className="btn sm" onClick={() => http('PUT', '/recorridos/config', { remito_ultimo: Number(ultimo) }).then((c) => { setCfg(c); toast('Guardado: el próximo remito sigue de ahí.'); }, (e) => toast((e as Error).message, true))}>Guardar</button>
          <span className="muted small">El próximo es el {cfg.remito_pv}-{String(Number(ultimo || 0) + 1).padStart(9, '0')}. Si la planilla se sigue usando un tiempo, ponele el último de la planilla para que no se repitan.</span>
        </div>
        <div>
          <b>Historial de la planilla Recorridos</b>
          <p className="muted small">Trae los viajes de los últimos meses (solo los días que ya pasaron) para que las sugerencias funcionen desde el primer día: a dónde manda cada uno y qué días se va a cada lugar. Se lee con tu usuario de Google, así que tenés que poder abrir la planilla. No aparece en el cronograma y se puede repetir sin duplicar.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="small row" style={{ gap: 6 }}>Meses<input className="input sm" style={{ width: 64 }} inputMode="numeric" value={meses} onChange={(e) => setMeses(e.target.value.replace(/\D/g, ''))} /></label>
            <button type="button" className="btn sm" disabled={ocupado} onClick={traer}>{ocupado ? 'Leyendo la planilla…' : res ? 'Volver a traer' : 'Traer el historial'}</button>
          </div>
          {res && (
            <div className="rc-quienes">
              <p className="small">{res.filas} filas de {res.pestañas.join(', ')}. En el Hub hay {res.en_el_hub} viajes de la planilla. Quién pidió cada uno (si un nombre no se reconoció, elegí el usuario y volvé a traer):</p>
              <ul>
                {res.quienes.map((x) => (
                  <li key={x.nombre}><span>{x.nombre} <span className="muted">({x.filas})</span></span>
                    <Select className="input sm" aria-label={`Usuario de ${x.nombre}`} value={alias[x.nombre] ?? (x.user_id ? String(x.user_id) : '')} onChange={(e) => setAlias({ ...alias, [x.nombre]: e.target.value })}>
                      <option value="">Sin usuario</option>
                      {meta.users.filter((u) => u.active && !u.deleted_at).map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
                    </Select></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

// ---------- Cargar o ver un encargo ----------

interface DiaDestino { fecha: string; feriado: string | null; viajes: string[]; propios: number; habitual: boolean; cuantos: number }
interface InfoDestino { destino: DestinoOpcion; lugar: { nombre: string; horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null; coordinacion: string | null; localidad: string | null } | null;
  dias: DiaDestino[]; habitual: Habitual | null; ultimos: Encargo[] }
interface Sugerencias { frecuentes: DestinoOpcion[]; de_pedidos: DestinoOpcion[]; bases: Base[]; organiza: boolean }
// En la pantalla la cantidad es el texto que se escribe («2,5»); el servidor la pasa a número.
type ItemForm = Omit<ItemEnc, 'cant'> & { cant: number | string | null };
const vacio = (): ItemForm => ({ cant: null, que: '', pdv: null });

export function EncargoModal({ id, inicial, onClose, onListo }: { id?: number; inicial?: { destino?: DestinoOpcion | null; fecha?: string }; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const { meta } = useMeta();
  const [enc, setEnc] = useState<Encargo | null>(null);
  const [sug, setSug] = useState<Sugerencias | null>(null);
  const [destino, setDestino] = useState<DestinoOpcion | null>(inicial?.destino ?? null);
  const [fecha, setFecha] = useState(inicial?.fecha ?? proximoHabil());
  const [llevar, setLlevar] = useState<ItemForm[]>([vacio()]);
  const [retirar, setRetirar] = useState<ItemForm[]>([vacio()]);
  const [extra, setExtra] = useState({ desde: '', hacia: '', horario: '', contacto: '', notas: '', urgente: false, record_id: null as number | null, motivo: '' });
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const fechaElegida = useRef(!!inicial?.fecha);

  useEffect(() => { http<Sugerencias>('GET', '/recorridos/sugerencias').then(setSug, () => setSug({ frecuentes: [], de_pedidos: [], bases: [], organiza: false })); }, []);
  useEffect(() => {
    if (!id) return;
    http<Encargo>('GET', `/recorridos/encargos/${id}`).then((e) => {
      setEnc(e); fechaElegida.current = true; setFecha(e.fecha);
      setDestino({ tipo: e.lugar_id ? 'lugar' : e.company_id ? 'empresa' : 'suelto', key: e.lugar_id ? `l:${e.lugar_id}` : e.company_id ? `c:${e.company_id}` : 'd', nombre: e.destino, direccion: e.direccion,
        detalle: null, lugar_id: e.lugar_id, company_id: e.company_id });
      setLlevar(e.llevar.length ? e.llevar : [vacio()]); setRetirar(e.retirar.length ? e.retirar : [vacio()]);
      setExtra({ desde: e.desde ?? '', hacia: e.hacia ?? '', horario: e.horario ?? '', contacto: e.contacto ?? '', notas: e.notas ?? '', urgente: e.urgente, record_id: e.record_id, motivo: '' });
    }, (err) => setError((err as Error).message));
  }, [id]);

  const organiza = !!sug?.organiza;
  const esSuyo = !enc || enc.user_id === meta.me.id;
  const editable = meta.me.role !== 'viewer' && (!enc || (enc.origen === 'hub' && (organiza || (esSuyo && ['pendiente', 'no_se_pudo'].includes(enc.estado)))));
  const elegirDestino = (d: DestinoOpcion | null) => {
    setDestino(d);
    if (d?.record_id && !extra.record_id) setExtra((x) => ({ ...x, record_id: d.record_id ?? null }));
    if (d?.contacto && !extra.contacto && /[a-z]/i.test(d.contacto)) setExtra((x) => ({ ...x, contacto: d.contacto ?? '' }));
  };

  async function guardar() {
    if (!destino) { setError('Elegí a dónde va.'); return; }
    setOcupado(true); setError('');
    const body = {
      fecha, llevar: llevar.filter((i) => i.que.trim() || i.pdv), retirar: retirar.filter((i) => i.que.trim() || i.pdv), ...extra,
      desde: extra.desde || null, hacia: extra.hacia || null, motivo: undefined,
      destino: { lugar_id: destino.lugar_id, company_id: destino.company_id, nombre: destino.nombre, direccion: destino.direccion, guardar: destino.tipo === 'suelto' && !!(destino as DestinoOpcion & { guardar?: boolean }).guardar },
    };
    try {
      const r = await http<Encargo>(enc ? 'PATCH' : 'POST', enc ? `/recorridos/encargos/${enc.id}` : '/recorridos/encargos', enc && enc.destino === destino.nombre && enc.direccion === destino.direccion ? { ...body, destino: undefined } : body);
      toast(enc ? 'Encargo guardado.' : `Listo: ${lindo(r.destino)}, ${cuando(r.fecha).toLowerCase()}. Logística lo ve en el cronograma.`);
      onListo();
    } catch (e) { setError((e as Error).message); setOcupado(false); }
  }
  async function cambiarEstado(estado: EstadoEnc) {
    if (!enc) return;
    setOcupado(true);
    try { await http('PATCH', `/recorridos/encargos/${enc.id}`, { estado, motivo: extra.motivo || undefined }); toast(estado === 'cancelado' ? 'Encargo cancelado.' : estado === 'hecho' ? 'Marcado como hecho.' : 'Volvió a pendiente.'); onListo(); }
    catch (e) { toast((e as Error).message, true); setOcupado(false); }
  }

  const titulo = enc ? `Encargo a ${lindo(enc.destino)}` : 'Nuevo encargo';
  if (id && !enc) return <Modal title="Encargo" onClose={onClose}>{error ? <div className="aviso warn small">{error}</div> : <div className="empty plain">Cargando…</div>}</Modal>;
  return (
    <Modal wide title={titulo} onClose={onClose} footer={<>
      {enc && editable && enc.estado !== 'cancelado' && <button type="button" className="btn ghost danger" disabled={ocupado} onClick={() => cambiarEstado('cancelado')}>Cancelar encargo</button>}
      {enc && organiza && enc.origen === 'hub' && enc.estado !== 'hecho' && <button type="button" className="btn ghost" disabled={ocupado} onClick={() => cambiarEstado('hecho')}><Icon name="check" size={14} />Marcar hecho</button>}
      {enc && enc.estado !== 'pendiente' && enc.origen === 'hub' && (organiza || (esSuyo && enc.estado === 'cancelado')) && <button type="button" className="btn ghost" disabled={ocupado} onClick={() => cambiarEstado('pendiente')}>Volver a pendiente</button>}
      {enc && enc.origen === 'hub' && enc.llevar.length + enc.retirar.length > 0 && <button type="button" className="btn ghost" onClick={() => abrirRemito(enc.id, toast)}><Icon name="printer" size={14} />{enc.remito ? `Remito ${enc.remito}` : 'Remito de traslado'}</button>}
      <span className="grow" />
      <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancelar' : 'Cerrar'}</button>
      {editable && <button type="button" className="btn primary" disabled={ocupado || !destino} onClick={guardar}>{enc ? 'Guardar' : 'Cargar encargo'}</button>}
    </>}>
      <div className="rc-modal">
        {enc && (
          <div className="rc-estado-linea">
            <span className={`rc-estado ${ESTADO[enc.estado].clase}`}>{ESTADO[enc.estado].nombre}</span>
            <span className="muted small">Lo pidió {enc.quien ?? 'alguien'} {fmtRelative(enc.created_at)}{enc.hecho_chofer ? ` · lo marcó ${enc.hecho_chofer}` : ''}{enc.motivo ? ` · ${enc.motivo}` : ''}{enc.chofer ? ` · va con ${enc.chofer}` : ''}</span>
            {enc.origen === 'planilla' && <span className="cr-tag">De la planilla vieja</span>}
          </div>
        )}
        <section className="rc-paso">
          <h3><span>1</span>¿A dónde?</h3>
          {destino ? <DestinoElegido d={destino} editable={editable && !(enc && enc.origen !== 'hub')} onCambiar={() => setDestino(null)} />
            : <ElegirDestino sug={sug} onElegir={elegirDestino} />}
        </section>
        {destino && (
          <section className="rc-paso">
            <h3><span>2</span>¿Qué día?</h3>
            <ElegirDia destino={destino} fecha={fecha} editable={editable} onFecha={(f) => { fechaElegida.current = true; setFecha(f); }} />
          </section>
        )}
        {destino && (
          <section className="rc-paso">
            <h3><span>3</span>¿Qué hay que hacer?</h3>
            <Items titulo="Llevar" ayuda="Lo que el chofer deja ahí" items={llevar} onChange={setLlevar} editable={editable} />
            {llevar.some((i) => i.que.trim()) && sug?.bases.length ? (
              <div className="rc-base"><span className="small muted">Lo que hay que llevar está en</span>
                {sug.bases.map((b) => <button key={b.id} type="button" disabled={!editable} className={`chip${(extra.desde || sug.bases[0].id) === b.id ? ' on' : ''}`} onClick={() => setExtra({ ...extra, desde: b.id })}>{b.nombre}</button>)}</div>
            ) : null}
            <Items titulo="Retirar" ayuda="Lo que el chofer trae" items={retirar} onChange={setRetirar} editable={editable} />
            {retirar.some((i) => i.que.trim()) && sug?.bases.length ? (
              <div className="rc-base"><span className="small muted">Lo que se retira va a</span>
                {sug.bases.map((b) => <button key={b.id} type="button" disabled={!editable} className={`chip${(extra.hacia || sug.bases[0].id) === b.id ? ' on' : ''}`} onClick={() => setExtra({ ...extra, hacia: b.id })}>{b.nombre}</button>)}</div>
            ) : null}
            <div className="rc-2">
              <label className="field">Horario<input className="input" disabled={!editable} value={extra.horario} onChange={(e) => setExtra({ ...extra, horario: e.target.value })} placeholder="10 a 16, después del mediodía…" maxLength={120} /></label>
              <label className="field">Preguntar por<input className="input" disabled={!editable} value={extra.contacto} onChange={(e) => setExtra({ ...extra, contacto: e.target.value })} placeholder="Nombre y teléfono" maxLength={200} /></label>
            </div>
            <label className="field">Notas para Logística y el chofer<textarea className="input" disabled={!editable} rows={2} value={extra.notas} onChange={(e) => setExtra({ ...extra, notas: e.target.value })} placeholder="Para Delfina Pepe, dejar en recepción…" maxLength={1000} /></label>
            <label className="small row rc-urgente"><input type="checkbox" disabled={!editable} checked={extra.urgente} onChange={(e) => setExtra({ ...extra, urgente: e.target.checked })} />Tiene que ir sí o sí ese día</label>
            {enc && editable && enc.estado === 'pendiente' && <label className="field">Si lo cancelás, ¿por qué? (opcional)<input className="input" value={extra.motivo} onChange={(e) => setExtra({ ...extra, motivo: e.target.value })} placeholder="Ya no hace falta, lo llevo yo…" maxLength={300} /></label>}
          </section>
        )}
        {error && <div className="aviso warn small">{error}</div>}
      </div>
    </Modal>
  );
}

function DestinoElegido({ d, editable, onCambiar }: { d: DestinoOpcion; editable: boolean; onCambiar: () => void }) {
  return (
    <div className="rc-elegido">
      <Icon name="pin" size={18} />
      <div><b>{lindo(d.nombre)}</b><span>{d.direccion ?? 'Sin dirección'}</span>{(d.horario || d.contacto) && <span className="muted small">{[d.horario, d.contacto].filter(Boolean).join(' · ')}</span>}</div>
      {editable && <button type="button" className="btn sm ghost" onClick={onCambiar}>Cambiar</button>}
    </div>
  );
}

// Elegir el destino: tus frecuentes y los de tus pedidos (con cuándo ya se va), o buscar en toda la base, o una dirección.
function ElegirDestino({ sug, onElegir }: { sug: Sugerencias | null; onElegir: (d: DestinoOpcion) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<DestinoOpcion[] | null>(null);
  const [otro, setOtro] = useState(false);
  const [suelto, setSuelto] = useState({ nombre: '', direccion: '', guardar: true });
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    let vivo = true;
    const t = window.setTimeout(() => http<{ destinos: DestinoOpcion[] }>('GET', `/recorridos/destinos${qs({ q })}`).then((r) => { if (vivo) setRes(r.destinos); }, () => undefined), 220);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [q]);
  return (
    <div className="rc-elegir">
      <div className="search"><Icon name="search" />
        <input className="input" autoFocus placeholder="Buscá el lugar: proveedor, cliente, expreso, calle…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar destino" />
      </div>
      {res && (
        <ul className="rc-res">
          {res.map((d) => <li key={d.key}><button type="button" onClick={() => onElegir(d)}><b>{lindo(d.nombre)}</b><span>{d.direccion ?? 'Sin dirección'}</span>
            <em>{d.tipo === 'empresa' ? d.detalle : d.tipo === 'expreso' ? 'Expreso' : d.tipo === 'base' ? 'De Formas' : d.detalle}</em></button></li>)}
          {!res.length && <li className="muted small">No está en la base. Cargalo como «Otro lugar».</li>}
        </ul>
      )}
      {!res && sug && (sug.frecuentes.length > 0 || sug.de_pedidos.length > 0) && (
        <>
          {sug.frecuentes.length > 0 && <Sugeridos titulo="A donde más mandás" items={sug.frecuentes} onElegir={onElegir} />}
          {sug.de_pedidos.length > 0 && <Sugeridos titulo="De tus pedidos y negocios" items={sug.de_pedidos} onElegir={onElegir} />}
        </>
      )}
      {!res && !sug && <div className="muted small">Buscando tus destinos de siempre…</div>}
      {otro ? (
        <div className="rc-otro">
          <div className="rc-2">
            <label className="field">Nombre<input className="input" value={suelto.nombre} onChange={(e) => setSuelto({ ...suelto, nombre: e.target.value })} placeholder="Casa de…, Oficina de…" /></label>
            <label className="field">Dirección<input className="input" value={suelto.direccion} onChange={(e) => setSuelto({ ...suelto, direccion: e.target.value })} placeholder="Calle y altura, localidad" /></label>
          </div>
          <label className="small row"><input type="checkbox" checked={suelto.guardar} onChange={(e) => setSuelto({ ...suelto, guardar: e.target.checked })} />Guardarlo en Destinos (para la próxima)</label>
          <div className="row"><button type="button" className="btn sm primary" disabled={!suelto.direccion.trim()} onClick={() => onElegir({ tipo: 'suelto', key: 'd', nombre: suelto.nombre.trim() || suelto.direccion.trim(), direccion: suelto.direccion.trim(), detalle: null, lugar_id: null, company_id: null, ...{ guardar: suelto.guardar } } as DestinoOpcion)}>Usar esta dirección</button>
            <button type="button" className="btn sm ghost" onClick={() => setOtro(false)}>Cancelar</button></div>
        </div>
      ) : <button type="button" className="cr-link" onClick={() => setOtro(true)}><Icon name="plus" size={12} />Otro lugar (una dirección que no está en la base)</button>}
    </div>
  );
}

function Sugeridos({ titulo, items, onElegir }: { titulo: string; items: DestinoOpcion[]; onElegir: (d: DestinoOpcion) => void }) {
  const hoy = hoyIso();
  return (
    <div className="rc-sug">
      <div className="eyebrow">{titulo}</div>
      <div className="rc-sug-grid">
        {items.map((d) => {
          const prox = d.proximos?.[0];
          return (
            <button key={d.key} type="button" className="rc-sug-item" onClick={() => onElegir(d)} title={d.direccion ?? undefined}>
              <b>{lindo(d.nombre)}</b>
              {d.motivo && <span className="muted small">{d.motivo}</span>}
              {prox ? <span className="rc-va"><i />Ya van {cuando(prox.fecha, hoy).toLowerCase()}</span>
                : d.habitual ? <span className="rc-suele">{d.habitual.texto}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Los próximos días hábiles para ese destino: cuáles ya tienen viaje ahí y cuáles son los de siempre.
function ElegirDia({ destino, fecha, editable, onFecha }: { destino: DestinoOpcion; fecha: string; editable: boolean; onFecha: (f: string) => void }) {
  const [info, setInfo] = useState<InfoDestino | null>(null);
  useEffect(() => {
    let vivo = true;
    setInfo(null);
    http<InfoDestino>('GET', `/recorridos/destino${qs({ lugar_id: destino.lugar_id ?? undefined, company_id: destino.company_id ?? undefined, nombre: destino.nombre, direccion: destino.direccion ?? undefined })}`)
      .then((r) => { if (vivo) setInfo(r); }, () => undefined);
    return () => { vivo = false; };
  }, [destino.lugar_id, destino.company_id, destino.nombre, destino.direccion]);
  const hoy = hoyIso();
  const dia = info?.dias.find((d) => d.fecha === fecha);
  const proximo = info?.dias.find((d) => d.viajes.length && d.fecha > hoy && d.propios < d.viajes.length);
  return (
    <div className="rc-dia-elegir">
      {info && (
        <div className="rc-tira" role="group" aria-label="Día">
          {info.dias.map((d) => (
            <button key={d.fecha} type="button" disabled={!editable || !!d.feriado} aria-pressed={d.fecha === fecha} className={`rc-d${d.fecha === fecha ? ' on' : ''}${d.viajes.length ? ' va' : ''}${d.habitual ? ' suele' : ''}`}
              onClick={() => onFecha(d.fecha)} title={d.feriado ? `Feriado: ${d.feriado}` : d.viajes.length ? `Ese día ya van: ${d.viajes.join(', ')}` : d.habitual ? 'Es uno de los días que se suele ir' : undefined}>
              <span className="rc-d-dia">{d.fecha === hoy ? 'Hoy' : DIAS[D(d.fecha).getDay()].slice(0, 3)}</span>
              <span className="rc-d-num num">{D(d.fecha).getDate()}/{D(d.fecha).getMonth() + 1}</span>
              <span className="rc-d-marca">{d.feriado ? 'Feriado' : d.viajes.length ? 'Ya van' : d.habitual ? 'Suele ir' : ''}</span>
            </button>
          ))}
          {editable && <SelectorFecha valor={fecha} onElegir={(f) => f && onFecha(f)} label="Otro día" className="rc-d otro" title="Otro día"><Icon name="calendar" size={14} /><span className="rc-d-marca">Otro día</span></SelectorFecha>}
        </div>
      )}
      {!info && <div className="muted small">Viendo cuándo se va a {lindo(destino.nombre)}…</div>}
      {info && (
        <div className="rc-pista">
          {dia?.viajes.length && dia.propios === dia.viajes.length ? <span className="rc-va"><i /><b>{cuando(fecha, hoy)} ya tenés un encargo a {lindo(destino.nombre)}.</b> Si es para sumarle algo, podés editar ese; si no, este va en la misma parada.</span>
            : dia?.viajes.length ? <span className="rc-va"><i /><b>{cuando(fecha, hoy)} ya van a {lindo(destino.nombre)}</b> ({dia.viajes.join(', ')}): tu encargo va en la misma parada.</span>
            : <span><b>{cuando(fecha, hoy)}</b> todavía no hay nada para {lindo(destino.nombre)}: va a ser una parada nueva.{info.habitual ? ` ${info.habitual.texto}.` : ''}</span>}
          {proximo && proximo.fecha !== fecha && editable && (
            <span className="rc-mejor">{proximo.fecha > fecha ? 'Si puede esperar' : 'Antes'}, {cuando(proximo.fecha, hoy).toLowerCase()} ya van ({proximo.viajes.join(', ')}).
              <button type="button" className="cr-link" onClick={() => onFecha(proximo.fecha)}>Sumarlo {cuando(proximo.fecha, hoy).toLowerCase()}</button></span>
          )}
          {fecha === hoy && <span className="aviso warn small">Es para hoy: el recorrido puede haber salido. Logística se entera con un aviso; si es urgente, avisale también por teléfono.</span>}
          {[0, 6].includes(D(fecha).getDay()) && <span className="aviso warn small">Cae {DIAS[D(fecha).getDay()]}: fijate que haya recorrido ese día.</span>}
          {info.lugar && (info.lugar.horario || info.lugar.contacto || info.lugar.observaciones) && (
            <span className="muted small">De la libreta: {[info.lugar.horario && `atienden ${info.lugar.horario}`, [info.lugar.contacto, info.lugar.telefono].filter(Boolean).join(' '), info.lugar.observaciones].filter(Boolean).join(' · ')}</span>
          )}
          {info.ultimos.some((e) => e.fecha < hoy) && <span className="muted small">Lo último que se mandó ahí: {info.ultimos.filter((e) => e.fecha < hoy).map((e) => `${corto(e.fecha)} ${resumen(e)}`).slice(0, 2).join(' · ')}</span>}
        </div>
      )}
    </div>
  );
}

function Items({ titulo, ayuda, items, onChange, editable }: { titulo: string; ayuda: string; items: ItemForm[]; onChange: (x: ItemForm[]) => void; editable: boolean }) {
  const set = (i: number, k: keyof ItemForm, v: string) => onChange(items.map((x, j) => (j === i ? { ...x, [k]: k === 'cant' ? (v.replace(/[^\d.,]/g, '') || null) : v || (k === 'pdv' ? null : '') } : x)));
  return (
    <div className="rc-items">
      <div className="rc-items-cab"><b>{titulo}</b><span className="muted small">{ayuda}</span></div>
      {items.map((x, i) => (
        <div key={i} className="rc-item">
          <input className="input sm num" inputMode="decimal" disabled={!editable} value={x.cant ?? ''} onChange={(e) => set(i, 'cant', e.target.value)} placeholder="Cant." aria-label={`${titulo}: cantidad`} />
          <input className="input sm" disabled={!editable} value={x.que} onChange={(e) => set(i, 'que', e.target.value)} placeholder={titulo === 'Llevar' ? 'Muestras de termos, un sobre, 100 bolsas…' : 'Muestra de lona, cajas de hilos…'} aria-label={`${titulo}: qué`} maxLength={200} />
          <input className="input sm num" disabled={!editable} value={x.pdv ?? ''} onChange={(e) => set(i, 'pdv', e.target.value)} placeholder="PDV" aria-label={`${titulo}: PDV`} maxLength={20} />
          {editable && <button type="button" className="btn ghost icon sm" aria-label="Sacar el renglón" disabled={items.length === 1 && !x.que && !x.pdv && x.cant == null} onClick={() => onChange(items.length === 1 ? [vacio()] : items.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>}
        </div>
      ))}
      {editable && <button type="button" className="cr-link" onClick={() => onChange([...items, vacio()])}><Icon name="plus" size={12} />Otro renglón</button>}
    </div>
  );
}
