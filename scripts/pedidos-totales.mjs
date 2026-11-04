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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
