-- Pedidos conectados con ClickUp (pedido de Rodrigo del 30/10/2026).
-- 1. Estados generales para las comerciales: la vendedora solo pasa de «Pedido confirmado» a «Listo para producción»;
--    el resto lo mueve ClickUp (lista PEC) según el estado de los artículos. Se conservan los ids de HubSpot que siguen y
--    los estados que se juntan pasan al general que corresponde.
UPDATE properties SET options = '[{"value": "4b27b500-f031-4927-9811-68a0b525cbae", "label": "Pedido confirmado"}, {"value": "3725360f-519b-4b18-a593-494d60a29c9f", "label": "Listo para producción"}, {"value": "esperando_boceto", "label": "Esperando boceto o confirmación"}, {"value": "1237498994", "label": "En producción"}, {"value": "1237498996", "label": "Listo para entregar"}, {"value": "entregado_parcial", "label": "Entregado parcial"}, {"value": "1237498998", "label": "Entregado"}, {"value": "3c85a297-e9ce-400b-b42e-9f16853d69d6", "label": "Anulado"}]', description = 'Lo mueve ClickUp. La vendedora solo lo pasa de «Pedido confirmado» a «Listo para producción».'
WHERE object_type = 'order' AND name = 'hs_pipeline_stage';
UPDATE records SET props = json_set(props, '$.hs_pipeline_stage', '4b27b500-f031-4927-9811-68a0b525cbae') WHERE object_type = 'order' AND json_extract(props, '$.hs_pipeline_stage') = '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03';
UPDATE records SET props = json_set(props, '$.hs_pipeline_stage', 'esperando_boceto') WHERE object_type = 'order' AND json_extract(props, '$.hs_pipeline_stage') = 'aa99e8d0-c1d5-4071-b915-d240bbb1aed9';
UPDATE records SET props = json_set(props, '$.hs_pipeline_stage', '1237498994') WHERE object_type = 'order' AND json_extract(props, '$.hs_pipeline_stage') = '1250237623';
UPDATE records SET props = json_set(props, '$.hs_pipeline_stage', '1237498996') WHERE object_type = 'order' AND json_extract(props, '$.hs_pipeline_stage') = '1237498995';
UPDATE records SET props = json_set(props, '$.hs_pipeline_stage', '1237498996') WHERE object_type = 'order' AND json_extract(props, '$.hs_pipeline_stage') = '1237498997';
-- 2. Lo que trae cada PDV de ClickUp.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'unidad_de_negocio', 'Unidad de negocio', 'enum', '[{"value": "FORMAS SHOP", "label": "FORMAS SHOP"}, {"value": "CORPORATE", "label": "CORPORATE"}, {"value": "NO ESTRÉS", "label": "NO ESTRÉS"}]', 'Pedido', '', 5, 1, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'cliente_clickup', 'Cliente (ClickUp)', 'string', '[]', 'Pedido', '', 6, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'pedido_finnegans', 'Pedido en Finnegans', 'string', '[]', 'Pedido', '', 7, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'url_clickup', 'PDV en ClickUp', 'url', '[]', 'Pedido', '', 8, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'detalle_produccion', 'Detalle de producción', 'text', '[]', 'Pedido', '', 9, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'entregado_el', 'Entregado el', 'date', '[]', 'Pedido', '', 26, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'factura_numero', 'Factura', 'string', '[]', 'Pedido', '', 27, 1, 1, 0, 0);
-- 3. Archivos de cada registro: la factura (Finnegans, con su PDF) y el remito (la foto que suben a ClickUp al entregar).
-- El PDF de la factura se guarda acá; el remito se trae de ClickUp cada vez que se abre (son fotos de hasta 3 MB).
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),
  kind TEXT NOT NULL,              -- 'factura', 'remito', 'archivo'
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  source TEXT NOT NULL,            -- 'finnegans', 'clickup', 'crm'
  source_ref TEXT NOT NULL,        -- factura: su IdentificacionExterna; remito: <tarea>:<adjunto> de ClickUp
  meta TEXT NOT NULL DEFAULT '{}', -- número, fecha, CAE, empresa…
  data BLOB,                       -- el PDF, cuando ya se bajó
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, source_ref, record_id)
);
CREATE INDEX files_record ON files(record_id);
