import type { Ctx } from './env';
import { HttpError } from './env';
import { associate, primaryCompanyId } from './associations';
import { createRecord, getRow } from './records';

// Razones sociales (pedido de Rodrigo del 13/11/2026). El pedido trae de Finnegans la razón social y el CUIT con que se
// factura. Una empresa del CRM puede tener varias razones sociales; cada CUIT es de una sola empresa. La empresa del
// pedido se decide así:
//   1. Si su negocio ya tiene una empresa, esa queda, aunque el pedido venga con otra razón social: esa razón social pasa
//      a ser una de las de esa empresa.
//   2. Si no, la empresa que ya tiene ese CUIT (en sus razones sociales). Queda también en el negocio, si tiene.
//   3. Si nadie tiene ese CUIT, no se adivina: el pedido (y su negocio) muestran la razón social como empresa sugerida,
//      para crearla, asignarla a una empresa que ya está, o crear una empresa con otro nombre que la tenga.

export const soloNumeros = (cuit: unknown) => String(cuit ?? '').replace(/\D/g, '');

interface Datos { id: number; razon: string | null; cuit: string; empresa: number | null; negocio: number | null; empresaNegocio: number | null }
async function datosDe(db: D1Database, orderId: number): Promise<Datos | null> {
  const o = await db.prepare(`SELECT r.id, json_extract(r.props, '$.razon_social') AS razon, json_extract(r.props, '$.cuit') AS cuit,
      (SELECT x.to_id FROM associations x JOIN records d ON d.id = x.to_id AND d.archived = 0 WHERE x.from_id = r.id AND x.to_type = 'deal' LIMIT 1) AS negocio
    FROM records r WHERE r.id = ? AND r.object_type = 'order' AND r.archived = 0`).bind(orderId).first<{ id: number; razon: string | null; cuit: string | null; negocio: number | null }>();
  if (!o) return null;
  return { id: o.id, razon: o.razon?.trim() || null, cuit: soloNumeros(o.cuit), negocio: o.negocio, empresa: await primaryCompanyId(db, o.id),
    empresaNegocio: o.negocio ? await primaryCompanyId(db, o.negocio) : null };
}
// De qué empresa es un CUIT: por sus razones sociales o, si todavía no está anotado, por el CUIT cargado en la empresa.
async function empresaDelCuit(db: D1Database, cuit: string) {
  if (cuit.length !== 11) return null;
  const z = await db.prepare('SELECT z.company_id FROM razones_sociales z JOIN records c ON c.id = z.company_id AND c.archived = 0 WHERE z.cuit = ?').bind(cuit).first<{ company_id: number }>();
  if (z) return z.company_id;
  const c = await db.prepare(`SELECT id FROM records WHERE object_type = 'company' AND archived = 0
    AND replace(replace(replace(COALESCE(json_extract(props, '$.cuit'), ''), '-', ''), ' ', ''), '.', '') = ? ORDER BY id LIMIT 1`).bind(cuit).first<{ id: number }>();
  return c?.id ?? null;
}
// Suma la razón social a la empresa. Si ese CUIT ya es de otra empresa, no lo mueve (devuelve de quién es).
async function sumarRazon(db: D1Database, ctx: Ctx, companyId: number, cuit: string, razon: string | null, origen: string) {
  if (cuit.length !== 11) return null;
  await db.batch([
    // Si quedó anotado en una empresa que ya no está (archivada o combinada), se libera.
    db.prepare("DELETE FROM razones_sociales WHERE cuit = ? AND company_id NOT IN (SELECT id FROM records WHERE object_type = 'company' AND archived = 0)").bind(cuit),
    db.prepare('INSERT OR IGNORE INTO razones_sociales (cuit, razon, company_id, origen, user_id) VALUES (?, ?, ?, ?, ?)').bind(cuit, razon ?? cuit, companyId, origen, ctx.user.id),
  ]);
  return empresaDelCuit(db, cuit);
}
const asociarEmpresa = (db: D1Database, ctx: Ctx, id: number, empresa: number) => associate(db, ctx, id, empresa, { primary: true }).catch(() => undefined);

// La empresa del pedido según las reglas de arriba. No crea empresas. Se puede llamar las veces que haga falta.
export async function resolverEmpresa(db: D1Database, ctx: Ctx, orderId: number) {
  const o = await datosDe(db, orderId);
  if (!o) return null;
  // 1. La empresa del negocio manda.
  if (o.empresaNegocio) {
    if (o.empresa !== o.empresaNegocio) await asociarEmpresa(db, ctx, o.id, o.empresaNegocio);
    await sumarRazon(db, ctx, o.empresaNegocio, o.cuit, o.razon, 'negocio');
    return o.empresaNegocio;
  }
  // 2. La empresa que el pedido ya tiene (se le suma la razón social) o, si no tiene, la que ya tiene ese CUIT.
  const empresa = o.empresa ?? (await empresaDelCuit(db, o.cuit));
  if (!empresa) return null;
  if (o.empresa !== empresa) await asociarEmpresa(db, ctx, o.id, empresa);
  await sumarRazon(db, ctx, empresa, o.cuit, o.razon, 'finnegans');
  if (o.negocio) await asociarEmpresa(db, ctx, o.negocio, empresa);
  return empresa;
}

