import { useMemo, useState } from 'react';
import { juntarTalles, lineasMovs, textoTalles } from '../talles';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, Cargando, fmtDate, fmtRelative, userOf, recordUrl, type CrmRecord } from '../lib';
import { Avatar } from '../components';
import {
  CARRILES, carrilDe, cantidad, diaCorto, diaLargo, lindo, lunesDe, sumar, tarjetas, NuevoTransportista,
  type Mov, type Tarjeta, type Tipo, type Vista,
  idsYLugares,
} from '../pages/Cronograma';
import { MOTIVO, hechaParada, type Datos as Ruta, type Parada } from '../pages/CronogramaRuta';
import { ESTADO as ESTADO_ENC, itemTexto, resumen, hoyIso, type Encargo } from '../pages/Recorridos';
import type { Remito } from '../pages/Remitos';
import { ChoferesPanel } from '../pages/Choferes';
import { useNoLeidas } from '../pages/Conversacion';
import { Hoja, TareaRapida } from './Movil';
import { FilaTarea, PanelTarea, useCambiosTarea } from './TareasChatMovil';
import { EncargoAbierto } from './RecorridosMovil';
import { VerArchivo } from './VentasMovil';
import { Fallo, useCarga, usePuedeEscribir } from './base';

// Logística en el celular (versión celular, docs/MOVIL.md): lo que hace quien organiza el recorrido mientras se mueve.
// Hoy: cómo va cada chofer, lo que falta resolver (remitos para revisar, fotos que faltan, encargos sin chofer, lo
// atrasado) y sus tareas. Día: el cronograma de un día —marcar hecho, elegir chofer, pasar a otro día— y su ruta, parada
// por parada, con Llamar y Cómo llegar. Entregas: revisar los remitos con la foto. Lo que se arma con el mapa (ordenar
// paradas, corregir puntos, fijar horas) sigue en la compu.

const TANDA = 25;   // el servidor acepta de a 25 artículos por vez
const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const TIPO_CORTO: Record<Tipo, string> = { entrega: 'Entrega', ingreso: 'Ingreso', retiro_proveedor: 'Retiro', retiro_impresor: 'Retiro', egreso: 'Egreso', ingreso_impresor: 'Ingreso' };
const mapa = (p: { lat: number | null; lng: number | null; direccion: string | null; nombre: string }) => (p.lat != null && p.lng != null
  ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`
  : p.direccion ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.direccion)}` : undefined);
const tel = (v: string | null | undefined) => { const d = String(v ?? '').replace(/[^\d+]/g, ''); return d.length >= 6 ? `tel:${d}` : undefined; };

// Las paradas de un recorrido, en su orden (el que arma el servidor: el más corto, o el que se le dio a mano).
const paradasDe = (ruta: Ruta, n: number) => {
  const porClave = new Map(ruta.paradas.map((p) => [p.clave, p]));
  return (ruta.rutas.find((r) => r.n === n)?.orden ?? []).map((c) => porClave.get(c)).filter((p): p is Parada => !!p);
};
const avance = (ps: Parada[]) => ({
  hechas: ps.filter(hechaParada).length,
  sinFoto: ps.filter((p) => hechaParada(p) && !p.fotos).length,
  noSePudo: ps.filter((p) => p.visita?.resultado === 'no_se_pudo').length,
});

// ---------- Acciones compartidas (las mismas que el Cronograma y la Ruta del día de escritorio) ----------

function useAcciones(recargar: () => void) {
  const toast = useToast();
  return {
    // Marcar hechos (o pendientes) los artículos y encargos: los artículos cambian de estado en ClickUp.
    async hecho(movs: Mov[], encs: Encargo[], hecho: boolean, nombre: string, deshacer?: () => void) {
      const porTipo = new Map<Tipo, Mov[]>();
      for (const m of movs) if (m.hecho !== hecho) porTipo.set(m.tipo, [...(porTipo.get(m.tipo) ?? []), m]);
      try {
        let cambiados = 0;
        for (const [tipo, ms] of porTipo) for (let i = 0; i < ms.length; i += TANDA) cambiados += (await http<{ cambiados: number }>('POST', '/cronograma/hecho', { ...idsYLugares(ms.slice(i, i + TANDA)), tipo, hecho })).cambiados;
        for (const e of encs.filter((x) => (x.estado === 'hecho') !== hecho)) await http('PATCH', `/recorridos/encargos/${e.id}`, { estado: hecho ? 'hecho' : 'pendiente' });
        toast(!hecho ? `${nombre}: quedó pendiente.` : `${nombre}: hecho.${cambiados ? ` ${cambiados === 1 ? 'El artículo cambió' : `${cambiados} artículos cambiaron`} de estado en ClickUp.` : ''}`, false,
          deshacer ? { label: 'Deshacer', onClick: deshacer } : undefined);
      } catch (e) { toast(`${(e as Error).message} Puede haber quedado a medias: revisalo.`, true); }
      recargar();
    },
    // El chofer: pasa la parada entera al recorrido de ese chofer ese día (Ruta del día y app del chofer).
    async chofer(fecha: string, ids: string[], chofer: string, nombre: string) {
      try {
        const r = await http<{ chofer: string | null; recorrido: number; movimientos: number }>('PUT', '/cronograma/chofer', { fecha, ids, chofer });
        const otros = r.movimientos - ids.length;
        toast(`${nombre}: ${r.chofer ? `va con ${r.chofer}` : 'quedó sin chofer'} el ${diaCorto(fecha)}.${otros > 0 ? ' Va toda la parada de ese lugar.' : ''}`);
      } catch (e) { toast((e as Error).message, true); }
      recargar();
    },
    // Pasar a otro día: la fecha se escribe en ClickUp (o en el encargo).
    async mover(t: Tarjeta | Encargo, fecha: string) {
      try {
        if ('movs' in t) {
          for (let i = 0; i < t.movs.length; i += TANDA) await http('POST', '/cronograma/mover', { ...idsYLugares(t.movs.slice(i, i + TANDA)), tipo: t.tipo, fecha });
          toast(`${t.pdv}: ${carrilDe(t.tipo).uno.toLowerCase()} pasó al ${diaCorto(fecha)}. Ya está en ClickUp.`);
        } else {
          await http('PATCH', `/recorridos/encargos/${t.id}`, { fecha });
          toast(`Encargo a ${lindo(t.destino)}: pasó al ${diaCorto(fecha)}.`);
        }
      } catch (e) { toast((e as Error).message, true); }
      recargar();
    },
  };
}

