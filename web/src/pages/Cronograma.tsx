import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, qs, useToast, Icon, unidadDeTexto } from '../lib';
import { SelectorFecha } from '../Fecha';
import { RecordPreview } from './RecordPage';
import { Avatar, EditarEnLinea, Modal, QuienPidio, UnidadBadge, UserChip, alEsc } from '../components';
import { Pop, UnidadFilter } from './QuickFilters';
import { ICONO_ESTADO, NOMBRE_ROL, despachoTarjeta, etiquetaEstado, faltaTexto, nombreEstado, riesgo, type Control, type DespachoMov, type DespachoTarjeta, type EstadoDespacho, type Riesgo, type Rol } from '../despacho';
import { Select } from '../Select';
import { FotoProducto } from './Produccion';
import { MEDIDAS, SIN_BULTOS, desgloseBultos, sumarBultos, textoBultos, totalBultos, type Bultos } from '../bultos';
import { BarraPie } from '../vistas';
import { seguimientoExpreso } from '../expresos';
import { LogoProveedor, marcaProveedor } from '../proveedores';
import { EncargoModal, ESTADO as ESTADO_ENC, abrirRemitoEgreso, itemTexto, type Encargo } from './Recorridos';
import { EditarDireccion, lindaDireccion } from './DireccionParada';

// Cronograma (pedido de Rodrigo del 12/11/2026): reemplaza la planilla «Cronograma Semanal» de Logística. Cada día con
// sus entregas, ingresos, retiros y egresos, armados solos con las fechas de cada artículo en ClickUp. Arrastrar una
// tarjeta a otro día cambia la fecha en ClickUp; el círculo la marca como hecha (y el artículo cambia de estado). Arriba,
// la barra de semanas para ir a cualquier semana, pasada o futura, y ver cuánto queda pendiente. «Ruta del día» arma el
// recorrido en el mapa (CronogramaRuta.tsx). Ver docs/CRONOGRAMA.md.

import { LineaNota, NotasLogistica, type NotaLogistica } from '../NotasLogistica';
import type { ModoHora } from '../ruta';
import { juntarTalles, textoTalles } from '../talles';
const CronogramaRuta = lazy(() => import('./CronogramaRuta'));

export type Tipo = 'entrega' | 'ingreso' | 'retiro_proveedor' | 'egreso' | 'retiro_impresor' | 'ingreso_impresor';
// Los que llegan solos al depósito (los trae el proveedor o el impresor): no son una parada de ningún recorrido.
export const llega = (t: Tipo) => t === 'ingreso' || t === 'ingreso_impresor';
export interface Mov {
  id: string; tipo: Tipo; fecha: string; task_id: string; pdv_task: string; npdv: string | null; cliente: string | null; unidad: string | null;
  record_id: number | null; articulo: string; cantidad: number | null; estado: string; lugar: string | null; company_id: number | null;
  hecho: boolean; hecho_por: number | null; evento: boolean; avisos: string[]; url: string | null; dominio?: string | null;
  expreso?: { nombre: string; guia: string | null } | null;
  chofer?: string | null;     // quién hace la parada ese día (el chofer o el expreso de su recorrido); no viene en los ingresos
  retira_en?: string | null;  // lo retira el cliente en Formas: no es parada de nadie
  hora?: string | null;       // la hora fijada a mano en su parada, en la ruta del día («A las 12:00»)
  parada?: string;            // la clave de su parada en la ruta del día
  colgado?: { motivo: string; at: string; por: string | null; fecha: string } | null;   // en la columna «Colgados»
  // La entrega en un lugar de un pedido que va a varios: la dirección del pedido, cómo se llama y si la cantidad es la de ese lugar.
  dir?: number | null; sitio?: string | null; repartida?: boolean;
  notas?: NotaLogistica[];    // las anotaciones de logística: las de este movimiento y las de siempre de ese lugar
  enviado?: { cantidad: number; motivo: string | null; por: string | null } | null;   // lo que realmente se mandó o llegó (demasía)
  despacho?: DespachoMov;     // si está listo para salir, qué falta y a quién le toca (despacho.ts)
  bultos?: Bultos | null;     // los bultos que anotó Logística, por medida; la tarjeta muestra la suma de los suyos (cronograma.ts, guardarBultos)
  foto?: string | null;       // la foto del producto, la misma que en el pedido y en Producción
  // Una prenda en varios talles es un producto (talles.ts): su talle, la clave del producto y el nombre sin el talle. La
  // tarjeta los muestra en un renglón, con el desglose de talles.
  talle?: string | null; grupo?: string | null; producto?: string | null;
}
export interface Nota { id: number; fecha: string; texto: string; hecho: number }
export interface SinFecha { task_id: string; pdv_task: string; npdv: string | null; cliente: string | null; unidad: string | null; record_id: number | null; articulo: string; cantidad: number | null;
  talle?: string | null; grupo?: string | null; producto?: string | null }
interface DiaResumen { total: number; pendientes: number; atrasados: number }
export interface Vista {
  hoy: string; desde: string; hasta: string; movimientos: Mov[]; notas: Nota[]; feriados: Record<string, string>; dias: Record<string, DiaResumen>;
  sin_fecha: SinFecha[]; puede_editar: boolean; choferes?: string[]; expresos?: string[];
  encargos?: Encargo[];   // lo que pidió alguien al recorrido de cada día (Recorridos)
  colgados?: Mov[];       // lo que no se pudo hacer y quedó pendiente, con su motivo: la misma columna en todas las semanas
}
// La columna de lo colgado, como destino del arrastre (no es un día).
const COLGADOS = 'colgados';
const MOTIVOS_COLGADO = ['El cliente todavía no abonó el total', 'Fueron y nadie recibió', 'Falta un documento para entregar', 'El cliente pidió reprogramar', 'No estaba listo'];

// La dirección de cada parada de la semana (GET /cronograma/direcciones), por `fecha|clave de la parada`: la misma que usa
// la Ruta del día y si está ubicada en el mapa (pedido de Rodrigo del 18/11/2026).
export interface DirParada {
  direccion: string | null; origen: string | null; estado: 'ok' | 'no_encontrada' | 'buscando' | 'sin_direccion';
  nombre: string; record_ids: number[]; company_id: number | null; horario: string | null; expreso: boolean; otras: number;
  detalle: string | null; observaciones: string | null;   // piso, depto, puerta, unidad y las observaciones de entrega
  sitios?: string[];   // un pedido que va a varias direcciones: cada lugar con lo que va ahí («Central: 250»)
}

export const CARRILES: Array<{ k: 'E' | 'I' | 'R' | 'G'; nombre: string; uno: string; tipos: Tipo[]; ayuda: string }> = [
  { k: 'E', nombre: 'Entregas', uno: 'Entrega', tipos: ['entrega'], ayuda: 'Al cliente' },
  { k: 'I', nombre: 'Ingresos', uno: 'Ingreso', tipos: ['ingreso', 'ingreso_impresor'], ayuda: 'Lo trae el proveedor o el impresor' },
  { k: 'R', nombre: 'Retiros', uno: 'Retiro', tipos: ['retiro_proveedor', 'retiro_impresor'], ayuda: 'Del proveedor o del impresor' },
  { k: 'G', nombre: 'Egresos', uno: 'Egreso', tipos: ['egreso'], ayuda: 'Va al impresor' },
];
export const carrilDe = (t: Tipo) => CARRILES.find((c) => c.tipos.includes(t))!;

