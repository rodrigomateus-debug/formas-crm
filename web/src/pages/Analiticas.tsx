import { useSearchParams } from 'react-router-dom';
import { useMeta } from '../lib';
import { analiticasDe, TEMAS_ANALITICAS } from './analiticasTemas';
import { RendimientoPanel } from './Rendimiento';
import { ConsultasPanel } from './Consultas';

// Analíticas (pedido de Rodrigo del 18/11/2026): una sola entrada en el menú para los números de cada área, así los
// módulos de trabajo (CRM, Operaciones) no se llenan de pantallas de reportes. Adentro, una pestaña por tema; cada perfil
// ve las suyas. Por ahora hay una: el rendimiento de los recorridos (Rendimiento.tsx). Las que vengan (costos,
// puntualidad, ventas) se suman acá, en ANALITICAS.

// El panel de cada pestaña; quién ve cada una está en analiticasTemas.ts.
const PANELES: Record<(typeof TEMAS_ANALITICAS)[number]['k'], () => JSX.Element> = {
  consultas: () => <ConsultasPanel />,
  recorridos: () => <RendimientoPanel />,
};
export { analiticasDe };

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
      {PANELES[tema.k]()}
    </div>
  );
}
