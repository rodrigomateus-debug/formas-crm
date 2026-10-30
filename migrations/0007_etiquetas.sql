-- Etiquetas de color con regla (las «Etiquetas de negocio» de HubSpot). Una etiqueta se pone sola a los negocios que
-- cumplen su regla (filtros Y/O, opcionalmente solo en algunos pipelines): no hay que cargarla a mano.
-- Las 7 de HubSpot, con la regla que muestran los datos (relevamiento del 30/10/2026): las de producto salen del
-- «Tipo de producto» en Corporate y NETWORKING del «Origen manual».
ALTER TABLE tags ADD COLUMN object_type TEXT NOT NULL DEFAULT 'deal';
ALTER TABLE tags ADD COLUMN rule TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tags ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE tags ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Producción Simple', '#2f7d32', 'deal', '{"groups": [[{"prop": "tipo_de_producto", "op": "in", "values": ["Producción simple"]}]], "pipelines": ["674405796"]}', 'Tipo de producto: Producción simple.', 0);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Productos Importados', '#1565c0', 'deal', '{"groups": [[{"prop": "tipo_de_producto", "op": "in", "values": ["Productos importados"]}]], "pipelines": ["674405796"]}', 'Tipo de producto: Productos importados.', 1);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Mix de Categorías', '#6a1b9a', 'deal', '{"groups": [[{"prop": "tipo_de_producto", "op": "in", "values": ["Mix de categorías"]}]], "pipelines": ["674405796"]}', 'Tipo de producto: Mix de categorías.', 2);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Desarrollos Especiales', '#c62828', 'deal', '{"groups": [[{"prop": "tipo_de_producto", "op": "in", "values": ["Desarrollos especiales"]}]], "pipelines": ["674405796"]}', 'Tipo de producto: Desarrollos especiales.', 3);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Importación Especial', '#ef6c00', 'deal', '{"groups": [[{"prop": "tipo_de_producto", "op": "in", "values": ["Importación especial"]}]], "pipelines": ["674405796"]}', 'Tipo de producto: Importación especial.', 4);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('Oportunidad Tier 3', '#5d4037', 'deal', '{"groups": [[{"prop": "tier_de_negocio", "op": "in", "values": ["Tier 3"]}]], "pipelines": ["674405796"]}', 'Aproximada: en HubSpot la pone un workflow y no coincide exacto con «Tier de negocio = Tier 3». Revisar la regla.', 5);
INSERT OR IGNORE INTO tags (name, color, object_type, rule, description, display_order) VALUES ('NETWORKING', '#00838f', 'deal', '{"groups": [[{"prop": "origen", "op": "in", "values": ["Networking"]}]], "pipelines": []}', 'El origen manual es Networking.', 6);
