import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from 'react';

// Desplegable del Design System de Formas (SelectField): el campo con el chevron y una lista propia, con el mismo aspecto
// en todos los navegadores y en los tres temas, en lugar de la lista nativa del sistema operativo.
// Se usa igual que un <select>: mismos <option> y <optgroup> adentro, y `onChange` recibe { target: { value } }.
// Con más de 10 opciones aparece un buscador arriba de la lista (en el celular no toma el foco solo, para no tapar la lista con el teclado).

type ChangeEvent = { target: { value: string } };
interface Opt { value: string; label: ReactNode; text: string; disabled: boolean; group?: string }

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function textOf(n: ReactNode): string {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return '';
}

function collect(children: ReactNode, out: Opt[], group?: string) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: unknown; children?: ReactNode; disabled?: boolean; label?: ReactNode }>;
    if (el.type === 'option') {
      const text = textOf(el.props.children);
      out.push({ value: el.props.value != null ? String(el.props.value) : text, label: el.props.children, text, disabled: !!el.props.disabled, group });
    } else if (el.type === 'optgroup') collect(el.props.children, out, textOf(el.props.label));
    else if (el.type === Fragment) collect(el.props.children, out, group);
  });
}

// Antes de ubicarla: invisible pero enfocable (con visibility: hidden el buscador no tomaba el foco).
const HIDDEN: CSSProperties = { position: 'fixed', top: 0, left: 0, opacity: 0, pointerEvents: 'none' };

