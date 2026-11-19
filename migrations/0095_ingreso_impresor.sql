-- Ingreso (impresor) (pedido de Producción del 19/11/2026): a veces el impresor trae lo que hizo al depósito, en vez de que
-- lo vayan a retirar. Es el campo «INGRESO (IMPRESOR)» de la lista PEC de ClickUp, una fecha por artículo, igual que las
-- otras (produccion.ts, cronograma.ts).
ALTER TABLE produccion ADD COLUMN ingreso_impresor TEXT;   -- INGRESO (IMPRESOR): el impresor lo trae al depósito

-- El cronograma lo puede marcar como hecho: la restricción de `tipo` no se puede cambiar en SQLite, así que la tabla se
-- arma de nuevo con el tipo nuevo, con lo que ya estaba marcado.
CREATE TABLE cronograma_hechos_nueva (
  task_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrega', 'ingreso', 'retiro_proveedor', 'egreso', 'retiro_impresor', 'ingreso_impresor')),
  estado_antes TEXT,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  chofer TEXT,
  PRIMARY KEY (task_id, tipo)
);
INSERT INTO cronograma_hechos_nueva (task_id, tipo, estado_antes, user_id, at, chofer)
  SELECT task_id, tipo, estado_antes, user_id, at, chofer FROM cronograma_hechos;
DROP TABLE cronograma_hechos;
ALTER TABLE cronograma_hechos_nueva RENAME TO cronograma_hechos;
