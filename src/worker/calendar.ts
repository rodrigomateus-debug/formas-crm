import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { createActivity, updateActivity, type ActivityRow } from './activities';
import { findContact, upsertContact } from './upsert';
import { updateRecord, type Props, type RecordRow } from './records';
import { Budget, OutOfBudget } from './budget';
import { serviceToken } from './google';
import { gmailConfig, openDealOf, personName } from './gmail';

// Google Calendar (pedido de Rodrigo del 18/11/2026), con la misma cuenta de servicio que Gmail (delegación de dominio,
// permiso calendar.events):
// - Leer: cada 10 minutos mira los calendarios del equipo. Una reunión con invitados de afuera queda registrada como
//   actividad «Reunión» en sus contactos (y, por el contacto, en su empresa y su negocio abierto). Los invitados que no
//   son contactos se crean (y su empresa sale del dominio del mail, como con Gmail). Si la reunión se mueve, se actualiza;
//   si se cancela, se archiva.
// - Agendar: desde la ficha se arma la reunión en el calendario de quien la crea, con las invitaciones y el link de Meet.
// La misma reunión en dos calendarios del equipo se guarda una vez (se deduplica por el iCalUID del evento).
// Usa los dominios propios y los ignorados de la configuración de Gmail.

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface CalendarConfig {
  enabled: boolean;
  create_contacts: boolean;
  users: string[] | 'all';
  lookback_days: number;
}

export const DEFAULT_CALENDAR: CalendarConfig = { enabled: false, create_contacts: true, users: 'all', lookback_days: 30 };

export async function calendarConfig(db: D1Database): Promise<CalendarConfig> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'calendar'").first<{ value: string }>();
  return { ...DEFAULT_CALENDAR, ...(row ? JSON.parse(row.value) : {}) };
}

interface GDate { dateTime?: string; date?: string; timeZone?: string }
interface GAttendee { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean; resource?: boolean }
export interface GEvent {
  id: string; iCalUID?: string; status?: string; summary?: string; description?: string; location?: string; htmlLink?: string; hangoutLink?: string;
  start?: GDate; end?: GDate; originalStartTime?: GDate; recurringEventId?: string; attendees?: GAttendee[]; organizer?: { email?: string; self?: boolean };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attachments?: Array<{ fileId?: string; fileUrl?: string; title?: string; mimeType?: string }>;
}

// ---------- Resumen de la reunión (Gemini en Meet) ----------
// Cuando la reunión se graba con «Tomar notas con Gemini», Meet adjunta al evento un documento («Notas de Gemini» /
// «Notes by Gemini»). La pasada del calendario lo ve (el evento cambia), lo lee por Drive como quien tiene el calendario y
// guarda un resumen breve en la reunión. Los resúmenes de Claude llegan por el conector (herramienta resumen_reunion, mcp.ts).
const DRIVE_LECTURA = 'https://www.googleapis.com/auth/drive';
const esNotas = (a: { title?: string; mimeType?: string }) => a.mimeType === 'application/vnd.google-apps.document' && /gemini|notas|notes|resumen|summary|transcri/i.test(a.title ?? '');

// Del texto del documento: la sección de resumen («Resumen» / «Summary»), sin los detalles ni la transcripción.
export function resumenDeNotas(texto: string, max = 900) {
  const t = texto.replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const m = t.match(/(?:^|\n)\s*(?:resumen|summary)\s*\n([\s\S]*?)(?:\n\s*(?:detalles|details|pr[oó]ximos pasos(?: sugeridos)?|suggested next steps|next steps|transcripci[oó]n|transcript)\s*\n|$)/i);
  const cuerpo = (m ? m[1] : t).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return cuerpo.length > max ? `${cuerpo.slice(0, max).replace(/\s+\S*$/, '')}…` : cuerpo;
}

async function leerNotas(env: Env, user: User, fileId: string) {
  const token = await serviceToken(env, user.email, DRIVE_LECTURA);
  const drive = (env.DRIVE_API_URL ?? 'https://www.googleapis.com').replace(/\/$/, '');
  const res = await fetch(`${drive}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive no dejó leer las notas de la reunión (${res.status})`);
  return res.text();
}

