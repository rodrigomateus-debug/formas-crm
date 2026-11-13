import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { primaryCompanyId } from './associations';
import { subirArchivo } from './drive';

// Logos del cliente (pedido de Rodrigo del 13/11/2026): el original «en curvas» (AI, EPS, CDR, SVG, PDF…) se sube una vez a
// la empresa (Drive: <empresa>/Logos) y se usa en todos sus pedidos y negocios. En cada producto (y su boceto) se elige cuál
// va; sin elegir, va el principal. Al subirlo se revisa si los textos están pasados a curvas (SVG y EPS acá; los PDF y los
// AI compatibles con PDF, también en el navegador con pdf.js, que manda lo que vio en «curvas»). Con el boceto aprobado,
// el logo del producto se adjunta en ClickUp a la misma subtarea (clickup.ts).

export const CURVAS = ['ok', 'textos', 'sin_verificar', 'no_vectorial'] as const;
type Curvas = (typeof CURVAS)[number];
const MAX = 50 * 1024 * 1024;

interface Formato { mime: string; vectorial: boolean; firma: (b: Uint8Array, txt: string) => boolean }
const empieza = (b: Uint8Array, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);
// Cada byte, un carácter (latin-1): así se buscan las marcas de texto en un archivo binario sin que nada lo rompa.
function latin1(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}
const esPdf = (txt: string) => txt.slice(0, 1024).includes('%PDF-');
const esPs = (b: Uint8Array, txt: string) => txt.startsWith('%!PS-Adobe') || empieza(b, 0xc5, 0xd0, 0xd3, 0xc6);
const FORMATOS: Record<string, Formato> = {
  ai: { mime: 'application/illustrator', vectorial: true, firma: (b, t) => esPdf(t) || esPs(b, t) },
  eps: { mime: 'application/postscript', vectorial: true, firma: esPs },
  cdr: { mime: 'application/x-coreldraw', vectorial: true, firma: (b, t) => (t.startsWith('RIFF') && t.slice(8, 11) === 'CDR') || empieza(b, 0x50, 0x4b, 0x03, 0x04) },
  svg: { mime: 'image/svg+xml', vectorial: true, firma: (_b, t) => /<svg[\s>]/i.test(t.slice(0, 4096)) },
  pdf: { mime: 'application/pdf', vectorial: true, firma: (_b, t) => esPdf(t) },
  psd: { mime: 'image/vnd.adobe.photoshop', vectorial: false, firma: (_b, t) => t.startsWith('8BPS') },
  png: { mime: 'image/png', vectorial: false, firma: (b) => empieza(b, 0x89, 0x50, 0x4e, 0x47) },
  jpg: { mime: 'image/jpeg', vectorial: false, firma: (b) => empieza(b, 0xff, 0xd8, 0xff) },
  webp: { mime: 'image/webp', vectorial: false, firma: (_b, t) => t.startsWith('RIFF') && t.slice(8, 12) === 'WEBP' },
  tif: { mime: 'image/tiff', vectorial: false, firma: (b) => empieza(b, 0x49, 0x49, 0x2a, 0x00) || empieza(b, 0x4d, 0x4d, 0x00, 0x2a) },
};
const ALIAS: Record<string, string> = { jpeg: 'jpg', tiff: 'tif', svgz: 'svg' };
export const EXTENSIONES = Object.keys(FORMATOS);

export interface Logo {
  id: number; company_id: number; etiqueta: string | null; nombre: string; formato: string; mime: string | null; size: number | null;
  vectorial: number; vista: 'pdf' | 'svg' | 'imagen' | null; curvas: Curvas; principal: number; drive_id: string; drive_link: string | null;
  user_id: number | null; created_at: string;
}
const COLS = 'id, company_id, etiqueta, nombre, formato, mime, size, vectorial, vista, curvas, principal, drive_id, drive_link, user_id, created_at';

// ---------- Revisar el archivo ----------

