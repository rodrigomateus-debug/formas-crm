-- Órdenes de compra a proveedores de cada pedido (pedido de Rodrigo del 17/11/2026), desde Finnegans: las que se generan
-- desde el pedido de venta (documentos destino) y llevan el pedido en la dimensión. Se ven en Producción y en Pedidos,
-- en cada producto, con link a la OC en Finnegans GO (ordenescompra.ts).
CREATE TABLE IF NOT EXISTS ordenes_compra (
  record_id INTEGER NOT NULL,          -- el pedido del CRM
  ie TEXT NOT NULL,                    -- IdentificacionExterna de la OC en Finnegans
  nombre TEXT,                         -- como la nombra Finnegans («FPOC - 00001234»)
  transaccion_id INTEGER,              -- para el link a Finnegans GO (pk)
  proveedor TEXT,
  fecha TEXT,
  codigos TEXT,                        -- JSON: códigos de producto de sus renglones de este pedido; NULL si no se pudo leer el detalle
  leido_at TEXT NOT NULL,
  PRIMARY KEY (record_id, ie)
);
