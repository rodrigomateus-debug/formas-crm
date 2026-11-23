// Un iconito por subcategoría de producto (pedido de Rodrigo del 19/11/2026): las mismas del catálogo con que Claude clasifica
// las consultas de Darwin (src/worker/darwin.ts, CATALOGO). Los usa Chispín para embalar en la caja los productos de un pedido
// listo para entregar y para cargarlos en el camión al entregarlo. Cada producto se reconoce por su nombre (el de la venta o
// el de ClickUp): la primera subcategoría cuyas palabras aparecen; si ninguna, la caja genérica.
// Íconos ilustrados de 24×24 («ponele más onda… que queden más lindos todos los iconos», Rodrigo, 19/11/2026): todos en el
// mismo idioma —relleno pastel, contorno azul Formas, un detalle de color y un brillito blanco— para que se lean como un
// juego y no como señales de tránsito. Los colores van fijos adentro del SVG (no heredan el del texto): por eso las fichas
// que los muestran les ponen un fondito claro, y se ven igual en tema claro y oscuro.

export interface Subcategoria { tipo: string; familia: string; plural: string; svg: string; re: RegExp }

// La paleta: el azul y el verde de Formas, los tres acentos de los papelitos del festejo y sus pasteles.
const TINTA = '#000085', VERDE = '#8ee021', CIELO = '#65a7dd', MIEL = '#f0b45a', CORAL = '#ff7d74', SOL = '#ffd76a';
const P_CIELO = '#d3e8f9', P_MIEL = '#fde4b8', P_CORAL = '#ffd6d2', P_VERDE = '#def6b6', P_LILA = '#dfe0ff', METAL = '#e4e7f5', BLANCO = '#fff';
// Las piezas: p = con contorno (y relleno si se le pasa), s = mancha de color sin contorno, t = rayita de color,
// h = brillito blanco, o = redondel con contorno, pt = puntito de tinta, g = un grupo girado alrededor del centro.
const p = (d: string, fill = 'none') => `<path d="${d}" fill="${fill}"/>`;
const s = (d: string, fill: string) => `<path d="${d}" fill="${fill}" stroke="none"/>`;
const t = (d: string, color: string, ancho = 1.4) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${ancho}"/>`;
const h = (d: string) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.5" opacity=".9"/>`;
const o = (cx: number, cy: number, r: number, fill = 'none') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const pt = (cx: number, cy: number, r = 0.95, fill = TINTA) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="none"/>`;
const g = (grados: number, ...piezas: string[]) => `<g transform="rotate(${grados} 12 12)">${piezas.join('')}</g>`;
// Un rectángulo redondeado (lo usan media docena de íconos).
const caja = (x: number, y: number, w: number, a: number, r: number, fill = 'none') => `<rect x="${x}" y="${y}" width="${w}" height="${a}" rx="${r}" fill="${fill}"/>`;

// La caja de cartón (packaging y el «otro» genérico): cambia solo el color de la cinta.
const CAJA = (cinta: string) => p('M3.5 8 12 4l8.5 4v8.5L12 20.5l-8.5-4z', P_MIEL) + p('M3.5 8 12 12l8.5-4L12 4z', '#fff3dc')
  + p('M12 12v8.5') + p('M9.9 5 18.4 9l-2.1 1L7.8 6z', cinta) + p('M16.3 10l2.1-1v2.9l-2.1 1z', cinta);

const IC: Record<string, string> = {
  Mochila: p('M9.5 5.5v-1a2.5 2.5 0 0 1 5 0v1') + p('M6 12.5H4.5v4.5H6M18 12.5h1.5V17H18', MIEL)
    + p('M6 10a4.5 4.5 0 0 1 4.5-4.5h3A4.5 4.5 0 0 1 18 10v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19z', P_MIEL)
    + p('M8.5 14.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6h-7z', MIEL) + p('M8.8 10.2h6.4') + pt(14.4, 10.2, 1.1, VERDE) + h('M10.6 16.5h2.8'),
  Bolso: p('M8.5 9V7.5A1.5 1.5 0 0 1 10 6h4a1.5 1.5 0 0 1 1.5 1.5V9') + caja(3, 9, 18, 10.5, 2.5, P_MIEL)
    + s('M6.3 9.75h2.4v9H6.3zM15.3 9.75h2.4v9h-2.4z', MIEL) + caja(3, 9, 18, 10.5, 2.5) + p('M3 12.8h18') + caja(10.6, 11.4, 2.8, 3.2, 0.7, VERDE),
  'Neceser / Cartuchera': p('M4 10h16l-.9 8.6a1.5 1.5 0 0 1-1.5 1.4H6.4a1.5 1.5 0 0 1-1.5-1.4z', P_CORAL)
    + p('M3.5 8A1.5 1.5 0 0 1 5 6.5h14A1.5 1.5 0 0 1 20.5 8v2h-17z', CORAL) + h('M6 8.3h7') + p('M16 8.3v3.6') + o(16, 13.2, 1.3, VERDE) + h('M7 13v3.5'),
  Riñonera: t('M2.4 8.8h19.2', TINTA, 3.6) + t('M2.4 8.8h19.2', MIEL, 1.5)
    + p('M5 8.8h14v4.4a6.3 6.3 0 0 1-6.3 6.3h-1.4A6.3 6.3 0 0 1 5 13.2z', P_MIEL) + s('M5.75 9.5h12.5v1.7H5.75z', MIEL)
    + p('M5 11.2h14M8 14.6h8') + pt(15.6, 14.6, 1.2, VERDE) + o(15.6, 14.6, 1.2) + h('M7.6 14.4c.3 1 .9 1.8 1.7 2.4'),
  'Billetera / Portadocumentos': p('M6 8.5V5.3h9.5v3.2', P_VERDE) + caja(3.5, 8, 17, 11.5, 2, P_MIEL) + t('M5.5 10.3h9', MIEL)
    + p('M15.2 12h5.3v3.6h-5.3a1.8 1.8 0 0 1 0-3.6z', VERDE) + pt(15.6, 13.8, 0.8) + h('M6 16.8h4'),
  'Packaging / Cajas': CAJA(VERDE),
  'Tote / Bolsa': p('M9 9V7a3 3 0 0 1 6 0v2') + p('M5.5 9h13l-.9 10.6a1 1 0 0 1-1 .9H7.4a1 1 0 0 1-1-.9z', P_VERDE)
    + p('M12 17.3c-2.2-1.4-2.9-2.5-2.9-3.5a1.5 1.5 0 0 1 2.9-.6 1.5 1.5 0 0 1 2.9.6c0 1-.7 2.1-2.9 3.5z', CORAL) + h('M7.5 11.5v2'),
  'Mate / Set matero': p('M13 8 16.3 2.6') + p('M7 11.2c0-1.3.6-2.2 1.6-2.7h6.8c1 .5 1.6 1.4 1.6 2.7 0 4.5-2 9.3-5 9.3s-5-4.8-5-9.3z', MIEL)
    + caja(7.3, 7.2, 9.4, 2.4, 1.2, METAL) + s('M10 6.4c.4-.9 1.2-1.3 2-1.3s1.6.4 2 1.3z', VERDE) + p('M10 6.9c.4-1.1 1.2-1.6 2-1.6s1.6.5 2 1.6')
    + p('M13 8 16.3 2.6') + h('M9.4 12.5c.1 1.9.6 3.6 1.3 4.8'),
  Termo: p('M16 9.8h1.4A1.6 1.6 0 0 1 19 11.4v3.2a1.6 1.6 0 0 1-1.6 1.6H16') + caja(9.3, 2.5, 5.4, 3.6, 1.2, VERDE)
    + p('M8 7.2a1.6 1.6 0 0 1 1.6-1.6h4.8A1.6 1.6 0 0 1 16 7.2v12.3a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z', P_CIELO)
    + s('M8.75 9.2h6.5v2.3h-6.5z', CIELO) + p('M8 9.2h8M8 11.5h8') + h('M10.4 13.8v5'),
  Botella: caja(9.8, 2.5, 4.4, 2.8, 1, VERDE) + p('M10 5.3h4v1.1l1.6 2.2v10.9a2 2 0 0 1-2 2h-3.2a2 2 0 0 1-2-2V8.6L10 6.4z', P_CIELO)
    + s('M9.15 12h5.7v4.6h-5.7z', CIELO) + p('M8.4 12h7.2M8.4 16.6h7.2') + h('M10.5 13.6v1.5') + h('M10.3 9v.6'),
  'Taza / Jarro': t('M8.8 2.6c0 1.2 1.1 1.2 1.1 2.5M12.4 2.6c0 1.2 1.1 1.2 1.1 2.5', CIELO, 1.5) + p('M16 10.5h1.1a2.7 2.7 0 0 1 0 5.4H16')
    + p('M5 8h11v8.5a3.5 3.5 0 0 1-3.5 3.5h-4A3.5 3.5 0 0 1 5 16.5z', P_CORAL) + s('M5.75 11h9.5v2.6h-9.5z', CORAL) + p('M5 11h11M5 13.6h11') + h('M7.4 15.6v1.2'),
  Vaso: p('M6.6 5.5h10.8l-1.2 14a1.6 1.6 0 0 1-1.6 1.5H9.4a1.6 1.6 0 0 1-1.6-1.5z', P_CIELO) + s('M7.6 10h8.8l-.45 5.2H8.05z', CIELO)
    + p('M7 10h10M7.45 15.2h9.1') + caja(5.4, 3, 13.2, 2.8, 1.2, VERDE) + h('M9.6 11.6l.2 2'),
  Remera: p('M8.5 3.5 3 6.5l2 4.2 2.5-1.2V20a.6.6 0 0 0 .6.6h7.8a.6.6 0 0 0 .6-.6V9.5l2.5 1.2 2-4.2-5.5-3c-.5 1.5-1.8 2.4-3.5 2.4S9 5 8.5 3.5z', P_CORAL)
    + s('M4.1 7.3 5.6 6.5l1.9 3-2.1 1zM19.9 7.3l-1.5-.8-1.9 3 2.1 1z', CORAL)
    + p('M8.5 3.5 3 6.5l2 4.2 2.5-1.2V20a.6.6 0 0 0 .6.6h7.8a.6.6 0 0 0 .6-.6V9.5l2.5 1.2 2-4.2-5.5-3c-.5 1.5-1.8 2.4-3.5 2.4S9 5 8.5 3.5z')
    + o(14.2, 11.3, 1.3, VERDE) + h('M9.6 12v5'),
  'Buzo / Campera': p('M8 5.5 3.5 8.2v10.3h3v2h11v-2h3V8.2L16 5.5z', P_CIELO) + p('M6.5 12v6.5M17.5 12v6.5')
    + p('M8 5.5C8 3.4 9.8 2.5 12 2.5s4 .9 4 3c0 2-1.8 3.4-4 3.4S8 7.5 8 5.5z', CIELO) + p('M9.2 15.2h5.6l1 3.6H8.2z', CIELO)
    + p('M10.9 8.8v2.6M13.1 8.8v2.6') + s('M6.5 18.9h11v1.6h-11z', CIELO) + p('M6.5 18.8h11'),
  Chaleco: p('M8.5 3.5 5.5 6v13.5a1 1 0 0 0 1 1H12v-8.3zM15.5 3.5l3 2.5v13.5a1 1 0 0 1-1 1H12v-8.3z', MIEL)
    + s('M6.25 14.4h11.5v2.2H6.25z', VERDE) + p('M5.5 14.4h13M5.5 16.6h13M12 12.2v8.3') + pt(13.6, 13, 0.7) + h('M7.4 8v3.5'),
  Gorra: p('M3.5 15.5a7.5 7.5 0 0 1 15 0z', CIELO) + p('M12.5 15.5h8.2a1.7 1.7 0 0 1 0 3.4H16c-1.9 0-3.5-1.4-3.5-3.4z', VERDE)
    + p('M11 8c2.2 1.6 3.3 4.2 3.3 7.5') + p('M11 8V6.8') + h('M6 13.5a5 5 0 0 1 2.4-3.6'),
  'Kit asado / Cocina': p('M6 3v5.4a2.5 2.5 0 0 0 5 0V3M8.5 3v10.5') + caja(7.3, 13, 2.4, 8, 1.2, MIEL)
    + p('M14.8 12.8V3c2.6 1.6 3.8 5.2 3.8 9.8z', METAL) + caja(14.8, 12.8, 2.6, 8.2, 1.3, MIEL) + h('M16.2 6.5c.5 1.2.8 2.6.9 4'),
  'Uniforme / Ropa de trabajo': p('M8.5 3.5 4 6v14a.6.6 0 0 0 .6.6h14.8a.6.6 0 0 0 .6-.6V6l-4.5-2.5L12 7z', P_CIELO)
    + p('M8.5 3.5 12 7 9.6 9.8zM15.5 3.5 12 7l2.4 2.8z', BLANCO) + p('M12 7v13.6') + caja(14.2, 12, 3.4, 3, 0.6, VERDE)
    + pt(12, 11.2, 0.75) + pt(12, 14.6, 0.75) + pt(12, 18, 0.75) + h('M6.6 12v5.5'),
  Conservadora: p('M8 6V4.6A1.6 1.6 0 0 1 9.6 3h4.8A1.6 1.6 0 0 1 16 4.6V6') + p('M4 9.5h16v9.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.9z', P_CIELO)
    + p('M3.5 7.2A1.2 1.2 0 0 1 4.7 6h14.6a1.2 1.2 0 0 1 1.2 1.2v2.3h-17z', CIELO) + caja(10.3, 8.4, 3.4, 3, 0.7, BLANCO)
    + s('M4.75 15.2h14.5v1.9H4.75z', CIELO) + h('M6.4 12v1.6'),
  Paraguas: p('M2.5 12.5a9.5 9.5 0 0 1 19 0q-1.58-1.7-3.17 0q-1.58-1.7-3.16 0q-1.59-1.7-3.17 0q-1.58-1.7-3.17 0q-1.58-1.7-3.16 0q-1.59-1.7-3.17 0z', CORAL)
    + p('M12 3Q8.9 7 8.83 12.5q1.59-1.7 3.17 0q1.58-1.7 3.17 0Q15.1 7 12 3z', P_CORAL) + p('M12 3V2M12 12.6v6.1a2 2 0 0 1-4 0', 'none')
    + h('M5.2 8.9a7 7 0 0 1 2-2.6'),
  'Toalla / Lona': caja(5.5, 4.5, 13, 15, 1, P_CIELO) + s('M6.25 13.4h11.5v2.6H6.25z', CIELO) + p('M5.5 13.4h13M5.5 16h13')
    + p('M7.5 19.5v1.7M10.5 19.5v1.7M13.5 19.5v1.7M16.5 19.5v1.7') + caja(4.3, 3.2, 15.4, 3.6, 1.6, CIELO) + h('M7.8 9v2.4'),
  Manta: p('M6.5 18v2.2M9.25 18v2.2M12 18v2.2M14.75 18v2.2M17.5 18v2.2') + caja(4, 5.5, 16, 12.5, 2, P_CORAL)
    + t('M4.8 9.6h14.4M4.8 13.9h14.4', CORAL, 1.6) + t('M9.2 6.3v10.9M14.8 6.3v10.9', CORAL, 1.6) + caja(4, 5.5, 16, 12.5, 2),
  Abanico: p('M12 20.2 3.4 9.6a11 11 0 0 1 17.2 0z', P_CORAL) + s('M5 9.9a9.4 9.4 0 0 1 14 0l-1.9 2.4a6.4 6.4 0 0 0-10.2 0z', CORAL)
    + p('M12 20.2 3.4 9.6a11 11 0 0 1 17.2 0z') + p('M12 20.2 8.2 6.3M12 20.2V5.6M12 20.2l3.8-13.9') + pt(12, 20.2, 1.5, VERDE) + o(12, 20.2, 1.5),
  Juego: g(-8, caja(4, 4, 16, 16, 3.2, P_VERDE), pt(8.3, 8.3, 1.3), pt(15.7, 8.3, 1.3), pt(12, 12, 1.5, CORAL), pt(8.3, 15.7, 1.3), pt(15.7, 15.7, 1.3), h('M6.2 11.5v2')),
  Pendrive: p('M9.5 2.5h5V8h-5z', METAL) + pt(11.1, 5.2, 0.7) + pt(12.9, 5.2, 0.7)
    + p('M8 9.6A1.6 1.6 0 0 1 9.6 8h4.8A1.6 1.6 0 0 1 16 9.6v9.9a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z', P_LILA) + s('M8.75 8.75h6.5v2.6h-6.5z', CIELO) + p('M8 11.4h8')
    + pt(12, 18, 1.3, VERDE) + o(12, 18, 1.3) + h('M10.3 13.5v2'),
  Auriculares: t('M4.6 14V12a7.4 7.4 0 0 1 14.8 0v2', TINTA, 3.4) + t('M4.6 14V12a7.4 7.4 0 0 1 14.8 0v2', P_LILA, 1.3)
    + caja(2.8, 13.2, 4.8, 7.6, 1.8, VERDE) + caja(16.4, 13.2, 4.8, 7.6, 1.8, VERDE) + h('M4.6 15.6v2.4') + h('M18.2 15.6v2.4'),
  Parlante: caja(6.5, 3, 11, 18, 2.2, P_LILA) + o(12, 14.3, 3.4, CIELO) + o(12, 14.3, 1.2, BLANCO) + o(12, 7.3, 1.4, VERDE)
    + t('M20 10c.9 1.3.9 2.7 0 4', CIELO, 1.5) + t('M4 10c-.9 1.3-.9 2.7 0 4', CIELO, 1.5),
  'Power bank / Cargador': caja(6.5, 3, 11, 18, 2.6, P_LILA) + p('M13 6.6 9.6 12.4h2.5l-1.1 5 3.5-6h-2.6z', SOL) + pt(10.4, 5.2, 0.6, CIELO) + h('M8.6 15v3'),
  'Accesorio tecnológico': p('M9.5 3v4M14.5 3v4') + p('M12 15.5v2.6a2.4 2.4 0 0 0 2.4 2.4H18') + p('M7 7h10v3.5a5 5 0 0 1-10 0z', P_LILA)
    + s('M7.75 7.75h8.5v1.9h-8.5z', CIELO) + p('M7 9.6h10') + pt(12, 12.4, 1.2, VERDE) + o(12, 12.4, 1.2),
  'Set de escritura': caja(3, 6.5, 18, 12.5, 2, P_VERDE) + p('M5.5 9.3h8.6l2.6 1.3-2.6 1.3H5.5z', CORAL) + p('M7.6 9.3v2.6')
    + p('M18.5 13.6H9.9l-2.6 1.3 2.6 1.3h8.6z', CIELO) + p('M16.4 13.6v2.6'),
  'Resaltador / Marcador': t('M3.2 20.6h7.3', SOL, 3) + g(38, p('M9 4.6A1.6 1.6 0 0 1 10.6 3h2.8A1.6 1.6 0 0 1 15 4.6V14H9z', SOL), p('M9 7h6'),
    p('M9.8 14h4.4l-.6 3h-3.2z', BLANCO), p('M10.4 17h3.2v1.9l-3.2 1.5z', VERDE), h('M11 9v3')),
  Lápiz: g(40, p('M9.5 4A1.5 1.5 0 0 1 11 2.5h2A1.5 1.5 0 0 1 14.5 4v2.2h-5z', CORAL), p('M9.5 6.2h5v2h-5z', METAL),
    p('M9.5 8.2h5V17L12 21.6 9.5 17z', SOL), p('M9.5 17h5', 'none'), s('M9.9 17.4h4.2L12 21z', '#fbe5c5'), p('M9.5 17 12 21.6 14.5 17'),
    s('M11.2 20h1.6l-.8 1.6z', TINTA), h('M11.1 10v5')),
  Bolígrafo: g(40, p('M11 2.4h2V5h-2z', VERDE), p('M14.2 6.5h1.4v5.2'), p('M9.8 5h4.4v11.2L12 20.2l-2.2-4z', CIELO),
    s('M10.5 12.6h3v3.2h-3z', P_CIELO), p('M9.8 12.6h4.4M9.8 16.2h4.4'), p('M12 20.2v1.3'), h('M11.2 7v3.6')),
  Agenda: p('M9 20v2.6l1.3-1 1.3 1V20', VERDE) + p('M5.5 3.5h12A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5h-12z', CORAL)
    + s('M6.25 4.25h1.9v15.5h-1.9z', '#e9584f') + p('M8.2 3.5v17') + caja(10.3, 7, 5.2, 3.4, 0.7, BLANCO) + t('M16.6 4.3v15.4', TINTA, 1.2),
  'Cuaderno / Libreta': p('M7 3.5h10.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H7z', P_VERDE) + s('M7.75 4.25h2.2v15.5h-2.2z', VERDE)
    + p('M7 3.5h10.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H7z') + p('M5 7h3.6M5 10.3h3.6M5 13.7h3.6M5 17h3.6') + caja(11.6, 7, 5, 3.2, 0.7, BLANCO)
    + t('M12 14h4.4M12 16.6h3', '#7ab81c', 1.2),
  Calendario: caja(4, 5, 16, 15.5, 2, BLANCO) + p('M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4z', CORAL) + p('M8 3.3v3.4M16 3.3v3.4')
    + caja(13.2, 12.6, 3.6, 3.6, 0.8, VERDE) + pt(8, 13.4, 0.9) + pt(11, 13.4, 0.9) + pt(8, 17, 0.9) + pt(11, 17, 0.9),
  'Carpeta / Portafolio': p('M3 7A1.5 1.5 0 0 1 4.5 5.5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 9.2V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z', MIEL)
    + p('M5.5 12V9.6h13V12', BLANCO) + p('M3 12.8a1.3 1.3 0 0 1 1.3-1.3h15.4a1.3 1.3 0 0 1 1.3 1.3V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z', P_MIEL)
    + caja(9.6, 14.2, 4.8, 2.4, 0.6, VERDE),
  'Accesorio de escritorio': p('M7.6 11.5V5.4L8.9 3l1.3 2.4v6.1z', CORAL) + p('M11 11.5V4.2a1.3 1.3 0 0 1 2.6 0v7.3z', CIELO) + p('M14.6 11.5V6h2.4v5.5z', SOL)
    + p('M14.6 6l1.2-2.6L17 6') + p('M6.3 11h11.4l-.9 8.6a1 1 0 0 1-1 .9H8.2a1 1 0 0 1-1-.9z', P_LILA) + s('M7.3 13.2h9.4l-.25 2.4h-8.9z', CIELO)
    + p('M6.55 13.2h10.9M6.8 15.6h10.4'),
  'Stickers / Etiquetas': p('M5.6 4h12.8A1.6 1.6 0 0 1 20 5.6V14l-6 6H5.6A1.6 1.6 0 0 1 4 18.4V5.6A1.6 1.6 0 0 1 5.6 4z', SOL)
    + p('M20 14h-4.4a1.6 1.6 0 0 0-1.6 1.6V20z', BLANCO) + pt(9, 9.6, 1.05) + pt(14.4, 9.6, 1.05) + p('M8.6 12.6c1.2 1.9 5 1.9 6.2 0')
    + pt(7.2, 12, 0.9, CORAL) + pt(16.2, 12, 0.9, CORAL),
  'Banner / Display': p('M12 16.5v4M8.2 20.5h7.6') + caja(6.5, 3, 11, 13.8, 1, CIELO) + s('M7.25 3.75h9.5v2h-9.5z', TINTA)
    + o(12, 9.3, 1.9, VERDE) + h('M9.4 13.6h5.2'),
  Impresos: p('M7.5 6.5H5v14.5h10.5v-1', P_CIELO) + p('M8 3h7.5L19.5 7v12a1 1 0 0 1-1 1H8z', BLANCO) + p('M15.5 3v4h4z', CIELO)
    + caja(10.2, 9, 3.6, 3.2, 0.6, VERDE) + t('M10.3 14.6h6.4M10.3 17.2h4.4', CIELO, 1.4),
  Kit: p('M5 12.5h14v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z', P_CORAL) + caja(3.5, 8.5, 17, 4, 1, CORAL) + s('M10.7 9.25h2.6v10.5h-2.6z', VERDE)
    + p('M10.7 8.5v12M13.3 8.5v12') + p('M12 8.5c-2 0-4.6-1-4.1-3s3.6-.6 4.1 3c.5-3.6 3.6-5 4.1-3s-2.1 3-4.1 3z', VERDE),
  Otro: CAJA(CIELO),
};

// El orden importa: las más específicas antes («bolso matero» es un bolso, «set de escritura» antes que «bolígrafo»,
// «pendrive» antes que «pen», «tarjetero» antes que «tarjeta», «kit asado» antes que «kit»).
export const SUBCATEGORIAS: Subcategoria[] = [
  // Marroquinería primero por los «bolso matero», «mochila térmica»…
  { tipo: 'Mochila', familia: 'Marroquinería', plural: 'Mochilas', re: /mochila|backpack/, svg: IC.Mochila },
  { tipo: 'Bolso', familia: 'Marroquinería', plural: 'Bolsos', re: /bolso|valija|maleta|duffel|carry ?on/, svg: IC.Bolso },
  { tipo: 'Neceser / Cartuchera', familia: 'Marroquinería', plural: 'Neceseres', re: /neceser|cartuchera|portacosmet|estuche(?! de carton)/, svg: IC['Neceser / Cartuchera'] },
  { tipo: 'Riñonera', familia: 'Marroquinería', plural: 'Riñoneras', re: /rinonera|banano|cangurera/, svg: IC.Riñonera },
  { tipo: 'Billetera / Portadocumentos', familia: 'Marroquinería', plural: 'Billeteras', re: /billetera|portadoc|tarjetero|porta ?tarjeta|monedero|pasaporte|portacredencial/, svg: IC['Billetera / Portadocumentos'] },
  // Gráfico: el packaging antes que las bolsas («bolsa de papel» es packaging).
  { tipo: 'Packaging / Cajas', familia: 'Gráfico', plural: 'Cajas', re: /packaging|\bcaja|estuche de carton|bolsa de papel|envoltorio|empaque/, svg: IC['Packaging / Cajas'] },
  { tipo: 'Tote / Bolsa', familia: 'Marroquinería', plural: 'Bolsas', re: /\btote|bolsa|ecobag|eco bag|morral/, svg: IC['Tote / Bolsa'] },
  // Drinkware
  { tipo: 'Mate / Set matero', familia: 'Drinkware', plural: 'Mates', re: /\bmate\b|matero|bombilla|yerbera/, svg: IC['Mate / Set matero'] },
  { tipo: 'Termo', familia: 'Drinkware', plural: 'Termos', re: /\btermo\b|\btermos\b|stanley/, svg: IC.Termo },
  { tipo: 'Botella', familia: 'Drinkware', plural: 'Botellas', re: /botell|caramayol|squeeze|cantimplor|hoppy/, svg: IC.Botella },
  { tipo: 'Taza / Jarro', familia: 'Drinkware', plural: 'Tazas', re: /\btaza|jarro|\bmug|pocillo/, svg: IC['Taza / Jarro'] },
  { tipo: 'Vaso', familia: 'Drinkware', plural: 'Vasos', re: /\bvaso|tumbler|\bcopa|chopp|\bshot/, svg: IC.Vaso },
  // Textil
  { tipo: 'Remera', familia: 'Textil', plural: 'Remeras', re: /remera|chomba|t-?shirt|\bpolo\b|musculosa/, svg: IC.Remera },
  { tipo: 'Buzo / Campera', familia: 'Textil', plural: 'Buzos', re: /buzo|campera|hoodie|canguro|rompeviento|sweater|parka/, svg: IC['Buzo / Campera'] },
  { tipo: 'Chaleco', familia: 'Textil', plural: 'Chalecos', re: /chaleco/, svg: IC.Chaleco },
  { tipo: 'Gorra', familia: 'Textil', plural: 'Gorras', re: /gorr|\bcap\b|visera|piluso|beanie/, svg: IC.Gorra },
  // Tiempo libre / hogar (el kit asado antes que el delantal del uniforme)
  { tipo: 'Kit asado / Cocina', familia: 'Tiempo Libre / Hogar', plural: 'Kits de asado', re: /asado|parrill|cuchill|tabla de|cocina|cubierto|sacacorch|tirabuz|\bvino|coctel/, svg: IC['Kit asado / Cocina'] },
  { tipo: 'Uniforme / Ropa de trabajo', familia: 'Textil', plural: 'Uniformes', re: /uniforme|ambo|delantal|mameluco|camisa|pantalon|ropa de trabajo|grafa/, svg: IC['Uniforme / Ropa de trabajo'] },
  { tipo: 'Conservadora', familia: 'Tiempo Libre / Hogar', plural: 'Conservadoras', re: /conservador|heladerita|cooler|lunchera|vianda/, svg: IC.Conservadora },
  { tipo: 'Paraguas', familia: 'Tiempo Libre / Hogar', plural: 'Paraguas', re: /paragua|sombrilla/, svg: IC.Paraguas },
  { tipo: 'Toalla / Lona', familia: 'Tiempo Libre / Hogar', plural: 'Toallas', re: /toall|\blona|salida de bano/, svg: IC['Toalla / Lona'] },
  { tipo: 'Manta', familia: 'Tiempo Libre / Hogar', plural: 'Mantas', re: /manta|frazada|plaid|almohad|cojin|poncho/, svg: IC.Manta },
  { tipo: 'Abanico', familia: 'Tiempo Libre / Hogar', plural: 'Abanicos', re: /abanico/, svg: IC.Abanico },
  { tipo: 'Juego', familia: 'Tiempo Libre / Hogar', plural: 'Juegos', re: /juego|pelota|frisbee|yoyo|rompecab|naipe|ajedrez|\bdado|anti ?stress|antiestres|juguete|peluche/, svg: IC.Juego },
  // Tecnología (el pendrive antes que la lapicera «pen»)
  { tipo: 'Pendrive', familia: 'Tecnología', plural: 'Pendrives', re: /pen ?drive|\busb|memoria/, svg: IC.Pendrive },
  { tipo: 'Auriculares', familia: 'Tecnología', plural: 'Auriculares', re: /auricular|headphone|earbud|airpod|vincha/, svg: IC.Auriculares },
  { tipo: 'Parlante', familia: 'Tecnología', plural: 'Parlantes', re: /parlante|speaker|bocina/, svg: IC.Parlante },
  { tipo: 'Power bank / Cargador', familia: 'Tecnología', plural: 'Cargadores', re: /power ?bank|cargador|bateria|inalambric/, svg: IC['Power bank / Cargador'] },
  { tipo: 'Accesorio tecnológico', familia: 'Tecnología', plural: 'Accesorios tecnológicos', re: /cable|adaptador|\bhub\b|pop ?socket|soporte (para )?(celular|notebook)|mouse(?! ?pad)|teclado|webcam|smart|reloj/, svg: IC['Accesorio tecnológico'] },
  // Escritura (el set antes que la lapicera)
  { tipo: 'Set de escritura', familia: 'Escritura', plural: 'Sets de escritura', re: /set (de )?escritura|kit (de )?escritura|set (de )?bolig|estuche (de )?bolig/, svg: IC['Set de escritura'] },
  { tipo: 'Resaltador / Marcador', familia: 'Escritura', plural: 'Resaltadores', re: /resaltador|marcador|\bfibra|highlighter/, svg: IC['Resaltador / Marcador'] },
  { tipo: 'Lápiz', familia: 'Escritura', plural: 'Lápices', re: /lapiz|lapices|portaminas/, svg: IC.Lápiz },
  { tipo: 'Bolígrafo', familia: 'Escritura', plural: 'Bolígrafos', re: /boligraf|birome|lapicera|roller|\bpen\b|esfero/, svg: IC.Bolígrafo },
  // Oficina
  { tipo: 'Agenda', familia: 'Oficina', plural: 'Agendas', re: /agenda|planner/, svg: IC.Agenda },
  { tipo: 'Cuaderno / Libreta', familia: 'Oficina', plural: 'Cuadernos', re: /cuaderno|libreta|anotador|\bblock|\bbloc|notebook|post-?it|notas adhesiv/, svg: IC['Cuaderno / Libreta'] },
  { tipo: 'Calendario', familia: 'Oficina', plural: 'Calendarios', re: /calendario|almanaque/, svg: IC.Calendario },
  { tipo: 'Carpeta / Portafolio', familia: 'Oficina', plural: 'Carpetas', re: /carpeta|portafolio|folder|bibliorato/, svg: IC['Carpeta / Portafolio'] },
  { tipo: 'Accesorio de escritorio', familia: 'Oficina', plural: 'Accesorios de escritorio', re: /portalapiz|lapicero|organizador|mouse ?pad|escritorio|\bregla|abrecartas|pisapapel/, svg: IC['Accesorio de escritorio'] },
  // Gráfico
  { tipo: 'Stickers / Etiquetas', familia: 'Gráfico', plural: 'Stickers', re: /sticker|etiqueta|calco|vinilo|adhesivo|\biman|\bpin\b|prendedor|parche/, svg: IC['Stickers / Etiquetas'] },
  { tipo: 'Banner / Display', familia: 'Gráfico', plural: 'Banners', re: /banner|roll ?up|display|bandera|cartel|\bstand|totem|backing|pendon/, svg: IC['Banner / Display'] },
  { tipo: 'Impresos', familia: 'Gráfico', plural: 'Impresos', re: /impres|folleto|flyer|tarjeta|volante|catalogo|revista|afiche|poster|papeleria|\bsobre/, svg: IC.Impresos },
  // Kit / combo, al final: «Kit Verano», «Box de bienvenida»…
  { tipo: 'Kit', familia: 'Kit / Combo', plural: 'Kits', re: /\bkit\b|combo|\bbox\b|set (de )?regalo|ancheta|welcome pack/, svg: IC.Kit },
];
const OTRO: Subcategoria = { tipo: 'Otro', familia: 'Otro', plural: 'Productos', svg: IC.Otro, re: /$^/ };

const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Producción filtra por familia y subfamilia cada artículo de la pantalla, varias veces por cada cambio de filtro: el
// resultado de cada nombre queda guardado (son unos cientos de nombres).
const yaVistos = new Map<string, Subcategoria>();
export function subcategoriaDe(nombre: string): Subcategoria {
  let s = yaVistos.get(nombre);
  if (!s) {
    const n = normal(nombre);
    s = SUBCATEGORIAS.find((x) => x.re.test(n)) ?? OTRO;
    if (yaVistos.size > 5000) yaVistos.clear();
    yaVistos.set(nombre, s);
  }
  return s;
}

// Las familias y sus subfamilias para elegir en un filtro (Producción, pedido de Rodrigo del 23/11/2026): en orden
// alfabético, con «Otro» (lo que no se reconoce por el nombre) al final. La subfamilia es el tipo («Botella», «Mochila»…).
const alfa = (a: string, b: string) => (a === 'Otro' ? 1 : b === 'Otro' ? -1 : a.localeCompare(b, 'es'));
export const FAMILIAS: string[] = [...new Set([...SUBCATEGORIAS, OTRO].map((s) => s.familia))].sort(alfa);
export const SUBFAMILIAS: Array<{ tipo: string; familia: string }> = [...SUBCATEGORIAS, OTRO]
  .map(({ tipo, familia }) => ({ tipo, familia }))
  .sort((a, b) => alfa(a.familia, b.familia) || alfa(a.tipo, b.tipo));

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

// El ícono como SVG suelto (para los festejos, que se dibujan fuera de React). Recibe el dibujo de la subcategoría (sub.svg).
export const svgIcono = (svg: string, size = 26) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${TINTA}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
