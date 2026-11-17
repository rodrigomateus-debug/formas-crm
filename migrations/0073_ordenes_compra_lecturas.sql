-- Cuándo se leyeron por última vez las órdenes de compra de cada pedido (ordenescompra.ts): la tarea de cada hora las lee
-- de los pedidos en curso que no se leyeron en las últimas 6 horas.
CREATE TABLE IF NOT EXISTS ordenes_compra_lecturas (
  record_id INTEGER PRIMARY KEY,
  leido_at TEXT NOT NULL,
  ocs INTEGER NOT NULL DEFAULT 0
);
