-- Formas CRM · esquema inicial
-- Modelo genérico como HubSpot: cada registro (contacto, empresa, negocio) vive en `records`
-- con sus propiedades en `props` (JSON). Las columnas sueltas son copias indexadas de las
-- propiedades que más se filtran y ordenan; las mantiene `src/worker/records.ts`.

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hs_id TEXT UNIQUE
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'manager', 'member', 'viewer')),
  team_id INTEGER REFERENCES teams(id),
  active INTEGER NOT NULL DEFAULT 1,
  hs_owner_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE properties (
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('string', 'text', 'number', 'currency', 'date', 'datetime', 'enum', 'multienum', 'bool', 'owner', 'email', 'phone', 'url')),
  options TEXT NOT NULL DEFAULT '[]',
  group_name TEXT NOT NULL DEFAULT 'Información',
  description TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 100,
  system INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0,
  in_create_form INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_type, name)
);

CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL DEFAULT 'deal',
  label TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  team_id INTEGER REFERENCES teams(id),
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  label TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  probability REAL NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX stages_pipeline ON stages(pipeline_id, display_order);

CREATE TABLE records (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('contact', 'company', 'deal', 'order')),
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
CREATE INDEX records_type_updated ON records(object_type, archived, updated_at DESC);
CREATE INDEX records_type_name ON records(object_type, name COLLATE NOCASE);
CREATE INDEX records_owner ON records(object_type, owner_id);
CREATE INDEX records_email ON records(email);
CREATE INDEX records_domain ON records(domain);
CREATE INDEX records_phone ON records(phone);
CREATE INDEX records_stage ON records(pipeline_id, stage_id);
CREATE UNIQUE INDEX records_hs ON records(object_type, hs_id);

CREATE TABLE associations (
  from_type TEXT NOT NULL,
  from_id INTEGER NOT NULL,
  to_type TEXT NOT NULL,
  to_id INTEGER NOT NULL,
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX associations_to ON associations(to_id, from_type);
CREATE INDEX associations_from ON associations(from_id, to_type);

-- Actividades: notas, mails, llamadas, reuniones, tareas y mensajes de WhatsApp.
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('note', 'email', 'call', 'meeting', 'task', 'whatsapp')),
  occurred_at TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  direction TEXT CHECK (direction IN ('in', 'out')),
  status TEXT,
  outcome TEXT,
  due_at TEXT,
  completed_at TEXT,
  priority TEXT CHECK (priority IN ('none', 'low', 'medium', 'high')),
  task_type TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  thread_id TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'crm',
  archived INTEGER NOT NULL DEFAULT 0,
  hs_id TEXT
);
CREATE INDEX activities_type_time ON activities(type, occurred_at DESC);
CREATE INDEX activities_tasks ON activities(type, status, owner_id, due_at);
CREATE UNIQUE INDEX activities_external ON activities(type, external_id);
CREATE UNIQUE INDEX activities_hs ON activities(type, hs_id);

CREATE TABLE activity_links (
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  record_id INTEGER NOT NULL REFERENCES records(id),
  object_type TEXT NOT NULL,
  PRIMARY KEY (activity_id, record_id)
);
CREATE INDEX activity_links_record ON activity_links(record_id);

-- Historial de propiedades (lo que HubSpot muestra en "Ver historial" y los cambios de etapa).
CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL,
  prop TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id INTEGER,
  source TEXT NOT NULL DEFAULT 'crm'
);
CREATE INDEX changes_record ON changes(record_id, changed_at DESC);
CREATE INDEX changes_prop ON changes(prop, changed_at);

-- Vistas guardadas de las listas (filtros, columnas, orden).
CREATE TABLE views (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  shared INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#7c8597',
  hs_id TEXT
);

-- Bitácora de lo que entra por integraciones (Darwin, Zapier, formularios, MCP) para auditar.
CREATE TABLE inbound_log (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload TEXT NOT NULL,
  result TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
