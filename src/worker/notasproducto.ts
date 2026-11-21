import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { visibleSql } from './alcance';
import { STAGE } from './clickup';
import { bajarArchivo, driveConfig, subirArchivo } from './drive';
import { nombreSinTalle, raizTalle, TALLES_VERSION } from './talles';
import { raizDeSku } from './tallesdb';

// Notas de producto (pedido de Rodrigo del 16/11/2026). Producción documenta lo que va pasando con un producto de
// importador («la serigrafía se sale», «el bordado tapa el bolsillo», «la tinta se borra», «es de mala calidad») y queda
// atado a su SKU, no al pedido: cada vez que se vuelve a vender, la nota aparece sola en Producción y en los productos
// del pedido, y la vendedora y Producción reciben un aviso. La ficha del SKU junta sus notas y los pedidos donde se vendió.
// - Escriben Producción y los administradores; ven todos (también Ventas, que es quien vende el producto).
// - Los SKU genéricos (`_GE_`: «PICPS_GE_6000», «PS_GE_2000») no llevan notas: el mismo código es vasos, naipes y paletas.
// - Una nota es del SKU exacto (ese color) o, si se marca, de todo el modelo: el SKU sin la variante del final
//   («IMP_P18.030» de «IMP_P18.030.03»), y vale para cualquier SKU que empiece así seguido de un separador.
// - Una prenda con talles (talles.ts) es un producto: la nota vale siempre para todos sus talles (pedido de Rodrigo del
//   20/11/2026). Guarda la raíz de su SKU (el SKU sin el talle) y vale para cualquier SKU con la misma raíz.

export const TIPOS: Record<string, string> = {
  serigrafia: 'Serigrafía', bordado: 'Bordado', laser: 'Grabado láser', tampografia: 'Tampografía', sublimacion: 'Sublimación',
  calidad: 'Calidad del producto', tinta: 'Durabilidad de la impresión', otro: 'Otro',
};
export const GRAVEDADES = ['info', 'ojo', 'no'] as const;
export type Gravedad = (typeof GRAVEDADES)[number];
const PESO: Record<Gravedad, number> = { info: 0, ojo: 1, no: 2 };
const MAX_TEXTO = 2000;
const MAX_FOTO = 15 * 1024 * 1024;
export const MAX_FOTOS = 10;       // por nota
const FOTOS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export const skuDe = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
export const esGenerico = (code: string | null | undefined) => /_GE(_|$)/i.test(code ?? '');
// Si un SKU puede llevar notas: de importador (no genérico) y con forma de código.
export const admiteNotas = (sku: string | null | undefined) => {
  const s = skuDe(sku);
  return s.length >= 3 && s.length <= 120 && !esGenerico(s);
};
// El modelo de un SKU: sin el último tramo si es corto (la variante de color: «.03», «-AZ», «_NE»). Si no se puede
// separar con seguridad, null (la nota queda solo para ese SKU).
export function modeloDe(sku: string): string | null {
  const m = skuDe(sku).match(/^(.+)[.\-_ ]([A-Z0-9]{1,3})$/);
  if (!m || m[1].length < 5 || !/[.\-_ ]/.test(m[1])) return null;
  return m[1];
}

// Puede escribir notas: Producción y los administradores (no los de solo lectura).
export const puedeEscribirNotas = (u: User) => u.role !== 'viewer' && (u.role === 'admin' || u.profile === 'produccion');

// La nota `n` vale para el SKU `s` (una expresión SQL): el mismo SKU, uno que empieza con su modelo y sigue con un
// separador (todos los colores) o, si `r` es la raíz de ese SKU (talles.ts), otro talle del mismo producto.
const APLICA = (n: string, s: string, r?: string) => `(${n}.sku = ${s} OR (${n}.modelo IS NOT NULL AND substr(${s}, 1, length(${n}.modelo)) = ${n}.modelo
  AND substr(${s}, length(${n}.modelo) + 1, 1) IN ('.', '-', '_', ' '))${r ? ` OR (${n}.raiz IS NOT NULL AND ${n}.raiz = ${r})` : ''})`;
const VIGENTE = (n: string) => `${n}.borrada_at IS NULL AND ${n}.archivada_at IS NULL`;

// ---------- El resumen (para el aviso en Producción y en los productos del pedido) ----------

