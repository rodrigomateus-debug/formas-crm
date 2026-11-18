import Anthropic from '@anthropic-ai/sdk';
import type { Ctx, Env } from './env';
import { HttpError, now } from './env';
import { norm } from './clickup';
import { claveCalle, claveDireccion, direccionLugar, puedeEditarCronograma, reindexarLugares } from './cronograma';
import { MODELO } from './remitos';
import { normalizarUbicacion } from '../../web/src/localidades';

// Destinos completados con IA (pedido de Rodrigo del 18/11/2026). En la libreta (pestaña Destinos de Recorridos) muchos
// lugares no tienen la localidad o la provincia, o la dirección está escrita de una forma que el mapa no encuentra. Claude
// revisa cada uno (nombre, dirección, localidad, zona, observaciones) y propone la dirección prolija (calle y altura), la
// localidad y la provincia, con cuán seguro está.
//
// - Solo se corrige lo que está **al menos 90 % seguro**. Con Google Maps conectado (GOOGLE_MAPS_API_KEY), además Google
//   tiene que ubicarlo en esa misma altura, localidad y provincia; entonces el punto de Google va al mapa.
// - Nunca inventa una calle ni una altura que no esté en los datos: ordena, corrige errores de tipeo y deduce la localidad
//   y la provincia.
// - Lo que no llega al 90 % queda «Para revisar», con la sugerencia y el motivo, para que Logística la acepte o la corrija.
// - Lo corregido queda como «corregido en el Hub» (la copia de la planilla ya no lo pisa) y guarda cómo estaba, para
//   volver atrás desde el destino.
// - Cada destino se revisa una vez: si nadie lo cambia, no se vuelve a preguntar.

export const UMBRAL = 90;
const POR_VEZ = 15;
const PLACES = (env: Env) => env.GOOGLE_PLACES_API_URL ?? 'https://places.googleapis.com/v1';

interface FilaLugar { id: number; nombre: string; direccion: string | null; localidad: string | null; provincia: string | null; zona: string | null;
  observaciones: string | null; editado: number; ia_firma: string | null; tipo: string | null; empresa: string | null }
interface Propuesta { id: number; direccion: string; localidad: string; provincia: string; confianza: number; motivo: string; tipo: string; tipo_confianza: number }

export const firmaDe = (l: { nombre: string; direccion: string | null; localidad: string | null; provincia: string | null }) =>
  norm([l.nombre, l.direccion ?? '', l.localidad ?? '', l.provincia ?? ''].join('|'));
const vacio = (s: string | null | undefined) => !String(s ?? '').trim();

// Los que hay que revisar: les falta la localidad, la provincia o el punto en el mapa, y no se revisaron así como están.
async function pendientes(db: D1Database, ids?: number[]) {
  const { results } = await db.prepare(`SELECT l.id, l.nombre, l.direccion, l.localidad, l.provincia, l.zona, l.observaciones, l.editado, l.ia_firma, l.tipo, r.name AS empresa
    FROM lugares l LEFT JOIN records r ON r.id = l.company_id WHERE l.activo = 1 ${ids?.length ? 'AND l.id IN (SELECT value FROM json_each(?))' : ''} ORDER BY l.id`).bind(...(ids?.length ? [JSON.stringify(ids)] : [])).all<FilaLugar>();
  const sinRevisar = results.filter((l) => l.ia_firma !== firmaDe(l));
  const claves = [...new Set(sinRevisar.map((l) => claveDireccion(direccionLugar(l))).filter(Boolean))];
  const enMapa = new Set<string>();
  for (let i = 0; i < claves.length; i += 500) {
    const { results: g } = await db.prepare('SELECT clave FROM geocodigos WHERE ok = 1 AND clave IN (SELECT value FROM json_each(?))').bind(JSON.stringify(claves.slice(i, i + 500))).all<{ clave: string }>();
    for (const x of g) enMapa.add(x.clave);
  }
  // Pedido a mano (ids): se revisan aunque estén completos.
  return sinRevisar.filter((l) => ids?.length || !l.tipo || vacio(l.localidad) || vacio(l.provincia) || vacio(l.direccion) || !enMapa.has(claveDireccion(direccionLugar(l))));
}

