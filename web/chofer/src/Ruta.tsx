import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { marcarParada, pedirRuta, SinSenal, type ItemChofer, type ParadaChofer, type RecorridoChofer } from './api';
import { hhmm, simular } from '../../src/ruta';
import { Icono } from './iconos';
import { telefono } from './instalar';

// El recorrido de hoy (pedido de Rodrigo del 12/11/2026): las paradas en el orden que armó Logística en el Cronograma
// del CRM, con la hora aproximada de llegada, qué hay que retirar o entregar y un botón para abrir el mapa del celular.
// En cada parada el chofer marca cómo le fue: la hizo, no se pudo (con el motivo, como en las apps de reparto) o la deja
// para después. Si era una entrega, al marcarla se abre la cámara para la foto del remito firmado.
// Si no tiene recorrido asignado (o no hay señal), no se muestra nada: la app sigue siendo la de los remitos.

const TIPO: Record<string, string> = { entrega: 'Entregar', retiro_proveedor: 'Retirar', retiro_impresor: 'Retirar', egreso: 'Dejar' };
const MOTIVOS: Array<[string, string]> = [['nadie', 'No había nadie'], ['cerrado', 'Estaba cerrado'], ['direccion', 'No encontré la dirección'], ['rechazo', 'No lo quisieron recibir'], ['no_listo', 'No estaba listo'], ['otro', 'Otro motivo']];
const num = new Intl.NumberFormat('es-AR');
const item = (i: ItemChofer) => [i.cant != null ? num.format(i.cant) : '', i.que, i.pdv ? `(PDV ${i.pdv})` : ''].filter(Boolean).join(' ');
// Las paradas a las que el chofer ya les mandó la foto del remito desde este celular hoy (aunque todavía no haya salido,
// sin señal): así no le pide la foto de nuevo. Lo de otro celular lo dice el servidor (`fotos`).
const CLAVE_FOTOS = 'chofer-fotos-paradas';
export function fotosLocales(): string[] {
  try { const g = JSON.parse(localStorage.getItem(CLAVE_FOTOS) ?? '{}') as { dia?: string; paradas?: string[] }; return g.dia === hoy() ? g.paradas ?? [] : []; } catch { return []; }
}
export function anotarFoto(parada: string) {
  try { localStorage.setItem(CLAVE_FOTOS, JSON.stringify({ dia: hoy(), paradas: [...new Set([...fotosLocales(), parada])] })); } catch { /* sin almacenamiento */ }
  window.dispatchEvent(new Event('chofer-foto'));
}
// Quien pidió el encargo (pedido de Rodrigo del 17/11/2026): su foto de Google y su nombre de pila. Sin foto, o si no
// carga (sin señal), van sus iniciales.
function QuienPidio({ nombre, foto }: { nombre: string; foto?: string | null }) {
  const [falla, setFalla] = useState(false);
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  return (
    <span className="ruta-pidio">
      {foto && !falla ? <img src={foto} alt="" referrerPolicy="no-referrer" onError={() => setFalla(true)} />
        : <i aria-hidden="true">{partes.slice(0, 2).map((x) => x[0]?.toUpperCase()).join('')}</i>}
      {partes[0]}
    </span>
  );
}
// Hecha: la marcó él, o están hechos sus artículos y sus encargos.
const hechaP = (p: ParadaChofer) => p.visita?.resultado === 'hecho' || (p.movimientos.every((m) => m.hecho) && (p.encargos ?? []).every((e) => e.estado === 'hecho'));
const CLAVE = 'chofer-ruta';
const hoy = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
function guardado(): RecorridoChofer[] {
  try { const g = JSON.parse(localStorage.getItem(CLAVE) ?? 'null') as { dia: string; r: RecorridoChofer[] } | null; return g && g.dia === hoy() && Array.isArray(g.r) ? g.r : []; } catch { return []; }
}

