import type { Env, User, Ctx } from './env';
import { HttpError } from './env';

// Quién hace el pedido:
// 1. Token propio (Authorization: Bearer fcrm_…, o /mcp/<token>): Claude, Darwin/Pipedream, Zapier, formularios.
// 2. Cloudflare Access: el mail del JWT `Cf-Access-Jwt-Assertion`, verificado contra las claves del equipo.
// 3. Sesión propia del CRM: la cookie `crm_sesion` que deja «Ingresar con Google» (login.ts), firmada con SESSION_SECRET.
// 4. Desarrollo local: DEV_USER_EMAIL.

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'fcrm_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function userFromToken(env: Env, token: string): Promise<{ user: User; source: string; name: string; tokenId: number } | null> {
  if (!token.startsWith('fcrm_')) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.source, t.name AS token_name, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked = 0 AND u.active = 1`,
  ).bind(hash).first<User & { token_id: number; source: string; token_name: string }>();
  if (!row) return null;
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), row.token_id).run();
  const { token_id, source, token_name, ...user } = row;
  return { user: user as User, source, name: token_name, tokenId: token_id };
}

let jwksCache: { at: number; keys: JsonWebKey[] } | null = null;

async function accessKeys(team: string) {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const data = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { at: Date.now(), keys: data.keys };
  return data.keys;
}

function b64urlDecode(s: string) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function verifyAccessJwt(env: Env, jwt: string): Promise<string | null> {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  const team = env.ACCESS_TEAM_DOMAIN!.includes('.') ? env.ACCESS_TEAM_DOMAIN! : `${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  const keys = await accessKeys(team);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload.email ?? null;
}

