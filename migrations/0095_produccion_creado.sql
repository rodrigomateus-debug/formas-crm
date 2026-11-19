-- Fecha de creación del PDV en Producción (pedido de Rodrigo del 19/11/2026: la lista ordenada por fecha de creación, con
-- su columna y su filtro). La fecha del PDV es la del pedido de venta en Finnegans (fecha_pedido, migración 0089); esta es
-- la de alta de la tarea en ClickUp (date_created), para los PDV que todavía no la tienen (recién cargados, antes de la
-- corrida de totales de la mañana). Se completa con la sincronización de ClickUp.
ALTER TABLE produccion ADD COLUMN creado TEXT;   -- AAAA-MM-DD (Buenos Aires)
