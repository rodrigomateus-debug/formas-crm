// Provincias y localidades de la Argentina, para elegir la localidad según la provincia y para dejar escritas igual las
// que ya están cargadas (pedido de Rodrigo del 18/11/2026). El listado sale de Georef, el servicio de normalización
// geográfica del Estado (apis.datos.gob.ar/georef: localidades del BAHRA y, en Buenos Aires, también los partidos), con
// los nombres de uso que faltan en el AMBA (Don Torcuato, Nordelta, Boulogne…). En CABA la localidad es el barrio, o
// «CABA» si no se sabe. Lo usan el formulario de Destinos y el servidor (la copia de la planilla y lo que se guarda).
import datos from './localidades.json';

export const CABA = 'Ciudad Autónoma de Buenos Aires';
export const BSAS = 'Buenos Aires';
export const PROVINCIAS: string[] = datos.provincias;
const LOCALIDADES = datos.localidades as Record<string, string[]>;

const clave = (s: string | null | undefined) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.,;:()'"/-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Las localidades de una provincia (vacío si la provincia no es una de las 24). */
export function localidadesDe(provincia: string | null | undefined): string[] {
  const p = provinciaCanonica(provincia);
  return p ? LOCALIDADES[p] ?? [] : [];
}

const PROV_ALIAS: Record<string, string> = {
  caba: CABA, 'c a b a': CABA, capital: CABA, 'capital federal': CABA, 'cap fed': CABA, 'ciudad de buenos aires': CABA, 'ciudad autonoma de buenos aires': CABA,
  'cdad autonoma de buenos aires': CABA, 'ciudad autonomas buenos aires': CABA, 'ciudad autonoma buenos aires': CABA, cdba: CABA,
  'buenos aires': BSAS, 'provincia de buenos aires': BSAS, 'pcia de buenos aires': BSAS, 'pcia buenos aires': BSAS, 'pcia bs as': BSAS, 'bs as': BSAS, 'bsas': BSAS,
  'prov de buenos aires': BSAS, 'prov buenos aires': BSAS, pba: BSAS, gba: BSAS,
  'tierra del fuego': 'Tierra del Fuego, Antártida e Islas del Atlántico Sur', cordoba: 'Córdoba', 'entre rios': 'Entre Ríos', neuquen: 'Neuquén', tucuman: 'Tucumán', 'rio negro': 'Río Negro',
};
const PROV_CLAVE = new Map(PROVINCIAS.map((p) => [clave(p), p]));
/** «CABA», «Capital Federal», «Provincia de Buenos Aires», «cordoba» → el nombre oficial; null si no es una provincia. */
export function provinciaCanonica(s: string | null | undefined): string | null {
  const k = clave(s);
  return k ? PROV_ALIAS[k] ?? PROV_CLAVE.get(k) ?? null : null;
}

// Cómo se escriben en la planilla (sin tildes ni mayúsculas) las que no se reconocen solas.
const ALIAS: Record<string, string> = {
  once: 'Balvanera', pompeya: 'Nueva Pompeya', lugano: 'Villa Lugano', soldati: 'Villa Soldati', urquiza: 'Villa Urquiza', devoto: 'Villa Devoto', crespo: 'Villa Crespo',
  microcentro: 'San Nicolás', 'barrio norte': 'Recoleta', bouedo: 'Boedo', sordeaux: 'Sourdeaux', 'ricardo rojaz': 'Ricardo Rojas', 'belgrano r': 'Belgrano', 'belgrano c': 'Belgrano', 'barrio belgrano': 'Belgrano', 'barracas de belgrano': 'Barracas', 'puerto madero': 'Puerto Madero',
  'la boca': 'La Boca', boca: 'La Boca', paternal: 'La Paternal', montecastro: 'Monte Castro', 'parque patricio': 'Parque Patricios', abasto: 'Balvanera', congreso: 'Balvanera',
  tribunales: 'San Nicolás', 'las canitas': 'Palermo', 'palermo soho': 'Palermo', 'palermo hollywood': 'Palermo', 'villa pueyrredon': 'Villa Pueyrredón', velez: 'Vélez Sarsfield',
  palomar: 'El Palomar', 'ciudad jardin el palomar': 'Ciudad Jardín Lomas del Palomar', pacheco: 'General Pacheco', 'talar de pacheco': 'Talar de Pacheco', tablada: 'La Tablada',
  'pablo nogues': 'Ingeniero Pablo Nogués', 'jose leon suarez': 'José León Suárez', 'william morris': 'William C. Morris', 'greg de laferrere': 'Gregorio de Laferrere',
  laferrere: 'Gregorio de Laferrere', 'olivos la lucila': 'Olivos', 'san martin': 'General San Martín', 'tres de febrero': 'Tres de Febrero', 'ciudad jardin': 'Ciudad Jardín',
  'parque industrial de pilar': 'Parque Industrial Pilar', 'pq ind pilar': 'Parque Industrial Pilar', 'fatima pilar': 'Fátima', jepener: 'Jeppener', maschwitz: 'Ingeniero Maschwitz',
  'v lopez': 'Vicente López', 'vte lopez': 'Vicente López', 'lomas de zamora': 'Lomas de Zamora', 'castelar': 'Castelar', tesei: 'Villa Santos Tesei', 'villa tesei': 'Villa Tesei',
  'villa club hurlingham': 'Hurlingham', 'rodriguez': 'General Rodríguez', 'el talar': 'El Talar', 'del viso': 'Del Viso', 'pilar del viso': 'Del Viso',
};
// Abreviaturas: «pq», «gral», «v.», «ing», «pte», «cnel», «sta».
const ABREV: Array<[RegExp, string]> = [[/^(pq|pque|pque|prque) /, 'parque '], [/^(gral|grl) /, 'general '], [/^v /, 'villa '], [/^vila /, 'villa '], [/^ing /, 'ingeniero '],
  [/^pte /, 'presidente '], [/^cnel /, 'coronel '], [/^sta /, 'santa '], [/^sn /, 'san '], [/ gral /, ' general '], [/ grl /, ' general ']];
