import type { Env } from './env';
import { Budget, OutOfBudget } from './budget';
import { fin, finnegansToken } from './finnegans';
import { lista } from './produccion';
import { clavePedido } from './totales';

// Órdenes de compra a proveedores (pedido de Rodrigo del 17/11/2026): en Producción y en Pedidos, cada producto con el
// número de su OC de Finnegans, con link a la OC en Finnegans GO.
//
// Cómo están en Finnegans (lo investigó una sesión en el entorno de Finnegans el 17/11/2026, con datos reales):
// - Las OC (categoría «Orden de Compra», subtipo `OC`, id 71) NO son documentos destino del pedido de venta. Cada renglón
//   lleva el pedido en la dimensión `PEDVTA` (un renglón puede repartirse entre varios pedidos y una OC puede juntar
//   pedidos distintos).
// - `reports/ANALISISORDENESCOMPRA` (rango de fechas, `Empresa=EMPRE01`, `dimension=PEDVTA`) trae en una sola consulta un
//   renglón por producto y por pedido: TRANSACCIONID, IDENTIFICACIONEXTERNA, DOCNROINT («OC - 11394»), PROVEEDOR (nombre),
//   CODIGOPROD, DIMENSIONVALOR (el pedido por nombre, «PEDVTASTP - 31546»), ESTADO. Las filas sin CODIGOPROD son IVA y
//   conceptos. «Sin dimensión valor» / «Sin distribuir»: el renglón no tiene pedido.
// - Las OC del mismo día a veces salen en el informe sin pedido aunque lo tengan: para esas se lee el detalle
//   (`ordenCompra/<id>`, `Items[].DimensionDistribucion[dimensionCodigo=PEDVTA].distribucionItems[].codigo`, con la
//   identificación externa del pedido, «PEDVTASTP - 00031577»).
// - El link: el visor de Finnegans GO con `pk` = TRANSACCIONID y `docId=71`.
//
// La tarea de cada hora (scripts/pedidos-productos.mjs → POST /hooks/ordenes-compra/sincronizar) lee los últimos 30 días
// (la primera vez, 120) y reemplaza las OC de ese rango. El pedido se cruza por su número (clavePedido: «PEDVTASTP -
// 00031577» y «PEDVTASTP - 31577» son el mismo). Una consulta por corrida, más una por cada OC del día que salió sin pedido.

export const urlOc = (transaccion: number | null) => (transaccion
  ? `https://go.finneg.com/mas/vista?fafViewCode=DF_VIEWER&pk=${transaccion}&docId=71&claseVO=OperacionVO&appitemID=50255&customXsl=mainPageNoFrame.xsl&modoF4=1`
  : null);

// «OC - 11744» → «OC 11744» (el número interno de la OC; las automáticas de Formas Shop se identifican «OC - 00031651 -
// P01435», pero su número interno es el de siempre).
export const numeroOc = (nombre: string | null) => {
  const n = String(nombre ?? '').match(/OC\D*?(\d+)/i)?.[1] ?? String(nombre ?? '').match(/(\d+)/)?.[1];
  return n ? `OC ${Number(n)}` : String(nombre ?? 'OC');
};

interface FilaAnalisis {
  TRANSACCIONID?: number; IDENTIFICACIONEXTERNA?: string; DOCNROINT?: string | null; FECHA?: string | null; PROVEEDOR?: string | null;
  CODIGOPROD?: string | null; DIMENSIONVALOR?: string | null; ESTADO?: string | null;
}
interface DetalleOc {
  Items?: Array<{ ProductoCodigo?: string; DimensionDistribucion?: Array<{ dimensionCodigo?: string; distribucionItems?: Array<{ codigo?: string }> }> }>;
}
interface Oc { ie: string; nombre: string; tx: number | null; proveedor: string | null; fecha: string | null; anulada: boolean; sinPedido: boolean; porPedido: Map<string, Set<string>> }

