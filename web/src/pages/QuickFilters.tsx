import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeta, propOf, UNIDADES, type Filter, type ObjectType } from '../lib';
import { UnidadBadge } from '../components';

// Filtros rápidos, como los de HubSpot: propietarios (varios a la vez) y fechas con rangos listos.
// Se guardan en la vista (`owners`, `dates`, `tags` y `unidades`) y se suman a los filtros avanzados en cada grupo.

type Preset = { key: string; label: string };
const PAST: Preset[] = [
  { key: 'today', label: 'Hoy' }, { key: 'week', label: 'Esta semana' }, { key: 'last7', label: 'Últimos 7 días' },
  { key: 'month', label: 'Este mes' }, { key: 'last_month', label: 'El mes pasado' }, { key: 'last30', label: 'Últimos 30 días' },
  { key: 'last90', label: 'Últimos 90 días' }, { key: 'year', label: 'Este año' },
];
export const DATE_CHIPS: Record<string, { label: string; presets: Preset[] }> = {
  createdate: { label: 'Fecha de creación', presets: PAST },
  notes_last_updated: {
    label: 'Última actividad',
    presets: [...PAST, { key: 'older30', label: 'Hace más de 30 días o nunca' }, { key: 'older90', label: 'Hace más de 90 días o nunca' }, { key: 'none', label: 'Nunca' }],
  },
  closedate: {
    label: 'Fecha de cierre',
    presets: [
      { key: 'overdue', label: 'Vencida (antes de hoy)' }, { key: 'week', label: 'Esta semana' }, { key: 'month', label: 'Este mes' },
      { key: 'next_month', label: 'El mes que viene' }, { key: 'next30', label: 'Próximos 30 días' }, { key: 'quarter', label: 'Este trimestre' },
      { key: 'last_month', label: 'El mes pasado' }, { key: 'none', label: 'Sin fecha' },
    ],
  },
};
export const dateChipsFor = (type: ObjectType) => (type === 'deal' ? ['createdate', 'notes_last_updated', 'closedate'] : ['createdate', 'notes_last_updated']);

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// El rango se calcula cada vez (con la fecha de hoy), así «Este mes» de una vista guardada sigue siendo este mes.
export function presetFilter(prop: string, key: string): Filter | null {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const range = (from: Date, to: Date): Filter => ({ prop, op: 'between', value: ymd(from), high: `${ymd(to)}T23:59:59.999Z` });
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  switch (key) {
    case 'today': return range(today, today);
    case 'week': return range(monday, addDays(monday, 6));
    case 'last7': return range(addDays(today, -6), today);
    case 'month': return range(first, new Date(today.getFullYear(), today.getMonth() + 1, 0));
    case 'last_month': return range(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0));
    case 'next_month': return range(new Date(today.getFullYear(), today.getMonth() + 1, 1), new Date(today.getFullYear(), today.getMonth() + 2, 0));
    case 'last30': return range(addDays(today, -29), today);
    case 'last90': return range(addDays(today, -89), today);
    case 'next30': return range(today, addDays(today, 30));
    case 'year': return range(new Date(today.getFullYear(), 0, 1), new Date(today.getFullYear(), 11, 31));
    case 'quarter': { const q = Math.floor(today.getMonth() / 3) * 3; return range(new Date(today.getFullYear(), q, 1), new Date(today.getFullYear(), q + 3, 0)); }
    case 'overdue': return { prop, op: 'lt', value: ymd(today) };
    case 'older30': return { prop, op: 'before_days_ago', value: 30 };
    case 'older90': return { prop, op: 'before_days_ago', value: 90 };
    case 'none': return { prop, op: 'unknown' };
    default: return null;
  }
}

export function quickFilters(owners: string[] | undefined, dates: Record<string, string> | undefined, tags?: string[], unidades?: string[]): Filter[] {
  const out: Filter[] = [];
  if (unidades?.length) out.push({ prop: '__unidad', op: 'in', values: unidades });
  if (tags?.length) out.push({ prop: '__tag', op: 'in', values: tags });
  if (owners?.length) out.push(owners.length === 1 && owners[0] === 'none' ? { prop: 'owner_id', op: 'unknown' } : { prop: 'owner_id', op: 'in', values: owners });
  for (const [prop, key] of Object.entries(dates ?? {})) { const f = presetFilter(prop, key); if (f) out.push(f); }
  return out;
}

