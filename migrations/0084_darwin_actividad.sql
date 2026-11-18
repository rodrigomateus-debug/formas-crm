-- Actividad diaria de Darwin en el CRM (pedido de Rodrigo del 18/11/2026, docs/DARWIN.md § 4): un workflow de Darwin manda
-- cada evento de las conversaciones (con Maru y con cada vendedora) a /hooks/darwin/evento; a la madrugada el CRM arma, por
-- conversación con movimiento, un resumen del día con IA en el contacto (y su empresa y negocio) y las consultas con datos
-- fijos (categoría, tipo de producto, cantidad, fecha...) para poder buscar «quién consultó por botellas».

-- Lo que llegó de Darwin, tal cual (para auditar y para volver a resumir un día).
CREATE TABLE IF NOT EXISTS darwin_eventos (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id INTEGER,
  tipo TEXT NOT NULL,
  dia TEXT NOT NULL,                -- AAAA-MM-DD en Buenos Aires
  ocurrido_at TEXT NOT NULL,
  telefono TEXT,                    -- los últimos 10 dígitos (normPhone), como records.phone
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS darwin_eventos_conv ON darwin_eventos(conversation_id, dia);

-- El estado de cada conversación (una por contacto y canal): quién la tiene, cuándo habló el cliente y cuándo el equipo.
CREATE TABLE IF NOT EXISTS darwin_conversaciones (
  conversation_id TEXT PRIMARY KEY,
  telefono TEXT,
  email TEXT,
  titulo TEXT,
  link TEXT,
  contact_id INTEGER,
  asignada_a TEXT,                  -- la vendedora a la que Maru la pasó (nombre en Darwin)
  asignada_user_id INTEGER,
  asignada_at TEXT,
  ultima_respuesta_cliente TEXT,    -- último session.replied
  ultima_actividad_equipo TEXT,     -- lastHumanActivityAt
  cerrada_at TEXT,
  abierta_at TEXT,
  campos TEXT NOT NULL DEFAULT '{}', -- los campos inteligentes de Darwin, el último valor de cada uno
  ultimo_resumen TEXT,              -- el último resumen diario del CRM (para que el siguiente diga solo lo nuevo)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS darwin_conversaciones_contacto ON darwin_conversaciones(contact_id);
CREATE INDEX IF NOT EXISTS darwin_conversaciones_tel ON darwin_conversaciones(telefono);

-- Un resumen por conversación y día: pendiente → hecho / sin_novedad / sin_contacto / error.
CREATE TABLE IF NOT EXISTS darwin_resumenes (
  conversation_id TEXT NOT NULL,
  dia TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  contact_id INTEGER,
  activity_id INTEGER,
  detalle TEXT,
  intentos INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (conversation_id, dia)
);
CREATE INDEX IF NOT EXISTS darwin_resumenes_estado ON darwin_resumenes(estado, dia);

-- Lo que consultó cada cliente, un renglón por producto, con datos fijos para filtrar.
CREATE TABLE IF NOT EXISTS consultas (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER,
  company_id INTEGER,
  deal_id INTEGER,
  conversation_id TEXT,
  dia TEXT NOT NULL,
  atendio TEXT,                     -- «Maru» o el nombre de la vendedora
  owner_id INTEGER,
  categoria TEXT,
  tipo TEXT,
  producto TEXT,
  cantidad INTEGER,
  precio_unitario REAL,
  presupuesto_total REAL,
  fecha_necesaria TEXT,
  ocasion TEXT,
  personalizacion TEXT,
  pidio_muestra INTEGER NOT NULL DEFAULT 0,
  pidio_boceto INTEGER NOT NULL DEFAULT 0,
  objecion TEXT,
  competidor TEXT,
  entrega TEXT,
  origen TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS consultas_tipo ON consultas(tipo, dia);
CREATE INDEX IF NOT EXISTS consultas_categoria ON consultas(categoria, dia);
CREATE INDEX IF NOT EXISTS consultas_contacto ON consultas(contact_id);
CREATE INDEX IF NOT EXISTS consultas_empresa ON consultas(company_id);
CREATE INDEX IF NOT EXISTS consultas_conv ON consultas(conversation_id, dia);
