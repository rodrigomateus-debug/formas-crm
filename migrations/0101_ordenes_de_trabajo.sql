-- Orden de trabajo (pedido de Rodrigo del 19/11/2026): lo que Producción trabaja es un objeto propio, la «Orden de trabajo»
-- (OT), aparte del pedido de Ventas. Nace sola con el pedido (en «Pedido confirmado») y queda relacionada con él y con su
-- empresa, contactos y negocio. Funciona igual que el pedido: tiene su misma etapa (la de ClickUp) y sus mismos datos, que
-- copia sola de su pedido (src/worker/ordenes.ts). Ver docs/ORDENES.md.

-- Este paso solo rearma la tabla (se verifica con los conteos antes y después); las OT se crean en 0102.
-- El tipo nuevo. SQLite no deja cambiar un CHECK: se rearma la tabla `records` con las mismas columnas, en el mismo
--    orden, y sus índices. Las otras tablas apuntan a `records` por nombre, así que siguen apuntando a la nueva. La tabla
--    nueva ya no tiene el CHECK del tipo (lo controla el Worker, assertType en env.ts): así un tipo más no obliga a rearmarla.
--    Las FK quedan diferidas mientras se rearma; el «= false» del final es necesario (pone en cero el contador del DROP).
--    Después de aplicarla en producción: PRAGMA foreign_key_check (tiene que dar vacío). Ver docs/ORDENES.md.
PRAGMA defer_foreign_keys = true;
CREATE TABLE records_nueva (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,
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
PRAGMA defer_foreign_keys = false;
