-- «Fecha del pedido» (pedido de Rodrigo del 18/11/2026): la fecha en que se hizo el pedido en Finnegans, no la fecha en que
-- entró al CRM. El Inicio de Dirección contaba como «pedidos del período sin negocio» los ~880 pedidos que entraron de una
-- vez el 02/11 (la carga inicial desde ClickUp). La completa scripts/pedidos-totales.mjs (todos los días, desde 2023).
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('order', 'fecha_del_pedido', 'Fecha del pedido', 'date', '[]', 'Pedido',
    'La fecha del pedido de venta en Finnegans (no la fecha en que entró al CRM).', 20, 1, 1, 0, 0);

-- Lo que ya se sabe: los pedidos que dio de alta Finnegans entran con su fecha a las 12:00 UTC, y los de HubSpot, con la
-- fecha en que se crearon allá. El resto lo completa la próxima corrida de pedidos-totales.
UPDATE records SET props = json_set(props, '$.fecha_del_pedido', substr(created_at, 1, 10))
  WHERE object_type = 'order' AND json_extract(props, '$.fecha_del_pedido') IS NULL
    AND (created_at LIKE '%T12:00:00.000Z' OR id < 900000000001);
