import { useState } from 'react';
import { http, qs, useAsync, useMeta, useToast, Icon } from './lib';

// Anotaciones de logística (logistica.ts, pedido de Producción del 19/11/2026): lo que hay que saber para entregar o
// retirar, con quién lo escribió. «Solo esta vez» es de este pedido; «siempre» queda en la empresa para las que vengan.
// Va en la ficha del pedido (la escribe la vendedora) y en la tarjeta del cronograma (Logística y Producción).
export interface NotaLogistica { id: number; alcance: 'puntual' | 'siempre'; texto: string; por: string | null; user_id: number | null; at: string; destino?: string | null }
interface Datos { notas: NotaLogistica[]; destino: { nombre: string | null } | null; horarios?: Array<{ fecha: string; texto: string }>; edita: boolean }
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const diaDe = (f: string) => { const d = new Date(`${f}T12:00:00`); return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`; };

const cuando = (iso: string) => { const d = new Date(iso); return `${d.getDate()}/${d.getMonth() + 1}`; };
export const nombreCorto = (n: string | null) => (n ?? '').split(' ')[0] || 'Alguien';

// Una anotación, como se lee en la tarjeta, la parada y el pedido: el texto, de quién es y si es de siempre.
export function LineaNota({ n, onBorrar }: { n: NotaLogistica; onBorrar?: () => void }) {
  return (
    <div className={`lg-nota ${n.alcance}`}>
      <p>{n.texto}</p>
      <span className="lg-nota-pie">
        <span className="lg-nota-tag" title={n.alcance === 'siempre' ? `Queda guardada para todas las veces que se vaya a ${n.destino ?? 'este lugar'}` : 'Solo para esta vez'}>{n.alcance === 'siempre' ? 'Siempre' : 'Solo esta vez'}</span>
        {n.por ? `${nombreCorto(n.por)} · ` : ''}{cuando(n.at)}
        {onBorrar && <button type="button" className="lg-nota-x" aria-label="Borrar la anotación" title="Borrar" onClick={onBorrar}><Icon name="x" size={11} /></button>}
      </span>
    </div>
  );
}

// `tipo`: entrega (por defecto) o el movimiento de la tarjeta; `destino`: en un retiro, egreso o ingreso, a dónde se va (el
// proveedor o el impresor), para las de siempre; en una entrega es el cliente del pedido. `titulo`: «Anotaciones de
// logística», en la ficha del pedido (ahí también se ve el horario fijado en el cronograma).
export function NotasLogistica({ recordId, tipo = 'entrega', destino, titulo, onCambio }: {
  recordId: number; tipo?: string; destino?: { company_id?: number | null; nombre?: string | null } | null; titulo?: string; onCambio?: () => void;
}) {
  const { meta } = useMeta();
  const toast = useToast();
  const res = useAsync(() => http<Datos>('GET', `/logistica/notas${qs({ record_id: recordId, tipo, company_id: destino?.company_id ?? undefined, nombre: destino?.nombre ?? undefined })}`), [recordId, tipo, destino?.company_id, destino?.nombre]);
  const [texto, setTexto] = useState('');
  const [alcance, setAlcance] = useState<'puntual' | 'siempre'>('puntual');
  const [ocupado, setOcupado] = useState(false);
  const d = res.data;
  const puede = meta.me.role !== 'viewer';
  const esEntrega = tipo === 'entrega';
  const guardar = async () => {
    if (texto.trim().length < 2 || ocupado) return;
    setOcupado(true);
    try {
      await http('POST', '/logistica/notas', { record_id: recordId, tipo, alcance, texto, destino: destino ?? null });
      toast(alcance === 'siempre' ? `Guardada para ${esEntrega ? 'todas las entregas a' : 'cada vez que se vaya a'} ${d?.destino?.nombre ?? 'ese lugar'}.` : `Guardada para ${esEntrega ? 'esta entrega' : 'esta vez'}.`);
      setTexto(''); res.reload(); onCambio?.();
    } catch (e) { toast((e as Error).message, true); } finally { setOcupado(false); }
  };
  const borrar = async (n: NotaLogistica) => {
    if (!confirm(n.alcance === 'siempre' ? '¿Borrar esta anotación? Deja de aparecer en todas las entregas y retiros de ese lugar.' : '¿Borrar esta anotación?')) return;
    try { await http('DELETE', `/logistica/notas/${n.id}`); res.reload(); onCambio?.(); } catch (e) { toast((e as Error).message, true); }
  };
  if (!d) return null;
  return (
    <div className="lg-notas">
      {titulo && <div className="remitos-sub" style={{ padding: 0 }}>{titulo}</div>}
      {(d.horarios ?? []).map((h) => <div key={h.fecha} className="lg-horario" title="Horario fijado en el cronograma para la entrega"><Icon name="timer" size={13} /><b>{diaDe(h.fecha)}</b>{h.texto}</div>)}
      {titulo && !d.notas.length && <div className="muted small">Lo que Logística tiene que saber para entregar: con quién hablar, por dónde entrar, qué llevar. Le aparece en el cronograma, en la ruta y al chofer.</div>}
      {d.notas.map((n) => <LineaNota key={n.id} n={n} onBorrar={puede && (d.edita || n.user_id === meta.me.id || meta.me.role === 'admin') ? () => borrar(n) : undefined} />)}
      {puede && (
        <form className="lg-form" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
          <textarea className="input sm" rows={2} maxLength={500} placeholder={esEntrega ? 'Anotación para Logística sobre la entrega…' : 'Anotación para Logística…'} value={texto} aria-label="Anotación de logística"
            onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void guardar(); }} />
          {texto.trim().length > 0 && (
            <div className="lg-form-pie">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Para cuándo vale">
                <button type="button" className={`chip${alcance === 'puntual' ? ' on' : ''}`} aria-pressed={alcance === 'puntual'} onClick={() => setAlcance('puntual')}>{esEntrega ? 'Solo esta entrega' : 'Solo esta vez'}</button>
                <button type="button" className={`chip${alcance === 'siempre' ? ' on' : ''}`} aria-pressed={alcance === 'siempre'} disabled={!d.destino} onClick={() => setAlcance('siempre')}
                  title={d.destino ? `Aparece cada vez que se vaya a ${d.destino.nombre ?? 'ese lugar'}: entregas, retiros y encargos` : 'No se sabe a qué lugar es'}>
                  {esEntrega ? 'Todas las entregas a' : 'Siempre en'} {d.destino?.nombre ?? 'este lugar'}</button>
              </div>
              <button type="submit" className="btn sm primary" disabled={ocupado || texto.trim().length < 2}>Guardar</button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
