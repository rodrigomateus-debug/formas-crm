-- El total de los pedidos es sin IVA (neto del pedido de venta de Finnegans, scripts/pedidos-totales.mjs).
UPDATE properties SET label = 'Total sin IVA', description = 'Neto del pedido de venta en Finnegans, sin IVA. Se actualiza solo desde Finnegans.'
  WHERE object_type = 'order' AND name = 'hs_total_price';
