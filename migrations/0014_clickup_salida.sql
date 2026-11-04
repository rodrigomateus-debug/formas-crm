-- Lo que el CRM le pide a ClickUp (pedido de Rodrigo del 4/11/2026): cuando la vendedora pasa un pedido de «Pedido
-- confirmado» a «Listo para producción», el PDV y sus artículos pasan de «ingreso de pedido» a «pdv» en ClickUp.
-- Queda en esta cola y sale enseguida; si ClickUp falla, se reintenta en las corridas siguientes.
CREATE TABLE clickup_salida (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,              -- 'pasar_a_pdv'
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX clickup_salida_pendientes ON clickup_salida(done_at, attempts);
