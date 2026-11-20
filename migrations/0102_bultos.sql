-- Cantidad de bultos de cada tarjeta del cronograma (pedido de Rodrigo del 20/11/2026): por ahora la anota Logística a
-- mano, en cualquier tarjeta (entregas, ingresos, retiros, egresos y encargos).
-- `clave`: el movimiento («task_id:tipo», o «task_id:tipo@dir» en un pedido que va a varios lugares) o el encargo
-- («enc:id»). Lo de una tarjeta queda en su primer movimiento y la tarjeta muestra la suma de los suyos: así sigue a la
-- tarjeta si se pasa a otro día y, si dos se juntan, se suman.
CREATE TABLE IF NOT EXISTS cronograma_bultos (
  clave TEXT PRIMARY KEY,
  bultos INTEGER NOT NULL CHECK (bultos > 0),
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
