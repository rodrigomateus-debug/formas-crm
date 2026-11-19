// Un iconito por subcategoría de producto (pedido de Rodrigo del 19/11/2026): las mismas del catálogo con que Claude clasifica
// las consultas de Darwin (src/worker/darwin.ts, CATALOGO). Los usa Chispín para embalar en la caja los productos de un pedido
// listo para entregar y para cargarlos en el camión al entregarlo. Cada producto se reconoce por su nombre (el de la venta o
// el de ClickUp): la primera subcategoría cuyas palabras aparecen; si ninguna, la caja genérica.
// Íconos de línea de 24×24, como los de las etapas del pedido (components.tsx, ETAPAS_PEDIDO).

export interface Subcategoria { tipo: string; familia: string; plural: string; d: string; re: RegExp }

const CAJA = 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9';
const IMPRESO = 'M7 3.5h8l4 4v13H7zM15 3.5v4h4M10 12h6M10 15h6M10 18h4M7 6.5H5v15h11';
const JUEGO = 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01';

// El orden importa: las más específicas antes («bolso matero» es un bolso, «set de escritura» antes que «bolígrafo»,
// «pendrive» antes que «pen», «tarjetero» antes que «tarjeta», «kit asado» antes que «kit»).
export const SUBCATEGORIAS: Subcategoria[] = [
  // Marroquinería primero por los «bolso matero», «mochila térmica»…
  { tipo: 'Mochila', familia: 'Marroquinería', plural: 'Mochilas', re: /mochila|backpack/,
    d: 'M9 5V4a3 3 0 0 1 6 0v1M6 9a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v11.5H6zM9 13.5h6v4H9z' },
  { tipo: 'Bolso', familia: 'Marroquinería', plural: 'Bolsos', re: /bolso|valija|maleta|duffel|carry ?on/,
    d: 'M3 9.5h18v9H3zM8 9.5v-2A1.5 1.5 0 0 1 9.5 6h5A1.5 1.5 0 0 1 16 7.5v2M3 13h18' },
  { tipo: 'Neceser / Cartuchera', familia: 'Marroquinería', plural: 'Neceseres', re: /neceser|cartuchera|portacosmet|estuche(?! de carton)/,
    d: 'M3.5 8h17v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 11h17M15 11v3' },
  { tipo: 'Riñonera', familia: 'Marroquinería', plural: 'Riñoneras', re: /rinonera|banano|cangurera/,
    d: 'M2.5 11c3 1 6 1.5 9.5 1.5s6.5-.5 9.5-1.5M5.5 12v4a3 3 0 0 0 3 3h7a3 3 0 0 0 3-3v-4M8 15.5h8' },
  { tipo: 'Billetera / Portadocumentos', familia: 'Marroquinería', plural: 'Billeteras', re: /billetera|portadoc|tarjetero|porta ?tarjeta|monedero|pasaporte|portacredencial/,
    d: 'M3.5 6.5h15v3M3.5 6.5v12h17v-9h-17M15.5 13.5h2' },
  // Gráfico: el packaging antes que las bolsas («bolsa de papel» es packaging).
  { tipo: 'Packaging / Cajas', familia: 'Gráfico', plural: 'Cajas', re: /packaging|\bcaja|estuche de carton|bolsa de papel|envoltorio|empaque/, d: CAJA },
  { tipo: 'Tote / Bolsa', familia: 'Marroquinería', plural: 'Bolsas', re: /\btote|bolsa|ecobag|eco bag|morral/,
    d: 'M5 8.5h14l-1 12H6zM9 8.5V6a3 3 0 0 1 6 0v2.5' },
  // Drinkware
  { tipo: 'Mate / Set matero', familia: 'Drinkware', plural: 'Mates', re: /\bmate\b|matero|bombilla|yerbera/,
    d: 'M7 10c0-1.5 1-2.5 2-3h6c1 .5 2 1.5 2 3 0 5-2 10.5-5 10.5S7 15 7 10zM9 7h6M13 7l3-5' },
  { tipo: 'Termo', familia: 'Drinkware', plural: 'Termos', re: /\btermo\b|\btermos\b|stanley/,
    d: 'M9 2.5h6v2H9zM8 4.5h8v15a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2zM8 9h8M10.5 13v4' },
  { tipo: 'Botella', familia: 'Drinkware', plural: 'Botellas', re: /botell|caramayol|squeeze|cantimplor|hoppy/,
    d: 'M10 2.5h4V5l1.5 2v13a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 20V7L10 5zM8.5 11h7' },
  { tipo: 'Taza / Jarro', familia: 'Drinkware', plural: 'Tazas', re: /\btaza|jarro|\bmug|pocillo/,
    d: 'M5 7.5h11V17a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5c0 1 1 1 1 2M12 3.5c0 1 1 1 1 2' },
  { tipo: 'Vaso', familia: 'Drinkware', plural: 'Vasos', re: /\bvaso|tumbler|\bcopa|chopp|\bshot/,
    d: 'M6 4h12l-1.5 16.5h-9zM6.6 9h10.8' },
  // Textil
  { tipo: 'Remera', familia: 'Textil', plural: 'Remeras', re: /remera|chomba|t-?shirt|\bpolo\b|musculosa/,
    d: 'M8 3.5 3 6.5l2 4 2.5-1v11h9v-11l2.5 1 2-4-5-3c-.5 1.5-2 2.5-4 2.5S8.5 5 8 3.5z' },
  { tipo: 'Buzo / Campera', familia: 'Textil', plural: 'Buzos', re: /buzo|campera|hoodie|canguro|rompeviento|sweater|parka/,
    d: 'M8 4 3.5 7v12h3v-8M16 4l4.5 3v12h-3v-8M6.5 11v9.5h11V11M8 4a4 4 0 0 0 8 0M12 8v12.5' },
  { tipo: 'Chaleco', familia: 'Textil', plural: 'Chalecos', re: /chaleco/,
    d: 'M8 3.5 5 6v14.5h6V12L8 3.5zM16 3.5 19 6v14.5h-6V12l3-8.5zM11 12h2' },
  { tipo: 'Gorra', familia: 'Textil', plural: 'Gorras', re: /gorr|\bcap\b|visera|piluso|beanie/,
    d: 'M3.5 15.5a8.5 8.5 0 0 1 17 0zM20.5 15.5c1.5 0 2.5.5 2.5 1.2S21 18 19 18H5M12 7V6' },
  // Tiempo libre / hogar (el kit asado antes que el delantal del uniforme)
  { tipo: 'Kit asado / Cocina', familia: 'Tiempo Libre / Hogar', plural: 'Kits de asado', re: /asado|parrill|cuchill|tabla de|cocina|cubierto|sacacorch|tirabuz|\bvino|coctel/,
    d: 'M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M9 3v6M16.5 21V3c-2 1-3 4-3 8h3' },
  { tipo: 'Uniforme / Ropa de trabajo', familia: 'Textil', plural: 'Uniformes', re: /uniforme|ambo|delantal|mameluco|camisa|pantalon|ropa de trabajo|grafa/,
    d: 'M8.5 3.5 4 6v14.5h16V6l-4.5-2.5L12 7zM12 7v13.5M14.5 11h3v2.5h-3' },
  { tipo: 'Conservadora', familia: 'Tiempo Libre / Hogar', plural: 'Conservadoras', re: /conservador|heladerita|cooler|lunchera|vianda/,
    d: 'M3.5 9h17v10.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1zM3.5 9 5 5.5h14L20.5 9M9 5.5V4h6v1.5M3.5 13h17' },
  { tipo: 'Paraguas', familia: 'Tiempo Libre / Hogar', plural: 'Paraguas', re: /paragua|sombrilla/,
    d: 'M2.5 12a9.5 9.5 0 0 1 19 0zM12 2.5V2M12 12v6.5a2 2 0 0 1-4 0' },
  { tipo: 'Toalla / Lona', familia: 'Tiempo Libre / Hogar', plural: 'Toallas', re: /toall|\blona|salida de bano/,
    d: 'M5 4h14v4H5zM6.5 8v12.5h11V8M6.5 16h11' },
  { tipo: 'Manta', familia: 'Tiempo Libre / Hogar', plural: 'Mantas', re: /manta|frazada|plaid|almohad|cojin|poncho/,
    d: 'M4 6h16v10H4zM4 10h16M5.5 16v3M8.5 16v3M11.5 16v3M14.5 16v3M17.5 16v3' },
  { tipo: 'Abanico', familia: 'Tiempo Libre / Hogar', plural: 'Abanicos', re: /abanico/,
    d: 'M12 20 4 9a10 10 0 0 1 16 0zM12 20 8 7.5M12 20V6.5M12 20l4-12.5' },
  { tipo: 'Juego', familia: 'Tiempo Libre / Hogar', plural: 'Juegos', re: /juego|pelota|frisbee|yoyo|rompecab|naipe|ajedrez|\bdado|anti ?stress|antiestres|juguete|peluche/, d: JUEGO },
  // Tecnología (el pendrive antes que la lapicera «pen»)
  { tipo: 'Pendrive', familia: 'Tecnología', plural: 'Pendrives', re: /pen ?drive|\busb|memoria/,
    d: 'M9.5 2.5h5V8h-5zM8 8h8v11.5a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z' },
  { tipo: 'Auriculares', familia: 'Tecnología', plural: 'Auriculares', re: /auricular|headphone|earbud|airpod|vincha/,
    d: 'M4 15v-3a8 8 0 0 1 16 0v3M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z' },
  { tipo: 'Parlante', familia: 'Tecnología', plural: 'Parlantes', re: /parlante|speaker|bocina/,
    d: 'M7 3h10v18H7zM12 16a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 7h.01' },
  { tipo: 'Power bank / Cargador', familia: 'Tecnología', plural: 'Cargadores', re: /power ?bank|cargador|bateria|inalambric/,
    d: 'M7 3h10v18H7zM12.5 7.5 10 12h4l-2.5 4.5' },
  { tipo: 'Accesorio tecnológico', familia: 'Tecnología', plural: 'Accesorios tecnológicos', re: /cable|adaptador|\bhub\b|pop ?socket|soporte (para )?(celular|notebook)|mouse(?! ?pad)|teclado|webcam|smart|reloj/,
    d: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5.5' },
  // Escritura (el set antes que la lapicera)
  { tipo: 'Set de escritura', familia: 'Escritura', plural: 'Sets de escritura', re: /set (de )?escritura|kit (de )?escritura|set (de )?bolig|estuche (de )?bolig/,
    d: 'M5 21l1.5-4L15 3.5l2.5 2.5L9 19.5zM11.5 21H20M13 5.5 15.5 8' },
  { tipo: 'Resaltador / Marcador', familia: 'Escritura', plural: 'Resaltadores', re: /resaltador|marcador|\bfibra|highlighter/,
    d: 'M9 15l-4 4.5h4l1.5-1.5M9 15l7.5-11 4 3.5L13 18zM9 15l4 3' },
  { tipo: 'Lápiz', familia: 'Escritura', plural: 'Lápices', re: /lapiz|lapices|portaminas/,
    d: 'M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19zM14 6.5l3.5 3.5M5 15.5 8.5 19' },
  { tipo: 'Bolígrafo', familia: 'Escritura', plural: 'Bolígrafos', re: /boligraf|birome|lapicera|roller|\bpen\b|esfero/,
    d: 'M18.5 3.5a2.1 2.1 0 0 1 3 3L9 19l-5 1.5L5.5 15.5zM16 6l3 3' },
  // Oficina
  { tipo: 'Agenda', familia: 'Oficina', plural: 'Agendas', re: /agenda|planner/,
    d: 'M5 3.5h13a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5zM16 3.5v17M8.5 8h4M8.5 11h4' },
  { tipo: 'Cuaderno / Libreta', familia: 'Oficina', plural: 'Cuadernos', re: /cuaderno|libreta|anotador|\bblock|\bbloc|notebook|post-?it|notas adhesiv/,
    d: 'M6 3.5h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6zM9 3.5v17M4.5 7.5H7M4.5 12H7M4.5 16.5H7' },
  { tipo: 'Calendario', familia: 'Oficina', plural: 'Calendarios', re: /calendario|almanaque/,
    d: 'M4 5.5h16v15H4zM4 10h16M8 3v5M16 3v5M8 14h2M14 14h2M8 17.5h2' },
  { tipo: 'Carpeta / Portafolio', familia: 'Oficina', plural: 'Carpetas', re: /carpeta|portafolio|folder|bibliorato/,
    d: 'M3 6.5h6l2 2h10v11H3z' },
  { tipo: 'Accesorio de escritorio', familia: 'Oficina', plural: 'Accesorios de escritorio', re: /portalapiz|lapicero|organizador|mouse ?pad|escritorio|\bregla|abrecartas|pisapapel/,
    d: 'M7 11h10l-1 9.5H8zM9 11 7.5 3.5M12 11V4M15 11l1.5-6.5' },
  // Gráfico
  { tipo: 'Stickers / Etiquetas', familia: 'Gráfico', plural: 'Stickers', re: /sticker|etiqueta|calco|vinilo|adhesivo|\biman|\bpin\b|prendedor|parche/,
    d: 'M3.5 12.5V4h8.5l9 9-8.5 8.5zM8 8h.01' },
  { tipo: 'Banner / Display', familia: 'Gráfico', plural: 'Banners', re: /banner|roll ?up|display|bandera|cartel|\bstand|totem|backing|pendon/,
    d: 'M6 3h12v14H6zM12 17v4M8 21h8M9 7h6M9 10h6' },
  { tipo: 'Impresos', familia: 'Gráfico', plural: 'Impresos', re: /impres|folleto|flyer|tarjeta|volante|catalogo|revista|afiche|poster|papeleria|\bsobre/, d: IMPRESO },
  // Kit / combo, al final: «Kit Verano», «Box de bienvenida»…
  { tipo: 'Kit', familia: 'Kit / Combo', plural: 'Kits', re: /\bkit\b|combo|\bbox\b|set (de )?regalo|ancheta|welcome pack/,
    d: 'M3.5 8.5h17v4h-17zM5 12.5v8h14v-8M12 8.5v12M12 8.5c-2 0-4.5-1-4-3s3.5-.5 4 3c.5-3.5 3.5-5 4-3s-2 3-4 3' },
];
const OTRO: Subcategoria = { tipo: 'Otro', familia: 'Otro', plural: 'Productos', d: CAJA, re: /$^/ };

const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function subcategoriaDe(nombre: string): Subcategoria {
  const n = normal(nombre);
  return SUBCATEGORIAS.find((s) => s.re.test(n)) ?? OTRO;
}

// Los productos de un pedido agrupados por subcategoría, con las cantidades sumadas (para embalar uno de cada tipo).
export function agruparProductos(articulos: Array<{ nombre: string; cantidad: number | null }>) {
  const m = new Map<string, { sub: Subcategoria; cantidad: number }>();
  for (const a of articulos) {
    const sub = subcategoriaDe(a.nombre);
    const x = m.get(sub.tipo) ?? { sub, cantidad: 0 };
    x.cantidad += Number(a.cantidad) || 0;
    m.set(sub.tipo, x);
  }
  return [...m.values()];
}

// El ícono como SVG suelto (para los festejos, que se dibujan fuera de React).
export const svgIcono = (d: string, size = 26) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
