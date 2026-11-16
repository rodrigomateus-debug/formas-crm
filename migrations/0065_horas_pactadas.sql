-- Hora fijada a mano en una parada de la ruta del día (pedido de Rodrigo del 16/11/2026): «esta entrega tiene que ser a
-- las 12:00», «antes de las 14», «desde las 13». Es de esa parada ese día (la clave de la ruta del día, cronograma.ts). El
-- recorrido se ordena solo para cumplirla, junto con las demás horas fijadas y los horarios de recepción.
CREATE TABLE cronograma_horas (
  fecha TEXT NOT NULL,                 -- AAAA-MM-DD
  clave TEXT NOT NULL,                 -- la parada
  modo TEXT NOT NULL CHECK (modo IN ('a_las', 'antes', 'desde')),
  minutos INTEGER NOT NULL,            -- desde las 0:00
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (fecha, clave)
);
