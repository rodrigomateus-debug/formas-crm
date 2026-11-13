-- Reacciones con emojis a los mensajes de la conversación (pedido de Rodrigo del 13/11/2026), como en Slack o WhatsApp:
-- cada persona pone o saca un emoji en un mensaje; se ve cuántos y quiénes.
CREATE TABLE IF NOT EXISTS mensaje_reacciones (
  mensaje_id INTEGER NOT NULL REFERENCES mensajes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (mensaje_id, user_id, emoji)
);
-- Cuándo cambió una reacción del mensaje: así la pantalla de los demás la trae con las novedades.
ALTER TABLE mensajes ADD COLUMN reaccion_at TEXT;
