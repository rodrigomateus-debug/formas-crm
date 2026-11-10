import type { Ctx, Env, User } from './env';
import { updateRecord } from './records';
import { Budget, OutOfBudget } from './budget';

// Facturas de los pedidos, desde Finnegans (solo lectura). Cada hora, por cada pedido con su pedido de Finnegans
// (`pedido_finnegans`, que trae ClickUp), el reporte de documentos destino dice qué facturas tiene, también las que
// pasan por un remito (Corporate). Cuando una factura ya tiene CAE («está lista») queda en el pedido con su número;
// el PDF lo baja aparte una tarea de GitHub (scripts/facturas-pdf.mjs), porque Finnegans lo da solo con sesión de GO.

const API = (env: Env) => env.FINNEGANS_API_URL ?? 'https://api.finneg.com/api';
const POR_CORRIDA = 40;
const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const ENTREGADO = '1237498998';

export async function finnegansToken(env: Env, b?: Budget) {
  if (!env.FINNEGANS_CLIENT_ID || !env.FINNEGANS_CLIENT_SECRET) return null;
  b?.take();
  const url = new URL(`${API(env)}/oauth/token`);
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', env.FINNEGANS_CLIENT_ID);
  url.searchParams.set('client_secret', env.FINNEGANS_CLIENT_SECRET);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnegans token: HTTP ${res.status}`);
  return (await res.text()).trim().replace(/^"|"$/g, '');
}

async function fin<T>(env: Env, token: string, path: string, params: Record<string, string> = {}, b?: Budget): Promise<T | null> {
  b?.take();
  const url = new URL(`${API(env)}/${path}`);
  for (const [k, v] of Object.entries({ ...params, ACCESS_TOKEN: token })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Finnegans ${path.split('/')[0]}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ClickUp trae «PEDVTASTP - 31277»; Finnegans lo guarda como «PEDVTASTP - 00031277» (Shop y Corporate) o tal cual (NoEstres).
export function pedidoIds(p: string) {
  const m = p.match(/^([A-Z]+)\s*-\s*(\d+)$/);
  if (!m) return [p];
  const padded = `${m[1]} - ${m[2].padStart(8, '0')}`;
  const plain = `${m[1]} - ${Number(m[2])}`;
  return m[1] === 'PEDVTANE' ? [plain, padded] : [padded, plain];
}

export interface PedidoVenta {
  Cliente?: string; MonedaCodigo?: string;
  Items?: Array<{ ProductoCodigo?: string; Cantidad?: number; Precio?: number; Descuento1?: number; Descuento2?: number; Descripcion?: string; IncluyeImpuesto?: boolean }>;
}

// El pedido de venta, con sus renglones.
export async function finnegansPedidoVenta(env: Env, token: string, pedido: string, b?: Budget) {
  for (const id of pedidoIds(pedido)) {
    const p = await fin<PedidoVenta>(env, token, `pedidoVenta/${encodeURIComponent(id)}`, {}, b);
    if (p?.Cliente) return p;
  }
  return null;
}

// La ficha de un producto: nombre, descripción y foto.
export async function finnegansProducto(env: Env, token: string, code: string, b?: Budget) {
  return fin<{ Nombre?: string; Descripcion?: string; ProductoImagen?: string }>(env, token, `producto/${encodeURIComponent(code)}`, {}, b);
}

// Cliente del pedido (para asociar la empresa por CUIT).
export async function finnegansPedido(env: Env, token: string, pedido: string, b?: Budget) {
  const p = await finnegansPedidoVenta(env, token, pedido, b);
  if (!p?.Cliente) return null;
  const c = await fin<{ IdentificacionTributariaNumero?: string; RazonSocial?: string }>(env, token, `cliente/${encodeURIComponent(p.Cliente)}`, {}, b);
  return { cliente: p.Cliente, cuit: c?.IdentificacionTributariaNumero ?? null, razon: c?.RazonSocial ?? null };
}

interface Destino {
  DESTINONOMBRE: string; DESTINOIDENTIFICACIONEXTERNA: string; DESTINOTRANSACCIONID: number; TIPODOCUMENTO: string;
  CATEGORIATIPODOCUMENTO: number; DESTINOIMPORTETOTAL: number; OBTUVOCAE: string; DESTINOFECHA: string;
}

// Facturas con CAE de un pedido (directas o a través de un remito). Las notas de crédito y débito no cuentan.
// Una sola consulta, con el número como lo guarda Finnegans (verificado con pedidos reales de cada unidad).
export async function facturasDelPedido(env: Env, token: string, pedido: string, b?: Budget) {
  const rows = await fin<Destino[]>(env, token, 'reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals', { PARAMWEBREPORT_IdentificacionExternaOrigen: pedidoIds(pedido)[0] }, b);
  return (rows ?? []).filter((r) => r.CATEGORIATIPODOCUMENTO === -8 && r.OBTUVOCAE === 'SI' && !/^(NC|ND)/.test(r.TIPODOCUMENTO));
}

// Remitos de un pedido según Finnegans (los documentos destino de tipo remito), con el número para comparar con el
// impreso («R-0001-00027857» → 27857). Sirve para confirmar que una foto de remito es de ese pedido (remitos.ts).
export async function finnegansRemitos(env: Env, token: string, pedido: string, b?: Budget) {
  const rows = await fin<Destino[]>(env, token, 'reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals', { PARAMWEBREPORT_IdentificacionExternaOrigen: pedidoIds(pedido)[0] }, b);
  return (rows ?? []).filter((r) => /REM/i.test(r.TIPODOCUMENTO ?? '')).map((r) => {
    // Cualquiera de los números del nombre o de la identificación («FPREMVTA - 00027857 1» → 27857 y 1).
    const numeros = [...new Set((`${r.DESTINONOMBRE ?? ''} ${r.DESTINOIDENTIFICACIONEXTERNA ?? ''}`.match(/\d{3,}/g) ?? []).map(Number))];
    return { nombre: r.DESTINONOMBRE, numeros, fecha: r.DESTINOFECHA };
  });
}

export interface FinnegansState { cursor?: number; at?: string; revisados?: number; facturas?: number; error?: string | null }

export async function finnegansState(db: D1Database): Promise<FinnegansState> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'finnegans_state'").first<{ value: string }>();
  return r ? JSON.parse(r.value) : {};
}

export async function syncFacturas(env: Env) {
  const db = env.DB;
  const state = await finnegansState(db);
  const out: FinnegansState = { ...state, at: new Date().toISOString(), revisados: 0, facturas: 0, error: null };
  const b = Budget.of(env);
  try {
    const token = await finnegansToken(env, b);
    if (!token) return { skipped: 'Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.' };
    // Pedidos de los últimos 4 meses que no están anulados ni entregados y facturados; se recorren de a tandas (cursor
    // por id) y se vuelve a empezar.
    const pick = (after: number) => db.prepare(`SELECT id, props FROM records WHERE object_type = 'order' AND archived = 0 AND id > ?
      AND json_extract(props, '$.pedido_finnegans') IS NOT NULL AND COALESCE(json_extract(props, '$.hs_pipeline_stage'), '') != ?
      AND NOT (json_extract(props, '$.hs_pipeline_stage') = ? AND json_extract(props, '$.factura_numero') IS NOT NULL)
      AND updated_at >= ? ORDER BY id LIMIT ?`).bind(after, ANULADO, ENTREGADO, new Date(Date.now() - 120 * 86_400_000).toISOString(), POR_CORRIDA).all<{ id: number; props: string }>();
    let rows = (await pick(state.cursor ?? 0)).results;
    if (!rows.length && state.cursor) rows = (await pick(0)).results;
    const sys = await db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<User>();
    const ctx: Ctx = { user: sys!, source: 'finnegans', sourceDetail: 'Facturas' };
    for (const r of rows) {
      const props = JSON.parse(r.props) as Record<string, string>;
      const facturas = await facturasDelPedido(env, token, props.pedido_finnegans, b);
      for (const f of facturas) {
        const known = await db.prepare("SELECT id FROM files WHERE record_id = ? AND source = 'finnegans' AND source_ref = ?").bind(r.id, f.DESTINOIDENTIFICACIONEXTERNA).first();
        if (known) continue;
        const det = await fin<{ NumeroComprobante?: string; Fecha?: string; CAE?: string; CAEFechaVto?: string; RazonSocial?: string }>(
          env, token, `facturaVenta/${encodeURIComponent(f.DESTINOIDENTIFICACIONEXTERNA)}`, {}, b);
        const numero = det?.NumeroComprobante ?? f.DESTINONOMBRE;
        await db.prepare(`INSERT OR IGNORE INTO files (record_id, kind, name, mime, source, source_ref, meta) VALUES (?, 'factura', ?, 'application/pdf', 'finnegans', ?, ?)`)
          .bind(r.id, `Factura ${numero}.pdf`, f.DESTINOIDENTIFICACIONEXTERNA, JSON.stringify({
            numero, documento: f.DESTINONOMBRE, fecha: det?.Fecha ?? null, cae: det?.CAE ?? null, cae_vto: det?.CAEFechaVto ?? null,
            total: f.DESTINOIMPORTETOTAL, razon_social: det?.RazonSocial ?? null, transaccion_id: f.DESTINOTRANSACCIONID, empresa: 'EMPRE01',
          })).run();
        await updateRecord(db, ctx, 'order', r.id, { factura_numero: numero }, { system: true, strict: false });
        out.facturas!++;
      }
      // El pedido queda revisado recién cuando están todas sus facturas (si se corta antes, se repite en la próxima).
      out.revisados!++;
      out.cursor = r.id;
    }
    if (rows.length < POR_CORRIDA) out.cursor = 0;
  } catch (e) {
    if (!(e instanceof OutOfBudget)) out.error = (e as Error).message;
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('finnegans_state', ?)").bind(JSON.stringify(out)).run();
  return out;
}
