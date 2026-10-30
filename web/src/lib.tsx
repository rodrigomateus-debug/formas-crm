import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

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
export interface User { id: number; email: string; name: string; role: string; team_id: number | null; extra_teams?: string; active: number }
export interface Meta { me: User & { deal_pipelines?: string[] }; properties: Property[]; pipelines: Pipeline[]; users: User[]; teams: Array<{ id: number; name: string }> }
export interface CrmRecord { id: number; type: ObjectType; name: string; props: Record<string, any>; created_at: string; updated_at: string; archived: boolean }
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

// ---------- HTTP ----------

export async function http<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
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
// Pipeline con el que arranca Negocios: el de su equipo; si no tiene, donde tiene más negocios; si no, el primero.
export function defaultPipeline(meta: Meta) {
  return meta.pipelines.find((p) => p.team_id != null && p.team_id === meta.me.team_id)
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
export function missingFor(stage: Stage, props: Record<string, unknown>) {
  return (stage.config?.required_props ?? []).filter((k) => props[k] == null || props[k] === '');
}
export const userName = (meta: Meta, id: unknown) => meta.users.find((u) => u.id === Number(id))?.name ?? (id ? `Usuario ${id}` : 'Sin asignar');

// ---------- Formato ----------

const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const moneyUsd = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('es-AR');
export const fmtMoney = (v: unknown, currency?: string) => (v == null || v === '' ? '' : (currency === 'USD' ? moneyUsd : money).format(Number(v)));
export const fmtNumber = (v: unknown) => (v == null || v === '' ? '' : number.format(Number(v)));
export function fmtDate(v: unknown, withTime = false) {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
export function fmtRelative(v: unknown) {
  if (!v) return '';
  const d = new Date(String(v));
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
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
    case 'currency': return fmtMoney(value, props?.deal_currency_code ?? props?.hs_currency_code);
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
      {t && <div className={`toast${t.err ? ' err' : ''}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => alive && setState({ data, loading: false })).catch((e) => alive && setState({ error: (e as Error).message, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ---------- Íconos (trazo simple, 24x24) ----------

const paths: Record<string, string> = {
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
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
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
