import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { http, useMeta, useToast, Icon, fmtDate, fmtRelative, fmtMoney, userOf, CINTA, type Stage } from './lib';
import { UserAvatar, etapaPedidoSlug } from './components';
import { agruparProductos, svgIcono, type Subcategoria } from './iconosProducto';

// Chispín (pedido de Rodrigo del 19/11/2026; src/worker/ideas.ts, docs/IDEAS.md): el personaje de abajo a la derecha del Hub,
// que junta las ideas para mejorarlo. Es una «forma» que cambia de forma (Formas), con una lamparita arriba que se prende
// cuando hay ideas nuevas. Sigue el mouse con los ojos, parpadea, se duerme si nadie lo mira, festeja cuando se hace una
// idea tuya y, de vez en cuando, dice algo. Se puede esconder (queda espiando desde el borde).
// Adentro: proponer (avisa si ya hay una parecida, para votarla en vez de repetirla), el ranking por votos, lo que está en
// marcha y lo hecho, con quién lo propuso. Los administradores las marcan («en marcha», «hecha», «no va») con una respuesta.

export interface Idea {
  id: number; texto: string; user_id: number; estado: 'pendiente' | 'en_curso' | 'hecha' | 'descartada'; respuesta: string | null;
  estado_at: string | null; estado_por: number | null; created_at: string; updated_at: string | null;
  votos: number; votantes: number[]; votada: boolean; puede_editar: boolean;
}
type Pestana = 'ranking' | 'hechas' | 'mias';

// ---------- Lo que se recuerda en este navegador (si no se puede, se arranca de cero) ----------
const leer = (k: string) => { try { return localStorage.getItem(`chispin.${k}`); } catch { return null; } };
const guardar = (k: string, v: string) => { try { localStorage.setItem(`chispin.${k}`, v); } catch { /* sin almacenamiento */ } };

// ---------- Abrir el buzón desde otro lado (la campanita) ----------
let abrirDesdeAfuera: ((id?: number) => void) | null = null;
export function abrirChispin(id?: number) { abrirDesdeAfuera?.(id); }
// Los anteojos de sol (al proponer o votar): lo llaman el buzón y los botones de votar.
let fachaDesdeAfuera: (() => void) | null = null;
const conFacha = () => fachaDesdeAfuera?.();

const FRASES = [
  '¿Algo del Hub te hace renegar? Contámelo y lo arreglamos.',
  'Las ideas más votadas se hacen primero. ¿Ya votaste?',
  'Me alimento de ideas. Tengo un hambre… 🍽️',
  'Si hacés algo a mano todos los días, capaz se puede automatizar. Contame.',
  'Psst… hay ideas de tus compañeros esperando tu voto.',
  'Ninguna idea es chica. Las chicas se hacen más rápido 😉',
];
const EJEMPLOS = [
  'Ej.: que en Pedidos se pueda filtrar por fecha de entrega',
  'Ej.: que me avise cuando un cliente no contesta hace 3 días',
  'Ej.: ver el remito sin tener que descargarlo',
  'Ej.: un botón para copiar los datos del cliente y pegarlos en un mail',
];

// Ideas parecidas a lo que se está escribiendo: palabras de 4 letras o más en común (sin las de relleno).
const RELLENO = new Set(['para', 'que', 'como', 'cuando', 'donde', 'esto', 'esta', 'este', 'estos', 'estas', 'poder', 'pueda', 'puedan', 'tener', 'tenga',
  'hacer', 'haga', 'sería', 'seria', 'bueno', 'bueno', 'estaría', 'estaria', 'mejor', 'todos', 'todas', 'cada', 'desde', 'hasta', 'sobre', 'entre', 'hubo', 'algo', 'mismo', 'misma']);
const palabras = (s: string) => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9ñ]+/)
  .filter((w) => w.length >= 4 && !RELLENO.has(w)).map((w) => w.replace(/(es|s)$/, '')));
function parecidas(texto: string, ideas: Idea[]) {
  const a = palabras(texto);
  if (a.size < 2) return [];
  return ideas.filter((i) => i.estado === 'pendiente' || i.estado === 'en_curso')
    .map((i) => { const b = palabras(i.texto); const comunes = [...a].filter((w) => b.has(w)).length; return { i, comunes, peso: comunes / Math.min(a.size, b.size || 1) }; })
    .filter((x) => x.comunes >= 2 && x.peso >= 0.34).sort((x, y) => y.peso - x.peso).slice(0, 3).map((x) => x.i);
}

// ---------- Papelitos de colores ----------
const reducido = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function festejar(desde?: HTMLElement | null) {
  if (reducido()) return;
  const r = desde?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth - 60, y = r ? r.top + r.height / 2 : innerHeight - 60;
  const capa = document.createElement('div');
  capa.className = 'chispin-papelitos';
  capa.style.left = `${x}px`; capa.style.top = `${y}px`;
  for (let k = 0; k < 34; k++) {
    const p = document.createElement('i');
    const ang = (-160 + Math.random() * 140) * (Math.PI / 180), dist = 70 + Math.random() * 150;
    p.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    p.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
    p.style.setProperty('--d', `${Math.random() * 120}ms`);
    p.dataset.c = String(k % 5);
    capa.appendChild(p);
  }
  document.body.appendChild(capa);
  setTimeout(() => capa.remove(), 1600);
}

// ---------- Negocio ganado (pedido de Rodrigo del 19/11/2026) ----------
// Cuando un negocio pasa a una etapa ganada (tablero, ficha, vista previa o celular), llueven papelitos por toda la
// pantalla y Chispín salta y te felicita por tu nombre. Si el negocio es de otra persona (una gerente que lo mueve),
// felicita a esa persona.
export interface NegocioGanado { nombre: string; monto?: unknown; moneda?: string; duenio?: unknown }
let ganadoDesdeAfuera: ((n: NegocioGanado, tipo: 'ganado' | 'anticipo') => void) | null = null;
// Solo «Cierre ganado» (no otras etapas que cuentan como ganadas, como «Lead calificado» o «Pedido completo»).
export const esGanada = (s?: Stage | null) => !!s?.is_closed && !!s?.is_won && /ganad/i.test(s.label);
// Para llamar después de guardar el cambio de etapa: festeja solo si entra a ganada desde una que no lo era.
export function siGano(antes: Stage | null | undefined, despues: Stage | null | undefined, n: NegocioGanado) {
  if (esGanada(despues) && !esGanada(antes)) festejarGanado(n);
}
export function festejarGanado(n: NegocioGanado) {
  lluvia();
  ganadoDesdeAfuera?.(n, 'ganado');
}

// ---------- Entró el anticipo (pedido de Rodrigo del 19/11/2026) ----------
// Cuando un pedido sale de «$ Pendiente de anticipo» hacia una etapa posterior (boceto, producción, entrega…), Chispín se
// pone los anteojos de sol, saca un fajo y tira billetes como en el meme, mientras llueve plata por toda la pantalla.
// No festeja si vuelve a «Pedido confirmado» ni si se anula.
const ANTICIPO = '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03';
const DESPUES_DEL_ANTICIPO = new Set(['boceto-digital', 'listo-produccion', 'esperando', 'produccion', 'listo-entregar', 'parcial', 'entregado']);
// Para llamar después de guardar una propiedad de un registro (tablero, ficha, vista previa, lista, celular).
export function siFestejaPedido(tipo: string, prop: string, antes: unknown, despues: unknown, rec: { name: string; props: Record<string, any> }) {
  if (tipo !== 'order' || prop !== 'hs_pipeline_stage' || String(antes ?? '') === String(despues ?? '')) return;
  // Listo para entregar o entregado: si es suyo, Chispín lo encuentra enseguida (y si es de otra, en la pantalla de ella).
  if (['listo-entregar', 'entregado'].includes(etapaPedidoSlug(despues) ?? '')) { setTimeout(() => revisarDesdeAfuera?.(), 600); return; }
  if (String(antes ?? '') !== ANTICIPO || !DESPUES_DEL_ANTICIPO.has(etapaPedidoSlug(despues) ?? '')) return;
  lluvia(true);
  ganadoDesdeAfuera?.({ nombre: rec.name, monto: rec.props.hs_total_price, moneda: rec.props.hs_currency_code, duenio: rec.props.owner_id }, 'anticipo');
}

