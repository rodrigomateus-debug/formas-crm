-- Dos etapas antes de «Listo para producción» (pedido de Rodrigo del 10/11/2026), para que las vendedoras y el backoffice
-- sigan de su lado la parte previa a la producción. Las mueven a mano, como «Listo para producción»; ClickUp no las toca.
--   «$ Pendiente de Anticipo»: solo Formas Shop y No Estrés (lo controla records.ts).
--   «Pendiente Boceto Digital»: Formas Shop, No Estrés y Corporate.
-- Conservan los ids que tenían en HubSpot (en 0008 se habían juntado con otras etapas), así el historial viejo se lee.
-- Se agregan justo antes de «Listo para producción» sin tocar las demás opciones (si alguna se renombró desde
-- Configuración, queda como está). Si ya estaban, se reemplazan por estas en el mismo lugar.
UPDATE properties SET options = (
  SELECT json_group_array(json(o)) FROM (
    SELECT o FROM (
      SELECT value AS o, CAST(key AS REAL) AS pos FROM json_each(properties.options)
        WHERE json_extract(value, '$.value') NOT IN ('937ea84d-0a4f-4dcf-9028-3f9c2aafbf03', 'aa99e8d0-c1d5-4071-b915-d240bbb1aed9')
      UNION ALL
      SELECT json_object('value', '937ea84d-0a4f-4dcf-9028-3f9c2aafbf03', 'label', '$ Pendiente de Anticipo'),
        COALESCE((SELECT key FROM json_each(properties.options) WHERE json_extract(value, '$.value') = '3725360f-519b-4b18-a593-494d60a29c9f'), 1) - 0.2
      UNION ALL
      SELECT json_object('value', 'aa99e8d0-c1d5-4071-b915-d240bbb1aed9', 'label', 'Pendiente Boceto Digital'),
        COALESCE((SELECT key FROM json_each(properties.options) WHERE json_extract(value, '$.value') = '3725360f-519b-4b18-a593-494d60a29c9f'), 1) - 0.1
    ) ORDER BY pos
  )
), description = 'Lo mueve ClickUp. Las vendedoras y el backoffice lo mueven a mano antes de producción: «Pedido confirmado», «$ Pendiente de Anticipo» (Formas Shop y No Estrés), «Pendiente Boceto Digital» y «Listo para producción».'
WHERE object_type = 'order' AND name = 'hs_pipeline_stage';
