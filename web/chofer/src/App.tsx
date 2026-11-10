import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  LinkInvalido, nombreGuardado, pedirRemitos, pedirYo, token, tokenDeTexto, usarToken, type RemitoChofer,
} from './api';
import { envios, type Envio } from './envios';
import { achicarFoto } from './imagen';
import { conTope, ubicacion, type Punto } from './ubicacion';
import { Icono } from './iconos';

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
  switch (r.estado) {
    case 'ok': return { tono: 'bien', icono: 'bien', titulo: 'Listo' };
    case 'revisar': return { tono: 'aviso', icono: 'aviso', titulo: 'Llegó. Lo revisa Logística' };
    case 'duplicado': return { tono: 'neutro', icono: 'copia', titulo: 'Ese remito ya estaba mandado' };
    case 'descartado': return { tono: 'neutro', icono: 'cruz', titulo: 'Logística lo descartó' };
    default: return { tono: 'neutro', icono: 'reloj', titulo: 'Llegó. Se lee más tarde' };
  }
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

type Previa =
  | { paso: 'preparando' }
  | { paso: 'lista'; blob: Blob; url: string; tomada_el: string }
  | { paso: 'error' };

export default function App() {
  const estado = useSyncExternalStore(envios.suscribir, envios.leer);
  const enLinea = useEnLinea();
  const [hayToken, setHayToken] = useState(() => !!token());
  const [nombre, setNombre] = useState<string | null>(() => nombreGuardado());
  const [remitos, setRemitos] = useState<RemitoChofer[]>(remitosGuardados);
  const [listaAlDia, setListaAlDia] = useState(false);
  const [reemplazadas, setReemplazadas] = useState<string[]>(() => leerLista('chofer-reemplazadas'));
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [anuncio, setAnuncio] = useState('');

  const entrada = useRef<HTMLInputElement>(null);
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

  // ----- Cámara y vista previa -----

  const soltarPrevia = useCallback(() => {
    setPrevia((p) => {
      if (p?.paso === 'lista') URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);

  // El botón «atrás» del celular cierra la vista previa en vez de salir de la app: al abrirla se suma un paso al
  // historial y al cerrarla se vuelve.
  useEffect(() => {
    window.addEventListener('popstate', soltarPrevia);
    return () => window.removeEventListener('popstate', soltarPrevia);
  }, [soltarPrevia]);

  const enPrevia = () => {
    try { return !!(history.state as { previa?: boolean } | null)?.previa; } catch { return false; }
  };
  function cerrarPrevia() {
    soltarPrevia();
    if (enPrevia()) history.back();
  }

  function abrirCamara(reemplazaA?: string) {
    reemplaza.current = reemplazaA;
    entrada.current?.click();
  }

  async function alElegirFoto(archivo: File | undefined) {
    if (!archivo) return;
    const tomada = archivo.lastModified > 0 && archivo.lastModified <= Date.now() ? archivo.lastModified : Date.now();
    setPrevia((p) => {
      if (p?.paso === 'lista') URL.revokeObjectURL(p.url);
      return { paso: 'preparando' };
    });
    if (!enPrevia()) { try { history.pushState({ previa: true }, ''); } catch { /* da igual */ } }
    if (!punto.current) punto.current = ubicacion();
    try {
      const blob = await achicarFoto(archivo);
      setPrevia({ paso: 'lista', blob, url: URL.createObjectURL(blob), tomada_el: new Date(tomada).toISOString() });
    } catch {
      setPrevia({ paso: 'error' });
    }
  }

  async function mandar() {
    if (previa?.paso !== 'lista') return;
    const { blob, tomada_el } = previa;
    const reemplazaA = reemplaza.current;
    reemplaza.current = undefined;
    cerrarPrevia();
    setAnuncio('Mandando la foto.');
    const lugar = punto.current ? await conTope(punto.current, 800) : null;
    punto.current = null;
    if (reemplazaA) {
      setReemplazadas((antes) => {
        const lista = [...antes.filter((c) => c !== reemplazaA), reemplazaA].slice(-60);
        try { localStorage.setItem('chofer-reemplazadas', JSON.stringify(lista)); } catch { /* da igual */ }
        return lista;
      });
    }
    await envios.agregar({ clave: claveNueva(), blob, tomada_el, lat: lugar?.lat, lng: lugar?.lng, reemplaza: reemplazaA });
    window.scrollTo({ top: 0 });
    arriba.current?.focus({ preventScroll: true });
  }

  // ----- Qué se muestra -----

  const foco = estado.envios.find((e) => e.clave === estado.foco) ?? null;

  /** La versión más nueva de un remito: la de la lista del servidor si ya la trae, si no la respuesta del envío. */
  const alDia = useCallback((r: RemitoChofer): RemitoChofer => {
    return remitos.find((x) => x.id === r.id) ?? r;
  }, [remitos]);

  const remitoFoco = foco?.resultado ? alDia(foco.resultado) : null;
  const claveFoco = foco ? (remitoFoco?.clave ?? foco.clave) : null;
  const focoPideOtra = !!foco && (foco.fase === 'fallo' || !!remitoFoco?.repetir) && !reemplazadas.includes(claveFoco ?? '');

  const filas = useMemo(() => {
    type Fila = { llave: string; cuando: string; clave: string; envio?: Envio; remito?: RemitoChofer };
    const lista: Fila[] = [];
    const idsLocales = new Set<number>();
    for (const e of estado.envios) {
      if (e.resultado) idsLocales.add(e.resultado.id);
      if (e.clave === estado.foco) continue;
      if (e.resultado) {
        if (esHoy(e.resultado.creado) && !remitos.some((r) => r.id === e.resultado!.id)) {
          lista.push({ llave: `r${e.resultado.id}`, cuando: e.resultado.creado, clave: e.resultado.clave ?? e.clave, remito: e.resultado });
        }
      } else {
        lista.push({ llave: `e${e.clave}`, cuando: e.tomada_el, clave: e.clave, envio: e });
      }
    }
    const idFoco = foco?.resultado?.id;
    for (const r of remitos) {
      if (!esHoy(r.creado) || r.id === idFoco) continue;
      lista.push({ llave: `r${r.id}`, cuando: r.creado, clave: r.clave ?? `remito-${r.id}`, remito: r });
    }
    return lista.sort((a, b) => b.cuando.localeCompare(a.cuando));
  }, [estado.envios, estado.foco, remitos, foco]);

  const esperando = estado.envios.filter((e) => e.fase === 'espera');
  const esperandoFuera = esperando.filter((e) => e.clave !== estado.foco).length;

  if (!hayToken || estado.linkInvalido) {
    return (
      <LinkRoto
        guardadas={esperando.length}
        alPegar={(t) => { usarToken(t); setHayToken(true); envios.linkNuevo(); void refrescar(); pedirYo().then(setNombre).catch(() => {}); }}
      />
    );
  }

  const primerNombre = nombre?.trim().split(/\s+/)[0];

  return (
    <div className="app">
      <header className="barra">
        <img src={`${import.meta.env.BASE_URL}icono.svg`} alt="" width="32" height="32" />
        <span className="marca">Remitos <span>Formas</span></span>
        {!enLinea && (
          <span className="chip-senal"><Icono nombre="sinSenal" tamano={18} /> Sin señal</span>
        )}
      </header>

      <main className="cuerpo">
        <h1 ref={arriba} tabIndex={-1}>{primerNombre ? `Hola, ${primerNombre}` : 'Hola'}</h1>

        <p className="solo-lector" role="status" aria-live="polite">{anuncio}</p>

        {foco && (
          <TarjetaFoco
            envio={foco}
            remito={remitoFoco}
            enLinea={enLinea}
            pideOtra={focoPideOtra}
            alReintentar={() => envios.empujar()}
            alSeguir={() => envios.enfocar(null)}
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

        {!foco && <Consejos />}

        <section className="hoy" aria-labelledby="titulo-hoy">
          <h2 id="titulo-hoy">Hoy {filas.length > 0 && <span className="cuenta">{filas.length}</span>}</h2>
          {filas.length === 0 ? (
            <p className="vacio">
              {foco ? 'Acá vas a ver los otros remitos que mandes hoy.'
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
                      />}
                </li>
              ))}
            </ul>
          )}
        </section>

        {foco && <Consejos />}
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
      </div>

      <input
        ref={entrada}
        className="solo-lector"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => { const a = e.target.files?.[0]; e.target.value = ''; void alElegirFoto(a); }}
      />

      {previa && (
        <VistaPrevia
          previa={previa}
          alMandar={() => void mandar()}
          alSacarOtra={() => abrirCamara(reemplaza.current)}
          alCancelar={() => { reemplaza.current = undefined; cerrarPrevia(); }}
        />
      )}
    </div>
  );
}

// ---------- Piezas ----------

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
  const hayDatos = remito.pdv || remito.cliente || remito.numero || remito.items.length > 0;
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

function TarjetaFoco({ envio, remito, enLinea, pideOtra, alReintentar, alSeguir }: {
  envio: Envio; remito: RemitoChofer | null; enLinea: boolean; pideOtra: boolean;
  alReintentar: () => void; alSeguir: () => void;
}) {
  if (envio.fase === 'fallo') {
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
          <DatosLeidos remito={remito} />
          {remito.repetir && !pideOtra && <p className="nota">Ya sacaste otra foto de este remito.</p>}
          {pideOtra && <button type="button" className="enlace" onClick={alSeguir}>Seguir con otro remito</button>}
        </div>
      </section>
    );
  }

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

function FilaRemito({ remito, yaRepetida, alRepetir }: { remito: RemitoChofer; yaRepetida: boolean; alRepetir: () => void }) {
  const l = lectura(remito);
  const pideOtra = remito.repetir && !yaRepetida;
  const tono = remito.repetir && yaRepetida ? 'neutro' : l.tono;
  const resumen = resumenItems(remito);
  return (
    <div className="fila">
      <span className={`punto ${tono}`}><Icono nombre={l.icono} tamano={22} /></span>
      <div className="texto">
        <strong>{tituloRemito(remito)}</strong>
        <span className={`estado ${tono}`}>{remito.repetir && yaRepetida ? 'No se leía bien. Ya sacaste otra' : l.titulo}</span>
        {pideOtra && remito.mensaje ? <span className="sub">{remito.mensaje}</span> : resumen && <span className="sub">{resumen}</span>}
        {pideOtra && <button type="button" className="boton chico" onClick={alRepetir}>Sacar otra foto</button>}
      </div>
      <time dateTime={remito.creado}>{hora(remito.creado)}</time>
    </div>
  );
}

function VistaPrevia({ previa, alMandar, alSacarOtra, alCancelar }: {
  previa: Previa; alMandar: () => void; alSacarOtra: () => void; alCancelar: () => void;
}) {
  const principal = useRef<HTMLButtonElement>(null);
  const lista = previa.paso === 'lista';
  useEffect(() => { principal.current?.focus(); }, [previa.paso]);
  useEffect(() => {
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = antes; };
  }, []);
  return (
    <div className="previa" role="dialog" aria-modal="true" aria-labelledby="titulo-previa"
      onKeyDown={(e) => { if (e.key === 'Escape') alCancelar(); }}>
      <div className="previa-arriba">
        <h2 id="titulo-previa">
          {previa.paso === 'preparando' ? 'Preparando la foto…' : lista ? '¿Se lee todo el remito?' : 'No se pudo abrir la foto'}
        </h2>
        <button type="button" className="cerrar" onClick={alCancelar} aria-label="Cancelar y volver">
          <Icono nombre="cruz" tamano={26} />
        </button>
      </div>
      <div className="previa-foto">
        {lista && <img src={previa.url} alt="La foto que sacaste del remito" />}
        {previa.paso === 'preparando' && <span className="girando grande" role="status" aria-label="Preparando la foto" />}
        {previa.paso === 'error' && <p>Probá sacarla de nuevo.</p>}
      </div>
      <div className="previa-abajo">
        <button type="button" className="boton fantasma" ref={lista ? undefined : principal} onClick={alSacarOtra}>
          <Icono nombre="repetir" tamano={24} /> Sacar otra
        </button>
        {lista && (
          <button type="button" className="boton verde" ref={principal} onClick={alMandar}>
            <Icono nombre="subir" tamano={26} /> Mandar
          </button>
        )}
      </div>
    </div>
  );
}

