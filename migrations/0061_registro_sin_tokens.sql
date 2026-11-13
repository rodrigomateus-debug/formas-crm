-- Los avisos de prueba de Finnegans del 13/11/2026 quedaron en el registro de entradas con el token que Finnegans manda
-- en la dirección y en el cuerpo. Desde ahora el receptor los quita antes de guardar (hooks.ts); acá se limpian esos.
UPDATE inbound_log SET payload = '(aviso de prueba de Finnegans; se quitó porque traía un token de Finnegans)'
  WHERE source = 'finnegans' AND (payload LIKE '%access_token=%' OR payload LIKE '%"token"%');
