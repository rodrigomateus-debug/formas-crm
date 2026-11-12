import { Hono } from 'hono';
import type { Ctx, Env, User } from './env';
import { HttpError } from './env';
import { authenticate, newToken, sha256 } from './auth';

// «Conectar con Claude» (pedido de Rodrigo del 12/11/2026): cada usuario conecta su Claude con el CRM como se conectan
// HubSpot o ClickUp, con OAuth 2.1 (lo que piden los conectores remotos de Claude):
//   1. En Claude se agrega el conector «Formas CRM» con la dirección del CRM (/mcp). Un administrador lo puede agregar
//      una vez para toda la organización; después cada uno solo toca «Conectar».
//   2. Claude pide /mcp sin token → 401 con dónde está la autorización (RFC 9728) → lee los datos del servidor de
//      autorización (RFC 8414) → se registra solo (RFC 7591) → manda a la persona a /conectar/autorizar.
//   3. Ahí el CRM pide el login de siempre (Access o «Ingresar con Google») y muestra «Permitir»: Claude va a ver lo mismo
//      que ve la persona y, salvo los administradores, cambiar solo lo suyo (mcp.ts).
//   4. Claude cambia el código (con PKCE) por un token del CRM a nombre de la persona (api_tokens, tipo «mcp», 30 días)
//      y uno para renovarlo (180 días). Desconectar (el botón del CRM) lo revoca.
// Cloudflare Access: /mcp* ya va sin Access; hace falta sumar /.well-known/* (docs/CLAUDE.md). /conectar sigue con login.

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const conectar = new Hono<App>();

const DIAS_ACCESO = 30;
const DIAS_RENOVAR = 180;
const MINUTOS_CODIGO = 10;
const base = (req: Request) => new URL(req.url).origin;
const aleatorio = (n = 32) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256b64url = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const masDias = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version' };
const NO_GUARDAR = { 'cache-control': 'no-store', pragma: 'no-cache' };

// Adónde puede volver: solo a Claude (claude.ai, claude.com) o a la propia computadora (Claude Desktop y Claude Code).
// Así nadie puede armar una «app» que pida permiso para leer el CRM y se lleve el acceso a otro lado.
export function vueltaPermitida(uri: string) {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const h = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && (h === 'claude.ai' || h === 'claude.com' || h.endsWith('.claude.ai') || h.endsWith('.claude.com'))) return true;
  return (u.protocol === 'http:' || u.protocol === 'https:') && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]');
}

// ---------- Descubrimiento ----------

const recurso = (req: Request) => ({
  resource: `${base(req)}/mcp`, authorization_servers: [base(req)], bearer_methods_supported: ['header'],
  resource_name: 'Formas CRM', resource_documentation: `${base(req)}/`,
});
const servidor = (req: Request) => ({
  issuer: base(req),
  authorization_endpoint: `${base(req)}/conectar/autorizar`,
  token_endpoint: `${base(req)}/mcp/oauth/token`,
  registration_endpoint: `${base(req)}/mcp/oauth/register`,
  revocation_endpoint: `${base(req)}/mcp/oauth/revoke`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['crm'],
});
for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/mcp/.well-known/oauth-protected-resource']) {
  conectar.get(p, (c) => c.json(recurso(c.req.raw), 200, CORS));
}
for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/mcp/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
  conectar.get(p, (c) => c.json(servidor(c.req.raw), 200, CORS));
}
conectar.options('/mcp/oauth/*', () => new Response(null, { status: 204, headers: CORS }));
conectar.options('/.well-known/*', () => new Response(null, { status: 204, headers: CORS }));

// La respuesta de /mcp sin token (o con uno vencido): dónde pedir permiso.
export function sinPermiso(req: Request, motivo: string, conToken: boolean) {
  return new Response(JSON.stringify({ error: conToken ? 'invalid_token' : 'unauthorized', error_description: motivo }), {
    status: 401,
    headers: { 'content-type': 'application/json', ...CORS, 'access-control-expose-headers': 'www-authenticate',
      'www-authenticate': `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"${conToken ? ', error="invalid_token"' : ''}` },
  });
}

// ---------- Registro del cliente (Claude, la primera vez) ----------

const errorOauth = (error: string, descripcion: string, status = 400) =>
  new Response(JSON.stringify({ error, error_description: descripcion }), { status, headers: { 'content-type': 'application/json', ...CORS, ...NO_GUARDAR } });

