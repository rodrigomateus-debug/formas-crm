import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { http, qs, useMeta, Icon, fmtMoney, fmtRelative, recordUrl, stageOf, formatValue, userOf, Cargando, type Activity, type CrmRecord } from '../lib';
import { Avatar, EtapaPedido } from '../components';
import { lindo } from '../pages/Cronograma';
import { cuando, resumen, hoyIso, sumar, ESTADO, type Encargo } from '../pages/Recorridos';
import { useNoLeidas } from '../pages/Conversacion';
import { TareaRapida } from './Movil';
import { FilaTarea, PanelTarea, useCambiosTarea } from './TareasChatMovil';
import { Fallo, useCarga, usePuedeEscribir } from './base';

// Hoy (versión celular, perfil Ventas): lo que el vendedor tiene que hacer hoy, todo junto y en orden de urgencia
// (revisión del 18/11/2026): sus tareas de hoy y vencidas (se tildan acá mismo), lo que le escribieron, las entregas de
// sus pedidos de esta semana, sus encargos al recorrido y los negocios que se le están enfriando.

export default function Hoy() {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const puede = usePuedeEscribir();
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const hoy = hoyIso();
  const sinLeer = useNoLeidas();

  const tareas = useCarga(() => http<{ results: Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 30 })}`).then((r) => r.results), []);
  const { completar, posponer } = useCambiosTarea((t) => tareas.setDatos((ts) => ts?.filter((x) => x.id !== t.id) ?? null), tareas.recargar);
  const entregas = useCarga(() => http<{ results: Array<CrmRecord & { company?: { id: number; name: string } | null }> }>('GET', `/records/order${qs({
    filters: [{ prop: 'owner_id', op: 'eq', value: meta.me.id }, { prop: 'fecha_de_entrega', op: 'between', value: hoy, high: sumar(hoy, 7) }],
    sort: 'fecha_de_entrega', dir: 'asc', limit: 5, with: 'company',
  })}`).then((r) => r.results), [meta.me.id, hoy]);
  const encargos = useCarga(() => http<{ encargos: Encargo[] }>('GET', `/recorridos/encargos${qs({ desde: hoy, hasta: sumar(hoy, 14) })}`)
    .then((r) => r.encargos.filter((e) => e.estado !== 'cancelado').sort((a, b) => a.fecha.localeCompare(b.fecha))), [hoy]);
  const frios = useCarga(() => {
    const cerradas = meta.pipelines.flatMap((p) => p.stages.filter((s) => s.is_closed).map((s) => s.id));
    return http<{ results: CrmRecord[] }>('GET', `/records/deal${qs({
      filters: [{ prop: 'owner_id', op: 'eq', value: meta.me.id }, { prop: 'dealstage', op: 'not_in', values: cerradas }, { prop: 'notes_last_updated', op: 'before_days_ago', value: 14 }],
      sort: 'amount', dir: 'desc', limit: 5,
    })}`).then((r) => r.results);
  }, [meta.me.id]);

  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const vencidas = (tareas.datos ?? []).filter((t) => t.due_at && Date.parse(t.due_at) < new Date().setHours(0, 0, 0, 0)).length;
  const mensajes = sinLeer.conversaciones.slice(0, 3);
  return (
    <div className="m-pag">
      <div className="m-saludo">
        <h1>Hola, {meta.me.name.split(' ')[0]}</h1>
        <p className="muted">{fecha.charAt(0).toUpperCase() + fecha.slice(1)}</p>
      </div>

      <section className="m-sec" aria-label="Tareas">
        <div className="m-sec-cab"><h2>Tareas</h2>{vencidas > 0 && <span className="m-pill mal">{vencidas} vencida{vencidas === 1 ? '' : 's'}</span>}
          <span className="grow" />{puede && <button type="button" className="m-link" onClick={() => setNueva(true)}><Icon name="plus" size={14} />Nueva</button>}</div>
        {tareas.error && <Fallo chico error={tareas.error} onReintentar={tareas.recargar} />}
        {!tareas.datos && !tareas.error && <Cargando chico />}
        {tareas.datos && !tareas.datos.length && <div className="m-vacio">Nada pendiente para hoy.</div>}
        {tareas.datos?.map((t) => <FilaTarea key={t.id} t={t} puede={puede} onCheck={() => completar(t)} onPosponer={() => posponer(t)} onAbrir={() => setAbierta(t.id)} />)}
        <Link to="/tasks" className="m-ver">Todas las tareas</Link>
      </section>

      {mensajes.length > 0 && (
        <section className="m-sec" aria-label="Te escribieron">
          <div className="m-sec-cab"><h2>Te escribieron</h2><span className="m-pill nuevo">{sinLeer.no_leidos}</span><span className="grow" /><Link to="/conversaciones" className="m-link">Ver todo</Link></div>
          {mensajes.map((c) => (
            <Link key={`${c.object_type}-${c.record_id}`} to={`/conversaciones/${c.object_type}/${c.record_id}`} className="m-item m-item-link">
              <Avatar name={c.name} type={c.object_type} />
              <div className="m-item-txt"><b>{c.menciones > 0 && <span className="m-mencion">@ </span>}{c.name}</b>
                <small className="muted">{c.ultimo ? `${userOf(meta, c.ultimo.user_id)?.name.split(' ')[0] ?? 'Alguien'}: ${c.ultimo.body.replace(/\s+/g, ' ')}` : ''}</small></div>
              <span className="m-badge-fila">{c.no_leidos}</span>
            </Link>
          ))}
        </section>
      )}

      {(entregas.datos?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Entregas de la semana">
          <div className="m-sec-cab"><h2>Entregas de la semana</h2></div>
          {entregas.datos!.map((o) => (
            <Link key={o.id} to={recordUrl('order', o.id)} className="m-item m-item-link">
              <span className="m-fecha"><b>{o.props.fecha_de_entrega ? cuando(String(o.props.fecha_de_entrega).slice(0, 10), hoy).replace(/^El /, '') : ''}</b></span>
              <div className="m-item-txt"><b>{o.name}</b><small className="muted">{o.company?.name ?? ''}</small></div>
              <span className="m-etapa-chip"><EtapaPedido value={o.props.hs_pipeline_stage} label={formatValue(meta, 'order', 'hs_pipeline_stage', o.props.hs_pipeline_stage)} /></span>
            </Link>
          ))}
        </section>
      )}

      <section className="m-sec" aria-label="Tus encargos al recorrido">
        <div className="m-sec-cab"><h2>Tus encargos</h2><span className="grow" />
          {puede && <button type="button" className="m-link" onClick={() => navigate('/recorridos/nuevo')}><Icon name="plus" size={14} />Encargo</button>}</div>
        {encargos.error && <Fallo chico error={encargos.error} onReintentar={encargos.recargar} />}
        {!encargos.datos && !encargos.error && <Cargando chico />}
        {encargos.datos && !encargos.datos.length && <div className="m-vacio">Nada en el recorrido de los próximos días. Con «+ Encargo» le pedís al chofer que lleve o retire algo.</div>}
        {encargos.datos?.slice(0, 5).map((e) => (
          <Link key={e.id} to={`/recorridos?encargo=${e.id}`} className="m-item m-item-link">
            <span className="m-fecha"><b>{cuando(e.fecha, hoy).replace(/^El /, '')}</b></span>
            <div className="m-item-txt"><b>{lindo(e.destino)}{e.urgente && <span className="cr-tag late">Urgente</span>}</b><small className="muted">{resumen(e) || 'Sin detalle'}</small></div>
            {e.estado !== 'pendiente' && <span className={`rc-estado ${ESTADO[e.estado].clase}`}>{ESTADO[e.estado].nombre}</span>}
          </Link>
        ))}
        {(encargos.datos?.length ?? 0) > 0 && <Link to="/recorridos" className="m-ver">Todos tus encargos</Link>}
      </section>

      {(frios.datos?.length ?? 0) > 0 && (
        <section className="m-sec" aria-label="Negocios sin movimiento">
          <div className="m-sec-cab"><h2>Negocios sin movimiento</h2><span className="muted small">hace +14 días</span></div>
          {frios.datos!.map((r) => (
            <Link key={r.id} to={recordUrl('deal', r.id)} className="m-item m-item-link">
              <div className="m-item-txt"><b>{r.name}</b><small className="muted">{stageOf(meta, r.props.dealstage)?.stage.label}{r.props.notes_last_updated ? ` · ${fmtRelative(r.props.notes_last_updated)}` : ''}</small></div>
              <span className="num small">{fmtMoney(r.props.amount)}</span>
            </Link>
          ))}
        </section>
      )}
      {abierta && <PanelTarea id={abierta} onClose={() => { setAbierta(null); tareas.recargar(); }} onChange={tareas.recargar} />}
      {nueva && <TareaRapida onClose={() => setNueva(false)} onCreada={tareas.recargar} />}
    </div>
  );
}