function lluvia(plata = false) {
  if (reducido()) return;
  const capa = document.createElement('div');
  capa.className = `chispin-lluvia${plata ? ' plata' : ''}`;
  const cuantos = plata ? Math.max(24, Math.min(60, Math.round(innerWidth / 26))) : Math.max(50, Math.min(150, Math.round(innerWidth / 9)));
  for (let k = 0; k < cuantos; k++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.setProperty('--x', `${Math.random() * 160 - 80}px`);
    p.style.setProperty('--r', `${(Math.random() * 1080 - 540) * (plata ? 0.4 : 1)}deg`);
    p.style.setProperty('--d', `${Math.random() * (plata ? 2600 : 900)}ms`);
    p.style.setProperty('--t', `${(plata ? 3 : 2) + Math.random() * 1.6}s`);
    if (plata) p.textContent = '$'; else p.dataset.c = String(k % 5);
    capa.appendChild(p);
  }
  document.body.appendChild(capa);
  setTimeout(() => capa.remove(), plata ? 7600 : 4800);
}

// Un puñado de billetes que salen de la mano de Chispín (o de la esquina, si no está), suben en arco y caen.
function tirarPlata(desde?: HTMLElement | null) {
  if (reducido()) return;
  const r = desde?.getBoundingClientRect();
  const x = r ? r.left + r.width * 0.85 : innerWidth - 40, y = r ? r.top + r.height * 0.55 : innerHeight - 70;
  const capa = document.createElement('div');
  capa.className = 'chispin-plata';
  capa.style.left = `${x}px`; capa.style.top = `${y}px`;
  for (let k = 0; k < 5; k++) {
    const b = document.createElement('i');
    b.textContent = '$';
    b.style.setProperty('--dx', `${-(60 + Math.random() * Math.min(420, innerWidth * 0.45))}px`);
    b.style.setProperty('--alto', `${-(110 + Math.random() * 200)}px`);
    b.style.setProperty('--cae', `${innerHeight - y + 40}px`);
    b.style.setProperty('--r', `${Math.random() * 500 - 250}deg`);
    b.style.setProperty('--d', `${k * 40}ms`);
    capa.appendChild(b);
  }
  document.body.appendChild(capa);
  setTimeout(() => capa.remove(), 2600);
}
// ---------- Pedido listo para entregar: la caja / entregado: el camión (pedido de Rodrigo del 19/11/2026) ----------
// Los mueve casi siempre ClickUp, así que Chispín los busca (GET /pedidos/festejos, src/worker/festejos.ts) y los festeja en
// la pantalla de la dueña del pedido. Los productos que se embalan (o que van en el camión) son los del pedido, uno por
// subcategoría con su iconito (iconosProducto.ts): si lleva botellas y mochilas, se embalan una botella y una mochila.
export interface FestejoPedido {
  id: number; name: string; etapa: 'listo' | 'entregado'; at: string; monto: number | null; moneda: string | null;
  articulos: Array<{ nombre: string; cantidad: number | null }>; hizo: Array<{ nombre: string; user_id: number | null }>;
}
let revisarDesdeAfuera: (() => void) | null = null;
type Grupo = { sub: Subcategoria; cantidad: number };
const MAX_EN_CAJA = 6;
// El iconito va más grande en la caja y en el camión (ahí se luce el dibujo) y chiquito en las fichas de la lista.
const TAM_ICONO: Record<string, number> = { 'emb-item': 40, 'cam-item': 22 };
const fichaProducto = (g: Grupo, clase: string) => {
  const i = document.createElement('i');
  i.className = clase;
  i.title = g.sub.tipo;
  i.innerHTML = svgIcono(g.sub.svg, TAM_ICONO[clase] ?? 17);
  return i;
};
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
// El moño de Formas (el isotipo, CINTA) como SVG suelto, para el sticker de la caja y el costado del camión.
const monio = (color: string, ancho: number) =>
  `<svg viewBox="78 221 544 258" width="${ancho}" height="${Math.round(ancho * 258 / 544 * 10) / 10}" aria-hidden="true"><path d="${CINTA}" fill="${color}"/></svg>`;

// La caja: aparece abierta, caen los productos uno por uno, se cierran las solapas, la cinta, el sello «LISTO ✓» y vuela a Chispín.
// Con más onda («ponele un poco más de onda al camioncito, cajita e iconitos», Rodrigo, 19/11/2026): cartón kraft con el sticker
// del moño y las flechitas de «este lado arriba», los productos rebotan al caer (y la caja acusa el golpe), pega un saltito
// de contenta cuando la sellan, le saltan brillitos y se va volando en curva. Los tiempos son los de siempre: lo que cambia
// es el dibujo (styles.css, .emb-*); si se toca una duración allá, acá van los mismos milisegundos.
async function embalar(grupos: Grupo[], hacia?: HTMLElement | null) {
  if (reducido()) return;
  const capa = document.createElement('div');
  capa.className = 'chispin-embalar';
  capa.innerHTML = '<span class="emb-halo"></span><div class="emb-escena"><span class="emb-sombra"></span><div class="emb-caja">'
    + '<span class="emb-solapa atras"></span><span class="emb-fondo"></span>'
    + `<span class="emb-frente"><span class="emb-sticker">${monio('#fff', 24)}</span>`
    + '<svg class="emb-estampa" viewBox="0 0 40 24" width="40" height="24" aria-hidden="true"><path d="M8 20V6M3.5 10.5 8 6l4.5 4.5M21 20V6M16.5 10.5 21 6l4.5 4.5M30 8h8l-1 5a3 3 0 0 1-6 0zM34 16v4M31.5 20h5"/></svg></span>'
    + '<span class="emb-solapa izq"></span><span class="emb-solapa der"></span><span class="emb-cinta"></span><span class="emb-sello">LISTO ✓</span>'
    + '<span class="emb-brillos"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div></div><div class="emb-lista"></div>';
  const caja = capa.querySelector('.emb-caja') as HTMLElement;
  const lista = capa.querySelector('.emb-lista') as HTMLElement;
  const enCaja = grupos.slice(0, MAX_EN_CAJA);
  enCaja.forEach((g, k) => {
    const it = fichaProducto(g, 'emb-item');
    // Repartidos a lo ancho de la caja, un poco desordenados.
    it.style.setProperty('--x', `${(k - (enCaja.length - 1) / 2) * (enCaja.length > 4 ? 23 : 32) + (Math.random() * 8 - 4)}px`);
    it.style.setProperty('--r', `${Math.random() * 40 - 20}deg`);
    it.style.setProperty('--y', `${-4 - (k % 2) * 10}px`);
    caja.insertBefore(it, caja.querySelector('.emb-frente'));
    const chip = document.createElement('span');
    chip.className = 'emb-chip';
    chip.style.setProperty('--d', `${500 + k * 90}ms`);
    chip.appendChild(fichaProducto(g, 'emb-chip-ic'));
    chip.appendChild(document.createTextNode(`${g.cantidad ? `${g.cantidad} ` : ''}${(g.cantidad === 1 ? g.sub.tipo.split(' / ')[0] : g.sub.plural).toLowerCase()}`));
    lista.appendChild(chip);
  });
  document.body.appendChild(capa);
  await esperar(350);
  const items = [...caja.querySelectorAll<HTMLElement>('.emb-item')];
  for (const it of items) {
    it.classList.add('cae');
    // Cuando toca fondo (a los ~430 ms de los 620 de la caída) la caja acusa el golpe: se reinicia la animación en cada producto.
    setTimeout(() => { caja.classList.remove('pum'); void caja.offsetWidth; caja.classList.add('pum'); }, 430);
    await esperar(420);
  }
  await esperar(450);
  caja.classList.add('cerrada');
  await esperar(450);
  caja.classList.add('cinta');
  await esperar(380);
  caja.classList.add('sellada');
  capa.classList.add('golpe');
  await esperar(1500);
  // Vuela a Chispín (o a la esquina).
  const r = hacia?.getBoundingClientRect(), c = caja.getBoundingClientRect();
  const dx = (r ? r.left + r.width / 2 : innerWidth - 50) - (c.left + c.width / 2), dy = (r ? r.top + r.height / 2 : innerHeight - 50) - (c.top + c.height / 2);
  caja.style.setProperty('--vx', `${dx}px`); caja.style.setProperty('--vy', `${dy}px`);
  capa.classList.add('vuela');
  await esperar(900);
  capa.remove();
}

