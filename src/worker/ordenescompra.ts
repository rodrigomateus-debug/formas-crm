import type { Env } from './env';
import type { Budget } from './budget';
import { OutOfBudget } from './budget';
import { fin, finnegansToken, pedidoIds, type Destino } from './finnegans';
import { lista } from './produccion';

// Órdenes de compra a proveedores (pedido de Rodrigo del 17/11/2026): en Producción y en Pedidos, cada producto con el
// número de su OC de Finnegans, con link a la OC en Finnegans GO.
//
// - Cuáles: las OC se generan desde el pedido de venta, así que Finnegans las da entre los documentos destino del pedido
//   (el mismo informe de las facturas y los remitos, `ApiGetDocumentosDestinoByIdentificacionExternaDeals`). Se toman los
//   documentos cuyo tipo dice orden de compra (`esOc`).
// - De qué producto: el detalle de cada OC (`ordenCompra/<id>`) trae sus renglones con el código del producto. Una OC
//   puede juntar varios pedidos del mismo proveedor: cada renglón lleva el pedido de venta en la dimensión, así que de una
//   OC se toman los renglones que nombran este pedido (si ninguno nombra un pedido, todos). Si el detalle no se puede
//   leer, la OC queda solo en el pedido (`codigos` NULL).
// - Cuándo: al leer los productos del pedido de Finnegans (al abrirlo, cada 6 horas, y de fondo una vez por día los
//   activos, productos.ts). El detalle de cada OC se lee una sola vez.
// - El link: el visor de documentos de Finnegans GO con la transacción de la OC (`pk`), el formato que pasó Rodrigo.
//
// Los nombres del tipo de documento y de los campos del detalle no están documentados: `GET
// /api/integrations/finnegans/documentos?pedido=…` (administrador) muestra lo que devuelve Finnegans para revisarlo.

export const urlOc = (transaccion: number | null) => (transaccion
  ? `https://go.finneg.com/mas/vista?fafViewCode=DF_VIEWER&pk=${transaccion}&docId=71&claseVO=OperacionVO&appitemID=50255&customXsl=mainPageNoFrame.xsl&modoF4=1`
  : null);

// Un documento destino que es una orden de compra (no una factura, un remito o una nota).
export const esOc = (d: Pick<Destino, 'TIPODOCUMENTO' | 'DESTINONOMBRE'>) => {
  const t = `${d.TIPODOCUMENTO ?? ''} ${d.DESTINONOMBRE ?? ''}`.toUpperCase();
  return /(^|[^A-Z])(FP|ST|NE)?O\.?C(OMPRA|PROV|PRO)?([^A-Z]|$)|ORD(EN)?\s*(DE\s*)?COMPRA|ORDCOMP|OCOMPRA/.test(t) && !/VTA|REM|FAC|^(NC|ND)\b/.test(t);
};

// «FPOC - 00001234» → «OC 1234».
export const numeroOc = (nombre: string | null) => {
  const n = String(nombre ?? '').match(/(\d+)\D*$/)?.[1];
  return n ? `OC ${Number(n)}` : String(nombre ?? 'OC');
};

interface DetalleOc {
  Proveedor?: string; ProveedorNombre?: string; Organizacion?: string; RazonSocial?: string; Fecha?: string;
  Items?: Array<Record<string, unknown> & { ProductoCodigo?: string }>;
}

// Los renglones de una OC que son de este pedido: los que nombran el pedido de venta (en la dimensión o donde sea); si
// ninguno nombra un pedido de venta, todos.
function codigosDelPedido(det: DetalleOc, pedido: string) {
  const items = det.Items ?? [];
  const ids = pedidoIds(pedido).map((x) => x.toUpperCase().replace(/\s+/g, ''));
  const texto = (it: unknown) => JSON.stringify(it).toUpperCase().replace(/\s+/g, '');
  const conPedido = items.filter((it) => /PEDVTA/.test(texto(it)));
  const suyos = conPedido.length ? conPedido.filter((it) => ids.some((id) => texto(it).includes(id))) : items;
  return [...new Set(suyos.map((it) => String(it.ProductoCodigo ?? '').trim().toUpperCase()).filter(Boolean))];
}