// ---------- Cómo llegar (pedido de Rodrigo del 13/11/2026) ----------
// Cada parada se abre en la app de mapas que elige el chofer: Google Maps, Waze o, en el iPhone, Mapas de Apple. La
// primera vez pregunta; después el botón de la parada abre directo con esa (se cambia en «Cómo llegar» de la parada).
// El recorrido entero, con sus paradas, solo se puede abrir en Google Maps: Waze no deja cargar varias paradas por link.
type AppMapa = 'google' | 'waze' | 'apple';
const APPS: Array<{ k: AppMapa; nombre: string }> = [
  { k: 'google', nombre: 'Google Maps' }, { k: 'waze', nombre: 'Waze' }, ...(telefono() === 'iphone' ? [{ k: 'apple' as const, nombre: 'Apple Maps' }] : []),
];
const CLAVE_MAPA = 'chofer-mapa';
function appGuardada(): AppMapa | null {
  try { const v = localStorage.getItem(CLAVE_MAPA); return APPS.some((a) => a.k === v) ? (v as AppMapa) : null; } catch { return null; }
}
// Las coordenadas van tal cual («-34.69,-58.39», como las documentan Google y Waze); una dirección, codificada.
const enc = (x: string) => (/^-?[\d.]+,-?[\d.]+$/.test(x) ? x : encodeURIComponent(x));
// Adónde ir: el punto en el mapa o, si no está ubicado, la dirección.
const destinoDe = (p: { lat: number | null; lng: number | null; direccion: string | null }) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : p.direccion);
function linkA(app: AppMapa, p: ParadaChofer): string | null {
  const ir = destinoDe(p);
  if (!ir) return null;
  const q = enc(ir);
  if (app === 'waze') return p.lat != null ? `https://waze.com/ul?ll=${q}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`;
  if (app === 'apple') return `https://maps.apple.com/?daddr=${q}&dirflg=d`;
  return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving&dir_action=navigate`;
}
// El recorrido en Google Maps, desde donde está el chofer: las paradas que le faltan, en orden, y dónde termina. Google
// Maps acepta hasta 9 paradas en el medio más el destino: si faltan más, abre las próximas 10 (al hacerlas, el botón
// abre las que siguen).
function linkRecorrido(pendientes: ParadaChofer[], fin: string | null): { url: string; cuantas: number; todas: boolean } | null {
  const puntos = pendientes.map(destinoDe).filter((x): x is string => !!x);
  if (!puntos.length) return null;
  const todas = puntos.length <= 10;
  const tramo = puntos.slice(0, 10);
  const conFin = todas && !!fin && tramo.length <= 9;
  const destino = conFin ? fin! : tramo[tramo.length - 1];
  const medio = conFin ? tramo : tramo.slice(0, -1);
  const url = `https://www.google.com/maps/dir/?api=1&destination=${enc(destino)}${medio.length ? `&waypoints=${medio.map(enc).join('%7C')}` : ''}&travelmode=driving&dir_action=navigate`;
  return { url, cuantas: tramo.length, todas };
}

// Un cambio en la parada que se ve ya, antes de que conteste el servidor.
function optimista(p: ParadaChofer, resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, motivo?: string, nota?: string): ParadaChofer {
  if (!resultado) return { ...p, visita: null };
  return { ...p, visita: { resultado, motivo: motivo ?? null, nota: nota || null }, movimientos: resultado === 'hecho' ? p.movimientos.map((m) => ({ ...m, hecho: true })) : p.movimientos,
    encargos: resultado === 'hecho' ? (p.encargos ?? []).map((e) => ({ ...e, estado: 'hecho' as const })) : p.encargos };
}

// Las entregas del recorrido de hoy, para elegir de cuál es una foto (la guía de un expreso, un remito sin PDV).
export function entregasDeHoy(): Array<{ clave: string; nombre: string; pdv: string | null }> {
  const vistas = new Set<string>();
  return guardado().flatMap((r) => r.paradas)
    .filter((p) => p.movimientos.some((m) => m.tipo === 'entrega') && !vistas.has(p.clave) && (vistas.add(p.clave), true))
    .map((p) => ({ clave: p.clave, nombre: p.expreso ? p.expreso.cliente : p.nombre, pdv: p.movimientos.find((m) => m.npdv)?.npdv ?? null }));
}

