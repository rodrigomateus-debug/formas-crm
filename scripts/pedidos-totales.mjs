// Total sin IVA de cada pedido: Finnegans → pedidos del CRM. Corre en GitHub Actions (.github/workflows/pedidos-totales.yml):
// cada hora en horario de trabajo con los pedidos de los últimos 120 días, y una vez por día con todos desde 2023.
//
// Lee el informe de pedidos de venta por producto de Finnegans (solo lectura), suma el neto de cada renglón (sin IVA, en
// pesos) por pedido y le pasa al CRM {"PEDVTASTP - 31277": total, …}. El CRM lo guarda en el «Total sin IVA» de los pedidos
// con ese pedido de Finnegans; el tablero de pedidos lo suma abajo de cada columna.
//
//   CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… FIN_CLIENT_ID=… FIN_SECRET=… node scripts/pedidos-totales.mjs
//   DESDE=2023-01-01 trae desde esa fecha (si no, los últimos 120 días). DRY_RUN=1 calcula sin mandar nada.
//
// EL REPO ES PÚBLICO: este script nunca imprime clientes ni montos, solo cantidades.
import { pathToFileURL } from 'node:url';

const FIN = (process.env.FINNEGANS_API_URL ?? 'https://api.finneg.com/api').replace(/\/$/, '');
// Formas Publicitarias SA primero: si un número de pedido está en las dos empresas, vale el de Formas (como las facturas).
const EMPRESAS = ['EMPRE01', '7'];
const DIA = 86_400_000;
const masDias = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DIA).toISOString().slice(0, 10);

// «PEDVTASTP - 00031277» y «PEDVTASTP - 31277» son el mismo pedido (igual que clavePedido en src/worker/totales.ts).
export const clavePedido = (p) => {
  const m = String(p ?? '').match(/^\s*([A-Za-z]+)\s*-\s*(\d+)\s*$/);
  return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null;
};

