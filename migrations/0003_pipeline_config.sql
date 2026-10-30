-- Configuración por pipeline y por etapa, como en HubSpot (Configuración → Negocios → Pipelines):
--   pipelines.config: { rules: { no_skip, no_backward, require_company, create_stages[] }, card_props[], key_props[] }
--   stages.config:    { required_props[], task: { subject, due_days, task_type } }
ALTER TABLE pipelines ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE stages ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

-- Perder un negocio pide el motivo (lo que hacía el tablero a mano), en los pipelines de venta.
UPDATE stages SET config = '{"required_props":["motivo_de_cierre_perdido"]}'
WHERE is_closed = 1 AND is_won = 0 AND pipeline_id IN ('674405796', 'default', '740095901', '687889576', '746355608', '772119841');

-- Corporate: todo negocio con empresa asociada (pendiente de calidad de datos del runbook de márgenes).
UPDATE pipelines SET config = '{"rules":{"require_company":true}}' WHERE id = '674405796';
