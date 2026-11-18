import { useSearchParams } from 'react-router-dom';
import { useMeta, esOperaciones, type User } from '../lib';
import { RendimientoPanel } from './Rendimiento';
import { ConsultasPanel } from './Consultas';

// Analíticas (pedido de Rodrigo del 18/11/2026): una sola entrada en el menú para los números de cada área, así los
// módulos de trabajo (CRM, Operaciones) no se llenan de pantallas de reportes. Adentro, una pestaña por tema; cada perfil
// ve las suyas. Por ahora hay una: el rendimiento de los recorridos (Rendimiento.tsx). Las que vengan (costos,
// puntualidad, ventas) se suman acá, en ANALITICAS.

type Tema = { k: string; nombre: string; puede: (u: User) => boolean; panel: () => JSX.Element };
const ANALITICAS: Tema[] = [
  // Lo que consultan los clientes por WhatsApp (darwin.ts): la parte comercial y los administradores. Ventas ve lo de sus clientes.
  { k: 'consultas', nombre: 'Consultas por WhatsApp', puede: (u) => !esOperaciones(u), panel: () => <ConsultasPanel /> },
  // Km y tiempo de cada recorrido, por chofer: Logística, Producción y los administradores (lo mismo que pide el servidor).
  { k: 'recorridos', nombre: 'Recorridos', puede: (u) => u.role !== 'viewer' && (u.role === 'admin' || esOperaciones(u)), panel: () => <RendimientoPanel /> },
];
// Las pestañas que ve ese usuario. Sin ninguna, «Analíticas» no aparece en el menú.
export const analiticasDe = (u: User) => ANALITICAS.filter((t) => t.puede(u));

export default function AnaliticasPage() {
  const { meta } = useMeta();
  const [sp, setSp] = useSearchParams();
  const temas = analiticasDe(meta.me);
  const tema = temas.find((t) => t.k === sp.get('t')) ?? temas[0];
  if (!tema) return <div className="content"><div className="page-head"><h1>Analíticas</h1></div><p className="muted">Todavía no hay analíticas para tu perfil.</p></div>;
  return (
    <div className="content">
      <div className="page-head"><h1>Analíticas</h1></div>
      <div className="tabs" role="tablist">
        {temas.map((t) => <button key={t.k} type="button" role="tab" aria-selected={t.k === tema.k} className={`tab${t.k === tema.k ? ' on' : ''}`}
          onClick={() => setSp(t.k === temas[0].k ? {} : { t: t.k }, { replace: true })}>{t.nombre}</button>)}
      </div>
      {tema.panel()}
    </div>
  );
}
