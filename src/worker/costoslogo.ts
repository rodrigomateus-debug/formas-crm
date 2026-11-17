// Costo del logo de cada producto (pedido de Rodrigo del 17/11/2026): lo que se tomó para el logo en la cotización del
// STP, para que Producción sepa con cuánto cuenta. Son valores por unidad: el costo del logo y el setup prorrateado (que
// ya viene dividido por la cantidad en el STP). Los manda scripts/stp-costos-logo.mjs desde dos exports del STP:
//   · «cotizaciones_modo_costos»: LOGOS y SETUP que cargó la vendedora (existe desde septiembre de 2026);
//   · «pedidos_sku_formas»: COSTO EXTRA (el logo) y SETUP PRORRATEADO de cada SKU del pedido confirmado, para los que
//     no están en el modo costos.
// Es la misma regla que usa el tablero de Formas para el costo teórico (formas-tablero, claude/comisiones.py).
import type { Env } from './env';
import { HttpError } from './env';
import { clavePedido } from './totales';
import { palabras } from './productos';

export interface CostoLogo { logo: number; setup: number; cantidad: number | null; fuente: 'costos' | 'pedido' }
export interface CostosLogoEstado { recibidos: number; pedidos: number; total: number; at: string }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const skuLimpio = (s: unknown) => String(s ?? '').replace(/\\/g, '').trim().toUpperCase().replace(/\s+/g, ' ');

// {filas: [["PEDVTASTP - 31277", "SKU", "Nombre", cantidad, logo, setup, "costos" | "pedido"], …]}: los de cada pedido que
// llega reemplazan a los que tenía; ["PEDVTASTP - 31277"] solo, los borra. Los productos de un pedido vienen juntos.
export async function aplicarCostosLogo(env: Env, body: { filas?: unknown }): Promise<CostosLogoEstado> {
  if (!Array.isArray(body?.filas)) throw new HttpError(400, 'Falta filas: [["PEDVTASTP - 31277", "SKU", "Nombre", 100, 1500, 200, "costos"], …].');
  const porPedido = new Map<string, unknown[][]>();
  for (const f of body.filas as unknown[]) {
    if (!Array.isArray(f)) continue;
    const pedido = clavePedido(f[0]);
    if (!pedido) continue;
    const lista = porPedido.get(pedido) ?? [];
    porPedido.set(pedido, lista);
    const sku = skuLimpio(f[1]);
    if (!sku || sku.length > 120) continue;
    const cant = Number(f[3]);
    lista.push([pedido, lista.length, sku, String(f[2] ?? '').trim().slice(0, 200), Number.isFinite(cant) && cant > 0 ? cant : null,
      num(f[4]), num(f[5]), f[6] === 'costos' ? 'costos' : 'pedido']);
  }
  const db = env.DB;
  const pedidos = [...porPedido.keys()];
  const filas = [...porPedido.values()].flat();
  const tandas = [];
  for (let i = 0; i < pedidos.length; i += 1000) {
    tandas.push(db.prepare('DELETE FROM stp_costos_logo WHERE pedido IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pedidos.slice(i, i + 1000))));
  }
  for (let i = 0; i < filas.length; i += 1000) {
    tandas.push(db.prepare(`INSERT INTO stp_costos_logo (pedido, pos, sku, nombre, cantidad, logo, setup, fuente)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
        json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]') FROM json_each(?)`).bind(JSON.stringify(filas.slice(i, i + 1000))));
  }
  if (tandas.length) await db.batch(tandas);
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM stp_costos_logo').first<{ n: number }>())?.n ?? 0;
  const estado = { recibidos: filas.length, pedidos: pedidos.length, total, at: new Date().toISOString() };
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('costos_logo_stp', ?)").bind(JSON.stringify(estado)).run();
  return estado;
}

// El costo del logo de cada artículo de Producción: por el PDV de Finnegans de su pedido y su SKU. Si el SKU se repite en
// el pedido (los genéricos «PICPS_GE_6000», o el mismo producto con dos logos), el de la misma cantidad y, si no, el
// que más se parece por el nombre. `skus`: el SKU de cada artículo (skusDeArticulos en notasproducto.ts).
export async function costosLogoDeArticulos(db: D1Database, arts: Array<{ task_id: string; record_id: number | null; nombre: string; cantidad: number | null }>,
  skus: Map<string, string>) {
  const out = new Map<string, CostoLogo>();
  const ids = [...new Set(arts.map((a) => a.record_id).filter((x): x is number => x != null))];
  if (!ids.length) return out;
  const pedidos = (await db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido FROM records WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<{ id: number; pedido: string | null }>()).results;
  const claveDe = new Map(pedidos.map((p) => [p.id, clavePedido(p.pedido)]).filter((x): x is [number, string] => !!x[1]));
  if (!claveDe.size) return out;
  type Fila = { pedido: string; sku: string; nombre: string; cantidad: number | null; logo: number; setup: number; fuente: 'costos' | 'pedido' };
  const filas = (await db.prepare('SELECT pedido, sku, nombre, cantidad, logo, setup, fuente FROM stp_costos_logo WHERE pedido IN (SELECT value FROM json_each(?)) ORDER BY pedido, pos')
    .bind(JSON.stringify([...new Set(claveDe.values())])).all<Fila>()).results;
  const dePedido = new Map<string, Fila[]>();
  for (const f of filas) { const l = dePedido.get(f.pedido) ?? []; l.push(f); dePedido.set(f.pedido, l); }
  const usadas = new Map<string, Set<Fila>>();
  for (const a of arts) {
    const clave = a.record_id != null ? claveDe.get(a.record_id) : undefined;
    const sku = skuLimpio(skus.get(a.task_id));
    if (!clave || !sku) continue;
    const usadasP = usadas.get(clave) ?? new Set<Fila>();
    usadas.set(clave, usadasP);
    const cand = (dePedido.get(clave) ?? []).filter((f) => f.sku === sku && !usadasP.has(f));
    if (!cand.length) continue;
    const pal = palabras(a.nombre);
    const parecido = (f: Fila) => [...palabras(f.nombre)].filter((w) => pal.has(w)).length;
    const elegida = cand.length === 1 ? cand[0]
      : [...cand].sort((x, y) => Number(y.cantidad === a.cantidad) - Number(x.cantidad === a.cantidad) || parecido(y) - parecido(x))[0];
    usadasP.add(elegida);
    out.set(a.task_id, { logo: elegida.logo, setup: elegida.setup, cantidad: elegida.cantidad, fuente: elegida.fuente });
  }
  return out;
}
