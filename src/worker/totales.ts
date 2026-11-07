import type { Env } from './env';
import { HttpError } from './env';

// Total sin IVA de cada pedido, desde Finnegans (scripts/pedidos-totales.mjs, solo lectura): el neto del pedido de venta,
// en pesos, sumado renglón por renglón. Con eso el tablero de pedidos suma cada columna, como el de negocios.
// Se aplica en tanda (pocas consultas aunque sean cientos de pedidos), queda en el historial de la propiedad y no toca la
// fecha de modificación del pedido, así el tablero no se reordena cada vez que llega un total.

// «PEDVTASTP - 00031277», «PEDVTASTP - 31277» y «pedvtastp-31277» son el mismo pedido.
export const clavePedido = (p: unknown) => {
  const m = String(p ?? '').match(/^\s*([A-Za-z]+)\s*-\s*(\d+)\s*$/);
  return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null;
};

export interface TotalesEstado { recibidos: number; pedidos: number; cruzados: number; actualizados: number; at: string }

export async function aplicarTotales(env: Env, body: { totales?: Record<string, number> }): Promise<TotalesEstado> {
  const tot = body?.totales;
  if (!tot || typeof tot !== 'object' || Array.isArray(tot)) throw new HttpError(400, 'Falta totales: {"PEDVTASTP - 31277": 123456.78, …}.');
  const db = env.DB;
  const porPedido = new Map<string, number>();
  for (const [k, v] of Object.entries(tot)) {
    const c = clavePedido(k);
    const n = Number(v);
    if (c && Number.isFinite(n)) porPedido.set(c, Math.round(n * 100) / 100);
  }
  const sys = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<{ id: number }>();
  const { results } = await db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido, json_extract(props, '$.hs_total_price') AS total
    FROM records WHERE object_type = 'order' AND archived = 0 AND json_extract(props, '$.pedido_finnegans') IS NOT NULL`)
    .all<{ id: number; pedido: string; total: number | string | null }>();
  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let cruzados = 0, actualizados = 0;
  for (const r of results) {
    const k = clavePedido(r.pedido);
    if (!k || !porPedido.has(k)) continue;
    cruzados++;
    const v = porPedido.get(k)!;
    if (r.total != null && r.total !== '' && Math.abs(Number(r.total) - v) < 0.01) continue;
    actualizados++;
    stmts.push(
      db.prepare(`UPDATE records SET props = json_set(props, '$.hs_total_price', ?, '$.hs_currency_code', COALESCE(json_extract(props, '$.hs_currency_code'), 'ARS')),
        amount = ? WHERE id = ?`).bind(v, v, r.id),
      db.prepare('INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(r.id, 'hs_total_price', r.total == null || r.total === '' ? null : String(r.total), String(v), ts, sys?.id ?? null, 'finnegans'),
    );
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  const out = { recibidos: porPedido.size, pedidos: results.length, cruzados, actualizados, at: ts };
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totales_pedidos', ?)").bind(JSON.stringify(out)).run();
  return out;
}

// ---------- Saldo pendiente de cada pedido ----------
// Del informe de composición de saldos de Finnegans (scripts/pedidos-totales.mjs): una fila por comprobante con saldo
// (facturas, notas de crédito, cobranzas sin aplicar), con lo que falta cobrar, con IVA; acá se pasa a sin IVA con el
// total/neto exacto de esa factura (`facturas`), o el de su pedido (`factores`), o 1,21, porque se trabaja sin IVA. Cada factura se cruza con su
// pedido: por la factura que el CRM ya tiene enganchada al pedido; si no, por su identificación («FC PEDVTASTP-00031277 1»)
// o por el número de PDV con que empieza la descripción («31089», «2407 / OC N°…», «PDV:36 NOESTRES»), que también lo
// tienen las facturas que salen de un remito. Las notas de crédito restan en el pedido de la factura que corrigen. Al
// saldo de las facturas se le suma lo que falta facturar (`porFacturar`). Facturado y cobrado queda en 0; sin dato, vacío.

export interface FilaSaldo { emp?: string | null; ie?: string | null; doc?: string | null; desc?: string | null; importe: number; vto?: string | null }
export interface SaldosEstado { filas: number; cruzadas: number; sin_cruce: number; pedidos_con_saldo: number; total: number; actualizados: number; at: string }

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
// «FCVTAELECT - 0002583», «FCVTAELECT-2583» → «FCVTAELECT - 2583».
const claveDoc = (s: unknown) => { const m = String(s ?? '').match(/([A-Za-z_]+)\s*-\s*0*(\d+)/); return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null; };
const esNota = (f: FilaSaldo) => /^NC/i.test(String(f.doc ?? '')) || /^NC\s/i.test(String(f.ie ?? ''));

const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';

// `porFacturar` ({"PEDVTAFP - 2413": 1234.5}): lo que falta facturar de cada pedido, sin IVA (scripts/pedidos-totales.mjs);
// queda en el pedido («Por facturar») y se suma al saldo. Los pedidos que no vienen conservan el último que llegó.
// `factores` ({"PEDVTAFP - 2413": 1.21}): total con IVA / neto de cada pedido.
// `facturas` ({"EMPRE01|FCVTAELECT - 2583": {pedido: "PEDVTAFP - 2413", factor: 1.2345}}): de qué pedido es cada comprobante
// y su total/neto exacto, del análisis de facturas (scripts/pedidos-totales.mjs). Manda sobre las otras formas de cruzarlo.
const IVA = 1.21;
type FacturaCrm = { pedido?: string | null; factor?: number | null };
export async function aplicarSaldos(env: Env, body: { filas?: unknown; porFacturar?: Record<string, number>; factores?: Record<string, number>;
  facturas?: Record<string, FacturaCrm>; completo?: boolean }): Promise<SaldosEstado> {
  if (!Array.isArray(body?.filas)) throw new HttpError(400, 'Falta filas: [{ie, doc, desc, importe}, …].');
  const filas = (body.filas as FilaSaldo[]).filter((f) => f && Number.isFinite(Number(f.importe)));
  const db = env.DB;
  const [pedidos, facturas] = await db.batch([
    db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido, json_extract(props, '$.pdv_finnegans') AS pdv,
        json_extract(props, '$.factura_numero') AS factura, json_extract(props, '$.saldo_pendiente_de_pago_mxn') AS saldo,
        json_extract(props, '$.importe_por_facturar') AS por_facturar, json_extract(props, '$.hs_pipeline_stage') AS etapa
      FROM records WHERE object_type = 'order' AND archived = 0 AND json_extract(props, '$.pedido_finnegans') IS NOT NULL`),
    db.prepare("SELECT record_id, source_ref, json_extract(meta, '$.documento') AS documento FROM files WHERE kind = 'factura' AND source = 'finnegans'"),
  ]);
  const ped = pedidos.results as Array<{ id: number; pedido: string; pdv: string | number | null; factura: string | null; saldo: number | string | null;
    por_facturar: number | string | null; etapa: string | null }>;
  const porFacturar = new Map<string, number>();
  for (const [k, v] of Object.entries(body.porFacturar && typeof body.porFacturar === 'object' ? body.porFacturar : {})) {
    const c = clavePedido(k);
    if (c && Number.isFinite(Number(v))) porFacturar.set(c, Math.max(0, Math.round(Number(v) * 100) / 100));
  }
  const fac = facturas.results as Array<{ record_id: number; source_ref: string; documento: string | null }>;
  const porIe = new Map(fac.map((f) => [norm(f.source_ref), f.record_id]));
  const porDoc = new Map(fac.filter((f) => claveDoc(f.documento)).map((f) => [claveDoc(f.documento)!, f.record_id]));
  const porPedido = new Map(ped.map((p) => [clavePedido(p.pedido), p.id]));
  const porPdv = new Map<number, Array<{ id: number; tipo: string }>>();
  for (const p of ped) {
    const n = Number(String(p.pdv ?? '').match(/\d+/)?.[0] ?? clavePedido(p.pedido)?.split(' - ')[1]);
    if (!n) continue;
    const l = porPdv.get(n) ?? [];
    l.push({ id: p.id, tipo: clavePedido(p.pedido)?.split(' - ')[0] ?? '' });
    porPdv.set(n, l);
  }
  const conFactura = new Set([...fac.map((f) => f.record_id), ...ped.filter((p) => p.factura).map((p) => p.id)]);
  const factorDe = new Map<number, number>();
  for (const [k, v] of Object.entries(body.factores && typeof body.factores === 'object' ? body.factores : {})) {
    const id = porPedido.get(clavePedido(k));
    if (id !== undefined && Number(v) >= 1 && Number(v) < 2) factorDe.set(id, Number(v));
  }
  const facturasCrm = body.facturas && typeof body.facturas === 'object' ? body.facturas : {};
  const deFactura = (f: FilaSaldo): FacturaCrm | undefined => {
    const d = claveDoc(f.doc);
    return d ? facturasCrm[`${f.emp || 'EMPRE01'}|${d}`] : undefined;
  };
  const factorOk = (v: unknown) => (Number(v) >= 1 && Number(v) < 2 ? Number(v) : undefined);
  const sinIva = (id: number, importe: number, f?: FilaSaldo) => importe / (factorOk(f && deFactura(f)?.factor) ?? factorDe.get(id) ?? IVA);

  const pedidoDe = (f: FilaSaldo): number | undefined => {
    const fx = deFactura(f)?.pedido;
    if (fx && porPedido.has(clavePedido(fx))) return porPedido.get(clavePedido(fx));
    const ie = norm(f.ie);
    if (porIe.has(ie)) return porIe.get(ie);
    const d = claveDoc(f.doc);
    if (d && porDoc.has(d)) return porDoc.get(d);
    const m = ie.match(/^FC (PEDVTA[A-Z]*)-0*(\d+)/);
    if (m && porPedido.has(`${m[1]} - ${Number(m[2])}`)) return porPedido.get(`${m[1]} - ${Number(m[2])}`);
    const n = Number(String(f.desc ?? '').match(/^\s*(?:PDV\s*:?\s*)?(\d+)/i)?.[1]);
    let cand = n ? porPdv.get(n) ?? [] : [];
    if (cand.length > 1) {
      // Mismo número en otra unidad: la descripción o la identificación dicen cuál.
      const tipo = /NO\s*ESTRES/i.test(String(f.desc ?? '')) ? 'PEDVTANE' : m?.[1] ?? null;
      if (tipo) cand = cand.filter((c) => c.tipo === tipo);
    }
    return cand.length === 1 ? cand[0].id : undefined;
  };

  const saldo = new Map<number, number>();
  const pedidoDeDoc = new Map<string, number>();
  let cruzadas = 0;
  // Primero las facturas; después las notas de crédito, que van al pedido de la factura que corrigen.
  for (const f of filas.filter((x) => !esNota(x))) {
    const id = pedidoDe(f);
    if (id === undefined) continue;
    cruzadas++;
    saldo.set(id, (saldo.get(id) ?? 0) + sinIva(id, Number(f.importe), f));
    const d = claveDoc(f.doc);
    if (d) pedidoDeDoc.set(d, id);
  }
  for (const f of filas.filter(esNota)) {
    const ref = String(f.ie ?? '').match(/^NC\s+([A-Za-z]+)-0*(\d+)/i);
    const refDoc = ref ? `${ref[1].toUpperCase()} - ${Number(ref[2])}` : null;
    const anula = Number(String(f.desc ?? '').match(/ANULA\s+FC\s*0*(\d+)/i)?.[1]);
    const fx = deFactura(f)?.pedido;
    let id = (fx && porPedido.get(clavePedido(fx))) || (refDoc && (pedidoDeDoc.get(refDoc) ?? porDoc.get(refDoc))) || undefined;
    if (id === undefined && anula) id = [...pedidoDeDoc].find(([k]) => Number(k.split(' - ')[1]) === anula)?.[1];
    id ??= pedidoDe(f);
    if (id === undefined) continue;
    cruzadas++;
    saldo.set(id, (saldo.get(id) ?? 0) + sinIva(id, Number(f.importe), f));
  }

  const sys = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<{ id: number }>();
  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let actualizados = 0;
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const cambiar = (id: number, prop: string, viejo: number | null, nuevo: number | null) => {
    if (nuevo === viejo || (nuevo != null && viejo != null && Math.abs(nuevo - viejo) < 0.01)) return false;
    stmts.push(
      nuevo == null
        ? db.prepare(`UPDATE records SET props = json_remove(props, '$.${prop}') WHERE id = ?`).bind(id)
        : db.prepare(`UPDATE records SET props = json_set(props, '$.${prop}', ?) WHERE id = ?`).bind(nuevo, id),
      db.prepare('INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, prop, viejo == null ? null : String(viejo), nuevo == null ? null : String(nuevo), ts, sys?.id ?? null, 'finnegans'),
    );
    return true;
  };
  for (const p of ped) {
    const clave = clavePedido(p.pedido);
    const llega = clave != null && porFacturar.has(clave);
    // Sin la lista completa (body.completo), solo se tocan los pedidos que aparecen.
    if (!saldo.has(p.id) && !llega && !body.completo) continue;
    // Anulado: ni saldo ni nada por facturar.
    const anulado = p.etapa === ANULADO;
    const pf = anulado ? null : llega ? porFacturar.get(clave!)! : num(p.por_facturar);
    const facturas = saldo.get(p.id);
    const nuevo = anulado ? null
      : facturas === undefined && pf == null ? (conFactura.has(p.id) ? 0 : null)
      : Math.max(0, Math.round(((facturas ?? 0) + (pf ?? 0)) * 100) / 100);
    const a = cambiar(p.id, 'importe_por_facturar', num(p.por_facturar), pf);
    const b = cambiar(p.id, 'saldo_pendiente_de_pago_mxn', num(p.saldo), nuevo);
    if (a || b) actualizados++;
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  const conSaldo = [...saldo.values()].filter((v) => v > 0.005);
  const out = { filas: filas.length, cruzadas, sin_cruce: filas.length - cruzadas, pedidos_con_saldo: conSaldo.length,
    total: Math.round(conSaldo.reduce((t, v) => t + v, 0)), actualizados, at: ts };
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('saldos_pedidos', ?)").bind(JSON.stringify(out)).run();
  return out;
}

