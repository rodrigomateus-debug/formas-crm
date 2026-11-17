-- El detalle de las OC que el informe de Finnegans todavía da sin pedido (ordenescompra.ts): se guarda lo que dijo, así
-- cada corrida lo reusa en lugar de volver a pedirlo (Finnegans cobra por consulta).
CREATE TABLE IF NOT EXISTS ordenes_compra_detalles (
  ie TEXT PRIMARY KEY,
  pedidos TEXT NOT NULL DEFAULT '{}',   -- JSON {"PEDVTASTP - 31577": ["COD1", "COD2"]}
  leido_at TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 1
);