// «17-11-2026» → «2026-11-17».
const isoDe = (f: string | null | undefined) => { const m = String(f ?? '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (String(f ?? '').slice(0, 10) || null); };
const hoyBA = (dias = 0) => new Date(Date.now() - 3 * 3600_000 - dias * 86_400_000).toISOString().slice(0, 10);

export async function sincronizarOrdenesCompra(env: Env, opts: { dias?: number; budget?: Budget } = {}) {
  const db = env.DB;
  const b = opts.budget ?? Budget.of(env);
  const antes = await db.prepare("SELECT value FROM settings WHERE key = 'ordenes_compra_sync'").first<{ value: string }>();
  const dias = Math.min(Math.max(opts.dias ?? (antes ? 30 : 120), 1), 180);
  const token = await finnegansToken(env, b);
  if (!token) return { error: 'Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.' };
  const filas = (await fin<FilaAnalisis[]>(env, token, 'reports/ANALISISORDENESCOMPRA', {
    PARAMWEBREPORT_FechaDesde: hoyBA(dias), PARAMWEBREPORT_FechaHasta: hoyBA(), PARAMWEBREPORT_Empresa: 'EMPRE01', PARAMWEBREPORT_dimension: 'PEDVTA',
  }, b)) ?? [];
  // Cada OC con sus productos por pedido.
  const ocs = new Map<string, Oc>();
  for (const f of Array.isArray(filas) ? filas : []) {
    const ie = String(f.IDENTIFICACIONEXTERNA ?? '').trim();
    if (!ie) continue;
    let o = ocs.get(ie);
    if (!o) {
      o = { ie, nombre: String(f.DOCNROINT ?? '').trim() || ie, tx: Number(f.TRANSACCIONID) || null, proveedor: f.PROVEEDOR?.trim() || null, fecha: isoDe(f.FECHA),
        anulada: false, sinPedido: false, porPedido: new Map() };
      ocs.set(ie, o);
    }
    if (/anul/i.test(f.ESTADO ?? '')) o.anulada = true;
    const codigo = String(f.CODIGOPROD ?? '').trim().toUpperCase();
    if (!codigo) continue;   // IVA y otros conceptos
    const pedido = clavePedido(f.DIMENSIONVALOR);
    if (!pedido) { o.sinPedido = true; continue; }
    const s = o.porPedido.get(pedido) ?? new Set<string>();
    s.add(codigo);
    o.porPedido.set(pedido, s);
  }
  // Las OC de hoy y ayer con renglones sin pedido: el informe puede no tenerlo todavía; el detalle sí.
  let detalles = 0;
  for (const o of [...ocs.values()].filter((x) => x.sinPedido && !x.anulada && (x.fecha ?? '') >= hoyBA(1)).slice(0, 25)) {
    if (b.left() < 3) break;
    let det: DetalleOc | null = null;
    try { det = await fin<DetalleOc>(env, token, `ordenCompra/${encodeURIComponent(o.ie)}`, {}, b); } catch (e) { if (e instanceof OutOfBudget) break; continue; }
    detalles++;
    for (const it of det?.Items ?? []) {
      const codigo = String(it.ProductoCodigo ?? '').trim().toUpperCase();
      if (!codigo) continue;
      for (const d of (it.DimensionDistribucion ?? []).filter((x) => x.dimensionCodigo === 'PEDVTA')) {
        for (const di of d.distribucionItems ?? []) {
          const pedido = clavePedido(di.codigo);
          if (!pedido) continue;
          const s = o.porPedido.get(pedido) ?? new Set<string>();
          s.add(codigo);
          o.porPedido.set(pedido, s);
        }
      }
    }
  }
  // Los pedidos del CRM, por su número de Finnegans.
  const { results } = await db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido FROM records
      WHERE object_type = 'order' AND archived = 0 AND json_extract(props, '$.pedido_finnegans') IS NOT NULL`).all<{ id: number; pedido: string }>();
  const porPedido = new Map<string, number>();
  for (const r of results) { const k = clavePedido(r.pedido); if (k && !porPedido.has(k)) porPedido.set(k, r.id); }
  const at = new Date().toISOString();
  const filasOc: unknown[] = [];
  let cruzadas = 0;
  for (const o of ocs.values()) {
    if (o.anulada) continue;
    for (const [pedido, codigos] of o.porPedido) {
      const rid = porPedido.get(pedido);
      if (!rid) continue;
      cruzadas++;
      filasOc.push([rid, o.ie, o.nombre, o.tx, o.proveedor, o.fecha, JSON.stringify([...codigos]), at]);
    }
  }
  // Las OC del rango se reemplazan (las anuladas o que cambiaron de pedido dejan de estar); las más viejas quedan.
  const stmts: D1PreparedStatement[] = [];
  const ies = [...ocs.keys()];
  for (let i = 0; i < ies.length; i += 500) stmts.push(db.prepare('DELETE FROM ordenes_compra WHERE ie IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ies.slice(i, i + 500))));
  for (let i = 0; i < filasOc.length; i += 500) {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO ordenes_compra (record_id, ie, nombre, transaccion_id, proveedor, fecha, codigos, leido_at)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
        json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]') FROM json_each(?)`).bind(JSON.stringify(filasOc.slice(i, i + 500))));
  }
  const estado = { at, dias, filas: Array.isArray(filas) ? filas.length : 0, ocs: ocs.size, anuladas: [...ocs.values()].filter((o) => o.anulada).length,
    sin_pedido: [...ocs.values()].filter((o) => !o.porPedido.size).length, cruzadas, detalles };
  stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ordenes_compra_sync', ?)").bind(JSON.stringify(estado)));
  await db.batch(stmts);
  return estado;
}

// Cuántas OC hay y cómo salió la última lectura (solo cantidades, sin datos de clientes ni proveedores): lo imprime la
// tarea de cada hora (scripts/pedidos-productos.mjs), que corre en un repo público.
export async function estadoOrdenesCompra(db: D1Database) {
  const [n, s] = await db.batch([
    db.prepare("SELECT COUNT(DISTINCT ie) AS total, COUNT(DISTINCT record_id) AS pedidos FROM ordenes_compra"),
    db.prepare("SELECT value FROM settings WHERE key = 'ordenes_compra_sync'"),
  ]);
  const c = (n.results[0] ?? {}) as { total: number; pedidos: number };
  const v = (s.results[0] as { value?: string } | undefined)?.value;
  return { total: c.total ?? 0, pedidos: c.pedidos ?? 0, ultima: v ? JSON.parse(v) : null };
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
