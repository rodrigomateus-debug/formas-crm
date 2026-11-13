-- De qué parada del recorrido es la foto que mandó el chofer (pedido de Rodrigo del 13/11/2026): la clave de la parada
-- (p:<PDV>, o p:<PDV>:2 si el pedido va a varias direcciones). La manda la app cuando la cámara se abre desde la parada
-- («Entregué», «Dejé en el expreso: foto de la guía»), o el chofer la elige cuando la app le pregunta de qué entrega es.
-- Sirve para saber de qué entrega es la guía de un expreso, y el PDV de un remito que no lo dice.
ALTER TABLE remitos ADD COLUMN parada TEXT;
