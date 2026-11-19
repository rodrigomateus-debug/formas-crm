-- Orden de trabajo (pedido de Rodrigo del 19/11/2026): lo que Producción trabaja es un objeto propio, la «Orden de trabajo»
-- (OT), aparte del pedido de Ventas. Nace sola con el pedido (en «Pedido confirmado») y queda relacionada con él y con su
-- empresa, contactos y negocio. Funciona igual que el pedido: tiene su misma etapa (la de ClickUp) y sus mismos datos, que
-- copia sola de su pedido (src/worker/ordenes.ts). Ver docs/ORDENES.md.
-- Esta parte: el vínculo pedido ↔ OT, sus propiedades y las OT de los pedidos activos (0101 rearmó `records`).

-- El vínculo pedido ↔ orden de trabajo: uno a uno, con unicidad en la base (dos sincronizaciones a la vez no pueden crear
-- dos OT para el mismo pedido). Además están asociados como cualquier registro (associations), para verse en las fichas.
CREATE TABLE ot_pedido (
  pedido_id INTEGER PRIMARY KEY,
  ot_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sus propiedades: las mismas del pedido que sirven en producción, con los mismos nombres internos (así la etapa se ve
--    y se filtra igual), todas de solo lectura porque las copia del pedido. La etapa toma las opciones que tenga hoy la
--    del pedido; igual, al leerlas el Worker usa siempre las del pedido (meta.ts), así una etapa nueva vale para las dos.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES
  ('work_order', 'nombre_ot', 'Nombre de la orden de trabajo', 'string', '[]', 'Orden de trabajo', 'Sale del pedido: «OT 31167 · Cliente».', 0, 1, 1, 0, 1),
  ('work_order', 'pdv_finnegans', 'PDV Finnegans', 'string', '[]', 'Orden de trabajo', 'El del pedido.', 1, 1, 1, 0, 0),
  ('work_order', 'hs_pipeline_stage', 'Etapa', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'hs_pipeline_stage'), '[]'),
    'Orden de trabajo', 'La misma del pedido: la mueve ClickUp (antes de producción, la vendedora desde el pedido).', 2, 1, 1, 0, 0),
  ('work_order', 'owner_id', 'Vendedora', 'owner', '[]', 'Orden de trabajo', 'La propietaria del pedido.', 3, 1, 1, 0, 0),
  ('work_order', 'unidad_de_negocio', 'Unidad de negocio', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'unidad_de_negocio'), '[]'),
    'Orden de trabajo', '', 4, 1, 1, 0, 0),
  ('work_order', 'tipo_de_pedido', 'Tipo de pedido', 'enum',
    COALESCE((SELECT options FROM properties WHERE object_type = 'order' AND name = 'tipo_de_pedido'), '[]'),
    'Orden de trabajo', '', 5, 1, 1, 0, 0),
  ('work_order', 'fecha_de_entrega', 'Fecha de entrega', 'date', '[]', 'Orden de trabajo', 'La pactada: la del pedido de venta en Finnegans.', 6, 1, 1, 0, 0),
  ('work_order', 'fecha_pedido', 'Fecha del pedido', 'date', '[]', 'Orden de trabajo', 'La del pedido de venta en Finnegans.', 7, 1, 1, 0, 0),
  ('work_order', 'detalle_produccion', 'Detalle de producción', 'text', '[]', 'Orden de trabajo', '', 8, 1, 1, 0, 0),
  ('work_order', 'entregado_el', 'Entregado el', 'date', '[]', 'Orden de trabajo', '', 9, 1, 1, 0, 0),
  ('work_order', 'cliente_clickup', 'Cliente (ClickUp)', 'string', '[]', 'Orden de trabajo', '', 10, 1, 1, 0, 0),
  ('work_order', 'pedido_finnegans', 'Pedido en Finnegans', 'string', '[]', 'Orden de trabajo', '', 11, 1, 1, 0, 0),
  ('work_order', 'url_clickup', 'PDV en ClickUp', 'url', '[]', 'Orden de trabajo', '', 12, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES
  ('work_order', 'createdate', 'Fecha de creación', 'datetime', '[]', 'Actividad', '', 1000, 1, 1, 0, 0),
  ('work_order', 'notes_last_updated', 'Última actividad', 'datetime', '[]', 'Actividad', '', 1001, 1, 1, 0, 0),
  ('work_order', 'source', 'Origen del registro', 'string', '[]', 'Actividad', '', 1002, 1, 1, 0, 0);

-- Una OT para cada pedido activo con su PDV en ClickUp (pedido de Rodrigo del 19/11/2026): ni entregado ni anulado, y
--    con `url_clickup`. Quedan afuera los entregados, los anulados y los que quedaron colgados de HubSpot sin PDV. Los
--    pedidos nuevos nacen siempre con la suya (ordenes.ts). Los ids siguen la numeración propia del CRM.
INSERT INTO ot_pedido (pedido_id, ot_id)
SELECT o.id, MAX((SELECT MAX(id) FROM records), 900000000000) + ROW_NUMBER() OVER (ORDER BY o.id)
FROM records o
WHERE o.object_type = 'order' AND o.archived = 0
  AND COALESCE(json_extract(o.props, '$.url_clickup'), '') != ''
  AND COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '4b27b500-f031-4927-9811-68a0b525cbae')
    NOT IN ('1237498998', '3c85a297-e9ce-400b-b42e-9f16853d69d6');

