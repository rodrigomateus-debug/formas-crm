import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// ---------- Tipos compartidos con el Worker ----------

export type ObjectType = 'contact' | 'company' | 'deal' | 'order';
export interface Option { value: string; label: string }
export interface Property {
  object_type: ObjectType; name: string; label: string; type: string; options: Option[]; group_name: string; description: string;
  display_order: number; system: number; read_only: number; in_create_form: number; required: number;
}
export interface StageConfig { required_props?: string[]; task?: { subject: string; due_days?: number; task_type?: string } | null }
export interface PipelineConfig {
  rules?: { no_skip?: boolean; no_backward?: boolean; require_company?: boolean; create_stages?: string[] };
  visible_teams?: number[];
  card_props?: string[];
  key_props?: string[];
}
export interface Stage { id: string; pipeline_id: string; label: string; display_order: number; probability: number; is_closed: number; is_won: number; config: StageConfig }
export interface Pipeline { id: string; label: string; display_order: number; team_id: number | null; config: PipelineConfig; stages: Stage[] }
// photo_url: la foto de su cuenta de Google (la trae el CRM, src/worker/fotos.ts); sin foto, se ven sus iniciales.
export interface User { id: number; email: string; name: string; role: string; profile: string; team_id: number | null; extra_teams?: string; active: number; photo_url?: string | null; deleted_at?: string | null; superadmin?: number }
// Perfiles: el área de cada usuario (por ahora todos ven todo; más adelante cada uno va a ver lo suyo). Permisos: qué puede hacer.
export const PROFILE_LABEL: Record<string, string> = { admin: 'Admin', comercial: 'Comercial', produccion: 'Producción', logistica: 'Logística' };
export const ROLE_LABEL: Record<string, string> = { member: 'Edita', manager: 'Edita y borra', viewer: 'Solo mira' };
// Perfil Ventas (perfil Comercial que no es administrador): ve lo suyo, lo sin propietario y lo asociado a lo suyo; no ve
// Producción, la bandeja de Entregas ni el ranking del equipo, y no importa ni exporta. Lo controla el servidor (src/worker/alcance.ts);
// la pantalla solo esconde lo que no va a poder abrir.
export const esVentas = (u: Pick<User, 'profile' | 'role'>) => u.profile === 'comercial' && u.role !== 'admin';
// Etiqueta de color con regla: se pone sola a los registros que cumplen sus filtros (en los pipelines elegidos).
export interface Tag { id: number; name: string; color: string; object_type: ObjectType; description: string; rule: { groups?: Filter[][]; pipelines?: string[] } }
export interface Meta {
  // superadmin: quien está en la sesión puede «Ver como»; real_user: mirando como otro, quién es en realidad.
  superadmin?: boolean; real_user?: { id: number; name: string; email: string; photo_url: string | null };
  me: User & { deal_pipelines?: string[] }; properties: Property[]; pipelines: Pipeline[]; users: User[]; teams: Array<{ id: number; name: string }>; tags: Tag[]; key_props?: Partial<Record<ObjectType, string[]>>;
  orden_vistas?: Partial<Record<ObjectType, Array<number | string>>> }
export interface CrmRecord { id: number; type: ObjectType; name: string; props: Record<string, any>; created_at: string; updated_at: string; archived: boolean; tags?: number[] }
export interface Activity {
  id: number; type: 'note' | 'email' | 'call' | 'meeting' | 'task' | 'whatsapp'; occurred_at: string; owner_id: number | null; subject: string; body: string;
  direction: string | null; status: string | null; outcome: string | null; due_at: string | null; completed_at: string | null; priority: string | null;
  task_type: string | null; meta: Record<string, any>; links: Array<{ id: number; type: ObjectType; name: string }>; source: string; created_by: number | null;
}
export interface Filter { prop: string; op: string; value?: unknown; values?: unknown[]; high?: unknown }

export const OBJECTS: Record<ObjectType, { path: string; plural: string; single: string; nameProp: string; create: string }> = {
  contact: { path: 'contacts', plural: 'Contactos', single: 'Contacto', nameProp: 'name', create: 'Crear contacto' },
  company: { path: 'companies', plural: 'Empresas', single: 'Empresa', nameProp: 'name', create: 'Crear empresa' },
  deal: { path: 'deals', plural: 'Negocios', single: 'Negocio', nameProp: 'dealname', create: 'Crear negocio' },
  order: { path: 'orders', plural: 'Pedidos', single: 'Pedido', nameProp: 'hs_order_name', create: 'Crear pedido' },
};
export const typeFromPath = (p: string) => (Object.entries(OBJECTS).find(([, v]) => v.path === p)?.[0] ?? 'contact') as ObjectType;
export const recordUrl = (type: ObjectType, id: number) => `/${OBJECTS[type].path}/${id}`;

