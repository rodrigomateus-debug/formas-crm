import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { RutaHoy } from './Ruta';
import {
  LinkInvalido, Rechazo, corregirPdv, entrarConCodigo, nombreGuardado, pedirRemitos, pedirYo, token, tokenDeTexto, usarToken, type RemitoChofer,
} from './api';
import { envios, type Envio } from './envios';
import { guardarEnTanda, leerTanda, sacarDeTanda, vaciarTanda, type FotoDeTanda } from './cola';
import { achicarFoto } from './imagen';
import { conTope, ubicacion, type Punto } from './ubicacion';
import { Icono, Marca } from './iconos';
import { instalacion, instalada, telefono } from './instalar';

// ---------- Utilidades ----------

function claveNueva(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
}

function esHoy(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
}

const formatoHora = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
function hora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : formatoHora.format(d);
}

const formatoNumero = new Intl.NumberFormat('es-AR');

function leerLista(clave: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(clave) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** Lo último que contestó el servidor, para mostrar la lista aunque la app abra sin señal. */
function remitosGuardados(): RemitoChofer[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem('chofer-remitos') || '[]');
    return Array.isArray(v) ? (v as RemitoChofer[]) : [];
  } catch { return []; }
}

type Tono = 'bien' | 'aviso' | 'mal' | 'neutro';
type Lectura = { tono: Tono; icono: string; titulo: string };

/** Qué significa cada respuesta del servidor para el chofer. */
function lectura(r: RemitoChofer): Lectura {
  if (r.repetir) return { tono: 'mal', icono: 'repetir', titulo: 'Sacala de nuevo' };
  if (faltaPdv(r)) return { tono: 'aviso', icono: 'aviso', titulo: 'Falta el número de PDV' };
  switch (r.estado) {
    case 'ok': return { tono: 'bien', icono: 'bien', titulo: 'Listo' };
    case 'revisar': return { tono: 'aviso', icono: 'aviso', titulo: 'Llegó. Lo revisa Logística' };
    case 'duplicado': return { tono: 'neutro', icono: 'copia', titulo: 'Ese remito ya estaba mandado' };
    case 'descartado': return { tono: 'neutro', icono: 'cruz', titulo: 'Logística lo descartó' };
    default: return { tono: 'neutro', icono: 'reloj', titulo: 'Llegó. Se lee más tarde' };
  }
}

/** El servidor pide el PDV y todavía se puede escribir (un duplicado o un descartado ya no se corrigen). */
function faltaPdv(r: RemitoChofer): boolean {
  return !!r.pide_pdv && r.estado !== 'duplicado' && r.estado !== 'descartado';
}

function tituloRemito(r: RemitoChofer): string {
  const partes = [r.pdv ? `PDV ${r.pdv}` : null, r.cliente].filter(Boolean);
  if (partes.length) return partes.join(' · ');
  if (r.numero) return `Remito ${r.numero}`;
  return `Foto de las ${hora(r.creado)}`;
}

function textoItem(i: { descripcion: string; cantidad: number | null }): string {
  return i.cantidad != null ? `${formatoNumero.format(i.cantidad)} ${i.descripcion}` : i.descripcion;
}

function resumenItems(r: RemitoChofer): string {
  if (!r.items.length) return '';
  const primero = textoItem(r.items[0]);
  return r.items.length > 1 ? `${primero} y ${r.items.length - 1} más` : primero;
}

const FALLOS: Record<NonNullable<Envio['fallo']>, string> = {
  pesada: 'La foto salió muy pesada y no se pudo mandar.',
  rechazada: 'Esta foto no se pudo mandar.',
};

function useEnLinea(): boolean {
  const [enLinea, setEnLinea] = useState(() => navigator.onLine);
  useEffect(() => {
    const si = () => setEnLinea(true);
    const no = () => setEnLinea(false);
    window.addEventListener('online', si);
    window.addEventListener('offline', no);
    return () => { window.removeEventListener('online', si); window.removeEventListener('offline', no); };
  }, []);
  return enLinea;
}

// ---------- App ----------

/** De dónde viene la foto: recién sacada con la cámara o elegida entre las guardadas en el celular. */
type Origen = 'camara' | 'guardada';
/** Una foto de la tanda que se está armando: ya achicada, con su dirección para mostrarla. */
type FotoTanda = FotoDeTanda & { url: string };
/** Cuántas fotos entran en una tanda. */
const TOPE_TANDA = 10;

