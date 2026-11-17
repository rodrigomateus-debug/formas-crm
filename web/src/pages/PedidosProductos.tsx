import { useEffect, useState } from 'react';
import { http, useAsync, useMeta, formatValue, type CrmRecord } from '../lib';
import { EtapaPedido, OcLinks, PersonaProd, type OcRef, type PersonaProduccion } from '../components';
import { dia, Flecha, FotoProducto, hoyIso } from './Produccion';

// Producción en la lista y el tablero de Pedidos (pedido de Rodrigo del 17/11/2026): el pantallazo de la vendedora, como
// la pantalla Producción pero simplificado. Cada pedido con sus productos (se abren y se cierran, uno o todos), cada
// producto con su foto, su estado en palabras de la vendedora (la etapa del pedido: esperando boceto, en producción, listo
// para entregar, entregado) y quién lo tiene en Producción. Del pedido: lo que le toca a ella (anticipo, boceto), quién lo
// tiene, cuántos productos están listos y la entrega: la pactada con el cliente y, si Producción propuso otra, cuál.
// Lo arma pedidosprod.ts.

export interface ArticuloPedido {
  id: string; nombre: string; cantidad: number | null; foto: string | null; etapa: string | null; produccion: boolean;
  asignados: PersonaProduccion[]; entrega_real: string | null;
  entregado?: number; vendido?: number | null;   // según los remitos, en los pedidos con entregas a medias
  oc?: OcRef[];   // sus órdenes de compra de Finnegans, con link (ordenescompra.ts)
}
export interface ProduccionPedido { asignados: PersonaProduccion[]; listos: number; total: number; entrega_real: string | null; articulos: ArticuloPedido[]; ocs?: OcRef[] }

// La columna «OC» del pedido: todas sus órdenes de compra de Finnegans, cada una con link.
export function CeldaOc({ p }: { p?: ProduccionPedido }) {
  return <td className="ped-prod"><OcLinks ocs={p?.ocs} vacio={<span className="muted">—</span>} /></td>;
}

// Factura, remito, bocetos y conversación de cada pedido (los iconitos de la tarjeta del tablero, PropBoard.tsx).
export interface AdjuntosPedido { facturas: number; remitos: number; bocetos: number; con_boceto: number; productos: number; mensajes?: number }
const VACIO = { pedidos: {} as Record<number, ProduccionPedido>, adjuntos: {} as Record<number, AdjuntosPedido> };
// La dirección de los productos de esos pedidos (también para traerlos antes de tiempo, en las otras pestañas de la lista).
export const urlArticulos = (ids: number[], adjuntos = false) => `/pedidos/articulos?ids=${ids.join(',')}${adjuntos ? '&adjuntos=1' : ''}`;
// Los productos de los pedidos de la página o del tablero (una consulta) y, en la lista, sus adjuntos. `version`: cambia
// cuando se recarga. Quedan en la memoria de la página, como las listas: al volver a Pedidos aparecen enseguida.
// `listo`: lo que trae es de estos pedidos (si no, es lo de antes, esperando), para no dibujar la lista sin sus productos y
// estirarla un instante después (el «titileo» al entrar a Pedidos).
export function useProduccionPedidos(ids: number[], activo: boolean, version: unknown, adjuntos = false) {
  const url = activo && ids.length ? urlArticulos(ids, adjuntos) : undefined;
  const r = useAsync(() => (url ? http<typeof VACIO>('GET', url) : Promise.resolve(VACIO)), [url, version], url);
  return { ...(r.data ?? VACIO), listo: !url || r.fresh };
}

// Esperar los productos, pero no más de un rato: si tardan, se muestra lo que hay y los productos llegan después (mejor
// eso que la pantalla quieta en «Cargando…»). Devuelve true cuando ya se esperó demasiado.
export function useEsperaCorta(esperando: boolean, ms = 600) {
  const [harto, setHarto] = useState(false);
  useEffect(() => {
    if (!esperando) { setHarto(false); return; }
    const t = window.setTimeout(() => setHarto(true), ms);
    return () => window.clearTimeout(t);
  }, [esperando, ms]);
  return esperando && harto;
}

