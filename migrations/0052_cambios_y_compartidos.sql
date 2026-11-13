-- Avisos de cambios en los pedidos (pedido de Rodrigo del 13/11/2026): cuando otra persona (producción, logística, un
-- administrador) sube o cambia un boceto o un logo, o cambia la dirección o la fecha de entrega, le llega al vendedor (y a
-- quienes tienen el pedido compartido) a la campanita y por mail (avisos.ts, kind 'cambio'). `detalle`: qué cambió, lista
-- JSON de textos; los cambios seguidos de la misma persona en el mismo pedido se juntan en un solo aviso (cambios.ts).
ALTER TABLE avisos ADD COLUMN detalle TEXT;

-- Pedidos compartidos (pedido de Rodrigo del 13/11/2026): el propietario es uno solo, pero el pedido se comparte con más
-- personas (por ejemplo, el backoffice de una vendedora) para que lo vean, sigan su conversación y reciban sus avisos
-- (compartidos.ts; qué ve cada uno, en alcance.ts).
CREATE TABLE IF NOT EXISTS compartidos (
  record_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  by_user INTEGER,                   -- quién lo compartió
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS compartidos_usuario ON compartidos(user_id, record_id);
