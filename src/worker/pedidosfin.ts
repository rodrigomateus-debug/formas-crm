import type { Ctx, Env, User } from './env';
import { Meta } from './meta';
import { createRecord, updateRecord } from './records';
import { STAGE, usuarioPorNombre } from './clickup';
import { resolverEmpresa, soloNumeros } from './razones';
import { clavePedido } from './totales';
import { numeroPdv, vincularPedido, vincularPendientes } from './vinculos';
import { finnegansToken, type PedidoVenta } from './finnegans';
import { Budget } from './budget';

// Pedidos desde Finnegans (pedido de Rodrigo del 13/11/2026). El pedido se carga desde el cotizador, queda en Finnegans y
// de ahí va a ClickUp; el CRM se enteraba recién cuando ClickUp creaba el PDV. Ahora el pedido se da de alta con lo que
// trae el informe de pedidos de venta de Finnegans, el mismo que ya se baja cada hora para los totales
// (scripts/pedidos-totales.mjs): no suma ninguna consulta a Finnegans, que cobra por cantidad.
//
// Mientras se siga usando ClickUp, el pedido llega por los dos lados y no se duplica: la llave es el pedido de Finnegans
// («PEDVTASTP - 31277») o, si no lo tiene, el número de PDV en la misma unidad. El que llega primero lo crea; el otro lo
// completa (la sincronización de ClickUp busca por número de PDV y le suma el link del PDV y el estado de producción).

// La unidad sale del tipo de documento. Mercado Libre, MarketShell y los objetivos de venta no son pedidos del CRM.
const UNIDAD: Record<string, string> = { PEDVTASTP: 'FORMAS SHOP', PEDVTAFP: 'CORPORATE', PEDVTANE: 'NO ESTRÉS' };

export interface PedidoFin { cliente?: string; cuit?: string; vendedor?: string; fecha?: string; entrega?: string; evento?: boolean }
export interface PedidosEstado { recibidos: number; creados: number; completados: number; con_negocio: number; duplicados: number; at: string }

const fecha = (s: unknown) => { const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/) ?? null; return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

