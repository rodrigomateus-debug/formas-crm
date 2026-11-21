import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { http, qs, useToast, Icon } from '../lib';
import { QuienPidio, alEsc, useEsc } from '../components';
import { Select, useFloating } from '../Select';
import { seguimientoExpreso } from '../expresos';
import { claveOrden, dondeEntra, duracion, hhmm, optimizar, simular, type Destino, type ModoHora, type Simulacion, type TramosReales } from '../ruta';
import { lineasMovs } from '../talles';
import { idsYLugares, lindo, carrilDe, diaCorto, diaLargo, sumar, NuevoTransportista, opcionesChofer, useLugares, CamposHora, ayudaHora, type Mov, type Tipo } from './Cronograma';
import { LineaNota } from '../NotasLogistica';
import { APARTE, EncargoModal, abrirRemitoEgreso, itemTexto, juntarEncargos, type Encargo, type SitioJuntar } from './Recorridos';
import { EditarDireccion, LinkChofer, lindaDireccion } from './DireccionParada';
import { SIN_BULTOS, cargaRecorrido, desgloseBultos, fotoVehiculo, sumarBultos, textoBultos, textoCapacidad, tieneCapacidad, totalBultos, vehiculoDe, type Bultos, type Carga, type Vehiculo } from '../bultos';

// Ruta del día (Cronograma): las paradas del día en el mapa, una por lugar (tres retiros en el mismo impresor son una
// parada), con la hora aproximada de llegada a cada una. Se reordenan arrastrando, con las flechas o con «Ordenar por el
// recorrido más corto»; se reparten en varios recorridos (uno por chofer) y cada uno sale de un depósito. Los tiempos
// son los de un día de tránsito moderado según la hora (ruta.ts); todavía no usan el tránsito del momento.

export interface Parada {
  clave: string; nombre: string; direccion: string | null; origen: 'pedido' | 'finnegans' | 'ultima_entrega' | 'empresa' | 'libreta' | 'expreso' | null;
  lat: number | null; lng: number | null; punto_manual: boolean; horario: [number, number] | null; horario_texto: string | null;
  expreso?: { nombre: string; guia: string | null; cliente: string } | null;   // no va directo: se lleva a este expreso
  company_id: number | null; record_id: number | null; movimientos: Mov[];
  encargos?: Encargo[];   // lo que pidió alguien para ese día en ese lugar (Recorridos)
  lugar?: { nombre: string; horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null; coordinacion: string | null } | null;
  detalle?: string | null; observaciones?: string | null;   // piso, depto, puerta, unidad y observaciones de entrega
  sitio?: string | null; observaciones_por?: string | null;  // en un pedido repartido: cómo se llama este lugar, y de quién es su anotación
  // La hora fijada a mano (pedido de Rodrigo del 16/11/2026): `horario` ya es esa ventana y el orden más corto la cumple.
  pactada?: { modo: ModoHora; min: number; hasta?: number | null; texto: string } | null; estricto?: boolean;
  fotos?: number;   // las fotos del remito que mandó el chofer de esta parada (obligatoria en todas)
  remito?: number | null;   // el número del remito de traslado del egreso, si ya se imprimió
  espera_hasta?: number | null;   // con una hora fijada «a las», hasta cuándo se espera (ruta.ts)
  sugerencia: { record_id: number; sugerida: string; motivo: string } | null;
  visita?: { resultado: 'hecho' | 'no_se_pudo' | 'salteada'; motivo: string | null; nota: string | null; chofer: string | null; at: string } | null;
  // Solo de encargos y puede ser el mismo lugar que otra parada de ese día (la misma empresa o el mismo nombre, en otra
  // dirección): «¿Es el mismo lugar?» con «Juntar».
  juntar?: SitioJuntar[];
}
export const MOTIVO: Record<string, string> = { nadie: 'No había nadie', cerrado: 'Estaba cerrado', direccion: 'No encontró la dirección', rechazo: 'No lo quisieron recibir', no_listo: 'No estaba listo', otro: 'No se pudo' };
const horaDe = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
// `a_mano`: alguien movió sus paradas. Si no, se ordena solo por el recorrido más corto (igual que en el servidor y en la
// app del chofer): así quedan los que se arman eligiendo el chofer desde las tarjetas de la semana.
// `fin`: dónde termina (pedido de Rodrigo del 13/11/2026): 'igual' (vuelve a donde sale), el id de un depósito, 'ultima'
// (en la última parada, sin volver) u 'otro' (`fin_otro`).
type LugarElegido = { nombre: string; direccion: string; lat?: number | null; lng?: number | null };
export interface Recorrido { n: number; chofer: string | null; base: string; salida: number; orden: string[]; base_otro?: LugarElegido | null; a_mano?: boolean; fin?: string; fin_otro?: LugarElegido | null }
interface BaseGeo { id: string; nombre: string; direccion: string; lat: number | null; lng: number | null }
// `retiran`: las entregas que retira el cliente en Formas (tarjeta «Entrega» del pedido); `parcial`: el resto del pedido se envía.
export interface Datos { fecha: string; paradas: Parada[]; llegan: Mov[]; retiran?: Array<Mov & { retira_en: string; parcial: boolean }>; rutas: Recorrido[]; guardada: boolean;
  choferes: string[]; con_link?: string[]; expresos?: Array<{ id: number; nombre: string; direccion: string | null }>; bases: BaseGeo[]; buscando: number; puede_editar: boolean;
  vehiculos?: Vehiculo[];   // la camioneta de cada chofer (pantalla Choferes): para avisar si la carga no entra
}

// Los bultos que se dejan y los que se retiran en una parada (los que anotó Logística en las tarjetas): las entregas y los
// egresos se dejan, los retiros se suben; un encargo que solo retira se sube y si no, se deja.
const SE_DEJA: Tipo[] = ['entrega', 'egreso'];
function bultosDeParada(p: Parada): { deja: Bultos; levanta: Bultos } {
  let deja = SIN_BULTOS, levanta = SIN_BULTOS;
  for (const m of p.movimientos) if (m.bultos) { if (SE_DEJA.includes(m.tipo)) deja = sumarBultos(deja, m.bultos); else levanta = sumarBultos(levanta, m.bultos); }
  for (const e of p.encargos ?? []) if (e.bultos) { if (e.retirar.length && !e.llevar.length) levanta = sumarBultos(levanta, e.bultos); else deja = sumarBultos(deja, e.bultos); }
  return { deja, levanta };
}
// Si la carga entra: pasada (más de lo que entra), casi llena (más del 90 %) o bien. Sin la camioneta, null.
const estadoCarga = (c: Carga) => (c.ocupacion == null ? null : c.ocupacion > 1.0001 ? 'excede' : c.ocupacion > 0.9 ? 'casi' : 'ok');
const porciento = (x: number) => `${Math.round(x * 100)} %`;
interface Real extends TramosReales { linea: Array<[number, number]> }

// Con el número en blanco encima: todos pasan 4,5:1.
const COLORES = ['#3b5bdb', '#c2410c', '#0b7285', '#862e9c', '#2b7a39', '#a61e4d', '#5f3dc4', '#364fc7'];
// Los nombres vienen de ClickUp y de las fichas: al mapa van como texto, nunca como HTML.
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TANDA = 25;   // el servidor acepta de a 25 artículos por vez
const ORIGEN: Record<string, string> = { pedido: 'Dirección cargada en el pedido', finnegans: 'Del pedido en Finnegans', ultima_entrega: 'De la última entrega a este cliente', empresa: 'De la ficha de la empresa', libreta: 'De la libreta de direcciones', expreso: 'La dirección del expreso' };
const ROUTER = 'https://router.project-osrm.org/route/v1/driving/';
const punto = (p: { lat: number | null; lng: number | null } | undefined | null) => (p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);

// Una parada está hecha cuando están hechos sus movimientos de ClickUp y sus encargos (una sin nada para hacer, no).
export const hechaParada = (p: Pick<Parada, 'movimientos' | 'encargos'>) => p.movimientos.length + (p.encargos?.length ?? 0) > 0 && p.movimientos.every((m) => m.hecho) && (p.encargos ?? []).every((e) => e.estado === 'hecho');
// De dónde salió la dirección, cuando no es la del pedido: se dice en la tarjeta si es una suposición.
const ORIGEN_DUDOSO: Partial<Record<NonNullable<Parada['origen']>, string>> = { ultima_entrega: 'de la última entrega', libreta: 'de la libreta' };

// Las paradas que no están en ningún recorrido van al primero; las que ya no existen se sacan.
function acomodar(rutas: Recorrido[], paradas: Parada[]): Recorrido[] {
  const claves = new Set(paradas.map((p) => p.clave)), vistas = new Set<string>();
  const out = rutas.map((r) => ({ ...r, orden: r.orden.filter((c) => claves.has(c) && !vistas.has(c) && (vistas.add(c), true)) }));
  out[0] = { ...out[0], orden: [...out[0].orden, ...paradas.map((p) => p.clave).filter((c) => !vistas.has(c))] };
  return out;
}
const geoDe = (id: string, l: LugarElegido): BaseGeo => ({ id, nombre: l.nombre, direccion: l.direccion, lat: l.lat ?? null, lng: l.lng ?? null });
// De dónde sale: un depósito de Formas o, con «Otro lugar», el que se eligió.
const salidaDe = (r: Recorrido, i: number, bases: BaseGeo[]): BaseGeo | null => (r.base === 'otro' && r.base_otro ? geoDe(`otro-${i}`, r.base_otro) : bases.find((b) => b.id === r.base) ?? bases[0] ?? null);
// Dónde termina: donde sale, un depósito, otro lugar o, si termina en la última parada, ninguno (null).
const finDe = (r: Recorrido, i: number, bases: BaseGeo[], salida: BaseGeo | null): BaseGeo | null =>
  r.fin === 'ultima' ? null : r.fin === 'otro' && r.fin_otro ? geoDe(`fin-${i}`, r.fin_otro) : bases.find((b) => b.id === r.fin) ?? salida;
