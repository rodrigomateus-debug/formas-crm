import { useState } from 'react';
import { Link } from 'react-router-dom';
import { achicarImagen, fmtDate, http, qs, recordUrl, useAsync, useMeta, useToast, userName, Icon, type CrmRecord } from '../lib';
import { EstadoEntrega, Modal } from '../components';
import { BotonArchivos } from './Bocetos';

// Remitos de entrega (src/worker/remitos.ts): la tarjeta de la ficha del pedido (qué se entregó, qué falta y los
// remitos, vengan de ClickUp, del CRM o de la app del chofer) y la bandeja de Logística (lo que hay que revisar y los
// links de los choferes).

export interface Control { dato: string; ok: boolean | null; detalle: string }
export interface Remito {
  id: number; record_id: number | null; origen: 'clickup' | 'crm' | 'chofer'; nombre: string | null; mime: string | null;
  estado: 'sin_leer' | 'ok' | 'revisar' | 'duplicado' | 'descartado'; motivo: string | null; repetir: boolean;
  numero: string | null; pdv: string | null; cuit: string | null; cliente: string | null; fecha: string | null;
  recibido_por: string | null; recibido_el: string | null; firmado: boolean | null; reservas: boolean; notas: string | null;
  chofer: string | null; controles: Control[]; candidatos: Array<{ id: number; nombre: string; pdv: string | null }>;
  duplicado_de: number | null; otros_remitos_en_foto: boolean; dudas: string[]; leido_at: string | null; created_at: string;
  items: Array<{ code: string | null; description: string | null; quantity: number | null }>;
  pdv_chofer: string | null;   // el PDV que escribió el chofer en la app
}
interface Linea { code: string | null; name: string; vendido: number | null; entregado: number; falta: number; excede: number }
export interface Entrega {
  estado: string | null; lineas: Linea[]; extras: Array<{ code: string | null; description: string | null; quantity: number | null; numero: string | null }>;
  remitos_ok: number; pendientes: number; reservas: number; sin_productos: boolean; clickup_entregado: boolean; alerta: string | null;
  falta_texto: string | null; cerrada: { el: string; por: number | null; motivo: string | null } | null;
}

const cant = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('es-AR', { maximumFractionDigits: 2 }));
const ESTADO: Record<Remito['estado'], [string, string]> = {
  ok: ['Leído', 'ok'], revisar: ['Para revisar', 'warn'], sin_leer: ['Sin leer', 'info'], duplicado: ['Repetido', 'info'], descartado: ['Descartado', 'bad'],
};
// El número del remito; sin número, el nombre del archivo solo si es de ClickUp (ahí lo pone una persona).
const titulo = (r: Remito) => r.numero ?? (r.origen === 'clickup' && r.nombre ? r.nombre : 'Remito sin número leído');
const origenDe = (r: Remito) => (r.origen === 'clickup' ? 'De ClickUp' : r.origen === 'chofer' ? `Chofer${r.chofer ? `: ${r.chofer}` : ''}` : 'Subido en el CRM');

