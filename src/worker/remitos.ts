import Anthropic from '@anthropic-ai/sdk';
import type { Ctx, Env } from './env';
import { HttpError, now } from './env';
import { getRow, updateRecord } from './records';
import { Budget, OutOfBudget } from './budget';
import { clickupAttachment } from './clickup';
import { finnegansPedido, finnegansRemitos, finnegansToken } from './finnegans';
import { orderProducts } from './productos';

// Remitos de entrega (pedido de Rodrigo del 10/11/2026). Cada foto del remito firmado llega por ClickUp (como hasta
// ahora), por el CRM (ficha del pedido) o por la app del chofer (/hooks/chofer), y todas van a la misma lista del pedido.
//
// La lectura la hace Claude: devuelve lo que dice el remito (número, PDV, cliente, CUIT, productos, cantidades, firma y
// sello). A qué pedido va lo decide este archivo, cruzando datos que se controlan entre sí:
// - el PDV, que en el remito aparece dos veces («Nº Pedido Web» y «Observaciones»): tienen que coincidir;
// - el CUIT del cliente, que tiene dígito verificador (un error de lectura se detecta solo) y tiene que ser el de la
//   empresa del pedido (en el CRM o en Finnegans);
// - el número de remito, que Finnegans sabe de qué pedido es;
// - los productos, que tienen que ser del pedido (por código).
// Va solo al pedido cuando el PDV lleva a un único pedido y otro dato fuerte (CUIT o remito en Finnegans) lo confirma sin
// que nada lo contradiga; si no, queda para revisar con los pedidos posibles. Nunca a uno «parecido».
// El mismo número de remito dos veces (una foto repetida, o el mismo remito por la app y por ClickUp) es un solo remito.
//
// Con lo que traen los remitos leídos, el pedido sabe qué se entregó y qué falta, producto por producto (estado de
// entrega). ClickUp no se toca. Logística (o un administrador) puede finalizar la entrega aceptando un faltante.

export const MODELO = 'claude-opus-5-5';
const MAX_IMAGEN = 5 * 1024 * 1024;       // lo más que acepta la API de Claude por imagen
const MAX_PDF = 20 * 1024 * 1024;
export const MAX_SUBIDA = 1_900_000;      // una fila de D1 no puede pasar de 2 MB
const LEER_CLICKUP_DIAS = 60;             // los remitos viejos de ClickUp se leen solo si alguien abre el pedido
const AVISO_DIAS = 15;                    // el aviso a Logística, solo por remitos nuevos (no por los viejos que se leen)
const ENTREGADO = '1237498998';
const PARCIAL = 'entregado_parcial';
const ANULADO = '3c85a297-e9ce-400b-b42e-9f16853d69d6';
const CUIT_FORMAS = ['33709951519', '30716102049'];   // Formas Publicitarias y FP DEMO: el que emite, nunca el cliente

export type Origen = 'clickup' | 'crm' | 'chofer';
export type EstadoRemito = 'sin_leer' | 'ok' | 'revisar' | 'duplicado' | 'descartado';
export interface Control { dato: string; ok: boolean | null; detalle: string }
interface Candidato { id: number; nombre: string; pdv: string | null }

export interface RemitoRow {
  id: number; record_id: number | null; origen: Origen; file_id: number | null; nombre: string | null; mime: string | null; size: number | null;
  data?: ArrayBuffer | number[] | null; hash: string | null; clave: string | null; subido_por: number | null; token_id: number | null; chofer: string | null;
  lat: number | null; lng: number | null; tomada_el: string | null; estado: EstadoRemito; motivo: string | null; repetir: number;
  numero: string | null; pdv: string | null; cuit: string | null; cliente: string | null; fecha: string | null; recibido_por: string | null;
  recibido_el: string | null; firmado: number | null; reservas: number; notas: string | null; lectura: string; controles: string; candidatos: string;
  duplicado_de: number | null; intentos: number; leido_at: string | null; revisado_por: number | null; revisado_at: string | null;
  pdv_chofer: string | null; pide_pdv: number; created_at: string; updated_at: string;
}
const SIN_DATA = `id, record_id, origen, file_id, nombre, mime, size, hash, clave, subido_por, token_id, chofer, lat, lng, tomada_el, estado, motivo,
  repetir, numero, pdv, cuit, cliente, fecha, recibido_por, recibido_el, firmado, reservas, notas, lectura, controles, candidatos, duplicado_de,
  intentos, leido_at, revisado_por, revisado_at, pdv_chofer, pide_pdv, created_at, updated_at`;

// ---------- Datos que se controlan solos ----------

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

// CUIT/CUIL con su dígito verificador (módulo 11). Devuelve los 11 dígitos, o null si no es válido.
export function cuitValido(v: unknown): string | null {
  const d = digitos(v);
  if (d.length !== 11) return null;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return null;
  return dv === Number(d[10]) ? d : null;
}
export const fmtCuit = (d: string) => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;

// «R-0001-00027857», «0001-00027857», «R 1 27857» → «R-0001-00027857». El número es la llave contra los duplicados.
export function normNumero(v: unknown): string | null {
  const s = String(v ?? '').toUpperCase();
  const m = s.match(/([A-Z])?\s*-?\s*(\d{1,5})\s*-\s*(\d{1,8})/);
  if (m) return `${m[1] ?? 'R'}-${m[2].padStart(4, '0')}-${m[3].padStart(8, '0')}`;
  const solo = digitos(s);
  return solo.length >= 5 && solo.length <= 13 ? `R-${solo.slice(0, -8).padStart(4, '0') || '0000'}-${solo.slice(-8).padStart(8, '0')}` : null;
}
const numeroDe = (n: string | null | undefined) => (n ? Number(n.split('-').pop()) : null);

