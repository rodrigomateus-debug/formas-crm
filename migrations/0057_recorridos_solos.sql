-- El chofer también se elige desde la tarjeta de la semana del cronograma (pedido de Rodrigo del 13/11/2026).

-- Un recorrido que nadie ordenó a mano en la Ruta del día (lo armaron las tarjetas, o todavía nadie lo tocó) se sigue
-- ordenando solo por el recorrido más corto, también en la app del chofer. Queda «a mano» cuando alguien mueve sus
-- paradas en la Ruta del día. Los que ya están guardados los armó alguien en la Ruta: quedan como estaban.
ALTER TABLE cronograma_rutas ADD COLUMN a_mano INTEGER NOT NULL DEFAULT 1;
