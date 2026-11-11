import type { Ctx } from './env';
import { now } from './env';

// Tipo de relación de contactos y empresas (pedido de Rodrigo del 11/11/2026): para que los proveedores, el equipo de
// Formas y otros (bancos, transporte, estudios…) no se mezclen con los clientes y prospectos. Vacío = cliente. Las listas
// de contactos y empresas muestran por defecto solo clientes y prospectos (filtro «__relacion» en records.ts).
//
// - Equipo Formas, solo: el contacto con mail de un dominio de Formas (los «internos» de la configuración de Gmail) o de
//   un usuario del CRM, y la empresa con dominio de Formas.
// - El contacto hereda el tipo de su empresa principal: al asociarlo, si no tiene uno propio; y cuando se le cambia el
//   tipo a la empresa, a sus contactos que no tienen uno propio distinto.

export const RELACIONES = ['cliente', 'proveedor', 'equipo', 'otro'] as const;
export const DOMINIOS_FORMAS = ['formaspublicitarias.com', 'formas.ar', 'soutex.com.ar'];
type Props = Record<string, unknown>;
const vacio = (v: unknown) => v == null || v === '';

async function dominiosFormas(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'gmail'").first<{ value: string }>();
  try {
    const d = row ? (JSON.parse(row.value) as { internal_domains?: string[] }).internal_domains : null;
    if (Array.isArray(d) && d.length) return d.map((x) => String(x).toLowerCase());
  } catch { /* configuración rota: los de siempre */ }
  return DOMINIOS_FORMAS;
}

// El tipo que le corresponde solo a un contacto o una empresa (o null si no se sabe: queda como cliente).
export async function relacionSola(db: D1Database, type: string, props: Props): Promise<string | null> {
  if (type === 'contact') {
    const email = String(props.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return null;
    if ((await dominiosFormas(db)).includes(email.split('@')[1])) return 'equipo';
    if (await db.prepare('SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1').bind(email).first()) return 'equipo';
    return null;
  }
  if (type === 'company') {
    const dominio = String(props.domain ?? '').trim().toLowerCase().replace(/^www\./, '');
    return dominio && (await dominiosFormas(db)).includes(dominio) ? 'equipo' : null;
  }
  return null;
}

// Cambia el tipo de varios contactos (sin pasar por updateRecord: no hay más reglas que aplicar), con su historial.
async function ponerRelacion(db: D1Database, ctx: Ctx, cambios: Array<{ id: number; antes: string | null; ahora: string | null }>) {
  if (!cambios.length) return;
  const ts = now();
  await db.batch(cambios.flatMap((c) => [
    db.prepare(`UPDATE records SET props = CASE WHEN ?1 IS NULL THEN json_remove(props, '$.tipo_de_relacion') ELSE json_set(props, '$.tipo_de_relacion', ?1) END
      WHERE id = ?2`).bind(c.ahora, c.id),
    db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, 'tipo_de_relacion', ?, ?, ?, ?, ?)")
      .bind(c.id, c.antes, c.ahora, ts, ctx.user.id, ctx.source),
  ]));
}

// La empresa cambió de tipo: sus contactos (los que la tienen como principal) que no tenían tipo, o tenían el de antes
// de la empresa, pasan al nuevo. Un contacto con un tipo propio distinto lo conserva.
export async function propagarRelacion(db: D1Database, ctx: Ctx, companyId: number, antes: unknown, ahora: unknown) {
  const de = vacio(antes) ? '' : String(antes);
  const a = vacio(ahora) || ahora === 'cliente' ? null : String(ahora);
  const { results } = await db.prepare(`SELECT r.id, json_extract(r.props, '$.tipo_de_relacion') AS t FROM associations x
    JOIN records r ON r.id = x.from_id AND r.object_type = 'contact' AND r.archived = 0
    WHERE x.to_id = ? AND x.from_type = 'contact' AND x.is_primary = 1`).bind(companyId).all<{ id: number; t: string | null }>();
  await ponerRelacion(db, ctx, results.filter((r) => (vacio(r.t) || r.t === de) && (r.t ?? null) !== a).map((r) => ({ id: r.id, antes: r.t ?? null, ahora: a })));
}

// Un contacto se asocia a su empresa principal: si no tiene tipo y la empresa sí (proveedor, equipo u otro), lo hereda.
export async function heredarRelacion(db: D1Database, ctx: Ctx, contact: { id: number; props: string }, company: { props: string }) {
  const t = (JSON.parse(contact.props) as Props).tipo_de_relacion;
  const e = (JSON.parse(company.props) as Props).tipo_de_relacion;
  if (!vacio(t) || vacio(e) || e === 'cliente') return;
  await ponerRelacion(db, ctx, [{ id: contact.id, antes: null, ahora: String(e) }]);
}
