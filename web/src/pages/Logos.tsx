import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { http, useAsync, useMeta, useToast, fmtDate, Icon, type ObjectType, cabecerasVerComo } from '../lib';
import { Modal } from '../components';
import { BotonArchivos, SoltarBocetos, VistaPdf } from './Bocetos';

// Logos del cliente (pedido de Rodrigo del 13/11/2026): el original «en curvas» (AI, EPS, CDR, SVG, PDF…) se guarda una vez
// en la empresa (Drive: <empresa>/Logos) y en cada producto del pedido o negocio (y en su boceto) se elige cuál va; sin
// elegir, el principal. Subir uno nuevo desde un producto lo deja elegido ahí y guardado entre los de la empresa. Al
// subirlo se revisa si los textos están en curvas (los PDF y los AI compatibles, acá con pdf.js; el resto, en el servidor).

export type Curvas = 'ok' | 'textos' | 'sin_verificar' | 'no_vectorial';
export interface Logo {
  id: number; company_id: number; etiqueta: string | null; nombre: string; formato: string; mime: string | null; size: number | null;
  vectorial: number; vista: 'pdf' | 'svg' | 'imagen' | null; curvas: Curvas; principal: number; drive_id: string; drive_link: string | null; created_at: string;
}
export interface LogosRes { company_id: number | null; empresa: string | null; logos: Logo[]; elegidos: Array<{ producto: string; logo_id: number }>; configurado: boolean }

export const ACEPTA_LOGOS = '.ai,.eps,.cdr,.svg,.pdf,.psd,.png,.jpg,.jpeg,.webp,.tif,.tiff,application/pdf,image/svg+xml,image/png,image/jpeg,image/webp';
const urlLogo = (l: Logo, descargar = false) => `/api/logos/${l.id}/archivo${descargar ? '?descargar=1' : ''}`;
const tamano = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
export const nombreLogo = (l: Logo) => l.etiqueta || l.nombre.replace(/\.[a-z0-9]+$/i, '');

export const CURVAS: Record<Curvas, { label: string; cls: string; ayuda: string }> = {
  ok: { label: 'En curvas', cls: 'ok', ayuda: 'Vectorial y sin textos sueltos: listo para producción.' },
  textos: { label: 'Textos sin curvas', cls: 'bad', ayuda: 'Tiene textos con tipografía: si el taller no la tiene, sale distinto. Pedí el archivo con los textos convertidos a curvas.' },
  sin_verificar: { label: 'Sin verificar', cls: 'info', ayuda: 'Es vectorial, pero en este formato el CRM no puede revisar si los textos están en curvas. Abrilo y fijate.' },
  no_vectorial: { label: 'No vectorial', cls: 'warn', ayuda: 'Es una imagen (PNG, JPG, PSD…): sirve de referencia, pero para producir hace falta el vectorial.' },
};

// `empresas`: las empresas asociadas al pedido o negocio (sus ids). Si cambian (se asocia o se crea la empresa desde la vista
// previa), los logos se vuelven a pedir: antes quedaba «no tiene empresa» hasta cerrar y abrir (aviso de Rodrigo del 13/11/2026).
export function useLogos(type: ObjectType, id: number, empresas = '') {
  return useAsync(() => http<LogosRes>('GET', `/records/${type}/${id}/logos`), [type, id, empresas]);
}

// El logo que va en un producto: el elegido o, si no, el principal (el primero de la lista).
export function logoDe(res: LogosRes | null | undefined, producto: string | null) {
  if (!res) return { logo: null as Logo | null, elegido: false };
  const id = producto ? res.elegidos.find((e) => e.producto === producto)?.logo_id : undefined;
  const elegido = id ? res.logos.find((l) => l.id === id) ?? null : null;
  return { logo: elegido ?? res.logos.find((l) => l.principal) ?? res.logos[0] ?? null, elegido: !!elegido };
}

// ---------- Subir ----------