// ---------- De dónde se viene ----------
// Las listas se abren limpias, en su primera pestaña, cuando se entra desde el menú u otra pantalla; y como se dejaron
// cuando se vuelve de una ficha (por la flecha «← Negocios» o el botón de atrás) o se recarga la página. App avisa
// cada cambio de pantalla, antes de que se dibuje la nueva.
const esLista = (p: string) => Object.values(OBJECTS).some((o) => p === `/${o.path}`);
const esFicha = (p: string) => Object.values(OBJECTS).some((o) => new RegExp(`^/${o.path}/[^/]+$`).test(p));
const rutas = { actual: '', lista: '', soloFichas: false, volver: false };
try {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if ((nav?.type === 'reload' || nav?.type === 'back_forward') && esLista(location.pathname)) { rutas.lista = location.pathname; rutas.soloFichas = true; }
} catch { /* navegador sin el dato: se abre limpia */ }
export function registrarRuta(p: string) {
  if (p === rutas.actual) return;
  rutas.actual = p;
  rutas.volver = esLista(p) && rutas.lista === p && rutas.soloFichas;
  if (esLista(p)) { rutas.lista = p; rutas.soloFichas = true; }
  else if (!esFicha(p)) rutas.soloFichas = false;
}
// ¿Se está volviendo a la lista que se dejó (pasando solo por fichas)?
export const vuelveALaLista = () => rutas.volver;

// ---------- «Ver como» (superadmin) ----------

// El usuario como el que se está mirando el CRM (auth.ts, verComo). Queda guardado en el navegador hasta «Volver a mi
// usuario»; cada pedido al servidor lo manda en la cabecera x-ver-como. Es solo para mirar.
const VER_COMO = 'crm:ver-como';
export function verComoId(): number | null {
  try { const v = Number(localStorage.getItem(VER_COMO)); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}
export const cabecerasVerComo = (): Record<string, string> => { const id = verComoId(); return id ? { 'x-ver-como': String(id) } : {}; };
// Cambiar de usuario recarga la página: así no queda nada en memoria del anterior (listas, sin leer, tableros).
export function verComo(id: number | null) {
  try { if (id) localStorage.setItem(VER_COMO, String(id)); else localStorage.removeItem(VER_COMO); } catch { /* sin memoria: no se puede */ }
  window.location.reload();
}

// ---------- HTTP ----------

export async function http<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...cabecerasVerComo() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // El usuario que se estaba mirando ya no está (o se perdió el permiso): vuelve al propio.
  if (res.status === 403 && data?.ver_como_invalido && verComoId()) { verComo(null); throw new Error(data.error); }
  // Sin sesión (o vencida): a la pantalla de «Ingresar con Google», y después de vuelta a donde estaba.
  if (res.status === 401 && data?.login) {
    window.location.assign(`${data.login}?volver=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return new Promise<T>(() => { /* la página se va */ });
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Error ${res.status}`) as Error & { data?: any };
    err.data = data;
    throw err;
  }
  return data as T;
}

export function qs(params: Record<string, unknown>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    s.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

// ---------- Contexto de configuración ----------

const MetaCtx = createContext<{ meta: Meta; reload: () => Promise<void> } | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setMeta(await http<Meta>('GET', '/meta')); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  if (error) return <div className="empty">No se pudo abrir el CRM: {error}</div>;
  if (!meta) return <div className="empty">Cargando…</div>;
  return <MetaCtx.Provider value={{ meta, reload }}>{children}</MetaCtx.Provider>;
}

export function useMeta() {
  const v = useContext(MetaCtx);
  if (!v) throw new Error('MetaProvider faltante');
  return v;
}