const destinoDe = (fin: BaseGeo | null): Destino => (fin ? punto(fin) : 'ultima');
// Los recorridos que nadie ordenó a mano van siempre por el más corto (la misma cuenta que hace el servidor).
function ordenarSolos(rutas: Recorrido[], paradas: Parada[], bases: BaseGeo[]): Recorrido[] {
  const porClave = new Map(paradas.map((p) => [p.clave, p]));
  return rutas.map((r, i) => {
    if (r.a_mano || r.orden.length < 2) return r;
    const sale = salidaDe(r, i, bases);
    return { ...r, orden: optimizar(punto(sale), r.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p), r.salida, destinoDe(finDe(r, i, bases, sale))).map((p) => p.clave) };
  });
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
  const [fijando, setFijando] = useState<string | null>(null);   // la parada a la que se le está fijando la hora
  // La parada a la que se le está corrigiendo la ubicación en el mapa (solo ese número se puede arrastrar) y dónde se soltó.
  const [ubicando, setUbicando] = useState<{ clave: string; lat?: number; lng?: number } | null>(null);
  // Corregir la ubicación: Esc lo cancela aunque el foco esté en el mapa (se arrastra el marcador).
  useEsc(!!ubicando, () => setUbicando(null));
  // Paneles de la barra del recorrido (agregar un chofer o un expreso, elegir otro lugar de salida) y la parada a la que
  // se le está cargando el expreso.
  const [panel, setPanel] = useState<'chofer' | 'salida' | 'fin' | null>(null);
  const [expresando, setExpresando] = useState<string | null>(null);
  const [encargo, setEncargo] = useState<number | null>(null);   // el encargo que se abrió para ver o cambiar
  const [juntando, setJuntando] = useState<string | null>(null);   // la parada que se está por juntar con otra («Juntar con…»)
  const [ocupadoJuntar, setOcupadoJuntar] = useState(false);
  const arrastre = useRef<string | null>(null);
  // Sobre qué parada se está soltando la que se arrastra; `abajo`: queda después de ella (se arrastra hacia abajo).
  const [sobre, setSobre] = useState<{ clave: string; abajo: boolean } | null>(null);
  const [marcando, setMarcando] = useState<string | null>(null);   // la parada que se está marcando como hecha (o pendiente)
  const [agotado, setAgotado] = useState(false);   // se dejó de preguntar si ya se ubicaron las direcciones
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
        // Con cambios hechos en la pantalla se quedan esos; si no, lo que dice el servidor. Los recorridos que nadie ordenó
        // a mano se vuelven a ordenar a medida que se van ubicando las direcciones.
        const base = antes.length && d.fecha === (antes as Recorrido[] & { fecha?: string }).fecha && tocado.current ? antes : d.rutas;
        return Object.assign(ordenarSolos(acomodar(base, d.paradas), d.paradas, d.bases), { fecha: d.fecha });
      });
      // Faltan ubicar direcciones (se buscan de a pocas): vuelve a pedir hasta que estén.
      window.clearTimeout(sondeo.current);
      setAgotado(d.buscando > 0 && intento >= 12);
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
  const datosRef = useRef(datos);
  datosRef.current = datos;
  const porClave = useMemo(() => new Map((datos?.paradas ?? []).map((p) => [p.clave, p])), [datos]);
  const cambiar = (f: (r: Recorrido[]) => Recorrido[]) => {
    sucio.current = true; tocado.current = true;
    setRutas((r) => { const n = Object.assign(datos ? ordenarSolos(f(r), datos.paradas, datos.bases) : f(r), { fecha }); porGuardar.current = { fecha, rutas: n }; return n; });
  };
  // Guarda el orden y los recorridos un rato después del último cambio.
  useEffect(() => {
    if (!sucio.current || !puede || !rutas.length || (rutas as Recorrido[] & { fecha?: string }).fecha !== fecha) return;
    const t = window.setTimeout(() => { sucio.current = false; porGuardar.current = null; http('PUT', '/cronograma/ruta', { fecha, rutas }).catch((e) => toast((e as Error).message, true)); }, 700);
    return () => window.clearTimeout(t);
  }, [rutas, puede, fecha, toast]);

  const armadas = useMemo(() => rutas.map((r, i) => {
    const base = salidaDe(r, i, datos?.bases ?? []), fin = finDe(r, i, datos?.bases ?? [], base), destino = destinoDe(fin);
    const paradas = r.orden.map((c) => porClave.get(c)).filter((p): p is Parada => !!p);
    const clave = claveOrden(punto(base), paradas, destino);
    const real = reales[clave];
    // `vuelve`: termina donde sale.
    // La carga a lo largo del recorrido, contra la camioneta de su chofer (cajas combinadas: bultos.ts).
    const vehiculo = vehiculoDe(datos?.vehiculos, r.chofer), porParada = paradas.map(bultosDeParada);
    const carga = cargaRecorrido(porParada, vehiculo);
    return { r, i, base, fin, vuelve: !!fin && fin.id === base?.id, paradas, clave, real, sim: simular(punto(base), paradas, r.salida, real, destino), color: COLORES[i % COLORES.length],
      vehiculo, carga, porParada };
  }), [rutas, datos, porClave, reales]);

  // El recorrido por calles (distancia y tiempo de cada tramo, y el dibujo). Si el servicio no contesta, queda la
  // estimación en línea recta.
  // Con alguna dirección sin ubicar se pide igual, con las que sí están: así un punto que falta no deja todo el recorrido
  // en línea recta.
  useEffect(() => {
    const faltan = armadas.filter((a) => punto(a.base) && a.paradas.some((p) => punto(p)) && !reales[a.clave]);
    if (!faltan.length) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      for (const a of faltan) {
        const ubicadas = a.paradas.filter((p) => punto(p)), fin = punto(a.fin) ? a.fin : null;
        const pts = [a.base!, ...ubicadas, ...(fin ? [fin] : [])].map((p) => `${p.lng},${p.lat}`).join(';');
        try {
          const res = await fetch(`${ROUTER}${pts}?overview=full&geometries=geojson`, { signal: ctl.signal });
          if (!res.ok) continue;
          const j = (await res.json()) as { routes?: Array<{ legs: Array<{ distance: number; duration: number }>; geometry: { coordinates: Array<[number, number]> } }> };
          const ruta = j.routes?.[0];
          if (!ruta || ruta.legs.length !== ubicadas.length + (fin ? 1 : 0)) continue;
          // Al orden de la simulación: cada parada ubicada, el tramo desde la anterior ubicada; las que faltan, ninguno.
          let k = 0;
          const tramos = [...a.paradas.map((p) => (punto(p) ? ruta.legs[k++] : null)), fin ? ruta.legs[k] : null].map((l) => (l ? { km: l.distance / 1000, min: l.duration / 60 } : { km: 0, min: 0 }));
          setReales((r) => ({ ...r, [a.clave]: { clave: a.clave, tramos, linea: ruta.geometry.coordinates.map(([x, y]) => [y, x]) } }));
        } catch { /* sin servicio de rutas: sigue la estimación */ }
      }
    }, 500);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [armadas, reales]);

  const act = armadas[Math.min(activa, armadas.length - 1)];
  // El número de una parada en su recorrido («3»; con varios recorridos, «R2 · 3»), para elegirla en «Juntar con…».
  const numeroDe = (clave: string) => {
    for (const a of armadas) { const k = a.paradas.findIndex((x) => x.clave === clave); if (k >= 0) return armadas.length > 1 ? `R${a.i + 1} · ${k + 1}` : String(k + 1); }
    return null;
  };
  // Guarda ya y vuelve a pedir la ruta: hace falta cuando el cambio necesita algo del servidor (ubicar en el mapa el lugar
  // de salida que se eligió).
  // Fijar (o sacar) la hora de una parada: lo que estaba sin guardar se guarda primero, y el recorrido vuelve del servidor
  // ya ordenado solo para cumplir esa hora y las demás.
  async function fijarHora(p: Parada, modo: ModoHora | null, hora: string, hasta: string) {
    try {
      const pend = porGuardar.current;
      if (sucio.current && pend) { sucio.current = false; porGuardar.current = null; await http('PUT', '/cronograma/ruta', pend); }
      await http('PUT', '/cronograma/hora', { fecha, clave: p.clave, modo, hora, hasta });
      toast(modo ? `${lindo(p.nombre)}: ${modo === 'antes' ? 'antes de las' : modo === 'desde' ? 'desde las' : 'a las'} ${hora}. El recorrido se ordenó para cumplirla.` : `${lindo(p.nombre)}: sin hora fijada.`);
    } catch (e) { toast((e as Error).message, true); return; }
    // Vuelve del servidor ya ordenado; mientras tanto queda a la vista lo que había (sin vaciar la pantalla ni el mapa).
    setFijando(null); tocado.current = false;
    void cargar(); onCambio();
  }
  async function guardarYa(nuevas: Recorrido[]) {
    sucio.current = false; porGuardar.current = null; tocado.current = true;
    setRutas(Object.assign(nuevas, { fecha }));
    try { await http('PUT', '/cronograma/ruta', { fecha, rutas: nuevas }); tocado.current = false; } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  // Mover una parada a mano deja el recorrido ordenado a mano: ya no se reordena solo.
  const mover = (clave: string, a: number) => {
    const antes = act.paradas.findIndex((p) => p.clave === clave);
    if (antes < 0 || a < 0 || a >= act.paradas.length || a === antes) return;
    cambiar((rs) => rs.map((r, i) => {
      if (i !== act.i) return r;
      const o = [...r.orden], de = o.indexOf(clave);
      if (de < 0 || a >= o.length) return r;
      o.splice(a, 0, o.splice(de, 1)[0]);
      return { ...r, orden: o, a_mano: true };
    }));
    if (!act.r.a_mano) toast('El recorrido quedó ordenado a mano: ya no se reordena solo. «Ordenar por el recorrido más corto» lo vuelve a dejar automático.');
  };
  // A otro recorrido: si ese está ordenado a mano, entra donde menos lo alarga (igual que en el servidor); si no, se ordena solo.
  const pasar = (p: Parada, a: number) => {
    const previo = rutas, destino = armadas.find((x) => x.i === a);
    if (!destino) return;
    cambiar((rs) => rs.map((r, i) => {
      const sin = r.orden.filter((c) => c !== p.clave);
      if (i !== a) return { ...r, orden: sin };
      const pos = r.a_mano ? dondeEntra(punto(destino.base), destinoDe(destino.fin), destino.paradas, p, r.salida) : sin.length;
      return { ...r, orden: [...sin.slice(0, pos), p.clave, ...sin.slice(pos)] };
    }));
    toast(`${lindo(p.nombre)} pasó al recorrido ${a + 1}${destino.r.chofer ? ` (${destino.r.chofer})` : ''}.`, false, { label: 'Deshacer', onClick: () => cambiar(() => previo) });
  };
  // Ordena por el más corto y lo deja otra vez automático (se reordena solo a medida que cambia).
  const ordenar = () => {
    // Los dos órdenes se comparan con la misma cuenta (línea recta), y el de ahora solo se cambia si el nuevo es mejor.
    const b = punto(act.base), d = destinoDe(act.fin);
    const antes = simular(b, act.paradas, act.r.salida, null, d).costo;
    const nuevo = optimizar(b, act.paradas, act.r.salida, d);
    const despues = simular(b, nuevo, act.r.salida, null, d).costo;
    const mejor = antes - despues > 1;
    cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, orden: mejor ? nuevo.map((p) => p.clave) : r.orden, a_mano: false } : r)));
    toast(`${mejor ? `Recorrido reordenado: unos ${duracion(antes - despues)} menos.` : 'Ya era el recorrido más corto.'} Desde ahora se ordena solo.`);
  };
  // Un panel abierto por vez en toda la lista: la hora, la dirección, el expreso o el punto en el mapa.
  const abrirPanel = (que: 'hora' | 'direccion' | 'expreso' | 'ubicar' | 'juntar' | null, clave: string) => {
    setFijando(que === 'hora' ? clave : null); setEditando(que === 'direccion' ? clave : null); setExpresando(que === 'expreso' ? clave : null);
    setJuntando(que === 'juntar' ? clave : null);
    setUbicando(que === 'ubicar' ? { clave } : null);
    if (que === 'ubicar') { setCaliente(clave); requestAnimationFrame(() => document.querySelector('.cr-mapa')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
  };
  async function imprimirRemito(p: Parada) {
    await abrirRemitoEgreso(fecha, p.clave, toast);
    void cargar();   // para que la tarjeta muestre el número
  }
  // Marca la parada como hecha (o la vuelve a pendiente): cambia el estado en ClickUp, así que no se puede tocar dos veces
  // seguidas y el aviso trae «Deshacer».
  async function marcar(p: Parada) {
    if (marcando) return;
    const hecho = !hechaParada(p);
    const porTipo = new Map<Tipo, Mov[]>();
    for (const m of p.movimientos) if (m.hecho !== hecho) porTipo.set(m.tipo, [...(porTipo.get(m.tipo) ?? []), m]);
    const encs = (p.encargos ?? []).filter((e) => (e.estado === 'hecho') !== hecho), cambian = new Set(encs.map((e) => e.id));
    setMarcando(p.clave);
    setDatos((d) => d && { ...d, paradas: d.paradas.map((x) => (x.clave === p.clave ? { ...x, movimientos: x.movimientos.map((m) => ({ ...m, hecho })),
      encargos: (x.encargos ?? []).map((e) => (cambian.has(e.id) ? { ...e, estado: hecho ? 'hecho' : 'pendiente' } : e)) } : x)) });
    try {
      let cambiados = 0;
      for (const [tipo, ms] of porTipo) for (let i = 0; i < ms.length; i += TANDA) cambiados += (await http<{ cambiados: number }>('POST', '/cronograma/hecho', { ...idsYLugares(ms.slice(i, i + TANDA)), tipo, hecho })).cambiados;
      for (const e of encs) await http('PATCH', `/recorridos/encargos/${e.id}`, { estado: hecho ? 'hecho' : 'pendiente' });
      const deshacer = { label: 'Deshacer', onClick: () => { const q = datosRef.current?.paradas.find((x) => x.clave === p.clave); if (q) void marcar(q); } };
      toast(!hecho ? `${lindo(p.nombre)}: quedó como pendiente.` : `${lindo(p.nombre)}: hecha.${cambiados ? ` ${cambiados} artículo${cambiados === 1 ? ' cambió' : 's cambiaron'} de estado en ClickUp.` : ''}`, false, deshacer);
    } catch (e) { toast(`${(e as Error).message} Puede haber quedado a medias: revisá la parada.`, true); }
    setMarcando(null);
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
  // Juntar paradas (pedido de Rodrigo del 20/11/2026): los encargos de una parada van en otra de ese día (su clave) o
  // quedan como otra parada (APARTE). Lo que estaba sin guardar del orden se guarda primero; la ruta vuelve del servidor
  // ya armada. El aviso trae «Deshacer» (cada encargo vuelve a como estaba).
  async function juntar(encs: Encargo[], con: string, texto: string) {
    if (ocupadoJuntar || !encs.length) return;
    const antes = encs.map((e) => ({ id: e.id, junto_a: e.junto_a ?? null }));
    setOcupadoJuntar(true);
    try {
      const pend = porGuardar.current;
      if (sucio.current && pend) { sucio.current = false; porGuardar.current = null; await http('PUT', '/cronograma/ruta', pend); }
      await juntarEncargos(encs, con);
      const deshacer = async () => {
        try { for (const a of antes) await http('PATCH', `/recorridos/encargos/${a.id}`, { junto_a: a.junto_a }); } catch (e) { toast((e as Error).message, true); }
        void cargar(); onCambio();
      };
      toast(texto, false, { label: 'Deshacer', onClick: () => { void deshacer(); } });
      setJuntando(null);
    } catch (e) { toast((e as Error).message, true); }
    setOcupadoJuntar(false);
    void cargar(); onCambio();
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

  const movs = act.paradas.flatMap((p) => [...p.movimientos.map((m) => m.hecho), ...(p.encargos ?? []).map((e) => e.estado === 'hecho')]), hechos = movs.filter(Boolean).length, tarde = act.sim.paradas.filter((s) => s.tarde > 0).length;
  const sinBase = !punto(act.base), sinFin = !!act.fin && !punto(act.fin);
  const incierto = act.sim.incierta || act.sim.vuelta.sinUbicar;
  // Qué falta ubicar en un tramo sin calcular, y cómo arreglarlo desde ahí.
  const faltaSalida = { nombre: act.base?.nombre ?? 'el lugar de salida', accion: puede && act.r.base === 'otro' ? { label: 'Cambiar el lugar', onClick: () => setPanel('salida') } : null };
  return (
    <div className="cr-ruta">
      {cab}
      <div className="cr-recorridos">
        {armadas.map((a) => (
          <button key={a.i} type="button" className={`cr-rec${a.i === act.i ? ' on' : ''}${estadoCarga(a.carga) === 'excede' ? ' excede' : ''}`} aria-pressed={a.i === act.i} onClick={() => setActiva(a.i)} style={{ '--c': a.color } as React.CSSProperties}
            title={estadoCarga(a.carga) === 'excede' ? `La carga no entra en la camioneta: ${porciento(a.carga.ocupacion!)} de lo que entra` : undefined}>
            <i />Recorrido {a.i + 1}<span className="muted">{a.r.chofer ?? 'Sin chofer'} · {a.paradas.length} parada{a.paradas.length === 1 ? '' : 's'}</span>
            {estadoCarga(a.carga) === 'excede' && <span className="cr-rec-excede"><Icon name="alert" size={12} />{porciento(a.carga.ocupacion!)}</span>}
          </button>
        ))}
        {puede && rutas.length < 8 && <button type="button" className="cr-agregar" onClick={() => { cambiar((rs) => [...rs, { n: rs.length + 1, chofer: null, base: rs[0].base, salida: rs[0].salida, orden: [], a_mano: false }]); setActiva(rutas.length); }}><Icon name="plus" size={12} />Otro recorrido</button>}
      </div>

      <div className="toolbar cr-ruta-barra">
        <label className="cr-campo">Chofer
          <Select className="input sm cr-sel" value={act.r.chofer ?? ''} disabled={!puede} aria-label="Chofer"
            onChange={(e) => { if (e.target.value === '+') { setPanel('chofer'); return; } cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, chofer: e.target.value || null } : r))); }}>
            {opcionesChofer({ choferes: datos.choferes, expresos: (datos.expresos ?? []).map((x) => x.nombre), actual: act.r.chofer, vacio: 'Sin asignar', agregar: 'Agregar chofer o expreso…' })}
          </Select>
        </label>
        {act.vehiculo && <VehiculoChip v={act.vehiculo} />}
        <label className="cr-campo">Sale de
          <Select className="input sm cr-sel" value={act.r.base} disabled={!puede} aria-label="Sale de"
            onChange={(e) => { if (e.target.value === 'otro') { setPanel('salida'); return; } setPanel(null); cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, base: e.target.value, base_otro: null } : r))); }}>
            {datos.bases.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            <option value="otro">{act.r.base === 'otro' && act.r.base_otro ? act.r.base_otro.nombre : 'Otro lugar…'}</option>
          </Select>
        </label>
        {puede && act.r.base === 'otro' && <button type="button" className="cr-link" onClick={() => setPanel('salida')}>Cambiar lugar</button>}
        <label className="cr-campo">Termina en
          <Select className="input sm cr-sel" value={act.r.fin ?? 'igual'} disabled={!puede} aria-label="Termina en"
            onChange={(e) => { const v = e.target.value; if (v === 'otro') { setPanel('fin'); return; } setPanel(null); cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, fin: v, fin_otro: null } : r))); }}>
            <option value="igual">Donde sale</option>
            {datos.bases.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            <option value="ultima">La última parada</option>
            <option value="otro">{act.r.fin === 'otro' && act.r.fin_otro ? act.r.fin_otro.nombre : 'Otro lugar…'}</option>
          </Select>
        </label>
        {puede && act.r.fin === 'otro' && <button type="button" className="cr-link" onClick={() => setPanel('fin')}>Cambiar lugar</button>}
        <label className="cr-campo">A las
          <input type="time" className="input sm" value={`${String(Math.floor(act.r.salida / 60)).padStart(2, '0')}:${String(act.r.salida % 60).padStart(2, '0')}`} disabled={!puede}
            onChange={(e) => { if (!e.target.value) return; const [h, m] = e.target.value.split(':').map(Number); if (Number.isFinite(h)) cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, salida: h * 60 + (m || 0) } : r))); }} />
        </label>
        {puede && (act.r.a_mano ? <button type="button" className="btn sm primary" disabled={act.paradas.length < 2} onClick={ordenar}><Icon name="route" size={14} />Ordenar por el recorrido más corto</button>
          : act.paradas.length > 1 && <span className="cr-solo" title="Hasta que muevas una parada a mano: desde ahí queda en el orden que le des."><Icon name="route" size={14} />Se ordena solo por el recorrido más corto</span>)}
        <span className="grow" />
        {puede && rutas.length > 1 && <button type="button" className="btn sm ghost danger" onClick={() => { cambiar((rs) => { const fuera = rs[act.i].orden, q = rs.filter((_, i) => i !== act.i); q[0] = { ...q[0], orden: [...q[0].orden, ...fuera] }; return q; }); setActiva(0); }}>Quitar este recorrido</button>}
      </div>

      {/* El link de la app del chofer elegido, para copiarlo o mandarlo por WhatsApp (los expresos no tienen app). */}
      {puede && act.r.chofer && !(datos.expresos ?? []).some((x) => x.nombre === act.r.chofer) && <LinkChofer chofer={act.r.chofer} cuando={fecha === hoy ? 'hoy' : diaLargo(fecha).toLowerCase()} />}
      {panel === 'chofer' && puede && <NuevoTransportista onCancelar={() => setPanel(null)} onListo={(nombre) => { setPanel(null); cambiar((rs) => rs.map((r, i) => (i === act.i ? { ...r, chofer: nombre } : r))); void cargar(); }} />}
      {panel === 'salida' && puede && <OtroLugar onCancelar={() => setPanel(null)} onElegir={(l) => { setPanel(null); void guardarYa(rutas.map((r, i) => (i === act.i ? { ...r, base: 'otro', base_otro: l } : r))); }} />}
      {panel === 'fin' && puede && <OtroLugar titulo="Dónde termina este recorrido" onCancelar={() => setPanel(null)} onElegir={(l) => { setPanel(null); void guardarYa(rutas.map((r, i) => (i === act.i ? { ...r, fin: 'otro', fin_otro: l } : r))); }} />}

      <div className="cr-kpis">
        <div><span>Paradas</span><b className="num">{act.paradas.length}<small>{movs.length} {movs.length === 1 ? 'cosa' : 'cosas'} para hacer</small></b></div>
        {totalBultos(act.carga.total) > 0 && (
          <div title={`En el momento más cargado: ${desgloseBultos(act.carga.pico) || 'nada'}${act.vehiculo && tieneCapacidad(act.vehiculo) ? `. ${textoCapacidad(act.vehiculo)}.` : ''}`}>
            <span>Carga</span>
            {act.carga.ocupacion != null
              ? <b className={`num ${estadoCarga(act.carga) === 'excede' ? 'danger-text' : estadoCarga(act.carga) === 'casi' ? 'warn-text' : ''}`}>{porciento(act.carga.ocupacion)}<small>de la camioneta</small></b>
              : <b className="num">{totalBultos(act.carga.pico)}<small>bultos a la vez</small></b>}
          </div>
        )}
        <div><span>Recorrido</span><b className="num">{incierto ? '≈' : ''}{act.sim.km.toFixed(0)}<small>km{act.real && !incierto ? '' : ' aprox.'}</small></b></div>
        <div><span>En la calle</span><b className="num">{act.sim.vuelta.sinUbicar ? '—' : `${incierto ? '≈' : ''}${duracion(act.sim.fin - act.r.salida)}`}</b></div>
        <div><span>{act.vuelve ? 'Vuelve' : 'Termina'}</span><b className="num">{act.sim.vuelta.sinUbicar ? '—' : `${incierto ? '≈' : ''}${hhmm(act.sim.fin)}`}</b></div>
        <div><span>Hecho</span><b className="num">{hechos}<small>de {movs.length}</small></b></div>
        <div><span>Fuera de horario</span><b className={`num ${tarde ? 'danger-text' : ''}`}>{tarde || '—'}</b></div>
        {act.sim.sinUbicar + (sinFin ? 1 : 0) + (sinBase ? 1 : 0) > 0 && <div><span>Sin ubicar</span><b className="num warn-text">{act.sim.sinUbicar + (sinFin ? 1 : 0) + (sinBase ? 1 : 0)}</b></div>}
      </div>
      <AvisoCarga a={act} />
      {datos.buscando > 0 && (agotado
        ? <div className="aviso warn small">Todavía faltan ubicar en el mapa {datos.buscando} dirección{datos.buscando === 1 ? '' : 'es'}. <button type="button" className="cr-link" onClick={() => { setAgotado(false); void cargar(); }}>Volver a fijarse</button></div>
        : <div className="aviso info small">Buscando en el mapa {datos.buscando} dirección{datos.buscando === 1 ? '' : 'es'}…</div>)}
      {sinBase && !datos.buscando && <div className="aviso warn small">No se pudo ubicar {act.base?.nombre ?? 'el depósito'} ({act.base?.direccion}). {act.r.base === 'otro' ? <>Elegí otro lugar en «Sale de».</> : 'Corregí la dirección en la configuración del cronograma.'}</div>}
      {sinFin && !datos.buscando && <div className="aviso warn small">No se pudo ubicar dónde termina: {act.fin!.nombre} ({act.fin!.direccion}). La vuelta queda sin calcular. {act.r.fin === 'otro' ? <>Elegí otro lugar en «Termina en».</> : 'Corregí la dirección en la configuración del cronograma.'}</div>}

      <div className="cr-ruta-cuerpo">
        <ol className="cr-paradas">
          <li className="cr-parada base"><div className="cr-n-col"><div className="cr-n base"><Icon name="home" size={13} /></div></div><div><div className="cr-p-nombre">{act.base?.nombre}</div><div className="cr-p-sub">{act.base?.direccion}</div></div><div className="cr-eta"><b className="num">{hhmm(act.r.salida)}</b><span>sale</span></div></li>
          {!act.paradas.length && <li className="empty plain">{datos.paradas.length ? 'Este recorrido no tiene paradas. Pasale alguna desde otro recorrido.' : 'Este día no hay retiros, egresos, entregas ni encargos.'}</li>}
          {act.paradas.map((p, i) => {
            const s = act.sim.paradas[i], todo = hechaParada(p), nombre = lindo(p.nombre);
            const entregas = [...new Set(p.movimientos.filter((m) => m.tipo === 'entrega' && m.record_id).map((m) => m.record_id!))];
            const abierto = fijando === p.clave || editando === p.clave || expresando === p.clave || ubicando?.clave === p.clave || juntando === p.clave;
            // Una parada que es solo de encargos se puede juntar con otra de ese día; un encargo que comparte la parada con
            // otra cosa se puede separar.
            const encs = p.encargos ?? [];
            const puedeJuntar = puede && encs.length > 0 && !p.movimientos.length && !p.expreso && datos.paradas.length > 1;
            const separables = puede && (p.movimientos.length > 0 || encs.length > 1) ? encs : [];
            const buscando = p.lat == null && !!p.direccion && datos.buscando > 0 && !agotado;
            const puedeDireccion = puede && !p.expreso && (!!p.company_id || entregas.length > 0);
            const egreso = p.movimientos.some((m) => m.tipo === 'egreso');
            // Arriba del tramo que llega a esta parada: si no se pudo calcular, qué falta ubicar (ella o de donde sale).
            const falta = s.tramo.falta === 'desde' ? faltaSalida
              : { nombre, accion: buscando ? null : puede && p.direccion ? { label: 'Ubicarla en el mapa', onClick: () => abrirPanel('ubicar', p.clave) }
                : puedeDireccion ? { label: 'Cargar la dirección', onClick: () => abrirPanel('direccion', p.clave) } : null };
            const atiende = s.llega + (s.espera > 1 ? s.espera : 0);
            const menu: ItemMenu[] = [
              ...(puedeDireccion ? [{ label: p.direccion ? 'Corregir la dirección' : 'Cargar la dirección', icon: 'edit', nota: entregas.length ? 'Se cambia en el pedido' : 'Se cambia en la ficha de la empresa', onClick: () => abrirPanel('direccion', p.clave) }] : []),
              ...(puede && p.direccion ? [{ label: p.lat == null ? 'Ubicarla en el mapa' : 'Corregir el punto en el mapa', icon: 'pin', nota: 'Vale para esta dirección en todas las rutas', onClick: () => abrirPanel('ubicar', p.clave) }] : []),
              ...(puede && /^p:/.test(p.clave) ? [{ label: p.expreso ? (p.expreso.guia ? 'Cambiar expreso o guía' : 'Cargar la guía') : 'Mandar por expreso', icon: 'truck', onClick: () => abrirPanel('expreso', p.clave) }] : []),
              ...(p.lat != null ? [{ label: 'Cómo llegar (Google Maps)', icon: 'external', onClick: () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`, '_blank', 'noopener') }] : []),
              ...(puede ? armadas.filter((a) => a.i !== act.i).map((a, k) => ({ label: `Recorrido ${a.i + 1} · ${a.r.chofer ?? 'sin chofer'}`, icon: 'route', grupo: k === 0 ? 'Pasar a otro recorrido' : undefined, onClick: () => pasar(p, a.i) })) : []),
              ...(puedeJuntar ? [{ label: 'Juntar con otra parada…', icon: 'merge', nota: 'Si es el mismo lugar que otra de este día', onClick: () => abrirPanel('juntar', p.clave) }] : []),
              ...separables.map((e, k) => ({ label: `Separar el encargo de ${e.quien?.split(' ')[0] ?? 'alguien'}`, icon: 'merge', grupo: k === 0 ? 'Es otro lugar' : undefined,
                nota: 'Va como otra parada', onClick: () => void juntar([e], APARTE, `El encargo de ${e.quien?.split(' ')[0] ?? 'alguien'} va como otra parada.`) })),
            ];
            const bp = act.porParada[i];
            const tags = [
              totalBultos(bp.deja) > 0 && <span key="bd" className="cr-tag" title={`Se dejan: ${desgloseBultos(bp.deja)}`}>Deja {textoBultos(totalBultos(bp.deja))}</span>,
              totalBultos(bp.levanta) > 0 && <span key="bl" className="cr-tag" title={`Se suben: ${desgloseBultos(bp.levanta)}`}>Sube {textoBultos(totalBultos(bp.levanta))}</span>,
              p.pactada ? <span key="h" className={`cr-tag fija${s.tarde ? ' late' : ''}`} title="Hora fijada a mano: el recorrido se ordena para cumplirla"><Icon name="timer" size={11} />{p.pactada.texto}{s.tarde ? ` · llega ${duracion(s.tarde)} tarde` : s.espera > 1 ? ` · espera ${duracion(s.espera)}` : ''}</span>
                : (p.horario || s.espera > 1) && <span key="h" className={`cr-tag${s.tarde ? ' late' : ''}`}>{p.horario ? `Recibe de ${hhmm(p.horario[0])} a ${hhmm(p.horario[1])}` : ''}{s.tarde ? ` · llega ${duracion(s.tarde)} tarde` : s.espera > 1 ? ` · espera ${duracion(s.espera)}` : ''}</span>,
              p.lat == null && (buscando ? <span key="u" className="cr-tag">Buscando en el mapa…</span>
                : <span key="u" className="cr-tag riesgo"><Icon name="alert" size={11} />{p.direccion ? 'No se encontró en el mapa' : 'Falta la dirección'}</span>),
              p.visita?.resultado === 'hecho' && <span key="v" className="cr-tag">Lo marcó {p.visita.chofer ?? 'el chofer'} a las {horaDe(p.visita.at)}</span>,
              (p.fotos ?? 0) > 0 ? <span key="f" className="cr-tag" title="La foto del remito que mandó el chofer: está en los pedidos de la parada"><Icon name="image" size={11} />{p.fotos === 1 ? 'Foto del remito' : `${p.fotos} fotos del remito`}</span>
                : (todo || p.visita?.resultado === 'hecho') && <span key="f" className="cr-tag riesgo" title="La foto del remito es obligatoria en todas las paradas"><Icon name="alert" size={11} />Sin foto del remito</span>,
            ].filter(Boolean);
            const etaTexto = s.tramo.sinUbicar ? 'Hora sin calcular' : `${s.espera > 1 ? `Llega a las ${hhmm(s.llega)} y la atienden a las ${hhmm(atiende)}` : `Llega a las ${hhmm(s.llega)}, ${duracion(s.servicio)} en el lugar`}${s.incierta ? ' (aproximado: antes hay una dirección sin ubicar)' : ''}`;
            return (
              <Fragment key={p.clave}>
                <Tramo t={s.tramo} falta={falta} />
                <li data-clave={p.clave} className={`cr-parada${todo ? ' hecha' : ''}${caliente === p.clave ? ' caliente' : ''}${sobre?.clave === p.clave ? ` sobre${sobre.abajo ? ' abajo' : ''}` : ''}`}
                  style={{ '--c': act.color } as React.CSSProperties}
                  onMouseEnter={() => setCaliente(p.clave)} onMouseLeave={() => setCaliente((c) => (c === p.clave ? null : c))}
                  onFocus={() => setCaliente(p.clave)}
                  onDragOver={(e) => { const de = arrastre.current; if (de && de !== p.clave) { e.preventDefault(); const abajo = act.paradas.findIndex((x) => x.clave === de) < i; if (sobre?.clave !== p.clave || sobre.abajo !== abajo) setSobre({ clave: p.clave, abajo }); } }}
                  onDrop={(e) => { e.preventDefault(); const de = arrastre.current; arrastre.current = null; setSobre(null); if (de) mover(de, i); }}>
                  {/* Se arrastra desde el número (con la manija): así el resto de la tarjeta deja seleccionar y copiar. */}
                  <div className={`cr-n-col${puede && !abierto ? ' asa' : ''}`} draggable={puede && !abierto} title={puede && !abierto ? 'Arrastrá para cambiar el orden' : undefined}
                    onDragStart={(e) => { arrastre.current = p.clave; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.clave); const li = e.currentTarget.closest('li'); if (li) e.dataTransfer.setDragImage(li, 18, 18); } catch { /* no hace falta */ } }}
                    onDragEnd={() => { arrastre.current = null; setSobre(null); }}>
                    <div className="cr-n num" aria-label={`Parada ${i + 1}${todo ? ', hecha' : ''}`}>{i + 1}</div>
                    {puede && !abierto && <span className="cr-asa" aria-hidden="true" />}
                  </div>
                  <div className="cr-p-quien">
                    <div className="cr-p-nombre">{nombre}{p.sitio ? <span className="cr-p-sitio"> · {p.sitio}</span> : null}</div>
                    {p.expreso && <div className="cr-p-expreso"><span className="cr-tag exp">Expreso</span>para {lindo(p.expreso.cliente)}{p.expreso.guia
                      ? <> · guía {seguimientoExpreso(p.expreso.nombre, p.expreso.guia) ? <a className="cr-link num" href={seguimientoExpreso(p.expreso.nombre, p.expreso.guia)!} target="_blank" rel="noreferrer" title="Ver el seguimiento del envío">{p.expreso.guia} ↗</a> : <b className="num">{p.expreso.guia}</b>}</>
                      : ' · sin guía todavía'}</div>}
                    <div className="cr-p-sub" title={p.origen ? ORIGEN[p.origen] : undefined}>{p.direccion ? lindaDireccion(p.direccion) : 'Sin dirección cargada'}{p.detalle ? ` · ${p.detalle}` : ''}
                      {p.direccion && p.origen && ORIGEN_DUDOSO[p.origen] && <span className="cr-origen"> · {ORIGEN_DUDOSO[p.origen]}</span>}</div>
                    {p.observaciones && <div className="lg-nota"><p>{p.observaciones}</p><span className="lg-nota-pie"><span className="lg-nota-tag">Solo este lugar</span>{p.observaciones_por ? p.observaciones_por.split(' ')[0] : ''}</span></div>}
                    {/* Las anotaciones de logística de lo que se hace en la parada, con quién las escribió. */}
                    {[...new Map([...p.movimientos.flatMap((m) => m.notas ?? []), ...(p.encargos ?? []).flatMap((e) => e.anotaciones ?? [])].map((n) => [n.id, n])).values()].map((n) => <LineaNota key={n.id} n={n} />)}
                  </div>
                  <div className={`cr-eta${s.tarde ? ' tarde' : ''}`} role="group" aria-label={etaTexto} title={s.incierta ? 'Aproximada: antes hay una dirección sin ubicar, así que no cuenta ese viaje' : undefined}>
                    <b className="num" aria-hidden="true">{s.tramo.sinUbicar ? '—' : `${s.incierta ? '≈' : ''}${hhmm(atiende)}`}</b>
                    <span aria-hidden="true">{s.tramo.sinUbicar ? 'sin calcular' : s.espera > 1 ? `llega ${hhmm(s.llega)} y espera` : `${duracion(s.servicio)} en el lugar`}</span>
                  </div>
                  {p.lugar && (p.lugar.contacto || p.lugar.telefono || p.lugar.observaciones || p.lugar.coordinacion || (p.lugar.horario && !p.horario)) && (
                    <div className="cr-libreta" title={`De la libreta de direcciones: ${p.lugar.nombre}`}>
                      {p.lugar.horario && !p.horario && <span><b>Horario</b>{p.lugar.horario}</span>}
                      {(p.lugar.contacto || p.lugar.telefono) && <span><b>Contacto</b>{[p.lugar.contacto, p.lugar.telefono].filter(Boolean).join(' · ')}</span>}
                      {p.lugar.observaciones && <span><b>Ojo</b>{p.lugar.observaciones}</span>}
                      {p.lugar.coordinacion && <details><summary>Cómo se coordina la entrega</summary>{p.lugar.coordinacion}</details>}
                    </div>
                  )}
                  <div className="cr-p-movs">
                    {(p.encargos ?? []).map((e) => (
                      <div key={`e${e.id}`} className={`cr-k-X${e.estado === 'hecho' ? ' ok' : ''}`}>
                        <i /><span><b>Encargo</b><button type="button" className="cr-link" onClick={() => setEncargo(e.id)}>de {e.quien ? <QuienPidio id={e.user_id} name={e.quien} corto /> : 'alguien'}</button>
                          {e.urgente ? ' · urgente' : ''}{e.llevar.length ? ` · deja ${e.llevar.map(itemTexto).join(', ')}` : ''}{e.retirar.length ? ` · retira ${e.retirar.map(itemTexto).join(', ')}` : ''}
                          {!e.llevar.length && !e.retirar.length && e.notas ? ` · ${e.notas}` : ''}
                          {e.desde && e.desde !== datos.bases[0]?.id && e.llevar.length ? ` · está en ${datos.bases.find((b) => b.id === e.desde)?.nombre ?? e.desde}` : ''}
                          {e.hacia && e.hacia !== datos.bases[0]?.id && e.retirar.length ? ` · va a ${datos.bases.find((b) => b.id === e.hacia)?.nombre ?? e.hacia}` : ''}
                          {e.contacto ? ` · preguntar por ${e.contacto}` : ''}{e.horario ? ` · ${e.horario}` : ''}{e.estado === 'no_se_pudo' && e.motivo ? ` · no se pudo: ${e.motivo}` : ''}</span>
                      </div>
                    ))}
                    {/* Primero qué se lleva o se trae y cuánto; abajo, de qué pedido es. */}
                    {/* Una prenda en varios talles, en un renglón con sus talles (talles.ts). */}
                    {lineasMovs(p.movimientos).map((l) => { const m = l.movs[0]; return (
                      <div key={l.key} className={`cr-k-${carrilDe(m.tipo).k}${l.hecho ? ' ok' : ''}`}>
                        <i /><span><b>{carrilDe(m.tipo).uno}</b>{m.articulo ? <span className="cr-que">{l.texto}</span> : null}
                          <span className="cr-pdv">{m.record_id ? <button type="button" className="cr-link" onClick={() => onAbrir(m.record_id!)}>PDV {m.npdv}</button> : `PDV ${m.npdv ?? '—'}`}
                            {m.tipo !== 'entrega' && m.cliente ? ` · ${lindo(m.cliente)}` : ''}{m.evento ? ' · evento' : ''}</span></span>
                      </div>
                    ); })}
                  </div>
                  {p.sugerencia && (
                    <div className="cr-sugerencia">
                      <Icon name="alert" size={14} />
                      <div><b>Puede que vaya a otra dirección.</b> {p.sugerencia.motivo} El pedido dice «{p.direccion}».
                        {puede && <div className="row" style={{ marginTop: 6 }}><button type="button" className="btn sm primary" onClick={() => sugerencia(p, true)}>Usar {p.sugerencia.sugerida}</button><button type="button" className="btn sm ghost" onClick={() => sugerencia(p, false)}>Dejar la del pedido</button></div>}
                      </div>
                    </div>
                  )}
                  {puede && p.juntar?.length && !abierto ? (
                    <div className="cr-sugerencia cr-juntar">
                      <Icon name="merge" size={14} />
                      <div><b>¿Es el mismo lugar?</b> Este día también van a{p.juntar.length > 1 ? ':' : ''}
                        {p.juntar.map((j) => (
                          <div key={j.clave} className="cr-juntar-op">
                            <span><b>{lindo(j.nombre)}</b>{j.direccion ? ` · ${lindaDireccion(j.direccion)}` : ''}</span>
                            <button type="button" className="btn sm primary" disabled={ocupadoJuntar} onClick={() => juntar(encs, j.clave, `${nombre} va junto con ${lindo(j.nombre)}.`)}>Juntar</button>
                          </div>
                        ))}
                        <button type="button" className="cr-link" disabled={ocupadoJuntar} onClick={() => juntar(encs, APARTE, `${nombre} queda como otra parada.`)}>No, son lugares distintos</button>
                      </div>
                    </div>
                  ) : null}
                  {p.visita && p.visita.resultado !== 'hecho' && (
                    <div className={`cr-visita ${p.visita.resultado}`}><Icon name="alert" size={14} />
                      <span><b>{p.visita.resultado === 'salteada' ? 'El chofer la dejó para después' : MOTIVO[p.visita.motivo ?? 'otro'] ?? 'No se pudo'}</b>{p.visita.nota ? `: ${p.visita.nota}` : ''} · {p.visita.chofer ?? 'Chofer'}, {horaDe(p.visita.at)}</span></div>
                  )}
                  {tags.length > 0 && <div className="cr-p-estado">{tags}</div>}
                  {/* Las acciones: a la vista las de todos los días; lo de corregir, el expreso y pasar a otro recorrido, en «⋯». */}
                  {(puede || menu.length > 0) && (
                    <div className="cr-p-acciones">
                      {puede && <button type="button" className={`btn sm cr-hecho${todo ? ' on' : ''}`} aria-pressed={todo} disabled={marcando === p.clave}
                        title={todo ? 'Volver a pendiente' : 'Marcarla como hecha: cambia el estado de sus artículos en ClickUp'} onClick={() => marcar(p)}>
                        <Icon name="check" size={13} />{marcando === p.clave ? 'Guardando…' : todo ? 'Hecha' : 'Marcar hecha'}</button>}
                      {puede && egreso && <button type="button" className="btn sm ghost" onClick={() => imprimirRemito(p)}
                        title={p.remito ? 'Volver a imprimirlo (no gasta otro número)' : 'Imprimir el remito de traslado: todo lo que va a este impresor ese día. Se numera la primera vez.'}>
                        <Icon name="printer" size={13} />{p.remito ? <>Remito <span className="num">{p.remito}</span></> : 'Remito'}</button>}
                      {puede && <button type="button" className={`btn sm ghost${fijando === p.clave ? ' on' : ''}`} aria-expanded={fijando === p.clave} onClick={() => abrirPanel(fijando === p.clave ? null : 'hora', p.clave)}>
                        <Icon name="timer" size={13} />{p.pactada ? 'Cambiar hora' : 'Fijar hora'}</button>}
                      <span className="cr-mover">
                      <MenuParada nombre={nombre} items={menu} />
                      {puede && <span className="cr-flechas"><button type="button" aria-label={`Subir ${nombre}`} title="Subir" disabled={i === 0} onClick={() => mover(p.clave, i - 1)}>↑</button><button type="button" aria-label={`Bajar ${nombre}`} title="Bajar" disabled={i === act.paradas.length - 1} onClick={() => mover(p.clave, i + 1)}>↓</button></span>}
                      </span>
                    </div>
                  )}
                  {ubicando?.clave === p.clave && (
                    <div className="cr-ubicar">
                      <span>{p.lat == null ? <>El número <b>{i + 1}</b> está en el centro del mapa: arrastralo hasta donde queda <b>{lindaDireccion(p.direccion!)}</b>.</> : <>Arrastrá el número <b>{i + 1}</b> en el mapa hasta donde queda de verdad.</>} Vale para esta dirección en todas las rutas.{p.punto_manual ? ' Ya tiene una ubicación corregida a mano.' : ''}</span>
                      <div className="acciones">
                        <button type="button" className="btn sm ghost" onClick={() => setUbicando(null)}>Cancelar</button>
                        {p.punto_manual && <button type="button" className="btn sm ghost" onClick={() => rebuscar(p)}>Volver a buscar en el mapa</button>}
                        <button type="button" className="btn sm primary" disabled={ubicando.lat == null} onClick={() => fijar(p)}>Guardar ubicación</button>
                      </div>
                    </div>
                  )}
                  {juntando === p.clave && <JuntarCon p={p} paradas={datos.paradas} numero={numeroDe} ocupado={ocupadoJuntar} onCancelar={() => setJuntando(null)}
                    onElegir={(c) => juntar(encs, c.clave, `${nombre} va junto con ${lindo(c.nombre)}.`)} />}
                  {expresando === p.clave && <PorExpreso p={p} expresos={datos.expresos ?? []} onListo={() => { setExpresando(null); void cargar(); onCambio(); }} />}
                  {editando === p.clave && <EditarDireccion p={p} pedidos={entregas} onListo={() => { setEditando(null); void cargar(); }} />}
                  {fijando === p.clave && <FijarHora p={p} llega={s.tramo.sinUbicar ? null : s.llega} aMano={!!act.r.a_mano} onGuardar={(modo, hora, hasta) => fijarHora(p, modo, hora, hasta)} onCancelar={() => setFijando(null)} />}
                </li>
              </Fragment>
            );
          })}
          {act.paradas.length > 0 && act.fin && <Tramo t={act.sim.vuelta} falta={act.sim.vuelta.falta === 'desde' ? faltaSalida
            : { nombre: act.fin.nombre, accion: puede && act.r.fin === 'otro' ? { label: 'Cambiar el lugar', onClick: () => setPanel('fin') } : null }} />}
          {act.paradas.length > 0 && (
            <li className="cr-parada base"><div className="cr-n-col"><div className="cr-n base"><Icon name={act.vuelve ? 'home' : 'pin'} size={13} /></div></div>
              <div><div className="cr-p-nombre">{!act.fin ? 'Termina en la última parada' : act.vuelve ? `Vuelta a ${act.base?.nombre}` : `Termina en ${act.fin.nombre}`}</div>
                {act.fin && !act.vuelve && <div className="cr-p-sub">{act.fin.direccion}</div>}</div>
              <div className="cr-eta"><b className="num">{act.sim.vuelta.sinUbicar ? '—' : `${incierto ? '≈' : ''}${hhmm(act.sim.fin)}`}</b><span>{act.sim.vuelta.sinUbicar ? 'sin calcular' : act.fin ? 'llega' : 'termina'}</span></div></li>
          )}
        </ol>

        <div className="cr-ruta-lado">
          <div className="cr-mapa-caja">
            <Mapa armadas={armadas} activa={act.i} bases={[...datos.bases, ...armadas.filter((a) => a.base && a.base.id.startsWith('otro-')).map((a) => a.base!), ...armadas.filter((a) => a.fin?.id.startsWith('fin-')).map((a) => a.fin!)]} caliente={caliente} puede={puede} onPin={(c, i) => { setActiva(i); setCaliente(c); requestAnimationFrame(() => document.querySelector(`.cr-parada[data-clave="${CSS.escape(c)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }} ubicando={ubicando} onUbicar={(lat, lng) => setUbicando((u) => (u ? { ...u, lat, lng } : u))} />
            <div className="cr-mapa-pie small">
              <span>{act.real ? 'Recorrido por calles.' : 'Recorrido en línea recta (estimado).'} Tiempos con el tránsito habitual de cada hora, no el del momento.</span>
              {puede && <span>Si un punto quedó mal, corregilo desde el menú ⋯ de su parada.</span>}
              <Libreta puede={puede} onCambio={() => void cargar()} />
            </div>
          </div>
          <section className="cr-llegan cr-k-I">
            <h3>Llega al depósito <span className="muted">(no es parte del recorrido)</span></h3>
            {datos.llegan.length ? lineasMovs(datos.llegan).map((l) => { const m = l.movs[0]; return <div key={l.key} className={l.hecho ? 'ok' : ''}><i /><span><b>{m.lugar ?? 'Proveedor'}</b>PDV {m.npdv ?? '—'} {m.cliente ?? ''}{m.articulo ? ` · ${l.texto}` : ''}</span></div>; })
              : <div className="muted small">Nada para recibir este día.</div>}
          </section>
          {encargo && <EncargoModal id={encargo} onClose={() => setEncargo(null)} onListo={() => { setEncargo(null); void cargar(); onCambio(); }} />}
          {(datos.retiran?.length ?? 0) > 0 && (
            <section className="cr-llegan cr-k-E">
              <h3>Retiran en Formas <span className="muted">(lo retira el cliente: no es parte del recorrido)</span></h3>
              {lineasMovs(datos.retiran!).map((l) => { const m = l.movs[0]; return (
                <div key={l.key} className={l.hecho ? 'ok' : ''}><i /><span><b>{m.cliente ?? `PDV ${m.npdv ?? '—'}`}</b>PDV {m.npdv ?? '—'} · en {m.retira_en}
                  {m.parcial ? ' (una parte; el resto se envía)' : ''}{m.articulo ? ` · ${l.texto}` : ''}</span></div>
              ); })}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// El viaje entre dos puntos. Sin calcular (falta ubicar una de las puntas) es un aviso: dice cuál y cómo arreglarlo. El
// tránsito va en tonos neutros: es el habitual a esa hora, no un problema (el rojo queda para llegar tarde).
type Falta = { nombre: string; accion: { label: string; onClick: () => void } | null };
function Tramo({ t, falta }: { t: Simulacion['vuelta']; falta: Falta }) {
  if (t.sinUbicar) return (
    <li role="presentation" className="cr-tramo sin"><Icon name="alert" size={12} />
      <span>Sin calcular: falta ubicar <b>{lindo(falta.nombre)}</b>{falta.accion && <> · <button type="button" className="cr-link" onClick={falta.accion.onClick}>{falta.accion.label}</button></>}</span></li>
  );
  return <li role="presentation" className={`cr-tramo ${t.nivel}`}><span className="num">{duracion(t.min)} · {t.km.toFixed(1).replace('.', ',')} km{t.estimado ? ' aprox.' : ''} · tránsito habitual {t.nivel}</span></li>;
}

// «⋯» de cada parada: lo que no se usa todos los días (corregir la dirección o el punto, el expreso, cómo llegar, pasar a
// otro recorrido). Cada opción dice, si hace falta, hasta dónde llega el cambio.
type ItemMenu = { label: string; icon: string; nota?: string; grupo?: string; onClick: () => void };
function MenuParada({ nombre, items }: { nombre: string; items: ItemMenu[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const { style } = useFloating(btn, pop, open, () => setOpen(false), 360);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  if (!items.length) return null;
  // Flechas para moverse entre las opciones.
  const teclas = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ops = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])], i = ops.indexOf(document.activeElement as HTMLElement);
    ops[(i + (e.key === 'ArrowDown' ? 1 : ops.length - 1)) % ops.length]?.focus();
  };
  return (
    <span className="cr-menu" ref={ref}>
      <button ref={btn} type="button" className={`cr-menu-btn${open ? ' on' : ''}`} aria-label={`Más acciones de ${nombre}`} title="Más acciones" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="dots" size={16} /></button>
      {open && (
        <div ref={pop} className="popover cr-menu-pop" role="menu" aria-label={`Acciones de ${nombre}`} style={{ ...style, minWidth: 230 }} onKeyDown={teclas}>
          {items.map((it) => (
            <Fragment key={it.label}>
              {it.grupo && <div className="grp" role="presentation">{it.grupo}</div>}
              <button type="button" role="menuitem" className="opt" onClick={() => { setOpen(false); it.onClick(); }}>
                <Icon name={it.icon} size={15} /><span>{it.label}{it.nota && <small>{it.nota}</small>}</span></button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
}

// «Sale de → Otro lugar» (o «Termina en»): se busca en la libreta por nombre o por dirección, o se escribe la dirección a mano.
function OtroLugar({ titulo = 'De dónde sale este recorrido', onElegir, onCancelar }: { titulo?: string; onElegir: (l: { nombre: string; direccion: string }) => void; onCancelar: () => void }) {
  const [buscar, setBuscar] = useState('');
  const lugares = useLugares(buscar);
  const texto = buscar.trim();
  return (
    <div className="cr-panel" onKeyDown={alEsc(onCancelar)}>
      <label>{titulo}<input className="input sm" autoFocus value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Nombre del lugar o dirección" /></label>
      {lugares.length > 0 && <ul className="cr-lugares">{lugares.map((l) => <li key={l.id}><button type="button" onClick={() => onElegir({ nombre: l.nombre, direccion: l.direccion })}><b>{l.nombre}</b><span>{l.direccion}</span></button></li>)}</ul>}
      <div className="acciones">
        <button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button>
        {/\d/.test(texto) && texto.length > 5 && <button type="button" className="btn sm" onClick={() => onElegir({ nombre: texto, direccion: texto })}>Usar «{texto}» como dirección</button>}
      </div>
    </div>
  );
}

// Una entrega que no va directo al cliente: se lleva a un expreso. La guía se puede cargar después, cuando se despacha.
// «Juntar con otra parada…»: los encargos de esta parada van en la que se elige (de cualquier recorrido de ese día).
// Primero las que pueden ser el mismo lugar (la misma empresa o el mismo nombre); después las demás, por nombre.
function JuntarCon({ p, paradas, numero, ocupado, onElegir, onCancelar }: {
  p: Parada; paradas: Parada[]; numero: (clave: string) => string | null; ocupado: boolean; onElegir: (p: Parada) => void; onCancelar: () => void;
}) {
  const [q, setQ] = useState('');
  const sugeridas = new Set((p.juntar ?? []).map((j) => j.clave));
  const t = q.trim().toLowerCase();
  const lista = paradas.filter((x) => x.clave !== p.clave && !x.expreso && (!t || [x.nombre, x.direccion].some((v) => (v ?? '').toLowerCase().includes(t))))
    .sort((a, b) => Number(sugeridas.has(b.clave)) - Number(sugeridas.has(a.clave)) || lindo(a.nombre).localeCompare(lindo(b.nombre)));
  return (
    <div className="cr-editar" onKeyDown={alEsc(onCancelar)}>
      <span className="muted small">Si {lindo(p.nombre)} es el mismo lugar que otra parada de este día, su encargo va ahí y el chofer los hace juntos.</span>
      {paradas.length > 8 && <input className="input sm" placeholder="Buscar una parada" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar una parada" autoFocus />}
      <ul className="cr-lugares">
        {lista.map((x) => (
          <li key={x.clave}><button type="button" disabled={ocupado} onClick={() => onElegir(x)}>
            <b>{numero(x.clave) ? `${numero(x.clave)} · ` : ''}{lindo(x.nombre)}{sugeridas.has(x.clave) ? ' · puede ser el mismo lugar' : ''}</b>
            <span>{x.direccion ? lindaDireccion(x.direccion) : 'Sin dirección'}{x.movimientos.length ? ` · ${x.movimientos.length === 1 ? carrilDe(x.movimientos[0].tipo).uno.toLowerCase() : `${x.movimientos.length} movimientos`}` : ''}</span>
          </button></li>
        ))}
        {!lista.length && <li className="muted small" style={{ padding: '6px 9px' }}>Ninguna parada coincide.</li>}
      </ul>
      <div className="acciones"><button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button></div>
    </div>
  );
}

function PorExpreso({ p, expresos, onListo }: { p: Parada; expresos: Array<{ id: number; nombre: string; direccion: string | null }>; onListo: () => void }) {
  const toast = useToast();
  const [expreso, setExpreso] = useState(p.expreso?.nombre ?? '');
  const [guia, setGuia] = useState(p.expreso?.guia ?? '');
  const [nuevo, setNuevo] = useState(false);
  const [lista, setLista] = useState(expresos);
  const guardar = async (nombre: string) => {
    try {
      await http('PUT', '/cronograma/expreso', { clave: p.clave, record_id: p.record_id, expreso: nombre, guia });
      toast(nombre ? `Va por ${nombre}${guia ? `, guía ${guia}` : ''}.` : 'Vuelve a ir directo al cliente.');
      onListo();
    } catch (e) { toast((e as Error).message, true); }
  };
  if (nuevo) return <div className="cr-editar"><NuevoTransportista soloExpreso onCancelar={() => setNuevo(false)} onListo={(n) => { setLista((l) => (l.some((x) => x.nombre === n) ? l : [...l, { id: -Date.now(), nombre: n, direccion: null }])); setExpreso(n); setNuevo(false); }} /></div>;
  return (
    <form className="cr-editar" onKeyDown={alEsc(onListo)} onSubmit={(e) => { e.preventDefault(); if (expreso) void guardar(expreso); }}>
      <label>Expreso
        <Select className="input sm" value={expreso} placeholder="Elegí un expreso" aria-label="Expreso" onChange={(e) => { if (e.target.value === '+') setNuevo(true); else setExpreso(e.target.value); }}>
          {[...new Set([...lista.map((x) => x.nombre), ...(expreso ? [expreso] : [])])].map((n) => <option key={n} value={n}>{n}</option>)}
          <option value="+"><span className="select-nuevo"><Icon name="plus" size={13} />Agregar expreso…</span></option>
        </Select></label>
      <label>Número de guía (se puede cargar después)<input className="input sm" value={guia} onChange={(e) => setGuia(e.target.value)} maxLength={80} /></label>
      <div className="acciones">
        <button type="button" className="btn sm ghost" onClick={onListo}>Cancelar</button>
        {p.expreso && <button type="button" className="btn sm ghost" onClick={() => guardar('')}>Va directo al cliente</button>}
        <button type="submit" className="btn sm primary" disabled={!expreso}>Guardar</button>
      </div>
    </form>
  );
}

// Fijar la hora de una parada: «a las 12:00» (llega entre 15 minutos antes y 15 después), «antes de las…» o «desde las…».
function FijarHora({ p, llega, aMano, onGuardar, onCancelar }: { p: Parada; llega: number | null; aMano: boolean; onGuardar: (modo: ModoHora | null, hora: string, hasta: string) => Promise<void>; onCancelar: () => void }) {
  const dos = (x: number) => { const m = Math.round(x); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const [modo, setModo] = useState<ModoHora>(p.pactada?.modo ?? 'a_las');
  const [hora, setHora] = useState(p.pactada ? dos(p.pactada.min) : llega != null ? dos(Math.round(llega / 15) * 15) : '12:00');
  const [hasta, setHasta] = useState(p.pactada?.hasta != null ? dos(p.pactada.hasta) : '13:00');
  const [ocupado, setOcupado] = useState(false);
  const ok = !!hora && (modo !== 'entre' || (!!hasta && hasta > hora));
  const guardar = async (m: ModoHora | null) => { setOcupado(true); await onGuardar(m, hora, hasta); setOcupado(false); };
  return (
    <form className="cr-editar cr-fijar" onKeyDown={alEsc(onCancelar)} onSubmit={(e) => { e.preventDefault(); if (ok) void guardar(modo); }}>
      <CamposHora modo={modo} hora={hora} hasta={hasta} onModo={setModo} onHora={setHora} onHasta={setHasta} />
      <span className="muted small">{ayudaHora(modo)} El recorrido se ordena solo para cumplirla, junto con las demás horas fijadas.</span>
      {aMano && <span className="cr-ojo small"><Icon name="alert" size={12} />Este recorrido está ordenado a mano: al guardar se vuelve a ordenar solo y se pierde ese orden.</span>}
      <div className="acciones">
        <button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button>
        {p.pactada && <button type="button" className="btn sm ghost" disabled={ocupado} onClick={() => guardar(null)}>Sacar la hora</button>}
        <button type="submit" className="btn sm primary" disabled={ocupado || !ok}>Fijar la hora</button>
      </div>
    </form>
  );
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

// ---------- El mapa ----------

type Armada = { r: Recorrido; i: number; base: BaseGeo | null; fin: BaseGeo | null; paradas: Parada[]; real?: Real; sim: Simulacion; color: string };
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
    const usadas = new Set(armadas.filter((a) => a.paradas.length).flatMap((a) => [a.base?.id, a.fin?.id]));
    for (const b of bases) {
      if (b.lat == null || b.lng == null || (!usadas.has(b.id) && usadas.size)) continue;
      todos.push([b.lat, b.lng]);
      // Donde sale (o vuelve), la casita; donde termina, si es otro lugar, la bandera.
      L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'cr-pin-wrap', html: `<span class="cr-pin base">${b.id.startsWith('fin-') ? '⚑' : '⌂'}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 500, keyboard: false })
        .bindTooltip(esc(b.nombre), { direction: 'top', offset: [0, -14] }).addTo(g);
    }
    // Primero los recorridos que no se están mirando, apagados; el activo arriba.
    for (const a of [...armadas].sort((x, y) => Number(x.i === activa) - Number(y.i === activa))) {
      const act = a.i === activa, b = a.base && a.base.lat != null ? [a.base.lat, a.base.lng] as [number, number] : null;
      const f = a.fin && a.fin.lat != null ? [a.fin.lat, a.fin.lng] as [number, number] : null;
      const puntos = a.paradas.filter((p) => p.lat != null).map((p) => [p.lat!, p.lng!] as [number, number]);
      const linea = a.real?.linea ?? (puntos.length && b ? [b, ...puntos, ...(f ? [f] : [])] : puntos);
      if (linea.length > 1) {
        if (act) L.polyline(linea, { color: '#ffffff', weight: 8, opacity: 0.9, interactive: false }).addTo(g);
        L.polyline(linea, { color: a.color, weight: act ? 4.5 : 3, opacity: act ? 0.95 : 0.4, dashArray: a.real ? undefined : '2 9', lineCap: 'round', interactive: false }).addTo(g);
      }
      a.paradas.forEach((p, i) => {
        // Los números no se arrastran, salvo el de la parada a la que se le está corrigiendo la ubicación. Una que no se
        // encontró en el mapa aparece en el centro para llevarla a su lugar.
        const mio = ubicando?.clave === p.clave;
        if ((p.lat == null || p.lng == null) && !mio) return;
        if (p.lat != null && p.lng != null) todos.push([p.lat, p.lng]);
        const s = a.sim.paradas[i], hecha = hechaParada(p);
        const donde: L.LatLngExpression = mio && ubicando.lat != null && ubicando.lng != null ? [ubicando.lat, ubicando.lng] : p.lat != null && p.lng != null ? [p.lat, p.lng] : m.getCenter();
        const mk = L.marker(donde, {
          icon: L.divIcon({ className: 'cr-pin-wrap', html: `<span class="cr-pin${act ? '' : ' apagado'}${mio ? ' ubicando' : ''}${hecha ? ' hecha' : ''}${s.tarde || (p.visita && p.visita.resultado === 'no_se_pudo') ? ' tarde' : ''}" style="--c:${a.color}">${hecha ? '✓' : i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
          zIndexOffset: mio ? 4000 : act ? 1000 : 0, draggable: puede && mio, keyboard: false,
        }).bindTooltip(esc(s.tramo.sinUbicar ? p.nombre : `${p.nombre} · ${hhmm(s.llega + (s.espera > 1 ? s.espera : 0))}`), { direction: 'top', offset: [0, -14] }).addTo(g);
        pines.current.set(p.clave, mk);
        mk.on('click', () => cb.current.onPin(p.clave, a.i));
        mk.on('dragend', () => { const ll = mk.getLatLng(); cb.current.onUbicar(ll.lat, ll.lng); });
      });
    }
    // Se vuelve a encuadrar solo cuando cambian los puntos, no al reordenar.
    const firma = armadas.flatMap((a) => a.paradas.filter((p) => p.lat != null).map((p) => p.clave)).sort().join('|');
    if (todos.length && firma !== encuadre.current) { encuadre.current = firma; m.fitBounds(L.latLngBounds(todos).pad(0.15), { maxZoom: 15, animate: false }); }
  }, [armadas, activa, bases, puede, ubicando]);
  // La parada sobre la que está el mouse: se resalta su pin sin rehacer el mapa.
  useEffect(() => {
    for (const [clave, mk] of pines.current) { mk.getElement()?.querySelector('.cr-pin')?.classList.toggle('caliente', clave === caliente); mk.setZIndexOffset(clave === ubicando?.clave ? 4000 : clave === caliente ? 3000 : 1000); }
  }, [caliente, armadas, activa]);

  return <div ref={caja} className="cr-mapa" role="application" aria-label="Mapa del recorrido" />;
}

// La camioneta del chofer elegido, al lado del desplegable: la foto, el modelo y cuánto entra (pantalla Choferes).
function VehiculoChip({ v }: { v: Vehiculo }) {
  const foto = fotoVehiculo(v), cap = textoCapacidad(v);
  return (
    <span className="cr-vehiculo" title={[v.modelo, v.tamano, cap].filter(Boolean).join(' · ') || 'Camioneta'}>
      {foto ? <img src={foto} alt="" /> : <Icon name="truck" size={14} />}
      <span>{v.modelo || v.tamano || 'Camioneta'}{!tieneCapacidad(v) && <em> · sin capacidad</em>}</span>
    </span>
  );
}

// El aviso de la carga (pedido de Rodrigo del 20/11/2026): si en algún momento del recorrido lleva más de lo que entra en la
// camioneta de su chofer (cajas combinadas de 40×30 y 60×40), o casi. Si hay bultos pero la camioneta no tiene cargado
// cuánto entra, lo dice para que la carguen en Choferes. Los bultos de otra medida no entran en la cuenta.
function AvisoCarga({ a }: { a: { r: Recorrido; paradas: Parada[]; vehiculo: Vehiculo | null; carga: Carga } }) {
  const c = a.carga, estado = estadoCarga(c), quien = a.r.chofer;
  if (!totalBultos(c.total) || !quien) return null;
  const otros = c.pico.otros === 1 ? ' Además va 1 bulto de otra medida, que no entra en la cuenta.'
    : c.pico.otros > 1 ? ` Además van ${textoBultos(c.pico.otros)} de otra medida, que no entran en la cuenta.` : '';
  if (estado == null) {
    return <div className="aviso info small">Hay bultos anotados en este recorrido. Para saber si entran, cargá en Choferes cuántas cajas entran en la camioneta de {quien}.</div>;
  }
  if (estado === 'ok') return null;
  const cuando = c.donde < 0 ? 'al salir' : `después de ${lindo(a.paradas[c.donde]?.nombre ?? 'una parada')}`;
  // «56 de 40×30 y 20 de 60×40».
  const cajas = desgloseBultos({ ...c.pico, otros: 0 }).replace(' · ', ' y ');
  const camioneta = `la camioneta de ${quien}${a.vehiculo?.modelo ? ` (${a.vehiculo.modelo})` : ''}`;
  return estado === 'excede'
    ? <div className="aviso bad small"><b>No entra en {camioneta}.</b> {cuando[0].toUpperCase() + cuando.slice(1)} lleva {cajas}: el {porciento(c.ocupacion!)} de lo que entra ({textoCapacidad(a.vehiculo!).replace(/^Entran/, 'entran')}). Pasá alguna parada a otro recorrido o revisá los bultos.{otros}</div>
    : <div className="aviso warn small">Va casi llena: {cuando} lleva {cajas}, el {porciento(c.ocupacion!)} de lo que entra en {camioneta}.{otros}</div>;
}
