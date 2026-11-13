// Los expresos con los que se despacha (pedido de Rodrigo del 13/11/2026): el link para seguir un envío por su número de
// guía, cuando el expreso tiene uno que abre el seguimiento directo. Si no, null: queda el número para copiar.
//
// Vía Cargo: el mismo link que abre el buscador de su página (viacargo.com.ar/seguimiento-de-envio/<guía>, números de
// 12 dígitos); la página busca sola el número que viene en la dirección. Para otro expreso, se agrega acá.
const sinAcentos = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
export function seguimientoExpreso(empresa: string | null | undefined, numero: string | null | undefined): string | null {
  const n = String(numero ?? '').replace(/\s+/g, '');
  if (!n) return null;
  const e = sinAcentos(empresa ?? '');
  if (e.includes('viacargo') && /^\d{6,20}$/.test(n)) return `https://viacargo.com.ar/seguimiento-de-envio/${n}/`;
  return null;
}
