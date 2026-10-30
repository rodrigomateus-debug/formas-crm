-- Lo que relevamos en el HubSpot de Formas (30/10/2026):
-- 1. Pedidos: las propiedades que muestran la tarjeta y la vista previa de HubSpot (tipo, fecha de entrega, PDV…).
-- 2. Negocios: «Último contacto» (se calcula solo) para la «Tarjeta Inbound».
-- 3. Formas Shop (Inbound): la tarjeta del tablero y «Acerca de» como en HubSpot, si nadie los configuró todavía.
-- 4. Vistas compartidas con un equipo (Corporate, Formas Shop, NOESTRES), además de «solo yo» y «todo el equipo».
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'tipo_de_pedido', 'Tipo de pedido', 'enum', '[{"value": "PEDIDO NORMAL", "label": "PEDIDO NORMAL"}, {"value": "EVENTO", "label": "EVENTO"}]', 'Pedido', '', 20, 0, 0, 1, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'fecha_de_entrega', 'Fecha de entrega', 'date', '[]', 'Pedido', '', 21, 0, 0, 1, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'url_pdv_finnegans', 'URL PDV Finnegans', 'url', '[]', 'Pedido', '', 22, 0, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'saldo_pendiente_de_pago_mxn', 'Saldo pendiente de pago (ARS)', 'currency', '[]', 'Pedido', '', 23, 0, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'progreso_pdv', 'Progreso PDV', 'number', '[]', 'Pedido', '', 24, 0, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'items_entregados', 'Ítems entregados', 'string', '[]', 'Pedido', '', 25, 0, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('deal', 'notes_last_contacted', 'Último contacto', 'datetime', '[]', 'Actividad', '', 1002, 1, 1, 0, 0);
UPDATE pipelines SET config = json_set(COALESCE(config, '{}'), '$.card_props', json('["amount","createdate","fecha_pospuesta"]'))
WHERE id = 'default' AND json_extract(COALESCE(config, '{}'), '$.card_props') IS NULL;
UPDATE pipelines SET config = json_set(COALESCE(config, '{}'), '$.key_props', json('["link_a_darwin","producto","cantidad","eventos_especiales","notes_last_contacted","origen","owner_id"]'))
WHERE id = 'default' AND json_extract(COALESCE(config, '{}'), '$.key_props') IS NULL;
ALTER TABLE views ADD COLUMN team_id INTEGER REFERENCES teams(id);
