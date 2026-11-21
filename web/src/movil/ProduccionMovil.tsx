import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { http, qs, useMeta, useToast, useDebounced, Icon, Cargando, formatValue, recordUrl, userOf, type Activity } from '../lib';
import { Avatar, EstadoClickup, EtapaPedido, nombreEstado } from '../components';
import { CARRILES, lindo, type Vista as VistaCrono } from '../pages/Cronograma';
import { hoyIso } from '../pages/Recorridos';
import { useNoLeidas } from '../pages/Conversacion';
import { Hoja, TareaRapida } from './Movil';
import { FilaTarea, PanelTarea, useCambiosTarea } from './TareasChatMovil';
import { BotonConversacion } from './VentasMovil';
import { Fallo, useCarga, usePuedeEscribir } from './base';
import { revisarFestejos } from '../Chispin';
import { juntarTalles, textoTalles } from '../talles';

// Producción en el celular (versión celular, docs/MOVIL.md): lo que hacen Ceci y Sole con el producto en la mano, en el
// depósito o en un proveedor. Hoy: sus PDV atrasados y los de la semana, lo que entra y sale hoy, tareas y mensajes.
// Producción: los PDV (míos, sin asignar o todos), por etapa. Cada PDV: sus artículos, y cada artículo se toca para
// cambiar el estado, las fechas, el proveedor, el impresor o quién lo tiene; se escribe en ClickUp en el momento, como en
// la pantalla Producción (Produccion.tsx). Las unidades que se siguen trabajando en ClickUp solo se reasignan.

interface Articulo {
  task_id: string; nombre: string; estado: string; cantidad: number | null; proveedor: string | null; impresor: string | null; entrega_real: string | null;
  ingreso_proveedor: string | null; retiro_proveedor: string | null; egreso_impresor: string | null; retiro_impresor: string | null; ingreso_impresor: string | null; asignados: number[];
  url: string | null; foto?: string | null; logo?: string | null;
  talle?: string | null; grupo?: string | null;   // una prenda en varios talles es un producto (talles.ts)
}
interface Pdv extends Articulo {
  npdv: string | null; unidad: string | null; vendedor: string | null; record_id: number | null; pedido: string | null; owner_id: number | null;
  entrega_prometida: string | null; etapa: string | null; listos: number; total: number; editable: boolean; asignados_todos: number[]; articulos: Articulo[]; cliente: string | null;
  grupos?: Record<string, { nombre: string }>;   // el nombre sin el talle de cada producto con talles
}
interface Persona { clickup_id: number; nombre: string; user_id: number | null; foto: string | null; produccion?: number }
interface Opcion { campo: 'proveedor' | 'impresor'; option_id: string; nombre: string; company_id: number | null; empresa: string | null }
interface Estado { status: string; color: string; type: string }
interface Vista { pdvs: Pdv[]; personas: Persona[]; opciones: Opcion[]; estados: Estado[]; puede_editar: boolean }
type Campo = 'estado' | 'asignados' | 'entrega_real' | 'ingreso_proveedor' | 'retiro_proveedor' | 'egreso_impresor' | 'retiro_impresor' | 'ingreso_impresor' | 'proveedor' | 'impresor';