// ---------- Sesión propia (login con Google, login.ts) ----------
// La cookie lleva el mail y el vencimiento, firmados con HMAC-SHA256 (SESSION_SECRET). No hace falta guardarla en la
// base: quien entra lo sigue decidiendo la lista de usuarios (desactivar a alguien lo deja afuera en el próximo pedido).
export const COOKIE_SESION = 'crm_sesion';
export const DIAS_SESION = 30;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
function igualSeguro(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Firma un contenido cualquiera (la sesión, o el estado del ida y vuelta a Google): «base64.firma».
export async function firmar(secret: string, contenido: Record<string, unknown>) {
  const datos = b64url(new TextEncoder().encode(JSON.stringify(contenido)));
  return `${datos}.${await hmac(secret, datos)}`;
}
export async function leerFirmado<T extends { exp: number }>(secret: string, valor: string | null | undefined): Promise<T | null> {
  if (!valor) return null;
  const [datos, firma] = valor.split('.');
  if (!datos || !firma || !igualSeguro(firma, await hmac(secret, datos))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(datos))) as T;
    return typeof c.exp === 'number' && c.exp > Date.now() ? c : null;
  } catch { return null; }
}
export function leerCookie(req: Request, nombre: string) {
  for (const parte of (req.headers.get('cookie') ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
export const nuevaSesion = (env: Env, email: string) => firmar(env.SESSION_SECRET!, { email, exp: Date.now() + DIAS_SESION * 86400_000 });
// Un cambio (POST, PATCH, DELETE…) con la cookie solo vale desde el mismo CRM: si el navegador manda el origen, tiene que
// ser este. La cookie ya es SameSite=Lax; esto es una vuelta más contra pedidos armados desde otra página.
function mismoOrigen(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origen = req.headers.get('origin');
  return !origen || origen === new URL(req.url).origin;
}

function nameFromEmail(email: string) {
  return email.split('@')[0].split(/[._-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export async function userByEmail(env: Env, email: string): Promise<User> {
  const sinUsuario = () => new HttpError(403, `Tu mail (${email}) no tiene usuario en el CRM. Pedile a un administrador que te agregue en Configuración → Usuarios.`);
  const found = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
  if (found) {
    if (found.deleted_at) throw sinUsuario();
    if (!found.active) throw new HttpError(403, 'Tu usuario está desactivado en el CRM.');
    return found;
  }
  // Quién entra lo decide la lista de Configuración → Usuarios: Access solo verifica que el mail sea de Formas.
  // Las únicas altas automáticas son el primer usuario y ADMIN_EMAIL, para que el CRM nunca quede sin administrador.
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const isAdmin = (count?.n ?? 0) === 0 || (env.ADMIN_EMAIL && env.ADMIN_EMAIL.toLowerCase() === email.toLowerCase());
  if (!isAdmin) throw sinUsuario();
  return (await env.DB.prepare("INSERT INTO users (email, name, role, profile) VALUES (?, ?, 'admin', 'admin') RETURNING *")
    .bind(email, nameFromEmail(email)).first<User>())!;
}

// Los links de los choferes (tokens tipo «chofer») solo sirven para la app de remitos (/hooks/chofer/api): si uno se
// filtra, no abre el resto del CRM.
export async function authenticate(env: Env, req: Request, pathToken?: string, opts: { chofer?: boolean } = {}): Promise<Ctx> {
  const auth = req.headers.get('authorization');
  const bearer = pathToken ?? (auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null) ?? new URL(req.url).searchParams.get('token');
  if (bearer) {
    const t = await userFromToken(env, bearer);
    if (!t) throw new HttpError(401, 'Token inválido o revocado.');
    if ((t.source === 'chofer') !== !!opts.chofer) throw new HttpError(t.source === 'chofer' ? 403 : 401, t.source === 'chofer' ? 'El link del chofer solo sirve para mandar remitos.' : 'Este token no es de un chofer.');
    return { user: t.user, source: t.source, sourceDetail: t.name, tokenId: t.tokenId };
  }
  if (opts.chofer) throw new HttpError(401, 'Falta el link del chofer.');
  const jwt = req.headers.get('cf-access-jwt-assertion');
  if (jwt && env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    const email = await verifyAccessJwt(env, jwt);
    if (!email) throw new HttpError(401, 'No se pudo verificar la sesión de Cloudflare Access.');
    return verComo(env, req, { user: await userByEmail(env, email), source: 'crm' });
  }
  const sesion = env.SESSION_SECRET ? await leerFirmado<{ email: string; exp: number }>(env.SESSION_SECRET, leerCookie(req, COOKIE_SESION)) : null;
  if (sesion) {
    if (!mismoOrigen(req)) throw new HttpError(403, 'Pedido desde otra página: se rechaza.');
    return verComo(env, req, { user: await userByEmail(env, sesion.email), source: 'crm' });
  }
  if (env.DEV_USER_EMAIL) {
    const email = req.headers.get('x-dev-user') || env.DEV_USER_EMAIL;
    return verComo(env, req, { user: await userByEmail(env, email), source: 'crm' });
  }
  throw new HttpError(401, 'Tu sesión terminó: volvé a ingresar con Google.', { login: '/login' });
}

// Superadmin: un administrador con la marca (Configuración → Usuarios) o el administrador principal (ADMIN_EMAIL).
export function esSuperadmin(env: Env, u: User) {
  return u.role === 'admin' && (!!u.superadmin || (!!env.ADMIN_EMAIL && u.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()));
}

// «Ver como» (pedido de Rodrigo del 12/11/2026): un superadmin, desde su sesión, mira el CRM como lo ve otro usuario
// (sus pipelines, sus tareas, sus conversaciones, lo que puede y no puede hacer). La pantalla manda el id en la cabecera
// x-ver-como en cada pedido. Solo con la sesión (Cloudflare Access o «Ingresar con Google»; nunca con un token) y solo para mirar: cualquier
// cambio se rechaza (api.ts), así nada queda hecho a nombre del otro.
async function verComo(env: Env, req: Request, ctx: Ctx): Promise<Ctx> {
  const v = req.headers.get('x-ver-como');
  if (!v) return ctx;
  const invalido = (msg: string) => new HttpError(403, msg, { ver_como_invalido: true });
  if (!esSuperadmin(env, ctx.user)) throw invalido('Solo un superadmin puede ver el CRM como otro usuario.');
  const id = Number(v);
  if (id === ctx.user.id) return ctx;
  const otro = Number.isInteger(id) && id > 0
    ? await env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').bind(id).first<User>() : null;
  if (!otro) throw invalido('Ese usuario ya no está activo: volvés a tu usuario.');
  return { ...ctx, user: otro, realUser: ctx.user };
}

export function requireRole(ctx: Ctx, ...roles: User['role'][]) {
  if (!roles.includes(ctx.user.role)) throw new HttpError(403, 'No tenés permiso para esto.');
}

export function canWrite(ctx: Ctx) {
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'Tu usuario es de solo lectura.');
}
