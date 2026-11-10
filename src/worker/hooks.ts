import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { authenticate } from './auth';
import { applyBundle, findCompany, type Bundle } from './upsert';
import { emailDomain, normDomain, normLinkedin, normPhone, splitName } from './records';
import { clickupStatus, limpiarRemitos, remitosPendientes, syncClickup } from './clickup';
import { finnegansState } from './finnegans';
import { gmailConfig, syncAll } from './gmail';
import { avisosConfig, correrAvisos } from './avisos';
import { aplicarCompras, empresasParaCruce, guardarHistorico, historico } from './clientes';
import { refrescarFce } from './facturar';
import { aplicarSaldos, aplicarTotales } from './totales';
import { aplicarImagenes, cargarProductosPendientes } from './productos';
import { driveConfig, guardarDriveConfig, probarDrive } from './drive';
import { guardarRemito, itemsDe, leerPendientes, leerRemito, paraChofer, remitoPorId, type RemitoRow } from './remitos';

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

// Lo que llegó bien pero no alcanza para crear nada (por ejemplo, una conversación de Darwin sin WhatsApp ni mail):
// queda en el registro de entradas y se contesta 200, así la integración no lo cuenta como falla.
class Omitir extends Error {}

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
    if (e instanceof Omitir) {
      await log(env, source, body, { omitido: e.message }, true).catch(() => {});
      return Response.json({ ok: true, omitido: e.message });
    }
    const status = e instanceof HttpError ? e.status : 500;
    await log(env, source, body, { error: (e as Error).message }, false).catch(() => {});
    return Response.json({ ok: false, error: (e as Error).message }, { status });
  }
}

// Genérico: { contact, company, deal, note, task, owner_id | owner_email }.
hooks.post('/bundle', (c) => run(c.env, c.req.raw, 'api', async (b) => ({ ...b, owner_id: await ownerFrom(c.env, b) } as Bundle)));

// Darwin (WhatsApp con IA). Reemplaza al workflow «Formas Publicitarias - Hubspot» de Darwin: cuando la IA le pasa la
// conversación a una vendedora (evento `session.forwarded`), un paso `http-request` manda el evento entero
// ({ data: {{data}} }) acá. Se arma igual que en HubSpot: negocio "Nombre - Producto - Cantidad - Darwin" en Formas Shop
// (Inbound) / Lead calificado, pero:
// - el contacto lleva su WhatsApp, nombre y mail (el que juntó la IA, nunca uno inventado); con WhatsApp o mail alcanza,
//   y sin ninguno de los dos no se crea nada (queda en el registro de entradas);
// - si la IA juntó la empresa (o el mail es corporativo), se crea la empresa con su dominio y queda asociada al contacto,
//   al negocio y a la nota;
// - propietario: la vendedora a la que se asignó (por mail, aunque en Darwin esté con otro dominio de Formas, o por nombre);
// - sin negocios repetidos cuando la misma conversación se califica y después se escala.
// También acepta campos planos (name, phone, email, company, …).
const DARWIN_INTERNAL = ['maru', 'eli', 'elizabeth', 'jorgelina', 'lucia', 'lucía', 'ciro', 'rodrigo', 'facundo', 'tomas', 'tomás'];
const MEDIUM: Record<string, string> = { instagram: 'Instagram DM', webchat: 'WebChat', messenger: 'Facebook Messenger', facebook: 'Facebook Messenger' };

// Darwin pone «nolastname» (y parecidos) cuando no sabe un dato: eso no es un dato.
const SIN_DATO = /^(no ?last ?name|no ?name|sin (apellido|nombre|empresa)|n\/?a|none|null|undefined|unknown|desconocid[oa]|-+|\.+)$/i;
const dato = (v: unknown) => { const s = String(v ?? '').trim(); return s && !SIN_DATO.test(s) ? s : ''; };
const mail = (v: unknown) => { const s = dato(v).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s) ? s : ''; };
// «acme.com.ar» → «Acme» (como el alta automática de empresas por el mail).
const nombreDeDominio = (d: string) => d.charAt(0).toUpperCase() + d.split('.')[0].slice(1);

