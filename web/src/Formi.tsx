import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { http, useMeta, useToast, Icon, fmtDate, fmtRelative, userOf } from './lib';
import { UserAvatar } from './components';

// Formi (pedido de Rodrigo del 19/11/2026; src/worker/ideas.ts, docs/IDEAS.md): el personaje de abajo a la derecha del Hub,
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
const leer = (k: string) => { try { return localStorage.getItem(`formi.${k}`); } catch { return null; } };
const guardar = (k: string, v: string) => { try { localStorage.setItem(`formi.${k}`, v); } catch { /* sin almacenamiento */ } };

// ---------- Abrir el buzón desde otro lado (la campanita) ----------
let abrirDesdeAfuera: ((id?: number) => void) | null = null;
export function abrirFormi(id?: number) { abrirDesdeAfuera?.(id); }

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
  capa.className = 'formi-papelitos';
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

// ---------- El personaje ----------
function Personaje({ animo, lampara, ojosRef }: { animo: string; lampara: boolean; ojosRef: React.RefObject<HTMLSpanElement> }) {
  return (
    <span className={`formi-bicho ${animo}`} aria-hidden="true">
      <span className={`formi-antena${lampara ? ' prendida' : ''}`}><span className="formi-lampara" /></span>
      <span className="formi-cuerpo">
        <span className="formi-ojos" ref={ojosRef}>
          <span className="formi-ojo"><span className="formi-pupila" /></span>
          <span className="formi-ojo"><span className="formi-pupila" /></span>
        </span>
        <span className="formi-cachetes"><span /><span /></span>
        <span className="formi-boca" />
      </span>
      <span className="formi-mano izq" /><span className="formi-mano der" />
      <span className="formi-zzz"><i>z</i><i>z</i><i>z</i></span>
    </span>
  );
}

