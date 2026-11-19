-- Archivos fuera de la base (auditoría del 19/11/2026, src/worker/archivos.ts): las fotos de los remitos, los adjuntos del
-- chat y los PDF de las facturas pasan al bucket R2 «formas-crm-archivos». En la base queda la clave; lo que ya estaba se
-- mueve de a poco en el cron y, una vez guardado en R2, se saca de la base (data = NULL, o vacío en los adjuntos).
ALTER TABLE remitos ADD COLUMN r2_key TEXT;
ALTER TABLE files ADD COLUMN r2_key TEXT;
ALTER TABLE mensaje_adjuntos ADD COLUMN r2_key TEXT;

-- Lo que falta mover (se achican a medida que se mueve).
CREATE INDEX IF NOT EXISTS remitos_en_base ON remitos(id) WHERE data IS NOT NULL AND r2_key IS NULL;
CREATE INDEX IF NOT EXISTS files_en_base ON files(id) WHERE data IS NOT NULL AND r2_key IS NULL;
CREATE INDEX IF NOT EXISTS adjuntos_en_base ON mensaje_adjuntos(id) WHERE r2_key IS NULL;