// Para la ficha: del pedido (o del pedido de un negocio), la razón social y qué falta resolver; de una empresa, sus razones.
export async function razonSocialDe(db: D1Database, type: string, id: number) {
  if (type === 'company') {
    const { results } = await db.prepare('SELECT cuit, razon, origen, created_at FROM razones_sociales WHERE company_id = ? ORDER BY created_at').bind(id).all();
    return { razones: results };
  }
  let orderId: number | null = type === 'order' ? id : null;
  if (type === 'deal') {
    // El pedido del negocio con razón social; primero el que todavía no tiene empresa.
    orderId = (await db.prepare(`SELECT p.id FROM associations a JOIN records p ON p.id = a.to_id AND p.object_type = 'order' AND p.archived = 0
      WHERE a.from_id = ? AND a.to_type = 'order' AND COALESCE(json_extract(p.props, '$.razon_social'), '') != ''
      ORDER BY EXISTS (SELECT 1 FROM associations x WHERE x.from_id = p.id AND x.to_type = 'company'), p.created_at DESC LIMIT 1`).bind(id).first<{ id: number }>())?.id ?? null;
  }
  const o = orderId ? await datosDe(db, orderId) : null;
  if (!o || !o.razon) return { pedido: null };
  const duena = await empresaDelCuit(db, o.cuit);
  const nombre = async (cid: number | null) => (cid ? (await db.prepare('SELECT id, name FROM records WHERE id = ? AND archived = 0').bind(cid).first<{ id: number; name: string }>()) ?? null : null);
  return {
    pedido: { id: o.id, razon: o.razon, cuit: o.cuit || null },
    empresa: await nombre(o.empresa ?? o.empresaNegocio),            // la empresa del pedido (o de su negocio)
    de: await nombre(duena),                                         // de qué empresa es esa razón social, si ya está cargada
    sugerida: !o.empresa && !o.empresaNegocio,                       // sin empresa: se sugiere crearla o asignarla
  };
}

// Resolver a mano la razón social de un pedido sin empresa: crear la empresa con ese nombre, asignarla a una que ya está,
// o crear una empresa con otro nombre que la tenga. La empresa queda en el pedido y en su negocio.
export async function asignarRazon(db: D1Database, ctx: Ctx, orderId: number, body: { accion?: string; company_id?: number; name?: string }) {
  const o = await datosDe(db, orderId);
  if (!o?.razon) throw new HttpError(400, 'Este pedido no tiene razón social de Finnegans.');
  let empresa: number;
  if (body.accion === 'asignar') {
    const c = await getRow(db, Number(body.company_id), 'company').catch(() => null);
    if (!c) throw new HttpError(404, 'No existe esa empresa.');
    empresa = c.id;
  } else if (body.accion === 'crear' || body.accion === 'crear_con_nombre') {
    const name = body.accion === 'crear' ? o.razon : String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Falta el nombre de la empresa.');
    empresa = (await createRecord(db, ctx, 'company', { name, razon_social: o.razon, ...(o.cuit.length === 11 ? { cuit: o.cuit } : {}) }, { strict: false })).id;
  } else throw new HttpError(400, 'La acción es «crear», «asignar» o «crear_con_nombre».');
  const duena = await sumarRazon(db, ctx, empresa, o.cuit, o.razon, 'a mano');
  if (duena && duena !== empresa) {
    const d = await db.prepare('SELECT name FROM records WHERE id = ?').bind(duena).first<{ name: string }>();
    throw new HttpError(409, `Ese CUIT ya es una razón social de «${d?.name ?? duena}». Asigná el pedido a esa empresa, o combiná las dos empresas.`);
  }
  await asociarEmpresa(db, ctx, o.id, empresa);
  if (o.negocio && !o.empresaNegocio) await asociarEmpresa(db, ctx, o.negocio, empresa);
  return razonSocialDe(db, 'order', o.id);
}

// Si se combinan dos empresas, las razones sociales pasan a la que queda.
export async function razonesAEmpresa(db: D1Database, de: number[], a: number) {
  await db.prepare('UPDATE razones_sociales SET company_id = ? WHERE company_id IN (SELECT value FROM json_each(?))').bind(a, JSON.stringify(de)).run();
}
