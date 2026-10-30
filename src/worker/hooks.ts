import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { authenticate } from './auth';
import { applyBundle, findCompany, type Bundle } from './upsert';
import { normLinkedin, splitName } from './records';

// Lo que entra solo: Darwin, prospección por LinkedIn, formularios web y cualquier integración con token.
// Todo queda en `inbound_log` para poder auditar qué llegó y qué se hizo.

type App = { Bindings: Env };
export const hooks = new Hono<App>();

async function log(env: Env, source: string, payload: unknown, result: unknown, ok: boolean) {
  await env.DB.prepare('INSERT INTO inbound_log (source, payload, result, ok) VALUES (?, ?, ?, ?)')
    .bind(source, JSON.stringify(payload).slice(0, 20000), JSON.stringify(result).slice(0, 5000), ok ? 1 : 0).run();
}

async function ownerFrom(env: Env, v: { owner_id?: unknown; owner_email?: unknown }) {
  if (v.owner_id) return Number(v.owner_id);
  if (v.owner_email) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND active = 1').bind(String(v.owner_email)).first<{ id: number }>();
    return u?.id;
  }
  return undefined;
}

async function readBody(req: Request): Promise<Record<string, any>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return req.json();
  const form = await req.formData();
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));
}

async function run(env: Env, req: Request, source: string, build: (body: Record<string, any>, ctx: Ctx) => Promise<Bundle>) {
  let body: Record<string, any> = {};
  try {
    // Las integraciones entran siempre con token propio (nunca por la sesión de Access ni el usuario de desarrollo).
    if (!/^Bearer fcrm_/.test(req.headers.get('authorization') ?? '') && !new URL(req.url).searchParams.get('token')) {
      throw new HttpError(401, 'Falta el token de integración (Authorization: Bearer fcrm_…).');
    }
    const auth = await authenticate(env, req);
    const ctx: Ctx = { ...auth, source: auth.source === 'crm' ? source : auth.source };
    body = await readBody(req);
    const bundle = await build(body, ctx);
    const result = await applyBundle(env.DB, ctx, bundle);
    await log(env, source, body, result, true);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    await log(env, source, body, { error: (e as Error).message }, false).catch(() => {});
    return Response.json({ ok: false, error: (e as Error).message }, { status });
  }
}

// Genérico: { contact, company, deal, note, task, owner_id | owner_email }.
hooks.post('/bundle', (c) => run(c.env, c.req.raw, 'api', async (b) => ({ ...b, owner_id: await ownerFrom(c.env, b) } as Bundle)));

// Darwin (WhatsApp con IA). Arma el negocio igual que hoy la integración de Pipedream:
// "Nombre - Producto - Cantidad - Darwin", pipeline Formas Shop (Inbound), etapa Lead calificado.
hooks.post('/darwin', (c) => run(c.env, c.req.raw, 'darwin', async (b) => {
  const owner = await ownerFrom(c.env, b);
  const phone = b.phone ?? b.telefono ?? String(b.conversation_id ?? '').split('-').pop();
  const name = String(b.name ?? b.nombre ?? '').trim();
  const [firstname, ...rest] = name.split(/\s+/);
  const producto = b.producto ?? b.product ?? '';
  const cantidad = b.cantidad ?? b.quantity ?? '';
  const url = b.conversation_url ?? (b.conversation_id ? `https://app.getdarwin.ai/agent/1986/conversations/all/${b.conversation_id}` : undefined);
  return {
    owner_id: owner,
    contact: {
      firstname: firstname || undefined, lastname: rest.join(' ') || undefined, mobilephone: phone, email: b.email,
      company: b.company ?? b.empresa, origen_del_contacto: 'Contacto por Whatsapp', origen_de_la_conversacion: 'Darwin',
      prospect_source: b.utm_source, campaign_name: b.utm_campaign,
    },
    company: b.company_domain ? { name: b.company ?? b.empresa, domain: b.company_domain } : undefined,
    deal: {
      dealname: b.dealname ?? [name || phone, producto, cantidad === '' ? '0' : cantidad, 'Darwin'].join(' - '),
      pipeline: b.pipeline ?? 'default',
      dealstage: b.dealstage ?? 'appointmentscheduled',
      estado_del_negocio: 'Nuevo',
      producto, cantidad: cantidad === '' ? undefined : String(cantidad),
      origen_del_negocio: 'Contacto por Whatsapp',
      origen_del_prospecto: b.utm_source ?? b.origen,
      origen_de_la_campana: b.utm_campaign ?? b.campaign,
      link_a_darwin: url,
      dedupe_open: b.dedupe_open !== false,
    },
    note: b.summary ? `Resumen de Darwin:\n${b.summary}` : undefined,
  };
}));