export default function App() {
  const estado = useSyncExternalStore(envios.suscribir, envios.leer);
  const enLinea = useEnLinea();
  const [hayToken, setHayToken] = useState(() => !!token());
  const [nombre, setNombre] = useState<string | null>(() => nombreGuardado());
  const [remitos, setRemitos] = useState<RemitoChofer[]>(remitosGuardados);
  const [listaAlDia, setListaAlDia] = useState(false);
  const [reemplazadas, setReemplazadas] = useState<string[]>(() => leerLista('chofer-reemplazadas'));
  /** La tanda: las fotos sacadas o elegidas que todavía no se mandaron. También queda guardada en el celular. */
  const [tanda, setTanda] = useState<FotoTanda[]>([]);
  const [viendo, setViendo] = useState(false);       // la vista previa está abierta
  const [preparando, setPreparando] = useState(0);   // fotos que se están achicando
  const [elegida, setElegida] = useState<string | null>(null); // la que se ve grande
  const [avisoTanda, setAvisoTanda] = useState('');
  const [anuncio, setAnuncio] = useState('');
  /** Un remito de la lista de hoy traído a la tarjeta grande (para escribirle el PDV). */
  const [idSuelto, setIdSuelto] = useState<number | null>(null);

  const entrada = useRef<HTMLInputElement>(null);
  const entradaGuardadas = useRef<HTMLInputElement>(null);
  const tandaAhora = useRef(tanda); // la tanda al día, para lo que corre fuera del dibujado
  tandaAhora.current = tanda;
  const enCamino = useRef(0);       // fotos que se están achicando (cuentan para el tope)
  const tandaLevantada = useRef(false);
  const reemplaza = useRef<string | undefined>(undefined);
  const punto = useRef<Promise<Punto | null> | null>(null);
  const arriba = useRef<HTMLHeadingElement>(null);

  const refrescar = useCallback(async () => {
    if (!token()) return;
    try {
      const lista = await pedirRemitos();
      setRemitos(lista);
      setListaAlDia(true);
      try { localStorage.setItem('chofer-remitos', JSON.stringify(lista)); } catch { /* da igual */ }
    } catch (e) {
      if (e instanceof LinkInvalido) envios.marcarLinkInvalido();
    }
  }, []);

  // Al abrir: quién es, qué mandó hoy y qué había quedado sin mandar.
  useEffect(() => {
    if (!hayToken) return;
    pedirYo().then(setNombre).catch((e) => { if (e instanceof LinkInvalido) envios.marcarLinkInvalido(); });
    void refrescar();
    void envios.levantarCola();
    try { void navigator.storage?.persist?.(); } catch { /* opcional */ }
  }, [hayToken, refrescar]);

  // Cuando un envío termina: se avisa (vibración + lector de pantalla) y se refresca la lista.
  useEffect(() => {
    envios.alTerminar((e) => {
      const r = e.resultado;
      const pideOtra = e.fase === 'fallo' || !!r?.repetir;
      try { navigator.vibrate?.(pideOtra ? [90, 70, 90] : 50); } catch { /* sin vibración */ }
      if (r) setAnuncio(r.repetir ? `Sacala de nuevo. ${r.mensaje}` : r.mensaje || lectura(r).titulo);
      else if (e.fallo) setAnuncio(`Sacala de nuevo. ${FALLOS[e.fallo]}`);
      void refrescar();
    });
  }, [refrescar]);

  // Reintentos: al volver la señal, al volver a la app y cada tanto.
  useEffect(() => {
    const empujar = () => { envios.empujar(); void refrescar(); };
    const alVolver = () => { if (document.visibilityState === 'visible') empujar(); };
    window.addEventListener('online', empujar);
    document.addEventListener('visibilitychange', alVolver);
    const cadaTanto = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      envios.empujar();
    }, 30_000);
    return () => {
      window.removeEventListener('online', empujar);
      document.removeEventListener('visibilitychange', alVolver);
      clearInterval(cadaTanto);
    };
  }, [refrescar]);

  // Si algún remito de hoy quedó «se lee más tarde», se vuelve a preguntar cada tanto hasta que tenga respuesta.
  const hayPorLeer = remitos.some((r) => r.estado === 'sin_leer' && esHoy(r.creado))
    || estado.envios.some((e) => e.resultado?.estado === 'sin_leer');
  useEffect(() => {
    if (!hayPorLeer) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refrescar(); }, 20_000);
    return () => clearInterval(t);
  }, [hayPorLeer, refrescar]);

  // ----- Cámara, fotos guardadas y la tanda -----

  // Al abrir: si quedó una tanda a medio armar (cerró la app antes de mandar), vuelve a aparecer.
  useEffect(() => {
    if (!hayToken || tandaLevantada.current) return;
    tandaLevantada.current = true;
    leerTanda().then((guardadas) => {
      if (!guardadas.length) return;
      setTanda((antes) => [...guardadas.filter((g) => !antes.some((a) => a.clave === g.clave)).map((g) => ({ ...g, url: URL.createObjectURL(g.blob) })), ...antes]);
    }).catch(() => { /* sin IndexedDB no hay tanda guardada */ });
  }, [hayToken]);

  // El botón «atrás» del celular cierra la vista previa en vez de salir de la app: al abrirla se suma un paso al
  // historial y al cerrarla se vuelve.
  useEffect(() => {
    const atras = () => setViendo(false);
    window.addEventListener('popstate', atras);
    return () => window.removeEventListener('popstate', atras);
  }, []);

  const enPrevia = () => {
    try { return !!(history.state as { previa?: boolean } | null)?.previa; } catch { return false; }
  };
  function abrirPrevia() {
    setViendo(true);
    if (!enPrevia()) { try { history.pushState({ previa: true }, ''); } catch { /* da igual */ } }
  }
  /** Cierra la vista previa. La tanda no se pierde: queda en el inicio como «fotos sin mandar». */
  function cerrarPrevia() {
    setViendo(false);
    if (enPrevia()) history.back();
  }

  function abrirCamara(reemplazaA?: string) {
    reemplaza.current = reemplazaA;
    entrada.current?.click();
  }
  function abrirGuardadas(reemplazaA?: string) {
    reemplaza.current = reemplazaA;
    entradaGuardadas.current?.click();
  }

  /** Fotos nuevas (una de la cámara, o una o varias guardadas): se achican y se suman a la tanda. */
  async function alElegir(lista: FileList | null, origen: Origen) {
    const archivos = Array.from(lista ?? []);
    if (!archivos.length) return;
    const reemplazaA = reemplaza.current;
    reemplaza.current = undefined;
    const lugar = Math.max(0, TOPE_TANDA - tandaAhora.current.length - enCamino.current);
    const entran = archivos.slice(0, lugar);
    setAvisoTanda(entran.length < archivos.length
      ? `Entran hasta ${TOPE_TANDA} fotos por vez. Mandá estas y después seguí con las que faltan.` : '');
    abrirPrevia();
    if (!entran.length) return;
    // La ubicación solo sirve si la foto se está sacando ahora: una guardada pudo sacarse en cualquier lado.
    if (origen === 'camara' && !punto.current) punto.current = ubicacion();
    enCamino.current += entran.length;
    setPreparando((n) => n + entran.length);
    let fallaron = 0;
    for (const [i, archivo] of entran.entries()) {
      try {
        const blob = await achicarFoto(archivo);
        const tomada = archivo.lastModified > 0 && archivo.lastModified <= Date.now() ? archivo.lastModified : Date.now();
        const foto: FotoDeTanda = {
          clave: claveNueva(), blob, tomada_el: new Date(tomada).toISOString(), origen,
          reemplaza: i === 0 ? reemplazaA : undefined, // «Sacala de nuevo» reemplaza a una sola foto
          orden: Date.now() + i / 1000,
        };
        setTanda((antes) => [...antes, { ...foto, url: URL.createObjectURL(blob) }]);
        setElegida(foto.clave);
        guardarEnTanda(foto).catch(() => { /* sin IndexedDB la tanda vive mientras la app esté abierta */ });
      } catch {
        fallaron += 1;
      } finally {
        enCamino.current -= 1;
        setPreparando((n) => n - 1);
      }
    }
    if (fallaron) {
      setAvisoTanda(fallaron === 1
        ? (origen === 'guardada' ? 'Una foto no se pudo abrir. Probá con otra.' : 'La foto no se pudo abrir. Probá sacarla de nuevo.')
        : `${fallaron} fotos no se pudieron abrir. Probá con otras.`);
    }
  }

  function sacarDeLaTanda(clave: string) {
    const foto = tandaAhora.current.find((f) => f.clave === clave);
    if (!foto) return;
    URL.revokeObjectURL(foto.url);
    setTanda((antes) => antes.filter((f) => f.clave !== clave));
    setAvisoTanda('');
    sacarDeTanda(clave).catch(() => {});
  }

  function descartarTanda() {
    tandaAhora.current.forEach((f) => URL.revokeObjectURL(f.url));
    setTanda([]);
    setAvisoTanda('');
    vaciarTanda().catch(() => {});
  }

  // Si se sacaron todas las fotos de la tanda, no queda nada que mirar: se cierra la vista previa.
  useEffect(() => {
    if (viendo && tanda.length === 0 && preparando === 0 && !avisoTanda) cerrarPrevia();
  });

  /** Manda la tanda: cada foto es un envío propio, con su clave; las que van juntas comparten lote. */
  async function mandarTanda() {
    const fotos = tandaAhora.current;
    if (!fotos.length) return;
    const esperaLugar = punto.current;
    punto.current = null;
    setTanda([]);
    setAvisoTanda('');
    cerrarPrevia();
    setAnuncio(fotos.length === 1 ? 'Mandando la foto.' : `Mandando ${fotos.length} fotos.`);
    const lugar = esperaLugar && fotos.some((f) => f.origen === 'camara') ? await conTope(esperaLugar, 800) : null;
    const repetidas = fotos.map((f) => f.reemplaza).filter((c): c is string => !!c);
    if (repetidas.length) {
      setReemplazadas((antes) => {
        const lista = [...antes.filter((c) => !repetidas.includes(c)), ...repetidas].slice(-60);
        try { localStorage.setItem('chofer-reemplazadas', JSON.stringify(lista)); } catch { /* da igual */ }
        return lista;
      });
    }
    const lote = fotos.length > 1 ? claveNueva() : undefined;
    for (const f of fotos) {
      const conLugar = f.origen === 'camara' ? lugar : null;
      await envios.agregar({ clave: f.clave, blob: f.blob, tomada_el: f.tomada_el, lat: conLugar?.lat, lng: conLugar?.lng, reemplaza: f.reemplaza, lote });
      sacarDeTanda(f.clave).catch(() => {}); // ya quedó en la cola de envíos
      URL.revokeObjectURL(f.url);
    }
    window.scrollTo({ top: 0 });
    arriba.current?.focus({ preventScroll: true });
  }

  // ----- Qué se muestra -----

  const foco = estado.envios.find((e) => e.clave === estado.foco) ?? null;

  // Una foto nueva (o una que pide repetirse) pasa al frente: el remito traído de la lista vuelve a la lista.
  useEffect(() => { if (estado.foco) setIdSuelto(null); }, [estado.foco]);

  /** Trae un remito de la lista a la tarjeta grande. */
  function traerAlFrente(r: RemitoChofer) {
    const suyo = estado.envios.find((e) => e.resultado?.id === r.id);
    if (suyo) { setIdSuelto(null); envios.enfocar(suyo.clave); } else { envios.enfocar(null); setIdSuelto(r.id); }
    window.scrollTo({ top: 0 });
  }

  /** El servidor contestó una corrección de PDV: se guarda el remito actualizado y se avisa. */
  function alCorregirPdv(r: RemitoChofer) {
    setRemitos((antes) => {
      const lista = antes.some((x) => x.id === r.id) ? antes.map((x) => (x.id === r.id ? r : x)) : [r, ...antes];
      try { localStorage.setItem('chofer-remitos', JSON.stringify(lista)); } catch { /* da igual */ }
      return lista;
    });
    setAnuncio(r.mensaje || lectura(r).titulo);
    try { navigator.vibrate?.(50); } catch { /* sin vibración */ }
  }

  /** La versión más nueva de un remito: la de la lista del servidor si ya la trae, si no la respuesta del envío. */
  const alDia = useCallback((r: RemitoChofer): RemitoChofer => {
    return remitos.find((x) => x.id === r.id) ?? r;
  }, [remitos]);

  const suelto = idSuelto != null ? remitos.find((r) => r.id === idSuelto) ?? null : null;
  const envioFoco = suelto ? null : foco;
  const remitoFoco = suelto ?? (foco?.resultado ? alDia(foco.resultado) : null);
  const claveFoco = suelto ? (suelto.clave ?? `remito-${suelto.id}`) : foco ? (remitoFoco?.clave ?? foco.clave) : null;
  const hayFoco = !!envioFoco || !!suelto;
  const focoPideOtra = hayFoco && (envioFoco?.fase === 'fallo' || !!remitoFoco?.repetir) && !reemplazadas.includes(claveFoco ?? '');

  // Fotos mandadas juntas: mientras ninguna pida nada, la tarjeta grande muestra el avance de todas («Mandando 2 de 3…»)
  // y cada resultado va apareciendo en la lista de hoy. La que pide algo (otra foto o el PDV) pasa al frente.
  const pideAlgo = (e: Envio): boolean => {
    if (e.fase === 'fallo') return true;
    const r = e.resultado ? alDia(e.resultado) : null;
    return !!r && ((r.repetir && !reemplazadas.includes(r.clave ?? e.clave)) || faltaPdv(r));
  };
  const loteFoco = envioFoco?.lote ? estado.envios.filter((e) => e.lote === envioFoco.lote) : [];
  const enLote = !!envioFoco && loteFoco.length > 1 && !pideAlgo(envioFoco);
  const loteTerminado = enLote && loteFoco.every((e) => e.fase === 'listo' || e.fase === 'fallo');
  const pideDelLote = loteTerminado ? loteFoco.find(pideAlgo)?.clave : undefined;
  useEffect(() => { if (pideDelLote) envios.enfocar(pideDelLote); }, [pideDelLote]);

  const filas = useMemo(() => {
    type Fila = { llave: string; cuando: string; clave: string; envio?: Envio; remito?: RemitoChofer };
    const lista: Fila[] = [];
    const idsLocales = new Set<number>();
    for (const e of estado.envios) {
      if (e.resultado) idsLocales.add(e.resultado.id);
      if (!enLote && e.clave === envioFoco?.clave) continue;
      if (e.resultado) {
        if (esHoy(e.resultado.creado) && !remitos.some((r) => r.id === e.resultado!.id)) {
          lista.push({ llave: `r${e.resultado.id}`, cuando: e.resultado.creado, clave: e.resultado.clave ?? e.clave, remito: e.resultado });
        }
      } else {
        lista.push({ llave: `e${e.clave}`, cuando: e.tomada_el, clave: e.clave, envio: e });
      }
    }
    const idFoco = enLote ? undefined : remitoFoco?.id;
    for (const r of remitos) {
      if (!esHoy(r.creado) || r.id === idFoco) continue;
      lista.push({ llave: `r${r.id}`, cuando: r.creado, clave: r.clave ?? `remito-${r.id}`, remito: r });
    }
    return lista.sort((a, b) => b.cuando.localeCompare(a.cuando));
  }, [estado.envios, remitos, envioFoco, remitoFoco, enLote]);

  const esperando = estado.envios.filter((e) => e.fase === 'espera');
  const esperandoFuera = esperando.filter((e) => e.clave !== estado.foco).length;

  if (!hayToken || estado.linkInvalido) {
    return (
      <LinkRoto
        sinLink={!token()}
        guardadas={esperando.length}
        alEntrar={(t) => { if (t) usarToken(t); setHayToken(true); setNombre(nombreGuardado()); envios.linkNuevo(); void refrescar(); pedirYo().then(setNombre).catch(() => {}); }}
      />
    );
  }

  const primerNombre = nombre?.trim().split(/\s+/)[0];

  return (
    <div className="app">
      <header className="barra">
        <Marca tamano={30} />
        <span className="marca">Remitos <span>Formas</span></span>
        {!enLinea && (
          <span className="chip-senal"><Icono nombre="sinSenal" tamano={18} /> Sin señal</span>
        )}
      </header>

      <main className="cuerpo">
        <h1 ref={arriba} tabIndex={-1}>{primerNombre ? `Hola, ${primerNombre}` : 'Hola'}</h1>

        <p className="solo-lector" role="status" aria-live="polite">{anuncio}</p>

        {tanda.length > 0 && !viendo && (
          <section className="sin-mandar" aria-labelledby="titulo-sin-mandar">
            <h2 id="titulo-sin-mandar">{tanda.length === 1 ? 'Tenés 1 foto sin mandar' : `Tenés ${tanda.length} fotos sin mandar`}</h2>
            <button type="button" className="minis" onClick={abrirPrevia} aria-label="Ver las fotos sin mandar">
              {tanda.slice(0, 5).map((f) => <img key={f.clave} src={f.url} alt="" />)}
              {tanda.length > 5 && <span>+{tanda.length - 5}</span>}
            </button>
            <div className="acciones">
              <button type="button" className="boton principal" onClick={() => void mandarTanda()}>
                <Icono nombre="subir" tamano={24} /> {tanda.length === 1 ? 'Mandar' : `Mandar las ${tanda.length}`}
              </button>
              <button type="button" className="enlace" onClick={descartarTanda}>Descartar</button>
            </div>
          </section>
        )}

        {enLote && <TarjetaLote envios={loteFoco} enLinea={enLinea} alReintentar={() => envios.empujar()} />}

        {hayFoco && !enLote && (
          <TarjetaFoco
            key={remitoFoco ? `r${remitoFoco.id}` : `e${envioFoco?.clave}`}
            envio={envioFoco}
            remito={remitoFoco}
            enLinea={enLinea}
            pideOtra={focoPideOtra}
            escribirYa={!!suelto}
            alReintentar={() => envios.empujar()}
            alSeguir={() => { setIdSuelto(null); envios.enfocar(null); }}
            alCorregirPdv={alCorregirPdv}
          />
        )}

        {esperandoFuera > 0 && (
          <section className="aviso-cola" aria-label="Fotos sin mandar">
            <Icono nombre="sinSenal" tamano={28} />
            <div>
              <strong>{esperandoFuera === 1 ? '1 foto esperando señal' : `${esperandoFuera} fotos esperando señal`}</strong>
              <p>Están guardadas en el celular. Salen solas cuando vuelva la señal.</p>
            </div>
            {enLinea && <button type="button" className="boton chico" onClick={() => envios.empujar()}>Probar ahora</button>}
          </section>
        )}

        {!hayFoco && <TarjetaInstalar />}

        {!hayFoco && <Consejos />}

        {!hayFoco && <RutaHoy enLinea={enLinea} alEntregar={() => abrirCamara()} />}

        <section className="hoy" aria-labelledby="titulo-hoy">
          <h2 id="titulo-hoy">Hoy {filas.length > 0 && <span className="cuenta">{filas.length}</span>}</h2>
          {filas.length === 0 ? (
            <p className="vacio">
              {hayFoco ? 'Acá vas a ver los otros remitos que mandes hoy.'
                : listaAlDia || enLinea ? 'Todavía no mandaste ningún remito hoy.'
                : 'Sin señal no se puede ver lo que mandaste hoy. Igual podés sacar fotos: se mandan solas después.'}
            </p>
          ) : (
            <ul className="lista">
              {filas.map((f) => (
                <li key={f.llave}>
                  {f.envio
                    ? <FilaEnvio envio={f.envio} enLinea={enLinea} alRepetir={() => abrirCamara(f.envio!.clave)} />
                    : <FilaRemito
                        remito={f.remito!}
                        yaRepetida={reemplazadas.includes(f.clave)}
                        alRepetir={() => abrirCamara(f.clave)}
                        alEscribirPdv={() => traerAlFrente(f.remito!)}
                      />}
                </li>
              ))}
            </ul>
          )}
        </section>

        {hayFoco && <Consejos />}
      </main>

      <div className="muelle">
        <button
          type="button"
          className={`boton principal enorme${focoPideOtra ? ' otra' : ''}`}
          onClick={() => abrirCamara(focoPideOtra ? claveFoco ?? undefined : undefined)}
        >
          <Icono nombre={focoPideOtra ? 'repetir' : 'camara'} tamano={32} />
          {focoPideOtra ? 'Sacar otra foto' : 'Sacar foto del remito'}
        </button>
        <button
          type="button"
          className="boton guardada"
          onClick={() => abrirGuardadas(focoPideOtra ? claveFoco ?? undefined : undefined)}
        >
          <Icono nombre="galeria" tamano={24} />
          Subir una foto guardada
        </button>
      </div>

      {/* Dos entradas: la de la cámara (capture) abre directo la cámara; la otra deja elegir fotos ya guardadas. */}
      <input
        ref={entrada}
        id="foto-camara"
        className="solo-lector"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => { const l = e.target.files; alElegir(l, 'camara'); e.target.value = ''; }}
      />
      <input
        ref={entradaGuardadas}
        id="foto-guardada"
        className="solo-lector"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => { const l = e.target.files; alElegir(l, 'guardada'); e.target.value = ''; }}
      />

      {viendo && (
        <VistaPrevia
          fotos={tanda}
          elegida={elegida}
          preparando={preparando}
          aviso={avisoTanda}
          llena={tanda.length + preparando >= TOPE_TANDA}
          alElegir={setElegida}
          alSacar={sacarDeLaTanda}
          alCamara={() => abrirCamara()}
          alGuardadas={() => abrirGuardadas()}
          alMandar={() => void mandarTanda()}
          alCerrar={cerrarPrevia}
        />
      )}
    </div>
  );
}

