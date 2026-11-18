// La zona del AMBA de un lugar (CABA, Norte, Oeste, Sur), para agrupar los recorridos como los piensa Logística. Primero
// lo que dice la libreta (columna «Zona» de la planilla), después la localidad y por último la dirección entera.
export type Zona = 'CABA' | 'Norte' | 'Oeste' | 'Sur' | 'Interior';
export const ZONAS: Zona[] = ['CABA', 'Norte', 'Oeste', 'Sur', 'Interior'];
export const nombreZona = (z: Zona) => (z === 'CABA' ? 'CABA' : z === 'Interior' ? 'Más lejos' : `Zona ${z}`);

const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LISTA: Record<Exclude<Zona, 'Interior'>, string[]> = {
  CABA: ['caba', 'capital federal', 'ciudad autonoma', 'buenos aires ciudad', 'palermo', 'belgrano', 'nunez', 'saavedra', 'colegiales', 'chacarita', 'villa crespo', 'almagro',
    'caballito', 'recoleta', 'retiro', 'san nicolas', 'microcentro', 'monserrat', 'montserrat', 'san telmo', 'la boca', 'barracas', 'constitucion', 'balvanera', 'once',
    'san cristobal', 'boedo', 'parque patricios', 'pompeya', 'flores', 'floresta', 'parque chacabuco', 'villa urquiza', 'villa pueyrredon', 'villa devoto', 'devoto',
    'villa del parque', 'agronomia', 'paternal', 'villa ortuzar', 'coghlan', 'villa luro', 'liniers', 'mataderos', 'versalles', 'monte castro', 'velez sarsfield',
    'villa real', 'villa santa rita', 'villa general mitre', 'parque avellaneda', 'villa lugano', 'villa soldati', 'villa riachuelo', 'puerto madero', 'parque chas'],
  Norte: ['vicente lopez', 'olivos', 'florida', 'munro', 'carapachay', 'villa adelina', 'la lucila', 'villa martelli', 'martinez', 'san isidro', 'boulogne', 'beccar',
    'acassuso', 'victoria', 'san fernando', 'tigre', 'pacheco', 'don torcuato', 'benavidez', 'nordelta', 'pilar', 'escobar', 'garin', 'del viso', 'talar', 'el talar',
    'san martin', 'villa ballester', 'jose leon suarez', 'malvinas argentinas', 'los polvorines', 'grand bourg', 'jose c. paz', 'jose c paz', 'san miguel', 'bella vista',
    'muniz', 'tortuguitas', 'villa lynch', 'villa zagala', 'san martin centro', 'villa maipu', 'billinghurst', 'san andres', 'chilavert', 'troncos del talar', 'rincon de milberg', 'dique lujan', 'zona norte'],
  Oeste: ['moron', 'haedo', 'castelar', 'ituzaingo', 'hurlingham', 'merlo', 'moreno', 'ramos mejia', 'san justo', 'la matanza', 'tres de febrero', 'caseros', 'ciudadela',
    'villa bosch', 'palomar', 'isidro casanova', 'laferrere', 'gonzalez catan', 'tapiales', 'villa madero', 'aldo bonzi', 'padua', 'paso del rey', 'general rodriguez',
    'gral rodriguez', 'lujan', 'santos lugares', 'saenz pena', 'martin coronado', 'ciudad jardin', 'villa luzuriaga', 'lomas del mirador', 'villa tesei', 'william morris',
    'villa sarmiento', 'el palomar', 'loma hermosa', 'pablo podesta', 'villa raffo', 'rafael castillo', 'virrey del pino', 'zona oeste'],
  Sur: ['avellaneda', 'lanus', 'lomas de zamora', 'banfield', 'temperley', 'adrogue', 'quilmes', 'bernal', 'berazategui', 'florencio varela', 'almirante brown', 'burzaco',
    'longchamps', 'ezeiza', 'esteban echeverria', 'monte grande', 'canning', 'gerli', 'sarandi', 'wilde', 'dock sud', 'valentin alsina', 'remedios de escalada', 'turdera',
    'llavallol', 'glew', 'claypole', 'rafael calzada', 'la plata', 'ranelagh', 'hudson', 'tristan suarez', 'luis guillon', 'villa dominico', 'piñeyro', 'pineyro',
    'jose marmol', 'don bosco', 'ensenada', 'berisso', 'city bell', 'gonnet', 'zona sur'],
};
const ORDEN: Array<Exclude<Zona, 'Interior'>> = ['CABA', 'Norte', 'Oeste', 'Sur'];
const enTexto = (t: string, palabra: string) => new RegExp(`(^|[^a-z])${palabra.replace(/[.]/g, '\\.')}([^a-z]|$)`).test(t);

function desdeTexto(s: string | null | undefined): Zona | null {
  const t = n(String(s ?? ''));
  if (!t.trim()) return null;
  // El código postal de la Ciudad: C1414…
  if (/\bc\s?1\d{3}(?:[a-z]{3})?\b/.test(t)) return 'CABA';
  // Las localidades más largas primero: «san isidro» antes que «isidro casanova», «villa martelli» antes que «villa»…
  let mejor: { z: Zona; largo: number } | null = null;
  for (const z of ORDEN) for (const p of LISTA[z]) if (p.length > (mejor?.largo ?? 0) && enTexto(t, p)) mejor = { z, largo: p.length };
  return mejor?.z ?? null;
}

export function zonaDe(x: { zona?: string | null; localidad?: string | null; direccion?: string | null }): Zona | null {
  const z = n(String(x.zona ?? '')).trim();
  if (z === 'caba' || z === 'capital') return 'CABA';
  if (z === 'norte' || z === 'noroeste') return 'Norte';
  if (z === 'oeste') return 'Oeste';
  if (z === 'sur') return 'Sur';
  if (z === 'interior' || z === 'larga distancia') return 'Interior';
  const dir = String(x.direccion ?? '');
  if (/\bC\s?1\d{3}(?:[A-Z]{3})?\b/i.test(dir)) return 'CABA';
  // De la dirección, lo que va después de la calle: «Florida 537, CABA» es CABA, no Florida (Vicente López).
  const resto = dir.includes(',') ? dir.slice(dir.indexOf(',') + 1) : '';
  return desdeTexto(x.localidad) ?? desdeTexto(resto);
}