export function propsOf(meta: Meta, type: ObjectType) {
  return meta.properties.filter((p) => p.object_type === type);
}
export function propOf(meta: Meta, type: ObjectType, name: string) {
  return meta.properties.find((p) => p.object_type === type && p.name === name);
}
export function stageOf(meta: Meta, id?: string) {
  for (const p of meta.pipelines) {
    const s = p.stages.find((st) => st.id === id);
    if (s) return { stage: s, pipeline: p };
  }
  return null;
}
// Cada equipo arranca en su pipeline (Corporate en Corporate, Formas Shop en Formas Shop).
// Pipeline con el que arranca Negocios: el de su equipo (el primero de sus equipos que tenga uno); si no tiene, donde tiene
// más negocios; si no, el primero.
export function defaultPipeline(meta: Meta) {
  return teamsOf(meta.me).map((t) => meta.pipelines.find((p) => p.team_id === t)).find(Boolean)
    ?? meta.pipelines.find((p) => p.id === meta.me.deal_pipelines?.[0])
    ?? meta.pipelines[0];
}
// Quién ve un pipeline (misma regla que el servidor): sin equipos, todos; si no, sus equipos y los administradores.
export function userTeams(u: User) {
  let extra: number[] = [];
  try { extra = JSON.parse(u.extra_teams ?? '[]'); } catch { /* sin equipos extra */ }
  return new Set([u.team_id, ...extra].filter((t): t is number => t != null).map(Number));
}
export function canSeePipeline(u: User, p: Pipeline) {
  const teams = p.config.visible_teams ?? [];
  if (u.role === 'admin' || !teams.length) return true;
  const mine = userTeams(u);
  return teams.some((t) => mine.has(Number(t)));
}
// Lo que falta completar para pasar un negocio a una etapa.
// Un dato obligatorio falta si está vacío; el valor del negocio, también si es $0 (la misma regla que el servidor).
export const faltaDato = (k: string, v: unknown) => v == null || v === '' || (k === 'amount' && !(Number(v) > 0));
export function missingFor(stage: Stage, props: Record<string, unknown>) {
  return (stage.config?.required_props ?? []).filter((k) => faltaDato(k, props[k]));
}
export const userOf = (meta: Meta, id: unknown) => (id == null || id === '' ? undefined : meta.users.find((u) => u.id === Number(id)));
export const userName = (meta: Meta, id: unknown) => userOf(meta, id)?.name ?? (id ? `Usuario ${id}` : 'Sin asignar');

// ---------- Formato ----------

