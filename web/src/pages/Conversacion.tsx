import { createPortal } from 'react-dom';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { http, qs, useMeta, useToast, Icon, OBJECTS, achicarImagen, formatValue, propOf, fmtDate, fmtRelative, userOf, type Meta, type ObjectType, type User, cabecerasVerComo } from '../lib';
import { Avatar, EstadoClickup, UserAvatar } from '../components';
import { RecordPreview } from './RecordPage';
import { VistaPdf } from './Bocetos';

// Conversación de un pedido o negocio (src/worker/conversacion.ts): un chat grupal entre el vendedor, producción y
// logística, con @menciones, y entremezclada la actividad del pedido (cambios de estado, de cada artículo, bocetos,
// remitos, notas, mails y tareas), como los comentarios de una tarea de ClickUp. Se actualiza sola mientras está abierta.

export interface Mensaje {
  key: string; kind: 'mensaje'; at: string; id: number; record_id: number; user_id: number | null; body: string; menciones: number[];
  responde_a: number | null; source: string; editado_at: string | null; borrado_at: string | null; created_at: string; adjuntos: Adjunto[];
}
export interface Adjunto { id: number; nombre: string; mime: string; size: number; ancho: number | null; alto: number | null }
const urlImagen = (id: number, descargar = false) => `/api/mensaje-adjuntos/${id}${descargar ? '?descargar=1' : ''}`;
type Evento =
  | { key: string; kind: 'cambio'; at: string; prop: string; antes: string | null; despues: string | null; user_id: number | null; actor: string | null; source: string }
  | { key: string; kind: 'articulo'; at: string; articulo: string; es_pdv: boolean; antes: string | null; despues: string | null; user_id: number | null; actor: string | null; source: string }
  | { key: string; kind: 'boceto'; at: string; accion: 'subido' | 'aprobado'; boceto_id: number; nombre: string; producto: string | null; version: number; tipo: string; mime: string | null; user_id: number | null }
  | { key: string; kind: 'remito'; at: string; remito_id: number; numero: string | null; estado: string; origen: string; chofer: string | null; user_id: number | null }
  | { key: string; kind: 'actividad'; at: string; activity_id: number; tipo: string; subject: string; body: string; direction: string | null; status: string | null; due_at: string | null; user_id: number | null };
type Item = Mensaje | Evento;
interface Participante { user_id: number; leido_hasta: number; siguiendo: boolean; motivo: string | null }
interface Respuesta { ahora: string; items: Item[]; participantes: Participante[]; siguiendo: boolean; leido_hasta: number; estados?: Array<{ status: string; color: string }> }

// ---------- Mensajes sin leer (el globito del menú y de las tarjetas) ----------

export interface ConvResumen {
  record_id: number; object_type: ObjectType; name: string; no_leidos: number; menciones: number; ultimo_id: number;
  ultimo: { id: number; user_id: number | null; body: string; created_at: string } | null;
}
interface NoLeidas { no_leidos: number; menciones: number; conversaciones: ConvResumen[] }
let noLeidas: NoLeidas = { no_leidos: 0, menciones: 0, conversaciones: [] };
const oyentes = new Set<(n: NoLeidas) => void>();
let pidiendo: Promise<void> | null = null;
export function refrescarNoLeidas() {
  pidiendo ??= http<NoLeidas>('GET', `/conversaciones${qs({ no_leidas: 1 })}`)
    .then((r) => { noLeidas = r; oyentes.forEach((f) => f(r)); }, () => undefined)
    .finally(() => { pidiendo = null; });
  return pidiendo;
}
let reloj: ReturnType<typeof setInterval> | null = null;
export function useNoLeidas() {
  const [v, setV] = useState(noLeidas);
  useEffect(() => {
    oyentes.add(setV);
    if (!reloj) {
      refrescarNoLeidas();
      reloj = setInterval(() => { if (document.visibilityState === 'visible') refrescarNoLeidas(); }, 45_000);
    }
    return () => { oyentes.delete(setV); };
  }, []);
  return v;
}
// Los sin leer de un registro (para su tarjeta y la vista previa).
export function useNoLeidosDe(recordId: number) {
  const n = useNoLeidas();
  return n.conversaciones.find((c) => c.record_id === recordId);
}

// En la tarjeta del tablero de pedidos: cuántos mensajes tiene la conversación y, si hay sin leer, en color.
export function ChatChip({ recordId, mensajes }: { recordId: number; mensajes: number }) {
  const sin = useNoLeidosDe(recordId);
  if (!mensajes && !sin) return null;
  const titulo = sin ? `${sin.no_leidos} sin leer${sin.menciones ? ' · te mencionaron' : ''}` : `${mensajes} ${mensajes === 1 ? 'mensaje' : 'mensajes'} en la conversación`;
  return (
    <span className={`adj chat${sin ? ' nuevo' : ' ok'}`} title={titulo}>
      <Icon name="chat" size={14} /><span className="n">{sin ? (sin.menciones ? '@' : '') + sin.no_leidos : mensajes}</span>
    </span>
  );
}

// ---------- Texto con menciones y links ----------

