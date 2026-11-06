import type { Env } from './env';
import { HttpError } from './env';
import { serviceToken } from './google';

// Archivos en Google Drive (bocetos de producción): una unidad compartida de Formas, con una carpeta por empresa y, adentro,
// una por pedido o negocio. Entra con la cuenta de servicio de `GOOGLE_SA_JSON` como el usuario de la configuración
// (delegación de todo el dominio, permiso de Drive). Los archivos se ven también en Drive, con los permisos de la unidad.

const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const api = (env: Env) => (env.DRIVE_API_URL ?? 'https://www.googleapis.com').replace(/\/$/, '');

export interface DriveConfig { carpeta: string | null; usuario: string | null }

export async function driveConfig(env: Env): Promise<DriveConfig> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bocetos'").first<{ value: string }>();
  const c = row ? (JSON.parse(row.value) as Partial<DriveConfig>) : {};
  return { carpeta: c.carpeta || env.BOCETOS_DRIVE_FOLDER || null, usuario: c.usuario || env.ADMIN_EMAIL || null };
}

async function acceso(env: Env) {
  const cfg = await driveConfig(env);
  if (!env.GOOGLE_SA_JSON) throw new HttpError(503, 'Falta la cuenta de servicio de Google (GOOGLE_SA_JSON).');
  if (!cfg.carpeta || !cfg.usuario) throw new HttpError(503, 'Falta configurar la carpeta de Drive de los bocetos (Configuración → Integraciones).');
  return { cfg, token: await serviceToken(env, cfg.usuario, SCOPE) };
}

async function drive<T>(env: Env, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${api(env)}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Drive ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// La carpeta `nombre` adentro de `padre` (la crea si no está). Se recuerda para no buscarla cada vez.
async function carpeta(env: Env, token: string, padre: string, nombre: string) {
  const limpio = nombre.replace(/[\\/]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Sin nombre';
  const clave = `drive_carpeta:${padre}/${limpio}`;
  const memo = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(clave).first<{ value: string }>();
  if (memo) return memo.value;
  const q = `'${padre}' in parents and name = '${limpio.replace(/'/g, "\\'")}' and mimeType = '${FOLDER}' and trashed = false`;
  const found = await drive<{ files: Array<{ id: string }> }>(env, token,
    `/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives' })}`);
  const id = found.files[0]?.id ?? (await drive<{ id: string }>(env, token, '/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: limpio, mimeType: FOLDER, parents: [padre] }),
  })).id;
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(clave, id).run();
  return id;
}

// Sube un archivo a <carpeta de bocetos>/<ruta…> y devuelve su id y su link de Drive. Subida «reanudable» de Google: sirve
// igual para un PDF de 1 MB que para uno de 50.
export async function subirArchivo(env: Env, ruta: string[], nombre: string, mime: string, datos: ArrayBuffer) {
  const { cfg, token } = await acceso(env);
  let padre = cfg.carpeta!;
  for (const r of ruta) padre = await carpeta(env, token, padre, r);
  const init = await fetch(`${api(env)}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': String(datos.byteLength) },
    body: JSON.stringify({ name: nombre, parents: [padre] }),
  });
  const destino = init.headers.get('location');
  if (!init.ok || !destino) throw new Error(`Drive no aceptó el archivo: HTTP ${init.status} ${(await init.text()).slice(0, 200)}`);
  const up = await fetch(destino, { method: 'PUT', headers: { 'content-type': mime }, body: datos });
  if (!up.ok) throw new Error(`Drive no guardó el archivo: HTTP ${up.status}`);
  const f = (await up.json()) as { id: string; webViewLink?: string };
  return { id: f.id, link: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view` };
}

// El archivo tal cual (para verlo en el CRM, mandarlo a ClickUp o descargarlo).
export async function bajarArchivo(env: Env, id: string) {
  const { token } = await acceso(env);
  const res = await fetch(`${api(env)}/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive no dio el archivo: HTTP ${res.status}`);
  return res;
}
