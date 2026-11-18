import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { http, qs, useMeta, useToast, Icon, fmtDate, fmtMoney, recordUrl, stageOf, Cargando, type Activity, type CrmRecord } from '../lib';
import { lindo } from '../pages/Cronograma';
import { cuando, resumen, hoyIso, sumar, ESTADO, type Encargo } from '../pages/Recorridos';
import { TareaRapida } from './Movil';
import { FilaTarea } from './TareasChatMovil';
import { TareaPanel } from '../TareaPanel';

// Hoy (versión celular, perfil Ventas): lo que el vendedor tiene que hacer hoy, todo junto. Sus tareas de hoy y vencidas
// (se tildan acá mismo), sus encargos al recorrido de los próximos días y los negocios que se le están enfriando.

export default function Hoy() {
  const { meta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const [version, setVersion] = useState(0);
  const [tareas, setTareas] = useState<Activity[] | null>(null);
  const [encargos, setEncargos] = useState<Encargo[] | null>(null);
  const [frios, setFrios] = useState<CrmRecord[] | null>(null);
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const hoy = hoyIso();

  useEffect(() => {
    http<{ results: Activity[] }>('GET', `/tasks${qs({ due: 'today', limit: 30 })}`).then((r) => setTareas(r.results), () => setTareas([]));
  }, [version]);
  useEffect(() => {
    http<{ encargos: Encargo[] }>('GET', `/recorridos/encargos${qs({ desde: hoy, hasta: sumar(hoy, 14) })}`)
      .then((r) => setEncargos(r.encargos.filter((e) => e.estado !== 'cancelado').sort((a, b) => a.fecha.localeCompare(b.fecha))), () => setEncargos([]));
  }, [hoy]);
  useEffect(() => {
    const cerradas = meta.pipelines.flatMap((p) => p.stages.filter((s) => s.is_closed).map((s) => s.id));
    http<{ results: CrmRecord[] }>('GET', `/records/deal${qs({
      filters: [{ prop: 'owner_id', op: 'eq', value: meta.me.id }, { prop: 'dealstage', op: 'not_in', values: cerradas }, { prop: 'notes_last_updated', op: 'before_days_ago', value: 14 }],
      sort: 'amount', dir: 'desc', limit: 5,
    })}`).then((r) => setFrios(r.results), () => setFrios([]));
  }, [meta]);

  async function completar(t: Activity) {
    setTareas((ts) => ts?.filter((x) => x.id !== t.id) ?? null);
    try {
      await http('PATCH', `/activities/${t.id}`, { status: 'COMPLETED' });
      toast('Tarea completada', false, { label: 'Deshacer', onClick: () => http('PATCH', `/activities/${t.id}`, { status: 'NOT_STARTED' }).then(() => setVersion((v) => v + 1)) });
    } catch (e) { toast((e as Error).message, true); setVersion((v) => v + 1); }
  }
  async function posponer(t: Activity) {
    const d = new Date(Math.max(Date.now(), Date.parse(t.due_at ?? '') || 0) + 86_400_000);
    setTareas((ts) => ts?.filter((x) => x.id !== t.id) ?? null);
    try { await http('PATCH', `/activities/${t.id}`, { due_at: d.toISOString() }); toast(`Pasada al ${fmtDate(d)}`); }
    catch (e) { toast((e as Error).message, true); setVersion((v) => v + 1); }
  }

  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const vencidas = (tareas ?? []).filter((t) => t.due_at && Date.parse(t.due_at) < new Date().setHours(0, 0, 0, 0)).length;
  return (
    <div className="m-pag">
      <div className="m-saludo">
        <h1>Hola, {meta.me.name.split(' ')[0]}</h1>
        <p className="muted">{fecha.charAt(0).toUpperCase() + fecha.slice(1)}</p>
      </div>

      <button type="button" className="m-cta" onClick={() => navigate('/recorridos/nuevo')}>
        <span className="m-cta-ico"><Icon name="route" size={22} /></span>
        <span><b>¿Algo para el recorrido?</b><small>Muestras, un sobre, mercadería: el chofer lo lleva o lo retira.</small></span>
        <Icon name="chevron" size={18} />
      </button>

      <section className="m-sec">
        <div className="m-sec-cab"><h2>Tareas</h2>{vencidas > 0 && <span className="m-pill mal">{vencidas} vencida{vencidas === 1 ? '' : 's'}</span>}
          <span className="grow" /><button type="button" className="m-link" onClick={() => setNueva(true)}><Icon name="plus" size={14} />Nueva</button></div>
        {!tareas && <Cargando chico />}
        {tareas && !tareas.length && <div className="m-vacio">Nada pendiente para hoy.</div>}
        {tareas?.map((t) => <FilaTarea key={t.id} t={t} onCheck={() => completar(t)} onPosponer={() => posponer(t)} onAbrir={() => setAbierta(t.id)} />)}
        {tareas && tareas.length > 0 && <Link to="/tasks" className="m-ver">Todas las tareas</Link>}
      </section>

      <section className="m-sec">
        <div className="m-sec-cab"><h2>Tus encargos</h2><span className="grow" /><Link to="/recorridos" className="m-link">Ver todos</Link></div>
        {!encargos && <Cargando chico />}
        {encargos && !encargos.length && <div className="m-vacio">No tenés nada en el recorrido de los próximos días.</div>}
        {encargos?.slice(0, 5).map((e) => (
          <Link key={e.id} to={`/recorridos?encargo=${e.id}`} className="m-item m-item-link">
            <span className="m-fecha"><b>{cuando(e.fecha, hoy).replace(/^El /, '')}</b></span>
            <div className="m-item-txt"><b>{lindo(e.destino)}{e.urgente && <span className="cr-tag late">Urgente</span>}</b><small className="muted">{resumen(e) || 'Sin detalle'}</small></div>
            <span className={`rc-estado ${ESTADO[e.estado].clase}`}>{ESTADO[e.estado].nombre}</span>
          </Link>
        ))}
      </section>

      {frios && frios.length > 0 && (
        <section className="m-sec">
          <div className="m-sec-cab"><h2>Negocios sin movimiento</h2><span className="muted small">hace +14 días</span></div>
          {frios.map((r) => (
            <Link key={r.id} to={recordUrl('deal', r.id)} className="m-item m-item-link">
              <div className="m-item-txt"><b>{r.name}</b><small className="muted">{stageOf(meta, r.props.dealstage)?.stage.label}</small></div>
              <span className="num small">{fmtMoney(r.props.amount)}</span>
            </Link>
          ))}
        </section>
      )}
      {abierta && <TareaPanel id={abierta} onClose={() => { setAbierta(null); setVersion((v) => v + 1); }} onChange={() => setVersion((v) => v + 1)} />}
      {nueva && <TareaRapida onClose={() => setNueva(false)} onCreada={() => setVersion((v) => v + 1)} />}
    </div>
  );
}