async function subirRemito(orderId: number, f: File) {
  const fd = new FormData();
  fd.append('archivo', await achicarImagen(f));
  const res = await fetch(`/api/records/order/${orderId}/remitos`, { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data as unknown as { remito: Remito; entrega: Entrega };
}

// ---------- Ficha del pedido ----------

export function RemitosCard({ record, onChange }: { record: CrmRecord; onChange?: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const res = useAsync(() => http<{ remitos: Remito[]; entrega: Entrega; puede_finalizar: boolean; lector: boolean }>('GET', `/records/order/${record.id}/remitos`), [record.id]);
  const [subiendo, setSubiendo] = useState(0);
  const [finalizar, setFinalizar] = useState(false);
  const d = res.data;
  const e = d?.entrega;
  const remitos = d?.remitos ?? [];
  const recargar = () => { res.reload(); onChange?.(); };
  const subir = async (files: File[]) => {
    setSubiendo(files.length);
    for (const f of files) {
      try {
        const { remito: r } = await subirRemito(record.id, f);
        toast(r.estado === 'ok' ? `Remito leído${r.numero ? ` (${r.numero})` : ''}: cuenta para la entrega.`
          : r.estado === 'duplicado' ? 'Ese remito ya estaba en el pedido.'
          : r.estado === 'sin_leer' ? `Remito guardado. ${r.motivo ?? 'Se lee en unos minutos.'}`
          : `Remito guardado, para revisar: ${r.motivo ?? 'no se pudo confirmar.'}`, r.estado === 'revisar');
      } catch (err) { toast((err as Error).message, true); }
      setSubiendo((n) => n - 1);
    }
    recargar();
  };
  const reabrir = async () => {
    try { await http('DELETE', `/records/order/${record.id}/entrega/finalizar`); toast('La entrega quedó abierta de nuevo'); recargar(); }
    catch (err) { toast((err as Error).message, true); }
  };
  const faltan = e?.lineas.filter((l) => l.falta > 0) ?? [];
  const mostrarLineas = !!e && e.lineas.length > 0 && (e.remitos_ok > 0 || !!e.estado);
  const puedeEditar = meta.me.role !== 'viewer';
  return (
    <div className="panel assoc-card remitos-card">
      <div className="panel-head">
        <h3>Entrega</h3>
        {e?.estado && <EstadoEntrega value={e.estado} />}
        {puedeEditar && <BotonArchivos onArchivos={subir} title="Subir la foto o el PDF del remito firmado">{subiendo ? 'Leyendo…' : '+ Remito'}</BotonArchivos>}
      </div>
      {e?.alerta && <div className="panel-body"><div className="aviso warn" role="status">{e.alerta}</div></div>}
      {mostrarLineas && (
        <div className="entrega-lineas">
          {e!.lineas.map((l, i) => (
            <div key={i} className="entrega-linea">
              <span className="entrega-nombre">{l.name}</span>
              <span className="num small grow">{cant(l.entregado)} de {cant(l.vendido)}</span>
              {l.falta > 0 ? <span className="tag warn">faltan {cant(l.falta)}</span>
                : l.excede > 0 ? <span className="tag bad">{cant(l.excede)} de más</span>
                : l.vendido != null ? <span className="tag ok">completo</span> : null}
            </div>
          ))}
        </div>
      )}
      {(e?.extras.length ?? 0) > 0 && (
        <div className="panel-body small"><div className="aviso bad">En los remitos pero no en el pedido: {e!.extras.map((x) => `${cant(x.quantity)} ${x.description ?? x.code ?? ''}`.trim()).join(' · ')}</div></div>
      )}
      {e && e.reservas > 0 && <div className="panel-body small muted" style={{ paddingTop: 0 }}>{e.reservas === 1 ? 'Un remito se recibió' : `${e.reservas} remitos se recibieron`} «a controlar»: el cliente todavía puede reclamar.</div>}
      {e?.cerrada && (
        <div className="panel-body small">
          <div className="aviso info">Finalizada con faltante por {userName(meta, e.cerrada.por)} el {fmtDate(e.cerrada.el)}{e.cerrada.motivo ? `: ${e.cerrada.motivo}` : '.'}
            {d?.puede_finalizar && <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={reabrir}>Reabrir</button>}</div>
        </div>
      )}
      {d?.puede_finalizar && faltan.length > 0 && !e?.cerrada && (
        <div className="panel-body" style={{ paddingTop: 0 }}><button className="btn sm" onClick={() => setFinalizar(true)}>Finalizar con faltante</button></div>
      )}
      {remitos.length > 0 && <div className="remitos-sub small muted">Remitos ({remitos.length})</div>}
      {remitos.map((r) => <RemitoFila key={r.id} r={r} orderId={record.id} onCambio={recargar} />)}
      {!remitos.length && <div className="panel-body muted small">{res.loading ? 'Cargando…' : 'Todavía no hay remitos. Llegan solos de ClickUp y de la app del chofer, o subí la foto acá.'}</div>}
      {d && !d.lector && remitos.some((r) => r.estado === 'sin_leer') && <div className="panel-body small muted">Los remitos se leen cuando esté conectada la API de Claude (Configuración → Integraciones).</div>}
      {finalizar && e && <FinalizarModal orderId={record.id} faltan={faltan} onClose={() => setFinalizar(false)} onDone={() => { setFinalizar(false); recargar(); }} />}
    </div>
  );
}

function FinalizarModal({ orderId, faltan, onClose, onDone }: { orderId: number; faltan: Linea[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const enviar = async () => {
    setEnviando(true);
    try { await http('POST', `/records/order/${orderId}/entrega/finalizar`, { motivo }); toast('Entrega finalizada con faltante'); onDone(); }
    catch (err) { toast((err as Error).message, true); } finally { setEnviando(false); }
  };
  return (
    <Modal title="Finalizar la entrega con faltante" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={enviando || motivo.trim().length < 3} onClick={enviar}>{enviando ? 'Guardando…' : 'Finalizar'}</button>
    </>}>
      <p className="small" style={{ marginTop: 0 }}>El pedido queda como «Finalizada con faltante» y deja de figurar en «Faltan entregas». Lo que falta:</p>
      <ul className="small">{faltan.map((l, i) => <li key={i}>{cant(l.falta)} {l.name}</li>)}</ul>
      <label className="field">Motivo<textarea className="input" rows={3} autoFocus value={motivo} onChange={(ev) => setMotivo(ev.target.value)}
        placeholder="Por ejemplo: el cliente aceptó 990 de 1000 porque 10 salieron falladas." /></label>
    </Modal>
  );
}

function RemitoFila({ r, orderId, onCambio }: { r: Remito; orderId?: number; onCambio: () => void }) {
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const accion = async (body: Record<string, unknown>, ok: string) => {
    setOcupado(true);
    try { await http('POST', `/remitos/${r.id}/revisar`, body); toast(ok); onCambio(); }
    catch (err) { toast((err as Error).message, true); } finally { setOcupado(false); }
  };
  const [label, cls] = ESTADO[r.estado];
  const ajeno = orderId != null && r.record_id !== orderId;
  const productos = r.items.slice(0, 3).map((i) => `${cant(i.quantity)} ${i.description ?? i.code ?? ''}`.trim()).join(' · ');
  return (
    <div className="assoc-item remito-fila">
      <span className={`tag ${cls}`}>{label}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="remito-titulo">{titulo(r)}{r.pdv ? ` · PDV ${r.pdv}` : ''}{r.pdv_chofer ? ' (escrito por el chofer)' : ''}</div>
        <div className="small muted">{[r.fecha && fmtDate(r.fecha), origenDe(r), r.recibido_por && `recibió ${r.recibido_por}`].filter(Boolean).join(' · ')}</div>
        {productos && <div className="small">{productos}{r.items.length > 3 ? ` y ${r.items.length - 3} más` : ''}</div>}
        {r.reservas && <div className="small"><span className="tag warn">Recibido a controlar</span>{r.notas ? <span className="muted"> {r.notas}</span> : null}</div>}
        {(r.estado === 'revisar' || r.estado === 'sin_leer' || r.estado === 'duplicado') && r.motivo && <div className="small warn-text">{r.motivo}</div>}
        {ajeno && <div className="small warn-text">No está en este pedido: puede ser de este (el PDV o el cliente coinciden).</div>}
        {r.controles.length > 0 && (
          <details className="small controles">
            <summary>Cómo se controló</summary>
            <ul>{r.controles.map((c, i) => <li key={i} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '•'} {c.detalle}</li>)}</ul>
          </details>
        )}
        {(r.estado === 'revisar' || r.estado === 'sin_leer') && (
          <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
            {orderId != null && r.estado === 'revisar' && <button className="btn sm" disabled={ocupado} onClick={() => accion({ accion: 'confirmar', pedido: orderId }, 'Remito confirmado en este pedido')}>Es de este pedido</button>}
            <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Leyendo…' : 'Leer de nuevo'}</button>
            <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'descartar' }, 'Remito descartado')}>Descartar</button>
          </div>
        )}
      </div>
      <a className="btn sm" href={`/api/remitos/${r.id}/archivo`} target="_blank" rel="noreferrer">Ver</a>
    </div>
  );
}