// La misma persona puede estar con otro dominio de Formas (lucia.senini@formas.ar en Darwin, @formaspublicitarias.com en el CRM).
async function ownerByEmailUser(env: Env, email?: unknown) {
  const local = String(email ?? '').toLowerCase().split('@')[0];
  if (!local || !String(email).includes('@')) return undefined;
  const u = await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND lower(substr(email, 1, instr(email, '@'))) = ? ORDER BY id LIMIT 1")
    .bind(`${local}@`).first<{ id: number }>();
  return u?.id;
}

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
  // WhatsApp: el número de la conversación, solo si es de WhatsApp (en Instagram o el webchat el id del hilo no es un teléfono).
  const familia = String(d.channelFamily ?? d.channelType ?? '').toLowerCase();
  const esWhatsApp = !familia || familia.startsWith('wa');
  const phoneRaw = raw.phone ?? raw.telefono ?? raw.whatsapp ?? (esWhatsApp ? d.phoneNumber ?? (conversationId ? String(conversationId).split('-').pop() : undefined) : undefined);
  const phone = normPhone(phoneRaw) ? String(phoneRaw).replace(/[^\d+]/g, '') : undefined;
  const email = mail(raw.email ?? sf.email ?? sf.mail);
  if (!phone && !email) throw new Omitir('La conversación no trae WhatsApp ni mail: no se creó el contacto ni el negocio.');
  const assignee = d.forwardedToName ?? raw.owner_name;
  const assigneeEmail = d.forwardedToEmail ?? raw.owner_email;
  const owner = (await ownerFrom(c.env, { owner_id: raw.owner_id, owner_email: assigneeEmail }))
    ?? (await ownerByEmailUser(c.env, assigneeEmail)) ?? (await ownerByName(c.env, assignee));
  // Nombre: el que juntó la IA, salvo que sea el de alguien de Formas; si no, el título de la conversación.
  const internal = (n: string) => !n || DARWIN_INTERNAL.includes(n.toLowerCase().split(/\s+/)[0]) || (assignee && n.toLowerCase() === String(assignee).toLowerCase());
  const candidates = [sf.name, raw.name, raw.nombre, d.conversationTitle].map(dato);
  const name = candidates.find((n) => n && !internal(n) && !/^\+?\d[\d\s-]+$/.test(n)) ?? '';
  const apellido = dato(raw.lastname ?? sf.last_name ?? sf.apellido);
  const parts = apellido ? splitName(name, apellido) : splitName(undefined, undefined, name);
  // Empresa: la que juntó la IA y, de dominio, el del mail si es corporativo (o el que venga).
  const empresa = dato(raw.company ?? raw.empresa ?? sf.company ?? sf.empresa);
  const dominioDado = normDomain(dato(raw.company_domain ?? raw.dominio ?? sf.website ?? sf.dominio));
  const dominio = (dominioDado?.includes('.') ? dominioDado : null) ?? emailDomain(email);
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
      ...parts, mobilephone: phone, email: email || undefined, company: empresa || undefined,
      origen_del_contacto: canal, origen_de_la_conversacion: 'Darwin', prospect_source: utmSource, campaign_name: utmCampaign,
    },
    company: empresa || dominio ? { name: empresa || nombreDeDominio(dominio!), domain: dominio ?? undefined } : undefined,
    deal: {
      dealname: raw.dealname ?? [name || phone || email, producto, cantidad === '' ? '0' : cantidad, 'Darwin'].join(' - '),
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

// Saldo pendiente de cada pedido (scripts/pedidos-totales.mjs): las filas del informe de composición de saldos de
// Finnegans, {filas: [{ie, doc, desc, importe, vto}], completo: true}.
hooks.post('/pedidos/saldos', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await aplicarSaldos(c.env, await c.req.json()));
});
hooks.get('/pedidos/saldos', async (c) => {
  await adminToken(c.env, c.req.raw);
  const r = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'saldos_pedidos'").first<{ value: string }>();
  return c.json(r ? JSON.parse(r.value) : null);
});

// Productos de los pedidos que todavía no se leyeron (para las miniaturas de las tarjetas): una tanda por llamada,
// la que entre en el tope de consultas. Devuelve cuántos leyó y cuántos quedan.
hooks.post('/productos/pendientes', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await cargarProductosPendientes(c.env, Math.min(Math.max(Number(c.req.query('limit')) || 25, 1), 50)));
});

