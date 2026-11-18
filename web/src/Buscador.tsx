import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { http, qs, useMeta, useDebounced, recordUrl, OBJECTS, Icon, esOperaciones, type CrmRecord, type ObjectType } from './lib';
import { Avatar, UserChip } from './components';

// El buscador de arriba (Ctrl+K), en el escritorio y en la versión celular. Va aparte de App.tsx para que el celular no
// tenga que bajar todo el escritorio para usarlo.

// En el buscador se encuentra todo; los que no son clientes llevan su marca (tipo de relación, relacion.ts).
// En el perfil Ventas, los contactos y empresas de otra vendedora vienen marcados «ajeno» (solo el nombre y de quién es).
type Encontrado = CrmRecord & { ajeno?: boolean };
const RELACION_MARCA: Record<string, string> = { proveedor: 'Proveedor', equipo: 'Equipo Formas', otro: 'Otro' };

export function GlobalSearch({ corto }: { corto?: boolean }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Record<ObjectType, CrmRecord[]> | null>(null);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dq.trim().length < 2) { setRes(null); return; }
    http<Record<ObjectType, CrmRecord[]>>('GET', `/search${qs({ q: dq })}`).then(setRes).catch(() => {});
  }, [dq]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, []);
  const go = (t: ObjectType, id: number) => { setOpen(false); setQ(''); navigate(recordUrl(t, id)); };
  const all = res ? (Object.entries(res) as Array<[ObjectType, Encontrado[]]>).filter(([, l]) => l.length) : [];
  const primero = all.flatMap(([t, l]) => l.filter((r) => !r.ajeno).map((r) => [t, r.id] as const))[0];
  return (
    <div className="gsearch" ref={ref}>
      <div className="search"><Icon name="search" />
        <input ref={input} className="input" placeholder={corto ? 'Buscar clientes, negocios…' : esOperaciones(useMeta().meta.me) ? 'Buscar pedidos, clientes, proveedores… (Ctrl+K)' : 'Buscar contactos, empresas, negocios… (Ctrl+K)'} value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && primero) go(primero[0], primero[1]); }} />
      </div>
      {open && res && (
        <div className="popover">
          {!all.length && <div className="opt muted">Sin resultados para «{dq}»</div>}
          {all.map(([t, list]) => (
            <div key={t}>
              <div className="grp">{OBJECTS[t].plural}</div>
              {list.map((r) => r.ajeno ? (
                // Perfil Ventas: ya existe, pero es de otra vendedora. No se abre; sirve para no cargarlo de nuevo.
                <div key={r.id} className="opt ajeno" aria-disabled="true" title="Ya existe y es de otra vendedora: pedile a un administrador que te lo pase.">
                  <Avatar name={r.name} type={t} />
                  <div className="grow"><div className="ellipsis">{r.name}</div>
                    <div className="small muted ellipsis row" style={{ gap: 4 }}>Ya existe · es de <UserChip id={r.props.owner_id} size="xs" /></div></div>
                </div>
              ) : (
                <div key={r.id} className="opt" onClick={() => go(t, r.id)}>
                  <Avatar name={r.name} type={t} />
                  <div className="grow"><div className="ellipsis">{r.name}{RELACION_MARCA[String(r.props.tipo_de_relacion ?? '')] && <span className="tag" style={{ marginLeft: 6 }}>{RELACION_MARCA[String(r.props.tipo_de_relacion)]}</span>}</div>
                    <div className="small muted ellipsis">{r.props.email || r.props.domain || r.props.company || ''}</div></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
