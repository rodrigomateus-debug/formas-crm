import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './lib';
import { useFloating } from './Select';

// Selector de fecha del CRM (pedido de Rodrigo del 12/11/2026, Producción). En lugar del campo de fecha del navegador
// (que ensanchaba la columna, cambiaba el formato a 10/11/2026 y traía un calendario con otro estilo en cada navegador):
// la celda queda igual y el calendario se abre flotando, con atajos (hoy, mañana, en una semana, quitar). Elegir un día
// lo guarda y cierra. Teclado: flechas para moverse, Re Pág / Av Pág para cambiar de mes, Enter para elegir, Esc para salir.

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];

// AAAA-MM-DD ↔ fecha local (al mediodía, para que el huso no la corra de día).
export const isoDia = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const deIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const sumar = (d: Date, dias: number) => { const x = new Date(d); x.setDate(x.getDate() + dias); return x; };
const hoyDia = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };

export function SelectorFecha({ valor, onElegir, label, children, className, title }: {
  valor: string | null; onElegir: (v: string) => void; label: string; children: React.ReactNode; className?: string; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const cerrar = (volverAlBoton = true) => { setOpen(false); if (volverAlBoton) btn.current?.focus(); };
  const { style } = useFloating(btn, pop, open, () => setOpen(false), 420);
  useEffect(() => {
    if (!open) return;
    const fuera = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [open]);
  const elegir = (v: string) => { cerrar(); if (v !== (valor ?? '')) onElegir(v); };
  return (
    <>
      <button ref={btn} type="button" className={className} title={title} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        {children}
      </button>
      {open && createPortal(
        <div ref={pop} className="popover cal-pop" role="dialog" aria-label={label} style={{ ...style, minWidth: 0, maxHeight: 'none' }}
          onMouseDown={(e) => e.stopPropagation()}>
          <Calendario valor={valor} onElegir={elegir} onCerrar={() => cerrar()} />
        </div>,
        document.body,
      )}
    </>
  );
}

function Calendario({ valor, onElegir, onCerrar }: { valor: string | null; onElegir: (v: string) => void; onCerrar: () => void }) {
  const hoy = useMemo(hoyDia, []);
  const [foco, setFoco] = useState<Date>(() => (valor ? deIso(valor) : hoy));
  const mes = new Date(foco.getFullYear(), foco.getMonth(), 1, 12);
  // Seis semanas desde el lunes de la semana del 1.
  const inicio = sumar(mes, -((mes.getDay() + 6) % 7));
  const dias = Array.from({ length: 42 }, (_, i) => sumar(inicio, i));
  const grilla = useRef<HTMLDivElement>(null);
  const fIso = isoDia(foco);
  useEffect(() => { grilla.current?.querySelector<HTMLButtonElement>(`[data-dia="${fIso}"]`)?.focus(); }, [fIso]);
  const mover = (d: number) => setFoco((f) => sumar(f, d));
  const cambiarMes = (d: number) => setFoco((f) => {
    const x = new Date(f.getFullYear(), f.getMonth() + d, 1, 12);
    x.setDate(Math.min(f.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
    return x;
  });
  const tecla = (e: React.KeyboardEvent) => {
    const k: Record<string, () => void> = {
      ArrowLeft: () => mover(-1), ArrowRight: () => mover(1), ArrowUp: () => mover(-7), ArrowDown: () => mover(7),
      PageUp: () => cambiarMes(-1), PageDown: () => cambiarMes(1), Home: () => mover(-((foco.getDay() + 6) % 7)), End: () => mover(6 - ((foco.getDay() + 6) % 7)),
      Escape: onCerrar,
    };
    if (k[e.key]) { e.preventDefault(); e.stopPropagation(); k[e.key](); }
  };
  const atajos: Array<[string, Date]> = [['Hoy', hoy], ['Mañana', sumar(hoy, 1)], ['En una semana', sumar(hoy, 7)]];
  return (
    <div className="cal" onKeyDown={tecla}>
      <div className="cal-head">
        <button type="button" className="btn ghost sm icon" onClick={() => cambiarMes(-1)} aria-label="Mes anterior"><Icon name="chevron" size={16} /></button>
        <b className="cal-mes" aria-live="polite">{MESES[mes.getMonth()]} {mes.getFullYear()}</b>
        <button type="button" className="btn ghost sm icon cal-sig" onClick={() => cambiarMes(1)} aria-label="Mes siguiente"><Icon name="chevron" size={16} /></button>
      </div>
      <div className="cal-grid" role="grid" ref={grilla}>
        {DIAS.map((d) => <span key={d} className="cal-dow" role="columnheader">{d}</span>)}
        {dias.map((d) => {
          const iso = isoDia(d);
          const otro = d.getMonth() !== mes.getMonth();
          const cls = ['cal-dia', otro && 'otro', iso === isoDia(hoy) && 'hoy', iso === valor && 'sel', d.getDay() % 6 === 0 && 'finde'].filter(Boolean).join(' ');
          return (
            <button key={iso} type="button" role="gridcell" data-dia={iso} className={cls} tabIndex={iso === fIso ? 0 : -1} aria-selected={iso === valor}
              aria-label={d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              onClick={() => onElegir(iso)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onElegir(iso); } }}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="cal-atajos">
        {atajos.map(([l, d]) => <button key={l} type="button" className="chip" onClick={() => onElegir(isoDia(d))}>{l}</button>)}
        {valor && <button type="button" className="btn ghost sm cal-quitar" onClick={() => onElegir('')}>Quitar fecha</button>}
      </div>
    </div>
  );
}
