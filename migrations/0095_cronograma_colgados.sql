-- Colgados del cronograma (pedido de Rodrigo del 19/11/2026): los movimientos (entregas, retiros, egresos, ingresos) que no
-- se pudieron hacer y quedan pendientes por algún motivo (el cliente no pagó el total, fueron y nadie recibió, falta un
-- documento). Dejan de verse en su día y en la ruta, y quedan en la columna «Colgados», que está en todas las semanas,
-- hasta que se pasan a un día o se marcan hechos. La fecha de ClickUp no se toca.
CREATE TABLE IF NOT EXISTS cronograma_colgados (
  task_id TEXT NOT NULL,               -- el artículo (o el PDV, si no tiene artículos)
  tipo TEXT NOT NULL,                  -- entrega | ingreso | retiro_proveedor | egreso | retiro_impresor
  motivo TEXT NOT NULL,                -- por qué quedó colgado
  fecha TEXT NOT NULL,                 -- el día en el que estaba cuando se colgó
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, tipo)
);