// {"PEDVTASTP - 31277": {cliente, cuit, vendedor, fecha, entrega, evento}, …}: los pedidos recientes y no anulados de
// Formas Publicitarias. Crea los que no están y completa el pedido de Finnegans y la unidad de los que sí.
export async function aplicarPedidos(env: Env, pedidos: Record<string, PedidoFin>): Promise<PedidosEstado> {
  const db = env.DB;
  const sys = await db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<User>();
  const ctx: Ctx = { user: sys!, source: 'finnegans', sourceDetail: 'Pedidos de venta' };
  const out: PedidosEstado = { recibidos: 0, creados: 0, completados: 0, con_negocio: 0, duplicados: 0, at: new Date().toISOString() };
  const entradas = Object.entries(pedidos ?? {}).map(([k, p]) => ({ clave: clavePedido(k), p })).filter((x): x is { clave: string; p: PedidoFin } => !!x.clave && !!UNIDAD[x.clave.split(' - ')[0]]);
  out.recibidos = entradas.length;
  if (entradas.length) {
    const existentes = (await db.prepare(`SELECT id, json_extract(props, '$.pedido_finnegans') AS pedido, json_extract(props, '$.pdv_finnegans') AS pdv,
        json_extract(props, '$.unidad_de_negocio') AS unidad, COALESCE(json_extract(props, '$.razon_social'), '') != '' AS con_razon
        FROM records WHERE object_type = 'order' AND archived = 0`)
      .all<{ id: number; pedido: string | null; pdv: string | number | null; unidad: string | null; con_razon: number }>()).results;
    const conRazon = new Set(existentes.filter((e) => e.con_razon).map((e) => e.id));
    // La razón social y el CUIT con que se factura (razones.ts): a los pedidos que ya estaban (los de ClickUp) se les suma
    // la primera vez, y con eso se resuelve su empresa.
    const facturacion = (pf: PedidoFin) => { const c = soloNumeros(pf.cuit); const rz = String(pf.cliente ?? '').trim(); return { ...(rz ? { razon_social: rz } : {}), ...(c.length === 11 ? { cuit: c } : {}) }; };
    const completarRazon = async (id: number, pf: PedidoFin, mas: Record<string, unknown> = {}) => {
      const datos = { ...mas, ...(conRazon.has(id) ? {} : facturacion(pf)) };
      if (!Object.keys(datos).length) return;
      await updateRecord(db, ctx, 'order', id, datos, { system: true, strict: false });
      conRazon.add(id);
      await resolverEmpresa(db, ctx, id).catch(() => undefined);
    };
    const porClave = new Map<string, number>();
    const porNumero = new Map<number, typeof existentes>();
    for (const e of existentes) {
      const c = clavePedido(e.pedido);
      if (c) porClave.set(c, e.id);
      const n = numeroPdv(e.pdv);
      if (n) porNumero.set(n, [...(porNumero.get(n) ?? []), e]);
    }
    const users = (await db.prepare('SELECT id, name, email FROM users WHERE active = 1').all<{ id: number; name: string; email: string }>()).results;
    const pipeline = (await new Meta(db).property('order', 'hs_pipeline'))?.options[0]?.value;
    for (const { clave, p } of entradas) {
      const [tipo, num] = clave.split(' - ');
      const n = Number(num);
      const unidad = UNIDAD[tipo];
      if (porClave.has(clave)) { await completarRazon(porClave.get(clave)!, p); continue; }
      // El mismo número de PDV en la misma unidad, todavía sin su pedido de Finnegans (cargado a mano o traído de ClickUp sin
      // el dato): es este. El mismo número en otra unidad es otro pedido (cada unidad tiene su numeración).
      const mismo = (porNumero.get(n) ?? []).find((e) => !clavePedido(e.pedido) && (!e.unidad || e.unidad.toUpperCase() === unidad));
      if (mismo) {
        await completarRazon(mismo.id, p, { pedido_finnegans: `${tipo} - ${n}`, ...(mismo.unidad ? {} : { unidad_de_negocio: unidad }) });
        porClave.set(clave, mismo.id);
        out.completados++;
        continue;
      }
      const cliente = String(p.cliente ?? '').trim();
      const row = await createRecord(db, ctx, 'order', {
        hs_order_name: `PDV ${n}${cliente ? ` · ${cliente}` : ''}`, pdv_finnegans: String(n), pedido_finnegans: `${tipo} - ${n}`, unidad_de_negocio: unidad,
        cliente_clickup: cliente || null, ...facturacion(p), hs_pipeline_stage: STAGE.confirmado, hs_pipeline: pipeline ?? null, tipo_de_pedido: p.evento ? 'EVENTO' : 'PEDIDO NORMAL',
        fecha_de_entrega: fecha(p.entrega),
        // El vendedor viene como nombre (informe) o como mail (el pedido de Finnegans de la tienda).
        owner_id: usuarioPorNombre(users, /@/.test(p.vendedor ?? '') ? '' : String(p.vendedor ?? ''), /@/.test(p.vendedor ?? '') ? String(p.vendedor) : '') ?? null,
      }, { system: true, strict: false, createdAt: fecha(p.fecha) ? `${fecha(p.fecha)}T12:00:00.000Z` : undefined });
      porClave.set(clave, row.id);
      porNumero.set(n, [...(porNumero.get(n) ?? []), { id: row.id, pedido: `${tipo} - ${n}`, pdv: String(n), unidad, con_razon: 1 }]);
      conRazon.add(row.id);
      out.creados++;
      // Su empresa, por el CUIT (razones.ts); con ella se busca su negocio (vinculos.ts), y si el negocio ya tenía otra
      // empresa, queda esa.
      await resolverEmpresa(db, ctx, row.id).catch(() => undefined);
      if (await vincularPedido(db, ctx, row.id).catch(() => null)) out.con_negocio++;
    }
  }
  // Los que siguen sin negocio (el número se cargó después en el negocio, o entraron por ClickUp).
  out.con_negocio += (await vincularPendientes(db, ctx)).asociados;
  out.duplicados = (await pedidosDuplicados(db)).length;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pedidos_finnegans', ?)").bind(JSON.stringify(out)).run();
  return out;
}

// Control: pedidos repetidos (el mismo pedido de Finnegans, o el mismo número de PDV en la misma unidad). No debería haber:
// si aparece alguno, se combinan desde la lista de pedidos.
export async function pedidosDuplicados(db: D1Database) {
  const { results } = await db.prepare(`SELECT id, name, json_extract(props, '$.pedido_finnegans') AS pedido, json_extract(props, '$.pdv_finnegans') AS pdv,
      json_extract(props, '$.unidad_de_negocio') AS unidad, created_at FROM records WHERE object_type = 'order' AND archived = 0
      AND (json_extract(props, '$.pdv_finnegans') IS NOT NULL OR json_extract(props, '$.pedido_finnegans') IS NOT NULL)`)
    .all<{ id: number; name: string; pedido: string | null; pdv: string | number | null; unidad: string | null; created_at: string }>();
  const grupos = new Map<string, typeof results>();
  for (const r of results) {
    const c = clavePedido(r.pedido);
    const n = numeroPdv(r.pdv);
    // Con pedido de Finnegans, por él; si no, por número y unidad. Un pedido sin el dato se compara con los dos.
    const llaves = c ? [`p|${c}`] : n ? [`n|${n}|${(r.unidad ?? '').toUpperCase()}`] : [];
    if (c && n) llaves.push(`n|${n}|${(r.unidad ?? '').toUpperCase()}`);
    for (const k of llaves) grupos.set(k, [...(grupos.get(k) ?? []), r]);
  }
  const vistos = new Set<string>();
  const out: Array<{ pdv: string; pedidos: Array<{ id: number; name: string; created_at: string }> }> = [];
  for (const [k, g] of grupos) {
    if (g.length < 2) continue;
    // En la llave por número, dos pedidos con distinto pedido de Finnegans no son el mismo.
    const distintos = k.startsWith('n|') && new Set(g.map((r) => clavePedido(r.pedido)).filter(Boolean)).size === g.length;
    const firma = g.map((r) => r.id).sort().join(',');
    if (distintos || vistos.has(firma)) continue;
    vistos.add(firma);
    out.push({ pdv: k.split('|')[1], pedidos: g.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at })) });
  }
  return out;
}

