import type { Ctx, Env } from './env';
import { createActivity } from './activities';
import { primaryCompanyId } from './associations';

// Datos para facturar: cuando un negocio se gana, el CRM revisa que la empresa tenga lo que administración necesita para
// facturar (CUIT válido, razón social) y avisa lo que conviene saber antes (si es cliente nuevo en Finnegans, si es empresa
// grande y puede ir con Factura de Crédito Electrónica). Si falta algo, la vendedora tiene una tarea para hoy.
// La lista de empresas grandes (FCE) es la oficial de ARCA, sin captcha; se baja una vez por día.

const FCE_URL = 'https://servicioscf.afip.gob.ar/FCEServicioConsulta/api/fceconsulta.aspx/getGrandesEmpresas';

// Dígito verificador del CUIT (módulo 11).
export function cuitValido(cuit: unknown) {
  const d = String(cuit ?? '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(d[10]);
}

export async function refrescarFce(env: Env, now = new Date()) {
  const hoy = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'arca_fce'").first<{ value: string }>();
  if (row && (JSON.parse(row.value) as { fecha: string }).fecha === hoy) return { skipped: 'ya está la de hoy' };
  const res = await fetch(env.ARCA_FCE_URL ?? FCE_URL, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
  if (!res.ok) throw new Error(`ARCA (empresas grandes): HTTP ${res.status}`);
  const data = (await res.json()) as { d?: string };
  const lista = JSON.parse(data.d ?? '[]') as Array<{ Cuit: number | string }>;
  const cuits = lista.map((x) => String(x.Cuit).replace(/\D/g, '')).filter((c) => c.length === 11);
  if (!cuits.length) throw new Error('ARCA devolvió la lista de empresas grandes vacía.');
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('arca_fce', ?)").bind(JSON.stringify({ fecha: hoy, cuits })).run();
  return { empresas_grandes: cuits.length };
}

export interface Control { empresa: { id: number; name: string } | null; faltan: string[]; avisos: string[]; listo: string[] }

export async function datosParaFacturar(db: D1Database, dealId: number): Promise<Control> {
  const companyId = await primaryCompanyId(db, dealId);
  const out: Control = { empresa: null, faltan: [], avisos: [], listo: [] };
  if (!companyId) { out.faltan.push('Asociar la empresa a la que se le factura.'); return out; }
  const row = await db.prepare('SELECT id, name, props FROM records WHERE id = ?').bind(companyId).first<{ id: number; name: string; props: string }>();
  if (!row) { out.faltan.push('Asociar la empresa a la que se le factura.'); return out; }
  out.empresa = { id: row.id, name: row.name };
  const p = JSON.parse(row.props) as Record<string, unknown>;
  const cuit = String(p.cuit ?? '').trim();
  if (!cuit) out.faltan.push('Cargar el CUIT de la empresa.');
  else if (!cuitValido(cuit)) out.faltan.push(`Revisar el CUIT: ${cuit} no es válido (no da el dígito verificador).`);
  else out.listo.push(`CUIT ${cuit}`);
  if (!String(p.razon_social ?? '').trim()) out.faltan.push('Cargar la razón social (como figura en ARCA).');
  else out.listo.push(`Razón social: ${p.razon_social}`);
  if (p.codigo_de_finnegans || p.estado_cliente) out.listo.push(`Ya es cliente en Finnegans${p.codigo_de_finnegans ? ` (código ${p.codigo_de_finnegans})` : ''}.`);
  else out.avisos.push('Es cliente nuevo en Finnegans: administración lo tiene que dar de alta (revisa ARCA, AGIP e IIBB) antes de facturar.');
  if (cuitValido(cuit)) {
    const fce = await db.prepare("SELECT value FROM settings WHERE key = 'arca_fce'").first<{ value: string }>();
    if (fce && (JSON.parse(fce.value) as { cuits: string[] }).cuits.includes(cuit.replace(/\D/g, ''))) {
      out.avisos.push('Es empresa grande para ARCA: si la factura supera el monto mínimo, va como Factura de Crédito Electrónica (FCE).');
    }
  }
  if (Number(p.saldo_vencido) > 0) out.avisos.push(`Tiene saldo vencido en Finnegans ($ ${Math.round(Number(p.saldo_vencido)).toLocaleString('es-AR')}).`);
  return out;
}

// Al ganar el negocio: si falta algo, una tarea para la vendedora (una sola por negocio).
export async function controlAlGanar(db: D1Database, ctx: Ctx, dealId: number, ownerId: number | null) {
  const c = await datosParaFacturar(db, dealId);
  if (!c.faltan.length) return c;
  const deal = await db.prepare('SELECT name FROM records WHERE id = ?').bind(dealId).first<{ name: string }>();
  await createActivity(db, ctx, {
    type: 'task', task_type: 'todo', priority: 'high', owner_id: ownerId ?? ctx.user.id,
    subject: `Completar datos para facturar: ${c.empresa?.name ?? deal?.name ?? 'negocio ganado'}`,
    body: ['Antes de que el pedido llegue a administración:', ...c.faltan.map((f) => `• ${f}`), ...(c.avisos.length ? ['', 'Para tener en cuenta:', ...c.avisos.map((a) => `• ${a}`)] : [])].join('\n'),
    due_at: new Date().toISOString(),
    external_id: `facturar:${dealId}`,
    links: [dealId, ...(c.empresa ? [c.empresa.id] : [])],
    link_primary_company: false,
  });
  return c;
}
