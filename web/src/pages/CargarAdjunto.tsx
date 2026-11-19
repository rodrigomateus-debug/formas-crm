import { useEffect, useState } from 'react';
import { http, useAsync, useToast, Icon, cabecerasVerComo } from '../lib';
import { Modal } from '../components';
import { Select } from '../Select';
import { subir as subirBoceto } from './Bocetos';
import { subirLogo } from './Logos';

// Cargar en un producto un archivo de la conversación del pedido (pedido de Rodrigo del 19/11/2026): al equipo le resulta
// más fácil mandar el boceto o el logo por el chat del PDV que ir al producto y subirlo ahí. Desde el archivo ya mandado,
// «Cargar en un producto» lo sube como boceto (PDF o imagen) o como logo original (AI, EPS, CDR, SVG, PDF, PNG…) del producto
// elegido, igual que si se subiera desde el producto: el boceto queda para aprobar y el logo queda guardado en la empresa y
// elegido para ese producto. El archivo sigue en la conversación.

export interface AdjuntoRef { id: number; nombre: string; mime: string }
type Como = 'boceto' | 'logo';

const esBoceto = (a: AdjuntoRef) => a.mime === 'application/pdf' || a.mime.startsWith('image/') || /\.pdf$/i.test(a.nombre);
const esLogo = (a: AdjuntoRef) => /\.(ai|eps|cdr|svg|pdf|psd|png|jpe?g|webp|tiff?)$/i.test(a.nombre) || /^(application\/pdf|image\/)/.test(a.mime);
export const sePuedeCargar = (a: AdjuntoRef) => esBoceto(a) || esLogo(a);

// Avisa a la tarjeta de productos del pedido que se cargó algo (vuelve a pedir bocetos y logos).
export const EVENTO_ARCHIVOS = 'crm:archivos-producto';
export function useCambioArchivos(recordId: number, f: () => void) {
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent<number>).detail === recordId) f(); };
    window.addEventListener(EVENTO_ARCHIVOS, h);
    return () => window.removeEventListener(EVENTO_ARCHIVOS, h);
  });
}

interface Producto { key: string; nombre: string }

export function CargarAdjunto({ recordId, adjunto, onClose }: { recordId: number; adjunto: AdjuntoRef; onClose: () => void }) {
  const toast = useToast();
  const res = useAsync(() => http<{ items: Array<{ code: string | null; name: string; tipo?: string }> }>('GET', `/records/order/${recordId}/products`), [recordId]);
  // Los servicios (envío, setup…) no llevan boceto ni logo.
  const productos: Producto[] = (res.data?.items ?? []).filter((it) => it.tipo !== 'servicio').map((it) => ({ key: it.code || it.name, nombre: it.name }));
  const [como, setComo] = useState<Como>(esBoceto(adjunto) && !/\.(ai|eps|cdr|svg)$/i.test(adjunto.nombre) ? 'boceto' : 'logo');
  const [producto, setProducto] = useState('');
  const [tipo, setTipo] = useState<'tecnico' | 'referencia'>(adjunto.mime.startsWith('image/') ? 'referencia' : 'tecnico');
  const [cargando, setCargando] = useState(false);
  // Con un solo producto, ese.
  useEffect(() => { if (!producto && productos.length === 1) setProducto(productos[0].key); }, [productos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const cargar = async () => {
    const p = productos.find((x) => x.key === producto);
    if (!p) { toast('Elegí el producto.', true); return; }
    setCargando(true);
    try {
      const r = await fetch(`/api/mensaje-adjuntos/${adjunto.id}?descargar=1`, { credentials: 'same-origin', headers: cabecerasVerComo() });
      if (!r.ok) throw new Error('No se pudo leer el archivo de la conversación.');
      const file = new File([await r.blob()], adjunto.nombre, { type: adjunto.mime });
      if (como === 'boceto') await subirBoceto('order', recordId, { file, producto: p.key, productoNombre: p.nombre, tipo }, () => undefined);
      else await subirLogo('order', recordId, file, { producto: p.key });
      window.dispatchEvent(new CustomEvent(EVENTO_ARCHIVOS, { detail: recordId }));
      toast(como === 'boceto' ? `Boceto cargado en ${p.nombre}` : `Logo cargado en ${p.nombre} (y guardado en la empresa)`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setCargando(false); }
  };

  return (
    <Modal title="Cargar en un producto" onClose={() => !cargando && onClose()} footer={<>
      <button className="btn" disabled={cargando} onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={cargando || !producto} onClick={cargar}>{cargando ? 'Cargando…' : 'Cargar'}</button>
    </>}>
      <div className="ellipsis small" title={adjunto.nombre}><Icon name="clip" size={14} /> {adjunto.nombre}</div>
      <div className="field">Como
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className={`chip${como === 'boceto' ? ' on' : ''}`} aria-pressed={como === 'boceto'} disabled={!esBoceto(adjunto) || cargando}
            title={esBoceto(adjunto) ? 'Boceto de producción del producto' : 'Los bocetos son PDF o imágenes'} onClick={() => setComo('boceto')}>Boceto</button>
          <button type="button" className={`chip${como === 'logo' ? ' on' : ''}`} aria-pressed={como === 'logo'} disabled={!esLogo(adjunto) || cargando}
            title="El logo original del cliente: queda en la empresa y elegido para este producto" onClick={() => setComo('logo')}>Logo</button>
        </div>
      </div>
      <label className="field">Producto
        {res.loading && !res.data ? <span className="muted small">Cargando los productos…</span>
          : productos.length ? <Select className="input" value={producto} onChange={(e) => setProducto(e.target.value)} aria-label="Producto" disabled={cargando}>
              <option value="">Elegí el producto…</option>
              {productos.map((x) => <option key={x.key} value={x.key}>{x.nombre}</option>)}
            </Select>
          : <span className="muted small">El pedido todavía no tiene productos.</span>}
      </label>
      {como === 'boceto' && <label className="field">Tipo
        <Select className="input" value={tipo} onChange={(e) => setTipo(e.target.value as 'tecnico' | 'referencia')} aria-label="Tipo de boceto" disabled={cargando}>
          <option value="tecnico">Técnico (final, con medidas)</option>
          <option value="referencia">Referencia (foto o boceto rápido)</option>
        </Select></label>}
      <p className="small muted" style={{ margin: 0 }}>{como === 'boceto' ? 'Queda como boceto para aprobar en el producto, igual que si lo subieras ahí.' : 'Se guarda en los logos de la empresa (se revisa si está en curvas) y queda elegido para este producto.'} El archivo sigue en la conversación.</p>
    </Modal>
  );
}
