-- Archivos en los mensajes de la conversación (pedido de Rodrigo del 12/11/2026): además de imágenes, PDF (que se ven en
-- el CRM), planillas, documentos, ZIP o archivos de diseño, de hasta 20 MB. Una fila de D1 no puede pasar de 2 MB, así
-- que el archivo se guarda en pedazos: el primero en mensaje_adjuntos.data y el resto acá, en orden.
CREATE TABLE IF NOT EXISTS mensaje_adjunto_partes (
  adjunto_id INTEGER NOT NULL REFERENCES mensaje_adjuntos(id),
  n INTEGER NOT NULL,          -- 1, 2, 3… (el 0 es mensaje_adjuntos.data)
  data BLOB NOT NULL,
  PRIMARY KEY (adjunto_id, n)
);
