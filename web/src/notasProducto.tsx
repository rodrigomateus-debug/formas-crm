import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { http, cabecerasVerComo, useToast, Icon, recordUrl, fmtDate, fmtRelative, Cargando } from './lib';
import { Modal, UserAvatar, alEsc } from './components';
import { Select } from './Select';

// Notas de producto (pedido de Rodrigo del 16/11/2026; src/worker/notasproducto.ts): lo que Producción aprendió de un
// producto de importador («la serigrafía se sale», «el bordado tapa el bolsillo», «la tinta se borra»), atado a su SKU.
// Se ve sola cada vez que el SKU vuelve a aparecer: en Producción, al lado del artículo, y en los productos del pedido.
// Un clic abre la ficha del SKU: sus notas (con foto), cargar una nueva y los pedidos donde se vendió.

export type Gravedad = 'info' | 'ojo' | 'no';
export interface ResumenNotas { n: number; gravedad: Gravedad; tipos: string[]; ultima: string }
export interface NotaProducto {
  id: number; sku: string; modelo: string | null; producto: string | null; tipo: string; gravedad: Gravedad; texto: string;
  record_id: number | null; pedido: string | null; task_id: string | null; fotos: number[]; user_id: number | null; autor: string | null;
  created_at: string; updated_at: string | null; archivada_at: string | null; archivada_por: number | null; puede_editar: boolean;
}
interface Venta { id: number; name: string; created_at: string; etapa: string | null; cantidad: number | null; empresa: string | null; notas: number }
interface Ficha {
  sku: string; modelo: string | null; nombre: string | null; foto: string | null; notas: NotaProducto[]; ventas: Venta[]; ventas_total: number; unidades_total: number;
  puede_escribir: boolean; fotos: boolean; tipos: Record<string, string>;
}

export const GRAVEDAD: Record<Gravedad, { label: string; corto: string; cls: string }> = {
  info: { label: 'Dato útil', corto: 'Dato', cls: 'info' },
  ojo: { label: 'Ojo', corto: 'Ojo', cls: 'warn' },
  no: { label: 'No recomendado', corto: 'Evitar', cls: 'bad' },
};
const AYUDA_GRAVEDAD: Record<Gravedad, string> = {
  info: 'Algo que conviene saber («en blanco queda mejor»)',
  ojo: 'Hay que tener cuidado («el bordado tapa el bolsillo»)',
  no: 'No conviene venderlo así («la tinta se borra»)',
};

// Cuando se carga, cambia o borra una nota, las pantallas abiertas (Producción, los productos del pedido, la lista de
// notas) se vuelven a pedir para que el aviso se actualice.
const oyentes = new Set<() => void>();
export function avisarCambioNotas() { oyentes.forEach((f) => f()); }
export function useCambioNotas(f: () => void) {
  const ref = useRef(f);
  ref.current = f;
  useEffect(() => {
    const g = () => ref.current();
    oyentes.add(g);
    return () => { oyentes.delete(g); };
  }, []);
}

const urlSku = (sku: string) => `/productos/sku/${encodeURIComponent(sku)}`;
const urlFoto = (id: number) => `/api/productos/notas/fotos/${id}`;
const MAX_FOTOS = 10;   // por nota (MAX_FOTOS en notasproducto.ts)
const TIPOS_FOTO = 'image/jpeg,image/png,image/webp,image/gif';
const esFoto = (f: File) => TIPOS_FOTO.split(',').includes(f.type);

// Las fotos van en un formulario (`foto` repetido, una vez por foto); http() manda JSON.
async function enviarFormulario<T>(url: string, fd: FormData): Promise<T> {
  const res = await fetch(`/api${url}`, { method: 'POST', body: fd, credentials: 'same-origin', headers: cabecerasVerComo() });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data as T;
}
// Las imágenes pegadas (Ctrl+V de una captura o de WhatsApp Web).
const fotosPegadas = (e: React.ClipboardEvent) => Array.from(e.clipboardData.files).filter(esFoto);

// Las fotos elegidas que todavía no se subieron: el nombre y una cruz para sacarla.
function FotosElegidas({ fotos, onQuitar }: { fotos: File[]; onQuitar: (i: number) => void }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = fotos.map((f) => URL.createObjectURL(f));
    setUrls(u);
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, [fotos]);
  if (!fotos.length) return null;
  return (
    <div className="nota-fotos">
      {fotos.map((f, i) => (
        <span key={`${f.name}-${f.size}-${i}`} className="nota-foto" title={f.name}>
          {urls[i] && <img src={urls[i]} alt={f.name} />}
          <button type="button" className="nota-foto-x" onClick={() => onQuitar(i)} aria-label={`Sacar ${f.name}`}><Icon name="x" size={12} /></button>
        </span>
      ))}
    </div>
  );
}

