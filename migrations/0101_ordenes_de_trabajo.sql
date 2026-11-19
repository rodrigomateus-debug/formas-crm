-- Orden de trabajo (pedido de Rodrigo del 19/11/2026): lo que Producción trabaja es un objeto propio, la «Orden de trabajo»
-- (OT), aparte del pedido de Ventas. Nace sola con el pedido (en «Pedido confirmado») y queda relacionada con él y con su
-- empresa, contactos y negocio. Funciona igual que el pedido: tiene su misma etapa (la de ClickUp) y sus mismos datos, que
-- copia sola de su pedido (src/worker/ordenes.ts). Ver docs/ORDENES.md.

-- 1. El tipo nuevo. SQLite no deja cambiar un CHECK: se rearma la tabla `records` con las mismas columnas, en el mismo
--    orden, y sus índices. Las otras tablas apuntan a `records` por nombre, así que siguen apuntando a la nueva.
PRAGMA defer_foreign_keys = true;
CREATE TABLE records_nueva (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('contact', 'company', 'deal', 'order', 'work_order')),
  name TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}',
  owner_id INTEGER REFERENCES users(id),
  email TEXT COLLATE NOCASE,
  domain TEXT COLLATE NOCASE,
  phone TEXT,
  pipeline_id TEXT,
  stage_id TEXT,
  amount REAL,
  close_date TEXT,
  stage_entered_at TEXT,
  last_activity_at TEXT,
  last_contacted_at TEXT,
  next_activity_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'crm',
  source_detail TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  merged_into INTEGER,
  hs_id TEXT
);
INSERT INTO records_nueva (id, object_type, name, props, owner_id, email, domain, phone, pipeline_id, stage_id, amount, close_date,
  stage_entered_at, last_activity_at, last_contacted_at, next_activity_at, created_at, updated_at, created_by, source, source_detail,
  archived, merged_into, hs_id)
SELECT id, object_type, name, props, owner_id, email, domain, phone, pipeline_id, stage_id, amount, close_date,
  stage_entered_at, last_activity_at, last_contacted_at, next_activity_at, created_at, updated_at, created_by, source, source_detail,
  archived, merged_into, hs_id FROM records;
DROP TABLE records;
ALTER TABLE records_nueva RENAME TO records;
CREATE INDEX records_type_updated ON records(object_type, archived, updated_at DESC);
CREATE INDEX records_type_name ON records(object_type, name COLLATE NOCASE);
CREATE INDEX records_owner ON records(object_type, owner_id);
CREATE INDEX records_email ON records(email);
CREATE INDEX records_domain ON records(domain);
CREATE INDEX records_phone ON records(phone);
CREATE INDEX records_stage ON records(pipeline_id, stage_id);
CREATE UNIQUE INDEX records_hs ON records(object_type, hs_id);