-- El nombre sale del pedido: «PDV 31167 · Cliente» → «OT 31167 · Cliente». json_patch con un null saca la clave: quedan
-- solo los datos que el pedido tiene.
INSERT INTO records (id, object_type, name, props, owner_id, created_at, updated_at, created_by, source, source_detail)
SELECT t.ot_id, 'work_order', x.nombre,
  json_patch(json_object('nombre_ot', x.nombre, 'pedido_id', o.id), json_object(
    'pdv_finnegans', json_extract(o.props, '$.pdv_finnegans'),
    'hs_pipeline_stage', COALESCE(json_extract(o.props, '$.hs_pipeline_stage'), '4b27b500-f031-4927-9811-68a0b525cbae'),
    'owner_id', o.owner_id,
    'unidad_de_negocio', json_extract(o.props, '$.unidad_de_negocio'),
    'tipo_de_pedido', json_extract(o.props, '$.tipo_de_pedido'),
    'fecha_de_entrega', json_extract(o.props, '$.fecha_de_entrega'),
    'fecha_pedido', json_extract(o.props, '$.fecha_pedido'),
    'detalle_produccion', json_extract(o.props, '$.detalle_produccion'),
    'entregado_el', json_extract(o.props, '$.entregado_el'),
    'cliente_clickup', json_extract(o.props, '$.cliente_clickup'),
    'pedido_finnegans', json_extract(o.props, '$.pedido_finnegans'),
    'url_clickup', json_extract(o.props, '$.url_clickup'))),
  o.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'crm', 'orden de trabajo'
FROM ot_pedido t
JOIN records o ON o.id = t.pedido_id
JOIN (SELECT id, CASE WHEN trim(name) LIKE 'PDV %' THEN 'OT ' || substr(trim(name), 5) WHEN trim(name) = '' THEN 'OT · Pedido' ELSE 'OT · ' || trim(name) END AS nombre
      FROM records WHERE object_type = 'order') x ON x.id = o.id;

-- Pedido ↔ OT, en los dos sentidos (como toda asociación).
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'order', pedido_id, 'work_order', ot_id, NULL, 0 FROM ot_pedido;
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'work_order', ot_id, 'order', pedido_id, NULL, 0 FROM ot_pedido;
-- Y las mismas empresas, contactos y negocio que su pedido (con la empresa principal).
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT 'work_order', t.ot_id, a.to_type, a.to_id, a.label, a.is_primary
FROM ot_pedido t JOIN associations a ON a.from_id = t.pedido_id AND a.to_type IN ('company', 'contact', 'deal');
INSERT OR IGNORE INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
SELECT a.to_type, a.to_id, 'work_order', t.ot_id, a.label, a.is_primary
FROM ot_pedido t JOIN associations a ON a.from_id = t.pedido_id AND a.to_type IN ('company', 'contact', 'deal');

