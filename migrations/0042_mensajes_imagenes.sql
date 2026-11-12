-- Imágenes en los mensajes de la conversación (pedido de Rodrigo del 12/11/2026): fotos, capturas de pantalla o un boceto
-- rápido pegados en el chat. Como las fotos de los remitos, se achican en el navegador y se guardan en la base (una fila
-- de D1 no puede pasar de 2 MB). Se suben al elegirlas (mensaje_id vacío) y quedan del mensaje al mandarlo; las que nunca
-- se mandaron se borran al día siguiente, y las de un mensaje borrado, al borrarlo.
CREATE TABLE IF NOT EXISTS mensaje_adjuntos (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),
  mensaje_id INTEGER REFERENCES mensajes(id),
  user_id INTEGER REFERENCES users(id),
  nombre TEXT NOT NULL DEFAULT 'imagen',
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  ancho INTEGER,
  alto INTEGER,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS mensaje_adjuntos_record ON mensaje_adjuntos(record_id, mensaje_id);
CREATE INDEX IF NOT EXISTS mensaje_adjuntos_mensaje ON mensaje_adjuntos(mensaje_id);
CREATE INDEX IF NOT EXISTS mensaje_adjuntos_sueltos ON mensaje_adjuntos(user_id, mensaje_id, created_at);
