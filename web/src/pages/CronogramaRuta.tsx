import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { http, qs, useToast, Icon } from '../lib';
import { claveOrden, duracion, hhmm, optimizar, simular, type Simulacion, type TramosReales } from '../ruta';
import { lindo, carrilDe, cantidad, diaCorto, diaLargo, sumar, type Mov, type Tipo } from './Cronograma';

// Ruta del día (Cronograma): las paradas del día en el mapa, una por lugar (tres retiros en el mismo impresor son una
// parada), con la hora aproximada de llegada a cada una. Se reordenan arrastrando, con las flechas o con «Ordenar por el
// recorrido más corto»; se reparten en varios recorridos (uno por chofer) y cada uno sale de un depósito. Los tiempos
// son los de un día de tránsito moderado según la hora (ruta.ts); todavía no usan el tránsito del momento.

interface Parada {
  clave: string; nombre: string; direccion: string | null; origen: 'pedido' | 'finnegans' | 'ultima_entrega' | 'empresa' | 'libreta' | null;
  lat: number | null; lng: number | null; punto_manual: boolean; horario: [number, number] | null; horario_texto: string | null;
  company_id: number | null; record_id: number | null; movimientos: Mov[];
  lugar?: { nombre: string; horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null; coordinacion: string | null } | null;
  sugerencia: { record_id: number; sugerida: string; motivo: string } | null;
  visita?: { resultado: 'hecho' | 'no_se_pudo' | 'salteada'; motivo: string | null; nota: string | null; chofer: string | null; at: string } | null;
}
const MOTIVO: Record<string, string> = { nadie: 'No había nadie', cerrado: 'Estaba cerrado', direccion: 'No encontró la dirección', rechazo: 'No lo quisieron recibir', no_listo: 'No estaba listo', otro: 'No se pudo' };
const horaDe = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
interface Recorrido { n: number; chofer: string | null; base: string; salida: number; orden: string[] }
interface BaseGeo { id: string; nombre: string; direccion: string; lat: number | null; lng: number | null }
// `retiran`: las entregas que retira el cliente en Formas (tarjeta «Entrega» del pedido); `parcial`: el resto del pedido se envía.
interface Datos { fecha: string; paradas: Parada[]; llegan: Mov[]; retiran?: Array<Mov & { retira_en: string; parcial: boolean }>; rutas: Recorrido[]; guardada: boolean;
  choferes: string[]; bases: BaseGeo[]; buscando: number; puede_editar: boolean }
interface Real extends TramosReales { linea: Array<[number, number]> }

// Con el número en blanco encima: todos pasan 4,5:1.
const COLORES = ['#3b5bdb', '#c2410c', '#0b7285', '#862e9c', '#2b7a39', '#a61e4d', '#5f3dc4', '#364fc7'];
// Los nombres vienen de ClickUp y de las fichas: al mapa van como texto, nunca como HTML.
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TANDA = 25;   // el servidor acepta de a 25 artículos por vez
const ORIGEN: Record<string, string> = { pedido: 'Dirección cargada en el pedido', finnegans: 'Del pedido en Finnegans', ultima_entrega: 'De la última entrega a este cliente', empresa: 'De la ficha de la empresa', libreta: 'De la libreta de direcciones' };
const ROUTER = 'https://router.project-osrm.org/route/v1/driving/';
const punto = (p: { lat: number | null; lng: number | null } | undefined | null) => (p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);

// Las paradas que no están en ningún recorrido van al primero; las que ya no existen se sacan.
function acomodar(rutas: Recorrido[], paradas: Parada[]): Recorrido[] {
  const claves = new Set(paradas.map((p) => p.clave)), vistas = new Set<string>();
  const out = rutas.map((r) => ({ ...r, orden: r.orden.filter((c) => claves.has(c) && !vistas.has(c) && (vistas.add(c), true)) }));
  out[0] = { ...out[0], orden: [...out[0].orden, ...paradas.map((p) => p.clave).filter((c) => !vistas.has(c))] };
  return out;
}

