-- Remitos internos y foto obligatoria en todas las paradas (pedido de Rodrigo del 16/11/2026, de Logística).
--
-- Los choferes sacan la foto del remito en todas las paradas, no solo en las entregas. El de una entrega es el remito de
-- Formas al cliente: el que ven las vendedoras en el pedido y con el que se calcula qué se entregó (como hasta ahora). El
-- de un retiro, un egreso o un encargo es un remito interno (de un proveedor, de un impresor, el de traslado de Formas):
-- queda atado a los pedidos de esa parada —puede ser de varios PDV— para Producción y Logística, no se lee con Claude y
-- no cuenta para la entrega al cliente (remitos.ts).
ALTER TABLE remitos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'entrega';   -- 'entrega' | 'interno'
ALTER TABLE remitos ADD COLUMN fecha_parada TEXT;                      -- el día del recorrido de la parada de la foto
CREATE INDEX remitos_parada ON remitos(fecha_parada, parada);

-- Remito de traslado de un egreso (lo que se le lleva al impresor), impreso desde el cronograma, como el de los encargos de
-- Recorridos: el mismo número que sigue la planilla. Uno por parada y por día (todos los PDV que van a ese impresor).
CREATE TABLE remitos_traslado (
  id INTEGER PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE,
  fecha TEXT NOT NULL,                 -- AAAA-MM-DD
  clave TEXT NOT NULL,                 -- la parada (e:<empresa> del impresor)
  destino TEXT NOT NULL,
  direccion TEXT,
  items TEXT NOT NULL DEFAULT '[]',    -- [{ cant, que, pdv }]
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (fecha, clave)
);