const CERRADOS = ['entregados', 'anulado'];
const LISTOS = ['listo para entergar', 'entregados'];
const D = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`);
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const dia = (f: string | null) => (f ? `${DIAS[D(f).getDay()]} ${D(f).getDate()}/${D(f).getMonth() + 1}` : '');
const sumar = (f: string, n: number) => { const d = D(f); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T12:00:00Z`) - Date.parse(`${a.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
const corrida = (p: Pdv) => (p.entrega_prometida && p.entrega_real && p.entrega_real.slice(0, 10) > p.entrega_prometida.slice(0, 10) ? diasEntre(p.entrega_prometida, p.entrega_real) : 0);
const listoPdv = (p: Pdv) => p.total > 0 && p.listos >= p.total;
// Atrasado: alguna fecha de entrega real (del PDV o de un artículo abierto) ya pasó y no está listo.
const atrasado = (p: Pdv, hoy: string) => !listoPdv(p) && [p.entrega_real, ...p.articulos.filter((a) => !LISTOS.includes(a.estado) && !CERRADOS.includes(a.estado)).map((a) => a.entrega_real)]
  .some((f) => !!f && f.slice(0, 10) < hoy);
const fechaPdv = (p: Pdv) => (p.entrega_real ?? p.entrega_prometida ?? '').slice(0, 10);

// Proveedor o impresor: una opción por empresa (las repetidas de ClickUp juntas) y las que no son empresas («STOCK»).
function opcionesDe(v: Vista, campo: 'proveedor' | 'impresor') {
  const vistas = new Set<number>();
  const lista: Array<{ value: string; label: string }> = [];
  for (const o of v.opciones.filter((x) => x.campo === campo)) {
    if (o.company_id) { if (vistas.has(o.company_id)) continue; vistas.add(o.company_id); lista.push({ value: o.option_id, label: o.empresa ?? o.nombre }); }
    else lista.push({ value: o.option_id, label: o.nombre });
  }
  return lista.sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
const nombreOpcion = (v: Vista, campo: 'proveedor' | 'impresor', id: string | null) => {
  if (!id) return null;
  const o = v.opciones.find((x) => x.campo === campo && x.option_id === id);
  return o ? lindo(o.empresa ?? o.nombre) : id;
};

// Lo mismo que hace la pantalla Producción al editar: se ve enseguida y, si ClickUp no lo acepta, vuelve atrás.
function aplicar(p: Pdv, taskId: string, campo: Campo, valor: unknown): Pdv {
  const v = campo === 'asignados' ? (valor as number[]) : valor === '' ? null : valor;
  if (p.task_id === taskId && campo === 'asignados') {
    const ids = v as number[];
    const articulos = p.articulos.map((a) => (CERRADOS.includes(a.estado) ? a : { ...a, asignados: ids }));
    return { ...p, asignados: ids, articulos, asignados_todos: [...new Set([...ids, ...articulos.flatMap((a) => a.asignados)])] };
  }
  if (p.task_id === taskId) return { ...p, [campo]: v };
  return { ...p, articulos: p.articulos.map((a) => (a.task_id === taskId ? { ...a, [campo]: v } : a)) };
}
function useProduccion() {
  const toast = useToast();
  const carga = useCarga(() => http<Vista>('GET', '/produccion'), []);
  const editar = async (pdv: Pdv, taskId: string, campo: Campo, valor: unknown, aviso = 'Guardado en ClickUp') => {
    const antes = carga.datos;
    carga.setDatos((v) => v && { ...v, pdvs: v.pdvs.map((p) => (p.task_id === pdv.task_id ? aplicar(p, taskId, campo, valor) : p)) });
    try {
      const r = await http<{ pdv: Pdv | null }>('PATCH', `/produccion/${encodeURIComponent(taskId)}`, { campo, valor });
      revisarFestejos();   // si el pedido pasó a listo para entregar o entregado, Chispín lo festeja (Chispin.tsx)
      if (r.pdv) carga.setDatos((v) => v && { ...v, pdvs: v.pdvs.map((p) => (p.task_id === r.pdv!.task_id ? r.pdv! : p)) });
      toast(aviso);
    } catch (e) {
      carga.setDatos(antes);
      toast((e as Error).message, true);
      if (campo === 'asignados') carga.recargar();
    }
  };
  // Una prenda con talles: el mismo cambio en todos sus talles (PATCH /produccion/grupo). Si alguno no se pudo, se avisa.
  const editarGrupo = async (pdv: Pdv, tareas: string[], campo: Campo, valor: unknown, aviso = 'Guardado en ClickUp, en todos los talles') => {
    const antes = carga.datos;
    carga.setDatos((v) => v && { ...v, pdvs: v.pdvs.map((p) => (p.task_id === pdv.task_id ? tareas.reduce((x, t) => aplicar(x, t, campo, valor), p) : p)) });
    try {
      const r = await http<{ pdv: Pdv | null; error: string | null }>('PATCH', '/produccion/grupo', { tareas, campo, valor });
      revisarFestejos();
      if (r.pdv) carga.setDatos((v) => v && { ...v, pdvs: v.pdvs.map((p) => (p.task_id === r.pdv!.task_id ? r.pdv! : p)) });
      toast(r.error ?? aviso, !!r.error);
    } catch (e) {
      carga.setDatos(antes);
      toast((e as Error).message, true);
    }
  };
  return { ...carga, editar, editarGrupo };
}
const yoEn = (v: Vista | null, userId: number) => v?.personas.find((p) => p.user_id === userId)?.clickup_id ?? null;

function Personas({ ids, v }: { ids: number[]; v: Vista }) {
  const quienes = ids.map((id) => v.personas.find((p) => p.clickup_id === id)).filter((p): p is Persona => !!p);
  if (!quienes.length) return <span className="small muted">Sin asignar</span>;
  return (
    <span className="m-personas" title={quienes.map((p) => p.nombre).join(', ')}>
      <span className="avatar-stack">{quienes.slice(0, 3).map((p) => <Avatar key={p.clickup_id} name={p.nombre} photo={p.foto} size="sm" />)}</span>
      <span className="small">{quienes.length === 1 ? quienes[0].nombre.split(' ')[0] : `${quienes.length} personas`}</span>
    </span>
  );
}

function TarjetaPdv({ p, v, hoy }: { p: Pdv; v: Vista; hoy: string }) {
  const { meta } = useMeta();
  const etapa = p.etapa ? formatValue(meta, 'order', 'hs_pipeline_stage', p.etapa) : '';
  const atr = atrasado(p, hoy);
  const c = corrida(p);
  return (
    <Link to={`/produccion/${encodeURIComponent(p.task_id)}`} className="m-item m-item-link m-pdv">
      <div className="m-item-txt">
        <b>PDV {p.npdv ?? '—'} · {lindo(p.cliente) || 'Sin cliente'}</b>
        <small className={atr ? 'overdue' : 'muted'}>
          {p.entrega_real ? `Real ${dia(p.entrega_real)}` : p.entrega_prometida ? `Pactada ${dia(p.entrega_prometida)}` : 'Sin fecha'}{c ? ` · +${c} d` : ''}{atr ? ' · atrasado' : ''}
        </small>
        <span className="m-pdv-pie">
          {etapa ? <EtapaPedido value={p.etapa} label={etapa} /> : <span className="small muted">Sin arrancar</span>}
          <span className="small muted">{p.listos}/{p.total} listos</span>
        </span>
        <span className="m-barra" aria-hidden="true"><i style={{ width: `${p.total ? (p.listos / p.total) * 100 : 0}%` }} /></span>
      </div>
      <span className="m-pdv-lado"><Personas ids={p.asignados_todos} v={v} /></span>
    </Link>
  );
}

// ---------- Hoy ----------

export function HoyProduccion() {
  const { meta } = useMeta();
  const puede = usePuedeEscribir();
  const hoy = hoyIso();
  const sinLeer = useNoLeidas();
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const prod = useCarga(() => http<Vista>('GET', '/produccion'), []);
  const crono = useCarga(() => http<VistaCrono>('GET', `/cronograma${qs({ desde: hoy, hasta: hoy })}`), [hoy]);
  const tareas = useCarga(() => http<{ results: Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 20 })}`).then((r) => r.results), []);
  const { completar, posponer } = useCambiosTarea((t) => tareas.setDatos((ts) => ts?.filter((x) => x.id !== t.id) ?? null), tareas.recargar);
  const v = prod.datos;
  const yo = yoEn(v, meta.me.id);
  const mios = (v?.pdvs ?? []).filter((p) => yo != null && p.asignados_todos.includes(yo));
  const atrasados = mios.filter((p) => atrasado(p, hoy));
  const semana = mios.filter((p) => !atrasado(p, hoy) && !listoPdv(p) && fechaPdv(p) >= hoy && fechaPdv(p) <= sumar(hoy, 7)).sort((a, b) => fechaPdv(a).localeCompare(fechaPdv(b)));
  const movsHoy = (crono.datos?.movimientos ?? []).filter((m) => m.fecha === hoy);
  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="m-pag">
      <div className="m-saludo"><h1>Hola, {meta.me.name.split(' ')[0]}</h1><p className="muted">{fecha.charAt(0).toUpperCase() + fecha.slice(1)}</p></div>

      {prod.error && <Fallo error={prod.error} onReintentar={prod.recargar} />}
      {!v && !prod.error && <Cargando chico />}
      {v && yo == null && <div className="m-fallo chico m-motivo">Tu usuario no está en ClickUp como de Producción: no se puede saber qué PDV son tuyos. Mirá todos en Producción.</div>}

      {atrasados.length > 0 && (
        <section className="m-sec" aria-label="Tus PDV atrasados">
          <div className="m-sec-cab"><h2 className="overdue">Tus PDV atrasados</h2><span className="m-pill mal">{atrasados.length}</span><span className="grow" />
            <Link to="/produccion?filtro=atrasados" className="m-link">Ver todos</Link></div>
          {atrasados.slice(0, 5).map((p) => <TarjetaPdv key={p.task_id} p={p} v={v!} hoy={hoy} />)}
        </section>
      )}

      {v && yo != null && (
        <section className="m-sec" aria-label="Tus entregas de la semana">
          <div className="m-sec-cab"><h2>Tus entregas de la semana</h2><span className="grow" /><Link to="/produccion" className="m-link">Tus PDV ({mios.filter((p) => !listoPdv(p)).length})</Link></div>
          {!semana.length && <div className="m-vacio">Nada para entregar en los próximos 7 días.</div>}
          {semana.slice(0, 6).map((p) => <TarjetaPdv key={p.task_id} p={p} v={v} hoy={hoy} />)}
        </section>
      )}

      <section className="m-sec" aria-label="Entra y sale hoy">
        <div className="m-sec-cab"><h2>Entra y sale hoy</h2><span className="grow" /><Link to="/cronograma" className="m-link">Ver el día</Link></div>
        {crono.error && <Fallo chico error={crono.error} onReintentar={crono.recargar} />}
        {!crono.datos && !crono.error && <Cargando chico />}
        {crono.datos && !movsHoy.length && <div className="m-vacio">Hoy no entra ni sale nada.</div>}
        {crono.datos && movsHoy.length > 0 && (
          <div className="m-carriles">
            {CARRILES.map((c) => {
              const ms = movsHoy.filter((m) => c.tipos.includes(m.tipo));
              if (!ms.length) return null;
              const pend = ms.filter((m) => !m.hecho).length;
              return <Link key={c.k} to="/cronograma" className="m-carril"><b>{ms.length}</b><span>{c.nombre}</span><small className={pend ? '' : 'muted'}>{pend ? `${pend} pendiente${pend === 1 ? '' : 's'}` : 'todo hecho'}</small></Link>;
            })}
          </div>
        )}
      </section>

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

