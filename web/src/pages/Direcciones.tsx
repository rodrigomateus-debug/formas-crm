import { useEffect, useMemo, useRef, useState } from 'react';
import { http, qs, useAsync, useDebounced, useMeta, useToast, Icon } from '../lib';
import { Modal } from '../components';

// Direcciones de entrega del pedido (src/worker/direcciones.ts), arriba de la tarjeta «Entrega».
// Por defecto, una dirección y todo va ahí. Con varias, cuánto de cada producto lleva cada una; lo repartido se descuenta
// del total de cada producto y no se puede pasar de lo que tiene el pedido. Las direcciones se eligen de Google Maps
// (quedan validadas); escritas a mano quedan «sin validar».
// Retira en Formas (pedido de Rodrigo del 13/11/2026): en vez de enviarlo, lo retira el cliente en una de las direcciones de
// Formas (Depósito Gral. Roca u Oficina Matienzo). Es una dirección más: también sirve repartido (parte retira, parte se envía).

interface Direccion { id: number; direccion: string; detalle: string | null; place_id: string | null; validada: boolean; precisa: boolean; maps: string; localidad: string | null;
  retira: string | null; retira_nombre: string | null }
interface Producto { clave: string; nombre: string; codigo: string | null; total: number | null; asignado: number; quedan: number | null }
interface Base { id: string; nombre: string; direccion: string }
interface Datos { direcciones: Direccion[]; cantidades: Array<{ direccion_id: number; clave: string; cantidad: number }>; productos: Producto[]; varias: boolean;
  sugerida: string | null; maps: boolean; sin_repartir: number; bases: Base[] }
interface Sugerencia { place_id: string; texto: string; principal: string; secundario: string }

const cant = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

function Validacion({ d }: { d: Pick<Direccion, 'validada' | 'precisa'> }) {
  if (!d.validada) return <span className="tag warn" title="Cargada a mano: no se verificó con Google Maps. Elegila de las sugerencias de Google para validarla.">Sin validar</span>;
  if (!d.precisa) return <span className="tag warn" title="Google la encontró, pero sin la altura (calle y número). Conviene elegir la dirección exacta.">Sin altura</span>;
  return <span className="tag ok" title="Elegida de Google Maps: existe y está ubicada en el mapa.">Validada en Google Maps</span>;
}

