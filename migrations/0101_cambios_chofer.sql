-- Lo que marcó el chofer desde su app, con su origen (pedido de Rodrigo del 20/11/2026): en la conversación del pedido se
-- leía «Gabriel Cimino pasó…» como si fuera un usuario del CRM. Desde ahora queda con origen «chofer» y se lee «Gabriel
-- Cimino (app del chofer)» (produccion.ts, records.ts). Esto pasa lo de antes.

-- Los cambios de estado de los artículos: los únicos del CRM a nombre de alguien sin usuario son los del chofer.
UPDATE produccion_cambios SET source = 'chofer' WHERE source = 'crm' AND user_id IS NULL AND actor IS NOT NULL;

-- Los cambios del pedido que salieron de eso (la etapa, al releer el PDV): quedaban como de ClickUp. Son los del mismo
-- pedido, a nombre del mismo chofer y en el mismo momento (5 minutos) que un cambio de artículo suyo; así no se toca lo
-- de quien tiene asignado el PDV en ClickUp sin usuario del CRM.
UPDATE changes SET source = 'chofer'
WHERE source = 'clickup' AND user_id IS NULL AND actor IS NOT NULL
  AND EXISTS (SELECT 1 FROM produccion_cambios p WHERE p.record_id = changes.record_id AND p.source = 'chofer' AND p.actor = changes.actor
    AND abs(julianday(p.at) - julianday(changes.changed_at)) < 5.0 / 1440);
