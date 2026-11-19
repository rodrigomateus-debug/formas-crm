// Estados de despacho del cronograma (pedido de Logística, Rodrigo del 19/11/2026; docs/CRONOGRAMA.md). El servidor manda,
// en cada movimiento, sus controles y un estado base (cronograma.ts, despachoDe); acá se juntan los de una tarjeta (los
// artículos de un PDV con el mismo movimiento, día y lugar) y se suma la dirección de la parada, que llega aparte.
// Si varios aplican, gana el que traba la entrega.

export type EstadoDespacho = 'hecho' | 'nopago' | 'info' | 'nollego' | 'cola' | 'remitido' | 'listo' | 'prog';
export type Rol = 'produccion' | 'ventas' | 'proveedor' | 'logistica';
export interface ControlMov { k: 'prod' | 'dep' | 'pago' | 'remito'; v: 'ok' | 'no' | 'pend'; t?: string }
export interface DespachoMov {
  estado: Exclude<EstadoDespacho, 'info'>; checks: ControlMov[]; quien: Rol | null; owner_id: number | null; lugar: string | null;
}
export interface Control { k: ControlMov['k'] | 'dir'; nombre: string; v: 'ok' | 'no' | 'medio' | 'pend'; t?: string }
export interface DespachoTarjeta { estado: EstadoDespacho; checks: Control[]; quien: Rol | null; owner_id: number | null; lugar: string | null }

type TipoMov = 'entrega' | 'ingreso' | 'retiro_proveedor' | 'egreso' | 'retiro_impresor' | 'ingreso_impresor';
const PRIORIDAD: EstadoDespacho[] = ['nopago', 'info', 'nollego', 'cola', 'remitido', 'listo', 'prog', 'hecho'];
const QUIEN: Record<EstadoDespacho, Rol | null> = { hecho: null, nopago: 'ventas', info: 'ventas', nollego: 'proveedor', cola: 'produccion', remitido: 'logistica', listo: 'logistica', prog: 'proveedor' };

export const NOMBRE_ROL: Record<Rol, string> = { produccion: 'Producción', ventas: 'Ventas', proveedor: 'Proveedor', logistica: 'Logística' };

// Cómo se llama cada estado según el movimiento: un ingreso «llegó», un retiro «está para retirar».
export function nombreEstado(e: EstadoDespacho, tipo: TipoMov): string {
  const entrega = tipo === 'entrega', egreso = tipo === 'egreso', ingreso = tipo === 'ingreso' || tipo === 'ingreso_impresor';
  switch (e) {
    case 'hecho': return entrega ? 'Entregado' : ingreso ? 'Llegó' : egreso ? 'Llevado' : 'Retirado';
    case 'nopago': return 'No pagó';
    case 'info': return 'Falta información';
    case 'nollego': return tipo === 'ingreso_impresor' || tipo === 'retiro_impresor' ? 'No volvió del impresor' : 'No llegó';
    case 'cola': return egreso ? 'Esperando la mercadería' : 'En cola de producción';
    case 'remitido': return egreso ? 'Remito de traslado hecho' : 'Remitido';
    case 'listo': return entrega ? 'Listo para despachar' : egreso ? 'Listo para llevar' : 'Para retirar';
    case 'prog': return 'Programado';
  }
}
export const ICONO_ESTADO: Record<EstadoDespacho, string> = {
  hecho: 'check', nopago: 'deal', info: 'alert', nollego: 'bag', cola: 'timer', remitido: 'receipt', listo: 'truck', prog: 'calendar',
};
const NOMBRE_CONTROL: Record<Control['k'], string> = {
  prod: 'Producción completa', dep: 'Mercadería en el depósito', pago: 'Pago', dir: 'Dirección', remito: 'Remito',
};

// La dirección de la parada: falta o no se encontró en el mapa → «Falta información». Mientras se busca, no cuenta.
export type EstadoDir = 'ok' | 'no_encontrada' | 'buscando' | 'sin_direccion';

export function despachoTarjeta(t: { tipo: TipoMov; hecho: boolean; parada: boolean; movs: Array<{ despacho?: DespachoMov }> }, dir?: { estado: EstadoDir } | null): DespachoTarjeta | null {
  const ds = t.movs.map((m) => m.despacho).filter((d): d is DespachoMov => !!d);
  if (!ds.length) return null;
  if (t.hecho) return { estado: 'hecho', checks: [], quien: null, owner_id: ds[0].owner_id, lugar: null };
  // Los controles de todos los artículos: todos bien, todos mal o algunos (la producción de un pedido con 2 de 3 listos).
  const orden: ControlMov['k'][] = [];
  for (const d of ds) for (const c of d.checks) if (!orden.includes(c.k)) orden.push(c.k);
  const checks: Control[] = orden.map((k) => {
    const cs = ds.flatMap((d) => d.checks.filter((c) => c.k === k));
    const ok = cs.filter((c) => c.v === 'ok').length, no = cs.filter((c) => c.v === 'no').length;
    const v: Control['v'] = ok === cs.length ? 'ok' : no === cs.length ? 'no' : k === 'prod' && ok ? 'medio' : no ? 'no' : 'pend';
    const t = k === 'prod' && v !== 'ok' ? `${ok} de ${cs.length} listos`
      : [...new Set(cs.filter((c) => c.v !== 'ok' && c.t).map((c) => c.t!))].join(' · ') || cs.find((c) => c.t)?.t;
    return { k, nombre: NOMBRE_CONTROL[k], v, t };
  });
  let estado = PRIORIDAD.find((e) => ds.some((d) => d.estado === e && e !== 'hecho')) ?? 'listo';
  // La dirección de la parada (entregas, retiros y egresos): en el lugar de la entrega, antes del remito.
  if (t.parada && dir && dir.estado !== 'buscando') {
    const ok = dir.estado === 'ok';
    const c: Control = { k: 'dir', nombre: NOMBRE_CONTROL.dir, v: ok ? 'ok' : 'no', t: ok ? undefined : dir.estado === 'sin_direccion' ? 'No tiene dirección' : 'No se encontró en el mapa' };
    const i = checks.findIndex((x) => x.k === 'remito');
    checks.splice(i < 0 ? checks.length : i, 0, c);
    if (!ok && ['nollego', 'cola', 'remitido', 'listo'].includes(estado)) estado = 'info';
  }
  const d0 = ds.find((d) => d.estado === estado) ?? ds[0];
  // Sin dirección en un retiro o un egreso es la del proveedor o el impresor: la corrige Logística, no la vendedora.
  return { estado, checks, quien: estado === 'info' && t.tipo !== 'entrega' ? 'logistica' : QUIEN[estado], owner_id: d0.owner_id, lugar: estado === 'nollego' || estado === 'prog' ? d0.lugar : null };
}

// Lo que falta, en pocas palabras, para la tarjeta.
export function faltaTexto(d: DespachoTarjeta): string {
  const no = d.checks.filter((c) => c.v === 'no' || c.v === 'medio');
  if (no.length) return `Falta: ${no.map((c) => c.nombre.toLowerCase()).join(', ')}`;
  if (!d.checks.length) return '';
  return d.checks.every((c) => c.v === 'ok') ? 'Todo listo' : `Falta: ${d.checks.filter((c) => c.v === 'pend').map((c) => c.nombre.toLowerCase()).join(', ')}`;
}
