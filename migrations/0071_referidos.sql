-- Referidos (pedido de Rodrigo del 17/11/2026): quién nos recomendó a quién. Los cargan las vendedoras desde el pedido
-- de referidos del Workspace de Formas Shop o desde la ficha del cliente en el Hub; ya no pasan por HubSpot.
-- Cada fila une al referido (su contacto y el negocio nuevo en «Lead») con el cliente que lo recomendó (su empresa y su
-- contacto, si se encontraron). `clave` la manda quien carga: el mismo referido no se crea dos veces.
CREATE TABLE IF NOT EXISTS referidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT UNIQUE,
  contacto_id INTEGER,
  empresa_id INTEGER,
  negocio_id INTEGER,
  tarea_id INTEGER,
  referidor_empresa_id INTEGER,
  referidor_contacto_id INTEGER,
  referidor_nombre TEXT NOT NULL,
  pdvs TEXT NOT NULL DEFAULT '[]',
  owner_id INTEGER,
  cargado_por TEXT,
  origen TEXT NOT NULL DEFAULT 'tablero',
  nota TEXT,
  agradecer_tarea_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referidos_negocio ON referidos (negocio_id);
CREATE INDEX IF NOT EXISTS idx_referidos_contacto ON referidos (contacto_id);
CREATE INDEX IF NOT EXISTS idx_referidos_ref_empresa ON referidos (referidor_empresa_id);
CREATE INDEX IF NOT EXISTS idx_referidos_ref_contacto ON referidos (referidor_contacto_id);
CREATE INDEX IF NOT EXISTS idx_referidos_owner ON referidos (owner_id, created_at);
