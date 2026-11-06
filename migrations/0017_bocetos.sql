-- Bocetos de producción (pedido de Rodrigo del 6/11/2026): PDF o imagen por producto del pedido (o del negocio, antes de que
-- exista el pedido). El archivo vive en una unidad compartida de Google Drive; acá queda a qué producto va, si es una
-- referencia rápida o el técnico final, la versión y si está aprobado. Al aprobarlo en un pedido, el CRM lo adjunta a la
-- subtarea del artículo en ClickUp (donde trabaja producción).
CREATE TABLE IF NOT EXISTS bocetos (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),   -- pedido o negocio
  producto TEXT,                                       -- en un pedido: código del producto (o su nombre si no tiene)
  producto_nombre TEXT,                                -- el nombre que se ve
  tipo TEXT NOT NULL DEFAULT 'tecnico' CHECK (tipo IN ('referencia', 'tecnico')),
  estado TEXT NOT NULL DEFAULT 'para_aprobar' CHECK (estado IN ('para_aprobar', 'aprobado')),
  version INTEGER NOT NULL DEFAULT 1,
  nombre TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  drive_id TEXT NOT NULL,
  drive_link TEXT,
  origen_id INTEGER,                                   -- si se tomó de un negocio: el boceto de ese negocio
  clickup_task TEXT,                                   -- dónde se adjuntó en ClickUp (subtarea del artículo o el PDV)
  clickup_adjunto TEXT,
  clickup_at TEXT,
  user_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS bocetos_record ON bocetos(record_id, archived);

-- La subtarea de ClickUp de cada producto del pedido (y su estado), para mostrarlo y para adjuntarle el boceto.
ALTER TABLE line_items ADD COLUMN clickup_task TEXT;

-- Lo que el CRM le manda a ClickUp ahora puede referirse a un boceto.
ALTER TABLE clickup_salida ADD COLUMN ref TEXT;
