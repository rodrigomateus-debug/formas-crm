-- Notas de producto (pedido de Rodrigo del 16/11/2026): lo que va pasando con un producto de importador, atado a su SKU y
-- no al pedido, para que se vea cada vez que se vuelve a vender («la serigrafía se sale», «el bordado tapa el bolsillo»,
-- «la tinta se borra», «es de mala calidad»). Los SKU genéricos (`_GE_`) no llevan notas: el mismo código es vasos,
-- naipes y paletas. Ver notasproducto.ts y docs/PRODUCCION.md.
CREATE TABLE producto_notas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,                 -- en mayúsculas y sin espacios de más (skuDe)
  modelo TEXT,                       -- si vale para todos los colores: el SKU sin la variante («IMP_P18.030» de «IMP_P18.030.03»)
  producto TEXT,                     -- el nombre del producto cuando se escribió (para la lista de notas)
  tipo TEXT NOT NULL,                -- serigrafia, bordado, laser, tampografia, sublimacion, calidad, tinta, otro
  gravedad TEXT NOT NULL CHECK (gravedad IN ('info', 'ojo', 'no')),   -- dato útil, ojo, no recomendado
  texto TEXT NOT NULL,
  record_id INTEGER,                 -- el pedido donde pasó
  task_id TEXT,                      -- el artículo de ClickUp donde pasó
  foto_drive_id TEXT,                -- una foto, en Drive (Notas de productos/<SKU>)
  foto_mime TEXT,
  foto_nombre TEXT,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT,
  archivada_at TEXT,                 -- «ya no aplica» (el importador cambió el producto o el lote): queda en el historial
  archivada_por INTEGER,
  borrada_at TEXT                    -- borrada por quien la escribió o un administrador: no se ve más
);
CREATE INDEX producto_notas_sku ON producto_notas(sku);
CREATE INDEX producto_notas_modelo ON producto_notas(modelo) WHERE modelo IS NOT NULL;

-- Dónde se vendió cada SKU (la ficha del producto) sin recorrer todos los renglones.
CREATE INDEX IF NOT EXISTS line_items_code ON line_items(UPPER(TRIM(code)));

-- El aviso «entró un pedido con un producto que tiene notas» (kind 'producto'): uno por persona, pedido y SKU.
ALTER TABLE avisos ADD COLUMN sku TEXT;
