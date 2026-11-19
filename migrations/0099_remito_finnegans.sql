-- Estados de despacho del cronograma (pedido de Logística, Rodrigo del 19/11/2026): «Remitido» es que el remito ya está
-- hecho en Finnegans. Se lee de Finnegans solo para los pedidos con productos listos y entrega cercana (finnegans.ts,
-- revisarRemitos), y queda en el pedido.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required) VALUES
  ('order', 'remito_finnegans', 'Remito en Finnegans', 'string', '[]', 'Pedido',
    'El remito del pedido en Finnegans (hecho desde el pedido o desde su factura). Lo lee el CRM para el cronograma.', 28, 1, 1, 0, 0),
  ('order', 'remito_finnegans_fecha', 'Fecha del remito', 'date', '[]', 'Pedido', '', 29, 1, 1, 0, 0);

-- Cuándo se le preguntó a Finnegans por el remito de cada pedido, para no preguntar de nuevo enseguida (Finnegans cobra
-- por cantidad de consultas).
CREATE TABLE IF NOT EXISTS finnegans_remitos_revision (
  record_id INTEGER PRIMARY KEY REFERENCES records(id),
  at TEXT NOT NULL
);
