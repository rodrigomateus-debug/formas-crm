-- Al combinar dos registros, la conversación del que se archivaba no pasaba al que quedaba (corregido en records.ts): el
-- mail de una mención llevaba a un pedido sin mensajes. Acá se pasan las de los que ya se combinaron (dos veces, por si
-- alguno se combinó en otro que después también se combinó).
UPDATE mensajes SET record_id = (SELECT merged_into FROM records WHERE id = mensajes.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE mensajes SET record_id = (SELECT merged_into FROM records WHERE id = mensajes.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE mensaje_adjuntos SET record_id = (SELECT merged_into FROM records WHERE id = mensaje_adjuntos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE mensaje_adjuntos SET record_id = (SELECT merged_into FROM records WHERE id = mensaje_adjuntos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE OR IGNORE conversacion_participantes SET record_id = (SELECT merged_into FROM records WHERE id = conversacion_participantes.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE OR IGNORE conversacion_participantes SET record_id = (SELECT merged_into FROM records WHERE id = conversacion_participantes.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
DELETE FROM conversacion_participantes WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE avisos SET record_id = (SELECT merged_into FROM records WHERE id = avisos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
UPDATE avisos SET record_id = (SELECT merged_into FROM records WHERE id = avisos.record_id)
  WHERE record_id IN (SELECT id FROM records WHERE merged_into IS NOT NULL);