export function DireccionesEntrega({ orderId, onChange }: { orderId: number; onChange?: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const res = useAsync(() => http<Datos>('GET', `/records/order/${orderId}/direcciones`), [orderId]);
  const [editar, setEditar] = useState<null | { varias: boolean }>(null);
  const [guardando, setGuardando] = useState(false);
  // «Retira en Formas ▾»: las direcciones de Formas se despliegan abajo, dentro de la tarjeta (en la vista previa, angosta,
  // un globo se salía del panel).
  const [elegirRetira, setElegirRetira] = useState(false);
  const puede = meta.me.role !== 'viewer';
  const d = res.data;
  if (!d) return null;
  const dirs = d.direcciones;
  const items = (dirId: number) => d.cantidades.filter((c) => c.direccion_id === dirId && c.cantidad > 0);
  const unidades = (dirId: number) => items(dirId).reduce((s, c) => s + c.cantidad, 0);
  // Retira en Formas, de un toque (sin abrir el cuadro): queda como la única «dirección» del pedido.
  const retirar = async (b: Base) => {
    setGuardando(true);
    try {
      await http('PUT', `/records/order/${orderId}/direcciones`, { direcciones: [{ retira: b.id }] });
      toast(`Retira en Formas: ${b.nombre}`);
      res.reload(); onChange?.();
    } catch (e) { toast((e as Error).message, true); } finally { setGuardando(false); }
  };
  const soloRetira = dirs.length === 1 && !!dirs[0].retira;
  return (
    <div className="panel-body direcciones">
      <div className="remitos-sub" style={{ padding: 0 }}>{dirs.length > 1 ? `Entrega en ${dirs.length} direcciones` : soloRetira ? 'Retira en Formas' : 'Dirección de entrega'}</div>
      {!dirs.length && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="aviso warn small">Este pedido todavía no tiene dirección de entrega.</div>
          {puede && <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={guardando} onClick={() => setEditar({ varias: false })}><Icon name="pin" size={14} />Cargar dirección</button>
            {d.bases.length > 0 && (
              <button className="btn sm" disabled={guardando} aria-expanded={elegirRetira} onClick={() => setElegirRetira((x) => !x)}
                title="El cliente lo retira en una de las direcciones de Formas: no va en el recorrido del chofer">
                <Icon name="company" size={14} />Retira en Formas
                <span style={{ display: 'inline-flex', transform: elegirRetira ? 'rotate(180deg)' : undefined }}><Icon name="down" size={12} /></span>
              </button>
            )}
          </div>}
          {puede && elegirRetira && (
            <div className="retira-lista" role="group" aria-label="¿En cuál de las direcciones de Formas lo retira?">
              {d.bases.map((b) => (
                <button key={b.id} type="button" className="retira-item" disabled={guardando} onClick={() => retirar(b)}>
                  <Icon name="company" size={14} />
                  <span><span className="retira-nombre">{b.nombre}</span><span className="small muted">{b.direccion}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {dirs.map((x, i) => (
        <div key={x.id} className="direccion">
          <Icon name={x.retira ? 'company' : 'pin'} size={16} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="direccion-texto">{dirs.length > 1 && <span className="muted">{i + 1}. </span>}
              {x.retira ? (soloRetira ? x.retira_nombre : <>Retira en Formas: {x.retira_nombre}</>) : x.direccion}</div>
            {x.retira && <div className="small muted">{x.direccion}</div>}
            {x.detalle && <div className="small muted">{x.detalle}</div>}
            <div className="row wrap small" style={{ gap: 6, marginTop: 2 }}>
              {x.retira ? <span className="tag info" title="No va en el recorrido del chofer: el cliente lo retira en esta dirección de Formas.">Lo retira el cliente</span> : <Validacion d={x} />}
              {(x.validada || x.retira) && <a href={x.maps} target="_blank" rel="noreferrer">Ver en el mapa</a>}
              {dirs.length > 1 && <span className="muted">{items(x.id).length ? `${items(x.id).length} ${items(x.id).length === 1 ? 'producto' : 'productos'} · ${cant(unidades(x.id))} u.` : 'Sin productos asignados'}</span>}
            </div>
          </div>
        </div>
      ))}
      {d.varias && d.sin_repartir > 0 && (
        <div className="aviso warn small">{d.sin_repartir === 1 ? 'Queda 1 producto' : `Quedan ${d.sin_repartir} productos`} sin repartir entre las direcciones:
          {' '}{d.productos.filter((p) => (p.quedan ?? 0) > 0).slice(0, 3).map((p) => `${cant(p.quedan!)} ${p.nombre}`).join(' · ')}{d.sin_repartir > 3 ? '…' : ''}</div>
      )}
      {puede && dirs.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => setEditar({ varias: d.varias })}>{d.varias ? 'Cambiar direcciones y reparto' : soloRetira ? 'Cambiar' : 'Cambiar dirección'}</button>
          {!d.varias && <button className="btn sm ghost" onClick={() => setEditar({ varias: true })}>Entregar en varias direcciones</button>}
        </div>
      )}
      {editar && <EditorDirecciones orderId={orderId} datos={d} varias={editar.varias} onClose={() => setEditar(null)} onSaved={() => { setEditar(null); res.reload(); onChange?.(); }} />}
    </div>
  );
}

// ---------- Editor ----------

// `retira`: el id de la dirección de Formas donde lo retira el cliente (entonces no hay dirección que buscar).
interface Fila { key: string; id?: number; texto: string; place_id: string | null; detalle: string; validada: boolean; retira: string | null }
const nuevaSesion = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
let n = 0;
const k = () => `f${++n}`;

function EditorDirecciones({ orderId, datos, varias: variasIn, onClose, onSaved }: { orderId: number; datos: Datos; varias: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const sesion = useRef(nuevaSesion()).current;
  const [filas, setFilas] = useState<Fila[]>(() => {
    const f: Fila[] = datos.direcciones.map((d) => ({ key: k(), id: d.id, texto: d.retira ? '' : d.direccion, place_id: d.place_id, detalle: d.detalle ?? '', validada: d.validada, retira: d.retira }));
    if (!f.length) f.push({ key: k(), texto: '', place_id: null, detalle: '', validada: false, retira: null });
    if (variasIn && f.length < 2) f.push({ key: k(), texto: '', place_id: null, detalle: '', validada: false, retira: null });
    return f;
  });
  const baseDe = (id: string | null) => datos.bases.find((b) => b.id === id);
  // Cantidades por fila (key) y producto (clave). Al pasar de una dirección a varias, todo arranca en la primera.
  const [q, setQ] = useState<Record<string, Record<string, string>>>(() => {
    const out: Record<string, Record<string, string>> = {};
    const porId = new Map(filas.map((f) => [f.id, f.key]));
    if (datos.varias) for (const c of datos.cantidades) { const key = porId.get(c.direccion_id); if (key) (out[key] ??= {})[c.clave] = String(c.cantidad); }
    else if (filas[0]) for (const p of datos.productos) if (p.total) (out[filas[0].key] ??= {})[p.clave] = String(p.total);
    return out;
  });
  const [guardando, setGuardando] = useState(false);
  const varias = filas.length > 1;
  const num = (v: string | undefined) => (v == null || v.trim() === '' ? 0 : Number(v.replace(',', '.')));
  const repartido = (clave: string) => filas.reduce((s, f) => s + (num(q[f.key]?.[clave]) || 0), 0);
  const quedan = (p: Producto) => (p.total == null ? null : Math.round((p.total - repartido(p.clave)) * 1000) / 1000);
  const pasados = varias ? datos.productos.filter((p) => (quedan(p) ?? 0) < 0) : [];
  const invalidas = varias && filas.some((f) => Object.values(q[f.key] ?? {}).some((v) => v.trim() !== '' && (!Number.isFinite(num(v)) || num(v) < 0)));
  const vacias = filas.some((f) => !f.retira && f.texto.trim().length < 5);
  const setFila = (key: string, cambio: Partial<Fila>) => setFilas((fs) => fs.map((f) => (f.key === key ? { ...f, ...cambio } : f)));
  const quitar = (key: string) => { setFilas((fs) => fs.filter((f) => f.key !== key)); setQ((c) => { const x = { ...c }; delete x[key]; return x; }); };
  const agregar = () => setFilas((fs) => [...fs, { key: k(), texto: '', place_id: null, detalle: '', validada: false, retira: null }]);
  // Lo que falta repartir de cada producto, a esta dirección.
  const restoA = (key: string) => setQ((c) => {
    const x = { ...c, [key]: { ...(c[key] ?? {}) } };
    for (const p of datos.productos) { const r = quedan(p); if (r && r > 0) x[key][p.clave] = String(num(x[key][p.clave]) + r); }
    return x;
  });
  const guardar = async () => {
    setGuardando(true);
    try {
      await http('PUT', `/records/order/${orderId}/direcciones`, {
        sesion,
        direcciones: filas.map((f) => (f.retira ? { id: f.id, retira: f.retira, detalle: f.detalle } : { id: f.id, place_id: f.place_id, direccion: f.texto, detalle: f.detalle })),
        cantidades: varias ? filas.flatMap((f, i) => Object.entries(q[f.key] ?? {}).filter(([, v]) => num(v) > 0).map(([clave, v]) => ({ direccion: i, clave, cantidad: num(v) }))) : [],
      });
      toast(varias ? 'Direcciones y reparto guardados' : 'Dirección de entrega guardada');
      onSaved();
    } catch (e) { toast((e as Error).message, true); } finally { setGuardando(false); }
  };
  const sinValidar = filas.filter((f) => !f.retira && !f.place_id && f.texto.trim()).length;
  return (
    <Modal title={varias ? 'Entrega en varias direcciones' : 'Dirección de entrega'} wide={varias} onClose={onClose} footer={<>
      {sinValidar > 0 && <span className="small warn-text grow">{sinValidar === 1 ? 'Una dirección queda' : `${sinValidar} direcciones quedan`} sin validar: elegilas de las sugerencias de Google.</span>}
      <button className="btn" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={guardando || vacias || pasados.length > 0 || invalidas} onClick={guardar}
        title={pasados.length ? 'Hay productos repartidos de más' : vacias ? 'Falta completar una dirección' : undefined}>{guardando ? 'Validando…' : 'Guardar'}</button>
    </>}>
      {!datos.maps && <div className="aviso warn small" style={{ marginBottom: 10 }}>Google Maps no está conectado en el CRM: las direcciones se guardan como se escriben, sin validar.</div>}
      <div className="stack direcciones-editor">
        {filas.map((f, i) => (
          <div key={f.key} className="direccion-fila">
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              {varias && <span className="direccion-num">{i + 1}</span>}
              <div className="grow stack" style={{ gap: 6 }}>
                {datos.bases.length > 0 && (
                  <div className="seg" role="group" aria-label={varias ? `Cómo se entrega lo de la dirección ${i + 1}` : 'Cómo se entrega'} style={{ alignSelf: 'flex-start' }}>
                    <button type="button" className={f.retira ? '' : 'on'} aria-pressed={!f.retira} onClick={() => setFila(f.key, { retira: null })}><Icon name="truck" size={13} />Envío</button>
                    <button type="button" className={f.retira ? 'on' : ''} aria-pressed={!!f.retira} onClick={() => setFila(f.key, { retira: f.retira ?? datos.bases[0].id })}>
                      <Icon name="company" size={13} />Retira en Formas</button>
                  </div>
                )}
                {f.retira
                  ? <div className="retira-opciones" role="radiogroup" aria-label="En cuál de las direcciones de Formas lo retira">
                      {datos.bases.map((b) => (
                        <label key={b.id} className={`retira-op${f.retira === b.id ? ' on' : ''}`}>
                          <input type="radio" name={`retira-${f.key}`} checked={f.retira === b.id} onChange={() => setFila(f.key, { retira: b.id })} />
                          <span style={{ minWidth: 0 }}><span className="retira-nombre">{b.nombre}</span><span className="small muted">{b.direccion}</span></span>
                        </label>
                      ))}
                    </div>
                  : <BuscarDireccion valor={f.texto} validada={!!f.place_id} sesion={sesion} maps={datos.maps}
                      sugerida={i === 0 && !datos.direcciones.length ? datos.sugerida : null}
                      onTexto={(texto) => setFila(f.key, { texto, place_id: null, validada: false })}
                      onElegir={(s) => setFila(f.key, { texto: s.texto, place_id: s.place_id, validada: true })} />}
                <input className="input sm" placeholder={f.retira ? 'Detalle (opcional): quién retira, día y horario…' : 'Detalle (opcional): piso, depto, horario, quién recibe…'}
                  value={f.detalle} maxLength={300} onChange={(e) => setFila(f.key, { detalle: e.target.value })} aria-label={`Detalle de la dirección ${i + 1}`} />
              </div>
              {varias && <button className="btn ghost icon sm" title="Quitar esta dirección" aria-label={`Quitar la dirección ${i + 1}`} onClick={() => quitar(f.key)}><Icon name="trash" size={14} /></button>}
            </div>
          </div>
        ))}
        <div><button className="btn sm ghost" onClick={agregar}><Icon name="plus" size={14} />{varias ? 'Agregar otra dirección' : 'Entregar en varias direcciones'}</button></div>
      </div>

      {varias && (
        <div className="reparto">
          <h3>Qué va a cada dirección</h3>
          {!datos.productos.length
            ? <div className="muted small">El pedido todavía no tiene productos (llegan de Finnegans o de ClickUp). Las direcciones se guardan igual; el reparto, cuando estén.</div>
            : <div className="table-wrap"><table className="grid reparto-tabla">
              <thead><tr><th className="nosort">Producto</th><th className="nosort num">Pedido</th>
                {filas.map((f, i) => <th key={f.key} className="nosort num" title={f.retira ? `Retira en Formas: ${baseDe(f.retira)?.nombre ?? ''}` : f.texto}>{f.retira ? `Retira (${i + 1})` : `Dirección ${i + 1}`}
                  <button className="link-btn small" style={{ display: 'block', marginLeft: 'auto' }} onClick={() => restoA(f.key)} title="Pasar acá todo lo que falta repartir">+ lo que falta</button></th>)}
                <th className="nosort num">Falta repartir</th></tr></thead>
              <tbody>{datos.productos.map((p) => {
                const r = quedan(p);
                return (
                  <tr key={p.clave} className={r != null && r < 0 ? 'pasado' : undefined}>
                    <td style={{ maxWidth: 260 }}><div className="ellipsis" title={p.nombre}>{p.nombre}</div>{p.codigo && <div className="small muted">{p.codigo}</div>}</td>
                    <td className="num">{p.total == null ? '—' : cant(p.total)}</td>
                    {filas.map((f, i) => (
                      <td key={f.key} className="num"><input className="input sm num reparto-input" inputMode="decimal" value={q[f.key]?.[p.clave] ?? ''} placeholder="0"
                        aria-label={`${p.nombre} en la dirección ${i + 1}`}
                        onChange={(e) => setQ((c) => ({ ...c, [f.key]: { ...(c[f.key] ?? {}), [p.clave]: e.target.value.replace(/[^\d.,]/g, '') } }))} /></td>
                    ))}
                    <td className="num">{r == null ? '—' : r < 0 ? <b className="danger-text" title="No se puede entregar más que lo pedido">{cant(r)} (de más)</b>
                      : r === 0 ? <span className="tag ok">Completo</span> : <b className="warn-text">{cant(r)}</b>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>}
          {pasados.length > 0 && <div className="aviso bad small" role="alert">No se puede entregar más que lo pedido: {pasados.map((p) => p.nombre).join(', ')}.</div>}
        </div>
      )}
    </Modal>
  );
}

// Buscador de direcciones con las sugerencias de Google Maps (las pide el servidor, con la clave de Google).
function BuscarDireccion({ valor, validada, sesion, maps, sugerida, onTexto, onElegir }: {
  valor: string; validada: boolean; sesion: string; maps: boolean; sugerida: string | null; onTexto: (t: string) => void; onElegir: (s: Sugerencia) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [lista, setLista] = useState<Sugerencia[]>([]);
  const [activa, setActiva] = useState(0);
  const dq = useDebounced(valor, 250);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!maps || validada || dq.trim().length < 3) { setLista([]); return; }
    let vivo = true;
    http<{ sugerencias: Sugerencia[] }>('GET', `/maps/sugerencias${qs({ q: dq, sesion })}`).then((r) => { if (vivo) { setLista(r.sugerencias); setActiva(0); } }).catch(() => vivo && setLista([]));
    return () => { vivo = false; };
  }, [dq, maps, validada, sesion]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setAbierto(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const elegir = (s: Sugerencia) => { onElegir(s); setAbierto(false); setLista([]); };
  const mostrar = abierto && lista.length > 0 && !validada;
  const ayuda = useMemo(() => {
    if (!valor.trim()) return null;
    if (validada) return null;
    return maps ? 'Elegí la dirección de la lista de Google para validarla.' : null;
  }, [valor, validada, maps]);
  return (
    <div className="buscar-direccion" ref={ref}>
      <div className={`search${validada ? ' validada' : ''}`}>
        <Icon name={validada ? 'check' : 'pin'} />
        <input className="input" autoFocus={!valor} placeholder="Calle y número, localidad…" value={valor} aria-label="Dirección de entrega" role="combobox" aria-expanded={mostrar} aria-autocomplete="list"
          onChange={(e) => { onTexto(e.target.value); setAbierto(true); }} onFocus={() => setAbierto(true)}
          onKeyDown={(e) => {
            if (!mostrar) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActiva((a) => Math.min(a + 1, lista.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActiva((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); elegir(lista[activa]); }
            else if (e.key === 'Escape') setAbierto(false);
          }} />
      </div>
      {mostrar && (
        <div className="popover" role="listbox">
          {lista.map((s, i) => (
            <div key={s.place_id} className={`opt${i === activa ? ' on' : ''}`} role="option" aria-selected={i === activa} onMouseDown={(e) => { e.preventDefault(); elegir(s); }}>
              <Icon name="pin" size={14} /><div className="grow" style={{ minWidth: 0 }}><div className="ellipsis">{s.principal}</div><div className="small muted ellipsis">{s.secundario}</div></div>
            </div>
          ))}
          <div className="small muted" style={{ padding: '4px 10px', textAlign: 'right' }}>Sugerencias de Google Maps</div>
        </div>
      )}
      {validada && <div className="small ok-text"><Icon name="check" size={12} /> Validada con Google Maps</div>}
      {ayuda && <div className="small muted">{ayuda}</div>}
      {sugerida && !valor && (
        <div className="small">La de la empresa: <button className="link-btn" onClick={() => { onTexto(sugerida); }}>{sugerida}</button>{maps ? ' (después elegila de la lista de Google)' : ''}</div>
      )}
    </div>
  );
}
