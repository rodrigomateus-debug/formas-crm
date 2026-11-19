-- Entrega en varias direcciones, etapa 2 (Rodrigo, 19/11/2026): la producción sigue siendo una sola, pero la logística se
-- bifurca. Cada lugar del pedido tiene su fecha (si no tiene, la del artículo en ClickUp), su «hecho» y puede quedar
-- colgado por separado.
ALTER TABLE entrega_direcciones ADD COLUMN fecha TEXT;          -- AAAA-MM-DD; NULL: la fecha de entrega del artículo
ALTER TABLE entrega_direcciones ADD COLUMN hecho_at TEXT;       -- cuándo se entregó en este lugar
ALTER TABLE entrega_direcciones ADD COLUMN hecho_por INTEGER;   -- quién lo marcó (usuario), o
ALTER TABLE entrega_direcciones ADD COLUMN hecho_chofer TEXT;   -- el chofer, desde su app
CREATE INDEX IF NOT EXISTS entrega_direcciones_fecha ON entrega_direcciones(fecha) WHERE fecha IS NOT NULL;

-- Lo colgado también puede ser de un solo lugar: `dir` es la dirección del pedido (0: el movimiento entero).
CREATE TABLE cronograma_colgados_nueva (
  task_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  dir INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL,
  fecha TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, tipo, dir)
);
INSERT INTO cronograma_colgados_nueva (task_id, tipo, dir, motivo, fecha, user_id, at) SELECT task_id, tipo, 0, motivo, fecha, user_id, at FROM cronograma_colgados;
DROP TABLE cronograma_colgados;
ALTER TABLE cronograma_colgados_nueva RENAME TO cronograma_colgados;
