-- Cronograma, pedidos de Producción (Rodrigo, 19/11/2026).

-- 1. La hora de una parada también puede ser un rango («entre las 10 y las 13»): `hasta`, en minutos. La tabla tenía un
-- CHECK con los tres modos de antes, así que se vuelve a armar.
CREATE TABLE cronograma_horas_nueva (
  fecha TEXT NOT NULL,                 -- AAAA-MM-DD
  clave TEXT NOT NULL,                 -- la parada
  modo TEXT NOT NULL CHECK (modo IN ('a_las', 'antes', 'desde', 'entre')),
  minutos INTEGER NOT NULL,            -- desde las 0:00
  hasta INTEGER,                       -- solo «entre»: hasta qué hora
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (fecha, clave)
);
INSERT INTO cronograma_horas_nueva (fecha, clave, modo, minutos, user_id, at) SELECT fecha, clave, modo, minutos, user_id, at FROM cronograma_horas;
DROP TABLE cronograma_horas;
ALTER TABLE cronograma_horas_nueva RENAME TO cronograma_horas;

-- 2. Anotaciones de logística, con quién las escribió: «puntual» es de este pedido y este movimiento (esta entrega, este
-- retiro); «siempre» queda en la empresa (el cliente, el proveedor o el impresor) para todas las que vengan. Las escriben
-- Logística y Producción desde el cronograma y la vendedora desde su pedido.
CREATE TABLE IF NOT EXISTS logistica_notas (
  id INTEGER PRIMARY KEY,
  alcance TEXT NOT NULL CHECK (alcance IN ('puntual', 'siempre')),
  record_id INTEGER REFERENCES records(id),   -- puntual: el pedido. siempre: desde qué pedido se escribió (si fue desde uno)
  tipo TEXT,                                  -- puntual: entrega | ingreso | retiro_proveedor | egreso | retiro_impresor
  company_id INTEGER REFERENCES records(id),  -- siempre: la empresa
  texto TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  borrada_at TEXT
);
CREATE INDEX IF NOT EXISTS logistica_notas_pedido ON logistica_notas(record_id) WHERE alcance = 'puntual';
CREATE INDEX IF NOT EXISTS logistica_notas_empresa ON logistica_notas(company_id) WHERE alcance = 'siempre';

-- 3. Lo que realmente se mandó (o llegó) en un egreso, un ingreso o un retiro, cuando no es la cantidad del pedido: la
-- demasía («se mandan 10 de más por si alguno sale fallado»). La cantidad del PDV no cambia.
CREATE TABLE IF NOT EXISTS cronograma_enviados (
  task_id TEXT NOT NULL,
  tipo TEXT NOT NULL,                  -- ingreso | retiro_proveedor | egreso | retiro_impresor
  cantidad REAL NOT NULL,
  motivo TEXT,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, tipo)
);
