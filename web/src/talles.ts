// Productos con talle en las pantallas (talles.ts del Worker, docs/TALLES.md): una prenda en varios talles es un producto.
// Lo que llega del servidor trae, en cada renglón (artículo o movimiento), su `talle` y la clave `grupo` que comparten los
// talles del mismo producto, y `producto`, el nombre sin el talle. Esto los junta para mostrarlos como un renglón con el
// desglose («30 Campera Stone - Negro (XS 3 · S 4 · M 8 · L 12 · XL 3)»), en el orden de siempre de los talles.

const LETRAS = ['3XS', '2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
// El orden de un talle: las letras, después los números de menor a mayor.
export const ordenTalle = (t: string | null | undefined) => {
  if (!t) return 9999;
  const i = LETRAS.indexOf(t);
  return i >= 0 ? i : 100 + (Number(t) || 0);
};

export interface ConTalle { talle?: string | null; grupo?: string | null }
export type Junto<T> = { k: 'uno'; x: T } | { k: 'talles'; clave: string; xs: T[] };
// Los renglones con los talles de cada producto juntos (donde está el primero) y en orden. `clave`: con qué más se separa
// (por ejemplo, el lugar de entrega). Un producto con un solo talle en la lista queda como un renglón más.
export function juntarTalles<T extends ConTalle>(xs: T[], clave: (x: T) => string | null = (x) => x.grupo ?? null): Junto<T>[] {
  const out: Junto<T>[] = [];
  const de = new Map<string, number>();
  for (const x of xs) {
    const k = x.grupo ? clave(x) : null;
    const i = k != null ? de.get(k) : undefined;
    if (k != null && i != null) (out[i] as Extract<Junto<T>, { k: 'talles' }>).xs.push(x);
    else { if (k != null) de.set(k, out.length); out.push(k != null ? { k: 'talles', clave: k, xs: [x] } : { k: 'uno', x }); }
  }
  return out.map((e): Junto<T> => (e.k === 'uno' ? e : e.xs.length === 1 ? { k: 'uno', x: e.xs[0] }
    : { ...e, xs: [...e.xs].sort((a, b) => ordenTalle(a.talle) - ordenTalle(b.talle)) }));
}

const num = new Intl.NumberFormat('es-AR');
// «XS 3 · S 4 · M 8»
export const textoTalles = (xs: Array<{ talle?: string | null; cantidad?: number | null }>) =>
  xs.map((x) => `${x.talle ?? '—'}${x.cantidad != null ? ` ${num.format(x.cantidad)}` : ''}`).join(' · ');

// Para las listas de movimientos del cronograma (la tarjeta, la ruta del día, el celular): cada producto una vez, con su
// cantidad (lo que realmente va, si se anotó una demasía) y el texto con los talles.
interface MovTalle extends ConTalle { id: string; tipo: string; articulo: string; cantidad: number | null; hecho: boolean; producto?: string | null; dir?: number | null; enviado?: { cantidad: number } | null }
export function lineasMovs<T extends MovTalle>(movs: T[]) {
  return juntarTalles(movs, (m) => `${m.tipo}|${m.grupo}|${m.dir ?? ''}`).map((e) => {
    const ms = e.k === 'uno' ? [e.x] : e.xs;
    const cant = (m: T) => m.enviado?.cantidad ?? m.cantidad;
    const cantidad = ms.some((m) => cant(m) != null) ? ms.reduce((n, m) => n + (cant(m) ?? 0), 0) : null;
    const articulo = e.k === 'talles' ? ms[0].producto || ms[0].articulo : ms[0].articulo;
    const talles = e.k === 'talles' ? textoTalles(ms.map((m) => ({ talle: m.talle, cantidad: cant(m) }))) : null;
    return { key: ms[0].id, movs: ms, cantidad, articulo, talles, hecho: ms.every((m) => m.hecho),
      texto: `${[cantidad != null ? num.format(cantidad) : '', articulo].filter(Boolean).join(' ')}${talles ? ` (${talles})` : ''}` };
  });
}

// Para elegir un producto del pedido (subir un boceto o un logo, cargar un archivo de la conversación): cada producto una
// vez, sin los servicios. El de talles va con el nombre sin el talle y con el código de su primer talle, que es donde se
// guardan su boceto y su logo (los mismos que en la tarjeta de productos del pedido). Aviso de Rodrigo del 21/11/2026: al
// cargar un boceto desde el chat aparecía cada talle de la Campera Stone.
export interface RenglonPedido extends ConTalle { code: string | null; name: string; tipo?: string | null }
export function productosParaElegir(items: RenglonPedido[], grupos?: Record<string, { nombre: string }> | null) {
  const out: Array<{ key: string; nombre: string }> = [];
  const vistos = new Set<string>();
  for (const it of items) {
    const g = it.grupo ? grupos?.[it.grupo] : undefined;
    if (g) { if (vistos.has(it.grupo!)) continue; vistos.add(it.grupo!); }
    else if (it.tipo === 'servicio') continue;
    out.push({ key: it.code || it.name, nombre: g?.nombre ?? it.name });
  }
  return out;
}
