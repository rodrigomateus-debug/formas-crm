-- Choferes y expresos del cronograma (pedido de Rodrigo del 13/11/2026).

-- La lista de quienes hacen un recorrido o llevan una entrega: los choferes propios y los expresos (transportes de
-- terceros). Se agregan desde el desplegable «Chofer» de la ruta del día. El link de la app del chofer es aparte
-- (Entregas → Choferes): un chofer puede estar en la lista sin tener link.
CREATE TABLE transportistas (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('chofer', 'expreso')),
  direccion TEXT,                      -- de un expreso: a dónde se le lleva la mercadería
  activo INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Una entrega que no va directo al cliente sino a un expreso, que se la lleva. La parada pasa a ser el expreso; el número
-- de guía se carga cuando se despacha, para seguir el envío. `clave` es la de la parada (p:<PDV>, o p:<PDV>:2 si el pedido
-- va a varias direcciones).
CREATE TABLE entrega_expresos (
  clave TEXT PRIMARY KEY,
  record_id INTEGER REFERENCES records(id),
  expreso TEXT NOT NULL,
  guia TEXT,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Un recorrido puede salir de otro lugar que no sea un depósito de Formas (base = 'otro'): su nombre y su dirección.
ALTER TABLE cronograma_rutas ADD COLUMN base_nombre TEXT;
ALTER TABLE cronograma_rutas ADD COLUMN base_direccion TEXT;