const MENCION = /@\[([^\]\n]{1,80})\]\((\d{1,15})\)/g;
const LINK = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
// Para editar: el texto como se escribe (@Nombre) y las menciones que tiene.
const aEditable = (body: string) => ({
  texto: body.replace(MENCION, '@$1'),
  menciones: [...body.matchAll(MENCION)].map((m) => ({ id: Number(m[2]), name: m[1] })),
});
// Al mandar: «@Nombre» de las personas elegidas en la lista pasa a @[Nombre](id).
function conMarcas(texto: string, menciones: Array<{ id: number; name: string }>) {
  let out = texto;
  const unicas = [...new Map(menciones.map((m) => [m.name, m])).values()].sort((a, b) => b.name.length - a.name.length);
  for (const m of unicas) {
    const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w\\]])@${esc}(?![\\wÀ-ÿ])`, 'g'), (_, pre: string) => `${pre}\u0000${m.id}\u0001`);
  }
  // Las marcas provisorias (para no volver a reemplazar adentro de una ya puesta).
  return out.replace(/\u0000(\d+)\u0001/g, (_, id: string) => `@[${unicas.find((m) => m.id === Number(id))!.name}](${id})`);
}
const textoPlano = (body: string) => body.replace(MENCION, '@$1');

function Cuerpo({ body, meId }: { body: string; meId: number }) {
  const partes: ReactNode[] = [];
  let i = 0;
  const conLinks = (s: string, k: string) => {
    const out: ReactNode[] = [];
    let j = 0;
    for (const m of s.matchAll(LINK)) {
      if (m.index! > j) out.push(s.slice(j, m.index));
      out.push(<a key={`${k}-${m.index}`} href={m[0]} target="_blank" rel="noreferrer">{m[0]}</a>);
      j = m.index! + m[0].length;
    }
    if (j < s.length) out.push(s.slice(j));
    return out;
  };
  for (const m of body.matchAll(MENCION)) {
    if (m.index! > i) partes.push(...conLinks(body.slice(i, m.index), `t${i}`));
    partes.push(<span key={`m${m.index}`} className={`mencion${Number(m[2]) === meId ? ' yo' : ''}`}>@{m[1]}</span>);
    i = m.index! + m[0].length;
  }
  if (i < body.length) partes.push(...conLinks(body.slice(i), `t${i}`));
  return <div className="msg-body">{partes}</div>;
}

// ---------- Eventos ----------

const FUENTE: Record<string, string> = { clickup: 'ClickUp', finnegans: 'Finnegans', mcp: 'Claude', hubspot: 'HubSpot', api: 'API', remitos: 'remitos', pedidos: 'pedidos' };
const CAMBIO: Record<string, string> = { hs_pipeline_stage: 'la etapa', dealstage: 'la etapa', pipeline: 'el pipeline', owner_id: 'el propietario', amount: 'el monto',
  hs_total_price: 'el total sin IVA', closedate: 'la fecha de cierre', fecha_de_entrega: 'la fecha de entrega', estado_entrega: 'el estado de entrega', factura_numero: 'la factura' };
const ICONO: Record<string, string> = { cambio: 'history', articulo: 'printer', boceto: 'boceto', remito: 'truck' };

function Quien({ meta, id, actor, source }: { meta: Meta; id: number | null; actor?: string | null; source?: string }) {
  const u = userOf(meta, id);
  if (u) return <b>{u.name}</b>;
  if (actor) return <b>{actor}{source && source !== 'crm' ? ` (${FUENTE[source] ?? source})` : ''}</b>;
  return <b>{source && FUENTE[source] ? FUENTE[source] : 'El sistema'}</b>;
}

function EventoLinea({ e, type, estados }: { e: Evento; type: ObjectType; estados: Array<{ status: string; color: string }> }) {
  const { meta } = useMeta();
  const [abierto, setAbierto] = useState(false);
  const hora = new Date(e.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const val = (prop: string, v: string | null) => (v == null || v === '' ? '—' : prop === 'archived' ? (v === 'true' ? 'borrado' : 'restaurado')
    : prop === 'owner_id' ? (userOf(meta, v)?.name ?? `Usuario ${v}`) : formatValue(meta, type, prop, v) || v);
  const est = (s: string | null) => (s ? <EstadoClickup estado={s} color={estados.find((x) => x.status === s)?.color} /> : <span className="muted">sin estado</span>);
  let icono = ICONO[e.kind] ?? 'note';
  let texto: ReactNode;
  let detalle: ReactNode = null;
  if (e.kind === 'cambio') {
    if (e.prop === 'archived') texto = <><Quien meta={meta} id={e.user_id} actor={e.actor} source={e.source} /> {e.despues === 'true' ? 'borró' : 'restauró'} el registro</>;
    else if (e.prop === 'merged') texto = <><Quien meta={meta} id={e.user_id} actor={e.actor} source={e.source} /> lo combinó con <b>{e.despues}</b></>;
    else {
      const nombre = CAMBIO[e.prop] ?? (propOf(meta, type, e.prop)?.label ?? e.prop).toLowerCase();
      texto = <><Quien meta={meta} id={e.user_id} actor={e.actor} source={e.source} /> cambió {nombre}{e.antes != null && e.antes !== '' ? <> de {val(e.prop, e.antes)}</> : null} a <b>{val(e.prop, e.despues)}</b></>;
    }
  } else if (e.kind === 'articulo') {
    texto = <><Quien meta={meta} id={e.user_id} actor={e.actor} source={e.source} /> pasó {e.es_pdv ? 'el PDV' : <>«{e.articulo}»</>} {e.antes ? <>de {est(e.antes)} </> : null}a {est(e.despues)}</>;
  } else if (e.kind === 'boceto') {
    const link = <a href={`/api/bocetos/${e.boceto_id}/archivo`} target="_blank" rel="noreferrer">{e.nombre}</a>;
    texto = e.accion === 'aprobado'
      ? <><Quien meta={meta} id={e.user_id} /> aprobó el boceto {link}{e.producto ? <> de <b>{e.producto}</b></> : null}</>
      : <><Quien meta={meta} id={e.user_id} /> subió {e.tipo === 'referencia' ? 'una referencia' : 'el boceto técnico'} {link}{e.version > 1 ? ` (versión ${e.version})` : ''}{e.producto ? <> para <b>{e.producto}</b></> : null}</>;
    if (e.accion === 'aprobado') icono = 'check';
  } else if (e.kind === 'remito') {
    const quien = e.origen === 'chofer' ? <b>{e.chofer || 'El chofer'}</b> : e.origen === 'clickup' ? <b>ClickUp</b> : <Quien meta={meta} id={e.user_id} />;
    texto = <>{quien} subió <a href={`/api/remitos/${e.remito_id}/archivo`} target="_blank" rel="noreferrer">{e.numero ? `el remito N° ${e.numero}` : 'un remito'}</a>{e.estado === 'revisar' ? ' · para revisar' : ''}</>;
  } else {
    icono = e.tipo;
    const t = e.tipo;
    const q = <Quien meta={meta} id={e.user_id} />;
    texto = t === 'task' ? <>{q} creó la tarea <b>{e.subject || 'sin título'}</b>{e.due_at ? ` · vence ${fmtDate(e.due_at)}` : ''}{e.status === 'COMPLETED' ? ' · hecha' : ''}</>
      : t === 'email' ? <>{e.direction === 'in' ? 'Llegó un mail' : <>{q} mandó un mail</>}{e.subject ? <>: <b>{e.subject}</b></> : null}</>
        : t === 'call' ? <>{q} registró una llamada</>
          : t === 'meeting' ? <>{q} registró una reunión{e.subject ? <>: <b>{e.subject}</b></> : null}</>
            : t === 'whatsapp' ? <>WhatsApp {e.direction === 'in' ? 'recibido' : 'enviado'}</>
              : <>{q} dejó una nota</>;
    if (e.body) detalle = <div className={`ev-detalle${abierto ? ' abierto' : ''}`} onClick={() => setAbierto(true)}>{e.body}</div>;
  }
  return (
    <div className={`conv-ev ev-${e.kind}`}>
      <span className="ev-ic"><Icon name={icono} size={12} /></span>
      <div className="ev-txt">{texto}{detalle}</div>
      <time dateTime={e.at} title={fmtDate(e.at, true)}>{hora}</time>
    </div>
  );
}

// ---------- Escribir: el cuadro con @menciones ----------

function useUsuariosMencionables(meta: Meta) {
  return useMemo(() => meta.users.filter((u) => u.active && !u.deleted_at), [meta.users]);
}
const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Una imagen elegida para el próximo mensaje: se achica y se sube enseguida (se ve la miniatura mientras tanto).
// Un archivo elegido para el próximo mensaje: se sube enseguida (las imágenes, achicadas) y se ve mientras tanto.
interface Pendiente { tmp: string; url: string | null; nombre: string; size: number; adj?: Adjunto; error?: string }
const ARCHIVO_MAX = 20 * 1024 * 1024;
export const esImagen = (mime: string) => /^image\/(jpeg|png|webp|gif)$/.test(mime);
export const esPdf = (mime: string) => mime === 'application/pdf';
const extension = (nombre: string) => (nombre.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toUpperCase();
const peso = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const MAX_IMAGENES = 10;

// Las medidas, para reservar el lugar de la miniatura antes de que cargue (si no, la lista salta).
async function medidas(f: File): Promise<{ ancho?: number; alto?: number }> {
  try { const b = await createImageBitmap(f); const m = { ancho: b.width, alto: b.height }; b.close(); return m; } catch { return {}; }
}

function Escribir({ inicial, respondiendo, onCancelarRespuesta, onEnviar, onCancelar, placeholder, autoFocus, subirA, registrarSoltar }: {
  inicial?: string; respondiendo?: ReactNode; onCancelarRespuesta?: () => void; onEnviar: (body: string, adjuntos: number[]) => Promise<boolean>; onCancelar?: () => void;
  placeholder?: string; autoFocus?: boolean;
  // Adónde se suben las imágenes (sin esto, como al editar, no se adjunta nada) y cómo el panel le pasa lo que se suelta encima.
  subirA?: string; registrarSoltar?: (f: ((files: File[]) => void) | null) => void;
}) {
  const toast = useToast();
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const vivos = useRef(pendientes);
  vivos.current = pendientes;
  useEffect(() => () => { for (const p of vivos.current) if (p.url) URL.revokeObjectURL(p.url); }, []);
  // Imágenes, capturas pegadas, PDF y otros archivos (planillas, documentos, ZIP, diseño): hasta 20 MB cada uno.
  const agregar = useCallback((files: File[]) => {
    if (!subirA || !files.length) return;
    const grandes = files.filter((f) => f.size > ARCHIVO_MAX);
    if (grandes.length) toast(`${grandes.map((f) => f.name).join(', ')}: pesa más de 20 MB. Comprimilo o compartí el link de Drive.`, true);
    const ok = files.filter((f) => f.size <= ARCHIVO_MAX);
    const lugar = MAX_IMAGENES - vivos.current.length;
    if (ok.length > lugar) toast(`Van hasta ${MAX_IMAGENES} archivos por mensaje.`, true);
    for (const f of ok.slice(0, Math.max(0, lugar))) {
      const tmp = `${Date.now()}-${Math.random()}`;
      const img = f.type.startsWith('image/') && !/heic|heif/.test(f.type);
      setPendientes((ps) => [...ps, { tmp, url: img ? URL.createObjectURL(f) : null, nombre: f.name || 'archivo', size: f.size }]);
      (async () => {
        const fd = new FormData();
        if (img) {
          const chica = await achicarImagen(f, 2000, 1_800_000);
          fd.append('archivo', chica, f.name || 'captura.png');
          const m = await medidas(chica);
          if (m.ancho) { fd.append('ancho', String(m.ancho)); fd.append('alto', String(m.alto)); }
        } else fd.append('archivo', f, f.name || 'archivo');
        const res = await fetch(`/api${subirA}`, { method: 'POST', body: fd, credentials: 'same-origin', headers: cabecerasVerComo() });
        const data = await res.json().catch(() => null) as (Adjunto & { error?: string }) | null;
        if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
        return data as Adjunto;
      })().then((adj) => {
        // Si la sacaron mientras subía, se borra.
        if (!vivos.current.some((p) => p.tmp === tmp)) { http('DELETE', `/mensaje-adjuntos/${adj.id}`).catch(() => undefined); return; }
        setPendientes((ps) => ps.map((p) => (p.tmp === tmp ? { ...p, adj } : p)));
      }, (e: Error) => setPendientes((ps) => ps.map((p) => (p.tmp === tmp ? { ...p, error: e.message } : p))));
    }
  }, [subirA, toast]);
  useEffect(() => { registrarSoltar?.(agregar); return () => registrarSoltar?.(null); }, [registrarSoltar, agregar]);
  const quitar = (p: Pendiente) => {
    if (p.url) URL.revokeObjectURL(p.url);
    setPendientes((ps) => ps.filter((x) => x.tmp !== p.tmp));
    if (p.adj) http('DELETE', `/mensaje-adjuntos/${p.adj.id}`).catch(() => undefined);
  };
  const archivo = useRef<HTMLInputElement>(null);
  const subiendo = pendientes.some((p) => !p.adj && !p.error);
  const listas = pendientes.filter((p) => p.adj);
  const { meta } = useMeta();
  const usuarios = useUsuariosMencionables(meta);
  const ini = useMemo(() => aEditable(inicial ?? ''), [inicial]);
  const [texto, setTexto] = useState(ini.texto);
  const [menc, setMenc] = useState(ini.menciones);
  const [busy, setBusy] = useState(false);
  const [lista, setLista] = useState<{ desde: number; q: string; sel: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [texto]);
  useEffect(() => { if (autoFocus) ta.current?.focus(); }, [autoFocus]);
  const opciones = useMemo(() => {
    if (!lista) return [];
    const q = sinTildes(lista.q);
    return usuarios.filter((u) => !q || sinTildes(u.name).split(/\s+/).some((p) => p.startsWith(q)) || sinTildes(u.name).startsWith(q)).slice(0, 8);
  }, [lista, usuarios]);
  // ¿Se está escribiendo una mención? «@» al principio o después de un espacio, y lo escrito hasta el cursor.
  const mirar = (v: string, pos: number) => {
    const antes = v.slice(0, pos);
    const m = antes.match(/(^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
    setLista(m ? { desde: pos - m[2].length - 1, q: m[2], sel: 0 } : null);
  };
  const elegir = (u: User) => {
    if (!lista) return;
    const pos = ta.current?.selectionStart ?? texto.length;
    const nuevo = `${texto.slice(0, lista.desde)}@${u.name} ${texto.slice(pos)}`;
    setTexto(nuevo);
    setMenc((m) => [...m.filter((x) => x.id !== u.id), { id: u.id, name: u.name }]);
    setLista(null);
    const cursor = lista.desde + u.name.length + 2;
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(cursor, cursor); });
  };
  const puedeMandar = (!!texto.trim() || listas.length > 0) && !subiendo && !busy;
  const enviar = async () => {
    const t = texto.trim();
    if (!puedeMandar) return;
    setBusy(true);
    const ok = await onEnviar(conMarcas(t, menc), listas.map((p) => p.adj!.id)).finally(() => setBusy(false));
    if (ok && inicial === undefined) {
      setTexto(''); setMenc([]);
      for (const p of pendientes) if (p.url) URL.revokeObjectURL(p.url);
      setPendientes([]);
    }
  };
  return (
    <div className="conv-escribir">
      {respondiendo && <div className="conv-respondiendo"><Icon name="reply" size={13} /><div className="grow ellipsis">{respondiendo}</div>
        <button className="btn ghost sm icon" onClick={onCancelarRespuesta} aria-label="No responder"><Icon name="x" size={14} /></button></div>}
      {pendientes.length > 0 && (
        <div className="conv-pendientes">
          {pendientes.map((p) => (
            <div key={p.tmp} className={`conv-pend${p.error ? ' error' : ''}${!p.adj && !p.error ? ' subiendo' : ''}${p.url ? '' : ' archivo'}`}
              title={p.error ?? `${p.nombre}${p.adj ? '' : ' · subiendo…'}`}>
              {p.url ? <img src={p.url} alt="" />
                : <><span className="pend-ext">{extension(p.nombre) || 'ARCHIVO'}</span><span className="pend-nombre">{p.nombre}</span><span className="pend-peso">{peso(p.size)}</span></>}
              {!p.adj && !p.error && <span className="spinner" aria-label="Subiendo" />}
              {p.error && <span className="pend-error">No se subió</span>}
              <button type="button" className="pend-x" onClick={() => quitar(p)} aria-label={`Sacar ${p.nombre}`}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="conv-caja">
        {subirA && <>
          <input ref={archivo} type="file" multiple hidden onChange={(e) => { agregar([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <button type="button" className="btn ghost sm icon conv-clip" onClick={() => archivo.current?.click()}
            title="Adjuntar archivos: fotos, PDF, planillas, documentos… (también podés pegar una captura con Ctrl+V o arrastrarlos acá)"
            aria-label="Adjuntar archivos"><Icon name="clip" size={18} /></button>
        </>}
        <textarea ref={ta} className="input" rows={1} value={texto} placeholder={placeholder ?? (subirA ? 'Escribí un comentario… (@ para mencionar, Ctrl+V para pegar una captura)' : 'Escribí un comentario… (@ para mencionar)')}
          onChange={(e) => { setTexto(e.target.value); mirar(e.target.value, e.target.selectionStart); }}
          onClick={(e) => mirar(texto, e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // Una captura o un archivo copiado (Ctrl+V) se adjunta; si además viene texto, el texto se pega igual.
            const files = [...e.clipboardData.files];
            if (!files.length || !subirA) return;
            if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
            agregar(files);
          }}
          onBlur={() => setTimeout(() => setLista(null), 150)}
          onKeyDown={(e) => {
            if (lista && opciones.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setLista({ ...lista, sel: (lista.sel + 1) % opciones.length }); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setLista({ ...lista, sel: (lista.sel - 1 + opciones.length) % opciones.length }); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); elegir(opciones[lista.sel]); return; }
            }
            if (e.key === 'Escape') { if (lista) { e.stopPropagation(); setLista(null); } else if (onCancelar) { e.stopPropagation(); onCancelar(); } return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); }
          }} />
        {onCancelar && <button className="btn sm" onClick={onCancelar}>Cancelar</button>}
        <button className="btn primary sm conv-enviar" disabled={!puedeMandar} onClick={enviar} aria-label={inicial !== undefined ? 'Guardar' : 'Enviar'} title="Enviar (Enter) · Shift+Enter: otra línea">
          {inicial !== undefined ? 'Guardar' : <Icon name="send" size={16} />}
        </button>
        {lista && opciones.length > 0 && (
          <div className="popover conv-menciones" role="listbox" aria-label="Mencionar a">
            {opciones.map((u, i) => (
              <div key={u.id} role="option" aria-selected={i === lista.sel} className={`opt${i === lista.sel ? ' on' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); elegir(u); }} onMouseEnter={() => setLista({ ...lista, sel: i })}>
                <Avatar name={u.name} photo={u.photo_url} size="sm" /><span className="grow ellipsis">{u.name}</span><span className="small muted ellipsis">{u.email.split('@')[0]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Un mensaje ----------

// La primera página de un PDF, chiquita (con pdf.js, que se carga solo cuando hace falta). Se guarda la imagen por si se
// vuelve a ver.
const miniaturas = new Map<number, string>();
function MiniPdf({ id }: { id: number }) {
  const [src, setSrc] = useState(() => miniaturas.get(id) ?? null);
  useEffect(() => {
    if (src) return;
    let vivo = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        const res = await fetch(urlImagen(id), { credentials: 'same-origin', headers: cabecerasVerComo() });
        if (!res.ok) return;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 240 / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        await doc.destroy();
        const url = canvas.toDataURL('image/jpeg', 0.8);
        miniaturas.set(id, url);
        if (vivo) setSrc(url);
      } catch { /* sin miniatura: queda el ícono */ }
    })();
    return () => { vivo = false; };
  }, [id, src]);
  return src ? <img src={src} alt="" /> : <span className="arch-ext">PDF</span>;
}

