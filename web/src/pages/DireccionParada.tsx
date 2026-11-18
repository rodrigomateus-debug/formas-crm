import { useEffect, useRef, useState } from 'react';
import { http, qs, useToast, Icon } from '../lib';
import { alEsc } from '../components';
import { BuscarDireccion, nuevaSesion } from './Direcciones';

// Lo que comparten la Ruta del día (CronogramaRuta.tsx) y las tarjetas de la semana (Cronograma.tsx): escribir lindo una
// dirección, corregirla (en el pedido o en la ficha de la empresa) y el link de la app del chofer. Va aparte para que la
// semana no cargue el mapa.

// Lo que hace falta de una parada para corregir su dirección.
export interface ParadaDir { nombre: string; direccion: string | null; horario_texto: string | null; company_id: number | null; detalle?: string | null; observaciones?: string | null }

// La dirección como viene de las fichas y los pedidos («domingo prat 2260, 1603 villa rosa, VILLA ROSA PILAR»): cada parte
// toda en minúscula o toda en mayúscula pasa a «Domingo Prat 2260»; las que ya vienen bien escritas quedan como están.
const SIGLAS = new Set(['caba', 'cp', 'pb', 'gba', 'pba', 'amba', 'sa', 'srl', 'ruta', 'km']);
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e']);
export function lindaDireccion(d: string) {
  const vistas = new Set<string>();
  return d.split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => {
    const k = x.toLowerCase();
    if (!x || vistas.has(k)) return false;
    vistas.add(k); return true;
  }).map((x) => (/[a-záéíóúñ]/.test(x) && /[A-ZÁÉÍÓÚÑ]/.test(x) ? x : x.toLowerCase().split(' ').map((w, i) =>
    SIGLAS.has(w) && w !== 'ruta' && w !== 'km' ? w.toUpperCase() : i > 0 && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' '))).join(', ');
}

// Corregir la dirección de la parada: la de entrega de sus pedidos, o la de la empresa (con su horario de recepción).
export function EditarDireccion({ p, pedidos, onListo }: { p: ParadaDir; pedidos: number[]; onListo: () => void }) {
  const toast = useToast();
  const [direccion, setDireccion] = useState(p.direccion ?? '');
  // La que se eligió de las sugerencias de Google Maps (como en Uber): queda validada, con el punto exacto en el mapa.
  const [placeId, setPlaceId] = useState<string | null>(null);
  const sesion = useRef(nuevaSesion()).current;
  const [maps, setMaps] = useState(true);
  useEffect(() => { http<{ maps: boolean }>('GET', `/maps/sugerencias${qs({ q: '' })}`).then((r) => setMaps(r.maps !== false), () => undefined); }, []);
  const [horario, setHorario] = useState(p.horario_texto ?? '');
  // Lo que completa la dirección (piso, depto, puerta, unidad) y lo que tiene que saber el chofer al llegar.
  const [detalle, setDetalle] = useState(p.detalle ?? '');
  const [observaciones, setObservaciones] = useState(p.observaciones ?? '');
  const [guardando, setGuardando] = useState(false);
  const esEntrega = pedidos.length > 0;
  // La libreta: al abrir, los lugares de ese cliente o proveedor; al escribir, lo que coincida.
  const [buscar, setBuscar] = useState('');
  const [lugares, setLugares] = useState<Array<{ id: number; nombre: string; direccion: string; horario: string | null }>>([]);
  useEffect(() => {
    let vivo = true;
    const t = window.setTimeout(() => { http<{ lugares: typeof lugares }>('GET', `/cronograma/lugares${qs({ q: buscar, de: p.nombre })}`).then((r) => { if (vivo) setLugares(r.lugares); }, () => undefined); }, buscar ? 250 : 0);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [buscar, p.nombre]);
  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setGuardando(true);
    const dir = { direccion, detalle, observaciones, ...(placeId ? { place_id: placeId, sesion } : {}) };
    try {
      if (esEntrega) { for (const id of pedidos) await http('PUT', '/cronograma/direccion', { record_id: id, ...dir }); }
      if (p.company_id && (!esEntrega || horario !== (p.horario_texto ?? ''))) await http('PUT', '/cronograma/direccion', { company_id: p.company_id, ...(esEntrega ? {} : dir), horario });
      toast(`${esEntrega ? 'Dirección de entrega guardada en el pedido' : 'Dirección guardada en la ficha de la empresa'}${placeId ? ', validada con Google Maps' : ''}.`);
      onListo();
    } catch (err) { toast((err as Error).message, true); setGuardando(false); }
  }
  return (
    <form className="cr-editar" onKeyDown={alEsc(onListo)} onSubmit={guardar}>
      <BuscarDireccion etiqueta={esEntrega ? 'Dirección de entrega de este pedido' : 'Dirección de la empresa'} valor={direccion} validada={!!placeId} sesion={sesion} maps={maps} sugerida={null}
        onTexto={(t) => { setDireccion(t); setPlaceId(null); }} onElegir={(s) => { setDireccion(s.texto); setPlaceId(s.place_id); }} />
      <details className="cr-libreta">
        <summary className="small">O elegila de la libreta de direcciones</summary>
        <label>Buscar en la libreta
          <input className="input sm" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Nombre del lugar, calle o localidad" /></label>
        {lugares.length > 0 && (
          <ul className="cr-lugares">
            {lugares.map((l) => (
              <li key={l.id}><button type="button" onClick={() => { setDireccion(l.direccion); setPlaceId(null); if (p.company_id && !horario && l.horario && /\d\s*(a|-|hasta)\s*\d/i.test(l.horario)) setHorario(l.horario); }}>
                <b>{l.nombre}</b><span>{l.direccion}{l.horario ? ` · ${l.horario}` : ''}</span></button></li>
            ))}
          </ul>
        )}
      </details>
      <div className="cr-editar-fila">
        <label>Piso, depto, puerta o unidad<input className="input sm" value={detalle} onChange={(e) => setDetalle(e.target.value)} placeholder="Piso 4 B, nave 3, puerta 2…" maxLength={200} /></label>
        {p.company_id && <label>Horario de recepción<input className="input sm" value={horario} onChange={(e) => setHorario(e.target.value)} placeholder="9 a 13" /></label>}
      </div>
      <label>Observaciones de entrega
        <textarea className="input sm" rows={2} value={observaciones} onChange={(e) => setObservaciones(e.target.value)} placeholder="Tocar timbre de recepción, entrar por el portón de atrás, preguntar por Ana…" maxLength={500} /></label>
      <div className="acciones"><button type="button" className="btn sm ghost" onClick={onListo}>Cancelar</button><button type="submit" className="btn sm primary" disabled={guardando || !direccion.trim()}>Guardar</button></div>
    </form>
  );
}