const api = (env: Env) => `${env.CALENDAR_API_URL ?? 'https://www.googleapis.com'}/calendar/v3`;
const fecha = (d?: GDate) => (d?.dateTime ? new Date(d.dateTime).toISOString() : d?.date ? new Date(`${d.date}T12:00:00Z`).toISOString() : null);
// La clave de la reunión: la misma en todos los calendarios del equipo; en una serie, una por cada vez.
export const claveEvento = (e: GEvent) => `gcal:${e.iCalUID ?? e.id}${e.recurringEventId ? `:${fecha(e.originalStartTime) ?? e.id}` : ''}`;
const linkMeet = (e: GEvent) => e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;

async function filtros(db: D1Database) {
  const g = await gmailConfig(db);
  const internal = (e: string) => g.internal_domains.some((d) => e.endsWith(`@${d}`));
  const ignored = (e: string) => g.ignore_addresses.includes(e) || g.ignore_domains.some((d) => e.endsWith(`@${d}`) || e.endsWith(`.${d}`))
    || e.endsWith('calendar.google.com') || /^(no-?reply|notifications?)([-+._][^@]*)?@/.test(e);
  return { internal, ignored, dominios: g.internal_domains };
}

// Quién es dueña de la reunión en el CRM: quien la organizó, si es del equipo; si no, la del calendario.
async function duenio(db: D1Database, e: GEvent, user: User) {
  const org = e.organizer?.email?.toLowerCase();
  if (!org || org === user.email.toLowerCase()) return user.id;
  const u = await db.prepare('SELECT id FROM users WHERE lower(email) = ? AND active = 1').bind(org).first<{ id: number }>();
  return u?.id ?? user.id;
}

function metaDe(e: GEvent, user: User, externos: string[]) {
  return {
    end_at: fecha(e.end), location: e.location ?? null, meet: linkMeet(e), html_link: e.htmlLink ?? null, calendar_event_id: e.id,
    calendar: user.email, organizer: e.organizer?.email ?? null, attendees: (e.attendees ?? []).filter((a) => a.email && !a.resource).map((a) => a.email!.toLowerCase()).join(';'),
    externos: externos.join(';'), all_day: !e.start?.dateTime,
  };
}

