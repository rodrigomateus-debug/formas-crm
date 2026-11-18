-- Destinos completados con IA (pedido de Rodrigo del 18/11/2026): a muchos destinos de la libreta les faltaba la
-- localidad, la provincia o no aparecían en el mapa. Claude los revisa y solo se corrige lo que está al menos 90 % seguro
-- (y, con Google Maps conectado, lo que Google ubica en el mismo lugar); lo demás queda «Para revisar» con la sugerencia.
ALTER TABLE lugares ADD COLUMN provincia TEXT;
ALTER TABLE lugares ADD COLUMN ia_estado TEXT;      -- 'corregido' | 'ok' | 'dudoso' | NULL (sin revisar o corregido a mano)
ALTER TABLE lugares ADD COLUMN ia_nota TEXT;        -- por qué (para Logística)
ALTER TABLE lugares ADD COLUMN ia_antes TEXT;       -- JSON: cómo estaba antes de la corrección (para volver atrás)
ALTER TABLE lugares ADD COLUMN ia_sugerida TEXT;    -- JSON: lo que propuso Claude cuando no estaba seguro
ALTER TABLE lugares ADD COLUMN ia_firma TEXT;       -- lo que se revisó: no se vuelve a revisar si no cambió
ALTER TABLE lugares ADD COLUMN ia_at TEXT;
