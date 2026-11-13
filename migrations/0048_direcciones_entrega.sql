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

-- «Dirección de entrega» del pedido (la creó el cronograma, 0045): ahora es el resumen de estas direcciones y se cambia
-- desde la tarjeta «Entrega» (o desde la parada del cronograma, que pasa por direcciones.ts).
UPDATE properties SET read_only = 1,
  description = 'Se carga en la tarjeta «Entrega» del pedido, validada con Google Maps. Con varias direcciones dice cuántas y cuáles. Si está vacía, el cronograma usa la del pedido en Finnegans.'
WHERE object_type = 'order' AND name = 'direccion_entrega';

-- Las que ya estaban cargadas a mano en el pedido pasan a ser su dirección de entrega (sin validar, hasta elegirla de Google).
INSERT INTO entrega_direcciones (record_id, position, direccion, precisa)
SELECT id, 0, trim(json_extract(props, '$.direccion_entrega')), 0 FROM records
WHERE object_type = 'order' AND trim(COALESCE(json_extract(props, '$.direccion_entrega'), '')) != '';
