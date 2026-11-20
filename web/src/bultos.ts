// Los bultos de una tarjeta del cronograma, por medida (pedido de Rodrigo del 20/11/2026; cronograma.ts, guardarBultos):
// las cajas que más se usan (40x30 y 60x40), con las que se calcula si la carga entra en la camioneta, y las de otra medida.
export interface Bultos { c40: number; c60: number; otros: number }
export const MEDIDAS: Array<{ k: keyof Bultos; nombre: string; ayuda: string }> = [
  { k: 'c40', nombre: '40×30', ayuda: 'Cajas de 40×30' },
  { k: 'c60', nombre: '60×40', ayuda: 'Cajas de 60×40' },
  { k: 'otros', nombre: 'Otros', ayuda: 'Bultos de otra medida (no entran en la cuenta de la camioneta)' },
];
export const SIN_BULTOS: Bultos = { c40: 0, c60: 0, otros: 0 };
export const sumarBultos = (a: Bultos, b?: Bultos | null): Bultos => (b ? { c40: a.c40 + b.c40, c60: a.c60 + b.c60, otros: a.otros + b.otros } : a);
export const totalBultos = (b?: Bultos | null) => (b ? b.c40 + b.c60 + b.otros : 0);
const num = new Intl.NumberFormat('es-AR');
export const textoBultos = (n: number) => `${num.format(n)} bulto${n === 1 ? '' : 's'}`;
// «2 de 40×30 · 3 de 60×40 · 1 de otra medida».
export const desgloseBultos = (b: Bultos) => [
  b.c40 ? `${num.format(b.c40)} de 40×30` : '', b.c60 ? `${num.format(b.c60)} de 60×40` : '', b.otros ? `${num.format(b.otros)} de otra medida` : '',
].filter(Boolean).join(' · ');

// ---------- La camioneta y la carga de un recorrido ----------
// La camioneta de cada chofer (pantalla Choferes; vehiculos.ts): cuántas cajas de cada medida entran.
export interface Vehiculo { chofer: string; nombre: string; modelo: string | null; tamano: string | null; cap_c40: number | null; cap_c60: number | null; foto_at: string | null }
// Los recorridos se asignan por el nombre del chofer, sin mayúsculas, tildes ni espacios de más (como en el servidor).
export const normNombre = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export const vehiculoDe = (vs: Vehiculo[] | undefined, chofer: string | null | undefined) => (chofer ? vs?.find((v) => v.chofer === normNombre(chofer)) ?? null : null);
export const fotoVehiculo = (v: Pick<Vehiculo, 'nombre' | 'foto_at'>) => (v.foto_at ? `/api/choferes/vehiculo/foto?nombre=${encodeURIComponent(v.nombre)}&v=${encodeURIComponent(v.foto_at)}` : null);
export const tieneCapacidad = (v: Pick<Vehiculo, 'cap_c40' | 'cap_c60'> | null | undefined): v is Pick<Vehiculo, 'cap_c40' | 'cap_c60'> => !!(v && (v.cap_c40 || v.cap_c60));
// «Entran 80 cajas de 40×30 o 40 de 60×40».
export function textoCapacidad(v: Pick<Vehiculo, 'cap_c40' | 'cap_c60'>) {
  if (v.cap_c40 && v.cap_c60) return `Entran ${num.format(v.cap_c40)} cajas de 40×30 o ${num.format(v.cap_c60)} de 60×40`;
  if (v.cap_c40) return `Entran ${num.format(v.cap_c40)} cajas de 40×30`;
  if (v.cap_c60) return `Entran ${num.format(v.cap_c60)} cajas de 60×40`;
  return '';
}

// Cajas combinadas (pedido de Rodrigo del 20/11/2026): qué parte de la camioneta ocupan (1 = llena). Cada caja ocupa la
// parte que le toca de su medida: con 80 de 40×30 o 40 de 60×40, 20 de 40×30 y 10 de 60×40 son 20/80 + 10/40 = la mitad.
// Si solo se sabe una de las dos, la otra se pasa por superficie (una de 60×40 son dos de 40×30). Los bultos de otra
// medida no entran en la cuenta. Sin ninguna capacidad, null.
export function ocupacion(b: Pick<Bultos, 'c40' | 'c60'>, v: Pick<Vehiculo, 'cap_c40' | 'cap_c60'> | null | undefined): number | null {
  if (!v) return null;
  if (v.cap_c40 && v.cap_c60) return b.c40 / v.cap_c40 + b.c60 / v.cap_c60;
  if (v.cap_c40) return (b.c40 + 2 * b.c60) / v.cap_c40;
  if (v.cap_c60) return (b.c40 / 2 + b.c60) / v.cap_c60;
  return null;
}

// La carga de un recorrido a lo largo del día: sale con todo lo que va a dejar (entregas, egresos y encargos que llevan
// algo) y en cada parada baja lo que deja ahí y sube lo que retira. Lo que hay que comparar con la camioneta es el momento
// más cargado (`pico`), que puede ser al salir o después de retirar. `donde`: -1 al salir, o el índice de la parada
// después de la cual va más cargada.
export interface Carga { pico: Bultos; donde: number; ocupacion: number | null; total: Bultos }
export function cargaRecorrido(paradas: Array<{ deja: Bultos; levanta: Bultos }>, v?: Pick<Vehiculo, 'cap_c40' | 'cap_c60'> | null): Carga {
  const peso = (b: Bultos) => ocupacion(b, v) ?? b.c40 + 2 * b.c60 + b.otros;
  let carga = paradas.reduce<Bultos>((a, p) => sumarBultos(a, p.deja), SIN_BULTOS);
  let pico = carga, donde = -1;
  const total = paradas.reduce<Bultos>((a, p) => sumarBultos(sumarBultos(a, p.deja), p.levanta), SIN_BULTOS);
  paradas.forEach((p, i) => {
    carga = { c40: Math.max(0, carga.c40 - p.deja.c40 + p.levanta.c40), c60: Math.max(0, carga.c60 - p.deja.c60 + p.levanta.c60), otros: Math.max(0, carga.otros - p.deja.otros + p.levanta.otros) };
    if (peso(carga) > peso(pico)) { pico = carga; donde = i; }
  });
  return { pico, donde, ocupacion: ocupacion(pico, v), total };
}