// Lo entregado de un producto según los remitos, en los pedidos con entregas a medias: «80 de 150 entregadas» (qué falta
// llevar) o, si ya se entregó todo, el tilde.
function Entregado({ a }: { a: ArticuloPedido }) {
  if (a.entregado == null || !a.vendido) return null;
  if (a.entregado >= a.vendido) return <span className="ped-entregado ok" title="Según los remitos, se entregó todo">Entregadas ✓</span>;
  const n = (x: number) => x.toLocaleString('es-AR');
  return <span className="ped-entregado" title={`Según los remitos: se entregaron ${n(a.entregado)} de ${n(a.vendido)}; faltan ${n(a.vendido - a.entregado)}`}>
    {a.entregado ? `${n(a.entregado)} de ${n(a.vendido)} entregadas` : 'Sin entregar'}</span>;
}

// Abiertos o cerrados: todos (queda en este navegador; por defecto, abiertos) y cada pedido aparte mientras se está en la
// pantalla, como en Producción. Los entregados y anulados arrancan cerrados: lo que importa es lo que está en curso. La
// lista y el tablero lo recuerdan cada uno por su lado.
export function useProductosAbiertos(pref = 'crm.pedidos.productos') {
  const [cerrados, setCerrados] = useState(() => { try { return localStorage.getItem(pref) === 'cerrados'; } catch { return false; } });
  const [excepciones, setExcepciones] = useState<Set<number>>(new Set());
  return {
    cerrados,
    abierto: (r: CrmRecord) => (cerrados || CERRADOS.includes(r.props.hs_pipeline_stage)) === excepciones.has(r.id),
    alternar: (id: number) => setExcepciones((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    todos: (abrir: boolean) => {
      setCerrados(!abrir); setExcepciones(new Set());
      try { localStorage.setItem(pref, abrir ? 'abiertos' : 'cerrados'); } catch { /* sin almacenamiento */ }
    },
  };
}

// La flecha del renglón del pedido (o su lugar, para que los nombres queden alineados).
export function FlechaPedido({ p, abierto, onToggle, nombre }: { p?: ProduccionPedido; abierto: boolean; onToggle: () => void; nombre: string }) {
  if (!p?.articulos.length) return <span className="ped-flecha" aria-hidden />;
  const n = p.articulos.length;
  return (
    <button type="button" className="btn ghost xs ped-flecha" onClick={onToggle} aria-expanded={abierto}
      aria-label={`${abierto ? 'Cerrar' : 'Ver'} los productos de ${nombre}`} title={`${abierto ? 'Cerrar' : 'Ver'} ${n === 1 ? 'el producto' : `los ${n} productos`}`}>
      <Flecha abierto={abierto} />
    </button>
  );
}

const ENTREGADO = '1237498998';
const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const LISTO = '1237498996';
const CERRADOS = [ENTREGADO, ANULADO];
const pactadaDe = (r: CrmRecord) => (r.props.fecha_de_entrega ? String(r.props.fecha_de_entrega).slice(0, 10) : null);
const listoEl = (a: ArticuloPedido) => a.etapa === LISTO || a.etapa === ENTREGADO;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

// La entrega que propuso Producción para el pedido: la más lejana entre la del PDV y la de sus productos que faltan
// (si un producto se corrió, el pedido no llega antes que él).
export function estimadaDe(p: ProduccionPedido) {
  return [p.entrega_real, ...p.articulos.filter((a) => !listoEl(a)).map((a) => a.entrega_real)].filter((x): x is string => !!x).sort().pop() ?? null;
}

// «+4 d» en ámbar: Producción corrió la entrega después de la pactada (hay que avisarle al cliente). El rojo queda para lo
// que ya pasó y no está listo.
function Corrida({ pactada, estimada }: { pactada: string | null; estimada: string | null }) {
  const n = pactada && estimada && estimada > pactada ? diasEntre(pactada, estimada) : 0;
  if (!n) return null;
  return <span className="ped-corrida" title={`Producción la propuso ${n} día${n === 1 ? '' : 's'} después de la pactada (${dia(pactada!)}): avisale al cliente`}>+{n} d</span>;
}

// La entrega del pedido, como se la dice al cliente: «Pactada vie 20/11 → mar 24/11 +4 d» si Producción propuso otra
// fecha; si no, la pactada («Pactada vie 20/11») o la de Producción («Entrega mar 24/11»). En rojo si ya pasó y no está listo.
export function Entrega({ r, p, soloSiCambia }: { r: CrmRecord; p?: ProduccionPedido; soloSiCambia?: boolean }) {
  if (CERRADOS.includes(r.props.hs_pipeline_stage)) return null;
  const pactada = pactadaDe(r);
  const estimada = p ? estimadaDe(p) : null;
  const vale = estimada ?? pactada;
  if (!vale) return null;
  const listo = !!p && p.total > 0 && p.listos >= p.total;
  const atrasada = vale < hoyIso() && !listo;
  const otra = !!estimada && !!pactada && estimada !== pactada;
  // En la tarjeta del tablero la pactada ya está arriba: acá solo si Producción propuso otra.
  if (soloSiCambia && pactada && !otra) return null;
  const title = [pactada && `Pactada con el cliente: ${dia(pactada)} (Finnegans)`, estimada && `Propuesta por Producción: ${dia(estimada)}`,
    atrasada && 'Ya pasó y no está listo'].filter(Boolean).join('. ');
  return (
    <span className={`ped-real${atrasada ? ' fecha-alerta' : ''}`} title={title}>
      {otra && soloSiCambia ? <>Nueva fecha {dia(estimada)}</> : otra ? <>Pactada {dia(pactada)} → {dia(estimada)}</> : estimada ? <>Entrega {dia(estimada)}</> : <>Pactada {dia(pactada)}</>}
      <Corrida pactada={pactada} estimada={estimada} />
    </span>
  );
}

// La fecha de un producto, solo si es otra que la del pedido (si no, repite lo mismo en cada renglón) y todavía no está listo.
function EntregaArticulo({ a, p, r }: { a: ArticuloPedido; p: ProduccionPedido; r: CrmRecord }) {
  if (!a.entrega_real || listoEl(a) || a.entrega_real === estimadaDe(p)) return null;
  const atrasada = a.entrega_real < hoyIso();
  return (
    <span className={`ped-real${atrasada ? ' fecha-alerta' : ''}`} title={`Este producto, para el ${dia(a.entrega_real)} (lo propuso Producción)${atrasada ? '. Ya pasó y no está listo' : ''}`}>
      {dia(a.entrega_real)}<Corrida pactada={pactadaDe(r)} estimada={a.entrega_real} />
    </span>
  );
}

// Lo que le toca a la vendedora antes de producción (las etapas que mueve ella). «Esperando boceto o confirmación» ya lo
// dice la etapa (y en qué producto, su estado).
const PENDIENTES: Record<string, { texto: string; title: string; tuyo: boolean }> = {
  '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03': { texto: 'Te toca: el anticipo', title: 'Falta que el cliente pague el anticipo. Cuando esté, pasalo a la etapa que sigue.', tuyo: true },
  'aa99e8d0-c1d5-4071-b915-d240bbb1aed9': { texto: 'Te toca: el boceto', title: 'Falta que el cliente apruebe el boceto digital. Cuando lo apruebe, pasalo a la etapa que sigue.', tuyo: true },
};
export function Pendiente({ r }: { r: CrmRecord }) {
  const x = PENDIENTES[String(r.props.hs_pipeline_stage ?? '')];
  if (!x) return null;
  return <span className={`ped-pendiente${x.tuyo ? ' tuyo' : ''}`} title={x.title}>{x.texto}</span>;
}

// Quién lo tiene en Producción (foto y nombre) y cuántos productos están listos. Sin asignar no se dice: la vendedora no
// puede hacer nada con eso.
// `soloFotos`: en el renglón del pedido, las fotos (los nombres al pasar el mouse), para que entren la entrega y el cobro.
function Quien({ asignados, listos, total, soloFotos }: { asignados: PersonaProduccion[]; listos?: number; total?: number; soloFotos?: boolean }) {
  if (!asignados.length && !total) return null;
  const nombres = asignados.map((p) => p.nombre).join(', ');
  return (
    <span className="prod-quien" title={[nombres && `Lo tiene en Producción: ${nombres}`, total && `${listos ?? 0} de ${total} productos listos`].filter(Boolean).join('. ')}>
      {asignados.length > 0 && <span className="avatar-stack">{asignados.slice(0, 3).map((p) => <PersonaProd key={p.id} p={p} size="xs" />)}</span>}
      {asignados.length > 0 && (!soloFotos || asignados.length === 1) && <span className="ellipsis">{asignados.map((p) => p.nombre.split(' ')[0]).join(', ')}</span>}
      {!!total && <span className={`prod-avance${(listos ?? 0) >= total ? ' ok' : ''}`}>{listos ?? 0}/{total} listos</span>}
    </span>
  );
}

// La columna «Producción» del pedido: lo que le toca, quién lo tiene, cuántos productos están listos y la entrega.
export function CeldaProduccion({ p, r }: { p?: ProduccionPedido; r: CrmRecord }) {
  const vacio = !p || (!p.total && !p.asignados.length);
  return (
    <td className="ped-prod">
      {vacio && !PENDIENTES[String(r.props.hs_pipeline_stage ?? '')] && !pactadaDe(r) ? <span className="muted">—</span>
        : <ResumenProduccion p={p} r={r} />}
    </td>
  );
}
// En la lista, quién lo tiene va en su propia columna («Responsable»); en la tarjeta del tablero, acá.
export function ResumenProduccion({ p, r, tarjeta }: { p?: ProduccionPedido; r: CrmRecord; tarjeta?: boolean }) {
  const cerrado = CERRADOS.includes(r.props.hs_pipeline_stage);
  return (
    <span className="ped-prod-in">
      <Pendiente r={r} />
      {p && !cerrado && (tarjeta ? <Quien asignados={p.asignados} listos={p.listos} total={p.total} soloFotos />
        : !!p.total && <span className={`prod-avance${p.listos >= p.total ? ' ok' : ''}`} title={`${p.listos} de ${p.total} productos listos`}>{p.listos}/{p.total} listos</span>)}
      <Entrega r={r} p={p} soloSiCambia={tarjeta} />
    </span>
  );
}
// La columna «Responsable» del pedido: quién lo tiene en Producción (el PDV y sus productos que faltan), con foto y nombre.
export function CeldaResponsable({ p, r }: { p?: ProduccionPedido; r: CrmRecord }) {
  const ver = !!p?.asignados.length && !CERRADOS.includes(r.props.hs_pipeline_stage);
  return <td className="ped-prod">{ver ? <Quien asignados={p!.asignados} /> : <span className="muted">—</span>}</td>;
}
// Si la tarjeta del tablero tiene algo de esto para mostrar.
export const hayResumen = (r: CrmRecord, p?: ProduccionPedido) => !CERRADOS.includes(r.props.hs_pipeline_stage)
  && (!!PENDIENTES[String(r.props.hs_pipeline_stage ?? '')] || !!p?.total || !!p?.asignados.length);

function EstadoArticulo({ a }: { a: ArticuloPedido }) {
  const { meta } = useMeta();
  if (!a.produccion) return null;
  if (!a.etapa) return <span className="ped-sin-arrancar" title="Producción todavía no lo empezó">Sin arrancar</span>;
  return <EtapaPedido value={a.etapa} label={formatValue(meta, 'order', 'hs_pipeline_stage', a.etapa)} />;
}

// Quién tiene el producto (columna «Responsable»).
function QuienArticulo({ a }: { a: ArticuloPedido }) {
  if (!a.produccion || a.etapa === ENTREGADO) return null;
  return <Quien asignados={a.asignados} />;
}

// Los productos del pedido, un renglón cada uno debajo del pedido, cada dato en su columna: el estado en «Etapa del
// pedido», la fecha en «Producción», quién lo tiene en «Responsable» y la OC en «OC» (con los productos abiertos, esas
// columnas se ven siempre: ObjectIndex.tsx). Un clic abre la vista previa del pedido.
export function FilasProductos({ p, r, columns, sel, onAbrir }: { p: ProduccionPedido; r: CrmRecord; columns: string[]; sel: boolean; onAbrir: () => void }) {
  const celda = (a: ArticuloPedido, col: string) => (col === 'hs_pipeline_stage' ? <span className="ped-prod-in"><EstadoArticulo a={a} /><Entregado a={a} /></span>
    : col === '__produccion' ? <EntregaArticulo a={a} p={p} r={r} />
    : col === '__responsable' ? <QuienArticulo a={a} />
    : col === '__oc' ? <OcLinks ocs={a.oc} /> : null);
  return (
    <>
      {p.articulos.map((a, i) => (
        <tr key={a.id} className={`ped-art${i === p.articulos.length - 1 ? ' ultimo' : ''}${a.etapa === ENTREGADO ? ' entregado' : ''}${sel ? ' sel' : ''}`}
          onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) onAbrir(); }}>
          <td className="check" />
          <td className="name">
            <span className="ped-art-t">
              <FotoProducto url={a.foto} nombre={a.nombre} />
              <span className="ped-art-n ellipsis" title={a.nombre}>{a.nombre}</span>
              {a.cantidad != null && <span className="muted small num ped-cant">{a.cantidad.toLocaleString('es-AR')} u.</span>}
            </span>
          </td>
          {columns.map((col) => <td key={col} className={['__produccion', '__responsable', '__oc'].includes(col) ? 'ped-prod' : undefined}>{celda(a, col)}</td>)}
        </tr>
      ))}
    </>
  );
}

