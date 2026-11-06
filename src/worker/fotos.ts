import type { Env } from './env';
import { now } from './env';
import { Budget, OutOfBudget } from './budget';
import { serviceToken } from './google';

// Foto de cada usuario: la de su cuenta de Google, la misma que se ve en Gmail. La cuenta de servicio de `GOOGLE_SA_JSON`
// entra como cada usuario (delegación de todo el dominio) y lee su perfil, de una de estas dos formas:
// 1. Con el permiso de perfil (https://www.googleapis.com/auth/userinfo.profile): lo justo para ver nombre y foto.
// 2. Si ese permiso no está en la delegación, con el de Drive (el mismo de los bocetos): Drive también dice la foto.
// Se guarda el link (lh3.googleusercontent.com, se ve sin iniciar sesión). El cron (en la corrida de Gmail) revisa unos
// pocos por vez a los que hace más de una semana que no se revisan; el botón de Configuración → Usuarios las trae ya.

const PERFIL = 'https://www.googleapis.com/auth/userinfo.profile';
const DRIVE = 'https://www.googleapis.com/auth/drive';
const SEMANA = 7 * 86_400_000;
const DIA = 86_400_000;

type Metodo = 'perfil' | 'drive';
export interface FotosEstado {
  at: string;
  metodo: Metodo | null;      // con cuál anduvo la última vez (se prueba primero)
  error: string | null;
  sin_permiso: boolean;       // ninguna de las dos formas anda: falta el permiso en la delegación
  actualizadas: number;       // usuarios con foto
  sin_foto: number;           // usuarios que Google no conoce (por ejemplo, un mail que no es de Workspace)
  pendientes: number;         // quedaron para la próxima corrida (tope de consultas)
}

export async function fotosEstado(db: D1Database): Promise<FotosEstado | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'fotos_usuarios'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as FotosEstado) : null;
}

