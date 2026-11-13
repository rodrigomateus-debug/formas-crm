import type { Ctx, Env } from './env';
import { HttpError, now } from './env';
import { getRow, updateRecord } from './records';
import { claveDireccion } from './cronograma';
import { avisarCambio } from './cambios';

// Direcciones de entrega del pedido (pedido de Rodrigo del 12/11/2026), en la tarjeta «Entrega».
//
// - Por defecto, una sola dirección y todo el pedido va ahí.
// - Con varias, cada una dice cuánto de cada producto lleva. Lo que se reparte se va descontando del total de cada producto:
//   la suma entre todas las direcciones no puede pasar de lo que tiene el pedido (lo que falta repartir queda a la vista).
// - La dirección se valida con Google Maps (Places API): se elige de lo que sugiere Google y el servidor vuelve a pedirle a
//   Google los datos del lugar (dirección, coordenadas, localidad), así lo validado no lo puede inventar la pantalla. Sin la
//   clave de Google Maps (GOOGLE_MAPS_API_KEY), o si se carga a mano, queda «sin validar».
//
// Los productos son los renglones del pedido (Finnegans, o los artículos de ClickUp), los mismos de «Entrega».
//
// El cronograma (cronograma.ts) arma la ruta del día con estas direcciones: una parada por dirección, y las validadas van al
// mapa con el punto de Google. Cambiar la dirección desde la parada también pasa por acá (direccionDesdeRuta).

const PLACES = (env: Env) => env.GOOGLE_PLACES_API_URL ?? 'https://places.googleapis.com/v1';
export const mapsConfigurado = (env: Env) => !!env.GOOGLE_MAPS_API_KEY;

export interface Sugerencia { place_id: string; texto: string; principal: string; secundario: string }
export interface Lugar { place_id: string; direccion: string; lat: number | null; lng: number | null; precisa: boolean; localidad: string | null; provincia: string | null; codigo_postal: string | null }