// Los archivos de un mensaje: las imágenes (una sola, grande, con su proporción para que la lista no salte al cargar;
// varias, en grilla) y abajo los demás como tarjetas. Un PDF se abre en el visor; el resto se descarga.
function Adjuntos({ adjuntos, onAbrir }: { adjuntos: Adjunto[]; onAbrir: (id: number) => void }) {
  if (!adjuntos.length) return null;
  const imgs = adjuntos.filter((a) => esImagen(a.mime));
  const otros = adjuntos.filter((a) => !esImagen(a.mime));
  return <>
    {imgs.length > 0 && <Imagenes adjuntos={imgs} onAbrir={onAbrir} />}
    {otros.length > 0 && (
      <div className="msg-archivos">
        {otros.map((a) => {
          const pdf = esPdf(a.mime);
          const cuerpo = <>
            <span className={`arch-mini${pdf ? ' pdf' : ''}`}>{pdf ? <MiniPdf id={a.id} /> : <span className="arch-ext">{extension(a.nombre) || 'ARCHIVO'}</span>}</span>
            <span className="arch-info"><span className="arch-nombre" title={a.nombre}>{a.nombre}</span>
              <span className="arch-peso">{[extension(a.nombre), peso(a.size)].filter(Boolean).join(' · ')}</span></span>
          </>;
          return (
            <div key={a.id} className="msg-archivo">
              {pdf ? <button type="button" className="arch-abrir" onClick={() => onAbrir(a.id)} aria-label={`Ver ${a.nombre}`}>{cuerpo}</button>
                : <a className="arch-abrir" href={urlImagen(a.id, true)} aria-label={`Descargar ${a.nombre}`}>{cuerpo}</a>}
              <a className="btn ghost sm icon" href={urlImagen(a.id, true)} title="Descargar" aria-label={`Descargar ${a.nombre}`}><Icon name="download" size={15} /></a>
            </div>
          );
        })}
      </div>
    )}
  </>;
}