const ESQUEMA = {
  type: 'object', additionalProperties: false, required: ['destinos'],
  properties: {
    destinos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'direccion', 'localidad', 'provincia', 'confianza', 'motivo', 'tipo', 'tipo_confianza'],
        properties: { id: { type: 'integer' }, direccion: { type: 'string' }, localidad: { type: 'string' }, provincia: { type: 'string' }, confianza: { type: 'integer' }, motivo: { type: 'string' },
          tipo: { type: 'string', enum: ['cliente', 'proveedor', 'impresor', 'taller', 'expreso', 'otro', ''] }, tipo_confianza: { type: 'integer' } },
      },
    },
  },
};
const INSTRUCCIONES = `Sos parte del Hub de Formas Publicitarias, una empresa de Buenos Aires. Te paso destinos de la libreta de Logística (proveedores, impresores, talleres, depósitos, oficinas de clientes, expresos), casi todos en el AMBA (CABA y conurbano), algunos en el interior. Algunos tienen la dirección incompleta: sin localidad, sin provincia, con abreviaturas o errores de tipeo, o con la localidad metida en la dirección.
Para cada uno devolvé:
- direccion: solo calle y altura, prolija («Av. del Libertador 1855», «Nicaragua 1651»). Mantené piso, oficina o local si los tenía. NUNCA inventes una calle ni una altura que no estén en los datos; si no hay altura, dejala sin altura.
- localidad: la localidad o ciudad («Vicente López», «Sarandí», «Rosario»). En la Ciudad de Buenos Aires, el barrio si está en los datos («Flores», «Puerto Madero»); si no, «CABA».
- provincia: «Ciudad Autónoma de Buenos Aires», «Buenos Aires», «Santa Fe», etc.
- confianza: de 0 a 100, cuán seguro estás de que esa calle, esa altura, esa localidad y esa provincia son las del lugar (no si la dirección está bien escrita). Una calle que existe en varias localidades y sin otra pista no pasa de 60. Sin altura, no pasa de 50. Poné 90 o más solo si de verdad no tenés dudas (la localidad o la zona lo confirman, o la calle y altura son inconfundibles).
- motivo: una frase corta en castellano rioplatense para Logística: qué completaste o por qué no estás seguro («Agregué Sarandí, Buenos Aires: Nicaragua al 1600 está en Sarandí y la zona es Sur», «Hay calle Mitre en muchas localidades y no hay zona»).
- tipo: qué es el lugar para Formas: «cliente» (una empresa a la que le vendemos: se le entregan pedidos o muestras), «proveedor» (nos vende productos o insumos), «impresor» (imprenta, serigrafía, bordado, sublimación, grabado: personaliza la mercadería), «taller» (costura, confección), «expreso» (transporte o expreso al que se le lleva mercadería para el interior), «otro». Si no lo sabés, cadena vacía.
- tipo_confianza: de 0 a 100, cuán seguro estás del tipo. 90 o más solo si el nombre, la empresa o las observaciones lo dejan claro.
Devolvé un elemento por cada destino, con su mismo id.`;

async function preguntarAClaude(env: Env, lugares: FilaLugar[]): Promise<Propuesta[]> {
  const datos = lugares.map((l) => ({ id: l.id, nombre: l.nombre, empresa_del_crm: l.empresa ?? '', direccion: l.direccion ?? '', localidad: l.localidad ?? '', provincia: l.provincia ?? '', zona: l.zona ?? '',
    observaciones: (l.observaciones ?? '').slice(0, 200) }));
  const res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeout: 90_000 }).beta.messages.create({
    model: MODELO, max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    system: INSTRUCCIONES,
    messages: [{ role: 'user', content: `Destinos:\n${JSON.stringify(datos, null, 1)}` }],
  });
  const texto = res.content.map((x) => (x.type === 'text' ? x.text : '')).join('').trim();
  const r = JSON.parse(texto) as { destinos?: Propuesta[] };
  return (r.destinos ?? []).filter((p) => lugares.some((l) => l.id === p.id));
}

