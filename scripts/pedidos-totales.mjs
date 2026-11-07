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

async function finToken() {
  const id = process.env.FINNEGANS_CLIENT_ID || process.env.FIN_CLIENT_ID;
  const secret = process.env.FINNEGANS_CLIENT_SECRET || process.env.FIN_SECRET;
  if (!id || !secret) throw new Error('Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.');
  const res = await fetch(`${FIN}/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`);
  if (!res.ok) throw new Error(`Finnegans token: HTTP ${res.status}`);
  return (await res.text()).trim().replace(/^"|"$/g, '');
}

async function filasDe(tok, emp, desde, hasta) {
  const filas = [];
  for (let d = desde; d <= hasta; d = masDias(d, 31)) {
    const h = masDias(d, 30) < hasta ? masDias(d, 30) : hasta;
    const r = await getJson(`${FIN}/reports/AnalisisdePedidosdeVentaPorProducto?${new URLSearchParams({
      PARAMWEBREPORT_FechaDesde: d, PARAMWEBREPORT_FechaHasta: h, PARAMWEBREPORT_Empresa: emp, ACCESS_TOKEN: tok })}`);
    if (Array.isArray(r)) filas.push(...r);
  }
  return filas;
}

// Lo que falta facturar de cada pedido, sin IVA (Rodrigo, 7/11/2026: «trabajamos con números sin IVA»). Un pedido está
// facturado si la factura sale de él (Finnegans lo dice en el informe de facturas), o de un remito suyo: el remito trae el
// PDV en la descripción («pdv 31089») o, si no, se buscan los remitos del pedido. Sin factura, todo está por facturar (el
// neto del pedido). Facturado, queda lo que todavía no pasó al remito o a la factura (el pendiente del pedido, que ya es
// neto). Los objetivos de venta y los de Mercado Libre no van.
export function resumenPedidos(filasPorEmpresa) {
  const out = new Map();
  for (const filas of filasPorEmpresa) {
    const vistos = new Map();
    for (const r of filas) {
      const k = clavePedido(r.DOCNROINT);
      if (!k || !/^PEDVTA/.test(k) || /anulad/i.test(r.ESTADO ?? '') || out.has(k)) continue;
      const o = vistos.get(k) ?? { total: Number(r.TOTAL ?? 0), neto: 0, pendiente: 0 };
      o.neto += Number(r.IMPORTEMONPRINCIPAL ?? 0);
      o.pendiente += Number(r.IMPORTEPENDIENTEDESTINO ?? 0);
      vistos.set(k, o);
    }
    for (const [k, v] of vistos) out.set(k, v);
  }
  return out;
}
export function facturadosDe(filasFacturas) {
  const pedidos = new Set(), pdvs = new Set(), remitos = new Set();
  for (const x of filasFacturas) {
    const t = String(x.TRANSACCIONSUBTIPOCODIGO ?? '');
    const k = clavePedido(x.IDENTIFICACIONEXTERNA);
    if (/^PEDVTA/.test(t)) { if (k) pedidos.add(k); continue; }
    if (k) remitos.add(k);
    const n = String(x.DESCRIPCION ?? '').match(/pdv\s*:?\s*(\d+)/i)?.[1];
    if (n) pdvs.add(Number(n));
  }
  return { pedidos, pdvs, remitos };
}
export const estaFacturado = (k, fact) => fact.pedidos.has(k) || fact.pdvs.has(Number(k.split(' - ')[1]));
export function porFacturarDe(resumen, fact, otrosFacturados = new Set()) {
  const out = {};
  for (const [k, o] of resumen) {
    const facturado = estaFacturado(k, fact) || otrosFacturados.has(k);
    const v = !facturado ? o.neto : o.pendiente > 0.5 ? o.pendiente : 0;
    out[k] = Math.round(Math.max(0, v) * 100) / 100;
  }
  return out;
}
// Total con IVA / neto de cada pedido: el CRM lo usa para pasar a sin IVA el saldo de sus facturas (que Finnegans da con
// IVA y percepciones).
export function factoresDe(resumen) {
  const out = {};
  for (const [k, o] of resumen) if (o.neto > 0 && o.total >= o.neto) out[k] = Math.round((o.total / o.neto) * 10000) / 10000;
  return out;
}
async function facturas(tok, desde, hasta) {
  const filas = [];
  for (const emp of EMPRESAS) {
    for (let d = desde; d <= hasta; d = masDias(d, 31)) {
      const h = masDias(d, 30) < hasta ? masDias(d, 30) : hasta;
      const r = await getJson(`${FIN}/reports/ApiFacturasDeVenta?${new URLSearchParams({
        PARAMWEBREPORT_FechaDesde: d, PARAMWEBREPORT_FechaHasta: h, PARAMWEBREPORT_EmpresaCodigo: emp, ACCESS_TOKEN: tok })}`);
      if (Array.isArray(r)) filas.push(...r);
    }
  }
  return filas;
}
// Los pedidos que no aparecen facturados por el informe ni por el PDV del remito: se miran sus remitos uno por uno.
async function facturadosPorRemito(tok, claves, fact) {
  const out = new Set();
  for (const k of claves) {
    const [tipo, n] = k.split(' - ');
    const r = await getJson(`${FIN}/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals?${new URLSearchParams({
      PARAMWEBREPORT_IdentificacionExternaOrigen: `${tipo} - ${String(n).padStart(8, '0')}`, ACCESS_TOKEN: tok })}`).catch(() => []);
    const remitos = (Array.isArray(r) ? r : []).filter((x) => /^FPREMVTA/.test(String(x.TIPODOCUMENTO ?? '')))
      .map((x) => clavePedido(x.DESTINOIDENTIFICACIONEXTERNA ?? x.DESTINONOMBRE));
    if (remitos.some((x) => x && fact.remitos.has(x))) out.add(k);
  }
  return out;
}

