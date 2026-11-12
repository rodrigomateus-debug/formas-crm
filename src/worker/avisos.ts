import type { Ctx, Env, User } from './env';
import { b64url, serviceToken } from './google';
import { Budget, OutOfBudget } from './budget';

// Avisos por mail del CRM, por Gmail con la cuenta de servicio (permiso gmail.send en la delegación de dominio):
// - Resumen del día: a la mañana (días hábiles), las tareas que vencen hoy y las vencidas de cada persona.
// - Asignaciones: cuando alguien le asigna a otra persona un registro o una tarea, le llega un mail en la próxima corrida
//   (cada 10 minutos, junta todo lo que se acumuló).
// - Faltantes de entrega (remitos.ts): a Logística y a los administradores.
// Cada mail sale de la casilla de quien lo recibe, a sí misma, salvo que se configure `desde` (una casilla del dominio).
// Solo les llegan a los usuarios con «Avisos por mail» prendido (users.avisos_mail, Configuración → Usuarios), que está
// apagado por defecto. Antes era una lista de mails en esta configuración (`users`): ya no se usa.

export interface AvisosConfig { enabled: boolean; resumen: boolean; asignaciones: boolean; hora: number; desde: string }
export const DEFAULT_AVISOS = (): AvisosConfig => ({ enabled: true, resumen: true, asignaciones: true, hora: 8, desde: '' });
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const APP_URL = (env: Env) => (env.APP_URL ?? 'https://formas-crm.rodrigo-mateus.workers.dev').replace(/\/$/, '');
const ART = -3 * 3600_000;   // Buenos Aires
const PATHS: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals', order: 'orders' };

export async function avisosConfig(env: Env): Promise<AvisosConfig> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'avisos'").first<{ value: string }>();
  const { users: _lista, ...cfg } = { ...DEFAULT_AVISOS(), ...(row ? JSON.parse(row.value) : {}) } as AvisosConfig & { users?: unknown };
  return cfg;
}

// Se anota cuando una persona le asigna algo a otra desde la pantalla o desde Claude (no lo que mueven las integraciones).
export async function avisarAsignacion(db: D1Database, ctx: Ctx, to: number | null | undefined, ref: { recordId?: number; activityId?: number }) {
  if (!to || to === ctx.user.id || !['crm', 'mcp'].includes(ctx.source)) return;
  await db.prepare('INSERT INTO avisos (user_id, kind, record_id, activity_id, by_user) VALUES (?, ?, ?, ?, ?)')
    .bind(to, ref.activityId ? 'tarea' : 'registro', ref.recordId ?? null, ref.activityId ?? null, ctx.user.id).run();
}

// ---------- Envío ----------

function mimeB64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{76}/g, '$&\r\n');
}

