import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, useMeta } from '../lib';
import { refrescarNoLeidas } from '../pages/Conversacion';

// Piezas comunes de la versión celular (revisión del 18/11/2026): cargar datos sin mezclar respuestas viejas ni
// confundir un error con «no hay nada», recargar al volver a la app, volver atrás sin quedar encerrado y cerrar las hojas
// con el botón Atrás del teléfono.

// ---------- Volver a la app ----------

// Si la app estuvo en segundo plano más de 5 minutos (o pasó la medianoche), al volver se recarga lo que está a la vista:
// una app instalada no tiene «tirar para refrescar» y quedaba mostrando el día anterior.
let vuelta = 0;
const oyentes = new Set<(n: number) => void>();
let oculta = 0;
let dia = new Date().toDateString();
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { oculta = Date.now(); return; }
    const otroDia = new Date().toDateString() !== dia;
    if (oculta && (Date.now() - oculta > 5 * 60_000 || otroDia)) {
      dia = new Date().toDateString();
      vuelta++;
      oyentes.forEach((f) => f(vuelta));
      refrescarNoLeidas();
    }
  });
}
export function useVuelta() {
  const [n, setN] = useState(vuelta);
  useEffect(() => { oyentes.add(setN); return () => { oyentes.delete(setN); }; }, []);
  return n;
}

// ---------- Cargar ----------

// Carga algo de la API: `datos` es null mientras carga, `error` dice qué falló (y no se muestra como lista vacía). Si las
// dependencias cambian antes de que llegue la respuesta, la vieja se descarta (antes, con señal lenta, «Hechas» llegó a
// mostrar las tareas pendientes). `recargar` vuelve a pedir sin borrar lo que se ve.
export function useCarga<T>(pedir: () => Promise<T>, deps: unknown[]) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  const vuelto = useVuelta();
  const llave = JSON.stringify(deps);
  const ultima = useRef(llave);
  useEffect(() => {
    let vivo = true;
    // Otra cosa (otro registro, otro filtro): se limpia lo anterior para no mostrarlo ni escribir en él.
    if (ultima.current !== llave) { setDatos(null); ultima.current = llave; }
    setError('');
    pedir().then((d) => { if (vivo) setDatos(d); }, (e) => { if (vivo) setError((e as Error).message || 'No se pudo cargar.'); });
    return () => { vivo = false; };
  }, [llave, n, vuelto]); // eslint-disable-line react-hooks/exhaustive-deps
  const recargar = useCallback(() => setN((x) => x + 1), []);
  return { datos, error, recargar, setDatos };
}

// Lo que se muestra cuando algo no cargó: el motivo y «Reintentar» (nunca «no hay nada»).
export function Fallo({ error, onReintentar, chico }: { error: string; onReintentar: () => void; chico?: boolean }) {
  return (
    <div className={`m-fallo${chico ? ' chico' : ''}`} role="alert">
      <Icon name="alert" size={chico ? 16 : 20} />
      <span>{error}</span>
      <button type="button" className="btn sm" onClick={onReintentar}>Reintentar</button>
    </div>
  );
}

// ---------- Navegación ----------

// Volver: atrás si se llegó navegando dentro de la app; si se entró directo (un link de un mail o una notificación, la app
// recién abierta), a `alt`. Antes, «Volver» dejaba la pantalla en blanco o fuera de la app.
export function useVolver() {
  const navigate = useNavigate();
  return useCallback((alt: string) => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1); else navigate(alt, { replace: true });
  }, [navigate]);
}

// Una hoja o panel abierto se cierra con el botón Atrás del teléfono (o el gesto), en vez de irse de la pantalla y perder
// lo que se estaba escribiendo. Al abrir se suma un paso al historial; si se cierra con la ✕, se saca.
// Una hoja que abre otra (＋ → «Nueva tarea») comparte el mismo paso: se saca recién cuando no queda ninguna abierta, y
// si se cerró porque se fue a otra pantalla, no se toca el historial.
let hojasAbiertas = 0;
const esPasoDeHoja = () => !!(window.history.state as { hojaMovil?: boolean } | null)?.hojaMovil;
export function useCerrarConAtras(onClose: () => void) {
  const cerrar = useRef(onClose);
  cerrar.current = onClose;
  useEffect(() => {
    hojasAbiertas++;
    if (!esPasoDeHoja()) window.history.pushState({ ...(window.history.state ?? {}), hojaMovil: true }, '');
    const alVolver = () => cerrar.current();
    window.addEventListener('popstate', alVolver);
    return () => {
      window.removeEventListener('popstate', alVolver);
      hojasAbiertas--;
      window.setTimeout(() => { if (hojasAbiertas === 0 && esPasoDeHoja()) window.history.back(); }, 0);
    };
  }, []);
}

// ¿Puede cargar y cambiar cosas? No con el rol «Solo mira» ni mirando como otro usuario: esos botones no se muestran.
export function usePuedeEscribir() {
  const { meta } = useMeta();
  return meta.me.role !== 'viewer' && !meta.real_user;
}
