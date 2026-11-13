// Contrato con el servidor (/hooks/chofer/api) y el link personal del chofer.
import { instalada } from './instalar';

export type RemitoChofer = {
  id: number;
  clave: string | null;
  creado: string;
  estado: 'sin_leer' | 'ok' | 'revisar' | 'duplicado' | 'descartado';
  repetir: boolean;
  mensaje: string;
  numero: string | null;
  pdv: string | null;
  cliente: string | null;
  items: Array<{ descripcion: string; cantidad: number | null }>;
  pedido: { id: number; nombre: string } | null;
  /** El servidor no pudo saber de qué pedido es por el PDV: el chofer lo puede escribir. */
  pide_pdv?: boolean;
  /** El PDV que escribió el chofer, si escribió. */
  pdv_chofer?: string | null;
  /** La guía de un expreso que se leyó en la foto. */
  guia?: { empresa: string | null; numero: string } | null;
};

const API = '/hooks/chofer/api';
const CLAVE_TOKEN = 'chofer-token';
const CLAVE_NOMBRE = 'chofer-nombre';

function leer(clave: string): string | null {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function guardar(clave: string, valor: string): void {
  try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento: sigue en memoria */ }
}

let tokenEnMemoria: string | null = null;

/** Saca el token de un link (o de un texto pegado): «…#t=fcrm_xxx» o directamente «fcrm_xxx». */
export function tokenDeTexto(texto: string): string | null {
  const m = /[#&?]t=([^&\s]+)/.exec(texto);
  if (m) return decodeURIComponent(m[1]);
  const suelto = /\bfcrm_[A-Za-z0-9_-]+/.exec(texto);
  return suelto ? suelto[0] : null;
}

/** Al abrir: toma el token del link (#t=…) o, si no viene, el que quedó guardado en este celular. */
export function tomarTokenDelLink(): void {
  const delLink = window.location.hash.includes('t=') ? tokenDeTexto(window.location.hash) : null;
  if (delLink) {
    tokenEnMemoria = delLink;
    guardar(CLAVE_TOKEN, delLink);
  } else {
    tokenEnMemoria = leer(CLAVE_TOKEN);
  }
  reflejarToken();
}

/** Deja el token donde lo necesita «Agregar a la pantalla de inicio».
    - El manifest se pide con ?t=…: el servidor lo devuelve con el link personal como dirección de arranque. Así la app
      instalada abre ya con el token (en iPhone la app de inicio no comparte lo guardado con Safari).
    - En el navegador, #t=… queda en la dirección (iOS a veces guarda la dirección actual). Instalada, se saca. */
function reflejarToken(): void {
  const t = tokenEnMemoria;
  try {
    const enlace = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (enlace) enlace.href = `${import.meta.env.BASE_URL}manifest.webmanifest${t ? `?t=${encodeURIComponent(t)}` : ''}`;
    const base = window.location.pathname + window.location.search;
    const quiero = t && !instalada() ? `#t=${encodeURIComponent(t)}` : '';
    if (window.location.hash !== quiero) history.replaceState(history.state, '', base + quiero);
  } catch { /* da igual */ }
}

export function usarToken(t: string): void {
  tokenEnMemoria = t;
  guardar(CLAVE_TOKEN, t);
  reflejarToken();
}
export function token(): string | null { return tokenEnMemoria; }

export function nombreGuardado(): string | null { return leer(CLAVE_NOMBRE); }

export class LinkInvalido extends Error {}

/** Entra con el código de 8 números que le pasó Logística: el servidor devuelve su link y queda guardado en este celular,
    como si lo hubiera abierto. Si el código no es, devuelve por qué (para mostrárselo). */
export async function entrarConCodigo(codigo: string): Promise<{ ok: true; nombre: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch(`${API}/entrar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo }), cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No hay señal. Probá de nuevo cuando tengas.' };
  }
  try {
    const j = (await r.json()) as { token?: string; nombre?: string; error?: string };
    if (r.ok && j.token) {
      usarToken(j.token);
      if (j.nombre) guardar(CLAVE_NOMBRE, j.nombre);
      return { ok: true, nombre: j.nombre ?? '' };
    }
    return { ok: false, error: j.error ?? 'No se pudo entrar. Probá de nuevo.' };
  } catch {
    return { ok: false, error: 'No se pudo entrar. Probá de nuevo.' };
  }
}
/** Sin señal, corte o servidor caído: conviene reintentar. */
export class SinSenal extends Error {}
/** El servidor rechazó el pedido y reintentar igual no sirve. */
export class Rechazo extends Error {
  constructor(public status: number, public detalle?: string) { super(`HTTP ${status}`); }
}

function reintentable(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

async function pedir<T>(ruta: string): Promise<T> {
  if (!tokenEnMemoria) throw new LinkInvalido();
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 20_000);
  let r: Response;
  try {
    r = await fetch(API + ruta, { headers: { Authorization: `Bearer ${tokenEnMemoria}` }, signal: corte.signal, cache: 'no-store' });
  } catch {
    throw new SinSenal();
  } finally {
    clearTimeout(reloj);
  }
  if (r.status === 401) throw new LinkInvalido();
  if (reintentable(r.status)) throw new SinSenal();
  if (!r.ok) throw new Rechazo(r.status);
  try { return (await r.json()) as T; } catch { throw new SinSenal(); }
}

export async function pedirYo(): Promise<string> {
  const { nombre } = await pedir<{ nombre: string }>('/yo');
  guardar(CLAVE_NOMBRE, nombre);
  return nombre;
}

export async function pedirRemitos(): Promise<RemitoChofer[]> {
  const { remitos } = await pedir<{ remitos: RemitoChofer[] }>('/remitos');
  return Array.isArray(remitos) ? remitos : [];
}

/** El chofer dice de qué entrega es una foto: escribe el PDV o elige la parada de su recorrido. No va a la cola: si no hay
    señal, se prueba de nuevo. */
export async function corregirPdv(id: number, pdv: string, parada?: string): Promise<RemitoChofer> {
  if (!tokenEnMemoria) throw new LinkInvalido();
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 30_000);
  let r: Response;
  try {
    r = await fetch(`${API}/remitos/${id}/pdv`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenEnMemoria}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parada ? { parada } : { pdv }),
      signal: corte.signal,
    });
  } catch {
    throw new SinSenal();
  } finally {
    clearTimeout(reloj);
  }
  if (r.status === 401) throw new LinkInvalido();
  if (reintentable(r.status)) throw new SinSenal();
  if (!r.ok) {
    let detalle: string | undefined;
    try { const j = (await r.json()) as { error?: unknown }; if (typeof j.error === 'string') detalle = j.error; } catch { /* sin detalle */ }
    throw new Rechazo(r.status, detalle);
  }
  try {
    const remito = (await r.json()) as RemitoChofer;
    if (!remito || typeof remito.estado !== 'string') throw new Error('respuesta rara');
    return remito;
  } catch {
    throw new SinSenal();
  }
}

export type FotoParaMandar = {
  clave: string;
  blob: Blob;
  tomada_el: string;
  lat?: number;
  lng?: number;
  /** Clave de la foto anterior que esta viene a reemplazar (cuando el servidor pidió repetirla). */
  reemplaza?: string;
  /** La parada del recorrido desde la que se sacó: así se sabe de qué entrega es (la guía de un expreso, un remito sin PDV). */
  parada?: string;
};

/** Manda una foto. Con XMLHttpRequest para poder contar de verdad cuánto subió: `alSubir(0..1)` y después `alLeer()`
    cuando la foto ya está entera del otro lado y solo falta que el servidor la lea. */
export function mandarRemito(f: FotoParaMandar, alSubir: (parte: number) => void, alLeer: () => void): Promise<RemitoChofer> {
  return new Promise((resolver, rechazar) => {
    if (!tokenEnMemoria) { rechazar(new LinkInvalido()); return; }
    const datos = new FormData();
    datos.append('archivo', new File([f.blob], `remito-${f.clave}.jpg`, { type: 'image/jpeg' }));
    datos.append('clave', f.clave);
    datos.append('tomada_el', f.tomada_el);
    if (f.lat != null && f.lng != null) { datos.append('lat', String(f.lat)); datos.append('lng', String(f.lng)); }
    if (f.reemplaza) datos.append('reemplaza', f.reemplaza);
    if (f.parada) datos.append('parada', f.parada);

    const x = new XMLHttpRequest();
    x.open('POST', API + '/remitos');
    x.setRequestHeader('Authorization', `Bearer ${tokenEnMemoria}`);
    x.responseType = 'text';
    x.timeout = 120_000;
    x.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) alSubir(e.loaded / e.total); };
    x.upload.onload = () => alLeer();
    x.onerror = () => rechazar(new SinSenal());
    x.ontimeout = () => rechazar(new SinSenal());
    x.onabort = () => rechazar(new SinSenal());
    x.onload = () => {
      if (x.status === 401) { rechazar(new LinkInvalido()); return; }
      if (x.status === 0 || reintentable(x.status)) { rechazar(new SinSenal()); return; }
      if (x.status < 200 || x.status >= 300) { rechazar(new Rechazo(x.status)); return; }
      try {
        const r = JSON.parse(x.responseText) as RemitoChofer;
        if (!r || typeof r !== 'object' || typeof r.estado !== 'string') throw new Error('respuesta rara');
        resolver(r);
      } catch {
        rechazar(new SinSenal());
      }
    };
    x.send(datos);
  });
}

// ---------- El recorrido del día (Cronograma del CRM) ----------
export type ParadaChofer = {
  clave: string; nombre: string; direccion: string | null; lat: number | null; lng: number | null; horario: [number, number] | null;
  visita: { resultado: 'hecho' | 'no_se_pudo' | 'salteada'; motivo: string | null; nota: string | null } | null;
  /** La entrega no va directo: se deja en este expreso, para ese cliente. */
  expreso?: { guia: string | null; cliente: string } | null;
  /** Lo que dice la libreta de direcciones de ese lugar. */
  lugar?: { horario: string | null; telefono: string | null; contacto: string | null; observaciones: string | null } | null;
  movimientos: Array<{ id: string; tipo: string; npdv: string | null; cliente: string | null; articulo: string; cantidad: number | null; hecho: boolean }>;
};
type LugarChofer = { nombre: string; direccion: string; lat: number | null; lng: number | null };
/** `fin`: dónde termina (null: en la última parada); `vuelve`: es el mismo lugar de donde sale. Sin `fin` (servidor de
    antes), vuelve. */
export type RecorridoChofer = { n: number; salida: number; base: LugarChofer; fin?: LugarChofer | null; vuelve?: boolean; paradas: ParadaChofer[] };

/** El recorrido que Logística le armó a este chofer para hoy (vacío si todavía no le asignaron ninguno). */
export async function pedirRuta(): Promise<RecorridoChofer[]> {
  const { recorridos } = await pedir<{ recorridos: RecorridoChofer[] }>('/ruta');
  return Array.isArray(recorridos) ? recorridos : [];
}

/** El chofer marca una parada: la hizo, no se pudo (con el motivo) o la deja para después. Sin `resultado`, lo borra. */
export async function marcarParada(clave: string, resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, motivo?: string, nota?: string): Promise<void> {
  if (!tokenEnMemoria) throw new LinkInvalido();
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 30_000);
  let r: Response;
  try {
    r = await fetch(`${API}/ruta/parada`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenEnMemoria}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, resultado, motivo, nota }), signal: corte.signal,
    });
  } catch { throw new SinSenal(); } finally { clearTimeout(reloj); }
  if (r.status === 401) throw new LinkInvalido();
  if (!r.ok) throw new Rechazo(r.status);
}
