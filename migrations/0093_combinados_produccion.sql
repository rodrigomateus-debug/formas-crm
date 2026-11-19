-- Al combinar dos pedidos, el PDV de ClickUp quedaba atado al que se archivaba y dejaba de verse en Producción; tampoco
-- pasaban sus bocetos, remitos ni logos (corregido en records.ts). Acá se pasa lo de los que ya se combinaron (dos veces,
-- por si alguno se combinó en otro que después también se combinó). La etapa la corrige el repaso contra ClickUp
-- (scripts/revisar-clickup.mjs).
UPDATE produccion SET record_id = (SELECT merged_into FROM records WHERE id = produccion.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE produccion SET record_id = (SELECT merged_into FROM records WHERE id = produccion.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE produccion_cambios SET record_id = (SELECT merged_into FROM records WHERE id = produccion_cambios.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE produccion_cambios SET record_id = (SELECT merged_into FROM records WHERE id = produccion_cambios.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE bocetos SET record_id = (SELECT merged_into FROM records WHERE id = bocetos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE bocetos SET record_id = (SELECT merged_into FROM records WHERE id = bocetos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE remitos SET record_id = (SELECT merged_into FROM records WHERE id = remitos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE remitos SET record_id = (SELECT merged_into FROM records WHERE id = remitos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE logos SET record_id = (SELECT merged_into FROM records WHERE id = logos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE logos SET record_id = (SELECT merged_into FROM records WHERE id = logos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE clickup_salida SET record_id = (SELECT merged_into FROM records WHERE id = clickup_salida.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE producto_notas SET record_id = (SELECT merged_into FROM records WHERE id = producto_notas.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE OR IGNORE remito_pedidos SET record_id = (SELECT merged_into FROM records WHERE id = remito_pedidos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE OR IGNORE producto_logos SET record_id = (SELECT merged_into FROM records WHERE id = producto_logos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