export interface ResumenNotas { n: number; gravedad: Gravedad; tipos: string[]; ultima: string }
// Cada SKU puede venir con su raíz (talles.ts), si es un talle: así trae también las notas escritas en los otros talles.
export async function resumenNotas(db: D1Database, skus: Array<string | null | undefined | { sku: string | null | undefined; raiz?: string | null }>) {
  const out = new Map<string, ResumenNotas>();
  const pares = new Map<string, string | null>();
  for (const x of skus) {
    const s = typeof x === 'object' && x ? x.sku : x;
    if (!admiteNotas(s)) continue;
    const r = typeof x === 'object' && x ? x.raiz ?? null : null;
    if (!pares.get(skuDe(s))) pares.set(skuDe(s), r);
  }
  if (!pares.size) return out;
  const { results } = await db.prepare(`SELECT json_extract(j.value, '$[0]') AS sku, n.gravedad, n.tipo, n.texto FROM json_each(?1) j
      JOIN producto_notas n ON ${VIGENTE('n')} AND ${APLICA('n', "json_extract(j.value, '$[0]')", "json_extract(j.value, '$[1]')")} ORDER BY n.id`)
    .bind(JSON.stringify([...pares])).all<{ sku: string; gravedad: Gravedad; tipo: string; texto: string }>();
  for (const r of results) {
    const a = out.get(r.sku) ?? { n: 0, gravedad: 'info' as Gravedad, tipos: [], ultima: '' };
    a.n++;
    if (PESO[r.gravedad] > PESO[a.gravedad]) a.gravedad = r.gravedad;
    if (!a.tipos.includes(r.tipo)) a.tipos.push(r.tipo);
    a.ultima = r.texto.slice(0, 160);
    out.set(r.sku, a);
  }
  return out;
}

// El SKU de cada artículo de Producción: el de la subtarea («Código:») o, si no lo tiene, el del renglón del pedido atado
// a ese artículo (lo mismo que usa completarProveedores).
export async function skusDeArticulos(db: D1Database, arts: Array<{ task_id: string; codigo: string | null }>) {
  const out = new Map<string, string>();
  const faltan: string[] = [];
  for (const a of arts) { if (a.codigo?.trim()) out.set(a.task_id, skuDe(a.codigo)); else faltan.push(a.task_id); }
  if (faltan.length) {
    const { results } = await db.prepare(`SELECT clickup_task, code FROM line_items WHERE clickup_task IN (SELECT value FROM json_each(?))
        AND TRIM(COALESCE(code, '')) != '' ORDER BY id`).bind(JSON.stringify(faltan)).all<{ clickup_task: string; code: string }>();
    for (const r of results) if (!out.has(r.clickup_task)) out.set(r.clickup_task, skuDe(r.code));
  }
  return out;
}

// ---------- La ficha del SKU ----------

export interface NotaProducto {
  id: number; sku: string; modelo: string | null; raiz: string | null; producto: string | null; tipo: string; gravedad: Gravedad; texto: string;
  record_id: number | null; pedido: string | null; task_id: string | null; fotos: number[]; user_id: number | null; autor: string | null;
  created_at: string; updated_at: string | null; archivada_at: string | null; archivada_por: number | null; puede_editar: boolean;
}

function validarSku(sku: string) {
  const s = skuDe(sku);
  if (!s) throw new HttpError(400, 'Falta el SKU.');
  if (esGenerico(s)) throw new HttpError(400, `${s} es un SKU genérico (el mismo código se usa para productos distintos): no lleva notas.`);
  if (!admiteNotas(s)) throw new HttpError(400, 'Ese SKU no es válido.');
  return s;
}

