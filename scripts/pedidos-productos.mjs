// Productos de los pedidos (para las miniaturas de las tarjetas del tablero de pedidos): le pide al CRM que lea, de a
// tandas, los productos de los pedidos que todavía no se leyeron de Finnegans o ClickUp (o de los activos, una vez por
// día). Cada tanda es una llamada a POST /hooks/productos/pendientes; sigue hasta que no queda ninguno o pasan 20 minutos.
// Corre después de los totales en .github/workflows/pedidos-totales.yml.
//
//   CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… node scripts/pedidos-productos.mjs
//
// EL REPO ES PÚBLICO: solo imprime cantidades.
const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
if (!base || !process.env.CRM_TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }
const hasta = Date.now() + 20 * 60_000;
let leidos = 0, vueltas = 0, quedan = null, fallas = 0;
while (Date.now() < hasta) {
  const res = await fetch(`${base}/hooks/productos/pendientes?limit=25`, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
  if (!res.ok) {
    if (++fallas >= 3) { console.error(`CRM /hooks/productos/pendientes: HTTP ${res.status}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  const r = await res.json();
  vueltas++;
  leidos += r.leidos;
  quedan = r.quedan;
  if (!r.leidos || !r.quedan) break;
}
console.log(`Productos: ${leidos} pedidos leídos en ${vueltas} tandas; quedan ${quedan ?? '?'}.`);
