import { useState } from 'react';
import { createPortal } from 'react-dom';
import { http, useMeta, useToast, Icon, userOf, type ObjectType } from './lib';
import { Modal, userOption } from './components';
import { Select } from './Select';
import { SelectorFecha, isoDia } from './Fecha';

// «Crear tarea» desde un comentario de la conversación (pedido de Rodrigo del 13/11/2026): el título sale del mensaje, va
// asociada al pedido o negocio (así aparece también en su conversación) y en el detalle queda el mensaje citado. Por
// defecto es para mí y vence mañana.

export interface MensajeParaTarea { id: number; user_id: number | null; texto: string; recordId: number; type: ObjectType; recordName: string }

const sumarDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDia(d); };
const proximoLunes = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return isoDia(d); };
const ATAJOS: Array<[string, () => string]> = [['Hoy', () => sumarDias(0)], ['Mañana', () => sumarDias(1)], ['En 2 días', () => sumarDias(2)], ['El lunes', proximoLunes]];
const etiquetaDia = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });

export function CrearTareaDesdeMensaje({ m, onClose, onCreada }: { m: MensajeParaTarea; onClose: () => void; onCreada?: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const autor = userOf(meta, m.user_id);
  // El título, sin las menciones del principio («@Rodrigo Mateus subí el boceto…» → «Subí el boceto…»).
  const nombres = meta.users.map((u) => u.name).sort((a, b) => b.length - a.length);
  let primera = m.texto.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  for (let seguir = true; seguir;) {
    seguir = false;
    for (const n of nombres) if (primera.startsWith(`@${n}`)) { primera = primera.slice(n.length + 1).replace(/^[\s,:;-]+/, ''); seguir = true; break; }
  }
  primera = primera.charAt(0).toUpperCase() + primera.slice(1);
  const [titulo, setTitulo] = useState(primera.length > 90 ? `${primera.slice(0, 88).trimEnd()}…` : primera);
  const [dia, setDia] = useState(sumarDias(1));
  const [owner, setOwner] = useState<number>(meta.me.id);
  const [prioridad, setPrioridad] = useState('none');
  const [detalle, setDetalle] = useState(`«${m.texto}»\n— ${autor?.name ?? 'Alguien'}, en la conversación de ${m.recordName}`);
  const [guardando, setGuardando] = useState(false);
  const crear = async () => {
    if (!titulo.trim()) { toast('La tarea necesita un título', true); return; }
    setGuardando(true);
    try {
      await http('POST', '/activities', {
        type: 'task', subject: titulo.trim(), body: detalle, due_at: new Date(`${dia}T10:00:00`).toISOString(), owner_id: owner, priority: prioridad,
        task_type: 'todo', links: [m.recordId], meta: { mensaje_id: m.id },
      });
      toast(owner === meta.me.id ? 'Tarea creada: la ves en Tareas' : `Tarea creada para ${userOf(meta, owner)?.name.split(' ')[0] ?? 'la persona'}`);
      onCreada?.();
      onClose();
    } catch (e) { toast((e as Error).message, true); }
    setGuardando(false);
  };
  const activos = meta.users.filter((u) => u.active);
  return createPortal(
    <Modal title="Crear tarea" onClose={() => !guardando && onClose()} footer={<>
      <span className="small muted grow">Queda en {m.recordName}</span>
      <button className="btn" onClick={onClose} disabled={guardando}>Cancelar</button>
      <button className="btn primary" onClick={crear} disabled={guardando}><Icon name="task" size={14} />{guardando ? 'Creando…' : 'Crear tarea'}</button>
    </>}>
      <div className="tarea-cita"><Icon name="chat" size={14} /><span><b>{autor?.name ?? 'Alguien'}:</b> {m.texto || '📎 Adjunto'}</span></div>
      <label className="field">Título
        <input className="input" autoFocus value={titulo} onChange={(e) => setTitulo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') crear(); }} placeholder="Qué hay que hacer" />
      </label>
      <div className="field">Vence
        <div className="row wrap" style={{ gap: 6 }}>
          {ATAJOS.map(([l, f]) => { const v = f(); return <button key={l} type="button" className={`chip-op${dia === v ? ' on' : ''}`} onClick={() => setDia(v)}>{l}</button>; })}
          <SelectorFecha valor={dia} onElegir={(v) => v && setDia(v)} label="Elegir otro día" className={`chip-op${ATAJOS.some(([, f]) => f() === dia) ? '' : ' on'}`}>
            <Icon name="calendar" size={13} />{ATAJOS.some(([, f]) => f() === dia) ? 'Otro día' : etiquetaDia(dia)}
          </SelectorFecha>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <label className="field grow">Para
          <Select className="input" value={owner} onChange={(e) => setOwner(Number(e.target.value))} aria-label="Responsable">
            {activos.map((u) => <option key={u.id} value={u.id}>{userOption(u, u.id === meta.me.id ? ' (yo)' : '')}</option>)}
          </Select>
        </label>
        <label className="field" style={{ width: 160 }}>Prioridad
          <Select className="input" value={prioridad} onChange={(e) => setPrioridad(e.target.value)}>
            <option value="none">Sin prioridad</option><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option>
          </Select>
        </label>
      </div>
      {autor && autor.id !== meta.me.id && owner !== autor.id && (
        <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOwner(autor.id)}>Asignársela a {autor.name.split(' ')[0]}</button>
      )}
      <label className="field">Detalle
        <textarea className="input" rows={3} value={detalle} onChange={(e) => setDetalle(e.target.value)} />
      </label>
    </Modal>, document.body);
}
