import type { Parada } from './CronogramaRuta';

// Lo que comparten la Ruta del día (CronogramaRuta.tsx, con el mapa) y la versión celular de Logística, sin cargar el mapa:
// importarlo de CronogramaRuta metía Leaflet en lo que baja el celular al abrir (auditoría del 19/11/2026).
export const MOTIVO: Record<string, string> = { nadie: 'No había nadie', cerrado: 'Estaba cerrado', direccion: 'No encontró la dirección', rechazo: 'No lo quisieron recibir', no_listo: 'No estaba listo', otro: 'No se pudo' };
export const hechaParada = (p: Pick<Parada, 'movimientos' | 'encargos'>) => p.movimientos.length + (p.encargos?.length ?? 0) > 0 && p.movimientos.every((m) => m.hecho) && (p.encargos ?? []).every((e) => e.estado === 'hecho');