// Las notas que valen para un SKU (las de ese SKU y las de su modelo), con las archivadas al final. El pedido donde pasó
// se muestra solo si quien mira lo ve (una vendedora no ve los pedidos de otra).
async function notasDe(db: D1Database, user: User, sku: string, raiz?: string | null): Promise<NotaProducto[]> {
  if (raiz === undefined) raiz = await raizDeSku(db, sku);
  const { results } = await db.prepare(`SELECT n.id, n.sku, n.modelo, n.raiz, n.producto, n.tipo, n.gravedad, n.texto, n.task_id,
        (SELECT json_group_array(f.id) FROM (SELECT id FROM producto_nota_fotos WHERE nota_id = n.id AND borrada_at IS NULL ORDER BY id) f) AS fotos, n.user_id, u.name AS autor, n.created_at, n.updated_at, n.archivada_at, n.archivada_por,
        CASE WHEN r.id IS NOT NULL AND ${visibleSql('r', user)} THEN r.id END AS record_id,
        CASE WHEN r.id IS NOT NULL AND ${visibleSql('r', user)} THEN r.name END AS pedido
      FROM producto_notas n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN records r ON r.id = n.record_id AND r.archived = 0
      WHERE n.borrada_at IS NULL AND ${APLICA('n', '?1', '?2')}
      ORDER BY n.archivada_at IS NOT NULL, CASE n.gravedad WHEN 'no' THEN 0 WHEN 'ojo' THEN 1 ELSE 2 END, n.created_at DESC`)
    .bind(sku, raiz).all<Omit<NotaProducto, 'fotos' | 'puede_editar'> & { fotos: string | null }>();
  return results.map((n) => ({ ...n, fotos: JSON.parse(n.fotos ?? '[]') as number[], puede_editar: puedeEscribirNotas(user) && (user.role === 'admin' || n.user_id === user.id) }));
}

// Los SKU de los otros talles del mismo producto que se vendieron (los de la misma raíz). Se buscan los que empiezan como la
// raíz (hasta donde va el talle) y tienen talle, y se quedan los que dan esa raíz.
async function skusDeRaiz(db: D1Database, sku: string, raiz: string) {
  const prefijo = raiz.split(/[·*]/)[0];
  const { results } = await db.prepare(`SELECT DISTINCT UPPER(TRIM(code)) AS code, talle, grupo_talle FROM line_items
      WHERE talle IS NOT NULL AND substr(UPPER(TRIM(code)), 1, ?2) = ?1 LIMIT 500`).bind(prefijo, prefijo.length)
    .all<{ code: string; talle: string; grupo_talle: string | null }>();
  return [...new Set([sku, ...results.filter((r) => raizTalle(r.code, r.talle, r.grupo_talle) === raiz).map((r) => r.code)])];
}

export async function fichaProducto(env: Env, user: User, skuCrudo: string) {
  const db = env.DB;
  const sku = validarSku(skuCrudo);
  // Una prenda con talles: las notas y dónde se vendió, de todos sus talles (los SKU con la misma raíz).
  const raiz = await raizDeSku(db, sku);
  const skus = raiz ? await skusDeRaiz(db, sku, raiz) : [sku];
  const [ficha, ventas, total, notas, drive] = await Promise.all([
    // El nombre y la foto: la ficha de Finnegans, si no la foto del SKU en las cotizaciones del STP y el nombre de algún
    // renglón o artículo de ClickUp.
    db.prepare(`SELECT
        (SELECT name FROM products WHERE UPPER(TRIM(code)) = ?1 AND name IS NOT NULL LIMIT 1) AS nombre_fin,
        (SELECT image_url FROM products WHERE UPPER(TRIM(code)) = ?1 AND image_url IS NOT NULL LIMIT 1) AS foto_fin,
        (SELECT image_url FROM stp_imagenes WHERE pedido = '' AND sku = ?1 AND image_url != '' LIMIT 1) AS foto_stp,
        (SELECT COALESCE(name, description) FROM line_items WHERE UPPER(TRIM(code)) = ?1 AND COALESCE(name, description) IS NOT NULL ORDER BY id DESC LIMIT 1) AS nombre_li,
        (SELECT producto FROM producto_notas WHERE sku = ?1 AND producto IS NOT NULL ORDER BY id DESC LIMIT 1) AS nombre_nota`)
      .bind(sku).first<{ nombre_fin: string | null; foto_fin: string | null; foto_stp: string | null; nombre_li: string | null; nombre_nota: string | null }>(),
    // Dónde se vendió: los pedidos con ese SKU que quien mira puede ver, lo último primero.
    db.prepare(`SELECT r.id, r.name, r.created_at, json_extract(r.props, '$.hs_pipeline_stage') AS etapa, SUM(li.quantity) AS cantidad,
        (SELECT c.name FROM associations x JOIN records c ON c.id = x.to_id AND c.archived = 0 WHERE x.from_id = r.id AND x.to_type = 'company'
          ORDER BY x.is_primary DESC, x.created_at LIMIT 1) AS empresa,
        (SELECT COUNT(*) FROM producto_notas n WHERE n.record_id = r.id AND n.borrada_at IS NULL AND ${APLICA('n', '?1', '?3')}) AS notas
      FROM line_items li JOIN records r ON r.id = li.record_id AND r.object_type = 'order' AND r.archived = 0
      WHERE UPPER(TRIM(li.code)) IN (SELECT value FROM json_each(?2)) AND ${visibleSql('r', user)}
      GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`).bind(sku, JSON.stringify(skus), raiz)
      .all<{ id: number; name: string; created_at: string; etapa: string | null; cantidad: number | null; empresa: string | null; notas: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT li.record_id) AS n, SUM(li.quantity) AS unidades FROM line_items li
      JOIN records r ON r.id = li.record_id AND r.object_type = 'order' AND r.archived = 0 WHERE UPPER(TRIM(li.code)) IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(skus))
      .first<{ n: number; unidades: number | null }>(),
    notasDe(db, user, sku, raiz),
    driveConfig(env),
  ]);
  return {
    sku, modelo: modeloDe(sku), raiz, talles: skus.length, nombre: ficha?.nombre_fin ?? ficha?.nombre_li ?? ficha?.nombre_nota ?? null, foto: ficha?.foto_fin ?? ficha?.foto_stp ?? null,
    notas, ventas: ventas.results, ventas_total: total?.n ?? 0, unidades_total: total?.unidades ?? 0,
    puede_escribir: puedeEscribirNotas(user), fotos: !!(drive.carpeta && drive.usuario && env.GOOGLE_SA_JSON), tipos: TIPOS,
  };
}