// `alEntregar(parada)`: abre la cámara para la foto del remito (o de la guía del expreso) de esa parada.
export function RutaHoy({ enLinea, alEntregar }: { enLinea: boolean; alEntregar: (parada?: string) => void }) {
  // La foto del remito es obligatoria en todas las paradas (pedido de Rodrigo del 16/11/2026): las hechas sin foto quedan
  // marcadas hasta que la saque.
  const [locales, setLocales] = useState<string[]>(fotosLocales);
  useEffect(() => { const f = () => setLocales(fotosLocales()); window.addEventListener('chofer-foto', f); return () => window.removeEventListener('chofer-foto', f); }, []);
  const conFoto = (p: ParadaChofer) => (p.fotos ?? 0) > 0 || locales.includes(p.clave);
  // Lo último que se trajo queda en el celular: sin señal (o si el celular recarga la app al volver de la cámara) el
  // recorrido de hoy se sigue viendo.
  const [recorridos, setRecorridos] = useState<RecorridoChofer[]>(guardado);
  // La parada abierta, en su pantalla. Suma un paso al historial: el «atrás» del celular vuelve al recorrido. Queda
  // anotada por si el celular recarga la app al volver de la cámara.
  const [abierta, setAbierta] = useState<string | null>(() => {
    try { return (history.state as { chofer_parada?: string } | null)?.chofer_parada ?? sessionStorage.getItem('chofer-parada') ?? null; } catch { return null; }
  });
  useEffect(() => {
    const atras = () => { const c = (history.state as { chofer_parada?: string } | null)?.chofer_parada ?? null; setAbierta(c); try { if (c) sessionStorage.setItem('chofer-parada', c); else sessionStorage.removeItem('chofer-parada'); } catch { /* da igual */ } };
    window.addEventListener('popstate', atras);
    return () => window.removeEventListener('popstate', atras);
  }, []);
  const abrir = (clave: string) => {
    setAbierta(clave);
    try { sessionStorage.setItem('chofer-parada', clave); } catch { /* da igual */ }
    try { const st = history.state as { chofer_parada?: string } | null; if (st?.chofer_parada) history.replaceState({ chofer_parada: clave }, ''); else history.pushState({ chofer_parada: clave }, ''); } catch { /* da igual */ }
  };
  // Si volvió a abrirse la app (de la cámara) con una parada abierta, el «atrás» tiene que volver al recorrido.
  useEffect(() => {
    try { if (abierta && !(history.state as { chofer_parada?: string } | null)?.chofer_parada) history.pushState({ chofer_parada: abierta }, ''); } catch { /* da igual */ }
  }, []);
  const cerrar = () => {
    setAbierta(null);
    try { sessionStorage.removeItem('chofer-parada'); } catch { /* da igual */ }
    try { if ((history.state as { chofer_parada?: string } | null)?.chofer_parada) history.back(); } catch { /* da igual */ }
  };
  const [app, setApp] = useState<AppMapa | null>(appGuardada);
  const [eligiendo, setEligiendo] = useState<ParadaChofer | null>(null);   // la parada para la que se elige la app
  const [aviso, setAviso] = useState('');
  const traer = useCallback(() => pedirRuta().then((r) => { setRecorridos(r); try { localStorage.setItem(CLAVE, JSON.stringify({ dia: hoy(), r })); } catch { /* sin almacenamiento */ } }, () => undefined), []);
  useEffect(() => {
    if (!enLinea) return;
    void traer();
    const t = window.setInterval(traer, 5 * 60_000);   // Logística puede cambiar el orden durante el día
    return () => window.clearInterval(t);
  }, [enLinea, traer]);
  const elegirApp = (k: AppMapa) => { setApp(k); try { localStorage.setItem(CLAVE_MAPA, k); } catch { /* sin almacenamiento */ } };
  const cambiarParada = (clave: string, cambio: (p: ParadaChofer) => ParadaChofer) =>
    setRecorridos((rs) => rs.map((r) => ({ ...r, paradas: r.paradas.map((x) => (x.clave === clave ? cambio(x) : x)) })));
  // Marcar una parada: se ve hecha en el momento y se guarda atrás (ClickUp puede tardar). Si no se pudo guardar, vuelve
  // a como estaba y lo avisa arriba.
  const marcar = (p: ParadaChofer, resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, motivo?: string, nota?: string) => {
    setAviso('');
    cambiarParada(p.clave, (x) => optimista(x, resultado, motivo, nota));
    marcarParada(p.clave, resultado, motivo, nota).then(() => traer(), (e) => {
      cambiarParada(p.clave, () => p);
      setAviso(`${p.nombre}: ${e instanceof SinSenal ? 'no se guardó porque no hay señal. Marcala de nuevo cuando vuelva.' : 'no se pudo guardar. Marcala de nuevo.'}`);
      void traer();
    });
  };
  const conParadas = recorridos.filter((r) => r.paradas.length);
  if (!conParadas.length) return null;
  return (
    <>
      {aviso && <p className="ruta-aviso" role="alert">{aviso}</p>}
      {conParadas.map((r) => {
        const base = r.base.lat != null && r.base.lng != null ? { lat: r.base.lat, lng: r.base.lng } : null;
        // Dónde termina: donde sale, otro lugar o la última parada.
        const vuelve = r.fin === undefined || !!r.vuelve;
        const destino = vuelve ? base : r.fin ? (r.fin.lat != null && r.fin.lng != null ? { lat: r.fin.lat, lng: r.fin.lng } : null) : 'ultima' as const;
        const sim = simular(base, r.paradas, r.salida, null, destino);
        const hechas = r.paradas.filter(hechaP).length;
        const sinFoto = r.paradas.filter((p) => hechaP(p) && !conFoto(p)).length;
        const lugarFin = vuelve ? r.base : r.fin ?? null;
        const todo = linkRecorrido(r.paradas.filter((p) => !hechaP(p) && p.visita?.resultado !== 'no_se_pudo'), lugarFin ? destinoDe(lugarFin) : null);
        return (
          <section key={r.n} className="ruta" aria-labelledby={`titulo-ruta-${r.n}`}>
            <h2 id={`titulo-ruta-${r.n}`}>Tu recorrido de hoy <span className="cuenta">{hechas}/{r.paradas.length}</span></h2>
            {sinFoto > 0 && <p className="ruta-sin-foto" role="status">{sinFoto === 1 ? 'A una parada hecha le falta' : `A ${sinFoto} paradas hechas les falta`} la foto del remito: abrila y sacala.</p>}
            <p className="ruta-sale">Salís de {r.base.nombre} a las {hhmm(r.salida)} · {vuelve ? 'volvés' : r.fin ? `terminás en ${r.fin.nombre}` : 'terminás en la última parada'} cerca de las {hhmm(sim.fin)}</p>
            {todo && (
              <div className="ruta-todo">
                <a className="boton chico" href={todo.url} target="_blank" rel="noreferrer"><Icono nombre="navegar" tamano={22} />
                  {todo.todas ? 'Todo el recorrido en Google Maps' : `Las próximas ${todo.cuantas} paradas en Google Maps`}</a>
                {app === 'waze' && <p className="ruta-nota">Waze no deja cargar varias paradas juntas: con Waze, andá con el botón de cada parada.</p>}
              </div>
            )}
            <ol className="lista ruta-lista">
              {r.paradas.map((p, i) => {
                const s = sim.paradas[i], hecha = hechaP(p);
                const estado = hecha ? (conFoto(p) ? 'hecha' : 'hecha sin-foto') : p.visita?.resultado === 'no_se_pudo' ? 'fallo' : p.visita?.resultado === 'salteada' ? 'salteada' : '';
                const ir = app ? linkA(app, p) : null;
                return (
                  <li key={p.clave} className={estado}>
                    <div className="ruta-fila">
                      <button type="button" className="ruta-parada" aria-haspopup="dialog" onClick={() => abrir(p.clave)}>
                        <span className="ruta-n">{hecha ? '✓' : estado === 'fallo' ? '!' : i + 1}</span>
                        <span className="ruta-quien"><strong>{p.nombre}</strong>{p.expreso && <span>Expreso: dejar para {p.expreso.cliente}{p.expreso.guia ? ` · guía ${p.expreso.guia}` : ''}</span>}<span>{p.direccion ?? 'Sin dirección: preguntale a Logística'}</span>
                          {estado === 'fallo' && <em>{MOTIVOS.find((m) => m[0] === p.visita!.motivo)?.[1] ?? 'No se pudo'}{p.visita!.nota ? `: ${p.visita!.nota}` : ''}</em>}
                          {estado === 'salteada' && <em>La dejaste para después</em>}
                          {hecha && !conFoto(p) && <em>Falta la foto del remito</em>}</span>
                        <span className="ruta-hora">{s.tramo.sinUbicar ? '—' : hhmm(s.llega)}{p.pactada && <small>{p.pactada}</small>}</span>
                      </button>
                      {/* Cómo llegar, sin abrir la parada: con la app que eligió; la primera vez, pregunta cuál. */}
                      {destinoDe(p) && (ir
                        ? <a className="ruta-ir" href={ir} target="_blank" rel="noreferrer" aria-label={`Cómo llegar a ${p.nombre} con ${APPS.find((a) => a.k === app)?.nombre}`}><Icono nombre="navegar" /></a>
                        : <button type="button" className="ruta-ir" aria-label={`Cómo llegar a ${p.nombre}`} onClick={() => setEligiendo(p)}><Icono nombre="navegar" /></button>)}
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="ruta-nota">Los horarios son aproximados.</p>
          </section>
        );
      })}
      {(() => {
        // La parada abierta: en qué recorrido está, su número, su hora y la siguiente que falta.
        for (const r of conParadas) {
          const i = r.paradas.findIndex((x) => x.clave === abierta);
          if (i < 0) continue;
          const base = r.base.lat != null && r.base.lng != null ? { lat: r.base.lat, lng: r.base.lng } : null;
          const vuelve = r.fin === undefined || !!r.vuelve;
          const sim = simular(base, r.paradas, r.salida, null, vuelve ? base : r.fin ? (r.fin.lat != null && r.fin.lng != null ? { lat: r.fin.lat, lng: r.fin.lng } : null) : 'ultima');
          const p = r.paradas[i], s = sim.paradas[i];
          const siguiente = [...r.paradas.slice(i + 1), ...r.paradas.slice(0, i)].find((x) => !hechaP(x) && x.visita?.resultado !== 'no_se_pudo') ?? null;
          return <PantallaParada key="parada" p={p} n={i + 1} total={r.paradas.length} llega={s.llega} sinUbicar={s.tramo.sinUbicar} tarde={s.tarde > 0} hecha={hechaP(p)} conFoto={conFoto(p)}
            enLinea={enLinea} app={app} siguiente={siguiente} alElegirApp={elegirApp} alMarcar={(...a) => marcar(p, ...a)} alEntregar={alEntregar} alVolver={cerrar}
            alSiguiente={() => siguiente && abrir(siguiente.clave)} />;
        }
        return null;
      })()}
      {eligiendo && <ElegirApp p={eligiendo} alElegir={(k) => { elegirApp(k); setEligiendo(null); }} alCerrar={() => setEligiendo(null)} />}
    </>
  );
}

// Los botones de las apps de mapas para una parada. Tocar uno abre la navegación y queda como la elegida.
function BotonesApps({ p, app, alElegir }: { p: ParadaChofer; app: AppMapa | null; alElegir: (k: AppMapa) => void }) {
  return (
    <div className="ruta-apps">
      {APPS.map((a) => {
        const url = linkA(a.k, p);
        return url && <a key={a.k} className={`boton chico${a.k === app ? ' elegida' : ''}`} href={url} target="_blank" rel="noreferrer" onClick={() => alElegir(a.k)}>{a.nombre}</a>;
      })}
    </div>
  );
}

// La primera vez que toca «Cómo llegar» sin abrir la parada: con qué app va. Queda guardada para las siguientes.
// Va directo en el body: así queda arriba de todo, también del botón de la cámara.
function ElegirApp({ p, alElegir, alCerrar }: { p: ParadaChofer; alElegir: (k: AppMapa) => void; alCerrar: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') alCerrar(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [alCerrar]);
  return createPortal(
    <div className="hoja-fondo" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) alCerrar(); }}>
      <div className="hoja" role="dialog" aria-modal="true" aria-labelledby="hoja-titulo">
        <h2 id="hoja-titulo">¿Con qué app vas?</h2>
        <p className="ruta-nota">A {p.nombre}. La próxima vez abre directo con la que elijas; la cambiás en «Cómo llegar» de cada parada.</p>
        <BotonesApps p={p} app={null} alElegir={alElegir} />
        <button type="button" className="enlace" onClick={alCerrar}>Cancelar</button>
      </div>
    </div>,
    document.body,
  );
}

// La parada abierta (pedido de Rodrigo del 16/11/2026): una pantalla propia que entra desde la derecha, como si el chofer
// entrara a la parada, con el lugar y la dirección grandes, qué hacer, a quién preguntar y, abajo y siempre a mano, los
// botones. Se vuelve con la flecha o con el «atrás» del celular. Después de hacerla queda abierta (para la foto del remito)
// y ofrece la siguiente.
const QUE: Record<string, string> = { entrega: 'Entrega', retiro_proveedor: 'Retiro', retiro_impresor: 'Retiro', egreso: 'Egreso' };
function PantallaParada({ p, n, total, llega, sinUbicar, tarde, hecha, conFoto, enLinea, app, siguiente, alElegirApp, alMarcar, alEntregar, alVolver, alSiguiente }: {
  p: ParadaChofer; n: number; total: number; llega: number; sinUbicar: boolean; tarde: boolean; hecha: boolean; conFoto: boolean; enLinea: boolean; app: AppMapa | null;
  siguiente: ParadaChofer | null; alElegirApp: (k: AppMapa) => void; alMarcar: (resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, motivo?: string, nota?: string) => void;
  alEntregar: (parada?: string) => void; alVolver: () => void; alSiguiente: () => void;
}) {
  const [paso, setPaso] = useState<'botones' | 'motivo'>('botones');
  const [motivo, setMotivo] = useState('');
  const [nota, setNota] = useState('');
  const cuerpo = useRef<HTMLDivElement>(null);
  // Otra parada (la siguiente): arriba de todo y con los botones de siempre.
  useEffect(() => { setPaso('botones'); setMotivo(''); setNota(''); cuerpo.current?.scrollTo({ top: 0 }); }, [p.clave]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') alVolver(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [alVolver]);
  const esEntrega = p.movimientos.some((m) => m.tipo === 'entrega');
  const encs = p.encargos ?? [];
  const soloRetiros = p.movimientos.every((m) => m.tipo.startsWith('retiro')) && encs.every((e) => !e.llevar.length && e.retirar.length > 0);
  function marcar(resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, m?: string, n2?: string) {
    // Hecha (una entrega, un retiro, un egreso, un encargo): directo a la foto del remito, que es obligatoria en todas. La
    // cámara se abre ya, en el mismo toque: si se espera a que conteste el servidor, el iPhone no la deja abrir.
    if (resultado === 'hecho') alEntregar(p.clave);
    alMarcar(resultado, m, n2);
    setPaso('botones');
  }
  const tipos = [...new Set([...p.movimientos.map((m) => QUE[m.tipo] ?? m.tipo), ...(encs.length ? ['Encargo'] : [])])];
  const estado = hecha ? { t: conFoto ? 'Hecha' : 'Hecha · falta la foto del remito', c: conFoto ? 'bien' : 'mal' }
    : p.visita?.resultado === 'no_se_pudo' ? { t: `No se pudo: ${MOTIVOS.find((x) => x[0] === p.visita!.motivo)?.[1] ?? 'otro motivo'}${p.visita.nota ? ` (${p.visita.nota})` : ''}`, c: 'mal' }
    : p.visita?.resultado === 'salteada' ? { t: 'La dejaste para después', c: 'neutro' } : { t: 'Pendiente', c: 'acento' };
  const telefonos = [...new Set([p.lugar?.telefono, ...encs.map((e) => e.contacto)].map((t) => String(t ?? '').match(/(\+?\d[\d\s-]{6,}\d)/)?.[1]?.replace(/[\s-]/g, '')).filter((x): x is string => !!x))];
  const contacto = [p.lugar?.contacto, p.lugar?.telefono].filter(Boolean).join(' · ');
  return createPortal(
    <div className="parada-pantalla" role="dialog" aria-modal="true" aria-labelledby="parada-titulo">
      <header className="parada-cab">
        <button type="button" className="parada-volver" onClick={alVolver}><Icono nombre="atras" tamano={22} />Recorrido</button>
        <span className="parada-cuenta">Parada {n} de {total}</span>
      </header>
      <div className="parada-cuerpo" ref={cuerpo}>
        <section className="parada-hero">
          <span className={`parada-estado ${estado.c}`}>{estado.t}</span>
          <h2 id="parada-titulo">{p.nombre}</h2>
          {tipos.length > 0 && <p className="parada-tipos">{tipos.map((t) => <span key={t}>{t}</span>)}</p>}
          {p.expreso && <p className="parada-expreso">Es un expreso: dejá la mercadería para <b>{p.expreso.cliente}</b>{p.expreso.guia ? ` · guía ${p.expreso.guia}` : ''}</p>}
          <p className="parada-dir"><Icono nombre="lugar" tamano={22} /><span>{p.direccion ?? 'Sin dirección: preguntale a Logística'}</span></p>
          <p className={`parada-llega${tarde ? ' tarde' : ''}`}><Icono nombre="reloj" tamano={20} />
            <span>{sinUbicar ? 'Sin hora estimada' : <>Llegás cerca de las <b>{hhmm(llega)}</b></>}
              {p.pactada ? <> · <b>{p.pactada}</b></> : p.horario ? ` · reciben de ${hhmm(p.horario[0])} a ${hhmm(p.horario[1])}` : p.lugar?.horario ? ` · horario: ${p.lugar.horario}` : ''}
              {tarde ? ' · vas justo' : ''}</span></p>
          {destinoDe(p) && (
            <div className="ruta-llegar">
              <p className="ruta-llegar-tit"><Icono nombre="navegar" tamano={20} />Cómo llegar con</p>
              <BotonesApps p={p} app={app} alElegir={alElegirApp} />
            </div>
          )}
        </section>

        <section className="parada-seccion">
          <h3>Qué hay que hacer</h3>
          <ul className="parada-que">
            {p.movimientos.map((m) => <li key={m.id} className={m.hecho ? 'hecho' : ''}><strong>{TIPO[m.tipo] ?? m.tipo}</strong>
              <span>{m.articulo ? `${m.cantidad != null ? `${num.format(m.cantidad)} ` : ''}${m.articulo}` : 'Lo del pedido'}<small>PDV {m.npdv ?? '—'}{m.cliente ? ` · ${m.cliente}` : ''}</small></span></li>)}
            {encs.flatMap((e) => [
              ...e.llevar.map((it, k) => <li key={`${e.id}l${k}`} className={e.estado === 'hecho' ? 'hecho' : ''}><strong>Dejar</strong><span>{item(it)}{e.desde ? <small>Lo buscás en {e.desde}</small> : null}</span></li>),
              ...e.retirar.map((it, k) => <li key={`${e.id}r${k}`} className={e.estado === 'hecho' ? 'hecho' : ''}><strong>Retirar</strong><span>{item(it)}{e.hacia ? <small>Va a {e.hacia}</small> : null}</span></li>),
              ...(!e.llevar.length && !e.retirar.length && e.notas ? [<li key={`${e.id}n`} className={e.estado === 'hecho' ? 'hecho' : ''}><strong>Hacer</strong><span>{e.notas}</span></li>] : []),
            ])}
          </ul>
          {encs.map((e) => {
            const partes = [e.urgente ? 'Urgente: tiene que ser hoy' : '', e.horario ? `Horario: ${e.horario}` : '', e.llevar.length || e.retirar.length ? e.notas ?? '' : ''].filter(Boolean);
            return (partes.length > 0 || e.quien) && (
              <p key={`x${e.id}`} className={e.urgente ? 'ruta-tarde' : 'parada-nota'}>{partes.join(' · ')}
                {e.quien && <>{partes.length ? ' · ' : ''}Lo pidió <QuienPidio nombre={e.quien} foto={e.quien_foto} /></>}</p>
            );
          })}
        </section>

        {(contacto || p.lugar?.observaciones || encs.some((e) => e.contacto)) && (
          <section className="parada-seccion">
            <h3>En el lugar</h3>
            {contacto && <p>Preguntá por <b>{contacto}</b></p>}
            {encs.filter((e) => e.contacto).map((e) => <p key={`c${e.id}`}>Preguntá por <b>{e.contacto}</b></p>)}
            {p.lugar?.observaciones && <p className="parada-ojo"><Icono nombre="aviso" tamano={20} /><span>{p.lugar.observaciones}</span></p>}
            {telefonos.length > 0 && <div className="parada-llamar">{telefonos.map((t) => <a key={t} className="boton chico" href={`tel:${t}`}>Llamar {t}</a>)}</div>}
          </section>
        )}

        {hecha && (conFoto
          ? <p className="parada-foto bien"><Icono nombre="bien" tamano={22} />La foto del remito ya está.</p>
          : <p className="ruta-sin-foto">Falta la foto del remito. Es obligatoria: sin ella, la parada no queda completa.</p>)}
        {!enLinea && <p className="ruta-tarde">Sin señal no se puede marcar la parada.</p>}

        {paso === 'motivo' && (
          <form id={`motivo-${p.clave}`} className="ruta-motivo" onSubmit={(e) => { e.preventDefault(); if (motivo) marcar('no_se_pudo', motivo, nota); }}>
            <fieldset><legend>¿Qué pasó?</legend>
              {MOTIVOS.filter(([k]) => (k === 'no_listo' ? !esEntrega : k === 'rechazo' ? esEntrega : true)).map(([k, t]) => (
                <label key={k} className={motivo === k ? 'elegido' : ''}><input type="radio" name={`motivo-${p.clave}`} checked={motivo === k} onChange={() => setMotivo(k)} />{t}</label>))}
            </fieldset>
            <input className="campo" value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Algo más para Logística (opcional)" aria-label="Nota para Logística" maxLength={300} />
          </form>
        )}
      </div>

      <footer className="parada-acciones">
        {paso === 'motivo' ? (<>
          <button type="submit" form={`motivo-${p.clave}`} className="boton principal" disabled={!motivo || !enLinea}>Avisar a Logística</button>
          <button type="button" className="boton chico" onClick={() => setPaso('botones')}>Volver</button>
        </>) : hecha || p.visita ? (<>
          {hecha && <button type="button" className={conFoto ? 'boton chico' : 'boton principal'} onClick={() => alEntregar(p.clave)}><Icono nombre="camara" />{conFoto ? 'Sacar otra foto' : p.expreso ? 'Sacar la foto de la guía' : 'Sacar la foto del remito'}</button>}
          {!hecha && <button type="button" className="boton principal" disabled={!enLinea} onClick={() => marcar('hecho')}>{esEntrega ? 'Ahora sí: entregué' : 'Ahora sí: listo'}</button>}
          <div className="parada-fila">
            <button type="button" className="boton chico" disabled={!enLinea} onClick={() => marcar(null)}>Deshacer</button>
            {siguiente && <button type="button" className="boton chico" onClick={alSiguiente}>Siguiente: {siguiente.nombre}</button>}
          </div>
        </>) : (<>
          <button type="button" className="boton principal" disabled={!enLinea} onClick={() => marcar('hecho')}><Icono nombre="camara" />{p.expreso ? 'Dejé en el expreso: foto de la guía' : esEntrega ? 'Entregué: sacar foto del remito' : soloRetiros ? 'Retiré todo: sacar foto del remito' : 'Listo: sacar foto del remito'}</button>
          <div className="parada-fila">
            <button type="button" className="boton chico" disabled={!enLinea} onClick={() => setPaso('motivo')}>No se pudo</button>
            <button type="button" className="boton chico" disabled={!enLinea} onClick={() => marcar('salteada')}>Para después</button>
          </div>
        </>)}
      </footer>
    </div>,
    document.body,
  );
}