// El aviso al lado del producto: cuántas notas tiene y la más grave, con la última en el título. Sin notas, quien puede
// escribir ve «+ Nota» (en Producción, solo al pasar el mouse por el artículo).
export function NotasDelProducto({ sku, resumen, nombre, foto, recordId, taskId, puedeAgregar, className = '' }: {
  sku: string | null | undefined; resumen?: ResumenNotas | null; nombre?: string | null; foto?: string | null; recordId?: number | null; taskId?: string | null;
  puedeAgregar?: boolean; className?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  if (!sku || (!resumen && !puedeAgregar)) return null;
  const abrir = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); setAbierto(true); };
  const g = resumen ? GRAVEDAD[resumen.gravedad] : null;
  const titulo = resumen
    ? `${resumen.n === 1 ? 'Una nota' : `${resumen.n} notas`} de Producción sobre ${sku}: «${resumen.ultima}»${resumen.n > 1 ? '…' : ''}`
    : `Anotar algo de ${sku} para la próxima vez que se venda`;
  return (
    <>
      {resumen && g
        ? <button type="button" className={`nota-prod-chip ${g.cls} ${className}`} onClick={abrir} title={titulo} aria-label={titulo}>
            <Icon name="alert" size={12} />{resumen.n === 1 ? (resumen.gravedad === 'info' ? 'Nota' : g.corto) : `${resumen.n} notas`}
          </button>
        : <button type="button" className={`nota-prod-mas ${className}`} onClick={abrir} title={titulo} aria-label={titulo}><Icon name="plus" size={12} />Nota</button>}
      {/* Fuera de la fila (en Producción la tabla tiene encabezados fijos que quedarían arriba) y sin que los clics lleguen
          a la fila, que abriría la vista previa del pedido. */}
      {abierto && createPortal(
        <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <FichaProducto sku={sku} nombre={nombre} foto={foto} recordId={recordId} taskId={taskId} nueva={!resumen} onClose={() => setAbierto(false)} />
        </div>, document.body)}
    </>
  );
}

