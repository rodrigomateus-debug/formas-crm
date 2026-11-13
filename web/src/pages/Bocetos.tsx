import { useEffect, useRef, useState, type ReactNode } from 'react';
import { http, useAsync, useToast, fmtDate, Icon, type ObjectType, cabecerasVerComo } from '../lib';
import { Modal } from '../components';
import { Select } from '../Select';
import { LogoProducto, useLogos, type LogosRes } from './Logos';

// Bocetos de producción (pedido de Rodrigo del 6/11/2026): por producto del pedido, PDF o imagen, guardados en Drive.
// Referencia (una foto o un boceto rápido para avanzar) o técnico (el final, con las medidas); varias versiones; el aprobado
// se adjunta solo a la subtarea del artículo en ClickUp. También se suben al negocio y después se usan en el pedido.

export interface Boceto {
  id: number; record_id: number; producto: string | null; producto_nombre: string | null; tipo: 'referencia' | 'tecnico'; estado: 'para_aprobar' | 'aprobado';
  version: number; nombre: string; mime: string | null; size: number | null; drive_id: string; drive_link: string | null; origen_id: number | null;
  clickup_task: string | null; clickup_at: string | null; created_at: string; negocio?: string;
}
export interface BocetosRes { bocetos: Boceto[]; de_negocios: Boceto[]; configurado: boolean }
// Un producto del pedido: `key` es lo que se guarda en el boceto (el código, o el nombre si no tiene).
export interface ProductoRef { key: string; nombre: string }

export const TIPO_LABEL = { referencia: 'Referencia', tecnico: 'Técnico' } as const;
const esPdf = (b: { mime: string | null; nombre: string }) => b.mime === 'application/pdf' || /\.pdf$/i.test(b.nombre);
const urlArchivo = (b: Boceto, descargar = false) => `/api/bocetos/${b.id}/archivo${descargar ? '?descargar=1' : ''}`;

export function useBocetos(type: ObjectType, id: number) {
  return useAsync(() => http<BocetosRes>('GET', `/records/${type}/${id}/bocetos`), [type, id]);
}

// ---------- Leer el boceto para saber a qué producto va ----------

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const palabras = (s: string) => norm(s).split(' ').filter((w) => w.length > 2);

// El texto de la primera página del PDF (con pdf.js, que se carga solo cuando hace falta).
async function textoPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const out = tc.items.map((i) => ('str' in i ? i.str : '')).filter((s) => s.trim()).join('\n');
  await doc.destroy();
  return out;
}

// El boceto de producción dice «PRODUCTO» y abajo el nombre (hasta «CANTIDAD»). Los títulos vienen con las letras
// separadas («P R O D U C T O»): se juntan antes de comparar.
const titulo = (l: string) => (/^(\S )+\S$/.test(l) ? l.replace(/ /g, '') : l).toUpperCase();
function productoDelTexto(texto: string) {
  const lineas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lineas.findIndex((l) => titulo(l) === 'PRODUCTO');
  if (i < 0) return null;
  const nombre: string[] = [];
  for (const l of lineas.slice(i + 1, i + 4)) { if (/^(CANTIDAD|COLOR|LOGO)/.test(titulo(l))) break; nombre.push(l); }
  return nombre.join(' ').trim() || null;
}

// Qué producto del pedido se parece más (por el nombre del boceto o el del archivo). Sin un parecido claro, ninguno.
function adivinar(pista: string, productos: ProductoRef[]) {
  const p = new Set(palabras(pista));
  let mejor: { key: string; score: number } | null = null, empate = false;
  for (const prod of productos) {
    if (norm(prod.key) && norm(pista).includes(norm(prod.key)) && norm(prod.key).length > 3) return prod.key;
    const score = palabras(prod.nombre).filter((w) => p.has(w)).length;
    if (!score) continue;
    if (!mejor || score > mejor.score) { mejor = { key: prod.key, score }; empate = false; } else if (score === mejor.score) empate = true;
  }
  return mejor && !empate ? mejor.key : null;
}

