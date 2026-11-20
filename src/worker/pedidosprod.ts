import { generalStage, STAGE } from './clickup';
import { CERRADOS, contarProductos, lista } from './produccion';
import { compararTalles, nombreSinTalle, talleCanonico } from './talles';
import { fotosDeArticulos, fotosDeRenglones, fotosSql, type StpItem } from './productos';
import { TIPO_SQL, tareasServicio } from './servicios';
import { calcularEntrega } from './remitos';
import { ocsDeCodigo, ocsDePedidos, sinCodigos, type OcRef } from './ordenescompra';
import { skusDeArticulos } from './notasproducto';
import { adjuntosSql, armarAdjuntos, type Adjuntos } from './productos';

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
  // Lo entregado según los remitos (remitos.ts), solo en los pedidos con entregas parciales: cuánto de lo vendido.
  entregado?: number; vendido?: number | null;
  oc: OcRef[];   // sus órdenes de compra de Finnegans (ordenescompra.ts)
  // Una prenda en varios talles (talles.ts) es un solo producto: sus talles con la cantidad de cada uno, en orden.
  talles?: Array<{ talle: string; cantidad: number | null }>;
}
// Mientras se arma: el talle y el grupo de cada artículo, y su estado de ClickUp (no salen así: juntarTalles).
type ArticuloArmado = ArticuloPedido & { _talle?: string | null; _grupo?: string | null; _estado?: string };
export interface ProduccionPedido {
  asignados: PersonaPedido[]; listos: number; total: number; entrega_real: string | null; articulos: ArticuloPedido[];
  ocs: OcRef[];   // todas las del pedido (también las que no se pudieron atar a un producto)
}

const ANULADOS = CERRADOS.slice(1);
const LISTOS = ['listo para entergar', 'listo para entregar', 'entregados'];

type Fila = { task_id: string; pdv_task: string; es_pdv: number; nombre: string; estado: string; cantidad: number | null; asignados: string;
  entrega_real: string | null; orden: number; record_id: number | null; codigo: string | null; talle: string | null; grupo_talle: string | null };

