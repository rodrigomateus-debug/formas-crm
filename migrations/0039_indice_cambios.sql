-- La sincronización con HubSpot borra el historial de etapas de cada negocio antes de volver a escribirlo
-- (migrate.ts: DELETE FROM changes WHERE record_id = ? AND prop = 'dealstage' AND source = 'hubspot'). SQLite usaba el
-- índice por prop (changes_prop) y en cada llamada recorría todos los cambios de etapa de negocios (unas 2.800 filas):
-- 1.524 llamadas por día leyeron 4,33 millones de filas y el CRM pasó el límite diario del plan gratis de D1
-- (12/11/2026). Con este índice cada borrado lee solo las filas de ese negocio. Mismo nombre que el que se creó a mano
-- desde la consola de D1: si ya existe, no hace nada.
CREATE INDEX IF NOT EXISTS idx_changes_record_prop_source ON changes(record_id, prop, source);