// Fechas AAAA-MM-DD, siempre al mediodía para que no cambien de día.
const D = (iso: string) => new Date(`${iso}T12:00:00`);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const sumar = (dia: string, n: number) => { const d = D(dia); d.setDate(d.getDate() + n); return iso(d); };
export const lunesDe = (dia: string) => sumar(dia, -((D(dia).getDay() + 6) % 7));
const hoyIso = () => iso(new Date());
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const diaCorto = (dia: string) => `${DIAS[D(dia).getDay()].slice(0, 3).toLowerCase()} ${D(dia).getDate()}/${D(dia).getMonth() + 1}`;
export const diaLargo = (dia: string) => `${DIAS[D(dia).getDay()]} ${D(dia).getDate()} de ${MESES[D(dia).getMonth()].toLowerCase()}`;
const num = new Intl.NumberFormat('es-AR');
// Los nombres vienen de ClickUp y Finnegans todo en mayúsculas («SAMSUNG ELECTRONICS ARGENTINA S.A.»): se muestran como
// se escriben («Samsung Electronics Argentina S.A.»). Lo que ya trae minúsculas se deja como está.
const SIGLA = /^(s\.?a\.?(s|u)?|s\.?r\.?l\.?|s\.?a\.?i\.?c\.?(i|f)?\.?|s\.?h\.?|cdo|ypf|tgn|tgs|kcc|bs|as|pdv|ii|iii|[a-z])$/i;
const MENOR = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'para', 'con', 'en', 'el', 'a']);
export function lindo(s: string | null | undefined): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || /[a-záéíóúñ]/.test(t)) return t;
  return t.split(' ').map((w, i) => {
    const m = w.toLowerCase();
    if (SIGLA.test(m.replace(/[(),]/g, ''))) return w;
    if (i > 0 && MENOR.has(m)) return m;
    return m.replace(/(^|[(/\-.'"«])([a-záéíóúñ])/g, (_, a: string, b: string) => a + b.toUpperCase());
  }).join(' ');
}
// Con la cantidad que realmente va, si se anotó una demasía.
// Lo que se le manda al servidor para mover, marcar o colgar: los artículos y, en paralelo, de qué lugar es cada entrega
// (en un pedido que va a varios lugares).
export const idsYLugares = (movs: Array<Pick<Mov, 'task_id' | 'dir'>>) => ({ ids: movs.map((m) => m.task_id), dirs: movs.map((m) => m.dir ?? null) });
export const cantidad = (m: { cantidad: number | null; articulo: string; enviado?: { cantidad: number } | null }) => { const c = m.enviado?.cantidad ?? m.cantidad; return [c != null ? num.format(c) : '', m.articulo].filter(Boolean).join(' '); };

// Una tarjeta: los artículos de un PDV que tienen el mismo movimiento, el mismo día, en el mismo lugar.
// `parada`: va en la ruta del día (no es un ingreso ni lo retira el cliente), así que se le elige el chofer.
export interface Tarjeta { key: string; tipo: Tipo; fecha: string; titulo: string; pdv: string; para: string; movs: Mov[]; hecho: boolean; evento: boolean; avisos: string[]; record_id: number | null; dominio: string | null; crudo: string;
  parada: boolean; chofer: string | null; retira_en: string | null }
export function tarjetas(movs: Mov[]): Tarjeta[] {
  const m = new Map<string, Tarjeta>();
  for (const x of movs) {
    const key = `${x.fecha}|${x.tipo}|${x.pdv_task}|${x.lugar ?? ''}`;
    let t = m.get(key);
    if (!t) {
      const pdv = `PDV ${x.npdv ?? '—'}`;
      // En las entregas la tarjeta es del cliente; en lo demás, del proveedor o impresor, y dice para qué PDV y cliente es.
      const entrega = x.tipo === 'entrega';
      const crudo = (entrega ? x.cliente : x.lugar) ?? '';
      t = { key, tipo: x.tipo, fecha: x.fecha, pdv, para: entrega ? '' : lindo(x.cliente), movs: [], hecho: true, evento: false, avisos: [], record_id: x.record_id, dominio: x.dominio ?? null, crudo,
        parada: !llega(x.tipo) && !x.retira_en, chofer: x.chofer ?? null, retira_en: x.retira_en ?? null,
        titulo: lindo(crudo) || (entrega ? pdv : x.tipo === 'egreso' || x.tipo === 'retiro_impresor' || x.tipo === 'ingreso_impresor' ? 'Sin impresor' : 'Sin proveedor') };
      m.set(key, t);
    }
    t.movs.push(x);
    t.hecho = t.hecho && x.hecho;
    t.evento = t.evento || x.evento;
    for (const a of x.avisos) if (!t.avisos.includes(a)) t.avisos.push(a);
  }
  // Primero lo pendiente y, adentro, los eventos; lo hecho al final.
  return [...m.values()].sort((a, b) => Number(a.hecho) - Number(b.hecho) || Number(b.evento) - Number(a.evento) || a.titulo.localeCompare(b.titulo));
}
const coincide = (m: { npdv: string | null; cliente: string | null; articulo: string; lugar?: string | null }, q: string) =>
  !q || [m.npdv, m.cliente, m.articulo, m.lugar].some((x) => (x ?? '').toLowerCase().includes(q));
const coincideEnc = (e: Encargo, q: string) => !q || [e.destino, e.quien, e.notas, ...e.llevar.map(itemTexto), ...e.retirar.map(itemTexto)].some((x) => (x ?? '').toLowerCase().includes(q));

export default function CronogramaPage() {
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const semana = lunesDe(/^\d{4}-\d{2}-\d{2}$/.test(sp.get('semana') ?? '') ? sp.get('semana')! : hoyIso());
  // Semana, un día expandido (pedido de Rodrigo del 20/11/2026) o la ruta del día en el mapa.
  const vista: 'semana' | 'dia' | 'ruta' = sp.get('vista') === 'ruta' ? 'ruta' : sp.get('vista') === 'dia' ? 'dia' : 'semana';
  const [centro, setCentro] = useState(semana);   // la semana del medio de la barra
  const [datos, setDatos] = useState<Vista | null>(null);
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');
  const [unidades, setUnidades] = useState<string[]>([]);   // filtro por unidad de negocio (claves: shop, corporate, noestres)
  const deUnidad = (u: string | null) => !unidades.length || unidades.includes(unidadDeTexto(u) ?? '');
  const [pendientes, setPendientes] = useState(false);
  const [toca, setToca] = useState<Rol[]>([]);   // «Le toca a»: solo las tarjetas de Producción, Ventas, el proveedor o Logística
  // Qué movimientos se ven (pedido de Rodrigo del 20/11/2026): las claves de CARRILES y «X», los encargos. Vacío, todos.
  const [tipos, setTipos] = useState<string[]>([]);
  const deTipo = (t: Tipo) => !tipos.length || tipos.includes(carrilDe(t).k);
  const [preview, setPreview] = useState<number | null>(null);
  const [previewT, setPreviewT] = useState<Tarjeta | null>(null);   // la tarjeta desde la que se abrió (su despacho va arriba)
  const abrirTarjeta = (t: Tarjeta) => { if (t.record_id) { setPreview(t.record_id); setPreviewT(t); } };
  const [nuevoPara, setNuevoPara] = useState<Tarjeta | Encargo | null>(null);   // agregar un chofer o expreso a la lista, desde una tarjeta
  const [encargo, setEncargo] = useState<number | null>(null);   // el encargo abierto
  const [sobre, setSobre] = useState<string | null>(null);   // el día sobre el que se está arrastrando
  const [colgando, setColgando] = useState<{ ids: string[]; dirs?: Array<number | null>; tipo: Tipo; pdv: string } | null>(null);   // lo que se soltó en «Colgados»: falta el motivo
  const [anotando, setAnotando] = useState<Tarjeta | null>(null);   // las anotaciones de logística de una tarjeta
  const [anotandoEnc, setAnotandoEnc] = useState<Encargo | null>(null);   // las de siempre del destino de un encargo
  const [horaDe, setHoraDe] = useState<Tarjeta | null>(null);      // fijar la hora (o el rango) de la parada de una tarjeta
  const [enviando, setEnviando] = useState<Mov | null>(null);      // la cantidad que realmente se mandó o llegó
  const arrastre = useRef<{ ids: string[]; dirs?: Array<number | null>; tipo: Tipo | 'encargo'; de: string | null; pdv: string } | null>(null);
  const pedido = useRef(0);
  // Las direcciones de las paradas de la semana: llegan después de la semana (no la demoran) y, mientras el servidor
  // busca en el mapa las que faltan, se vuelven a pedir.
  const [dirs, setDirs] = useState<Record<string, DirParada>>({});
  const [buscandoDirs, setBuscandoDirs] = useState(false);   // el servidor sigue buscando en el mapa: la ruedita gira
  const [corrigiendo, setCorrigiendo] = useState<{ k: string; d: DirParada } | null>(null);
  const pedidoDirs = useRef(0);
  const sondeoDirs = useRef<number>();

  const ir = (cambios: Record<string, string | null>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(cambios)) { if (v == null) n.delete(k); else n.set(k, v); } return n; }, { replace: true });
  const dia = (() => { const d = sp.get('dia'); return d && d >= semana && d <= sumar(semana, 6) ? d : datos && datos.hoy >= semana && datos.hoy <= sumar(semana, 4) ? datos.hoy : semana; })();

  const cargar = useCallback(async () => {
    const n = ++pedido.current;
    try {
      const v = await http<Vista>('GET', `/cronograma${qs({ desde: semana, hasta: sumar(semana, 6), rd: sumar(centro, -42), rh: sumar(centro, 48) })}`);
      if (n === pedido.current) { setDatos(v); setError(''); }
    } catch (e) { if (n === pedido.current) setError((e as Error).message); }
  }, [semana, centro]);
  useEffect(() => { void cargar(); }, [cargar]);
  const cargarDirs = useCallback(async (intento = 0) => {
    const n = ++pedidoDirs.current;
    window.clearTimeout(sondeoDirs.current);
    try {
      const r = await http<{ direcciones: Record<string, DirParada>; buscando: number }>('GET', `/cronograma/direcciones${qs({ desde: semana, hasta: sumar(semana, 6) })}`);
      if (n !== pedidoDirs.current) return;
      setDirs(r.direcciones);
      setBuscandoDirs(r.buscando > 0 && intento < 10);
      if (r.buscando > 0 && intento < 10) sondeoDirs.current = window.setTimeout(() => { if (n === pedidoDirs.current) void cargarDirs(intento + 1); }, 2500);
    } catch { /* sin direcciones: las tarjetas se ven igual */ }
  }, [semana]);
  // Se piden cuando llega (o cambia) la semana: un chofer, un día o una dirección nuevos cambian las paradas.
  useEffect(() => { if (datos?.desde === semana && vista !== 'ruta') void cargarDirs(); }, [datos, semana, vista, cargarDirs]);
  useEffect(() => () => { pedidoDirs.current++; window.clearTimeout(sondeoDirs.current); }, []);
  // El día expandido: si las pestañas de los días no entran (en el celular), la del día elegido queda a la vista. Se corre
  // solo la fila de pestañas, no la página.
  useEffect(() => {
    if (vista !== 'dia') return;
    const nav = document.querySelector<HTMLElement>('.cr-diax-dias'), on = nav?.querySelector<HTMLElement>('.cr-diax-tab.on');
    if (!nav || !on) return;
    const n = nav.getBoundingClientRect(), o = on.getBoundingClientRect();
    if (o.left < n.left || o.right > n.right) nav.scrollLeft += o.left - n.left - (n.width - o.width) / 2;
  }, [vista, dia, datos]);
  // Lo que cambian en ClickUp llega cada 10 minutos: la pantalla se pone al día sola.
  useEffect(() => { const t = window.setInterval(() => { if (!document.hidden && !arrastre.current) void cargar(); }, 120_000); return () => window.clearInterval(t); }, [cargar]);

  const v = datos && datos.desde === semana ? datos : null;
  const q = buscar.trim().toLowerCase();
  // Lo de la semana con todos los filtros menos el del tipo (para contar cuántos hay de cada tipo) y con ese también.
  const sinTipo = useMemo(() => (v?.movimientos ?? []).filter((m) => coincide(m, q) && deUnidad(m.unidad) && (!pendientes || !m.hecho)), [v, q, unidades, pendientes]);   // eslint-disable-line react-hooks/exhaustive-deps
  const movs = useMemo(() => sinTipo.filter((m) => deTipo(m.tipo)), [sinTipo, tipos]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Los encargos no son de una unidad de negocio: con ese filtro no se ven.
  const encsSinTipo = useMemo(() => (v?.encargos ?? []).filter((e) => coincideEnc(e, q) && !unidades.length && (!pendientes || e.estado !== 'hecho')), [v, q, unidades, pendientes]);
  const encs = !tipos.length || tipos.includes('X') ? encsSinTipo : [];
  // Sábado y domingo se ven si tienen algo: un movimiento, un encargo, una nota o un feriado.
  const finDeSemana = [5, 6].filter((i) => { const d = sumar(semana, i); return movs.some((m) => m.fecha === d) || encs.some((e) => e.fecha === d) || !!v?.notas.some((n) => n.fecha === d); });
  const dias = [0, 1, 2, 3, 4, ...finDeSemana].map((i) => sumar(semana, i));
  const puede = !!v?.puede_editar;
  const colgSinTipo = useMemo(() => (v?.colgados ?? []).filter((m) => coincide(m, q) && deUnidad(m.unidad)), [v, q, unidades]);   // eslint-disable-line react-hooks/exhaustive-deps
  const colg = useMemo(() => colgSinTipo.filter((m) => deTipo(m.tipo)), [colgSinTipo, tipos]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Estados de despacho: la dirección de la parada de una tarjeta (llega aparte) y a quién le toca cada una.
  const dirDe = (t: Tarjeta) => (t.parada && t.movs[0]?.parada ? dirs[`${t.fecha}|${t.movs[0].parada}`] : undefined);
  const pasaToca = (t: Tarjeta) => { const r = despachoTarjeta(t, dirDe(t))?.quien; return !toca.length || (!!r && toca.includes(r)); };
  // Cuántas tarjetas hay de cada tipo (de la semana y colgadas), con los demás filtros puestos.
  const porTipo = useMemo(() => {
    const n: Record<string, number> = { X: encsSinTipo.length };
    for (const t of [...tarjetas(sinTipo), ...tarjetas(colgSinTipo).map((x) => ({ ...x, parada: false }))]) if (pasaToca(t)) { const k = carrilDe(t.tipo).k; n[k] = (n[k] ?? 0) + 1; }
    return n;
  }, [sinTipo, colgSinTipo, encsSinTipo, toca, dirs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const porRol = useMemo(() => {
    const n: Partial<Record<Rol, number>> = {};
    for (const t of [...tarjetas(movs), ...tarjetas(colg).map((x) => ({ ...x, parada: false }))]) {
      const r = despachoTarjeta(t, t.parada && t.movs[0]?.parada ? dirs[`${t.fecha}|${t.movs[0].parada}`] : undefined)?.quien;
      if (r) n[r] = (n[r] ?? 0) + 1;
    }
    return n;
  }, [movs, colg, dirs]);

  // Lo de un día, con los filtros puestos: sus movimientos, encargos y notas, y cuántos faltan (en la semana y en el día).
  const delDiaDe = (d: string) => {
    const movsDia = movs.filter((m) => m.fecha === d), encDia = encs.filter((e) => e.fecha === d), notas = v?.notas.filter((n) => n.fecha === d) ?? [];
    const pend = movsDia.filter((m) => !m.hecho).length + encDia.filter((e) => e.estado !== 'hecho').length, cuantos = movsDia.length + encDia.length;
    const atrasado = pend > 0 && d < (v?.hoy ?? '');
    const texto = cuantos ? (pend ? `${pend} ${atrasado ? `atrasado${pend === 1 ? '' : 's'}` : `pendiente${pend === 1 ? '' : 's'}`} de ${cuantos}` : `${cuantos} hechos`) : 'Sin movimientos';
    return { movs: movsDia, encs: encDia, notas, pend, cuantos, atrasado, texto };
  };

  async function mover(ids: string[], tipo: Tipo, fecha: string, pdv: string, dirs?: Array<number | null>) {
    // Es este movimiento: el del artículo o, en un pedido que va a varios lugares, la entrega de ese lugar.
    const es = (m: Mov) => m.tipo === tipo && ids.some((id, i) => id === m.task_id && (dirs?.[i] ?? null) === (m.dir ?? null));
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map((m) => (es(m) ? { ...m, fecha } : m)), sin_fecha: d.sin_fecha.filter((s) => !ids.includes(s.task_id)),
      colgados: (d.colgados ?? []).filter((m) => !es(m)) });
    try {
      for (let i = 0; i < ids.length; i += 25) await http('POST', '/cronograma/mover', { ids: ids.slice(i, i + 25), dirs: dirs?.slice(i, i + 25), tipo, fecha });
      toast(`${pdv}: ${carrilDe(tipo).uno.toLowerCase()} pasó al ${diaCorto(fecha)}. Ya está en ClickUp.`);
    } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  // Deja un movimiento en «Colgados», con el motivo: sale de su día y al responsable del pedido le llega el aviso.
  async function colgar(a: { ids: string[]; dirs?: Array<number | null>; tipo: Tipo; pdv: string }, motivo: string) {
    setColgando(null);
    setDatos((d) => d && { ...d, movimientos: d.movimientos.filter((m) => !(m.tipo === a.tipo && a.ids.some((id, i) => id === m.task_id && (a.dirs?.[i] ?? null) === (m.dir ?? null)))) });
    try {
      const avisados = new Set<string>();
      for (let i = 0; i < a.ids.length; i += 25) (await http<{ avisados: string[] }>('POST', '/cronograma/colgar', { ids: a.ids.slice(i, i + 25), dirs: a.dirs?.slice(i, i + 25), tipo: a.tipo, motivo })).avisados.forEach((x) => avisados.add(x));
      toast(`${a.pdv}: ${carrilDe(a.tipo).uno.toLowerCase()} quedó en Colgados.${avisados.size ? ` Se le avisó a ${[...avisados].join(' y ')}.` : ''}`);
    } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  const soltarEnColgados = () => {
    const a = arrastre.current;
    arrastre.current = null; setSobre(null);
    if (!a || a.de === COLGADOS) return;
    if (a.tipo === 'encargo') { toast('Los encargos no se cuelgan acá: se pasan a otro día o se cancelan desde el encargo.', true); return; }
    if (!a.de) { toast('Eso todavía no tiene fecha: no hay qué dejar pendiente.', true); return; }
    setColgando({ ids: a.ids, dirs: a.dirs, tipo: a.tipo, pdv: a.pdv });
  };
  async function marcar(t: Tarjeta) {
    const hecho = !t.hecho, ids = t.movs.map((m) => m.task_id), dirs = t.movs.map((m) => m.dir ?? null), suyos = new Set(t.movs.map((m) => m.id));
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map((m) => (suyos.has(m.id) ? { ...m, hecho } : m)),
      colgados: (d.colgados ?? []).filter((m) => !(hecho && suyos.has(m.id))) });
    try {
      const r = { cambiados: 0, estado: null as string | null };
      for (let i = 0; i < ids.length; i += 25) { const x = await http<{ cambiados: number; estado: string | null }>('POST', '/cronograma/hecho', { ids: ids.slice(i, i + 25), dirs: dirs.slice(i, i + 25), tipo: t.tipo, hecho }); r.cambiados += x.cambiados; r.estado = x.estado; }
      toast(!hecho ? 'Quedó como pendiente.' : r.cambiados && r.estado ? `Hecho. ${r.cambiados === 1 ? 'El artículo pasó' : `${r.cambiados} artículos pasaron`} a «${r.estado}» en ClickUp.` : 'Marcado como hecho.');
    } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  // El chofer de una tarjeta: su parada pasa al recorrido de ese chofer ese día (toda la parada: en un impresor van todos
  // sus retiros y egresos del día). Se ve en la Ruta del día y en la app del chofer.
  async function asignar(t: Tarjeta, chofer: string) {
    if (chofer === '+') { setNuevoPara(t); return; }
    const ids = t.movs.map((m) => m.id);
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map((m) => (ids.includes(m.id) ? { ...m, chofer: chofer || null } : m)) });
    try {
      const r = await http<{ chofer: string | null; recorrido: number; movimientos: number }>('PUT', '/cronograma/chofer', { fecha: t.fecha, ids, chofer });
      const otros = r.movimientos - ids.length;
      toast(`${t.titulo}: ${r.chofer ? `va con ${r.chofer}` : 'quedó sin chofer'} el ${diaCorto(t.fecha)} (recorrido ${r.recorrido}).${otros > 0 ? ` Va toda la parada: ${otros === 1 ? 'pasó también otro movimiento' : `pasaron también otros ${otros} movimientos`} de ese lugar.` : ''}`);
    } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  // Un encargo: pasarlo a otro día, marcarlo hecho o elegirle el chofer (su parada pasa a ese recorrido, como las tarjetas).
  async function encargoA(e: Encargo, cambios: { fecha?: string; estado?: string }) {
    setDatos((d) => d && { ...d, encargos: (d.encargos ?? []).map((x) => (x.id === e.id ? { ...x, ...cambios } as Encargo : x)) });
    try {
      await http('PATCH', `/recorridos/encargos/${e.id}`, cambios);
      toast(cambios.fecha ? `Encargo a ${lindo(e.destino)}: pasó al ${diaCorto(cambios.fecha)}.${e.user_id ? ' Se le avisó a quien lo pidió.' : ''}` : cambios.estado === 'hecho' ? 'Encargo hecho.' : 'Encargo pendiente otra vez.');
    } catch (err) { toast((err as Error).message, true); }
    void cargar();
  }
  async function choferEnc(e: Encargo, chofer: string) {
    if (chofer === '+') { setNuevoPara(e); return; }
    setDatos((d) => d && { ...d, encargos: (d.encargos ?? []).map((x) => (x.id === e.id ? { ...x, chofer: chofer || null } : x)) });
    try {
      const r = await http<{ chofer: string | null; recorrido: number; movimientos: number }>('PUT', '/cronograma/chofer', { fecha: e.fecha, ids: [`enc:${e.id}`], chofer });
      toast(`Encargo a ${lindo(e.destino)}: ${r.chofer ? `va con ${r.chofer}` : 'quedó sin chofer'} el ${diaCorto(e.fecha)} (recorrido ${r.recorrido}).${r.movimientos > 1 ? ' Va toda la parada de ese lugar.' : ''}`);
    } catch (err) { toast((err as Error).message, true); }
    void cargar();
  }
  const soltar = (fecha: string) => {
    const a = arrastre.current;
    arrastre.current = null; setSobre(null);
    if (a && a.de !== fecha) {
      if (a.tipo === 'encargo') { const e = v?.encargos?.find((x) => String(x.id) === a.ids[0]); if (e) void encargoA(e, { fecha }); }
      else void mover(a.ids, a.tipo, fecha, a.pdv, a.dirs);
    }
  };

  // Los bultos de una tarjeta (sus movimientos o su encargo), por medida: quedan en la primera clave, como en el servidor.
  async function guardarBultos(claves: string[], b: Bultos | null, que: string) {
    const primera = [...claves].sort()[0], de = (id: string) => (claves.includes(id) ? (id === primera ? b : null) : undefined);
    const conBultos = (m: Mov) => { const x = de(m.id); return x === undefined ? m : { ...m, bultos: x }; };
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map(conBultos), colgados: (d.colgados ?? []).map(conBultos),
      encargos: (d.encargos ?? []).map((e) => (claves.includes(`enc:${e.id}`) ? { ...e, bultos: b } : e)) });
    try {
      await http('POST', '/cronograma/bultos', { claves, ...(b ?? SIN_BULTOS) });
      toast(b ? `${que}: ${textoBultos(totalBultos(b))} (${desgloseBultos(b)}).` : `${que}: sin bultos anotados.`);
    } catch (e) { toast((e as Error).message, true); void cargar(); }
  }
  // Cada tarjeta, igual en la semana y en el día expandido (`expandida`: con las fotos y todos los productos a la vista).
  const tarjetaMov = (t: Tarjeta, expandida = false) => (
    <TarjetaMov key={t.key} t={t} hoy={v?.hoy ?? ''} puede={puede} choferes={v?.choferes ?? []} expresos={v?.expresos ?? []} onChofer={(c) => asignar(t, c)}
      dir={t.parada && t.movs[0]?.parada ? dirs[`${t.fecha}|${t.movs[0].parada}`] : undefined} buscando={buscandoDirs} onDir={(k, d) => setCorrigiendo({ k, d })}
      onMarcar={() => marcar(t)} onAbrir={t.record_id ? () => abrirTarjeta(t) : undefined} feriados={v?.feriados}
      onColgar={t.hecho ? undefined : () => setColgando({ ids: t.movs.map((m) => m.task_id), dirs: t.movs.map((m) => m.dir ?? null), tipo: t.tipo, pdv: `PDV ${t.movs[0].npdv ?? ''}` })}
      onAnotar={t.record_id ? () => setAnotando(t) : undefined} onHora={t.parada && t.movs[0]?.parada && !t.hecho ? () => setHoraDe(t) : undefined}
      onEnviado={t.tipo !== 'entrega' ? setEnviando : undefined} expandida={expandida} onBultos={(b) => guardarBultos(t.movs.map((m) => m.id), b, t.pdv)}
      onMover={(f) => mover(t.movs.map((m) => m.task_id), t.tipo, f, `PDV ${t.movs[0].npdv ?? ''}`, t.movs.map((m) => m.dir ?? null))}
      onArrastrar={(on) => { arrastre.current = on ? { ids: t.movs.map((m) => m.task_id), dirs: t.movs.map((m) => m.dir ?? null), tipo: t.tipo, de: t.fecha, pdv: `PDV ${t.movs[0].npdv ?? ''}` } : null; if (!on) setSobre(null); }} />
  );
  const tarjetaEnc = (e: Encargo, expandida = false) => (
    <TarjetaEncargo key={e.id} e={e} hoy={v?.hoy ?? ''} puede={puede} choferes={v?.choferes ?? []} expresos={v?.expresos ?? []}
      dir={e.parada ? dirs[`${e.fecha}|${e.parada}`] : undefined} buscando={buscandoDirs} onDir={(k, d) => setCorrigiendo({ k, d })}
      onAbrir={() => setEncargo(e.id)} onChofer={(c) => choferEnc(e, c)} onMover={(f) => encargoA(e, { fecha: f })} onAnotar={() => setAnotandoEnc(e)}
      onMarcar={() => encargoA(e, { estado: e.estado === 'hecho' ? 'pendiente' : 'hecho' })} onBultos={(b) => guardarBultos([`enc:${e.id}`], b, `Encargo a ${lindo(e.destino)}`)} expandida={expandida}
      onArrastrar={(on) => { arrastre.current = on ? { ids: [String(e.id)], tipo: 'encargo', de: e.fecha, pdv: '' } : null; if (!on) setSobre(null); }} />
  );
  const verDia = (d: string) => ir({ vista: 'dia', dia: d });
  const totalesTexto = (m: Mov[], e: Encargo[]) => { const h = m.filter((x) => x.hecho).length;
    return `${m.length} movimiento${m.length === 1 ? '' : 's'} · ${h} hecho${h === 1 ? '' : 's'} · ${e.length} encargo${e.length === 1 ? '' : 's'}`; };

  const total = movs.length, hechos = movs.filter((m) => m.hecho).length;
  return (
    <div className="content cr-page">
      <div className="page-head">
        <h1>Cronograma {v && <span className="muted small">{total} movimientos · {hechos} hechos{encs.length ? ` · ${encs.length} encargo${encs.length === 1 ? '' : 's'}` : ''}</span>}</h1>
        {/* La leyenda de colores, en la fila del título (en el lugar que sobra), no en un renglón propio: así la cabecera
            ocupa menos (pedido de Rodrigo del 20/11/2026). */}
        {vista !== 'ruta' && <div className="cr-leyenda small">{CARRILES.map((c) => <span key={c.k} className={`cr-k-${c.k}`} title={c.ayuda}><i />{c.nombre}</span>)}<span className="cr-k-X" title="Lo que alguien pidió en Recorridos"><i />Encargos</span></div>}
        <div className="row" role="group" aria-label="Vista">
          <button type="button" className={`btn sm${vista === 'semana' ? ' primary' : ''}`} aria-pressed={vista === 'semana'} onClick={() => ir({ vista: null })}><Icon name="calendar" size={14} />Semana</button>
          <button type="button" className={`btn sm${vista === 'dia' ? ' primary' : ''}`} aria-pressed={vista === 'dia'} onClick={() => verDia(dia)} title="Un día expandido, con todo ordenado"><Icon name="board" size={14} />Día</button>
          <button type="button" className={`btn sm${vista === 'ruta' ? ' primary' : ''}`} aria-pressed={vista === 'ruta'} onClick={() => ir({ vista: 'ruta', dia })}><Icon name="route" size={14} />Ruta del día</button>
        </div>
      </div>

      <BarraSemanas semana={semana} centro={centro} dias={datos?.dias ?? {}} hoy={datos?.hoy ?? hoyIso()}
        onElegir={(s) => ir({ semana: s, dia: null })} onCentro={setCentro} onHoy={() => { const h = lunesDe(hoyIso()); setCentro(h); ir({ semana: h, dia: null }); }} />

      {error && <div className="aviso warn small" style={{ marginBottom: 12 }}>{error}</div>}

      {vista !== 'ruta' && (
        <>
          <div className="toolbar">
            <div className="search" style={{ minWidth: 220, flex: '0 1 280px' }}><Icon name="search" />
              <input className="input" placeholder="Buscar PDV, cliente, proveedor o producto" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
            </div>
            {/* El mismo desplegable de unidades de negocio (con sus logos) que en Pedidos, Negocios, Empresas y Contactos. */}
            <UnidadFilter value={unidades} onChange={setUnidades} />
            {/* Lo propio del cronograma (qué movimientos y a quién le toca) y después lo terminado, como en el resto de los módulos. */}
            <FiltroCr nombre="Tipo de movimiento" value={tipos} onChange={setTipos}
              opciones={[...CARRILES.map((c) => ({ k: c.k, nombre: c.nombre, ayuda: c.ayuda })), { k: 'X', nombre: 'Encargos', ayuda: 'Lo que alguien pidió en Recorridos' }]
                .map((o) => ({ ...o, n: porTipo[o.k] ?? 0, punto: `cr-k-${o.k}` }))} />
            <FiltroCr nombre="Le toca a" conNombre value={toca} onChange={(x) => setToca(x as Rol[])}
              opciones={(Object.keys(NOMBRE_ROL) as Rol[]).map((r) => ({ k: r, nombre: NOMBRE_ROL[r], ayuda: `Lo que le toca a ${NOMBRE_ROL[r]}`, n: porRol[r] ?? 0 }))} />
            <button type="button" className={`btn qf-btn${pendientes ? ' on' : ''}`} aria-pressed={pendientes} onClick={() => setPendientes(!pendientes)}
              title="Oculta lo que ya está hecho">Solo lo pendiente</button>
          </div>
          {v && !puede && <div className="aviso info small" style={{ marginBottom: 12 }}>Ves el cronograma para saber cuándo sale cada cosa. Lo editan Logística, Producción y los administradores.</div>}
          {!v && !error && <div className="empty plain">Cargando la semana…</div>}
          {v && vista === 'semana' && (
            <div className="cr-scroll">
              {/* Colgados es una columna más de la grilla, al final y del mismo ancho que los días. */}
              <div className="cr-semana" style={{ gridTemplateColumns: `repeat(${dias.length + 1}, minmax(214px, 1fr))` }}>
                {dias.map((d) => {
                  const r = delDiaDe(d), delDia = r.movs, notas = r.notas, encDia = r.encs;
                  return (
                    <section key={d} className={`cr-dia${d === v.hoy ? ' hoy' : ''}${v.feriados[d] ? ' feriado' : ''}${sobre === d ? ' sobre' : ''}`}
                      onDragOver={(e) => { if (arrastre.current && puede) { e.preventDefault(); if (sobre !== d) setSobre(d); } }}
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSobre((s) => (s === d ? null : s)); }}
                      onDrop={(e) => { e.preventDefault(); soltar(d); }}>
                      <header className="cr-dia-cab">
                        {/* El nombre del día abre el día expandido. */}
                        <div className="cr-dia-tit">
                          <button type="button" className="cr-dia-ver" onClick={() => verDia(d)} title="Ver el día expandido"><b>{DIAS[D(d).getDay()]}</b><span className="num">{D(d).getDate()}/{D(d).getMonth() + 1}</span><Icon name="board" size={13} /></button>
                          {d === v.hoy && <span className="cr-hoy">Hoy</span>}
                        </div>
                        <div className="cr-dia-sub">
                          <span className={`num${r.atrasado ? ' overdue' : ''}`}>{r.texto}</span>
                          {(delDia.some((m) => !llega(m.tipo)) || encDia.length > 0) && <button type="button" className="cr-link" onClick={() => ir({ vista: 'ruta', dia: d })}><Icon name="route" size={12} />Ruta</button>}
                        </div>
                        <MezclaDia estados={tarjetas(delDia).map((t) => (t.hecho ? 'hecho' : despachoTarjeta(t, dirDe(t))?.estado ?? 'listo'))} />
                        <Feriado dia={d} nombre={v.feriados[d]} puede={puede} onCambio={cargar} />
                      </header>
                      <div className="cr-carriles">
                        {CARRILES.map((c) => {
                          const ts = tarjetas(delDia.filter((m) => c.tipos.includes(m.tipo))).filter(pasaToca);
                          if (!ts.length) return null;
                          return (
                            <div key={c.k} className={`cr-carril cr-k-${c.k}`}>
                              <h3>{c.nombre} <span className="num">{ts.length}</span></h3>
                              {ts.map((t) => tarjetaMov(t))}
                            </div>
                          );
                        })}
                        {encDia.length > 0 && (
                          <div className="cr-carril cr-k-X">
                            <h3>Encargos <span className="num">{encDia.length}</span></h3>
                            {encDia.map((e) => tarjetaEnc(e))}
                          </div>
                        )}
                        <Notas dia={d} notas={notas} puede={puede} onCambio={cargar} />
                      </div>
                    </section>
                  );
                })}
                {/* Colgados: lo que no se pudo hacer y quedó pendiente. La misma columna en todas las semanas. */}
                <section className={`cr-dia cr-colgados${sobre === COLGADOS ? ' sobre' : ''}`} aria-label="Colgados"
                  onDragOver={(e) => { if (arrastre.current && puede && arrastre.current.de !== COLGADOS) { e.preventDefault(); if (sobre !== COLGADOS) setSobre(COLGADOS); } }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSobre((x) => (x === COLGADOS ? null : x)); }}
                  onDrop={(e) => { e.preventDefault(); soltarEnColgados(); }}>
                  <header className="cr-dia-cab">
                    <div className="cr-dia-tit"><Icon name="alert" size={15} /><b>Colgados</b><span className="num">{colg.length ? tarjetas(colg).length : ''}</span></div>
                    <div className="cr-dia-sub"><span>Lo que no se pudo hacer. No es de ninguna semana: queda acá hasta que se resuelve.</span></div>
                  </header>
                  <div className="cr-carriles">
                    {CARRILES.map((c) => {
                      const ts = ordenColgados(tarjetas(colg.filter((m) => c.tipos.includes(m.tipo))).map((t) => ({ ...t, parada: false })).filter(pasaToca));
                      if (!ts.length) return null;
                      return (
                        <div key={c.k} className={`cr-carril cr-k-${c.k}`}>
                          <h3>{c.nombre} <span className="num">{ts.length}</span></h3>
                          {ts.map((t) => <TarjetaMov key={t.key} t={t} hoy="" puede={puede} choferes={[]} expresos={[]} onChofer={() => undefined} buscando={false} onDir={() => undefined}
                            onMarcar={() => marcar(t)} onAbrir={t.record_id ? () => abrirTarjeta(t) : undefined} onBultos={(b) => guardarBultos(t.movs.map((m) => m.id), b, t.pdv)}
                            onMover={(f) => mover(t.movs.map((m) => m.task_id), t.tipo, f, `PDV ${t.movs[0].npdv ?? ''}`, t.movs.map((m) => m.dir ?? null))}
                            onArrastrar={(on) => { arrastre.current = on ? { ids: t.movs.map((m) => m.task_id), dirs: t.movs.map((m) => m.dir ?? null), tipo: t.tipo, de: COLGADOS, pdv: `PDV ${t.movs[0].npdv ?? ''}` } : null; if (!on) setSobre(null); }} />)}
                        </div>
                      );
                    })}
                    {!colg.length && <div className="cr-colgados-vacio small">{puede ? 'Arrastrá acá lo que no se pudo hacer (no pagó, nadie recibió, falta un documento…) y decí por qué. Al responsable del pedido le llega el aviso.' : 'Nada pendiente.'}</div>}
                  </div>
                </section>
              </div>
            </div>
          )}
          {v && vista === 'dia' && (() => {
            // El día expandido (pedido de Rodrigo del 20/11/2026): lo mismo que la columna de ese día en la semana, con lugar.
            // Arriba los días de la semana (se elige otro o se suelta una tarjeta ahí para pasarla a ese día); abajo, cada
            // tipo de movimiento con sus tarjetas en grilla, los encargos y las notas.
            const r = delDiaDe(dia);
            const pestanas = dias.includes(dia) ? dias : [...dias, dia].sort();
            const carriles = CARRILES.map((c) => ({ c, ts: tarjetas(r.movs.filter((m) => c.tipos.includes(m.tipo))).filter(pasaToca) })).filter((x) => x.ts.length);
            return (
              <div className="cr-diax">
                <nav className="cr-diax-dias" aria-label="Días de la semana">
                  {pestanas.map((d) => { const x = delDiaDe(d); return (
                    <button key={d} type="button" aria-current={d === dia ? 'date' : undefined} onClick={() => ir({ dia: d })}
                      className={`cr-diax-tab${d === dia ? ' on' : ''}${d === v.hoy ? ' hoy' : ''}${v.feriados[d] ? ' feriado' : ''}${sobre === d ? ' sobre' : ''}`}
                      title={d === dia ? undefined : puede ? 'Ver ese día (o soltá acá una tarjeta para pasarla a ese día)' : 'Ver ese día'}
                      onDragOver={(e) => { if (arrastre.current && puede && d !== dia) { e.preventDefault(); if (sobre !== d) setSobre(d); } }}
                      onDragLeave={() => setSobre((o) => (o === d ? null : o))}
                      onDrop={(e) => { e.preventDefault(); soltar(d); }}>
                      {/* Hoy, en el color de la marca (como en la semana): el cartelito «Hoy» está en el encabezado del día. */}
                      <b title={d === v.hoy ? 'Hoy' : undefined}>{DIAS[D(d).getDay()].slice(0, 3)} {D(d).getDate()}/{D(d).getMonth() + 1}</b>
                      <span className={`num${x.atrasado ? ' overdue' : ''}`}>{x.texto}</span>
                    </button>
                  ); })}
                </nav>
                <section className={`cr-diax-panel${v.feriados[dia] ? ' feriado' : ''}`} aria-label={diaLargo(dia)}>
                  <header className="cr-diax-cab">
                    <div className="cr-diax-tit">
                      <h2>{diaLargo(dia)}</h2>
                      {dia === v.hoy && <span className="cr-hoy">Hoy</span>}
                      <span className={`num${r.atrasado ? ' overdue' : ''}`}>{r.texto}</span>
                      {(() => { const b = [...r.movs.map((m) => m.bultos), ...r.encs.map((e) => e.bultos)].reduce<Bultos>((a, x) => sumarBultos(a, x), SIN_BULTOS), n = totalBultos(b);
                        return n > 0 && <span className="cr-bultos solo" title={`Los bultos anotados en las tarjetas del día: ${desgloseBultos(b)}`}>{ICONO_BULTOS}{textoBultos(n)}</span>; })()}
                      <Feriado dia={dia} nombre={v.feriados[dia]} puede={puede} onCambio={cargar} />
                      <span className="cr-diax-links">
                        {(r.movs.some((m) => !llega(m.tipo)) || r.encs.length > 0) && <button type="button" className="cr-link" onClick={() => ir({ vista: 'ruta', dia })}><Icon name="route" size={12} />Ruta del día</button>}
                        <button type="button" className="cr-link" onClick={() => ir({ vista: null })}><Icon name="calendar" size={12} />Volver a la semana</button>
                      </span>
                    </div>
                    <MezclaDia estados={tarjetas(r.movs).map((t) => (t.hecho ? 'hecho' : despachoTarjeta(t, dirDe(t))?.estado ?? 'listo'))} />
                  </header>
                  <div className="cr-diax-cuerpo">
                    {carriles.map(({ c, ts }) => (
                      <section key={c.k} className={`cr-diax-carril cr-k-${c.k}`} aria-label={c.nombre}>
                        <h3>{c.nombre} <span className="num">{ts.length}</span><small>{c.ayuda}</small></h3>
                        <div className="cr-diax-grilla">{ts.map((t) => tarjetaMov(t, true))}</div>
                      </section>
                    ))}
                    {r.encs.length > 0 && (
                      <section className="cr-diax-carril cr-k-X" aria-label="Encargos">
                        <h3>Encargos <span className="num">{r.encs.length}</span><small>Lo que alguien pidió en Recorridos</small></h3>
                        <div className="cr-diax-grilla">{r.encs.map((e) => tarjetaEnc(e, true))}</div>
                      </section>
                    )}
                    {!carriles.length && !r.encs.length && <div className="empty plain">{r.cuantos ? 'Con estos filtros no queda nada en este día.' : 'Nada para este día.'}</div>}
                    <div className="cr-diax-notas"><Notas dia={dia} notas={r.notas} puede={puede} onCambio={cargar} /></div>
                  </div>
                </section>
              </div>
            );
          })()}
          {/* Abajo a la izquierda, como en Pedidos y Producción: cuánto hay en la semana o en el día (con lo que se ve filtrado). */}
          {v && <BarraPie onRecargar={cargar} total={vista === 'dia' ? totalesTexto(delDiaDe(dia).movs, delDiaDe(dia).encs) : totalesTexto(movs, encs)} />}
          {colgando && <ModalColgar a={colgando} onCerrar={() => setColgando(null)} onColgar={(m) => colgar(colgando, m)} />}
          {anotando && anotando.record_id && (
            <Modal title={`Anotaciones de logística · ${anotando.titulo} (${anotando.pdv})`} onClose={() => setAnotando(null)}>
              <NotasLogistica recordId={anotando.record_id} tipo={anotando.tipo} destino={anotando.tipo === 'entrega' ? null : { company_id: anotando.movs[0]?.company_id, nombre: anotando.movs[0]?.lugar }} onCambio={cargar} />
            </Modal>
          )}
          {anotandoEnc && (
            <Modal title={`Anotaciones de logística · ${lindo(anotandoEnc.destino)}`} onClose={() => setAnotandoEnc(null)}>
              <NotasLogistica recordId={null} destino={{ company_id: anotandoEnc.company_id, lugar_id: anotandoEnc.lugar_id, nombre: anotandoEnc.destino }} onCambio={cargar} />
            </Modal>
          )}
          {horaDe && <ModalHora t={horaDe} onCerrar={() => setHoraDe(null)} onListo={() => { setHoraDe(null); void cargar(); }} />}
          {enviando && <ModalEnviado m={enviando} onCerrar={() => setEnviando(null)} onListo={() => { setEnviando(null); void cargar(); }} />}
          {v && vista === 'semana' && deTipo('entrega') && <SinFecha items={v.sin_fecha.filter((s) => coincide(s, q) && deUnidad(s.unidad))} puede={puede}
            onArrastrar={(a) => { arrastre.current = a; if (!a) setSobre(null); }} onMover={(ids, f, pdv) => mover(ids, 'entrega', f, pdv)} onAbrir={setPreview} />}
        </>
      )}

      {vista === 'ruta' && (
        <Suspense fallback={<div className="empty plain">Cargando el mapa…</div>}>
          <CronogramaRuta fecha={dia} semana={semana} hoy={datos?.hoy ?? hoyIso()} resumen={datos?.dias ?? {}} onFecha={(d) => ir({ dia: d })} onAbrir={setPreview} onCambio={cargar} />
        </Suspense>
      )}
      {corrigiendo && (
        <Modal title={`Dirección de ${lindo(corrigiendo.d.nombre)}`} onClose={() => setCorrigiendo(null)}>
          <EditarDireccion p={{ nombre: corrigiendo.d.nombre, direccion: corrigiendo.d.direccion, horario_texto: corrigiendo.d.horario, company_id: corrigiendo.d.company_id,
            detalle: corrigiendo.d.detalle, observaciones: corrigiendo.d.observaciones }}
            pedidos={corrigiendo.d.record_ids} onListo={(g) => {
              // Lo guardado se ve enseguida en la tarjeta (y su despacho); la semana se vuelve a pedir de fondo.
              if (g) { const k = corrigiendo.k; setDirs((ds) => (ds[k] ? { ...ds, [k]: { ...ds[k], direccion: g.direccion.trim() || null, detalle: g.detalle.trim() || null, horario: g.horario.trim() || ds[k].horario,
                estado: !g.direccion.trim() ? 'sin_direccion' : g.validada ? 'ok' : 'buscando' } } : ds)); }
              setCorrigiendo(null); void cargarDirs();
            }} />
        </Modal>
      )}
      {encargo && <EncargoModal id={encargo} onClose={() => setEncargo(null)} onListo={() => { setEncargo(null); void cargar(); }} />}
      {preview && <RecordPreview key={preview} type="order" id={preview} onClose={() => { setPreview(null); setPreviewT(null); }} onChange={cargar}
        arriba={previewT && previewT.record_id === preview ? <PanelDespacho t={previewT} dir={dirDe(previewT)} hoy={v?.hoy ?? hoyIso()} feriados={v?.feriados} /> : undefined} />}
      {nuevoPara && (
        <Modal title="Agregar chofer o expreso" onClose={() => setNuevoPara(null)}>
          <NuevoTransportista onCancelar={() => setNuevoPara(null)} onListo={(nombre) => { const t = nuevoPara; setNuevoPara(null); if ('movs' in t) void asignar(t, nombre); else void choferEnc(t, nombre); }} />
        </Modal>
      )}
    </div>
  );
}

