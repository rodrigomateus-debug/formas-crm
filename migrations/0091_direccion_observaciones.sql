-- Observaciones de entrega (pedido de Rodrigo del 18/11/2026): además del detalle de la dirección (piso, depto, puerta,
-- unidad), lo que tiene que saber el chofer al llegar («tocar timbre de recepción», «entrar por el portón de atrás»). Se
-- cargan al corregir la dirección desde la tarjeta del cronograma y se ven en la tarjeta, en la Ruta del día y en la app
-- del chofer. En las empresas (proveedores e impresores) van en la ficha: `direccion_detalle` y `observaciones_entrega`.
ALTER TABLE entrega_direcciones ADD COLUMN observaciones TEXT;

INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required) VALUES
  ('company', 'direccion_detalle', 'Piso, depto, puerta o unidad', 'string', '[]', 'Información de la empresa',
    'Lo que completa la dirección: piso, depto, puerta, unidad, nave. Lo ve el chofer en la parada.', 15, 1, 0, 0, 0),
  ('company', 'observaciones_entrega', 'Observaciones de entrega', 'string', '[]', 'Información de la empresa',
    'Lo que tiene que saber el chofer al llegar («tocar timbre de recepción», «entrar por el portón de atrás»).', 16, 1, 0, 0, 0);