// ---------- Bandeja de Logística: la pestaña «Entregas» (/entregas) ----------

export default function RemitosPage() {
  const { meta } = useMeta();
  const [tab, setTab] = useState<'revisar' | 'choferes'>('revisar');
  const puede = meta.me.role === 'admin' || meta.me.profile === 'logistica';
  return (
    <div className="content">
      <div className="page-head"><h1>Entregas</h1></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'revisar'} className={`tab${tab === 'revisar' ? ' on' : ''}`} onClick={() => setTab('revisar')}>Remitos para revisar</button>
        {puede && <button role="tab" aria-selected={tab === 'choferes'} className={`tab${tab === 'choferes' ? ' on' : ''}`} onClick={() => setTab('choferes')}>Choferes</button>}
      </div>
      {tab === 'revisar' ? <Bandeja /> : <Choferes />}
    </div>
  );
}

function Bandeja() {
  const res = useAsync(() => http<{ remitos: Remito[]; lector: boolean }>('GET', '/remitos/revisar'), []);
  const lista = res.data?.remitos ?? [];
  return (
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>Los remitos que no se pudieron adjuntar solos a su pedido (porque algo no cierra) o que no se pudieron leer. Elegí el pedido, descartalo o leelo de nuevo.</p>
      {res.data && !res.data.lector && <div className="aviso warn small">Falta conectar la API de Claude: los remitos se guardan pero no se leen.</div>}
      {lista.map((r) => <RevisionCard key={r.id} r={r} onCambio={() => res.reload()} />)}
      {!lista.length && <div className="empty plain">{res.loading ? 'Cargando…' : 'No hay remitos para revisar.'}</div>}
    </div>
  );
}

