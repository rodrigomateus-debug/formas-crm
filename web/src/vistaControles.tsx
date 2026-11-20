import { useEffect, useRef, useState } from 'react';
import { Icon } from './lib';

// Los controles de la fila de vista (.toolbar.vista), iguales en todos los módulos (pedido de Rodrigo del 20/11/2026): el
// mismo botón para colapsar (productos, columnas vacías) y el mismo selector de columnas. El orden en la fila es siempre:
// Agrupar por · Ordenar · Colapsar productos · Colapsar vacías · Tarjeta · Columnas (y a la derecha, los totales).

// Un botón que se prende y se apaga: «Colapsar productos», «Colapsar vacías». Prendido, con el borde y fondo de acento,
// como un filtro en uso.
export function BotonColapsar({ on, onChange, label, title, icon = 'down' }: {
  on: boolean; onChange?: (v: boolean) => void; label: string; title?: string; icon?: string;
}) {
  if (!onChange) return null;
  return (
    <button type="button" className={`btn qf-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onChange(!on)} title={title}>
      <Icon name={icon} size={14} />{label}
    </button>
  );
}

// Agregar o sacar columnas de una tabla: las que no se pueden sacar (`fijas`) no se listan. El menú se abre hacia la
// derecha del botón (el botón está a la izquierda de la fila de vista).
export function ElegirColumnas({ columnas, ocultas, onChange, fijas = [] }: {
  columnas: Array<[string, string]>; ocultas: string[]; onChange: (ocultas: string[]) => void; fijas?: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const elegibles = columnas.filter(([k]) => !fijas.includes(k));
  const n = elegibles.filter(([k]) => !ocultas.includes(k)).length;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`btn qf-btn${ocultas.length ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Agregar o sacar columnas de la tabla">
        <Icon name="columns" size={14} />Columnas{ocultas.length ? ` (${n}/${elegibles.length})` : ''}
      </button>
      {open && (
        <div className="popover" style={{ left: 0, top: 36, minWidth: 230, maxHeight: 360, overflow: 'auto' }}>
          <div className="grp">Columnas</div>
          {elegibles.map(([k, l]) => (
            <label key={k} className="opt small">
              <input type="checkbox" checked={!ocultas.includes(k)} onChange={() => onChange(ocultas.includes(k) ? ocultas.filter((x) => x !== k) : [...ocultas, k])} />{l}
            </label>
          ))}
          {ocultas.length > 0 && <button type="button" className="btn sm ghost" style={{ margin: '4px 8px' }} onClick={() => onChange([])}>Mostrar todas</button>}
        </div>
      )}
    </div>
  );
}
