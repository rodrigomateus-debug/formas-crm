-- Productos con talle (pedido de Rodrigo del 20/11/2026): una prenda en varios talles es un solo producto, con el desglose
-- de talles abajo. Cada artículo de Producción (ClickUp) y cada renglón del pedido (Finnegans) guarda su talle y, si va
-- junto con otros talles del mismo producto, la clave de ese grupo (la raíz del SKU: «ZEC_99030777273D··D62D54»). Así las
-- cuentas en SQL («2/3 listos», bocetos de la tarjeta) cuentan el producto una vez. Lo calcula talles.ts; `talles_v` es la
-- versión de las reglas con que se calculó cada PDV y cada pedido: si cambian, el cron recalcula (tallesdb.ts).
ALTER TABLE produccion ADD COLUMN talle TEXT;
ALTER TABLE produccion ADD COLUMN grupo_talle TEXT;
ALTER TABLE produccion ADD COLUMN talles_v INTEGER NOT NULL DEFAULT 0;   -- solo en la fila del PDV
ALTER TABLE line_items ADD COLUMN talle TEXT;
ALTER TABLE line_items ADD COLUMN grupo_talle TEXT;
ALTER TABLE line_item_sync ADD COLUMN talles_v INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_produccion_talles_v ON produccion(es_pdv, talles_v);
CREATE INDEX IF NOT EXISTS idx_line_item_sync_talles_v ON line_item_sync(talles_v);
-- El renglón del pedido de cada artículo de Producción (también lo buscan las notas, las OC y los nombres de venta).
CREATE INDEX IF NOT EXISTS idx_line_items_clickup_task ON line_items(clickup_task);
-- Las notas de producto valen para todos los talles (pedido de Rodrigo del 20/11/2026): cada nota guarda la raíz de su SKU
-- (el SKU sin el talle, talles.ts) y vale para cualquier SKU con la misma raíz. `talles_v`: con qué reglas se calculó.
ALTER TABLE producto_notas ADD COLUMN raiz TEXT;
ALTER TABLE producto_notas ADD COLUMN talles_v INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_producto_notas_raiz ON producto_notas(raiz) WHERE raiz IS NOT NULL;
