import { useState } from 'react';
import { http, useAsync, useMeta, formatValue, type CrmRecord } from '../lib';
import { EtapaPedido, PersonaProd, QuienProduce, type PersonaProduccion } from '../components';
import { Corrida, dia, Flecha, FotoProducto, hoyIso } from './Produccion';

// Producción en la lista de Pedidos (pedido de Rodrigo del 17/11/2026): lo que ven las vendedoras, como la pantalla
// Producción pero simplificado. Cada pedido con sus productos abajo (se abren y se cierran, uno o todos), cada producto
// con su foto, su estado en palabras de la vendedora (la etapa del pedido: esperando boceto, en producción, listo para
// entregar, entregado), quién lo tiene en Producción y la fecha real que propuso Producción. En el renglón del pedido, la
// columna «Producción»: quién lo tiene, cuántos productos están listos y la fecha real. Lo arma pedidosprod.ts.

export interface ArticuloPedido {
  id: string; nombre: string; cantidad: number | null; foto: string | null; etapa: string | null; produccion: boolean;
  asignados: PersonaProduccion[]; entrega_real: string | null;
}
export interface ProduccionPedido { asignados: PersonaProduccion[]; listos: number; total: number; entrega_real: string | null; articulos: ArticuloPedido[] }

const VACIO = { pedidos: {} as Record<number, ProduccionPedido> };
// Los productos de los pedidos de la página (una consulta). `version`: cambia cuando se recarga la lista.
export function useProduccionPedidos(ids: number[], activo: boolean, version: unknown) {
  const key = ids.join(',');
  const r = useAsync(() => (activo && ids.length ? http<typeof VACIO>('GET', `/pedidos/articulos?ids=${key}`) : Promise.resolve(VACIO)), [key, activo, version]);
  return r.data?.pedidos ?? VACIO.pedidos;
}

// Abiertos o cerrados: todos (queda en este navegador; por defecto, abiertos) y cada pedido aparte mientras se está en la
// pantalla, como en Producción.
const PREF = 'crm.pedidos.productos';
export function useProductosAbiertos() {
  const [cerrados, setCerrados] = useState(() => { try { return localStorage.getItem(PREF) === 'cerrados'; } catch { return false; } });
  const [excepciones, setExcepciones] = useState<Set<number>>(new Set());
  return {
    cerrados,
    abierto: (id: number) => cerrados === excepciones.has(id),
    alternar: (id: number) => setExcepciones((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    todos: (abrir: boolean) => {
      setCerrados(!abrir); setExcepciones(new Set());
      try { localStorage.setItem(PREF, abrir ? 'abiertos' : 'cerrados'); } catch { /* sin almacenamiento */ }
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
const LISTO = '1237498996';
const pactadaDe = (r: CrmRecord) => (r.props.fecha_de_entrega ? String(r.props.fecha_de_entrega).slice(0, 10) : null);

// La fecha real que propuso Producción, con cuántos días se corrió de la pactada. En rojo si ya pasó y no está listo.
function Real({ real, pactada, listo }: { real: string | null; pactada: string | null; listo: boolean }) {
  if (!real) return null;
  const atrasada = real < hoyIso() && !listo;
  return (
    <span className={`ped-real${atrasada ? ' fecha-alerta' : ''}`} title={`Entrega real: la fecha que propuso Producción${atrasada ? '. Ya pasó y no está listo' : ''}`}>
      Real {dia(real)}<Corrida pactada={pactada} real={real} />
    </span>
  );
}

// La columna «Producción» del pedido: quién lo tiene (foto y nombre), cuántos productos están listos y la fecha real
// (la del PDV o, si no tiene, la más lejana de sus productos abiertos).
export function CeldaProduccion({ p, r }: { p?: ProduccionPedido; r: CrmRecord }) {
  if (!p || (!p.total && !p.asignados.length)) return <td className="ped-prod"><span className="muted">—</span></td>;
  const abiertos = p.articulos.filter((a) => a.etapa !== ENTREGADO);
  const real = p.entrega_real ?? abiertos.map((a) => a.entrega_real).filter((x): x is string => !!x).sort().pop() ?? null;
  return (
    <td className="ped-prod">
      <span className="ped-prod-in">
        <QuienProduce asignados={p.asignados} listos={p.listos} total={p.total} />
        <Real real={real} pactada={pactadaDe(r)} listo={p.total > 0 && p.listos >= p.total} />
      </span>
    </td>
  );
}

function EstadoArticulo({ a }: { a: ArticuloPedido }) {
  const { meta } = useMeta();
  if (!a.produccion) return null;
  if (!a.etapa) return <span className="muted small" title="Producción todavía no lo arrancó">Sin arrancar</span>;
  return <EtapaPedido value={a.etapa} label={formatValue(meta, 'order', 'hs_pipeline_stage', a.etapa)} />;
}

function QuienArticulo({ a, r }: { a: ArticuloPedido; r: CrmRecord }) {
  if (!a.produccion) return null;
  const listo = a.etapa === LISTO || a.etapa === ENTREGADO;
  const nombres = a.asignados.map((p) => p.nombre).join(', ');
  return (
    <span className="ped-prod-in">
      <span className="prod-quien" title={nombres ? `En producción: ${nombres}` : 'Sin asignar en producción'}>
        {a.asignados.length > 0 && <span className="avatar-stack">{a.asignados.slice(0, 3).map((p) => <PersonaProd key={p.id} p={p} size="xs" />)}</span>}
        <span className={a.asignados.length ? 'ellipsis' : 'muted'}>{a.asignados.length ? a.asignados.map((p) => p.nombre.split(' ')[0]).join(', ') : 'Sin asignar'}</span>
      </span>
      <Real real={a.entrega_real} pactada={pactadaDe(r)} listo={listo} />
    </span>
  );
}

// Los productos del pedido, un renglón cada uno debajo del pedido. El estado va en la columna de la etapa y quién lo tiene
// en la de Producción; si alguna de las dos no está en la tabla, van al lado del nombre. Un clic abre la vista previa.
export function FilasProductos({ p, r, columns, sel, onAbrir }: { p: ProduccionPedido; r: CrmRecord; columns: string[]; sel: boolean; onAbrir: () => void }) {
  const conEtapa = columns.includes('hs_pipeline_stage');
  const conProd = columns.includes('__produccion');
  return (
    <>
      {p.articulos.map((a, i) => (
        <tr key={a.id} className={`ped-art${i === p.articulos.length - 1 ? ' ultimo' : ''}${a.etapa === ENTREGADO ? ' entregado' : ''}${sel ? ' sel' : ''}`}
          onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) onAbrir(); }} title={`Ver el pedido ${r.name}`}>
          <td className="check" />
          <td className="name">
            <span className="ped-art-t">
              <FotoProducto url={a.foto} nombre={a.nombre} />
              <span className="ped-art-n ellipsis" title={a.nombre}>{a.nombre}</span>
              {a.cantidad != null && <span className="muted small num ped-cant">{a.cantidad.toLocaleString('es-AR')} u.</span>}
              {!conEtapa && <EstadoArticulo a={a} />}
              {!conProd && <QuienArticulo a={a} r={r} />}
            </span>
          </td>
          {columns.map((col) => (
            <td key={col} className={col === '__produccion' ? 'ped-prod' : undefined}>
              {col === 'hs_pipeline_stage' ? <EstadoArticulo a={a} /> : col === '__produccion' ? <QuienArticulo a={a} r={r} /> : null}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
