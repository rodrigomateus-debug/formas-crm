// Contrato con el servidor (/hooks/chofer/api) y el link personal del chofer.

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

/** Al abrir: si el link trae #t=…, lo guarda y lo saca de la barra de direcciones. */
export function tomarTokenDelLink(): void {
  const hash = window.location.hash;
  if (hash.includes('t=')) {
    const t = tokenDeTexto(hash);
    if (t) usarToken(t);
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* da igual */ }
  }
  if (!tokenEnMemoria) tokenEnMemoria = leer(CLAVE_TOKEN);
}

export function usarToken(t: string): void {
  tokenEnMemoria = t;
  guardar(CLAVE_TOKEN, t);
}
export function token(): string | null { return tokenEnMemoria; }

export function nombreGuardado(): string | null { return leer(CLAVE_NOMBRE); }

export class LinkInvalido extends Error {}
/** Sin señal, corte o servidor caído: conviene reintentar. */
export class SinSenal extends Error {}
/** El servidor rechazó el pedido y reintentar igual no sirve. */
export class Rechazo extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
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

export type FotoParaMandar = {
  clave: string;
  blob: Blob;
  tomada_el: string;
  lat?: number;
  lng?: number;
  /** Clave de la foto anterior que esta viene a reemplazar (cuando el servidor pidió repetirla). */
  reemplaza?: string;
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