// El camión: cruza la pantalla de izquierda a derecha con los productos en la caja de carga, frena en el medio a tocar bocina
// y sigue. El camioncito con más onda (Rodrigo, 19/11/2026): redondeado, con el moño y «formas» en el costado, la vidriera de
// la carga donde saltan los productos, el chofer, el farol que hace guiños al tocar bocina, la suspensión que cabecea al
// frenar y al arrancar, humito, polvo y rayitas de viento. Va en dos SVG: la carrocería (que se hamaca) y las ruedas (que no).
// Todo el dibujo es nuestro y fijo: lo único que viene de afuera son los productos, y entran por fichaProducto (title).
const RUEDA = (cx: number) => `<g class="cam-rueda"><circle cx="${cx}" cy="97" r="15.5" fill="#12143a"/><circle cx="${cx}" cy="97" r="11.6" fill="none" stroke="#2c2f5c" stroke-width="1.6"/>`
  + `<circle cx="${cx}" cy="97" r="8" fill="#e4e7f5"/><path d="M${cx} 90.2v13.6M${cx - 6.8} 97h13.6M${cx - 4.8} 92.2l9.6 9.6M${cx + 4.8} 92.2l-9.6 9.6" stroke="#a9adcd" stroke-width="1.7" stroke-linecap="round"/>`
  + `<circle cx="${cx}" cy="97" r="3" fill="#8ee021" stroke="#12143a" stroke-width="1.2"/></g>`;
function camion(grupos: Grupo[]) {
  if (reducido()) return;
  const capa = document.createElement('div');
  capa.className = 'chispin-camion';
  capa.innerHTML = `<div class="cam-auto"><span class="cam-viento"><i></i><i></i><i></i></span><span class="cam-sombra"></span>
    <span class="cam-humo"><i></i><i></i><i></i></span><span class="cam-polvo"><i></i><i></i><i></i><i></i></span>
    <div class="cam-inercia"><div class="cam-cuerpo"><svg viewBox="0 0 250 120" width="250" height="120" aria-hidden="true">
      <defs><linearGradient id="cam-luz-g" x1="0" x2="1"><stop offset="0" stop-color="#ffe88a" stop-opacity=".95"/><stop offset="1" stop-color="#ffe88a" stop-opacity="0"/></linearGradient>
        <clipPath id="cam-vidrio-c"><path d="M161 41h27.5a7 7 0 0 1 5.4 2.6L207.5 60H161z"/></clipPath><clipPath id="cam-caja-c"><rect x="6" y="9" width="146" height="77" rx="12"/></clipPath></defs>
      <path class="cam-luz" d="M229 66 250 56v26l-21-7z" fill="url(#cam-luz-g)"/>
      <rect x="0" y="86" width="12" height="5" rx="2.5" fill="#6d7096"/>
      <rect x="6" y="9" width="146" height="77" rx="12" fill="#000085"/>
      <g clip-path="url(#cam-caja-c)"><rect x="6" y="9" width="146" height="6" fill="#8ee021"/><rect x="6" y="64" width="146" height="3" fill="#8ee021"/><path d="M6 15h146v3H6z" fill="#fff" opacity=".12"/></g>
      <rect x="14" y="20" width="130" height="40" rx="8" fill="#12143a"/><rect x="15.5" y="21.5" width="127" height="37" rx="6.5" fill="#dcecff"/>
      <path d="M15.5 30v-2a6.5 6.5 0 0 1 6.5-6.5h114a6.5 6.5 0 0 1 6.5 6.5v2z" fill="#fff" opacity=".55"/>
      <g transform="translate(72 69.6) scale(.044) translate(-78 -221)"><path d="${CINTA}" fill="#8ee021"/></g>
      <text x="100" y="80.5" fill="#fff" font-family="Poppins, system-ui, sans-serif" font-weight="800" font-size="12.5" letter-spacing=".3">formas</text>
      <path d="M154 86V42a9 9 0 0 1 9-9h26.5a12 12 0 0 1 9.3 4.4L218 60.5l9.5 3.8a7 7 0 0 1 4.5 6.5V86z" fill="#8ee021"/>
      <path d="M154 70h78v16h-78z" fill="#7bcb14"/><path d="M154 68.5h77.4" stroke="#fff" stroke-width="2" opacity=".5"/>
      <path d="M161 41h27.5a7 7 0 0 1 5.4 2.6L207.5 60H161z" fill="#d9eeff" stroke="#12143a" stroke-width="2.2" stroke-linejoin="round"/>
      <g clip-path="url(#cam-vidrio-c)"><rect x="170" y="56" width="20" height="8" rx="4" fill="#000085"/><circle cx="180" cy="51" r="6.8" fill="#ffd9b8"/>
        <path d="M172.8 50a7.2 7.2 0 0 1 14.4 0z" fill="#000085"/><path d="M186 50h5.5" stroke="#000085" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="182.6" cy="52.3" r=".9" fill="#12143a"/><path d="M181 55.2c1.2.9 2.6.8 3.6-.2" stroke="#12143a" stroke-width="1" fill="none" stroke-linecap="round"/>
        <path d="M164 58 174 42M168.5 58l6-9.5" stroke="#fff" stroke-width="2" opacity=".8" stroke-linecap="round"/></g>
      <path d="M165 66.5h7" stroke="#12143a" stroke-width="2.2" stroke-linecap="round"/><rect x="207" y="52" width="5" height="8" rx="2" fill="#12143a"/>
      <rect x="222" y="65" width="8.5" height="10" rx="3.5" fill="#ffd76a" stroke="#12143a" stroke-width="1.6"/>
      <rect x="2" y="83" width="234" height="8.5" rx="4" fill="#12143a"/><rect x="226" y="80" width="12" height="9" rx="4" fill="#c9cbe0" stroke="#12143a" stroke-width="1.6"/>
      <path d="M28 91a20 20 0 0 1 40 0zM170 91a20 20 0 0 1 40 0z" fill="#12143a"/>
      <g class="cam-ondas" fill="none" stroke="#000085" stroke-width="2.4" stroke-linecap="round"><path d="M236 40c2.5 2 2.5 6 0 8"/><path d="M241 36c4.5 4 4.5 12 0 16"/></g>
    </svg><div class="cam-carga"></div><span class="cam-bocina">¡Bip, bip!</span></div></div>
    <svg class="cam-ruedas" viewBox="0 0 250 120" width="250" height="120" aria-hidden="true">${RUEDA(48)}${RUEDA(190)}</svg></div>`;
  const carga = capa.querySelector('.cam-carga') as HTMLElement;
  const enCarga = grupos.length ? grupos.slice(0, MAX_EN_CAJA) : agruparProductos([{ nombre: '', cantidad: null }]);
  // Con más de cuatro no entran en una fila de la vidriera: van más chicos, en dos.
  if (enCarga.length > 4) carga.classList.add('muchos');
  for (const g of enCarga) carga.appendChild(fichaProducto(g, 'cam-item'));
  document.body.appendChild(capa);
  setTimeout(() => capa.remove(), 5200);
}

