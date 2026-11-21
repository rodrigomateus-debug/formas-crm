// Productos con talle (pedido de Rodrigo del 20/11/2026). En el rubro, una prenda con talles es un solo producto: la
// «Campera Stone negra» lleva un logo, un boceto y un precio por logo, aunque Finnegans y ClickUp la tengan en un renglón
// (y una subtarea) por talle. Acá se reconoce el talle de cada renglón y se juntan los talles del mismo producto (su
// «raíz»), en el orden de siempre (2XS XS S M L XL 2XL 3XL…), para verlos como un producto con el desglose de talles.
//
// Cómo se reconoce (relevado el 20/11/2026 en el catálogo textil de formas.shop y en pedidos reales; docs/TALLES.md):
// - Del nombre: «Campera Stone X Small - Negro - Algodon 100%» (así nombra Zecat: Small, X Large, XX Large, 3 X Large…),
//   «Remera Soul Negro XS», «Talle M», «Talle 38».
// - Del SKU, según el proveedor:
//     Zecat        ZEC_99030777273·D00·D62D54   un tramo D##: D00 XS … D07 4XL, D34…D60 los numéricos. No siempre es el
//                                              primero (Buzo Hoodie Snake: D55·D00·D54) y los colores usan los mismos
//                                              códigos (D01 es S y también amarillo), así que solo vale con el nombre.
//     Zecat Cardon ZEC_99030540300759799·002   los 3 últimos dígitos: 002 XS … 008 3XL, 010 4XL.
//     Soutex       ZZ_ST_RM_JSMC_M_NE·_XS      el último tramo es el talle tal cual (también 38…60).
//     Maya (Suco)  MYA_TEX3051617·54           los 2 últimos dígitos: 54 S … 58 2XL.
//   Un proveedor nuevo con otro formato: el talle como tramo del SKU («ABC-1234-M») o un código numérico que sube con
//   el talle («…-01» S, «…-02» M), como hacen Cardon y Maya (raizComun).
// - SOLO PRENDAS: el talle se busca solo en lo textil que se viste (esPrenda: remera, chomba, buzo, campera, chaleco,
//   camisa, pantalón… o un SKU de una línea textil, Soutex o Maya TEX). Un «Moleskine Large» y un «XL», la «Botella
//   Landscape S» y la «L» o el «Bolso Medium» y el «Large» son productos distintos (otra medida), no talles.
// - SOLO TALLES (pedido de Rodrigo del 20/11/2026): se juntan únicamente los renglones que son el mismo producto, del
//   mismo color y el mismo material, y cambian solo en el talle. El nombre sin el talle tiene que ser idéntico (color y
//   material incluidos) y el SKU sin el tramo del talle también. Un color o un material distinto es otro producto: la
//   remera negra y la roja no se juntan, ni el «Gorro Trucker Fluo» en tres colores (D01D01, D85D85, D14D14: D01 ahí es
//   amarillo, y sin talle en el nombre no hay talle).
//
// Este archivo no usa nada del Worker (se prueba solo: test/talles.test.mjs). Si cambia una regla, se sube
// TALLES_VERSION y el cron vuelve a calcular todo lo guardado (completarTalles).

export const TALLES_VERSION = 1;

export type Familia = 'letra' | 'numero';
export interface Talle { talle: string; familia: Familia; orden: number }

// Las letras, en el orden del shop (data-canonical-sort de formas.shop: XS 30, S 40 … 4XL 100).
const LETRAS: Array<[string, number]> = [['3XS', 10], ['2XS', 20], ['XS', 30], ['S', 40], ['M', 50], ['L', 60], ['XL', 70], ['2XL', 80],
  ['3XL', 90], ['4XL', 100], ['5XL', 110], ['6XL', 120]];
const ORDEN_LETRA = new Map(LETRAS);
// Cómo puede venir escrita cada letra.
const ALIAS_LETRA: Record<string, string> = {
  XXXS: '3XS', XXS: '2XS', XXL: '2XL', XXXL: '3XL', XXXXL: '4XL', XXXXXL: '5XL', XXXXXXL: '6XL',
  SMALL: 'S', MEDIUM: 'M', LARGE: 'L', CHICO: 'S', MEDIANO: 'M', GRANDE: 'L',
};

const letra = (t: string): Talle => ({ talle: t, familia: 'letra', orden: ORDEN_LETRA.get(t)! });
const numero = (n: number): Talle | null => (Number.isInteger(n) && n >= 1 && n <= 70 ? { talle: String(n), familia: 'numero', orden: n } : null);