// En los PDF (y los AI guardados compatibles con PDF), si hay textos: pdf.js lee el texto de las primeras páginas; si no
// encuentra nada, los textos están en curvas.
async function curvasPdf(file: File): Promise<Curvas | null> {
  const cabeza = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!String.fromCharCode(...cabeza).includes('%PDF-')) return null;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let textos = false;
    for (let n = 1; n <= Math.min(doc.numPages, 5) && !textos; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      textos = tc.items.some((i) => 'str' in i && i.str.trim() !== '');
    }
    await doc.destroy();
    return textos ? 'textos' : 'ok';
  } catch { return null; }
}

export async function subirLogo(type: ObjectType, recordId: number, file: File, extra: { etiqueta?: string; producto?: string } = {}) {
  const fd = new FormData();
  fd.append('archivo', file);
  const c = await curvasPdf(file);
  if (c) fd.append('curvas', c);
  if (extra.etiqueta) fd.append('etiqueta', extra.etiqueta);
  if (extra.producto) fd.append('producto', extra.producto);
  const res = await fetch(`/api/records/${type}/${recordId}/logos`, { method: 'POST', body: fd, credentials: 'same-origin', headers: cabecerasVerComo() });
  const data = (await res.json().catch(() => null)) as (Logo & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data as Logo;
}

// ---------- Mostrar ----------

export function EstadoCurvas({ curvas, corto }: { curvas: Curvas; corto?: boolean }) {
  const c = CURVAS[curvas];
  return <span className={`tag ${c.cls}${corto ? ' logo-tag' : ''}`} title={c.ayuda}>{c.label}</span>;
}

// La miniatura: la imagen o el SVG tal cual; el PDF (o el AI), su primera página dibujada con pdf.js; lo demás, el formato.
const miniaturas = new Map<number, string>();
export function LogoMini({ logo, grande }: { logo: Logo; grande?: boolean }) {
  const [src, setSrc] = useState<string | null>(() => (logo.vista === 'pdf' ? miniaturas.get(logo.id) ?? null : logo.vista ? urlLogo(logo) : null));
  useEffect(() => {
    if (logo.vista !== 'pdf' || miniaturas.has(logo.id)) return;
    let vivo = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        const res = await fetch(urlLogo(logo), { credentials: 'same-origin', headers: cabecerasVerComo() });
        if (!res.ok) return;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 200 / Math.max(page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height) });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        await doc.destroy();
        const url = canvas.toDataURL('image/png');
        miniaturas.set(logo.id, url);
        if (vivo) setSrc(url);
      } catch { /* sin miniatura: queda el formato */ }
    })();
    return () => { vivo = false; };
  }, [logo]);
  return (
    <span className={`logo-mini${grande ? ' grande' : ''}`}>
      {src ? <img src={src} alt="" loading="lazy" onError={() => setSrc(null)} /> : <span className="logo-ext">{logo.formato.toUpperCase()}</span>}
    </span>
  );
}

