import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { authenticate } from './auth';
import { applyBundle, findCompany, type Bundle } from './upsert';
import { normLinkedin, splitName } from './records';
import { clickupStatus, syncClickup } from './clickup';
import { finnegansState } from './finnegans';
import { gmailConfig, syncAll } from './gmail';
import { avisosConfig, correrAvisos } from './avisos';
import { aplicarCompras, empresasParaCruce, guardarHistorico, historico } from './clientes';
import { refrescarFce } from './facturar';
import { aplicarTotales } from './totales';
import { aplicarImagenes, cargarProductosPendientes } from './productos';
import { driveConfig, guardarDriveConfig, probarDrive } from './drive';

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

// Darwin (WhatsApp con IA). Reemplaza al workflow «Formas Publicitarias - Hubspot» de Darwin: ese workflow pasa a
// tener un solo paso `http-request` que manda el evento `session.forwarded` entero ({ data: {{data}} }) acá.
// Se arma igual que hoy: negocio "Nombre - Producto - Cantidad - Darwin" en Formas Shop (Inbound) / Lead calificado,
// pero sin el mail inventado (el contacto se busca por teléfono), con propietario por mail y sin negocios repetidos
// cuando la misma conversación se califica y después se escala. También acepta campos planos (name, phone, …).
const DARWIN_INTERNAL = ['maru', 'eli', 'elizabeth', 'jorgelina', 'lucia', 'lucía', 'ciro', 'rodrigo', 'facundo', 'tomas', 'tomás'];
const MEDIUM: Record<string, string> = { instagram: 'Instagram DM', webchat: 'WebChat', messenger: 'Facebook Messenger', facebook: 'Facebook Messenger' };

async function ownerByName(env: Env, name?: string) {
  if (!name) return undefined;
  const { results } = await env.DB.prepare('SELECT id, name FROM users WHERE active = 1').all<{ id: number; name: string }>();
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return results.find((u) => norm(name).startsWith(norm(u.name)))?.id;
}

