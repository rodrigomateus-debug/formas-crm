import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { achicarImagen, fmtDate, http, qs, recordUrl, useAsync, useMeta, esVentas, useToast, userName, Icon, type CrmRecord, cabecerasVerComo } from '../lib';
import { EstadoEntrega, Modal } from '../components';
import { BotonArchivos } from './Bocetos';
import { DireccionesEntrega } from './Direcciones';
import { Select } from '../Select';

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
  pedido_nombre?: string | null;   // en la bandeja: el nombre del pedido donde está
  revisado_por?: number | null; revisado_at?: string | null;
  revisor?: string | null;   // en «Revisados»: quién lo revisó
  // en «Revisados»: a qué producto del pedido va cada renglón (pedido: de cuál, en un remito de varios pedidos)
  pares?: Array<{ position: number; pedido?: number; i: number; name: string; cantidad: number }>;
  pedidos?: Array<{ id: number; nombre: string }>;   // los pedidos del remito: el principal primero y, si es de varios, los otros
}
interface Linea { code: string | null; name: string; vendido: number | null; entregado: number; falta: number; excede: number }
// Un renglón de los remitos (clave: cuál es, para asignarlo a mano a productos del pedido).
// compartido: de un remito de varios pedidos donde este no es el principal (si no se asigna acá, cuenta en ese pedido).
interface ItemRemito { clave: string; code: string | null; description: string | null; quantity: number | null; numero: string | null; compartido?: string }
interface Asignado extends ItemRemito { a: Array<{ i: number; name: string; cantidad: number }>; por: number | null; el: string }
export interface Entrega {
  estado: string | null; lineas: Linea[]; extras: Array<ItemRemito & { sin_asignar?: boolean }>; asignados: Asignado[];
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
  const res = await fetch(`/api/records/order/${orderId}/remitos`, { method: 'POST', body: fd, credentials: 'same-origin', headers: cabecerasVerComo() });
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
  const [asignar, setAsignar] = useState<string | null>(null);   // la clave del renglón que se asigna a productos del pedido
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
  const deshacer = async (clave: string) => {
    try { await http('POST', `/records/order/${record.id}/entrega/asignar`, { clave, lineas: [] }); toast('Asignación deshecha'); recargar(); }
    catch (err) { toast((err as Error).message, true); }
  };
  const faltan = e?.lineas.filter((l) => l.falta > 0) ?? [];
  const propios = e?.extras.filter((x) => !x.compartido) ?? [];
  const compartidos = e?.extras.filter((x) => x.compartido) ?? [];
  // Lo entregado y lo que falta, solo cuando hay algún remito leído y confirmado: antes, todo daría «falta» sin serlo.
  const mostrarLineas = !!e && e.lineas.length > 0 && e.remitos_ok > 0;
  const sinLeer = remitos.filter((r) => r.estado === 'sin_leer' && r.record_id === record.id).length;
  const paraRevisar = remitos.filter((r) => r.estado === 'revisar').length;
  // Perfil Ventas: ve y baja los remitos de sus pedidos (para mandárselos al cliente); cargarlos, revisarlos y asignarlos
  // es de Logística.
  const puedeEditar = meta.me.role !== 'viewer' && !esVentas(meta.me);
  return (
    <div className="panel assoc-card remitos-card">
      <div className="panel-head">
        <h3>Entrega</h3>
        {e?.estado && <EstadoEntrega value={e.estado} />}
        {puedeEditar && <BotonArchivos onArchivos={subir} title="Subir la foto o el PDF del remito firmado">{subiendo ? 'Leyendo…' : '+ Remito'}</BotonArchivos>}
      </div>
      {/* La dirección (o las direcciones) de entrega, con qué va a cada una (Direcciones.tsx). */}
      <DireccionesEntrega orderId={record.id} onChange={onChange} />
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
      {/* Lo que el remito dice con otro nombre: se puede decir a qué producto (o productos) del pedido corresponde. */}
      {propios.length > 0 && (
        <div className="panel-body small">
          <div className="aviso bad extras-remito">
            <div>En los remitos pero no en el pedido:</div>
            {propios.map((x) => (
              <div key={x.clave + (x.sin_asignar ? '-resto' : '')} className="extra-remito">
                <span className="grow">{`${cant(x.quantity)} ${x.description ?? x.code ?? ''}`.trim()}{x.sin_asignar ? ' (sin asignar)' : ''}</span>
                {puedeEditar && e!.lineas.length > 0 && <button className="btn sm" onClick={() => setAsignar(x.clave)}>Asignar a producto</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Un remito de varios pedidos: lo que se asigna acá cuenta en este pedido; lo demás, en el principal. */}
      {compartidos.length > 0 && (
        <div className="panel-body small">
          <div className="aviso info extras-remito">
            <div>De un remito de varios pedidos: lo que asignes acá cuenta en este pedido; lo demás, en «{compartidos[0].compartido}».</div>
            {compartidos.map((x) => (
              <div key={x.clave + (x.sin_asignar ? '-resto' : '')} className="extra-remito">
                <span className="grow">{`${cant(x.quantity)} ${x.description ?? x.code ?? ''}`.trim()}{x.numero ? <span className="muted"> ({x.numero})</span> : null}</span>
                {puedeEditar && e!.lineas.length > 0 && <button className="btn sm" onClick={() => setAsignar(x.clave)}>Asignar a producto</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      {(e?.asignados.length ?? 0) > 0 && (
        <div className="panel-body small asignados-remito">
          <div className="remitos-sub" style={{ padding: 0 }}>Asignados a mano</div>
          {e!.asignados.map((x) => (
            <div key={x.clave} className="asignado-remito">
              <span className="grow">{`${cant(x.quantity)} ${x.description ?? x.code ?? ''}`.trim()}{x.numero ? <span className="muted"> ({x.numero})</span> : null}
                {' → '}{x.a.map((d) => `${cant(d.cantidad)} ${d.name}`).join(' · ')}
                <span className="muted"> · {userName(meta, x.por)}, {fmtDate(x.el)}</span></span>
              {puedeEditar && <span className="row" style={{ gap: 4 }}>
                <button className="btn sm ghost" onClick={() => setAsignar(x.clave)}>Cambiar</button>
                <button className="btn sm ghost" onClick={() => deshacer(x.clave)}>Deshacer</button>
              </span>}
            </div>
          ))}
        </div>
      )}
      {e && !e.remitos_ok && (sinLeer > 0 || paraRevisar > 0) && (
        <div className="panel-body small muted">{sinLeer > 0
          ? `${sinLeer === 1 ? 'El remito todavía no se leyó' : `${sinLeer} remitos todavía no se leyeron`}: cuando se ${sinLeer === 1 ? 'lea' : 'lean'}, acá se ve qué se entregó y qué falta.`
          : `${paraRevisar === 1 ? 'El remito está' : 'Los remitos están'} para revisar: cuando se confirme, acá se ve qué se entregó y qué falta.`}</div>
      )}
      {e && e.reservas > 0 && <div className="panel-body small muted" style={{ paddingTop: 0 }}>{e.reservas === 1 ? 'Un remito se recibió' : `${e.reservas} remitos se recibieron`} «a controlar»: el cliente todavía puede reclamar.</div>}
      {e?.cerrada && (
        <div className="panel-body small">
          <div className="aviso info">Finalizada con faltante por {userName(meta, e.cerrada.por)} el {fmtDate(e.cerrada.el)}{e.cerrada.motivo ? `: ${e.cerrada.motivo}` : '.'}
            {d?.puede_finalizar && <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={reabrir}>Reabrir</button>}</div>
        </div>
      )}
      {d?.puede_finalizar && mostrarLineas && faltan.length > 0 && !e?.cerrada && (
        <div className="panel-body" style={{ paddingTop: 0 }}><button className="btn sm" onClick={() => setFinalizar(true)}>Finalizar con faltante</button></div>
      )}
      {remitos.length > 0 && <div className="remitos-sub small muted">Remitos ({remitos.length})</div>}
      {remitos.map((r) => <RemitoFila key={r.id} r={r} orderId={record.id} onCambio={recargar} soloVer={!puedeEditar} />)}
      {!remitos.length && <div className="panel-body muted small">{res.loading ? 'Cargando…' : 'Todavía no hay remitos. Llegan solos de ClickUp y de la app del chofer, o subí la foto acá.'}</div>}
      {d && !d.lector && remitos.some((r) => r.estado === 'sin_leer') && <div className="panel-body small muted">Los remitos se leen cuando esté conectada la API de Claude (Configuración → Integraciones).</div>}
      {finalizar && e && <FinalizarModal orderId={record.id} faltan={faltan} onClose={() => setFinalizar(false)} onDone={() => { setFinalizar(false); recargar(); }} />}
      {asignar && e && <AsignarModal orderId={record.id} entrega={e} clave={asignar} onClose={() => setAsignar(null)} onDone={() => { setAsignar(null); recargar(); }} />}
    </div>
  );
}

// A qué producto (o productos) del pedido corresponde un renglón del remito que no se reconoció, y cuánto va a cada uno.
// Se ofrecen los productos a los que todavía les falta (y, si hace falta, los completos). La suma no pasa lo que dice el
// remito: si el remito dice 70 y el producto 100, quedan 30 por entregar.
function AsignarModal({ orderId, entrega, clave, onClose, onDone }: { orderId: number; entrega: Entrega; clave: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const actual = entrega.asignados.find((x) => x.clave === clave);
  const it = actual ?? entrega.extras.find((x) => x.clave === clave);
  const total = it?.quantity ?? null;
  // Lo que falta de cada producto sin contar esta asignación (si se está cambiando).
  const antes = new Map((actual?.a ?? []).map((d) => [d.i, d.cantidad]));
  const disponible = (i: number) => {
    const l = entrega.lineas[i];
    return l.vendido == null ? Infinity : Math.max(0, l.vendido - (l.entregado - (antes.get(i) ?? 0)));
  };
  const [sel, setSel] = useState<Map<number, string>>(() => new Map((actual?.a ?? []).map((d) => [d.i, String(d.cantidad)])));
  const [todos, setTodos] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const num = (v: string | undefined) => Number(String(v ?? '').replace(',', '.'));
  const suma = [...sel.values()].reduce((n, v) => n + (Number.isFinite(num(v)) ? num(v) : 0), 0);
  const opciones = entrega.lineas.map((l, i) => ({ l, i })).filter(({ i }) => todos || disponible(i) > 0 || sel.has(i));
  const tocar = (i: number, on: boolean) => setSel((m) => {
    const n = new Map(m);
    if (!on) { n.delete(i); return n; }
    const resto = total == null ? Infinity : Math.max(0, total - [...m.values()].reduce((s, v) => s + (Number.isFinite(num(v)) ? num(v) : 0), 0));
    const sug = Math.min(disponible(i), resto);
    n.set(i, Number.isFinite(sug) && sug > 0 ? String(sug) : '');
    return n;
  });
  const pasa = total != null && suma > total + 1e-9;
  const invalida = !sel.size || [...sel.values()].some((v) => !(num(v) > 0)) || pasa;
  const guardar = async () => {
    setEnviando(true);
    try {
      await http('POST', `/records/order/${orderId}/entrega/asignar`, { clave, lineas: [...sel.entries()].map(([i, v]) => ({ i, cantidad: num(v) })) });
      toast('Listo: cuenta como entregado');
      onDone();
    } catch (err) { toast((err as Error).message, true); } finally { setEnviando(false); }
  };
  if (!it) return null;
  return (
    <Modal title="¿A qué producto del pedido corresponde?" onClose={onClose} footer={<>
      <span className={`small grow${pasa ? ' bad-text' : ' muted'}`}>{total == null ? `Asignás ${cant(suma)}`
        : pasa ? `Asignás ${cant(suma)} y el remito dice ${cant(total)}` : suma < total ? `Asignás ${cant(suma)} de ${cant(total)}: ${cant(total - suma)} quedan sin asignar` : `Asignás los ${cant(total)}`}</span>
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={enviando || invalida} onClick={guardar}>{enviando ? 'Guardando…' : 'Asignar'}</button>
    </>}>
      <p className="small" style={{ marginTop: 0 }}>El remito{it.numero ? ` ${it.numero}` : ''} dice <b>{`${cant(total)} ${it.description ?? it.code ?? ''}`.trim()}</b>. Elegí el producto (o los productos) del pedido y cuánto va a cada uno: se descuenta de lo que falta entregar.</p>
      <div className="asignar-lista">
        {opciones.map(({ l, i }) => {
          const on = sel.has(i);
          const disp = disponible(i);
          return (
            <label key={i} className={`asignar-op${on ? ' on' : ''}`}>
              <input type="checkbox" checked={on} onChange={(ev) => tocar(i, ev.target.checked)} />
              <span className="grow"><span className="asignar-nombre">{l.name}</span>
                <span className="small muted">{l.vendido == null ? 'Sin cantidad vendida' : disp > 0 ? `Faltan ${cant(disp)} de ${cant(l.vendido)}` : `Completo (${cant(l.vendido)})`}</span></span>
              {on && <input className="input sm num" style={{ width: 90 }} inputMode="decimal" aria-label={`Cantidad para ${l.name}`} value={sel.get(i) ?? ''}
                onChange={(ev) => { const v = ev.target.value; setSel((m) => new Map(m).set(i, v)); }} />}
            </label>
          );
        })}
        {!opciones.length && <div className="small muted">A ningún producto del pedido le falta entregar.</div>}
      </div>
      {entrega.lineas.some((_, i) => !(disponible(i) > 0) && !sel.has(i)) && (
        <label className="row small muted" style={{ marginTop: 8 }}><input type="checkbox" checked={todos} onChange={(ev) => setTodos(ev.target.checked)} />Mostrar también los productos completos</label>
      )}
    </Modal>
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

function RemitoFila({ r, orderId, onCambio, soloVer }: { r: Remito; orderId?: number; onCambio: () => void; soloVer?: boolean }) {
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const accion = async (body: Record<string, unknown>, ok: string) => {
    setOcupado(true);
    try { await http('POST', `/remitos/${r.id}/revisar`, body); toast(ok); onCambio(); }
    catch (err) { toast((err as Error).message, true); } finally { setOcupado(false); }
  };
  const [label, cls] = ESTADO[r.estado];
  const ajeno = orderId != null && r.record_id !== orderId && (r.estado === 'revisar' || r.estado === 'sin_leer');
  const productos = r.items.slice(0, 3).map((i) => `${cant(i.quantity)} ${i.description ?? i.code ?? ''}`.trim()).join(' · ');
  const [notasAbiertas, setNotasAbiertas] = useState(false);
  const notasLargas = (r.notas ?? '').length > 110;
  const otrosPedidos = (r.pedidos ?? []).length > 1 ? r.pedidos!.filter((p) => p.id !== orderId) : [];
  return (
    <div className="assoc-item remito-fila">
      {/* Arriba, en una línea: el estado, el número y «Ver». Abajo, los datos a todo el ancho de la tarjeta. */}
      <div className="remito-cabeza">
        <span className={`tag ${cls}`}>{label}</span>
        <span className="remito-titulo grow">{titulo(r)}</span>
        <a className="btn sm" href={`/api/remitos/${r.id}/archivo`} target="_blank" rel="noreferrer">Ver</a>
        <a className="btn sm ghost icon" href={`/api/remitos/${r.id}/archivo?descargar=1`} title="Descargar el remito (para mandárselo al cliente)" aria-label="Descargar el remito"><Icon name="download" size={14} /></a>
      </div>
      <div className="remito-cuerpo">
        <div className="small muted">{[r.pdv && `PDV ${r.pdv}${r.pdv_chofer ? ' (escrito por el chofer)' : ''}`, r.fecha && fmtDate(r.fecha), origenDe(r), r.recibido_por && `recibió ${r.recibido_por}`].filter(Boolean).join(' · ')}</div>
        {productos && <div className="small">{productos}{r.items.length > 3 ? ` y ${r.items.length - 3} más` : ''}</div>}
        {otrosPedidos.length > 0 && (
          <div className="small">Remito de varios pedidos: también {otrosPedidos.map((p, k) => <span key={p.id}>{k ? ' y ' : ''}<Link to={recordUrl('order', p.id)}>{p.nombre}</Link></span>)}</div>
        )}
        {r.reservas && <div><span className="tag warn">Recibido a controlar</span></div>}
        {r.notas && (
          <div className="small muted">
            <span className={notasLargas && !notasAbiertas ? 'clamp-2' : undefined}>{r.notas}</span>
            {notasLargas && <button type="button" className="link-btn" onClick={() => setNotasAbiertas(!notasAbiertas)}>{notasAbiertas ? 'ver menos' : 'ver más'}</button>}
          </div>
        )}
        {(r.estado === 'revisar' || r.estado === 'sin_leer' || r.estado === 'duplicado') && r.motivo && <div className="small warn-text">{r.motivo}</div>}
        {ajeno && <div className="small warn-text">No está en este pedido: puede ser de este (el PDV o el cliente coinciden).</div>}
        {r.controles.length > 0 && (
          <details className="small controles">
            <summary>Cómo se controló</summary>
            <ul>{r.controles.map((c, i) => <li key={i} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '•'} {c.detalle}</li>)}</ul>
          </details>
        )}
        {!soloVer && (r.estado === 'revisar' || r.estado === 'sin_leer') && (
          <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
            {orderId != null && r.estado === 'revisar' && <button className="btn sm" disabled={ocupado} onClick={() => accion({ accion: 'confirmar', pedido: orderId }, 'Remito confirmado en este pedido')}>Es de este pedido</button>}
            <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Leyendo…' : 'Leer de nuevo'}</button>
            <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'descartar' }, 'Remito descartado')}>Descartar</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Bandeja de Logística: la pestaña «Entregas» (/entregas) ----------

export default function RemitosPage() {
  const { meta } = useMeta();
  const [tab, setTab] = useState<'revisar' | 'revisados' | 'choferes'>('revisar');
  const puede = meta.me.role === 'admin' || meta.me.profile === 'logistica';
  return (
    <div className="content">
      <div className="page-head"><h1>Entregas</h1></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'revisar'} className={`tab${tab === 'revisar' ? ' on' : ''}`} onClick={() => setTab('revisar')}>Remitos para revisar</button>
        <button role="tab" aria-selected={tab === 'revisados'} className={`tab${tab === 'revisados' ? ' on' : ''}`} onClick={() => setTab('revisados')}>Revisados</button>
        {puede && <button role="tab" aria-selected={tab === 'choferes'} className={`tab${tab === 'choferes' ? ' on' : ''}`} onClick={() => setTab('choferes')}>Choferes</button>}
      </div>
      {tab === 'revisar' ? <Bandeja /> : tab === 'revisados' ? <Revisados /> : <Choferes />}
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

// Lo que ya se revisó (confirmado, asignado, descartado), el más reciente primero: qué se hizo, quién y cuándo, y los
// mismos botones para corregirlo (otro pedido, otros productos, descartarlo o leerlo de nuevo).
function Revisados() {
  const res = useAsync(() => http<{ remitos: Remito[] }>('GET', '/remitos/revisados'), []);
  const lista = res.data?.remitos ?? [];
  return (
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>Los remitos que ya revisó alguien: a qué pedido se confirmaron (y a qué producto va cada renglón) o por qué se descartaron. Si algo quedó mal, corregilo desde acá.</p>
      {lista.map((r) => <RevisionCard key={r.id} r={r} revisado onCambio={() => res.reload()} />)}
      {!lista.length && <div className="empty plain">{res.loading ? 'Cargando…' : 'Todavía no se revisó ningún remito.'}</div>}
    </div>
  );
}

// Lo que se decidió en la revisión, en palabras.
function resultado(r: Remito) {
  const varios = (r.pedidos ?? []).length > 1;
  const pedido = varios ? r.pedidos!.map((p) => `«${p.nombre}»`).join(' y ') : r.pedido_nombre ? `«${r.pedido_nombre}»` : 'el pedido';
  if (r.estado === 'ok') return `Confirmado en ${pedido}`;
  if (r.estado === 'descartado') return `Descartado${r.motivo ? `: ${r.motivo}` : ''}`;
  if (r.estado === 'duplicado') return `Repetido${r.motivo ? `: ${r.motivo}` : ''}`;
  if (r.estado === 'revisar') return `Asignado a ${pedido}, falta confirmarlo`;
  return 'Se volvió a leer';
}

// Para cada producto del remito, su par en el pedido (cuando el remito los nombra distinto y no se reconocieron). Los
// productos del pedido, con lo que falta entregar de cada uno; «Que lo busque solo» deja que el CRM lo empareje. En un
// remito de varios pedidos, los productos de todos, agrupados por pedido: el valor es «pedido:producto».
interface LineaPedido { name: string; vendido: number | null; falta: number }
interface PedidoLite { id: number; nombre: string }
function ParesProductos({ r, pedidos, pares, onChange }: { r: Remito; pedidos: PedidoLite[]; pares: Record<number, string>; onChange: (p: Record<number, string>) => void }) {
  const [lineas, setLineas] = useState<Record<number, LineaPedido[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = pedidos.map((p) => p.id).join(',');
  useEffect(() => {
    let vivo = true;
    setLineas(null);
    (async () => {
      try {
        const out: Record<number, LineaPedido[]> = {};
        for (const p of pedidos) {
          // Primero los productos (si el pedido todavía no los tiene, los trae de Finnegans); después, cuánto falta de cada uno.
          await http('GET', `/records/order/${p.id}/products`);
          out[p.id] = (await http<{ entrega: { lineas: LineaPedido[] } }>('GET', `/records/order/${p.id}/remitos`)).entrega.lineas;
        }
        if (vivo) { setLineas(out); setError(null); }
      } catch (err) { if (vivo) setError((err as Error).message); }
    })();
    return () => { vivo = false; };
  }, [ids]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="small warn-text">No se pudieron traer los productos del pedido: {error}</div>;
  if (!lineas) return <div className="small muted">Cargando los productos del pedido…</div>;
  const varios = pedidos.length > 1;
  if (!pedidos.some((p) => lineas[p.id]?.length)) return <div className="small muted">{varios ? 'Los pedidos todavía no tienen productos cargados' : 'El pedido todavía no tiene productos cargados'}: confirmalo y asigná los productos desde la ficha del pedido.</div>;
  // Con varios pedidos, cada producto lleva adelante su pedido (el PDV): así se ve también con el desplegable cerrado.
  const opciones = (p: PedidoLite) => (lineas[p.id] ?? []).map((l, i) => (
    <option key={`${p.id}:${i}`} value={`${p.id}:${i}`}>{varios ? `${p.nombre.split(' · ')[0]} · ` : ''}{l.name}{l.vendido != null ? ` · faltan ${cant(l.falta)} de ${cant(l.vendido)}` : ''}</option>
  ));
  return (
    <div className="pares-productos">
      <div className="small"><b>{varios ? '¿A qué pedido y producto va cada uno?' : '¿A qué producto del pedido corresponde cada uno?'}</b></div>
      {r.items.map((it, k) => (
        <div key={k} className="par-producto">
          <span className="small par-remito">{`${cant(it.quantity)} ${it.description ?? it.code ?? ''}`.trim()}</span>
          <span className="small muted" aria-hidden="true">→</span>
          <Select className="input sm" value={pares[k] ?? ''} aria-label={`Producto del pedido para ${it.description ?? it.code ?? 'este renglón'}`}
            onChange={(ev) => { const n = { ...pares }; if (ev.target.value === '') delete n[k]; else n[k] = ev.target.value; onChange(n); }}>
            <option value="">{varios ? `Que lo busque solo (en «${pedidos[0].nombre}»)` : 'Que lo busque solo'}</option>
            {varios ? pedidos.map((p) => <optgroup key={p.id} label={p.nombre}>{opciones(p)}</optgroup>) : opciones(pedidos[0])}
          </Select>
        </div>
      ))}
    </div>
  );
}

// Buscar un pedido por PDV o cliente.
function BuscarPedido({ inicial, excluir = [], ocupado, onElegir, placeholder }: { inicial: string; excluir?: number[]; ocupado: boolean; onElegir: (o: CrmRecord) => void; placeholder: string }) {
  const [q, setQ] = useState(inicial);
  const busqueda = useAsync(() => (q.trim().length >= 2 ? http<{ results: CrmRecord[] }>('GET', `/records/order${qs({ q, limit: 6 })}`) : Promise.resolve({ results: [] })), [q]);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input className="input sm" placeholder={placeholder} value={q} autoFocus onChange={(ev) => setQ(ev.target.value)} />
      {(busqueda.data?.results ?? []).filter((o) => !excluir.includes(o.id)).map((o) => (
        <button key={o.id} className="btn sm ghost" style={{ justifyContent: 'flex-start' }} disabled={ocupado} onClick={() => onElegir(o)}>{o.name}</button>
      ))}
    </div>
  );
}

function RevisionCard({ r, onCambio, revisado }: { r: Remito; onCambio: () => void; revisado?: boolean }) {
  const toast = useToast();
  const [buscar, setBuscar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const accion = async (body: Record<string, unknown>, ok: string) => {
    setOcupado(true);
    try { await http('POST', `/remitos/${r.id}/revisar`, body); toast(ok); onCambio(); }
    catch (err) { toast((err as Error).message, true); } finally { setOcupado(false); }
  };
  const esImagen = (r.mime ?? '').startsWith('image/');
  // Revisado: el pedido donde quedó va primero (volver a confirmarlo sirve para cambiar los productos).
  const enPedido = r.record_id ? [{ id: r.record_id, nombre: r.pedido_nombre ?? 'el pedido donde está', pdv: null }] : [];
  const candidatos = revisado ? [...enPedido, ...r.candidatos.filter((c) => c.id !== r.record_id)] : r.candidatos.length ? r.candidatos : enPedido;
  // Si el pedido está identificado pero sus productos no coinciden con los del remito, se elige el par de cada uno.
  const destino = candidatos.length === 1 ? candidatos[0].id : revisado && r.record_id ? r.record_id : null;
  const productosNoCierran = r.controles.some((c) => c.dato === 'Productos' && c.ok !== true) || (r.pares?.length ?? 0) > 0;
  // El par de cada renglón, como «pedido:producto».
  const [pares, setPares] = useState<Record<number, string>>(() => Object.fromEntries((r.pares ?? []).map((p) => [p.position, `${p.pedido ?? r.record_id}:${p.i}`])));
  const [elegir, setElegir] = useState(!revisado);
  // Un remito de varios pedidos (un camión, un remito, dos PDV): los pedidos, el principal primero. null: de un solo pedido.
  const [varios, setVarios] = useState<PedidoLite[] | null>(() => ((r.pedidos ?? []).length > 1 ? r.pedidos! : null));
  const [sumar, setSumar] = useState(false);
  const productos = (pedidos: number[]) => Object.entries(pares).map(([position, v]) => {
    const [pedido, i] = v.split(':').map(Number);
    return { position: Number(position), pedido, i };
  }).filter((x) => pedidos.includes(x.pedido));
  const conPares = (pedido: number) => ({ accion: 'confirmar', pedido, ...(pedido === destino && Object.keys(pares).length ? { productos: productos([pedido]) } : {}) });
  const empezarVarios = () => {
    // Arranca con el pedido donde está (o los posibles, si el PDV no coincide en los dos lugares) y se suman los demás.
    const base = revisado && r.record_id ? [{ id: r.record_id, nombre: r.pedido_nombre ?? 'el pedido' }] : candidatos.map((c) => ({ id: c.id, nombre: c.nombre }));
    setVarios(base);
    setSumar(true);
    setBuscar(false);
    setElegir(true);
  };
  const confirmarVarios = () => {
    const ids = varios!.map((p) => p.id);
    return accion({ accion: 'confirmar', pedido: ids[0], pedidos: ids.slice(1), productos: productos(ids) },
      ids.length > 1 ? `Remito confirmado en los ${ids.length} pedidos` : 'Remito confirmado en el pedido');
  };
  const quitarPedido = (id: number) => {
    setVarios((v) => v!.filter((p) => p.id !== id));
    setPares((ps) => Object.fromEntries(Object.entries(ps).filter(([, v]) => Number(v.split(':')[0]) !== id)));
  };
  const nombreDe = (id: number | undefined) => r.pedidos?.find((p) => p.id === id)?.nombre;
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
        {revisado ? (
          <div className="aviso info small">{resultado(r)}{r.revisado_at ? ` · ${r.revisor ?? 'alguien'}, ${fmtDate(r.revisado_at, true)}` : ''}</div>
        ) : r.motivo && <div className="aviso warn small">{r.motivo}</div>}
        <dl className="revision-dl small">
          {r.pdv && <><dt>PDV</dt><dd>{r.pdv}{r.pdv_chofer ? ' (lo escribió el chofer)' : ''}</dd></>}
          {r.cliente && <><dt>Cliente</dt><dd>{r.cliente}{r.cuit ? ` · CUIT ${r.cuit}` : ''}</dd></>}
          {r.fecha && <><dt>Fecha</dt><dd>{fmtDate(r.fecha)}</dd></>}
          {r.recibido_por && <><dt>Recibió</dt><dd>{r.recibido_por}{r.reservas ? ' · a controlar' : ''}</dd></>}
          {r.items.length > 0 && <><dt>Productos</dt><dd>{r.items.map((i) => `${cant(i.quantity)} ${i.description ?? i.code ?? ''}`.trim()).join(' · ')}</dd></>}
        </dl>
        {r.controles.length > 0 && <ul className="controles small">{r.controles.map((c, i) => <li key={i} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '•'} {c.detalle}</li>)}</ul>}
        {r.otros_remitos_en_foto && <div className="small warn-text">En la foto se ve otro remito: se leyó solo el de adelante.</div>}
        {revisado && (r.pares?.length ?? 0) > 0 && (
          <div className="small">Productos: {r.pares!.map((p) => `${cant(r.items[p.position]?.quantity)} ${r.items[p.position]?.description ?? r.items[p.position]?.code ?? ''} → ${p.name}${(r.pedidos ?? []).length > 1 && nombreDe(p.pedido) ? ` (${nombreDe(p.pedido)})` : ''}`).join(' · ')}</div>
        )}
        {varios ? (
          // Remito de varios pedidos: cuáles son, a cuál va cada renglón y confirmar en todos.
          <div className="varios-pedidos">
            <div className="small"><b>Pedidos de este remito</b></div>
            {varios.map((p, k) => (
              <div key={p.id} className="row small varios-pedido">
                <span className="grow">{p.nombre}{k === 0 && varios.length > 1 ? <span className="muted"> · principal: lo que no se elija abajo se busca acá</span> : null}</span>
                {varios.length > 1 && <button className="btn sm ghost" disabled={ocupado} onClick={() => quitarPedido(p.id)}>Quitar</button>}
              </div>
            ))}
            {sumar
              ? <BuscarPedido inicial="" excluir={varios.map((p) => p.id)} ocupado={ocupado} placeholder="Sumar otro pedido: PDV o cliente"
                  onElegir={(o) => { setVarios((v) => [...(v ?? []), { id: o.id, nombre: o.name }]); setSumar(false); }} />
              : <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setSumar(true)}>+ Sumar otro pedido</button>}
            {varios.length > 0 && r.items.length > 0 && <ParesProductos r={r} pedidos={varios} pares={pares} onChange={setPares} />}
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn sm primary" disabled={ocupado || !varios.length} onClick={confirmarVarios}>
                {varios.length > 1 ? `Confirmar en los ${varios.length} pedidos` : varios.length ? `Es de «${varios[0].nombre}»` : 'Elegí los pedidos'}</button>
              <button className="btn sm ghost" disabled={ocupado} onClick={() => { setVarios(null); setSumar(false); }}>Cancelar</button>
            </div>
          </div>
        ) : (
          <>
            {destino && productosNoCierran && r.items.length > 0 && (elegir
              ? <ParesProductos r={r} pedidos={[{ id: destino, nombre: candidatos.find((c) => c.id === destino)?.nombre ?? 'el pedido' }]} pares={pares} onChange={setPares} />
              : <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setElegir(true)}>Cambiar a qué producto va cada uno</button>)}
            <div className="row wrap" style={{ gap: 6 }}>
              {candidatos.map((c) => {
                // Ya confirmado en ese pedido: solo hace falta el botón para guardar los productos si se están cambiando.
                const yaEsta = revisado && c.id === r.record_id && r.estado === 'ok';
                if (yaEsta && !elegir) return null;
                return (
                  <button key={c.id} className="btn sm primary" disabled={ocupado} onClick={() => accion(conPares(c.id), yaEsta ? 'Productos guardados' : 'Remito confirmado en el pedido')}>
                    {yaEsta ? 'Guardar los productos' : `Es de «${c.nombre}»`}</button>
                );
              })}
              {r.record_id && <Link className="btn sm ghost" to={recordUrl('order', r.record_id)}>Abrir el pedido</Link>}
              <button className="btn sm ghost" disabled={ocupado} onClick={() => setBuscar(!buscar)}>Otro pedido…</button>
              {r.estado !== 'descartado' && <button className="btn sm ghost" disabled={ocupado} onClick={empezarVarios}>Es de varios pedidos…</button>}
              <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Un momento…' : 'Leer de nuevo'}</button>
              {r.estado !== 'descartado' && <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'descartar' }, 'Remito descartado')}>Descartar</button>}
            </div>
            {buscar && <BuscarPedido inicial={r.pdv ? `PDV ${r.pdv}` : ''} ocupado={ocupado} placeholder="Buscar el pedido: PDV o cliente"
              onElegir={(o) => accion({ accion: 'confirmar', pedido: o.id }, 'Remito confirmado en el pedido')} />}
          </>
        )}
        {varios && (
          <div className="row wrap" style={{ gap: 6 }}>
            {(r.pedidos ?? []).map((p) => <Link key={p.id} className="btn sm ghost" to={recordUrl('order', p.id)}>Abrir {p.nombre}</Link>)}
            <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Un momento…' : 'Leer de nuevo'}</button>
            {r.estado !== 'descartado' && <button className="btn sm ghost" disabled={ocupado} onClick={() => accion({ accion: 'descartar' }, 'Remito descartado')}>Descartar</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// `usuario`: es de Formas y entra con su usuario del Hub; `con_link`: además tiene link (o solo link, si no es de Formas).
interface Chofer { id: number; name: string; created_at: string; last_used_at: string | null; revoked: number; user_name: string; remitos: number; ultimo: string | null; usuario?: number; con_link?: number }
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
      <p className="small muted" style={{ margin: 0 }}>Cada chofer tiene su link personal a la app de remitos: lo abre en el celular, saca la foto del remito firmado y queda en el pedido. El link solo sirve para eso. Si lo pierde, «Ver link» te lo muestra para mandárselo de nuevo; si cambia de celular o el link quedó en manos de otro, dalo de baja y creá uno nuevo. Los choferes de Formas no necesitan link: abren la app y tocan «Entrar con mi usuario de Formas».</p>
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
              <div className="small muted">{c.remitos} remitos{c.ultimo ? ` · el último ${fmtDate(c.ultimo, true)}` : ''}{c.usuario && !c.con_link ? ' · entra con su usuario del Hub' : ` · creado por ${c.user_name}`}{c.usuario && c.con_link ? ' · también entra con su usuario del Hub' : ''}</div>
            </div>
            {!c.revoked && (!c.usuario || !!c.con_link) && <button className="btn sm" onClick={() => verLink(c)}>Ver link</button>}
            {!c.revoked && (!c.usuario || !!c.con_link) && <button className="btn sm ghost" onClick={() => revocar(c)}>Dar de baja</button>}
          </div>
        ))}
        {!res.data?.length && <div className="panel-body muted small">{res.loading ? 'Cargando…' : 'Todavía no hay choferes.'}</div>}
      </div>
    </div>
  );
}
