import type { Env, User, Ctx } from './env';
import { HttpError } from './env';

// Quién hace el pedido:
// 1. Token propio (Authorization: Bearer fcrm_…, o /mcp/<token>): Claude, Darwin/Pipedream, Zapier, formularios.
// 2. Cloudflare Access: el mail del JWT `Cf-Access-Jwt-Assertion`, verificado contra las claves del equipo.
// 3. Desarrollo local: DEV_USER_EMAIL.

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

function nameFromEmail(email: string) {
  return email.split('@')[0].split(/[._-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

async function userByEmail(env: Env, email: string): Promise<User> {
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
    return { user: await userByEmail(env, email), source: 'crm' };
  }
  if (env.DEV_USER_EMAIL) {
    const email = req.headers.get('x-dev-user') || env.DEV_USER_EMAIL;
    return { user: await userByEmail(env, email), source: 'crm' };
  }
  throw new HttpError(401, 'Falta iniciar sesión (Cloudflare Access) o un token.');
}

export function requireRole(ctx: Ctx, ...roles: User['role'][]) {
  if (!roles.includes(ctx.user.role)) throw new HttpError(403, 'No tenés permiso para esto.');
}

export function canWrite(ctx: Ctx) {
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'Tu usuario es de solo lectura.');
}