function RevisionCard({ r, onCambio }: { r: Remito; onCambio: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(r.pdv ? `PDV ${r.pdv}` : '');
  const [buscar, setBuscar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const busqueda = useAsync(() => (buscar && q.trim().length >= 2 ? http<{ results: CrmRecord[] }>('GET', `/records/order${qs({ q, limit: 6 })}`) : Promise.resolve({ results: [] })), [buscar, q]);
  const accion = async (body: Record<string, unknown>, ok: string) => {
    setOcupado(true);
    try { await http('POST', `/remitos/${r.id}/revisar`, body); toast(ok); onCambio(); }
    catch (err) { toast((err as Error).message, true); } finally { setOcupado(false); }
  };
  const esImagen = (r.mime ?? '').startsWith('image/');
  const candidatos = r.candidatos.length ? r.candidatos : r.record_id ? [{ id: r.record_id, nombre: 'El pedido donde está', pdv: null }] : [];
  return (
    <div className="panel revision">
      <a className="revision-foto" href={`/api/remitos/${r.id}/archivo`} target="_blank" rel="noreferrer" title="Ver el remito entero">
        {esImagen ? <img src={`/api/remitos/${r.id}/archivo`} alt={`Remito ${r.numero ?? r.id}`} loading="lazy" /> : <span className="muted"><Icon name="order" size={28} />Ver PDF</span>}
      </a>
      <div className="revision-datos">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className={`tag ${ESTADO[r.estado][1]}`}>{ESTADO[r.estado][0]}</span>
          <b>{titulo(r)}</b>
          <span className="small muted">{[origenDe(r), fmtDate(r.created_at, true)].join(' · ')}</span>
        </div>
        {r.motivo && <div className="aviso warn small">{r.motivo}</div>}
        <dl className="revision-dl small">
          {r.pdv && <><dt>PDV</dt><dd>{r.pdv}{r.pdv_chofer ? ' (lo escribió el chofer)' : ''}</dd></>}
          {r.cliente && <><dt>Cliente</dt><dd>{r.cliente}{r.cuit ? ` · CUIT ${r.cuit}` : ''}</dd></>}
          {r.fecha && <><dt>Fecha</dt><dd>{fmtDate(r.fecha)}</dd></>}
          {r.recibido_por && <><dt>Recibió</dt><dd>{r.recibido_por}{r.reservas ? ' · a controlar' : ''}</dd></>}
          {r.items.length > 0 && <><dt>Productos</dt><dd>{r.items.map((i) => `${cant(i.quantity)} ${i.description ?? i.code ?? ''}`.trim()).join(' · ')}</dd></>}
        </dl>
        {r.controles.length > 0 && <ul className="controles small">{r.controles.map((c, i) => <li key={i} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '•'} {c.detalle}</li>)}</ul>}
        {r.otros_remitos_en_foto && <div className="small warn-text">En la foto se ve otro remito: se leyó solo el de adelante.</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          {candidatos.map((c) => (
            <button key={c.id} className="btn sm primary" disabled={ocupado} onClick={() => accion({ accion: 'confirmar', pedido: c.id }, 'Remito confirmado en el pedido')}>Es de «{c.nombre}»</button>
          ))}
          {r.record_id && <Link className="btn sm ghost" to={recordUrl('order', r.record_id)}>Abrir el pedido</Link>}
          <button className="btn sm ghost" disabled={ocupado} onClick={() => setBuscar(!buscar)}>Otro pedido…</button>
          <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Un momento…' : 'Leer de nuevo'}</button>
          <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'descartar' }, 'Remito descartado')}>Descartar</button>
        </div>
        {buscar && (
          <div className="stack" style={{ gap: 4 }}>
            <input className="input sm" placeholder="Buscar el pedido: PDV o cliente" value={q} autoFocus onChange={(ev) => setQ(ev.target.value)} />
            {(busqueda.data?.results ?? []).map((o) => (
              <button key={o.id} className="btn sm ghost" style={{ justifyContent: 'flex-start' }} disabled={ocupado}
                onClick={() => accion({ accion: 'confirmar', pedido: o.id }, 'Remito confirmado en el pedido')}>{o.name}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface Chofer { id: number; name: string; created_at: string; last_used_at: string | null; revoked: number; user_name: string; remitos: number; ultimo: string | null }
function Choferes() {
  const toast = useToast();
  const res = useAsync(() => http<Chofer[]>('GET', '/choferes'), []);
  const [nombre, setNombre] = useState('');
  const [nuevo, setNuevo] = useState<{ nombre: string; link: string } | null>(null);
  const crear = async () => {
    try { const r = await http<{ link: string }>('POST', '/choferes', { name: nombre }); setNuevo({ nombre, link: r.link }); setNombre(''); res.reload(); }
    catch (err) { toast((err as Error).message, true); }
  };
  const revocar = async (c: Chofer) => {
    if (!confirm(`¿Dar de baja el link de ${c.name}? Deja de poder mandar remitos.`)) return;
    try { await http('DELETE', `/choferes/${c.id}`); res.reload(); } catch (err) { toast((err as Error).message, true); }
  };
  const copiar = async (t: string) => { try { await navigator.clipboard.writeText(t); toast('Link copiado'); } catch { toast('No se pudo copiar: seleccionalo y copialo a mano.', true); } };
  // El link de un chofer ya creado, para volver a mandárselo si lo perdió.
  const verLink = async (c: Chofer) => {
    try { const r = await http<{ link: string }>('GET', `/choferes/${c.id}/link`); setNuevo({ nombre: c.name, link: r.link }); }
    catch (err) { toast((err as Error).message, true); }
  };
  return (
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>Cada chofer tiene su link personal a la app de remitos: lo abre en el celular, saca la foto del remito firmado y queda en el pedido. El link solo sirve para eso. Si lo pierde, «Ver link» te lo muestra para mandárselo de nuevo; si cambia de celular o el link quedó en manos de otro, dalo de baja y creá uno nuevo.</p>
      <form className="row" style={{ gap: 6 }} onSubmit={(ev) => { ev.preventDefault(); crear(); }}>
        <input className="input" placeholder="Nombre del chofer" value={nombre} onChange={(ev) => setNombre(ev.target.value)} style={{ maxWidth: 280 }} />
        <button className="btn primary" disabled={nombre.trim().length < 2}>Crear link</button>
      </form>
      {nuevo && (
        <div className="panel panel-body stack" style={{ gap: 8 }}>
          <b>Link de {nuevo.nombre}</b>
          <span className="small muted">Mandáselo por WhatsApp y que lo abra en el celular (conviene agregarlo a la pantalla de inicio). Si lo pierde, lo volvés a copiar desde la lista.</span>
          <input className="input" readOnly value={nuevo.link} onFocus={(ev) => ev.target.select()} />
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => copiar(nuevo.link)}>Copiar</button>
            <button className="btn sm ghost" onClick={() => setNuevo(null)}>Cerrar</button>
            <a className="btn sm wa-link" href={`https://wa.me/?text=${encodeURIComponent(`Tu link para mandar los remitos firmados: ${nuevo.link}`)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14} />Mandar por WhatsApp</a>
          </div>
        </div>
      )}
      <div className="panel">
        {(res.data ?? []).map((c) => (
          <div key={c.id} className={`assoc-item${c.revoked ? ' muted' : ''}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div>{c.name}{c.revoked ? ' (dado de baja)' : ''}</div>
              <div className="small muted">{c.remitos} remitos{c.ultimo ? ` · el último ${fmtDate(c.ultimo, true)}` : ''} · creado por {c.user_name}</div>
            </div>
            {!c.revoked && <button className="btn sm" onClick={() => verLink(c)}>Ver link</button>}
            {!c.revoked && <button className="btn sm ghost" onClick={() => revocar(c)}>Dar de baja</button>}
          </div>
        ))}
        {!res.data?.length && <div className="panel-body muted small">{res.loading ? 'Cargando…' : 'Todavía no hay choferes.'}</div>}
      </div>
    </div>
  );
}
