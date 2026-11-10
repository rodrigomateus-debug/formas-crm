// Los envíos de esta sesión: cada foto pasa por «espera → mandando → leyendo → listo» (o vuelve a «espera» si se corta).
// Vive fuera de React para que los reintentos sigan aunque cambie la pantalla; la interfaz se suscribe con
// useSyncExternalStore.

import { LinkInvalido, Rechazo, mandarRemito, type RemitoChofer } from './api';
import { guardarEnCola, leerCola, sacarDeCola, type FotoEnCola } from './cola';
import { achicarFoto } from './imagen';

export type Envio = {
  clave: string;
  tomada_el: string;
  reemplaza?: string;
  /** espera: guardada en el celular, todavía no salió. */
  fase: 'espera' | 'mandando' | 'leyendo' | 'listo' | 'fallo';
  /** 0..1, cuánto de la foto ya subió (solo en «mandando»). */
  subido: number;
  /** Ya se intentó al menos una vez y no salió. */
  reintento: boolean;
  resultado?: RemitoChofer;
  fallo?: 'pesada' | 'rechazada';
  /** Miniatura (object URL) mientras la foto sigue en el celular. */
  mini?: string;
};

export type Estado = {
  envios: Envio[];
  /** El envío que se muestra grande arriba. */
  foco: string | null;
  linkInvalido: boolean;
};

const EN_PARALELO = 2;

let estado: Estado = { envios: [], foco: null, linkInvalido: false };
const fotos = new Map<string, FotoEnCola>();
const activos = new Set<string>();
const oyentes = new Set<() => void>();
let alTerminar: (e: Envio) => void = () => {};
let reloj: ReturnType<typeof setTimeout> | null = null;
let seguidos = 0; // intentos fallidos seguidos: cada vez se espera un poco más antes de reintentar

function publicar(cambio: Partial<Estado>): void {
  estado = { ...estado, ...cambio };
  oyentes.forEach((o) => o());
}
function cambiar(clave: string, cambio: Partial<Envio>): void {
  publicar({ envios: estado.envios.map((e) => (e.clave === clave ? { ...e, ...cambio } : e)) });
}
function soltarFoto(clave: string): void {
  fotos.delete(clave);
  const mini = estado.envios.find((e) => e.clave === clave)?.mini;
  if (mini) URL.revokeObjectURL(mini);
  sacarDeCola(clave).catch(() => {});
}

export const envios = {
  suscribir(o: () => void): () => void { oyentes.add(o); return () => { oyentes.delete(o); }; },
  leer(): Estado { return estado; },
  /** Se llama cada vez que un envío termina (bien o mal): para refrescar la lista y avisar. */
  alTerminar(f: (e: Envio) => void): void { alTerminar = f; },

  /** Foto nueva, ya achicada: se guarda en el celular y sale. */
  async agregar(foto: FotoEnCola): Promise<void> {
    fotos.set(foto.clave, foto);
    const nuevo: Envio = {
      clave: foto.clave, tomada_el: foto.tomada_el, reemplaza: foto.reemplaza,
      fase: 'espera', subido: 0, reintento: false, mini: URL.createObjectURL(foto.blob),
    };
    publicar({ envios: [...estado.envios, nuevo], foco: foto.clave });
    try { await guardarEnCola(foto); } catch { /* sin IndexedDB la foto queda en memoria y sale igual */ }
    envios.empujar();
  },

  /** Al abrir la app: levanta lo que había quedado guardado sin mandar. */
  async levantarCola(): Promise<void> {
    let guardadas: FotoEnCola[] = [];
    try { guardadas = await leerCola(); } catch { return; }
    const nuevos: Envio[] = [];
    for (const f of guardadas) {
      if (fotos.has(f.clave)) continue;
      fotos.set(f.clave, f);
      nuevos.push({
        clave: f.clave, tomada_el: f.tomada_el, reemplaza: f.reemplaza,
        fase: 'espera', subido: 0, reintento: true, mini: URL.createObjectURL(f.blob),
      });
    }
    if (nuevos.length) publicar({ envios: [...nuevos, ...estado.envios] });
    envios.empujar();
  },

  /** Manda lo que esté esperando (hasta dos fotos a la vez). Se puede llamar todas las veces que haga falta. */
  empujar(): void {
    if (estado.linkInvalido || navigator.onLine === false) return;
    for (const e of estado.envios) {
      if (activos.size >= EN_PARALELO) break;
      if (e.fase === 'espera' && !activos.has(e.clave) && fotos.has(e.clave)) void mandar(e.clave);
    }
  },

  enfocar(clave: string | null): void { publicar({ foco: clave }); },

  /** El chofer pegó un link nuevo: se vuelve a intentar todo. */
  linkNuevo(): void { publicar({ linkInvalido: false }); envios.empujar(); },
  marcarLinkInvalido(): void { if (!estado.linkInvalido) publicar({ linkInvalido: true }); },
};

function reintentarEnUnRato(): void {
  if (reloj) return;
  seguidos += 1;
  reloj = setTimeout(() => { reloj = null; envios.empujar(); }, Math.min(8_000 * seguidos, 30_000));
}

async function mandar(clave: string): Promise<void> {
  const foto = fotos.get(clave);
  if (!foto) return;
  activos.add(clave);
  cambiar(clave, { fase: 'mandando', subido: 0 });
  let salioBien = false;
  try {
    const r = await mandarRemito(
      foto,
      (parte) => cambiar(clave, { subido: parte }),
      () => cambiar(clave, { fase: 'leyendo', subido: 1 }),
    );
    salioBien = true;
    seguidos = 0;
    soltarFoto(clave);
    cambiar(clave, { fase: 'listo', resultado: r, mini: undefined });
    terminar(clave, r.repetir);
  } catch (e) {
    if (e instanceof LinkInvalido) {
      cambiar(clave, { fase: 'espera', reintento: true });
      publicar({ linkInvalido: true });
    } else if (e instanceof Rechazo && e.status === 413 && !foto.achicada) {
      // Muy pesada para el servidor: se achica más y se prueba otra vez, sin molestar al chofer.
      try {
        const menor = await achicarFoto(foto.blob, 4);
        const nueva: FotoEnCola = { ...foto, blob: menor, achicada: true };
        fotos.set(clave, nueva);
        guardarEnCola(nueva).catch(() => {});
        cambiar(clave, { fase: 'espera' });
        salioBien = true; // para que se vuelva a empujar enseguida
      } catch {
        soltarFoto(clave);
        cambiar(clave, { fase: 'fallo', fallo: 'pesada', mini: undefined });
        terminar(clave, true);
      }
    } else if (e instanceof Rechazo) {
      soltarFoto(clave);
      cambiar(clave, { fase: 'fallo', fallo: e.status === 413 ? 'pesada' : 'rechazada', mini: undefined });
      terminar(clave, true);
    } else {
      cambiar(clave, { fase: 'espera', reintento: true });
      reintentarEnUnRato();
    }
  } finally {
    activos.delete(clave);
    if (salioBien) envios.empujar();
  }
}

function terminar(clave: string, pideOtraFoto: boolean): void {
  // Si hay que repetir la foto y el chofer ya está con otra cosa, este envío pasa al frente: tiene que verlo ahora.
  if (pideOtraFoto && estado.foco !== clave) {
    const foco = estado.envios.find((e) => e.clave === estado.foco);
    const focoPideOtra = !!foco && (foco.fase === 'fallo' || !!foco.resultado?.repetir);
    if (!focoPideOtra) publicar({ foco: clave });
  }
  const e = estado.envios.find((x) => x.clave === clave);
  if (e) alTerminar(e);
}
