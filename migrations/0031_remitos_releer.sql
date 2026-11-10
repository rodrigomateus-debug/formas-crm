-- Los remitos que no se pudieron leer porque la API de Claude rechazaba el formato de la respuesta («Schemas contains
-- too many parameters with type arrays or anyOf»: el esquema tenía 17 campos de dos tipos y el máximo es 16). Con el
-- esquema nuevo (remitos.ts) se vuelven a leer solos: se les borra la cuenta de intentos.
UPDATE remitos SET intentos = 0, motivo = 'Se vuelve a leer (falló el formato de la lectura).'
  WHERE estado = 'sin_leer' AND motivo LIKE 'No se pudo leer:%';
