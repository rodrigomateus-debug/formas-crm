-- Fecha del pedido (pedido de Rodrigo del 18/11/2026, Inicio de Producción; src/worker/inicioprod.ts): la fecha del pedido de
-- venta en Finnegans. La completa la corrida de totales (scripts/pedidos-totales.mjs → totales.ts); la de las 7 trae todos
-- desde 2023. Mientras tanto, los pedidos que no vinieron de ClickUp (Finnegans, HubSpot, cargados a mano) ya tienen la
-- fecha real en su alta; los de ClickUp no (se dieron de alta todos juntos el 2/11/2026) y esperan a Finnegans.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'fecha_pedido', 'Fecha del pedido', 'date', '[]', 'Pedido', 'La fecha del pedido de venta en Finnegans (scripts/pedidos-totales.mjs).', 100, 1, 1, 0, 0);
UPDATE records SET props = json_set(props, '$.fecha_pedido', substr(created_at, 1, 10))
WHERE object_type = 'order' AND json_extract(props, '$.fecha_pedido') IS NULL AND source NOT LIKE 'clickup%';
