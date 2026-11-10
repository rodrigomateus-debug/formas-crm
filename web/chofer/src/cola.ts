// Cola de fotos en el celular (IndexedDB). Cada foto se guarda acá antes de mandarla y se borra recién cuando el
// servidor contesta: si se corta la señal o se cierra la app, la foto no se pierde y sale sola después.

export type FotoEnCola = {
  clave: string;
  blob: Blob;
  tomada_el: string;
  lat?: number;
  lng?: number;
  reemplaza?: string;
  /** Ya se probó achicarla más después de un «muy pesada». */
  achicada?: boolean;
};

const BASE = 'chofer';
const ALMACEN = 'cola';

let abierta: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (!abierta) {
    abierta = new Promise<IDBDatabase>((ok, mal) => {
      const p = indexedDB.open(BASE, 1);
      p.onupgradeneeded = () => {
        if (!p.result.objectStoreNames.contains(ALMACEN)) p.result.createObjectStore(ALMACEN, { keyPath: 'clave' });
      };
      p.onsuccess = () => ok(p.result);
      p.onerror = () => mal(p.error);
      p.onblocked = () => mal(new Error('bloqueada'));
    });
    abierta.catch(() => { abierta = null; });
  }
  return abierta;
}

function operar<T>(modo: IDBTransactionMode, hacer: (a: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return abrir().then((db) => new Promise<T>((ok, mal) => {
    const t = db.transaction(ALMACEN, modo);
    const p = hacer(t.objectStore(ALMACEN));
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