// Un talle escrito de cualquier forma («XXL», «2XL», «2 XL», «x-large», «38») → el canónico. Talle único: null.
export function talleCanonico(crudo: unknown): Talle | null {
  const s = sinAcentos(String(crudo ?? '')).toUpperCase().replace(/[\s\-_.]+/g, '');
  if (!s) return null;
  if (/^\d{1,2}$/.test(s)) return numero(Number(s));
  if (ORDEN_LETRA.has(s)) return letra(s);
  if (ALIAS_LETRA[s]) return letra(ALIAS_LETRA[s]);
  const m = s.match(/^(?:(EXTRA)|([2-6])X|(X{1,6}))?(SMALL|S|MEDIUM|M|LARGE|L)$/);
  if (m) {
    const xs = m[1] ? 1 : m[2] ? Number(m[2]) : m[3]?.length ?? 0;
    const base = m[4][0];
    if (base === 'M') return xs ? null : letra('M');
    const t = xs === 0 ? base : xs === 1 ? `X${base}` : `${xs}X${base}`;
    return ORDEN_LETRA.has(t) ? letra(t) : null;
  }
  return null;
}

// Para ordenar: primero las letras, después los números.
export const compararTalles = (a: Talle | null | undefined, b: Talle | null | undefined) =>
  (a ? (a.familia === 'letra' ? 0 : 1) : 2) - (b ? (b.familia === 'letra' ? 0 : 1) : 2) || (a?.orden ?? 0) - (b?.orden ?? 0);

// ---------- El talle en el nombre ----------

// Sin acentos y en mayúsculas, carácter por carácter (las posiciones son las mismas que en el original).
function sinAcentos(s: string) {
  return s.split('').map((c) => { const x = c.normalize('NFD').charAt(0); return x.length === 1 ? x : c; }).join('');
}
const mayus = (s: string) => sinAcentos(s).split('').map((c) => { const x = c.toUpperCase(); return x.length === 1 ? x : c; }).join('');

