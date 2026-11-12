-- Direcciones de entrega del pedido (pedido de Rodrigo del 12/11/2026), en la tarjeta «Entrega» (src/worker/direcciones.ts).
-- Por defecto, una sola dirección y todo el pedido va ahí. Con varias, cada una dice cuánto de cada producto lleva; la suma
-- de un producto entre todas no pasa de lo que tiene el pedido.
-- La dirección se valida con Google Maps (Places): place_id, coordenadas y la dirección como la escribe Google. Una cargada a
-- mano (sin Google) queda «sin validar».
CREATE TABLE entrega_direcciones (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),
  position INTEGER NOT NULL DEFAULT 0,
  direccion TEXT NOT NULL,             -- como la devuelve Google (o como se escribió, si no está validada)
  detalle TEXT,                        -- piso, depto, horario, quién recibe…
  place_id TEXT,                       -- de Google Maps; con él, la dirección está validada
  lat REAL,
  lng REAL,
  precisa INTEGER NOT NULL DEFAULT 0,  -- 1: Google la ubica con altura (calle y número), no solo la calle o el barrio
  localidad TEXT,
  provincia TEXT,
  codigo_postal TEXT,
  user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX entrega_direcciones_pedido ON entrega_direcciones(record_id, position);

-- Con varias direcciones: cuánto de cada producto del pedido va a cada una. `clave` identifica el producto del pedido (su
-- código o nombre, y el número de vez si se repite), así sobrevive a que se vuelvan a traer los renglones de Finnegans.
CREATE TABLE entrega_cantidades (
  direccion_id INTEGER NOT NULL REFERENCES entrega_direcciones(id) ON DELETE CASCADE,
  clave TEXT NOT NULL,
  cantidad REAL NOT NULL,
  PRIMARY KEY (direccion_id, clave)
);

-- Resumen en el pedido (para las listas, las columnas y Claude): la dirección, o «3 direcciones: …».
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'direccion_entrega', 'Dirección de entrega', 'string', '[]', 'Pedido',
  'Se carga en la tarjeta «Entrega» del pedido, validada con Google Maps. Con varias direcciones, dice cuántas y la primera.', 12, 1, 1, 0, 0);