// El logo grande: verlo, ponerle nombre, hacerlo principal, descargarlo, abrirlo en Drive o quitarlo.
export function LogoVisor({ logo, onClose, onCambio, puedeEditar }: { logo: Logo; onClose: () => void; onCambio: () => void; puedeEditar: boolean }) {
  const toast = useToast();
  const [x, setX] = useState(logo);
  const cambiar = async (cambios: { etiqueta?: string | null; principal?: boolean }, aviso: string) => {
    try { setX(await http<Logo>('PATCH', `/logos/${x.id}`, cambios)); toast(aviso); onCambio(); } catch (e) { toast((e as Error).message, true); }
  };
  const quitar = async () => {
    if (!confirm('¿Quitar este logo? Deja de ofrecerse en los productos (el archivo queda en Drive).')) return;
    try { await http('DELETE', `/logos/${x.id}`); toast('Logo quitado'); onCambio(); onClose(); } catch (e) { toast((e as Error).message, true); }
  };
  return createPortal(
    <Modal wide title={nombreLogo(x)} onClose={onClose} footer={<>
      {puedeEditar && <button className="btn ghost danger" onClick={quitar}>Quitar</button>}
      <span className="grow" />
      {x.drive_link && <a className="btn" href={x.drive_link} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Abrir en Drive</a>}
      <a className="btn primary" href={urlLogo(x, true)}><Icon name="download" size={14} />Descargar {x.formato.toUpperCase()}</a>
    </>}>
      <div className="boceto-visor">
        <div className="boceto-vista logo-vista">
          {x.vista === 'pdf' ? <VistaPdf url={urlLogo(x)} paginas={3} cargando="Cargando el logo…" ayuda="Descargalo para verlo." />
            : x.vista ? <img src={urlLogo(x)} alt={x.nombre} />
            : <div className="logo-sin-vista"><span className="logo-ext grande">{x.formato.toUpperCase()}</span>
                <span className="small muted">Los {x.formato.toUpperCase()} no se pueden ver en el navegador: descargalo para abrirlo{x.formato === 'cdr' ? ' con CorelDRAW' : x.formato === 'ai' ? ' con Illustrator' : ''}.</span></div>}
        </div>
        <div className="boceto-datos">
          <label className="field">Nombre
            <input className="input sm" defaultValue={x.etiqueta ?? ''} placeholder="Ej. Color, Negativo, Isotipo" disabled={!puedeEditar}
              onBlur={(e) => e.target.value !== (x.etiqueta ?? '') && cambiar({ etiqueta: e.target.value }, 'Nombre guardado')} />
          </label>
          <div className="field">Curvas <span><EstadoCurvas curvas={x.curvas} /></span></div>
          <div className="small muted">{CURVAS[x.curvas].ayuda}</div>
          <div className="eyebrow">Archivo</div>
          <div className="small" style={{ overflowWrap: 'anywhere' }}>{x.nombre}</div>
          <div className="small muted">{x.formato.toUpperCase()}{x.size ? ` · ${tamano(x.size)}` : ''} · subido el {fmtDate(x.created_at)}</div>
          {x.principal
            ? <div className="small"><Icon name="star" size={14} /> Es el principal: va en los productos que no tienen otro elegido.</div>
            : puedeEditar && <button className="btn sm" onClick={() => cambiar({ principal: true }, 'Ahora es el principal')}><Icon name="star" size={14} />Hacerlo principal</button>}
        </div>
      </div>
    </Modal>, document.body);
}

// ---------- En la empresa ----------

// «Logos» en la ficha de la empresa: todas las versiones, el principal primero; se suben con el botón o soltándolos.
export function LogosCard({ companyId }: { companyId: number }) {
  const { meta } = useMeta();
  const toast = useToast();
  const res = useLogos('company', companyId);
  const [ver, setVer] = useState<Logo | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const puede = meta.me.role !== 'viewer' && !meta.real_user;
  const lista = res.data?.logos ?? [];
  const subir = async (files: File[]) => {
    if (!res.data?.configurado) { toast('Para subir logos falta elegir la carpeta de Drive (Configuración → Integraciones).', true); return; }
    setSubiendo(true);
    let ok = 0;
    for (const f of files) {
      try { const l = await subirLogo('company', companyId, f); ok++; if (l.curvas === 'textos') toast(`${f.name}: tiene textos sin pasar a curvas.`, true); }
      catch (e) { toast(`${f.name}: ${(e as Error).message}`, true); }
    }
    setSubiendo(false);
    if (ok) { toast(ok === 1 ? 'Logo guardado' : `${ok} logos guardados`); res.reload(); }
  };
  return (
    <SoltarBocetos className="panel assoc-card soltar" onArchivos={(f) => puede && subir(f)} aviso="Soltá los logos acá">
      <div className="panel-head">
        <h3>Logos <span className="muted small">({lista.length})</span></h3>
        {puede && res.data?.configurado && <BotonArchivos accept={ACEPTA_LOGOS} onArchivos={subir} disabled={subiendo} title="AI, EPS, CDR, SVG o PDF (en curvas); también podés soltarlos encima">{subiendo ? 'Subiendo…' : '+ Subir'}</BotonArchivos>}
      </div>
      {res.data && !res.data.configurado && <div className="panel-body small muted">Para subir logos falta elegir la carpeta de Drive (Configuración → Integraciones).</div>}
      {lista.map((l) => (
        <button key={l.id} type="button" className="assoc-item logo-item" onClick={() => setVer(l)}>
          <LogoMini logo={l} />
          <span className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
            <span className="product-name ellipsis" style={{ display: 'block' }}>{nombreLogo(l)}{l.principal ? <Icon name="star" size={12} /> : null}</span>
            <span className="small muted">{l.formato.toUpperCase()}</span>
          </span>
          <EstadoCurvas curvas={l.curvas} corto />
        </button>
      ))}
      {res.data?.configurado && !lista.length && <div className="panel-body small muted">Subí el logo original en curvas (AI, EPS, CDR, SVG o PDF). Queda para todos los pedidos de esta empresa y se elige en cada producto.</div>}
      {ver && <LogoVisor logo={ver} puedeEditar={puede} onClose={() => setVer(null)} onCambio={() => res.reload()} />}
    </SoltarBocetos>
  );
}

