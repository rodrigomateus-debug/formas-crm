-- Motivo de cierre perdido de los negocios: solo estos 7 (pedido de Rodrigo del 10/11/2026), en este orden. Salen
-- «No hay stock», «Calidad», «Producto inexistente», «Nunca respondió», «Pospuesto para más adelante», «Eligió otra
-- propuesta» y cualquier otra que haya sumado la sincronización con HubSpot (que ya no suma opciones a esta lista).
-- Si alguna de las 7 se renombró desde Configuración, conserva su nombre. Los negocios que ya tienen otro motivo lo
-- conservan (se sigue viendo en la ficha); solo deja de ofrecerse.
UPDATE properties SET options = (
  WITH m(pos, v, l) AS (VALUES
    (1, 'Demora en la entrega de la cotización', 'Cotización (demora)'),
    (2, 'Demora en tiempo de producción', 'Tiempos de producción (demora)'),
    (3, 'Precio', 'Precio del producto'),
    (4, 'Producto', 'Producto (calidad, stock, modelo, etc.)'),
    (5, 'Sin respuesta', 'No contesta'),
    (6, 'Se dió de baja', 'No se hizo'),
    (7, 'No Califica', 'No Califica'))
  SELECT json_group_array(json(o)) FROM (
    SELECT COALESCE((SELECT value FROM json_each(properties.options) WHERE json_extract(value, '$.value') = m.v LIMIT 1),
      json_object('value', m.v, 'label', m.l)) AS o
    FROM m ORDER BY m.pos
  )
)
WHERE object_type = 'deal' AND name = 'motivo_de_cierre_perdido';
