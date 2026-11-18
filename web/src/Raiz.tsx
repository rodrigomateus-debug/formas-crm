import { lazy, Suspense } from 'react';
import { useMeta, Cargando } from './lib';
import { useModoMovil } from './movil/modo';

// Qué CRM se dibuja: el de escritorio o la versión celular (perfiles Ventas y Logística en el teléfono, docs/MOVIL.md). Cada uno se baja
// por separado, así el teléfono no carga todo el escritorio (revisión del 18/11/2026: tardaba 3 s con 4G lenta).
const Escritorio = lazy(() => import('./App'));
const Movil = lazy(() => import('./movil/Movil'));

export default function Raiz() {
  const { meta } = useMeta();
  const modo = useModoMovil(meta.me);
  return (
    <Suspense fallback={<Cargando pantalla texto="Abriendo Formas Hub…" />}>
      {modo.movil ? <Movil perfil={modo.movil} /> : <Escritorio puedeVolver={modo.puedeVolver} />}
    </Suspense>
  );
}