const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const moneyUsd = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('es-AR');
// Montos: desde un millón, abreviados («$ 23,4 M»; desde 100 millones sin decimales: «$ 190 M», «$ 4.762 M»).
// fmtMoneyExact da la cifra completa (para el título al pasar el mouse y donde haga falta exacto).
const millones1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const millones0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
export const fmtMoneyExact = (v: unknown, currency?: string) => (v == null || v === '' ? '' : (currency === 'USD' ? moneyUsd : money).format(Number(v)));
export const fmtMoney = (v: unknown, currency?: string) => {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) < 1_000_000) return fmtMoneyExact(v, currency);
  const m = Math.abs(n) / 1_000_000;
  return `${n < 0 ? '-' : ''}${currency === 'USD' ? 'US$' : '$'}\u00a0${(m >= 100 ? millones0 : millones1).format(m)}\u00a0M`;
};
export const fmtNumber = (v: unknown) => (v == null || v === '' ? '' : number.format(Number(v)));
export function fmtDate(v: unknown, withTime = false) {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
// `corto` («hace 27 min», «hace 3 h», «hace 6 d»): para las tarjetas del tablero, donde no entra el texto largo.
export function fmtRelative(v: unknown, corto = false) {
  if (!v) return '';
  const d = new Date(String(v));
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: corto ? 'short' : 'long' });
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  return fmtDate(v);
}
// Solo links http(s): un valor cargado por una integración no puede ejecutar código al hacer clic.
export function safeUrl(v: unknown) {
  const s = String(v ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
  return undefined;
}

// Link para abrir el chat de WhatsApp con un teléfono. Los de Argentina van como los usa WhatsApp, 549 + característica +
// número, aunque estén cargados a mano («011 15 4567-8901», «+54 11 4567 8901», «3465 53-6693»…); los de otro país,
// tal cual si traen el «+». Sin número que alcance, nada.
export function whatsappUrl(v: unknown) {
  const s = String(v ?? '').trim();
  let d = s.replace(/\D/g, '');
  const intl = s.startsWith('+') || d.startsWith('00');
  d = d.replace(/^00/, '');
  if (d.length < 8) return undefined;
  if (d.startsWith('54') && (intl || d.length >= 12)) d = d.slice(2).replace(/^9/, '');
  else if (intl || (!d.startsWith('0') && d.length !== 10 && !(d.length === 12 && /^\d{2,4}15/.test(d)))) return `https://wa.me/${d}`;
  d = d.replace(/^0/, '');
  // El «15» de los celulares va después de la característica (2 a 4 dígitos) y WhatsApp no lo usa.
  if (d.length === 12) { const i = [2, 3, 4].find((k) => d.slice(k, k + 2) === '15'); if (i != null) d = d.slice(0, i) + d.slice(i + 2); }
  return d.length >= 10 ? `https://wa.me/549${d.slice(-10)}` : undefined;
}

// Una foto achicada en el navegador antes de subirla (remitos): el lado mayor hasta `lado` píxeles, en JPEG, y que no pase
// de `max` bytes (una fila de la base no puede pasar de 2 MB). Los PDF y las fotos chicas van como están.
export async function achicarImagen(file: File, lado = 2000, max = 1_800_000): Promise<File> {
  if (!file.type.startsWith('image/') || /heic|heif|gif/.test(file.type)) return file;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  const escala = Math.min(1, lado / Math.max(bmp.width, bmp.height));
  if (escala === 1 && file.size <= max) { bmp.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * escala);
  canvas.height = Math.round(bmp.height * escala);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  let blob: Blob | null = null;
  for (const q of [0.85, 0.75, 0.6, 0.5]) {
    blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= max) break;
  }
  return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

export function initials(name: string) {
  return name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
}

export function formatValue(meta: Meta, type: ObjectType, name: string, value: unknown, props?: Record<string, any>): string {
  if (value == null || value === '') return '';
  if (name === 'dealstage') return stageOf(meta, String(value))?.stage.label ?? String(value);
  if (name === 'pipeline') return meta.pipelines.find((p) => p.id === value)?.label ?? String(value);
  const p = propOf(meta, type, name);
  if (!p) return String(value);
  switch (p.type) {
    case 'owner': return userName(meta, value);
    case 'currency': return fmtMoney(value, name.endsWith('_usd') ? 'USD' : props?.deal_currency_code ?? props?.hs_currency_code);
    case 'number': return fmtNumber(value);
    case 'date': return fmtDate(value);
    case 'datetime': return fmtDate(value, true);
    case 'bool': return value === 'true' ? 'Sí' : value === 'false' ? 'No' : String(value);
    case 'enum': return p.options.find((o) => o.value === value)?.label ?? String(value);
    case 'multienum': return String(value).split(';').map((v) => p.options.find((o) => o.value === v)?.label ?? v).join(', ');
    default: return String(value);
  }
}

// ---------- Avisos ----------

const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; err: boolean } | null>(null);
  const timer = useRef<number>();
  const show = useCallback((msg: string, err = false) => {
    setT({ msg, err });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), err ? 6000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast${t.err ? ' err' : ''}`} role={t.err ? 'alert' : 'status'}>
          <span className="toast-ic" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={t.err ? 'M5 5l6 6M11 5l-6 6' : 'M4 8.5 6.8 11 12 5'} /></svg></span>
          <span className="toast-msg">{t.msg}</span>
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// Lo último que trajo cada pedido al servidor (tableros y listas), para mostrarlo al toque al volver a una pestaña o vista
// mientras se actualiza (como HubSpot). Se guarda solo en la memoria de la página; las últimas 40 respuestas.
const memoria = new Map<string, unknown>();
export function olvidarMemoria(prefijo = '') { for (const k of [...memoria.keys()]) if (k.startsWith(prefijo)) memoria.delete(k); }
function recordar(key: string, data: unknown) {
  memoria.delete(key);
  memoria.set(key, data);
  if (memoria.size > 40) memoria.delete(memoria.keys().next().value as string);
}

// Trae algo para tenerlo en la memoria antes de que se lo pida (las otras pestañas de la lista). Sin errores a la vista.
export function precargar(path: string) {
  if (memoria.has(path)) return Promise.resolve();
  return http('GET', path).then((d) => recordar(path, d), () => undefined);
}

// Datos de un pedido al servidor. Con `key` (la dirección del pedido) usa la memoria: si ya se vio, lo muestra enseguida
// y lo actualiza atrás. `fresh` dice si lo que se ve corresponde a lo pedido ahora (si no, es lo de antes, esperando).
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], key?: string) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; key?: string }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => { if (key) recordar(key, data); if (alive) setState({ data, loading: false, key }); })
      .catch((e) => alive && setState((s) => ({ ...s, error: (e as Error).message, loading: false, key })));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const otro = key !== undefined && state.key !== key;
  const guardado = otro && memoria.has(key) ? (memoria.get(key) as T) : undefined;
  return {
    ...state, data: guardado ?? state.data, loading: state.loading || otro,
    fresh: !otro || guardado !== undefined, reload: () => setTick((x) => x + 1),
  };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ---------- Íconos (trazo simple, 24x24) ----------

const paths: Record<string, string> = {
  bag: 'M5 8h14l-1.2 12.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9zM9 8V6.5a3 3 0 0 1 6 0V8',
  briefcase: 'M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM8 8V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V8M3 13h18',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  contact: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
  company: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M3 21h18',
  deal: 'M3 7h18v12H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18',
  order: 'M6 2l1.5 4h9L18 2M4 6h16l-1.5 14h-13zM9 11h6',
  task: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  note: 'M4 4h12l4 4v12H4zM8 10h8M8 14h8M8 18h5',
  email: 'M3 5h18v14H3zM3 6l9 7 9-7',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  meeting: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  whatsapp: 'M4 20l1.3-3.9A8 8 0 1 1 8 19zM9 9c0 3 2 6 6 6l1-1.5-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  columns: 'M4 4h6v16H4zM14 4h6v16h-6z',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  menu: 'M4 6h16M4 12h16M4 18h16',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  merge: 'M6 3v6a6 6 0 0 0 6 6h6M18 15l-3-3M18 15l-3 3M6 21v-4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  receipt: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9.5 8h5M9.5 12h5M9.5 16h3',
  printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  truck: 'M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7M6.5 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM17 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  boceto: 'M4 20l4-1L19 8a2.1 2.1 0 0 0-3-3L5 16zM14 7l3 3M4 20h6',
  chevron: 'M15 18l-6-6 6-6',
  down: 'M6 9l6 6 6-6',
  updown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  theme: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 3v18M12 3a9 9 0 0 1 0 18',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  chat: 'M4 5h16v11H10l-5 4v-4H4z',
  spark: 'M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  clip: 'M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  reply: 'M9 15l-5-5 5-5M4 10h10a6 6 0 0 1 6 6v3',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7',
  pin: 'M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
};
export function Icon({ name, size }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      width={size} height={size} aria-hidden="true">
      <path d={paths[name] ?? paths.note} />
    </svg>
  );
}

export const ACTIVITY_LABEL: Record<Activity['type'], string> = {
  note: 'Nota', email: 'Email', call: 'Llamada', meeting: 'Reunión', task: 'Tarea', whatsapp: 'WhatsApp',
};

// Chips de las etiquetas de un registro, con su color.
export function TagChips({ meta, ids, small }: { meta: Meta; ids?: number[]; small?: boolean }) {
  const tags = (ids ?? []).map((id) => meta.tags?.find((t) => t.id === id)).filter(Boolean) as Tag[];
  if (!tags.length) return null;
  return (
    <span className={`tag-chips${small ? ' small' : ''}`}>
      {tags.map((t) => <span key={t.id} className="tag-chip" style={{ '--tag': t.color } as CSSProperties} title={t.description || t.name}>{t.name}</span>)}
    </span>
  );
}

// Unidades de negocio: el negocio, por el equipo de su pipeline; el pedido, por la unidad de ClickUp; contactos, empresas y
// tareas, por el equipo de su propietario. Cada una con su ícono y su color (filtro rápido, columna y etiquetas).
export const UNIDADES = [
  // El color de cada una está en styles.css (.unidad.u-shop, .u-corporate, .u-noestres), con su versión oscura y de alto contraste.
  { key: 'shop', label: 'Formas Shop', team: 57132078, icon: 'bag' },
  { key: 'corporate', label: 'Corporate', team: 58079782, icon: 'briefcase' },
  { key: 'noestres', label: 'NoEstres', team: 57393663, icon: 'smile' },
] as const;
export type UnidadKey = (typeof UNIDADES)[number]['key'];
const PEDIDO_UNIDAD: Record<string, UnidadKey> = { 'FORMAS SHOP': 'shop', CORPORATE: 'corporate', 'NO ESTRÉS': 'noestres', 'NO ESTRES': 'noestres', NOESTRES: 'noestres' };
export const unidadDeEquipo = (team: number | null | undefined) => UNIDADES.find((u) => u.team === Number(team))?.key;
export function teamsOf(u: User | undefined): number[] {
  if (!u) return [];
  let extra: number[] = [];
  try { extra = JSON.parse(u.extra_teams ?? '[]').map(Number); } catch { /* sin equipos extra */ }
  return [u.team_id, ...extra].filter((t): t is number => t != null);
}
export function unidadesDe(meta: Meta, type: ObjectType | 'task', props: Record<string, any>): UnidadKey[] {
  if (type === 'deal') { const k = unidadDeEquipo(meta.pipelines.find((p) => p.id === props.pipeline)?.team_id); return k ? [k] : []; }
  if (type === 'order') { const k = PEDIDO_UNIDAD[String(props.unidad_de_negocio ?? '').toUpperCase()]; return k ? [k] : []; }
  const owner = meta.users.find((u) => u.id === Number(props.owner_id));
  return [...new Set(teamsOf(owner).map(unidadDeEquipo).filter((k): k is UnidadKey => !!k))];
}