// Un tamaño parejo (96 px, recortada al cuadrado): alcanza para el avatar grande en pantallas de alta densidad.
export function fotoDe(url: unknown): string | null {
  const s = String(url ?? '').trim();
  if (!/^https:\/\//i.test(s)) return null;
  return /=s\d+(-[a-z0-9-]+)?$/i.test(s) ? s.replace(/=s\d+(-[a-z0-9-]+)?$/i, '=s96-c') : s;
}

async function leer<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

async function fotoDeGoogle(env: Env, metodo: Metodo, email: string, b: Budget): Promise<string | null> {
  b.take();
  const token = await serviceToken(env, email, metodo === 'perfil' ? PERFIL : DRIVE);
  b.take();
  if (metodo === 'perfil') {
    const p = await leer<{ picture?: string }>(env.GOOGLE_USERINFO_URL ?? 'https://www.googleapis.com/oauth2/v3/userinfo', token);
    return fotoDe(p.picture);
  }
  const drive = (env.DRIVE_API_URL ?? 'https://www.googleapis.com').replace(/\/$/, '');
  const a = await leer<{ user?: { photoLink?: string } }>(`${drive}/drive/v3/about?fields=user(photoLink)`, token);
  return fotoDe(a.user?.photoLink);
}

// ¿De qué es el error? «metodo»: esa forma no anda para nadie (falta el permiso o la API), se pasa a la otra.
// «usuario»: Google no conoce ese mail, queda sin foto. «otro»: algo pasajero, se reintenta en la próxima corrida.
function tipoDeError(m: string): 'metodo' | 'usuario' | 'otro' {
  if (/unauthorized|not authorized|access_denied|insufficient|has not been used in project|SERVICE_DISABLED/i.test(m)) return 'metodo';
  if (/invalid email|user id|not a valid email|invalid_grant|HTTP 404/i.test(m)) return 'usuario';
  return 'otro';
}

const SIN_PERMISO = 'A la cuenta de servicio de Google le falta permiso para ver las fotos: sumá https://www.googleapis.com/auth/userinfo.profile '
  + 'a su Client ID en la delegación de todo el dominio (admin.google.com → Seguridad → Acceso y control de datos → Controles de API).';

// Trae las fotos. Sin opciones (el cron): hasta `max` usuarios activos que hace más de una semana que no se revisan.
// `todos` (el botón): todos los activos. `ids`: esos usuarios (al agregar uno).
export async function actualizarFotos(env: Env, b: Budget = Budget.of(env), opts: { todos?: boolean; ids?: number[]; max?: number } = {}): Promise<FotosEstado> {
  const prev = await fotosEstado(env.DB);
  const base: FotosEstado = { at: now(), metodo: prev?.metodo ?? null, error: null, sin_permiso: false, actualizadas: 0, sin_foto: 0, pendientes: 0 };
  if (!env.GOOGLE_SA_JSON) return { ...base, error: 'Falta la cuenta de servicio de Google (GOOGLE_SA_JSON).' };
  // Si falta el permiso, el cron no insiste más de una vez por día (el botón y el alta de un usuario sí).
  const aMano = !!opts.todos || !!opts.ids;
  if (!aMano && prev?.sin_permiso && Date.now() - Date.parse(prev.at) < DIA) return prev;

  const db = env.DB;
  const users = (opts.ids
    ? await db.prepare('SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(opts.ids)).all<{ id: number; email: string }>()
    : opts.todos
      ? await db.prepare('SELECT id, email FROM users WHERE active = 1 ORDER BY photo_checked_at IS NOT NULL, photo_checked_at').all<{ id: number; email: string }>()
      : await db.prepare(`SELECT id, email FROM users WHERE active = 1 AND (photo_checked_at IS NULL OR photo_checked_at < ?)
          ORDER BY photo_checked_at IS NOT NULL, photo_checked_at LIMIT ?`).bind(new Date(Date.now() - SEMANA).toISOString(), opts.max ?? 3).all<{ id: number; email: string }>()
  ).results;
  if (!users.length) return prev ?? base;

  // Primero la forma que anduvo la última vez.
  let metodos: Metodo[] = prev?.metodo === 'drive' ? ['drive', 'perfil'] : ['perfil', 'drive'];
  const estado = { ...base };
  let hechos = 0;
  for (const u of users) {
    let foto: string | null | undefined;   // undefined: no se pudo saber (se reintenta)
    try {
      while (metodos.length && foto === undefined) {
        try { foto = await fotoDeGoogle(env, metodos[0], u.email, b); }
        catch (e) {
          if (e instanceof OutOfBudget) throw e;
          const m = (e as Error).message;
          const tipo = tipoDeError(m);
          if (tipo === 'metodo') metodos = metodos.slice(1);
          else if (tipo === 'usuario') foto = null;
          else { estado.error = `${u.email}: ${m}`; break; }
        }
      }
    } catch (e) {
      if (e instanceof OutOfBudget) break;
      throw e;
    }
    if (!metodos.length) break;   // ninguna forma anda: no tiene sentido seguir con los demás
    if (foto === undefined) {
      // Algo pasajero: se reintenta en un día, detrás de los que faltan (así no frena a los demás en la fila del cron).
      await db.prepare('UPDATE users SET photo_checked_at = ? WHERE id = ?').bind(new Date(Date.now() - SEMANA + DIA).toISOString(), u.id).run();
      continue;
    }
    await db.prepare('UPDATE users SET photo_url = ?, photo_checked_at = ? WHERE id = ?').bind(foto, now(), u.id).run();
    if (foto) estado.actualizadas++; else estado.sin_foto++;
    hechos++;
  }
  estado.metodo = metodos[0] ?? null;
  if (!metodos.length) Object.assign(estado, { error: SIN_PERMISO, sin_permiso: true });
  else if (hechos < users.length) {
    // Los que faltan revisar (siguen en las próximas corridas del cron).
    const r = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND (photo_checked_at IS NULL OR photo_checked_at < ?)')
      .bind(new Date(Date.now() - SEMANA).toISOString()).first<{ n: number }>();
    estado.pendientes = r?.n ?? 0;
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fotos_usuarios', ?)").bind(JSON.stringify(estado)).run();
  return estado;
}
