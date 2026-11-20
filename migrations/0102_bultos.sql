-- Bultos de cada tarjeta del cronograma (pedido de Rodrigo del 20/11/2026): por ahora los anota Logística a mano, en
-- cualquier tarjeta (entregas, ingresos, retiros, egresos y encargos), por medida: las cajas que más se usan (40x30 y
-- 60x40) y las de otra medida. Con las dos primeras se calcula si la carga de un recorrido entra en la camioneta del
-- chofer (cronograma_vehiculos, migración 0103).
-- `clave`: el movimiento («task_id:tipo», o «task_id:tipo@dir» en un pedido que va a varios lugares) o el encargo
-- («enc:id»). Lo de una tarjeta queda en su primer movimiento y la tarjeta muestra la suma de los suyos: así sigue a la
-- tarjeta si se pasa a otro día y, si dos se juntan, se suman.
CREATE TABLE IF NOT EXISTS cronograma_bultos (
  clave TEXT PRIMARY KEY,
  c40 INTEGER NOT NULL DEFAULT 0,      -- cajas de 40x30
  c60 INTEGER NOT NULL DEFAULT 0,      -- cajas de 60x40
  otros INTEGER NOT NULL DEFAULT 0,    -- bultos de otra medida (no entran en la cuenta de la camioneta)
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (c40 >= 0 AND c60 >= 0 AND otros >= 0 AND c40 + c60 + otros > 0)
);
