// La camioneta de cada chofer (pedido de Rodrigo del 20/11/2026): modelo, tamaño, una foto y cuántas cajas entran (de 40x30
// y de 60x40, las que más se usan). Se carga en la pantalla Choferes (Logística y los administradores) y la Ruta del día la
// usa para avisar si los bultos de un recorrido no entran (cajas combinadas: web/src/bultos.ts). Va por el nombre del
// chofer normalizado, igual que se le asignan los recorridos (migración 0103).
import type { Ctx } from './env';
import { HttpError, now } from './env';
import { norm } from './clickup';

export interface Vehiculo {
  chofer: string; nombre: string; modelo: string | null; tamano: string | null; cap_c40: number | null; cap_c60: number | null;
  foto_at: string | null;   // si tiene foto, cuándo se subió (para la dirección de la foto, así el navegador no muestra la vieja)
}
const COLS = 'chofer, nombre, modelo, tamano, cap_c40, cap_c60, CASE WHEN foto IS NULL THEN NULL ELSE foto_at END AS foto_at';
const FOTO_MAX = 900_000;

export async function vehiculos(db: D1Database): Promise<Vehiculo[]> {
  return (await db.prepare(`SELECT ${COLS} FROM cronograma_vehiculos ORDER BY nombre`).all<Vehiculo>()).results;
}

const texto = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s || null; };
const capacidad = (v: unknown, que: string) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new HttpError(400, `Las cajas de ${que} que entran tienen que ser un número entero (o vacío si no se sabe).`);
  return n;
};
const nombreDe = (v: unknown) => {
  const nombre = texto(v, 80);
  if (!nombre || nombre.length < 2) throw new HttpError(400, 'Falta el nombre del chofer.');
  return nombre;
};

// Guarda los datos de la camioneta (sin la foto, que va aparte). Todo vacío y sin foto, se saca.
export async function guardarVehiculo(db: D1Database, ctx: Ctx, b: { nombre?: unknown; modelo?: unknown; tamano?: unknown; cap_c40?: unknown; cap_c60?: unknown }) {
  const nombre = nombreDe(b.nombre), chofer = norm(nombre);
  const v = { modelo: texto(b.modelo, 80), tamano: texto(b.tamano, 60), cap_c40: capacidad(b.cap_c40, '40×30'), cap_c60: capacidad(b.cap_c60, '60×40') };
  await db.prepare(`INSERT INTO cronograma_vehiculos (chofer, nombre, modelo, tamano, cap_c40, cap_c60, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chofer) DO UPDATE SET nombre = excluded.nombre, modelo = excluded.modelo, tamano = excluded.tamano, cap_c40 = excluded.cap_c40,
      cap_c60 = excluded.cap_c60, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(chofer, nombre, v.modelo, v.tamano, v.cap_c40, v.cap_c60, ctx.user.id, now()).run();
  await limpiar(db, chofer);
  return (await db.prepare(`SELECT ${COLS} FROM cronograma_vehiculos WHERE chofer = ?`).bind(chofer).first<Vehiculo>()) ?? null;
}
// Una camioneta sin ningún dato ni foto no sirve: se saca.
async function limpiar(db: D1Database, chofer: string) {
  await db.prepare('DELETE FROM cronograma_vehiculos WHERE chofer = ? AND modelo IS NULL AND tamano IS NULL AND cap_c40 IS NULL AND cap_c60 IS NULL AND foto IS NULL').bind(chofer).run();
}

// La foto: una imagen de verdad (JPEG, PNG o WebP, se mira el contenido), ya achicada en el navegador.
const esJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const esPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const esWebp = (b: Uint8Array) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
export async function guardarFotoVehiculo(db: D1Database, ctx: Ctx, nombreCrudo: unknown, archivo: unknown) {
  const nombre = nombreDe(nombreCrudo), chofer = norm(nombre);
  if (!(archivo instanceof File)) throw new HttpError(400, 'Falta la foto.');
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, 'La foto está vacía.');
  if (bytes.length > FOTO_MAX) throw new HttpError(413, 'La foto es muy pesada. Probá con otra (o una captura).');
  const mime = esJpeg(bytes) ? 'image/jpeg' : esPng(bytes) ? 'image/png' : esWebp(bytes) ? 'image/webp' : null;
  if (!mime) throw new HttpError(415, 'Tiene que ser una foto (JPG, PNG o WebP).');
  const ts = now();
  await db.prepare(`INSERT INTO cronograma_vehiculos (chofer, nombre, foto, foto_mime, foto_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chofer) DO UPDATE SET foto = excluded.foto, foto_mime = excluded.foto_mime, foto_at = excluded.foto_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(chofer, nombre, bytes, mime, ts, ctx.user.id, ts).run();
  return (await db.prepare(`SELECT ${COLS} FROM cronograma_vehiculos WHERE chofer = ?`).bind(chofer).first<Vehiculo>())!;
}
export async function quitarFotoVehiculo(db: D1Database, ctx: Ctx, nombreCrudo: unknown) {
  const chofer = norm(nombreDe(nombreCrudo));
  await db.prepare('UPDATE cronograma_vehiculos SET foto = NULL, foto_mime = NULL, foto_at = NULL, updated_by = ?, updated_at = ? WHERE chofer = ?').bind(ctx.user.id, now(), chofer).run();
  await limpiar(db, chofer);
  return { ok: true };
}
export async function fotoVehiculo(db: D1Database, nombreCrudo: unknown) {
  const r = await db.prepare('SELECT foto, foto_mime FROM cronograma_vehiculos WHERE chofer = ? AND foto IS NOT NULL').bind(norm(nombreDe(nombreCrudo)))
    .first<{ foto: ArrayBuffer | number[]; foto_mime: string }>();
  if (!r) throw new HttpError(404, 'No tiene foto.');
  return { mime: r.foto_mime, bytes: r.foto instanceof ArrayBuffer ? new Uint8Array(r.foto) : new Uint8Array(r.foto) };
}