export interface TalleEnNombre {
  talle: Talle;
  raiz: string;      // el nombre sin el talle («Campera Stone - Negro - Algodon 100%»)
  debil: boolean;    // un número suelto («Pantalón Cargo 34 - Beige»): solo vale si el SKU lo confirma
}
// «Talle M», «Talla: 38», «T. XL».
const EXPLICITO = /(?<![A-Z0-9])(?:TALLES?|TALLA|TALL\.|T\.)\s*:?\s*(?:N[°º]?\s*)?([A-Z0-9]{1,7})(?![A-Z0-9])/g;
// «X Small», «XX Large», «3 X Large», «Extra Large», «Medium».
const PALABRA = /(?<![A-Z0-9])(?:EXTRA[\s\-]*|[2-6]\s*X[\s\-]*|X{1,5}[\s\-]*)?(?:SMALL|MEDIUM|LARGE)(?![A-Z0-9])/g;
// «XS», «2XL», «XXL», «S», «M», «L». No «M/C» ni «M/L» (manga corta, manga larga), ni «S.A.», ni la de «Sol's».
const LETRA = /(?<![A-Z0-9/'’´`])(?:X{0,5}[SL]|[2-6]\s?X[SL]|M)(?![A-Z0-9/]|\.[A-Z])/g;
// Un número suelto justo antes de « - » (el formato de Zecat: «Pantalón Cargo Unisex 34 - Beige - …»).
const NUMERO = /(?<![A-Z0-9.,/])(\d{1,2})(?=\s*-\s)/g;

function ultimo(re: RegExp, u: string, ok: (m: RegExpExecArray) => boolean = () => true) {
  let r: RegExpExecArray | null = null;
  re.lastIndex = 0;
  for (let m = re.exec(u); m; m = re.exec(u)) if (ok(m)) r = m;
  return r;
}

export function talleDeNombre(nombre: string | null | undefined): TalleEnNombre | null {
  const original = String(nombre ?? '');
  if (!original.trim()) return null;
  const u = mayus(original);
  const quitar = (desde: number, hasta: number) => limpiarNombre(original.slice(0, desde) + ' ' + original.slice(hasta));
  // 1. Dicho con todas las letras: «Talle M».
  const e = ultimo(EXPLICITO, u, (m) => !!talleCanonico(m[1]));
  if (e) return { talle: talleCanonico(e[1])!, raiz: quitar(e.index, e.index + e[0].length), debil: false };
  // 2. En palabras, como Zecat: «X Small», «XX Large».
  const p = ultimo(PALABRA, u, (m) => !!talleCanonico(m[0]));
  if (p) return { talle: talleCanonico(p[0])!, raiz: quitar(p.index, p.index + p[0].length), debil: false };
  // 3. La letra: la última que aparece (no la de «1 L» o «500 M», que son medidas).
  const l = ultimo(LETRA, u, (m) => !!talleCanonico(m[0]) && !(m[0].length === 1 && /\d\s*$/.test(u.slice(0, m.index))));
  if (l) return { talle: talleCanonico(l[0])!, raiz: quitar(l.index, l.index + l[0].length), debil: false };
  // 4. Un número suelto antes de « - »: débil (puede ser el modelo, «Gorro 36»).
  const n = ultimo(NUMERO, u, (m) => !!numero(Number(m[1])));
  if (n) return { talle: numero(Number(n[1]))!, raiz: quitar(n.index, n.index + n[0].length), debil: true };
  return null;
}

// El nombre sin el talle, prolijo: sin espacios de más, guiones repetidos ni paréntesis vacíos.
export function limpiarNombre(s: string) {
  return s.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/(\s*-\s*){2,}/g, ' - ').replace(/^[\s\-–,:]+|[\s\-–,:]+$/g, '').trim();
}
// El nombre del producto sin el talle («Campera Stone - Negro - Algodon 100%»), para mostrar el grupo.
export const nombreSinTalle = (nombre: string) => talleDeNombre(nombre)?.raiz || limpiarNombre(nombre);
// Para comparar nombres: minúsculas, sin acentos ni signos.
export const claveNombre = (s: string) => sinAcentos(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- Solo prendas ----------

// Lo que se viste y viene en talles. Sin «polo» (hay gorros y sombreros «Polo»), «polar» (mantas polar), «canguro» (también
// es la riñonera), «campero» (el mate) ni «gorro».
const PRENDA = /(?<![A-Z])(REMERAS?|CHOMBAS?|BUZOS?|CAMPERAS?|CAMPERON(ES)?|CHALECOS?|CAMISAS?|CAMISETAS?|MUSCULOSAS?|POLERAS?|PANTALON(ES)?|BERMUDAS?|SHORTS?|JOGGERS?|CALZAS?|LEGGINGS?|SWEATERS?|SUETERS?|CARDIGANS?|HOODIES?|ROMPEVIENTOS?|WINDBREAKERS?|SOFTSHELLS?|PARKAS?|CHAQUETAS?|CHAQUETILLAS?|CASACAS?|BLAZERS?|VESTIDOS?|POLLERAS?|FALDAS?|OVEROL(ES)?|MAMELUCOS?|AMBO|GUARDAPOLVOS?|DELANTAL(ES)?|FILIPINAS?|UNIFORMES?|PIJAMAS?|GUANTES?|T-?SHIRTS?|SWEATSHIRTS?|JACKETS?)(?![A-Z])/;
const SKU_TEXTIL = /^((ZZ_)?ST_|MYA_TEX)/;
export function esPrenda(nombres: Array<string | null | undefined>, sku?: string | null) {
  return SKU_TEXTIL.test(skuLimpio(sku)) || nombres.some((n) => PRENDA.test(mayus(String(n ?? ''))));
}

// ---------- El talle en el SKU ----------

export interface TalleEnSku { talle: Talle; raiz: string; seguro: boolean }
const ZECAT_LETRA: Record<string, string> = { XS: 'D00', S: 'D01', M: 'D02', L: 'D03', XL: 'D04', '2XL': 'D05', '3XL': 'D06', '4XL': 'D07' };
const CARDON: Record<string, string> = { '002': 'XS', '003': 'S', '004': 'M', '005': 'L', '006': 'XL', '007': '2XL', '008': '3XL', '010': '4XL' };
const MAYA: Record<string, string> = { '54': 'S', '55': 'M', '56': 'L', '57': 'XL', '58': '2XL' };
export const skuLimpio = (s: unknown) => String(s ?? '').trim().toUpperCase();
export const esGenerico = (sku: string | null | undefined) => /_GE(_|$)/i.test(sku ?? '');

// El talle que dice el SKU por sí solo (`seguro`: el formato del proveedor no deja dudas). Zecat de siempre no está acá:
// sus códigos de talle son también de colores (raicesSku lo resuelve con el talle del nombre).
export function talleDeSku(sku: string | null | undefined): TalleEnSku | null {
  const s = skuLimpio(sku);
  if (!s || esGenerico(s)) return null;
  let m = s.match(/^((?:ZZ_)?ST_.+)_([A-Z0-9]{1,5})$/);   // Soutex
  if (m && talleCanonico(m[2])) return { talle: talleCanonico(m[2])!, raiz: m[1], seguro: true };
  m = s.match(/^(ZEC_\d{17})(\d{3})$/);                     // Zecat Cardon
  if (m && CARDON[m[2]]) return { talle: letra(CARDON[m[2]]), raiz: m[1], seguro: true };
  m = s.match(/^(MYA_TEX\d{7})(\d{2})$/);                   // Maya (Suco)
  if (m && MAYA[m[2]]) return { talle: letra(MAYA[m[2]]), raiz: m[1], seguro: true };
  m = s.match(/^(.+[A-Z0-9])[_\-.]((?:X{0,5}|[2-6])[SL]|M)$/);   // otro, con el talle en letras al final: hay que confirmarlo
  if (m && talleCanonico(m[2])) return { talle: talleCanonico(m[2])!, raiz: m[1], seguro: false };
  return null;
}

// El SKU sin el talle, sabiendo cuál es el talle. Puede haber más de una posibilidad (Zecat: «D01D01» con talle S, ¿cuál
// es el talle y cuál el color?); `confirmado`: se encontró el talle en el SKU. Sin SKU o genérico, ''.
export function raicesSku(sku: string | null | undefined, talle: Talle): { raices: string[]; confirmado: boolean } {
  const s = skuLimpio(sku);
  if (!s || esGenerico(s)) return { raices: [''], confirmado: false };
  const t = talleDeSku(s);
  if (t && t.talle.talle === talle.talle) return { raices: [t.raiz], confirmado: true };
  const z = s.match(/^(ZEC_\d{11})((?:D\d\d)+)$/);
  if (z) {
    const codigo = talle.familia === 'letra' ? ZECAT_LETRA[talle.talle] : `D${talle.talle.padStart(2, '0')}`;
    const tramos = z[2].match(/D\d\d/g)!;
    const raices = tramos.flatMap((x, i) => (x === codigo ? [z[1] + tramos.map((y, j) => (j === i ? 'D··' : y)).join('')] : []));
    if (raices.length) return { raices, confirmado: true };
  }
  // Otro proveedor: un tramo del SKU (entre «_», «-», «.» o espacios) que es ese mismo talle («ABC-1234-M», «ABC_M_NE»).
  // Solo se saca ese tramo: lo demás (modelo, color, material) queda en la raíz.
  const tramos = s.split(/([_\-. ])/);
  const raices = tramos.flatMap((x, i) => (i % 2 === 0 && i > 0 && talleCanonico(x)?.talle === talle.talle ? [tramos.map((y, j) => (j === i ? '·' : y)).join('')] : []));
  if (raices.length) return { raices, confirmado: true };
  return { raices: [s], confirmado: false };
}

// Para un proveedor que no se conoce, con el talle como código numérico (como Cardon y Maya): SKU iguales salvo unos
// dígitos en el mismo lugar, que suben con el talle de a poco («ABC-7781-01» S, «ABC-7781-02» M, «ABC-7781-04» XL). Un
// color no se comporta así. La raíz: lo común, con «*» donde cambia. Null si no es claramente el talle.
export function raizComun(skus: string[], talles: Talle[]): string | null {
  if (skus.length < 2 || skus.length !== talles.length || skus.some((s) => !s) || new Set(skus).size !== skus.length) return null;
  if (new Set(talles.map((t) => `${t.familia}${t.talle}`)).size !== talles.length) return null;
  let p = 0;
  while (skus.every((s) => p < s.length && s[p] === skus[0][p])) p++;
  // El código entero (si cortó a mitad de un número, desde donde empieza).
  while (p > 0 && /\d/.test(skus[0][p - 1]) && skus.every((s) => /\d/.test(s[p] ?? ''))) p--;
  let q = 0;
  while (skus.every((s) => q < s.length - p && s[s.length - 1 - q] === skus[0][skus[0].length - 1 - q])) q++;
  if (p < 6) return null;
  const medios = skus.map((s) => s.slice(p, s.length - q));
  if (medios.some((m) => !/^\d{1,3}$/.test(m))) return null;
  // En el orden de los talles, el código sube: entre un talle y el siguiente, de 1 a 2 por cada talle de distancia.
  const rango = (t: Talle) => (t.familia === 'letra' ? LETRAS.findIndex(([x]) => x === t.talle) : t.orden);
  const orden = talles.map((t, i) => ({ r: rango(t), n: Number(medios[i]) })).sort((a, b) => a.r - b.r);
  for (let i = 1; i < orden.length; i++) {
    const pasos = orden[i].r - orden[i - 1].r, dif = orden[i].n - orden[i - 1].n;
    if (pasos <= 0 || dif < pasos || dif > 2 * pasos) return null;
  }
  return `${skus[0].slice(0, p)}*${skus[0].slice(skus[0].length - q)}`;
}

// La raíz de un SKU con talle: el SKU sin el talle («ZEC_99030777273D··D62D54», «ZZ_ST_RM_JSMC_M_NE»), la misma para todos
// los talles del producto (y distinta para otro color o material). Con el talle del renglón (o del artículo) y, si se
// juntó con otros talles, la clave de ese grupo (que resuelve los SKU ambiguos de Zecat y los de un proveedor que no se
// conoce). Sin talle, null: las notas de producto se atan a la raíz (notasproducto.ts).
export function raizTalle(sku: string | null | undefined, talle: string | null | undefined, grupo?: string | null): string | null {
  const t = talleCanonico(talle);
  if (!t || !skuLimpio(sku) || esGenerico(sku)) return null;
  const g = grupo && !grupo.startsWith('n:') ? grupo.replace(/#\d+$/, '') : null;
  const r = raicesSku(sku, t);
  if (r.confirmado) return g && r.raices.includes(g) ? g : r.raices[0];
  return g;
}

// ---------- Agrupar ----------

export interface ItemTalle {
  id: string;
  nombres: Array<string | null | undefined>;   // el nombre (y otros posibles: el de la venta, la descripción); vale el primero con talle
  sku?: string | null;
  orden?: number;                              // la posición en el pedido o en el PDV
}
export interface GrupoTalles { clave: string; nombre: string; ids: string[] }   // ids en el orden de los talles
export interface Agrupado { talles: Map<string, Talle>; grupoDe: Map<string, string>; grupos: GrupoTalles[] }

// Los talles de una lista de productos (los renglones de un pedido o los artículos de un PDV) y cuáles van juntos.
export function agruparTalles(items: ItemTalle[]): Agrupado {
  const talles = new Map<string, Talle>();
  const grupoDe = new Map<string, string>();
  const grupos: GrupoTalles[] = [];
  type Info = { it: ItemTalle; talle: Talle; nombre: string; debil: boolean; seguro: TalleEnSku | null; orden: number };
  const infos: Info[] = [];
  items.forEach((it, i) => {
    const nombres = it.nombres.map((n) => String(n ?? '').trim()).filter(Boolean);
    // Solo lo textil que se viste: el resto no tiene talles, aunque diga «Large» o «S» (otra medida, otro producto).
    if (!esPrenda(nombres, it.sku)) return;
    const conTalle = nombres.map((n) => ({ n, t: talleDeNombre(n) })).find((x) => x.t);
    const sku = talleDeSku(it.sku);
    const seguro = sku?.seguro ? sku : null;
    // Lo que dice el SKU de un proveedor conocido manda (es lo que se pide y se entrega); si no, el nombre.
    const talle = seguro?.talle ?? conTalle?.t?.talle ?? null;
    if (!talle) return;
    talles.set(it.id, talle);
    infos.push({ it, talle, nombre: conTalle ? conTalle.t!.raiz : nombres[0] ?? '', debil: !seguro && !!conTalle?.t?.debil, seguro, orden: it.orden ?? i });
  });
  // Los del mismo nombre sin el talle.
  const porNombre = new Map<string, Info[]>();
  for (const x of infos) { const k = claveNombre(x.nombre); if (!k) continue; const l = porNombre.get(k) ?? []; l.push(x); porNombre.set(k, l); }
  for (const [kNombre, lista] of porNombre) {
    if (lista.length < 2) continue;
    // El SKU sin el talle de cada uno: la posibilidad que comparten más (Zecat con talle y color del mismo código).
    const cand = lista.map((x) => (x.seguro ? { raices: [x.seguro.raiz], confirmado: true } : raicesSku(x.it.sku, x.talle)));
    const veces = new Map<string, number>();
    cand.forEach((c) => [...new Set(c.raices)].forEach((r) => veces.set(r, (veces.get(r) ?? 0) + 1)));
    const raiz = cand.map((c) => c.raices.reduce((a, b) => ((veces.get(b) ?? 0) > (veces.get(a) ?? 0) ? b : a)));
    // Un proveedor sin formato conocido: los que quedaron con el SKU entero y solos, si se parecen entre sí.
    const sueltos = lista.map((_, i) => i).filter((i) => !cand[i].confirmado && raiz[i] !== '' && !lista[i].debil && (veces.get(raiz[i]) ?? 0) === 1);
    const comun = raizComun(sueltos.map((i) => raiz[i]), sueltos.map((i) => lista[i].talle));
    if (comun) for (const i of sueltos) { raiz[i] = comun; cand[i].confirmado = true; }
    // Cada grupo, los de la misma raíz del SKU. Los que no tienen SKU (o es genérico) van solo entre ellos: sin SKU no se
    // puede confirmar que sean del mismo color, así que vale el nombre (idéntico salvo el talle).
    const subgrupos = new Map<string, Info[]>();
    lista.forEach((x, i) => {
      const r = raiz[i];
      // Un número suelto en el nombre solo vale si el SKU lo confirma.
      if (x.debil && (r === '' || !cand[i].confirmado)) return;
      const l = subgrupos.get(r) ?? []; l.push(x); subgrupos.set(r, l);
    });
    for (const [r, miembros] of subgrupos) {
      // El mismo talle dos veces (el producto con dos logos): se separan en tandas seguidas, si cada una tiene sus talles.
      const ordenados = [...miembros].sort((a, b) => a.orden - b.orden);
      const tandas: Info[][] = [[]];
      for (const x of ordenados) {
        const cur = tandas[tandas.length - 1];
        if (cur.some((y) => y.talle.talle === x.talle.talle)) tandas.push([x]); else cur.push(x);
      }
      if (tandas.length > 1 && tandas.some((t) => t.length < 2)) continue;
      tandas.forEach((t, k) => {
        if (t.length < 2) return;
        const clave = `${(r || `n:${kNombre}`).slice(0, 120)}${tandas.length > 1 ? `#${k + 1}` : ''}`;
        const porTalle = [...t].sort((a, b) => compararTalles(a.talle, b.talle) || a.orden - b.orden);
        grupos.push({ clave, nombre: limpiarNombre(porTalle[0].nombre), ids: porTalle.map((x) => x.it.id) });
        for (const x of t) grupoDe.set(x.it.id, clave);
      });
    }
  }
  return { talles, grupoDe, grupos };
}

// ---------- El costo del logo de un producto con talles ----------

// Lo que se tomó para el logo en la cotización (costoslogo.ts), del producto entero. El STP prorratea el setup en cada
// talle por separado (PDV 31725: «$79.999/u» en 3 XS y «$29.999/u» en 8 M, los dos $239.998): si todos los talles traen
// el mismo setup total, es uno solo y se reparte entre todas las unidades.
export interface CostoLogoTalles { logo: number; setup: number; cantidad: number | null; fuente: 'costos' | 'pedido'; setup_una_vez?: boolean }
export function costoLogoDeGrupo(costos: Array<{ logo: number; setup: number; cantidad: number | null; fuente: 'costos' | 'pedido' } | null | undefined>,
  cantidades: Array<number | null>): CostoLogoTalles | null {
  const filas = costos.map((c, i) => (c ? { c, q: c.cantidad ?? cantidades[i] ?? 0 } : null)).filter((x): x is NonNullable<typeof x> => !!x && x.q > 0);
  if (!filas.length) return null;
  const total = filas.reduce((n, x) => n + x.q, 0);
  const logo = filas.reduce((n, x) => n + x.c.logo * x.q, 0);
  const setups = filas.map((x) => x.c.setup * x.q);
  const max = Math.max(...setups);
  const unaVez = filas.length > 1 && max > 0 && setups.every((s) => Math.abs(s - max) <= Math.max(1, max * 0.01));
  const setup = unaVez ? max : setups.reduce((a, b) => a + b, 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { logo: r2(logo / total), setup: r2(setup / total), cantidad: total, fuente: filas[0].c.fuente, ...(unaVez ? { setup_una_vez: true } : {}) };
}