// PDV: solo el número, sin ceros a la izquierda («00030706» → «30706»).
export function normPdv(v: unknown): string | null {
  const d = digitos(v);
  return d && Number(d) > 0 ? String(Number(d)) : null;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const normCodigo = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Razón social sin la forma jurídica, para comparar «SAMSUNG ELECTRONICS ARGENTINA S A» con «Samsung Electronics Argentina SA».
const razon = (s: unknown) => norm(s).replace(/\b(s ?a ?u?|s ?r ?l|s ?a ?s|sociedad anonima|srl|sa|sas|saic|sacif|s ?h)\b/g, ' ').replace(/\s+/g, ' ').trim();

async function sha256Bytes(bytes: ArrayBuffer) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function aBase64(bytes: ArrayBuffer) {
  const u = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}
const aBytes = (d: ArrayBuffer | number[]) => (d instanceof ArrayBuffer ? d : new Uint8Array(d).buffer);

// ---------- Guardar ----------

export interface NuevoRemito {
  recordId?: number | null; origen: Origen; bytes: ArrayBuffer; mime: string; nombre: string;
  clave?: string | null; tokenId?: number | null; chofer?: string | null; lat?: number | null; lng?: number | null; tomadaEl?: string | null;
}

const TIPOS = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;

// Guarda la foto (o el PDF). La misma clave de la app o el mismo archivo devuelven el remito que ya estaba.
export async function guardarRemito(env: Env, ctx: Ctx, n: NuevoRemito): Promise<{ id: number; nuevo: boolean }> {
  const db = env.DB;
  const mime = n.mime.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!TIPOS.test(mime)) throw new HttpError(415, 'El remito tiene que ser una foto (JPG, PNG o WebP) o un PDF.');
  if (!n.bytes.byteLength) throw new HttpError(400, 'El archivo está vacío.');
  if (n.bytes.byteLength > MAX_SUBIDA) throw new HttpError(413, 'El archivo es muy pesado (más de 1,9 MB). Achicá la foto o mandá el PDF comprimido.');
  if (n.clave) {
    const ya = await db.prepare('SELECT id FROM remitos WHERE clave = ?').bind(n.clave).first<{ id: number }>();
    if (ya) return { id: ya.id, nuevo: false };
  }
  // La misma foto dos veces del mismo chofer (o del CRM) es una sola. De otro chofer (una foto reenviada) entra aparte, y
  // el número de remito igual la marca como repetida: así cada chofer ve y puede corregir lo suyo.
  const hash = await sha256Bytes(n.bytes);
  const igual = await db.prepare("SELECT id FROM remitos WHERE hash = ? AND estado != 'descartado' AND COALESCE(token_id, 0) = COALESCE(?, 0) ORDER BY id LIMIT 1")
    .bind(hash, n.tokenId ?? null).first<{ id: number }>();
  if (igual) return { id: igual.id, nuevo: false };
  if (n.recordId) {
    const rec = await getRow(db, n.recordId);
    if (rec.object_type !== 'order') throw new HttpError(400, 'Los remitos van en un pedido.');
  }
  const r = await db.prepare(`INSERT INTO remitos (record_id, origen, nombre, mime, size, data, hash, clave, subido_por, token_id, chofer, lat, lng, tomada_el)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(n.recordId ?? null, n.origen, n.nombre.slice(0, 200) || 'remito', mime, n.bytes.byteLength,
    n.bytes, hash, n.clave ?? null, ctx.user.id, n.tokenId ?? null, n.chofer ?? null, num(n.lat), num(n.lng), n.tomadaEl ?? null).first<{ id: number }>();
  return { id: r!.id, nuevo: true };
}
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function remitoPorId(db: D1Database, id: number) {
  const r = await db.prepare(`SELECT ${SIN_DATA} FROM remitos WHERE id = ?`).bind(id).first<RemitoRow>();
  if (!r) throw new HttpError(404, 'No existe el remito.');
  return r;
}

// El archivo: lo guardado, o el adjunto de ClickUp traído en el momento (sus links vencen).
export async function archivoDeRemito(env: Env, id: number): Promise<{ bytes: ArrayBuffer; mime: string; nombre: string } | null> {
  const r = await env.DB.prepare('SELECT r.data, r.mime, r.nombre, f.source_ref FROM remitos r LEFT JOIN files f ON f.id = r.file_id WHERE r.id = ?')
    .bind(id).first<{ data: ArrayBuffer | number[] | null; mime: string | null; nombre: string | null; source_ref: string | null }>();
  if (!r) return null;
  if (r.data) return { bytes: aBytes(r.data), mime: r.mime ?? 'application/octet-stream', nombre: r.nombre ?? 'remito' };
  if (!r.source_ref) return null;
  const [task, att] = r.source_ref.split(':');
  const a = await clickupAttachment(env, task, att);
  if (!a?.body) return null;
  return { bytes: await new Response(a.body).arrayBuffer(), mime: (r.mime || a.type).split(';')[0], nombre: a.name };
}

// ---------- Lectura con Claude ----------

export interface Lectura {
  es_remito: boolean; legible: boolean; problemas_foto: string[]; repetir_foto: boolean; motivo_repetir: string | null;
  numero_remito: string | null; fecha: string | null; pdv_pedido_web: string | null; pdv_observaciones: string | null;
  cliente: string | null; cuit_cliente: string | null; direccion_entrega: string | null; orden_compra: string | null; bultos: number | null;
  items: Array<{ codigo: string | null; descripcion: string; cantidad: number | null; cantidad_texto: string | null }>;
  firmado: boolean; sello_recepcion: string | null; fecha_recepcion: string | null; aclaracion_firma: string | null;
  recibido_con_reservas: boolean; notas: string | null; otros_remitos_en_foto: boolean; dudas: string[];
}

// El formato de la respuesta. Sin campos que puedan ser de dos tipos (anyOf o ["string", "null"]): la API acepta como
// mucho 16 en un esquema estricto y cada uno encarece la compilación. Un dato que no está o no se lee va como texto
// vacío ("") y una cantidad que no se lee, como -1; limpiarLectura los pasa a null.
const S = { type: 'string' } as const;
const N = { type: 'number' } as const;
const B = { type: 'boolean' } as const;
const LISTA = { type: 'array', items: S } as const;
export const ESQUEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    es_remito: B, legible: B, problemas_foto: LISTA, repetir_foto: B, motivo_repetir: S,
    numero_remito: S, fecha: S, pdv_pedido_web: S, pdv_observaciones: S, cliente: S, cuit_cliente: S,
    direccion_entrega: S, orden_compra: S, bultos: S,
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { codigo: S, descripcion: S, cantidad: N, cantidad_texto: S }, required: ['codigo', 'descripcion', 'cantidad', 'cantidad_texto'] } },
    firmado: B, sello_recepcion: S, fecha_recepcion: S, aclaracion_firma: S, recibido_con_reservas: B, notas: S,
    otros_remitos_en_foto: B, dudas: LISTA,
  },
  required: ['es_remito', 'legible', 'problemas_foto', 'repetir_foto', 'motivo_repetir', 'numero_remito', 'fecha', 'pdv_pedido_web', 'pdv_observaciones',
    'cliente', 'cuit_cliente', 'direccion_entrega', 'orden_compra', 'bultos', 'items', 'firmado', 'sello_recepcion', 'fecha_recepcion', 'aclaracion_firma',
    'recibido_con_reservas', 'notas', 'otros_remitos_en_foto', 'dudas'],
};

export const INSTRUCCIONES = `Leés fotos (o PDF) de remitos de entrega de Formas Publicitarias SA, impresos por el sistema Finnegans, después de que el cliente los firmó. Devolvés exactamente lo que está escrito en el remito, sin completar ni adivinar: si un dato de texto no está o no se lee con seguridad, va vacío ("") y lo anotás en "dudas"; si una cantidad no se lee, va -1.

Cómo es el remito: arriba a la izquierda el logo de Formas; en el centro una "R" grande ("No válido como factura"); arriba a la derecha "Remito" con Numero (por ejemplo R-0001-00027857), Fecha y Nro Int. Debajo, los datos del cliente: "Sr. (es)" (la razón social), Domicilio, Cond. IVA y, a la derecha, su C.U.I.T. Después "Dirección de Entrega", "Nº Orden de Compra", "Nº Pedido Web" y "Bultos/Cajas". Luego la tabla de Cantidad y Descripción (la descripción empieza con el código del producto, por ejemplo "SIM10001273 Llavero corto | ..."). Abajo, "Observaciones" (suele decir "pdv 30706") y "Observaciones de Entrega". Encima o al costado puede haber un sello de recepción, una firma, una aclaración y cosas escritas a mano.

Campos:
- numero_remito: el "Numero" de arriba a la derecha, tal cual (no el "Nro Int").
- fecha: la "Fecha" del remito, en formato AAAA-MM-DD.
- pdv_pedido_web: el "Nº Pedido Web", solo dígitos sin ceros a la izquierda ("00030706" es "30706").
- pdv_observaciones: el número de PDV que aparece en "Observaciones" (por ejemplo "pdv 30706" es "30706"), solo dígitos. Si no aparece, "".
- cliente: la razón social de "Sr. (es)". No uses el nombre del sello de quien recibió: a veces recibe otra empresa (una agencia, un depósito).
- cuit_cliente: el C.U.I.T. del cliente, con guiones como está impreso. Nunca el de Formas (33-70995151-9), que es el que emite.
- direccion_entrega, orden_compra, bultos: como están impresos (texto).
- items: un renglón por cada línea de la tabla: codigo (el código con que empieza la descripción, o "" si no tiene), descripcion (el resto, sin el código), cantidad (número de unidades; en estos remitos "1000.00" es mil y "1.000,00" también; -1 si no se lee) y cantidad_texto (la cantidad tal cual está impresa).
- firmado: true si hay firma o sello de recepción.
- sello_recepcion: el nombre de la empresa o persona que dice el sello de recepción. fecha_recepcion: la fecha del sello o la escrita a mano junto a la firma (AAAA-MM-DD). aclaracion_firma: la aclaración escrita a mano, si se lee.
- recibido_con_reservas: true si el sello o algo escrito a mano dice que la mercadería se recibe sin controlar o "a controlar", con faltantes, dañada, o con cualquier otra salvedad. En "notas" transcribí esas leyendas y lo escrito a mano que importe.
- otros_remitos_en_foto: true si en la foto se ve otro remito además del principal (el que está entero y al frente). Leé solo el principal.
- es_remito: false si no es un remito de Formas (una factura, otra cosa, una foto de producto).
- legible y problemas_foto: si los datos clave (número de remito, PDV, cliente, cantidades) se leen bien; en problemas_foto, lo que pasa con la foto ("cortada", "borrosa", "sombra", "reflejo", "lejos", "torcida").
- repetir_foto: true si falta algún dato clave porque la foto no deja leerlo (cortada, borrosa, con reflejo o sombra encima). motivo_repetir: una frase corta para el chofer que la sacó, en castellano rioplatense con "vos", que diga qué falta y cómo sacarla (por ejemplo "El número de PDV quedó cortado. Que se vea el remito entero, de frente."); la app ya le dice que la saque de nuevo. Si no hay que repetirla, "".
- dudas: cada dato que leíste pero del que no estás seguro.`;

// 55 segundos por intento y un reintento: entra en los 120 s que espera la app del chofer.
function cliente(env: Env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeout: 55_000 });
}

export class LecturaFallida extends Error {}

export async function leerConClaude(env: Env, bytes: ArrayBuffer, mime: string): Promise<{ lectura: Lectura; modelo: string; usage: unknown }> {
  const data = aBase64(bytes);
  const archivo: Anthropic.Beta.BetaContentBlockParam = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data } };
  const res = await cliente(env).beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    // Si un control de seguridad rechaza la lectura (no debería pasar con un remito), la repite otro modelo.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA } },
    system: INSTRUCCIONES,
    messages: [{ role: 'user', content: [archivo, { type: 'text', text: 'Leé este remito.' }] }],
  });
  if (res.stop_reason === 'refusal') throw new LecturaFallida('Claude no quiso leer el archivo.');
  if (res.stop_reason === 'max_tokens') throw new LecturaFallida('La lectura quedó cortada.');
  const texto = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  let crudo: Record<string, unknown>;
  try { crudo = JSON.parse(texto) as Record<string, unknown>; } catch { throw new LecturaFallida('La lectura no vino en el formato esperado.'); }
  return { lectura: limpiarLectura(crudo), modelo: res.model, usage: res.usage };
}

// Lo que devuelve Claude, con los vacíos ("" y -1) pasados a null y las listas siempre como listas. Acepta también null
// (lecturas guardadas antes de este formato).
export function limpiarLectura(x: Record<string, unknown>): Lectura {
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
  const cant = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const lista = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []);
  const bultos = txt(x.bultos);
  return {
    es_remito: x.es_remito !== false, legible: x.legible !== false, problemas_foto: lista(x.problemas_foto), repetir_foto: x.repetir_foto === true,
    motivo_repetir: txt(x.motivo_repetir), numero_remito: txt(x.numero_remito), fecha: txt(x.fecha), pdv_pedido_web: txt(x.pdv_pedido_web),
    pdv_observaciones: txt(x.pdv_observaciones), cliente: txt(x.cliente), cuit_cliente: txt(x.cuit_cliente), direccion_entrega: txt(x.direccion_entrega),
    orden_compra: txt(x.orden_compra), bultos: bultos && /\d/.test(bultos) ? Number(bultos.replace(/[^\d]/g, '')) : null,
    items: (Array.isArray(x.items) ? x.items : []).map((it: Record<string, unknown>) => ({
      codigo: txt(it?.codigo), descripcion: txt(it?.descripcion) ?? '', cantidad: cant(it?.cantidad), cantidad_texto: txt(it?.cantidad_texto),
    })).filter((it) => it.descripcion || it.codigo),
    firmado: x.firmado === true, sello_recepcion: txt(x.sello_recepcion), fecha_recepcion: txt(x.fecha_recepcion), aclaracion_firma: txt(x.aclaracion_firma),
    recibido_con_reservas: x.recibido_con_reservas === true, notas: txt(x.notas), otros_remitos_en_foto: x.otros_remitos_en_foto === true, dudas: lista(x.dudas),
  };
}

// ---------- Cruce con los pedidos ----------

interface Pedido { id: number; name: string; props: Record<string, unknown> }
async function pedidosConPdv(db: D1Database, pdv: string): Promise<Pedido[]> {
  const { results } = await db.prepare(`SELECT id, name, props FROM records WHERE object_type = 'order' AND archived = 0
    AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) IN (?, ?, ?, ?) ORDER BY id`)
    .bind(pdv, `PDV - ${pdv}`, `PDV ${pdv}`, pdv.padStart(8, '0')).all<{ id: number; name: string; props: string }>();
  return results.map((r) => ({ ...r, props: JSON.parse(r.props) }));
}
async function pedido(db: D1Database, id: number): Promise<Pedido> {
  const r = await getRow(db, id, 'order');
  return { id: r.id, name: r.name, props: JSON.parse(r.props) };
}
async function empresaDelPedido(db: D1Database, id: number) {
  return db.prepare(`SELECT r.id, r.name, json_extract(r.props, '$.cuit') AS cuit FROM associations a
      JOIN records r ON r.id = CASE WHEN a.from_id = ?1 THEN a.to_id ELSE a.from_id END AND r.archived = 0
    WHERE (a.from_id = ?1 AND a.to_type = 'company') OR (a.to_id = ?1 AND a.from_type = 'company') ORDER BY a.is_primary DESC LIMIT 1`)
    .bind(id).first<{ id: number; name: string; cuit: string | null }>();
}
interface Renglon { code: string | null; name: string; quantity: number | null; detalle?: string | null }
async function renglones(env: Env, p: Pedido, b?: Budget): Promise<Renglon[]> {
  const leer = async () => (await env.DB.prepare(`SELECT li.code, COALESCE(pr.name, li.name, li.description, li.code) AS name, li.quantity, li.description AS detalle
    FROM line_items li LEFT JOIN products pr ON pr.code = li.code WHERE li.record_id = ? ORDER BY li.position`).bind(p.id).all<Renglon>()).results;
  let rs = await leer();
  if (!rs.length && b && b.left() > 6) {
    await orderProducts(env, p.id, p.props, { budget: b }).catch((e) => { if (e instanceof OutOfBudget) throw e; });
    rs = await leer();
  }
  return rs;
}

// Cada renglón del remito con el producto del pedido que le corresponde: por código; si no, por nombre (palabra por
// palabra, sin números ni palabras de relleno: «Matera Engomada (equivale a 90 unidades)» es «Matera Engomada Negra»);
// si los dos tienen un solo producto, ese. Si un renglón se parece igual a varios productos (dos materas de colores),
// va al primero al que todavía le falta, así dos renglones iguales no caen en el mismo producto. Con 3 de 4 palabras
// en común alcanza; «Bolsa Shopper Azul» y «Bolsa Shopper Roja» (2 de 3) no son el mismo producto.
const RELLENO = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'para', 'por', 'una', 'uno', 'unos', 'equivale', 'equivalen', 'unidad',
  'unidades', 'uni', 'und', 'cant', 'cantidad', 'pack', 'caja', 'cajas', 'bulto', 'bultos', 'color', 'talle', 'modelo', 'merchandising']);
const palabras = (s: unknown) => new Set(norm(s).split(' ').filter((w) => w.length >= 3 && !RELLENO.has(w) && !/^\d+$/.test(w)));
function parecido(a: unknown, b: unknown) {
  const A = palabras(a), B = palabras(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
export function emparejar(items: Array<{ code: string | null; description: string | null; quantity?: number | null }>, lineas: Renglon[], ya: number[] = []) {
  const resto = lineas.map((l, i) => (l.quantity == null ? Infinity : Number(l.quantity) - (ya[i] ?? 0)));
  return items.map((it) => {
    const c = normCodigo(it.code);
    const d = norm(it.description);
    // Los candidatos, del más seguro al menos: el mismo código; un código dentro del otro; el nombre.
    let cand: number[] = [];
    if (c) cand = lineas.map((l, i) => (normCodigo(l.code) === c ? i : -1)).filter((i) => i >= 0);
    if (!cand.length && c) cand = lineas.map((l, i) => (normCodigo(l.code) && (c.includes(normCodigo(l.code)) || normCodigo(l.code).includes(c)) ? i : -1)).filter((i) => i >= 0);
    if (!cand.length && d) {
      const puntos = lineas.map((l) => Math.max(parecido(d, l.name), parecido(d, l.detalle)));
      const mejor = Math.max(0, ...puntos);
      if (mejor >= 0.75) cand = puntos.map((p, i) => (p === mejor ? i : -1)).filter((i) => i >= 0);
    }
    if (!cand.length && items.length === 1 && lineas.length === 1) cand = [0];
    if (!cand.length) return -1;
    const i = cand.find((k) => resto[k] > 0) ?? cand[0];
    resto[i] -= Number(it.quantity ?? 0);
    return i;
  });
}

// Cuántos productos de esta foto no están en las otras fotos del mismo número de remito en el pedido (por código o
// descripción). 0: es una foto repetida; más: es otra hoja.
const claveItem = (it: { code: string | null; description: string | null }) => normCodigo(it.code) || norm(it.description);
async function productosNuevos(db: D1Database, pedidoId: number, numero: string, remitoId: number, items: Array<{ code: string | null; description: string | null }>) {
  const { results } = await db.prepare(`SELECT i.code, i.description FROM remito_items i JOIN remitos r ON r.id = i.remito_id
    WHERE r.record_id = ? AND r.numero = ? AND r.id != ? AND r.estado IN ('ok', 'revisar', 'sin_leer') AND r.duplicado_de IS NULL`)
    .bind(pedidoId, numero, remitoId).all<{ code: string | null; description: string | null }>();
  // Por cantidad de renglones de cada producto: dos renglones iguales en esta foto contra uno en las otras es uno nuevo.
  const ya = new Map<string, number>();
  for (const it of results) ya.set(claveItem(it), (ya.get(claveItem(it)) ?? 0) + 1);
  const aca = new Map<string, number>();
  for (const it of items) if (claveItem(it)) aca.set(claveItem(it), (aca.get(claveItem(it)) ?? 0) + 1);
  let nuevos = 0;
  for (const [k, n] of aca) nuevos += Math.max(0, n - (ya.get(k) ?? 0));
  return nuevos;
}

interface Cruce { recordId: number | null; estado: EstadoRemito; motivo: string | null; repetir: boolean; controles: Control[]; candidatos: Candidato[]; duplicadoDe: number | null; pidePdv: boolean }

async function cruzar(env: Env, r: RemitoRow, l: Lectura, b: Budget): Promise<Cruce> {
  const db = env.DB;
  const controles: Control[] = [];
  const add = (dato: string, ok: boolean | null, detalle: string) => { controles.push({ dato, ok, detalle }); };
  const repetir = !!l.repetir_foto;
  const fin = (recordId: number | null, estado: EstadoRemito, motivo: string | null, extra: Partial<Cruce> = {}): Cruce =>
    ({ recordId, estado, motivo, repetir: estado === 'revisar' && repetir, controles, candidatos: [], duplicadoDe: null, pidePdv: false, ...extra });
  // El pedido que eligió una persona: subido en la ficha, adjunto al PDV en ClickUp o confirmado en la revisión. El que
  // puso el CRM a un remito del chofer no cuenta (se vuelve a buscar por el PDV).
  const elegidoPor = r.record_id && (r.origen !== 'chofer' || r.revisado_por) ? r.record_id : null;

  if (!l.es_remito) return fin(elegidoPor, 'revisar', 'No parece un remito de Formas.', { repetir: true });

  // El PDV, que aparece dos veces; y el que escribió el chofer, si lo escribió.
  const leidos = [...new Set([normPdv(l.pdv_pedido_web), normPdv(l.pdv_observaciones)].filter(Boolean) as string[])];
  const delChofer = normPdv(r.pdv_chofer);
  let pdvs = leidos;
  let porChofer = false;          // el PDV lo puso el chofer (no se leía, o no coincidía en el remito)
  let contraLectura: string | null = null;   // el chofer escribió otro que el que dice el remito (bien leído)
  if (delChofer && leidos.includes(delChofer)) {
    pdvs = [delChofer];
    add('PDV', true, leidos.length > 1 ? `PDV ${delChofer}: en el remito no coincidía en los dos lugares y el chofer confirmó este.` : `PDV ${delChofer} (lo confirmó el chofer).`);
  } else if (delChofer) {
    pdvs = [delChofer];
    porChofer = true;
    if (leidos.length === 1) { contraLectura = leidos[0]; add('PDV', null, `El remito dice PDV ${leidos[0]} y el chofer lo corrigió a ${delChofer}.`); }
    else add('PDV', null, `PDV ${delChofer}, escrito por el chofer (en el remito ${leidos.length ? 'no coincidía' : 'no se leía'}).`);
  } else if (leidos.length > 1) add('PDV', false, `El PDV no coincide: «Nº Pedido Web» dice ${normPdv(l.pdv_pedido_web)} y «Observaciones» ${normPdv(l.pdv_observaciones)}.`);
  else if (leidos.length === 1) add('PDV', true, normPdv(l.pdv_pedido_web) && normPdv(l.pdv_observaciones) ? `PDV ${leidos[0]} (en «Nº Pedido Web» y en «Observaciones»).` : `PDV ${leidos[0]}.`);
  else add('PDV', null, 'No se lee el número de PDV.');
  const pdv = pdvs.length === 1 ? pdvs[0] : null;

  const numero = normNumero(l.numero_remito);
  if (!numero) add('Número de remito', null, 'No se lee el número de remito.');

  // CUIT: el dígito verificador dice si se leyó bien.
  const cuitLeido = l.cuit_cliente ? cuitValido(l.cuit_cliente) : null;
  if (l.cuit_cliente && !cuitLeido) add('CUIT', false, `El CUIT leído (${l.cuit_cliente}) no es válido: puede estar mal leído.`);
  const cuit = cuitLeido && !CUIT_FORMAS.includes(cuitLeido) ? cuitLeido : null;

  if (!pdv && !numero && !l.items.length) return fin(elegidoPor, 'revisar', l.motivo_repetir || 'No se leen los datos del remito.', { repetir: true, pidePdv: true });

  // A qué pedido va: el que eligió una persona (subido en la ficha o adjunto en ClickUp) o el del PDV.
  let p: Pedido | null = null;
  let candidatos: Candidato[] = [];
  const cand = (x: Pedido): Candidato => ({ id: x.id, nombre: x.name, pdv: normPdv(x.props.pdv_finnegans) });
  if (elegidoPor) {
    p = await pedido(db, elegidoPor);
    const suyo = normPdv(p.props.pdv_finnegans);
    if (pdv && suyo && pdv !== suyo) {
      const otros = await pedidosConPdv(db, pdv);
      add('Pedido', false, `El remito dice PDV ${pdv} y está en el pedido del PDV ${suyo}.`);
      return fin(elegidoPor, 'revisar', `El remito es del PDV ${pdv}, no del ${suyo}.`, { candidatos: [cand(p), ...otros.map(cand)] });
    }
    if (pdv && suyo) add('Pedido', true, `Coincide con el pedido (PDV ${suyo}).`);
  } else if (pdv) {
    const ps = (await pedidosConPdv(db, pdv)).filter((x) => x.props.hs_pipeline_stage !== ANULADO);
    candidatos = ps.map(cand);
    if (ps.length === 1) { p = ps[0]; add('Pedido', true, `El PDV ${pdv} es del pedido «${p.name}».`); }
    else if (!ps.length) { add('Pedido', false, `No hay ningún pedido con el PDV ${pdv}.`); return fin(null, 'revisar', `No hay ningún pedido con el PDV ${pdv}${porChofer ? ' (el que escribió el chofer)' : ''}.`, { pidePdv: true }); }
    else { add('Pedido', null, `Hay ${ps.length} pedidos con el PDV ${pdv}.`); return fin(null, 'revisar', `Hay ${ps.length} pedidos con el PDV ${pdv}: elegí cuál.`, { candidatos }); }
  } else if (pdvs.length > 1) {
    // El PDV dice una cosa en «Nº Pedido Web» y otra en «Observaciones»: no se adivina; los dos pedidos, para elegir.
    for (const n of pdvs) candidatos.push(...(await pedidosConPdv(db, n)).filter((x) => x.props.hs_pipeline_stage !== ANULADO).map(cand));
    return fin(null, 'revisar', `El PDV no coincide en los dos lugares del remito (${pdvs.join(' y ')}): elegí el pedido.`, { candidatos, pidePdv: true });
  } else {
    // Sin PDV no se adjunta solo: se buscan los pedidos posibles por el CUIT para que alguien elija.
    if (cuit) {
      const { results } = await db.prepare(`SELECT o.id, o.name, o.props FROM records c
          JOIN associations a ON (a.from_id = c.id AND a.to_type = 'order') OR (a.to_id = c.id AND a.from_type = 'order')
          JOIN records o ON o.id = CASE WHEN a.from_id = c.id THEN a.to_id ELSE a.from_id END AND o.object_type = 'order' AND o.archived = 0
        WHERE c.object_type = 'company' AND c.archived = 0 AND REPLACE(json_extract(c.props, '$.cuit'), '-', '') = ? ORDER BY o.created_at DESC LIMIT 5`)
        .bind(cuit).all<{ id: number; name: string; props: string }>();
      candidatos = results.map((x) => cand({ ...x, props: JSON.parse(x.props) }));
    }
    // Otra foto sirve si la foto no deja leerlo; si el remito no lo dice, no.
    const otraFoto = !!l.repetir_foto || !l.legible;
    return fin(null, 'revisar', otraFoto ? (l.motivo_repetir || 'No se lee el PDV.') : 'El remito no dice el PDV: elegí el pedido.', { candidatos, repetir: otraFoto, pidePdv: true });
  }

  // El pedido elegido: lo que lo confirma y lo que lo contradice.
  let fuerte = false;
  let enFinnegans = false;   // Finnegans tiene este número de remito en este pedido
  let contra: string | null = null;
  const emp = await empresaDelPedido(db, p.id);
  let cuitPedido = cuitValido(emp?.cuit);
  const pedidoFin = typeof p.props.pedido_finnegans === 'string' && /PEDVTA/i.test(p.props.pedido_finnegans) ? p.props.pedido_finnegans : null;
  let token: string | null = null;
  const fin_ = async () => (token ??= (env.FINNEGANS_CLIENT_ID && pedidoFin && b.left() > 3 ? await finnegansToken(env, b).catch(() => null) : null));
  if (cuit && !cuitPedido && await fin_()) {
    const cf = await finnegansPedido(env, token!, pedidoFin!, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
    cuitPedido = cuitValido(cf?.cuit);
  }
  if (cuit && cuitPedido) {
    if (cuit === cuitPedido) { fuerte = true; add('CUIT', true, `El CUIT ${fmtCuit(cuit)} es el del cliente del pedido.`); }
    else { contra = `El CUIT del remito (${fmtCuit(cuit)}) no es el del cliente del pedido (${fmtCuit(cuitPedido)}).`; add('CUIT', false, contra); }
  } else if (cuit) add('CUIT', null, `CUIT ${fmtCuit(cuit)}: el pedido no tiene CUIT para comparar.`);

  // El número de remito en Finnegans.
  if (numero && await fin_()) {
    const rems = await finnegansRemitos(env, token!, pedidoFin!, b).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
    if (rems?.some((x) => x.numeros.includes(numeroDe(numero)!))) { fuerte = true; enFinnegans = true; add('Remito en Finnegans', true, `Finnegans tiene el remito ${numero} en el pedido ${pedidoFin}.`); }
    else if (rems?.length) add('Remito en Finnegans', null, `Finnegans no muestra el remito ${numero} en el pedido ${pedidoFin} (tiene ${rems.length}).`);
  }

  // El cliente, por el nombre (solo informa).
  if (l.cliente && emp?.name) {
    const a = razon(l.cliente), e = razon(emp.name);
    add('Cliente', a && e && (a.includes(e) || e.includes(a)) ? true : null, `Remito: ${l.cliente} · Pedido: ${emp.name}.`);
  }

  // Los productos.
  const lineas = await renglones(env, p, b);
  const items = l.items.map((it) => ({ code: it.codigo, description: it.descripcion }));
  if (lineas.length && items.length) {
    const pares = emparejar(items, lineas);
    const fuera = pares.filter((i) => i < 0).length;
    if (fuera === items.length) { contra ??= 'Ningún producto del remito es de este pedido.'; add('Productos', false, contra); }
    else add('Productos', fuera ? null : true, fuera ? `${fuera} de ${items.length} productos no están en el pedido.` : 'Los productos son del pedido.');
  }

  // El mismo remito ya estaba (otra foto, o por la app y por ClickUp). Si trae productos que las otras fotos de ese
  // número no tienen, es otra hoja del mismo remito (los remitos largos tienen varias) y suma; si no, es repetido.
  if (numero) {
    const otro = await db.prepare(`SELECT id, record_id FROM remitos WHERE numero = ? AND id != ? AND estado IN ('ok', 'revisar', 'sin_leer')
      AND duplicado_de IS NULL ORDER BY (record_id = ?) DESC, id LIMIT 1`).bind(numero, r.id, p.id).first<{ id: number; record_id: number | null }>();
    if (otro && otro.record_id === p.id) {
      const nuevos = await productosNuevos(db, p.id, numero, r.id, items);
      if (!nuevos) return fin(p.id, 'duplicado', `Es el mismo remito ${numero} que ya estaba.`, { duplicadoDe: otro.id });
      add('Hoja', true, `Otra hoja del remito ${numero}: suma ${nuevos} producto${nuevos > 1 ? 's' : ''} que las otras fotos no tienen.`);
    }
    else if (otro && otro.record_id) { contra ??= `El remito ${numero} ya está en otro pedido.`; add('Duplicado', false, contra); }
    // El mismo remito está para revisar sin pedido: este también, así no se cuenta dos veces cuando se resuelvan.
    else if (otro && !otro.record_id) { contra ??= `El mismo remito ${numero} ya está para revisar.`; add('Duplicado', null, contra); }
  }

  // Elegido por una persona: alcanza con que el PDV coincida (o, sin PDV, el CUIT). Desde la app: PDV y otro dato fuerte.
  // Si el chofer corrigió un PDV que el remito dice bien en los dos lugares, solo vale si Finnegans tiene el remito en el
  // pedido que dice el chofer; si no, lo revisa Logística (puede haberse equivocado al escribirlo).
  const elegido = !!elegidoPor;
  // Si el chofer corrigió el PDV, el pedido del PDV que dice el remito también es posible.
  if (contraLectura) for (const x of await pedidosConPdv(db, contraLectura)) if (!candidatos.some((y) => y.id === x.id)) candidatos.push(cand(x));
  if (contra) return fin(p.id, 'revisar', contra, { candidatos });
  if (pdvs.length > 1) return fin(p.id, 'revisar', 'El PDV no coincide en los dos lugares del remito.', { candidatos });
  if (contraLectura && !enFinnegans) {
    return fin(null, 'revisar', `El chofer corrigió el PDV: el remito dice ${contraLectura} y él escribió ${pdv}. Elegí el pedido.`, { candidatos });
  }
  if (elegido ? (pdv || fuerte) : (pdv && fuerte)) return fin(p.id, 'ok', null, { candidatos });
  return fin(elegido ? p.id : null, 'revisar', elegido ? 'No se pudo confirmar que el remito sea de este pedido (no se lee el PDV ni el CUIT).'
    : `El PDV${porChofer ? ' que escribió el chofer' : ''} lleva a un pedido, pero ningún otro dato lo confirma (CUIT o remito en Finnegans).`, { candidatos: candidatos.length ? candidatos : [cand(p)] });
}

// ---------- Leer un remito ----------

// Lee y cruza un remito; deja todo guardado y recalcula la entrega del pedido. Si no se puede (falta la clave, el archivo
// no está, Claude falló), queda «sin leer» con el motivo, para reintentar.
export async function leerRemito(env: Env, id: number, opts: { budget?: Budget; ctx?: Ctx | null } = {}) {
  const db = env.DB;
  const b = opts.budget ?? Budget.of(env);
  const r = await remitoPorId(db, id);
  if (r.estado === 'descartado') return r;
  const error = async (motivo: string, estado: EstadoRemito = 'sin_leer') => {
    await db.prepare('UPDATE remitos SET estado = ?, motivo = ?, intentos = intentos + 1, updated_at = ? WHERE id = ?').bind(estado, motivo, now(), id).run();
    return remitoPorId(db, id);
  };
  if (!env.ANTHROPIC_API_KEY) return error('Falta conectar la API de Claude (ANTHROPIC_API_KEY): se lee cuando esté.');
  if (r.file_id) { b.take(); b.take(); }   // ClickUp: la tarea y el archivo
  const a = await archivoDeRemito(env, id).catch((e) => { if (e instanceof OutOfBudget) throw e; return null; });
  if (!a) return error('No se pudo traer el archivo (de ClickUp).');
  const mime = a.mime.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (/heic|heif/.test(mime)) return error('La foto está en HEIC y no se puede leer: subila como JPG.', 'revisar');
  if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(mime)) return error(`El archivo (${mime}) no es una foto ni un PDF.`, 'revisar');
  if (a.bytes.byteLength > (mime === 'application/pdf' ? MAX_PDF : MAX_IMAGEN)) return error('El archivo es muy pesado para leerlo: subilo más chico.', 'revisar');
  b.take();
  let leida: Awaited<ReturnType<typeof leerConClaude>>;
  try { leida = await leerConClaude(env, a.bytes, mime); } catch (e) {
    if (e instanceof LecturaFallida) return error(e.message, 'revisar');
    console.error('remito', id, (e as Error).message);
    // El error de la API, legible (sin el JSON crudo): se vuelve a intentar solo en la próxima corrida.
    const m = (e as Error).message;
    const detalle = m.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? m;
    const status = (e as { status?: number }).status;
    return error(`No se pudo leer: la API de Claude contestó ${status ? `con error ${status}` : 'con un error'} (${detalle.slice(0, 160)}). Se vuelve a intentar solo.`);
  }
  return aplicarLectura(env, r, { ...leida.lectura, _modelo: leida.modelo }, b, opts.ctx ?? null, true);
}

// Cruza lo leído con los pedidos y lo deja guardado: el pedido, el estado, los controles, los renglones; después recalcula
// la entrega de los pedidos que cambiaron. Sirve también para volver a cruzar sin volver a leer (el chofer corrigió el PDV).
async function aplicarLectura(env: Env, r: RemitoRow, l: Lectura & { _modelo?: string }, b: Budget, ctx: Ctx | null, leida: boolean) {
  const db = env.DB;
  const id = r.id;
  const c = await cruzar(env, r, l, b);
  const items = l.items.filter((it) => it.descripcion || it.codigo);
  const ts = now();
  await db.batch([
    db.prepare(`UPDATE remitos SET record_id = ?, estado = ?, motivo = ?, repetir = ?, numero = ?, pdv = ?, cuit = ?, cliente = ?, fecha = ?,
        recibido_por = ?, recibido_el = ?, firmado = ?, reservas = ?, notas = ?, lectura = ?, controles = ?, candidatos = ?, duplicado_de = ?,
        pide_pdv = ?, intentos = intentos + ?, leido_at = ?, updated_at = ? WHERE id = ?`)
      .bind(c.recordId, c.estado, c.motivo, c.repetir ? 1 : 0, normNumero(l.numero_remito), normPdv(r.pdv_chofer) ?? normPdv(l.pdv_pedido_web) ?? normPdv(l.pdv_observaciones),
        cuitValido(l.cuit_cliente) ? fmtCuit(cuitValido(l.cuit_cliente)!) : l.cuit_cliente, l.cliente, /^\d{4}-\d{2}-\d{2}$/.test(l.fecha ?? '') ? l.fecha : null,
        [l.sello_recepcion, l.aclaracion_firma].filter(Boolean).join(' · ') || null, /^\d{4}-\d{2}-\d{2}$/.test(l.fecha_recepcion ?? '') ? l.fecha_recepcion : null,
        l.firmado ? 1 : 0, l.recibido_con_reservas ? 1 : 0, l.notas, JSON.stringify(l), JSON.stringify(c.controles),
        JSON.stringify(c.candidatos), c.duplicadoDe, c.estado === 'revisar' && c.pidePdv ? 1 : 0, leida ? 1 : 0, leida ? ts : r.leido_at, ts, id),
    db.prepare('DELETE FROM remito_items WHERE remito_id = ?').bind(id),
    ...items.map((it, i) => db.prepare('INSERT INTO remito_items (remito_id, position, code, description, quantity) VALUES (?, ?, ?, ?, ?)')
      .bind(id, i, it.codigo, it.descripcion, it.cantidad)),
  ]);
  const pedidos = [...new Set([r.record_id, c.recordId].filter(Boolean) as number[])];
  const reciente = Date.now() - Date.parse(r.created_at) < AVISO_DIAS * 86_400_000;
  for (const pid of pedidos) await recalcularEntrega(env, pid, { ctx, avisar: reciente });
  return remitoPorId(db, id);
}

// El chofer escribe el PDV: porque no se leía, porque no coincidía en el remito o porque ve que se leyó mal. Se vuelve a
// cruzar con lo ya leído (sin otra lectura) y vale como el leído: tiene que cerrar con el CUIT o el remito en Finnegans,
// y si contradice un PDV bien leído, solo con el remito en Finnegans; si no, lo revisa Logística. Solo sus remitos.
export async function corregirPdv(env: Env, ctx: Ctx, id: number, valor: unknown) {
  const db = env.DB;
  const r = await db.prepare(`SELECT ${SIN_DATA} FROM remitos WHERE id = ? AND token_id = ?`).bind(id, ctx.tokenId ?? -1).first<RemitoRow>();
  if (!r) throw new HttpError(404, 'No existe ese remito.');
  if (r.estado === 'descartado' || r.estado === 'duplicado') throw new HttpError(409, r.estado === 'duplicado' ? 'Ese remito ya estaba mandado.' : 'Logística descartó ese remito.');
  const pdv = normPdv(valor);
  if (!pdv) throw new HttpError(400, 'Escribí el número de PDV, solo con números.');
  if (pdv.length > 7) throw new HttpError(400, 'Ese número es muy largo para un PDV. Fijate en el remito y escribilo de nuevo.');
  await db.prepare('UPDATE remitos SET pdv_chofer = ?, updated_at = ? WHERE id = ?').bind(pdv, now(), id).run();
  const nuevo = { ...r, pdv_chofer: pdv };
  if (!r.leido_at) return env.ANTHROPIC_API_KEY ? leerRemito(env, id, { ctx }) : remitoPorId(db, id);
  let l: Lectura;
  try { l = limpiarLectura(JSON.parse(r.lectura) as Record<string, unknown>); } catch { return leerRemito(env, id, { ctx }); }
  return aplicarLectura(env, nuevo, l, Budget.of(env), ctx, false);
}

// De fondo (cron): los remitos sin leer. Primero los del chofer y del CRM; los de ClickUp, si son de los últimos 60 días
// (los más viejos se leen al abrir el pedido). Cada uno se intenta hasta 3 veces.
export async function leerPendientes(env: Env, b: Budget = Budget.of(env), limit = 4) {
  if (!env.ANTHROPIC_API_KEY) return { leidos: 0, skipped: 'Falta ANTHROPIC_API_KEY.' };
  const desde = new Date(Date.now() - LEER_CLICKUP_DIAS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(`SELECT id FROM remitos WHERE estado = 'sin_leer' AND intentos < 3
      AND (origen != 'clickup' OR created_at >= ?) ORDER BY origen = 'clickup', intentos, created_at DESC LIMIT ?`).bind(desde, limit).all<{ id: number }>();
  let leidos = 0;
  for (const r of results) {
    if (b.left() < 12) break;
    try { await leerRemito(env, r.id, { budget: b }); leidos++; } catch (e) {
      if (e instanceof OutOfBudget) break;
      console.error('remito', r.id, (e as Error).message);
    }
  }
  return { leidos };
}

// ---------- Estado de entrega del pedido ----------

export type EstadoEntrega = 'completa' | 'parcial' | 'diferencias' | 'cerrada_con_faltante' | 'falta_remito' | 'por_revisar';
export const ETIQUETA_ENTREGA: Record<EstadoEntrega, string> = {
  completa: 'Completa', parcial: 'Faltan entregas', diferencias: 'Con diferencias', cerrada_con_faltante: 'Finalizada con faltante',
  falta_remito: 'Falta el remito', por_revisar: 'Remito por revisar',
};
export interface LineaEntrega { code: string | null; name: string; vendido: number | null; entregado: number; falta: number; excede: number }
// Un renglón de remito: clave es cuál es (la que usa la asignación a mano).
interface ItemEntrega { clave: string; code: string | null; description: string | null; quantity: number | null; remito_id: number; numero: string | null }
// Un renglón asignado a mano a uno o más productos del pedido (i: la posición del producto en `lineas`).
export interface Asignado extends ItemEntrega { a: Array<{ i: number; name: string; cantidad: number }>; por: number | null; el: string }
export interface Entrega {
  estado: EstadoEntrega | null; lineas: LineaEntrega[];
  // extras: lo de los remitos que no es de ningún producto del pedido (o lo que quedó sin asignar de un renglón asignado).
  extras: Array<ItemEntrega & { sin_asignar?: boolean }>;
  asignados: Asignado[];
  remitos_ok: number; pendientes: number; reservas: number; sin_productos: boolean;
  clickup_entregado: boolean; alerta: string | null; falta_texto: string | null;
  cerrada: { el: string; por: number | null; motivo: string | null } | null;
}
const qty = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

export async function calcularEntrega(db: D1Database, orderId: number): Promise<Entrega> {
  const row = await getRow(db, orderId, 'order');
  const props = JSON.parse(row.props) as Record<string, unknown>;
  const [lin, its, cuenta, asig] = await db.batch([
    db.prepare(`SELECT li.code, COALESCE(pr.name, li.name, li.description, li.code, 'Producto') AS name, li.quantity, li.description AS detalle
      FROM line_items li LEFT JOIN products pr ON pr.code = li.code WHERE li.record_id = ? ORDER BY li.position`).bind(orderId),
    db.prepare(`SELECT i.code, i.description, i.quantity, i.position, r.id AS remito_id, r.numero FROM remito_items i JOIN remitos r ON r.id = i.remito_id
      WHERE r.record_id = ? AND r.estado = 'ok' AND r.duplicado_de IS NULL ORDER BY r.id, i.position`).bind(orderId),
    db.prepare(`SELECT SUM(estado = 'ok' AND duplicado_de IS NULL) AS ok, SUM(estado IN ('sin_leer', 'revisar')) AS pendientes,
      SUM(estado = 'ok' AND duplicado_de IS NULL AND reservas = 1) AS reservas FROM remitos WHERE record_id = ?`).bind(orderId),
    db.prepare('SELECT clave, lineas, user_id, created_at FROM remito_asignaciones WHERE record_id = ?').bind(orderId),
  ]);
  const lineas = (lin.results as Renglon[]);
  // Cada producto de un mismo número de remito cuenta una vez (con la cantidad más alta de sus fotos): las hojas
  // distintas suman y una foto repetida no.
  // Dos renglones iguales en la misma foto (dos materas sin código) son dos: la clave lleva cuál de ellos es.
  // La clave (número de remito, producto y cuál de los iguales) es también la de la asignación a mano: sigue valiendo si
  // el remito se vuelve a leer o llega otra foto del mismo número.
  const porClave = new Map<string, ItemEntrega>();
  const vez = new Map<string, number>();
  for (const { position, ...it } of its.results as Array<Omit<ItemEntrega, 'clave'> & { position: number }>) {
    const enFoto = `${it.remito_id}|${claveItem(it)}`;
    vez.set(enFoto, (vez.get(enFoto) ?? 0) + 1);
    const k = it.numero && claveItem(it) ? `${it.numero}|${claveItem(it)}|${vez.get(enFoto)}` : `r${it.remito_id}|p${position}`;
    const ya = porClave.get(k);
    if (!ya || Number(it.quantity ?? 0) > Number(ya.quantity ?? 0)) porClave.set(k, { clave: k, ...it });
  }
  const items = [...porClave.values()];
  const c = (cuenta.results[0] ?? {}) as { ok: number | null; pendientes: number | null; reservas: number | null };
  const stage = String(props.hs_pipeline_stage ?? '');
  const clickupEntregado = stage === ENTREGADO || stage === PARCIAL;
  const cerrada = props.entrega_cerrada_el ? { el: String(props.entrega_cerrada_el), por: props.entrega_cerrada_por == null ? null : Number(props.entrega_cerrada_por), motivo: (props.entrega_cerrada_motivo as string) ?? null } : null;
  const out: Entrega = { estado: null, lineas: [], extras: [], asignados: [], remitos_ok: Number(c.ok ?? 0), pendientes: Number(c.pendientes ?? 0), reservas: Number(c.reservas ?? 0),
    sin_productos: !lineas.length, clickup_entregado: clickupEntregado, alerta: null, falta_texto: null, cerrada };
  if (stage === ANULADO) return out;
  const entregado = lineas.map(() => 0);
  // Primero lo asignado a mano (a qué producto va cada renglón que no se reconoció, y cuánto); lo demás se empareja solo.
  // Si el producto ya no está en el pedido, la asignación no vale y el renglón vuelve a emparejarse solo.
  const asignaciones = new Map((asig.results as Array<{ clave: string; lineas: string; user_id: number | null; created_at: string }>).map((a) => [a.clave, a]));
  const libres: ItemEntrega[] = [];
  for (const it of items) {
    const a = asignaciones.get(it.clave);
    const destinos = a ? destinosDe(a.lineas, lineas) : null;
    if (!a || !destinos) { libres.push(it); continue; }
    for (const d of destinos) entregado[d.i] += d.cantidad;
    out.asignados.push({ ...it, a: destinos.map((d) => ({ ...d, name: lineas[d.i].name })), por: a.user_id, el: a.created_at });
    const sobra = it.quantity == null ? 0 : Number(it.quantity) - destinos.reduce((n, d) => n + d.cantidad, 0);
    if (sobra > 1e-9) out.extras.push({ ...it, quantity: sobra, sin_asignar: true });
  }
  const pares = emparejar(libres, lineas, entregado);
  libres.forEach((it, k) => { if (pares[k] >= 0) entregado[pares[k]] += Number(it.quantity ?? 0); else out.extras.push(it); });
  out.lineas = lineas.map((l, i) => {
    const vendido = l.quantity == null ? null : Number(l.quantity);
    return { code: l.code, name: l.name, vendido, entregado: entregado[i], falta: vendido == null ? 0 : Math.max(0, vendido - entregado[i]), excede: vendido == null ? 0 : Math.max(0, entregado[i] - vendido) };
  });
  const faltan = out.lineas.filter((l) => l.falta > 0);
  out.falta_texto = faltan.length ? faltan.map((l) => `${qty(l.falta)} ${l.name}`).join(' · ') : null;
  const diferencias = out.extras.length > 0 || out.lineas.some((l) => l.excede > 0);
  if (!out.remitos_ok) out.estado = out.pendientes ? 'por_revisar' : clickupEntregado ? 'falta_remito' : null;
  else if (!lineas.length) out.estado = 'por_revisar';
  else if (diferencias) out.estado = 'diferencias';
  else if (faltan.length) out.estado = cerrada ? 'cerrada_con_faltante' : 'parcial';
  else out.estado = 'completa';
  if (stage === ENTREGADO && faltan.length && out.remitos_ok && !cerrada) out.alerta = `ClickUp dice «Entregado», pero según los remitos falta: ${out.falta_texto}.`;
  else if (out.estado === 'falta_remito') out.alerta = 'ClickUp dice que se entregó, pero el pedido no tiene ningún remito leído.';
  return out;
}

// Los productos del pedido de una asignación a mano: por su posición si sigue siendo el mismo producto; si no (el pedido se
// volvió a leer de Finnegans y cambió el orden), por código o por nombre. null si alguno ya no está.
function destinosDe(json: string, lineas: Renglon[]): Array<{ i: number; cantidad: number }> | null {
  let ds: Array<{ i?: number; code?: string | null; name?: string | null; cantidad?: number }>;
  try { ds = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(ds) || !ds.length) return null;
  const mismo = (l: Renglon | undefined, d: { code?: string | null; name?: string | null }) =>
    !!l && (d.code ? normCodigo(l.code) === normCodigo(d.code) : norm(l.name) === norm(d.name));
  const out = ds.map((d) => ({
    i: mismo(lineas[Number(d.i)], d) ? Number(d.i) : lineas.findIndex((l) => mismo(l, d)),
    cantidad: Number(d.cantidad),
  }));
  return out.every((d) => d.i >= 0 && Number.isFinite(d.cantidad) && d.cantidad > 0) ? out : null;
}

// Asignar a mano un renglón de los remitos a uno o más productos del pedido, con la cantidad de cada uno (lo que el
// remito dice con otro nombre: «70 Jarro Bossa Waterdog» es el «Producción simple drinkware genérico» del pedido). La
// suma no puede pasar lo que dice el remito; lo que no se asigne sigue como «en los remitos pero no en el pedido».
// Sin productos, deshace la asignación.
export async function asignarRenglon(env: Env, ctx: Ctx, orderId: number, clave: string, destinos: Array<{ i: number; cantidad: number }>) {
  const db = env.DB;
  const e = await calcularEntrega(db, orderId);
  const it = e.asignados.find((x) => x.clave === clave) ?? e.extras.find((x) => x.clave === clave);
  if (!it) throw new HttpError(400, 'Ese renglón ya no está en los remitos del pedido. Recargá la página.');
  if (!destinos.length) {
    await db.prepare('DELETE FROM remito_asignaciones WHERE record_id = ? AND clave = ?').bind(orderId, clave).run();
    return recalcularEntrega(env, orderId, { ctx });
  }
  const vistos = new Set<number>();
  const lineas = destinos.map((d) => {
    const i = Number(d.i);
    const l = e.lineas[i];
    const cantidad = Number(d.cantidad);
    if (!l || vistos.has(i)) throw new HttpError(400, 'Elegí productos del pedido (cada uno una vez).');
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new HttpError(400, `Poné cuántos van a «${l.name}».`);
    vistos.add(i);
    return { i, code: l.code, name: l.name, cantidad };
  });
  const total = lineas.reduce((n, l) => n + l.cantidad, 0);
  if (it.quantity != null && total > Number(it.quantity) + 1e-9) {
    throw new HttpError(400, `Asignaste ${qty(total)} y el remito dice ${qty(Number(it.quantity))} de «${it.description ?? it.code ?? 'ese renglón'}».`);
  }
  await db.prepare(`INSERT INTO remito_asignaciones (record_id, clave, descripcion, lineas, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (record_id, clave) DO UPDATE SET descripcion = excluded.descripcion, lineas = excluded.lineas, user_id = excluded.user_id, created_at = excluded.created_at`)
    .bind(orderId, clave, it.description ?? it.code ?? null, JSON.stringify(lineas), ctx.user.id, now()).run();
  return recalcularEntrega(env, orderId, { ctx });
}

// Guarda el estado de entrega en el pedido (para filtros, tablas y tarjetas), con su historial y sin tocar la fecha de
// modificación (así el tablero no se reordena). Si el pedido pasa a «Faltan entregas» o «Con diferencias» por un remito
// nuevo, les avisa por mail a Logística y a los administradores.
export async function recalcularEntrega(env: Env, orderId: number, opts: { ctx?: Ctx | null; avisar?: boolean } = {}) {
  const db = env.DB;
  const e = await calcularEntrega(db, orderId);
  const row = await getRow(db, orderId, 'order');
  const props = JSON.parse(row.props) as Record<string, unknown>;
  const nuevo: Record<string, unknown> = { estado_entrega: e.estado, falta_entregar: e.falta_texto };
  const cambios = Object.keys(nuevo).filter((k) => String(props[k] ?? '') !== String(nuevo[k] ?? ''));
  if (!cambios.length) return e;
  const next = { ...props, ...nuevo };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  const ts = now();
  await db.batch([
    db.prepare('UPDATE records SET props = ? WHERE id = ?').bind(JSON.stringify(next), orderId),
    ...cambios.map((k) => db.prepare("INSERT INTO changes (record_id, prop, old_value, new_value, changed_at, user_id, source) VALUES (?, ?, ?, ?, ?, ?, 'remitos')")
      .bind(orderId, k, props[k] == null ? null : String(props[k]), nuevo[k] == null ? null : String(nuevo[k]), ts, opts.ctx?.user.id ?? null)),
  ]);
  if (opts.avisar && cambios.includes('estado_entrega') && (e.estado === 'parcial' || e.estado === 'diferencias')) await avisarLogistica(db, orderId, opts.ctx ?? null);
  return e;
}

async function avisarLogistica(db: D1Database, orderId: number, ctx: Ctx | null) {
  // A Logística y a los administradores (que ven todo).
  const { results } = await db.prepare("SELECT id FROM users WHERE active = 1 AND (profile = 'logistica' OR role = 'admin')").all<{ id: number }>();
  const stmts = results.map((u) => db.prepare(`INSERT INTO avisos (user_id, kind, record_id, by_user)
    SELECT ?, 'entrega', ?, ? WHERE NOT EXISTS (SELECT 1 FROM avisos WHERE user_id = ? AND kind = 'entrega' AND record_id = ? AND sent_at IS NULL)`)
    .bind(u.id, orderId, ctx?.user.id ?? null, u.id, orderId));
  if (stmts.length) await db.batch(stmts);
}

// Logística (o un administrador) finaliza la entrega aceptando lo que falta, con el motivo; o la vuelve a abrir.
export function puedeFinalizar(ctx: Ctx) {
  return ctx.user.role === 'admin' || ctx.user.profile === 'logistica';
}
export async function finalizarEntrega(env: Env, ctx: Ctx, orderId: number, motivo: string | null) {
  if (!puedeFinalizar(ctx)) throw new HttpError(403, 'Solo Logística o un administrador pueden finalizar una entrega con faltante.');
  if (motivo === null) {
    await updateRecord(env.DB, ctx, 'order', orderId, { entrega_cerrada_el: null, entrega_cerrada_por: null, entrega_cerrada_motivo: null }, { system: true });
  } else {
    const m = motivo.trim();
    if (m.length < 3) throw new HttpError(400, 'Escribí el motivo del faltante.');
    const e = await calcularEntrega(env.DB, orderId);
    if (!e.lineas.some((l) => l.falta > 0)) throw new HttpError(400, 'A este pedido no le falta nada según los remitos.');
    await updateRecord(env.DB, ctx, 'order', orderId, { entrega_cerrada_el: now(), entrega_cerrada_por: ctx.user.id, entrega_cerrada_motivo: m.slice(0, 500) }, { system: true });
  }
  return recalcularEntrega(env, orderId, { ctx });
}

// ---------- Revisión (Logística) ----------

export async function revisarRemito(env: Env, ctx: Ctx, id: number, body: { accion: 'asignar' | 'confirmar' | 'descartar' | 'releer'; pedido?: number | null; motivo?: string | null }) {
  const db = env.DB;
  const r = await remitoPorId(db, id);
  const antes = r.record_id;
  const ts = now();
  if (body.accion === 'releer') {
    await db.prepare("UPDATE remitos SET estado = 'sin_leer', intentos = 0, duplicado_de = NULL, updated_at = ? WHERE id = ?").bind(ts, id).run();
    return leerRemito(env, id, { ctx });
  }
  if (body.accion === 'descartar') {
    await db.prepare("UPDATE remitos SET estado = 'descartado', motivo = ?, revisado_por = ?, revisado_at = ?, updated_at = ? WHERE id = ?")
      .bind(body.motivo?.trim() || 'Descartado en la revisión.', ctx.user.id, ts, ts, id).run();
  } else {
    const pid = body.pedido ? Number(body.pedido) : r.record_id;
    if (!pid) throw new HttpError(400, 'Elegí el pedido del remito.');
    await getRow(db, pid, 'order');
    // Asignar a un pedido lo deja en ese pedido; confirmar además lo da por bueno (cuenta para la entrega). Si el pedido ya
    // tiene ese mismo número de remito contado, este queda como repetido (no se cuenta dos veces).
    const igual = r.numero ? await db.prepare("SELECT id FROM remitos WHERE record_id = ? AND numero = ? AND estado = 'ok' AND id != ? AND duplicado_de IS NULL LIMIT 1")
      .bind(pid, r.numero, id).first<{ id: number }>() : null;
    const itemsR = (await itemsDe(db, [id])).get(id) ?? [];
    if (igual && body.accion === 'confirmar' && !(await productosNuevos(db, pid, r.numero!, id, itemsR))) {
      await db.prepare("UPDATE remitos SET record_id = ?, estado = 'duplicado', duplicado_de = ?, motivo = ?, revisado_por = ?, revisado_at = ?, updated_at = ? WHERE id = ?")
        .bind(pid, igual.id, `Es el mismo remito ${r.numero} que ya estaba en el pedido.`, ctx.user.id, ts, ts, id).run();
      for (const x of new Set([antes, pid].filter(Boolean) as number[])) await recalcularEntrega(env, x, { ctx });
      return remitoPorId(db, id);
    }
    const estado = body.accion === 'confirmar' || r.estado === 'ok' ? 'ok' : 'revisar';
    await db.prepare(`UPDATE remitos SET record_id = ?, estado = ?, motivo = CASE WHEN ? = 'ok' THEN NULL ELSE ? END, repetir = 0, duplicado_de = NULL,
        revisado_por = ?, revisado_at = ?, updated_at = ? WHERE id = ?`)
      .bind(pid, estado, estado, body.accion === 'asignar' ? 'Asignado a mano: falta confirmarlo.' : r.motivo, ctx.user.id, ts, ts, id).run();
  }
  const despues = (await remitoPorId(db, id)).record_id;
  for (const pid of new Set([antes, despues].filter(Boolean) as number[])) await recalcularEntrega(env, pid, { ctx, avisar: true });
  return remitoPorId(db, id);
}

// ---------- Para las pantallas ----------

export function remitoPublico(r: RemitoRow, items: Array<{ code: string | null; description: string | null; quantity: number | null }> = []) {
  const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
  return {
    id: r.id, record_id: r.record_id, origen: r.origen, nombre: r.nombre, mime: r.mime, estado: r.estado, motivo: r.motivo, repetir: !!r.repetir,
    numero: r.numero, pdv: r.pdv, cuit: r.cuit, cliente: r.cliente, fecha: r.fecha, recibido_por: r.recibido_por, recibido_el: r.recibido_el,
    firmado: r.firmado == null ? null : !!r.firmado, reservas: !!r.reservas, notas: r.notas, chofer: r.chofer, subido_por: r.subido_por,
    controles: parse<Control[]>(r.controles, []), candidatos: parse<Candidato[]>(r.candidatos, []), duplicado_de: r.duplicado_de,
    otros_remitos_en_foto: !!parse<Partial<Lectura>>(r.lectura, {}).otros_remitos_en_foto, dudas: parse<Partial<Lectura>>(r.lectura, {}).dudas ?? [],
    leido_at: r.leido_at, revisado_por: r.revisado_por, revisado_at: r.revisado_at, created_at: r.created_at, tomada_el: r.tomada_el, items,
    pdv_chofer: r.pdv_chofer,
  };
}
export async function itemsDe(db: D1Database, ids: number[]) {
  const m = new Map<number, Array<{ code: string | null; description: string | null; quantity: number | null }>>();
  if (!ids.length) return m;
  const { results } = await db.prepare('SELECT remito_id, code, description, quantity FROM remito_items WHERE remito_id IN (SELECT value FROM json_each(?)) ORDER BY remito_id, position')
    .bind(JSON.stringify(ids)).all<{ remito_id: number; code: string | null; description: string | null; quantity: number | null }>();
  for (const { remito_id, ...it } of results) m.set(remito_id, [...(m.get(remito_id) ?? []), it]);
  return m;
}

export async function remitosDelPedido(db: D1Database, orderId: number) {
  const { results } = await db.prepare(`SELECT ${SIN_DATA} FROM remitos WHERE record_id = ? OR (record_id IS NULL AND candidatos LIKE ?) ORDER BY created_at DESC, id DESC`)
    .bind(orderId, `%"id":${orderId},%`).all<RemitoRow>();
  const items = await itemsDe(db, results.map((r) => r.id));
  return results.map((r) => remitoPublico(r, items.get(r.id)));
}

// La bandeja de revisión: lo que no se pudo adjuntar solo, más lo que no se pudo leer.
export async function remitosParaRevisar(db: D1Database, limit = 100) {
  const { results } = await db.prepare(`SELECT ${SIN_DATA.split(',').map((c) => `m.${c.trim()}`).join(', ')}, o.name AS pedido_nombre FROM remitos m
    LEFT JOIN records o ON o.id = m.record_id WHERE m.estado = 'revisar' OR (m.estado = 'sin_leer' AND m.intentos >= 1)
    ORDER BY m.created_at DESC LIMIT ?`).bind(limit).all<RemitoRow & { pedido_nombre: string | null }>();
  const items = await itemsDe(db, results.map((r) => r.id));
  return results.map((r) => ({ ...remitoPublico(r, items.get(r.id)), pedido_nombre: r.pedido_nombre }));
}

// Por qué se le pide el PDV al chofer, en sus palabras (de los controles del cruce).
function pedirPdv(r: Pick<RemitoRow, 'controles' | 'pdv' | 'pdv_chofer'>) {
  let cs: Control[] = [];
  try { cs = JSON.parse(r.controles || '[]') as Control[]; } catch { /* sin controles */ }
  if (cs.some((c) => c.dato === 'Pedido' && c.ok === false && /^No hay ningún pedido/.test(c.detalle))) return `No hay ningún pedido con el PDV ${r.pdv_chofer ?? r.pdv ?? ''}. Fijate el número y escribilo.`;
  if (cs.some((c) => c.dato === 'PDV' && c.ok === false)) return 'El número de PDV no coincide en los dos lugares del remito. Escribí cuál es, o sacá otra foto.';
  return 'No se lee el número de PDV. Escribilo, o sacá otra foto.';
}

// Lo que ve el chofer en la app: el estado en una frase.
export function paraChofer(r: RemitoRow, items: Array<{ description: string | null; quantity: number | null }>, pedidoNombre: string | null) {
  // La app ya muestra lo leído (PDV, cliente, productos): el mensaje dice solo lo que pasó.
  const mensaje = r.estado === 'ok' ? `Quedó en el pedido${r.pdv ? ` del PDV ${r.pdv}` : ''}. No tenés que hacer nada más.`
    : r.estado === 'duplicado' ? `Ese remito ya estaba mandado${r.pdv ? ` (PDV ${r.pdv})` : ''}. No hace falta mandarlo de nuevo.`
    : r.estado === 'descartado' ? `Logística lo descartó${r.motivo ? `: ${r.motivo}` : '.'}`
    : r.estado === 'revisar' ? (r.repetir ? (JSON.parse(r.lectura || '{}').motivo_repetir || 'No se lee bien. Sacá otra foto: el remito entero, de frente y sin sombra.')
      : r.pide_pdv ? pedirPdv(r)
      : `Llegó. Logística lo revisa${r.motivo ? `: ${r.motivo}` : '.'}`)
    : 'Llegó. Se lee en unos minutos; no tenés que hacer nada.';
  return {
    id: r.id, clave: r.clave, creado: r.created_at, estado: r.estado, repetir: r.estado === 'revisar' && !!r.repetir, mensaje,
    pide_pdv: r.estado === 'revisar' && !!r.pide_pdv, pdv_chofer: r.pdv_chofer,
    numero: r.numero, pdv: r.pdv, cliente: r.cliente, items: items.map((i) => ({ descripcion: i.description ?? '', cantidad: i.quantity })),
    pedido: r.record_id && pedidoNombre ? { id: r.record_id, nombre: pedidoNombre } : null,
  };
}
