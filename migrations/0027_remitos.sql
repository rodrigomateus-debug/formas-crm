-- Remitos de entrega (pedido de Rodrigo del 10/11/2026). Cada foto (o PDF) del remito firmado es un remito, venga de
-- ClickUp (como hasta ahora, files.kind = 'remito'), del CRM (la ficha del pedido) o de la app del chofer (/hooks/chofer).
-- Claude lo lee (remitos.ts): número, PDV, cliente, CUIT, productos y cantidades, firma y sello. Se cruza con el pedido y,
-- si algo no cierra, queda para revisar: nunca se adjunta a un pedido «parecido». Con los remitos leídos, cada pedido
-- sabe qué se entregó y qué falta (estado de entrega).
CREATE TABLE remitos (
  id INTEGER PRIMARY KEY,
  record_id INTEGER REFERENCES records(id),        -- el pedido; NULL mientras no se sabe de cuál es
  origen TEXT NOT NULL,                            -- 'clickup' | 'crm' | 'chofer'
  file_id INTEGER UNIQUE REFERENCES files(id),     -- de ClickUp: el adjunto (se baja de ClickUp al leerlo o abrirlo)
  nombre TEXT, mime TEXT, size INTEGER, data BLOB, -- del CRM y del chofer: la foto o el PDF
  hash TEXT,                                       -- SHA-256 del archivo: la misma foto mandada dos veces es una sola
  clave TEXT UNIQUE,                               -- la que manda la app del chofer: reintentar no duplica
  subido_por INTEGER REFERENCES users(id),
  token_id INTEGER,                                -- el link del chofer que la mandó
  chofer TEXT,
  lat REAL, lng REAL, tomada_el TEXT,
  estado TEXT NOT NULL DEFAULT 'sin_leer',         -- sin_leer | ok | revisar | duplicado | descartado
  motivo TEXT,                                     -- por qué quedó para revisar (o por qué no se pudo leer)
  repetir INTEGER NOT NULL DEFAULT 0,              -- la foto no se lee bien: conviene sacar otra
  numero TEXT, pdv TEXT, cuit TEXT, cliente TEXT, fecha TEXT,
  recibido_por TEXT, recibido_el TEXT, firmado INTEGER,
  reservas INTEGER NOT NULL DEFAULT 0,             -- lo recibieron «a controlar» o con alguna salvedad escrita
  notas TEXT,
  lectura TEXT NOT NULL DEFAULT '{}',              -- lo que devolvió Claude, entero
  controles TEXT NOT NULL DEFAULT '[]',            -- los cruces con el pedido: [{ dato, ok (true/false/null), detalle }]
  candidatos TEXT NOT NULL DEFAULT '[]',           -- pedidos posibles, para la revisión
  duplicado_de INTEGER REFERENCES remitos(id),
  intentos INTEGER NOT NULL DEFAULT 0,
  leido_at TEXT,
  revisado_por INTEGER REFERENCES users(id),
  revisado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX remitos_pedido ON remitos(record_id, estado);
CREATE INDEX remitos_numero ON remitos(numero);
CREATE INDEX remitos_estado ON remitos(estado, created_at);
CREATE INDEX remitos_hash ON remitos(hash);
CREATE INDEX remitos_token ON remitos(token_id, created_at);

-- Lo que trae cada remito, renglón por renglón.
CREATE TABLE remito_items (
  remito_id INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code TEXT,
  description TEXT,
  quantity REAL,
  PRIMARY KEY (remito_id, position)
);

-- Los remitos que ya vinieron de ClickUp también se leen.
INSERT INTO remitos (record_id, origen, file_id, nombre, mime, size, created_at, updated_at)
  SELECT record_id, 'clickup', id, name, mime, size, created_at, created_at FROM files WHERE kind = 'remito';

-- Estado de entrega del pedido, según sus remitos leídos (lo calcula el CRM; ClickUp no se toca). «Finalizada con
-- faltante»: Logística (o un administrador) cerró la entrega aceptando lo que falta, con el motivo.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required) VALUES
  ('order', 'estado_entrega', 'Estado de entrega', 'enum',
    '[{"value":"completa","label":"Completa"},{"value":"parcial","label":"Faltan entregas"},{"value":"diferencias","label":"Con diferencias"},{"value":"cerrada_con_faltante","label":"Finalizada con faltante"},{"value":"falta_remito","label":"Falta el remito"},{"value":"por_revisar","label":"Remito por revisar"}]',
    'Entrega', 'Lo calcula el CRM con los remitos leídos de este pedido: lo vendido contra lo entregado, producto por producto.', 1003, 1, 1, 0, 0),
  ('order', 'falta_entregar', 'Falta entregar', 'text', '[]', 'Entrega', 'Lo que todavía no figura en ningún remito leído.', 1004, 1, 1, 0, 0),
  ('order', 'entrega_cerrada_el', 'Entrega finalizada el', 'datetime', '[]', 'Entrega', 'Cuándo se finalizó la entrega con faltante.', 1005, 1, 1, 0, 0),
  ('order', 'entrega_cerrada_por', 'Entrega finalizada por', 'owner', '[]', 'Entrega', 'Quién finalizó la entrega con faltante.', 1006, 1, 1, 0, 0),
  ('order', 'entrega_cerrada_motivo', 'Motivo del faltante', 'text', '[]', 'Entrega', 'Por qué se finalizó la entrega con lo que falta.', 1007, 1, 1, 0, 0);