// La lista de los productos con notas (pantalla «Notas de productos»): un renglón por SKU con lo vigente.
export async function productosConNotas(db: D1Database, q: { buscar?: string; tipo?: string; gravedad?: string; archivadas?: boolean }) {
  const buscar = String(q.buscar ?? '').trim().toLowerCase();
  // Una fila por producto: las notas de los talles de una prenda, juntas (por su raíz).
  const { results } = await db.prepare(`SELECT g.*,
        (SELECT x.texto FROM producto_notas x WHERE COALESCE(x.raiz, x.sku) = g.clave AND x.borrada_at IS NULL ORDER BY x.archivada_at IS NOT NULL, x.created_at DESC LIMIT 1) AS texto,
        (SELECT image_url FROM products p WHERE UPPER(TRIM(p.code)) = g.sku AND p.image_url IS NOT NULL LIMIT 1) AS foto,
        (SELECT name FROM products p WHERE UPPER(TRIM(p.code)) = g.sku AND p.name IS NOT NULL LIMIT 1) AS nombre
      FROM (SELECT COALESCE(n.raiz, n.sku) AS clave, MAX(n.sku) AS sku, MAX(n.modelo) AS modelo, MAX(n.raiz) AS raiz, MAX(n.producto) AS producto,
          SUM(n.archivada_at IS NULL) AS vigentes, COUNT(*) AS total,
          MAX(CASE WHEN n.archivada_at IS NULL THEN CASE n.gravedad WHEN 'no' THEN 2 WHEN 'ojo' THEN 1 ELSE 0 END END) AS peso,
          json_group_array(DISTINCT n.tipo) AS tipos, MAX(n.created_at) AS ultima
        FROM producto_notas n WHERE n.borrada_at IS NULL
          AND (?1 = '' OR LOWER(n.sku) LIKE '%' || ?1 || '%' OR LOWER(COALESCE(n.producto, '')) LIKE '%' || ?1 || '%' OR LOWER(n.texto) LIKE '%' || ?1 || '%')
          AND (?2 = '' OR n.tipo = ?2) AND (?3 = '' OR n.gravedad = ?3) AND (?4 = 1 OR n.archivada_at IS NULL)
        GROUP BY COALESCE(n.raiz, n.sku)) g
      ORDER BY g.peso DESC, g.ultima DESC LIMIT 500`)
    .bind(buscar, q.tipo && TIPOS[q.tipo] ? q.tipo : '', q.gravedad && (GRAVEDADES as readonly string[]).includes(q.gravedad) ? q.gravedad : '', q.archivadas ? 1 : 0)
    .all<{ clave: string; sku: string; modelo: string | null; raiz: string | null; producto: string | null; vigentes: number; total: number; peso: number | null; tipos: string; ultima: string;
      texto: string | null; foto: string | null; nombre: string | null }>();
  return {
    productos: results.map(({ peso, tipos, clave: _clave, ...r }) => ({
      ...r, nombre: r.nombre ?? r.producto, tipos: JSON.parse(tipos) as string[], gravedad: peso == null ? null : GRAVEDADES[peso],
    })),
    tipos: TIPOS,
  };
}

