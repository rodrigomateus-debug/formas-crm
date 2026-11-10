-- Renglones de remito asignados a mano a productos del pedido (pedido de Rodrigo del 10/11/2026). Cuando el remito dice
-- algo que no se parece al producto del pedido («70 Jarro Bossa Waterdog» contra «Producción simple drinkware genérico»),
-- una persona dice a qué producto (o productos) corresponde y cuánto va a cada uno; eso cuenta como entregado.
-- clave: qué renglón es, la misma que usa el cálculo de la entrega (número de remito | código o descripción | cuál de
-- los iguales, o r<remito>|p<posición> si no tiene número), así sigue valiendo si el remito se vuelve a leer.
-- lineas: JSON [{ i, code, name, cantidad }], el producto del pedido (su posición, código y nombre) y la cantidad.
CREATE TABLE remito_asignaciones (
  record_id INTEGER NOT NULL REFERENCES records(id),
  clave TEXT NOT NULL,
  descripcion TEXT,
  lineas TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, clave)
);