const resumenProductos = (grupos: Grupo[]) => {
  const partes = grupos.slice(0, 4).map((g) => `${g.cantidad ? `${g.cantidad} ` : ''}${(g.cantidad === 1 ? g.sub.tipo.split(' / ')[0] : g.sub.plural).toLowerCase()}`);
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}${grupos.length > 4 ? ' (y más)' : ''}` : partes[0] ?? '';
};

const ANTICIPOS: Array<(n: string, pedido: string) => string> = [
  (n, x) => `😎💸 ¡Entró el anticipo, ${n}! ${x}. ¡A producir!`,
  (n, x) => `😎💸 Llueve plata, ${n}: se cobró el anticipo de ${x}.`,
  (n, x) => `😎💸 ¡Cash! Anticipo adentro, ${n}: ${x} sigue camino.`,
];
const primerNombre = (s?: string | null) => (s ?? '').trim().split(/\s+/)[0] || '';
const FELICITACIONES: Array<(n: string, negocio: string) => string> = [
  (n, x) => `¡Vamos, ${n}! 🏆 Cerraste ${x}.`,
  (n, x) => `¡Golazo, ${n}! ⚽ ${x} ya es ganado.`,
  (n, x) => `¡Eso, ${n}! 🎉 Un cierre más: ${x}.`,
  (n, x) => `¡Qué crack, ${n}! 💪 ${x} pasó a ganado.`,
  (n, x) => `¡Aplausos para ${n}! 👏 Ganaste ${x}.`,
];

// ---------- El personaje ----------
// Los anteojos de sol (pedido de Rodrigo del 19/11/2026): el moño del logo de Formas dado vuelta (el puente arriba, como unos
// anteojos de verdad), con vidrios oscuros, un reflejo y un destello que pasa cada tanto. Se los pone con el buzón abierto y,
// de vez en cuando, solo; la mano sube a acomodarlos al ponérselos y al sacárselos.
// Los dos huecos del moño (los vidrios) son el segundo y el tercer tramo de la cinta del isotipo.
const VIDRIOS = CINTA.split('Z').filter((t) => t.trim()).slice(1).map((t) => `${t}Z`).join('');
// Los reflejos, en las coordenadas del isotipo (el moño se da vuelta entero, así que se dibujan «\» para que se vean «/»).
const REFLEJO = 'M150 330 L230 410 M196 318 L262 384 M418 330 L498 410 M464 318 L530 384';
function Personaje({ animo, lampara, ojosRef, anteojos = false, acomoda = false }: {
  animo: string; lampara: boolean; ojosRef: React.RefObject<HTMLSpanElement>; anteojos?: boolean; acomoda?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  return (
    <span className={`chispin-bicho ${animo}${anteojos ? ' anteojos' : ''}${acomoda ? ' acomoda' : ''}`} aria-hidden="true">
      <span className={`chispin-antena${lampara ? ' prendida' : ''}`}><span className="chispin-lampara" /></span>
      <span className="chispin-cuerpo">
        <span className="chispin-ojos" ref={ojosRef}>
          <span className="chispin-ojo"><span className="chispin-pupila" /></span>
          <span className="chispin-ojo"><span className="chispin-pupila" /></span>
        </span>
        <span className="chispin-cachetes"><span /><span /></span>
        <span className="chispin-boca" />
        <svg className="chispin-anteojos" viewBox="78 221 544 258">
          <defs>
            <linearGradient id={`${id}-sol`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#05051c" /><stop offset=".55" stopColor="#141466" /><stop offset="1" stopColor="#3d2a8f" />
            </linearGradient>
            <clipPath id={`${id}-vidrios`}><path d={VIDRIOS} /></clipPath>
          </defs>
          <path className="chispin-vidrio" d={VIDRIOS} fill={`url(#${id}-sol)`} />
          <g clipPath={`url(#${id}-vidrios)`}>
            <path className="chispin-reflejo" d={REFLEJO} />
            <path className="chispin-destello" d="M100 300 L220 420" />
          </g>
          <path className="chispin-marco" d={CINTA} />
        </svg>
      </span>
      <span className="chispin-mano izq"><span className="chispin-fajo" /></span><span className="chispin-mano der" />
      <span className="chispin-zzz"><i>z</i><i>z</i><i>z</i></span>
    </span>
  );
}