// Remitos de los pedidos entregados que todavía no tienen (los que suben a los artículos en ClickUp): una tanda por
// llamada; devuelve cuántos revisó, cuántos encontró y cuántos quedan.
hooks.post('/pedidos/remitos/pendientes', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await remitosPendientes(c.env, Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 40)));
});

// Lee una tanda de remitos sin leer (lo mismo que hace el cron), con token de administrador.
hooks.post('/remitos/leer', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await leerPendientes(c.env, undefined, Math.min(Math.max(Number(c.req.query('limit')) || 4, 1), 6)));
});

// ---------- App del chofer (web/chofer, remitos.ts) ----------
// Va por /hooks porque esta ruta no pasa por el login de Cloudflare Access: cada chofer entra con su link personal
// (/hooks/chofer/#t=fcrm_…, un token tipo «chofer» que solo sirve para esto). La app se compila aparte a dist/chofer.
async function chofer(env: Env, req: Request) {
  return authenticate(env, req, undefined, { chofer: true });
}
async function pedidoNombre(db: D1Database, id: number | null) {
  return id ? (await db.prepare('SELECT name FROM records WHERE id = ?').bind(id).first<{ name: string }>())?.name ?? null : null;
}
hooks.get('/chofer/api/yo', async (c) => {
  const ctx = await chofer(c.env, c.req.raw);
  return c.json({ nombre: ctx.sourceDetail ?? 'Chofer' });
});
hooks.get('/chofer/api/remitos', async (c) => {
  const ctx = await chofer(c.env, c.req.raw);
  const { results } = await c.env.DB.prepare(`SELECT r.*, o.name AS pedido_nombre FROM (SELECT id, record_id, clave, created_at, estado, repetir, motivo,
      numero, pdv, cliente, lectura FROM remitos WHERE token_id = ? ORDER BY created_at DESC LIMIT 30) r LEFT JOIN records o ON o.id = r.record_id`)
    .bind(ctx.tokenId).all<RemitoRow & { pedido_nombre: string | null }>();
  const items = await itemsDe(c.env.DB, results.map((r) => r.id));
  return c.json({ remitos: results.map((r) => paraChofer(r, items.get(r.id) ?? [], r.pedido_nombre)) });
});
// Una foto: se guarda enseguida (la misma clave o la misma foto no duplican) y se lee en el momento, así el chofer sabe
// si tiene que sacar otra mientras está con el cliente.
hooks.post('/chofer/api/remitos', async (c) => {
  const ctx = await chofer(c.env, c.req.raw);
  const form = await c.req.formData();
  const archivo = form.get('archivo');
  if (!(archivo instanceof File)) throw new HttpError(400, 'Falta la foto del remito.');
  const s = (k: string) => (typeof form.get(k) === 'string' ? String(form.get(k)) : null);
  const tomada = s('tomada_el');
  const { id, nuevo } = await guardarRemito(c.env, ctx, {
    origen: 'chofer', bytes: await archivo.arrayBuffer(), mime: archivo.type || 'image/jpeg', nombre: archivo.name || 'remito.jpg',
    clave: s('clave')?.slice(0, 80) || null, tokenId: ctx.tokenId ?? null, chofer: ctx.sourceDetail ?? null,
    lat: s('lat') == null ? null : Number(s('lat')), lng: s('lng') == null ? null : Number(s('lng')),
    tomadaEl: tomada && !Number.isNaN(Date.parse(tomada)) ? new Date(tomada).toISOString() : null,
  });
  // Otra foto porque la anterior no se leía (`reemplaza`: la clave de esa): la anterior se descarta, así no queda en la
  // bandeja de Logística. Solo la del mismo chofer y si estaba para revisar.
  const reemplaza = s('reemplaza');
  if (nuevo && reemplaza) {
    await c.env.DB.prepare(`UPDATE remitos SET estado = 'descartado', motivo = 'El chofer sacó otra foto.', updated_at = ?
      WHERE clave = ? AND token_id = ? AND estado = 'revisar' AND id != ?`).bind(new Date().toISOString(), reemplaza, ctx.tokenId ?? -1, id).run();
  }
  const ya = await remitoPorId(c.env.DB, id);
  const r = nuevo || ya.estado === 'sin_leer' ? await leerRemito(c.env, id, { ctx }) : ya;
  return c.json(paraChofer(r, (await itemsDe(c.env.DB, [id])).get(id) ?? [], await pedidoNombre(c.env.DB, r.record_id)), nuevo ? 201 : 200);
});
// El manifest de la app con el link del chofer adentro (?t=<token>): así, al guardarla en la pantalla de inicio, abre ya
// con su link. Hace falta en iPhone, donde la app de inicio no comparte lo guardado con Safari. El token solo se copia
// si tiene la forma de uno; sin token, el manifest de siempre. Nunca queda en caché.
hooks.get('/chofer/manifest.webmanifest', async (c) => {
  const url = new URL(c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(new URL('/chofer/manifest.webmanifest', url.origin)));
  if (!res.ok) return c.text('No existe.', 404);
  const m = await res.json<Record<string, unknown>>();
  const t = url.searchParams.get('t') ?? '';
  if (/^fcrm_[0-9a-f]{48}$/.test(t)) Object.assign(m, { id: '/hooks/chofer/', start_url: `/hooks/chofer/#t=${t}` });
  return new Response(JSON.stringify(m), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' } });
});
// La app: index.html y sus archivos, desde dist/chofer.
hooks.get('/chofer', (c) => c.redirect('/hooks/chofer/', 301));
hooks.get('/chofer/*', async (c) => {
  const url = new URL(c.req.url);
  const resto = url.pathname.replace(/^\/hooks\/chofer\/?/, '');
  const archivo = !resto || resto.startsWith('api/') ? 'index.html' : resto;
  let res = await c.env.ASSETS.fetch(new Request(new URL(`/chofer/${archivo}`, url.origin)));
  // El servidor de archivos manda /chofer/index.html a /chofer/: se sigue acá, sin cambiar la dirección del navegador.
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await c.env.ASSETS.fetch(new Request(new URL(res.headers.get('location')!, url.origin)));
  // Si no existe, la app (que muestra su propia pantalla); nunca el CRM.
  if (res.status === 404 || (archivo !== 'index.html' && (res.headers.get('content-type') ?? '').includes('text/html') && !archivo.endsWith('.html'))) {
    if (/\.[a-z0-9]+$/i.test(archivo)) return c.text('No existe.', 404);
    res = await c.env.ASSETS.fetch(new Request(new URL('/chofer/', url.origin)));
  }
  const h = new Headers(res.headers);
  if (archivo === 'index.html' || archivo === 'sw.js') h.set('cache-control', 'no-cache');
  if (archivo === 'sw.js') h.set('service-worker-allowed', '/hooks/chofer/');
  return new Response(res.body, { status: res.status, headers: h });
});

// Borra del CRM los adjuntos de ClickUp guardados como remito que no lo son (fotos de producto, capturas, bocetos).
hooks.post('/pedidos/remitos/limpiar', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await limpiarRemitos(c.env.DB));
});

// Fotos de los productos desde el registro de cotizaciones del STP (scripts/stp-imagenes.mjs):
// {filas: [["PEDVTASTP - 31277", "SKU", "https://…"], ["", "SKU", "https://…"], …]} y los productos de cada cotización,
// {productos: [["PEDVTASTP - 31277", "SKU", "Nombre", [100], "https://…"], …]} (ver aplicarImagenes en productos.ts).
hooks.post('/productos/imagenes', async (c) => {
  await adminToken(c.env, c.req.raw);
  return c.json(await aplicarImagenes(c.env, await c.req.json()));
});
hooks.get('/productos/imagenes', async (c) => {
  await adminToken(c.env, c.req.raw);
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('imagenes_stp', 'imagenes_stp_productos')").all<{ key: string; value: string }>();
  const de = (k: string) => { const r = results.find((x) => x.key === k); return r ? JSON.parse(r.value) : null; };
  const filas = de('imagenes_stp'), productos = de('imagenes_stp_productos');
  return c.json(filas || productos ? { ...filas, productos } : null);
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