// ---------- Escribir ----------

interface DatosNota { texto?: unknown; tipo?: unknown; gravedad?: unknown; todos_colores?: unknown; record_id?: unknown; task_id?: unknown; producto?: unknown }

function validar(d: DatosNota, parcial = false) {
  const out: { texto?: string; tipo?: string; gravedad?: Gravedad } = {};
  if (!parcial || d.texto !== undefined) {
    const t = String(d.texto ?? '').trim();
    if (!t) throw new HttpError(400, 'Escribí qué pasa con el producto.');
    if (t.length > MAX_TEXTO) throw new HttpError(400, `La nota es muy larga (máximo ${MAX_TEXTO} caracteres).`);
    out.texto = t;
  }
  if (!parcial || d.tipo !== undefined) {
    const t = String(d.tipo ?? 'otro');
    if (!TIPOS[t]) throw new HttpError(400, 'Ese tipo de nota no existe.');
    out.tipo = t;
  }
  if (!parcial || d.gravedad !== undefined) {
    const g = String(d.gravedad ?? 'ojo') as Gravedad;
    if (!GRAVEDADES.includes(g)) throw new HttpError(400, 'La gravedad es info, ojo o no.');
    out.gravedad = g;
  }
  return out;
}
const verdad = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

// Revisa las fotos antes de subir ninguna (si una no sirve, no queda nada a medias en Drive).
async function validarFotos(env: Env, fotos: File[], yaTiene = 0) {
  if (!fotos.length) return;
  if (yaTiene + fotos.length > MAX_FOTOS) throw new HttpError(400, `Una nota lleva hasta ${MAX_FOTOS} fotos${yaTiene ? ` (ya tiene ${yaTiene})` : ''}.`);
  for (const foto of fotos) {
    if (foto.size > MAX_FOTO) throw new HttpError(400, `${foto.name || 'La foto'} es muy grande (máximo 15 MB por foto).`);
    if (!FOTOS[foto.type]) throw new HttpError(400, `${foto.name || 'La foto'}: tiene que ser JPG, PNG, WEBP o GIF.`);
  }
  const cfg = await driveConfig(env);
  if (!cfg.carpeta || !cfg.usuario || !env.GOOGLE_SA_JSON) throw new HttpError(400, 'Para guardar fotos falta elegir la carpeta de Drive (Configuración → Integraciones).');
}