// La ficha del SKU: las notas (las vigentes primero, las más graves arriba), cargar una nueva y dónde se vendió.
export function FichaProducto({ sku, nombre, foto, recordId, taskId, nueva, onClose }: {
  sku: string; nombre?: string | null; foto?: string | null; recordId?: number | null; taskId?: string | null; nueva?: boolean; onClose: () => void;
}) {
  const [f, setF] = useState<Ficha | null>(null);
  const [error, setError] = useState('');
  const [verArchivadas, setVerArchivadas] = useState(false);
  const [todasVentas, setTodasVentas] = useState(false);
  const cargar = () => http<Ficha>('GET', urlSku(sku)).then((d) => { setF(d); setError(''); }, (e) => setError((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [sku]);
  const cambio = () => { cargar(); avisarCambioNotas(); };
  const vigentes = f?.notas.filter((n) => !n.archivada_at) ?? [];
  const archivadas = f?.notas.filter((n) => n.archivada_at) ?? [];
  const titulo = f?.nombre ?? nombre ?? sku;
  const img = f?.foto ?? foto;
  const ventas = todasVentas ? f?.ventas ?? [] : (f?.ventas ?? []).slice(0, 8);
  return (
    <Modal title="Notas del producto" onClose={onClose} wide>
      <div className="nota-ficha">
        <div className="nota-ficha-head">
          {img ? <a href={img} target="_blank" rel="noreferrer" className="product-img" title="Ver la foto"><img src={img} alt="" /></a>
            : <span className="product-img none" aria-hidden><Icon name="order" size={18} /></span>}
          <div style={{ minWidth: 0 }}>
            <div className="nota-ficha-nombre">{titulo}</div>
            <div className="small muted">
              <span className="num">{sku}</span>
              {f && ` · ${f.ventas_total ? `se vendió en ${f.ventas_total === 1 ? 'un pedido' : `${f.ventas_total.toLocaleString('es-AR')} pedidos`}${f.unidades_total ? ` (${Math.round(f.unidades_total).toLocaleString('es-AR')} u.)` : ''}` : 'todavía no hay pedidos con este SKU en el CRM'}`}
            </div>
          </div>
        </div>
        {error && <div className="tag bad">{error}</div>}
        {!f && !error && <div className="muted small"><Cargando chico /></div>}
        {f?.puede_escribir && <NuevaNota ficha={f} nombre={titulo} recordId={recordId} taskId={taskId} autoFocus={nueva} onGuardada={cambio} />}
        {f && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="nota-seccion">Notas {vigentes.length > 0 && <span className="muted">({vigentes.length})</span>}</div>
            {!vigentes.length && <div className="muted small">{f.notas.length ? 'No hay notas vigentes.' : 'Este producto todavía no tiene notas.'}{!f.puede_escribir && ' Las cargan Producción y los administradores.'}</div>}
            {vigentes.map((n) => <Nota key={n.id} n={n} f={f} puede={f.puede_escribir} onCambio={cambio} />)}
            {archivadas.length > 0 && (
              <>
                <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setVerArchivadas(!verArchivadas)} aria-expanded={verArchivadas}>
                  {verArchivadas ? 'Ocultar' : 'Ver'} las que ya no aplican ({archivadas.length})
                </button>
                {verArchivadas && archivadas.map((n) => <Nota key={n.id} n={n} f={f} puede={f.puede_escribir} onCambio={cambio} />)}
              </>
            )}
          </div>
        )}
        {f && f.ventas.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="nota-seccion">Dónde se vendió {f.ventas.length < f.ventas_total && <span className="muted" title="Solo se listan los pedidos que podés ver">({f.ventas.length} de {f.ventas_total})</span>}</div>
            {ventas.map((v) => (
              <div key={v.id} className="nota-venta">
                <Link to={recordUrl('order', v.id)} className="ellipsis" onClick={onClose}>{v.name}</Link>
                <span className="small muted ellipsis">{[v.empresa, fmtDate(v.created_at), v.cantidad != null && `${Math.round(v.cantidad).toLocaleString('es-AR')} u.`].filter(Boolean).join(' · ')}</span>
                {v.notas > 0 && <span className="nota-prod-chip warn" title="En este pedido se escribió una nota"><Icon name="alert" size={12} />{v.notas === 1 ? 'Nota' : `${v.notas} notas`}</span>}
              </div>
            ))}
            {f.ventas.length > 8 && <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTodasVentas(!todasVentas)}>{todasVentas ? 'Ver menos' : `Ver todos (${f.ventas.length})`}</button>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ElegirGravedad({ value, onChange }: { value: Gravedad; onChange: (g: Gravedad) => void }) {
  return (
    <div className="nota-gravedad" role="radiogroup" aria-label="Qué tan importante es">
      {(['info', 'ojo', 'no'] as const).map((g) => (
        <button key={g} type="button" role="radio" aria-checked={value === g} className={`nota-grav-op ${GRAVEDAD[g].cls}${value === g ? ' on' : ''}`} onClick={() => onChange(g)} title={AYUDA_GRAVEDAD[g]}>
          {GRAVEDAD[g].label}
        </button>
      ))}
    </div>
  );
}

function NuevaNota({ ficha, nombre, recordId, taskId, autoFocus, onGuardada }: {
  ficha: Ficha; nombre: string; recordId?: number | null; taskId?: string | null; autoFocus?: boolean; onGuardada: () => void;
}) {
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const [tipo, setTipo] = useState('otro');
  const [gravedad, setGravedad] = useState<Gravedad>('ojo');
  const [todos, setTodos] = useState(false);
  const [fotos, setFotos] = useState<File[]>([]);
  const [guardando, setGuardando] = useState(false);
  const archivo = useRef<HTMLInputElement>(null);
  const sumarFotos = (nuevas: File[]) => {
    if (!nuevas.length) return;
    const todas = [...fotos, ...nuevas.filter(esFoto)];
    if (todas.length > MAX_FOTOS) toast(`Una nota lleva hasta ${MAX_FOTOS} fotos: quedaron las primeras ${MAX_FOTOS}.`, true);
    setFotos(todas.slice(0, MAX_FOTOS));
  };
  const guardar = async () => {
    if (!texto.trim()) return;
    setGuardando(true);
    try {
      const fd = new FormData();
      fd.append('texto', texto.trim()); fd.append('tipo', tipo); fd.append('gravedad', gravedad); fd.append('todos_colores', todos ? '1' : '0');
      fd.append('producto', nombre);
      if (recordId) fd.append('record_id', String(recordId));
      if (taskId) fd.append('task_id', taskId);
      for (const f of fotos) fd.append('foto', f);
      await enviarFormulario(`${urlSku(ficha.sku)}/notas`, fd);
      setTexto(''); setFotos([]); setTipo('otro'); setGravedad('ojo'); setTodos(false);
      toast('Nota guardada: se va a ver cada vez que se venda este producto');
      onGuardada();
    } catch (e) { toast((e as Error).message, true); }
    setGuardando(false);
  };
  return (
    <div className="nota-nueva">
      <textarea className="input" rows={3} autoFocus={autoFocus} placeholder="¿Qué pasó con este producto? Ej.: la serigrafía se sale en la tela, el bordado tapa el bolsillo…"
        value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={2000}
        onPaste={ficha.fotos ? (e) => { const p = fotosPegadas(e); if (p.length) { e.preventDefault(); sumarFotos(p); } } : undefined}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) guardar(); }} />
      {ficha.fotos && <FotosElegidas fotos={fotos} onQuitar={(i) => setFotos(fotos.filter((_, j) => j !== i))} />}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select className="input sm" style={{ width: 210 }} value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo de nota">
          {Object.entries(ficha.tipos).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <ElegirGravedad value={gravedad} onChange={setGravedad} />
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {ficha.modelo && (
          <label className="row small" style={{ gap: 6 }} title={`La nota se ve en todos los SKU que empiezan con ${ficha.modelo} (los otros colores del mismo producto)`}>
            <input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} />
            Vale para todos los colores ({ficha.modelo}…)
          </label>
        )}
        {ficha.fotos && (
          <>
            <input ref={archivo} type="file" accept={TIPOS_FOTO} multiple hidden
              onChange={(e) => { sumarFotos(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            {fotos.length < MAX_FOTOS && (
              <button type="button" className="btn ghost sm" onClick={() => archivo.current?.click()} title="Se pueden elegir varias a la vez, o pegarlas en el texto (Ctrl+V)">
                <Icon name="image" size={14} />{fotos.length ? 'Agregar más fotos' : 'Agregar fotos'}
              </button>
            )}
          </>
        )}
        <span className="grow" />
        <button type="button" className="btn primary sm" disabled={guardando || !texto.trim()} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar nota'}</button>
      </div>
    </div>
  );
}

function Nota({ n, f, puede, onCambio }: { n: NotaProducto; f: Ficha; puede: boolean; onCambio: () => void }) {
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(n.texto);
  const [tipo, setTipo] = useState(n.tipo);
  const [gravedad, setGravedad] = useState<Gravedad>(n.gravedad);
  const [todos, setTodos] = useState(!!n.modelo);
  const [subiendo, setSubiendo] = useState(false);
  const archivo = useRef<HTMLInputElement>(null);
  const g = GRAVEDAD[n.gravedad];
  // Agregar o sacar fotos (quien la escribió o un administrador, mientras edita): se guarda en el momento.
  const agregarFotos = async (nuevas: File[]) => {
    const ok = nuevas.filter(esFoto);
    if (!ok.length) return;
    const lugar = MAX_FOTOS - n.fotos.length;
    if (ok.length > lugar) toast(lugar > 0 ? `Una nota lleva hasta ${MAX_FOTOS} fotos: se suben las primeras ${lugar}.` : `Una nota lleva hasta ${MAX_FOTOS} fotos.`, true);
    if (lugar <= 0) return;
    setSubiendo(true);
    try {
      const fd = new FormData();
      for (const f of ok.slice(0, lugar)) fd.append('foto', f);
      await enviarFormulario(`/productos/notas/${n.id}/fotos`, fd);
      toast(ok.length > 1 ? 'Fotos agregadas' : 'Foto agregada'); onCambio();
    } catch (e) { toast((e as Error).message, true); }
    setSubiendo(false);
  };
  const sacarFoto = async (fotoId: number) => {
    if (!window.confirm('¿Sacar esta foto de la nota?')) return;
    try { await http('DELETE', `/productos/notas/fotos/${fotoId}`); toast('Foto sacada'); onCambio(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const cancelarEdicion = () => { setEditando(false); setTexto(n.texto); setTipo(n.tipo); setGravedad(n.gravedad); setTodos(!!n.modelo); };
  const cambiar = async (body: Record<string, unknown>, ok: string) => {
    try { await http('PATCH', `/productos/notas/${n.id}`, body); toast(ok); setEditando(false); onCambio(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const borrar = async () => {
    if (!window.confirm('¿Borrar la nota? Si ya no aplica (cambió el producto o el lote), mejor archivala: queda en el historial.')) return;
    try { await http('DELETE', `/productos/notas/${n.id}`); toast('Nota borrada'); onCambio(); }
    catch (e) { toast((e as Error).message, true); }
  };
  // Otra variante del mismo modelo: se avisa de qué SKU es.
  const deOtroSku = n.sku !== f.sku;
  return (
    <div className={`nota-item${n.archivada_at ? ' archivada' : ''}`}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`tag ${g.cls}`}>{g.label}</span>
        <span className="small nota-tipo">{f.tipos[n.tipo] ?? n.tipo}</span>
        {n.modelo && <span className="small muted" title={`Vale para todos los SKU que empiezan con ${n.modelo}`}>· todos los colores</span>}
        {deOtroSku && <span className="small muted">· escrita en {n.sku}</span>}
        {n.archivada_at && <span className="small muted">· ya no aplica desde {fmtDate(n.archivada_at)}</span>}
      </div>
      {editando ? (
        // Esc cancela y Ctrl+Enter guarda, como en la nota nueva y en la edición en el lugar del resto del CRM.
        <div className="stack" style={{ gap: 6, marginTop: 6 }} onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && texto.trim()) { e.preventDefault(); void cambiar({ texto, tipo, gravedad, ...(deOtroSku ? {} : { todos_colores: todos }) }, 'Nota actualizada'); return; }
          alEsc(cancelarEdicion)(e);
        }}>
          <textarea className="input" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={2000} autoFocus
            onPaste={f.fotos ? (e) => { const p = fotosPegadas(e); if (p.length) { e.preventDefault(); void agregarFotos(p); } } : undefined} />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Select className="input sm" style={{ width: 210 }} value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo de nota">
              {Object.entries(f.tipos).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
            <ElegirGravedad value={gravedad} onChange={setGravedad} />
            {(f.modelo || n.modelo) && !deOtroSku && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} />Todos los colores</label>}
            {f.fotos && n.fotos.length < MAX_FOTOS && (
              <>
                <input ref={archivo} type="file" accept={TIPOS_FOTO} multiple hidden onChange={(e) => { void agregarFotos(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                <button type="button" className="btn ghost sm" disabled={subiendo} onClick={() => archivo.current?.click()} title="Se guardan en el momento; también se pueden pegar en el texto (Ctrl+V)">
                  <Icon name="image" size={14} />{subiendo ? 'Subiendo…' : 'Agregar fotos'}
                </button>
              </>
            )}
            <span className="grow" />
            <button type="button" className="btn ghost sm" onClick={cancelarEdicion}>Cancelar</button>
            <button type="button" className="btn primary sm" disabled={!texto.trim()} onClick={() => cambiar({ texto, tipo, gravedad, ...(deOtroSku ? {} : { todos_colores: todos }) }, 'Nota actualizada')}>Guardar</button>
          </div>
        </div>
      ) : <div className="nota-texto">{n.texto}</div>}
      {n.fotos.length > 0 && (
        <div className="nota-fotos">
          {n.fotos.map((id, i) => (
            <span key={id} className="nota-foto">
              <a href={urlFoto(id)} target="_blank" rel="noreferrer" title="Ver la foto">
                <img src={urlFoto(id)} alt={`Foto ${i + 1} de ${n.fotos.length} de la nota sobre ${n.sku}`} loading="lazy" />
              </a>
              {editando && n.puede_editar && <button type="button" className="nota-foto-x" onClick={() => sacarFoto(id)} aria-label="Sacar la foto"><Icon name="x" size={12} /></button>}
            </span>
          ))}
        </div>
      )}
      <div className="row small muted" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
        {n.user_id ? <UserAvatar id={n.user_id} size="xs" /> : null}
        <span>{n.autor ?? 'Alguien'} · <span title={fmtDate(n.created_at, true)}>{fmtRelative(n.created_at)}</span>{n.updated_at ? ' (editada)' : ''}</span>
        {n.record_id && n.pedido && <>· <Link to={recordUrl('order', n.record_id)}>{n.pedido}</Link></>}
        <span className="grow" />
        {puede && !editando && (
          <>
            {n.puede_editar && !n.archivada_at && <button type="button" className="btn ghost sm" onClick={() => setEditando(true)}>Editar</button>}
            <button type="button" className="btn ghost sm" onClick={() => cambiar({ archivada: !n.archivada_at }, n.archivada_at ? 'La nota vuelve a estar vigente' : 'Nota archivada: ya no se avisa')}
              title={n.archivada_at ? 'Volver a avisar con esta nota' : 'El problema ya no pasa (cambió el producto o el lote): deja de avisar y queda en el historial'}>
              {n.archivada_at ? 'Volver a avisar' : 'Ya no aplica'}
            </button>
            {n.puede_editar && <button type="button" className="btn ghost xs" onClick={borrar} aria-label="Borrar la nota"><Icon name="trash" size={12} /></button>}
          </>
        )}
      </div>
    </div>
  );
}