// Un filtro del cronograma (qué movimientos, a quién le toca): el mismo desplegable con casillas que «Unidad de negocio»,
// con cuántas tarjetas hay de cada opción. Sin nada elegido, todo.
function FiltroCr({ nombre, opciones, value, onChange, conNombre }: {
  nombre: string; value: string[]; onChange: (v: string[]) => void; conNombre?: boolean;
  opciones: Array<{ k: string; nombre: string; ayuda: string; n: number; punto?: string }>;
}) {
  const sel = opciones.filter((o) => value.includes(o.k));
  const elegidos = sel.length > 2 ? `${sel.length} elegidos` : sel.map((o) => o.nombre).join(', ');
  return (
    <Pop label={sel.length ? (conNombre ? `${nombre}: ${elegidos}` : elegidos) : nombre} on={sel.length > 0}>
      {() => (
        <div className="stack" style={{ gap: 0 }}>
          {opciones.map((o) => (
            <label key={o.k} className="opt cr-op" title={o.ayuda}>
              <input type="checkbox" checked={value.includes(o.k)} onChange={() => onChange(value.includes(o.k) ? value.filter((x) => x !== o.k) : [...value, o.k])} />
              {o.punto && <i className={o.punto} aria-hidden />}<span className="grow">{o.nombre}</span><span className="num">{o.n}</span>
            </label>
          ))}
          {value.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => onChange([])}>Todos</button>}
        </div>
      )}
    </Pop>
  );
}

