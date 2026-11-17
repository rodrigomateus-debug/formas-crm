// Productos de los pedidos (para las miniaturas de las tarjetas del tablero de pedidos): le pide al CRM que lea, de a
// tandas, los productos de los pedidos que todavía no se leyeron de Finnegans o ClickUp (o de los activos, una vez por
// día). Cada tanda es una llamada a POST /hooks/productos/pendientes; sigue hasta que no queda ninguno o pasan 20 minutos.
// Después, los remitos de los pedidos entregados que todavía no tienen (los que suben a los artículos del PDV en ClickUp),
// para el iconito de la tarjeta: POST /hooks/pedidos/remitos/pendientes, hasta 8 minutos más.
// Corre después de los totales en .github/workflows/pedidos-totales.yml.
//
//   CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… node scripts/pedidos-productos.mjs
//
// EL REPO ES PÚBLICO: solo imprime cantidades.
const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
if (!base || !process.env.CRM_TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }

// Llama a un hook de a tandas hasta que no queda nada, no avanza o se termina el tiempo.
async function tandas(path, minutos, campo, pausa = 0) {
  const hasta = Date.now() + minutos * 60_000;
  const suma = {};
  let vueltas = 0, quedan = null, fallas = 0;
  while (Date.now() < hasta) {
    const res = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) {
      if (++fallas >= 3) { console.error(`CRM ${path}: HTTP ${res.status}`); process.exit(1); }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const r = await res.json();
    vueltas++;
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'quedan') suma[k] = (suma[k] ?? 0) + v;
    quedan = r.quedan;
    if (!r[campo] || !r.quedan) break;
    if (pausa) await new Promise((ok) => setTimeout(ok, pausa));
  }
  return { ...suma, vueltas, quedan };
}

const p = await tandas('/hooks/productos/pendientes?limit=25', 20, 'leidos');
console.log(`Productos: ${p.leidos ?? 0} pedidos leídos en ${p.vueltas} tandas; quedan ${p.quedan ?? '?'}.`);
// Las órdenes de compra de Finnegans que quedaron leídas (ordenescompra.ts): cantidades y los códigos de tipo de documento
// destino vistos, para revisar que las OC se reconozcan. Nada de clientes ni proveedores.
try {
  const res = await fetch(`${base}/hooks/ordenes-compra/estado`, { headers: { authorization: `Bearer ${process.env.CRM_TOKEN}` }, redirect: 'manual' });
  if (res.ok) {
    const o = await res.json();
    console.log(`Órdenes de compra: ${o.total} en ${o.pedidos} pedidos; ${o.con_detalle} con detalle leído, ${o.con_productos} atadas a productos.`);
    console.log(`Tipos de documento destino vistos: ${o.tipos.map((t) => `${t.tipo}${t.es_oc ? ' (OC)' : ''}`).join(', ') || 'ninguno todavía'}.`);
  } else console.log(`Órdenes de compra: HTTP ${res.status}`);
} catch (e) { console.log(`Órdenes de compra: ${e.message}`); }
// Cada tanda usa hasta ~45 consultas a ClickUp, que deja 100 por minuto (y la sincronización también usa): una cada 30 s.
const r = await tandas('/hooks/pedidos/remitos/pendientes?limit=20', 8, 'revisados', 30_000);
console.log(`Remitos: ${r.revisados ?? 0} pedidos entregados revisados en ${r.vueltas} tandas, ${r.encontrados ?? 0} remitos nuevos; quedan ${r.quedan ?? '?'}.`);
