-- Productos de los pedidos (4/11/2026): si Finnegans no trae los renglones, van los artículos del PDV de ClickUp.
ALTER TABLE line_items ADD COLUMN name TEXT;      -- el producto según ClickUp (cuando no hay ficha de Finnegans)
ALTER TABLE line_items ADD COLUMN status TEXT;    -- estado de producción del artículo en ClickUp
ALTER TABLE line_item_sync ADD COLUMN source TEXT; -- de dónde salieron: finnegans | clickup

-- Los PDV más viejos no tienen la línea «Pedido:» y se guardaba la «Fecha pedido» como número de pedido. El pedido es el
-- tipo de documento de su unidad con el número del PDV (verificado contra Finnegans: 48 de 50).
UPDATE records SET props = json_set(props, '$.pedido_finnegans',
    CASE upper(json_extract(props, '$.unidad_de_negocio')) WHEN 'CORPORATE' THEN 'PEDVTAFP' WHEN 'FORMAS SHOP' THEN 'PEDVTASTP' ELSE 'PEDVTANE' END
    || ' - ' || CAST(json_extract(props, '$.pdv_finnegans') AS TEXT))
  WHERE object_type = 'order' AND json_extract(props, '$.pedido_finnegans') GLOB '[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]'
    AND json_extract(props, '$.pdv_finnegans') IS NOT NULL;

-- Los pedidos que quedaron sin productos se vuelven a leer al abrirlos (ahora con ClickUp de respaldo).
DELETE FROM line_item_sync WHERE record_id NOT IN (SELECT DISTINCT record_id FROM line_items);