-- 2. Sus propiedades: las mismas del pedido que sirven en producción, con los mismos nombres internos (así la etapa se ve
--    y se filtra igual), todas de solo lectura porque las copia del pedido. La etapa toma las opciones que tenga hoy la
--    del pedido (por si alguna se renombró desde Configuración).
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES
  ('work_order', 'nombre_ot', 'Nombre de la orden de trabajo', 'string', '[]', 'Orden de trabajo', 'Sale del pedido: «OT 31167 · Cliente».', 0, 1, 1, 0, 1),
  ('work_order', 'pdv_finnegans', 'PDV Finnegans', 'string', '[]', 'Orden de trabajo', 'El del pedido.', 1, 1, 1, 0, 0),
  ('work_order', 'hs_pipeline_stage', 'Etapa', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'hs_pipeline_stage'), '[]'),
    'Orden de trabajo', 'La misma del pedido: la mueve ClickUp (antes de producción, la vendedora desde el pedido).', 2, 1, 1, 0, 0),
  ('work_order', 'owner_id', 'Vendedora', 'owner', '[]', 'Orden de trabajo', 'La propietaria del pedido.', 3, 1, 1, 0, 0),
  ('work_order', 'unidad_de_negocio', 'Unidad de negocio', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'unidad_de_negocio'), '[]'),
    'Orden de trabajo', '', 4, 1, 1, 0, 0),
  ('work_order', 'tipo_de_pedido', 'Tipo de pedido', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'tipo_de_pedido'), '[]'),
    'Orden de trabajo', '', 5, 1, 1, 0, 0),
  ('work_order', 'fecha_de_entrega', 'Fecha de entrega', 'date', '[]', 'Orden de trabajo', 'La pactada: la del pedido de venta en Finnegans.', 6, 1, 1, 0, 0),
  ('work_order', 'fecha_pedido', 'Fecha del pedido', 'date', '[]', 'Orden de trabajo', 'La del pedido de venta en Finnegans.', 7, 1, 1, 0, 0),
  ('work_order', 'detalle_produccion', 'Detalle de producción', 'text', '[]', 'Orden de trabajo', '', 8, 1, 1, 0, 0),
  ('work_order', 'entregado_el', 'Entregado el', 'date', '[]', 'Orden de trabajo', '', 9, 1, 1, 0, 0),
  ('work_order', 'cliente_clickup', 'Cliente (ClickUp)', 'string', '[]', 'Orden de trabajo', '', 10, 1, 1, 0, 0),
  ('work_order', 'pedido_finnegans', 'Pedido en Finnegans', 'string', '[]', 'Orden de trabajo', '', 11, 1, 1, 0, 0),
  ('work_order', 'url_clickup', 'PDV en ClickUp', 'url', '[]', 'Orden de trabajo', '', 12, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES
  ('work_order', 'createdate', 'Fecha de creación', 'datetime', '[]', 'Actividad', '', 1000, 1, 1, 0, 0),
  ('work_order', 'notes_last_updated', 'Última actividad', 'datetime', '[]', 'Actividad', '', 1001, 1, 1, 0, 0),
  ('work_order', 'source', 'Origen del registro', 'string', '[]', 'Actividad', '', 1002, 1, 1, 0, 0);

-- 3. Una OT para cada pedido que sigue activo (todo lo que no está entregado ni anulado). Los entregados y anulados quedan
--    como estaban. Los ids siguen la numeración propia del CRM.
CREATE TABLE ot_alta (pedido_id INTEGER PRIMARY KEY, ot_id INTEGER NOT NULL);
INSERT INTO ot_alta (pedido_id, ot_id)
SELECT o.id, MAX((SELECT MAX(id) FROM records), 900000000000) + ROW_NUMBER() OVER (ORDER BY o.id)
FROM records o
WHERE o.object_type = 'order' AND o.archived = 0
  AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '4b27b500-f031-4927-9811-68a0b525cbae')
    NOT IN ('1237498998', '3c85a297-e9ce-400b-b42e-9f16853d69d6');

-- El nombre sale del pedido: «PDV 31167 · Cliente» → «OT 31167 · Cliente». json_patch con un null saca la clave: quedan
-- solo los datos que el pedido tiene.
INSERT INTO records (id, object_type, name, props, owner_id, created_at, updated_at, created_by, source, source_detail)
SELECT t.ot_id, 'work_order', x.nombre,
  json_patch(json_object('nombre_ot', x.nombre), json_object(
    'pdv_finnegans', json_extract(o.props, '$.pdv_finnegans'),
    'hs_pipeline_stage', COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '4b27b500-f031-4927-9811-68a0b525cbae'),
    'owner_id', o.owner_id,
    'unidad_de_negocio', json_extract(o.props, '$.unidad_de_negocio'),
    'tipo_de_pedido', json_extract(o.props, '$.tipo_de_pedido'),
    'fecha_de_entrega', json_extract(o.props, '$.fecha_de_entrega'),
    'fecha_pedido', json_extract(o.props, '$.fecha_pedido'),
    'detalle_produccion', json_extract(o.props, '$.detalle_produccion'),
    'entregado_el', json_extract(o.props, '$.entregado_el'),
    'cliente_clickup', json_extract(o.props, '$.cliente_clickup'),
    'pedido_finnegans', json_extract(o.props, '$.pedido_finnegans'),
    'url_clickup', json_extract(o.props, '$.url_clickup'))),
  o.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'crm', 'orden de trabajo'
FROM ot_alta t
JOIN records o ON o.id = t.pedido_id
JOIN (SELECT id, CASE WHEN name LIKE 'PDV %' THEN 'OT ' || substr(name, 5) ELSE 'OT · ' || name END AS nombre FROM records) x ON x.id = o.id;

-- Pedido ↔ OT, en los dos sentidos (como toda asociación).
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'order', pedido_id, 'work_order', ot_id, NULL, 0 FROM ot_alta;
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'work_order', ot_id, 'order', pedido_id, NULL, 0 FROM ot_alta;
-- Y las mismas empresas, contactos y negocio que su pedido (con la empresa principal).
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'work_order', t.ot_id, a.to_type, a.to_id, a.label, a.is_primary
FROM ot_alta t JOIN associations a ON a.from_id = t.pedido_id AND a.to_type IN ('company', 'contact', 'deal');
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT a.to_type, a.to_id, 'work_order', t.ot_id, a.label, a.is_primary
FROM ot_alta t JOIN associations a ON a.from_id = t.pedido_id AND a.to_type IN ('company', 'contact', 'deal');

DROP TABLE ot_alta;
PRAGMA defer_foreign_keys = false;