// Posición de una lista flotante pegada a su botón: abajo si entra, si no arriba; nunca se sale de la pantalla. Es `fixed`,
// así no la corta el desplazamiento de una tabla, un panel lateral o un modal. Sigue al botón si se desplaza la página.
export function useFloating(anchor: RefObject<HTMLElement | null>, pop: RefObject<HTMLElement | null>, open: boolean, onLost: () => void, maxH = 320) {
  const [style, setStyle] = useState<CSSProperties>(HIDDEN);
  const place = () => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { onLost(); return; }
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(maxH, pop.current?.scrollHeight ?? maxH);
    const up = below < want && above > below;
    const w = pop.current?.offsetWidth ?? r.width;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    setStyle({
      position: 'fixed', left, minWidth: r.width, maxWidth: Math.min(440, innerWidth - 16),
      maxHeight: Math.max(120, Math.min(maxH, up ? above : below)),
      ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  };
  useLayoutEffect(() => { if (open) place(); else setStyle(HIDDEN); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', place); };
  }, [open]);
  return { style, place };
}

export function Select({ value, onChange, children, className = 'input', style, disabled, autoFocus, title, id, placeholder = '—', ...aria }: {
  value?: string | number | null; onChange?: (e: ChangeEvent) => void; children?: ReactNode; className?: string; style?: CSSProperties;
  disabled?: boolean; autoFocus?: boolean; title?: string; id?: string; placeholder?: string; 'aria-label'?: string;
}) {
  const opts = useMemo(() => { const o: Opt[] = []; collect(children, o); return o; }, [children]);
  const v = value == null ? '' : String(value);
  // Como el <select> nativo: si el valor no está entre las opciones, se ve la primera.
  const cur = opts.find((o) => o.value === v) ?? opts[0];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ s: '', t: 0 });
  const listId = useId();
  const withSearch = opts.length > 10;
  const close = (focus = true) => { setOpen(false); setQ(''); if (focus) btn.current?.focus(); };
  const { style: popStyle, place } = useFloating(btn, pop, open, () => close(false));

  const shown = useMemo(() => {
    const n = norm(q.trim());
    return opts.map((o, i) => ({ o, i })).filter(({ o }) => !n || norm(o.text).includes(n));
  }, [opts, q]);

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, opts.findIndex((o) => o.value === cur?.value)));
    setOpen(true);
  };
  useEffect(() => { if (!open || !withSearch || matchMedia('(pointer: coarse)').matches) return; const r = requestAnimationFrame(() => search.current?.focus()); return () => cancelAnimationFrame(r); }, [open]);
  // Si el desplegable aparece ya enfocado (al editar una celda o una propiedad), la lista se abre sola: un clic menos.
  useEffect(() => { if (autoFocus && !disabled) openList(); }, []);
  // Por si el panel que lo contiene todavía se estaba acomodando al abrir.
  useEffect(() => { if (!open) return; const t = window.setTimeout(place, 260); return () => window.clearTimeout(t); }, [open]);
  useLayoutEffect(() => { if (open) place(); }, [open, shown.length]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) close(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  // La opción activa siempre a la vista (al abrir, la elegida queda en el medio). Se mueve solo la lista, nunca la página.
  const centered = useRef(false);
  useLayoutEffect(() => {
    if (!open) { centered.current = false; return; }
    const list = pop.current?.querySelector<HTMLElement>('.select-list');
    const el = list?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!list || !el || !popStyle.maxHeight) return;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if (!centered.current) { list.scrollTop = Math.max(0, top - (list.clientHeight - el.offsetHeight) / 2); centered.current = true; }
    else if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }, [active, open, popStyle.maxHeight]);
  useEffect(() => { if (open && !shown.some((s) => s.i === active)) setActive(shown.find((s) => !s.o.disabled)?.i ?? -1); }, [shown]);

  const pick = (o: Opt) => {
    if (o.disabled) return;
    close();
    if (o.value !== v) onChange?.({ target: { value: o.value } });
  };
  const move = (d: number) => {
    const list = shown.filter((s) => !s.o.disabled);
    if (!list.length) return;
    const at = list.findIndex((s) => s.i === active);
    const next = d === Infinity ? list.length - 1 : d === -Infinity ? 0 : Math.max(0, Math.min(list.length - 1, (at < 0 ? -1 : at) + d));
    setActive(list[next].i);
  };
  const typeAhead = (ch: string) => {
    const now = Date.now();
    typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : '') + norm(ch), t: now };
    const hit = opts.findIndex((o) => !o.disabled && norm(o.text).startsWith(typed.current.s));
    return hit;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Como el <select> nativo: tipear con la lista cerrada elige la primera opción que empieza así.
        const hit = typeAhead(e.key);
        if (hit >= 0 && opts[hit].value !== v) onChange?.({ target: { value: opts[hit].value } });
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'PageDown': e.preventDefault(); move(8); break;
      case 'PageUp': e.preventDefault(); move(-8); break;
      case 'Home': if (!withSearch) { e.preventDefault(); move(-Infinity); } break;
      case 'End': if (!withSearch) { e.preventDefault(); move(Infinity); } break;
      case 'Enter': { e.preventDefault(); const o = opts[active]; if (o && shown.some((s) => s.i === active)) pick(o); break; }
      case 'Escape': e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); close(); break;
      case 'Tab': close(false); break;
      default:
        if (withSearch && e.target !== search.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Si el foco quedó en el campo, lo que se tipea va igual al buscador.
          e.preventDefault(); setQ((x) => x + e.key); search.current?.focus();
        } else if (!withSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const hit = typeAhead(e.key);
          if (hit >= 0) setActive(hit);
        }
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button type="button" ref={btn} id={id} className={`${className} select-like${cur ? '' : ' placeholder'}${open ? ' open' : ''}`} style={style}
        disabled={disabled} autoFocus={autoFocus} title={title ?? cur?.text} aria-label={aria['aria-label']}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !withSearch && active >= 0 ? `${listId}-${active}` : undefined}
        onClick={(e) => { e.preventDefault(); open ? close() : openList(); }} onKeyDown={onKey}>
        <span className="select-value">{cur ? cur.label : placeholder}</span>
      </button>
      {open && (
        <div ref={pop} className="select-pop" style={popStyle} onMouseDown={(e) => { if (e.target !== search.current) e.preventDefault(); }}>
          {withSearch && (
            <div className="select-search">
              <input ref={search} className="input sm" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-label="Buscar en la lista"
                aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} />
            </div>
          )}
          <div className="select-list" role="listbox" id={listId} aria-label={aria['aria-label']}>
            {shown.map(({ o, i }) => {
              const head = o.group !== lastGroup && o.group ? <div className="select-grp" role="presentation">{o.group}</div> : null;
              lastGroup = o.group;
              const on = o.value === cur?.value;
              return (
                <Fragment key={`${o.group ?? ''}\u0000${o.value}\u0000${i}`}>
                  {head}
                  <div id={`${listId}-${i}`} data-i={i} role="option" aria-selected={on} aria-disabled={o.disabled || undefined}
                    className={`select-opt${on ? ' on' : ''}${i === active ? ' act' : ''}${o.disabled ? ' off' : ''}`}
                    onMouseMove={() => { if (!o.disabled && active !== i) setActive(i); }}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); pick(o); }}>
                    <span className="select-text">{o.label === '' || o.label == null ? ' ' : o.label}</span>
                    {on && <svg className="select-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </div>
                </Fragment>
              );
            })}
            {!shown.length && <div className="select-empty">Sin resultados para «{q}»</div>}
          </div>
        </div>
      )}
    </>
  );
}