function Imagenes({ adjuntos, onAbrir }: { adjuntos: Adjunto[]; onAbrir: (id: number) => void }) {
  if (!adjuntos.length) return null;
  const una = adjuntos.length === 1;
  return (
    <div className={`msg-imagenes${una ? ' una' : ''}`}>
      {adjuntos.map((a) => (
        <button key={a.id} type="button" className="msg-img" onClick={() => onAbrir(a.id)} title={a.nombre} aria-label={`Ver ${a.nombre}`}
          style={una && a.ancho && a.alto ? { aspectRatio: `${a.ancho} / ${a.alto}`, width: `min(100%, ${Math.round(240 * a.ancho / a.alto)}px, ${a.ancho}px)` } : undefined}>
          <img src={urlImagen(a.id)} alt={a.nombre} loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  );
}

// Una imagen o un PDF a pantalla completa, con las flechas para pasar a los otros de la conversación.
function Visor({ imagenes, inicio, onClose }: { imagenes: Array<Adjunto & { autor: string; at: string }>; inicio: number; onClose: () => void }) {
  const [i, setI] = useState(Math.max(0, imagenes.findIndex((a) => a.id === inicio)));
  const a = imagenes[i];
  useEffect(() => {
    // En captura: que Escape cierre el visor y no la vista previa de atrás.
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); setI((x) => Math.max(0, x - 1)); }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); setI((x) => Math.min(imagenes.length - 1, x + 1)); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [imagenes.length, onClose]);
  if (!a) return null;
  return createPortal(
    <div className="visor" role="dialog" aria-label="Imagen" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="visor-barra">
        <span className="grow ellipsis"><b>{a.autor}</b> · {fmtDate(a.at, true)} · {a.nombre}</span>
        {imagenes.length > 1 && <span className="num">{i + 1} de {imagenes.length}</span>}
        <a className="btn sm" href={urlImagen(a.id, true)}><Icon name="download" size={14} />Descargar</a>
        <a className="btn sm" href={urlImagen(a.id)} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Abrir</a>
        <button className="btn ghost icon visor-x" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={20} /></button>
      </div>
      {i > 0 && <button className="visor-flecha izq" onClick={() => setI(i - 1)} aria-label="Anterior"><Icon name="chevron" size={28} /></button>}
      {esPdf(a.mime)
        ? <div key={a.id} className="visor-pdf" onMouseDown={(e) => e.stopPropagation()}><VistaPdf url={urlImagen(a.id)} paginas={30} cargando="Cargando el PDF…" ayuda="Descargalo para verlo." /></div>
        : <img key={a.id} src={urlImagen(a.id)} alt={a.nombre} onMouseDown={(e) => e.stopPropagation()} />}
      {i < imagenes.length - 1 && <button className="visor-flecha der" onClick={() => setI(i + 1)} aria-label="Siguiente"><Icon name="chevron" size={28} /></button>}
    </div>,
    document.body,
  );
}

function MensajeVista({ m, cont, citado, meId, esAdmin, vistoPor, onResponder, onEditado, onIrA, onAbrirImagen }: {
  m: Mensaje; cont: boolean; citado?: Mensaje; meId: number; esAdmin: boolean; vistoPor?: User[];
  onResponder: () => void; onEditado: (m: Mensaje) => void; onIrA: (id: number) => void; onAbrirImagen: (id: number) => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const u = userOf(meta, m.user_id);
  const mio = m.user_id === meId;
  const hora = new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const mencionado = m.menciones.includes(meId) && !mio;
  if (m.borrado_at) {
    return <div className={`conv-msg borrado${cont ? ' cont' : ''}`} id={`msg-${m.id}`}><div className="msg-av" /><div className="msg-main"><span className="muted small">Mensaje borrado</span></div></div>;
  }
  return (
    <div className={`conv-msg${cont ? ' cont' : ''}${mio ? ' mio' : ''}${mencionado ? ' mencionado' : ''}`} id={`msg-${m.id}`}>
      <div className="msg-av">{!cont && <UserAvatar id={m.user_id} />}</div>
      <div className="msg-main">
        {!cont && <div className="msg-head"><b>{u?.name ?? 'Alguien'}</b>{m.source === 'mcp' && <span className="tag">con Claude</span>}<time dateTime={m.created_at} title={fmtDate(m.created_at, true)}>{hora}</time></div>}
        {citado && (
          <button type="button" className="msg-cita" onClick={() => onIrA(citado.id)}>
            <b>{userOf(meta, citado.user_id)?.name ?? 'Alguien'}</b> <span className="ellipsis">{citado.borrado_at ? 'Mensaje borrado' : textoPlano(citado.body) || '📎 Adjunto'}</span>
          </button>
        )}
        {editando
          ? <Escribir inicial={m.body} autoFocus onCancelar={() => setEditando(false)} onEnviar={async (body) => {
            try { onEditado({ ...m, ...(await http<Omit<Mensaje, 'key' | 'kind' | 'at'>>('PATCH', `/mensajes/${m.id}`, { body })) }); setEditando(false); return true; }
            catch (e) { toast((e as Error).message, true); return false; }
          }} />
          : m.body ? <Cuerpo body={m.body} meId={meId} /> : null}
        {!editando && <Adjuntos adjuntos={m.adjuntos ?? []} onAbrir={onAbrirImagen} />}
        {(m.editado_at || (vistoPor && vistoPor.length > 0)) && !editando && (
          <div className="msg-pie">
            {m.editado_at && <span className="muted" title={fmtDate(m.editado_at, true)}>(editado)</span>}
            {vistoPor && vistoPor.length > 0 && <span className="muted visto" title={`Visto por ${vistoPor.map((v) => v.name).join(', ')}`}>
              Visto por {vistoPor.slice(0, 3).map((v) => v.name.split(' ')[0]).join(', ')}{vistoPor.length > 3 ? ` y ${vistoPor.length - 3} más` : ''}</span>}
          </div>
        )}
      </div>
      {!editando && (
        <div className="msg-acciones">
          {cont && <time className="msg-hora" dateTime={m.created_at}>{hora}</time>}
          <button className="btn ghost sm icon" title="Responder" aria-label="Responder" onClick={onResponder}><Icon name="reply" size={14} /></button>
          {mio && <button className="btn ghost sm icon" title="Editar" aria-label="Editar" onClick={() => setEditando(true)}><Icon name="edit" size={14} /></button>}
          {(mio || esAdmin) && <button className="btn ghost sm icon" title="Borrar" aria-label="Borrar" onClick={async () => {
            if (!confirm('¿Borrar este mensaje? Va a quedar «Mensaje borrado».')) return;
            try { await http('DELETE', `/mensajes/${m.id}`); onEditado({ ...m, borrado_at: new Date().toISOString(), body: '' }); } catch (e) { toast((e as Error).message, true); }
          }}><Icon name="trash" size={14} /></button>}
        </div>
      )}
    </div>
  );
}

// ---------- El panel ----------

const DIA = (iso: string) => {
  const d = new Date(iso);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const ese = new Date(d); ese.setHours(0, 0, 0, 0);
  const dif = Math.round((hoy.getTime() - ese.getTime()) / 86_400_000);
  if (dif === 0) return 'Hoy';
  if (dif === 1) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== hoy.getFullYear() ? { year: 'numeric' } : {}) });
};
const leerFiltro = () => { try { return localStorage.getItem('crm:conv-filtro') === 'mensajes' ? 'mensajes' : 'todo'; } catch { return 'todo'; } };

