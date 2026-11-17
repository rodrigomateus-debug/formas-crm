import { generalStage, STAGE } from './clickup';
import { CERRADOS, lista } from './produccion';
import { fotosDeArticulos, fotosDeRenglones, fotosSql, type StpItem } from './productos';
import { TIPO_SQL, tareasServicio } from './servicios';

// Producción en la lista de Pedidos (pedido de Rodrigo del 17/11/2026): lo que ven las vendedoras, como la pantalla
// Producción pero simplificado. Cada pedido con sus productos abajo (se abren y se cierran), cada uno con su foto, su
// estado en palabras de la vendedora (la misma etapa del pedido: esperando boceto, en producción, listo para entregar,
// entregado), quién lo tiene en Producción y la fecha real que propuso Producción. Del PDV, quién lo tiene, cuántos
// productos están listos y su fecha real. Sale de la tabla `produccion` (ClickUp, produccion.ts), sin consultas a ClickUp.
//
// Un pedido sin PDV en ClickUp muestra sus productos (los renglones del pedido, sin servicios) sin estado.

export interface PersonaPedido { id: number; nombre: string; user_id: number | null; foto: string | null }
export interface ArticuloPedido {
  id: string; nombre: string; cantidad: number | null; foto: string | null;
  etapa: string | null;        // la etapa del pedido que le corresponde a ese producto solo (generalStage); null = sin arrancar
  produccion: boolean;         // si viene de Producción (ClickUp) o es un renglón del pedido sin PDV
  asignados: PersonaPedido[]; entrega_real: string | null;
}
export interface ProduccionPedido {
  asignados: PersonaPedido[]; listos: number; total: number; entrega_real: string | null; articulos: ArticuloPedido[];
}

const ANULADOS = CERRADOS.slice(1);
const LISTOS = ['listo para entergar', 'listo para entregar', 'entregados'];

type Fila = { task_id: string; pdv_task: string; es_pdv: number; nombre: string; estado: string; cantidad: number | null; asignados: string;
  entrega_real: string | null; orden: number; record_id: number | null };