hooks.post('/darwin', (c) => run(c.env, c.req.raw, 'darwin', async (raw) => {
  const d: Record<string, any> = raw.data ?? raw;
  const sf: Record<string, any> = d.smartFields ?? d.smart_fields ?? {};
  const src: Record<string, any> = d.source ?? {};
  const conversationId = d.conversationId ?? raw.conversation_id;
  const phone = d.phoneNumber ?? raw.phone ?? raw.telefono ?? (conversationId ? String(conversationId).split('-').pop() : undefined);
  const assignee = d.forwardedToName ?? raw.owner_name;
  const owner = (await ownerFrom(c.env, { owner_id: raw.owner_id, owner_email: d.forwardedToEmail ?? raw.owner_email })) ?? (await ownerByName(c.env, assignee));
  // Nombre: el que juntó la IA, salvo que sea el de alguien de Formas; si no, el título de la conversación.
  const internal = (n: string) => !n || DARWIN_INTERNAL.includes(n.toLowerCase().split(/\s+/)[0]) || (assignee && n.toLowerCase() === String(assignee).toLowerCase());
  const candidates = [sf.name, raw.name, raw.nombre, d.conversationTitle].map((x) => String(x ?? '').trim());
  const name = candidates.find((n) => n && !internal(n) && !/^\+?\d[\d\s-]+$/.test(n)) ?? '';
  const parts = sf.last_name ? splitName(name, sf.last_name) : splitName(undefined, undefined, name);
  const producto = sf.producto ?? raw.producto ?? raw.product ?? '';
  const cantidad = sf.cantidad ?? raw.cantidad ?? raw.quantity ?? '';
  const prellenado = sf.anuncio_prellenado;
  const utmSource = src.utmSource ?? raw.utm_source ?? raw.origen ?? (prellenado ? 'META_ADS' : 'Orgánico');
  const utmCampaign = src.utmCampaign ?? raw.utm_campaign ?? raw.campaign ?? (prellenado ? `Anuncio sin referral - ${prellenado}` : 'Directo');
  const canal = MEDIUM[String(src.utmMedium ?? '').toLowerCase()] ?? 'Contacto por Whatsapp';
  const url = raw.conversation_url ?? (conversationId ? `https://app.getdarwin.ai/agent/1986/conversations/all/${conversationId}` : undefined);
  const summary = d.summary ?? raw.summary;
  return {
    owner_id: owner,
    contact: {
      ...parts, mobilephone: phone, email: raw.email ?? sf.email, company: raw.company ?? raw.empresa ?? sf.empresa,
      origen_del_contacto: canal, origen_de_la_conversacion: 'Darwin', prospect_source: utmSource, campaign_name: utmCampaign,
    },
    company: raw.company_domain ? { name: raw.company ?? raw.empresa, domain: raw.company_domain } : undefined,
    deal: {
      dealname: raw.dealname ?? [name || phone, producto, cantidad === '' ? '0' : cantidad, 'Darwin'].join(' - '),
      pipeline: raw.pipeline ?? 'default',
      dealstage: raw.dealstage ?? 'appointmentscheduled',
      estado_del_negocio: 'Nuevo',
      producto, cantidad: cantidad === '' ? undefined : String(cantidad),
      origen_del_negocio: canal,
      origen_del_prospecto: utmSource,
      origen_de_la_campana: utmCampaign,
      link_a_darwin: url,
      dedupe_open: raw.dedupe_open !== false,
    },
    note: summary ? `Resumen de Darwin${d.forwardType ? ` (${d.forwardType})` : ''}:\n${summary}` : undefined,
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
// Para la tarea que baja los PDF de las facturas (scripts/facturas-pdf.mjs, en GitHub): qué facturas faltan y dónde dejarlas.
async function adminToken(env: Env, req: Request) {
  if (!/^Bearer fcrm_/.test(req.headers.get('authorization') ?? '')) throw new HttpError(401, 'Falta el token de integración (Authorization: Bearer fcrm_…).');
  const ctx = await authenticate(env, req);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'El token tiene que ser de un administrador.');
  return ctx;
}
hooks.get('/facturas/pendientes', async (c) => {
  await adminToken(c.env, c.req.raw);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const { results } = await c.env.DB.prepare("SELECT id, name, meta FROM files WHERE kind = 'factura' AND source = 'finnegans' AND data IS NULL ORDER BY id LIMIT ?").bind(limit).all<{ id: number; name: string; meta: string }>();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE kind = 'factura' AND source = 'finnegans' AND data IS NULL").first<{ n: number }>();
  c.header('x-total', String(total?.n ?? results.length));
  return c.json(results.map((f) => { const m = JSON.parse(f.meta || '{}'); return { id: f.id, name: f.name, transaccion_id: m.transaccion_id, empresa: m.empresa, numero: m.numero }; }));
});
// Estado de las conexiones de los pedidos (lo mismo que Configuración → Integraciones), para revisarlo con un token.
hooks.get('/pedidos/estado', async (c) => {
  await adminToken(c.env, c.req.raw);
  const pend = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE kind = 'factura' AND data IS NULL").first<{ n: number }>();
  return c.json({
    clickup: { configured: !!c.env.CLICKUP_TOKEN, ...(await clickupStatus(c.env.DB)) },
    finnegans: { configured: !!(c.env.FINNEGANS_CLIENT_ID && c.env.FINNEGANS_CLIENT_SECRET), ...(await finnegansState(c.env.DB)), pdf_pendientes: pend?.n ?? 0 },
  });
});
// Lo mismo que «Revisar todo» de Configuración → Integraciones, para usarlo con token (por ejemplo, después de dar de
// alta vendedoras, para que los pedidos que ya entraron queden con la suya).
hooks.post('/pedidos/revisar', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await syncClickup(c.env, { full: true }));
});
// Gmail con token de administrador (lo mismo que Configuración → Integraciones → «Mails (Gmail)»): ver el estado,
// cambiar la configuración (prender, qué bandejas) y leer ahora.
hooks.get('/gmail', async (c) => {
  await adminToken(c.env, c.req.raw);
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'gmail_state:%' OR key = 'gmail_last_run'").all<{ key: string; value: string }>();
  return c.json({ config: await gmailConfig(c.env.DB), has_credentials: !!c.env.GOOGLE_SA_JSON,
    state: Object.fromEntries(results.map((r) => [r.key.replace('gmail_state:', ''), JSON.parse(r.value)])) });
});
hooks.put('/gmail', async (c) => {
  await adminToken(c.env, c.req.raw);
  const cfg = { ...(await gmailConfig(c.env.DB)), ...(await c.req.json()) };
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gmail', ?)").bind(JSON.stringify(cfg)).run();
  return c.json(cfg);
});
hooks.post('/gmail/sync', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await syncAll(c.env));
});
// Compras de clientes desde Finnegans (scripts/clientes.mjs, cada noche): empresas para cruzar, histórico de facturas
// anterior a Finnegans y el resultado. Todo con token de administrador.
hooks.get('/clientes/empresas', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await empresasParaCruce(c.env.DB));
});
hooks.get('/clientes/historico', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await historico(c.env.DB));
});
hooks.put('/clientes/historico', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await guardarHistorico(c.env.DB, (await c.req.json<{ rows: never[] }>()).rows));
});
hooks.post('/clientes/aplicar', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await aplicarCompras(c.env, await c.req.json()));
});
hooks.get('/clientes/estado', async (c) => {
  await adminToken(c.env, c.req.raw);
  const r = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clientes_estado'").first<{ value: string }>();
  return c.json(r ? JSON.parse(r.value) : null);
});

