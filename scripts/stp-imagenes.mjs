// Fotos de los productos desde el registro de cotizaciones del STP (pedido de Rodrigo del 6/11/2026): todas las
// cotizaciones, confirmadas o no, con la imagen que eligió la vendedora para cada producto. Arma:
//   · por pedido: el PDV de Finnegans de la cotización + el SKU → la foto de ese pedido (la variante que se cotizó);
//   · por SKU: la foto que más se repite en las cotizaciones (sin las personalizadas con el logo de un cliente), para
//     los productos de los pedidos que no tienen cotización en el STP.
// Las manda al CRM en tandas a POST /hooks/productos/imagenes. Corre después de los productos en
// .github/workflows/pedidos-totales.yml.
//
//   STPO_TOKEN=… CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… node scripts/stp-imagenes.mjs
//
// EL REPO ES PÚBLICO: solo imprime cantidades (nunca la dirección del export, que lleva el token, ni datos de clientes).
const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
if (!base || !process.env.CRM_TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }
if (!process.env.STPO_TOKEN) { console.log('Falta el secreto STPO_TOKEN: no se cargan las fotos del STP.'); process.exit(0); }

const url = `https://www.stpo.com.ar/export?token=${encodeURIComponent(process.env.STPO_TOKEN)}&file=registro_cotizaciones`;
let texto;
for (let i = 0; ; i++) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    texto = await res.text();
    break;
  } catch (e) {
    if (i >= 2) { console.error(`No se pudo bajar el registro de cotizaciones del STP (${e.message}).`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 10_000 * (i + 1)));
  }
}

// CSV con «;», comillas y BOM; los encabezados pueden traer espacios (ver formas-tablero, claude/stpo_api.py).
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
  return rows;
}
const filas = csv(texto.replace(/^﻿/, ''));
const h = (filas[0] ?? []).map((x) => x.trim().toUpperCase());
const col = (n) => h.indexOf(n);
const [cPdv, cSku, cImg, cFecha] = [col('PDV FINNEGANS'), col('SKU'), col('IMAGEN'), col('FECHA')];
if ([cPdv, cSku, cImg].some((c) => c < 0)) { console.error('El registro de cotizaciones no trae las columnas PDV FINNEGANS, SKU e IMAGEN.'); process.exit(1); }

const clave = (p) => { const m = String(p ?? '').match(/^\s*([A-Za-z]+)\s*-\s*(\d+)\s*$/); return m ? `${m[1].toUpperCase()} - ${Number(m[2])}` : null; };
// Las imágenes personalizadas (el producto con el logo de un cliente) sirven para su pedido, no para los de otros.
const personalizada = (u) => /user-images|zakeke/i.test(u);

const datos = filas.slice(1)
  .map((r) => ({ pdv: clave(r[cPdv]), sku: String(r[cSku] ?? '').trim().toUpperCase(), img: String(r[cImg] ?? '').trim(), fecha: cFecha >= 0 ? String(r[cFecha] ?? '') : '' }))
  .filter((r) => r.sku && /^https?:\/\/\S+$/.test(r.img) && r.img.length <= 600)
  .sort((a, b) => a.fecha.localeCompare(b.fecha));   // la más nueva pisa a la anterior

const porPedido = new Map();   // "PDV|SKU" → foto
const porSku = new Map();      // SKU → Map(foto → [veces, orden])
datos.forEach((r, i) => {
  if (r.pdv) porPedido.set(`${r.pdv}|${r.sku}`, [r.pdv, r.sku, r.img]);
  if (personalizada(r.img)) return;
  const m = porSku.get(r.sku) ?? new Map();
  const [n] = m.get(r.img) ?? [0];
  m.set(r.img, [n + 1, i]);
  porSku.set(r.sku, m);
});
const envio = [...porPedido.values()];
for (const [sku, m] of porSku) {
  const [img] = [...m].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1])[0];
  envio.push(['', sku, img]);
}

let guardadas = 0, estado = null;
for (let i = 0; i < envio.length; i += 2500) {
  let res;
  for (let k = 0; ; k++) {
    res = await fetch(`${base}/hooks/productos/imagenes`, { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ filas: envio.slice(i, i + 2500) }) });
    if (res.ok || k >= 2) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res.ok) { console.error(`CRM /hooks/productos/imagenes: HTTP ${res.status}`); process.exit(1); }
  estado = await res.json();
  guardadas += estado.guardadas;
}
const pedidos = new Set([...porPedido.values()].map(([p]) => p)).size;
console.log(`STP: ${filas.length - 1} renglones de cotizaciones, ${datos.length} con foto. Fotos por pedido: ${porPedido.size} (${pedidos} pedidos); por SKU: ${porSku.size}.`);
console.log(`CRM: ${guardadas} guardadas; en total ${estado?.pedidos ?? '?'} por pedido y ${estado?.skus ?? '?'} por SKU.`);