// ---------- Piezas ----------

/** Invitación a agregarla a la pantalla de inicio: solo en el navegador, chica y se puede cerrar para siempre. */
function TarjetaInstalar() {
  const { conBoton, hecha } = useSyncExternalStore(instalacion.suscribir, instalacion.leer);
  const [cerrada, setCerrada] = useState(() => {
    try { return localStorage.getItem('chofer-instalar-cerrada') === '1'; } catch { return false; }
  });
  const tel = useMemo(telefono, []);
  if (cerrada || hecha || instalada()) return null;
  if (tel === 'otro' && !conBoton) return null; // en una computadora sin instalación no hay nada que ofrecer
  const cerrar = () => {
    setCerrada(true);
    try { localStorage.setItem('chofer-instalar-cerrada', '1'); } catch { /* se vuelve a mostrar la próxima vez */ }
  };
  return (
    <section className="instalar" aria-labelledby="titulo-instalar">
      <img src={`${import.meta.env.BASE_URL}icono.svg`} alt="" width="44" height="44" />
      <div>
        <h2 id="titulo-instalar">Para tenerla a mano, agregala a la pantalla de inicio</h2>
        {conBoton ? (
          <button type="button" className="boton chico" onClick={() => void instalacion.pedir()}>Agregar a inicio</button>
        ) : tel === 'iphone' ? (
          <p>Tocá <span className="tecla"><Icono nombre="compartir" tamano={20} /> Compartir</span> y después <strong>«Agregar a inicio»</strong>.</p>
        ) : (
          <p>Tocá los tres puntitos <span className="tecla" aria-hidden="true">⋮</span> del navegador y después <strong>«Agregar a la pantalla principal»</strong>.</p>
        )}
      </div>
      <button type="button" className="cerrar-tarjeta" onClick={cerrar} aria-label="Cerrar este aviso">
        <Icono nombre="cruz" tamano={22} />
      </button>
    </section>
  );
}