// Elegir el chofer (o expreso) de una parada; o sumar uno nuevo a la lista.
function HojaChofer({ actual, choferes, expresos, onElegir, onClose }: { actual: string | null; choferes: string[]; expresos: string[]; onElegir: (c: string) => void; onClose: () => void }) {
  const [nuevo, setNuevo] = useState(false);
  return (
    <Hoja titulo="¿Quién va?" onClose={onClose}>
      {nuevo ? <NuevoTransportista onCancelar={() => setNuevo(false)} onListo={(n) => { onElegir(n); onClose(); }} /> : (
        <div className="m-etapas" role="radiogroup" aria-label="Chofer o expreso">
          {[...choferes, ...expresos].map((c) => (
            <button key={c} type="button" role="radio" aria-checked={actual === c} className={actual === c ? 'on' : ''} onClick={() => { onElegir(c); onClose(); }}>
              <Icon name={expresos.includes(c) ? 'truck' : 'volante'} size={16} />{c}{expresos.includes(c) && <small className="muted"> · expreso</small>}
              {actual === c && <Icon name="check" size={16} />}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={!actual} className={!actual ? 'on' : ''} onClick={() => { onElegir(''); onClose(); }}>
            <Icon name="x" size={16} />Sin chofer{!actual && <Icon name="check" size={16} />}</button>
          <button type="button" onClick={() => setNuevo(true)}><Icon name="plus" size={16} />Agregar chofer o expreso…</button>
        </div>
      )}
    </Hoja>
  );
}

// Pasar a otro día: los próximos días (con cuánto tiene cada uno) o cualquier fecha.
function HojaDia({ desde, actual, onElegir, onClose }: { desde: string; actual: string; onElegir: (f: string) => void; onClose: () => void }) {
  const [otra, setOtra] = useState('');
  const dias = Array.from({ length: 10 }, (_, i) => sumar(desde, i)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00`).getDay()) && d !== actual);
  return (
    <Hoja titulo="¿Para qué día?" onClose={onClose}>
      <div className="m-form">
        <div className="m-chips">{dias.map((d) => <button key={d} type="button" className="chip" onClick={() => { onElegir(d); onClose(); }}>{d === hoyIso() ? 'Hoy' : d === sumar(hoyIso(), 1) ? 'Mañana' : diaCorto(d)}</button>)}</div>
        <label className="field">Otra fecha<input className="input" type="date" value={otra} onChange={(e) => setOtra(e.target.value)} /></label>
        <button type="button" className="btn primary m-grande" disabled={!otra} onClick={() => { onElegir(otra); onClose(); }}>Pasar a esa fecha</button>
      </div>
    </Hoja>
  );
}

// ---------- Hoy ----------

export function HoyLogistica() {
  const { meta } = useMeta();
  const puede = usePuedeEscribir();
  const hoy = hoyIso();
  const sinLeer = useNoLeidas();
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const ruta = useCarga(() => http<Ruta>('GET', `/cronograma/ruta${qs({ fecha: hoy })}`), [hoy]);
  const semana = useCarga(() => http<Vista>('GET', `/cronograma${qs({ desde: sumar(hoy, -7), hasta: sumar(hoy, 1) })}`), [hoy]);
  const remitos = useCarga(() => http<{ total: number }>('GET', '/remitos/revisar/cuantos').then((r) => r.total), []);
  const tareas = useCarga(() => http<{ results: import('../lib').Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 20 })}`).then((r) => r.results), []);
  const { completar, posponer } = useCambiosTarea((t) => tareas.setDatos((ts) => ts?.filter((x) => x.id !== t.id) ?? null), tareas.recargar);

  const v = semana.datos;
  const atrasadas = useMemo(() => tarjetas((v?.movimientos ?? []).filter((m) => m.fecha < hoy && !m.hecho)), [v, hoy]);
  const sinChofer = (v?.encargos ?? []).filter((e) => e.fecha >= hoy && e.estado === 'pendiente' && !e.chofer);
  const sinFoto = ruta.datos ? ruta.datos.paradas.filter((p) => hechaParada(p) && !p.fotos) : [];
  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const pendientesResolver = (remitos.datos ?? 0) + sinFoto.length + sinChofer.length + atrasadas.length + (v?.sin_fecha.length ?? 0);
  return (
    <div className="m-pag">
      <div className="m-saludo"><h1>Hola, {meta.me.name.split(' ')[0]}</h1><p className="muted">{fecha.charAt(0).toUpperCase() + fecha.slice(1)}</p></div>

      <section className="m-sec" aria-label="El recorrido de hoy">
        <div className="m-sec-cab"><h2>El recorrido de hoy</h2><span className="grow" /><Link to={`/cronograma?vista=ruta&dia=${hoy}`} className="m-link">Ver la ruta</Link></div>
        {ruta.error && <Fallo chico error={ruta.error} onReintentar={ruta.recargar} />}
        {!ruta.datos && !ruta.error && <Cargando chico />}
        {ruta.datos && !ruta.datos.paradas.length && <div className="m-vacio">Hoy no hay paradas.</div>}
        {ruta.datos && ruta.datos.paradas.length > 0 && ruta.datos.rutas.map((r) => {
          const ps = paradasDe(ruta.datos!, r.n);
          if (!ps.length) return null;
          const a = avance(ps);
          return (
            <Link key={r.n} to={`/cronograma?vista=ruta&dia=${hoy}&r=${r.n}`} className="m-item m-item-link m-chofer">
              <span className="m-chofer-ico"><Icon name="volante" size={18} /></span>
              <div className="m-item-txt">
                <b>{r.chofer ?? 'Sin chofer'}</b>
                <small className="muted">{a.hechas} de {ps.length} paradas · sale {hhmm(r.salida)}</small>
                <span className="m-barra" aria-hidden="true"><i style={{ width: `${(a.hechas / ps.length) * 100}%` }} /></span>
              </div>
              <span className="m-chofer-alertas">
                {a.noSePudo > 0 && <span className="m-pill mal">{a.noSePudo} no se pudo</span>}
                {a.sinFoto > 0 && <span className="m-pill aviso">{a.sinFoto} sin foto</span>}
              </span>
            </Link>
          );
        })}
      </section>

      {pendientesResolver > 0 && (
        <section className="m-sec" aria-label="Para resolver">
          <div className="m-sec-cab"><h2>Para resolver</h2></div>
          {(remitos.datos ?? 0) > 0 && <Link to="/entregas" className="m-item m-item-link"><span className="m-resolver-ico"><Icon name="receipt" size={18} /></span>
            <div className="m-item-txt"><b>{remitos.datos} remito{remitos.datos === 1 ? '' : 's'} para revisar</b><small className="muted">No se pudieron adjuntar solos a su pedido</small></div><Icon name="chevron" size={16} /></Link>}
          {sinFoto.length > 0 && <Link to={`/cronograma?vista=ruta&dia=${hoy}`} className="m-item m-item-link"><span className="m-resolver-ico aviso"><Icon name="image" size={18} /></span>
            <div className="m-item-txt"><b>{sinFoto.length} parada{sinFoto.length === 1 ? '' : 's'} hecha{sinFoto.length === 1 ? '' : 's'} sin foto del remito</b><small className="muted">{sinFoto.slice(0, 3).map((p) => lindo(p.nombre)).join(', ')}</small></div><Icon name="chevron" size={16} /></Link>}
          {sinChofer.length > 0 && <Link to={`/cronograma?dia=${sinChofer[0].fecha}`} className="m-item m-item-link"><span className="m-resolver-ico"><Icon name="route" size={18} /></span>
            <div className="m-item-txt"><b>{sinChofer.length} encargo{sinChofer.length === 1 ? '' : 's'} sin chofer</b><small className="muted">{sinChofer.slice(0, 3).map((e) => `${lindo(e.destino)} (${diaCorto(e.fecha)})`).join(', ')}</small></div><Icon name="chevron" size={16} /></Link>}
          {atrasadas.length > 0 && <Link to={`/cronograma?dia=${atrasadas[0].fecha}&pendientes=1`} className="m-item m-item-link"><span className="m-resolver-ico mal"><Icon name="alert" size={18} /></span>
            <div className="m-item-txt"><b>{atrasadas.length} movimiento{atrasadas.length === 1 ? '' : 's'} atrasado{atrasadas.length === 1 ? '' : 's'}</b><small className="muted">De la última semana, sin marcar hechos</small></div><Icon name="chevron" size={16} /></Link>}
          {(v?.sin_fecha.length ?? 0) > 0 && <Link to="/cronograma?vista=sinfecha" className="m-item m-item-link"><span className="m-resolver-ico"><Icon name="calendar" size={18} /></span>
            <div className="m-item-txt"><b>{v!.sin_fecha.length} listo{v!.sin_fecha.length === 1 ? '' : 's'} para entregar sin fecha</b><small className="muted">Falta ponerles día</small></div><Icon name="chevron" size={16} /></Link>}
        </section>
      )}

      <section className="m-sec" aria-label="Tareas">
        <div className="m-sec-cab"><h2>Tareas</h2><span className="grow" />{puede && <button type="button" className="m-link" onClick={() => setNueva(true)}><Icon name="plus" size={14} />Nueva</button>}</div>
        {tareas.error && <Fallo chico error={tareas.error} onReintentar={tareas.recargar} />}
        {!tareas.datos && !tareas.error && <Cargando chico />}
        {tareas.datos && !tareas.datos.length && <div className="m-vacio">Nada pendiente para hoy.</div>}
        {tareas.datos?.map((t) => <FilaTarea key={t.id} t={t} puede={puede} onCheck={() => completar(t)} onPosponer={() => posponer(t)} onAbrir={() => setAbierta(t.id)} />)}
        <Link to="/tasks" className="m-ver">Todas las tareas</Link>
      </section>

      {sinLeer.conversaciones.length > 0 && (
        <section className="m-sec" aria-label="Te escribieron">
          <div className="m-sec-cab"><h2>Te escribieron</h2><span className="m-pill nuevo">{sinLeer.no_leidos}</span><span className="grow" /><Link to="/conversaciones" className="m-link">Ver todo</Link></div>
          {sinLeer.conversaciones.slice(0, 3).map((c) => (
            <Link key={`${c.object_type}-${c.record_id}`} to={`/conversaciones/${c.object_type}/${c.record_id}`} className="m-item m-item-link">
              <Avatar name={c.name} type={c.object_type} />
              <div className="m-item-txt"><b>{c.menciones > 0 && <span className="m-mencion">@ </span>}{c.name}</b>
                <small className="muted">{c.ultimo ? `${userOf(meta, c.ultimo.user_id)?.name.split(' ')[0] ?? 'Alguien'}: ${c.ultimo.body.replace(/\s+/g, ' ')}` : ''}</small></div>
              <span className="m-badge-fila">{c.no_leidos}</span>
            </Link>
          ))}
        </section>
      )}
      {abierta && <PanelTarea id={abierta} onClose={() => { setAbierta(null); tareas.recargar(); }} onChange={tareas.recargar} />}
      {nueva && <TareaRapida onClose={() => setNueva(false)} onCreada={tareas.recargar} />}
    </div>
  );
}

// ---------- Día: el cronograma de un día y su ruta ----------

const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export function DiaMovil() {
  const [sp, setSp] = useSearchParams();
  const hoy = hoyIso();
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('dia') ?? '') ? sp.get('dia')! : hoy;
  const vista = sp.get('vista') === 'ruta' ? 'ruta' : sp.get('vista') === 'sinfecha' ? 'sinfecha' : 'mov';
  const ir = (cambios: Record<string, string | null>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(cambios)) { if (v == null) n.delete(k); else n.set(k, v); } return n; }, { replace: true });
  const lunes = lunesDe(dia);
  const semana = useCarga(() => http<Vista>('GET', `/cronograma${qs({ desde: lunes, hasta: sumar(lunes, 6) })}`), [lunes]);
  const v = semana.datos;
  const dias = [0, 1, 2, 3, 4, 5, 6].map((i) => sumar(lunes, i)).filter((d, i) => i < 5 || (v?.dias[d]?.total ?? 0) > 0 || d === dia);
  return (
    <div className="m-pag m-dia">
      <div className="m-semana">
        <button type="button" className="btn ghost icon" onClick={() => ir({ dia: sumar(lunes, -7) })} aria-label="Semana anterior"><Icon name="chevron" size={20} /></button>
        <div className="m-semana-dias" role="tablist" aria-label="Día">
          {dias.map((d) => {
            const r = v?.dias[d];
            return (
              <button key={d} type="button" role="tab" aria-selected={d === dia} className={`m-semana-dia${d === dia ? ' on' : ''}${d === hoy ? ' hoy' : ''}${r?.atrasados ? ' mal' : ''}`} onClick={() => ir({ dia: d === hoy ? null : d })}>
                <small>{d === hoy ? 'Hoy' : DIAS_CORTOS[new Date(`${d}T12:00:00`).getDay()]}</small>
                <b>{new Date(`${d}T12:00:00`).getDate()}</b>
                <span className="m-semana-n">{r ? (r.pendientes ? r.pendientes : r.total ? '✓' : '') : ''}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className="btn ghost icon m-sig" onClick={() => ir({ dia: sumar(lunes, 7) })} aria-label="Semana siguiente"><Icon name="chevron" size={20} /></button>
      </div>
      <div className="m-dia-tit"><h1>{dia === hoy ? 'Hoy' : diaLargo(dia)}</h1>{v?.feriados[dia] && <span className="m-pill aviso">Feriado: {v.feriados[dia]}</span>}
        <span className="grow" />{dia !== hoy && <button type="button" className="m-link" onClick={() => ir({ dia: null })}>Ir a hoy</button>}</div>
      <div className="m-seg" role="tablist" aria-label="Qué ver">
        <button type="button" role="tab" aria-selected={vista === 'mov'} className={`m-seg-op${vista === 'mov' ? ' active' : ''}`} onClick={() => ir({ vista: null })}>Movimientos</button>
        <button type="button" role="tab" aria-selected={vista === 'ruta'} className={`m-seg-op${vista === 'ruta' ? ' active' : ''}`} onClick={() => ir({ vista: 'ruta' })}>Ruta</button>
      </div>
      {semana.error && <Fallo error={semana.error} onReintentar={semana.recargar} />}
      {vista === 'ruta' ? <RutaDia dia={dia} recorrido={Number(sp.get('r')) || null} onRecorrido={(n) => ir({ r: String(n) })} onCambio={semana.recargar} />
        : vista === 'sinfecha' ? <SinFecha v={v} onCambio={semana.recargar} />
        : <MovimientosDia v={v} dia={dia} pendientes={sp.get('pendientes') === '1'} onPendientes={(x) => ir({ pendientes: x ? '1' : null })} recargar={semana.recargar} />}
    </div>
  );
}

function MovimientosDia({ v, dia, pendientes, onPendientes, recargar }: { v: Vista | null; dia: string; pendientes: boolean; onPendientes: (x: boolean) => void; recargar: () => void }) {
  const navigate = useNavigate();
  const acciones = useAcciones(recargar);
  const [q, setQ] = useState('');
  const [hoja, setHoja] = useState<null | { chofer: Tarjeta | Encargo } | { dia: Tarjeta | Encargo }>(null);
  const [encargo, setEncargo] = useState<number | null>(null);
  if (!v) return <Cargando />;
  const puede = v.puede_editar;
  const texto = q.trim().toLowerCase();
  const movs = v.movimientos.filter((m) => m.fecha === dia && (!pendientes || !m.hecho) && (!texto || [m.npdv, m.cliente, m.articulo, m.lugar].some((x) => (x ?? '').toLowerCase().includes(texto))));
  const ts = tarjetas(movs);
  const encs = (v.encargos ?? []).filter((e) => e.fecha === dia && (!pendientes || e.estado !== 'hecho') && (!texto || [e.destino, e.quien, e.notas].some((x) => (x ?? '').toLowerCase().includes(texto))));
  const notas = v.notas.filter((n) => n.fecha === dia);
  const vacio = !ts.length && !encs.length;
  return (
    <>
      <div className="search"><Icon name="search" /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PDV, cliente, proveedor…" aria-label="Buscar en el día" enterKeyHint="search" /></div>
      <div className="m-chips"><button type="button" className={`chip sm${pendientes ? ' on' : ''}`} aria-pressed={pendientes} onClick={() => onPendientes(!pendientes)}>Solo lo pendiente</button></div>
      {notas.map((n) => <div key={n.id} className="m-nota"><Icon name="note" size={16} /><span>{n.texto}</span></div>)}
      {vacio && <div className="m-al-dia"><span className="m-al-dia-ico"><Icon name="check" size={22} /></span><b>{pendientes ? 'No queda nada pendiente este día' : 'No hay movimientos este día'}</b></div>}
      {CARRILES.map((c) => {
        const lista = ts.filter((t) => c.tipos.includes(t.tipo));
        if (!lista.length) return null;
        return (
          <section key={c.k} className="m-sec" aria-label={c.nombre}>
            <div className="m-sec-cab"><h2>{c.nombre}</h2><span className="muted small">{lista.filter((t) => !t.hecho).length} de {lista.length} pendientes · {c.ayuda}</span></div>
            {lista.map((t) => (
              <div key={t.key} className={`m-mov${t.hecho ? ' hecho' : ''}`}>
                {puede
                  ? <button type="button" className="m-check-zona" onClick={() => acciones.hecho(t.movs, [], !t.hecho, t.titulo)} aria-label={t.hecho ? `Volver a pendiente: ${t.titulo}` : `Marcar hecho: ${t.titulo}`}>
                      <span className={`check-round m-check${t.hecho ? ' on' : ''}`} aria-hidden="true">{t.hecho && <Icon name="check" />}</span></button>
                  : <span className="m-check-zona" aria-hidden="true"><span className={`check-round m-check${t.hecho ? ' on' : ''}`} /></span>}
                <div className="m-mov-cuerpo">
                  <button type="button" className="m-mov-tit" onClick={() => t.record_id && navigate(recordUrl('order', t.record_id))} disabled={!t.record_id}>
                    <b className={t.hecho ? 'tachada' : ''}>{t.titulo}</b>
                    <small className="muted">{[t.pdv, t.para].filter(Boolean).join(' · ')}</small>
                  </button>
                  {/* Una prenda en varios talles, en un renglón con sus talles (talles.ts). */}
                  {(() => { const ls = lineasMovs(t.movs.filter((m) => m.articulo)); return (
                    <div className="m-mov-arts">{ls.slice(0, 3).map((l) => <span key={l.key}>{l.texto}</span>)}{ls.length > 3 && <span className="muted">y {ls.length - 3} más</span>}</div>
                  ); })()}
                  {(t.avisos.length > 0 || t.evento || t.retira_en) && (
                    <div className="m-mov-avisos">{t.evento && <span className="m-pill aviso">Evento</span>}{t.retira_en && <span className="m-pill">Retira en {t.retira_en}</span>}
                      {t.avisos.map((a) => <span key={a} className="m-pill aviso">{a}</span>)}</div>
                  )}
                  {puede && !t.hecho && (
                    <div className="m-mov-acc">
                      {t.parada && <button type="button" className="btn sm" onClick={() => setHoja({ chofer: t })}><Icon name="volante" size={14} />{t.chofer ?? 'Sin chofer'}</button>}
                      <button type="button" className="btn sm ghost" onClick={() => setHoja({ dia: t })}><Icon name="calendar" size={14} />Otro día</button>
                    </div>
                  )}
                  {(!puede || t.hecho) && t.parada && <small className="muted">{t.chofer ? `Va con ${t.chofer}` : 'Sin chofer'}</small>}
                </div>
              </div>
            ))}
          </section>
        );
      })}
      {encs.length > 0 && (
        <section className="m-sec" aria-label="Encargos">
          <div className="m-sec-cab"><h2>Encargos</h2><span className="muted small">Lo que pidieron al recorrido</span></div>
          {encs.map((e) => {
            const hecho = e.estado === 'hecho';
            return (
              <div key={e.id} className={`m-mov${hecho ? ' hecho' : ''}`}>
                {puede
                  ? <button type="button" className="m-check-zona" onClick={() => acciones.hecho([], [e], !hecho, lindo(e.destino))} aria-label={hecho ? `Volver a pendiente: ${e.destino}` : `Marcar hecho: ${e.destino}`}>
                      <span className={`check-round m-check${hecho ? ' on' : ''}`} aria-hidden="true">{hecho && <Icon name="check" />}</span></button>
                  : <span className="m-check-zona" aria-hidden="true"><span className={`check-round m-check${hecho ? ' on' : ''}`} /></span>}
                <div className="m-mov-cuerpo">
                  <button type="button" className="m-mov-tit" onClick={() => setEncargo(e.id)}>
                    <b className={hecho ? 'tachada' : ''}>{lindo(e.destino)}{e.urgente && <span className="cr-tag late">Urgente</span>}</b>
                    <small className="muted">{resumen(e) || 'Sin detalle'}{e.quien ? ` · pidió ${e.quien}` : ''}</small>
                  </button>
                  {e.estado !== 'pendiente' && e.estado !== 'hecho' && <div className="m-mov-avisos"><span className="m-pill mal">{ESTADO_ENC[e.estado].nombre}{e.motivo ? `: ${e.motivo}` : ''}</span></div>}
                  {puede && !hecho && (
                    <div className="m-mov-acc">
                      <button type="button" className="btn sm" onClick={() => setHoja({ chofer: e })}><Icon name="volante" size={14} />{e.chofer ?? 'Sin chofer'}</button>
                      <button type="button" className="btn sm ghost" onClick={() => setHoja({ dia: e })}><Icon name="calendar" size={14} />Otro día</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}
      {hoja && 'chofer' in hoja && (
        <HojaChofer actual={'movs' in hoja.chofer ? hoja.chofer.chofer : hoja.chofer.chofer ?? null} choferes={v.choferes ?? []} expresos={v.expresos ?? []} onClose={() => setHoja(null)}
          onElegir={(c) => { const x = hoja.chofer; void ('movs' in x ? acciones.chofer(x.fecha, x.movs.map((m) => m.id), c, x.titulo) : acciones.chofer(x.fecha, [`enc:${x.id}`], c, `Encargo a ${lindo(x.destino)}`)); }} />
      )}
      {hoja && 'dia' in hoja && <HojaDia desde={hoyIso()} actual={dia} onClose={() => setHoja(null)} onElegir={(f) => void acciones.mover(hoja.dia, f)} />}
      {encargo && <EncargoAbierto id={encargo} onClose={() => setEncargo(null)} onListo={() => { setEncargo(null); recargar(); }} />}
    </>
  );
}

// Lo que está listo para entregar y todavía no tiene día: se le pone uno.
function SinFecha({ v, onCambio }: { v: Vista | null; onCambio: () => void }) {
  const toast = useToast();
  // Una prenda en varios talles es un producto: un renglón y un «Poner día» para todos sus talles (talles.ts).
  const [elegir, setElegir] = useState<Vista['sin_fecha'] | null>(null);
  if (!v) return <Cargando />;
  const poner = async (ids: string[], fecha: string, pdv: string) => {
    try { await http('POST', '/cronograma/mover', { ids, tipo: 'entrega', fecha }); toast(`PDV ${pdv}: entrega el ${diaCorto(fecha)}. Ya está en ClickUp.`); }
    catch (e) { toast((e as Error).message, true); }
    onCambio();
  };
  return (
    <section className="m-sec" aria-label="Listos para entregar sin fecha">
      <div className="m-sec-cab"><h2>Listos para entregar, sin fecha</h2></div>
      {!v.sin_fecha.length && <div className="m-vacio">No hay nada listo sin fecha.</div>}
      {juntarTalles(v.sin_fecha).map((e) => {
        const ss = e.k === 'uno' ? [e.x] : e.xs, s = ss[0];
        const que = e.k === 'uno' ? cantidad(s) : `${cantidad({ cantidad: ss.reduce((n, x) => n + (x.cantidad ?? 0), 0), articulo: s.producto || s.articulo })} (${textoTalles(ss)})`;
        return (
          <div key={s.task_id} className="m-item">
            <div className="m-item-txt"><b>{lindo(s.cliente) || `PDV ${s.npdv}`}</b><small className="muted">PDV {s.npdv ?? '—'} · {que}</small></div>
            {v.puede_editar && <button type="button" className="btn sm" onClick={() => setElegir(ss)}><Icon name="calendar" size={14} />Poner día</button>}
          </div>
        );
      })}
      {elegir && <HojaDia desde={hoyIso()} actual="" onClose={() => setElegir(null)} onElegir={(f) => void poner(elegir.map((x) => x.task_id), f, elegir[0].npdv ?? '—')} />}
    </section>
  );
}

function RutaDia({ dia, recorrido, onRecorrido, onCambio }: { dia: string; recorrido: number | null; onRecorrido: (n: number) => void; onCambio: () => void }) {
  const carga = useCarga(() => http<Ruta>('GET', `/cronograma/ruta${qs({ fecha: dia })}`), [dia]);
  const recargar = () => { carga.recargar(); onCambio(); };
  const acciones = useAcciones(recargar);
  const [hoja, setHoja] = useState<Parada | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  if (carga.error) return <Fallo error={carga.error} onReintentar={carga.recargar} />;
  const d = carga.datos;
  if (!d) return <Cargando />;
  if (!d.paradas.length && !d.llegan.length) return <div className="m-al-dia"><span className="m-al-dia-ico neutro"><Icon name="route" size={22} /></span><b>Este día no hay paradas</b></div>;
  const rutas = d.rutas.filter((r) => paradasDe(d, r.n).length);
  const activa = rutas.find((r) => r.n === recorrido) ?? rutas[0];
  const ps = activa ? paradasDe(d, activa.n) : [];
  const a = avance(ps);
  const puede = d.puede_editar;
  return (
    <>
      {rutas.length > 1 && (
        <div className="m-chips m-chips-scroll" role="tablist" aria-label="Recorrido">
          {rutas.map((r) => {
            const x = avance(paradasDe(d, r.n));
            return <button key={r.n} type="button" role="tab" aria-selected={r.n === activa?.n} className={`chip${r.n === activa?.n ? ' on' : ''}`} onClick={() => onRecorrido(r.n)}>
              {r.chofer ?? 'Sin chofer'} · {x.hechas}/{paradasDe(d, r.n).length}</button>;
          })}
        </div>
      )}
      {activa && (
        <div className="m-ruta-cab">
          <span className="m-chofer-ico"><Icon name="volante" size={18} /></span>
          <div className="m-item-txt"><b>{activa.chofer ?? 'Sin chofer'}</b><small className="muted">Sale {hhmm(activa.salida)} · {a.hechas} de {ps.length} paradas{a.sinFoto ? ` · ${a.sinFoto} sin foto` : ''}</small>
            <span className="m-barra" aria-hidden="true"><i style={{ width: `${ps.length ? (a.hechas / ps.length) * 100 : 0}%` }} /></span></div>
        </div>
      )}
      <ol className="m-paradas">
        {ps.map((p, i) => {
          const hecha = hechaParada(p);
          const llamar = tel(p.lugar?.telefono);
          const llegar = mapa(p);
          const abierto = abierta === p.clave;
          const fueTipos = [...new Set(p.movimientos.map((m) => TIPO_CORTO[m.tipo]))];
          return (
            <li key={p.clave} className={`m-parada${hecha ? ' hecha' : ''}${p.visita?.resultado === 'no_se_pudo' ? ' mal' : ''}`}>
              <span className="m-parada-n" aria-hidden="true">{hecha ? <Icon name="check" size={14} /> : i + 1}</span>
              <div className="m-parada-cuerpo">
                <button type="button" className="m-mov-tit" onClick={() => setAbierta(abierto ? null : p.clave)} aria-expanded={abierto}>
                  <b>{lindo(p.nombre)}</b>
                  <small className="muted">{[...fueTipos, (p.encargos?.length ?? 0) > 0 ? 'Encargo' : null].filter(Boolean).join(' · ')}{p.direccion ? ` · ${p.direccion}` : ' · sin dirección'}</small>
                </button>
                <div className="m-mov-avisos">
                  {p.pactada && <span className="m-pill">{p.pactada.texto}</span>}
                  {!p.pactada && p.horario_texto && <span className="m-pill">Atienden {p.horario_texto}</span>}
                  {p.expreso && <span className="m-pill">Por expreso {p.expreso.nombre}</span>}
                  {p.visita?.resultado === 'no_se_pudo' && <span className="m-pill mal">{MOTIVO[p.visita.motivo ?? 'otro'] ?? 'No se pudo'}{p.visita.nota ? `: ${p.visita.nota}` : ''}</span>}
                  {hecha && (p.fotos ? <span className="m-pill ok">Foto del remito</span> : <span className="m-pill aviso">Sin foto del remito</span>)}
                </div>
                {abierto && (
                  <div className="m-parada-det">
                    {lineasMovs(p.movimientos).map((l) => { const m = l.movs[0]; return <div key={l.key} className="small">{TIPO_CORTO[m.tipo]} · {l.texto}{m.npdv ? ` · PDV ${m.npdv}` : ''}{l.hecho ? ' ✓' : ''}</div>; })}
                    {(p.encargos ?? []).map((e) => <div key={e.id} className="small">Encargo · {[...e.llevar.map((x) => `Llevar ${itemTexto(x)}`), ...e.retirar.map((x) => `Retirar ${itemTexto(x)}`)].join(' · ') || e.notas || 'Sin detalle'}</div>)}
                    {p.lugar?.contacto && <div className="small muted">Preguntar por {p.lugar.contacto}</div>}
                    {p.lugar?.observaciones && <div className="small muted">{p.lugar.observaciones}</div>}
                    {p.visita?.at && <div className="small muted">Lo marcó {p.visita.chofer ?? 'el chofer'} {fmtRelative(p.visita.at)}</div>}
                  </div>
                )}
                <div className="m-mov-acc">
                  {puede && <button type="button" className={`btn sm${hecha ? ' ghost' : ' primary'}`} onClick={() => acciones.hecho(p.movimientos, p.encargos ?? [], !hecha, lindo(p.nombre))}>
                    <Icon name="check" size={14} />{hecha ? 'Volver a pendiente' : 'Hecha'}</button>}
                  {llamar && <a className="btn sm ghost" href={llamar} aria-label={`Llamar a ${p.nombre}`}><Icon name="call" size={14} />Llamar</a>}
                  {llegar && <a className="btn sm ghost" href={llegar} target="_blank" rel="noreferrer"><Icon name="pin" size={14} />Cómo llegar</a>}
                  {puede && !hecha && <button type="button" className="btn sm ghost" onClick={() => setHoja(p)}><Icon name="volante" size={14} />Otro chofer</button>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {d.llegan.length > 0 && (
        <section className="m-sec" aria-label="Llegan al depósito">
          <div className="m-sec-cab"><h2>Llegan al depósito</h2><span className="muted small">Ingresos: no son un viaje</span></div>
          {tarjetas(d.llegan).map((t) => (
            <div key={t.key} className={`m-item${t.hecho ? ' m-hecho' : ''}`}>
              <div className="m-item-txt"><b className={t.hecho ? 'tachada' : ''}>{t.titulo}</b><small className="muted">{[t.pdv, t.para].filter(Boolean).join(' · ')} · {t.movs.map(cantidad).join(', ')}</small></div>
              {puede && <button type="button" className="btn sm ghost" onClick={() => acciones.hecho(t.movs, [], !t.hecho, t.titulo)}>{t.hecho ? 'Pendiente' : 'Llegó'}</button>}
            </div>
          ))}
        </section>
      )}
      {(d.retiran?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Retiran en Formas">
          <div className="m-sec-cab"><h2>Retiran en Formas</h2></div>
          {lineasMovs(d.retiran!).map((l) => { const m = l.movs[0]; return <div key={l.key} className="m-item"><div className="m-item-txt"><b>{lindo(m.cliente)}</b><small className="muted">PDV {m.npdv} · {l.texto} · en {m.retira_en}</small></div></div>; })}
        </section>
      )}
      <p className="small muted m-nota-pie">Para ordenar las paradas, corregir un punto o fijar una hora, abrí la Ruta del día en la compu.</p>
      {hoja && (
        <HojaChofer actual={rutas.find((r) => r.orden.includes(hoja.clave))?.chofer ?? null} choferes={d.choferes} expresos={(d.expresos ?? []).map((x) => x.nombre)} onClose={() => setHoja(null)}
          onElegir={(c) => void acciones.chofer(dia, [...hoja.movimientos.map((m) => m.id), ...(hoja.encargos ?? []).map((e) => `enc:${e.id}`)], c, lindo(hoja.nombre))} />
      )}
    </>
  );
}

// ---------- Entregas: los remitos para revisar ----------

export function EntregasMovil() {
  const [tab, setTab] = useState<'revisar' | 'revisados'>('revisar');
  const carga = useCarga(() => http<{ remitos: Remito[]; lector?: boolean }>('GET', tab === 'revisar' ? '/remitos/revisar' : '/remitos/revisados'), [tab]);
  const lista = carga.datos?.remitos ?? null;
  return (
    <div className="m-pag">
      <div className="m-seg" role="tablist" aria-label="Remitos">
        <button type="button" role="tab" aria-selected={tab === 'revisar'} className={`m-seg-op${tab === 'revisar' ? ' active' : ''}`} onClick={() => setTab('revisar')}>Para revisar</button>
        <button type="button" role="tab" aria-selected={tab === 'revisados'} className={`m-seg-op${tab === 'revisados' ? ' active' : ''}`} onClick={() => setTab('revisados')}>Revisados</button>
      </div>
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!lista && !carga.error && <Cargando />}
      {carga.datos && carga.datos.lector === false && <div className="m-fallo chico">Falta conectar la API de Claude: los remitos se guardan pero no se leen.</div>}
      {lista && !lista.length && <div className="m-al-dia"><span className="m-al-dia-ico"><Icon name="check" size={22} /></span><b>{tab === 'revisar' ? 'No hay remitos para revisar' : 'Todavía no se revisó ninguno'}</b></div>}
      {lista?.map((r) => <RemitoMovil key={r.id} r={r} revisado={tab === 'revisados'} onCambio={carga.recargar} />)}
    </div>
  );
}

const cant = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('es-AR', { maximumFractionDigits: 2 }));
function RemitoMovil({ r, revisado, onCambio }: { r: Remito; revisado: boolean; onCambio: () => void }) {
  const toast = useToast();
  const puede = usePuedeEscribir();
  const [ocupado, setOcupado] = useState(false);
  const [buscar, setBuscar] = useState(false);
  const [ver, setVer] = useState(false);
  const accion = async (body: Record<string, unknown>, ok: string) => {
    setOcupado(true);
    try { await http('POST', `/remitos/${r.id}/revisar`, body); toast(ok); onCambio(); }
    catch (err) { toast((err as Error).message, true); } finally { setOcupado(false); }
  };
  const [rota, setRota] = useState(false);   // la foto no se pudo mostrar: queda el botón para abrirla
  const esImagen = (r.mime ?? '').startsWith('image/') && !rota;
  const candidatos = r.candidatos.length ? r.candidatos : r.record_id && !revisado ? [{ id: r.record_id, nombre: r.pedido_nombre ?? 'el pedido donde está', pdv: null }] : [];
  // Lo que se resuelve mejor en la compu: elegir a qué producto va cada renglón o repartir un remito de varios pedidos.
  const enLaCompu = r.controles.some((c) => c.dato === 'Productos' && c.ok !== true) || (r.pedidos ?? []).length > 1;
  const datos = [r.pdv && `PDV ${r.pdv}${r.pdv_chofer ? ' (lo escribió el chofer)' : ''}`, r.cliente && lindo(r.cliente), r.fecha && fmtDate(r.fecha), r.chofer && `Chofer: ${r.chofer}`,
    r.recibido_por && `Recibió ${r.recibido_por}`, r.firmado === false && 'Sin firma'].filter(Boolean).join(' · ');
  return (
    <article className="m-sec m-remito">
      <button type="button" className="m-remito-foto" onClick={() => setVer(true)} aria-label="Ver el remito grande">
        {esImagen ? <img src={`/api/remitos/${r.id}/archivo`} alt={`Remito ${r.numero ?? ''}`} loading="lazy" onError={() => setRota(true)} /> : <span className="m-remito-pdf"><Icon name="receipt" size={28} />Ver el remito</span>}
      </button>
      <div className="m-remito-cuerpo">
        <div className="m-remito-cab"><b>{r.numero ? `Remito ${r.numero}` : 'Remito sin número leído'}</b><small className="muted">{fmtRelative(r.created_at)}</small></div>
        {datos && <div className="small muted">{datos}</div>}
        {r.items.length > 0 && <div className="small">{r.items.slice(0, 4).map((i) => `${cant(i.quantity)} ${i.description ?? i.code ?? ''}`.trim()).join(' · ')}{r.items.length > 4 ? ` y ${r.items.length - 4} más` : ''}</div>}
        {r.reservas && <span className="m-pill aviso">Recibido a controlar</span>}
        {r.notas && <div className="small muted">{r.notas}</div>}
        {revisado
          ? <div className="small"><b>{r.estado === 'ok' ? `Confirmado en «${r.pedido_nombre ?? 'el pedido'}»` : r.estado === 'descartado' ? `Descartado${r.motivo ? `: ${r.motivo}` : ''}` : r.estado === 'duplicado' ? 'Repetido' : 'Asignado, falta confirmar'}</b>
              {r.revisor ? <span className="muted"> · {r.revisor}{r.revisado_at ? `, ${fmtRelative(r.revisado_at)}` : ''}</span> : null}</div>
          : r.motivo && <div className="m-fallo chico m-motivo">{r.motivo}</div>}
        {!revisado && puede && (
          <div className="m-remito-acc">
            {candidatos.map((c) => (
              <button key={c.id} type="button" className="btn primary" disabled={ocupado} onClick={() => accion({ accion: 'confirmar', pedido: c.id }, `Remito confirmado en «${c.nombre}»`)}>Es de {c.nombre}</button>
            ))}
            {buscar
              ? <BuscarPedido ocupado={ocupado} inicial={r.pdv ?? ''} onElegir={(o) => accion({ accion: 'confirmar', pedido: o.id }, `Remito confirmado en «${o.name}»`)} />
              : <button type="button" className="btn" disabled={ocupado} onClick={() => setBuscar(true)}><Icon name="search" size={14} />Es de otro pedido</button>}
            <div className="m-remito-sec">
              <button type="button" className="btn ghost sm" disabled={ocupado} onClick={() => accion({ accion: 'releer' }, 'Remito leído de nuevo')}>{ocupado ? 'Un momento…' : 'Leer de nuevo'}</button>
              <button type="button" className="btn ghost sm" disabled={ocupado} onClick={() => { if (confirm('¿Descartar este remito? No va a contar para ninguna entrega.')) void accion({ accion: 'descartar' }, 'Remito descartado'); }}>Descartar</button>
            </div>
            {enLaCompu && <small className="muted">Para elegir a qué producto va cada renglón, o si es de varios pedidos, abrilo en Entregas en la compu.</small>}
          </div>
        )}
      </div>
      {ver && <VerArchivo url={`/api/remitos/${r.id}/archivo`} nombre={r.numero ? `Remito ${r.numero}` : 'Remito'} onClose={() => setVer(false)} />}
    </article>
  );
}

function BuscarPedido({ inicial, ocupado, onElegir }: { inicial: string; ocupado: boolean; onElegir: (o: CrmRecord) => void }) {
  const [q, setQ] = useState(inicial);
  const res = useCarga(() => (q.trim().length >= 2 ? http<{ results: CrmRecord[] }>('GET', `/records/order${qs({ q, limit: 6 })}`).then((r) => r.results) : Promise.resolve([] as CrmRecord[])), [q]);
  return (
    <div className="m-buscar-pedido">
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PDV o cliente" aria-label="Buscar el pedido" autoFocus />
      {res.datos?.map((o) => <button key={o.id} type="button" className="m-op-pedido" disabled={ocupado} onClick={() => onElegir(o)}>{o.name}</button>)}
      {q.trim().length >= 2 && res.datos && !res.datos.length && <small className="muted">No hay pedidos con «{q}».</small>}
    </div>
  );
}

// ---------- Choferes ----------

export function ChoferesMovil() {
  return <div className="m-pag m-choferes"><ChoferesPanel /></div>;
}
