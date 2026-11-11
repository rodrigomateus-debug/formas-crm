-- Un remito que lleva productos de varios pedidos (un camión, un remito, dos PDV). Además del pedido principal
-- (remitos.record_id), los otros pedidos del mismo remito. Cada renglón cuenta en el pedido al que se lo asigna
-- (remito_asignaciones, con la clave del renglón); lo que no se asigna a ninguno se busca en el principal.
CREATE TABLE remito_pedidos (
  remito_id INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL REFERENCES records(id),
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (remito_id, record_id)
);
CREATE INDEX remito_pedidos_record ON remito_pedidos(record_id);
