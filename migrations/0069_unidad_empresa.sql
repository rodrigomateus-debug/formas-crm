-- Unidad de negocio de las empresas editable (pedido de Rodrigo del 16/11/2026). Antes salía solo del equipo del
-- propietario, y todas las empresas de alguien con dos equipos mostraban las dos unidades. Ahora, en este orden: la que se
-- carga a mano (este campo, varias a la vez); si no tiene, la de sus compras en Finnegans (unidad_finnegans); si tampoco,
-- la del equipo del propietario. Los contactos heredan la de su empresa principal (records.ts, unidadEmpresaSql).
INSERT INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('company', 'unidades_de_negocio', 'Unidades de negocio', 'multienum',
  '[{"value": "shop", "label": "Formas Shop"}, {"value": "corporate", "label": "Corporate"}, {"value": "noestres", "label": "NoEstres"}]',
  'Información de la empresa', 'A mano. Si queda vacío, se usa la unidad de sus compras en Finnegans y, si no compró, la del equipo del propietario. Sus contactos la heredan.', 13, 1, 0, 0, 0)
ON CONFLICT (object_type, name) DO UPDATE SET label = excluded.label, type = excluded.type, options = excluded.options,
  group_name = excluded.group_name, description = excluded.description, system = 1, read_only = 0, archived = 0;

-- La de las compras no se llama igual, para no confundirlas.
UPDATE properties SET label = 'Unidad de negocio de sus compras'
WHERE object_type = 'company' AND name = 'unidad_finnegans';