export default function CronogramaRuta({ fecha, semana, hoy, resumen, onFecha, onAbrir, onCambio }: {
  fecha: string; semana: string; hoy: string; resumen: Record<string, { total: number; pendientes: number }>; onFecha: (d: string) => void; onAbrir: (id: number) => void; onCambio: () => void;
}) {
  const toast = useToast();
  const [datos, setDatos] = useState<Datos | null>(null);
  const [rutas, setRutas] = useState<Recorrido[]>([]);
  const [activa, setActiva] = useState(0);
  const [error, setError] = useState('');
  const [reales, setReales] = useState<Record<string, Real>>({});
  const [caliente, setCaliente] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  // La parada a la que se le está corrigiendo la ubicación en el mapa (solo ese número se puede arrastrar) y dónde se soltó.
  const [ubicando, setUbicando] = useState<{ clave: string; lat?: number; lng?: number } | null>(null);
  const arrastre = useRef<string | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  const pedido = useRef(0);
  const sucio = useRef(false);
  const tocado = useRef(false);                                       // alguien cambió el orden a mano: no se reordena solo
  const porGuardar = useRef<{ fecha: string; rutas: Recorrido[] } | null>(null);
  const sondeo = useRef<number>();

  const cargar = useCallback(async (intento = 0) => {
    const n = ++pedido.current;
    try {
      const d = await http<Datos>('GET', `/cronograma/ruta${qs({ fecha })}`);
      if (n !== pedido.current) return;
      setError('');
      setDatos(d);
      setRutas((antes) => {
        const base = antes.length && d.fecha === (antes as Recorrido[] & { fecha?: string }).fecha ? antes : d.rutas;
        let r = acomodar(base, d.paradas);
        // Mientras nadie guardó ni tocó el orden, arranca con el recorrido más corto (y se vuelve a ordenar a medida que
        // se van ubicando las direcciones).
        if (!d.guardada && !tocado.current) { const b = punto(d.bases.find((x) => x.id === r[0].base)); r = [{ ...r[0], orden: optimizar(b, d.paradas, r[0].salida).map((p) => p.clave) }, ...r.slice(1)]; }
        return Object.assign(r, { fecha: d.fecha });
      });
      // Faltan ubicar direcciones (se buscan de a pocas): vuelve a pedir hasta que estén.
      window.clearTimeout(sondeo.current);
      if (d.buscando > 0 && intento < 12) sondeo.current = window.setTimeout(() => { if (n === pedido.current) void cargar(intento + 1); }, 1500);
    } catch (e) { if (n === pedido.current) setError((e as Error).message); }
  }, [fecha]);
  useEffect(() => {
    setDatos(null); setRutas([]); setActiva(0); setEditando(null); tocado.current = false;
    void cargar();
    // Al cambiar de día o salir: se corta el sondeo y, si quedó un cambio sin guardar, se guarda ya.
    return () => {
      pedido.current++;
      window.clearTimeout(sondeo.current);
      const p = porGuardar.current;
      if (sucio.current && p) { sucio.current = false; porGuardar.current = null; void http('PUT', '/cronograma/ruta', p).catch(() => undefined); }
    };
  }, [cargar]);

  const puede = !!datos?.puede_editar;
  const porClave = useMemo(() => new Map((datos?.paradas ?? []).map((p) => [p.clave, p])), [datos]);
  const cambiar = (f: (r: Recorrido[]) => Recorrido[]) => { sucio.current = true; tocado.current = true; setRutas((r) => { const n = Object.assign(f(r), { fecha }); porGuardar.current = { fecha, rutas: n }; return n; }); };
  // Guarda el orden y los recorridos un rato después del último cambio.
  useEffect(() => {
    if (!sucio.current || !puede || !rutas.length || (rutas as Recorrido[] & { fecha?: string }).fecha !== fecha) return;
    const t = window.setTimeout(() => { sucio.current = false; porGuardar.current = null; http('PUT', '/cronograma/ruta', { fecha, rutas }).catch((e) => toast((e as Error).message, true)); }, 700);
    return () => window.clearTimeout(t);
  }, [rutas, puede, fecha, toast]);

  const armadas = useMemo(() => rutas.map((r, i) => {
    const base = datos?.bases.find((b) => b.id === r.base) ?? datos?.bases[0] ?? null;
    const paradas = r.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p);
    const clave = claveOrden(punto(base), paradas);
    const real = reales[clave];
    return { r, i, base, paradas, clave, real, sim: simular(punto(base), paradas, r.salida, real), color: COLORES[i % COLORES.length] };
  }), [rutas, datos, porClave, reales]);

  // El recorrido por calles (distancia y tiempo de cada tramo, y el dibujo). Si el servicio no contesta, queda la
  // estimación en línea recta.
  useEffect(() => {
    const faltan = armadas.filter((a) => a.paradas.length && !a.clave.includes('?') && !reales[a.clave]);
    if (!faltan.length) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      for (const a of faltan) {
        const pts = [a.base!, ...a.paradas, a.base!].map((p) => `${p.lng},${p.lat}`).join(';');
        try {
          const res = await fetch(`${ROUTER}${pts}?overview=full&geometries=geojson`, { signal: ctl.signal });
          if (!res.ok) continue;
          const j = (await res.json()) as { routes?: Array<{ legs: Array<{ distance: number; duration: number }>; geometry: { coordinates: Array<[number, number]> } }> };
          const ruta = j.routes?.[0];
          if (!ruta || ruta.legs.length !== a.paradas.length + 1) continue;
          setReales((r) => ({ ...r, [a.clave]: { clave: a.clave, tramos: ruta.legs.map((l) => ({ km: l.distance / 1000, min: l.duration / 60 })), linea: ruta.geometry.coordinates.map(([x, y]) => [y, x]) } }));
        } catch { /* sin servicio de rutas: sigue la estimación */ }
      }
    }, 500);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [armadas, reales]);

  const act = armadas[Math.min(activa, armadas.length - 1)];
  const mover = (clave: string, a: number) => cambiar((rs) => rs.map((r, i) => {
    if (i !== act.i) return r;
    const o = [...r.orden], de = o.indexOf(clave);
    if (de < 0 || a < 0 || a >= o.length) return r;
    o.splice(a, 0, o.splice(de, 1)[0]);
    return { ...r, orden: o };
  }));
  const pasar = (clave: string, a: number) => cambiar((rs) => rs.map((r, i) => ({ ...r, orden: i === a ? [...r.orden.filter((c) => c !== clave), clave] : r.orden.filter((c) => c !== clave) })));
  const ordenar = () => {
    // Los dos órdenes se comparan con la misma cuenta (línea recta), y el de ahora solo se cambia si el nuevo es mejor.
    const b = punto(act.base);
    const antes = simular(b, act.paradas, act.r.salida).costo;
    const nuevo = optimizar(b, act.paradas, act.r.salida);
    const despues = simular(b, nuevo, act.r.salida).costo;
    if (antes - despues <= 1) { toast('Ya era el recorrido más corto.'); return; }
    cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, orden: nuevo.map((p) => p.clave) } : r)));
    toast(`Recorrido reordenado: unos ${duracion(antes - despues)} menos.`);
  };
  async function marcar(p: Parada) {
    const hecho = !p.movimientos.every((m) => m.hecho);
    const porTipo = new Map<Tipo, string[]>();
    for (const m of p.movimientos) if (m.hecho !== hecho) porTipo.set(m.tipo, [...(porTipo.get(m.tipo) ?? []), m.task_id]);
    setDatos((d) => d && { ...d, paradas: d.paradas.map((x) => (x.clave === p.clave ? { ...x, movimientos: x.movimientos.map((m) => ({ ...m, hecho })) } : x)) });
    try {
      let cambiados = 0;
      for (const [tipo, ids] of porTipo) for (let i = 0; i < ids.length; i += TANDA) cambiados += (await http<{ cambiados: number }>('POST', '/cronograma/hecho', { ids: ids.slice(i, i + TANDA), tipo, hecho })).cambiados;
      toast(!hecho ? `${p.nombre}: quedó como pendiente.` : `${p.nombre}: hecho.${cambiados ? ` ${cambiados} artículo${cambiados === 1 ? ' cambió' : 's cambiaron'} de estado en ClickUp.` : ''}`);
    } catch (e) { toast((e as Error).message, true); }
    void cargar(); onCambio();
  }
  // Corregir dónde queda una parada en el mapa: se guarda recién con «Guardar ubicación», y vale para esa dirección en
  // todas las rutas. «Volver a buscar» saca la corrección y la ubica de nuevo por su dirección.
  async function fijar(p: Parada) {
    if (!p.direccion || ubicando?.lat == null || ubicando.lng == null) return;
    try { await http('PUT', '/cronograma/punto', { direccion: p.direccion, lat: ubicando.lat, lng: ubicando.lng }); toast(`${p.nombre}: ubicación guardada.`); } catch (e) { toast((e as Error).message, true); }
    setUbicando(null);
    void cargar();
  }
  async function rebuscar(p: Parada) {
    try { await http('DELETE', `/cronograma/punto${qs({ direccion: p.direccion })}`); toast(`${p.nombre}: se vuelve a buscar en el mapa por su dirección.`); } catch (e) { toast((e as Error).message, true); }
    setUbicando(null);
    void cargar();
  }
  async function sugerencia(p: Parada, aceptar: boolean) {
    try { await http('POST', '/cronograma/sugerencia', { record_id: p.sugerencia!.record_id, aceptar }); toast(aceptar ? 'Dirección de entrega actualizada en el pedido.' : 'Queda la dirección del pedido.'); } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }

  const dias = [0, 1, 2, 3, 4].map((i) => sumar(semana, i));
  if (fecha > dias[4]) dias.push(fecha);
  const cab = (
    <div className="cr-ruta-dias" role="group" aria-label="Día">
      {dias.map((d) => <button key={d} type="button" className={`cr-pill${d === fecha ? ' on' : ''}`} aria-pressed={d === fecha} onClick={() => onFecha(d)}>
        {diaCorto(d)}{d === hoy ? ' · hoy' : ''}{resumen[d]?.pendientes ? <span className="num">{resumen[d].pendientes}</span> : null}</button>)}
    </div>
  );
  if (error) return <>{cab}<div className="aviso warn small">{error}</div></>;
  if (!datos || !act) return <>{cab}<div className="empty plain">Armando la ruta del {diaLargo(fecha).toLowerCase()}…</div></>;

  const movs = act.paradas.flatMap((p) => p.movimientos), hechos = movs.filter((m) => m.hecho).length, tarde = act.sim.paradas.filter((s) => s.tarde > 0).length;
  const sinBase = !punto(act.base);
  return (
    <div className="cr-ruta">
      {cab}
      <div className="cr-recorridos">
        {armadas.map((a) => (
          <button key={a.i} type="button" className={`cr-rec${a.i === act.i ? ' on' : ''}`} aria-pressed={a.i === act.i} onClick={() => setActiva(a.i)} style={{ '--c': a.color } as React.CSSProperties}>
            <i />Recorrido {a.i + 1}<span className="muted">{a.r.chofer ?? 'Sin chofer'} · {a.paradas.length} parada{a.paradas.length === 1 ? '' : 's'}</span>
          </button>
        ))}
        {puede && rutas.length < 8 && <button type="button" className="cr-agregar" onClick={() => { cambiar((rs) => [...rs, { n: rs.length + 1, chofer: null, base: rs[0].base, salida: rs[0].salida, orden: [] }]); setActiva(rutas.length); }}><Icon name="plus" size={12} />Otro recorrido</button>}
      </div>

      <div className="toolbar cr-ruta-barra">
        <label className="cr-campo">Chofer
          <select className="input sm" value={act.r.chofer ?? ''} disabled={!puede} onChange={(e) => cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, chofer: e.target.value || null } : r)))}>
            <option value="">Sin asignar</option>
            {[...new Set([...datos.choferes, ...(act.r.chofer ? [act.r.chofer] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="cr-campo">Sale de
          <select className="input sm" value={act.r.base} disabled={!puede} onChange={(e) => cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, base: e.target.value } : r)))}>
            {datos.bases.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </select>
        </label>
        <label className="cr-campo">A las
          <input type="time" className="input sm" value={`${String(Math.floor(act.r.salida / 60)).padStart(2, '0')}:${String(act.r.salida % 60).padStart(2, '0')}`} disabled={!puede}
            onChange={(e) => { if (!e.target.value) return; const [h, m] = e.target.value.split(':').map(Number); if (Number.isFinite(h)) cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, salida: h * 60 + (m || 0) } : r))); }} />
        </label>
        {puede && <button type="button" className="btn sm primary" disabled={act.paradas.length < 2} onClick={ordenar}><Icon name="route" size={14} />Ordenar por el recorrido más corto</button>}
        <span className="grow" />
        {puede && rutas.length > 1 && <button type="button" className="btn sm ghost danger" onClick={() => { cambiar((rs) => { const fuera = rs[act.i].orden, q = rs.filter((_, i) => i !== act.i); q[0] = { ...q[0], orden: [...q[0].orden, ...fuera] }; return q; }); setActiva(0); }}>Quitar este recorrido</button>}
      </div>

      <div className="cr-kpis">
        <div><span>Paradas</span><b className="num">{act.paradas.length}<small>{movs.length} movimientos</small></b></div>
        <div><span>Recorrido</span><b className="num">{act.sim.km.toFixed(0)}<small>km{act.real ? '' : ' aprox.'}</small></b></div>
        <div><span>En la calle</span><b className="num">{duracion(act.sim.fin - act.r.salida)}</b></div>
        <div><span>Vuelve</span><b className="num">{hhmm(act.sim.fin)}</b></div>
        <div><span>Hecho</span><b className="num">{hechos}<small>de {movs.length}</small></b></div>
        <div><span>Fuera de horario</span><b className={`num ${tarde ? 'danger-text' : ''}`}>{tarde || '—'}</b></div>
        {act.sim.sinUbicar > 0 && <div><span>Sin ubicar</span><b className="num warn-text">{act.sim.sinUbicar}</b></div>}
      </div>
      {datos.buscando > 0 && <div className="aviso info small">Buscando en el mapa {datos.buscando} dirección{datos.buscando === 1 ? '' : 'es'}…</div>}
      {sinBase && !datos.buscando && <div className="aviso warn small">No se pudo ubicar {act.base?.nombre ?? 'el depósito'} ({act.base?.direccion}). Corregí la dirección en la configuración del cronograma.</div>}

      <div className="cr-ruta-cuerpo">
        <ol className="cr-paradas">
          <li className="cr-parada base"><div className="cr-n base"><Icon name="home" size={13} /></div><div><div className="cr-p-nombre">{act.base?.nombre}</div><div className="cr-p-sub">{act.base?.direccion}</div></div><div className="cr-eta"><b className="num">{hhmm(act.r.salida)}</b><span>sale</span></div></li>
          {!act.paradas.length && <li className="empty plain">{datos.paradas.length ? 'Este recorrido no tiene paradas. Pasale alguna desde otro recorrido.' : 'Este día no hay retiros, egresos ni entregas.'}</li>}
          {act.paradas.map((p, i) => {
            const s = act.sim.paradas[i], todo = p.movimientos.every((m) => m.hecho);
            const entregas = [...new Set(p.movimientos.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
            return [
              <Tramo key={`t${p.clave}`} t={s.tramo} />,
              <li key={p.clave} className={`cr-parada${todo ? ' hecha' : ''}${caliente === p.clave ? ' caliente' : ''}${sobre === p.clave ? ' sobre' : ''}`} draggable={puede && editando !== p.clave && ubicando?.clave !== p.clave}
                style={{ '--c': act.color } as React.CSSProperties}
                onMouseEnter={() => setCaliente(p.clave)} onMouseLeave={() => setCaliente((c) => (c === p.clave ? null : c))}
                onDragStart={(e) => { arrastre.current = p.clave; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.clave); } catch { /* no hace falta */ } }}
                onDragEnd={() => { arrastre.current = null; setSobre(null); }}
                onDragOver={(e) => { if (arrastre.current && arrastre.current !== p.clave) { e.preventDefault(); if (sobre !== p.clave) setSobre(p.clave); } }}
                onDrop={(e) => { e.preventDefault(); const de = arrastre.current; arrastre.current = null; setSobre(null); if (de) mover(de, i); }}>
                <div className="cr-n num">{todo ? <Icon name="check" size={13} /> : i + 1}</div>
                <div className="cr-p-quien">
                  <div className="cr-p-nombre">{lindo(p.nombre)}</div>
                  <div className="cr-p-sub" title={p.origen ? ORIGEN[p.origen] : undefined}>{p.direccion ?? 'Sin dirección cargada'}</div>
                </div>
                <div className={`cr-eta${s.tarde ? ' tarde' : ''}`}><b className="num">{s.tramo.sinUbicar ? '—' : hhmm(s.llega)}</b><span>{duracion(s.servicio)} ahí</span></div>
                {p.lugar && (p.lugar.contacto || p.lugar.telefono || p.lugar.observaciones || p.lugar.coordinacion || (p.lugar.horario && !p.horario)) && (
                  <div className="cr-libreta" title={`De la libreta de direcciones: ${p.lugar.nombre}`}>
                    {p.lugar.horario && !p.horario && <span><b>Horario</b>{p.lugar.horario}</span>}
                    {(p.lugar.contacto || p.lugar.telefono) && <span><b>Contacto</b>{[p.lugar.contacto, p.lugar.telefono].filter(Boolean).join(' · ')}</span>}
                    {p.lugar.observaciones && <span><b>Ojo</b>{p.lugar.observaciones}</span>}
                    {p.lugar.coordinacion && <details><summary>Cómo se coordina la entrega</summary>{p.lugar.coordinacion}</details>}
                  </div>
                )}
                <div className="cr-p-movs">
                  {p.movimientos.map((m) => (
                    <div key={m.id} className={`cr-k-${carrilDe(m.tipo).k}${m.hecho ? ' ok' : ''}`}>
                      <i /><span><b>{carrilDe(m.tipo).uno}</b>{m.record_id ? <button type="button" className="cr-link" onClick={() => onAbrir(m.record_id!)}>PDV {m.npdv}</button> : `PDV ${m.npdv ?? '—'}`}
                        {m.tipo !== 'entrega' && m.cliente ? ` ${lindo(m.cliente)}` : ''}{m.articulo ? ` · ${cantidad(m)}` : ''}{m.evento ? ' · evento' : ''}</span>
                    </div>
                  ))}
                </div>
                {p.sugerencia && (
                  <div className="cr-sugerencia">
                    <Icon name="alert" size={14} />
                    <div><b>Puede que vaya a otra dirección.</b> {p.sugerencia.motivo} El pedido dice «{p.direccion}».
                      {puede && <div className="row" style={{ marginTop: 6 }}><button type="button" className="btn sm primary" onClick={() => sugerencia(p, true)}>Usar {p.sugerencia.sugerida}</button><button type="button" className="btn sm ghost" onClick={() => sugerencia(p, false)}>Dejar la del pedido</button></div>}
                    </div>
                  </div>
                )}
                {p.visita && p.visita.resultado !== 'hecho' && (
                  <div className={`cr-visita ${p.visita.resultado}`}><Icon name="alert" size={14} />
                    <span><b>{p.visita.resultado === 'salteada' ? 'El chofer la dejó para después' : MOTIVO[p.visita.motivo ?? 'otro'] ?? 'No se pudo'}</b>{p.visita.nota ? `: ${p.visita.nota}` : ''} · {p.visita.chofer ?? 'Chofer'}, {horaDe(p.visita.at)}</span></div>
                )}
                <div className="cr-p-pie">
                  {(p.horario || s.espera > 1) && <span className={`cr-tag${s.tarde ? ' late' : ''}`}>{p.horario ? `Recibe de ${hhmm(p.horario[0])} a ${hhmm(p.horario[1])}` : ''}{s.tarde ? ` · llega ${duracion(s.tarde)} tarde` : s.espera > 1 ? ` · espera ${duracion(s.espera)}` : ''}</span>}
                  {p.lat == null && <span className="cr-tag riesgo"><Icon name="alert" size={11} />{p.direccion ? 'No se encontró en el mapa' : 'Falta la dirección'}</span>}
                  {p.visita?.resultado === 'hecho' && <span className="cr-tag">Lo marcó {p.visita.chofer ?? 'el chofer'} a las {horaDe(p.visita.at)}</span>}
                  {puede && <button type="button" className="cr-link" onClick={() => marcar(p)}>{todo ? 'Volver a pendiente' : 'Marcar hecho'}</button>}
                  {puede && (p.company_id || entregas.length > 0) && <button type="button" className="cr-link" onClick={() => setEditando(editando === p.clave ? null : p.clave)}>{p.direccion ? 'Corregir dirección' : 'Cargar dirección'}</button>}
                  {puede && p.direccion && p.lat != null && ubicando?.clave !== p.clave && <button type="button" className="cr-link" onClick={() => { setUbicando({ clave: p.clave }); setCaliente(p.clave); }}>Corregir ubicación</button>}
                  {p.lat != null && <a className="cr-link" href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">Cómo llegar</a>}
                  <span className="grow" />
                  {puede && rutas.length > 1 && (
                    <select className="cr-pasar" aria-label="Pasar a otro recorrido" value="" onChange={(e) => { if (e.target.value !== '') pasar(p.clave, Number(e.target.value)); }}>
                      <option value="">Pasar a…</option>
                      {armadas.filter((a) => a.i !== act.i).map((a) => <option key={a.i} value={a.i}>Recorrido {a.i + 1}{a.r.chofer ? ` (${a.r.chofer})` : ''}</option>)}
                    </select>
                  )}
                  {puede && <span className="cr-flechas"><button type="button" aria-label="Subir" disabled={i === 0} onClick={() => mover(p.clave, i - 1)}>↑</button><button type="button" aria-label="Bajar" disabled={i === act.paradas.length - 1} onClick={() => mover(p.clave, i + 1)}>↓</button></span>}
                </div>
                {ubicando?.clave === p.clave && (
                  <div className="cr-ubicar">
                    <span>Arrastrá el número <b>{i + 1}</b> en el mapa hasta donde queda de verdad. Vale para esta dirección en todas las rutas.{p.punto_manual ? ' Ya tiene una ubicación corregida a mano.' : ''}</span>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <button type="button" className="btn sm primary" disabled={ubicando.lat == null} onClick={() => fijar(p)}>Guardar ubicación</button>
                      <button type="button" className="btn sm ghost" onClick={() => setUbicando(null)}>Cancelar</button>
                      {p.punto_manual && <button type="button" className="btn sm ghost" onClick={() => rebuscar(p)}>Volver a buscar en el mapa</button>}
                    </div>
                  </div>
                )}
                {editando === p.clave && <EditarDireccion p={p} pedidos={entregas} onListo={() => { setEditando(null); void cargar(); }} />}
              </li>,
            ];
          })}
          {act.paradas.length > 0 && <Tramo t={act.sim.vuelta} />}
          {act.paradas.length > 0 && <li className="cr-parada base"><div className="cr-n base"><Icon name="home" size={13} /></div><div><div className="cr-p-nombre">Vuelta a {act.base?.nombre}</div></div><div className="cr-eta"><b className="num">{hhmm(act.sim.fin)}</b><span>llega</span></div></li>}
        </ol>

        <div className="cr-ruta-lado">
          <div className="cr-mapa-caja">
            <Mapa armadas={armadas} activa={act.i} bases={datos.bases} caliente={caliente} puede={puede} onPin={(c, i) => { setActiva(i); setCaliente(c); }} ubicando={ubicando} onUbicar={(lat, lng) => setUbicando((u) => (u ? { ...u, lat, lng } : u))} />
            <div className="cr-mapa-pie small">
              <span>{act.real ? 'Recorrido por calles.' : 'Recorrido en línea recta (estimado).'} Tiempos con tránsito moderado según la hora, sin el tránsito del momento.</span>
              {puede && <span>Si un punto quedó mal, usá «Corregir ubicación» en su parada.</span>}
              <Libreta puede={puede} onCambio={() => void cargar()} />
            </div>
          </div>
          <section className="cr-llegan cr-k-I">
            <h3>Llega al depósito <span className="muted">(no es parte del recorrido)</span></h3>
            {datos.llegan.length ? datos.llegan.map((m) => <div key={m.id} className={m.hecho ? 'ok' : ''}><i /><span><b>{m.lugar ?? 'Proveedor'}</b>PDV {m.npdv ?? '—'} {m.cliente ?? ''}{m.articulo ? ` · ${cantidad(m)}` : ''}</span></div>)
              : <div className="muted small">Nada para recibir este día.</div>}
          </section>
          {(datos.retiran?.length ?? 0) > 0 && (
            <section className="cr-llegan cr-k-E">
              <h3>Retiran en Formas <span className="muted">(lo retira el cliente: no es parte del recorrido)</span></h3>
              {datos.retiran!.map((m) => (
                <div key={m.id} className={m.hecho ? 'ok' : ''}><i /><span><b>{m.cliente ?? `PDV ${m.npdv ?? '—'}`}</b>PDV {m.npdv ?? '—'} · en {m.retira_en}
                  {m.parcial ? ' (una parte; el resto se envía)' : ''}{m.articulo ? ` · ${cantidad(m)}` : ''}</span></div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Tramo({ t }: { t: Simulacion['vuelta'] }) {
  return <li className={`cr-tramo ${t.nivel}`}>{t.sinUbicar ? <span>Tramo sin calcular: falta ubicar una dirección</span> : <span className="num">{duracion(t.min)} · {t.km.toFixed(1).replace('.', ',')} km{t.estimado ? ' aprox.' : ''} · tránsito <b>{t.nivel}</b></span>}</li>;
}

// La libreta de direcciones: cuántos lugares tiene, de cuándo es la copia y «Actualizar» (la trae de nuevo de la planilla).
function Libreta({ puede, onCambio }: { puede: boolean; onCambio: () => void }) {
  const toast = useToast();
  const [e, setE] = useState<{ at: number; filas: number; error: string | null } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { http<typeof e>('GET', '/cronograma/lugares/estado').then(setE, () => undefined); }, []);
  if (!e) return null;
  const actualizar = async () => {
    setOcupado(true);
    try { const r = await http<NonNullable<typeof e>>('POST', '/cronograma/lugares/actualizar'); setE(r); toast(r.error ? `No se pudo actualizar la libreta: ${r.error}` : `Libreta actualizada: ${r.filas} lugares.`, !!r.error); onCambio(); }
    catch (err) { toast((err as Error).message, true); }
    setOcupado(false);
  };
  return (
    <span className="cr-libreta-pie">Libreta de direcciones: {e.filas ? `${e.filas} lugares` : 'sin copiar todavía'}{e.at && e.filas ? `, copiada el ${new Date(e.at).toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric' })}` : ''}{e.error ? ` (${e.error})` : ''}
      {puede && <button type="button" className="cr-link" disabled={ocupado} onClick={actualizar}>{ocupado ? 'Actualizando…' : 'Actualizar'}</button>}</span>
  );
}

// Corregir la dirección de la parada: la de entrega de sus pedidos, o la de la empresa (con su horario de recepción).
function EditarDireccion({ p, pedidos, onListo }: { p: Parada; pedidos: number[]; onListo: () => void }) {
  const toast = useToast();
  const [direccion, setDireccion] = useState(p.direccion ?? '');
  const [horario, setHorario] = useState(p.horario_texto ?? '');
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
    try {
      if (esEntrega) { for (const id of pedidos) await http('PUT', '/cronograma/direccion', { record_id: id, direccion }); }
      if (p.company_id && (!esEntrega || horario !== (p.horario_texto ?? ''))) await http('PUT', '/cronograma/direccion', { company_id: p.company_id, ...(esEntrega ? {} : { direccion }), horario });
      toast(esEntrega ? 'Dirección de entrega guardada en el pedido.' : 'Dirección guardada en la ficha de la empresa.');
      onListo();
    } catch (err) { toast((err as Error).message, true); setGuardando(false); }
  }
  return (
    <form className="cr-editar" onSubmit={guardar}>
      <label>{esEntrega ? 'Dirección de entrega de este pedido' : 'Dirección de la empresa'}
        <input className="input sm" autoFocus value={direccion} onChange={(e) => setDireccion(e.target.value)} placeholder="Calle y altura, localidad" /></label>
      <label>Buscar en la libreta de direcciones
        <input className="input sm" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Nombre del lugar, calle o localidad" /></label>
      {lugares.length > 0 && (
        <ul className="cr-lugares">
          {lugares.map((l) => (
            <li key={l.id}><button type="button" onClick={() => { setDireccion(l.direccion); if (p.company_id && !horario && l.horario && /\d\s*(a|-|hasta)\s*\d/i.test(l.horario)) setHorario(l.horario); }}>
              <b>{l.nombre}</b><span>{l.direccion}{l.horario ? ` · ${l.horario}` : ''}</span></button></li>
          ))}
        </ul>
      )}
      {p.company_id && <label>Horario de recepción<input className="input sm" value={horario} onChange={(e) => setHorario(e.target.value)} placeholder="9 a 13" /></label>}
      <div className="row"><button type="submit" className="btn sm primary" disabled={guardando}>Guardar</button><button type="button" className="btn sm ghost" onClick={onListo}>Cancelar</button></div>
    </form>
  );
}

// ---------- El mapa ----------

type Armada = { r: Recorrido; i: number; base: BaseGeo | null; paradas: Parada[]; real?: Real; sim: Simulacion; color: string };
function Mapa({ armadas, activa, bases, caliente, puede, onPin, ubicando, onUbicar }: {
  armadas: Armada[]; activa: number; bases: BaseGeo[]; caliente: string | null; puede: boolean; onPin: (clave: string, ruta: number) => void; ubicando: { clave: string; lat?: number; lng?: number } | null; onUbicar: (lat: number, lng: number) => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);
  const encuadre = useRef('');
  const pines = useRef(new Map<string, L.Marker>());
  const cb = useRef({ onPin, onUbicar });
  cb.current = { onPin, onUbicar };

  useEffect(() => {
    const m = L.map(caja.current!, { zoomControl: true, attributionControl: true, scrollWheelZoom: true }).setView([-34.6, -58.45], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }).addTo(m);
    capa.current = L.layerGroup().addTo(m);
    mapa.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(caja.current!);
    return () => { ro.disconnect(); m.remove(); mapa.current = null; };
  }, []);

  useEffect(() => {
    const m = mapa.current, g = capa.current;
    if (!m || !g) return;
    g.clearLayers();
    pines.current.clear();
    const todos: Array<[number, number]> = [];
    const usadas = new Set(armadas.filter((a) => a.paradas.length).map((a) => a.base?.id));
    for (const b of bases) {
      if (b.lat == null || b.lng == null || (!usadas.has(b.id) && usadas.size)) continue;
      todos.push([b.lat, b.lng]);
      L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'cr-pin-wrap', html: '<span class="cr-pin base">⌂</span>', iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 500, keyboard: false })
        .bindTooltip(esc(b.nombre), { direction: 'top', offset: [0, -14] }).addTo(g);
    }
    // Primero los recorridos que no se están mirando, apagados; el activo arriba.
    for (const a of [...armadas].sort((x, y) => Number(x.i === activa) - Number(y.i === activa))) {
      const act = a.i === activa, b = a.base && a.base.lat != null ? [a.base.lat, a.base.lng] as [number, number] : null;
      const puntos = a.paradas.filter((p) => p.lat != null).map((p) => [p.lat!, p.lng!] as [number, number]);
      const linea = a.real?.linea ?? (puntos.length && b ? [b, ...puntos, b] : puntos);
      if (linea.length > 1) {
        if (act) L.polyline(linea, { color: '#ffffff', weight: 8, opacity: 0.9, interactive: false }).addTo(g);
        L.polyline(linea, { color: a.color, weight: act ? 4.5 : 3, opacity: act ? 0.95 : 0.4, dashArray: a.real ? undefined : '2 9', lineCap: 'round', interactive: false }).addTo(g);
      }
      a.paradas.forEach((p, i) => {
        if (p.lat == null || p.lng == null) return;
        todos.push([p.lat, p.lng]);
        const s = a.sim.paradas[i], hecha = p.movimientos.every((x) => x.hecho);
        // Los números no se arrastran, salvo el de la parada a la que se le está corrigiendo la ubicación.
        const mio = ubicando?.clave === p.clave;
        const mk = L.marker(mio && ubicando.lat != null && ubicando.lng != null ? [ubicando.lat, ubicando.lng] : [p.lat, p.lng], {
          icon: L.divIcon({ className: 'cr-pin-wrap', html: `<span class="cr-pin${act ? '' : ' apagado'}${mio ? ' ubicando' : ''}${hecha ? ' hecha' : ''}${s.tarde || (p.visita && p.visita.resultado === 'no_se_pudo') ? ' tarde' : ''}" style="--c:${a.color}">${hecha ? '✓' : i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
          zIndexOffset: mio ? 4000 : act ? 1000 : 0, draggable: puede && mio, keyboard: false,
        }).bindTooltip(esc(`${p.nombre} · ${hhmm(s.llega)}`), { direction: 'top', offset: [0, -14] }).addTo(g);
        pines.current.set(p.clave, mk);
        mk.on('click', () => cb.current.onPin(p.clave, a.i));
        mk.on('dragend', () => { const ll = mk.getLatLng(); cb.current.onUbicar(ll.lat, ll.lng); });
      });
    }
    // Se vuelve a encuadrar solo cuando cambian los puntos, no al reordenar.
    const firma = [...pines.current.keys()].sort().join('|');
    if (todos.length && firma !== encuadre.current) { encuadre.current = firma; m.fitBounds(L.latLngBounds(todos).pad(0.15), { maxZoom: 15, animate: false }); }
  }, [armadas, activa, bases, puede, ubicando]);
  // La parada sobre la que está el mouse: se resalta su pin sin rehacer el mapa.
  useEffect(() => {
    for (const [clave, mk] of pines.current) { mk.getElement()?.querySelector('.cr-pin')?.classList.toggle('caliente', clave === caliente); mk.setZIndexOffset(clave === ubicando?.clave ? 4000 : clave === caliente ? 3000 : 1000); }
  }, [caliente, armadas, activa]);

  return <div ref={caja} className="cr-mapa" role="application" aria-label="Mapa del recorrido" />;
}
