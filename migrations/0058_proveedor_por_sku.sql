-- El proveedor de cada artículo de producción sale del SKU si ClickUp no lo tiene (pedido de Rodrigo del 13/11/2026):
-- ZEC Zecat, IMP Promoproductos, CDO Stocksur, ZOM Irion, NFM Nuevas Formas, XTR X-Trade, MYA Maya (produccion.ts).
-- `codigo`: el SKU del artículo (la línea «Código:» de la subtarea de ClickUp). `proveedor_auto`: la opción de PROVEEDOR
-- que el CRM puso por el SKU; con valor, ese artículo ya no se vuelve a completar (si después lo cambian o lo vacían, queda así).
ALTER TABLE produccion ADD COLUMN codigo TEXT;
ALTER TABLE produccion ADD COLUMN proveedor_auto TEXT;
