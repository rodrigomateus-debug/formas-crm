-- Conversación de cada pedido (y de cada negocio), como los comentarios de una tarea de ClickUp (pedido de Rodrigo del
-- 12/11/2026): un chat grupal entre los que trabajan el pedido (el vendedor, producción, logística), con @menciones, que
-- queda registrado, y entremezclada la actividad del pedido (cambios de estado, de cada artículo, bocetos, remitos,
-- notas, mails y tareas). La actividad no se copia acá: se lee de donde ya está (conversacion.ts).

CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,                        -- texto; las menciones van como @[Nombre](id del usuario)
  menciones TEXT NOT NULL DEFAULT '[]',      -- ids de los usuarios mencionados
  responde_a INTEGER REFERENCES mensajes(id),
  source TEXT NOT NULL DEFAULT 'crm',        -- 'crm' | 'mcp'
  editado_at TEXT,
  borrado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS mensajes_record ON mensajes(record_id, id);

-- Quiénes siguen cada conversación (les cuentan los mensajes sin leer) y hasta qué mensaje leyó cada uno. Entran solos
-- quien escribe, a quien mencionan, el propietario del registro y quien lo tiene asignado en producción; cada uno puede
-- dejar de seguirla (siguiendo = 0) y una mención lo vuelve a sumar.
CREATE TABLE IF NOT EXISTS conversacion_participantes (
  record_id INTEGER NOT NULL REFERENCES records(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  leido_hasta INTEGER NOT NULL DEFAULT 0,
  siguiendo INTEGER NOT NULL DEFAULT 1,
  motivo TEXT,                               -- 'escribio' | 'mencion' | 'propietario' | 'produccion' | 'manual'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversacion_participantes_user ON conversacion_participantes(user_id, siguiendo);

-- Los cambios de estado de cada artículo en producción (los de ClickUp, que trae la sincronización, y los que se hacen
-- desde la vista de Producción del CRM), para la conversación del pedido.
CREATE TABLE IF NOT EXISTS produccion_cambios (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL,                -- el pedido
  task_id TEXT NOT NULL,
  articulo TEXT NOT NULL DEFAULT '',
  es_pdv INTEGER NOT NULL DEFAULT 0,
  campo TEXT NOT NULL DEFAULT 'estado',
  antes TEXT,
  despues TEXT,
  user_id INTEGER,
  actor TEXT,                                -- en ClickUp: quien tiene asignada la tarea, si no es usuario del CRM
  source TEXT NOT NULL DEFAULT 'clickup',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS produccion_cambios_record ON produccion_cambios(record_id, at);

-- Cuándo y quién aprobó cada boceto (para la conversación del pedido).
ALTER TABLE bocetos ADD COLUMN aprobado_at TEXT;
ALTER TABLE bocetos ADD COLUMN aprobado_por INTEGER;

-- Avisos por mail de las menciones (avisos.ts, kind 'mencion').
ALTER TABLE avisos ADD COLUMN mensaje_id INTEGER;
