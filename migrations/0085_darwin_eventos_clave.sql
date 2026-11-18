-- Darwin entrega cada evento «al menos una vez» (puede llegar repetido): la clave de cada evento según la documentación de
-- la API (sessionId + forwardedAt / summarizedAt / etapa…) para guardar cada uno una sola vez.
ALTER TABLE darwin_eventos ADD COLUMN clave TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS darwin_eventos_clave ON darwin_eventos(clave);
