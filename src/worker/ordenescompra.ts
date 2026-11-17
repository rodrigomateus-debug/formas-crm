import type { Env } from './env';
import type { Budget } from './budget';
import { OutOfBudget } from './budget';
import { fin, pedidoIds, type Destino } from './finnegans';
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
  await db.batch(stmts);
  return ocs.length;
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
