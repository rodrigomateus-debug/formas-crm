import { useMemo, useState } from 'react';
import { http, useMeta, useToast, Icon, PROFILE_LABEL, userOf } from './lib';
import { Avatar, Modal, UserAvatar } from './components';

// Compartir el pedido (pedido de Rodrigo del 13/11/2026; src/worker/compartidos.ts): el propietario es uno solo, pero el
// pedido se comparte con más personas —el backoffice de la vendedora, por ejemplo— para que lo vean aunque no sea suyo,
// sigan su conversación y les lleguen sus avisos (cambios de boceto, logo, dirección o fecha de entrega).
export function CompartidoCon({ orderId, ownerId, compartidos, onChange }: { orderId: number; ownerId: unknown; compartidos: number[]; onChange: () => void }) {
  const { meta } = useMeta();
  const [abierto, setAbierto] = useState(false);
  const puede = meta.me.role !== 'viewer' && !meta.real_user;
  if (!compartidos.length && !puede) return null;
  const nombres = compartidos.map((id) => userOf(meta, id)?.name ?? `Usuario ${id}`);
  return (
    <span className="compartido-con">
      {compartidos.length > 0 && (
        <button type="button" className="compartido-gente" onClick={() => puede && setAbierto(true)} disabled={!puede}
          title={`Compartido con ${nombres.join(', ')}`} aria-label={`Compartido con ${nombres.join(', ')}`}>
          <span className="avatar-stack">{compartidos.slice(0, 4).map((id) => <UserAvatar key={id} id={id} size="xs" />)}</span>
          <span className="ellipsis">{compartidos.length === 1 ? nombres[0] : `${nombres[0].split(' ')[0]} y ${compartidos.length - 1} más`}</span>
        </button>
      )}
      {puede && (
        <button type="button" className="btn ghost sm" onClick={() => setAbierto(true)}
          title="Compartir el pedido con más personas (por ejemplo, tu backoffice): lo ven, siguen su conversación y les llegan sus avisos">
          <Icon name="users" size={14} />Compartir
        </button>
      )}
      {abierto && <CompartirModal orderId={orderId} ownerId={ownerId} actuales={compartidos} onClose={() => setAbierto(false)} onSaved={() => { setAbierto(false); onChange(); }} />}
    </span>
  );
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function CompartirModal({ orderId, ownerId, actuales, onClose, onSaved }: { orderId: number; ownerId: unknown; actuales: number[]; onClose: () => void; onSaved: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [elegidos, setElegidos] = useState<number[]>(actuales);
  const [q, setQ] = useState('');
  const [guardando, setGuardando] = useState(false);
  const owner = userOf(meta, ownerId);
  // Los usuarios activos menos el propietario (que ya lo ve); los elegidos, arriba.
  const gente = useMemo(() => meta.users
    .filter((u) => u.active && !u.deleted_at && u.id !== Number(ownerId))
    .filter((u) => !q.trim() || sinTildes(`${u.name} ${u.email}`).includes(sinTildes(q.trim())))
    .sort((a, b) => Number(actuales.includes(b.id)) - Number(actuales.includes(a.id)) || a.name.localeCompare(b.name, 'es')), [meta.users, ownerId, q, actuales]);
  const cambiar = (id: number) => setElegidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const iguales = elegidos.length === actuales.length && elegidos.every((x) => actuales.includes(x));
  const guardar = async () => {
    setGuardando(true);
    try {
      await http('PUT', `/records/order/${orderId}/compartidos`, { users: elegidos });
      toast(elegidos.length ? `Compartido con ${elegidos.length} ${elegidos.length === 1 ? 'persona' : 'personas'}` : 'Ya no está compartido');
      onSaved();
    } catch (e) { toast((e as Error).message, true); setGuardando(false); }
  };
  return (
    <Modal title="Compartir el pedido" onClose={() => !guardando && onClose()} footer={<>
      <span className="small muted grow">{elegidos.length ? `${elegidos.length} ${elegidos.length === 1 ? 'persona' : 'personas'}` : 'Solo el propietario'}</span>
      <button className="btn" onClick={onClose} disabled={guardando}>Cancelar</button>
      <button className="btn primary" onClick={guardar} disabled={guardando || iguales}>{guardando ? 'Guardando…' : 'Guardar'}</button>
    </>}>
      <p className="small muted" style={{ margin: 0 }}>
        El propietario sigue siendo {owner ? <b>{owner.name}</b> : 'el mismo'}. Con quienes lo compartas lo ven (aunque no sea suyo), siguen la conversación y
        les llegan los avisos cuando alguien cambia un boceto, un logo, la dirección o la fecha de entrega.
      </p>
      <input className="input" placeholder="Buscar persona…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="compartir-lista" role="group" aria-label="Personas">
        {gente.map((u) => (
          <label key={u.id} className={`compartir-op${elegidos.includes(u.id) ? ' sel' : ''}`}>
            <input type="checkbox" checked={elegidos.includes(u.id)} onChange={() => cambiar(u.id)} />
            <Avatar name={u.name} photo={u.photo_url} size="sm" />
            <span className="grow ellipsis">{u.name}</span>
            <span className="small muted">{PROFILE_LABEL[u.profile] ?? ''}</span>
          </label>
        ))}
        {!gente.length && <div className="small muted" style={{ padding: 8 }}>No hay nadie con ese nombre.</div>}
      </div>
    </Modal>
  );
}