conectar.post('/mcp/oauth/register', async (c) => {
  const b = await c.req.json<{ redirect_uris?: unknown; client_name?: unknown }>().catch(() => ({} as { redirect_uris?: unknown; client_name?: unknown }));
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
  if (!uris.length) return errorOauth('invalid_redirect_uri', 'Falta redirect_uris.');
  const mala = uris.find((u) => !vueltaPermitida(u));
  if (mala) return errorOauth('invalid_redirect_uri', `Este CRM solo se conecta con Claude (claude.ai) o con apps en la propia computadora: ${mala} no.`);
  const id = `cl_${aleatorio(18)}`;
  const nombre = String(b.client_name ?? 'Claude').slice(0, 80);
  await c.env.DB.prepare('INSERT INTO oauth_clientes (client_id, nombre, redirect_uris) VALUES (?, ?, ?)').bind(id, nombre, JSON.stringify(uris)).run();
  return new Response(JSON.stringify({
    client_id: id, client_name: nombre, redirect_uris: uris, client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }), { status: 201, headers: { 'content-type': 'application/json', ...CORS, ...NO_GUARDAR } });
});

// ---------- Permitir (la página del CRM) ----------

interface Pedido { client_id: string; redirect_uri: string; code_challenge: string; state: string }
async function validarPedido(db: D1Database, q: Record<string, string | undefined>): Promise<{ pedido: Pedido; cliente: string } | { error: string }> {
  if (q.response_type !== 'code') return { error: 'Claude pidió algo que este CRM no da (response_type).' };
  const cli = q.client_id ? await db.prepare('SELECT nombre, redirect_uris FROM oauth_clientes WHERE client_id = ?').bind(q.client_id).first<{ nombre: string; redirect_uris: string }>() : null;
  if (!cli) return { error: 'No se reconoce la app que pide permiso. Volvé a Claude y conectá de nuevo.' };
  if (!q.redirect_uri || !(JSON.parse(cli.redirect_uris) as string[]).includes(q.redirect_uri) || !vueltaPermitida(q.redirect_uri)) return { error: 'La dirección de vuelta no es la que registró Claude.' };
  if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return { error: 'Falta la verificación (PKCE S256).' };
  return { pedido: { client_id: q.client_id!, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: (q.state ?? '').slice(0, 500) }, cliente: cli.nombre || 'Claude' };
}

// Quién está en el CRM (Access, «Ingresar con Google» o desarrollo). Sin sesión: al login, y de vuelta acá.
async function quien(c: { env: Env; req: { raw: Request; url: string } }): Promise<User | Response> {
  try { return (await authenticate(c.env, c.req.raw)).user; } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      const u = new URL(c.req.url);
      return Response.redirect(`${u.origin}/login?volver=${encodeURIComponent(u.pathname + u.search)}`, 302);
    }
    return pagina({ titulo: 'No se puede conectar', texto: (e as Error).message }, 403);
  }
}

const vuelta = (p: Pedido, extra: Record<string, string>) => {
  const u = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  if (p.state) u.searchParams.set('state', p.state);
  return u.toString();
};

conectar.get('/conectar/autorizar', async (c) => {
  const v = await validarPedido(c.env.DB, c.req.query());
  if ('error' in v) return pagina({ titulo: 'No se puede conectar', texto: v.error }, 400);
  const u = await quien(c);
  if (u instanceof Response) return u;
  return pagina({ titulo: `Conectar ${v.cliente} con Formas CRM`, usuario: u, cliente: v.cliente, pedido: v.pedido, host: new URL(v.pedido.redirect_uri).host });
});

conectar.post('/conectar/autorizar', async (c) => {
  // Solo desde la página del CRM (no desde un formulario armado en otro sitio).
  const origen = c.req.header('origin');
  if (origen && origen !== base(c.req.raw)) return pagina({ titulo: 'No se puede conectar', texto: 'El pedido vino de otra página.' }, 403);
  const f = Object.fromEntries([...(await c.req.formData()).entries()].map(([k, x]) => [k, String(x)]));
  const v = await validarPedido(c.env.DB, { ...f, response_type: 'code' });
  if ('error' in v) return pagina({ titulo: 'No se puede conectar', texto: v.error }, 400);
  const u = await quien(c);
  if (u instanceof Response) return u;
  if (f.decision !== 'permitir') return Response.redirect(vuelta(v.pedido, { error: 'access_denied', error_description: 'No se dio permiso.' }), 302);
  const code = aleatorio();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_codigos WHERE expira < ?').bind(new Date().toISOString()),
    c.env.DB.prepare('INSERT INTO oauth_codigos (code_hash, client_id, user_id, redirect_uri, challenge, expira) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256(code), v.pedido.client_id, u.id, v.pedido.redirect_uri, v.pedido.code_challenge, new Date(Date.now() + MINUTOS_CODIGO * 60_000).toISOString()),
  ]);
  return Response.redirect(vuelta(v.pedido, { code, iss: base(c.req.raw) }), 302);
});