// Lee las OC de un pedido y las guarda. Una consulta por el informe y una por cada OC nueva.
export async function leerOrdenesCompra(env: Env, token: string, recordId: number, pedido: string, b?: Budget) {
  const db = env.DB;
  const rows = await fin<Destino[]>(env, token, 'reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals', { PARAMWEBREPORT_IdentificacionExternaOrigen: pedidoIds(pedido)[0] }, b);
  const ocs = (rows ?? []).filter(esOc);
  await anotarTipos(db, rows ?? []);
  const ya = new Map((await db.prepare('SELECT ie, codigos FROM ordenes_compra WHERE record_id = ?').bind(recordId).all<{ ie: string; codigos: string | null }>()).results.map((r) => [r.ie, r]));
  const at = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const o of ocs) {
    const ie = String(o.DESTINOIDENTIFICACIONEXTERNA ?? o.DESTINONOMBRE ?? '').trim();
    if (!ie) continue;
    let codigos: string[] | null = ya.get(ie)?.codigos ? lista(ya.get(ie)!.codigos) : null;
    let det: DetalleOc | null = null;
    if (!codigos) {
      try { det = await fin<DetalleOc>(env, token, `ordenCompra/${encodeURIComponent(ie)}`, {}, b); } catch (e) { if (e instanceof OutOfBudget) throw e; }
      codigos = det?.Items?.length ? codigosDelPedido(det, pedido) : null;
    }
    const proveedor = det ? det.ProveedorNombre ?? det.RazonSocial ?? det.Organizacion ?? det.Proveedor ?? null : null;
    stmts.push(db.prepare(`INSERT INTO ordenes_compra (record_id, ie, nombre, transaccion_id, proveedor, fecha, codigos, leido_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id, ie) DO UPDATE SET nombre = excluded.nombre, transaccion_id = excluded.transaccion_id,
        proveedor = COALESCE(excluded.proveedor, ordenes_compra.proveedor), fecha = excluded.fecha, codigos = COALESCE(excluded.codigos, ordenes_compra.codigos), leido_at = excluded.leido_at`)
      .bind(recordId, ie, o.DESTINONOMBRE ?? ie, o.DESTINOTRANSACCIONID ?? null, proveedor, o.DESTINOFECHA ?? null, codigos ? JSON.stringify(codigos) : null, at));
  }
  // Las que ya no están (la anularon o la desvincularon del pedido).
  stmts.push(db.prepare('DELETE FROM ordenes_compra WHERE record_id = ? AND leido_at != ?').bind(recordId, at));
  stmts.push(db.prepare('INSERT OR REPLACE INTO ordenes_compra_lecturas (record_id, leido_at, ocs) VALUES (?, ?, ?)').bind(recordId, at, ocs.length));
  await db.batch(stmts);
  return ocs.length;
}

// Los pedidos en curso (desde que se confirman hasta que se entregan) cuyas OC no se leyeron en las últimas 6 horas: la
// tarea de cada hora (scripts/pedidos-productos.mjs) los lee de a tandas, así cada producto tiene su OC sin esperar a que
// alguien abra el pedido. Primero los que nunca se leyeron.
const EN_CURSO = ['4b27b500-f031-4927-9811-68a0b525cbae', '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03', 'aa99e8d0-c1d5-4071-b915-d240bbb1aed9',
  '3725360f-519b-4b18-a593-494d60a29c9f', 'esperando_boceto', '1237498994', '1237498996', 'entregado_parcial'];
const PENDIENTES_OC = `r.object_type = 'order' AND r.archived = 0 AND json_extract(r.props, '$.pedido_finnegans') LIKE 'PEDVTA%'
  AND json_extract(r.props, '$.hs_pipeline_stage') IN (SELECT value FROM json_each(?1)) AND (l.record_id IS NULL OR l.leido_at < ?2)`;
export async function ordenesCompraPendientes(env: Env, b: Budget, limit = 15) {
  const db = env.DB;
  const binds = [JSON.stringify(EN_CURSO), new Date(Date.now() - 6 * 3600_000).toISOString()];
  const { results } = await db.prepare(`SELECT r.id, json_extract(r.props, '$.pedido_finnegans') AS pedido FROM records r
      LEFT JOIN ordenes_compra_lecturas l ON l.record_id = r.id WHERE ${PENDIENTES_OC} ORDER BY (l.record_id IS NULL) DESC, r.updated_at DESC LIMIT ?3`)
    .bind(...binds, limit).all<{ id: number; pedido: string }>();
  let leidos = 0, ocs = 0;
  if (results.length) {
    const token = await finnegansToken(env, b);
    if (!token) return { leidos, ocs, quedan: 0, error: 'Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.' };
    for (const r of results) {
      if (b.left() < 6) break;   // el informe y alguna OC nueva
      try { ocs += await leerOrdenesCompra(env, token, r.id, r.pedido, b); } catch (e) { if (e instanceof OutOfBudget) break; console.error('órdenes de compra', r.id, (e as Error).message); }
      leidos++;
    }
  }
  const q = await db.prepare(`SELECT COUNT(*) AS n FROM records r LEFT JOIN ordenes_compra_lecturas l ON l.record_id = r.id WHERE ${PENDIENTES_OC}`).bind(...binds).first<{ n: number }>();
  return { leidos, ocs, quedan: q?.n ?? 0 };
}

