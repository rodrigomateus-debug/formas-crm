import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, qs, useToast, Icon } from '../lib';
import { SelectorFecha } from '../Fecha';
import { RecordPreview } from './RecordPage';
import { Avatar, Modal } from '../components';
import { Select } from '../Select';
import { LogoProveedor, marcaProveedor } from '../proveedores';

// Cronograma (pedido de Rodrigo del 12/11/2026): reemplaza la planilla «Cronograma Semanal» de Logística. Cada día con
// sus entregas, ingresos, retiros y egresos, armados solos con las fechas de cada artículo en ClickUp. Arrastrar una
// tarjeta a otro día cambia la fecha en ClickUp; el círculo la marca como hecha (y el artículo cambia de estado). Arriba,
// la barra de semanas para ir a cualquier semana, pasada o futura, y ver cuánto queda pendiente. «Ruta del día» arma el
// recorrido en el mapa (CronogramaRuta.tsx). Ver docs/CRONOGRAMA.md.

const CronogramaRuta = lazy(() => import('./CronogramaRuta'));

export type Tipo = 'entrega' | 'ingreso' | 'retiro_proveedor' | 'egreso' | 'retiro_impresor';
export interface Mov {
  id: string; tipo: Tipo; fecha: string; task_id: string; pdv_task: string; npdv: string | null; cliente: string | null; unidad: string | null;
  record_id: number | null; articulo: string; cantidad: number | null; estado: string; lugar: string | null; company_id: number | null;
  hecho: boolean; hecho_por: number | null; evento: boolean; avisos: string[]; url: string | null; dominio?: string | null;
  expreso?: { nombre: string; guia: string | null } | null;
  chofer?: string | null;     // quién hace la parada ese día (el chofer o el expreso de su recorrido); no viene en los ingresos
  retira_en?: string | null;  // lo retira el cliente en Formas: no es parada de nadie
}
interface Nota { id: number; fecha: string; texto: string; hecho: number }
interface SinFecha { task_id: string; pdv_task: string; npdv: string | null; cliente: string | null; unidad: string | null; record_id: number | null; articulo: string; cantidad: number | null }
interface DiaResumen { total: number; pendientes: number; atrasados: number }
interface Vista {
  hoy: string; desde: string; hasta: string; movimientos: Mov[]; notas: Nota[]; feriados: Record<string, string>; dias: Record<string, DiaResumen>;
  sin_fecha: SinFecha[]; puede_editar: boolean; choferes?: string[]; expresos?: string[];
}