export async function detectar(file: File, productos: ProductoRef[]) {
  let texto = '';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) texto = await textoPdf(file).catch(() => '');
  const nombre = productoDelTexto(texto);
  const key = productos.length === 1 ? productos[0].key : adivinar([nombre, file.name.replace(/\.[a-z0-9]+$/i, '')].filter(Boolean).join(' '), productos)
    ?? (texto ? adivinar(texto, productos) : null);
  return { key, nombre };
}

// Con XMLHttpRequest y no con fetch: es lo único que avisa cuánto se mandó del archivo, para mostrar el avance.
function subir(type: ObjectType, recordId: number, p: Pendiente, onAvance: (pct: number) => void) {
  return new Promise<Boceto>((resolve, reject) => {
    const fd = new FormData();
    fd.append('archivo', p.file);
    if (p.producto) fd.append('producto', p.producto);
    if (p.productoNombre) fd.append('producto_nombre', p.productoNombre);
    fd.append('tipo', p.tipo);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/records/${type}/${recordId}/bocetos`);
    for (const [k, v] of Object.entries(cabecerasVerComo())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onAvance(e.loaded / e.total); };
    xhr.onload = () => {
      let data: (Boceto & { error?: string }) | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error(data?.error ?? `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Se cortó la conexión. Probá de nuevo.'));
    xhr.send(fd);
  });
}

// ---------- Subir (uno o varios, con su producto) ----------

interface Pendiente { file: File; producto: string; productoNombre: string; tipo: 'referencia' | 'tecnico' }

// Cómo va la subida (aviso de Rodrigo del 13/11/2026: subías un PDF y parecía que no hacía nada hasta el «subido»).
// Leyendo: pdf.js lee el PDF para proponer el producto. Subiendo: el archivo va al CRM (con el %). Guardando: el CRM lo
// guarda en Drive (sin %, es lo que más tarda en los PDF grandes).
export interface Progreso { fase: 'leyendo' | 'subiendo' | 'guardando'; archivo: string; producto: string | null; n: number; de: number; pct: number }