// ---------- Tablero: los productos adentro de la tarjeta del pedido, como en el tablero de Producción ----------

// Con «Expandir productos», cada tarjeta muestra sus productos como hijos (foto, nombre, cantidad, estado y quién lo tiene),
// hasta 4 y «+ N productos más»; colapsada, solo «N productos» para abrirla. Cada tarjeta se abre o se cierra aparte.
const MAX_HIJOS = 4;
export function ProductosTarjeta({ p, r, abierto, onToggle }: { p?: ProduccionPedido; r: CrmRecord; abierto: boolean; onToggle: () => void }) {
  const [todos, setTodos] = useState(false);
  if (!p?.articulos.length) return null;
  const n = p.articulos.length;
  const arts = todos ? p.articulos : p.articulos.slice(0, MAX_HIJOS);
  const resto = n - arts.length;
  const parar = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className={`ped-card-prods${abierto ? ' abierto' : ''}`}>
      <button type="button" className="ped-card-toggle" onClick={(e) => { parar(e); onToggle(); }} aria-expanded={abierto}
        title={abierto ? 'Ocultar los productos' : 'Ver los productos con su estado'}>
        <Flecha abierto={abierto} />{n === 1 ? '1 producto' : `${n} productos`}
      </button>
      {abierto && (
        <div className="prod-hijos ped-hijos">
          {arts.map((a) => (
            <div key={a.id} className={`prod-hijo${a.etapa === ENTREGADO ? ' cerrado' : ''}`}>
              <div className="row" style={{ gap: 8, minWidth: 0, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <FotoProducto url={a.foto} nombre={a.nombre} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="prod-hijo-t" title={a.nombre}>{a.nombre}</div>
                  <div className="small muted ped-hijo-sub">
                    {a.cantidad != null && <span className="num">{a.cantidad.toLocaleString('es-AR')} u.</span>}
                    <Entregado a={a} />
                    <EntregaArticulo a={a} p={p} r={r} />
                    <OcLinks ocs={a.oc} />
                  </div>
                </div>
              </div>
              {a.produccion && (
                <div className="row prod-hijo-pie">
                  <EstadoArticulo a={a} />
                  {a.etapa !== ENTREGADO && <QuienCorto a={a} />}
                </div>
              )}
            </div>
          ))}
          {n > MAX_HIJOS && (
            <button type="button" className="btn ghost xs prod-mas" onClick={(e) => { parar(e); setTodos(!todos); }}>
              {todos ? 'Ver menos' : `+ ${resto} producto${resto === 1 ? '' : 's'} más`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function QuienCorto({ a }: { a: ArticuloPedido }) {
  if (!a.asignados.length) return null;
  const nombres = a.asignados.map((p) => p.nombre).join(', ');
  return (
    <span className="prod-quien" title={`Lo tiene en Producción: ${nombres}`}>
      <span className="avatar-stack">{a.asignados.slice(0, 2).map((p) => <PersonaProd key={p.id} p={p} size="xs" />)}</span>
      <span className="ellipsis">{a.asignados.length === 1 ? a.asignados[0].nombre.split(' ')[0] : `${a.asignados.length}`}</span>
    </span>
  );
}