// Total sin IVA de cada pedido (scripts/pedidos-totales.mjs): {totales: {"PEDVTASTP - 31277": 123456.78, …}}.
hooks.post('/pedidos/totales', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await aplicarTotales(c.env, await c.req.json()));
});
hooks.get('/pedidos/totales', async (c) => {
  await adminToken(c.env, c.req.raw);
  const r = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'totales_pedidos'").first<{ value: string }>();
  return c.json(r ? JSON.parse(r.value) : null);
});

// Productos de los pedidos que todavía no se leyeron (para las miniaturas de las tarjetas): una tanda por llamada,
// la que entre en el tope de consultas. Devuelve cuántos leyó y cuántos quedan.
hooks.post('/productos/pendientes', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await cargarProductosPendientes(c.env, Math.min(Math.max(Number(c.req.query('limit')) || 25, 1), 50)));
});

// Fotos de los productos desde el registro de cotizaciones del STP (scripts/stp-imagenes.mjs):
// {filas: [["PEDVTASTP - 31277", "SKU", "https://…"], ["", "SKU", "https://…"], …]}.
hooks.post('/productos/imagenes', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await aplicarImagenes(c.env, await c.req.json()));
});
hooks.get('/productos/imagenes', async (c) => {
  await adminToken(c.env, c.req.raw);
  const r = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'imagenes_stp'").first<{ value: string }>();
  return c.json(r ? JSON.parse(r.value) : null);
});

// Bocetos en Drive: dónde se guardan (lo mismo que Configuración → Integraciones) y probar el acceso.
hooks.get('/bocetos', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await driveConfig(c.env));
});
hooks.put('/bocetos', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await guardarDriveConfig(c.env, await c.req.json()));
});
hooks.get('/bocetos/probar', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await probarDrive(c.env));
});

// La lista de empresas grandes de ARCA (Factura de Crédito Electrónica): se baja sola una vez por día; esto la trae ya.
hooks.post('/arca/fce', async (c) => {
  await adminToken(c.env, c.req.raw);
  await c.env.DB.prepare("DELETE FROM settings WHERE key = 'arca_fce'").run();
  return c.json(await refrescarFce(c.env));
});

// Lo que el CRM le mandó a ClickUp (pedidos que pasaron a «pdv»): lo último, con su resultado o error.
hooks.get('/clickup/salida', async (c) => {
  await adminToken(c.env, c.req.raw);
  const { results } = await c.env.DB.prepare(`SELECT s.id, s.record_id, r.name AS pedido, s.action, s.created_at, s.done_at, s.attempts, s.result, s.error
    FROM clickup_salida s LEFT JOIN records r ON r.id = s.record_id ORDER BY s.id DESC LIMIT 50`).all();
  return c.json(results);
});

// Avisos por mail: configuración, estado y envío a pedido (`?resumen=1` manda el resumen de tareas aunque no sea la hora).
hooks.get('/avisos', async (c) => {
  await adminToken(c.env, c.req.raw);
  const db = c.env.DB;
  const estado = await db.prepare("SELECT value FROM settings WHERE key = 'avisos_estado'").first<{ value: string }>();
  const pend = await db.prepare('SELECT COUNT(*) AS n FROM avisos WHERE sent_at IS NULL').first<{ n: number }>();
  return c.json({ config: await avisosConfig(c.env), estado: estado ? JSON.parse(estado.value) : null, pendientes: pend?.n ?? 0, has_credentials: !!c.env.GOOGLE_SA_JSON });
});
hooks.put('/avisos', async (c) => {
  await adminToken(c.env, c.req.raw);
  const cfg = { ...(await avisosConfig(c.env)), ...(await c.req.json()) };
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('avisos', ?)").bind(JSON.stringify(cfg)).run();
  return c.json(cfg);
});
hooks.post('/avisos/enviar', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await correrAvisos(c.env, undefined, { forceResumen: c.req.query('resumen') === '1' }));
});

hooks.put('/facturas/:id/pdf', async (c) => {
  await adminToken(c.env, c.req.raw);
  const buf = await c.req.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 5));
  if (head !== '%PDF-') throw new HttpError(400, 'No es un PDF.');
  if (buf.byteLength > 1_900_000) throw new HttpError(400, 'El PDF pesa más de 1,9 MB.');
  const r = await c.env.DB.prepare("UPDATE files SET data = ?, size = ?, mime = 'application/pdf' WHERE id = ? AND kind = 'factura'").bind(buf, buf.byteLength, Number(c.req.param('id'))).run();
  if (!r.meta.changes) throw new HttpError(404, 'No existe esa factura.');
  return c.json({ ok: true, size: buf.byteLength });
});

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
