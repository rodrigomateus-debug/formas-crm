import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { http, useMeta, useToast, Icon, fmtDate, fmtRelative } from './lib';
import { Modal } from './components';

// «Conectar con Claude» (src/worker/conectar.ts): abajo en el menú, arriba del nombre. Explica cómo se agrega el
// conector en Claude (como HubSpot o ClickUp: se toca Conectar y se da permiso en el CRM), muestra si ya está conectado
// y deja desconectarlo. Mientras la ventana está abierta se fija cada pocos segundos, así pasa sola a «Conectado».

interface Conexion { id: number; name: string; tipo: 'oauth'; created_at: string; last_used_at: string | null; refresh_expira: string | null }
const CLAUDE_CONECTORES = 'https://claude.ai/settings/connectors';

export function BotonConectarClaude() {
  const [abierto, setAbierto] = useState(false);
  const [conectado, setConectado] = useState<boolean | null>(null);
  useEffect(() => {
    http<{ conexiones: Conexion[] }>('GET', '/claude/conexiones').then((r) => setConectado(r.conexiones.length > 0), () => setConectado(null));
  }, [abierto]);
  return (
    <>
      <button type="button" className="nav-link conectar-claude" onClick={() => setAbierto(true)} title="Usar Claude con el CRM: buscar, cargar y actualizar conversando">
        <Icon name="spark" />{conectado ? 'Claude conectado' : 'Conectar con Claude'}
        {conectado && <span className="cc-ok" aria-label="Conectado" />}
      </button>
      {abierto && createPortal(<ConectarClaude onClose={() => setAbierto(false)} onCambio={setConectado} />, document.body)}
    </>
  );
}

function ConectarClaude({ onClose, onCambio }: { onClose: () => void; onCambio: (c: boolean) => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [datos, setDatos] = useState<{ conexiones: Conexion[]; mcp: string } | null>(null);
  const traer = () => http<{ conexiones: Conexion[]; mcp: string }>('GET', '/claude/conexiones').then((r) => { setDatos(r); onCambio(r.conexiones.length > 0); }, () => undefined);
  useEffect(() => {
    traer();
    const t = setInterval(() => { if (document.visibilityState === 'visible') traer(); }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const url = datos?.mcp ?? `${location.origin}/mcp`;
  const copiar = () => (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(() => toast('Dirección copiada'), () => toast('No se pudo copiar: seleccionala y copiala a mano.', true));
  const desconectar = async (c: Conexion) => {
    if (!confirm('¿Desconectar Claude del CRM? Claude ya no va a poder ver ni cargar nada hasta que lo conectes de nuevo.')) return;
    try { await http('DELETE', `/claude/conexiones/${c.id}`); toast('Claude desconectado'); traer(); } catch (e) { toast((e as Error).message, true); }
  };
  const admin = meta.me.role === 'admin';
  const conexiones = datos?.conexiones ?? [];
  return (
    <Modal title="Conectar con Claude" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>
        Con Claude podés preguntar y cargar cosas en el CRM conversando: «¿qué pedidos de Crockett están atrasados?», «anotá que llamé a…», «creame una tarea para el jueves».
        Claude ve lo mismo que ves vos y {admin ? 'puede cambiar cualquier cosa (sos administrador).' : <><b>solo puede cambiar lo tuyo</b>: tus registros, los que no tienen propietario y tus tareas.</>}
      </p>

      {conexiones.length > 0 && (
        <div className="cc-estado">
          <div className="cc-titulo"><span className="cc-ok" />Conectado</div>
          {conexiones.map((c) => (
            <div key={c.id} className="cc-fila">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{c.name.replace(' (conectado desde Claude)', '')}</div>
                <div className="small muted">Desde el {fmtDate(c.created_at)}{c.last_used_at ? ` · usado ${fmtRelative(c.last_used_at)}` : ' · todavía sin usar'}</div>
              </div>
              <button type="button" className="btn sm" onClick={() => desconectar(c)}>Desconectar</button>
            </div>
          ))}
        </div>
      )}

      <ol className="cc-pasos">
        <li><b>Abrí Claude</b> → Configuración → Conectores.
          <div><a className="btn sm primary" href={CLAUDE_CONECTORES} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Abrir Claude</a></div></li>
        <li><b>Buscá «Formas CRM» y tocá Conectar.</b> Si no aparece, tocá «Agregar conector personalizado», ponele de nombre <b>Formas CRM</b> y esta dirección:
          <div className="cc-url"><code>{url}</code><button type="button" className="btn sm" onClick={copiar}>Copiar</button></div></li>
        <li><b>Claude te trae al CRM: tocá «Permitir».</b> Listo, ya podés usarlo en Claude, Claude Desktop o Cowork.</li>
      </ol>
      {admin && <p className="small muted" style={{ margin: 0 }}>Como administrador, podés agregar «Formas CRM» una sola vez para toda la organización en Claude (Configuración de la organización → Conectores, con la misma dirección): así cada uno solo toca «Conectar».</p>}
    </Modal>
  );
}