export function AvisoSubida({ p }: { p: Progreso }) {
  const pct = Math.round(p.pct * 100);
  const texto = p.fase === 'leyendo' ? `Leyendo «${p.archivo}» para ver a qué producto va…`
    : p.fase === 'guardando' ? `Guardando «${p.archivo}» en Drive…` : `Subiendo «${p.archivo}»…`;
  const conPct = p.fase === 'subiendo';
  return (
    <div className="boceto-progreso">
      <div className="boceto-progreso-txt">
        <span className="spinner" aria-hidden />
        <span className="ellipsis grow" role="status">{texto}</span>
        {conPct && <span className="num" aria-hidden>{pct} %</span>}
        {p.de > 1 && <span className="muted">{p.n} de {p.de}</span>}
      </div>
      <div className={`boceto-barra${conPct ? '' : ' indeterminada'}`} role="progressbar" aria-label={texto}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={conPct ? pct : undefined}>
        <span style={conPct ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

// Arma la lista de lo que se va a subir: lee cada PDF y propone su producto; con uno solo y el producto ya sabido, sube
// directo. Si no, pregunta en un cuadro (producto y tipo de cada uno). Al terminar, `onListo` recibe los subidos (para
// abrir el primero en el visor y que se vea que quedó bien).
export function useSubirBocetos(type: ObjectType, recordId: number, productos: ProductoRef[] | null, onListo: (subidos: Boceto[]) => void) {
  const toast = useToast();
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  // Una subida por vez (soltar más archivos mientras sube no arranca otra).
  const ocupado = useRef(false);
  const subiendo = !!progreso;
  const elegir = async (files: File[], producto?: ProductoRef) => {
    if (ocupado.current) { toast('Esperá a que termine de subir el boceto anterior.', true); return; }
    const validos = files.filter((f) => /^(application\/pdf|image\/)/.test(f.type) || /\.pdf$/i.test(f.name));
    if (validos.length < files.length) toast('Solo se suben PDF o imágenes.', true);
    if (!validos.length) return;
    ocupado.current = true;
    const lista: Pendiente[] = [];
    try {
      for (const [i, f] of validos.entries()) {
        const tipo = f.type.startsWith('image/') ? 'referencia' : 'tecnico';
        if (producto) { lista.push({ file: f, producto: producto.key, productoNombre: producto.nombre, tipo }); continue; }
        setProgreso({ fase: 'leyendo', archivo: f.name, producto: null, n: i + 1, de: validos.length, pct: 0 });
        const d = await detectar(f, productos ?? []);
        const p = productos?.find((x) => x.key === d.key);
        lista.push({ file: f, producto: p?.key ?? '', productoNombre: p?.nombre ?? d.nombre ?? '', tipo });
      }
    } finally { setProgreso(null); ocupado.current = false; }
    if (lista.length === 1 && (producto || (productos && lista[0].producto))) await confirmar(lista);
    else setPendientes(lista);
  };
  const confirmar = async (lista: Pendiente[]) => {
    if (ocupado.current) return;
    ocupado.current = true;
    const subidos: Boceto[] = [];
    for (const [i, p] of lista.entries()) {
      const base = { archivo: p.file.name, producto: p.producto || null, n: i + 1, de: lista.length };
      setProgreso({ ...base, fase: 'subiendo', pct: 0 });
      try { subidos.push(await subir(type, recordId, p, (pct) => setProgreso({ ...base, fase: pct >= 1 ? 'guardando' : 'subiendo', pct }))); }
      catch (e) { toast(`${p.file.name}: ${(e as Error).message}`, true); }
    }
    ocupado.current = false;
    setProgreso(null);
    setPendientes(null);
    if (subidos.length) { toast(subidos.length === 1 ? 'Boceto subido: revisá que esté bien' : `${subidos.length} bocetos subidos: revisá que estén bien`); onListo(subidos); }
  };
  const cuadro = pendientes && (
    <Modal title={pendientes.length === 1 ? 'Subir boceto' : `Subir ${pendientes.length} bocetos`} onClose={() => !subiendo && setPendientes(null)} footer={<>
      <button className="btn" disabled={subiendo} onClick={() => setPendientes(null)}>Cancelar</button>
      <button className="btn primary" disabled={subiendo} onClick={() => confirmar(pendientes)}>{subiendo ? 'Subiendo…' : 'Subir'}</button>
    </>}>
      {progreso ? <AvisoSubida p={progreso} />
        : <p className="small muted" style={{ margin: 0 }}>{productos ? 'Elegí a qué producto va cada uno (lo propone el CRM leyendo el boceto).' : 'Poné a qué producto va cada uno (lo propone el CRM leyendo el boceto).'}</p>}
      {pendientes.map((p, i) => {
        const set = (x: Partial<Pendiente>) => setPendientes(pendientes.map((q, j) => (j === i ? { ...q, ...x } : q)));
        return (
          <div key={i} className="boceto-subir">
            <div className="ellipsis" title={p.file.name}><Icon name="note" size={14} /> {p.file.name}</div>
            {productos
              ? <Select className="input sm" value={p.producto} aria-label="Producto" disabled={subiendo} onChange={(e) => { const q = productos.find((x) => x.key === e.target.value); set({ producto: q?.key ?? '', productoNombre: q?.nombre ?? '' }); }}>
                  <option value="">Sin producto (lo elegís después)</option>
                  {productos.map((q) => <option key={q.key} value={q.key}>{q.nombre}</option>)}
                </Select>
              : <input className="input sm" placeholder="Producto (ej. Abanico Standard)" value={p.productoNombre} disabled={subiendo} onChange={(e) => set({ productoNombre: e.target.value, producto: e.target.value })} />}
            <Select className="input sm" value={p.tipo} aria-label="Tipo" disabled={subiendo} onChange={(e) => set({ tipo: e.target.value as Pendiente['tipo'] })}>
              <option value="tecnico">Técnico (final, con medidas)</option>
              <option value="referencia">Referencia (foto o boceto rápido)</option>
            </Select>
          </div>
        );
      })}
    </Modal>
  );
  return { elegir, cuadro, subiendo, progreso };
}

// Botón «Subir bocetos» (elige archivos) y zona para soltarlos encima (todo el recuadro).
export function SoltarBocetos({ onArchivos, children, className, aviso = 'Soltá los bocetos acá' }: { onArchivos: (f: File[]) => void; children: ReactNode; className?: string; aviso?: string }) {
  const [encima, setEncima] = useState(false);
  const tieneArchivos = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  return (
    <div className={`${className ?? ''}${encima ? ' soltar-encima' : ''}`}
      onDragOver={(e) => { if (!tieneArchivos(e)) return; e.preventDefault(); setEncima(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEncima(false); }}
      onDrop={(e) => { if (!tieneArchivos(e)) return; e.preventDefault(); setEncima(false); onArchivos([...e.dataTransfer.files]); }}>
      {children}
      {encima && <div className="soltar-aviso">{aviso}</div>}
    </div>
  );
}

export function BotonArchivos({ children, onArchivos, multiple = true, className = 'btn sm', title, accept = 'application/pdf,image/*', disabled }: {
  children: ReactNode; onArchivos: (f: File[]) => void; multiple?: boolean; className?: string; title?: string; accept?: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} title={title} disabled={disabled} onClick={() => ref.current?.click()}>{children}</button>
      <input ref={ref} type="file" hidden multiple={multiple} accept={accept}
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onArchivos(f); }} />
    </>
  );
}

// ---------- Mostrar ----------

// El PDF dibujado con pdf.js (se ve igual en todos los navegadores, también en el celular): hasta 6 páginas, al ancho del visor.
// También lo usa la conversación del pedido (archivos PDF en los mensajes), con sus textos.
export function VistaPdf({ url, paginas = 6, cargando = 'Cargando el boceto…', ayuda = 'Descargalo o abrilo en Drive.' }: { url: string; paginas?: number; cargando?: string; ayuda?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Error ${res.status}`);
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
        const caja = ref.current;
        if (!caja || !vivo) return;
        caja.innerHTML = '';
        for (let n = 1; n <= Math.min(doc.numPages, paginas) && vivo; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const escala = Math.min(2.5, ((caja.clientWidth || 700) - 24) / base.width) * (window.devicePixelRatio || 1);
          const vp = page.getViewport({ scale: escala });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.width = `${vp.width / (window.devicePixelRatio || 1)}px`;
          caja.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        }
        await doc.destroy();
      } catch (e) { if (vivo) setError((e as Error).message); }
    })();
    return () => { vivo = false; };
  }, [url]);
  return error ? <div className="muted small" style={{ padding: 16 }}>No se pudo mostrar el PDF: {error}. {ayuda}</div>
    : <div ref={ref} className="boceto-paginas"><span className="muted small">{cargando}</span></div>;
}

// Las fichitas de los bocetos de un producto: versión, tipo y estado; un clic abre el visor.
export function BocetoChips({ lista, onAbrir }: { lista: Boceto[]; onAbrir: (b: Boceto) => void }) {
  if (!lista.length) return null;
  return (
    <div className="boceto-chips">
      {lista.map((b) => (
        <button key={b.id} type="button" className={`boceto-chip${b.estado === 'aprobado' ? ' ok' : ''}`} onClick={() => onAbrir(b)}
          title={`${b.nombre} · ${TIPO_LABEL[b.tipo]} · ${b.estado === 'aprobado' ? 'Aprobado' : 'Para aprobar'}${b.clickup_at ? ' · adjunto en ClickUp' : ''}`}>
          <span className="boceto-ext">{esPdf(b) ? 'PDF' : 'IMG'}</span>
          v{b.version} · {TIPO_LABEL[b.tipo]}
          {b.estado === 'aprobado' ? <Icon name="check" size={12} /> : <span className="boceto-pend" aria-label="Para aprobar" />}
        </button>
      ))}
    </div>
  );
}

// El boceto grande, con lo que se puede hacer: aprobar, cambiar tipo o producto, abrir en Drive, descargar, quitar.
// Recién subidos (`subidos`): se abre solo con el primero para revisarlo y, si fueron varios, se pasa al siguiente con ‹ ›.
export function BocetoVisor({ b, productos, esPedido, onClose, onCambio, logos, subidos, onIr }: {
  b: Boceto; productos?: ProductoRef[]; esPedido: boolean; onClose: () => void; onCambio: () => void;
  logos?: { type: ObjectType; recordId: number; res: LogosRes | null | undefined; onCambio: () => void };
  subidos?: Boceto[]; onIr?: (b: Boceto) => void;
}) {
  const i = subidos ? subidos.findIndex((y) => y.id === b.id) : -1;
  const toast = useToast();
  const [x, setX] = useState(b);
  const [guardando, setGuardando] = useState(false);
  const cambiar = async (cambios: Partial<Boceto>, aviso: string) => {
    setGuardando(true);
    try { setX(await http<Boceto>('PATCH', `/bocetos/${b.id}`, cambios)); toast(aviso); onCambio(); } catch (e) { toast((e as Error).message, true); }
    setGuardando(false);
  };
  const quitar = async () => {
    if (!confirm('¿Quitar este boceto? El archivo queda en Drive.')) return;
    try { await http('DELETE', `/bocetos/${b.id}`); toast('Boceto quitado'); onCambio(); onClose(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal wide title={`${x.producto_nombre || 'Boceto'} · v${x.version}`} onClose={onClose} footer={<>
      <button className="btn ghost danger" onClick={quitar}>Quitar</button>
      <span className="grow" />
      {x.drive_link && <a className="btn" href={x.drive_link} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Abrir en Drive</a>}
      <a className="btn" href={urlArchivo(x, true)}><Icon name="download" size={14} />Descargar</a>
      {x.estado === 'aprobado'
        ? <button className="btn" disabled={guardando} onClick={() => cambiar({ estado: 'para_aprobar' }, 'Volvió a «Para aprobar»')}>Volver a «Para aprobar»</button>
        : <button className="btn primary" disabled={guardando} onClick={() => cambiar({ estado: 'aprobado' }, esPedido ? 'Aprobado: se adjunta en ClickUp al artículo' : 'Aprobado')}><Icon name="check" size={14} />Aprobar</button>}
    </>}>
      <div className="boceto-visor">
        <div className="boceto-vista">
          {esPdf(x) ? <VistaPdf url={urlArchivo(x)} /> : <img src={urlArchivo(x)} alt={x.nombre} />}
        </div>
        <div className="boceto-datos">
          {i >= 0 && (
            <div className="boceto-recien">
              <b>{subidos!.length > 1 ? `Recién subido (${i + 1} de ${subidos!.length})` : 'Recién subido'}</b>
              <span>Revisá que esté bien{x.estado === 'aprobado' ? '.' : ' y aprobalo.'}</span>
              {subidos!.length > 1 && onIr && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" disabled={i === 0} onClick={() => onIr(subidos![i - 1])} aria-label="Boceto anterior">‹ Anterior</button>
                  <button className="btn sm" disabled={i === subidos!.length - 1} onClick={() => onIr(subidos![i + 1])} aria-label="Boceto siguiente">Siguiente ›</button>
                </div>
              )}
            </div>
          )}
          <div className="eyebrow">Archivo</div>
          <div className="small" style={{ overflowWrap: 'anywhere' }}>{x.nombre}</div>
          <div className="small muted">Subido el {fmtDate(x.created_at)}</div>
          <label className="field">Producto
            {productos
              ? <Select className="input sm" value={x.producto ?? ''} onChange={(e) => { const p = productos.find((q) => q.key === e.target.value); cambiar({ producto: p?.key ?? null, producto_nombre: p?.nombre ?? null }, 'Producto cambiado'); }}>
                  <option value="">Sin producto</option>
                  {productos.map((p) => <option key={p.key} value={p.key}>{p.nombre}</option>)}
                </Select>
              : <input className="input sm" defaultValue={x.producto_nombre ?? ''} onBlur={(e) => e.target.value !== (x.producto_nombre ?? '') && cambiar({ producto: e.target.value, producto_nombre: e.target.value }, 'Producto cambiado')} />}
          </label>
          <label className="field">Tipo
            <Select className="input sm" value={x.tipo} onChange={(e) => cambiar({ tipo: e.target.value as Boceto['tipo'] }, 'Tipo cambiado')}>
              <option value="tecnico">Técnico (final, con medidas)</option>
              <option value="referencia">Referencia (foto o boceto rápido)</option>
            </Select>
          </label>
          {logos && (
            <div className="field">Logo
              {x.producto || x.producto_nombre
                ? <span><LogoProducto type={logos.type} recordId={logos.recordId} producto={(x.producto || x.producto_nombre)!} productoNombre={(x.producto_nombre || x.producto)!} res={logos.res} onCambio={logos.onCambio} /></span>
                : <span className="small muted">Elegí el producto para elegir su logo.</span>}
            </div>
          )}
          <div className="field">Estado
            <span>{x.estado === 'aprobado' ? <span className="tag ok">Aprobado</span> : <span className="tag warn">Para aprobar</span>}</span>
          </div>
          {esPedido && (
            <div className="small muted">
              {x.clickup_at ? <>Adjunto en ClickUp el {fmtDate(x.clickup_at)}.</>
                : x.estado === 'aprobado' ? 'Se está adjuntando en ClickUp al artículo de este producto.'
                : 'Al aprobarlo, se adjunta solo en ClickUp, en la subtarea del artículo, junto con el logo original.'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------- En el negocio ----------

// Bocetos del negocio (antes de que exista el pedido): se suben con el nombre del producto; cuando llega el pedido, se
// usan desde la ficha del pedido.
export function BocetosNegocioCard({ dealId }: { dealId: number }) {
  const res = useBocetos('deal', dealId);
  const [ver, setVer] = useState<Boceto | null>(null);
  const [subidos, setSubidos] = useState<Boceto[] | undefined>();
  const abrir = (b: Boceto | null, recien?: Boceto[]) => { setSubidos(recien); setVer(b); };
  const sub = useSubirBocetos('deal', dealId, null, (s) => { res.reload(); abrir(s[0], s); });
  const lg = useLogos('deal', dealId);
  const logos = { type: 'deal' as const, recordId: dealId, res: lg.data, onCambio: () => lg.reload() };
  const lista = res.data?.bocetos ?? [];
  const grupos = new Map<string, Boceto[]>();
  for (const b of lista) { const k = b.producto_nombre || 'Sin producto'; grupos.set(k, [...(grupos.get(k) ?? []), b]); }
  return (
    <SoltarBocetos className="panel assoc-card soltar" onArchivos={sub.elegir}>
      <div className="panel-head">
        <h3>Bocetos <span className="muted small">({lista.length})</span></h3>
        {res.data?.configurado && <BotonArchivos onArchivos={sub.elegir} disabled={sub.subiendo}>{sub.subiendo ? 'Subiendo…' : '+ Subir'}</BotonArchivos>}
      </div>
      {sub.progreso && !sub.cuadro && <div className="panel-body" style={{ paddingTop: 0 }}><AvisoSubida p={sub.progreso} /></div>}
      {res.data && !res.data.configurado && <div className="panel-body small muted">Para subir bocetos falta elegir la carpeta de Drive (Configuración → Integraciones).</div>}
      {[...grupos].map(([k, l]) => (
        <div key={k} className="assoc-item" style={{ flexDirection: 'column', gap: 4 }}>
          <div className="product-name">{k}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <BocetoChips lista={l} onAbrir={(b) => abrir(b)} />
            {(l[0].producto || l[0].producto_nombre) && <LogoProducto {...logos} producto={(l[0].producto || l[0].producto_nombre)!} productoNombre={k} />}
          </div>
        </div>
      ))}
      {res.data?.configurado && !lista.length && !sub.progreso && <div className="panel-body small muted">Arrastrá acá los PDF o las fotos de referencia. Cuando llegue el pedido, los usás desde su ficha.</div>}
      {sub.cuadro}
      {ver && <BocetoVisor key={ver.id} b={ver} esPedido={false} subidos={subidos} onIr={(b) => setVer(lista.find((y) => y.id === b.id) ?? b)}
        onClose={() => abrir(null)} onCambio={() => res.reload()} logos={logos} />}
    </SoltarBocetos>
  );
}
