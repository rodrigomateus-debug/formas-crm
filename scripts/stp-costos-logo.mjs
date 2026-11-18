// Costo del logo de cada producto de los pedidos, desde el STP (pedido de Rodrigo del 17/11/2026): lo que se tomó para el
// logo en la cotización, por unidad, para que Producción sepa con cuánto cuenta. Baja dos exports del STP:
//   · «pedidos_sku_formas»: cada SKU de cada pedido confirmado, con el PDV de Finnegans, COSTO EXTRA (el logo) y SETUP
//     PRORRATEADO (el setup ya dividido por la cantidad);
//   · «cotizaciones_modo_costos»: la misma línea con LOGOS y SETUP que cargó la vendedora (desde septiembre de 2026).
// Si el producto está en el modo costos (con COSTO TOTAL), van esos; si no, los del pedido. Es la misma regla del costo
// teórico del tablero de Formas (formas-tablero, claude/comisiones.py). El mismo SKU dos veces en un pedido (con otro logo)
// se empareja por orden de aparición. Los pedidos cancelados no van.
// Los manda al CRM en tandas a POST /hooks/productos/costos-logo (cada pedido entero en un envío). Corre después de las
// fotos en .github/workflows/pedidos-totales.yml.
//
//   STPO_TOKEN=… CRM_URL=https://hub.formas.workers.dev CRM_TOKEN=fcrm_… node scripts/stp-costos-logo.mjs
//
// EL REPO ES PÚBLICO: solo imprime cantidades (nunca la dirección del export, que lleva el token, ni datos de clientes).
const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
if (!base || !process.env.CRM_TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }
if (!process.env.STPO_TOKEN) { console.log('Falta el secreto STPO_TOKEN: no se cargan los costos del logo.'); process.exit(0); }

async function bajar(file) {
  const url = `https://www.stpo.com.ar/export?token=${encodeURIComponent(process.env.STPO_TOKEN)}&file=${file}`;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i >= 2) { console.error(`No se pudo bajar ${file} del STP (${e.message}).`); process.exit(1); }
      await new Promise((r) => setTimeout(r, 10_000 * (i + 1)));
    }
  }
}