export const CARRILES: Array<{ k: 'E' | 'I' | 'R' | 'G'; nombre: string; uno: string; tipos: Tipo[]; ayuda: string }> = [
  { k: 'E', nombre: 'Entregas', uno: 'Entrega', tipos: ['entrega'], ayuda: 'Al cliente' },
  { k: 'I', nombre: 'Ingresos', uno: 'Ingreso', tipos: ['ingreso'], ayuda: 'Llega al depósito' },
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
export const cantidad = (m: { cantidad: number | null; articulo: string }) => [m.cantidad != null ? num.format(m.cantidad) : '', m.articulo].filter(Boolean).join(' ');

// Una tarjeta: los artículos de un PDV que tienen el mismo movimiento, el mismo día, en el mismo lugar.
// `parada`: va en la ruta del día (no es un ingreso ni lo retira el cliente), así que se le elige el chofer.
interface Tarjeta { key: string; tipo: Tipo; fecha: string; titulo: string; pdv: string; para: string; movs: Mov[]; hecho: boolean; evento: boolean; avisos: string[]; record_id: number | null; dominio: string | null; crudo: string;
  parada: boolean; chofer: string | null; retira_en: string | null }
function tarjetas(movs: Mov[]): Tarjeta[] {
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
        parada: x.tipo !== 'ingreso' && !x.retira_en, chofer: x.chofer ?? null, retira_en: x.retira_en ?? null,
        titulo: lindo(crudo) || (entrega ? pdv : x.tipo === 'egreso' || x.tipo === 'retiro_impresor' ? 'Sin impresor' : 'Sin proveedor') };
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

export default function CronogramaPage() {
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const semana = lunesDe(/^\d{4}-\d{2}-\d{2}$/.test(sp.get('semana') ?? '') ? sp.get('semana')! : hoyIso());
  const vista = sp.get('vista') === 'ruta' ? 'ruta' : 'semana';
  const [centro, setCentro] = useState(semana);   // la semana del medio de la barra
  const [datos, setDatos] = useState<Vista | null>(null);
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');
  const [unidad, setUnidad] = useState('');
  const [pendientes, setPendientes] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [nuevoPara, setNuevoPara] = useState<Tarjeta | null>(null);   // agregar un chofer o expreso a la lista, desde una tarjeta
  const [sobre, setSobre] = useState<string | null>(null);   // el día sobre el que se está arrastrando
  const arrastre = useRef<{ ids: string[]; tipo: Tipo; de: string | null; pdv: string } | null>(null);
  const pedido = useRef(0);

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
  // Lo que cambian en ClickUp llega cada 10 minutos: la pantalla se pone al día sola.
  useEffect(() => { const t = window.setInterval(() => { if (!document.hidden && !arrastre.current) void cargar(); }, 120_000); return () => window.clearInterval(t); }, [cargar]);

  const v = datos && datos.desde === semana ? datos : null;
  const q = buscar.trim().toLowerCase();
  const unidades = useMemo(() => [...new Set((v?.movimientos ?? []).map((m) => m.unidad).filter((u): u is string => !!u))].sort(), [v]);
  const movs = useMemo(() => (v?.movimientos ?? []).filter((m) => coincide(m, q) && (!unidad || m.unidad === unidad) && (!pendientes || !m.hecho)), [v, q, unidad, pendientes]);
  // Sábado y domingo se ven si tienen algo: un movimiento, una nota o un feriado.
  const finDeSemana = [5, 6].filter((i) => { const d = sumar(semana, i); return movs.some((m) => m.fecha === d) || !!v?.notas.some((n) => n.fecha === d); });
  const dias = [0, 1, 2, 3, 4, ...finDeSemana].map((i) => sumar(semana, i));
  const puede = !!v?.puede_editar;

  async function mover(ids: string[], tipo: Tipo, fecha: string, pdv: string) {
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map((m) => (ids.includes(m.task_id) && m.tipo === tipo ? { ...m, fecha } : m)), sin_fecha: d.sin_fecha.filter((s) => !ids.includes(s.task_id)) });
    try {
      for (let i = 0; i < ids.length; i += 25) await http('POST', '/cronograma/mover', { ids: ids.slice(i, i + 25), tipo, fecha });
      toast(`${pdv}: ${carrilDe(tipo).uno.toLowerCase()} pasó al ${diaCorto(fecha)}. Ya está en ClickUp.`);
    } catch (e) { toast((e as Error).message, true); }
    void cargar();
  }
  async function marcar(t: Tarjeta) {
    const hecho = !t.hecho, ids = t.movs.map((m) => m.task_id);
    setDatos((d) => d && { ...d, movimientos: d.movimientos.map((m) => (ids.includes(m.task_id) && m.tipo === t.tipo ? { ...m, hecho } : m)) });
    try {
      const r = { cambiados: 0, estado: null as string | null };
      for (let i = 0; i < ids.length; i += 25) { const x = await http<{ cambiados: number; estado: string | null }>('POST', '/cronograma/hecho', { ids: ids.slice(i, i + 25), tipo: t.tipo, hecho }); r.cambiados += x.cambiados; r.estado = x.estado; }
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
  const soltar = (fecha: string) => {
    const a = arrastre.current;
    arrastre.current = null; setSobre(null);
    if (a && a.de !== fecha) void mover(a.ids, a.tipo, fecha, a.pdv);
  };

  const total = movs.length, hechos = movs.filter((m) => m.hecho).length;
  return (
    <div className="content cr-page">
      <div className="page-head">
        <h1>Cronograma {v && <span className="muted small">{total} movimientos · {hechos} hechos</span>}</h1>
        <div className="row" role="group" aria-label="Vista">
          <button type="button" className={`btn sm${vista === 'semana' ? ' primary' : ''}`} aria-pressed={vista === 'semana'} onClick={() => ir({ vista: null })}><Icon name="calendar" size={14} />Semana</button>
          <button type="button" className={`btn sm${vista === 'ruta' ? ' primary' : ''}`} aria-pressed={vista === 'ruta'} onClick={() => ir({ vista: 'ruta', dia })}><Icon name="route" size={14} />Ruta del día</button>
        </div>
      </div>

      <BarraSemanas semana={semana} centro={centro} dias={datos?.dias ?? {}} hoy={datos?.hoy ?? hoyIso()}
        onElegir={(s) => ir({ semana: s, dia: null })} onCentro={setCentro} onHoy={() => { const h = lunesDe(hoyIso()); setCentro(h); ir({ semana: h, dia: null }); }} />

      {error && <div className="aviso warn small" style={{ marginBottom: 12 }}>{error}</div>}

      {vista === 'semana' && (
        <>
          <div className="toolbar">
            <div className="search" style={{ minWidth: 220, flex: '0 1 280px' }}><Icon name="search" />
              <input className="input" placeholder="Buscar PDV, cliente, proveedor o producto" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar" />
            </div>
            {unidades.length > 1 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Unidad de negocio">
                {unidades.map((u) => <button key={u} type="button" className={`chip${unidad === u ? ' on' : ''}`} aria-pressed={unidad === u} onClick={() => setUnidad(unidad === u ? '' : u)}>{u.charAt(0) + u.slice(1).toLowerCase()}</button>)}
              </div>
            )}
            <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={pendientes} onChange={(e) => setPendientes(e.target.checked)} />Solo lo pendiente</label>
            <span className="grow" />
            <div className="cr-leyenda small">{CARRILES.map((c) => <span key={c.k} className={`cr-k-${c.k}`} title={c.ayuda}><i />{c.nombre}</span>)}</div>
          </div>
          {v && !puede && <div className="aviso info small" style={{ marginBottom: 12 }}>Ves el cronograma para saber cuándo sale cada cosa. Lo editan Logística, Producción y los administradores.</div>}
          {!v && !error && <div className="empty plain">Cargando la semana…</div>}
          {v && (
            <div className="cr-scroll">
              <div className="cr-semana" style={{ gridTemplateColumns: `repeat(${dias.length}, minmax(214px, 1fr))` }}>
                {dias.map((d) => {
                  const delDia = movs.filter((m) => m.fecha === d), notas = v.notas.filter((n) => n.fecha === d);
                  const pend = delDia.filter((m) => !m.hecho).length;
                  return (
                    <section key={d} className={`cr-dia${d === v.hoy ? ' hoy' : ''}${v.feriados[d] ? ' feriado' : ''}${sobre === d ? ' sobre' : ''}`}
                      onDragOver={(e) => { if (arrastre.current && puede) { e.preventDefault(); if (sobre !== d) setSobre(d); } }}
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSobre((s) => (s === d ? null : s)); }}
                      onDrop={(e) => { e.preventDefault(); soltar(d); }}>
                      <header className="cr-dia-cab">
                        <div className="cr-dia-tit"><b>{DIAS[D(d).getDay()]}</b><span className="num">{D(d).getDate()}/{D(d).getMonth() + 1}</span>{d === v.hoy && <span className="cr-hoy">Hoy</span>}</div>
                        <div className="cr-dia-sub">
                          <span className={`num${pend && d < v.hoy ? ' overdue' : ''}`}>{delDia.length ? (pend ? `${pend} ${d < v.hoy ? `atrasado${pend === 1 ? '' : 's'}` : `pendiente${pend === 1 ? '' : 's'}`} de ${delDia.length}` : `${delDia.length} hechos`) : 'Sin movimientos'}</span>
                          {delDia.some((m) => m.tipo !== 'ingreso') && <button type="button" className="cr-link" onClick={() => ir({ vista: 'ruta', dia: d })}><Icon name="route" size={12} />Ruta</button>}
                        </div>
                        <Feriado dia={d} nombre={v.feriados[d]} puede={puede} onCambio={cargar} />
                      </header>
                      <div className="cr-carriles">
                        {CARRILES.map((c) => {
                          const ts = tarjetas(delDia.filter((m) => c.tipos.includes(m.tipo)));
                          if (!ts.length) return null;
                          return (
                            <div key={c.k} className={`cr-carril cr-k-${c.k}`}>
                              <h3>{c.nombre} <span className="num">{ts.length}</span></h3>
                              {ts.map((t) => <TarjetaMov key={t.key} t={t} hoy={v.hoy} puede={puede} choferes={v.choferes ?? []} expresos={v.expresos ?? []} onChofer={(c) => asignar(t, c)}
                                onMarcar={() => marcar(t)} onAbrir={t.record_id ? () => setPreview(t.record_id) : undefined}
                                onMover={(f) => mover(t.movs.map((m) => m.task_id), t.tipo, f, `PDV ${t.movs[0].npdv ?? ''}`)}
                                onArrastrar={(on) => { arrastre.current = on ? { ids: t.movs.map((m) => m.task_id), tipo: t.tipo, de: t.fecha, pdv: `PDV ${t.movs[0].npdv ?? ''}` } : null; if (!on) setSobre(null); }} />)}
                            </div>
                          );
                        })}
                        <Notas dia={d} notas={notas} puede={puede} onCambio={cargar} />
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          )}
          {v && <SinFecha items={v.sin_fecha.filter((s) => coincide(s, q) && (!unidad || s.unidad === unidad))} puede={puede}
            onArrastrar={(a) => { arrastre.current = a; if (!a) setSobre(null); }} onMover={(ids, f, pdv) => mover(ids, 'entrega', f, pdv)} onAbrir={setPreview} />}
        </>
      )}

      {vista === 'ruta' && (
        <Suspense fallback={<div className="empty plain">Cargando el mapa…</div>}>
          <CronogramaRuta fecha={dia} semana={semana} hoy={datos?.hoy ?? hoyIso()} resumen={datos?.dias ?? {}} onFecha={(d) => ir({ dia: d })} onAbrir={setPreview} onCambio={cargar} />
        </Suspense>
      )}
      {preview && <RecordPreview key={preview} type="order" id={preview} onClose={() => setPreview(null)} onChange={cargar} />}
      {nuevoPara && (
        <Modal title="Agregar chofer o expreso" onClose={() => setNuevoPara(null)}>
          <NuevoTransportista onCancelar={() => setNuevoPara(null)} onListo={(nombre) => { const t = nuevoPara; setNuevoPara(null); void asignar(t, nombre); }} />
        </Modal>
      )}
    </div>
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
  const meses: Array<{ mes: string; semanas: string[] }> = [];
  for (const s of semanas) {
    const jueves = D(sumar(s, 3)), mes = `${MESES[jueves.getMonth()]}${jueves.getFullYear() !== D(hoy).getFullYear() ? ` ${jueves.getFullYear()}` : ''}`;
    if (meses[meses.length - 1]?.mes === mes) meses[meses.length - 1].semanas.push(s); else meses.push({ mes, semanas: [s] });
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
            <div className="cr-mes-nombre">{m.mes}</div>
            <div className="cr-mes-semanas">
              {m.semanas.map((s) => {
                const ds = [0, 1, 2, 3, 4, 5, 6].map((i) => dias[sumar(s, i)]);
                const pend = ds.reduce((n, d) => n + (d?.pendientes ?? 0), 0), atr = ds.reduce((n, d) => n + (d?.atrasados ?? 0), 0), tot = ds.reduce((n, d) => n + (d?.total ?? 0), 0);
                const a = D(s), b = D(sumar(s, 4));
                return (
                  <button key={s} type="button" data-s={s} className={`cr-sem${s === semana ? ' on' : ''}${s === estaSemana ? ' actual' : ''}${s < estaSemana ? ' pasada' : ''}`} aria-current={s === semana}
                    title={`${s === estaSemana ? 'Esta semana. ' : ''}Semana del ${a.getDate()}/${a.getMonth() + 1} al ${b.getDate()}/${b.getMonth() + 1}: ${tot} movimientos, ${pend} pendientes${atr ? `, ${atr} atrasados` : ''}`}
                    onClick={(e) => { if (tiro.current?.movio) { e.preventDefault(); return; } onElegir(s); }}>
                    {s === estaSemana && <span className="cr-sem-actual">Esta semana</span>}
                    <span className="cr-sem-rango num">{a.getDate()}–{b.getDate()}{a.getMonth() !== b.getMonth() ? `/${b.getMonth() + 1}` : ''}</span>
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
  egreso: { nombre: 'Impresor', icono: 'printer' }, retiro_impresor: { nombre: 'Impresor', icono: 'printer' },
};
const TOPE = 3;

function TarjetaMov({ t, hoy, puede, choferes, expresos, onChofer, onMarcar, onAbrir, onMover, onArrastrar }: {
  t: Tarjeta; hoy: string; puede: boolean; choferes: string[]; expresos: string[]; onChofer: (chofer: string) => void;
  onMarcar: () => void; onAbrir?: () => void; onMover: (fecha: string) => void; onArrastrar: (on: boolean) => void;
}) {
  const atrasado = !t.hecho && t.fecha < hoy;
  // Hasta tres productos a la vista; el resto se abre con «+ N productos más», así un pedido largo no estira la columna.
  const [todo, setTodo] = useState(false);
  const prods = t.movs.filter((m) => m.articulo);
  const ver = todo ? prods : prods.slice(0, TOPE);
  const marca = t.tipo === 'entrega' ? null : marcaProveedor(t.crudo);
  return (
    <article className={`cr-tarjeta${t.hecho ? ' hecho' : ''}${atrasado ? ' atrasado' : ''}${onAbrir ? ' abre' : ''}`} draggable={puede}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.key); } catch { /* no hace falta */ } onArrastrar(true); e.currentTarget.classList.add('arrastrando'); }}
      onDragEnd={(e) => { e.currentTarget.classList.remove('arrastrando'); onArrastrar(false); }}
      onClick={(e) => { if (onAbrir && !(e.target as HTMLElement).closest('button, a, .popover, .select-pop, [role="dialog"]')) onAbrir(); }}>
      <div className="cr-t-rol"><Icon name={ROL[t.tipo].icono} size={11} />{ROL[t.tipo].nombre}</div>
      <div className="cr-t-quien">
        {marca ? <LogoProveedor marca={marca} /> : t.dominio ? <Avatar name={t.titulo} type="company" domain={t.dominio} size="xs" /> : null}
        <span>{t.titulo}</span>
      </div>
      <div className="cr-t-linea">
        <span className="cr-t-pdv num">{t.pdv}</span>
        {t.para && <span className="cr-t-para">{t.para}</span>}
        {t.movs[0]?.expreso && <span className="cr-tag exp" title="No va directo al cliente: se lleva al expreso">Expreso {lindo(t.movs[0].expreso.nombre)}{t.movs[0].expreso.guia ? ` · guía ${t.movs[0].expreso.guia}` : ''}</span>}
        {t.retira_en && <span className="cr-tag" title="Lo retira el cliente: no es parada de ningún recorrido">Retira en {t.retira_en}</span>}
        {t.evento && <span className="cr-evento"><svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M12 2l3 7 7 .6-5.3 4.7 1.7 7.2L12 17.8 5.6 21.5l1.7-7.2L2 9.6 9 9z" /></svg>Evento</span>}
      </div>
      {prods.length > 0 && (
        <div className="cr-t-prods">
          {ver.map((m) => <div key={m.id} className={m.hecho && !t.hecho ? 'ok' : ''}><b className="num">{m.cantidad != null ? num.format(m.cantidad) : ''}</b><span>{m.articulo}</span></div>)}
          {prods.length > TOPE && <button type="button" className="cr-t-mas" aria-expanded={todo} onClick={() => setTodo(!todo)}>{todo ? 'Ver menos' : `+ ${prods.length - TOPE} producto${prods.length - TOPE === 1 ? '' : 's'} más`}</button>}
        </div>
      )}
      {!t.hecho && t.avisos.length > 0 && (
        <div className="cr-t-tags">
          {t.avisos.map((a) => <span key={a} className="cr-tag riesgo"><Icon name="alert" size={11} />{a}</span>)}
        </div>
      )}
      {t.parada && (puede && !t.hecho ? (
        <div className="cr-t-chofer">
          <Select className={`input cr-chofer${t.chofer ? '' : ' vacio'}`} value={t.chofer ?? ''} aria-label="Chofer" title={t.chofer ? `Chofer: ${t.chofer}` : 'Elegir el chofer'}
            onChange={(e) => onChofer(e.target.value)}>
            {opcionesChofer({ choferes, expresos, actual: t.chofer, vacio: 'Sin chofer', agregar: 'Agregar chofer o expreso…' })}
          </Select>
        </div>
      ) : t.chofer && <div className="cr-t-chofer solo" title="Chofer"><Icon name="truck" size={12} />{t.chofer}</div>)}
      {puede && (
        <div className="cr-t-acc">
          <SelectorFecha valor={t.fecha} onElegir={(f) => f && onMover(f)} label="Pasar a otro día" className="cr-mini" title="Pasar a otro día"><Icon name="calendar" size={13} /></SelectorFecha>
          <button type="button" className={`cr-check${t.hecho ? ' on' : ''}`} aria-pressed={t.hecho} aria-label={t.hecho ? 'Volver a pendiente' : 'Marcar como hecho'} title={t.hecho ? 'Volver a pendiente' : 'Marcar como hecho'} onClick={onMarcar}><Icon name="check" size={12} /></button>
        </div>
      )}
      {!puede && t.hecho && <span className="cr-check on solo" aria-label="Hecho"><Icon name="check" size={12} /></span>}
    </article>
  );
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
        <form className="cr-nota-form" onSubmit={(e) => { e.preventDefault(); if (!texto.trim()) return; void http('POST', '/cronograma/notas', { fecha: dia, texto }).then(() => { setTexto(''); setAbierto(false); onCambio(); }, (err) => toast((err as Error).message, true)); }}>
          <input className="input sm" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Llevar el sobre a…" aria-label="Nota del día" onKeyDown={(e) => { if (e.key === 'Escape') setAbierto(false); }} />
          <button type="submit" className="btn sm primary">Agregar</button>
        </form>
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
    <form className="cr-nota-form" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void guardar(texto.trim()); }}>
      <input className="input sm" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Nombre del feriado" onKeyDown={(e) => { if (e.key === 'Escape') setAbierto(false); }} />
      <button type="submit" className="btn sm">Guardar</button>
    </form>
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
            <div className="cr-t-linea"><span className="cr-t-pdv num">{pdv}</span></div>
            {g.filter((x) => x.articulo).slice(0, 3).map((x) => <div key={x.task_id} className="cr-t-item">{cantidad(x)}</div>)}
            {g.length > 3 && <div className="cr-t-item muted">+ {g.length - 3} más</div>}
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
    <form className="cr-panel" onSubmit={guardar}>
      {!soloExpreso && (
        <div className="row" role="group" aria-label="Qué es">
          <button type="button" className={`chip${tipo === 'chofer' ? ' on' : ''}`} aria-pressed={tipo === 'chofer'} onClick={() => setTipo('chofer')}>Chofer</button>
          <button type="button" className={`chip${tipo === 'expreso' ? ' on' : ''}`} aria-pressed={tipo === 'expreso'} onClick={() => setTipo('expreso')}>Expreso</button>
        </div>
      )}
      <label>{tipo === 'expreso' ? 'Nombre del expreso' : 'Nombre del chofer'}<input className="input sm" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} /></label>
      {tipo === 'expreso' && <label>Dirección del expreso (a dónde se le lleva)<input className="input sm" value={direccion} onChange={(e) => setDireccion(e.target.value)} placeholder="Calle y altura, localidad" maxLength={300} /></label>}
      {lugares.length > 0 && <ul className="cr-lugares">{lugares.map((l) => <li key={l.id}><button type="button" onClick={() => setDireccion(l.direccion)}><b>{l.nombre}</b><span>{l.direccion}</span></button></li>)}</ul>}
      {tipo === 'chofer' && <span className="muted small">Para que vea su recorrido en el celular, además hay que crearle el link en Entregas → Choferes, con el mismo nombre.</span>}
      <div className="row"><button type="submit" className="btn sm primary" disabled={ocupado || nombre.trim().length < 2}>Agregar</button><button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button></div>
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
