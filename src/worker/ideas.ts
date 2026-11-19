import type { Ctx, User } from './env';
import { HttpError, now } from './env';

// Buzón de ideas (pedido de Rodrigo del 19/11/2026): lo que dibuja Formi, el personaje de abajo a la derecha del Hub.
// - Cualquiera propone una mejora y vota las de los demás (un voto por persona; quien propone ya la vota).
// - El ranking: las que están en marcha arriba y después las pendientes, de más votos a menos.
// - Los administradores las van haciendo: «en marcha», «hecha» o «no va», con una respuesta opcional. Al pasar de estado,
//   la campanita le avisa a quien la propuso (y, al hacerse, a todos los que la votaron). Una idea nueva les avisa a los
//   administradores. Ninguno de estos avisos sale por mail.
// - Quien la escribió la puede corregir o borrar mientras está pendiente; un administrador, siempre.

export const ESTADOS = ['pendiente', 'en_curso', 'hecha', 'descartada'] as const;
export type EstadoIdea = (typeof ESTADOS)[number];
const ABIERTA: EstadoIdea[] = ['pendiente', 'en_curso'];
const MIN = 8, MAX = 1000, MAX_RESPUESTA = 1000;

export interface Idea {
  id: number; texto: string; user_id: number; estado: EstadoIdea; respuesta: string | null; estado_at: string | null; estado_por: number | null;
  created_at: string; updated_at: string | null; votos: number; votantes: number[]; votada: boolean; puede_editar: boolean;
}

const esAdmin = (u: User) => u.role === 'admin';
const limpiar = (s: unknown) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
// Para comparar dos textos («Que se pueda…» y «que se pueda…!» son la misma idea).
const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();

type Fila = Omit<Idea, 'votantes' | 'votada' | 'puede_editar'> & { votantes: string | null };
const SELECT = `SELECT i.id, i.texto, i.user_id, i.estado, i.respuesta, i.estado_at, i.estado_por, i.created_at, i.updated_at,
    (SELECT COUNT(*) FROM idea_votos v WHERE v.idea_id = i.id) AS votos,
    (SELECT json_group_array(user_id) FROM (SELECT user_id FROM idea_votos v WHERE v.idea_id = i.id ORDER BY v.created_at)) AS votantes
  FROM ideas i WHERE i.borrada_at IS NULL`;

function armar(f: Fila, user: User): Idea {
  const votantes = (JSON.parse(f.votantes ?? '[]') as number[]).filter((x) => x != null);
  return { ...f, votantes, votada: votantes.includes(user.id), puede_editar: esAdmin(user) || (f.user_id === user.id && f.estado === 'pendiente') };
}

// Todas (son pocas: un equipo proponiendo mejoras), en el orden del ranking.
export async function listarIdeas(db: D1Database, user: User) {
  const { results } = await db.prepare(`${SELECT}
    ORDER BY CASE i.estado WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 WHEN 'hecha' THEN 2 ELSE 3 END,
      CASE WHEN i.estado IN ('hecha', 'descartada') THEN i.estado_at END DESC, votos DESC, i.created_at`).all<Fila>();
  return { ideas: results.map((f) => armar(f, user)), admin: esAdmin(user) };
}

async function ideaPorId(db: D1Database, id: number) {
  const f = await db.prepare(`${SELECT} AND i.id = ?`).bind(id).first<Fila>();
  if (!f) throw new HttpError(404, 'Esa idea no existe o se borró.');
  return f;
}
export const leerIdea = async (db: D1Database, user: User, id: number) => armar(await ideaPorId(db, id), user);

function validarTexto(t: unknown) {
  const texto = limpiar(t);
  if (texto.length < MIN) throw new HttpError(400, 'Contá un poco más: ¿qué mejorarías y para qué?');
  if (texto.length > MAX) throw new HttpError(400, `Es muy larga: hasta ${MAX} caracteres.`);
  return texto;
}

