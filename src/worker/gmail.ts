import type { Ctx, Env, User } from './env';
import { now } from './env';
import { createActivity } from './activities';
import { findContact, upsertContact } from './upsert';
import type { RecordRow } from './records';

// Registro automático de mails, como la conexión de bandeja de HubSpot: cada 10 minutos lee los Gmail del equipo
// (cuenta de servicio con delegación de dominio, solo lectura) y guarda en el CRM los mails con contactos.
// - Recibidos: solo si el remitente ya es contacto.
// - Enviados: si el destinatario no existe y `create_contacts_on_sent` está activo, se crea el contacto (como el
//   botón «Registrar» de la extensión de HubSpot).
// - El mismo mail en dos bandejas del equipo se guarda una vez (se deduplica por Message-ID).

export interface GmailConfig {
  enabled: boolean;
  internal_domains: string[];
  ignore_domains: string[];
  ignore_addresses: string[];
  create_contacts_on_sent: boolean;
  users: string[] | 'all';
  lookback_days: number;
}

export const DEFAULT_GMAIL: GmailConfig = {
  enabled: false,
  internal_domains: ['formaspublicitarias.com', 'formas.ar', 'soutex.com.ar'],
  ignore_domains: ['google.com', 'hubspot.com', 'mercadolibre.com', 'mercadolibre.com.ar', 'afip.gob.ar', 'arca.gob.ar', 'clickup.com', 'getdarwin.ai'],
  ignore_addresses: [],
  create_contacts_on_sent: true,
  users: 'all',
  lookback_days: 2,
};

export async function gmailConfig(db: D1Database): Promise<GmailConfig> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'gmail'").first<{ value: string }>();
  return { ...DEFAULT_GMAIL, ...(row ? JSON.parse(row.value) : {}) };
}

// ---------- Token de la cuenta de servicio ----------

