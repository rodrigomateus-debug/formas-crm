-- Los pedidos de FP DEMO (la empresa de pruebas de Finnegans) también entran al CRM, aparte de los de verdad
-- (pedidosfin.ts): su unidad de negocio es «FP DEMO».
UPDATE properties SET options = json_insert(options, '$[#]', json_object('value', 'FP DEMO', 'label', 'FP DEMO'))
  WHERE object_type = 'order' AND name = 'unidad_de_negocio'
    AND NOT EXISTS (SELECT 1 FROM json_each(properties.options) WHERE json_extract(value, '$.value') = 'FP DEMO');