async function google<T>(env: Env, path: string, init: RequestInit & { campos?: string } = {}): Promise<T> {
  if (!env.GOOGLE_MAPS_API_KEY) throw new HttpError(503, 'Falta conectar Google Maps (GOOGLE_MAPS_API_KEY): la dirección se puede cargar a mano, sin validar.');
  const res = await fetch(`${PLACES(env)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GOOGLE_MAPS_API_KEY, ...(init.campos ? { 'x-goog-fieldmask': init.campos } : {}) },
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new HttpError(502, `Google Maps no respondió bien (${res.status}). ${detalle.slice(0, 200)}`.trim());
  }
  return res.json() as Promise<T>;
}

// Lo que sugiere Google mientras se escribe (direcciones de la Argentina).
export async function sugerencias(env: Env, texto: string, sesion?: string): Promise<Sugerencia[]> {
  const q = texto.trim();
  if (q.length < 3) return [];
  const r = await google<{ suggestions?: Array<{ placePrediction?: { placeId: string; text?: { text: string }; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }> }>(
    env, '/places:autocomplete', { method: 'POST', body: JSON.stringify({ input: q.slice(0, 200), languageCode: 'es', includedRegionCodes: ['ar'], ...(sesion ? { sessionToken: sesion } : {}) }) });
  return (r.suggestions ?? []).map((s) => s.placePrediction).filter((p): p is NonNullable<typeof p> => !!p?.placeId).slice(0, 6).map((p) => ({
    place_id: p.placeId, texto: p.text?.text ?? '', principal: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '', secundario: p.structuredFormat?.secondaryText?.text ?? '',
  }));
}

// Los datos de un lugar de Google: la dirección como la escribe Google, coordenadas, localidad y si tiene altura.
export async function lugar(env: Env, placeId: string, sesion?: string): Promise<Lugar> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new HttpError(400, 'Lugar de Google Maps inválido.');
  const r = await google<{ id?: string; formattedAddress?: string; location?: { latitude: number; longitude: number }; types?: string[];
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }> }>(
    env, `/places/${encodeURIComponent(placeId)}?languageCode=es${sesion ? `&sessionToken=${encodeURIComponent(sesion)}` : ''}`,
    { campos: 'id,formattedAddress,location,types,addressComponents' });
  const comp = (t: string) => r.addressComponents?.find((c) => c.types?.includes(t))?.longText ?? null;
  const tipos = r.types ?? [];
  return {
    place_id: r.id ?? placeId,
    direccion: r.formattedAddress ?? '',
    lat: r.location?.latitude ?? null, lng: r.location?.longitude ?? null,
    // Con altura: Google la ubica en un número de la calle (o es un edificio o local puntual), no en una calle, barrio o ciudad.
    precisa: !!comp('street_number') || tipos.some((t) => ['street_address', 'premise', 'subpremise'].includes(t)),
    localidad: comp('locality') ?? comp('administrative_area_level_2') ?? comp('sublocality'),
    provincia: comp('administrative_area_level_1'),
    codigo_postal: comp('postal_code'),
  };
}

export const linkMaps = (d: { direccion: string; place_id: string | null }) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.direccion)}${d.place_id ? `&query_place_id=${encodeURIComponent(d.place_id)}` : ''}`;

// ---------- Productos del pedido ----------

export interface ProductoReparto { clave: string; nombre: string; codigo: string | null; total: number | null }

// Los renglones del pedido, cada uno con su clave: el código (o el nombre) y, si se repite, el número de vez.
export async function productosDelPedido(db: D1Database, orderId: number): Promise<ProductoReparto[]> {
  const { results } = await db.prepare(`SELECT li.code, COALESCE(pr.name, li.name, li.description, li.code, 'Producto') AS name, li.quantity
    FROM line_items li LEFT JOIN products pr ON pr.code = li.code WHERE li.record_id = ? ORDER BY li.position`).bind(orderId)
    .all<{ code: string | null; name: string; quantity: number | null }>();
  const vistas = new Map<string, number>();
  return results.map((r) => {
    const base = (r.code?.trim() || r.name.trim()).toUpperCase();
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    return { clave: n === 1 ? base : `${base}#${n}`, nombre: r.name, codigo: r.code, total: r.quantity == null ? null : Number(r.quantity) };
  });
}

// ---------- Lo guardado ----------

interface FilaDireccion { id: number; position: number; direccion: string; detalle: string | null; place_id: string | null; lat: number | null; lng: number | null;
  precisa: number; localidad: string | null; provincia: string | null; codigo_postal: string | null; user_id: number | null; updated_at: string }

export async function direccionesDe(env: Env, orderId: number) {
  const db = env.DB;
  const pedido = await getRow(db, orderId, 'order');
  const [dirs, cants] = await db.batch([
    db.prepare('SELECT * FROM entrega_direcciones WHERE record_id = ? ORDER BY position, id').bind(orderId),
    db.prepare('SELECT c.direccion_id, c.clave, c.cantidad FROM entrega_cantidades c JOIN entrega_direcciones d ON d.id = c.direccion_id WHERE d.record_id = ?').bind(orderId),
  ]);
  const direcciones = (dirs.results as unknown as FilaDireccion[]).map((d) => ({ ...d, precisa: !!d.precisa, validada: !!d.place_id, maps: linkMaps(d) }));
  const cantidades = cants.results as Array<{ direccion_id: number; clave: string; cantidad: number }>;
  const productos = await productosDelPedido(db, orderId);
  const varias = direcciones.length > 1;
  // Cuánto de cada producto ya está repartido y cuánto queda (con una sola dirección, todo va ahí).
  const reparto = productos.map((p) => {
    const asignado = varias ? cantidades.filter((c) => c.clave === p.clave).reduce((s, c) => s + c.cantidad, 0) : p.total ?? 0;
    return { ...p, asignado, quedan: p.total == null ? null : Math.max(0, p.total - asignado) };
  });
  // Sugerencia para la primera carga (hay que confirmarla con Google): la del pedido de venta de Finnegans y, si no, la de la
  // empresa del pedido.
  let sugerida: string | null = null;
  if (!direcciones.length) {
    const props = JSON.parse(pedido.props) as Record<string, unknown>;
    const fin = (await db.prepare('SELECT direccion FROM direcciones_finnegans WHERE record_id = ?').bind(orderId).first<{ direccion: string | null }>())?.direccion
      ?? (typeof props.direccion_entrega_finnegans === 'string' ? props.direccion_entrega_finnegans : null);
    if (fin?.trim()) sugerida = fin.trim();
  }
  if (!direcciones.length && !sugerida) {
    const emp = await db.prepare(`SELECT json_extract(r.props, '$.address') AS calle, json_extract(r.props, '$.city') AS ciudad, json_extract(r.props, '$.state') AS prov
      FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0 WHERE a.from_id = ? AND a.to_type = 'company' ORDER BY a.is_primary DESC LIMIT 1`)
      .bind(orderId).first<{ calle: string | null; ciudad: string | null; prov: string | null }>();
    if (emp?.calle) sugerida = [emp.calle, emp.ciudad, emp.prov].filter(Boolean).join(', ');
  }
  return {
    pedido: pedido.name, direcciones, cantidades, productos: reparto, varias, sugerida, maps: mapsConfigurado(env),
    sin_repartir: varias ? reparto.filter((p) => (p.quedan ?? 0) > 0).length : 0,
  };
}

// ---------- Guardar ----------

export interface DireccionInput { id?: number; place_id?: string | null; direccion?: string; detalle?: string | null }
export interface GuardarInput { direcciones: DireccionInput[]; cantidades?: Array<{ direccion: number; clave: string; cantidad: number }>; sesion?: string }

const redondo = (n: number) => Math.round(n * 1000) / 1000;
const cant = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

// Reemplaza las direcciones del pedido (y el reparto) de una vez: o queda todo bien, o no cambia nada.
// En `cantidades`, `direccion` es la posición de la dirección en la lista que se manda.
export async function guardarDirecciones(env: Env, ctx: Ctx, orderId: number, b: GuardarInput) {
  const db = env.DB;
  await getRow(db, orderId, 'order');
  const lista = (b.direcciones ?? []).slice(0, 30);
  if ((b.direcciones ?? []).length > 30) throw new HttpError(400, 'Hasta 30 direcciones por pedido.');
  const actuales = new Map((await db.prepare('SELECT * FROM entrega_direcciones WHERE record_id = ? ORDER BY position, id').bind(orderId).all<FilaDireccion>()).results.map((d) => [d.id, d]));
  // Cómo estaban (direcciones y reparto), para avisarle al vendedor si cambió (cambios.ts).
  const repartoAntes = (await db.prepare(`SELECT d.position, c.clave, c.cantidad FROM entrega_cantidades c JOIN entrega_direcciones d ON d.id = c.direccion_id
    WHERE d.record_id = ? ORDER BY d.position, c.clave`).bind(orderId).all<{ position: number; clave: string; cantidad: number }>()).results;

  // Cada dirección: con place_id, la arma Google (se valida acá, no en la pantalla); sin place_id, la escrita, sin validar.
  const nuevas: Array<Omit<FilaDireccion, 'id' | 'position' | 'user_id' | 'updated_at'>> = [];
  for (const [i, d] of lista.entries()) {
    const detalle = d.detalle?.toString().trim().slice(0, 300) || null;
    const previa = d.id != null ? actuales.get(Number(d.id)) : undefined;
    if (d.place_id) {
      // Si es la misma que ya estaba validada, no hace falta volver a preguntarle a Google.
      if (previa?.place_id === d.place_id) { nuevas.push({ ...previa, detalle }); continue; }
      const l = await lugar(env, d.place_id, b.sesion);
      if (!l.direccion) throw new HttpError(400, `Google Maps no encontró la dirección ${i + 1}.`);
      nuevas.push({ direccion: l.direccion, detalle, place_id: l.place_id, lat: l.lat, lng: l.lng, precisa: l.precisa ? 1 : 0, localidad: l.localidad, provincia: l.provincia, codigo_postal: l.codigo_postal });
    } else {
      const texto = d.direccion?.toString().trim().slice(0, 300) ?? '';
      if (texto.length < 5) throw new HttpError(400, `Falta la dirección ${lista.length > 1 ? `${i + 1} ` : ''}(calle, número y localidad).`);
      nuevas.push({ direccion: texto, detalle, place_id: null, lat: null, lng: null, precisa: 0, localidad: null, provincia: null, codigo_postal: null });
    }
  }
  const repetida = nuevas.findIndex((d, i) => nuevas.findIndex((x) => (x.place_id && x.place_id === d.place_id && x.detalle === d.detalle) || (!x.place_id && x.direccion.toLowerCase() === d.direccion.toLowerCase() && x.detalle === d.detalle)) !== i);
  if (repetida >= 0) throw new HttpError(400, `La dirección ${repetida + 1} está repetida: si van dos entregas al mismo lugar, aclaralo en el detalle (piso, sector…).`);

  // El reparto (solo con varias direcciones): ningún producto puede repartir más de lo que tiene el pedido.
  const productos = await productosDelPedido(db, orderId);
  const filas: Array<{ direccion: number; clave: string; cantidad: number }> = [];
  if (nuevas.length > 1) {
    for (const c of b.cantidades ?? []) {
      const q = redondo(Number(c.cantidad));
      if (!Number.isFinite(q) || q < 0) throw new HttpError(400, 'Las cantidades tienen que ser números positivos.');
      if (q === 0) continue;
      if (!Number.isInteger(c.direccion) || c.direccion < 0 || c.direccion >= nuevas.length) throw new HttpError(400, 'Cantidad para una dirección que no está.');
      const p = productos.find((x) => x.clave === c.clave);
      if (!p) throw new HttpError(400, `El producto ${c.clave} no está en el pedido.`);
      filas.push({ direccion: c.direccion, clave: p.clave, cantidad: q });
    }
    for (const p of productos) {
      const suma = redondo(filas.filter((f) => f.clave === p.clave).reduce((s, f) => s + f.cantidad, 0));
      if (p.total != null && suma > p.total) {
        throw new HttpError(400, `De «${p.nombre}» repartiste ${cant(suma)} y el pedido tiene ${cant(p.total)}: no se puede entregar más que lo pedido.`, { clave: p.clave });
      }
    }
  }

  // Todo junto: se borran las anteriores y se escriben las nuevas (con sus cantidades), en un solo lote.
  const ts = now();
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM entrega_cantidades WHERE direccion_id IN (SELECT id FROM entrega_direcciones WHERE record_id = ?)').bind(orderId),
    db.prepare('DELETE FROM entrega_direcciones WHERE record_id = ?').bind(orderId),
  ];
  const base = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM entrega_direcciones').first<{ m: number }>())!.m + 1;
  nuevas.forEach((d, i) => {
    stmts.push(db.prepare(`INSERT INTO entrega_direcciones (id, record_id, position, direccion, detalle, place_id, lat, lng, precisa, localidad, provincia, codigo_postal, user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(base + i, orderId, i, d.direccion, d.detalle, d.place_id, d.lat, d.lng, d.precisa, d.localidad, d.provincia, d.codigo_postal, ctx.user.id, ts));
  });
  for (const f of filas) stmts.push(db.prepare('INSERT INTO entrega_cantidades (direccion_id, clave, cantidad) VALUES (?, ?, ?)').bind(base + f.direccion, f.clave, f.cantidad));
  // El punto de Google va al mapa de la ruta del cronograma (geocodigos), salvo que alguien ya haya corrido el punto a mano.
  for (const d of nuevas) {
    if (d.place_id && d.lat != null && d.lng != null && claveDireccion(d.direccion)) {
      stmts.push(db.prepare(`INSERT INTO geocodigos (clave, direccion, lat, lng, ok, manual, at) VALUES (?, ?, ?, ?, 1, 0, ?)
        ON CONFLICT (clave) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, ok = 1, at = excluded.at WHERE geocodigos.manual = 0`)
        .bind(claveDireccion(d.direccion), d.direccion, d.lat, d.lng, ts));
    }
  }
  await db.batch(stmts);

  // El resumen en el pedido (queda en el historial como cualquier cambio).
  const resumen = !nuevas.length ? null : nuevas.length === 1 ? nuevas[0].direccion : `${nuevas.length} direcciones: ${nuevas.map((d) => d.direccion).join(' · ')}`.slice(0, 500);
  await updateRecord(db, ctx, 'order', orderId, { direccion_entrega: resumen }, { system: true, strict: false });
  // Al vendedor, si la cambió otra persona (producción, logística…): qué dirección quedó, o que cambió el reparto.
  const lugares = (ds: Array<{ direccion: string; detalle: string | null }>) => JSON.stringify(ds.map((d) => [d.direccion.trim().toLowerCase(), d.detalle ?? '']));
  const reparto = (fs: Array<{ position: number; clave: string; cantidad: number }>) => JSON.stringify(fs.map((f) => [f.position, f.clave, f.cantidad]).sort());
  if (lugares([...actuales.values()]) !== lugares(nuevas)) {
    const con = (d: { direccion: string; detalle: string | null }) => `«${d.direccion}${d.detalle ? ` (${d.detalle})` : ''}»`;
    await avisarCambio(db, ctx, orderId, !nuevas.length ? 'Quitó la dirección de entrega'
      : nuevas.length === 1 ? `Cambió la dirección de entrega a ${con(nuevas[0])}`
      : `Cambió las direcciones de entrega: ${nuevas.map(con).join(', ')}`);
  } else if (reparto(repartoAntes) !== reparto(filas.map((f) => ({ position: f.direccion, clave: f.clave, cantidad: f.cantidad })))) {
    await avisarCambio(db, ctx, orderId, 'Cambió cuánto va a cada dirección de entrega');
  }
  return direccionesDe(env, orderId);
}

// Desde la parada del cronograma: una sola dirección, escrita (queda sin validar, salvo que sea la misma que ya estaba).
// Si el pedido va a varias direcciones, se cambian en la tarjeta «Entrega» del pedido, donde está el reparto.
export async function direccionDesdeRuta(env: Env, ctx: Ctx, orderId: number, texto: string | null) {
  const actuales = (await env.DB.prepare('SELECT id, direccion, detalle, place_id FROM entrega_direcciones WHERE record_id = ? ORDER BY position, id').bind(orderId)
    .all<{ id: number; direccion: string; detalle: string | null; place_id: string | null }>()).results;
  if (actuales.length > 1) throw new HttpError(409, 'Este pedido se entrega en varias direcciones: cambialas en la tarjeta «Entrega» del pedido.');
  const t = texto?.trim() ?? '';
  const misma = actuales[0] && actuales[0].direccion.trim().toLowerCase() === t.toLowerCase();
  return guardarDirecciones(env, ctx, orderId, {
    direcciones: !t ? [] : [misma ? { id: actuales[0].id, place_id: actuales[0].place_id, direccion: actuales[0].direccion, detalle: actuales[0].detalle } : { direccion: t, detalle: actuales[0]?.detalle ?? null }],
  });
}

// Las direcciones guardadas de varios pedidos (para la ruta del cronograma), en orden.
export async function direccionesDePedidos(db: D1Database, ids: number[]) {
  const out = new Map<number, Array<{ direccion: string; detalle: string | null; lat: number | null; lng: number | null; validada: boolean }>>();
  if (!ids.length) return out;
  const { results } = await db.prepare(`SELECT record_id, direccion, detalle, lat, lng, place_id FROM entrega_direcciones
    WHERE record_id IN (SELECT value FROM json_each(?)) ORDER BY record_id, position, id`).bind(JSON.stringify(ids))
    .all<{ record_id: number; direccion: string; detalle: string | null; lat: number | null; lng: number | null; place_id: string | null }>();
  for (const r of results) {
    const l = out.get(r.record_id) ?? [];
    l.push({ direccion: r.direccion, detalle: r.detalle, lat: r.lat, lng: r.lng, validada: !!r.place_id });
    out.set(r.record_id, l);
  }
  return out;
}