export default function Chispin() {
  const { meta } = useMeta();
  const yo = meta.me.id;
  const toast = useToast();
  const loc = useLocation();
  const navigate = useNavigate();
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [escondido, setEscondido] = useState(() => leer('escondido') === '1');
  const [globo, setGlobo] = useState<{ texto: string; tipo: 'charla' | 'nuevas' | 'festejo' | 'hola' } | null>(null);
  const [animo, setAnimo] = useState('');   // '', 'mira', 'feliz', 'duerme', 'traga'
  const [resaltar, setResaltar] = useState<number | null>(null);
  const [visto, setVisto] = useState(() => Number(leer('visto') ?? 0));
  const [festejando, setFestejando] = useState(false);   // un negocio ganado: se muestra aunque esté escondido
  const festejandoRef = useRef(false);
  festejandoRef.current = festejando;
  const botonRef = useRef<HTMLButtonElement>(null);
  const ojosRef = useRef<HTMLSpanElement>(null);

  // ---------- Los anteojos: la mano sube, se los pone (o se los saca) y baja ----------
  const [anteojos, setAnteojos] = useState(false);
  const [acomoda, setAcomoda] = useState(false);
  const anteojosRef = useRef(false);
  const fachaHasta = useRef<ReturnType<typeof setTimeout>>();   // cuándo se los saca (votos, ideas)
  const ponerAnteojos = useCallback((v: boolean) => {
    if (anteojosRef.current === v) return;
    anteojosRef.current = v;
    setAcomoda(true);
    setTimeout(() => setAnteojos(v), 200);
    setTimeout(() => setAcomoda(false), 800);
  }, []);

  const cargar = useCallback(() => http<{ ideas: Idea[]; admin: boolean }>('GET', '/ideas')
    .then((r) => { setIdeas(r.ideas); setAdmin(r.admin); return r.ideas; }, () => null), []);
  useEffect(() => {
    cargar();
    const t = setInterval(() => { if (document.visibilityState === 'visible') cargar(); }, 120_000);
    return () => clearInterval(t);
  }, [cargar]);

  const abrir = useCallback((id?: number) => {
    setAbierto(true); setGlobo(null); setEscondido(false); guardar('escondido', '0');
    if (id) setResaltar(id);
    cargar();
  }, [cargar]);
  useEffect(() => { abrirDesdeAfuera = abrir; return () => { abrirDesdeAfuera = null; }; }, [abrir]);

  // Un negocio ganado: sale (aunque esté escondido), salta, tira papelitos y felicita por el nombre.
  const festejoT = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    ganadoDesdeAfuera = (n, tipo) => {
      festejoT.current.forEach(clearTimeout);
      const duenio = userOf(meta, n.duenio);
      const ajeno = duenio && duenio.id !== yo ? duenio : null;
      const negocio = `«${n.nombre.length > 60 ? `${n.nombre.slice(0, 58)}…` : n.nombre}»${n.monto ? ` por ${fmtMoney(n.monto, n.moneda)}` : ''}`;
      if (tipo === 'anticipo') {
        // Se pone los anteojos, saca el fajo y tira billetes, una vez por cada vez que mueve la mano.
        const texto = ajeno
          ? `😎💸 ¡Entró el anticipo de ${negocio}! Pedido de ${primerNombre(ajeno.name)}. ¡A producir!`
          : ANTICIPOS[Math.floor(Math.random() * ANTICIPOS.length)](primerNombre(meta.me.name) || 'crack', negocio);
        clearTimeout(fachaHasta.current);
        setAbierto(false); setFestejando(true); setAnimo('');
        setGlobo({ tipo: 'festejo', texto });
        ponerAnteojos(true);
        festejoT.current = [
          setTimeout(() => setAnimo('tira'), 850),
          ...Array.from({ length: 9 }, (_, k) => setTimeout(() => tirarPlata(botonRef.current), 1150 + k * 500)),
          setTimeout(() => setAnimo(''), 850 + 9 * 500),
          setTimeout(() => ponerAnteojos(false), 8200),
          setTimeout(() => { setFestejando(false); setGlobo((g) => (g?.texto === texto ? null : g)); }, 9000),
        ];
        return;
      }
      const texto = ajeno
        ? `¡Ganó ${primerNombre(ajeno.name)}! 🏆 ${negocio}. ¡Mandale un aplauso!`
        : FELICITACIONES[Math.floor(Math.random() * FELICITACIONES.length)](primerNombre(meta.me.name) || 'campeón/a', negocio);
      setAbierto(false); setFestejando(true); setAnimo('feliz');
      setGlobo({ tipo: 'festejo', texto });
      festejoT.current = [
        setTimeout(() => festejar(botonRef.current), 250),
        setTimeout(() => festejar(botonRef.current), 1100),
        setTimeout(() => setAnimo(''), 2600),
        setTimeout(() => { setFestejando(false); setGlobo((g) => (g?.texto === texto ? null : g)); }, 9000),
      ];
    };
    return () => { ganadoDesdeAfuera = null; };
  }, [meta, yo, ponerAnteojos]);
  useEffect(() => () => festejoT.current.forEach(clearTimeout), []);

  // ---------- Los pedidos de ella listos para entregar o entregados: se buscan cada tanto y se festejan de a uno ----------
  const cola = useRef<FestejoPedido[]>([]);
  const abiertoRef = useRef(false);
  abiertoRef.current = abierto;
  const festejarPedido = useCallback((p: FestejoPedido) => {
    festejoT.current.forEach(clearTimeout);
    const grupos = agruparProductos(p.articulos);
    const pedido = `«${p.name.length > 60 ? `${p.name.slice(0, 58)}…` : p.name}»`;
    const productos = resumenProductos(grupos);
    const quien = primerNombre(meta.me.name);
    const hizo = [...new Set(p.hizo.filter((h) => h.user_id !== yo).map((h) => primerNombre(h.nombre)).filter(Boolean))];
    const texto = p.etapa === 'listo'
      ? `📦 ${quien ? `${quien}, ¡` : '¡'}está listo ${pedido}!${productos ? ` Ya están embalados: ${productos}.` : ''}${hizo.length ? ` Lo terminó ${hizo.join(' y ')} 💪` : ''} A coordinar la entrega.`
      : `🚚 ¡Entregado! ${pedido} ya llegó al cliente${quien ? `, ${quien}` : ''}.${productos ? ` Iban ${productos}.` : ''} ¡Otro más! 🙌`;
    setAbierto(false); setFestejando(true); setAnimo(p.etapa === 'listo' ? '' : 'mira');
    setGlobo({ tipo: 'festejo', texto });
    if (p.etapa === 'listo') {
      embalar(grupos, botonRef.current);
      festejoT.current = [setTimeout(() => { setAnimo('feliz'); festejar(botonRef.current); }, 900 + Math.min(grupos.length, MAX_EN_CAJA) * 420 + 2800)];
    } else {
      camion(grupos);
      festejoT.current = [setTimeout(() => setAnimo('feliz'), 2400)];
    }
    festejoT.current.push(
      setTimeout(() => setAnimo(''), 9000),
      setTimeout(() => { setFestejando(false); setGlobo((g) => (g?.texto === texto ? null : g)); }, 12_000),
    );
  }, [meta, yo]);
  const siguiente = useRef<() => void>(() => {});
  siguiente.current = () => {
    if (!cola.current.length) return;
    if (festejandoRef.current || abiertoRef.current || document.visibilityState !== 'visible') { setTimeout(() => siguiente.current(), 5000); return; }
    festejarPedido(cola.current.shift()!);
    setTimeout(() => siguiente.current(), 13_000);
  };
  const revisarPedidos = useCallback(async () => {
    let r: { pedidos: FestejoPedido[] };
    try { r = await http<{ pedidos: FestejoPedido[] }>('GET', '/pedidos/festejos'); } catch { return; }
    const hechos = new Set((leer('pedidos_festejados') ?? '').split(',').filter(Boolean));
    const nuevos = r.pedidos.filter((p) => !hechos.has(`${p.id}:${p.etapa}`) && !cola.current.some((x) => x.id === p.id && x.etapa === p.etapa))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (!nuevos.length) return;
    for (const p of nuevos) hechos.add(`${p.id}:${p.etapa}`);
    guardar('pedidos_festejados', [...hechos].slice(-120).join(','));
    cola.current.push(...nuevos.slice(-3));   // si se juntaron muchos (días sin entrar), los últimos
    siguiente.current();
  }, []);
  useEffect(() => {
    revisarDesdeAfuera = revisarPedidos;
    const t0 = setTimeout(revisarPedidos, 6000);
    const t = setInterval(() => { if (document.visibilityState === 'visible') revisarPedidos(); }, 90_000);
    return () => { revisarDesdeAfuera = null; clearTimeout(t0); clearInterval(t); };
  }, [revisarPedidos]);
  // El link de una idea (…?idea=12, el que da Claude): abre el buzón en esa idea y se saca de la dirección.
  useEffect(() => {
    const sp = new URLSearchParams(loc.search);
    const id = Number(sp.get('idea'));
    if (!id) return;
    sp.delete('idea');
    navigate({ pathname: loc.pathname, search: sp.toString() ? `?${sp}` : '' }, { replace: true });
    abrir(id);
  }, [loc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lo visto: al abrir el buzón, todo lo que hay.
  const maxId = ideas?.reduce((m, i) => Math.max(m, i.id), 0) ?? 0;
  useEffect(() => { if (abierto && maxId > visto) { setVisto(maxId); guardar('visto', String(maxId)); } }, [abierto, maxId, visto]);
  const nuevas = (ideas ?? []).filter((i) => i.id > visto && i.user_id !== yo && (i.estado === 'pendiente' || i.estado === 'en_curso')).length;

  // ---------- Lo que dice solo, una vez, un rato después de entrar ----------
  const yaHablo = useRef(false);
  useEffect(() => {
    if (!ideas || yaHablo.current || abierto) return;
    yaHablo.current = true;
    const festejados = new Set((leer('festejadas') ?? '').split(',').filter(Boolean).map(Number));
    const hecha = ideas.find((i) => i.estado === 'hecha' && (i.user_id === yo || i.votada) && !festejados.has(i.id)
      && i.estado_at && Date.now() - Date.parse(i.estado_at) < 21 * 86_400_000);
    const hoy = new Date().toISOString().slice(0, 10);
    let g: typeof globo = null;
    if (hecha) {
      festejados.add(hecha.id);
      guardar('festejadas', [...festejados].slice(-60).join(','));
      const corto = hecha.texto.length > 70 ? `${hecha.texto.slice(0, 68)}…` : hecha.texto;
      g = { tipo: 'festejo', texto: `${hecha.user_id === yo ? '¡Se hizo tu idea!' : '¡Se hizo una idea que votaste!'} «${corto}»` };
    } else if (!leer('hola')) {
      guardar('hola', '1');
      g = { tipo: 'hola', texto: '¡Hola! Soy Chispín 👋 Guardo las ideas para mejorar el Hub. Proponé las tuyas y votá las de los demás.' };
    } else if (nuevas > 0 && leer('aviso_nuevas') !== `${hoy}:${maxId}`) {
      guardar('aviso_nuevas', `${hoy}:${maxId}`);
      g = { tipo: 'nuevas', texto: nuevas === 1 ? 'Hay una idea nueva esperando tu voto 👀' : `Hay ${nuevas} ideas nuevas esperando tu voto 👀` };
    } else if (leer('charla') !== hoy && !escondido) {
      guardar('charla', hoy);
      g = { tipo: 'charla', texto: FRASES[Math.floor(Math.random() * FRASES.length)] };
    }
    if (!g || (escondido && g.tipo === 'charla')) return;
    const t1 = setTimeout(() => {
      if (festejandoRef.current) return;   // no pisar la felicitación de un negocio ganado
      setGlobo(g);
      if (g!.tipo === 'festejo') { setAnimo('feliz'); festejar(botonRef.current); setTimeout(() => setAnimo(''), 2400); }
    }, 3500);
    const t2 = setTimeout(() => setGlobo((x) => (x === g ? null : x)), 3500 + (g.tipo === 'festejo' || g.tipo === 'hola' ? 14_000 : 9000));
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ideas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Se los pone «con facha» solo cuando alguien propone una idea o vota una (pedido de Rodrigo del 19/11/2026): unos segundos,
  // inclinado y sonriendo de costado. Otro voto mientras los tiene puestos los deja un rato más. Dormido, sin anteojos.
  const facha = useCallback(() => {
    setAnimo((a) => (a === 'duerme' ? '' : a));
    ponerAnteojos(true);
    clearTimeout(fachaHasta.current);
    fachaHasta.current = setTimeout(() => ponerAnteojos(false), 4200);
  }, [ponerAnteojos]);
  useEffect(() => { fachaDesdeAfuera = facha; return () => { fachaDesdeAfuera = null; clearTimeout(fachaHasta.current); }; }, [facha]);
  useEffect(() => { if (animo === 'duerme') ponerAnteojos(false); }, [animo, ponerAnteojos]);

  // ---------- Los ojos siguen al mouse; sin moverse un buen rato, se duerme ----------
  useEffect(() => {
    if (reducido()) return;
    let raf = 0, x = 0, y = 0, sueno: ReturnType<typeof setTimeout>;
    const dormir = () => { sueno = setTimeout(() => setAnimo((a) => (a ? a : 'duerme')), 150_000); };
    const mover = (e: PointerEvent) => {
      x = e.clientX; y = e.clientY;
      clearTimeout(sueno); dormir();
      setAnimo((a) => (a === 'duerme' ? '' : a));
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = ojosRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 220);
        el.style.setProperty('--mx', `${(dx / d) * 3.2 * k}px`);
        el.style.setProperty('--my', `${(dy / d) * 3 * k}px`);
      });
    };
    dormir();
    window.addEventListener('pointermove', mover, { passive: true });
    return () => { window.removeEventListener('pointermove', mover); cancelAnimationFrame(raf); clearTimeout(sueno); };
  }, []);

  // Donde se escribe un mensaje (Conversaciones, o la conversación abierta en una ficha) se corre al borde solo, para no tapar
  // el botón de mandar; sin guardar nada.
  const estorba = !festejando && (/^\/conversaciones/.test(loc.pathname) || new URLSearchParams(loc.search).has('conversacion'));
  const esconder = (v: boolean) => { setEscondido(v); guardar('escondido', v ? '1' : '0'); setGlobo(null); };
  const lampara = abierto || nuevas > 0 || globo?.tipo === 'festejo';

  return createPortal(
    <div className={`chispin-zona${(escondido || estorba) && !abierto && !festejando ? ' escondido' : ''}${abierto ? ' abierto' : ''}${festejando ? ' festejando' : ''}`}>
      {abierto && <div className="chispin-velo" onClick={() => setAbierto(false)} aria-hidden="true" />}
      {abierto && ideas && (
        <Buzon ideas={ideas} admin={admin} yo={yo} resaltar={resaltar} onResaltado={() => setResaltar(null)} cerrar={() => setAbierto(false)}
          cambiar={(i) => setIdeas((l) => (l ?? []).map((x) => (x.id === i.id ? i : x)))}
          agregar={(i) => { setIdeas((l) => [i, ...(l ?? [])]); setAnimo('traga'); setTimeout(() => { setAnimo(''); facha(); }, 700); }}
          anteojos={anteojos} acomoda={acomoda}
          quitar={(id) => setIdeas((l) => (l ?? []).filter((x) => x.id !== id))}
          festejo={() => { setAnimo('feliz'); festejar(botonRef.current); setTimeout(() => setAnimo(''), 2000); }}
          toast={toast} />
      )}
      {abierto && !ideas && <div className="chispin-panel cargando" role="dialog" aria-label="Buzón de ideas"><div className="muted small">Buscando las ideas…</div></div>}
      {globo && !abierto && !estorba && (
        <div className={`chispin-globo ${globo.tipo}`} role="status">
          <button type="button" className="chispin-globo-texto" onClick={() => (festejando ? setGlobo(null) : abrir())}>{globo.texto}</button>
          <button type="button" className="chispin-globo-x" onClick={() => setGlobo(null)} aria-label="Cerrar"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div className="chispin-lugar">
        <button ref={botonRef} type="button" className="chispin" onClick={() => (abierto ? setAbierto(false) : escondido && !estorba ? esconder(false) : abrir())}
          onPointerEnter={() => setAnimo((a) => (a === '' || a === 'duerme' ? 'mira' : a))} onPointerLeave={() => setAnimo((a) => (a === 'mira' ? '' : a))}
          aria-expanded={abierto} aria-label={escondido ? 'Mostrar a Chispín (buzón de ideas)' : nuevas ? `Buzón de ideas: ${nuevas} nuevas` : 'Buzón de ideas para mejorar el Hub'}
          title={escondido ? 'Volver a mostrar a Chispín' : 'Ideas para mejorar el Hub'}>
          <Personaje animo={animo} lampara={lampara} ojosRef={ojosRef} anteojos={anteojos} acomoda={acomoda} />
          {nuevas > 0 && !abierto && <span className="chispin-n">{nuevas > 9 ? '9+' : nuevas}</span>}
        </button>
        {!escondido && !estorba && !abierto && (
          <button type="button" className="chispin-esconder" onClick={() => esconder(true)} aria-label="Esconder a Chispín" title="Esconder a Chispín (queda espiando en el borde)">
            <Icon name="x" size={10} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- El buzón ----------
function Buzon({ ideas, admin, yo, resaltar, onResaltado, cerrar, cambiar, agregar, quitar, festejo, toast, anteojos, acomoda }: {
  ideas: Idea[]; admin: boolean; yo: number; resaltar: number | null; onResaltado: () => void; cerrar: () => void;
  cambiar: (i: Idea) => void; agregar: (i: Idea) => void; quitar: (id: number) => void; festejo: () => void;
  toast: (msg: string, err?: boolean) => void; anteojos: boolean; acomoda: boolean;
}) {
  const ojosCab = useRef<HTMLSpanElement>(null);
  const { meta } = useMeta();
  const [pestana, setPestana] = useState<Pestana>('ranking');
  const [texto, setTexto] = useState(() => leer('borrador') ?? '');
  const [mandando, setMandando] = useState(false);
  const ejemplo = useMemo(() => EJEMPLOS[Math.floor(Math.random() * EJEMPLOS.length)], []);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  useEffect(() => { guardar('borrador', texto); }, [texto]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) cerrar(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [cerrar]);
  // En el celular no: abriría el teclado tapando la lista.
  useEffect(() => { if (!resaltar && matchMedia('(hover: hover)').matches) areaRef.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enMarcha = ideas.filter((i) => i.estado === 'en_curso').sort((a, b) => b.votos - a.votos);
  const pendientes = ideas.filter((i) => i.estado === 'pendiente').sort((a, b) => b.votos - a.votos || a.created_at.localeCompare(b.created_at));
  const hechas = ideas.filter((i) => i.estado === 'hecha');
  const noVan = ideas.filter((i) => i.estado === 'descartada');
  const mias = ideas.filter((i) => i.user_id === yo);
  // Las abiertas que todavía no votó (para invitarlo a votar en el ranking).
  const sinVotar = [...enMarcha, ...pendientes].filter((i) => !i.votada).length;
  const similares = useMemo(() => (texto.trim().length >= 12 ? parecidas(texto, ideas) : []), [texto, ideas]);

  // Ir a una idea (desde la campanita, un link o «ya está en el buzón»).
  useEffect(() => {
    if (!resaltar) return;
    const i = ideas.find((x) => x.id === resaltar);
    if (!i) { onResaltado(); return; }
    setPestana(i.estado === 'hecha' || i.estado === 'descartada' ? 'hechas' : 'ranking');
    const t = setTimeout(() => {
      document.getElementById(`chispin-idea-${resaltar}`)?.scrollIntoView({ block: 'center', behavior: reducido() ? 'auto' : 'smooth' });
      setTimeout(onResaltado, 2600);
    }, 60);
    return () => clearTimeout(t);
  }, [resaltar]); // eslint-disable-line react-hooks/exhaustive-deps

  const proponer = async () => {
    if (mandando || texto.trim().length < 8) { if (texto.trim().length < 8) toast('Contá un poco más: ¿qué mejorarías y para qué?', true); return; }
    setMandando(true);
    try {
      const i = await http<Idea>('POST', '/ideas', { texto });
      agregar(i); setTexto(''); setPestana('ranking');
      toast('¡Ñam! Idea guardada. Ahora a juntar votos 🗳️');
      setTimeout(() => document.getElementById(`chispin-idea-${i.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
    } catch (e) {
      const err = e as Error & { data?: { idea_id?: number } };
      toast(err.message, true);
      const id = err.data?.idea_id;
      if (id) { setPestana('ranking'); setTimeout(() => document.getElementById(`chispin-idea-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); }
    } finally { setMandando(false); }
  };

  // Por persona: cuántas ideas suyas se hicieron (el «salón de la fama»).
  const fama = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of hechas) m.set(i.user_id, (m.get(i.user_id) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [hechas]);

  const tarjeta = (i: Idea, puesto?: number) => (
    <Tarjeta key={i.id} idea={i} puesto={puesto} admin={admin} yo={yo} resaltada={resaltar === i.id} cambiar={cambiar} quitar={quitar} festejo={festejo} toast={toast} />
  );
  return (
    <div className="chispin-panel" role="dialog" aria-label="Buzón de ideas">
      <div className="chispin-cab">
        {/* En pantallas angostas el buzón tapa la esquina: Chispín se asoma acá arriba (con sus anteojos al votar o proponer). */}
        <span className="chispin-cab-bicho"><Personaje animo="" lampara anteojos={anteojos} acomoda={acomoda} ojosRef={ojosCab} /></span>
        <div className="chispin-cab-txt">
          <b>Buzón de ideas</b>
          <span>Proponé mejoras para el Hub y votá las de los demás: las más votadas se hacen primero.</span>
        </div>
        <button type="button" className="btn ghost icon sm" onClick={cerrar} aria-label="Cerrar el buzón"><Icon name="x" size={16} /></button>
      </div>

      <div className="chispin-escribir">
        <textarea ref={areaRef} className="input" rows={2} maxLength={1000} placeholder={ejemplo} value={texto} onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); proponer(); } }} aria-label="Tu idea para mejorar el Hub" />
        {similares.length > 0 && (
          <div className="chispin-parecidas">
            <span className="small">¿Es alguna de estas? <b>Votala</b> en vez de repetirla:</span>
            {similares.map((i) => (
              <div key={i.id} className="chispin-parecida">
                <span className="grow">{i.texto.length > 90 ? `${i.texto.slice(0, 88)}…` : i.texto}</span>
                <BotonVoto idea={i} cambiar={cambiar} toast={toast} chico />
              </div>
            ))}
          </div>
        )}
        <div className="chispin-escribir-pie">
          {texto.length > 800 ? <span className="small muted">{1000 - texto.length} caracteres más</span> : <span className="small muted chispin-atajo">Ctrl + Enter para mandar</span>}
          <button type="button" className="btn primary sm" onClick={proponer} disabled={mandando || !texto.trim()}>
            <Icon name="spark" size={14} />{mandando ? 'Mandando…' : 'Proponer'}
          </button>
        </div>
      </div>

      <div className="chispin-pestanas seg sm" role="tablist">
        <button role="tab" aria-selected={pestana === 'ranking'} className={pestana === 'ranking' ? 'on' : ''} onClick={() => setPestana('ranking')}>Ranking · {pendientes.length + enMarcha.length}</button>
        <button role="tab" aria-selected={pestana === 'hechas'} className={pestana === 'hechas' ? 'on' : ''} onClick={() => setPestana('hechas')}>Hechas · {hechas.length}</button>
        <button role="tab" aria-selected={pestana === 'mias'} className={pestana === 'mias' ? 'on' : ''} onClick={() => setPestana('mias')}>Mías · {mias.length}</button>
      </div>

      <div className="chispin-lista" ref={listaRef}>
        {pestana === 'ranking' && <>
          {(pendientes.length + enMarcha.length) > 0 && (
            <div className="chispin-ayuda-voto">
              <span className="chispin-ayuda-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width={14} height={14}><path d="M12 5l7 9h-4.5v5h-5v-5H5z" fill="currentColor" /></svg></span>
              <span><b>Votá las ideas que te sirven</b> con el botón <b>Votar</b>: las más votadas se hacen primero. Podés votar todas las que quieras.
                {' '}{sinVotar > 0 ? <b className="chispin-faltan">{sinVotar === 1 ? 'Te queda 1 por votar.' : `Te quedan ${sinVotar} por votar.`}</b> : <span className="chispin-faltan listo">Ya votaste todas 🙌</span>}</span>
            </div>
          )}
          {enMarcha.length > 0 && <div className="chispin-grupo"><span className="chispin-grupo-ic en_curso"><Icon name="settings" size={12} /></span>En marcha</div>}
          {enMarcha.map((i) => tarjeta(i))}
          {enMarcha.length > 0 && pendientes.length > 0 && <div className="chispin-grupo"><span className="chispin-grupo-ic"><Icon name="star" size={12} /></span>Para votar</div>}
          {pendientes.map((i, k) => tarjeta(i, k + 1))}
          {!pendientes.length && !enMarcha.length && <Vacio texto="No hay ideas pendientes. ¡Sé la primera persona en proponer algo!" />}
        </>}
        {pestana === 'hechas' && <>
          {fama.length > 0 && (
            <div className="chispin-fama">
              <span className="small"><b>Salón de la fama</b> · ideas hechas por persona</span>
              <div className="chispin-fama-lista">
                {fama.map(([u, n]) => (
                  <span key={u} className="chispin-fama-u" title={`${userOf(meta, u)?.name ?? 'Alguien'}: ${n} ${n === 1 ? 'idea hecha' : 'ideas hechas'}`}>
                    <UserAvatar id={u} size="sm" /><b>{n}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
          {hechas.map((i) => tarjeta(i))}
          {!hechas.length && <Vacio texto="Todavía no se hizo ninguna. La primera va a tener papelitos 🎉" />}
          {noVan.length > 0 && <>
            <div className="chispin-grupo"><span className="chispin-grupo-ic descartada"><Icon name="x" size={12} /></span>No van (por ahora)</div>
            {noVan.map((i) => tarjeta(i))}
          </>}
        </>}
        {pestana === 'mias' && <>
          {mias.map((i) => tarjeta(i))}
          {!mias.length && <Vacio texto="Todavía no propusiste nada. Arriba se escribe 👆" />}
        </>}
      </div>
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return <div className="chispin-vacio"><Personaje animo="mira" lampara={false} ojosRef={{ current: null }} /><span>{texto}</span></div>;
}

const ESTADO_LABEL: Record<Idea['estado'], string> = { pendiente: 'Pendiente', en_curso: 'En marcha', hecha: 'Hecha', descartada: 'No va' };

function BotonVoto({ idea, cambiar, toast, chico }: { idea: Idea; cambiar: (i: Idea) => void; toast: (m: string, e?: boolean) => void; chico?: boolean }) {
  const abierta = idea.estado === 'pendiente' || idea.estado === 'en_curso';
  const [pop, setPop] = useState(false);
  const votar = async () => {
    if (!abierta) return;
    const v = !idea.votada;
    // Al toque en pantalla; después lo confirma el servidor.
    cambiar({ ...idea, votada: v, votos: idea.votos + (v ? 1 : -1) });
    if (v) conFacha();
    if (v && !reducido()) { setPop(true); setTimeout(() => setPop(false), 450); }
    try { cambiar(await http<Idea>(v ? 'PUT' : 'DELETE', `/ideas/${idea.id}/voto`)); }
    catch (e) { cambiar(idea); toast((e as Error).message, true); }
  };
  return (
    <button type="button" className={`chispin-voto${idea.votada ? ' on' : ''}${chico ? ' chico' : ''}${pop ? ' pop' : ''}`} onClick={votar} disabled={!abierta}
      aria-pressed={idea.votada} title={!abierta ? `${idea.votos} ${idea.votos === 1 ? 'voto' : 'votos'}` : idea.votada ? 'Sacar mi voto' : 'Votar esta idea'}
      aria-label={`${idea.votada ? 'Sacar mi voto' : 'Votar'} (${idea.votos} ${idea.votos === 1 ? 'voto' : 'votos'})`}>
      {idea.votada && abierta
        ? <svg viewBox="0 0 24 24" width={chico ? 12 : 15} height={chico ? 12 : 15} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg viewBox="0 0 24 24" width={chico ? 12 : 15} height={chico ? 12 : 15} aria-hidden="true"><path d="M12 5l7 9h-4.5v5h-5v-5H5z" fill="currentColor" /></svg>}
      {/* Que se lea que es un voto (pedido de Rodrigo): «Votar» / «Votaste» y el número; cerrada, solo cuántos votos tuvo. */}
      {chico
        ? <span className="chispin-voto-txt">{idea.votada ? 'Votaste' : 'Votar'} · <b>{idea.votos}</b></span>
        : <><b>{idea.votos}</b><span className="chispin-voto-txt">{!abierta ? (idea.votos === 1 ? 'voto' : 'votos') : idea.votada ? 'Votaste' : 'Votar'}</span></>}
    </button>
  );
}

function Tarjeta({ idea, puesto, admin, yo, resaltada, cambiar, quitar, festejo, toast }: {
  idea: Idea; puesto?: number; admin: boolean; yo: number; resaltada: boolean; cambiar: (i: Idea) => void; quitar: (id: number) => void;
  festejo: () => void; toast: (m: string, e?: boolean) => void;
}) {
  const { meta } = useMeta();
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(idea.texto);
  const [marcar, setMarcar] = useState<Idea['estado'] | null>(null);
  const [respuesta, setRespuesta] = useState(idea.respuesta ?? '');
  const [ocupado, setOcupado] = useState(false);
  const autor = userOf(meta, idea.user_id);
  const quien = idea.user_id === yo ? 'Vos' : autor?.name.split(' ')[0] ?? 'Alguien';
  const otros = idea.votantes.filter((u) => u !== idea.user_id);
  const nueva = idea.estado === 'pendiente' && Date.now() - Date.parse(idea.created_at) < 3 * 86_400_000;

  const guardarTexto = async () => {
    setOcupado(true);
    try { cambiar(await http<Idea>('PATCH', `/ideas/${idea.id}`, { texto })); setEditando(false); }
    catch (e) { toast((e as Error).message, true); } finally { setOcupado(false); }
  };
  const borrar = async () => {
    if (!confirm('¿Borrar esta idea? Se pierden sus votos.')) return;
    try { await http('DELETE', `/ideas/${idea.id}`); quitar(idea.id); } catch (e) { toast((e as Error).message, true); }
  };
  const cambiarEstado = async (estado: Idea['estado']) => {
    setOcupado(true);
    try {
      const i = await http<Idea>('POST', `/ideas/${idea.id}/estado`, { estado, respuesta });
      cambiar(i); setMarcar(null);
      if (estado === 'hecha' && idea.estado !== 'hecha') { festejo(); toast(otros.length || idea.user_id !== yo ? '¡Hecha! Les avisé a quien la propuso y a los que la votaron 🎉' : '¡Hecha! 🎉'); }
      else if (estado !== idea.estado) toast(`Quedó «${ESTADO_LABEL[estado]}».`);
      else toast('Respuesta guardada.');
    } catch (e) { toast((e as Error).message, true); } finally { setOcupado(false); }
  };

  return (
    <article id={`chispin-idea-${idea.id}`} className={`chispin-idea ${idea.estado}${resaltada ? ' resaltada' : ''}`} style={{ '--i': puesto ?? 0 } as CSSProperties}>
      <BotonVoto idea={idea} cambiar={cambiar} toast={toast} />
      <div className="chispin-idea-cuerpo">
        {editando
          ? <div className="chispin-editar">
              <textarea className="input" rows={3} maxLength={1000} value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus />
              <div className="chispin-acciones">
                <button type="button" className="btn sm" onClick={() => { setEditando(false); setTexto(idea.texto); }}>Cancelar</button>
                <button type="button" className="btn primary sm" onClick={guardarTexto} disabled={ocupado || texto.trim().length < 8}>Guardar</button>
              </div>
            </div>
          : <p className="chispin-idea-texto">
              {puesto && puesto <= 3 && idea.votos > 1 && <span className={`chispin-puesto p${puesto}`} title={`Puesto ${puesto} del ranking`}>{puesto === 1 ? '👑' : `#${puesto}`}</span>}
              {idea.texto}
            </p>}
        <div className="chispin-idea-meta">
          <UserAvatar id={idea.user_id} size="xs" />
          <span>{quien}</span>
          <span className="muted" title={fmtDate(idea.created_at, true)}>· {fmtRelative(idea.created_at, true)}</span>
          {nueva && <span className="chispin-chip nueva">Nueva</span>}
          {idea.estado !== 'pendiente' && <span className={`chispin-chip ${idea.estado}`}>{ESTADO_LABEL[idea.estado]}{idea.estado_at && idea.estado !== 'en_curso' ? ` el ${fmtDate(idea.estado_at)}` : ''}</span>}
          {otros.length > 0 && (
            <span className="chispin-votantes" title={`La votaron: ${otros.map((u) => userOf(meta, u)?.name ?? 'Alguien').join(', ')}`}>
              {otros.slice(0, 3).map((u) => <UserAvatar key={u} id={u} size="xs" />)}
              {otros.length > 3 && <span className="chispin-mas">+{otros.length - 3}</span>}
            </span>
          )}
        </div>
        {idea.respuesta && !marcar && (
          <div className="chispin-respuesta">
            {idea.estado_por && <UserAvatar id={idea.estado_por} size="xs" />}
            <span><b>{idea.estado_por ? userOf(meta, idea.estado_por)?.name.split(' ')[0] ?? 'Admin' : 'Respuesta'}:</b> {idea.respuesta}</span>
          </div>
        )}
        {marcar && (
          <div className="chispin-editar">
            <textarea className="input" rows={2} maxLength={1000} value={respuesta} onChange={(e) => setRespuesta(e.target.value)} autoFocus
              placeholder={marcar === 'hecha' ? 'Contales qué se hizo y dónde está (opcional)' : marcar === 'descartada' ? '¿Por qué no va? (opcional, pero ayuda)' : 'Un comentario para el equipo (opcional)'} />
            <div className="chispin-acciones">
              <button type="button" className="btn sm" onClick={() => { setMarcar(null); setRespuesta(idea.respuesta ?? ''); }}>Cancelar</button>
              <button type="button" className={`btn sm ${marcar === 'descartada' ? 'danger' : 'primary'}`} onClick={() => cambiarEstado(marcar)} disabled={ocupado}>
                {marcar === idea.estado ? 'Guardar respuesta' : marcar === 'hecha' ? '¡Marcar hecha!' : marcar === 'en_curso' ? 'Poner en marcha' : marcar === 'descartada' ? 'No va' : 'Volver a pendiente'}
              </button>
            </div>
          </div>
        )}
        {!editando && !marcar && (admin || idea.puede_editar) && (
          <div className="chispin-acciones">
            {admin && idea.estado === 'pendiente' && <button type="button" className="btn ghost sm" onClick={() => setMarcar('en_curso')}><Icon name="settings" size={12} />En marcha</button>}
            {admin && idea.estado !== 'hecha' && <button type="button" className="btn ghost sm chispin-hecha" onClick={() => setMarcar('hecha')}><Icon name="check" size={12} />Hecha</button>}
            {admin && idea.estado !== 'descartada' && idea.estado !== 'hecha' && <button type="button" className="btn ghost sm" onClick={() => setMarcar('descartada')}>No va</button>}
            {admin && idea.estado !== 'pendiente' && <button type="button" className="btn ghost sm" onClick={() => setMarcar('pendiente')}>A pendiente</button>}
            {admin && <button type="button" className="btn ghost sm" onClick={() => setMarcar(idea.estado)}>{idea.respuesta ? 'Cambiar respuesta' : 'Responder'}</button>}
            {idea.puede_editar && <button type="button" className="btn ghost sm" onClick={() => setEditando(true)}>Corregir</button>}
            {idea.puede_editar && <button type="button" className="btn ghost sm danger" onClick={borrar}>Borrar</button>}
          </div>
        )}
      </div>
    </article>
  );
}