// El link de la app del chofer (pedido de Rodrigo del 18/11/2026), al lado del chofer elegido en la Ruta del día: para
// copiarlo o mandarlo por WhatsApp. Si el chofer ya tiene link, aparece el suyo; si no, se crea ahí mismo con su nombre
// (el mismo que en Choferes). Los expresos no tienen app.
type Acceso = { existe: boolean; id?: number; nombre?: string; link?: string; codigo?: string; app?: string; perdido?: boolean };
const lindoCodigo = (c: string) => `${c.slice(0, 4)} ${c.slice(4)}`;
export function LinkChofer({ chofer, cuando }: { chofer: string; cuando: string }) {
  const toast = useToast();
  const [a, setA] = useState<Acceso | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    let vivo = true;
    setA(null); setError('');
    http<Acceso>('GET', `/choferes/por-nombre${qs({ nombre: chofer })}`).then((r) => { if (vivo) setA(r); }, (e) => { if (vivo) setError((e as Error).message); });
    return () => { vivo = false; };
  }, [chofer]);
  async function crear() {
    setOcupado(true);
    try {
      const r = await http<Required<Omit<Acceso, 'perdido'>>>('POST', '/choferes', { name: chofer });
      setA({ ...r, existe: true, nombre: chofer });
      toast(`Se creó el link de ${chofer}.`);
    } catch (e) { toast((e as Error).message, true); }
    setOcupado(false);
  }
  const copiar = async (t: string, que: string) => { try { await navigator.clipboard.writeText(t); toast(`${que} copiado`); } catch { toast('No se pudo copiar: seleccionalo y copialo a mano.', true); } };
  if (error) return null;   // sin permiso para ver los links (solo Logística y administradores)
  if (!a) return <div className="cr-linkchofer muted small"><Icon name="volante" size={13} />Buscando el link de {chofer}…</div>;
  if (!a.existe || a.perdido) {
    return (
      <div className="cr-linkchofer falta">
        <Icon name="volante" size={13} />
        <span>{a.perdido ? `El link de ${chofer} no se guardó: dalo de baja en Choferes y creale otro.` : `${chofer} todavía no tiene link para ver su recorrido en el celular.`}</span>
        {!a.perdido && <button type="button" className="btn sm" disabled={ocupado} onClick={crear}><Icon name="plus" size={13} />Crear su link</button>}
      </div>
    );
  }
  const texto = `Hola ${chofer.split(' ')[0]}, ${cuando === 'hoy' ? 'tu recorrido de hoy ya está' : `el ${cuando} vas a tener tu recorrido`} en la app de Formas. Abrí este link: ${a.link}\nO entrá a ${a.app} y escribí tu código: ${lindoCodigo(a.codigo!)}`;
  return (
    <div className="cr-linkchofer">
      <Icon name="volante" size={13} />
      <span className="grow">Link de <b>{a.nombre}</b> · código <b className="num">{lindoCodigo(a.codigo!)}</b></span>
      <button type="button" className="btn sm" onClick={() => copiar(a.link!, 'Link')}><Icon name="copy" size={13} />Copiar link</button>
      <a className="btn sm wa-link" href={`https://wa.me/?text=${encodeURIComponent(texto)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={13} />Mandar por WhatsApp</a>
    </div>
  );
}