const expandir = (k: string) => ABREV.reduce((s, [re, r]) => s.replace(re, r), k);

const ZONAS_CABA = new Set(['caba', 'capital', 'capital federal', 'centro']);
const ZONAS_BA = new Set(['buenos aires', 'norte', 'oeste', 'sur', 'noroeste', 'nor oeste', 'sudoeste', 'gba', 'zona norte', 'zona sur', 'zona oeste']);

const indices = new Map<string, Map<string, string>>();
function indice(p: string) {
  let m = indices.get(p);
  if (!m) { m = new Map(); for (const l of LOCALIDADES[p] ?? []) m.set(clave(l), l); indices.set(p, m); }
  return m;
}
function parecido(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 3) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}
// La localidad de esa provincia: igual (sin tildes), con el alias o la abreviatura, o con un error de tipeo («Parlermo»).
function buscar(k: string, p: string): string | null {
  const m = indice(p);
  const k2 = expandir(k);
  const alias = ALIAS[k] ?? ALIAS[k2];
  if (alias && m.has(clave(alias))) return m.get(clave(alias))!;
  const exacta = m.get(k) ?? m.get(k2);
  if (exacta) return exacta;
  if (k2.length < 5) return null;
  let mejor: string | null = null, nota = 0, segunda = 0;
  for (const [ck, nombre] of m) { const r = parecido(k2, ck); if (r > nota) { segunda = nota; nota = r; mejor = nombre; } else if (r > segunda) segunda = r; }
  return nota >= 0.85 && nota - segunda >= 0.05 ? mejor : null;
}

const lindo = (s: string) => (s === s.toUpperCase() && s.length > 4 ? s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s);

/**
 * La localidad y la provincia escritas como en el listado. La provincia sale de la provincia, de la localidad
 * («CABA», «Martínez, Buenos Aires») o de la zona de la planilla. Una localidad que no está en el listado queda como
 * estaba (prolija, sin todo en mayúsculas); una zona («NORTE») no es una localidad y se saca.
 */
export function normalizarUbicacion(l: { localidad?: string | null; provincia?: string | null; zona?: string | null }): { localidad: string | null; provincia: string | null } {
  let prov = provinciaCanonica(l.provincia) ?? (l.provincia?.trim() || null);
  const original = String(l.localidad ?? '').replace(/\s+/g, ' ').trim();
  // «Martínez, Buenos Aires», «El Talar, Provincia de Buenos Aires», «CABA (Parque Patricios)», «Río Grande, Tierra del Fuego; CP 9420».
  const partes = original.split(/[,;()]/).map((x) => x.trim()).filter((x) => x && !/^cp\b|^\d+$/i.test(x));
  let resto: string[] = [];
  for (const x of partes) {
    const pp = provinciaCanonica(x);
    if (pp && provinciaCanonica(prov) && pp !== provinciaCanonica(prov)) continue;
    if (pp) { if (!provinciaCanonica(prov)) prov = pp; if (pp === CABA && !resto.length) resto.push('CABA'); } else resto.push(x);
  }
  if (resto.length > 1 && clave(resto[0]) === 'caba') resto = resto.slice(1);
  const zona = clave(l.zona);
  const explicita = provinciaCanonica(prov);
  const porZona = ZONAS_CABA.has(zona) ? CABA : ZONAS_BA.has(zona) ? BSAS : null;
  const texto = resto.join(', ');
  const k = clave(texto);
  if (!k) return { localidad: null, provincia: explicita ?? porZona ?? prov };
  if (ZONAS_BA.has(k)) return { localidad: null, provincia: explicita ?? BSAS };
  if (k === 'centro' && (!explicita || explicita === CABA)) return { localidad: 'CABA', provincia: CABA };
  // Lo escrito entero y, si no aparece, cada parte («Ricardo Rojas, El Talar, Tigre», «Monte Castro / Devoto», «Recoleta - CABA»).
  const textos = [k, ...texto.split(/[,/]| - | y /).map((x) => clave(x).replace(/^partido de /, '').replace(/ caba$/, '')).filter((x) => x && x !== 'caba' && x !== k)];
  if (/ caba$/.test(k)) textos.splice(1, 0, k.replace(/ caba$/, ''));
  // En qué provincias buscar: la que tiene escrita y nada más; si no, la de la zona de la planilla, la otra del AMBA (la
  // zona a veces está mal: «Munro» con zona CABA) y después el resto, si está en una sola.
  const orden = explicita ? [explicita] : porZona ? [porZona, porZona === CABA ? BSAS : CABA] : [CABA, BSAS];
  for (const t of textos) for (const q of orden) { const hallada = buscar(t, q); if (hallada) return { localidad: hallada, provincia: q }; }
  if (!explicita) {
    const otras = PROVINCIAS.filter((q) => q !== CABA && q !== BSAS && indice(q).has(k));
    if (otras.length === 1) return { localidad: indice(otras[0]).get(k)!, provincia: otras[0] };
  }
  return { localidad: lindo(texto), provincia: explicita ?? porZona ?? prov };
}
