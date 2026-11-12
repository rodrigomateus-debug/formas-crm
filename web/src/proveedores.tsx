// Los importadores VIP con su logo y su color, como en el seguimiento de importados del tablero de Formas Shop
// (formas-shop-tablero: proveedores_marcas.json y assets/proveedores). Los isotipos están recortados y achicados en
// web/public/proveedores/. Se reconocen por el nombre de la empresa o de la opción de ClickUp, con sus razones sociales
// (proveedores_finnegans.json) y los nombres con que aparecen en ClickUp («STOCK SUR», «IMPROM S.A.»…).
// Pedido de Rodrigo del 12/11/2026.

export interface MarcaProveedor { id: string; nombre: string; ink: string; inkDark: string; plate: string; ancho: boolean }

const MARCAS: Array<MarcaProveedor & { alias: string[] }> = [
  { id: 'zecat', nombre: 'Zecat', ink: '#b9231c', inkDark: '#ff978d', plate: '#ffffff', ancho: false, alias: ['Zecat', 'Articulos Promocionales S.A.'] },
  { id: 'promoproductos', nombre: 'Promoproductos', ink: '#795a00', inkDark: '#ffda4a', plate: '#ffffff', ancho: false, alias: ['Promoproductos', 'Promo Productos', 'Improm S.A.'] },
  { id: 'nuevas-formas', nombre: 'Nuevas Formas', ink: '#75357d', inkDark: '#d6abdc', plate: '#ffffff', ancho: false, alias: ['Nuevas Formas', 'Ene Formas S.A.'] },
  { id: 'stocksur', nombre: 'Stocksur (CDO)', ink: '#104852', inkDark: '#89d9c9', plate: '#ffffff', ancho: false, alias: ['Stocksur', 'Stock Sur', 'CDO', 'CDO / Stocksur', 'Stocksur Sociedad Anonima'] },
  { id: 'x-trade', nombre: 'X-Trade', ink: '#656624', inkDark: '#d3d281', plate: '#24272b', ancho: false, alias: ['X-Trade', 'XTrade', 'Xtradeonline SRL'] },
  { id: 'irion', nombre: 'Irion', ink: '#126990', inkDark: '#75c4e8', plate: '#ffffff', ancho: true, alias: ['Irion S.A.', 'ZÖM', 'Irion / ZÖM'] },
  { id: 'bello', nombre: 'Bello Export', ink: '#323232', inkDark: '#d9d9d9', plate: '#ffffff', ancho: false, alias: ['Bello', 'Bello Export'] },
];

// Igual que claveProveedor de produccion.ts: sin acentos, forma societaria, signos ni espacios.
export function claveMarca(nombre: string) {
  return nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,]/g, '')
    .replace(/(\s(sociedad anonima|s ?r ?l|s ?a ?s|s ?a ?u|s ?a ?i ?c|s ?a ?c ?i ?f|s ?a|s ?h))+$/, '').replace(/[^a-z0-9]+/g, '');
}

const POR_CLAVE = new Map<string, MarcaProveedor>();
for (const m of MARCAS) for (const a of [m.nombre, ...m.alias]) POR_CLAVE.set(claveMarca(a), m);

export const marcaProveedor = (nombre: string | null | undefined) => (nombre ? POR_CLAVE.get(claveMarca(nombre)) ?? null : null);

// El isotipo sobre su placa, del tamaño del texto.
export const LogoProveedor = ({ marca }: { marca: MarcaProveedor }) => (
  <span className={`prov-logo${marca.ancho ? ' ancho' : ''}`} style={{ background: marca.plate }} aria-hidden="true">
    <img src={`/proveedores/${marca.id}.png`} alt="" loading="lazy" />
  </span>
);

// El nombre como se ve: con logo y color si es un importador VIP; si no, el texto tal cual. El nombre va como hijo (no
// como prop) para que el Select lo lea al buscar y al tipear.
export function NombreProveedor({ children: nombre }: { children: string }) {
  const m = marcaProveedor(nombre);
  if (!m) return <>{nombre}</>;
  return (
    <span className="prov-marca" data-prov={m.id} style={{ ['--prov-ink' as string]: m.ink, ['--prov-ink-dark' as string]: m.inkDark }}>
      <LogoProveedor marca={m} />
      {nombre}
    </span>
  );
}