// Renglones del informe → total sin IVA por pedido. Los renglones anulados y los objetivos de venta no cuentan.
export function totalesPorPedido(filasPorEmpresa) {
  const out = {};
  for (const filas of filasPorEmpresa) {
    const suma = new Map();
    for (const r of filas) {
      const k = clavePedido(r.DOCNROINT);
      if (!k || /^PDVOBJETIVOS/.test(k) || /anulad/i.test(r.ESTADO ?? '')) continue;
      suma.set(k, (suma.get(k) ?? 0) + Number(r.IMPORTEMONPRINCIPAL ?? r.IMPORTE ?? 0));
    }
    for (const [k, v] of suma) if (!(k in out)) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

async function getJson(url, init, intentos = 4) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(url, init);
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(txt);   // la API de Finnegans a veces corta la respuesta: se reintenta
    } catch (e) { ultimo = e; await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  throw new Error(`${url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')}: ${ultimo.message}`);
}

export async function finToken() {
  const id = process.env.FINNEGANS_CLIENT_ID || process.env.FIN_CLIENT_ID;
  const secret = process.env.FINNEGANS_CLIENT_SECRET || process.env.FIN_SECRET;
  if (!id || !secret) throw new Error('Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.');
  const res = await fetch(`${FIN}/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`);
  if (!res.ok) throw new Error(`Finnegans token: HTTP ${res.status}`);
  return (await res.text()).trim().replace(/^"|"$/g, '');
}

export async function filasDe(tok, emp, desde, hasta) {
  const filas = [];
  for (let d = desde; d <= hasta; d = masDias(d, 31)) {
    const h = masDias(d, 30) < hasta ? masDias(d, 30) : hasta;
    const r = await getJson(`${FIN}/reports/AnalisisdePedidosdeVentaPorProducto?${new URLSearchParams({
      PARAMWEBREPORT_FechaDesde: d, PARAMWEBREPORT_FechaHasta: h, PARAMWEBREPORT_Empresa: emp, ACCESS_TOKEN: tok })}`);
    if (Array.isArray(r)) filas.push(...r);
  }
  return filas;
}

// ---------- Lo que falta facturar y lo que falta cobrar, sin IVA, al centavo ----------
// Rodrigo, 7/11/2026: «saber exactamente cuánto falta que nos paguen», sin IVA («trabajamos con números sin IVA»).
//
// Por facturar: lo que Finnegans lleva como pendiente en cada documento (neto). En Formas Shop y No Estrés el pedido
// pasa directo a la factura: su pendiente es lo que falta facturar. En Corporate pasa al remito y el remito a la factura:
// falta facturar lo que el pedido todavía no remitió más lo que sus remitos todavía no facturaron (análisis de remitos,
// que trae solo los que tienen algo sin facturar; cada remito dice el PDV en la descripción, «pdv 31089»). Así un precio
// que se ajustó al facturar o una nota de crédito por un descuento no quedan como «por facturar».
// Menos los anticipos: la factura de anticipo («ANTICIPO FINANCIERO», con el PDV en la descripción) no sale del pedido;
// la factura final lo descuenta con un renglón en negativo. Lo anticipado que todavía no se descontó ya está facturado.
//
// Lo que falta cobrar sale del informe de saldos, factura por factura; el CRM lo pasa a sin IVA con el neto/total exacto
// de cada factura (análisis de facturas). Cada factura se engancha a su pedido: por el pedido o remito del que sale
// (informe de facturas), por su identificación («FC PEDVTASTP-00031277 1»), por el PDV de la descripción («31089»,
// «PDV:36 NOESTRES», «PDV N° 31512 / OC…») o, si es una nota que anula otra («NC ANULA FC 2583»), por esa.
// Los objetivos de venta y Mercado Libre no van.

const normIe = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
// «FCVTAELECT - 0002583» → «FCVTAELECT - 2583» (también «NC FCVTAELECT-2583 1» → «FCVTAELECT - 2583»).
export const claveDoc = (s) => { const m = String(s ?? '').match(/([A-Za-z_]+)\s*-\s*0*(\d+)/); return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null; };
// El PDV con que empieza la descripción: «31089», «PDV:36 NOESTRES», «PDV N° 31512 / OC…», «PDV NOESTRES N° 36», «pdv 31089».
export function pdvDeDescripcion(desc) {
  const s = String(desc ?? '');
  const m = s.match(/^\s*(?:PDV\s*(?:NO\s*ESTRES\s*)?(?:N\s*[°º.]?\s*)?:?\s*)?(\d{1,6})\b/i);
  return m ? { n: Number(m[1]), ne: /NO\s*ESTRES/i.test(s) } : null;
}
const esAnticipo = (r) => /ANTICIPO/i.test(`${r.PRODUCTO ?? ''} ${r.CODIGOPROD ?? ''}`);

export function resumenPedidos(filasPorEmpresa) {
  const out = new Map();
  for (const filas of filasPorEmpresa) {
    const vistos = new Map();
    for (const r of filas) {
      const k = clavePedido(r.DOCNROINT);
      if (!k || !/^PEDVTA/.test(k) || out.has(k)) continue;
      const o = vistos.get(k) ?? { total: Number(r.TOTAL ?? 0), neto: 0, pendiente: 0, anulado: false };
      if (/anulad/i.test(r.ESTADO ?? '')) o.anulado = true;
      else { o.neto += Number(r.IMPORTEMONPRINCIPAL ?? 0); o.pendiente += Number(r.IMPORTEPENDIENTEDESTINO ?? 0); }
      vistos.set(k, o);
    }
    for (const [k, v] of vistos) out.set(k, v);
  }
  return out;
}

// Renglones del análisis de facturas → un comprobante por empresa y número: neto, total con IVA y anticipo (renglones
// «ANTICIPO FINANCIERO»: en positivo en la factura de anticipo, en negativo en la final que lo descuenta).
export function docsDeFacturas(filasPorEmpresa) {
  const out = new Map();
  for (const { emp, filas } of filasPorEmpresa) {
    for (const r of filas) {
      if (/anulad/i.test(r.ESTADO ?? '')) continue;
      const doc = claveDoc(r.DOCNROINT);
      if (!doc) continue;
      const k = `${emp}|${doc}`;
      const o = out.get(k) ?? { emp, doc, neto: 0, anticipo: 0, total: Number(r.TOTAL ?? 0), desc: String(r.DESCRIPCION ?? ''), ie: normIe(r.IDENTIFICACIONEXTERNA) };
      o.neto += Number(r.IMPORTEMONPRINCIPAL ?? 0);
      if (esAnticipo(r)) o.anticipo += Number(r.IMPORTEMONPRINCIPAL ?? 0);
      out.set(k, o);
    }
  }
  return out;
}

// Informe de facturas: de qué pedido o remito sale cada factura (por empresa e identificación: Formas y FP DEMO usan la
// misma numeración).
export function origenesDe(filasPorEmpresa) {
  const out = new Map();
  for (const { emp, filas } of filasPorEmpresa) for (const x of filas) {
    const ie = normIe(x.IDENTIFICACIONEXTERNAFACT);
    if (!ie) continue;
    const dePedido = /^PEDVTA/.test(String(x.TRANSACCIONSUBTIPOCODIGO ?? ''));
    // Una factura puede salir de varios documentos (un pedido y un remito, o varios remitos): se guardan todos.
    const k = `${emp}|${ie}`;
    out.set(k, [...(out.get(k) ?? []), { pedido: dePedido ? clavePedido(x.IDENTIFICACIONEXTERNA) : null, remito: dePedido ? null : claveDoc(x.IDENTIFICACIONEXTERNA),
      pdv: dePedido ? null : pdvDeDescripcion(x.DESCRIPCION)?.n ?? null }]);
  }
  return out;
}

function porNumeroDe(resumen) {
  const porNumero = new Map();
  for (const k of resumen.keys()) { const n = Number(k.split(' - ')[1]); porNumero.set(n, [...(porNumero.get(n) ?? []), k]); }
  return (n, ne) => {
    let c = porNumero.get(n) ?? [];
    if (c.length > 1) c = c.filter((k) => (ne ? /^PEDVTANE/.test(k) : !/^PEDVTANE/.test(k)));
    return c.length === 1 ? c[0] : null;
  };
}

// A qué pedido va cada comprobante. `remitoAPedido`: remitos buscados pedido por pedido (los que no dicen el PDV).
export function asignarFacturas(docs, origenes, resumen, remitoAPedido = new Map()) {
  const deNumero = porNumeroDe(resumen);
  const out = new Map();
  for (const [k, d] of docs) {
    const os = origenes.get(`${d.emp}|${d.ie}`) ?? [];
    const ped = d.ie.match(/^FC (PEDVTA[A-Z]*)-0*(\d+)/);
    const p = pdvDeDescripcion(d.desc);
    const escrito = p && !/^\s*(NC|ND|FC)\s+ANULA/i.test(d.desc) ? deNumero(p.n, p.ne) : null;
    // De qué pedidos sale según Finnegans: el pedido, o el PDV que dice su remito.
    const desdeOrigen = [...new Set(os.map((o) => o.pedido ?? (o.pdv != null ? deNumero(o.pdv, false) : null)).filter(Boolean))];
    // Si sale de varios, el que coincide con el PDV escrito en la factura; si sale de uno, ese; si no, lo escrito; la
    // búsqueda de remitos, al final.
    const elegido = (ped ? `${ped[1]} - ${Number(ped[2])}` : null)
      ?? (escrito && desdeOrigen.includes(escrito) ? escrito : null)
      ?? (desdeOrigen.length === 1 ? desdeOrigen[0] : null)
      ?? escrito ?? desdeOrigen[0]
      ?? os.map((o) => (o.remito ? remitoAPedido.get(o.remito) : null)).find(Boolean) ?? null;
    out.set(k, elegido);
  }
  // Las notas (y las facturas o débitos que anulan una nota) van con el comprobante que corrigen.
  for (const [k, d] of docs) {
    if (out.get(k)) continue;
    const ref = d.ie.match(/^(?:NC|ND|FC)\s+([A-Z_]+)-0*(\d+)/);
    const anula = d.desc.match(/ANULA\s+(FC|NC|ND)\s*0*(\d+)/i);
    let destino = ref ? out.get(`${d.emp}|${ref[1]} - ${Number(ref[2])}`) : null;
    if (!destino && anula) {
      const tipo = anula[1].toUpperCase() === 'FC' ? /^(FC|FACT)/ : /^(NC|FCENC|ND|FCEND)/;
      const cand = [...docs].filter(([kk, x]) => x.emp === d.emp && tipo.test(x.doc) && Number(x.doc.split(' - ')[1]) === Number(anula[2]) && out.get(kk));
      if (cand.length === 1) destino = out.get(cand[0][0]);
    }
    if (destino) out.set(k, destino);
  }
  return out;
}

// Remitos con algo sin facturar (análisis de remitos) → lo pendiente de cada pedido.
export function remitosPendientes(filasPorEmpresa) {
  const out = new Map();
  for (const { emp, filas } of filasPorEmpresa) {
    for (const r of filas) {
      if (/anulad/i.test(r.ESTADO ?? '')) continue;
      const doc = claveDoc(r.DOCNROINT);
      if (!doc) continue;
      const k = `${emp}|${doc}`;
      const o = out.get(k) ?? { emp, doc, pendiente: 0, pdv: pdvDeDescripcion(r.DESCRIPCION)?.n ?? null };
      o.pendiente += Number(r.IMPORTEPENDIENTEDESTINO ?? 0);
      out.set(k, o);
    }
  }
  return out;
}
// Solo cuentan los remitos de Corporate: en Formas Shop el remito es de la entrega y nunca se factura. Si un pedido
// Corporate se facturó directo y su remito quedó sin facturar, lo corrige el otro cálculo (neto menos lo facturado).
export function pendientePorRemitos(remitos, resumen, remitoAPedido = new Map()) {
  const soloFp = new Map([...resumen].filter(([k]) => /^PEDVTAFP/.test(k)));
  const deNumero = porNumeroDe(soloFp);
  const out = new Map(), sinPedido = [];
  for (const [, r] of remitos) {
    if (!(r.pendiente > 0)) continue;
    const p = (r.pdv != null ? deNumero(r.pdv, false) : null) ?? (r.pdv == null ? remitoAPedido.get(r.doc) : null) ?? null;
    if (!p) { sinPedido.push(r); continue; }
    out.set(p, (out.get(p) ?? 0) + r.pendiente);
  }
  return { porPedido: out, sinPedido };
}


// Anticipo facturado que la factura final todavía no descontó, por pedido.
export function anticiposDe(docs, asignadas) {
  const out = new Map();
  for (const [k, d] of docs) { const p = asignadas.get(k); if (p && d.anticipo) out.set(p, (out.get(p) ?? 0) + d.anticipo); }
  for (const [p, v] of out) if (v <= 0.005) out.delete(p);
  return out;
}

// Neto de todo lo facturado a cada pedido: facturas, anticipos y la final que los descuenta, notas de crédito y débito.
export function netoFacturado(docs, asignadas) {
  const out = new Map();
  for (const [k, d] of docs) { const p = asignadas.get(k); if (p) out.set(p, (out.get(p) ?? 0) + d.neto); }
  return out;
}

// Por facturar = el menor de dos cálculos: (1) lo pendiente según Finnegans (pedido y remitos, menos los anticipos sin
// descontar) y (2) el neto del pedido menos todo lo que se le facturó. El (1) no ve una factura que se hizo sin enlazarla
// al pedido o al remito; el (2) toma como pendiente un descuento por nota de crédito o un precio que se ajustó al facturar.
// Cada uno corrige el error del otro.
export function porFacturarDe(resumen, pendRemitos = new Map(), anticipos = new Map(), facturado = null) {
  const out = {};
  for (const [k, o] of resumen) {
    const segunFinnegans = o.pendiente + (pendRemitos.get(k) ?? 0) - (anticipos.get(k) ?? 0);
    const segunFacturas = facturado ? o.neto - (facturado.get(k) ?? 0) : Infinity;
    const v = o.anulado ? 0 : Math.min(segunFinnegans, segunFacturas);
    out[k] = v >= 0.01 ? Math.round(v * 100) / 100 : 0;
  }
  return out;
}

// Para el CRM: cada comprobante, de qué pedido es y su total/neto (con eso pasa a sin IVA lo que falta cobrar de él).
export function facturasParaCrm(docs, asignadas) {
  const out = {};
  for (const [k, d] of docs) {
    const r = d.neto ? d.total / d.neto : 0;
    const factor = r >= 1 && r < 2 ? Math.round(r * 1e6) / 1e6 : null;
    const pedido = asignadas.get(k) ?? null;
    if (pedido || factor) out[k] = { pedido, factor };
  }
  return out;
}
// Total con IVA / neto de cada pedido: si una factura con saldo es anterior a lo que se leyó, se usa el de su pedido.
export function factoresDe(resumen) {
  const out = {};
  for (const [k, o] of resumen) if (o.neto > 0 && o.total >= o.neto) out[k] = Math.round((o.total / o.neto) * 10000) / 10000;
  return out;
}

export async function porTramos(tok, informe, params, desde, hasta) {
  const filas = [];
  for (let d = desde; d <= hasta; d = masDias(d, 31)) {
    const h = masDias(d, 30) < hasta ? masDias(d, 30) : hasta;
    const r = await getJson(`${FIN}/reports/${informe}?${new URLSearchParams({ PARAMWEBREPORT_FechaDesde: d, PARAMWEBREPORT_FechaHasta: h, ...params, ACCESS_TOKEN: tok })}`);
    if (Array.isArray(r)) filas.push(...r);
  }
  return filas;
}
// Los remitos de un pedido (para los que el remito facturado no dice el PDV).
export async function remitosDe(tok, claves) {
  const out = new Map();
  for (const k of claves) {
    const [tipo, n] = k.split(' - ');
    const r = await getJson(`${FIN}/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals?${new URLSearchParams({
      PARAMWEBREPORT_IdentificacionExternaOrigen: `${tipo} - ${String(n).padStart(8, '0')}`, ACCESS_TOKEN: tok })}`).catch(() => []);
    for (const x of Array.isArray(r) ? r : []) {
      if (!/^FPREMVTA/.test(String(x.TIPODOCUMENTO ?? ''))) continue;
      const rem = claveDoc(x.DESTINOIDENTIFICACIONEXTERNA ?? x.DESTINONOMBRE);
      if (rem) out.set(rem, k);
    }
  }
  return out;
}

// Saldo pendiente de cada pedido: el informe de composición de saldos (las dos empresas juntas, con la coma y los
// corchetes sin escapar; si no, vuelve vacío). Solo los deudores en cuenta corriente: cada fila es un comprobante con lo
// que falta cobrar, con IVA (el CRM lo pasa a sin IVA). El CRM la cruza con su pedido (/hooks/pedidos/saldos). Del cliente no se manda nada más.
export function filasDeSaldo(reporte) {
  return (Array.isArray(reporte) ? reporte : []).filter((x) => x.CUENTA === 'Deudores en Cta. Cte.').map((x) => ({
    emp: /FP\s*DEMO/i.test(String(x.EMPRESA ?? '')) ? '7' : 'EMPRE01',
    ie: x.IDENTIFICACIONEXTERNA ?? null, doc: x.DOCUMENTO ?? null, desc: x.DESCRIPCION ?? null, importe: Number(x.IMPORTEMONPPAL ?? 0), vto: x.FECHAVTO ?? null,
  })).filter((f) => Number.isFinite(f.importe) && f.importe !== 0);
}
export async function saldos(tok, hoy) {
  const r = await getJson(`${FIN}/reports/COMPOSICIONSALDOSCLIENTES?${new URLSearchParams({ PARAMWEBREPORT_fecha: hoy, ACCESS_TOKEN: tok })}&PARAMWEBREPORT_Empresa=[${EMPRESAS.join(',')}]`);
  if (!Array.isArray(r)) throw new Error('El informe de saldos no volvió como lista.');
  return filasDeSaldo(r);
}

async function main() {
  const hoy = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const desde = process.env.DESDE || masDias(hoy, -120);
  const tok = await finToken();
  const filas = [];
  for (const emp of EMPRESAS) filas.push(await filasDe(tok, emp, desde, hoy));
  const totales = totalesPorPedido(filas);
  console.log(`Desde ${desde}: ${filas.reduce((n, f) => n + f.length, 0)} renglones, ${Object.keys(totales).length} pedidos con total.`);
  if (process.env.DRY_RUN) return;
  const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
  if (!base || !process.env.CRM_TOKEN) throw new Error('Faltan CRM_URL y CRM_TOKEN.');
  const res = await fetch(`${base}/hooks/pedidos/totales`, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ totales }) });
  if (!res.ok) throw new Error(`CRM /hooks/pedidos/totales: HTTP ${res.status}`);
  const r = await res.json();
  console.log(`CRM: ${r.pedidos} pedidos con pedido de Finnegans, ${r.cruzados} cruzan, ${r.actualizados} actualizados.`);
  // Si un informe falla no se manda nada (si no, todos los pedidos facturados quedarían en 0).
  const filasSaldo = await saldos(tok, hoy);
  const resumen = resumenPedidos(filas);
  const lineas = [];
  for (const emp of EMPRESAS) lineas.push({ emp, filas: await porTramos(tok, 'analisisFacturaVenta', { PARAMWEBREPORT_Empresa: emp }, desde, hoy) });
  const docs = docsDeFacturas(lineas);
  const origenes = [];
  for (const emp of EMPRESAS) origenes.push({ emp, filas: await porTramos(tok, 'ApiFacturasDeVenta', { PARAMWEBREPORT_EmpresaCodigo: emp }, desde, hoy) });
  const orig = origenesDe(origenes);
  const despachos = [];
  for (const emp of EMPRESAS) despachos.push({ emp, filas: await porTramos(tok, 'analisisDespachoVenta', { PARAMWEBREPORT_Empresa: emp }, desde, hoy) });
  const remitos = remitosPendientes(despachos);
  let asignadas = asignarFacturas(docs, orig, resumen);
  let pend = pendientePorRemitos(remitos, resumen);
  // Remitos con algo sin facturar que no dicen el PDV: se buscan los remitos de los pedidos Corporate recientes que ya
  // remitieron todo y no tienen factura (los 150 de número más alto; son pocos y siempre recientes).
  const conFactura = new Set(asignadas.values());
  const faltan = pend.sinPedido.some((r) => r.pdv == null);
  const candidatos = faltan ? [...resumen].filter(([k, o]) => /^PEDVTAFP/.test(k) && !o.anulado && o.pendiente < 0.01 && !conFactura.has(k) && !pend.porPedido.has(k))
    .map(([k]) => k).sort((a, b) => Number(b.split(' - ')[1]) - Number(a.split(' - ')[1])).slice(0, 150) : [];
  const remitoAPedido = await remitosDe(tok, candidatos);
  asignadas = asignarFacturas(docs, orig, resumen, remitoAPedido);
  pend = pendientePorRemitos(remitos, resumen, remitoAPedido);
  const porFacturar = porFacturarDe(resumen, pend.porPedido, anticiposDe(docs, asignadas), netoFacturado(docs, asignadas));
  const rs = await fetch(`${base}/hooks/pedidos/saldos`, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ filas: filasSaldo, porFacturar, factores: factoresDe(resumen), facturas: facturasParaCrm(docs, asignadas), completo: true }) });
  if (!rs.ok) throw new Error(`CRM /hooks/pedidos/saldos: HTTP ${rs.status}`);
  const s = await rs.json();
  const sinFacturar = Object.values(porFacturar).filter((v) => v > 0);
  const sinPedido = [...docs.keys()].filter((k) => !asignadas.get(k)).length;
  console.log(`Facturas: ${docs.size} comprobantes desde ${desde}, ${docs.size - sinPedido} con su pedido (${sinPedido} sin: Mercado Libre, de pedidos anteriores, otros). Remitos sin facturar: ${remitos.size}, ${pend.sinPedido.length} sin pedido.`);
  console.log(`Saldos: ${s.filas} comprobantes con saldo, ${s.cruzadas} cruzan con un pedido; ${sinFacturar.length} pedidos con algo por facturar ($ ${Math.round(sinFacturar.reduce((a, b) => a + b, 0)).toLocaleString('es-AR')} sin IVA); ${s.actualizados} actualizados.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
