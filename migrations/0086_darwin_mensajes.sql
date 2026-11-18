-- Los mensajes de cada conversación de Darwin (pedido de Rodrigo del 18/11/2026): la API de Darwin no los da, pero el
-- conector de Darwin en Claude sí. Una tarea programada de Claude los lee cada noche y los carga con la herramienta
-- `cargar_conversacion_darwin` del MCP del Hub; el resumen del día (darwin.ts) los usa en vez de solo el resumen de Darwin.
CREATE TABLE IF NOT EXISTS darwin_mensajes (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  dia TEXT NOT NULL,                 -- AAAA-MM-DD en Buenos Aires
  at TEXT NOT NULL,
  de TEXT NOT NULL,                  -- cliente | ia | equipo
  nombre TEXT,
  texto TEXT NOT NULL,
  externo TEXT,                      -- id del mensaje en Darwin (o en WhatsApp), para no repetirlo
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS darwin_mensajes_externo ON darwin_mensajes(conversation_id, externo);
CREATE INDEX IF NOT EXISTS darwin_mensajes_dia ON darwin_mensajes(conversation_id, dia, at);