// CSV con «;», comillas y BOM; los encabezados pueden traer espacios de más (ver formas-tablero, claude/stpo_api.py).
function csv(t) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ';') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}
// Una tabla: los encabezados normalizados y, por cada columna pedida, un lector. Los números se leen con el separador
// decimal de toda la columna, como formato_columna del tablero: «,» si algún valor trae coma o puntos de miles
// encadenados («1.234.567»); «.» si no (los exports de octubre de 2026 traen «492.765» con punto decimal).
function tabla(texto) {
  const filas = csv(texto.replace(/^﻿/, ''));
  const h = (filas[0] ?? []).map((x) => String(x).replace(/\s+/g, ' ').trim().toUpperCase());
  const datos = filas.slice(1);
  const col = (...nombres) => { for (const n of nombres) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  const txt = (i) => (r) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const numero = (i) => {
    const conComa = i >= 0 && datos.some((r) => /,|\d\.\d{3}\.\d/.test(String(r[i] ?? '')));
    return (r) => {
      if (i < 0) return NaN;
      const t = String(r[i] ?? '').replace(/[^\d.,-]/g, '');
      if (!t || t === '-' || t === '.' || t === ',') return NaN;
      return Number(conComa ? t.replace(/\./g, '').replace(',', '.') : t);
    };
  };
  return { h, datos, col, txt, numero };
}
const clave = (p) => { const m = String(p ?? '').match(/^\s*([A-Za-z]+)\s*-\s*(\d+)\s*$/); return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null; };
const skuDe = (s) => String(s ?? '').trim().toUpperCase();

const P = tabla(await bajar('pedidos_sku_formas'));
const pc = {
  pdv: P.col('PDV FINNEGANS'), stp: P.col('N°DE PEDIDO', 'N° DE PEDIDO'), sku: P.col('SKU'), nombre: P.col('NOMBRE', 'NOMBRE DEL PRODUCTO'),
  cant: P.col('CANTIDAD PEDIDA', 'CANTIDAD'), estado: P.col('ESTADO'), logo: P.col('COSTO EXTRA'), setup: P.col('SETUP PRORRATEADO'),
};
if ([pc.pdv, pc.stp, pc.sku, pc.logo].some((c) => c < 0)) {
  console.error('El export pedidos_sku_formas no trae las columnas PDV FINNEGANS, N°DE PEDIDO, SKU y COSTO EXTRA: no se cambia nada.');
  process.exit(1);
}
// El modo costos es optativo: sin él, van los del pedido.
const C = tabla(await bajar('cotizaciones_modo_costos'));
const cc = { stp: C.col('N° DE PEDIDO', 'N°DE PEDIDO'), sku: C.col('SKU'), logos: C.col('LOGOS'), setup: C.col('SETUP'), total: C.col('COSTO TOTAL') };
const conModo = [cc.stp, cc.sku, cc.logos, cc.setup, cc.total].every((c) => c >= 0);

const modo = new Map();   // "STP|SKU|n" → { logo, setup }
if (conModo) {
  const [stp, sku, logos, setup, total] = [C.txt(cc.stp), C.txt(cc.sku), C.numero(cc.logos), C.numero(cc.setup), C.numero(cc.total)];
  const occ = new Map();
  for (const r of C.datos) {
    const k = `${stp(r)}|${skuDe(sku(r))}`;
    const n = occ.get(k) ?? 0;
    occ.set(k, n + 1);
    if (total(r) > 0) modo.set(`${k}|${n}`, { logo: logos(r) || 0, setup: setup(r) || 0 });
  }
}

const [pdv, stp, sku, nombre, estado] = [P.txt(pc.pdv), P.txt(pc.stp), P.txt(pc.sku), P.txt(pc.nombre), P.txt(pc.estado)];
const [cant, logo, setup] = [P.numero(pc.cant), P.numero(pc.logo), P.numero(pc.setup)];
const porPedido = new Map();   // PDV → filas
const occ = new Map();
let deModo = 0, sinPdv = 0, cancelados = 0;
for (const r of P.datos) {
  const k = `${stp(r)}|${skuDe(sku(r))}`;
  const n = occ.get(k) ?? 0;
  occ.set(k, n + 1);
  if (estado(r).toLowerCase() === 'cancelled') { cancelados++; continue; }
  const p = clave(pdv(r));
  if (!p || !skuDe(sku(r))) { sinPdv++; continue; }
  const m = modo.get(`${k}|${n}`);
  if (m) deModo++;
  const fila = [p, skuDe(sku(r)), nombre(r).slice(0, 200), cant(r) || null, m ? m.logo : logo(r) || 0, m ? m.setup : setup(r) || 0, m ? 'costos' : 'pedido'];
  const l = porPedido.get(p) ?? [];
  l.push(fila);
  porPedido.set(p, l);
}

async function enviar(filas) {
  let res;
  for (let k = 0; ; k++) {
    res = await fetch(`${base}/hooks/productos/costos-logo`, { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ filas }) });
    if (res.ok || k >= 2) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res.ok) { console.error(`CRM /hooks/productos/costos-logo: HTTP ${res.status}`); process.exit(1); }
  return res.json();
}
let tanda = [], estadoCrm = null, total = 0;
for (const filas of porPedido.values()) {
  tanda.push(...filas);
  total += filas.length;
  if (tanda.length >= 2500) { estadoCrm = await enviar(tanda); tanda = []; }
}
if (tanda.length) estadoCrm = await enviar(tanda);
const conLogo = [...porPedido.values()].flat().filter((f) => f[4] > 0 || f[5] > 0).length;
console.log(`STP: ${P.datos.length} renglones de pedidos (${cancelados} cancelados, ${sinPdv} sin PDV de Finnegans); modo costos: ${conModo ? `${modo.size} con costo` : 'no vino'}.`);
console.log(`Costos del logo: ${total} productos de ${porPedido.size} pedidos (${deModo} del modo costos, ${conLogo} con logo o setup); en el CRM, ${estadoCrm?.total ?? '?'}.`);