// ---------- La barra de semanas ----------

// Trece semanas agrupadas por mes. Se arrastra para los costados (o con las flechas, de a un mes) y un clic elige la
// semana. Cada semana muestra cuánto tiene cada día y cuánto quedó pendiente; en rojo, lo que ya pasó y no se hizo.
function BarraSemanas({ semana, centro, dias, hoy, onElegir, onCentro, onHoy }: {
  semana: string; centro: string; dias: Record<string, DiaResumen>; hoy: string; onElegir: (s: string) => void; onCentro: (s: string) => void; onHoy: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const tiro = useRef<{ x: number; scroll: number; movio: boolean } | null>(null);
  const semanas = useMemo(() => Array.from({ length: 13 }, (_, i) => sumar(centro, (i - 6) * 7)), [centro]);
  const max = Math.max(1, ...semanas.flatMap((s) => [0, 1, 2, 3, 4].map((i) => dias[sumar(s, i)]?.total ?? 0)));
  const estaSemana = lunesDe(hoy);
  // Cómo se acomoda la barra. Por defecto arranca en la semana anterior a la actual: se ven la anterior, la actual y las
  // que vienen; las más viejas quedan a la izquierda, a un arrastre o una flecha. Si la semana elegida no entra en esa
  // vista (una muy vieja o muy lejana), se centra en ella. Con las flechas se centra en el mes al que se fue.
  const centroAntes = useRef(centro);
  useEffect(() => {
    const c = caja.current;
    if (!c) return;
    const base = c.getBoundingClientRect().left - c.scrollLeft;
    const izq = (x: HTMLElement) => x.getBoundingClientRect().left - base;
    const centrar = (x: HTMLElement) => izq(x) - c.clientWidth / 2 + x.clientWidth / 2;
    const porFlecha = centroAntes.current !== centro;
    centroAntes.current = centro;
    const elegida = c.querySelector<HTMLElement>('[aria-current="true"]');
    const delCentro = c.querySelector<HTMLElement>(`[data-s="${centro}"]`);
    const anterior = c.querySelector<HTMLElement>(`[data-s="${sumar(estaSemana, -7)}"]`);
    let left: number | null = null;
    if (porFlecha && delCentro && centro !== semana) left = centrar(delCentro);
    else if (anterior) {
      left = izq(anterior) - 30;
      // La elegida tiene que verse entera en esa vista; si no, se centra en ella.
      if (elegida && (izq(elegida) < left || izq(elegida) + elegida.clientWidth > left + c.clientWidth - 30)) left = centrar(elegida);
    } else if (elegida ?? delCentro) left = centrar((elegida ?? delCentro)!);
    if (left != null) c.scrollTo({ left, behavior: 'smooth' });
  }, [semana, centro, estaSemana]);
  const meses: Array<{ mes: string; corto: string; anio: string | null; semanas: string[] }> = [];
  for (const s of semanas) {
    const jueves = D(sumar(s, 3)), otroAnio = jueves.getFullYear() !== D(hoy).getFullYear();
    const mes = `${MESES[jueves.getMonth()]}${otroAnio ? ` ${jueves.getFullYear()}` : ''}`;
    if (meses[meses.length - 1]?.mes === mes) meses[meses.length - 1].semanas.push(s);
    else meses.push({ mes, corto: MESES[jueves.getMonth()].slice(0, 3), anio: otroAnio ? String(jueves.getFullYear()) : null, semanas: [s] });
  }
  return (
    <div className="cr-barra">
      <button type="button" className="btn ghost icon sm" aria-label="Un mes antes" onClick={() => onCentro(sumar(centro, -28))}><Icon name="chevron" size={16} /></button>
      <div className="cr-barra-caja" ref={caja}
        onPointerDown={(e) => { if (e.pointerType === 'mouse') tiro.current = { x: e.clientX, scroll: caja.current!.scrollLeft, movio: false }; }}
        onPointerMove={(e) => { const t = tiro.current; if (!t) return; const dx = e.clientX - t.x; if (Math.abs(dx) > 5) { t.movio = true; caja.current!.classList.add('tirando'); } if (t.movio) caja.current!.scrollLeft = t.scroll - dx; }}
        onPointerUp={() => { window.setTimeout(() => { tiro.current = null; }, 0); caja.current?.classList.remove('tirando'); }}
        onPointerLeave={() => { tiro.current = null; caja.current?.classList.remove('tirando'); }}>
        {meses.map((m) => (
          <div key={m.mes} className="cr-mes">
            {/* El mes, chico y a la izquierda de sus semanas (pedido de Rodrigo del 20/11/2026: que la barra ocupe menos). */}
            <div className="cr-mes-nombre" title={m.mes}>{m.corto}{m.anio && <small>{m.anio}</small>}</div>
            <div className="cr-mes-semanas">
              {m.semanas.map((s) => {
                const ds = [0, 1, 2, 3, 4, 5, 6].map((i) => dias[sumar(s, i)]);
                const pend = ds.reduce((n, d) => n + (d?.pendientes ?? 0), 0), atr = ds.reduce((n, d) => n + (d?.atrasados ?? 0), 0), tot = ds.reduce((n, d) => n + (d?.total ?? 0), 0);
                const a = D(s), b = D(sumar(s, 4));
                return (
                  <button key={s} type="button" data-s={s} className={`cr-sem${s === semana ? ' on' : ''}${s === estaSemana ? ' actual' : ''}${s < estaSemana ? ' pasada' : ''}`} aria-current={s === semana}
                    title={`${s === estaSemana ? 'Esta semana. ' : ''}Semana del ${a.getDate()}/${a.getMonth() + 1} al ${b.getDate()}/${b.getMonth() + 1}: ${tot} movimientos, ${pend} pendientes${atr ? `, ${atr} atrasados` : ''}`}
                    onClick={(e) => { if (tiro.current?.movio) { e.preventDefault(); return; } onElegir(s); }}>
                    {/* La actual: el fondo verde y un puntito (el nombre está en el botón «Esta semana» de la derecha). */}
                    <span className="cr-sem-rango num">{s === estaSemana && <i className="cr-sem-punto" aria-label="Esta semana" />}{a.getDate()}–{b.getDate()}{a.getMonth() !== b.getMonth() ? `/${b.getMonth() + 1}` : ''}</span>
                    <span className="cr-sem-barras" aria-hidden="true">
                      {ds.slice(0, 5).map((d, i) => <i key={i} className={d?.atrasados ? 'atr' : d?.pendientes ? 'pend' : d?.total ? 'ok' : ''} style={{ height: `${d?.total ? Math.max(18, (d.total / max) * 100) : 6}%` }} />)}
                    </span>
                    <span className={`cr-sem-pie num${atr ? ' atr' : ''}`}>{!tot ? 'Sin nada' : atr ? `${atr} atrasado${atr === 1 ? '' : 's'}` : pend ? `${pend} pend.` : 'Todo hecho'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn ghost icon sm cr-der" aria-label="Un mes después" onClick={() => onCentro(sumar(centro, 28))}><Icon name="chevron" size={16} /></button>
      <button type="button" className={`btn sm cr-ir-hoy${semana === estaSemana ? ' on' : ''}`} onClick={onHoy} title="Ir a la semana actual">
        <i aria-hidden="true" />Esta semana<span className="num">{D(estaSemana).getDate()}–{D(sumar(estaSemana, 4)).getDate()}/{D(sumar(estaSemana, 4)).getMonth() + 1}</span></button>
    </div>
  );
}

// ---------- Las tarjetas ----------

// Con quién es cada movimiento: el cliente, un proveedor o un impresor.
const ROL: Record<Tipo, { nombre: string; icono: string }> = {
  entrega: { nombre: 'Cliente', icono: 'company' }, ingreso: { nombre: 'Proveedor', icono: 'bag' }, retiro_proveedor: { nombre: 'Proveedor', icono: 'bag' },
  egreso: { nombre: 'Impresor', icono: 'printer' }, retiro_impresor: { nombre: 'Impresor', icono: 'printer' }, ingreso_impresor: { nombre: 'Impresor', icono: 'printer' },
};
const TOPE = 3;

function TarjetaMov({ t, hoy, feriados, puede, choferes, expresos, dir, buscando, onDir, onChofer, onMarcar, onAbrir, onMover, onArrastrar, onColgar, onAnotar, onHora, onEnviado, onBultos, expandida }: {
  t: Tarjeta; hoy: string; feriados?: Record<string, string>; puede: boolean; choferes: string[]; expresos: string[]; onChofer: (chofer: string) => void;
  dir?: DirParada; buscando: boolean; onDir: (k: string, d: DirParada) => void;
  onMarcar: () => void; onAbrir?: () => void; onMover: (fecha: string) => void; onArrastrar: (on: boolean) => void;
  onColgar?: () => void;   // dejarlo en «Colgados» (lo mismo que arrastrarlo ahí; para el celular)
  onAnotar?: () => void;   // las anotaciones de logística de esta tarjeta
  onHora?: () => void;     // fijar la hora o el rango horario de su parada
  onEnviado?: (m: Mov) => void;   // anotar la cantidad que realmente se mandó o llegó (no en las entregas)
  onBultos?: (b: Bultos | null) => void;   // anotar los bultos por medida (Logística, a mano)
  expandida?: boolean;     // en el día expandido: la foto de cada producto y todos a la vista
}) {
  // Las anotaciones de logística de sus movimientos, sin repetir (las de siempre son las mismas en todos).
  const notas = [...new Map(t.movs.flatMap((m) => m.notas ?? []).map((n) => [n.id, n])).values()];
  // En «Colgados»: por qué quedó, qué día era y quién lo dejó.
  const colgado = t.movs.find((m) => m.colgado)?.colgado ?? null;
  const motivos = [...new Set(t.movs.map((m) => m.colgado?.motivo).filter((x): x is string => !!x))];
  const toast = useToast();
  const atrasado = !t.hecho && t.fecha < hoy;
  // Hasta tres productos a la vista; el resto se abre con «+ N productos más», así un pedido largo no estira la columna.
  const [todo, setTodo] = useState(false);
  const prods = t.movs.filter((m) => m.articulo);
  // Una prenda en varios talles es un producto: un renglón con la suma y sus talles (talles.ts), por lugar de entrega.
  const entradas = juntarTalles(prods, (m) => `${m.grupo}|${m.dir ?? ''}`);
  const ver = todo || expandida ? entradas : entradas.slice(0, TOPE);
  const bultos = t.movs.reduce<Bultos>((a, m) => sumarBultos(a, m.bultos), SIN_BULTOS);
  const marca = t.tipo === 'entrega' ? null : marcaProveedor(t.crudo);
  const desp = t.hecho ? null : despachoTarjeta(t, dir);
  const reloj = desp && hoy ? riesgo(desp, t.fecha, hoy, feriados) : null;
  // Lo hecho ocupa una línea (la semana llena se sigue leyendo); se abre para ver la tarjeta entera.
  const [abierta, setAbierta] = useState(false);
  if (t.hecho && !abierta) return (
    <article className={`cr-tarjeta hecho compacta${onAbrir ? ' abre' : ''}`} draggable={puede}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.key); } catch { /* no hace falta */ } onArrastrar(true); }}
      onDragEnd={() => onArrastrar(false)}
      onClick={(e) => { if (onAbrir && !(e.target as HTMLElement).closest('button, a')) onAbrir(); }}>
      {puede ? <button type="button" className="cr-check on" aria-pressed="true" aria-label="Volver a pendiente" title="Volver a pendiente" onClick={onMarcar}><Icon name="check" size={12} /></button>
        : <span className="cr-check on solo" aria-label="Hecho"><Icon name="check" size={12} /></span>}
      <span className="cr-compacta-tit" title={t.titulo}>{t.titulo}</span>
      {unidadDeTexto(t.movs[0]?.unidad) && <UnidadBadge k={unidadDeTexto(t.movs[0]?.unidad)!} compact />}
      <span className="cr-compacta-pdv num">{t.pdv.replace('PDV ', '')}</span>
      <button type="button" className="cr-mini" aria-label="Ver la tarjeta entera" title="Ver la tarjeta entera" onClick={() => setAbierta(true)}><Icon name="down" size={13} /></button>
    </article>
  );
  return (
    <article className={`cr-tarjeta${t.hecho ? ' hecho' : ''}${atrasado ? ' atrasado' : ''}${onAbrir ? ' abre' : ''}${desp ? ` cr-d cr-d-${desp.estado}` : ''}`} draggable={puede}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.key); } catch { /* no hace falta */ } onArrastrar(true); e.currentTarget.classList.add('arrastrando'); }}
      onDragEnd={(e) => { e.currentTarget.classList.remove('arrastrando'); onArrastrar(false); }}
      onClick={(e) => { if (onAbrir && !(e.target as HTMLElement).closest('button, a, .popover, .select-pop, [role="dialog"]')) onAbrir(); }}>
      <div className="cr-t-rol"><Icon name={ROL[t.tipo].icono} size={11} />{ROL[t.tipo].nombre}</div>
      <div className="cr-t-quien">
        {marca ? <LogoProveedor marca={marca} /> : t.dominio ? <Avatar name={t.titulo} type="company" domain={t.dominio} size="xs" /> : null}
        <span>{t.titulo}</span>
      </div>
      <div className="cr-t-linea">
        {unidadDeTexto(t.movs[0]?.unidad) && <UnidadBadge k={unidadDeTexto(t.movs[0]?.unidad)!} compact />}
        <span className="cr-t-pdv num">{t.pdv}</span>
        {t.para && <span className="cr-t-para">{t.para}</span>}
        {t.movs[0]?.expreso && (() => {
          // Con la guía de un expreso que tiene seguimiento (Vía Cargo), la etiqueta abre el seguimiento del envío.
          const e = t.movs[0].expreso!, url = seguimientoExpreso(e.nombre, e.guia), texto = `Expreso ${lindo(e.nombre)}${e.guia ? ` · guía ${e.guia}` : ''}`;
          return url ? <a className="cr-tag exp" href={url} target="_blank" rel="noreferrer" title="Ver el seguimiento del envío">{texto} ↗</a>
            : <span className="cr-tag exp" title="No va directo al cliente: se lleva al expreso">{texto}</span>;
        })()}
        {t.retira_en && <span className="cr-tag" title="Lo retira el cliente: no es parada de ningún recorrido">Retira en {t.retira_en}</span>}
        {t.movs[0]?.hora && <span className="cr-tag fija" title="Hora fijada en la ruta del día"><Icon name="timer" size={11} />{t.movs[0].hora}</span>}
        {t.evento && <span className="cr-evento"><svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M12 2l3 7 7 .6-5.3 4.7 1.7 7.2L12 17.8 5.6 21.5l1.7-7.2L2 9.6 9 9z" /></svg>Evento</span>}
      </div>
      {desp && <FilaDespacho d={desp} tipo={t.tipo} reloj={colgado ? null : reloj} reprogramar={!!colgado && (desp.estado === 'listo' || desp.estado === 'remitido')} />}
      {colgado && (
        <div className="cr-t-motivo">
          {motivos.map((m) => <p key={m}>{m}</p>)}
          <span className="small">Era del {diaCorto(colgado.fecha)}{colgado.por ? ` · ${colgado.por.split(' ')[0]}` : ''}
            {(() => { const n = diasColgado(colgado.at); return <b className={`cr-colg-edad${n >= 7 ? ' vieja' : ''}`}> · colgado {n === 0 ? 'hoy' : `hace ${n} día${n === 1 ? '' : 's'}`}</b>; })()}</span>
        </div>
      )}
      {dir && <LineaDireccion d={dir} buscando={buscando} puede={puede && !t.hecho} onCorregir={() => onDir(`${t.fecha}|${t.movs[0].parada}`, dir)} />}
      {prods.length > 0 && (
        <div className={`cr-t-prods${expandida ? ' con-foto' : ''}`}>
          {ver.map((e) => {
            if (e.k === 'talles') {
              // Los talles: cada uno con lo que va de ese talle; un clic anota su demasía (como en un artículo suelto).
              const ms = e.xs, va = (m: Mov) => m.enviado?.cantidad ?? m.cantidad;
              const total = ms.some((m) => va(m) != null) ? ms.reduce((n, m) => n + (va(m) ?? 0), 0) : null;
              const conDemasia = ms.some((m) => m.enviado && m.cantidad != null && m.enviado.cantidad !== m.cantidad);
              return (
                <div key={e.clave} className={ms.every((m) => m.hecho) && !t.hecho ? 'ok' : ''}>
                  {expandida && <FotoProducto url={ms.find((m) => m.foto)?.foto} nombre={ms[0].producto ?? ms[0].articulo} />}
                  <b className="num" title={conDemasia ? 'Con lo que realmente va de cada talle' : undefined}>{total != null ? num.format(total) : ''}</b>
                  <span>{ms[0].producto || ms[0].articulo}{ms[0].dir != null && <em className="cr-t-lugar" title="Va a este lugar del pedido">{ms[0].sitio ?? 'Otra dirección'}</em>}
                    <span className="cr-t-talles" aria-label={`Talles: ${textoTalles(ms.map((m) => ({ talle: m.talle, cantidad: va(m) })))}`}>
                      {ms.map((m) => {
                        const dif = m.enviado && m.cantidad != null ? m.enviado.cantidad - m.cantidad : 0;
                        const txt = <><b>{m.talle}</b>{va(m) != null && num.format(va(m)!)}{dif !== 0 && <em className="cr-t-demasia">{dif > 0 ? `+${num.format(dif)}` : num.format(dif)}</em>}</>;
                        return puede && onEnviado
                          ? <button key={m.id} type="button" className={`cr-t-talle${m.hecho && !t.hecho ? ' ok' : ''}`} onClick={() => onEnviado(m)}
                            title={`Talle ${m.talle}: ${m.cantidad != null ? num.format(m.cantidad) : '—'} en el pedido${m.enviado ? `, van ${num.format(m.enviado.cantidad)}` : ''}. Clic para anotar la cantidad que realmente va.`}>{txt}</button>
                          : <span key={m.id} className={`cr-t-talle${m.hecho && !t.hecho ? ' ok' : ''}`}>{txt}</span>;
                      })}
                    </span>
                  </span>
                </div>
              );
            }
            const m = e.x;
            // Con demasía: lo que realmente va («510», y al lado cuánto de más o de menos respecto del pedido).
            const dif = m.enviado && m.cantidad != null ? m.enviado.cantidad - m.cantidad : 0;
            const cant = <>{m.enviado ? num.format(m.enviado.cantidad) : m.cantidad != null ? num.format(m.cantidad) : ''}</>;
            return (
              <div key={m.id} className={m.hecho && !t.hecho ? 'ok' : ''}>
                {expandida && <FotoProducto url={m.foto} nombre={m.articulo} />}
                {puede && onEnviado ? <button type="button" className="cr-t-cant num" title={m.enviado ? `Se ${t.tipo === 'egreso' ? 'mandan' : 'reciben'} ${num.format(m.enviado.cantidad)} (el pedido es de ${m.cantidad != null ? num.format(m.cantidad) : '—'})${m.enviado.motivo ? `: ${m.enviado.motivo}` : ''}${m.enviado.por ? ` · ${m.enviado.por.split(' ')[0]}` : ''}. Clic para cambiarlo.` : 'Anotar la cantidad que realmente va (demasía)'}
                  onClick={() => onEnviado(m)}>{cant}</button> : <b className="num">{cant}</b>}
                <span>{m.articulo}{m.dir != null && <em className="cr-t-lugar" title="Va a este lugar del pedido">{m.sitio ?? 'Otra dirección'}</em>}{m.enviado && dif !== 0 && <em className="cr-t-demasia">{dif > 0 ? `+${num.format(dif)} de más` : `${num.format(dif)}`}</em>}</span>
              </div>
            );
          })}
          {!expandida && entradas.length > TOPE && <button type="button" className="cr-t-mas" aria-expanded={todo} onClick={() => setTodo(!todo)}>{todo ? 'Ver menos' : `+ ${entradas.length - TOPE} producto${entradas.length - TOPE === 1 ? '' : 's'} más`}</button>}
        </div>
      )}
      {notas.length > 0 && <div className="cr-t-notas">{notas.map((n) => <LineaNota key={n.id} n={n} />)}</div>}
      {!t.hecho && t.avisos.length > 0 && (
        <div className="cr-t-tags">
          {t.avisos.map((a) => <span key={a} className="cr-tag riesgo"><Icon name="alert" size={11} />{a}</span>)}
        </div>
      )}
      {/* Al pie: el chofer (en lo que es parada de un recorrido) y los bultos. */}
      {((t.parada && (puede && !t.hecho || t.chofer)) || (onBultos && (puede || totalBultos(bultos) > 0))) && (
        <div className="cr-t-pie">
          {t.parada && (puede && !t.hecho ? (
            <div className="cr-t-chofer">
              <Select className={`input cr-chofer${t.chofer ? '' : ' vacio'}`} value={t.chofer ?? ''} aria-label="Chofer" title={t.chofer ? `Chofer: ${t.chofer}` : 'Elegir el chofer'}
                onChange={(e) => onChofer(e.target.value)}>
                {opcionesChofer({ choferes, expresos, actual: t.chofer, vacio: 'Sin chofer', agregar: 'Agregar chofer o expreso…' })}
              </Select>
            </div>
          ) : t.chofer && <div className="cr-t-chofer solo" title="Chofer"><Icon name="truck" size={12} />{t.chofer}</div>)}
          {onBultos && <BultosTarjeta b={bultos} puede={puede} detalle={expandida} onGuardar={onBultos} />}
        </div>
      )}
      {puede && (
        <div className="cr-t-acc">
          {/* Un egreso: el remito de traslado de lo que se le lleva al impresor ese día (todos sus PDV), para imprimir. */}
          {t.tipo === 'egreso' && t.movs[0]?.parada && <button type="button" className="cr-mini" aria-label="Remito de traslado" title="Imprimir el remito de traslado (todo lo que va a este impresor ese día)"
            onClick={() => abrirRemitoEgreso(t.fecha, t.movs[0].parada!, toast)}><Icon name="printer" size={13} /></button>}
          {onAnotar && <button type="button" className="cr-mini" aria-label="Anotaciones de logística" title="Anotaciones de logística: para esta vez o para siempre" onClick={onAnotar}><Icon name="note" size={13} /></button>}
          {onHora && <button type="button" className="cr-mini" aria-label="Horario" title={t.movs[0]?.hora ? `${t.movs[0].hora}: cambiar el horario` : 'Fijar la hora o el rango horario'} onClick={onHora}><Icon name="timer" size={13} /></button>}
          {onColgar && <button type="button" className="cr-mini" aria-label="Dejar en Colgados" title="No se pudo hacer: dejarlo en Colgados" onClick={onColgar}><Icon name="alert" size={13} /></button>}
          <SelectorFecha valor={t.fecha} onElegir={(f) => f && onMover(f)} label={colgado ? 'Pasar a un día' : 'Pasar a otro día'} className="cr-mini" title={colgado ? 'Pasar a un día' : 'Pasar a otro día'}><Icon name="calendar" size={13} /></SelectorFecha>
          <button type="button" className={`cr-check${t.hecho ? ' on' : ''}`} aria-pressed={t.hecho} aria-label={t.hecho ? 'Volver a pendiente' : 'Marcar como hecho'} title={t.hecho ? 'Volver a pendiente' : 'Marcar como hecho'} onClick={onMarcar}><Icon name="check" size={12} /></button>
        </div>
      )}
      {!puede && t.hecho && <span className="cr-check on solo" aria-label="Hecho"><Icon name="check" size={12} /></span>}
    </article>
  );
}

// El estado de despacho de una tarjeta: el estado, a quién le toca y los puntitos del checklist con lo que falta.
const PUNTO: Record<'ok' | 'no' | 'medio' | 'pend' | 'parcial', string> = { ok: 'M3.5 8.5l3 3 6-7', no: 'M4.5 4.5l7 7M11.5 4.5l-7 7', medio: 'M4 8h8', pend: 'M4 8h8', parcial: 'M4 8h8' };
const V_TXT = { ok: 'sí', no: 'no', medio: 'en parte', pend: 'pendiente', parcial: 'una parte' } as const;
// Cada control con su dibujito (pedido de Rodrigo del 20/11/2026), para saber de un pantallazo qué es lo que falta: la
// impresora es la producción (como en el menú), la caja la mercadería en el depósito, el $ el pago, el pin la dirección,
// la hoja el remito y el lápiz una anotación que traba. Dibujados para 16 px, así se leen chiquitos. El estado va en el
// color y en la marquita de la esquina (✓, ✗ o –), para no depender solo del color.
const ICONO_CONTROL: Record<Control['k'], string> = {
  prod: 'M4.5 6V2.5h7V6M4.5 11.5H3V6h10v5.5h-1.5M5 9.5h6V14H5z',
  dep: 'M2.5 5 8 2.5 13.5 5v6.5L8 14l-5.5-2.5zM2.5 5 8 7.5 13.5 5M8 7.5V14',
  pago: 'M10.6 5C10.1 4 9.1 3.4 8 3.4c-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2.1 2.7.9 2.7 2.2-1.2 2.1-2.7 2.1c-1.2 0-2.2-.6-2.7-1.6M8 1.8v12.4',
  dir: 'M8 14.5s4.5-4 4.5-7.6a4.5 4.5 0 0 0-9 0C3.5 10.5 8 14.5 8 14.5zM8 8.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  remito: 'M4 1.8h5.5l3 3v9.4H4zM9.5 1.8v3h3M6.2 8h4.1M6.2 10.6h4.1',
  nota: 'M3 13l.9-3.1 6.9-6.9a1.4 1.4 0 0 1 2 2L5.9 12.1zM9.8 4l2.2 2.2',
};
function PuntoControl({ c, solo }: { c: Control; solo?: boolean }) {
  // `solo`: en una lista que ya dice el nombre y el detalle al lado (la vista previa del pedido), es solo el dibujo.
  const dicho = `${c.nombre}: ${V_TXT[c.v]}`;
  return (
    <i role={solo ? undefined : 'listitem'} className={`cr-punto ${c.v}`} aria-hidden={solo || undefined}
      title={solo ? undefined : `${dicho}${c.t ? ` · ${c.t}` : ''}`} aria-label={solo ? undefined : dicho}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={ICONO_CONTROL[c.k]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <svg className="cr-punto-marca" viewBox="0 0 16 16" aria-hidden="true"><path d={PUNTO[c.v]} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </i>
  );
}
function Quien({ d }: { d: DespachoTarjeta }) {
  if (!d.quien) return null;
  return d.quien === 'ventas' && d.owner_id ? <UserChip id={d.owner_id} size="xs" /> : <>{NOMBRE_ROL[d.quien]}{d.lugar ? ` · ${lindo(d.lugar)}` : ''}</>;
}
const RelojTag = ({ r }: { r: Riesgo }) => <span className={`cr-desp-reloj ${r.nivel}`}><Icon name="timer" size={11} />{r.texto}</span>;
// `reprogramar`: un colgado al que ya se le destrabó lo que lo colgó: se le puede dar fecha.
function FilaDespacho({ d, tipo, reloj, reprogramar }: { d: DespachoTarjeta; tipo: Tipo; reloj?: Riesgo | null; reprogramar?: boolean }) {
  const falta = faltaTexto(d);
  return (
    <div className="cr-t-desp">
      <div className="cr-t-desp-l1">
        <span className={`cr-desp-chip cr-d-${reprogramar ? 'listo' : d.estado}`}><Icon name={reprogramar ? 'calendar' : ICONO_ESTADO[d.estado]} size={11} />{reprogramar ? 'Listo para reprogramar' : etiquetaEstado(d, tipo)}</span>
        {d.quien && <span className="cr-desp-quien" title="A quién le toca el próximo paso"><Quien d={d} /></span>}
      </div>
      {reloj && <RelojTag r={reloj} />}
      {d.checks.length > 0 && (
        <div className="cr-t-desp-l2">
          <span className="cr-puntos" role="list" aria-label="Checklist de salida">
            {d.checks.map((c) => <PuntoControl key={c.k} c={c} />)}
          </span>
          {falta && <small title={d.checks.filter((c) => c.t && c.v !== 'ok').map((c) => `${c.nombre}: ${c.t}`).join(' · ') || undefined}>{falta}</small>}
        </div>
      )}
    </div>
  );
}

// El despacho en la vista previa del pedido (arriba de todo): el estado, a quién le toca, si llega y el checklist entero.
const V_LARGO = { ok: 'Sí', no: 'No', medio: 'En parte', pend: 'Pendiente', parcial: 'Una parte' } as const;
function PanelDespacho({ t, dir, hoy, feriados }: { t: Tarjeta; dir?: DirParada; hoy: string; feriados?: Record<string, string> }) {
  const d = despachoTarjeta(t, dir);
  if (!d) return null;
  const r = riesgo(d, t.fecha, hoy, feriados);
  const colgado = t.movs.find((m) => m.colgado)?.colgado ?? null;
  return (
    <section className="panel cr-pv-desp" aria-label="Despacho">
      <div className="panel-head"><h3>Despacho</h3><span className="small muted">{carrilDe(t.tipo).uno}{t.tipo === 'entrega' ? '' : ` · ${t.titulo}`} · {diaLargo(t.fecha)}</span></div>
      <div className="cr-pv-desp-body">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className={`cr-desp-chip cr-d-${d.estado}`}><Icon name={ICONO_ESTADO[d.estado]} size={12} />{etiquetaEstado(d, t.tipo)}</span>
          {r && <RelojTag r={r} />}
        </div>
        {d.quien && <div className="small row" style={{ gap: 6 }}><span className="muted">Le toca a</span><Quien d={d} /></div>}
        {colgado && <div className="cr-t-motivo"><p>{colgado.motivo}</p><span className="small">Colgado · era del {diaCorto(colgado.fecha)}{colgado.por ? ` · ${colgado.por}` : ''}</span></div>}
        {d.checks.length > 0 && (
          <ul className="cr-pv-checks">
            {d.checks.map((c) => <li key={c.k}><PuntoControl c={c} solo />
              <span><b>{c.nombre}</b> <span className="muted">{c.t ?? V_LARGO[c.v]}</span></span></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

// Colgados: cuántos días lleva y en qué orden van (lo que ya se puede reprogramar arriba; después, del más viejo al más nuevo).
const diasColgado = (at: string) => Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 86_400_000));
const destrabado = (t: Tarjeta) => { const e = despachoTarjeta(t)?.estado; return e === 'listo' || e === 'remitido'; };
function ordenColgados(ts: Tarjeta[]) {
  const desde = (t: Tarjeta) => t.movs.find((m) => m.colgado)?.colgado?.at ?? '';
  return [...ts].sort((a, b) => Number(destrabado(b)) - Number(destrabado(a)) || desde(a).localeCompare(desde(b)));
}

// La barrita de cada día: cuánto hay de cada estado, de un vistazo.
const ORDEN_MEZCLA: EstadoDespacho[] = ['hecho', 'remitido', 'listo', 'prog', 'cola', 'nollego', 'info', 'nopago'];
function MezclaDia({ estados }: { estados: EstadoDespacho[] }) {
  if (!estados.length) return null;
  const n = (e: EstadoDespacho) => estados.filter((x) => x === e).length;
  return (
    <div className="cr-dia-mezcla" role="img" aria-label={ORDEN_MEZCLA.filter((e) => n(e)).map((e) => `${n(e)} ${nombreEstado(e, 'entrega').toLowerCase()}`).join(', ')}>
      {ORDEN_MEZCLA.filter((e) => n(e)).map((e) => <i key={e} className={`cr-d-${e}`} style={{ flex: n(e) }} title={`${n(e)} · ${nombreEstado(e, 'entrega')}`} />)}
    </div>
  );
}

// La hora de la parada de una tarjeta, desde la semana (pedido de Producción del 19/11/2026): una hora o un rango, para
// que Logística organice el recorrido. Es la misma hora fijada de la Ruta del día: el recorrido se ordena para cumplirla.
const MODOS_HORA: Array<[ModoHora, string]> = [['entre', 'Entre'], ['a_las', 'A las'], ['antes', 'Antes de las'], ['desde', 'Desde las']];
export function CamposHora({ modo, hora, hasta, onModo, onHora, onHasta }: { modo: ModoHora; hora: string; hasta: string; onModo: (m: ModoHora) => void; onHora: (h: string) => void; onHasta: (h: string) => void }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-label="Horario">
      {MODOS_HORA.map(([k, t]) => <button key={k} type="button" className={`chip${modo === k ? ' on' : ''}`} aria-pressed={modo === k} onClick={() => onModo(k)}>{t}</button>)}
      <input type="time" className="input sm" style={{ width: 'auto' }} value={hora} onChange={(e) => onHora(e.target.value)} aria-label={modo === 'entre' ? 'Desde' : 'Hora'} required />
      {modo === 'entre' && <><span className="small muted">y las</span><input type="time" className="input sm" style={{ width: 'auto' }} value={hasta} onChange={(e) => onHasta(e.target.value)} aria-label="Hasta" required /></>}
    </div>
  );
}
export const ayudaHora = (modo: ModoHora) => (modo === 'entre' ? 'Tiene que llegar dentro de ese rango.' : modo === 'a_las' ? 'Llega entre 15 minutos antes y 15 después.' : modo === 'antes' ? 'Tiene que llegar antes de esa hora.' : 'No antes de esa hora.');
function ModalHora({ t, onCerrar, onListo }: { t: Tarjeta; onCerrar: () => void; onListo: () => void }) {
  const toast = useToast();
  const [modo, setModo] = useState<ModoHora>('entre');
  const [hora, setHora] = useState('10:00');
  const [hasta, setHasta] = useState('13:00');
  const [ocupado, setOcupado] = useState(false);
  const actual = t.movs[0]?.hora ?? null;
  const ok = !!hora && (modo !== 'entre' || (!!hasta && hasta > hora));
  const guardar = async (m: ModoHora | null) => {
    setOcupado(true);
    try {
      await http('PUT', '/cronograma/hora', { fecha: t.fecha, clave: t.movs[0].parada, modo: m, hora, hasta });
      toast(m ? `${t.titulo}: horario guardado. El recorrido del ${diaCorto(t.fecha)} se ordena para cumplirlo.` : `${t.titulo}: sin horario fijado.`);
      onListo();
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  };
  return (
    <Modal title={`Horario · ${t.titulo} (${t.pdv})`} onClose={onCerrar}
      footer={<><button type="button" className="btn" onClick={onCerrar}>Cancelar</button>{actual && <button type="button" className="btn" disabled={ocupado} onClick={() => guardar(null)}>Sacar el horario</button>}
        <button type="button" className="btn primary" disabled={ocupado || !ok} onClick={() => guardar(modo)}>Guardar</button></>}>
      {actual && <p className="small" style={{ marginTop: 0 }}>Hoy tiene: <b>{actual}</b></p>}
      <CamposHora modo={modo} hora={hora} hasta={hasta} onModo={setModo} onHora={setHora} onHasta={setHasta} />
      <p className="small muted">{ayudaHora(modo)} Vale para toda la parada de ese día (en un proveedor o impresor, todos sus retiros y egresos). El recorrido se ordena solo para cumplirlo y el chofer lo ve en su app.</p>
      {modo === 'entre' && !!hora && !!hasta && hasta <= hora && <p className="small danger-text">La segunda hora tiene que ser más tarde.</p>}
    </Modal>
  );
}

// La cantidad que realmente se manda (o llega) de un producto, cuando no es la del pedido: la demasía. Queda anotada en
// la tarjeta y en el remito de traslado; la cantidad del PDV no cambia.
function ModalEnviado({ m, onCerrar, onListo }: { m: Mov; onCerrar: () => void; onListo: () => void }) {
  const toast = useToast();
  const [cantidad, setCantidad] = useState(String(m.enviado?.cantidad ?? m.cantidad ?? ''));
  const [motivo, setMotivo] = useState(m.enviado?.motivo ?? '');
  const [ocupado, setOcupado] = useState(false);
  const n = Number(cantidad), dif = m.cantidad != null && cantidad !== '' && Number.isFinite(n) ? n - m.cantidad : 0;
  const verbo = m.tipo === 'egreso' ? 'se manda' : m.tipo === 'ingreso' ? 'llega' : 'se retira';
  const guardar = async (valor: string) => {
    setOcupado(true);
    try {
      await http('POST', '/cronograma/enviado', { id: m.task_id, tipo: m.tipo, cantidad: valor === '' ? null : Number(valor), motivo });
      toast(valor === '' || Number(valor) === m.cantidad ? 'Quedó con la cantidad del pedido.' : `Anotado: ${verbo}n ${num.format(Number(valor))}${dif > 0 ? ` (${num.format(dif)} de más)` : ''}.`);
      onListo();
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  };
  return (
    <Modal title={`Cantidad que ${verbo} · ${m.articulo || 'Artículo'}`} onClose={onCerrar}
      footer={<><button type="button" className="btn" onClick={onCerrar}>Cancelar</button>{m.enviado && <button type="button" className="btn" disabled={ocupado} onClick={() => guardar('')}>Volver a la del pedido</button>}
        <button type="button" className="btn primary" disabled={ocupado || cantidad === '' || !Number.isFinite(n) || n < 0} onClick={() => guardar(cantidad)}>Guardar</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>PDV {m.npdv ?? '—'} · el pedido es de <b>{m.cantidad != null ? num.format(m.cantidad) : '—'}</b>. Si van unos de más (por si alguno sale fallado, para pruebas), anotá cuántos van en total. La cantidad del PDV no cambia{m.tipo === 'egreso' ? '; el remito de traslado sale con esta cantidad' : ''}.</p>
      <label className="small">Cantidad que {verbo}
        <input className="input" type="number" min={0} step="1" autoFocus value={cantidad} onChange={(e) => setCantidad(e.target.value)} /></label>
      {dif !== 0 && <p className="small" style={{ margin: '6px 0' }}><b>{dif > 0 ? `${num.format(dif)} de más` : `${num.format(-dif)} de menos`}</b> respecto del pedido.</p>}
      <label className="small">Por qué (opcional)
        <input className="input" maxLength={200} placeholder="Demasía por fallados, para pruebas…" value={motivo} onChange={(e) => setMotivo(e.target.value)} /></label>
    </Modal>
  );
}

// El motivo de lo que se deja en «Colgados»: los de siempre, a un clic, o el que se escriba.
function ModalColgar({ a, onCerrar, onColgar }: { a: { ids: string[]; tipo: Tipo; pdv: string }; onCerrar: () => void; onColgar: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('');
  const ok = motivo.trim().length >= 3;
  return (
    <Modal title={`${a.pdv}: ¿por qué queda pendiente?`} onClose={onCerrar}
      footer={<><button type="button" className="btn" onClick={onCerrar}>Cancelar</button><button type="button" className="btn primary" disabled={!ok} onClick={() => onColgar(motivo.trim())}>Dejar en Colgados</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>{carrilDe(a.tipo).uno} sale de su día y queda en la columna Colgados hasta que se resuelva. Al responsable del pedido le llega el aviso (en el Hub y por mail) con el motivo.</p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {MOTIVOS_COLGADO.map((m) => <button key={m} type="button" className={`chip${motivo === m ? ' on' : ''}`} aria-pressed={motivo === m} onClick={() => setMotivo(m)}>{m}</button>)}
      </div>
      <textarea className="input" rows={3} autoFocus placeholder="Qué pasó…" value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} aria-label="Motivo"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ok) onColgar(motivo.trim()); }} />
    </Modal>
  );
}

// Un encargo (Recorridos): a dónde, quién lo pidió y qué se deja o se retira. Se arrastra a otro día, se le elige el
// chofer y se marca hecho como las demás tarjetas; un clic lo abre.
function TarjetaEncargo({ e, hoy, puede, choferes, expresos, dir, buscando, onDir, onAbrir, onChofer, onMover, onMarcar, onArrastrar, onAnotar, onBultos, expandida }: {
  e: Encargo; hoy: string; puede: boolean; choferes: string[]; expresos: string[]; onAbrir: () => void; onChofer: (c: string) => void; onMover: (f: string) => void;
  dir?: DirParada; buscando: boolean; onDir: (k: string, d: DirParada) => void;
  onMarcar: () => void; onArrastrar: (on: boolean) => void;
  onAnotar?: () => void;   // las anotaciones de logística de siempre de ese destino
  onBultos?: (b: Bultos | null) => void;   // anotar los bultos por medida (Logística, a mano)
  expandida?: boolean;
}) {
  const hecho = e.estado === 'hecho', atrasado = !hecho && e.fecha < hoy;
  const lineas = [...e.llevar.map((i) => ['Deja', i] as const), ...e.retirar.map((i) => ['Retira', i] as const)];
  return (
    <article className={`cr-tarjeta abre${hecho ? ' hecho' : ''}${atrasado ? ' atrasado' : ''}`} draggable={puede}
      onDragStart={(ev) => { ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', `enc:${e.id}`); } catch { /* no hace falta */ } onArrastrar(true); ev.currentTarget.classList.add('arrastrando'); }}
      onDragEnd={(ev) => { ev.currentTarget.classList.remove('arrastrando'); onArrastrar(false); }}
      onClick={(ev) => { if (!(ev.target as HTMLElement).closest('button, a, .popover, .select-pop, [role="dialog"]')) onAbrir(); }}>
      <div className="cr-t-rol"><Icon name="route" size={11} />Encargo</div>
      <div className="cr-t-quien"><span>{lindo(e.destino)}</span></div>
      <div className="cr-t-pidio"><QuienPidio id={e.user_id} name={e.quien} corto /></div>
      {dir && <LineaDireccion d={dir} buscando={buscando} puede={puede && !hecho} onCorregir={() => onDir(`${e.fecha}|${e.parada}`, dir)} />}
      {lineas.length > 0 && (
        <div className="cr-t-prods">
          {lineas.map(([que, i], k) => <div key={k}><b>{que}</b><span>{itemTexto(i)}</span></div>)}
        </div>
      )}
      {!lineas.length && e.notas && <div className="cr-t-item">{e.notas}</div>}
      {/* Las anotaciones de logística de siempre de ese destino. */}
      {!!e.anotaciones?.length && <div className="cr-t-notas">{e.anotaciones.map((n) => <LineaNota key={n.id} n={n} />)}</div>}
      {(e.urgente || e.estado === 'no_se_pudo' || e.horario || e.hora) && (
        <div className="cr-t-tags">
          {e.hora && <span className="cr-tag fija" title="Hora fijada en la ruta del día"><Icon name="timer" size={11} />{e.hora}</span>}
          {e.urgente && <span className="cr-tag late">Urgente</span>}
          {e.estado === 'no_se_pudo' && <span className="cr-tag riesgo"><Icon name="alert" size={11} />{ESTADO_ENC.no_se_pudo.nombre}{e.motivo ? `: ${e.motivo}` : ''}</span>}
          {e.horario && <span className="cr-tag">{e.horario}</span>}
        </div>
      )}
      {((puede && !hecho) || e.chofer || (onBultos && (puede || totalBultos(e.bultos) > 0))) && (
        <div className="cr-t-pie">
          {puede && !hecho ? (
            <div className="cr-t-chofer">
              <Select className={`input cr-chofer${e.chofer ? '' : ' vacio'}`} value={e.chofer ?? ''} aria-label="Chofer" title={e.chofer ? `Chofer: ${e.chofer}` : 'Elegir el chofer'} onChange={(ev) => onChofer(ev.target.value)}>
                {opcionesChofer({ choferes, expresos, actual: e.chofer, vacio: 'Sin chofer', agregar: 'Agregar chofer o expreso…' })}
              </Select>
            </div>
          ) : e.chofer && <div className="cr-t-chofer solo" title="Chofer"><Icon name="truck" size={12} />{e.chofer}</div>}
          {onBultos && <BultosTarjeta b={e.bultos ?? SIN_BULTOS} puede={puede} detalle={expandida} onGuardar={onBultos} />}
        </div>
      )}
      {puede && (
        <div className="cr-t-acc">
          {onAnotar && <button type="button" className="cr-mini" aria-label="Anotaciones de logística del destino" title="Anotaciones de logística: lo que hay que saber cada vez que se va a este lugar" onClick={onAnotar}><Icon name="note" size={13} /></button>}
          <SelectorFecha valor={e.fecha} onElegir={(f) => f && onMover(f)} label="Pasar a otro día" className="cr-mini" title="Pasar a otro día"><Icon name="calendar" size={13} /></SelectorFecha>
          <button type="button" className={`cr-check${hecho ? ' on' : ''}`} aria-pressed={hecho} aria-label={hecho ? 'Volver a pendiente' : 'Marcar como hecho'} title={hecho ? 'Volver a pendiente' : 'Marcar como hecho'} onClick={onMarcar}><Icon name="check" size={12} /></button>
        </div>
      )}
      {!puede && hecho && <span className="cr-check on solo" aria-label="Hecho"><Icon name="check" size={12} /></span>}
    </article>
  );
}

// Los bultos de la tarjeta (pedido de Rodrigo del 20/11/2026): por ahora los anota Logística a mano, en cualquier tarjeta,
// por medida: cajas de 40×30, de 60×40 (con esas se calcula si entra en la camioneta) y de otra medida. Sin anotar, quien
// edita ve «+ Bultos»; anotados, «5 bultos» (con el desglose al pasar el mouse y, en el día expandido, a la vista); un clic
// los cambia y todo en 0 los saca. Quien solo mira los ve si están. El dibujo son cajas apiladas (la caja sola es
// «mercadería en el depósito», en el checklist).
const ICONO_BULTOS = <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5zM5.5 2.5h5v6h-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
function BultosTarjeta({ b, puede, detalle, onGuardar }: { b: Bultos; puede: boolean; detalle?: boolean; onGuardar: (b: Bultos | null) => void }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState<Record<keyof Bultos, string>>({ c40: '', c60: '', otros: '' });
  const n = totalBultos(b);
  if (!n && !puede) return null;
  const desglose = desgloseBultos(b);
  const contenido = <>{ICONO_BULTOS}{n ? textoBultos(n) : '+ Bultos'}{detalle && n > 0 && <small className="cr-bultos-des">{desglose}</small>}</>;
  if (!puede) return <span className="cr-bultos solo" title={`Bultos: ${desglose}`}>{contenido}</span>;
  if (editando) {
    const leer = (k: keyof Bultos) => (valor[k].trim() === '' ? 0 : Number(valor[k]));
    const nuevo: Bultos = { c40: leer('c40'), c60: leer('c60'), otros: leer('otros') };
    const valido = MEDIDAS.every((m) => Number.isInteger(nuevo[m.k]) && nuevo[m.k] >= 0 && nuevo[m.k] <= 9999);
    const igual = MEDIDAS.every((m) => nuevo[m.k] === b[m.k]);
    return (
      <EditarEnLinea className="cr-bultos-form" confirmar="Guardar los bultos" sucio={!igual} onCancelar={() => setEditando(false)}
        onGuardar={() => { if (!valido) return; setEditando(false); if (!igual) onGuardar(totalBultos(nuevo) ? nuevo : null); }}>
        {MEDIDAS.map((m, i) => (
          <label key={m.k} className="cr-bultos-med" title={m.ayuda}>
            <span>{m.nombre}</span>
            <input className="input sm num" type="number" inputMode="numeric" min={0} max={9999} step={1} autoFocus={i === 0} value={valor[m.k]} placeholder="0"
              onChange={(e) => setValor((v) => ({ ...v, [m.k]: e.target.value }))} aria-label={m.ayuda} aria-invalid={!(Number.isInteger(nuevo[m.k]) && nuevo[m.k] >= 0) || undefined} />
          </label>
        ))}
      </EditarEnLinea>
    );
  }
  return (
    <button type="button" className={`cr-bultos${n ? '' : ' vacio'}`} title={n ? `${desglose}. Clic para cambiarlo` : 'Anotar cuántos bultos son (cajas de 40×30, de 60×40 u otras)'}
      onClick={() => { setValor({ c40: b.c40 ? String(b.c40) : '', c60: b.c60 ? String(b.c60) : '', otros: b.otros ? String(b.otros) : '' }); setEditando(true); }}>{contenido}</button>
  );
}

// La dirección de la parada, en una línea (pedido de Rodrigo del 18/11/2026): con el tilde verde si está ubicada en el
// mapa y en naranja si falta o no se encontró. Un clic la corrige ahí mismo (en el pedido o en la ficha de la empresa,
// igual que en la Ruta del día). La de un expreso o un encargo sin empresa se cambia desde su lugar, no desde acá.
// Una que todavía no se buscó en el mapa: la ruedita mientras el servidor la busca; si no la buscó (quien solo mira no
// dispara la búsqueda, o el buscador no contesta), queda en naranja como sin ubicar.
const ESTADO_DIR: Record<DirParada['estado'], string> = {
  ok: 'Ubicada en el mapa', no_encontrada: 'No se encontró en el mapa: corregila', buscando: 'Todavía sin ubicar en el mapa', sin_direccion: 'Falta la dirección',
};
function LineaDireccion({ d: d0, buscando, puede, onCorregir }: { d: DirParada; buscando: boolean; puede: boolean; onCorregir: () => void }) {
  const ubicando = d0.estado === 'buscando' && buscando;
  const d = d0.estado === 'buscando' && !buscando ? { ...d0, estado: 'no_encontrada' as const } : d0;
  const editable = puede && !d.expreso && d.origen !== 'encargo' && (d.record_ids.length > 0 || !!d.company_id);
  const falta = d.estado === 'no_encontrada' || d.estado === 'sin_direccion';
  // El piso, depto, puerta o unidad y las observaciones de entrega, en una segunda línea (si no, una dirección larga lo tapa).
  const texto = d.direccion ? lindaDireccion(d.direccion) : 'Sin dirección';
  const titulo = `${texto}${d.detalle ? ` · ${d.detalle}` : ''}${d.observaciones ? ` — ${d.observaciones}` : ''}${d.otras ? ` (y ${d.otras} dirección${d.otras === 1 ? '' : 'es'} más)` : ''} · ${ubicando ? 'Buscándola en el mapa…' : ESTADO_DIR[d0.estado]}${editable ? ' · clic para corregirla' : ''}`;
  const contenido = (
    <>
      <span className="cr-t-dir-fila">
      <Icon name="pin" size={11} />
      <span className="cr-t-dir-txt">{texto}</span>
      {d.otras > 0 && <span className="cr-t-dir-mas num">+{d.otras}</span>}
      {d.estado === 'ok' ? <span className="cr-t-dir-ok" aria-label="Ubicada en el mapa"><Icon name="check" size={10} /></span>
        : ubicando ? <span className="cr-t-dir-busca" aria-label="Buscándola en el mapa" />
          : <span className="cr-t-dir-falta" aria-label={ESTADO_DIR[d0.estado]}><Icon name="alert" size={11} /></span>}
      </span>
      {(d.detalle || d.observaciones) && <span className="cr-t-dir-obs">{d.detalle && <b>{d.detalle}</b>}{d.detalle && d.observaciones ? ' · ' : ''}{d.observaciones && <i>{d.observaciones}</i>}</span>}
      {/* Un pedido que se reparte entre varios lugares: cuánto va a cada uno. */}
      {(d.sitios?.length ?? 0) > 1 && <span className="cr-t-sitios">{d.sitios!.map((x) => <span key={x}>{x}</span>)}</span>}
    </>
  );
  const cls = `cr-t-dir ${falta ? 'falta' : d.estado}`;
  return editable
    ? <button type="button" className={cls} title={titulo} aria-label={`Dirección: ${titulo}`} onClick={onCorregir}>{contenido}</button>
    : <div className={cls} title={titulo}>{contenido}</div>;
}

// Notas sueltas del día: lo que no es de un artículo («llevar el sobre a Matienzo»).
function Notas({ dia, notas, puede, onCambio }: { dia: string; notas: Nota[]; puede: boolean; onCambio: () => void }) {
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const hacer = (p: Promise<unknown>) => p.then(onCambio, (e) => toast((e as Error).message, true));
  if (!notas.length && !puede) return null;
  return (
    <div className="cr-carril cr-k-N">
      {notas.length > 0 && <h3>Notas <span className="num">{notas.length}</span></h3>}
      {notas.map((n) => (
        <div key={n.id} className={`cr-tarjeta nota${n.hecho ? ' hecho' : ''}`}>
          <div className="cr-t-item">{n.texto}</div>
          {puede && (
            <div className="cr-t-acc">
              <button type="button" className="cr-mini" aria-label="Borrar la nota" title="Borrar la nota" onClick={() => hacer(http('DELETE', `/cronograma/notas/${n.id}`))}><Icon name="trash" size={13} /></button>
              <button type="button" className={`cr-check${n.hecho ? ' on' : ''}`} aria-pressed={!!n.hecho} aria-label={n.hecho ? 'Volver a pendiente' : 'Marcar como hecho'} onClick={() => hacer(http('PATCH', `/cronograma/notas/${n.id}`, { hecho: !n.hecho }))}><Icon name="check" size={12} /></button>
            </div>
          )}
        </div>
      ))}
      {puede && (abierto ? (
        <EditarEnLinea className="cr-nota-form" confirmar="Agregar" sucio={!!texto.trim()} onCancelar={() => setAbierto(false)} onGuardar={() => {
          if (!texto.trim()) return;
          void http('POST', '/cronograma/notas', { fecha: dia, texto }).then(() => { setTexto(''); setAbierto(false); onCambio(); }, (err) => toast((err as Error).message, true));
        }}>
          <input className="input sm" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Llevar el sobre a…" aria-label="Nota del día" />
        </EditarEnLinea>
      ) : <button type="button" className="cr-agregar" onClick={() => setAbierto(true)}><Icon name="plus" size={12} />Nota</button>)}
    </div>
  );
}

function Feriado({ dia, nombre, puede, onCambio }: { dia: string; nombre?: string; puede: boolean; onCambio: () => void }) {
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('Feriado');
  const guardar = (n: string) => http('PUT', '/cronograma/feriados', { fecha: dia, nombre: n }).then(() => { setAbierto(false); onCambio(); }, (e) => toast((e as Error).message, true));
  if (nombre) return <div className="cr-feriado"><span>{nombre}</span>{puede && <button type="button" className="cr-mini" aria-label="Sacar el feriado" title="No es feriado" onClick={() => guardar('')}><Icon name="x" size={12} /></button>}</div>;
  if (!puede) return null;
  return abierto ? (
    <EditarEnLinea className="cr-nota-form" sucio={texto !== 'Feriado'} onCancelar={() => setAbierto(false)} onGuardar={() => { if (texto.trim()) void guardar(texto.trim()); }}>
      <input className="input sm" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Nombre del feriado" />
    </EditarEnLinea>
  ) : <button type="button" className="cr-agregar feriado" onClick={() => setAbierto(true)}>Marcar feriado</button>;
}

// Listos para entregar que todavía no tienen fecha: se arrastran al día, o se les elige la fecha.
function SinFecha({ items, puede, onArrastrar, onMover, onAbrir }: {
  items: SinFecha[]; puede: boolean; onArrastrar: (a: { ids: string[]; tipo: Tipo; de: string | null; pdv: string } | null) => void;
  onMover: (ids: string[], fecha: string, pdv: string) => void; onAbrir: (id: number) => void;
}) {
  const grupos = useMemo(() => {
    const m = new Map<string, SinFecha[]>();
    for (const s of items) m.set(s.pdv_task, [...(m.get(s.pdv_task) ?? []), s]);
    return [...m.values()];
  }, [items]);
  if (!grupos.length) return null;
  return (
    <section className="cr-bandeja cr-k-E">
      <div className="cr-bandeja-tit"><div className="eyebrow">Listos para entregar, sin fecha</div><div className="muted small">{puede ? 'Arrastralos al día que corresponda' : `${grupos.length} PDV`}</div></div>
      {grupos.map((g) => {
        const pdv = `PDV ${g[0].npdv ?? '—'}`, ids = g.map((x) => x.task_id);
        return (
          <article key={g[0].pdv_task} className={`cr-tarjeta${g[0].record_id ? ' abre' : ''}`} draggable={puede}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', pdv); } catch { /* no hace falta */ } onArrastrar({ ids, tipo: 'entrega', de: null, pdv }); }}
            onDragEnd={() => onArrastrar(null)}
            onClick={(e) => { if (g[0].record_id && !(e.target as HTMLElement).closest('button, .popover, [role="dialog"]')) onAbrir(g[0].record_id); }}>
            <div className="cr-t-quien">{lindo(g[0].cliente) || pdv}</div>
            <div className="cr-t-linea">{unidadDeTexto(g[0].unidad) && <UnidadBadge k={unidadDeTexto(g[0].unidad)!} compact />}<span className="cr-t-pdv num">{pdv}</span></div>
            {/* Una prenda en varios talles, en un renglón con sus talles (talles.ts). */}
            {(() => {
              const es = juntarTalles(g.filter((x) => x.articulo));
              return <>
                {es.slice(0, 3).map((e) => (e.k === 'uno' ? <div key={e.x.task_id} className="cr-t-item">{cantidad(e.x)}</div>
                  : <div key={e.clave} className="cr-t-item">{cantidad({ cantidad: e.xs.reduce((n, x) => n + (x.cantidad ?? 0), 0), articulo: e.xs[0].producto || e.xs[0].articulo })}
                    <span className="muted"> ({textoTalles(e.xs)})</span></div>))}
                {es.length > 3 && <div className="cr-t-item muted">+ {es.length - 3} más</div>}
              </>;
            })()}
            {puede && <div className="cr-t-acc"><SelectorFecha valor={null} onElegir={(f) => f && onMover(ids, f, pdv)} label="Ponerle fecha de entrega" className="cr-mini" title="Ponerle fecha de entrega"><Icon name="calendar" size={13} /></SelectorFecha></div>}
          </article>
        );
      })}
    </section>
  );
}

// ---------- Choferes y expresos (también los usa la Ruta del día) ----------

// Las opciones del desplegable «Chofer» (el Select del Hub): sin chofer, los choferes, los expresos y, con `agregar`, la
// opción para sumar uno a la lista (valor «+»). `actual` aparece aunque ya no esté en la lista. Es una función y no un
// componente porque el Select lee sus <option> directamente.
export function opcionesChofer({ choferes, expresos, actual, vacio, agregar }: { choferes: string[]; expresos: string[]; actual?: string | null; vacio: string; agregar?: string }) {
  const cs = [...new Set([...choferes, ...(actual && !expresos.includes(actual) ? [actual] : [])])];
  return (
    <>
      <option value="">{vacio}</option>
      {cs.length > 0 && <optgroup label="Choferes">{cs.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>}
      {expresos.length > 0 && <optgroup label="Expresos">{expresos.map((x) => <option key={x} value={x}>{x}</option>)}</optgroup>}
      {agregar && <option value="+"><span className="select-nuevo"><Icon name="plus" size={13} />{agregar}</span></option>}
    </>
  );
}

// Agregar un chofer o un expreso a la lista, desde el desplegable «Chofer» (de la Ruta del día o de una tarjeta). Del
// expreso se pide además la dirección, que es a donde se le lleva la mercadería (se puede buscar en la libreta).
export function NuevoTransportista({ soloExpreso, onListo, onCancelar }: { soloExpreso?: boolean; onListo: (nombre: string) => void; onCancelar: () => void }) {
  const toast = useToast();
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<'chofer' | 'expreso'>(soloExpreso ? 'expreso' : 'chofer');
  const [direccion, setDireccion] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const lugares = useLugares(tipo === 'expreso' && !direccion ? nombre : '');
  async function guardar(e: React.FormEvent) {
    e.preventDefault(); e.stopPropagation();
    if (nombre.trim().length < 2) return;
    setOcupado(true);
    try { const r = await http<{ nombre: string }>('POST', '/cronograma/transportistas', { nombre, tipo, direccion }); toast(`${r.nombre} quedó en la lista de ${tipo === 'expreso' ? 'expresos' : 'choferes'}.`); onListo(r.nombre); }
    catch (err) { toast((err as Error).message, true); setOcupado(false); }
  }
  return (
    <form className="cr-panel" onKeyDown={alEsc(onCancelar)} onSubmit={guardar}>
      {!soloExpreso && (
        <div className="row" role="group" aria-label="Qué es">
          <button type="button" className={`chip${tipo === 'chofer' ? ' on' : ''}`} aria-pressed={tipo === 'chofer'} onClick={() => setTipo('chofer')}>Chofer</button>
          <button type="button" className={`chip${tipo === 'expreso' ? ' on' : ''}`} aria-pressed={tipo === 'expreso'} onClick={() => setTipo('expreso')}>Expreso</button>
        </div>
      )}
      <label>{tipo === 'expreso' ? 'Nombre del expreso' : 'Nombre del chofer'}<input className="input sm" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} /></label>
      {tipo === 'expreso' && <label>Dirección del expreso (a dónde se le lleva)<input className="input sm" value={direccion} onChange={(e) => setDireccion(e.target.value)} placeholder="Calle y altura, localidad" maxLength={300} /></label>}
      {lugares.length > 0 && <ul className="cr-lugares">{lugares.map((l) => <li key={l.id}><button type="button" onClick={() => setDireccion(l.direccion)}><b>{l.nombre}</b><span>{l.direccion}</span></button></li>)}</ul>}
      {tipo === 'chofer' && <span className="muted small">Para que vea su recorrido en el celular, creale su código en Choferes (en Entregas → Choferes, si sos administrador), con el mismo nombre.</span>}
      <div className="acciones"><button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button><button type="submit" className="btn sm primary" disabled={ocupado || nombre.trim().length < 2}>Agregar</button></div>
    </form>
  );
}

// Lo que encuentra la libreta de direcciones para un texto (nombre del lugar, calle o localidad).
export function useLugares(q: string) {
  const [lugares, setLugares] = useState<Array<{ id: number; nombre: string; direccion: string; horario: string | null }>>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setLugares([]); return; }
    let vivo = true;
    const t = window.setTimeout(() => { http<{ lugares: typeof lugares }>('GET', `/cronograma/lugares${qs({ q })}`).then((r) => { if (vivo) setLugares(r.lugares); }, () => undefined); }, 250);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [q]);
  return lugares;
}