function LinkRoto({ guardadas, alPegar }: { guardadas: number; alPegar: (token: string) => void }) {
  const [texto, setTexto] = useState('');
  const [error, setError] = useState(false);
  function entrar(e: FormEvent) {
    e.preventDefault();
    const t = tokenDeTexto(texto.trim());
    if (t) alPegar(t); else setError(true);
  }
  return (
    <main className="link-roto">
      <img src={`${import.meta.env.BASE_URL}icono.svg`} alt="" width="56" height="56" />
      <h1>Este link no funciona</h1>
      <p className="grande">Pedile tu link a Logística.</p>
      {guardadas > 0 && (
        <p className="nota">
          {guardadas === 1 ? 'La foto que quedó guardada no se pierde: se manda' : `Las ${guardadas} fotos que quedaron guardadas no se pierden: se mandan`} cuando entres con tu link.
        </p>
      )}
      <form onSubmit={entrar} noValidate>
        <label htmlFor="link">¿Ya te lo pasaron? Pegalo acá</label>
        <input
          id="link" type="text" inputMode="url" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          value={texto} onChange={(e) => { setTexto(e.target.value); setError(false); }}
          aria-invalid={error} aria-describedby={error ? 'link-error' : undefined}
        />
        {error && <p id="link-error" className="error" role="alert">Eso no parece tu link. Copialo entero del mensaje de Logística.</p>}
        <button type="submit" className="boton principal" disabled={!texto.trim()}>Entrar</button>
      </form>
    </main>
  );
}
