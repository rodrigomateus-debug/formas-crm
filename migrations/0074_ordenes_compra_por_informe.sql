-- Las órdenes de compra se leen del informe ANALISISORDENESCOMPRA de Finnegans (ordenescompra.ts), no pedido por pedido:
-- la tabla de lecturas por pedido ya no hace falta. Índice para reemplazar las OC de cada corrida.
DROP TABLE IF EXISTS ordenes_compra_lecturas;
CREATE INDEX IF NOT EXISTS ordenes_compra_ie ON ordenes_compra(ie);