export async function produccionDePedidos(db: D1Database, ids: number[]): Promise<Record<number, ProduccionPedido>> {
  const out: Record<number, ProduccionPedido> = {};
  if (!ids.length) return out;
  const lista_ids = JSON.stringify(ids);
  // Los PDV de estos pedidos y sus artículos (el artículo puede no tener el pedido: vale el de su PDV).
  const pdvs = (await db.prepare(`SELECT task_id, pdv_task, es_pdv, nombre, estado, cantidad, asignados, entrega_real, orden, record_id, codigo, talle, grupo_talle FROM produccion
      WHERE es_pdv = 1 AND record_id IN (SELECT value FROM json_each(?))`).bind(lista_ids).all<Fila>()).results;
  const arts = pdvs.length ? (await db.prepare(`SELECT task_id, pdv_task, es_pdv, nombre, estado, cantidad, asignados, entrega_real, orden, record_id, codigo, talle, grupo_talle FROM produccion
      WHERE es_pdv = 0 AND pdv_task IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pdvs.map((p) => p.task_id))).all<Fila>()).results : [];
  const pedidoDe = new Map(pdvs.map((p) => [p.task_id, p.record_id!]));
  const conPedido = arts.map((a) => ({ ...a, record_id: pedidoDe.get(a.pdv_task) ?? a.record_id }));
  const [fotos, servicios, nombres, skus, ocs] = await Promise.all([fotosDeArticulos(db, conPedido), tareasServicio(db, ids), nombresDeVenta(db, arts.map((a) => a.task_id)),
    skusDeArticulos(db, arts), ocsDePedidos(db, ids)]);

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
    const cuenta = contarProductos(suyos);   // una prenda con talles cuenta una vez
    out[rid] = {
      asignados: [...new Map([...(previo?.asignados ?? []), ...todos.values()].map((p) => [p.id, p])).values()],
      listos: (previo?.listos ?? 0) + cuenta.listos,
      total: (previo?.total ?? 0) + cuenta.total,
      ocs: sinCodigos(ocs.get(rid)),
      entrega_real: [previo?.entrega_real, pdv.entrega_real].filter((x): x is string => !!x).sort().pop() ?? null,
      articulos: [...(previo?.articulos ?? []), ...suyos.map((a): ArticuloArmado => ({
        id: a.task_id, nombre: nombres.get(a.task_id) ?? a.nombre, cantidad: a.cantidad, foto: fotos.get(a.task_id) ?? null, etapa: etapaArticulo(a.estado), produccion: true,
        asignados: de(a.asignados), entrega_real: a.entrega_real, oc: ocsDeCodigo(ocs.get(rid), skus.get(a.task_id)),
        _talle: a.talle, _grupo: a.grupo_talle ? `${a.pdv_task}|${a.grupo_talle}` : null, _estado: a.estado,
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
      db.prepare(`SELECT li.record_id, li.position AS pos, ${TIPO_SQL()} AS tipo, li.talle, li.grupo_talle FROM line_items li LEFT JOIN products p ON p.code = li.code
        WHERE li.record_id IN (SELECT value FROM json_each(?))`).bind(lista2),
    ]);
    type FilaFoto = { k: 'li' | 'it' | 'so'; record_id: number; pos: number; code: string | null; description: string | null; quantity: number | null;
      li_name: string | null; name: string | null; foto_cot: string | null; foto_fin: string | null; foto_sku: string | null; cantidades: string | null };
    const filasTipo = tipos.results as Array<{ record_id: number; pos: number; tipo: string; talle: string | null; grupo_talle: string | null }>;
    const servicio = new Set(filasTipo.filter((t) => t.tipo === 'servicio').map((t) => `${t.record_id}:${t.pos}`));
    const talleDe = new Map(filasTipo.map((t) => [`${t.record_id}:${t.pos}`, t]));
    const porPedido = new Map<number, FilaFoto[]>();
    for (const f of fotosRes.results as FilaFoto[]) { const l = porPedido.get(f.record_id) ?? []; l.push(f); porPedido.set(f.record_id, l); }
    for (const [rid, fs] of porPedido) {
      const lineas = fs.filter((f) => f.k === 'li');
      if (!lineas.length) continue;
      const items: StpItem[] = fs.filter((f) => f.k === 'it').map((f) => ({ sku: f.code ?? '', nombre: f.name ?? '', cantidades: f.cantidades ?? '[]', image_url: f.foto_cot ?? '' }));
      const { fotos: fl } = fotosDeRenglones(lineas, items);
      const articulos = lineas.map((l, i) => ({ l, foto: fl[i] })).filter(({ l }) => !servicio.has(`${rid}:${l.pos}`)).map(({ l, foto }): ArticuloArmado => ({
        id: `li-${l.pos}`, nombre: (l.name ?? l.li_name ?? l.description ?? l.code ?? 'Producto').trim(), cantidad: l.quantity, foto: foto ?? null,
        etapa: null, produccion: false, asignados: [], entrega_real: null, oc: ocsDeCodigo(ocs.get(rid), l.code),
        _talle: talleDe.get(`${rid}:${l.pos}`)?.talle ?? null, _grupo: talleDe.get(`${rid}:${l.pos}`)?.grupo_talle ?? null,
      }));
      if (articulos.length) out[rid] = { asignados: [], listos: 0, total: 0, entrega_real: null, articulos, ocs: sinCodigos(ocs.get(rid)) };
    }
  }
  await entregasParciales(db, ids, out);
  for (const p of Object.values(out)) p.articulos = juntarTalles(p.articulos as ArticuloArmado[]);
  return out;
}

// Una prenda en varios talles es un producto (talles.ts): un renglón con el nombre sin el talle, la cantidad de todos, el
// desglose de talles y el estado de todos (si están en etapas distintas, la del producto entero: la misma regla que el
// pedido). Va donde estaba su primer talle.
function juntarTalles(arts: ArticuloArmado[]): ArticuloPedido[] {
  const limpio = ({ _talle, _grupo, _estado, ...a }: ArticuloArmado): ArticuloPedido => a;
  const out: ArticuloPedido[] = [];
  const hechos = new Set<string>();
  for (const a of arts) {
    if (!a._grupo) { out.push(limpio(a)); continue; }
    if (hechos.has(a._grupo)) continue;
    hechos.add(a._grupo);
    const ts = arts.filter((x) => x._grupo === a._grupo).sort((x, y) => compararTalles(talleCanonico(x._talle), talleCanonico(y._talle)));
    const suma = (k: 'cantidad' | 'entregado' | 'vendido') => (ts.some((x) => x[k] != null) ? ts.reduce((n, x) => n + (x[k] ?? 0), 0) : undefined);
    const etapas = [...new Set(ts.map((x) => x.etapa))];
    const pendientes = ts.filter((x) => x.etapa !== STAGE.listo_entregar && x.etapa !== STAGE.entregado);
    out.push({
      id: `g:${a._grupo}`, nombre: nombreSinTalle(ts[0].nombre), cantidad: suma('cantidad') ?? null, foto: ts.find((x) => x.foto)?.foto ?? null,
      etapa: etapas.length === 1 ? etapas[0] : ts.every((x) => x._estado) ? generalStage(ts.map((x) => x._estado!)) : null,
      produccion: ts.some((x) => x.produccion),
      asignados: [...new Map(ts.flatMap((x) => x.asignados).map((p) => [p.id, p])).values()],
      entrega_real: pendientes.map((x) => x.entrega_real).filter((x): x is string => !!x).sort().pop() ?? null,
      oc: [...new Map(ts.flatMap((x) => x.oc).map((o) => [o.nombre ?? o.numero, o])).values()],
      talles: ts.map((x) => ({ talle: x._talle ?? '', cantidad: x.cantidad })),
      ...(suma('entregado') !== undefined ? { entregado: suma('entregado'), vendido: suma('vendido') ?? null } : {}),
    });
  }
  return out;
}

// Lo entregado de cada producto según los remitos («80 de 150 entregadas»), para que la vendedora sepa qué falta llevar.
// Solo en los pedidos con entregas a medias (Entregado parcial, o los remitos dicen que falta algo o hay diferencias):
// en los demás, el estado del producto ya lo dice. Es la misma cuenta de la tarjeta «Entrega» del pedido
// (calcularEntrega), que va por los renglones del pedido; cada artículo se cruza con su renglón por la tarea de ClickUp.
const ENTREGA_A_MEDIAS = ['parcial', 'diferencias', 'cerrada_con_faltante'];
async function entregasParciales(db: D1Database, ids: number[], out: Record<number, ProduccionPedido>) {
  const { results } = await db.prepare(`SELECT id FROM records WHERE id IN (SELECT value FROM json_each(?1)) AND object_type = 'order'
      AND (json_extract(props, '$.hs_pipeline_stage') = ?2 OR json_extract(props, '$.estado_entrega') IN (SELECT value FROM json_each(?3)))`)
    .bind(JSON.stringify(ids.filter((id) => out[id])), STAGE.parcial, JSON.stringify(ENTREGA_A_MEDIAS)).all<{ id: number }>();
  if (!results.length) return;
  const renglones = (await db.prepare(`SELECT record_id, position, clickup_task FROM line_items WHERE record_id IN (SELECT value FROM json_each(?)) ORDER BY record_id, position`)
    .bind(JSON.stringify(results.map((r) => r.id))).all<{ record_id: number; position: number; clickup_task: string | null }>()).results;
  for (const { id } of results.slice(0, 40)) {
    const e = await calcularEntrega(db, id).catch(() => null);
    if (!e?.remitos_ok) continue;
    const suyos = renglones.filter((r) => r.record_id === id);
    // `lineas` va en el orden de los renglones del pedido: el i-ésimo es el renglón i.
    const porArticulo = new Map<string, { entregado: number; vendido: number | null }>();
    e.lineas.forEach((l, i) => {
      const r = suyos[i];
      if (!r) return;
      const x = { entregado: l.entregado, vendido: l.vendido };
      if (r.clickup_task) porArticulo.set(r.clickup_task, x);
      porArticulo.set(`li-${r.position}`, x);
    });
    for (const a of out[id].articulos) { const x = porArticulo.get(a.id); if (x) Object.assign(a, x); }
  }
}

// Factura, remito, bocetos y conversación de cada pedido: los mismos iconitos de la tarjeta del tablero (adjuntosSql).
export async function adjuntosDePedidos(db: D1Database, ids: number[]): Promise<Record<number, Adjuntos>> {
  if (!ids.length) return {};
  const { results } = await adjuntosSql(db, 'SELECT value FROM json_each(?)', [JSON.stringify(ids)]).all();
  return Object.fromEntries(armarAdjuntos(results));
}

// El nombre con que se vendió cada artículo (el del renglón del pedido atado a él: el que la vendedora cotizó), en lugar
// del de la subtarea de ClickUp, que Producción arma a su manera (a veces con el proveedor). Los SKU genéricos (`_GE_`)
// llevan el nombre en la descripción del renglón, no en la ficha.
async function nombresDeVenta(db: D1Database, tareas: string[]) {
  const out = new Map<string, string>();
  if (!tareas.length) return out;
  const { results } = await db.prepare(`SELECT li.clickup_task AS task, li.code, li.description, li.name AS li_name, p.name FROM line_items li
      LEFT JOIN products p ON p.code = li.code WHERE li.clickup_task IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(tareas))
    .all<{ task: string; code: string | null; description: string | null; li_name: string | null; name: string | null }>();
  for (const r of results) {
    const generico = /_GE(_|$)/i.test(r.code ?? '');
    const n = (generico ? r.description ?? r.li_name : r.name ?? r.li_name ?? r.description)?.trim();
    if (n && !out.has(r.task)) out.set(r.task, n);
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
