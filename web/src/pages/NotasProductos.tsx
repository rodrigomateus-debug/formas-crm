import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, qs, useDebounced, Icon, fmtRelative, Cargando } from '../lib';
import { Select } from '../Select';
import { FichaProducto, GRAVEDAD, useCambioNotas, type Gravedad } from '../notasProducto';

// Notas de productos (pedido de Rodrigo del 16/11/2026; notasproducto.ts): todos los SKU con notas de Producción, los
// que tienen algo «no recomendado» primero. Para consultar antes de cotizar («¿este producto tiene problemas?») y para
// cargar una nota de un SKU que no está en producción ahora («Abrir un SKU»). Un clic abre la ficha del SKU.

interface Fila {
  sku: string; modelo: string | null; raiz?: string | null; nombre: string | null; vigentes: number; total: number; gravedad: Gravedad | null; tipos: string[];
  ultima: string; texto: string | null; foto: string | null;
}

export default function NotasProductosPage() {
  const [sp, setSp] = useSearchParams();
  const [buscar, setBuscar] = useState('');
  const q = useDebounced(buscar, 200);
  const [tipo, setTipo] = useState('');
  const [gravedad, setGravedad] = useState('');
  const [archivadas, setArchivadas] = useState(false);
  const [datos, setDatos] = useState<{ productos: Fila[]; tipos: Record<string, string> } | null>(null);
  const [error, setError] = useState('');
  const [sku, setSku] = useState('');
  const abierto = sp.get('sku');
  const abrir = (s: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (s) n.set('sku', s); else n.delete('sku'); return n; }, { replace: true });
  const cargar = () => http<{ productos: Fila[]; tipos: Record<string, string> }>('GET', `/productos/notas${qs({ q: q || undefined, tipo: tipo || undefined, gravedad: gravedad || undefined, archivadas: archivadas ? 1 : undefined })}`)
    .then((d) => { setDatos(d); setError(''); }, (e) => setError((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [q, tipo, gravedad, archivadas]);
  useCambioNotas(cargar);
  const filas = datos?.productos ?? [];
  return (
    <div className="content">
      <div className="page-head">
        <h1>Notas de productos {datos && <span className="muted small num">{filas.length.toLocaleString('es-AR')}</span>}</h1>
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (sku.trim()) { abrir(sku.trim().toUpperCase()); setSku(''); } }}>
          <input className="input" style={{ width: 200 }} placeholder="SKU (ej. ZEC-12345)" value={sku} onChange={(e) => setSku(e.target.value)} aria-label="SKU para abrir" />
          <button type="submit" className="btn" disabled={!sku.trim()}>Abrir un SKU</button>
        </form>
      </div>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16, maxWidth: 760 }}>
        Lo que Producción aprendió de cada producto de importador. Cada nota queda atada al SKU y aparece sola cada vez que se vuelve a vender: en Producción, en los productos del pedido y con un aviso a la vendedora.
      </p>
      <div className="toolbar">
        <input className="input search" placeholder="Buscar por SKU, producto o lo que dice la nota" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
        <Select className="input bar-select" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {Object.entries(datos?.tipos ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select className="input bar-select" value={gravedad} onChange={(e) => setGravedad(e.target.value)} aria-label="Gravedad">
          <option value="">Cualquier gravedad</option>
          {(['no', 'ojo', 'info'] as const).map((g) => <option key={g} value={g}>{GRAVEDAD[g].label}</option>)}
        </Select>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={archivadas} onChange={(e) => setArchivadas(e.target.checked)} />Incluir las que ya no aplican</label>
      </div>
      {error && <div className="tag bad">{error}</div>}
      {!datos && !error && <Cargando />}
      {datos && !filas.length && (
        <div className="panel"><div className="panel-body muted">
          {q || tipo || gravedad ? 'No hay notas con esos filtros.' : 'Todavía no hay notas. Se cargan desde Producción (botón «+ Nota» al pasar el mouse por un artículo) o con «Abrir un SKU».'}
        </div></div>
      )}
      {filas.length > 0 && (
        <div className="panel nota-lista">
          {filas.map((f) => (
            <button key={f.sku} type="button" className="nota-lista-fila" onClick={() => abrir(f.sku)}>
              {f.foto ? <span className="product-img"><img src={f.foto} alt="" loading="lazy" /></span> : <span className="product-img none" aria-hidden><Icon name="order" size={18} /></span>}
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
                  <b className="ellipsis">{f.nombre ?? f.sku}</b>
                  {f.gravedad ? <span className={`tag ${GRAVEDAD[f.gravedad].cls}`}>{GRAVEDAD[f.gravedad].label}</span> : <span className="tag">Ya no aplica</span>}
                </span>
                <span className="small muted ellipsis" style={{ display: 'block' }}>
                  <span className="num">{f.sku}</span>{f.modelo ? ' y sus colores' : ''}{f.raiz ? ' y sus talles' : ''} · {f.tipos.map((t) => datos!.tipos[t] ?? t).join(', ')}
                </span>
                {f.texto && <span className="small ellipsis" style={{ display: 'block' }}>{f.texto}</span>}
              </span>
              <span className="small muted" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                {f.vigentes === 1 ? '1 nota' : `${f.vigentes} notas`}{f.total > f.vigentes ? ` (+${f.total - f.vigentes})` : ''}<br />{fmtRelative(f.ultima)}
              </span>
            </button>
          ))}
        </div>
      )}
      {abierto && <FichaProducto sku={abierto} onClose={() => abrir(null)} />}
    </div>
  );
}
