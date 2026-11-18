import { Fragment, useMemo, useState } from 'react';
import { http, qs, useAsync, useToast, Icon, Cargando } from '../lib';

// Rendimiento de los choferes (pedido de Rodrigo del 17/11/2026; src/worker/rendimiento.ts, docs/RENDIMIENTO.md). Es la
// pestaña «Recorridos» de Analíticas (Analiticas.tsx). Qué
// recorrido hizo cada chofer cada día, en km y en tiempo. Arriba, el período y los totales; después, cada chofer con sus
// promedios (propios y externos) y, abajo, día por día: a qué hora salió y volvió, los km que hizo contra los del plan y
// las paradas. Un clic en un día lo abre: las paradas en el orden en que las hizo y, para Logística, corregir la hora.

interface Paso { clave: string; nombre: string; resultado: 'hecho' | 'no_se_pudo' | 'sin_marca' | 'sin_visitar'; at: string | null; orden: number | null; km: number | null; lejos: number | null }
type Origen = 'gps' | 'boton' | 'marca' | 'estimada' | 'manual' | null;
interface Fila {
  fecha: string; n: number; chofer: string; plan_km: number | null; plan_min: number | null; plan_paradas: number | null;
  salida_at: string | null; salida_origen: Origen; llegada_at: string | null; llegada_origen: Origen; min: number | null;
  km: number | null; min_manejo: number | null; hechas: number; no_se_pudo: number; sin_visitar: number;
  estimado: boolean; cerrado: boolean; corregido: boolean; pasos: Paso[]; plan: string[];
}
interface Datos { desde: string; hasta: string; hoy: string; filas: Fila[]; faltan: string[]; choferes: Array<{ nombre: string; propio: boolean }> }

const ZONA = 'America/Argentina/Buenos_Aires';
const D = (iso: string) => new Date(`${iso}T12:00:00`);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sumar = (dia: string, n: number) => { const d = D(dia); d.setDate(d.getDate() + n); return iso(d); };
const hoyIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: ZONA });
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const dia = (f: string) => `${DIAS[D(f).getDay()]} ${D(f).getDate()}/${D(f).getMonth() + 1}`;
const hora = (at: string | null) => (at ? new Date(at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONA }) : '');
const n1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const km = (x: number | null | undefined) => (x == null ? '—' : `${n1.format(x)} km`);
const duracion = (m: number | null | undefined) => (m == null ? '—' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`);
const ORIGEN: Record<string, string> = { gps: 'por GPS', boton: 'la avisó el chofer', marca: 'al marcar la última parada', estimada: 'estimada con las paradas', manual: 'corregida a mano' };
const RESULTADO: Record<Paso['resultado'], string> = { hecho: 'Hecha', no_se_pudo: 'No se pudo', sin_marca: 'Hecha (marcada desde el Hub)', sin_visitar: 'Sin hacer' };

// Los períodos de siempre. La semana va de lunes a domingo.
function periodos(hoy: string): Array<{ k: string; nombre: string; desde: string; hasta: string }> {
  const d = D(hoy), lunes = sumar(hoy, -((d.getDay() + 6) % 7));
  const mes = iso(new Date(d.getFullYear(), d.getMonth(), 1)), mesAnt = iso(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  return [
    { k: 'semana', nombre: 'Esta semana', desde: lunes, hasta: hoy },
    { k: 'semana-ant', nombre: 'Semana pasada', desde: sumar(lunes, -7), hasta: sumar(lunes, -1) },
    { k: 'mes', nombre: 'Este mes', desde: mes, hasta: hoy },
    { k: 'mes-ant', nombre: 'Mes pasado', desde: mesAnt, hasta: sumar(mes, -1) },
    { k: '90', nombre: 'Últimos 90 días', desde: sumar(hoy, -89), hasta: hoy },
  ];
}

// Los números de un grupo de recorridos (un chofer, o todos). Los promedios usan solo los días que tienen el dato.
function resumen(filas: Fila[]) {
  const suma = (f: (x: Fila) => number | null) => filas.reduce((s, x) => s + (f(x) ?? 0), 0);
  const conKm = filas.filter((x) => x.km != null), conMin = filas.filter((x) => x.min != null), conPlan = conKm.filter((x) => x.plan_km != null && x.plan_km > 0);
  const visitadas = (x: Fila) => x.hechas + x.no_se_pudo;
  const kms = suma((x) => x.km), mins = suma((x) => x.min), dias = new Set(filas.map((x) => x.fecha)).size;
  const paradasConKm = conKm.reduce((s, x) => s + visitadas(x), 0), paradasConMin = conMin.reduce((s, x) => s + visitadas(x), 0);
  const planKm = conPlan.reduce((s, x) => s + x.plan_km!, 0), realKm = conPlan.reduce((s, x) => s + x.km!, 0);
  return {
    recorridos: filas.length, dias, km: kms, min: mins, hechas: suma((x) => x.hechas), no_se_pudo: suma((x) => x.no_se_pudo), sin_visitar: suma((x) => x.sin_visitar),
    kmDia: conKm.length ? kms / new Set(conKm.map((x) => x.fecha)).size : null, minDia: conMin.length ? mins / new Set(conMin.map((x) => x.fecha)).size : null,
    kmParada: paradasConKm ? conKm.reduce((s, x) => s + x.km!, 0) / paradasConKm : null, minParada: paradasConMin ? conMin.reduce((s, x) => s + x.min!, 0) / paradasConMin : null,
    // Cuánto más (o menos) hizo que lo que daba el plan, en km.
    desvio: planKm ? (realKm - planKm) / planKm : null,
    estimados: filas.filter((x) => x.estimado || x.salida_origen === 'estimada' || x.llegada_origen === 'estimada').length,
  };
}
const pct = (x: number | null) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Math.round(x * 100)} %`);