// ---------- Producción: la lista de PDV ----------

type Quien = 'mios' | 'sin' | 'todos';
export function ProduccionLista() {
  const { meta } = useMeta();
  const hoy = hoyIso();
  const [sp, setSp] = useSearchParams();
  const cambiar = (cambios: Record<string, string | null>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, x] of Object.entries(cambios)) { if (x) n.set(k, x); else n.delete(k); } return n; }, { replace: true });
  const carga = useCarga(() => http<Vista>('GET', '/produccion'), []);
  const v = carga.datos;
  const yo = yoEn(v, meta.me.id);
  const quien: Quien = (['mios', 'sin', 'todos'] as const).find((x) => x === sp.get('quien')) ?? (yo != null ? 'mios' : 'todos');
  // La etapa elegida («sin»: los que todavía no arrancaron); sin elegir, todas.
  const etapaSel = sp.get('etapa');
  const etapa = etapaSel === 'sin' ? '' : etapaSel;
  const soloAtrasados = sp.get('filtro') === 'atrasados';
  const q = sp.get('q') ?? '';
  const [texto, setTexto] = useState(q);
  const dq = useDebounced(texto, 250);
  useEffect(() => { if (dq.trim() !== q) cambiar({ q: dq.trim() || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => (v?.pdvs ?? []).filter((p) => (quien === 'mios' ? yo != null && p.asignados_todos.includes(yo) : quien === 'sin' ? !p.asignados_todos.length : true)), [v, quien, yo]);
  const etapas = useMemo(() => [...new Set(base.map((p) => p.etapa ?? ''))], [base]);
  const t = q.toLowerCase();
  const lista = base.filter((p) => (etapa == null || (p.etapa ?? '') === etapa) && (!soloAtrasados || atrasado(p, hoy))
    && (!t || [p.npdv, p.cliente, p.pedido, ...p.articulos.map((a) => a.nombre)].some((x) => (x ?? '').toLowerCase().includes(t))))
    .sort((a, b) => Number(atrasado(b, hoy)) - Number(atrasado(a, hoy)) || (fechaPdv(a) || '9').localeCompare(fechaPdv(b) || '9'));
  const nombreEtapa = (e: string) => (e ? formatValue(meta, 'order', 'hs_pipeline_stage', e) : 'Sin arrancar');
  return (
    <div className="m-pag">
      <div className="search"><Icon name="search" /><input className="input" type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="PDV, cliente o producto…" aria-label="Buscar en Producción" enterKeyHint="search" /></div>
      <div className="m-chips" role="group" aria-label="De quién">
        {([['mios', 'Míos'], ['sin', 'Sin asignar'], ['todos', 'Todos']] as Array<[Quien, string]>).filter(([k]) => k !== 'mios' || yo != null).map(([k, l]) => (
          <button key={k} type="button" className={`chip sm${quien === k ? ' on' : ''}`} aria-pressed={quien === k} onClick={() => cambiar({ quien: k, etapa: null })}>{l}</button>
        ))}
        <button type="button" className={`chip sm${soloAtrasados ? ' on' : ''}`} aria-pressed={soloAtrasados} onClick={() => cambiar({ filtro: soloAtrasados ? null : 'atrasados' })}>Atrasados</button>
      </div>
      {etapas.length > 1 && (
        <div className="m-chips m-chips-scroll" role="group" aria-label="Etapa">
          <button type="button" className={`chip${etapa == null ? ' on' : ''}`} aria-pressed={etapa == null} onClick={() => cambiar({ etapa: null })}>Todas ({base.length})</button>
          {etapas.map((e) => <button key={e || 'sin'} type="button" className={`chip${etapa === e ? ' on' : ''}`} aria-pressed={etapa === e}
            onClick={() => cambiar({ etapa: e || 'sin' })}>{nombreEtapa(e)} ({base.filter((p) => (p.etapa ?? '') === e).length})</button>)}
        </div>
      )}
      {carga.error && <Fallo error={carga.error} onReintentar={carga.recargar} />}
      {!v && !carga.error && <Cargando />}
      {v && !lista.length && <div className="m-vacio m-vacio-solo">{q ? `No hay PDV con «${q}».` : soloAtrasados ? 'No hay PDV atrasados.' : 'No hay PDV acá.'}</div>}
      {v && lista.length > 0 && <div className="m-sec">{lista.slice(0, 80).map((p) => <TarjetaPdv key={p.task_id} p={p} v={v} hoy={hoy} />)}
        {lista.length > 80 && <div className="m-vacio">Y {lista.length - 80} más: buscá o filtrá para verlos.</div>}</div>}
    </div>
  );
}

// ---------- Un PDV ----------

export function FichaPdv() {
  const { task = '' } = useParams();
  const { meta } = useMeta();
  const navigate = useNavigate();
  const prod = useProduccion();
  const hoy = hoyIso();
  const [hoja, setHoja] = useState<null | { articulo: string } | { grupo: string } | 'real' | 'asignados'>(null);
  const v = prod.datos;
  if (prod.error) return <div className="m-pag"><Fallo error={prod.error} onReintentar={prod.recargar} /></div>;
  if (!v) return <div className="m-pag"><Cargando /></div>;
  const p = v.pdvs.find((x) => x.task_id === task);
  if (!p) return <div className="m-pag"><div className="m-al-dia"><span className="m-al-dia-ico neutro"><Icon name="printer" size={22} /></span><b>Este PDV ya no está en Producción</b>
    <small className="muted">Puede estar entregado o anulado.</small><button type="button" className="btn" onClick={() => navigate('/produccion')}>Volver a Producción</button></div></div>;
  const ed = v.puede_editar && p.editable;
  const etapa = p.etapa ? formatValue(meta, 'order', 'hs_pipeline_stage', p.etapa) : '';
  const c = corrida(p);
  const abiertos = p.articulos.filter((a) => !CERRADOS.includes(a.estado));
  const cerrados = p.articulos.filter((a) => CERRADOS.includes(a.estado));
  const vendedor = p.owner_id ? userOf(meta, p.owner_id)?.name : p.vendedor;
  const art = hoja && typeof hoja === 'object' && 'articulo' in hoja ? p.articulos.find((a) => a.task_id === hoja.articulo) : null;
  // Una prenda en varios talles es un producto (talles.ts): un renglón, y su hoja cambia todos los talles.
  const productos = [...juntarTalles(abiertos), ...juntarTalles(cerrados)];
  const talles = hoja && typeof hoja === 'object' && 'grupo' in hoja ? p.articulos.filter((a) => a.grupo === hoja.grupo) : [];
  const comun = <K extends keyof Articulo>(k: K) => (talles.every((a) => a[k] === talles[0][k]) ? talles[0][k] : null);
  const grupoArt: Articulo | null = talles.length ? {
    ...talles[0], nombre: p.grupos?.[talles[0].grupo!]?.nombre ?? talles[0].nombre, estado: comun('estado') ?? '', cantidad: talles.reduce((n, a) => n + (a.cantidad ?? 0), 0),
    proveedor: comun('proveedor'), impresor: comun('impresor'), entrega_real: comun('entrega_real'), ingreso_proveedor: comun('ingreso_proveedor'),
    retiro_proveedor: comun('retiro_proveedor'), egreso_impresor: comun('egreso_impresor'), retiro_impresor: comun('retiro_impresor'), ingreso_impresor: comun('ingreso_impresor'),
    asignados: [...new Set(talles.flatMap((a) => a.asignados))], url: null,
  } : null;
  return (
    <div className="m-pag m-ficha">
      <div className="m-ficha-tit">
        <h1>PDV {p.npdv ?? '—'}</h1>
        <p className="muted">{[lindo(p.cliente), vendedor && `vende ${vendedor}`, p.unidad && lindo(p.unidad)].filter(Boolean).join(' · ')}</p>
        <div className="m-pedido-estado">{etapa ? <EtapaPedido value={p.etapa} label={etapa} /> : <span className="small muted">Sin arrancar</span>}
          <span className="small muted">{p.listos} de {p.total} listos</span></div>
      </div>
      {!ed && v.puede_editar && <div className="m-fallo chico m-motivo">{lindo(p.unidad) || 'Esta unidad'} se sigue trabajando en ClickUp: acá solo se reasigna.</div>}

      <section className="m-sec" aria-label="Fechas y quién lo tiene">
        <div className="m-datos">
          <div className="m-dato m-dato-fijo"><span className="m-dato-et">Pactada</span><span className="m-dato-val">{dia(p.entrega_prometida) || '—'}</span></div>
          <button type="button" className="m-dato" disabled={!ed} onClick={() => setHoja('real')} aria-label={`Entrega real: ${dia(p.entrega_real) || 'sin fecha'}${ed ? ', cambiar' : ''}`}>
            <span className="m-dato-et">Entrega real</span>
            <span className={`m-dato-val${atrasado(p, hoy) ? ' overdue' : ''}`}>{dia(p.entrega_real) || (ed ? 'Poner fecha' : '—')}{c ? <span className="m-pill aviso">+{c} d</span> : null}</span>
          </button>
          <button type="button" className="m-dato" disabled={!v.puede_editar} onClick={() => setHoja('asignados')} aria-label="Quién lo tiene, cambiar">
            <span className="m-dato-et">Lo tiene</span><span className="m-dato-val"><Personas ids={p.asignados} v={v} /></span>
          </button>
        </div>
      </section>

      {p.record_id && <BotonConversacion tipo="order" id={p.record_id} />}
      {p.record_id && <div className="m-rapidas"><Link to={recordUrl('order', p.record_id)} className="btn"><Icon name="order" size={16} />Ver el pedido</Link></div>}

      <section className="m-sec" aria-label="Artículos">
        <div className="m-sec-cab"><h2>Artículos</h2><span className="muted small">{juntarTalles(abiertos).length}{cerrados.length ? ` · ${juntarTalles(cerrados).length} cerrados` : ''}</span></div>
        {productos.map((e) => {
          if (e.k === 'talles') {
            const ts = e.xs, a = ts[0];
            const est = ts.every((x) => x.estado === a.estado) ? v.estados.find((x) => x.status === a.estado) : null;
            const prov = ts.every((x) => x.proveedor === a.proveedor) ? nombreOpcion(v, 'proveedor', a.proveedor) : 'varios proveedores';
            const real = ts.every((x) => x.entrega_real === a.entrega_real) ? a.entrega_real : null;
            const cant = ts.reduce((n, x) => n + (x.cantidad ?? 0), 0);
            const nombre = p.grupos?.[a.grupo!]?.nombre ?? a.nombre;
            return (
              <button key={e.clave} type="button" className={`m-art${ts.every((x) => CERRADOS.includes(x.estado)) ? ' cerrado' : ''}`} onClick={() => setHoja({ grupo: a.grupo! })}
                aria-label={`${nombre}, ${ts.length} talles. Editar`}>
                {ts.find((x) => x.foto)?.foto ? <img className="m-art-img" src={ts.find((x) => x.foto)!.foto!} alt="" loading="lazy" /> : <span className="m-art-img vacia"><Icon name="bag" size={18} /></span>}
                <span className="m-item-txt">
                  <b className="m-art-nombre">{nombre}</b>
                  <small className="muted">{[`${cant.toLocaleString('es-AR')} u.`, prov, nombreOpcion(v, 'impresor', a.impresor) && ts.every((x) => x.impresor === a.impresor) && `imp. ${nombreOpcion(v, 'impresor', a.impresor)}`].filter(Boolean).join(' · ')}</small>
                  <small className="m-art-talles">{textoTalles(ts)}</small>
                  <span className="m-art-pie">
                    {est ? <EstadoClickup estado={a.estado} color={est.color} /> : <span className="small muted">Varios estados</span>}
                    {real && <span className="small muted">Real {dia(real)}</span>}
                  </span>
                </span>
              </button>
            );
          }
          const a = e.x;
          const estado = v.estados.find((x) => x.status === a.estado);
          const atr = !!a.entrega_real && a.entrega_real.slice(0, 10) < hoy && !LISTOS.includes(a.estado) && !CERRADOS.includes(a.estado);
          const fechas = ([['Ingreso', a.ingreso_proveedor], ['Retiro prov.', a.retiro_proveedor], ['Egreso imp.', a.egreso_impresor], ['Retiro imp.', a.retiro_impresor], ['Ingreso imp.', a.ingreso_impresor]] as Array<[string, string | null]>).filter(([, f]) => f);
          return (
            <button key={a.task_id} type="button" className={`m-art${CERRADOS.includes(a.estado) ? ' cerrado' : ''}`} onClick={() => setHoja({ articulo: a.task_id })} aria-label={`${a.nombre}: ${nombreEstado(a.estado)}. Editar`}>
              {a.foto ? <img className="m-art-img" src={a.foto} alt="" loading="lazy" /> : <span className="m-art-img vacia"><Icon name="bag" size={18} /></span>}
              <span className="m-item-txt">
                <b className="m-art-nombre">{a.nombre}</b>
                <small className="muted">{[a.cantidad != null ? `${a.cantidad.toLocaleString('es-AR')} u.` : null, nombreOpcion(v, 'proveedor', a.proveedor), nombreOpcion(v, 'impresor', a.impresor) && `imp. ${nombreOpcion(v, 'impresor', a.impresor)}`].filter(Boolean).join(' · ')}</small>
                <span className="m-art-pie">
                  <EstadoClickup estado={a.estado} color={estado?.color} />
                  {a.entrega_real && <span className={`small${atr ? ' overdue' : ' muted'}`}>Real {dia(a.entrega_real)}</span>}
                </span>
                {fechas.length > 0 && <small className="muted m-art-fechas">{fechas.map(([l, f]) => `${l} ${dia(f)}`).join(' · ')}</small>}
                {a.logo && ['falta', 'textos', 'no_vectorial'].includes(a.logo) && <span className="m-pill aviso">{a.logo === 'falta' ? 'Falta el logo en curvas' : a.logo === 'textos' ? 'Logo con textos sin curvas' : 'Logo no vectorial'}</span>}
              </span>
            </button>
          );
        })}
      </section>

      {hoja === 'real' && <HojaFecha titulo={`Entrega real del PDV ${p.npdv}`} valor={p.entrega_real} onClose={() => setHoja(null)} onElegir={(f) => prod.editar(p, p.task_id, 'entrega_real', f)} />}
      {hoja === 'asignados' && <HojaAsignados v={v} ids={p.asignados} nota="Pasa también a sus artículos abiertos." onClose={() => setHoja(null)} onCambio={(ids) => prod.editar(p, p.task_id, 'asignados', ids, 'Reasignado en ClickUp')} />}
      {art && <HojaArticulo a={art} v={v} ed={ed} puedeAsignar={v.puede_editar} onClose={() => setHoja(null)} editar={(campo, valor, aviso) => prod.editar(p, art.task_id, campo, valor, aviso)} />}
      {grupoArt && <HojaArticulo a={grupoArt} v={v} ed={ed} puedeAsignar={v.puede_editar} onClose={() => setHoja(null)} talles={talles} onTalle={(id) => setHoja({ articulo: id })}
        editar={(campo, valor) => prod.editarGrupo(p, talles.map((a) => a.task_id), campo, valor)} />}
    </div>
  );
}

// ---------- Hojas para editar ----------

function HojaFecha({ titulo, valor, onElegir, onClose }: { titulo: string; valor: string | null; onElegir: (f: string) => void; onClose: () => void }) {
  const hoy = hoyIso();
  const [f, setF] = useState(valor?.slice(0, 10) ?? '');
  const elegir = (x: string) => { onElegir(x); onClose(); };
  return (
    <Hoja titulo={titulo} onClose={onClose}>
      <div className="m-form">
        <div className="m-chips">{[0, 1, 2, 3, 4, 7].map((n) => { const d = sumar(hoy, n); return <button key={n} type="button" className={`chip${valor?.slice(0, 10) === d ? ' on' : ''}`} onClick={() => elegir(d)}>{n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : dia(d)}</button>; })}</div>
        <label className="field">Otra fecha<input className="input" type="date" value={f} onChange={(e) => setF(e.target.value)} /></label>
        <button type="button" className="btn primary m-grande" disabled={!f || f === valor?.slice(0, 10)} onClick={() => elegir(f)}>Guardar</button>
        {valor && <button type="button" className="btn ghost" onClick={() => elegir('')}>Quitar la fecha</button>}
      </div>
    </Hoja>
  );
}

function HojaAsignados({ v, ids, nota, onCambio, onClose }: { v: Vista; ids: number[]; nota?: string; onCambio: (ids: number[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState(ids);
  const hayProduccion = v.personas.some((p) => p.produccion);
  const elegibles = v.personas.filter((p) => !hayProduccion || p.produccion || ids.includes(p.clickup_id));
  const cambio = sel.length !== ids.length || sel.some((x) => !ids.includes(x));
  return (
    <Hoja titulo="¿Quién lo tiene?" onClose={onClose}>
      <div className="m-form">
        {nota && <small className="muted">{nota}</small>}
        <div className="m-etapas" role="group" aria-label="Personas">
          {elegibles.map((p) => {
            const on = sel.includes(p.clickup_id);
            return <button key={p.clickup_id} type="button" role="checkbox" aria-checked={on} className={on ? 'on' : ''} onClick={() => setSel(on ? sel.filter((x) => x !== p.clickup_id) : [...sel, p.clickup_id])}>
              <Avatar name={p.nombre} photo={p.foto} size="sm" />{p.nombre}{on && <Icon name="check" size={16} />}</button>;
          })}
          {!elegibles.length && <div className="m-vacio">Todavía no hay nadie con perfil Producción en ClickUp.</div>}
        </div>
        <button type="button" className="btn primary m-grande" disabled={!cambio} onClick={() => { onCambio(sel); onClose(); }}>Guardar</button>
      </div>
    </Hoja>
  );
}

// Un artículo: el estado (con sus colores de ClickUp), las fechas, proveedor, impresor y quién lo tiene. Cada cambio se
// guarda en el momento, como en la pantalla Producción.
const FECHAS: Array<[Campo, string]> = [['entrega_real', 'Entrega real'], ['ingreso_proveedor', 'Ingreso del proveedor'], ['retiro_proveedor', 'Retiro del proveedor'],
  ['egreso_impresor', 'Egreso al impresor'], ['retiro_impresor', 'Retiro del impresor'], ['ingreso_impresor', 'Ingreso del impresor']];
// `talles`: una prenda en varios talles (talles.ts): lo que se elige va a todos sus talles; abajo, cada talle para cambiarlo solo.
function HojaArticulo({ a, v, ed, puedeAsignar, editar, onClose, talles, onTalle }: { a: Articulo; v: Vista; ed: boolean; puedeAsignar: boolean; editar: (c: Campo, valor: unknown, aviso?: string) => void; onClose: () => void;
  talles?: Articulo[]; onTalle?: (taskId: string) => void }) {
  const [sub, setSub] = useState<null | { fecha: Campo } | { opcion: 'proveedor' | 'impresor' } | 'asignados'>(null);
  if (sub && typeof sub === 'object' && 'fecha' in sub) {
    const [, nombre] = FECHAS.find(([c]) => c === sub.fecha)!;
    return <HojaFecha titulo={`${nombre}: ${a.nombre}`} valor={a[sub.fecha as keyof Articulo] as string | null} onClose={() => setSub(null)} onElegir={(f) => editar(sub.fecha, f)} />;
  }
  if (sub && typeof sub === 'object' && 'opcion' in sub) return <HojaOpcion v={v} campo={sub.opcion} valor={a[sub.opcion]} onClose={() => setSub(null)} onElegir={(x) => editar(sub.opcion, x)} />;
  if (sub === 'asignados') return <HojaAsignados v={v} ids={a.asignados} onClose={() => setSub(null)} onCambio={(ids) => editar('asignados', ids, 'Reasignado en ClickUp')} />;
  const conocido = v.estados.some((x) => x.status === a.estado);
  return (
    <Hoja titulo={a.nombre} onClose={onClose}>
      <div className="m-form">
        {talles && talles.length > 0 && <small className="muted">{talles.length} talles ({talles.map((t) => t.talle).join(', ')}): lo que elijas acá va a todos.</small>}
        <div className="field">Estado
          <div className="m-estados" role="radiogroup" aria-label="Estado">
            {[...v.estados, ...(conocido ? [] : [{ status: a.estado, color: '', type: '' }])].map((e) => (
              <button key={e.status} type="button" role="radio" aria-checked={a.estado === e.status} disabled={!ed} className={`m-estado${a.estado === e.status ? ' on' : ''}`}
                onClick={() => a.estado !== e.status && editar('estado', e.status, `Pasó a «${nombreEstado(e.status)}» en ClickUp`)}>
                <EstadoClickup estado={e.status} color={e.color} />{a.estado === e.status && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </div>
        <div className="m-datos m-datos-hoja">
          {FECHAS.map(([c, l]) => (
            <button key={c} type="button" className="m-dato" disabled={!ed} onClick={() => setSub({ fecha: c })}>
              <span className="m-dato-et">{l}</span><span className={`m-dato-val${a[c as keyof Articulo] ? '' : ' vacio'}`}>{dia(a[c as keyof Articulo] as string | null) || (ed ? 'Poner fecha' : '—')}</span>
            </button>
          ))}
          {(['proveedor', 'impresor'] as const).map((c) => (
            <button key={c} type="button" className="m-dato" disabled={!ed} onClick={() => setSub({ opcion: c })}>
              <span className="m-dato-et">{c === 'proveedor' ? 'Proveedor' : 'Impresor'}</span><span className={`m-dato-val${a[c] ? '' : ' vacio'}`}>{nombreOpcion(v, c, a[c]) ?? (ed ? 'Elegir' : '—')}</span>
            </button>
          ))}
          <button type="button" className="m-dato" disabled={!puedeAsignar} onClick={() => setSub('asignados')}>
            <span className="m-dato-et">Lo tiene</span><span className="m-dato-val"><Personas ids={a.asignados} v={v} /></span>
          </button>
        </div>
        {talles && talles.length > 0 && (
          <div className="field">Cada talle <small className="muted">Lo de arriba cambia todos; tocá uno para cambiarlo solo.</small>
            <div className="m-etapas m-talles">
              {talles.map((t) => (
                <button key={t.task_id} type="button" onClick={() => onTalle?.(t.task_id)}>
                  <b className="prod-talle grande">{t.talle}</b>{t.cantidad != null ? `${t.cantidad.toLocaleString('es-AR')} u.` : ''}
                  <EstadoClickup estado={t.estado} color={v.estados.find((x) => x.status === t.estado)?.color} />
                </button>
              ))}
            </div>
          </div>
        )}
        {a.url && <a className="btn ghost" href={a.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Abrir en ClickUp</a>}
      </div>
    </Hoja>
  );
}

function HojaOpcion({ v, campo, valor, onElegir, onClose }: { v: Vista; campo: 'proveedor' | 'impresor'; valor: string | null; onElegir: (x: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const actual = valor ? v.opciones.find((o) => o.campo === campo && o.option_id === valor) : null;
  const esActual = (id: string) => id === valor || (!!actual?.company_id && v.opciones.some((o) => o.option_id === id && o.company_id === actual.company_id));
  const ops = opcionesDe(v, campo).filter((o) => !t || o.label.toLowerCase().includes(t));
  return (
    <Hoja titulo={campo === 'proveedor' ? 'Proveedor' : 'Impresor'} onClose={onClose}>
      <div className="m-form">
        <div className="search"><Icon name="search" /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" aria-label="Buscar" /></div>
        <div className="m-etapas m-opciones-largas" role="radiogroup" aria-label={campo}>
          {valor && <button type="button" role="radio" aria-checked={false} onClick={() => { onElegir(''); onClose(); }}><Icon name="x" size={16} />Sacar el {campo}</button>}
          {ops.map((o) => <button key={o.value} type="button" role="radio" aria-checked={esActual(o.value)} className={esActual(o.value) ? 'on' : ''} onClick={() => { if (!esActual(o.value)) onElegir(o.value); onClose(); }}>
            {lindo(o.label)}{esActual(o.value) && <Icon name="check" size={16} />}</button>)}
          {!ops.length && <div className="m-vacio">No hay {campo === 'proveedor' ? 'proveedores' : 'impresores'} con «{q}».</div>}
        </div>
      </div>
    </Hoja>
  );
}
