import { esOperaciones, type User } from '../lib';

// Qué pestañas de Analíticas ve cada uno (Analiticas.tsx). Va aparte para que el menú sepa si mostrar «Analíticas» sin
// bajar la pantalla con sus paneles (auditoría del 19/11/2026).
export const TEMAS_ANALITICAS = [
  // Lo que consultan los clientes por WhatsApp (darwin.ts): la parte comercial y los administradores. Ventas ve lo de sus clientes.
  { k: 'consultas', nombre: 'Consultas por WhatsApp', puede: (u: User) => !esOperaciones(u) },
  // Km y tiempo de cada recorrido, por chofer: Logística, Producción y los administradores (lo mismo que pide el servidor).
  { k: 'recorridos', nombre: 'Recorridos', puede: (u: User) => u.role !== 'viewer' && (u.role === 'admin' || esOperaciones(u)) },
] as const;
// Las pestañas que ve ese usuario. Sin ninguna, «Analíticas» no aparece en el menú.
export const analiticasDe = (u: User) => TEMAS_ANALITICAS.filter((t) => t.puede(u));