// Registra (o actualiza) una reunión del calendario. Devuelve qué hizo.
export async function registrarEvento(env: Env, user: User, e: GEvent, cfg: CalendarConfig, f?: Awaited<ReturnType<typeof filtros>>): Promise<'nueva' | 'actualizada' | 'archivada' | null> {
  const db = env.DB;
  const ctx: Ctx = { user, source: 'calendar' };
  const clave = claveEvento(e);
  const prev = await db.prepare("SELECT * FROM activities WHERE type = 'meeting' AND external_id = ?").bind(clave).first<ActivityRow>();
  if (e.status === 'cancelled') {
    if (prev && !prev.archived) { await updateActivity(db, ctx, prev.id, { archived: true }); return 'archivada'; }
    return null;
  }
  const inicio = fecha(e.start);
  if (!inicio) return null;
  f ??= await filtros(db);
  const externos = (e.attendees ?? []).filter((a) => a.email && !a.resource && a.responseStatus !== 'declined')
    .map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName ?? '' }))
    .filter((a) => !f!.internal(a.email) && !f!.ignored(a.email));
  if (!externos.length) {
    // Ya no tiene invitados de afuera (los sacaron): si la había registrado el calendario, se archiva.
    if (prev && !prev.archived && prev.source === 'calendar') { await updateActivity(db, ctx, prev.id, { archived: true }); return 'archivada'; }
    return null;
  }
  const owner = await duenio(db, e, user);
  const contactos: RecordRow[] = [];
  for (const a of externos.slice(0, 15)) {
    let c = await findContact(db, { email: a.email });
    const name = personName(a.name);
    if (!c && cfg.create_contacts) {
      c = (await upsertContact(db, { ...ctx, sourceDetail: 'reunión del calendario' }, { email: a.email, ...name, owner_id: owner, origen_del_contacto: 'Contacto por email' })).row;
    } else if (c && name.firstname) {
      const cur = JSON.parse(c.props) as Props;
      if (!cur.firstname && !cur.lastname) c = await updateRecord(db, ctx, 'contact', c.id, name, { strict: false });
    }
    if (c) contactos.push(c);
  }
  if (!contactos.length) return null;
  const links = contactos.map((c) => c.id);
  for (const c of contactos) { const d = await openDealOf(db, c.id); if (d) links.push(d); }
  const datos = { subject: e.summary ?? 'Reunión', body: e.description ?? '', occurred_at: inicio, meta: metaDe(e, user, externos.map((a) => a.email)) as Record<string, unknown> };
  // Notas de Gemini adjuntas: se leen una vez (si ya hay resumen de esas notas, no se vuelven a pedir).
  const notas = (e.attachments ?? []).find(esNotas);
  const prevMeta = prev ? JSON.parse(prev.meta || '{}') as Record<string, unknown> : {};
  if (notas?.fileId && prevMeta.notas_id !== notas.fileId) {
    try {
      const resumen = resumenDeNotas(await leerNotas(env, user, notas.fileId));
      if (resumen) Object.assign(datos.meta, { resumen, resumen_de: 'Gemini', notas_url: notas.fileUrl ?? null, notas_id: notas.fileId });
    } catch (err) { console.error((err as Error).message); }
  }
  if (prev) {
    const cambio = prev.subject !== datos.subject || prev.occurred_at !== datos.occurred_at || prev.archived || (prev.body ?? '') !== datos.body
      || prevMeta.end_at !== datos.meta.end_at || (!!datos.meta.resumen && prevMeta.resumen !== datos.meta.resumen);
    // Los vínculos nuevos (un invitado que se sumó) se agregan con createActivity, que con el mismo external_id solo suma vínculos.
    await createActivity(db, ctx, { type: 'meeting', external_id: clave, links, ...datos, owner_id: owner });
    if (!cambio) return null;
    await updateActivity(db, ctx, prev.id, { ...datos, meta: { ...prevMeta, ...datos.meta }, ...(prev.archived ? { archived: false } : {}) });
    return 'actualizada';
  }
  await createActivity(db, ctx, { type: 'meeting', external_id: clave, links, owner_id: owner, ...datos });
  return 'nueva';
}