export async function crearIdea(db: D1Database, ctx: Ctx, body: { texto?: unknown }) {
  const texto = validarTexto(body?.texto);
  // La misma idea dos veces (de cualquiera), mientras sigue abierta: mejor votar la que está.
  const { results: abiertas } = await db.prepare(`SELECT id, texto FROM ideas WHERE borrada_at IS NULL AND estado IN ('pendiente', 'en_curso')`).all<{ id: number; texto: string }>();
  const igual = abiertas.find((a) => normal(a.texto) === normal(texto));
  if (igual) throw new HttpError(409, 'Esa idea ya está en el buzón: votala así sube en el ranking.', { idea_id: igual.id });
  const t = now();
  const r = await db.prepare('INSERT INTO ideas (texto, user_id, created_at) VALUES (?, ?, ?) RETURNING id').bind(texto, ctx.user.id, t).first<{ id: number }>();
  const id = r!.id;
  const { results: admins } = await db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL AND id != ?`).bind(ctx.user.id).all<{ id: number }>();
  await db.batch([
    db.prepare('INSERT INTO idea_votos (idea_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, ctx.user.id, t),
    ...admins.map((a) => aviso(db, a.id, 'idea_nueva', id, ctx.user.id, texto)),
  ]);
  return leerIdea(db, ctx.user, id);
}

export async function editarIdea(db: D1Database, ctx: Ctx, id: number, body: { texto?: unknown }) {
  const f = await ideaPorId(db, id);
  if (!armar(f, ctx.user).puede_editar) throw new HttpError(403, f.user_id === ctx.user.id ? 'Ya no se puede cambiar: dejó de estar pendiente.' : 'Es una idea de otra persona.');
  await db.prepare('UPDATE ideas SET texto = ?, updated_at = ? WHERE id = ?').bind(validarTexto(body?.texto), now(), id).run();
  return leerIdea(db, ctx.user, id);
}

export async function borrarIdea(db: D1Database, ctx: Ctx, id: number) {
  const f = await ideaPorId(db, id);
  if (!armar(f, ctx.user).puede_editar) throw new HttpError(403, f.user_id === ctx.user.id ? 'Ya no se puede borrar: dejó de estar pendiente.' : 'Es una idea de otra persona.');
  await db.prepare('UPDATE ideas SET borrada_at = ? WHERE id = ?').bind(now(), id).run();
  return { ok: true };
}

// Votar o sacarse el voto. Solo mientras está abierta (las hechas o descartadas quedan como quedaron).
export async function votarIdea(db: D1Database, ctx: Ctx, id: number, voto: boolean) {
  const f = await ideaPorId(db, id);
  if (!ABIERTA.includes(f.estado)) throw new HttpError(409, f.estado === 'hecha' ? 'Esa idea ya está hecha 🎉' : 'Esa idea ya se cerró.');
  await (voto
    ? db.prepare('INSERT OR IGNORE INTO idea_votos (idea_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, ctx.user.id, now())
    : db.prepare('DELETE FROM idea_votos WHERE idea_id = ? AND user_id = ?').bind(id, ctx.user.id)).run();
  return leerIdea(db, ctx.user, id);
}

const aviso = (db: D1Database, userId: number, kind: string, ideaId: number, by: number, detalle: string) =>
  db.prepare("INSERT INTO avisos (user_id, kind, idea_id, by_user, detalle, sent_at, error) VALUES (?, ?, ?, ?, ?, ?, 'solo en el Hub')")
    .bind(userId, kind, ideaId, by, detalle.slice(0, 300), now());

// Los administradores la pasan de estado, con una respuesta opcional (que se puede cambiar sin cambiar el estado).
export async function cambiarEstadoIdea(db: D1Database, ctx: Ctx, id: number, body: { estado?: unknown; respuesta?: unknown }) {
  if (!esAdmin(ctx.user)) throw new HttpError(403, 'Las ideas las marcan los administradores.');
  const f = await ideaPorId(db, id);
  const estado = (body?.estado ?? f.estado) as EstadoIdea;
  if (!ESTADOS.includes(estado)) throw new HttpError(400, `Estado desconocido: ${String(body?.estado)}.`);
  const respuesta = body?.respuesta === undefined ? f.respuesta : limpiar(body.respuesta) || null;
  if (respuesta && respuesta.length > MAX_RESPUESTA) throw new HttpError(400, `La respuesta es muy larga: hasta ${MAX_RESPUESTA} caracteres.`);
  const cambia = estado !== f.estado;
  const t = now();
  const stmts: D1PreparedStatement[] = [cambia
    ? db.prepare('UPDATE ideas SET estado = ?, respuesta = ?, estado_at = ?, estado_por = ?, updated_at = ? WHERE id = ?')
      .bind(estado, respuesta, estado === 'pendiente' ? null : t, estado === 'pendiente' ? null : ctx.user.id, t, id)
    : db.prepare('UPDATE ideas SET respuesta = ?, updated_at = ? WHERE id = ?').bind(respuesta, t, id)];
  if (cambia && estado !== 'pendiente') {
    // A quien la propuso (si no es quien la marca) y, si se hizo, a los que la votaron.
    const detalle = respuesta ? `${f.texto}\n— ${respuesta}` : f.texto;
    if (f.user_id !== ctx.user.id) stmts.push(aviso(db, f.user_id, `idea_${estado}`, id, ctx.user.id, detalle));
    if (estado === 'hecha') {
      const votantes = (JSON.parse(f.votantes ?? '[]') as number[]).filter((u) => u !== f.user_id && u !== ctx.user.id);
      stmts.push(...votantes.map((u) => aviso(db, u, 'idea_votada_hecha', id, ctx.user.id, detalle)));
    }
  }
  await db.batch(stmts);
  return leerIdea(db, ctx.user, id);
}
