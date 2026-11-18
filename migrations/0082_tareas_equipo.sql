-- Tareas como en ClickUp y Asana (pedido de Rodrigo del 18/11/2026): además del responsable principal (activities.owner_id,
-- que sigue siendo el de siempre para los avisos, el resumen de la mañana, la API compatible con HubSpot y Claude), una
-- tarea puede tener colaboradores, y todos conversan en la tarea con @menciones. Las tareas siguen siendo actividades:
-- se relacionan con pedidos, negocios, empresas y contactos por activity_links, como hasta ahora.

-- Los que trabajan la tarea además del principal.
CREATE TABLE IF NOT EXISTS tarea_colaboradores (
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (activity_id, user_id)
);
CREATE INDEX IF NOT EXISTS tarea_colaboradores_user ON tarea_colaboradores(user_id, activity_id);

-- La conversación de cada tarea. Las menciones van en el texto como @[Nombre](id), igual que en la de los pedidos.
CREATE TABLE IF NOT EXISTS tarea_comentarios (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  menciones TEXT NOT NULL DEFAULT '[]',
  responde_a INTEGER,
  source TEXT NOT NULL DEFAULT 'crm',
  editado_at TEXT,
  borrado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS tarea_comentarios_tarea ON tarea_comentarios(activity_id, id);

-- Hasta qué comentario leyó cada uno (para el globito de sin leer en la tarjeta).
CREATE TABLE IF NOT EXISTS tarea_lecturas (
  activity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  leido_hasta INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (activity_id, user_id)
);

-- Los avisos de la tarea (campanita y mail) apuntan al comentario.
ALTER TABLE avisos ADD COLUMN comentario_id INTEGER;