export function RendimientoPanel() {
  const toast = useToast();
  const hoy = hoyIso();
  const ps = useMemo(() => periodos(hoy), [hoy]);
  const [periodo, setPeriodo] = useState('mes');
  const [quienes, setQuienes] = useState<'todos' | 'propios' | 'externos'>('todos');
  const p = ps.find((x) => x.k === periodo) ?? ps[2];
  const res = useAsync(() => http<Datos>('GET', `/rendimiento${qs({ desde: p.desde, hasta: p.hasta })}`), [p.desde, p.hasta]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [trayendo, setTrayendo] = useState<{ hecho: number; total: number } | null>(null);
  const datos = res.data;
  const propio = (chofer: string) => !!datos?.choferes.find((c) => c.nombre === chofer)?.propio;
  const filas = (datos?.filas ?? []).filter((f) => quienes === 'todos' || propio(f.chofer) === (quienes === 'propios'));
  const total = resumen(filas);
  const porChofer = [...new Set(filas.map((f) => f.chofer))].map((c) => ({ chofer: c, propio: propio(c), ...resumen(filas.filter((f) => f.chofer === c)) })).sort((a, b) => b.km - a.km);

  // Medir días (los que faltan, o el de hoy): de a uno, porque cada día consulta al servicio de rutas.
  const medir = async (fechas: string[]) => {
    setTrayendo({ hecho: 0, total: fechas.length });
    let mal = 0;
    for (let i = 0; i < fechas.length; i++) {
      try { await http('POST', '/rendimiento/medir', { fecha: fechas[i] }); } catch { mal++; }
      setTrayendo({ hecho: i + 1, total: fechas.length });
    }
    setTrayendo(null); res.reload();
    toast(mal ? `${mal === 1 ? 'Un día no se pudo medir' : `${mal} días no se pudieron medir`}: probá de nuevo en un rato.` : fechas.length === 1 ? 'Día medido.' : `${fechas.length} días medidos.`, !!mal);
  };
  const marcarPropio = async (chofer: string, v: boolean) => {
    try { await http('PUT', '/rendimiento/chofer', { nombre: chofer, propio: v }); res.reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const exportar = () => {
    const celda = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const num = (x: number | null) => (x == null ? '' : String(x).replace('.', ','));
    const lineas = [['Fecha', 'Chofer', 'Vehículo', 'Salió', 'Cómo se supo', 'Volvió', 'Cómo se supo', 'Minutos en la calle', 'Km', 'Km del plan', 'Minutos del plan', 'Paradas del plan', 'Hechas', 'No se pudo', 'Sin hacer', 'Estimado'],
      ...filas.map((f) => [f.fecha, f.chofer, propio(f.chofer) ? 'Propio' : 'Externo', hora(f.salida_at), ORIGEN[f.salida_origen ?? ''] ?? '', hora(f.llegada_at), ORIGEN[f.llegada_origen ?? ''] ?? '',
        num(f.min), num(f.km), num(f.plan_km), num(f.plan_min), f.plan_paradas ?? '', f.hechas, f.no_se_pudo, f.sin_visitar, f.estimado ? 'sí' : ''])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${lineas.map((l) => l.map(celda).join(';')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `rendimiento-choferes-${p.desde}-a-${p.hasta}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="rd">
      <div className="page-head rd-cab">
        <h2>Rendimiento de los recorridos</h2>
        <button type="button" className="btn" disabled={!!trayendo} onClick={() => medir([hoy])} title="Vuelve a medir los recorridos de hoy con lo que los choferes marcaron hasta ahora"><Icon name="refresh" size={15} />Medir hoy</button>
        <button type="button" className="btn" disabled={!filas.length} onClick={exportar} title="Descarga el día por día de este período en un CSV"><Icon name="download" size={15} />Exportar</button>
      </div>
      <p className="muted rd-que">Los km son por calles, pasando por las paradas que el chofer marcó en la app, en el orden en que las marcó. La salida y la llegada salen del GPS de la app o del aviso del chofer; si no avisó, se estiman con la primera y la última parada.</p>
      <div className="rd-filtros" role="group" aria-label="Período">
        {ps.map((x) => <button key={x.k} type="button" className={`chip${x.k === periodo ? ' on' : ''}`} aria-pressed={x.k === periodo} onClick={() => { setPeriodo(x.k); setAbierta(null); }}>{x.nombre}</button>)}
        <span className="rd-sep" />
        {(['todos', 'propios', 'externos'] as const).map((k) => <button key={k} type="button" className={`chip${quienes === k ? ' on' : ''}`} aria-pressed={quienes === k} onClick={() => setQuienes(k)}>{k === 'todos' ? 'Todos' : k === 'propios' ? 'Vehículos de Formas' : 'Externos'}</button>)}
      </div>

      {datos && datos.faltan.length > 0 && (
        <div className="rd-aviso" role="status">
          <span>{datos.faltan.length === 1 ? 'Hay 1 día' : `Hay ${datos.faltan.length} días`} de este período con recorridos que todavía no se midieron.</span>
          <button type="button" className="btn sm primary" disabled={!!trayendo} onClick={() => medir(datos.faltan)}>{trayendo ? `Midiendo ${trayendo.hecho} de ${trayendo.total}…` : 'Medirlos ahora'}</button>
        </div>
      )}
      {res.error && <div className="rd-aviso mal" role="alert">{res.error}</div>}
      {!datos && !res.error && <Cargando />}

      {datos && (
        <>
          <div className="kpis">
            <div className="card kpi"><span className="label">Km recorridos</span><span className="value">{n1.format(total.km)}</span><span className="muted small">{total.kmDia != null ? `${n1.format(total.kmDia)} km por día de reparto` : 'en el período'}</span></div>
            <div className="card kpi"><span className="label">Horas en la calle</span><span className="value">{duracion(total.min || null)}</span><span className="muted small">{total.minDia != null ? `${duracion(total.minDia)} por día de reparto` : 'sin horarios todavía'}</span></div>
            <div className="card kpi"><span className="label">Paradas hechas</span><span className="value">{total.hechas}</span><span className="muted small">{total.no_se_pudo ? `${total.no_se_pudo} no se ${total.no_se_pudo === 1 ? 'pudo' : 'pudieron'}` : 'ninguna fallida'}{total.sin_visitar ? ` · ${total.sin_visitar} sin hacer` : ''}</span></div>
            <div className="card kpi"><span className="label">Por parada</span><span className="value">{total.kmParada != null ? n1.format(total.kmParada) : '—'}<small> km</small></span><span className="muted small">{total.minParada != null ? `${duracion(total.minParada)} cada una, con el viaje` : 'sin horarios todavía'}</span></div>
            <div className="card kpi"><span className="label">Contra el plan</span><span className="value">{pct(total.desvio)}</span><span className="muted small">en km, {total.recorridos} {total.recorridos === 1 ? 'recorrido' : 'recorridos'}{total.estimados ? ` · ${total.estimados} con algún dato estimado` : ''}</span></div>
          </div>

          <h2 className="rd-h">Por chofer</h2>
          {porChofer.length ? (
            <div className="table-wrap">
              <table className="grid rd-tabla">
                <thead><tr>
                  <th className="nosort">Chofer</th><th className="nosort">Vehículo</th><th className="nosort der">Días</th><th className="nosort der">Km</th><th className="nosort der" title="Km por día de reparto">Km/día</th>
                  <th className="nosort der" title="Horas en la calle, de la salida a la llegada, por día de reparto">Horas/día</th><th className="nosort der" title="Las que hizo; entre paréntesis, las que no se pudieron">Paradas</th><th className="nosort der" title="Km por cada parada que visitó">Km/parada</th>
                  <th className="nosort der" title="Tiempo en la calle dividido las paradas que visitó: incluye el viaje">Tiempo/parada</th><th className="nosort der" title="Cuánto más (o menos) hizo que lo que daba el plan, en km">Vs. plan</th>
                </tr></thead>
                <tbody>
                  {porChofer.map((c) => (
                    <tr key={c.chofer}>
                      <td><b>{c.chofer}</b></td>
                      <td><button type="button" className={`tag rd-propio${c.propio ? ' info' : ''}`} onClick={() => marcarPropio(c.chofer, !c.propio)}
                        title={c.propio ? 'El vehículo es de Formas. Tocá para pasarlo a externo.' : 'Es externo. Tocá si el vehículo es de Formas.'}>{c.propio ? 'De Formas' : 'Externo'}</button></td>
                      <td className="der">{c.dias}</td><td className="der">{km(c.km)}</td><td className="der">{km(c.kmDia)}</td><td className="der">{duracion(c.minDia)}</td>
                      <td className="der">{c.hechas}{c.no_se_pudo ? <span className="muted"> ({c.no_se_pudo} no)</span> : null}</td><td className="der">{km(c.kmParada)}</td><td className="der">{duracion(c.minParada)}</td>
                      <td className={`der${c.desvio != null && c.desvio > 0.25 ? ' rd-alto' : ''}`}>{pct(c.desvio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">Todavía no hay recorridos medidos en este período{quienes !== 'todos' ? ' para ese grupo' : ''}.</p>}

          <h2 className="rd-h">Día por día</h2>
          {filas.length > 0 && (
            <div className="table-wrap">
              <table className="grid rd-tabla">
                <thead><tr>
                  <th className="nosort">Día</th><th className="nosort">Chofer</th><th className="nosort">Salió</th><th className="nosort">Volvió</th><th className="nosort der">En la calle</th>
                  <th className="nosort der">Km</th><th className="nosort der">Km del plan</th><th className="nosort der">Paradas</th><th className="nosort">Notas</th>
                </tr></thead>
                <tbody>
                  {filas.map((f) => {
                    const k = `${f.fecha}:${f.n}`, ab = abierta === k;
                    return (
                      <Fragment key={k}>
                        <tr className={`rd-fila${ab ? ' sel' : ''}`} onClick={() => setAbierta(ab ? null : k)} aria-expanded={ab}>
                          <td>{dia(f.fecha)}</td><td><b>{f.chofer}</b></td>
                          <td title={f.salida_origen ? `La salida: ${ORIGEN[f.salida_origen]}` : undefined}>{hora(f.salida_at) || '—'}{f.salida_origen === 'estimada' && <span className="muted"> ≈</span>}</td>
                          <td title={f.llegada_origen ? `La llegada: ${ORIGEN[f.llegada_origen]}` : undefined}>{hora(f.llegada_at) || '—'}{f.llegada_origen === 'estimada' && <span className="muted"> ≈</span>}</td>
                          <td className="der">{duracion(f.min)}</td><td className="der">{km(f.km)}</td><td className="der muted">{km(f.plan_km)}</td>
                          <td className="der">{f.hechas} de {f.plan_paradas ?? f.hechas + f.no_se_pudo + f.sin_visitar}</td>
                          <td className="rd-notas">
                            {f.no_se_pudo > 0 && <span className="tag bad">{f.no_se_pudo} no se {f.no_se_pudo === 1 ? 'pudo' : 'pudieron'}</span>}
                            {f.estimado && <span className="tag warn" title="Algún tramo se calculó en línea recta (el servicio de rutas no contestó) o hay una parada sin ubicar en el mapa">Km estimados</span>}
                            {f.corregido && <span className="tag" title="Logística corrigió la hora de salida o de llegada">Corregido</span>}
                            {!f.cerrado && <span className="tag info">{f.fecha === datos.hoy ? 'Hoy, en curso' : 'Sin cerrar'}</span>}
                          </td>
                        </tr>
                        {ab && <tr className="rd-detalle"><td colSpan={9}><Detalle f={f} alGuardar={() => res.reload()} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {filas.length > 0 && <p className="muted small">≈ : hora estimada con las paradas, porque el chofer no avisó. Un clic en un día muestra las paradas y deja corregir la hora.</p>}
        </>
      )}
    </div>
  );
}

// Un recorrido abierto: las paradas en el orden en que las hizo (con su hora y los km del tramo), las que quedaron sin
// hacer, el orden que tenía el plan y la corrección de la hora de salida y de llegada.
function Detalle({ f, alGuardar }: { f: Fila; alGuardar: () => void }) {
  const toast = useToast();
  const [salida, setSalida] = useState(hora(f.salida_at)), [llegada, setLlegada] = useState(hora(f.llegada_at));
  const [guardando, setGuardando] = useState(false);
  const hechas = f.pasos.filter((p) => p.orden != null).sort((a, b) => a.orden! - b.orden!), sin = f.pasos.filter((p) => p.orden == null);
  const cambio = salida !== hora(f.salida_at) || llegada !== hora(f.llegada_at);
  const guardar = async () => {
    setGuardando(true);
    try {
      await http('PATCH', `/rendimiento/${f.fecha}/${f.n}`, { ...(salida !== hora(f.salida_at) ? { salida } : {}), ...(llegada !== hora(f.llegada_at) ? { llegada } : {}) });
      toast('Hora corregida.'); alGuardar();
    } catch (e) { toast((e as Error).message, true); }
    setGuardando(false);
  };
  return (
    <div className="rd-det">
      <div>
        <h3>Lo que hizo</h3>
        {hechas.length ? (
          <ol className="rd-pasos">
            {hechas.map((p) => (
              <li key={p.clave} className={p.resultado === 'no_se_pudo' ? 'mal' : ''}>
                <span className="rd-paso-hora">{hora(p.at) || '—'}</span>
                <span><b>{p.nombre}</b><small>{RESULTADO[p.resultado]}{p.km != null ? ` · ${km(p.km)} desde la anterior` : ''}
                  {p.lejos != null && p.lejos > 500 ? <em> · la marcó a {p.lejos >= 1000 ? `${n1.format(p.lejos / 1000)} km` : `${p.lejos} m`} del lugar</em> : null}</small></span>
              </li>
            ))}
          </ol>
        ) : <p className="muted">El chofer no marcó ninguna parada.</p>}
        {sin.length > 0 && <p className="muted small">Sin hacer: {sin.map((p) => p.nombre).join(', ')}.</p>}
      </div>
      <div>
        <h3>El plan</h3>
        <p className="muted small">{f.plan.length ? f.plan.join(' → ') : 'Sin paradas.'}</p>
        <p className="small">{km(f.plan_km)} y {duracion(f.plan_min)} en la calle, según la ruta del día.{f.min_manejo != null ? ` Lo que hizo son ${duracion(f.min_manejo)} de manejo con la calle libre.` : ''}</p>
        <h3>Corregir la hora</h3>
        <div className="rd-corregir">
          <label>Salió<input className="input sm" type="time" value={salida} onChange={(e) => setSalida(e.target.value)} /></label>
          <label>Volvió<input className="input sm" type="time" value={llegada} onChange={(e) => setLlegada(e.target.value)} /></label>
          <button type="button" className="btn sm primary" disabled={!cambio || guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
        </div>
        <p className="muted small">La salida: {f.salida_origen ? ORIGEN[f.salida_origen] : 'sin dato'}. La llegada: {f.llegada_origen ? ORIGEN[f.llegada_origen] : 'sin dato'}. Vaciar una hora la devuelve a lo que diga la app o a la estimación.</p>
      </div>
    </div>
  );
}