// Prospección por LinkedIn (reemplaza al Zap): HeyReach u otra herramienta manda el lead directo.
// Deduplica por la URL del perfil (el Zap creaba el mismo perfil varias veces) y separa bien nombre y apellido.
// Acepta el lead plano o dentro de `lead`, en camelCase o snake_case.
hooks.post('/linkedin', (c) => run(c.env, c.req.raw, 'linkedin', async (raw, ctx) => {
  const b: Record<string, any> = { ...raw, ...(raw.lead ?? {}), ...(raw.contact ?? {}) };
  const pick = (...keys: string[]) => keys.map((k) => b[k]).find((v) => v != null && v !== '');
  const url = pick('linkedin_url', 'linkedinUrl', 'profile_url', 'profileUrl', 'linkedin', 'url');
  if (!normLinkedin(url) && !pick('email', 'emailAddress', 'email_address')) throw new HttpError(400, 'Falta la URL del perfil de LinkedIn (o un email).');
  const name = splitName(pick('firstname', 'first_name', 'firstName'), pick('lastname', 'last_name', 'lastName'), pick('full_name', 'fullName', 'name'));
  const company = pick('company', 'company_name', 'companyName');
  const message = pick('message', 'message_text', 'messageText', 'reply', 'lastMessage');
  const owner = (await ownerFrom(c.env, b)) ?? ctx.user.id;
  // Si la empresa ya está en el CRM, se asocia; si no, queda como texto (no se crea una empresa por cada lead).
  const existing = company ? await findCompany(c.env.DB, { name: company }) : null;
  return {
    owner_id: owner,
    contact: {
      ...name, linkedin_url: url, email: pick('email', 'emailAddress', 'email_address'), jobtitle: pick('jobtitle', 'position', 'headline', 'title'),
      company, city: pick('city', 'location'), origen_del_contacto: 'Linkedin', prospect_source: 'LinkedIn', campaign_name: pick('campaign_name', 'campaignName', 'campaign') ?? 'Outbound',
      tipo_de_origen: 'Prospección', estado_de_lead___outbound: 'Nuevo', outbound_lead_status: 'New', lifecyclestage: 'lead',
    },
    company: existing ? { name: existing.name } : undefined,
    activity: message ? { type: 'note', subject: 'Mensaje de LinkedIn', body: String(message) } : undefined,
  };
}));

// Formularios web (catálogo, ruleta de eventos, contacto). Público: sin token, con trampa anti-bots
// (campo `_gotcha` vacío) y configuración por formulario en settings (clave `form:<slug>`).
hooks.options('/form/:slug', () => new Response(null, { headers: cors() }));
hooks.post('/form/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await readBody(c.req.raw);
  if (body._gotcha) return new Response(null, { status: 204, headers: cors() });
  const cfgRow = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`form:${slug}`).first<{ value: string }>();
  if (!cfgRow) return Response.json({ ok: false, error: 'Formulario desconocido.' }, { status: 404, headers: cors() });
  const cfg = JSON.parse(cfgRow.value) as { name: string; owner_id?: number; user_id: number; contact_defaults?: Record<string, unknown>; deal?: Record<string, unknown> };
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(cfg.user_id).first<Ctx['user']>();
  if (!user) return Response.json({ ok: false, error: 'El formulario no tiene usuario configurado.' }, { status: 500, headers: cors() });
  const ctx: Ctx = { user, source: 'form', sourceDetail: cfg.name };
  const { _gotcha, redirect, message, mensaje, ...fields } = body;
  try {
    if (!fields.email && !fields.phone && !fields.mobilephone) throw new HttpError(400, 'Falta email o teléfono.');
    const text = message ?? mensaje;
    const result = await applyBundle(c.env.DB, ctx, {
      owner_id: cfg.owner_id,
      contact: { ...cfg.contact_defaults, ...fields },
      deal: cfg.deal ? { ...cfg.deal, description: text } : undefined,
      activity: { type: 'note', subject: `Envió el formulario «${cfg.name}»`, body: text ?? '', meta: { form: slug, fields } },
    });
    await log(c.env, `form:${slug}`, body, result, true);
    if (redirect) return c.redirect(String(redirect), 303);
    return Response.json({ ok: true }, { headers: cors() });
  } catch (e) {
    await log(c.env, `form:${slug}`, body, { error: (e as Error).message }, false);
    return Response.json({ ok: false, error: (e as Error).message }, { status: e instanceof HttpError ? e.status : 500, headers: cors() });
  }
});

function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
}