// Saldo pendiente de cada pedido: el informe de composición de saldos (las dos empresas juntas, con la coma y los
// corchetes sin escapar; si no, vuelve vacío). Solo los deudores en cuenta corriente: cada fila es un comprobante con lo
// que falta cobrar, con IVA (el CRM lo pasa a sin IVA). El CRM la cruza con su pedido (/hooks/pedidos/saldos). Del cliente no se manda nada más.
export function filasDeSaldo(reporte) {
  return (Array.isArray(reporte) ? reporte : []).filter((x) => x.CUENTA === 'Deudores en Cta. Cte.').map((x) => ({
    ie: x.IDENTIFICACIONEXTERNA ?? null, doc: x.DOCUMENTO ?? null, desc: x.DESCRIPCION ?? null, importe: Number(x.IMPORTEMONPPAL ?? 0), vto: x.FECHAVTO ?? null,
  })).filter((f) => Number.isFinite(f.importe) && f.importe !== 0);
}
async function saldos(tok, hoy) {
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
  const fact = facturadosDe(await facturas(tok, desde, hoy));
  const dudosos = [...resumen.keys()].filter((k) => /^PEDVTAFP/.test(k) && !estaFacturado(k, fact));
  const porFacturar = porFacturarDe(resumen, fact, await facturadosPorRemito(tok, dudosos, fact));
  const rs = await fetch(`${base}/hooks/pedidos/saldos`, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ filas: filasSaldo, porFacturar, factores: factoresDe(resumen), completo: true }) });
  if (!rs.ok) throw new Error(`CRM /hooks/pedidos/saldos: HTTP ${rs.status}`);
  const s = await rs.json();
  const sinFacturar = Object.values(porFacturar).filter((v) => v > 0).length;
  console.log(`Saldos: ${s.filas} comprobantes con saldo, ${s.cruzadas} cruzan con un pedido; ${sinFacturar} pedidos con algo por facturar; ${s.pedidos_con_saldo} pedidos con saldo, ${s.actualizados} actualizados.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
