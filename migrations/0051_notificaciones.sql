-- Notificaciones en el CRM (la campanita de arriba, pedido de Rodrigo del 13/11/2026): los mismos avisos que salen por mail
-- (menciones, asignaciones, faltantes de entrega) y las respuestas a tus mensajes, con leído / no leído. Lo de hace más de
-- 3 días arranca como leído.
ALTER TABLE avisos ADD COLUMN leido_at TEXT;
UPDATE avisos SET leido_at = created_at WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
CREATE INDEX IF NOT EXISTS avisos_usuario ON avisos(user_id, id);
