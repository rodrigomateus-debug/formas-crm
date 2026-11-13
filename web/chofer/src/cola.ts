// Cola de fotos en el celular (IndexedDB). Cada foto se guarda acá antes de mandarla y se borra recién cuando el
// servidor contesta: si se corta la señal o se cierra la app, la foto no se pierde y sale sola después.

export type FotoEnCola = {
  clave: string;
  blob: Blob;
  tomada_el: string;
  lat?: number;
  lng?: number;
  reemplaza?: string;
  /** La parada del recorrido desde la que se sacó (la cámara se abrió desde «Entregué» o «Dejé en el expreso»). */
  parada?: string;
  /** Ya se probó achicarla más después de un «muy pesada». */
  achicada?: boolean;
  /** Las fotos que se mandaron juntas comparten este identificador (solo para mostrar el avance «2 de 3»). */
  lote?: string;
};

/** Una foto de la tanda que el chofer está armando (ya achicada) y todavía no mandó. */
export type FotoDeTanda = {
  clave: string;
  blob: Blob;
  tomada_el: string;
  origen: 'camara' | 'guardada';
  reemplaza?: string;
  parada?: string;
  /** Para mostrarlas en el orden en que se sumaron. */
  orden: number;
};

const BASE = 'chofer';
const ALMACEN = 'cola';
const TANDA = 'tanda';

let abierta: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (!abierta) {
    abierta = new Promise<IDBDatabase>((ok, mal) => {
      const p = indexedDB.open(BASE, 2);
      p.onupgradeneeded = () => {
        for (const almacen of [ALMACEN, TANDA]) {
          if (!p.result.objectStoreNames.contains(almacen)) p.result.createObjectStore(almacen, { keyPath: 'clave' });
        }
      };
      p.onsuccess = () => {
        // Si otra pestaña con una versión más nueva necesita actualizar la base, esta la suelta.
        p.result.onversionchange = () => { p.result.close(); abierta = null; };
        ok(p.result);
      };
      p.onerror = () => mal(p.error);
      p.onblocked = () => mal(new Error('bloqueada'));
    });
    abierta.catch(() => { abierta = null; });
  }
  return abierta;
}

function operar<T>(modo: IDBTransactionMode, hacer: (a: IDBObjectStore) => IDBRequest<T>, almacen = ALMACEN): Promise<T> {
  return abrir().then((db) => new Promise<T>((ok, mal) => {
    const t = db.transaction(almacen, modo);
    const p = hacer(t.objectStore(almacen));
    t.oncomplete = () => ok(p.result);
    t.onerror = () => mal(t.error);
    t.onabort = () => mal(t.error);
  }));
}

export function guardarEnCola(f: FotoEnCola): Promise<unknown> {
  return operar('readwrite', (a) => a.put(f));
}
export function sacarDeCola(clave: string): Promise<unknown> {
  return operar('readwrite', (a) => a.delete(clave));
}
export async function leerCola(): Promise<FotoEnCola[]> {
  const todas = await operar<FotoEnCola[]>('readonly', (a) => a.getAll());
  return todas.sort((x, y) => x.tomada_el.localeCompare(y.tomada_el));
}

// La tanda a medio armar: si el chofer cierra la app antes de mandar, las fotos siguen acá al volver.
export function guardarEnTanda(f: FotoDeTanda): Promise<unknown> {
  return operar('readwrite', (a) => a.put(f), TANDA);
}
export function sacarDeTanda(clave: string): Promise<unknown> {
  return operar('readwrite', (a) => a.delete(clave), TANDA);
}
export function vaciarTanda(): Promise<unknown> {
  return operar('readwrite', (a) => a.clear(), TANDA);
}
export async function leerTanda(): Promise<FotoDeTanda[]> {
  const todas = await operar<FotoDeTanda[]>('readonly', (a) => a.getAll(), TANDA);
  return todas.sort((x, y) => x.orden - y.orden);
}