// ---------- Tokens ----------

async function leerCuerpo(req: Request): Promise<Record<string, string>> {
  const tipo = req.headers.get('content-type') ?? '';
  if (tipo.includes('application/json')) return Object.fromEntries(Object.entries(await req.json().catch(() => ({})) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  return Object.fromEntries([...new URLSearchParams(await req.text()).entries()]);
}
const entregar = (acceso: string, renovar: string) => new Response(JSON.stringify({
  access_token: acceso, token_type: 'Bearer', expires_in: DIAS_ACCESO * 86400, refresh_token: renovar, scope: 'crm',
}), { status: 200, headers: { 'content-type': 'application/json', ...CORS, ...NO_GUARDAR } });

conectar.post('/mcp/oauth/token', async (c) => {
  const f = await leerCuerpo(c.req.raw);
  const db = c.env.DB;
  if (f.grant_type === 'authorization_code') {
    if (!f.code || !f.code_verifier) return errorOauth('invalid_request', 'Falta el código o la verificación.');
    const hash = await sha256(f.code);
    const cod = await db.prepare('DELETE FROM oauth_codigos WHERE code_hash = ? RETURNING *').bind(hash)
      .first<{ client_id: string; user_id: number; redirect_uri: string; challenge: string; expira: string }>();
    if (!cod || cod.expira < new Date().toISOString()) return errorOauth('invalid_grant', 'El código venció o ya se usó: conectá de nuevo.');
    if (f.client_id && f.client_id !== cod.client_id) return errorOauth('invalid_grant', 'El código es de otra app.');
    if (f.redirect_uri && f.redirect_uri !== cod.redirect_uri) return errorOauth('invalid_grant', 'La dirección de vuelta no coincide.');
    if (await sha256b64url(f.code_verifier) !== cod.challenge) return errorOauth('invalid_grant', 'La verificación (PKCE) no coincide.');
    const user = await db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').bind(cod.user_id).first<{ id: number; name: string }>();
    if (!user) return errorOauth('invalid_grant', 'El usuario ya no está activo en el CRM.');
    const cli = await db.prepare('SELECT nombre FROM oauth_clientes WHERE client_id = ?').bind(cod.client_id).first<{ nombre: string }>();
    const acceso = newToken();
    const renovar = `fcrr_${aleatorio()}`;
    await db.prepare(`INSERT INTO api_tokens (name, token_hash, user_id, source, client_id, expires_at, refresh_hash, refresh_expira)
      VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?)`).bind(`${cli?.nombre || 'Claude'} (conectado desde Claude)`, await sha256(acceso), user.id, cod.client_id,
      masDias(DIAS_ACCESO), await sha256(renovar), masDias(DIAS_RENOVAR)).run();
    return entregar(acceso, renovar);
  }
  if (f.grant_type === 'refresh_token') {
    if (!f.refresh_token) return errorOauth('invalid_request', 'Falta refresh_token.');
    const t = await db.prepare(`SELECT t.id, t.client_id FROM api_tokens t JOIN users u ON u.id = t.user_id AND u.active = 1 AND u.deleted_at IS NULL
      WHERE t.refresh_hash = ? AND t.revoked = 0 AND t.refresh_expira > ?`).bind(await sha256(f.refresh_token), new Date().toISOString()).first<{ id: number; client_id: string | null }>();
    if (!t || (f.client_id && t.client_id && f.client_id !== t.client_id)) return errorOauth('invalid_grant', 'La conexión venció o se desconectó: conectá de nuevo desde Claude.');
    // Los dos se renuevan (el anterior deja de servir).
    const acceso = newToken();
    const renovar = `fcrr_${aleatorio()}`;
    await db.prepare('UPDATE api_tokens SET token_hash = ?, expires_at = ?, refresh_hash = ?, refresh_expira = ? WHERE id = ?')
      .bind(await sha256(acceso), masDias(DIAS_ACCESO), await sha256(renovar), masDias(DIAS_RENOVAR), t.id).run();
    return entregar(acceso, renovar);
  }
  return errorOauth('unsupported_grant_type', 'Solo authorization_code y refresh_token.');
});

// Revocar (RFC 7009): siempre contesta 200.
conectar.post('/mcp/oauth/revoke', async (c) => {
  const f = await leerCuerpo(c.req.raw);
  if (f.token) {
    const h = await sha256(f.token);
    await c.env.DB.prepare("UPDATE api_tokens SET revoked = 1 WHERE source = 'mcp' AND client_id IS NOT NULL AND (token_hash = ? OR refresh_hash = ?)").bind(h, h).run();
  }
  return new Response(null, { status: 200, headers: CORS });
});

// ---------- La página ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

function pagina(d: { titulo: string; texto?: string; usuario?: User; cliente?: string; pedido?: Pedido; host?: string }, status = 200) {
  const permiso = d.usuario && d.pedido;
  const admin = d.usuario?.role === 'admin';
  const ocultos = d.pedido ? Object.entries(d.pedido).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}" />`).join('') : '';
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(d.titulo)} · Formas CRM</title><meta name="robots" content="noindex" /><meta name="color-scheme" content="light dark" />
<link rel="icon" href="/formas-favicon.svg" type="image/svg+xml" />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: light; --navy: #000085; --canvas: #f4f5f9; --surface: #fff; --ink: #12143a; --ink-2: #4b4f6b; --line: #e3e6ee; --ok: #2b7a39; --ok-soft: #e6f5e9; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --canvas: #0b0c1e; --surface: #12142b; --ink: #eef0fa; --ink-2: #b9bdd6; --line: #262a4a; --navy: #8cc63f; --ok: #8fe09c; --ok-soft: #13301d; } }
  * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--canvas); color: var(--ink);
    font: 15px/1.5 'Poppins', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
  .caja { width: min(460px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 28px; box-shadow: 0 8px 24px rgba(18, 20, 58, .08); }
  h1 { font-size: 20px; margin: 0 0 6px; line-height: 1.3; } p { margin: 0 0 12px; color: var(--ink-2); }
  .quien { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin: 14px 0; }
  .quien b { color: var(--ink); } ul { margin: 0 0 16px; padding-left: 20px; color: var(--ink-2); } li { margin: 4px 0; }
  .acciones { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button { font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 18px; cursor: pointer; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
  button.si { background: var(--navy); border-color: var(--navy); color: #fff; } @media (prefers-color-scheme: dark) { button.si { color: #12142b; } }
  .chico { font-size: 12px; color: var(--ink-2); margin-top: 14px; } .logo { height: 28px; margin-bottom: 18px; }
</style></head><body><main class="caja">
<img class="logo" src="/login/formas-logo.png" alt="Formas" onerror="this.remove()" />
<h1>${esc(d.titulo)}</h1>
${permiso ? `<p>${esc(d.cliente ?? 'Claude')} va a poder usar el CRM como vos:</p>
<div class="quien">✓ <span><b>${esc(d.usuario!.name)}</b><br/><span class="chico">${esc(d.usuario!.email)}</span></span></div>
<ul><li>Ve lo mismo que ves vos en el CRM, ni más ni menos.</li>
${admin ? '<li>Como sos administrador, puede cargar y cambiar cualquier cosa.</li>' : '<li>Puede cargar y cambiar <b>solo lo tuyo</b>: tus registros, los que no tienen propietario y tus tareas.</li>'}
<li>Todo lo que haga queda en el historial, a tu nombre, con origen «Claude».</li></ul>
<form method="post" action="/conectar/autorizar">${ocultos}
<div class="acciones"><button type="submit" name="decision" value="cancelar">Cancelar</button><button class="si" type="submit" name="decision" value="permitir" autofocus>Permitir</button></div></form>
<p class="chico">Vuelve a ${esc(d.host ?? '')}. Lo podés desconectar cuando quieras desde el CRM (abajo a la izquierda, «Conectar con Claude»).</p>`
    : `<p>${esc(d.texto ?? '')}</p>`}
</main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...NO_GUARDAR } });
}
