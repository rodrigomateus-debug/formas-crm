-- Dónde termina cada recorrido del cronograma (pedido de Rodrigo del 13/11/2026): a veces sale de un lugar y no vuelve
-- ahí. `fin`: NULL vuelve a donde salió; el id de un depósito de Formas; 'ultima' termina en la última parada (no vuelve
-- a ningún lado); 'otro' termina en otro lugar, con su nombre y su dirección.
ALTER TABLE cronograma_rutas ADD COLUMN fin TEXT;
ALTER TABLE cronograma_rutas ADD COLUMN fin_nombre TEXT;
ALTER TABLE cronograma_rutas ADD COLUMN fin_direccion TEXT;