// Google Maps tiene que ubicar la propuesta en la misma altura, localidad y provincia. Devuelve el punto o por qué no.
interface Confirmacion { ok: boolean; motivo?: string; lat?: number; lng?: number }
async function confirmarConGoogle(env: Env, p: Propuesta): Promise<Confirmacion> {
  const res = await fetch(`${PLACES(env)}/places:searchText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GOOGLE_MAPS_API_KEY!, 'x-goog-fieldmask': 'places.formattedAddress,places.location,places.types,places.addressComponents' },
    body: JSON.stringify({ textQuery: `${p.direccion}, ${p.localidad}, ${p.provincia}, Argentina`, languageCode: 'es', regionCode: 'ar', pageSize: 1 }),
  });
  if (!res.ok) throw new Error(`Google Maps ${res.status}`);
  const j = (await res.json()) as { places?: Array<{ formattedAddress?: string; location?: { latitude: number; longitude: number }; addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }> }> };
  const g = j.places?.[0];
  if (!g?.location) return { ok: false, motivo: 'Google Maps no la encuentra.' };
  const comps = g.addressComponents ?? [];
  const comp = (t: string) => comps.filter((c) => c.types?.includes(t)).flatMap((c) => [c.longText ?? '', c.shortText ?? '']).map(norm).filter(Boolean);
  const altura = p.direccion.match(/\b(\d{1,5})\b/)?.[1];
  if (altura && !comp('street_number').includes(altura)) return { ok: false, motivo: `Google Maps la ubica en ${g.formattedAddress ?? 'otro lugar'}, no en esa altura.` };
  const prov = norm(p.provincia), caba = norm(p.localidad) === 'caba' || /ciudad autonoma|capital federal/.test(prov);
  const provG = comp('administrative_area_level_1');
  const esCabaG = provG.some((x) => /ciudad autonoma|caba|capital federal/.test(x));
  if (caba ? !esCabaG : (esCabaG || !provG.some((x) => x.includes(prov.replace(/^provincia de /, '')) || prov.includes(x.replace(/^provincia de /, ''))))) {
    return { ok: false, motivo: `Google Maps la ubica en ${g.formattedAddress ?? 'otra provincia'}.` };
  }
  if (!caba) {
    const loc = norm(p.localidad);
    const lugaresG = [...comp('locality'), ...comp('sublocality'), ...comp('sublocality_level_1'), ...comp('administrative_area_level_2'), ...comp('neighborhood')];
    if (!lugaresG.some((x) => x === loc || x.includes(loc) || loc.includes(x)) && !norm(g.formattedAddress ?? '').includes(loc)) {
      return { ok: false, motivo: `Google Maps la ubica en ${g.formattedAddress ?? 'otra localidad'}.` };
    }
  }
  return { ok: true, lat: g.location.latitude, lng: g.location.longitude };
}

const recorte = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n) || null;

export interface ResultadoIA { revisados: number; corregidos: Array<{ id: number; nombre: string; antes: string; ahora: string; motivo: string }>;
  dudosos: Array<{ id: number; nombre: string; sugerida: string; confianza: number; motivo: string }>; pendientes: number; google: boolean }

// Revisa una tanda (la pantalla vuelve a llamar mientras queden `pendientes`). `ids`: revisar esos aunque estén completos.
export async function completarDestinos(env: Env, ctx: Ctx, b: { ids?: unknown } = {}): Promise<ResultadoIA> {
  if (!puedeEditarCronograma(ctx.user)) throw new HttpError(403, 'Completar los destinos con IA es de Logística.');
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'Falta conectar Claude (ANTHROPIC_API_KEY).');
  const db = env.DB;
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, POR_VEZ) : undefined;
  const todos = await pendientes(db, ids);
  const tanda = todos.slice(0, POR_VEZ);
  const google = !!env.GOOGLE_MAPS_API_KEY;
  const out: ResultadoIA = { revisados: 0, corregidos: [], dudosos: [], pendientes: Math.max(0, todos.length - tanda.length), google };
  if (!tanda.length) return out;

  let propuestas: Propuesta[];
  try { propuestas = await preguntarAClaude(env, tanda); }
  catch (e) { throw new HttpError(502, `Claude no pudo revisar los destinos: ${(e as Error).message}`.slice(0, 300)); }

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  const cambiados: number[] = [];
  for (const l of tanda) {
    const p = propuestas.find((x) => x.id === l.id);
    if (!p) continue;   // no contestó por este: queda para la próxima tanda
    out.revisados++;
    // La localidad y la provincia, como en el listado (normalizarUbicacion: «Capital Federal» → CABA, «Pompeya» → Nueva Pompeya).
    const nueva = { direccion: recorte(p.direccion, 300) ?? l.direccion, ...normalizarUbicacion({ localidad: recorte(p.localidad, 80), provincia: recorte(p.provincia, 80), zona: l.zona }) };
    const conf = Math.max(0, Math.min(100, Math.round(Number(p.confianza) || 0)));
    const motivo = recorte(String(p.motivo ?? ''), 300) ?? '';
    // El tipo, si no tenía y Claude está seguro.
    if (!l.tipo && p.tipo && Number(p.tipo_confianza) >= UMBRAL && ['cliente', 'proveedor', 'impresor', 'taller', 'expreso', 'otro'].includes(p.tipo)) {
      stmts.push(db.prepare("UPDATE lugares SET tipo = ?, tipo_origen = 'ia' WHERE id = ? AND tipo IS NULL").bind(p.tipo, l.id));
    }
    const igual = norm(nueva.direccion ?? '') === norm(l.direccion ?? '') && norm(nueva.localidad ?? '') === norm(l.localidad ?? '') && norm(nueva.provincia ?? '') === norm(l.provincia ?? '');
    let estado: 'corregido' | 'ok' | 'dudoso' = conf >= UMBRAL ? (igual ? 'ok' : 'corregido') : 'dudoso';
    let nota = motivo;
    let punto: { lat: number; lng: number } | null = null;
    if (estado !== 'dudoso' && google && nueva.direccion && nueva.localidad && nueva.provincia) {
      try {
        const c = await confirmarConGoogle(env, { ...p, direccion: nueva.direccion, localidad: nueva.localidad, provincia: nueva.provincia });
        if (c.ok) punto = { lat: c.lat!, lng: c.lng! };
        else { estado = 'dudoso'; nota = `${motivo} ${c.motivo ?? ''}`.trim(); }
      } catch (e) { console.error('destinos IA: google', l.id, (e as Error).message); continue; }   // se reintenta en la próxima
    }
    if (estado === 'dudoso') {
      stmts.push(db.prepare('UPDATE lugares SET ia_estado = ?, ia_nota = ?, ia_sugerida = ?, ia_firma = ?, ia_at = ? WHERE id = ?')
        .bind('dudoso', nota.slice(0, 400), JSON.stringify({ ...nueva, confianza: conf }), firmaDe(l), ts, l.id));
      out.dudosos.push({ id: l.id, nombre: l.nombre, sugerida: direccionLugar({ ...nueva, zona: null }), confianza: conf, motivo: nota });
    } else if (estado === 'ok') {
      stmts.push(db.prepare('UPDATE lugares SET ia_estado = ?, ia_nota = ?, ia_sugerida = NULL, ia_firma = ?, ia_at = ? WHERE id = ?').bind('ok', nota.slice(0, 400), firmaDe(l), ts, l.id));
    } else {
      const antes = { direccion: l.direccion, localidad: l.localidad, provincia: l.provincia };
      stmts.push(db.prepare(`UPDATE lugares SET direccion = ?, localidad = ?, provincia = ?, clave_dir = ?, editado = 1, ia_estado = 'corregido', ia_nota = ?, ia_antes = ?,
          ia_sugerida = NULL, ia_firma = ?, ia_at = ?, updated_at = ? WHERE id = ?`)
        .bind(nueva.direccion, nueva.localidad, nueva.provincia, nueva.direccion ? claveCalle(nueva.direccion) || null : null, nota.slice(0, 400), JSON.stringify(antes),
          firmaDe({ nombre: l.nombre, ...nueva }), ts, ts, l.id));
      cambiados.push(l.id);
      out.corregidos.push({ id: l.id, nombre: l.nombre, antes: direccionLugar(l), ahora: direccionLugar({ ...nueva, zona: l.zona }), motivo: nota });
    }
    // El punto de Google va al mapa de la ruta (salvo que alguien lo haya corrido a mano).
    const clave = claveDireccion(direccionLugar({ ...nueva, zona: l.zona }));
    if (punto && clave) {
      stmts.push(db.prepare(`INSERT INTO geocodigos (clave, direccion, lat, lng, ok, manual, at) VALUES (?, ?, ?, ?, 1, 0, ?)
        ON CONFLICT (clave) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, ok = 1, at = excluded.at WHERE geocodigos.manual = 0`)
        .bind(clave, direccionLugar({ ...nueva, zona: l.zona }), punto.lat, punto.lng, ts));
    }
  }
  if (stmts.length) await db.batch(stmts);
  if (cambiados.length) await reindexarLugares(db, cambiados);
  // Los que Claude no contestó siguen pendientes.
  out.pendientes += tanda.length - out.revisados;
  return out;
}