export function ConversacionPanel({ type, recordId, onClose, className = '' }: { type: ObjectType; recordId: number; onClose?: () => void; className?: string }) {
  const { meta } = useMeta();
  const toast = useToast();
  const me = meta.me;
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const [estado, setEstado] = useState<{ participantes: Participante[]; siguiendo: boolean; estados: Array<{ status: string; color: string }> }>({ participantes: [], siguiendo: false, estados: [] });
  const [error, setError] = useState<string | null>(null);
  const [cargado, setCargado] = useState(false);
  // Hasta dónde había leído al abrir: la raya de «Nuevos» queda ahí mientras está abierta.
  const [leidoAlAbrir, setLeidoAlAbrir] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<'todo' | 'mensajes'>(leerFiltro);
  const [respondiendo, setRespondiendo] = useState<Mensaje | null>(null);
  const [abajoNuevos, setAbajoNuevos] = useState(0);
  const cursor = useRef<string | null>(null);
  const lista = useRef<HTMLDivElement>(null);
  const pegado = useRef(true);
  const marcado = useRef(0);
  const [visor, setVisor] = useState<number | null>(null);
  // Soltar imágenes en cualquier parte del panel: van al cuadro de escribir.
  const soltar = useRef<((files: File[]) => void) | null>(null);
  const registrarSoltar = useCallback((f: ((files: File[]) => void) | null) => { soltar.current = f; }, []);
  const [encima, setEncima] = useState(0);

  const mezclar = useCallback((nuevos: Item[]) => {
    if (!nuevos.length) return;
    setItems((prev) => {
      const m = new Map(prev);
      for (const it of nuevos) m.set(it.key, it);
      return m;
    });
  }, []);

  const traer = useCallback(async (inicial: boolean) => {
    // Lo de los últimos 20 minutos de nuevo (no solo desde la última vez): lo que llega de ClickUp viene con su hora.
    const desde = inicial || !cursor.current ? undefined : new Date(Date.parse(cursor.current) - 20 * 60_000).toISOString();
    const r = await http<Respuesta>('GET', `/records/${type}/${recordId}/conversacion${qs({ desde })}`);
    cursor.current = r.ahora;
    if (inicial) {
      setItems(new Map(r.items.map((it) => [it.key, it])));
      setLeidoAlAbrir(r.leido_hasta);
      setCargado(true);
    } else mezclar(r.items);
    setEstado((s) => ({ participantes: r.participantes, siguiendo: r.siguiendo, estados: r.estados ?? s.estados }));
  }, [type, recordId, mezclar]);

  useEffect(() => {
    let vivo = true;
    setCargado(false); setItems(new Map()); cursor.current = null; marcado.current = 0; pegado.current = true;
    traer(true).catch((e) => vivo && setError((e as Error).message));
    const t = setInterval(() => { if (document.visibilityState === 'visible') traer(false).catch(() => undefined); }, 12_000);
    const alVolver = () => { if (document.visibilityState === 'visible') traer(false).catch(() => undefined); };
    document.addEventListener('visibilitychange', alVolver);
    return () => { vivo = false; clearInterval(t); document.removeEventListener('visibilitychange', alVolver); };
  }, [traer]);

  const ordenados = useMemo(() => [...items.values()].sort((x, y) => x.at.localeCompare(y.at) || x.key.localeCompare(y.key)), [items]);
  const mensajes = useMemo(() => ordenados.filter((i): i is Mensaje => i.kind === 'mensaje'), [ordenados]);
  const porId = useMemo(() => new Map(mensajes.map((m) => [m.id, m])), [mensajes]);
  const visibles = filtro === 'mensajes' ? mensajes : ordenados;
  const ultimoId = mensajes.length ? Math.max(...mensajes.map((m) => m.id)) : 0;

  // Marcar leído lo que está a la vista (si la pestaña está a la vista).
  useEffect(() => {
    if (!cargado || ultimoId <= marcado.current || document.visibilityState !== 'visible') return;
    marcado.current = ultimoId;
    http('POST', `/records/${type}/${recordId}/conversacion/leido`, { hasta: ultimoId }).then(() => refrescarNoLeidas(), () => undefined);
  }, [cargado, ultimoId, type, recordId]);

  // Abajo de todo al abrir y cuando llega algo nuevo (si se estaba abajo); si no, el aviso de «nuevos».
  const largo = visibles.length;
  const prevLargo = useRef(0);
  useLayoutEffect(() => {
    const el = lista.current;
    if (!el || !cargado) return;
    if (pegado.current || prevLargo.current === 0) { el.scrollTop = el.scrollHeight; setAbajoNuevos(0); }
    else if (largo > prevLargo.current) setAbajoNuevos((n) => n + largo - prevLargo.current);
    prevLargo.current = largo;
  }, [largo, cargado]);
  const alScroll = () => {
    const el = lista.current;
    if (!el) return;
    pegado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (pegado.current) setAbajoNuevos(0);
  };
  const irAbajo = () => { const el = lista.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); pegado.current = true; setAbajoNuevos(0); } };
  const irA = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('destello');
    setTimeout(() => el.classList.remove('destello'), 1600);
  };

  const enviar = async (body: string, adjuntos: number[]) => {
    try {
      const m = await http<Omit<Mensaje, 'key' | 'kind' | 'at'>>('POST', `/records/${type}/${recordId}/conversacion`, { body, responde_a: respondiendo?.id ?? null, adjuntos });
      pegado.current = true;
      mezclar([{ ...m, key: `m${m.id}`, kind: 'mensaje', at: m.created_at }]);
      setRespondiendo(null);
      // Quien escribe pasa a seguirla.
      setEstado((s) => ({ ...s, siguiendo: true, participantes: s.participantes.some((p) => p.user_id === me.id) ? s.participantes.map((p) => (p.user_id === me.id ? { ...p, siguiendo: true, leido_hasta: m.id } : p))
        : [...s.participantes, { user_id: me.id, leido_hasta: m.id, siguiendo: true, motivo: 'escribio' }] }));
      traer(false).catch(() => undefined);
      return true;
    } catch (e) { toast((e as Error).message, true); return false; }
  };

  const seguir = async () => {
    try {
      const r = await http<{ siguiendo: boolean }>('PUT', `/records/${type}/${recordId}/conversacion/seguir`, { siguiendo: !estado.siguiendo });
      toast(r.siguiendo ? 'Te van a contar los mensajes nuevos' : 'Dejaste de seguir la conversación');
      traer(false).catch(() => undefined);
      refrescarNoLeidas();
    } catch (e) { toast((e as Error).message, true); }
  };

  const siguen = estado.participantes.filter((p) => p.siguiendo).map((p) => userOf(meta, p.user_id)).filter((u): u is User => !!u);
  // «Visto por»: en el último mensaje, los que ya lo leyeron (sin contar a quien lo escribió).
  const ultimo = mensajes.filter((m) => !m.borrado_at).at(-1);
  const vistoUltimo = ultimo ? estado.participantes.filter((p) => p.user_id !== ultimo.user_id && p.leido_hasta >= ultimo.id)
    .map((p) => userOf(meta, p.user_id)).filter((u): u is User => !!u) : [];
  const puedeEscribir = me.role !== 'viewer';
  // Lo que se ve en el visor: las imágenes y los PDF (lo demás se descarga).
  const imagenes = mensajes.filter((m) => !m.borrado_at).flatMap((m) => (m.adjuntos ?? []).filter((a) => esImagen(a.mime) || esPdf(a.mime))
    .map((a) => ({ ...a, autor: userOf(meta, m.user_id)?.name ?? 'Alguien', at: m.created_at })));
  const conArchivos = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  let diaAnt = '';
  let autorAnt: { id: number | null; at: number } | null = null;
  let rayaPuesta = false;
  return (
    <section className={`conv ${className}${encima > 0 ? ' soltando' : ''}`} aria-label="Conversación"
      onDragEnter={(e) => { if (puedeEscribir && conArchivos(e)) { e.preventDefault(); setEncima((n) => n + 1); } }}
      onDragLeave={(e) => { if (conArchivos(e)) setEncima((n) => Math.max(0, n - 1)); }}
      onDragOver={(e) => { if (puedeEscribir && conArchivos(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(e) => { if (!conArchivos(e)) return; e.preventDefault(); setEncima(0); soltar.current?.([...e.dataTransfer.files]); }}>
      {encima > 0 && <div className="conv-soltar"><Icon name="clip" size={28} />Soltá los archivos para adjuntarlos</div>}
      {visor != null && <Visor imagenes={imagenes} inicio={visor} onClose={() => setVisor(null)} />}
      <header className="conv-head">
        <Icon name="chat" size={16} />
        <h3>Conversación</h3>
        {siguen.length > 0 && (
          <span className="avatar-stack conv-siguen" title={`La siguen: ${siguen.map((u) => u.name).join(', ')}`}>
            {siguen.slice(0, 5).map((u) => <Avatar key={u.id} name={u.name} photo={u.photo_url} size="sm" />)}
            {siguen.length > 5 && <span className="avatar sm">+{siguen.length - 5}</span>}
          </span>
        )}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Qué mostrar">
          <button className={filtro === 'todo' ? 'on' : ''} onClick={() => { setFiltro('todo'); try { localStorage.setItem('crm:conv-filtro', 'todo'); } catch { /* sin memoria */ } }}>Todo</button>
          <button className={filtro === 'mensajes' ? 'on' : ''} onClick={() => { setFiltro('mensajes'); try { localStorage.setItem('crm:conv-filtro', 'mensajes'); } catch { /* sin memoria */ } }} title="Solo los mensajes, sin la actividad">Mensajes</button>
        </div>
        <button className={`btn ghost sm icon${estado.siguiendo ? ' on' : ''}`} onClick={seguir} title={estado.siguiendo ? 'Dejar de seguir (no te cuenta los mensajes nuevos)' : 'Seguir: te cuenta los mensajes nuevos'}
          aria-label={estado.siguiendo ? 'Dejar de seguir' : 'Seguir'} aria-pressed={estado.siguiendo}><Icon name="bell" size={15} /></button>
        {onClose && <button className="btn ghost sm icon" onClick={onClose} aria-label="Cerrar la conversación"><Icon name="x" size={16} /></button>}
      </header>
      <div className="conv-lista" ref={lista} onScroll={alScroll}>
        {error && <div className="empty plain">{error}</div>}
        {!cargado && !error && <div className="muted small conv-vacio">Cargando…</div>}
        {cargado && !visibles.length && (
          <div className="conv-vacio">
            <Icon name="chat" size={28} />
            <p><b>Todavía no hay comentarios.</b><br />Escribí lo que haga falta del {OBJECTS[type].single.toLowerCase()} y mencioná con @ a quien tenga que enterarse: le llega un aviso. Podés pegar capturas o adjuntar fotos.</p>
          </div>
        )}
        {visibles.map((it) => {
          const dia = DIA(it.at);
          const sep = dia !== diaAnt ? <div className="conv-dia"><span>{dia}</span></div> : null;
          if (sep) { diaAnt = dia; autorAnt = null; }
          let raya: ReactNode = null;
          if (!rayaPuesta && leidoAlAbrir != null && it.kind === 'mensaje' && it.id > leidoAlAbrir && it.user_id !== me.id) {
            rayaPuesta = true;
            raya = <div className="conv-nuevos"><span>Nuevos</span></div>;
          }
          if (it.kind !== 'mensaje') {
            autorAnt = null;
            return <Fragment key={it.key}>{sep}<EventoLinea e={it} type={type} estados={estado.estados} /></Fragment>;
          }
          const t = Date.parse(it.created_at);
          const cont = !raya && !it.responde_a && !!autorAnt && autorAnt.id === it.user_id && t - autorAnt.at < 5 * 60_000;
          autorAnt = { id: it.user_id, at: t };
          return (
            <Fragment key={it.key}>{sep}{raya}
              <MensajeVista m={it} cont={cont} citado={it.responde_a ? porId.get(it.responde_a) : undefined} meId={me.id} esAdmin={me.role === 'admin'}
                vistoPor={ultimo && it.id === ultimo.id ? vistoUltimo : undefined}
                onResponder={() => setRespondiendo(it)} onIrA={irA} onAbrirImagen={setVisor}
                onEditado={(m) => mezclar([m])} />
            </Fragment>
          );
        })}
      </div>
      {abajoNuevos > 0 && <button className="btn sm conv-hay-nuevos" onClick={irAbajo}>↓ {abajoNuevos === 1 ? 'Hay algo nuevo' : `${abajoNuevos} novedades`}</button>}
      {puedeEscribir
        ? <Escribir key={`${type}-${recordId}`} onEnviar={enviar} subirA={`/records/${type}/${recordId}/conversacion/adjuntos`} registrarSoltar={registrarSoltar}
          respondiendo={respondiendo ? <>Respondiendo a <b>{userOf(meta, respondiendo.user_id)?.name ?? 'Alguien'}</b>: {textoPlano(respondiendo.body) || '📎 Adjunto'}</> : undefined}
          onCancelarRespuesta={() => setRespondiendo(null)} />
        : <div className="muted small conv-solo-mira">Tu usuario es de «Solo mira»: podés leer la conversación pero no escribir.</div>}
    </section>
  );
}

// ---------- Bandeja: las conversaciones que sigo ----------

export default function ConversacionesPage() {
  const { meta } = useMeta();
  const sinLeer = useNoLeidas();
  const [solo, setSolo] = useState(false);
  const [tick, setTick] = useState(0);
  const [lista, setLista] = useState<NoLeidas | null>(null);
  const [abierta, setAbierta] = useState<{ type: ObjectType; id: number } | null>(null);
  useEffect(() => {
    http<NoLeidas>('GET', `/conversaciones${qs({ no_leidas: solo ? 1 : undefined, limite: 100 })}`).then(setLista).catch(() => undefined);
  }, [solo, tick, sinLeer.no_leidos]);
  const convs = lista?.conversaciones ?? [];
  return (
    <div className="content">
      <div className="page-head">
        <h1>Conversaciones</h1>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Cuáles">
          <button className={!solo ? 'on' : ''} onClick={() => setSolo(false)}>Todas las que sigo</button>
          <button className={solo ? 'on' : ''} onClick={() => setSolo(true)}>Sin leer{sinLeer.no_leidos ? ` (${sinLeer.no_leidos})` : ''}</button>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>Las conversaciones de los pedidos y negocios donde escribiste, te mencionaron, sos el propietario o lo tenés en producción.</p>
      {!lista && <div className="muted">Cargando…</div>}
      {lista && !convs.length && <div className="empty panel">{solo ? 'No tenés nada sin leer.' : 'Todavía no seguís ninguna conversación. Abrí un pedido y escribí en «Conversación».'}</div>}
      <div className="panel conv-bandeja">
        {convs.map((c) => (
          <button key={c.record_id} type="button" className={`conv-fila${c.no_leidos ? ' sin-leer' : ''}`} onClick={() => setAbierta({ type: c.object_type, id: c.record_id })}>
            <Avatar name={c.name} type={c.object_type} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{c.name}</b>
                <span className="small muted">{OBJECTS[c.object_type].single}</span>
                <span className="grow" />
                {c.ultimo && <span className="small muted" title={fmtDate(c.ultimo.created_at, true)}>{fmtRelative(c.ultimo.created_at, true)}</span>}
              </div>
              {c.ultimo && <div className="small ellipsis conv-ultimo"><b>{userOf(meta, c.ultimo.user_id)?.name.split(' ')[0] ?? 'Alguien'}:</b> {c.ultimo.body}</div>}
            </div>
            {c.no_leidos > 0 && <span className={`count${c.menciones ? ' mencion' : ''}`} title={c.menciones ? 'Te mencionaron' : 'Sin leer'}>{c.menciones ? '@ ' : ''}{c.no_leidos}</span>}
          </button>
        ))}
      </div>
      {abierta && <RecordPreview type={abierta.type} id={abierta.id} onClose={() => { setAbierta(null); setTick((t) => t + 1); }} />}
    </div>
  );
}
