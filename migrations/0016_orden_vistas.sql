-- Orden de las pestañas de vistas de cada usuario (pedido de Rodrigo del 6/11/2026): cada uno las ordena arrastrándolas,
-- sin cambiarles el orden a los demás (las vistas compartidas son las mismas para todos).
CREATE TABLE IF NOT EXISTS view_order (
  user_id INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, object_type)
);