// ---------- Aviso de Finnegans (webhook) ----------
// Finnegans llama a una dirección cuando se crea, cambia o anula un documento (un «proceso» de tipo Transacción en modo
// Webhook; el de Formas es FORMAS_HUB_PEDIDOS, para los pedidos de venta de Shop, Corporate y No Estrés). Con eso el
// pedido entra al CRM en el momento, sin esperar el informe de cada hora. Avisa también cuando el pedido se carga por
// API, como hace el cotizador (probado el 13/11/2026). Lo que manda:
//   POST …?access_token=<token de Finnegans>&async=1
//   {"eventID": 318950, "webhook": "FORMAS_HUB_PEDIDOS", "webhookType": "Documento", "user": "…", "timeStamp": "…",
//    "object": {"type": "PEDVTASTP", "category": "PDV", "code": "<IdentificacionExterna>", "event": "create"}, "sucursal": "7"}
// `object.code` es la identificación externa del pedido: con ella se lee el pedido de Finnegans (tres consultas: token,
// pedido y cliente) y, si es de Formas Publicitarias (no de FP DEMO) y el CRM no lo tiene, se da de alta. Los demás
// eventos (anulación, cambios) por ahora solo quedan en el registro de entradas.
const FIN_API = (env: Env) => env.FINNEGANS_API_URL ?? 'https://api.finneg.com/api';
interface AvisoFin { object?: { type?: string; category?: string; code?: string; event?: string } }
export async function avisoDeFinnegans(env: Env, cuerpo: string) {
  let aviso: AvisoFin = {};
  try { aviso = JSON.parse(cuerpo) as AvisoFin; } catch { /* no es JSON: solo queda registrado */ }
  const o = aviso.object ?? {};
  const tipo = String(o.type ?? '').toUpperCase();
  const ie = String(o.code ?? '').trim();
  if (!UNIDAD[tipo] || !ie) return { evento: o.event ?? null, pedido: null, hecho: 'no es un pedido de venta del CRM' };
  if (o.event !== 'create') return { evento: o.event ?? null, pedido: ie, hecho: 'solo registrado' };
  const b = Budget.of(env);
  const token = await finnegansToken(env, b);
  if (!token) return { evento: o.event, pedido: ie, hecho: 'falta conectar Finnegans' };
  const leer = async <T>(path: string) => { b.take(); const r = await fetch(`${FIN_API(env)}/${path}?ACCESS_TOKEN=${encodeURIComponent(token)}`); return r.ok ? (await r.json()) as T : null; };
  const p = await leer<PedidoVenta & { EmpresaCodigo?: string; NumeroInterno?: number }>(`pedidoVenta/${encodeURIComponent(ie)}`);
  if (!p?.Cliente || !p.NumeroInterno) return { evento: o.event, pedido: ie, hecho: 'Finnegans no devolvió el pedido' };
  // FP DEMO y Soutex usan los mismos tipos de documento: solo los de Formas Publicitarias.
  if (p.EmpresaCodigo !== 'EMPRE01') return { evento: o.event, pedido: ie, hecho: `de otra empresa (${p.EmpresaCodigo ?? 'sin empresa'}): no se carga` };
  const cli = await leer<{ IdentificacionTributariaNumero?: string; RazonSocial?: string }>(`cliente/${encodeURIComponent(p.Cliente)}`);
  const clave = `${tipo} - ${p.NumeroInterno}`;
  const nuevos = await aplicarPedidos(env, { [clave]: { cliente: cli?.RazonSocial ?? '', cuit: cli?.IdentificacionTributariaNumero ?? '', vendedor: p.VendedorCodigo ?? '',
    fecha: p.Fecha, entrega: p.USR_FechaEntrega, evento: !!p.USR_EsEvento } });
  return { evento: o.event, pedido: clave, hecho: nuevos.creados ? 'dado de alta' : nuevos.completados ? 'completado' : 'ya estaba', nuevos };
}