export async function syncCalendar(env: Env, user: User, cfg: CalendarConfig, b: Budget = Budget.of(env)) {
  const db = env.DB;
  b.take();
  const token = await serviceToken(env, user.email, CALENDAR_SCOPE);
  const stateKey = `calendar_state:${user.email}`;
  const state = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(stateKey).first<{ value: string }>();
  const prev = state ? (JSON.parse(state.value) as { after: string }) : null;
  const startedAt = new Date().toISOString();
  const f = await filtros(db);
  const desde = new Date(Date.now() - cfg.lookback_days * 86_400_000).toISOString();
  const hasta = new Date(Date.now() + 180 * 86_400_000).toISOString();
  // La primera vez, las reuniones de los últimos días y las que vienen; después, solo las que cambiaron desde la última
  // pasada (con 10 minutos de margen).
  const base = `singleEvents=true&showDeleted=true&maxResults=250&timeMin=${encodeURIComponent(desde)}&timeMax=${encodeURIComponent(hasta)}`
    + (prev ? `&updatedMin=${encodeURIComponent(new Date(new Date(prev.after).getTime() - 600_000).toISOString())}` : '');
  let pageToken: string | undefined;
  const cuenta = { nuevas: 0, actualizadas: 0, archivadas: 0, leidas: 0 };
  do {
    b.take();
    const res = await fetch(`${api(env)}/calendars/primary/events?${base}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { items?: GEvent[]; nextPageToken?: string; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    for (const e of data.items ?? []) {
      cuenta.leidas++;
      const r = await registrarEvento(env, user, e, cfg, f);
      if (r === 'nueva') cuenta.nuevas++; else if (r === 'actualizada') cuenta.actualizadas++; else if (r === 'archivada') cuenta.archivadas++;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(stateKey, JSON.stringify({ after: startedAt, at: now(), ...cuenta })).run();
  return { calendar: user.email, ...cuenta };
}

export async function syncCalendars(env: Env, b: Budget = Budget.of(env)) {
  if (!env.GOOGLE_SA_JSON) return [{ error: 'Falta el secreto GOOGLE_SA_JSON.' }];
  const cfg = await calendarConfig(env.DB);
  if (!cfg.enabled) return [{ skipped: 'La sincronización del calendario está apagada.' }];
  const { dominios } = await filtros(env.DB);
  const { results } = await env.DB.prepare('SELECT * FROM users WHERE active = 1').all<User>();
  const wanted = cfg.users === 'all' ? null : cfg.users.map((e) => e.toLowerCase());
  const users = results.filter((u) => dominios.some((d) => u.email.toLowerCase().endsWith(`@${d}`)) && (!wanted || wanted.includes(u.email.toLowerCase())));
  const states = await env.DB.prepare("SELECT key, json_extract(value, '$.at') AS at FROM settings WHERE key LIKE 'calendar_state:%'").all<{ key: string; at: string | null }>();
  const lastAt = new Map(states.results.map((r) => [r.key.slice('calendar_state:'.length), r.at ?? '']));
  users.sort((x, y) => (lastAt.get(x.email) ?? '').localeCompare(lastAt.get(y.email) ?? ''));
  const out = [];
  for (const u of users) {
    if (b.left() < 3) { out.push({ calendar: u.email, skipped: 'Sigue en la próxima corrida (tope de consultas).' }); continue; }
    try { out.push(await syncCalendar(env, u, cfg, b)); } catch (e) {
      out.push(e instanceof OutOfBudget ? { calendar: u.email, skipped: 'Sigue en la próxima corrida (tope de consultas).' } : { calendar: u.email, error: (e as Error).message });
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('calendar_last_run', ?)").bind(JSON.stringify({ at: now(), out })).run();
  return out;
}

// ---------- Agendar desde el CRM ----------

export interface NuevaReunion {
  subject: string; body?: string; start: string; end: string; attendees: string[]; meet?: boolean; location?: string; links?: number[];
}

export async function agendarReunion(env: Env, ctx: Ctx, r: NuevaReunion) {
  if (!env.GOOGLE_SA_JSON) throw new HttpError(400, 'Falta conectar Google (secreto GOOGLE_SA_JSON).');
  const subject = String(r.subject ?? '').trim();
  if (!subject) throw new HttpError(400, 'La reunión necesita un título.');
  const ini = new Date(r.start), fin = new Date(r.end);
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) throw new HttpError(400, 'Revisá el horario: el fin tiene que ser después del comienzo.');
  const invitados = [...new Set((r.attendees ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  if (!invitados.length) throw new HttpError(400, 'Sumá al menos un invitado con mail.');
  let token: string;
  try { token = await serviceToken(env, ctx.user.email, CALENDAR_SCOPE); }
  catch (e) { throw new HttpError(400, `Google no dio acceso al calendario de ${ctx.user.email}: falta sumar el permiso ${CALENDAR_SCOPE} a la cuenta de servicio (delegación de dominio). ${(e as Error).message}`); }
  const evento = {
    summary: subject, description: r.body ?? '', location: r.location || undefined,
    start: { dateTime: ini.toISOString() }, end: { dateTime: fin.toISOString() },
    attendees: invitados.map((email) => ({ email })),
    ...(r.meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
  const res = await fetch(`${api(env)}/calendars/primary/events?sendUpdates=all${r.meet ? '&conferenceDataVersion=1' : ''}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(evento),
  });
  const e = (await res.json()) as GEvent & { error?: { message: string } };
  if (e.error || !res.ok) throw new HttpError(400, `Google Calendar no creó la reunión: ${e.error?.message ?? res.status}`);
  // Se registra ya (con los vínculos que se eligieron en la ficha); la próxima pasada del calendario la reconoce por la clave.
  const cfg = await calendarConfig(env.DB);
  await registrarEvento(env, ctx.user, e, { ...cfg, create_contacts: true });
  const act = await createActivity(env.DB, { ...ctx, source: 'calendar' }, {
    type: 'meeting', external_id: claveEvento(e), links: r.links ?? [], subject, body: r.body ?? '', occurred_at: ini.toISOString(), owner_id: ctx.user.id,
    meta: metaDe(e, ctx.user, invitados),
  });
  return { activity: act, html_link: e.htmlLink ?? null, meet: linkMeet(e) };
}