export function armarMail(from: string, to: string, subject: string, text: string, html: string) {
  const boundary = `fcrm${Date.now().toString(36)}`;
  const enc = (s: string) => `=?UTF-8?B?${mimeB64(s).replace(/\r\n/g, '')}?=`;
  return [
    `From: ${enc('Formas CRM')} <${from}>`, `To: <${to}>`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', mimeB64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', mimeB64(html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

async function enviar(env: Env, cfg: AvisosConfig, to: string, subject: string, text: string, html: string, b: Budget) {
  const from = cfg.desde || to;
  b.take();
  const token = await serviceToken(env, from, SEND_SCOPE);
  b.take();
  const api = env.GMAIL_API_URL ?? 'https://gmail.googleapis.com';
  const res = await fetch(`${api}/gmail/v1/users/me/messages/send`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(armarMail(from, to, subject, text, html)) }),
  });
  if (!res.ok) throw new Error(`Gmail no mandó el mail a ${to}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const fecha = (iso: string | null) => (iso ? new Date(Date.parse(iso) + ART).toISOString().slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '');

interface Linea { titulo: string; detalle: string; url: string }
function cuerpo(env: Env, intro: string, grupos: Array<[string, Linea[]]>) {
  const text = [intro, '', ...grupos.flatMap(([h, ls]) => [h, ...ls.map((l) => `• ${l.titulo}${l.detalle ? ` · ${l.detalle}` : ''}\n  ${l.url}`), '']),
    `Abrí el CRM: ${APP_URL(env)}/tasks`].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2933;max-width:560px">
<p>${esc(intro)}</p>${grupos.map(([h, ls]) => `<p style="margin:16px 0 6px;font-weight:bold">${esc(h)}</p><ul style="padding-left:18px;margin:0">${ls.map((l) =>
    `<li style="margin:4px 0"><a href="${esc(l.url)}" style="color:#0b6bcb">${esc(l.titulo)}</a>${l.detalle ? ` <span style="color:#6b7280">· ${esc(l.detalle)}</span>` : ''}</li>`).join('')}</ul>`).join('')}
<p style="margin-top:20px"><a href="${APP_URL(env)}/tasks" style="color:#0b6bcb">Abrir mis tareas en el CRM</a></p>
<p style="color:#9ca3af;font-size:12px">Aviso automático de Formas CRM.</p></div>`;
  return { text, html };
}

interface TareaRow { id: number; subject: string; due_at: string | null; rec_id: number | null; rec_type: string | null; rec_name: string | null }
const tareaUrl = (env: Env, t: TareaRow) => (t.rec_id ? `${APP_URL(env)}/${PATHS[t.rec_type!]}/${t.rec_id}` : `${APP_URL(env)}/tasks`);
const TAREA_SELECT = `SELECT a.id, a.subject, a.due_at,
  (SELECT r.id FROM activity_links l JOIN records r ON r.id = l.record_id WHERE l.activity_id = a.id ORDER BY r.object_type = 'company' DESC LIMIT 1) AS rec_id,
  (SELECT r.object_type FROM activity_links l JOIN records r ON r.id = l.record_id WHERE l.activity_id = a.id ORDER BY r.object_type = 'company' DESC LIMIT 1) AS rec_type,
  (SELECT r.name FROM activity_links l JOIN records r ON r.id = l.record_id WHERE l.activity_id = a.id ORDER BY r.object_type = 'company' DESC LIMIT 1) AS rec_name
  FROM activities a`;

// Resumen de la mañana: una vez por día hábil, desde la hora configurada (hora de Buenos Aires).
async function resumenes(env: Env, cfg: AvisosConfig, b: Budget, now: Date, force: boolean) {
  const db = env.DB;
  const local = new Date(now.getTime() + ART);
  const hoy = local.toISOString().slice(0, 10);
  const habil = local.getUTCDay() >= 1 && local.getUTCDay() <= 5;
  const estado = await db.prepare("SELECT value FROM settings WHERE key = 'avisos_resumen'").first<{ value: string }>();
  const st = estado ? JSON.parse(estado.value) as { fecha: string; listos: number[] } : { fecha: '', listos: [] };
  if (!force && (!habil || local.getUTCHours() < cfg.hora)) return { resumenes: 0 };
  const listos = st.fecha === hoy && !force ? st.listos : [];
  const finDelDia = new Date(Date.parse(`${hoy}T23:59:59.999Z`) - ART).toISOString();
  const { results: users } = await db.prepare('SELECT * FROM users WHERE active = 1 AND avisos_mail = 1 AND deleted_at IS NULL ORDER BY id').all<User>();
  let n = 0;
  try {
    for (const u of users) {
      if (listos.includes(u.id)) continue;
      const inicioDelDia = new Date(Date.parse(`${hoy}T00:00:00Z`) - ART).toISOString();
      const abiertas = `${TAREA_SELECT} WHERE a.type = 'task' AND a.archived = 0 AND a.status != 'COMPLETED' AND a.owner_id = ?`;
      const { results: deHoy } = await db.prepare(`${abiertas} AND a.due_at >= ? AND a.due_at <= ? ORDER BY a.due_at LIMIT 30`)
        .bind(u.id, inicioDelDia, finDelDia).all<TareaRow>();
      // Vencidas: las más recientes primero (las de hace meses no ayudan a arrancar el día) y cuántas más hay.
      const { results: vencidas } = await db.prepare(`${abiertas} AND a.due_at < ? ORDER BY a.due_at DESC LIMIT 15`).bind(u.id, inicioDelDia).all<TareaRow>();
      const totalVencidas = vencidas.length < 15 ? vencidas.length
        : (await db.prepare(`SELECT COUNT(*) AS n FROM activities a WHERE a.type = 'task' AND a.archived = 0 AND a.status != 'COMPLETED' AND a.owner_id = ? AND a.due_at < ?`)
          .bind(u.id, inicioDelDia).first<{ n: number }>())!.n;
      if (deHoy.length || vencidas.length) {
        const linea = (t: TareaRow): Linea => ({ titulo: t.subject || 'Tarea', detalle: [t.rec_name, t.due_at && (t.due_at < inicioDelDia ? `venció el ${fecha(t.due_at)}` : '')].filter(Boolean).join(' · '), url: tareaUrl(env, t) });
        const partes = [deHoy.length && `${deHoy.length} para hoy`, totalVencidas && `${totalVencidas} vencida${totalVencidas > 1 ? 's' : ''}`].filter(Boolean).join(' y ');
        const masVencidas = totalVencidas > vencidas.length
          ? [{ titulo: `y ${totalVencidas - vencidas.length} vencidas más`, detalle: '', url: `${APP_URL(env)}/tasks` }] : [];
        const { text, html } = cuerpo(env, `Hola ${u.name.split(' ')[0]}, estas son tus tareas de hoy en el CRM.`,
          [['Para hoy', deHoy.map(linea)], ['Vencidas', [...vencidas.map(linea), ...masVencidas]]].filter(([, ls]) => ls.length) as Array<[string, Linea[]]>);
        await enviar(env, cfg, u.email, `Tus tareas en el CRM: ${partes}`, text, html, b);
        n++;
      }
      listos.push(u.id);
    }
  } finally {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('avisos_resumen', ?)").bind(JSON.stringify({ fecha: hoy, listos })).run();
  }
  return { resumenes: n };
}

// Asignaciones pendientes: un mail por persona con todo lo que le asignaron desde la corrida anterior.
async function asignaciones(env: Env, cfg: AvisosConfig, b: Budget) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT v.id, v.user_id, v.kind, v.record_id, v.activity_id, v.created_at, u.email, u.name AS user_name, u.avisos_mail,
      p.name AS by_name, r.name AS rec_name, r.object_type AS rec_type, a.subject AS act_subject, a.due_at AS act_due,
      json_extract(r.props, '$.estado_entrega') AS entrega, json_extract(r.props, '$.falta_entregar') AS falta
    FROM avisos v JOIN users u ON u.id = v.user_id AND u.active = 1 LEFT JOIN users p ON p.id = v.by_user
    LEFT JOIN records r ON r.id = v.record_id LEFT JOIN activities a ON a.id = v.activity_id
    WHERE v.sent_at IS NULL ORDER BY v.user_id, v.id LIMIT 200`).all<{ id: number; user_id: number; kind: string; record_id: number | null; activity_id: number | null;
      created_at: string; email: string; user_name: string; avisos_mail: number; by_name: string | null; rec_name: string | null; rec_type: string | null; act_subject: string | null; act_due: string | null;
      entrega: string | null; falta: string | null }>();
  const porPersona = new Map<number, typeof results>();
  for (const r of results) porPersona.set(r.user_id, [...(porPersona.get(r.user_id) ?? []), r]);
  const marcar = (ids: number[], error: string | null) => db.batch(ids.map((id) => db.prepare('UPDATE avisos SET sent_at = ?, error = ? WHERE id = ?').bind(new Date().toISOString(), error, id)));
  let n = 0;
  for (const [, todas] of porPersona) {
    // Faltantes de entrega (remitos.ts): si el pedido ya se completó o se finalizó, no se avisa.
    const resueltas = todas.filter((r) => r.kind === 'entrega' && r.entrega !== 'parcial' && r.entrega !== 'diferencias').map((r) => r.id);
    if (resueltas.length) await marcar(resueltas, 'ya no falta nada');
    // Solo a quien tiene «Avisos por mail» prendido (lo de los demás se marca y no sale).
    const fuera = todas.filter((r) => !r.avisos_mail && !resueltas.includes(r.id)).map((r) => r.id);
    if (fuera.length) await marcar(fuera, 'sin avisos por mail');
    const rows = todas.filter((r) => !resueltas.includes(r.id) && !fuera.includes(r.id));
    if (!rows.length) continue;
    const ids = rows.map((r) => r.id);
    const u = rows[0];
    // Lo que no pudo salir en 3 días no se manda más (por ejemplo, si falta el permiso de Google).
    const viejos = rows.filter((r) => Date.now() - Date.parse(r.created_at) > 3 * 86_400_000).map((r) => r.id);
    if (viejos.length === rows.length) { await marcar(ids, 'vencido'); continue; }
    const lineas: Linea[] = rows.map((r) => r.kind === 'entrega'
      ? { titulo: r.rec_name || 'Pedido', detalle: r.entrega === 'diferencias' ? `con diferencias${r.falta ? ` · falta ${r.falta}` : ''}` : `falta ${r.falta ?? 'entregar'}`, url: `${APP_URL(env)}/orders/${r.record_id}` }
      : r.kind === 'tarea'
      ? { titulo: r.act_subject || 'Tarea', detalle: [r.act_due && `vence el ${fecha(r.act_due)}`, r.by_name && `te la asignó ${r.by_name}`].filter(Boolean).join(' · '), url: `${APP_URL(env)}/tasks` }
      : { titulo: r.rec_name || 'Registro', detalle: r.by_name ? `te lo asignó ${r.by_name}` : '', url: r.record_id && r.rec_type ? `${APP_URL(env)}/${PATHS[r.rec_type]}/${r.record_id}` : APP_URL(env) });
    const quien = [...new Set(rows.map((r) => r.by_name).filter(Boolean))];
    const entregas = rows.filter((r) => r.kind === 'entrega');
    const subject = entregas.length === rows.length
      ? (rows.length === 1 ? `Faltan entregas: ${rows[0].rec_name ?? 'un pedido'}` : `${rows.length} pedidos con faltantes de entrega`)
      : rows.length === 1
      ? `${quien[0] ?? 'Alguien'} te asignó ${rows[0].kind === 'tarea' ? 'una tarea' : `«${rows[0].rec_name ?? 'un registro'}»`}`
      : `Te asignaron ${rows.length} cosas en el CRM`;
    const grupos: Array<[string, Linea[]]> = [
      ['Pedidos con faltantes de entrega (según los remitos)', lineas.filter((_, i) => rows[i].kind === 'entrega')],
      ['Asignado a vos', lineas.filter((_, i) => rows[i].kind !== 'entrega')],
    ].filter(([, ls]) => ls.length) as Array<[string, Linea[]]>;
    const { text, html } = cuerpo(env, entregas.length === rows.length ? `Hola ${u.user_name.split(' ')[0]}, a estos pedidos les falta entregar algo según sus remitos:`
      : `Hola ${u.user_name.split(' ')[0]}, te asignaron esto en el CRM:`, grupos);
    try {
      await enviar(env, cfg, u.email, subject, text, html, b);
      await marcar(ids, null);
      n++;
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
      await db.batch(ids.map((id) => db.prepare('UPDATE avisos SET error = ? WHERE id = ?').bind((e as Error).message.slice(0, 300), id)));
      throw e;
    }
  }
  return { asignaciones: n };
}

export async function correrAvisos(env: Env, b: Budget = Budget.of(env), opts: { forceResumen?: boolean; now?: Date } = {}) {
  const cfg = await avisosConfig(env);
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  if (!cfg.enabled) return { ...out, skipped: 'Avisos apagados.' };
  if (!env.GOOGLE_SA_JSON) return { ...out, skipped: 'Falta el secreto GOOGLE_SA_JSON.' };
  try {
    if (cfg.asignaciones) Object.assign(out, await asignaciones(env, cfg, b));
    if (cfg.resumen) Object.assign(out, await resumenes(env, cfg, b, opts.now ?? new Date(), !!opts.forceResumen));
  } catch (e) {
    out.error = e instanceof OutOfBudget ? 'Sigue en la próxima corrida (tope de consultas).' : (e as Error).message;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('avisos_estado', ?)").bind(JSON.stringify(out)).run();
  return out;
}
