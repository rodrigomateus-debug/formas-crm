import { useEffect, useState } from 'react';
import { esVentas, type User } from '../lib';

// Cuándo se usa la versión celular (docs/MOVIL.md). Va aparte de Movil.tsx para que el escritorio no tenga que bajar la
// versión celular solo para saber si la necesita.

// Angosta, o un teléfono acostado (pantalla táctil y poco alto): girar el teléfono no pasa a la de escritorio ni pierde
// lo que se estaba escribiendo (revisión del 18/11/2026).
const CELULAR = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const CLAVE_COMPLETA = 'crm-version-completa';

const leerCompleta = () => { try { return localStorage.getItem(CLAVE_COMPLETA) === '1'; } catch { return false; } };
// Pasar a la versión completa (o volver a la del celular): se recuerda en este navegador.
export function usarVersionCompleta(si: boolean, a = '/') {
  try { if (si) localStorage.setItem(CLAVE_COMPLETA, '1'); else localStorage.removeItem(CLAVE_COMPLETA); } catch { /* ignorar */ }
  window.location.assign(a);
}

// ¿Esta pantalla va con la versión celular? Celular, perfil Ventas y sin haber pedido la completa.
export function useModoMovil(me: Pick<User, 'profile' | 'role'>) {
  const [celular, setCelular] = useState(() => typeof matchMedia === 'function' && matchMedia(CELULAR).matches);
  useEffect(() => {
    const m = matchMedia(CELULAR);
    const h = () => setCelular(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  const ventas = esVentas(me);
  const completa = leerCompleta();
  return { movil: celular && ventas && !completa, puedeVolver: celular && ventas && completa };
}