function Pop({ label, on, children }: { label: ReactNode; on: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="qf" ref={ref}>
      <button className={`btn qf-btn${on ? ' on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>{label}<span className="caret" aria-hidden="true">▾</span></button>
      {open && <div className="popover qf-pop" role="dialog">{children(() => setOpen(false))}</div>}
    </div>
  );
}

// Unidad de negocio (Formas Shop, Corporate, NoEstres): varias a la vez, con su ícono y color. Se usa también en Tareas.
export function UnidadFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const sel = UNIDADES.filter((u) => value.includes(u.key));
  return (
    <Pop label={sel.length ? <>Unidad{sel.map((u) => <UnidadBadge key={u.key} k={u.key} compact />)}</> : 'Unidad de negocio'} on={sel.length > 0}>
      {() => (
        <div className="stack" style={{ gap: 0 }}>
          {UNIDADES.map((u) => (
            <label key={u.key} className="opt"><input type="checkbox" checked={value.includes(u.key)}
              onChange={() => onChange(value.includes(u.key) ? value.filter((x) => x !== u.key) : [...value, u.key])} /><UnidadBadge k={u.key} /></label>
          ))}
          {value.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => onChange([])}>Cualquiera</button>}
        </div>
      )}
    </Pop>
  );
}

export function QuickFilterBar({ type, owners, dates, tags, unidades, onOwners, onDates, onTags, onUnidades, onClear, extra }: {
  type: ObjectType; owners: string[]; dates: Record<string, string>; tags: string[]; unidades: string[];
  onOwners: (o: string[]) => void; onDates: (d: Record<string, string>) => void; onTags: (t: string[]) => void; onUnidades: (u: string[]) => void; onClear: () => void; extra?: boolean;
}) {
  const { meta } = useMeta();
  const name = (v: string) => (v === 'me' ? 'Yo' : v === 'none' ? 'Sin asignar' : meta.users.find((u) => String(u.id) === v)?.name ?? v);
  const ownerLabel = owners.length ? `Propietario: ${owners.slice(0, 2).map(name).join(', ')}${owners.length > 2 ? ` +${owners.length - 2}` : ''}` : 'Propietario';
  const toggle = (v: string) => onOwners(owners.includes(v) ? owners.filter((x) => x !== v) : [...owners, v]);
  const any = owners.length > 0 || Object.keys(dates).length > 0 || tags.length > 0 || unidades.length > 0 || extra;
  const typeTags = meta.tags?.filter((t) => t.object_type === type) ?? [];
  const tagName = (v: string) => typeTags.find((t) => String(t.id) === v)?.name ?? v;
  return (
    <>
      <UnidadFilter value={unidades} onChange={onUnidades} />
      <Pop label={ownerLabel} on={owners.length > 0}>
        {() => (
          <div className="stack" style={{ gap: 0, maxHeight: 320, overflow: 'auto' }}>
            {[['me', 'Yo'], ['none', 'Sin asignar'], ...meta.users.filter((u) => u.active).map((u) => [String(u.id), u.name])].map(([v, l]) => (
              <label key={v} className="opt"><input type="checkbox" checked={owners.includes(v)} onChange={() => toggle(v)} />{l}</label>
            ))}
            {owners.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => onOwners([])}>Cualquiera</button>}
          </div>
        )}
      </Pop>
      {dateChipsFor(type).map((prop) => {
        const chip = DATE_CHIPS[prop];
        const cur = chip.presets.find((p) => p.key === dates[prop]);
        const label = propOf(meta, type, prop)?.label ?? chip.label;
        return (
          <Pop key={prop} label={cur ? `${label}: ${cur.label}` : label} on={!!cur}>
            {(close) => (
              <div className="stack" style={{ gap: 0 }}>
                {chip.presets.map((p) => (
                  <div key={p.key} className={`opt${cur?.key === p.key ? ' on' : ''}`} role="option" aria-selected={cur?.key === p.key}
                    onClick={() => { onDates({ ...dates, [prop]: p.key }); close(); }}>{p.label}</div>
                ))}
                {cur && <div className="opt" onClick={() => { const d = { ...dates }; delete d[prop]; onDates(d); close(); }}><b>Cualquiera</b></div>}
              </div>
            )}
          </Pop>
        );
      })}
      {typeTags.length > 0 && (
        <Pop label={tags.length ? `Etiqueta: ${tags.slice(0, 2).map(tagName).join(', ')}${tags.length > 2 ? ` +${tags.length - 2}` : ''}` : 'Etiqueta'} on={tags.length > 0}>
          {() => (
            <div className="stack" style={{ gap: 0 }}>
              {typeTags.map((t) => (
                <label key={t.id} className="opt"><input type="checkbox" checked={tags.includes(String(t.id))} onChange={() => onTags(tags.includes(String(t.id)) ? tags.filter((x) => x !== String(t.id)) : [...tags, String(t.id)])} />
                  <span className="tag-dot" style={{ background: t.color }} />{t.name}</label>
              ))}
            </div>
          )}
        </Pop>
      )}
      {any && <button className="btn ghost qf-clear" onClick={onClear}>Borrar todo</button>}
    </>
  );
}