export default function Formi() {
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
  const botonRef = useRef<HTMLButtonElement>(null);
  const ojosRef = useRef<HTMLSpanElement>(null);

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
      g = { tipo: 'hola', texto: '¡Hola! Soy Formi 👋 Guardo las ideas para mejorar el Hub. Proponé las tuyas y votá las de los demás.' };
    } else if (nuevas > 0 && leer('aviso_nuevas') !== `${hoy}:${maxId}`) {
      guardar('aviso_nuevas', `${hoy}:${maxId}`);
      g = { tipo: 'nuevas', texto: nuevas === 1 ? 'Hay una idea nueva esperando tu voto 👀' : `Hay ${nuevas} ideas nuevas esperando tu voto 👀` };
    } else if (leer('charla') !== hoy && !escondido) {
      guardar('charla', hoy);
      g = { tipo: 'charla', texto: FRASES[Math.floor(Math.random() * FRASES.length)] };
    }
    if (!g || (escondido && g.tipo === 'charla')) return;
    const t1 = setTimeout(() => {
      setGlobo(g);
      if (g!.tipo === 'festejo') { setAnimo('feliz'); festejar(botonRef.current); setTimeout(() => setAnimo(''), 2400); }
    }, 3500);
    const t2 = setTimeout(() => setGlobo((x) => (x === g ? null : x)), 3500 + (g.tipo === 'festejo' || g.tipo === 'hola' ? 14_000 : 9000));
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ideas]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const estorba = /^\/conversaciones/.test(loc.pathname) || new URLSearchParams(loc.search).has('conversacion');
  const esconder = (v: boolean) => { setEscondido(v); guardar('escondido', v ? '1' : '0'); setGlobo(null); };
  const lampara = abierto || nuevas > 0 || globo?.tipo === 'festejo';

  return createPortal(
    <div className={`formi-zona${(escondido || estorba) && !abierto ? ' escondido' : ''}${abierto ? ' abierto' : ''}`}>
      {abierto && <div className="formi-velo" onClick={() => setAbierto(false)} aria-hidden="true" />}
      {abierto && ideas && (
        <Buzon ideas={ideas} admin={admin} yo={yo} resaltar={resaltar} onResaltado={() => setResaltar(null)} cerrar={() => setAbierto(false)}
          cambiar={(i) => setIdeas((l) => (l ?? []).map((x) => (x.id === i.id ? i : x)))}
          agregar={(i) => { setIdeas((l) => [i, ...(l ?? [])]); setAnimo('traga'); setTimeout(() => setAnimo(''), 900); }}
          quitar={(id) => setIdeas((l) => (l ?? []).filter((x) => x.id !== id))}
          festejo={() => { setAnimo('feliz'); festejar(botonRef.current); setTimeout(() => setAnimo(''), 2000); }}
          toast={toast} />
      )}
      {abierto && !ideas && <div className="formi-panel cargando" role="dialog" aria-label="Buzón de ideas"><div className="muted small">Buscando las ideas…</div></div>}
      {globo && !abierto && !estorba && (
        <div className={`formi-globo ${globo.tipo}`} role="status">
          <button type="button" className="formi-globo-texto" onClick={() => abrir()}>{globo.texto}</button>
          <button type="button" className="formi-globo-x" onClick={() => setGlobo(null)} aria-label="Cerrar"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div className="formi-lugar">
        <button ref={botonRef} type="button" className="formi" onClick={() => (abierto ? setAbierto(false) : escondido && !estorba ? esconder(false) : abrir())}
          onPointerEnter={() => setAnimo((a) => (a === '' || a === 'duerme' ? 'mira' : a))} onPointerLeave={() => setAnimo((a) => (a === 'mira' ? '' : a))}
          aria-expanded={abierto} aria-label={escondido ? 'Mostrar a Formi (buzón de ideas)' : nuevas ? `Buzón de ideas: ${nuevas} nuevas` : 'Buzón de ideas para mejorar el Hub'}
          title={escondido ? 'Volver a mostrar a Formi' : 'Ideas para mejorar el Hub'}>
          <Personaje animo={animo} lampara={lampara} ojosRef={ojosRef} />
          {nuevas > 0 && !abierto && <span className="formi-n">{nuevas > 9 ? '9+' : nuevas}</span>}
        </button>
        {!escondido && !estorba && !abierto && (
          <button type="button" className="formi-esconder" onClick={() => esconder(true)} aria-label="Esconder a Formi" title="Esconder a Formi (queda espiando en el borde)">
            <Icon name="x" size={10} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- El buzón ----------
function Buzon({ ideas, admin, yo, resaltar, onResaltado, cerrar, cambiar, agregar, quitar, festejo, toast }: {
  ideas: Idea[]; admin: boolean; yo: number; resaltar: number | null; onResaltado: () => void; cerrar: () => void;
  cambiar: (i: Idea) => void; agregar: (i: Idea) => void; quitar: (id: number) => void; festejo: () => void;
  toast: (msg: string, err?: boolean) => void;
}) {
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
      document.getElementById(`formi-idea-${resaltar}`)?.scrollIntoView({ block: 'center', behavior: reducido() ? 'auto' : 'smooth' });
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
      setTimeout(() => document.getElementById(`formi-idea-${i.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
    } catch (e) {
      const err = e as Error & { data?: { idea_id?: number } };
      toast(err.message, true);
      const id = err.data?.idea_id;
      if (id) { setPestana('ranking'); setTimeout(() => document.getElementById(`formi-idea-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); }
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
    <div className="formi-panel" role="dialog" aria-label="Buzón de ideas">
      <div className="formi-cab">
        <div className="formi-cab-txt">
          <b>Buzón de ideas</b>
          <span>Proponé mejoras para el Hub y votá las de los demás: las más votadas se hacen primero.</span>
        </div>
        <button type="button" className="btn ghost icon sm" onClick={cerrar} aria-label="Cerrar el buzón"><Icon name="x" size={16} /></button>
      </div>

      <div className="formi-escribir">
        <textarea ref={areaRef} className="input" rows={2} maxLength={1000} placeholder={ejemplo} value={texto} onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); proponer(); } }} aria-label="Tu idea para mejorar el Hub" />
        {similares.length > 0 && (
          <div className="formi-parecidas">
            <span className="small">¿Es alguna de estas? <b>Votala</b> en vez de repetirla:</span>
            {similares.map((i) => (
              <div key={i.id} className="formi-parecida">
                <span className="grow">{i.texto.length > 90 ? `${i.texto.slice(0, 88)}…` : i.texto}</span>
                <BotonVoto idea={i} cambiar={cambiar} toast={toast} chico />
              </div>
            ))}
          </div>
        )}
        <div className="formi-escribir-pie">
          {texto.length > 800 ? <span className="small muted">{1000 - texto.length} caracteres más</span> : <span className="small muted formi-atajo">Ctrl + Enter para mandar</span>}
          <button type="button" className="btn primary sm" onClick={proponer} disabled={mandando || !texto.trim()}>
            <Icon name="spark" size={14} />{mandando ? 'Mandando…' : 'Proponer'}
          </button>
        </div>
      </div>

      <div className="formi-pestanas seg sm" role="tablist">
        <button role="tab" aria-selected={pestana === 'ranking'} className={pestana === 'ranking' ? 'on' : ''} onClick={() => setPestana('ranking')}>Ranking · {pendientes.length + enMarcha.length}</button>
        <button role="tab" aria-selected={pestana === 'hechas'} className={pestana === 'hechas' ? 'on' : ''} onClick={() => setPestana('hechas')}>Hechas · {hechas.length}</button>
        <button role="tab" aria-selected={pestana === 'mias'} className={pestana === 'mias' ? 'on' : ''} onClick={() => setPestana('mias')}>Mías · {mias.length}</button>
      </div>

      <div className="formi-lista" ref={listaRef}>
        {pestana === 'ranking' && <>
          {(pendientes.length + enMarcha.length) > 0 && (
            <div className="formi-ayuda-voto">
              <span className="formi-ayuda-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width={14} height={14}><path d="M12 5l7 9h-4.5v5h-5v-5H5z" fill="currentColor" /></svg></span>
              <span><b>Votá las ideas que te sirven</b> con el botón <b>Votar</b>: las más votadas se hacen primero. Podés votar todas las que quieras.
                {' '}{sinVotar > 0 ? <b className="formi-faltan">{sinVotar === 1 ? 'Te queda 1 por votar.' : `Te quedan ${sinVotar} por votar.`}</b> : <span className="formi-faltan listo">Ya votaste todas 🙌</span>}</span>
            </div>
          )}
          {enMarcha.length > 0 && <div className="formi-grupo"><span className="formi-grupo-ic en_curso"><Icon name="settings" size={12} /></span>En marcha</div>}
          {enMarcha.map((i) => tarjeta(i))}
          {enMarcha.length > 0 && pendientes.length > 0 && <div className="formi-grupo"><span className="formi-grupo-ic"><Icon name="star" size={12} /></span>Para votar</div>}
          {pendientes.map((i, k) => tarjeta(i, k + 1))}
          {!pendientes.length && !enMarcha.length && <Vacio texto="No hay ideas pendientes. ¡Sé la primera persona en proponer algo!" />}
        </>}
        {pestana === 'hechas' && <>
          {fama.length > 0 && (
            <div className="formi-fama">
              <span className="small"><b>Salón de la fama</b> · ideas hechas por persona</span>
              <div className="formi-fama-lista">
                {fama.map(([u, n]) => (
                  <span key={u} className="formi-fama-u" title={`${userOf(meta, u)?.name ?? 'Alguien'}: ${n} ${n === 1 ? 'idea hecha' : 'ideas hechas'}`}>
                    <UserAvatar id={u} size="sm" /><b>{n}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
          {hechas.map((i) => tarjeta(i))}
          {!hechas.length && <Vacio texto="Todavía no se hizo ninguna. La primera va a tener papelitos 🎉" />}
          {noVan.length > 0 && <>
            <div className="formi-grupo"><span className="formi-grupo-ic descartada"><Icon name="x" size={12} /></span>No van (por ahora)</div>
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
  return <div className="formi-vacio"><Personaje animo="mira" lampara={false} ojosRef={{ current: null }} /><span>{texto}</span></div>;
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
    if (v && !reducido()) { setPop(true); setTimeout(() => setPop(false), 450); }
    try { cambiar(await http<Idea>(v ? 'PUT' : 'DELETE', `/ideas/${idea.id}/voto`)); }
    catch (e) { cambiar(idea); toast((e as Error).message, true); }
  };
  return (
    <button type="button" className={`formi-voto${idea.votada ? ' on' : ''}${chico ? ' chico' : ''}${pop ? ' pop' : ''}`} onClick={votar} disabled={!abierta}
      aria-pressed={idea.votada} title={!abierta ? `${idea.votos} ${idea.votos === 1 ? 'voto' : 'votos'}` : idea.votada ? 'Sacar mi voto' : 'Votar esta idea'}
      aria-label={`${idea.votada ? 'Sacar mi voto' : 'Votar'} (${idea.votos} ${idea.votos === 1 ? 'voto' : 'votos'})`}>
      {idea.votada && abierta
        ? <svg viewBox="0 0 24 24" width={chico ? 12 : 15} height={chico ? 12 : 15} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg viewBox="0 0 24 24" width={chico ? 12 : 15} height={chico ? 12 : 15} aria-hidden="true"><path d="M12 5l7 9h-4.5v5h-5v-5H5z" fill="currentColor" /></svg>}
      {/* Que se lea que es un voto (pedido de Rodrigo): «Votar» / «Votaste» y el número; cerrada, solo cuántos votos tuvo. */}
      {chico
        ? <span className="formi-voto-txt">{idea.votada ? 'Votaste' : 'Votar'} · <b>{idea.votos}</b></span>
        : <><b>{idea.votos}</b><span className="formi-voto-txt">{!abierta ? (idea.votos === 1 ? 'voto' : 'votos') : idea.votada ? 'Votaste' : 'Votar'}</span></>}
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
    <article id={`formi-idea-${idea.id}`} className={`formi-idea ${idea.estado}${resaltada ? ' resaltada' : ''}`} style={{ '--i': puesto ?? 0 } as CSSProperties}>
      <BotonVoto idea={idea} cambiar={cambiar} toast={toast} />
      <div className="formi-idea-cuerpo">
        {editando
          ? <div className="formi-editar">
              <textarea className="input" rows={3} maxLength={1000} value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus />
              <div className="formi-acciones">
                <button type="button" className="btn sm" onClick={() => { setEditando(false); setTexto(idea.texto); }}>Cancelar</button>
                <button type="button" className="btn primary sm" onClick={guardarTexto} disabled={ocupado || texto.trim().length < 8}>Guardar</button>
              </div>
            </div>
          : <p className="formi-idea-texto">
              {puesto && puesto <= 3 && idea.votos > 1 && <span className={`formi-puesto p${puesto}`} title={`Puesto ${puesto} del ranking`}>{puesto === 1 ? '👑' : `#${puesto}`}</span>}
              {idea.texto}
            </p>}
        <div className="formi-idea-meta">
          <UserAvatar id={idea.user_id} size="xs" />
          <span>{quien}</span>
          <span className="muted" title={fmtDate(idea.created_at, true)}>· {fmtRelative(idea.created_at, true)}</span>
          {nueva && <span className="formi-chip nueva">Nueva</span>}
          {idea.estado !== 'pendiente' && <span className={`formi-chip ${idea.estado}`}>{ESTADO_LABEL[idea.estado]}{idea.estado_at && idea.estado !== 'en_curso' ? ` el ${fmtDate(idea.estado_at)}` : ''}</span>}
          {otros.length > 0 && (
            <span className="formi-votantes" title={`La votaron: ${otros.map((u) => userOf(meta, u)?.name ?? 'Alguien').join(', ')}`}>
              {otros.slice(0, 3).map((u) => <UserAvatar key={u} id={u} size="xs" />)}
              {otros.length > 3 && <span className="formi-mas">+{otros.length - 3}</span>}
            </span>
          )}
        </div>
        {idea.respuesta && !marcar && (
          <div className="formi-respuesta">
            {idea.estado_por && <UserAvatar id={idea.estado_por} size="xs" />}
            <span><b>{idea.estado_por ? userOf(meta, idea.estado_por)?.name.split(' ')[0] ?? 'Admin' : 'Respuesta'}:</b> {idea.respuesta}</span>
          </div>
        )}
        {marcar && (
          <div className="formi-editar">
            <textarea className="input" rows={2} maxLength={1000} value={respuesta} onChange={(e) => setRespuesta(e.target.value)} autoFocus
              placeholder={marcar === 'hecha' ? 'Contales qué se hizo y dónde está (opcional)' : marcar === 'descartada' ? '¿Por qué no va? (opcional, pero ayuda)' : 'Un comentario para el equipo (opcional)'} />
            <div className="formi-acciones">
              <button type="button" className="btn sm" onClick={() => { setMarcar(null); setRespuesta(idea.respuesta ?? ''); }}>Cancelar</button>
              <button type="button" className={`btn sm ${marcar === 'descartada' ? 'danger' : 'primary'}`} onClick={() => cambiarEstado(marcar)} disabled={ocupado}>
                {marcar === idea.estado ? 'Guardar respuesta' : marcar === 'hecha' ? '¡Marcar hecha!' : marcar === 'en_curso' ? 'Poner en marcha' : marcar === 'descartada' ? 'No va' : 'Volver a pendiente'}
              </button>
            </div>
          </div>
        )}
        {!editando && !marcar && (admin || idea.puede_editar) && (
          <div className="formi-acciones">
            {admin && idea.estado === 'pendiente' && <button type="button" className="btn ghost sm" onClick={() => setMarcar('en_curso')}><Icon name="settings" size={12} />En marcha</button>}
            {admin && idea.estado !== 'hecha' && <button type="button" className="btn ghost sm formi-hecha" onClick={() => setMarcar('hecha')}><Icon name="check" size={12} />Hecha</button>}
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