// Sube las fotos a Drive (de a una, en orden) y las ata a la nota.
async function guardarFotos(env: Env, notaId: number, sku: string, fotos: File[], userId: number) {
  const dia = now().slice(0, 10);
  for (const [i, foto] of fotos.entries()) {
    const nombre = `${sku} ${dia}${fotos.length > 1 ? ` (${i + 1})` : ''}.${FOTOS[foto.type]}`;
    const f = await subirArchivo(env, ['Notas de productos', sku.replace(/[\\/]/g, '-')], nombre, foto.type, await foto.arrayBuffer());
    await env.DB.prepare('INSERT INTO producto_nota_fotos (nota_id, drive_id, mime, nombre, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(notaId, f.id, foto.type, nombre, userId).run();
  }
}
const soloFotos = (fotos?: Array<File | null | undefined> | null) => (fotos ?? []).filter((f): f is File => !!f && f.size > 0);

export async function crearNotaProducto(env: Env, ctx: Ctx, skuCrudo: string, d: DatosNota, fotosCrudas?: Array<File | null> | null) {
  if (!puedeEscribirNotas(ctx.user)) throw new HttpError(403, 'Las notas de producto las escriben Producción y los administradores.');
  const db = env.DB;
  const sku = validarSku(skuCrudo);
  const v = validar(d);
  const modelo = verdad(d.todos_colores) ? modeloDe(sku) : null;
  if (verdad(d.todos_colores) && !modelo) throw new HttpError(400, `No se puede separar el color de ${sku}: la nota queda solo para ese SKU.`);
  const recordId = Number(d.record_id) > 0 ? Number(d.record_id) : null;
  if (recordId && !(await db.prepare("SELECT 1 FROM records WHERE id = ? AND object_type = 'order'").bind(recordId).first())) throw new HttpError(400, 'Ese pedido no existe.');
  const fotos = soloFotos(fotosCrudas);
  await validarFotos(env, fotos);
  const producto = String(d.producto ?? '').trim().slice(0, 200) || null;
  // Una prenda con talles: la nota vale para todos sus talles (la raíz de su SKU, talles.ts).
  const raiz = await raizDeSku(db, sku);
  const row = await db.prepare(`INSERT INTO producto_notas (sku, modelo, raiz, talles_v, producto, tipo, gravedad, texto, record_id, task_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(sku, modelo, raiz, TALLES_VERSION, producto, v.tipo, v.gravedad, v.texto, recordId, String(d.task_id ?? '').trim() || null, ctx.user.id)
    .first<{ id: number }>();
  // Si Drive falla a mitad de camino, la nota queda con las fotos que llegaron a subir (y se pueden agregar las otras).
  await guardarFotos(env, row!.id, sku, fotos, ctx.user.id);
  return (await notasDe(db, ctx.user, sku, raiz)).find((n) => n.id === row!.id)!;
}

async function notaPorId(db: D1Database, id: number) {
  const n = await db.prepare('SELECT * FROM producto_notas WHERE id = ? AND borrada_at IS NULL').bind(id)
    .first<{ id: number; sku: string; user_id: number | null; archivada_at: string | null }>();
  if (!n) throw new HttpError(404, 'No existe la nota.');
  return n;
}
const esAutorOAdmin = (ctx: Ctx, n: { user_id: number | null }) => ctx.user.role === 'admin' || n.user_id === ctx.user.id;

// Cambiar el texto, el tipo, la gravedad o si vale para todos los colores: quien la escribió o un administrador.
// Archivar («ya no aplica») o volver a ponerla vigente: cualquiera que escribe notas.
export async function editarNotaProducto(env: Env, ctx: Ctx, id: number, d: DatosNota & { archivada?: unknown }) {
  if (!puedeEscribirNotas(ctx.user)) throw new HttpError(403, 'Las notas de producto las escriben Producción y los administradores.');
  const db = env.DB;
  const n = await notaPorId(db, id);
  const contenido = d.texto !== undefined || d.tipo !== undefined || d.gravedad !== undefined || d.todos_colores !== undefined;
  if (contenido && !esAutorOAdmin(ctx, n)) throw new HttpError(403, 'Solo quien escribió la nota (o un administrador) la puede cambiar. Si ya no aplica, archivala.');
  const v = validar(d, true);
  const sets: string[] = [], binds: unknown[] = [];
  for (const [k, x] of Object.entries(v)) { sets.push(`${k} = ?`); binds.push(x); }
  if (d.todos_colores !== undefined) {
    const modelo = verdad(d.todos_colores) ? modeloDe(n.sku) : null;
    if (verdad(d.todos_colores) && !modelo) throw new HttpError(400, `No se puede separar el color de ${n.sku}.`);
    sets.push('modelo = ?'); binds.push(modelo);
  }
  if (contenido) { sets.push('updated_at = ?'); binds.push(now()); }
  if (d.archivada !== undefined) {
    const a = verdad(d.archivada);
    sets.push('archivada_at = ?', 'archivada_por = ?'); binds.push(a ? n.archivada_at ?? now() : null, a ? ctx.user.id : null);
  }
  if (sets.length) await db.prepare(`UPDATE producto_notas SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  return (await notasDe(db, ctx.user, n.sku)).find((x) => x.id === id)!;
}

export async function borrarNotaProducto(env: Env, ctx: Ctx, id: number) {
  const n = await notaPorId(env.DB, id);
  if (!puedeEscribirNotas(ctx.user) || !esAutorOAdmin(ctx, n)) throw new HttpError(403, 'Solo quien escribió la nota (o un administrador) la puede borrar. Si ya no aplica, archivala.');
  await env.DB.prepare('UPDATE producto_notas SET borrada_at = ? WHERE id = ?').bind(now(), id).run();
  return { ok: true };
}

// ---------- Las fotos ----------

// Agregar fotos a una nota que ya existe: quien la escribió o un administrador.
export async function agregarFotosNota(env: Env, ctx: Ctx, id: number, fotosCrudas: Array<File | null>) {
  const n = await notaPorId(env.DB, id);
  if (!puedeEscribirNotas(ctx.user) || !esAutorOAdmin(ctx, n)) throw new HttpError(403, 'Solo quien escribió la nota (o un administrador) le puede agregar fotos.');
  const fotos = soloFotos(fotosCrudas);
  if (!fotos.length) throw new HttpError(400, 'Elegí al menos una foto.');
  const ya = await env.DB.prepare('SELECT COUNT(*) AS n FROM producto_nota_fotos WHERE nota_id = ? AND borrada_at IS NULL').bind(id).first<{ n: number }>();
  await validarFotos(env, fotos, ya?.n ?? 0);
  await guardarFotos(env, id, n.sku, fotos, ctx.user.id);
  return (await notasDe(env.DB, ctx.user, n.sku)).find((x) => x.id === id)!;
}

async function fotoPorId(db: D1Database, fotoId: number) {
  const f = await db.prepare(`SELECT f.id, f.nota_id, f.drive_id, f.mime, f.nombre FROM producto_nota_fotos f
      JOIN producto_notas n ON n.id = f.nota_id AND n.borrada_at IS NULL WHERE f.id = ? AND f.borrada_at IS NULL`).bind(fotoId)
    .first<{ id: number; nota_id: number; drive_id: string; mime: string | null; nombre: string | null }>();
  if (!f) throw new HttpError(404, 'No existe la foto.');
  return f;
}

// Sacar una foto de la nota (el archivo queda en Drive): quien la escribió o un administrador.
export async function borrarFotoNota(env: Env, ctx: Ctx, fotoId: number) {
  const f = await fotoPorId(env.DB, fotoId);
  const n = await notaPorId(env.DB, f.nota_id);
  if (!puedeEscribirNotas(ctx.user) || !esAutorOAdmin(ctx, n)) throw new HttpError(403, 'Solo quien escribió la nota (o un administrador) le puede sacar fotos.');
  await env.DB.prepare('UPDATE producto_nota_fotos SET borrada_at = ? WHERE id = ?').bind(now(), fotoId).run();
  return (await notasDe(env.DB, ctx.user, n.sku)).find((x) => x.id === n.id)!;
}

// Una foto, desde Drive (la ven todos los que ven la nota).
async function servirFoto(env: Env, f: { drive_id: string; mime: string | null; nombre: string | null }) {
  const res = await bajarArchivo(env, f.drive_id);
  return new Response(res.body, { headers: {
    'content-type': f.mime ?? 'application/octet-stream', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.nombre ?? 'foto')}`,
    'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff',
  } });
}
export async function fotoNotaProducto(env: Env, fotoId: number) {
  return servirFoto(env, await fotoPorId(env.DB, fotoId));
}
// La primera foto de una nota (la dirección de antes, cuando las notas tenían una sola).
export async function primeraFotoNota(env: Env, id: number) {
  await notaPorId(env.DB, id);
  const f = await env.DB.prepare('SELECT drive_id, mime, nombre FROM producto_nota_fotos WHERE nota_id = ? AND borrada_at IS NULL ORDER BY id LIMIT 1')
    .bind(id).first<{ drive_id: string; mime: string | null; nombre: string | null }>();
  if (!f) throw new HttpError(404, 'La nota no tiene foto.');
  return servirFoto(env, f);
}

// ---------- El aviso: entró (o se volvió a leer) un pedido con un producto que tiene notas ----------

// Después de leer los productos de un pedido (productos.ts): por cada SKU con una nota vigente «ojo» o «no recomendado»
// que no se escribió en este mismo pedido, un aviso en la campanita a la vendedora del pedido y a Producción. Uno solo por
// persona, pedido y SKU. Los pedidos entregados o anulados no avisan. Solo en el CRM (no sale por mail).
export async function avisarNotasDelPedido(db: D1Database, recordId: number) {
  const r = await db.prepare(`SELECT owner_id, json_extract(props, '$.hs_pipeline_stage') AS etapa FROM records WHERE id = ? AND object_type = 'order' AND archived = 0`)
    .bind(recordId).first<{ owner_id: number | null; etapa: string | null }>();
  if (!r || [STAGE.entregado, STAGE.anulado].includes(r.etapa ?? '')) return 0;
  // Un aviso por producto: los talles de una prenda (talles.ts) van juntos, con el nombre sin el talle y el SKU de uno
  // de ellos (siempre el mismo, así no se repite el aviso).
  const lineas = (await db.prepare(`SELECT UPPER(TRIM(li.code)) AS sku, COALESCE(p.name, li.name, li.description) AS nombre, li.talle, li.grupo_talle
      FROM line_items li LEFT JOIN products p ON p.code = li.code WHERE li.record_id = ? AND TRIM(COALESCE(li.code, '')) != ''`).bind(recordId)
    .all<{ sku: string; nombre: string | null; talle: string | null; grupo_talle: string | null }>()).results;
  const productos = new Map<string, { sku: string; nombre: string | null; raiz: string | null }>();
  for (const l of lineas) {
    if (esGenerico(l.sku)) continue;
    const raiz = raizTalle(l.sku, l.talle, l.grupo_talle);
    const k = raiz ?? l.sku, antes = productos.get(k);
    if (!antes || l.sku < antes.sku) productos.set(k, { sku: l.sku, nombre: raiz && l.nombre ? nombreSinTalle(l.nombre) : l.nombre, raiz });
  }
  if (!productos.size) return 0;
  const nombreDe = new Map([...productos.values()].map((x) => [x.sku, x.nombre]));
  const { results } = await db.prepare(`SELECT json_extract(j.value, '$[0]') AS sku, n.gravedad, n.texto FROM json_each(?2) j
      JOIN producto_notas n ON ${VIGENTE('n')} AND n.gravedad IN ('ojo', 'no') AND COALESCE(n.record_id, 0) != ?1
        AND ${APLICA('n', "json_extract(j.value, '$[0]')", "json_extract(j.value, '$[1]')")}
      ORDER BY 1, CASE n.gravedad WHEN 'no' THEN 0 ELSE 1 END, n.created_at DESC`)
    .bind(recordId, JSON.stringify([...productos.values()].map((x) => [x.sku, x.raiz]))).all<{ sku: string; gravedad: Gravedad; texto: string }>();
  const porSku = new Map<string, { nombre: string | null; gravedad: Gravedad; textos: string[] }>();
  for (const x of results) {
    const a = porSku.get(x.sku) ?? { nombre: nombreDe.get(x.sku) ?? null, gravedad: x.gravedad, textos: [] };
    a.textos.push(x.texto);
    porSku.set(x.sku, a);
  }
  if (!porSku.size) return 0;
  const gente = (await db.prepare(`SELECT id FROM users WHERE active = 1 AND deleted_at IS NULL AND role != 'viewer' AND (id = ?1 OR profile = 'produccion')`)
    .bind(r.owner_id ?? 0).all<{ id: number }>()).results.map((u) => u.id);
  if (!gente.length) return 0;
  const ahora = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [sku, a] of porSku) {
    const resumen = `${a.gravedad === 'no' ? '⛔' : '⚠️'} ${a.nombre ? `${a.nombre} (${sku})` : sku}: ${a.textos[0]}${a.textos.length > 1 ? ` (y ${a.textos.length - 1} nota${a.textos.length > 2 ? 's' : ''} más)` : ''}`.slice(0, 500);
    for (const u of gente) {
      stmts.push(db.prepare(`INSERT INTO avisos (user_id, kind, record_id, sku, detalle, sent_at, error)
        SELECT ?1, 'producto', ?2, ?3, ?4, ?5, 'solo en el CRM' WHERE NOT EXISTS (SELECT 1 FROM avisos WHERE user_id = ?1 AND kind = 'producto' AND record_id = ?2 AND sku = ?3)`)
        .bind(u, recordId, sku, resumen, ahora));
    }
  }
  const res = await db.batch(stmts);
  return res.reduce((t, x) => t + (x.meta.changes ?? 0), 0);
}