// Los tipos de documento destino que se vieron (solo los códigos, «FPREMVTA», y si se toman como OC): para revisar que
// las OC se reconozcan (`estadoOrdenesCompra`). Se escribe solo cuando aparece un tipo nuevo.
async function anotarTipos(db: D1Database, rows: Destino[]) {
  const vistos = [...new Set(rows.map((r) => String(r.TIPODOCUMENTO ?? '').trim()).filter(Boolean))];
  if (!vistos.length) return;
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'finnegans_tipos_destino'").first<{ value: string }>();
  const antes = new Set<string>(r ? lista(r.value).map(String) : []);
  if (vistos.every((t) => antes.has(t)) || antes.size >= 60) return;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('finnegans_tipos_destino', ?)").bind(JSON.stringify([...new Set([...antes, ...vistos])].slice(0, 60))).run();
}
// Cuántas OC hay leídas y qué tipos de documento se vieron (solo cantidades y códigos de tipo, sin datos de clientes ni
// proveedores): lo imprime la tarea de cada hora (scripts/pedidos-productos.mjs), que corre en un repo público.
export async function estadoOrdenesCompra(db: D1Database) {
  const [n, t] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total, COUNT(codigos) AS con_detalle, SUM(codigos IS NOT NULL AND codigos != \'[]\') AS con_productos, COUNT(DISTINCT record_id) AS pedidos FROM ordenes_compra'),
    db.prepare("SELECT value FROM settings WHERE key = 'finnegans_tipos_destino'"),
  ]);
  const c = (n.results[0] ?? {}) as { total: number; con_detalle: number; con_productos: number | null; pedidos: number };
  const tipos = lista((t.results[0] as { value?: string } | undefined)?.value).map(String);
  return { total: c.total ?? 0, con_detalle: c.con_detalle ?? 0, con_productos: c.con_productos ?? 0, pedidos: c.pedidos ?? 0,
    tipos: tipos.map((x) => ({ tipo: x, es_oc: esOc({ TIPODOCUMENTO: x, DESTINONOMBRE: '' }) })) };
}

// Para la pantalla: las OC de cada pedido y, por código de producto, las de cada producto.
export interface OcRef { numero: string; nombre: string | null; url: string | null; proveedor: string | null }
export async function ocsDePedidos(db: D1Database, recordIds: Array<number | null | undefined>) {
  const ids = [...new Set(recordIds.filter((x): x is number => x != null))];
  const porPedido = new Map<number, Array<OcRef & { codigos: string[] | null }>>();
  if (!ids.length) return porPedido;
  const { results } = await db.prepare(`SELECT record_id, nombre, transaccion_id, proveedor, codigos FROM ordenes_compra WHERE record_id IN (SELECT value FROM json_each(?))
      ORDER BY record_id, nombre`).bind(JSON.stringify(ids)).all<{ record_id: number; nombre: string | null; transaccion_id: number | null; proveedor: string | null; codigos: string | null }>();
  for (const r of results) {
    const l = porPedido.get(r.record_id) ?? [];
    l.push({ numero: numeroOc(r.nombre), nombre: r.nombre, url: urlOc(r.transaccion_id), proveedor: r.proveedor, codigos: r.codigos == null ? null : lista(r.codigos).map(String) });
    porPedido.set(r.record_id, l);
  }
  return porPedido;
}
// Las OC de un producto del pedido, por su código.
// El código se compara sin espacios de más ni las barras que ClickUp les pone a los guiones bajos («MYA\_123»).
const normCodigo = (c: unknown) => String(c ?? '').trim().toUpperCase().replace(/\\/g, '').replace(/\s+/g, ' ');
export const ocsDeCodigo = (ocs: Array<OcRef & { codigos: string[] | null }> | undefined, codigo: string | null | undefined): OcRef[] => {
  const c = normCodigo(codigo);
  if (!c || !ocs) return [];
  return ocs.filter((o) => o.codigos?.some((x) => normCodigo(x) === c)).map(({ codigos: _c, ...o }) => o);
};
export const sinCodigos = (ocs: Array<OcRef & { codigos: string[] | null }> | undefined): OcRef[] => (ocs ?? []).map(({ codigos: _c, ...o }) => o);