// ---------- En el producto (y su boceto) ----------

// Bajar el archivo original del logo (AI, CDR, PDF…) de un clic (pedido de Rodrigo del 13/11/2026: desde el pedido había
// que abrir el cuadro, el ojito y recién ahí «Descargar»).
export function BajarLogo({ logo, className = 'btn ghost xs icon logo-bajar' }: { logo: Logo; className?: string }) {
  return (
    <a className={className} href={urlLogo(logo, true)} download={logo.nombre} title={`Descargar ${nombreLogo(logo)} (${logo.formato.toUpperCase()})`}
      aria-label={`Descargar el logo ${nombreLogo(logo)}`} onClick={(e) => e.stopPropagation()}>
      <Icon name="download" size={13} />
    </a>
  );
}

// La fichita del logo de un producto: cuál va y cómo está; un clic abre el cuadro para elegir otro o subir uno nuevo. Al
// lado, para bajarlo.
export function LogoProducto({ type, recordId, producto, productoNombre, res, onCambio }: {
  type: ObjectType; recordId: number; producto: string; productoNombre: string; res: LogosRes | null | undefined; onCambio: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  if (!res) return null;
  const { logo, elegido } = logoDe(res, producto);
  const estado = logo ? logo.curvas : null;
  return (
    <>
      <button type="button" className={`boceto-chip logo-chip${estado === 'ok' ? ' ok' : !logo || estado === 'textos' ? ' falta' : ''}`} onClick={() => setAbierto(true)}
        title={logo ? `Logo: ${nombreLogo(logo)}${elegido ? '' : ' (el principal)'} · ${CURVAS[logo.curvas].label}` : 'Este producto no tiene logo: elegí o subí el original en curvas'}>
        <Icon name="vector" size={13} />
        {logo ? <span className="ellipsis" style={{ maxWidth: 120 }}>{nombreLogo(logo)}</span> : 'Falta logo'}
        {logo && (estado === 'ok' ? <Icon name="check" size={12} /> : <span className={`logo-punto ${CURVAS[logo.curvas].cls}`} aria-label={CURVAS[logo.curvas].label} />)}
      </button>
      {logo && <BajarLogo logo={logo} />}
      {abierto && createPortal(<ElegirLogo type={type} recordId={recordId} producto={producto} productoNombre={productoNombre} res={res}
        onClose={() => setAbierto(false)} onCambio={onCambio} />, document.body)}
    </>
  );
}

function ElegirLogo({ type, recordId, producto, productoNombre, res, onClose, onCambio }: {
  type: ObjectType; recordId: number; producto: string; productoNombre: string; res: LogosRes; onClose: () => void; onCambio: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const [subiendo, setSubiendo] = useState(false);
  const [ver, setVer] = useState<Logo | null>(null);
  const puede = meta.me.role !== 'viewer' && !meta.real_user;
  const elegidoId = res.elegidos.find((e) => e.producto === producto)?.logo_id ?? null;
  const elegir = async (logoId: number | null) => {
    try {
      await http('PUT', `/records/${type}/${recordId}/logos/producto`, { producto, logo_id: logoId });
      toast(logoId ? 'Logo elegido' : 'Va el logo principal');
      onCambio(); onClose();
    } catch (e) { toast((e as Error).message, true); }
  };
  const subir = async (files: File[]) => {
    if (!files[0]) return;
    setSubiendo(true);
    try {
      const l = await subirLogo(type, recordId, files[0], { producto });
      toast(l.curvas === 'textos' ? 'Logo guardado, pero tiene textos sin pasar a curvas.' : `Logo guardado en ${res.empresa ?? 'la empresa'} y elegido para este producto`, l.curvas === 'textos');
      onCambio(); onClose();
    } catch (e) { toast((e as Error).message, true); }
    setSubiendo(false);
  };
  const principal = res.logos.find((l) => l.principal) ?? null;
  return (
    <Modal title={`Logo de ${productoNombre}`} onClose={() => !subiendo && onClose()} footer={<>
      <span className="small muted grow">{res.empresa ? `Logos de ${res.empresa}` : ''}</span>
      <button className="btn" onClick={onClose} disabled={subiendo}>Cerrar</button>
    </>}>
      {!res.company_id ? <p className="muted" style={{ margin: 0 }}>Este {type === 'order' ? 'pedido' : 'negocio'} no tiene empresa: asociale una para guardar sus logos.</p> : <>
        <p className="small muted" style={{ margin: 0 }}>Elegí cuál va en este producto. Si no elegís ninguno, va el principal.</p>
        <SoltarBocetos className="logo-grilla soltar" onArchivos={(f) => puede && subir(f.slice(0, 1))} aviso="Soltá el logo acá">
          {res.logos.map((l) => {
            const sel = elegidoId ? elegidoId === l.id : !!l.principal;
            return (
              <div key={l.id} className={`logo-op${sel ? ' sel' : ''}`}>
                <button type="button" className="logo-op-btn" disabled={!puede} onClick={() => elegir(l.id)} aria-pressed={sel}>
                  <LogoMini logo={l} grande />
                  <span className="logo-op-nombre ellipsis">{nombreLogo(l)}{l.principal ? <Icon name="star" size={12} /> : null}</span>
                  <span className="row" style={{ gap: 4, justifyContent: 'center' }}><span className="small muted">{l.formato.toUpperCase()}</span><EstadoCurvas curvas={l.curvas} corto /></span>
                </button>
                <span className="logo-op-acciones">
                  <button type="button" className="btn ghost xs icon" onClick={() => setVer(l)} title="Ver grande" aria-label={`Ver ${nombreLogo(l)}`}><Icon name="eye" size={14} /></button>
                  <BajarLogo logo={l} className="btn ghost xs icon" />
                </span>
              </div>
            );
          })}
          {puede && res.configurado && (
            <BotonArchivos className="logo-op logo-op-nuevo" accept={ACEPTA_LOGOS} multiple={false} onArchivos={subir} disabled={subiendo}
              title="AI, EPS, CDR, SVG o PDF en curvas. Queda guardado en la empresa y elegido para este producto.">
              <Icon name="upload" size={18} />{subiendo ? 'Subiendo…' : 'Subir uno nuevo'}
              <span className="small muted">Queda guardado en la empresa</span>
            </BotonArchivos>
          )}
        </SoltarBocetos>
        {!res.configurado && <p className="small muted" style={{ margin: 0 }}>Para subir logos falta elegir la carpeta de Drive (Configuración → Integraciones).</p>}
        {elegidoId && principal && puede && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => elegir(null)}>Volver al principal ({nombreLogo(principal)})</button>}
      </>}
      {ver && <LogoVisor logo={ver} puedeEditar={puede} onClose={() => setVer(null)} onCambio={onCambio} />}
    </Modal>
  );
}
