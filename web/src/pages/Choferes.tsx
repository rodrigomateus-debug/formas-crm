import { useState } from 'react';
import { http, useAsync, useToast, Icon, fmtDate } from '../lib';

// Choferes (pedido de Rodrigo del 16/11/2026): el acceso de cada chofer a su app (remitos y recorrido del día), a mano en
// la barra lateral del perfil Logística (los administradores lo tienen en Entregas → Choferes). Crear el código es un
// nombre y un clic, y los choferes del cronograma que todavía no tienen código aparecen para crearlo con un clic. El
// código de cada uno se ve en su fila con «Ver código» (la lista no trae los códigos: se piden de a uno).

interface Chofer { id: number; name: string; created_at: string; last_used_at: string | null; revoked: number; user_name: string; remitos: number; ultimo: string | null }
interface Acceso { link: string; codigo: string; app: string }
const lindo = (c: string) => `${c.slice(0, 4)} ${c.slice(4)}`;

export default function ChoferesPage() {
  return (
    <div className="content">
      <div className="page-head"><h1>Choferes</h1></div>
      <ChoferesPanel />
    </div>
  );
}

export function ChoferesPanel() {
  const toast = useToast();
  const res = useAsync(() => http<Chofer[]>('GET', '/choferes'), []);
  const sug = useAsync(() => http<{ nombres: string[] }>('GET', '/choferes/sugeridos').catch(() => ({ nombres: [] as string[] })), []);
  const [nombre, setNombre] = useState('');
  const [ocupado, setOcupado] = useState(false);
  // Los códigos que se están viendo, por chofer (el recién creado se abre solo).
  const [abiertos, setAbiertos] = useState<Record<number, Acceso>>({});
  const crear = async (n = nombre) => {
    if (n.trim().length < 2) return;
    setOcupado(true);
    try {
      const r = await http<Acceso & { id: number }>('POST', '/choferes', { name: n.trim() });
      setAbiertos((a) => ({ ...a, [r.id]: r })); setNombre(''); res.reload(); sug.reload();
      toast(`Código de ${n.trim()}: ${lindo(r.codigo)}`);
    } catch (err) { toast((err as Error).message, true); }
    setOcupado(false);
  };
  const ver = async (c: Chofer) => {
    if (abiertos[c.id]) { setAbiertos(({ [c.id]: _, ...a }) => a); return; }
    try { const r = await http<Acceso>('GET', `/choferes/${c.id}/link`); setAbiertos((a) => ({ ...a, [c.id]: r })); }
    catch (err) { toast((err as Error).message, true); }
  };
  const revocar = async (c: Chofer) => {
    if (!confirm(`¿Dar de baja el acceso de ${c.name}? Su código y su link dejan de andar: no puede ver su recorrido ni mandar remitos.`)) return;
    try { await http('DELETE', `/choferes/${c.id}`); res.reload(); sug.reload(); } catch (err) { toast((err as Error).message, true); }
  };
  const copiar = async (t: string, que: string) => { try { await navigator.clipboard.writeText(t); toast(`${que} copiado`); } catch { toast('No se pudo copiar: seleccionalo y copialo a mano.', true); } };
  const activos = (res.data ?? []).filter((c) => !c.revoked), bajas = (res.data ?? []).filter((c) => c.revoked);
  const sugeridos = sug.data?.nombres ?? [];

  return (
    <div className="stack ch-panel">
      <form className="ch-crear" onSubmit={(ev) => { ev.preventDefault(); void crear(); }}>
        <input className="input" placeholder="Nombre del chofer" value={nombre} onChange={(ev) => setNombre(ev.target.value)} aria-label="Nombre del chofer" />
        <button className="btn primary" disabled={ocupado || nombre.trim().length < 2}><Icon name="plus" size={16} />Crear código</button>
      </form>
      {sugeridos.length > 0 && (
        <div className="ch-sug">
          <span className="small muted">Del cronograma, todavía sin código:</span>
          {sugeridos.map((n) => <button key={n} type="button" className="chip" disabled={ocupado} onClick={() => crear(n)}><Icon name="plus" size={12} />{n}</button>)}
        </div>
      )}
      <p className="small muted ch-ayuda">El chofer abre la app en el celular y escribe su <b>código de 8 números</b> una sola vez (queda guardado), o entra con su link. Sirve solo para su recorrido y sus remitos. Para que vea su recorrido, tiene que llamarse igual que en el cronograma. Si cambia de celular o el código quedó en manos de otro, dalo de baja y creale uno nuevo.</p>

      <div className="panel ch-lista">
        {activos.map((c) => {
          const a = abiertos[c.id];
          return (
            <div key={c.id} className={`ch-fila${a ? ' abierta' : ''}`}>
              <div className="ch-cab">
                <span className="ch-ic" aria-hidden="true"><Icon name="volante" size={18} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{c.name}</b>
                  <div className="small muted">{c.last_used_at ? `Usó la app ${fmtDate(c.last_used_at, true)}` : 'Todavía no entró a la app'} · {c.remitos} remito{c.remitos === 1 ? '' : 's'}{c.ultimo ? `, el último ${fmtDate(c.ultimo, true)}` : ''}</div>
                </div>
                <button className="btn sm" onClick={() => ver(c)} aria-expanded={!!a}>{a ? 'Ocultar código' : 'Ver código'}</button>
                <button className="btn sm ghost" onClick={() => revocar(c)}>Dar de baja</button>
              </div>
              {a && (
                <div className="ch-acceso">
                  <div className="codigo-chofer num" aria-label={`Código ${a.codigo.split('').join(' ')}`}>{lindo(a.codigo)}</div>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => copiar(a.codigo, 'Código')}><Icon name="clip" size={14} />Copiar código</button>
                    <button className="btn sm" onClick={() => copiar(a.link, 'Link')}>Copiar link</button>
                    <a className="btn sm wa-link" href={`https://wa.me/?text=${encodeURIComponent(`Para la app de remitos de Formas abrí este link: ${a.link}\nO entrá a ${a.app} y escribí tu código: ${lindo(a.codigo)}`)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14} />Mandar por WhatsApp</a>
                  </div>
                  <span className="small muted">Que abra <b>{a.app.replace(/^https?:\/\//, '')}</b> y escriba el código (o que toque el link).</span>
                </div>
              )}
            </div>
          );
        })}
        {!activos.length && <div className="panel-body muted small">{res.loading ? 'Cargando…' : 'Todavía no hay choferes con código.'}</div>}
      </div>
      {bajas.length > 0 && (
        <details className="ch-bajas">
          <summary className="small muted">{bajas.length} dado{bajas.length === 1 ? '' : 's'} de baja</summary>
          <div className="panel">
            {bajas.map((c) => <div key={c.id} className="assoc-item muted"><div className="grow">{c.name}</div><span className="small">{c.remitos} remitos</span></div>)}
          </div>
        </details>
      )}
    </div>
  );
}
