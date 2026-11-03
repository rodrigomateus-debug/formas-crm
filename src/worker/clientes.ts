import type { Ctx, Env, User } from './env';
import { HttpError } from './env';
import { updateRecord } from './records';

// Compras de cada cliente (Finnegans → empresas del CRM). El cálculo pesado (años de pedidos, dólar MEP, estado del
// cliente) lo hace scripts/clientes.mjs en GitHub Actions cada noche; acá solo se le da la lista de empresas, el
// histórico de facturas anterior a Finnegans y se aplican los resultados. Ver docs/CLIENTES.md.

export const PROPS_COMPRAS = ['estado_cliente', 'fecha_ultima_compra', 'fecha_primera_compra', 'cantidad_de_compras', 'compra_historica_usd',
  'compra_12m_usd', 'ticket_promedio_usd', 'cada_cuanto_compra', 'saldo_pendiente', 'saldo_vencido', 'vendedora_finnegans', 'unidad_finnegans'];
// Datos de facturación que se completan si la empresa no los tiene (nunca se pisan).
const COMPLETAR = ['cuit', 'codigo_de_finnegans', 'razon_social'];

export async function empresasParaCruce(db: D1Database) {
  const { results } = await db.prepare(`SELECT id, name, json_extract(props, '$.cuit') AS cuit, json_extract(props, '$.codigo_de_finnegans') AS codigo,
      json_extract(props, '$.razon_social') AS razon_social, json_extract(props, '$.estado_cliente') AS estado
    FROM records WHERE object_type = 'company' AND archived = 0`).all();
  return results;
}

export async function historico(db: D1Database) {
  const { results } = await db.prepare('SELECT fecha, cuit, cliente, tipo, neto FROM compras_historicas ORDER BY fecha').all();
  return results;
}

export async function guardarHistorico(db: D1Database, rows: Array<{ fecha: string; cuit?: string | null; cliente: string; tipo: string; neto: number }>) {
  if (!Array.isArray(rows)) throw new HttpError(400, 'Falta rows.');
  const ok = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.fecha) && r.cliente && r.tipo && Number.isFinite(Number(r.neto)));
  const stmts = [db.prepare('DELETE FROM compras_historicas'), ...ok.map((r) =>
    db.prepare('INSERT INTO compras_historicas (fecha, cuit, cliente, tipo, neto) VALUES (?, ?, ?, ?, ?)').bind(r.fecha, r.cuit || null, r.cliente, r.tipo, Number(r.neto)))];
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  return { guardadas: ok.length, descartadas: rows.length - ok.length };
}

interface Update { id: number; props: Record<string, unknown>; completar?: Record<string, unknown> }

export async function aplicarCompras(env: Env, body: { updates?: Update[]; limpiar?: number[]; resumen?: Record<string, unknown> }) {
  const db = env.DB;
  const sys = await db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY (email = ?) DESC, id LIMIT 1").bind(env.ADMIN_EMAIL ?? '').first<User>();
  const ctx: Ctx = { user: sys!, source: 'finnegans', sourceDetail: 'Compras de clientes' };
  let actualizadas = 0, completadas = 0, limpiadas = 0;
  for (const u of body.updates ?? []) {
    const props: Record<string, unknown> = {};
    for (const k of PROPS_COMPRAS) if (k in u.props) props[k] = u.props[k];
    const row = await db.prepare("SELECT props FROM records WHERE id = ? AND object_type = 'company' AND archived = 0").bind(u.id).first<{ props: string }>();
    if (!row) continue;
    const cur = JSON.parse(row.props) as Record<string, unknown>;
    for (const k of COMPLETAR) {
      const v = u.completar?.[k];
      if (v != null && v !== '' && (cur[k] == null || cur[k] === '')) { props[k] = v; completadas++; }
    }
    const before = JSON.stringify(PROPS_COMPRAS.map((k) => cur[k] ?? null));
    await updateRecord(db, ctx, 'company', u.id, props, { system: true, strict: false });
    if (before !== JSON.stringify(PROPS_COMPRAS.map((k) => props[k] ?? cur[k] ?? null))) actualizadas++;
  }
  // Empresas que tenían compras calculadas y ya no cruzan con ningún cliente (por ejemplo, se corrigió el CUIT).
  for (const id of body.limpiar ?? []) {
    await updateRecord(db, ctx, 'company', id, Object.fromEntries(PROPS_COMPRAS.map((k) => [k, null])), { system: true, strict: false }).catch(() => undefined);
    limpiadas++;
  }
  if (body.resumen) {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clientes_estado', ?)").bind(JSON.stringify({ ...body.resumen, at: new Date().toISOString() })).run();
  }
  return { actualizadas, completadas, limpiadas };
}
