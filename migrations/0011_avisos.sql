-- Avisos por mail: lo que le asignan a alguien (un registro o una tarea) queda acá hasta que sale en el próximo mail.
CREATE TABLE avisos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,          -- a quién se le avisa
  kind TEXT NOT NULL,                -- 'registro' | 'tarea'
  record_id INTEGER,
  activity_id INTEGER,
  by_user INTEGER,                   -- quién lo asignó
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  error TEXT
);
CREATE INDEX avisos_pendientes ON avisos(sent_at, user_id);