function b64url(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function serviceToken(env: Env, subject: string): Promise<string> {
  const sa = JSON.parse(env.GOOGLE_SA_JSON!) as { client_email: string; private_key: string; token_uri?: string };
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const tokenUri = env.GOOGLE_TOKEN_URL ?? sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, sub: subject, scope: 'https://www.googleapis.com/auth/gmail.readonly', aud: tokenUri, iat, exp: iat + 3600,
  }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${b64url(sig)}`,
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!data.access_token) throw new Error(`Google no dio acceso a ${subject}: ${data.error_description ?? data.error ?? res.status}`);
  return data.access_token;
}

// ---------- Lectura de mensajes ----------

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{ name: string; value: string }> }
interface GMessage { id: string; threadId: string; labelIds?: string[]; internalDate: string; snippet?: string; payload: Part }

function decode(data?: string) {
  if (!data) return '';
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function findPart(p: Part, mime: string): string {
  if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
  for (const c of p.parts ?? []) {
    const r = findPart(c, mime);
    if (r) return r;
  }
  return '';
}

export function textOf(p: Part) {
  const plain = findPart(p, 'text/plain');
  const raw = plain || findPart(p, 'text/html').replace(/<(br|\/p|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  // Corta la cita del mail anterior ("El jue, 22 oct 2026 … escribió:" / "On … wrote:").
  const cut = raw.search(/\n\s*(El .{5,80}(escribió|wrote):|On .{5,80}wrote:|-----Original Message-----|De: .+\nEnviado)/);
  return (cut > 0 ? raw.slice(0, cut) : raw).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

export function addresses(v?: string) {
  if (!v) return [] as Array<{ email: string; name: string }>;
  const out: Array<{ email: string; name: string }> = [];
  for (const part of v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? part.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (m) out.push({ name: m[1].trim(), email: m[2].trim().toLowerCase() });
  }
  return out;
}

const header = (m: GMessage, name: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

async function openDealOf(db: D1Database, contactId: number) {
  const { results } = await db.prepare(
    `SELECT d.id FROM associations a JOIN records d ON d.id = a.to_id AND d.archived = 0 JOIN stages s ON s.id = d.stage_id AND s.is_closed = 0
     WHERE a.from_id = ? AND a.to_type = 'deal'`,
  ).bind(contactId).all<{ id: number }>();
  return results.length === 1 ? results[0].id : null;
}

export async function syncMailbox(env: Env, user: User, cfg: GmailConfig, maxMessages = 150) {
  const db = env.DB;
  const api = env.GMAIL_API_URL ?? 'https://gmail.googleapis.com';
  const token = await serviceToken(env, user.email);
  const stateKey = `gmail_state:${user.email}`;
  const state = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(stateKey).first<{ value: string }>();
  const since = state ? (JSON.parse(state.value) as { after: number }).after : Math.floor(Date.now() / 1000) - cfg.lookback_days * 86400;
  const startedAt = Math.floor(Date.now() / 1000);
  const q = `after:${since - 600} -in:chats -in:spam -in:trash -category:promotions -category:social`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch(`${api}/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    ids.push(...(data.messages ?? []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < 1000);

  const ctx: Ctx = { user, source: 'gmail' };
  const internal = (e: string) => cfg.internal_domains.some((d) => e.endsWith(`@${d}`));
  const ignored = (e: string) => cfg.ignore_addresses.includes(e) || cfg.ignore_domains.some((d) => e.endsWith(`@${d}`) || e.endsWith(`.${d}`))
    || /^(no-?reply|noreply|notifications?|mailer-daemon|postmaster)@/.test(e);
  let logged = 0;
  let lastSeen = since;
  // Gmail lista del más nuevo al más viejo: se procesa desde el más viejo para poder seguir donde quedó.
  const batch = ids.reverse().slice(0, maxMessages);
  for (const id of batch) {
    const res = await fetch(`${api}/gmail/v1/users/me/messages/${id}?format=full`, { headers: { authorization: `Bearer ${token}` } });
    const m = (await res.json()) as GMessage;
    if (!m.payload) continue;
    lastSeen = Math.max(lastSeen, Math.floor(Number(m.internalDate) / 1000));
    const messageId = header(m, 'Message-ID') || `${user.email}:${m.id}`;
    const from = addresses(header(m, 'From'))[0];
    if (!from) continue;
    const to = addresses(header(m, 'To'));
    const cc = addresses(header(m, 'Cc'));
    const outgoing = from.email === user.email.toLowerCase() || (m.labelIds ?? []).includes('SENT');
    const external = (outgoing ? [...to, ...cc] : [from]).filter((a) => !internal(a.email) && !ignored(a.email));
    if (!external.length) continue;
    const contacts: RecordRow[] = [];
    for (const a of external.slice(0, 10)) {
      let c = await findContact(db, { email: a.email });
      if (!c && outgoing && cfg.create_contacts_on_sent && a === external[0]) {
        const [firstname, ...rest] = a.name.replace(/['"]/g, '').split(/\s+/).filter(Boolean);
        c = (await upsertContact(db, { ...ctx, sourceDetail: 'mail enviado' }, { email: a.email, firstname, lastname: rest.join(' ') || undefined, owner_id: user.id, origen_del_contacto: 'Contacto por email' })).row;
      }
      if (c) contacts.push(c);
    }
    if (!contacts.length) continue;
    const links = contacts.map((c) => c.id);
    for (const c of contacts) {
      const deal = await openDealOf(db, c.id);
      if (deal) links.push(deal);
    }
    await createActivity(db, ctx, {
      type: 'email', direction: outgoing ? 'out' : 'in', subject: header(m, 'Subject'), body: textOf(m.payload),
      occurred_at: new Date(Number(m.internalDate)).toISOString(), owner_id: user.id, thread_id: m.threadId, external_id: messageId, links,
      meta: { from: from.email, to: to.map((a) => a.email).join(';'), cc: cc.map((a) => a.email).join(';'), gmail_id: m.id, mailbox: user.email },
    });
    logged++;
  }
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(stateKey, JSON.stringify({ after: ids.length > batch.length ? lastSeen : startedAt, at: now(), seen: batch.length, pending: ids.length - batch.length, logged })).run();
  return { mailbox: user.email, seen: batch.length, pending: ids.length - batch.length, logged };
}

export async function syncAll(env: Env) {
  if (!env.GOOGLE_SA_JSON) return [{ error: 'Falta el secreto GOOGLE_SA_JSON.' }];
  const cfg = await gmailConfig(env.DB);
  if (!cfg.enabled) return [{ skipped: 'La sincronización de Gmail está apagada.' }];
  const { results } = await env.DB.prepare('SELECT * FROM users WHERE active = 1').all<User>();
  const users = results.filter((u) => cfg.internal_domains.some((d) => u.email.endsWith(`@${d}`)) && (cfg.users === 'all' || cfg.users.includes(u.email)));
  const out = [];
  for (const u of users) {
    try { out.push(await syncMailbox(env, u, cfg)); } catch (e) { out.push({ mailbox: u.email, error: (e as Error).message }); }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gmail_last_run', ?)").bind(JSON.stringify({ at: now(), out })).run();
  return out;
}
