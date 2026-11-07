-- Pedido de Rodrigo (07/11/2026): un negocio pasa a «Envío de cotización» solo con su valor cargado, y mayor a $0
-- (src/worker/pipelines.ts). Se suma `amount` a los datos obligatorios de esa etapa en todos los pipelines de negocios que
-- la tienen (Formas Shop y NoEstres, Inbound y Outbound, e Híbrido Outbound), sin pisar los que ya tenga. El tablero, la ficha y la vista previa piden el
-- valor en una ventana antes de mover el negocio.
UPDATE stages SET config = json_set(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.required_props', json('[]'))
WHERE label LIKE 'env_o de cotizaci_n' AND pipeline_id IN (SELECT id FROM pipelines WHERE object_type = 'deal')
  AND (NOT json_valid(config) OR json_type(config, '$.required_props') IS NOT 'array');

UPDATE stages SET config = json_insert(config, '$.required_props[#]', 'amount')
WHERE label LIKE 'env_o de cotizaci_n' AND pipeline_id IN (SELECT id FROM pipelines WHERE object_type = 'deal')
  AND NOT EXISTS (SELECT 1 FROM json_each(stages.config, '$.required_props') WHERE value = 'amount');