// Qué formato es (por la extensión, confirmado por los primeros bytes), cómo se ve en el CRM y si los textos están en curvas.
export function revisar(nombre: string, datos: Uint8Array, pista?: string | null) {
  const ext0 = (nombre.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const ext = ALIAS[ext0] ?? ext0;
  const f = FORMATOS[ext];
  if (!f) throw new HttpError(400, `Ese formato no va como logo. Subí AI, EPS, CDR, SVG o PDF (o, si no hay otro, PNG, JPG o PSD).`);
  const cabeza = latin1(datos.subarray(0, 4096));
  if (!f.firma(datos, cabeza)) throw new HttpError(400, `El archivo no parece un ${ext.toUpperCase()} (¿se cambió la extensión?).`);
  const pdf = esPdf(cabeza);
  const vista: Logo['vista'] = pdf ? 'pdf' : ext === 'svg' ? 'svg' : ['png', 'jpg', 'webp'].includes(ext) ? 'imagen' : null;
  let curvas: Curvas = 'sin_verificar';
  if (!f.vectorial) curvas = 'no_vectorial';
  else if (ext === 'svg') {
    const txt = new TextDecoder().decode(datos);
    curvas = /<(text|tspan|textPath)[\s>/]/i.test(txt) ? 'textos' : 'ok';
  } else if (pdf || ext === 'eps' || ext === 'ai') {
    // Sin comprimir se ven las fuentes (/Type /Font en un PDF; «%%DocumentFonts: Arial» o «%%+ font Arial» en PostScript).
    // Lo comprimido lo lee pdf.js en el navegador y viene en la pista.
    const todo = latin1(datos.subarray(0, 8_000_000));
    const fuentes = pdf ? /\/Type\s*\/Font\b/.test(todo) : /%%(DocumentFonts|DocumentNeededFonts):\s*[^\s(]|%%(DocumentNeededResources:|\+)\s*font\s+\S/.test(todo);
    if (fuentes) curvas = 'textos';
    else if (pdf && (pista === 'ok' || pista === 'textos')) curvas = pista;
  }
  return { formato: ext, mime: f.mime, vectorial: f.vectorial, vista, curvas };
}

// ---------- Leer ----------

// La empresa de un registro: la misma si es una empresa; si no, su empresa principal.
export async function empresaDe(db: D1Database, rec: { id: number; object_type: string }) {
  if (rec.object_type === 'company') return rec.id;
  return primaryCompanyId(db, rec.id);
}

export async function logosDe(db: D1Database, companyId: number) {
  const { results } = await db.prepare(`SELECT ${COLS} FROM logos WHERE company_id = ? AND archived = 0 ORDER BY principal DESC, created_at DESC`)
    .bind(companyId).all<Logo>();
  return results;
}

export async function logoPorId(db: D1Database, id: number) {
  const l = await db.prepare(`SELECT ${COLS}, archived FROM logos WHERE id = ?`).bind(id).first<Logo & { archived: number }>();
  if (!l || l.archived) throw new HttpError(404, 'No existe el logo.');
  return l;
}

// Los logos elegidos en los productos de un pedido o negocio.
export async function elegidosDe(db: D1Database, recordId: number) {
  const { results } = await db.prepare('SELECT pl.producto, pl.logo_id FROM producto_logos pl JOIN logos l ON l.id = pl.logo_id AND l.archived = 0 WHERE pl.record_id = ?')
    .bind(recordId).all<{ producto: string; logo_id: number }>();
  return results;
}

// El logo que va en un producto: el elegido o, si no hay, el principal de la empresa.
export async function logoDelProducto(db: D1Database, recordId: number, producto: string | null) {
  const elegido = producto ? await db.prepare(`SELECT l.${COLS.split(', ').join(', l.')} FROM producto_logos pl JOIN logos l ON l.id = pl.logo_id AND l.archived = 0
    WHERE pl.record_id = ? AND pl.producto = ?`).bind(recordId, producto).first<Logo>() : null;
  if (elegido) return elegido;
  const company = await primaryCompanyId(db, recordId);
  if (!company) return null;
  return db.prepare(`SELECT ${COLS} FROM logos WHERE company_id = ? AND archived = 0 ORDER BY principal DESC, created_at DESC LIMIT 1`).bind(company).first<Logo>();
}

// ---------- Cambiar ----------

export async function subirLogo(env: Env, ctx: Ctx, companyId: number, archivo: File, datos: { etiqueta?: string | null; curvas?: string | null }) {
  if (archivo.size > MAX) throw new HttpError(400, 'El archivo es muy grande (máximo 50 MB).');
  const db = env.DB;
  const emp = await db.prepare("SELECT name FROM records WHERE id = ? AND object_type = 'company'").bind(companyId).first<{ name: string }>();
  if (!emp) throw new HttpError(404, 'No existe la empresa.');
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const r = revisar(archivo.name || 'logo', bytes, datos.curvas);
  const f = await subirArchivo(env, [emp.name, 'Logos'], archivo.name || `logo.${r.formato}`, r.mime, bytes.buffer as ArrayBuffer);
  // El primero de la empresa queda como principal.
  const hay = await db.prepare('SELECT 1 FROM logos WHERE company_id = ? AND archived = 0 LIMIT 1').bind(companyId).first();
  const row = await db.prepare(`INSERT INTO logos (company_id, etiqueta, nombre, formato, mime, size, vectorial, vista, curvas, principal, drive_id, drive_link, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(companyId, datos.etiqueta?.trim() || null, archivo.name || `logo.${r.formato}`, r.formato, r.mime,
    archivo.size, r.vectorial ? 1 : 0, r.vista, r.curvas, hay ? 0 : 1, f.id, f.link, ctx.user.id).first<{ id: number }>();
  return logoPorId(db, row!.id);
}

export async function actualizarLogo(db: D1Database, id: number, cambios: { etiqueta?: string | null; principal?: boolean }) {
  const l = await logoPorId(db, id);
  if (cambios.etiqueta !== undefined) await db.prepare('UPDATE logos SET etiqueta = ? WHERE id = ?').bind(cambios.etiqueta?.trim() || null, id).run();
  if (cambios.principal) {
    await db.batch([
      db.prepare('UPDATE logos SET principal = 0 WHERE company_id = ?').bind(l.company_id),
      db.prepare('UPDATE logos SET principal = 1 WHERE id = ?').bind(id),
    ]);
  }
  return logoPorId(db, id);
}

// Quitar: deja de ofrecerse (el archivo queda en Drive). Los productos que lo tenían vuelven al principal; si era el
// principal, pasa a serlo el más nuevo.
export async function quitarLogo(db: D1Database, id: number) {
  const l = await logoPorId(db, id);
  await db.batch([
    db.prepare('UPDATE logos SET archived = 1, principal = 0 WHERE id = ?').bind(id),
    db.prepare('DELETE FROM producto_logos WHERE logo_id = ?').bind(id),
  ]);
  if (l.principal) {
    await db.prepare(`UPDATE logos SET principal = 1 WHERE id = (SELECT id FROM logos WHERE company_id = ? AND archived = 0 ORDER BY created_at DESC LIMIT 1)`)
      .bind(l.company_id).run();
  }
}

// Elegir el logo de un producto del pedido o negocio (null: el principal). Tiene que ser de la empresa del registro.
// Si el boceto de ese producto ya está en ClickUp, el logo nuevo se manda también.
export async function elegirLogo(db: D1Database, ctx: Ctx, rec: { id: number; object_type: string }, producto: string, logoId: number | null) {
  if (!['order', 'deal'].includes(rec.object_type)) throw new HttpError(400, 'El logo se elige en los productos de un pedido o negocio.');
  const p = producto.trim();
  if (!p) throw new HttpError(400, 'Falta el producto.');
  if (logoId == null) {
    await db.prepare('DELETE FROM producto_logos WHERE record_id = ? AND producto = ?').bind(rec.id, p).run();
  } else {
    const l = await logoPorId(db, logoId);
    if (l.company_id !== (await primaryCompanyId(db, rec.id))) throw new HttpError(400, 'Ese logo es de otra empresa.');
    await db.prepare(`INSERT INTO producto_logos (record_id, producto, logo_id, user_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (record_id, producto) DO UPDATE SET logo_id = excluded.logo_id, user_id = excluded.user_id, updated_at = excluded.updated_at`)
      .bind(rec.id, p, logoId, ctx.user.id, new Date().toISOString()).run();
  }
  if (rec.object_type === 'order') await encolarLogo(db, rec.id, p, ctx.user.id);
  return logoDelProducto(db, rec.id, p);
}

// Con el boceto del producto ya adjunto en ClickUp: que se adjunte también el logo (clickup.ts, adjuntar_logo).
export async function encolarLogo(db: D1Database, orderId: number, producto: string, userId: number | null) {
  await db.prepare(`INSERT INTO clickup_salida (record_id, action, user_id, ref)
    SELECT ?1, 'adjuntar_logo', ?3, ?2 WHERE EXISTS (SELECT 1 FROM bocetos WHERE record_id = ?1 AND producto = ?2 AND archived = 0 AND clickup_task IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM clickup_salida WHERE record_id = ?1 AND action = 'adjuntar_logo' AND ref = ?2 AND done_at IS NULL)`)
    .bind(orderId, producto, userId).run();
}

// Un boceto del negocio usado en el pedido se lleva el logo elegido para ese producto en el negocio (si el pedido no tiene otro).
export async function copiarLogoElegido(db: D1Database, desde: number, productoDesde: string | null, hasta: number, productoHasta: string | null) {
  if (!productoDesde || !productoHasta) return;
  await db.prepare(`INSERT OR IGNORE INTO producto_logos (record_id, producto, logo_id, user_id)
    SELECT ?, ?, logo_id, user_id FROM producto_logos WHERE record_id = ? AND producto = ?`).bind(hasta, productoHasta, desde, productoDesde).run();
}

// ---------- Para Producción ----------

// Cómo está el logo de cada artículo de ClickUp (por su pedido): el del producto (si el artículo es un renglón del pedido)
// o el principal de la empresa; «falta» si la empresa no tiene ninguno.
export async function logosDeArticulos(db: D1Database, arts: Array<{ task_id: string; record_id: number | null; nombre: string }>) {
  const out = new Map<string, Curvas | 'falta'>();
  const ids = [...new Set(arts.map((a) => a.record_id).filter((x): x is number => x != null))];
  if (!ids.length) return out;
  const [principales, elegidos, renglones] = await db.batch([
    db.prepare(`SELECT r.value AS record_id, (SELECT l.curvas FROM logos l WHERE l.archived = 0 AND l.company_id =
        (SELECT x.to_id FROM associations x WHERE x.from_id = r.value AND x.to_type = 'company' ORDER BY x.is_primary DESC, x.created_at LIMIT 1)
      ORDER BY l.principal DESC, l.created_at DESC LIMIT 1) AS curvas FROM json_each(?1) r`).bind(JSON.stringify(ids)),
    db.prepare(`SELECT pl.record_id, pl.producto, l.curvas FROM producto_logos pl JOIN logos l ON l.id = pl.logo_id AND l.archived = 0
      WHERE pl.record_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)),
    db.prepare(`SELECT record_id, clickup_task, code FROM line_items WHERE record_id IN (SELECT value FROM json_each(?1)) AND clickup_task IS NOT NULL`).bind(JSON.stringify(ids)),
  ]);
  const principal = new Map((principales.results as Array<{ record_id: number; curvas: Curvas | null }>).map((r) => [r.record_id, r.curvas]));
  const elegido = new Map((elegidos.results as Array<{ record_id: number; producto: string; curvas: Curvas }>).map((r) => [`${r.record_id}|${r.producto}`, r.curvas]));
  const codigo = new Map((renglones.results as Array<{ clickup_task: string; code: string | null }>).map((r) => [r.clickup_task, r.code]));
  for (const a of arts) {
    if (a.record_id == null) continue;
    const cod = codigo.get(a.task_id);
    const c = (cod ? elegido.get(`${a.record_id}|${cod}`) : undefined) ?? elegido.get(`${a.record_id}|${a.nombre}`) ?? principal.get(a.record_id) ?? null;
    out.set(a.task_id, c ?? 'falta');
  }
  return out;
}