export async function produccionDePedidos(db: D1Database, ids: number[]): Promise<Record<number, ProduccionPedido>> {
  const out: Record<number, ProduccionPedido> = {};
  if (!ids.length) return out;
  const lista_ids = JSON.stringify(ids);
  // Los PDV de estos pedidos y sus artículos (el artículo puede no tener el pedido: vale el de su PDV).
  const pdvs = (await db.prepare(`SELECT task_id, pdv_task, es_pdv, nombre, estado, cantidad, asignados, entrega_real, orden, record_id FROM produccion
      WHERE es_pdv = 1 AND record_id IN (SELECT value FROM json_each(?))`).bind(lista_ids).all<Fila>()).results;
  const arts = pdvs.length ? (await db.prepare(`SELECT task_id, pdv_task, es_pdv, nombre, estado, cantidad, asignados, entrega_real, orden, record_id FROM produccion
      WHERE es_pdv = 0 AND pdv_task IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pdvs.map((p) => p.task_id))).all<Fila>()).results : [];
  const pedidoDe = new Map(pdvs.map((p) => [p.task_id, p.record_id!]));
  const conPedido = arts.map((a) => ({ ...a, record_id: pedidoDe.get(a.pdv_task) ?? a.record_id }));
  const [fotos, servicios] = await Promise.all([fotosDeArticulos(db, conPedido), tareasServicio(db, ids)]);

  // La gente de ClickUp que aparece, con su usuario del CRM (foto y nombre).
  const gente = [...new Set([...pdvs, ...arts].flatMap((f) => lista(f.asignados).map(Number)))];
  const personas = gente.length ? (await db.prepare(`SELECT cp.clickup_id AS id, COALESCE(u.name, cp.nombre) AS nombre, cp.user_id, COALESCE(u.photo_url, cp.foto) AS foto
      FROM clickup_personas cp LEFT JOIN users u ON u.id = cp.user_id WHERE cp.clickup_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(gente)).all<PersonaPedido>()).results : [];
  const de = (s: string) => lista(s).map((x) => personas.find((p) => p.id === Number(x))).filter((p): p is PersonaPedido => !!p);

  for (const pdv of pdvs) {
    const rid = pdv.record_id!;
    // Sin servicios (envío, setup, un adicional: no se producen) ni anulados.
    const suyos = conPedido.filter((a) => a.pdv_task === pdv.task_id && !servicios.has(a.task_id) && !ANULADOS.includes(a.estado))
      .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));
    const todos = new Map<number, PersonaPedido>();
    for (const p of de(pdv.asignados)) todos.set(p.id, p);
    for (const a of suyos) if (!CERRADOS.includes(a.estado)) for (const p of de(a.asignados)) todos.set(p.id, p);
    const previo = out[rid];   // un pedido con más de un PDV (raro): se suman
    out[rid] = {
      asignados: [...new Map([...(previo?.asignados ?? []), ...todos.values()].map((p) => [p.id, p])).values()],
      listos: (previo?.listos ?? 0) + suyos.filter((a) => LISTOS.includes(a.estado)).length,
      total: (previo?.total ?? 0) + suyos.length,
      entrega_real: [previo?.entrega_real, pdv.entrega_real].filter((x): x is string => !!x).sort().pop() ?? null,
      articulos: [...(previo?.articulos ?? []), ...suyos.map((a) => ({
        id: a.task_id, nombre: a.nombre, cantidad: a.cantidad, foto: fotos.get(a.task_id) ?? null, etapa: etapaArticulo(a.estado), produccion: true,
        asignados: de(a.asignados), entrega_real: a.entrega_real,
      }))],
    };
  }

  // Los pedidos sin PDV: sus productos (los renglones del pedido, sin servicios), con su foto, sin estado ni asignados.
  const sinPdv = ids.filter((id) => !out[id]);
  if (sinPdv.length) {
    const lista2 = JSON.stringify(sinPdv);
    const [, filasFoto] = fotosSql(db, 'SELECT value FROM json_each(?)', [lista2]);
    const [fotosRes, tipos] = await db.batch([
      filasFoto,
      db.prepare(`SELECT li.record_id, li.position AS pos, ${TIPO_SQL()} AS tipo FROM line_items li LEFT JOIN products p ON p.code = li.code
        WHERE li.record_id IN (SELECT value FROM json_each(?))`).bind(lista2),
    ]);
    type FilaFoto = { k: 'li' | 'it' | 'so'; record_id: number; pos: number; code: string | null; description: string | null; quantity: number | null;
      li_name: string | null; name: string | null; foto_cot: string | null; foto_fin: string | null; foto_sku: string | null; cantidades: string | null };
    const servicio = new Set((tipos.results as Array<{ record_id: number; pos: number; tipo: string }>).filter((t) => t.tipo === 'servicio').map((t) => `${t.record_id}:${t.pos}`));
    const porPedido = new Map<number, FilaFoto[]>();
    for (const f of fotosRes.results as FilaFoto[]) { const l = porPedido.get(f.record_id) ?? []; l.push(f); porPedido.set(f.record_id, l); }
    for (const [rid, fs] of porPedido) {
      const lineas = fs.filter((f) => f.k === 'li');
      if (!lineas.length) continue;
      const items: StpItem[] = fs.filter((f) => f.k === 'it').map((f) => ({ sku: f.code ?? '', nombre: f.name ?? '', cantidades: f.cantidades ?? '[]', image_url: f.foto_cot ?? '' }));
      const { fotos: fl } = fotosDeRenglones(lineas, items);
      const articulos = lineas.map((l, i) => ({ l, foto: fl[i] })).filter(({ l }) => !servicio.has(`${rid}:${l.pos}`)).map(({ l, foto }) => ({
        id: `li-${l.pos}`, nombre: (l.name ?? l.li_name ?? l.description ?? l.code ?? 'Producto').trim(), cantidad: l.quantity, foto: foto ?? null,
        etapa: null, produccion: false, asignados: [], entrega_real: null,
      }));
      if (articulos.length) out[rid] = { asignados: [], listos: 0, total: 0, entrega_real: null, articulos };
    }
  }
  return out;
}

// El estado de un producto en palabras de la vendedora: la etapa del pedido que tendría si fuera el único producto
// (Esperando boceto o confirmación, En producción, Listo para entregar, Entregado parcial, Entregado). null: Producción
// todavía no lo arrancó (ingreso de pedido, pdv, personales).
export function etapaArticulo(estado: string) {
  const e = estado.toLowerCase().trim();
  if (ANULADOS.includes(e)) return STAGE.anulado;
  return generalStage([e]);
}