function Consejos() {
  return (
    <section className="consejos" aria-labelledby="titulo-consejos">
      <h2 id="titulo-consejos">Para que se lea bien</h2>
      <ul>
        <li><Icono nombre="entero" tamano={26} /> El remito entero</li>
        <li><Icono nombre="frente" tamano={26} /> De frente</li>
        <li><Icono nombre="sol" tamano={26} /> Sin sombra</li>
        <li><Icono nombre="uno" tamano={26} /> Una foto por remito</li>
      </ul>
    </section>
  );
}

function DatosLeidos({ remito }: { remito: RemitoChofer }) {
  const hayDatos = remito.pdv || remito.cliente || remito.numero || remito.pdv_chofer || remito.items.length > 0;
  if (!hayDatos) return null;
  return (
    <div className="leido">
      {(remito.pdv || remito.cliente) && (
        <p className="quien">
          {remito.pdv && <span className="pdv">PDV {remito.pdv}</span>}
          {remito.cliente && <span className="cliente">{remito.cliente}</span>}
        </p>
      )}
      {remito.numero && <p className="numero">Remito {remito.numero}</p>}
      {remito.pdv_chofer && remito.pdv_chofer !== remito.pdv && <p className="numero">PDV que escribiste: {remito.pdv_chofer}</p>}
      {remito.items.length > 0 && (
        <ul className="items">
          {remito.items.map((i, n) => (
            <li key={n}>
              <span className="cant">{i.cantidad != null ? formatoNumero.format(i.cantidad) : '–'}</span>
              <span>{i.descripcion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** El campo para escribir o corregir el número de PDV. No va a la cola: si no hay señal, queda escrito y se prueba otra vez. */
function CampoPdv({ remito, modo, enfocar, alListo, alCancelar }: {
  remito: RemitoChofer;
  /** falta: el servidor lo pide · alternativa: lo pide pero conviene otra foto · corregir: el chofer dice que no es ese pedido. */
  modo: 'falta' | 'alternativa' | 'corregir';
  enfocar: boolean;
  alListo: (r: RemitoChofer) => void;
  alCancelar?: () => void;
}) {
  const [valor, setValor] = useState(() => (modo === 'corregir' ? remito.pdv ?? '' : remito.pdv_chofer ?? ''));
  const [mandando, setMandando] = useState(false);
  const [error, setError] = useState('');
  const [soloNumeros, setSoloNumeros] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const id = `pdv-${remito.id}`;

  useEffect(() => {
    if (!enfocar) return;
    campo.current?.focus();
    campo.current?.select();
  }, [enfocar]);

  function alEscribir(texto: string) {
    const limpio = texto.replace(/\D/g, '').slice(0, 10);
    setValor(limpio);
    setError('');
    // Las letras no entran al campo; el aviso queda a la vista para que se entienda por qué.
    if (/[^\d\s.]/.test(texto)) setSoloNumeros(true);
  }

  async function mandar(e: FormEvent) {
    e.preventDefault();
    if (mandando) return;
    if (!valor) { setError('Escribí el número de PDV.'); campo.current?.focus(); return; }
    setMandando(true);
    setError('');
    try {
      const r = await corregirPdv(remito.id, valor);
      alListo(r);
      // Si el servidor lo vuelve a pedir (no hay pedido con ese número), el número queda a la vista para corregirlo.
      if (r.pide_pdv) { campo.current?.focus(); campo.current?.select(); }
    } catch (err) {
      if (err instanceof LinkInvalido) envios.marcarLinkInvalido();
      else if (err instanceof Rechazo) {
        setError(err.status === 404 ? 'No encontramos este remito. Avisale a Logística.'
          : err.status === 409 ? 'Este remito ya no se puede corregir.'
          : err.detalle || 'Ese número no sirve. Revisalo y probá de nuevo.');
      } else setError('No hay señal: probá de nuevo en un rato.');
    } finally {
      setMandando(false);
    }
  }

  return (
    <form className={`campo-pdv ${modo}`} onSubmit={mandar} noValidate>
      <label htmlFor={id}>
        {modo === 'alternativa' ? 'O escribí el número de PDV' : modo === 'corregir' ? 'Número de PDV correcto' : 'Número de PDV'}
      </label>
      <input
        ref={campo} id={id} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="send"
        placeholder="Ej.: 30706" value={valor} onChange={(e) => alEscribir(e.target.value)}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : soloNumeros ? `${id}-pista` : undefined}
      />
      {error
        ? <p id={`${id}-error`} className="error" role="alert">{error}</p>
        : soloNumeros && <p id={`${id}-pista`} className="pista" role="status">Van solo números: las letras no se escriben.</p>}
      <div className="acciones">
        <button type="submit" className={`boton ${modo === 'alternativa' ? 'chico' : 'principal'}`} disabled={mandando}>
          {mandando ? <><span className="girando" aria-hidden="true" /> Mandando…</> : modo === 'alternativa' ? 'Mandar el PDV' : 'Mandar'}
        </button>
        {alCancelar && <button type="button" className="enlace" onClick={alCancelar} disabled={mandando}>Cancelar</button>}
      </div>
    </form>
  );
}

function TarjetaFoco({ envio, remito, enLinea, pideOtra, escribirYa, alReintentar, alSeguir, alCorregirPdv }: {
  envio: Envio | null; remito: RemitoChofer | null; enLinea: boolean; pideOtra: boolean;
  /** El chofer tocó «Escribir el PDV» en la lista: el campo arranca con el cursor. */
  escribirYa: boolean;
  alReintentar: () => void; alSeguir: () => void; alCorregirPdv: (r: RemitoChofer) => void;
}) {
  const [corrigiendo, setCorrigiendo] = useState(false);
  if (envio?.fase === 'fallo') {
    return (
      <section className="foco mal" aria-label="Resultado de la última foto">
        <div className="cabeza"><span className="sello"><Icono nombre="repetir" tamano={30} /></span><h2>Sacala de nuevo</h2></div>
        <div className="detalle">
          <p className="mensaje">{FALLOS[envio.fallo ?? 'rechazada']}</p>
          {pideOtra && <button type="button" className="enlace" onClick={alSeguir}>Seguir con otro remito</button>}
        </div>
      </section>
    );
  }

  if (remito) {
    const l = lectura(remito);
    return (
      <section className={`foco ${l.tono}`} aria-label="Resultado de la última foto">
        <div className="cabeza"><span className="sello"><Icono nombre={l.icono} tamano={30} /></span><h2>{l.titulo}</h2></div>
        <div className="detalle">
          {remito.mensaje && <p className="mensaje">{remito.mensaje}</p>}
          {faltaPdv(remito) && !pideOtra && (
            <CampoPdv remito={remito} modo="falta" enfocar={escribirYa} alListo={alCorregirPdv} />
          )}
          <DatosLeidos remito={remito} />
          {remito.repetir && !pideOtra && <p className="nota">Ya sacaste otra foto de este remito.</p>}
          {faltaPdv(remito) && pideOtra && (
            <CampoPdv remito={remito} modo="alternativa" enfocar={escribirYa} alListo={alCorregirPdv} />
          )}
          {remito.estado === 'ok' && !remito.repetir && remito.pdv && (corrigiendo ? (
            <CampoPdv
              remito={remito} modo="corregir" enfocar
              alListo={(r) => { setCorrigiendo(false); alCorregirPdv(r); }}
              alCancelar={() => setCorrigiendo(false)}
            />
          ) : (
            <button type="button" className="enlace" onClick={() => setCorrigiendo(true)}>¿No es este pedido? Corregilo</button>
          ))}
          {pideOtra && <button type="button" className="enlace" onClick={alSeguir}>Seguir con otro remito</button>}
          {!envio && !pideOtra && <button type="button" className="enlace" onClick={alSeguir}>Volver a la lista</button>}
        </div>
      </section>
    );
  }
  if (!envio) return null;

  const porciento = Math.round(envio.subido * 100);
  return (
    <section className="foco curso" aria-label="Foto en camino">
      {envio.mini && <img className="mini" src={envio.mini} alt="" />}
      <div className="paso">
        {envio.fase === 'mandando' && (<>
          <h2>Mandando la foto…</h2>
          <div className="barra-avance" role="progressbar" aria-label="Foto mandada" aria-valuemin={0} aria-valuemax={100} aria-valuenow={porciento}>
            <span style={{ width: `${Math.max(4, porciento)}%` }} />
          </div>
          <p>{porciento > 0 ? `${porciento} %` : 'Empezando…'}</p>
        </>)}
        {envio.fase === 'leyendo' && (<>
          <h2>Leyendo el remito…</h2>
          <div className="barra-avance sin-fin" aria-hidden="true"><span /></div>
          <p>Puede tardar hasta un minuto. Mientras, podés sacar la foto del siguiente.</p>
        </>)}
        {envio.fase === 'espera' && (enLinea && envio.reintento ? (<>
          <h2>No salió todavía</h2>
          <p>Está guardada en el celular. Se vuelve a mandar sola.</p>
          <button type="button" className="boton chico" onClick={alReintentar}>Probar ahora</button>
        </>) : enLinea ? (<>
          <h2>Mandando la foto…</h2>
          <div className="barra-avance" aria-hidden="true"><span style={{ width: '4%' }} /></div>
          <p>Empezando…</p>
        </>) : (<>
          <h2>Guardada. Esperando señal</h2>
          <p>Sale sola cuando vuelva la señal. No hace falta que hagas nada.</p>
        </>))}
      </div>
    </section>
  );
}

function FilaEnvio({ envio, enLinea, alRepetir }: { envio: Envio; enLinea: boolean; alRepetir: () => void }) {
  const titulo = `Foto de las ${hora(envio.tomada_el)}`;
  if (envio.fase === 'fallo') {
    return (
      <div className="fila">
        <span className="punto mal"><Icono nombre="repetir" tamano={22} /></span>
        <div className="texto">
          <strong>{titulo}</strong>
          <span className="estado mal">Sacala de nuevo</span>
          <span className="sub">{FALLOS[envio.fallo ?? 'rechazada']}</span>
          <button type="button" className="boton chico" onClick={alRepetir}>Sacar otra foto</button>
        </div>
      </div>
    );
  }
  const texto = envio.fase === 'mandando' ? `Mandando… ${Math.round(envio.subido * 100)} %`
    : envio.fase === 'leyendo' ? 'Leyendo el remito…'
    : enLinea ? 'Guardada. Se manda sola' : 'Esperando señal';
  return (
    <div className="fila">
      {envio.mini
        ? <img className="punto foto" src={envio.mini} alt="" />
        : <span className="punto neutro"><Icono nombre="subir" tamano={22} /></span>}
      <div className="texto">
        <strong>{titulo}</strong>
        <span className="estado neutro">
          {envio.fase !== 'espera' && <span className="girando" aria-hidden="true" />}
          {texto}
        </span>
      </div>
    </div>
  );
}

function FilaRemito({ remito, yaRepetida, alRepetir, alEscribirPdv }: {
  remito: RemitoChofer; yaRepetida: boolean; alRepetir: () => void; alEscribirPdv: () => void;
}) {
  const l = lectura(remito);
  const pideOtra = remito.repetir && !yaRepetida;
  const tono = remito.repetir && yaRepetida ? 'neutro' : l.tono;
  const resumen = resumenItems(remito);
  return (
    <div className="fila">
      <span className={`punto ${tono}`}><Icono nombre={l.icono} tamano={22} /></span>
      <div className="texto">
        <strong>{tituloRemito(remito)}</strong>
        <span className={`estado ${tono}`}>{remito.repetir && yaRepetida ? 'No se leía bien. Ya sacaste otra' : faltaPdv(remito) && !remito.repetir ? 'Falta el PDV' : l.titulo}</span>
        {faltaPdv(remito) && remito.repetir && !yaRepetida && <span className="estado aviso">Falta el PDV</span>}
        {(pideOtra || faltaPdv(remito)) && remito.mensaje ? <span className="sub">{remito.mensaje}</span> : resumen && <span className="sub">{resumen}</span>}
        {(pideOtra || (faltaPdv(remito) && !yaRepetida)) && (
          <div className="botones">
            {pideOtra && <button type="button" className="boton chico" onClick={alRepetir}>Sacar otra foto</button>}
            {faltaPdv(remito) && <button type="button" className="boton chico" onClick={alEscribirPdv}>Escribir el PDV</button>}
          </div>
        )}
      </div>
      <time dateTime={remito.creado}>{hora(remito.creado)}</time>
    </div>
  );
}

/** La tanda antes de mandar: la foto elegida en grande, la tira con todas (cada una con su X) y los botones. */
function VistaPrevia({ fotos, elegida, preparando, aviso, llena, alElegir, alSacar, alCamara, alGuardadas, alMandar, alCerrar }: {
  fotos: FotoTanda[]; elegida: string | null; preparando: number; aviso: string; llena: boolean;
  alElegir: (clave: string) => void; alSacar: (clave: string) => void;
  alCamara: () => void; alGuardadas: () => void; alMandar: () => void; alCerrar: () => void;
}) {
  const principal = useRef<HTMLButtonElement>(null);
  const tira = useRef<HTMLUListElement>(null);
  const n = fotos.length;
  const grande = fotos.find((f) => f.clave === elegida) ?? fotos[n - 1];
  useEffect(() => { principal.current?.focus(); }, [n > 0]);
  // La foto nueva queda a la vista en la tira.
  useEffect(() => { tira.current?.scrollTo({ left: tira.current.scrollWidth }); }, [n, preparando]);
  useEffect(() => {
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = antes; };
  }, []);
  return (
    <div className="previa" role="dialog" aria-modal="true" aria-labelledby="titulo-previa"
      onKeyDown={(e) => { if (e.key === 'Escape') alCerrar(); }}>
      <div className="previa-arriba">
        <h2 id="titulo-previa" aria-live="polite">
          {n === 0 ? (preparando > 0 ? 'Preparando la foto…' : 'No hay fotos para mandar')
            : n === 1 ? '¿Se lee todo el remito?' : `${n} fotos para mandar`}
        </h2>
        <button type="button" className="cerrar" onClick={alCerrar} aria-label="Cerrar. Las fotos quedan guardadas sin mandar">
          <Icono nombre="cruz" tamano={26} />
        </button>
      </div>
      <div className="previa-foto">
        {grande
          ? <img src={grande.url} alt={n > 1 ? `Foto ${fotos.indexOf(grande) + 1} de ${n}` : 'La foto del remito'} />
          : preparando > 0 && <span className="girando grande" role="status" aria-label="Preparando la foto" />}
      </div>
      {(n > 0 || preparando > 0) && (
        <ul className="tira" ref={tira} aria-label="Fotos de esta tanda">
          {fotos.map((f, i) => (
            <li key={f.clave} className={f === grande ? 'elegida' : undefined}>
              <button type="button" className="ver" onClick={() => alElegir(f.clave)} aria-label={`Ver la foto ${i + 1}`} aria-pressed={f === grande}>
                <img src={f.url} alt="" />
              </button>
              <button type="button" className="sacar" onClick={() => alSacar(f.clave)} aria-label={`Sacar la foto ${i + 1} de la tanda`}>
                <span><Icono nombre="cruz" tamano={18} /></span>
              </button>
            </li>
          ))}
          {Array.from({ length: Math.max(0, preparando) }, (_, i) => (
            <li key={`p${i}`} className="llegando"><span className="girando" role="status" aria-label="Preparando la foto" /></li>
          ))}
        </ul>
      )}
      {aviso
        ? <p className="previa-nota aviso" role="alert">{aviso}</p>
        : <p className="previa-nota">¿El remito tiene varias hojas? Sacale una foto a cada una.</p>}
      <div className="previa-abajo">
        <div className="sumar">
          <button type="button" className="boton fantasma" ref={n > 0 ? undefined : principal} onClick={alCamara} disabled={llena}>
            <Icono nombre="camara" tamano={24} /> Sacar otra foto
          </button>
          <button type="button" className="boton fantasma" onClick={alGuardadas} disabled={llena}>
            <Icono nombre="galeria" tamano={24} /> Sumar guardada
          </button>
        </div>
        {n > 0 && (
          <button type="button" className="boton verde" ref={principal} onClick={alMandar} disabled={preparando > 0}>
            <Icono nombre="subir" tamano={26} /> {n === 1 ? 'Mandar' : `Mandar las ${n} fotos`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Varias fotos mandadas juntas: el avance de todas y, al final, cuántas llegaron. Cada resultado está en la lista de hoy. */
function TarjetaLote({ envios: lote, enLinea, alReintentar }: { envios: Envio[]; enLinea: boolean; alReintentar: () => void }) {
  const total = lote.length;
  const hechas = lote.filter((e) => e.fase === 'listo' || e.fase === 'fallo').length;
  if (hechas === total) {
    const todasBien = lote.every((e) => e.resultado?.estado === 'ok');
    return (
      <section className={`foco ${todasBien ? 'bien' : 'neutro'}`} aria-label="Resultado de las fotos">
        <div className="cabeza"><span className="sello"><Icono nombre="bien" tamano={30} /></span><h2>Llegaron las {total} fotos</h2></div>
        <div className="detalle">
          <p className="mensaje">{todasBien ? 'Quedaron todas en su pedido.' : 'Abajo está cómo quedó cada una.'}</p>
        </div>
      </section>
    );
  }
  const avance = lote.reduce((suma, e) => suma + (e.fase === 'listo' || e.fase === 'fallo' ? 1 : e.fase === 'leyendo' ? .7 : e.fase === 'mandando' ? e.subido * .5 : 0), 0) / total;
  const andando = lote.some((e) => e.fase === 'mandando' || e.fase === 'leyendo');
  const faltan = total - hechas;
  return (
    <section className="foco curso lote" aria-label="Fotos en camino">
      <div className="paso">
        {andando || (enLinea && !lote.some((e) => e.fase === 'espera' && e.reintento)) ? (<>
          <h2>Mandando {Math.min(hechas + 1, total)} de {total}…</h2>
          <div className="barra-avance" role="progressbar" aria-label="Fotos mandadas" aria-valuemin={0} aria-valuemax={total} aria-valuenow={hechas}>
            <span style={{ width: `${Math.max(4, Math.round(avance * 100))}%` }} />
          </div>
          <p>Cada foto puede tardar hasta un minuto. Mientras, podés seguir sacando fotos.</p>
        </>) : enLinea ? (<>
          <h2>{faltan === 1 ? 'Falta salir 1 foto' : `Faltan salir ${faltan} fotos`}</h2>
          <p>Están guardadas en el celular. Se vuelven a mandar solas.</p>
          <button type="button" className="boton chico" onClick={alReintentar}>Probar ahora</button>
        </>) : (<>
          <h2>{faltan === 1 ? '1 foto guardada. Esperando señal' : `${faltan} fotos guardadas. Esperando señal`}</h2>
          <p>Salen solas cuando vuelva la señal. No hace falta que hagas nada.</p>
        </>)}
      </div>
    </section>
  );
}

// Sin link, o con uno que ya no anda: el chofer escribe el código de 8 números que le pasó Logística. Es una sola vez:
// queda guardado en el celular. El mismo lugar acepta el link pegado.
function LinkRoto({ sinLink, guardadas, alEntrar }: { sinLink: boolean; guardadas: number; alEntrar: (token: string | null) => void }) {
  const [texto, setTexto] = useState('');
  const [error, setError] = useState('');
  const [entrando, setEntrando] = useState(false);
  async function entrar(e: FormEvent) {
    e.preventDefault();
    const t = tokenDeTexto(texto.trim());
    if (t) { alEntrar(t); return; }
    const digitos = texto.replace(/\D/g, '');
    if (digitos.length !== 8) { setError('El código tiene 8 números. Fijate en el mensaje de Logística.'); return; }
    setEntrando(true);
    const r = await entrarConCodigo(digitos);
    setEntrando(false);
    if (r.ok) alEntrar(null); else setError(r.error);
  }
  return (
    <main className="link-roto">
      <img src={`${import.meta.env.BASE_URL}icono.svg`} alt="" width="56" height="56" />
      <h1>{sinLink ? 'Entrá con tu código' : 'Tu acceso ya no funciona'}</h1>
      <p className="grande">{sinLink
        ? 'Escribí los 8 números que te pasó Logística. Es una sola vez: después queda guardado en el celular.'
        : 'Pedile un código nuevo a Logística y escribilo acá.'}</p>
      {guardadas > 0 && (
        <p className="nota">
          {guardadas === 1 ? 'La foto que quedó guardada no se pierde: se manda' : `Las ${guardadas} fotos que quedaron guardadas no se pierden: se mandan`} cuando entres.
        </p>
      )}
      <form onSubmit={entrar} noValidate>
        <label htmlFor="codigo">Tu código</label>
        <input
          id="codigo" className="codigo" type="text" inputMode="numeric" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="0000 0000" value={texto} onChange={(e) => { setTexto(e.target.value); setError(''); }}
          aria-invalid={!!error} aria-describedby={error ? 'codigo-error' : 'codigo-ayuda'}
        />
        {error && <p id="codigo-error" className="error" role="alert">{error}</p>}
        <button type="submit" className="boton principal" disabled={!texto.trim() || entrando}>{entrando ? 'Entrando…' : 'Entrar'}</button>
        <p id="codigo-ayuda" className="nota">¿Te pasaron un link? Abrilo, o pegalo acá mismo.</p>
      </form>
    </main>
  );
}
