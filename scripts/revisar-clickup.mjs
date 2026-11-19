// Repaso de los pedidos en curso contra ClickUp (pedido de Rodrigo del 19/11/2026): vuelve a leer todos los PDV abiertos
// de ClickUp, los pedidos del CRM que no están entregados y los que se combinaron hace poco, y deja en cada uno la etapa
// y el estado de cada artículo que tiene ClickUp; los PDV que falten en el CRM se crean. Lo hace el CRM
// (/hooks/pedidos/revisar, clickup.ts) de a tandas: acá se le pide que siga hasta terminar. Solo imprime cantidades.
// MODO=todo hace la lectura completa (también los PDV cerrados en los últimos 45 días).
const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
if (!base || !process.env.CRM_TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }
const pedir = async (modo) => {
  const res = await fetch(`${base}/hooks/pedidos/revisar`, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(modo ? { modo } : {}) });
  if (!res.ok) throw new Error(`CRM /hooks/pedidos/revisar: HTTP ${res.status}`);
  return res.json();
};
const VUELTAS = Number(process.env.VUELTAS) || 90;
let creados = 0, actualizados = 0, r = await pedir(process.env.MODO === 'todo' ? '' : 'abiertos');
for (let i = 0; ; i++) {
  creados += r.creados ?? 0; actualizados += r.actualizados ?? 0;
  console.log(`Tanda ${i + 1}: ${r.creados ?? 0} creados, ${r.actualizados ?? 0} actualizados, quedan ${r.pendientes ?? '?'} PDV${r.leyendo_lista ? ' (leyendo la lista)' : ''}${r.error ? ` · ${r.error}` : ''}`);
  if ((!r.pendientes && !r.leyendo_lista) || i + 1 >= VUELTAS) break;
  // Cada tanda usa hasta ~45 consultas a ClickUp, que deja 100 por minuto: una cada 30 segundos.
  await new Promise((ok) => setTimeout(ok, 30_000));
  r = await pedir('seguir');
}
console.log(`Listo: ${creados} pedidos creados y ${actualizados} actualizados; quedan ${r.pendientes ?? 0} PDV por revisar${r.pendientes ? ' (siguen con la sincronización de cada 10 minutos)' : ''}.`);
