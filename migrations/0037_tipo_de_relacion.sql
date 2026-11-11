-- Tipo de relación de contactos y empresas (pedido de Rodrigo del 11/11/2026): para que los proveedores, el equipo de
-- Formas y otros no se mezclen con los clientes y prospectos. Vacío = cliente (relacion.ts). Las listas de contactos y
-- empresas muestran por defecto solo clientes y prospectos.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('contact', 'tipo_de_relacion', 'Tipo de relación', 'enum',
  '[{"value": "cliente", "label": "Cliente / prospecto"}, {"value": "proveedor", "label": "Proveedor"}, {"value": "equipo", "label": "Equipo Formas"}, {"value": "otro", "label": "Otro"}]',
  'Información del contacto', 'Vacío = cliente. Los proveedores, el equipo de Formas y los otros no aparecen en las listas por defecto. Si no tiene, hereda el de su empresa.', 12, 1, 0, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('company', 'tipo_de_relacion', 'Tipo de relación', 'enum',
  '[{"value": "cliente", "label": "Cliente / prospecto"}, {"value": "proveedor", "label": "Proveedor"}, {"value": "equipo", "label": "Equipo Formas"}, {"value": "otro", "label": "Otro"}]',
  'Información de la empresa', 'Vacío = cliente. Sus contactos lo heredan. Los proveedores, el equipo de Formas y los otros no aparecen en las listas por defecto.', 12, 1, 0, 0, 0);

-- Lo seguro, solo: las empresas que en HubSpot eran «Proveedor»; las de dominio de Formas; los contactos con mail de
-- Formas o de un usuario del CRM.
UPDATE records SET props = json_set(props, '$.tipo_de_relacion', 'proveedor')
WHERE object_type = 'company' AND json_extract(props, '$.type') = 'VENDOR' AND COALESCE(json_extract(props, '$.tipo_de_relacion'), '') = '';
UPDATE records SET props = json_set(props, '$.tipo_de_relacion', 'equipo')
WHERE object_type = 'company' AND COALESCE(json_extract(props, '$.tipo_de_relacion'), '') = ''
  AND lower(COALESCE(domain, '')) IN ('formaspublicitarias.com', 'formas.ar', 'soutex.com.ar');
UPDATE records SET props = json_set(props, '$.tipo_de_relacion', 'equipo')
WHERE object_type = 'contact' AND COALESCE(json_extract(props, '$.tipo_de_relacion'), '') = ''
  AND (lower(substr(COALESCE(email, ''), instr(COALESCE(email, ''), '@') + 1)) IN ('formaspublicitarias.com', 'formas.ar', 'soutex.com.ar')
    OR lower(COALESCE(email, '')) IN (SELECT lower(email) FROM users));
-- Los contactos sin tipo heredan el de su empresa principal.
UPDATE records SET props = json_set(props, '$.tipo_de_relacion', (
    SELECT json_extract(e.props, '$.tipo_de_relacion') FROM associations a JOIN records e ON e.id = a.to_id
    WHERE a.from_id = records.id AND a.to_type = 'company' AND a.is_primary = 1
      AND json_extract(e.props, '$.tipo_de_relacion') IN ('proveedor', 'equipo', 'otro') LIMIT 1))
WHERE object_type = 'contact' AND COALESCE(json_extract(props, '$.tipo_de_relacion'), '') = ''
  AND EXISTS (SELECT 1 FROM associations a JOIN records e ON e.id = a.to_id
    WHERE a.from_id = records.id AND a.to_type = 'company' AND a.is_primary = 1
      AND json_extract(e.props, '$.tipo_de_relacion') IN ('proveedor', 'equipo', 'otro'));

-- Pestañas para todos en Contactos y Empresas: «Proveedores» y «Equipo y otros» (a nombre del primer administrador).
INSERT INTO views (object_type, name, user_id, shared, config, display_order)
SELECT t.object_type, t.name, u.id, 1, t.config, 100 FROM (
  SELECT 'contact' AS object_type, 'Proveedores' AS name, '{"groups":[],"relacion":["proveedor"]}' AS config
  UNION ALL SELECT 'contact', 'Equipo y otros', '{"groups":[],"relacion":["equipo","otro"]}'
  UNION ALL SELECT 'company', 'Proveedores', '{"groups":[],"relacion":["proveedor"]}'
  UNION ALL SELECT 'company', 'Equipo y otros', '{"groups":[],"relacion":["equipo","otro"]}'
) t JOIN (SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1) u
WHERE NOT EXISTS (SELECT 1 FROM views v WHERE v.object_type = t.object_type AND v.name = t.name AND v.shared = 1);
