import { useEffect, useRef, useState, type ReactNode } from 'react';
import { http, useAsync, useToast, fmtDate, Icon, type ObjectType, cabecerasVerComo } from '../lib';
import { Modal } from '../components';
import { Select } from '../Select';

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

async function subir(type: ObjectType, recordId: number, file: File, producto: string | null, productoNombre: string | null, tipo: string) {
  const fd = new FormData();
  fd.append('archivo', file);
  if (producto) fd.append('producto', producto);
  if (productoNombre) fd.append('producto_nombre', productoNombre);
  fd.append('tipo', tipo);
  const res = await fetch(`/api/records/${type}/${recordId}/bocetos`, { method: 'POST', body: fd, credentials: 'same-origin', headers: cabecerasVerComo() });
  const data = (await res.json().catch(() => null)) as (Boceto & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data as Boceto;
}

// ---------- Subir (uno o varios, con su producto) ----------

interface Pendiente { file: File; producto: string; productoNombre: string; tipo: 'referencia' | 'tecnico' }

// Arma la lista de lo que se va a subir: lee cada PDF y propone su producto; con uno solo y el producto ya sabido, sube
// directo. Si no, pregunta en un cuadro (producto y tipo de cada uno).
export function useSubirBocetos(type: ObjectType, recordId: number, productos: ProductoRef[] | null, onListo: () => void) {
  const toast = useToast();
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const elegir = async (files: File[], producto?: ProductoRef) => {
    const validos = files.filter((f) => /^(application\/pdf|image\/)/.test(f.type) || /\.pdf$/i.test(f.name));
    if (validos.length < files.length) toast('Solo se suben PDF o imágenes.', true);
    if (!validos.length) return;
    const lista: Pendiente[] = [];
    for (const f of validos) {
      const tipo = f.type.startsWith('image/') ? 'referencia' : 'tecnico';
      if (producto) { lista.push({ file: f, producto: producto.key, productoNombre: producto.nombre, tipo }); continue; }
      const d = await detectar(f, productos ?? []);
      const p = productos?.find((x) => x.key === d.key);
      lista.push({ file: f, producto: p?.key ?? '', productoNombre: p?.nombre ?? d.nombre ?? '', tipo });
    }
    if (lista.length === 1 && (producto || (productos && lista[0].producto))) await confirmar(lista);
    else setPendientes(lista);
  };
  const confirmar = async (lista: Pendiente[]) => {
    setSubiendo(true);
    let ok = 0;
    for (const p of lista) {
      try { await subir(type, recordId, p.file, p.producto || null, p.productoNombre || null, p.tipo); ok++; }
      catch (e) { toast(`${p.file.name}: ${(e as Error).message}`, true); }
    }
    setSubiendo(false);
    setPendientes(null);
    if (ok) { toast(ok === 1 ? 'Boceto subido' : `${ok} bocetos subidos`); onListo(); }
  };
  const cuadro = pendientes && (
    <Modal title={pendientes.length === 1 ? 'Subir boceto' : `Subir ${pendientes.length} bocetos`} onClose={() => !subiendo && setPendientes(null)} footer={<>
      <button className="btn" disabled={subiendo} onClick={() => setPendientes(null)}>Cancelar</button>
      <button className="btn primary" disabled={subiendo} onClick={() => confirmar(pendientes)}>{subiendo ? 'Subiendo…' : 'Subir'}</button>
    </>}>
      <p className="small muted" style={{ margin: 0 }}>{productos ? 'Elegí a qué producto va cada uno (lo propone el CRM leyendo el boceto).' : 'Poné a qué producto va cada uno (lo propone el CRM leyendo el boceto).'}</p>
      {pendientes.map((p, i) => {
        const set = (x: Partial<Pendiente>) => setPendientes(pendientes.map((q, j) => (j === i ? { ...q, ...x } : q)));
        return (
          <div key={i} className="boceto-subir">
            <div className="ellipsis" title={p.file.name}><Icon name="note" size={14} /> {p.file.name}</div>
            {productos
              ? <Select className="input sm" value={p.producto} aria-label="Producto" onChange={(e) => { const q = productos.find((x) => x.key === e.target.value); set({ producto: q?.key ?? '', productoNombre: q?.nombre ?? '' }); }}>
                  <option value="">Sin producto (lo elegís después)</option>
                  {productos.map((q) => <option key={q.key} value={q.key}>{q.nombre}</option>)}
                </Select>
              : <input className="input sm" placeholder="Producto (ej. Abanico Standard)" value={p.productoNombre} onChange={(e) => set({ productoNombre: e.target.value, producto: e.target.value })} />}
            <Select className="input sm" value={p.tipo} aria-label="Tipo" onChange={(e) => set({ tipo: e.target.value as Pendiente['tipo'] })}>
              <option value="tecnico">Técnico (final, con medidas)</option>
              <option value="referencia">Referencia (foto o boceto rápido)</option>
            </Select>
          </div>
        );
      })}
    </Modal>
  );
  return { elegir, cuadro, subiendo };
}

// Botón «Subir bocetos» (elige archivos) y zona para soltarlos encima (todo el recuadro).
export function SoltarBocetos({ onArchivos, children, className }: { onArchivos: (f: File[]) => void; children: ReactNode; className?: string }) {
  const [encima, setEncima] = useState(false);
  const tieneArchivos = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  return (
    <div className={`${className ?? ''}${encima ? ' soltar-encima' : ''}`}
      onDragOver={(e) => { if (!tieneArchivos(e)) return; e.preventDefault(); setEncima(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEncima(false); }}
      onDrop={(e) => { if (!tieneArchivos(e)) return; e.preventDefault(); setEncima(false); onArchivos([...e.dataTransfer.files]); }}>
      {children}
      {encima && <div className="soltar-aviso">Soltá los bocetos acá</div>}
    </div>
  );
}

export function BotonArchivos({ children, onArchivos, multiple = true, className = 'btn sm', title }: { children: ReactNode; onArchivos: (f: File[]) => void; multiple?: boolean; className?: string; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => ref.current?.click()}>{children}</button>
      <input ref={ref} type="file" hidden multiple={multiple} accept="application/pdf,image/*"
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
export function BocetoVisor({ b, productos, esPedido, onClose, onCambio }: {
  b: Boceto; productos?: ProductoRef[]; esPedido: boolean; onClose: () => void; onCambio: () => void;
}) {
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
          <div className="field">Estado
            <span>{x.estado === 'aprobado' ? <span className="tag ok">Aprobado</span> : <span className="tag warn">Para aprobar</span>}</span>
          </div>
          {esPedido && (
            <div className="small muted">
              {x.clickup_at ? <>Adjunto en ClickUp el {fmtDate(x.clickup_at)}.</>
                : x.estado === 'aprobado' ? 'Se está adjuntando en ClickUp al artículo de este producto.'
                : 'Al aprobarlo, se adjunta solo en ClickUp, en la subtarea del artículo.'}
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
  const sub = useSubirBocetos('deal', dealId, null, () => res.reload());
  const lista = res.data?.bocetos ?? [];
  const grupos = new Map<string, Boceto[]>();
  for (const b of lista) { const k = b.producto_nombre || 'Sin producto'; grupos.set(k, [...(grupos.get(k) ?? []), b]); }
  return (
    <SoltarBocetos className="panel assoc-card soltar" onArchivos={sub.elegir}>
      <div className="panel-head">
        <h3>Bocetos <span className="muted small">({lista.length})</span></h3>
        {res.data?.configurado && <BotonArchivos onArchivos={sub.elegir}>{sub.subiendo ? 'Subiendo…' : '+ Subir'}</BotonArchivos>}
      </div>
      {res.data && !res.data.configurado && <div className="panel-body small muted">Para subir bocetos falta elegir la carpeta de Drive (Configuración → Integraciones).</div>}
      {[...grupos].map(([k, l]) => (
        <div key={k} className="assoc-item" style={{ flexDirection: 'column', gap: 4 }}>
          <div className="product-name">{k}</div>
          <BocetoChips lista={l} onAbrir={setVer} />
        </div>
      ))}
      {res.data?.configurado && !lista.length && <div className="panel-body small muted">Arrastrá acá los PDF o las fotos de referencia. Cuando llegue el pedido, los usás desde su ficha.</div>}
      {sub.cuadro}
      {ver && <BocetoVisor b={ver} esPedido={false} onClose={() => setVer(null)} onCambio={() => res.reload()} />}
    </SoltarBocetos>
  );
}
