-- Imágenes de los productos desde el registro de cotizaciones del STP (pedido de Rodrigo del 6/11/2026): la que eligió la
-- vendedora al cotizar, por pedido de Finnegans y SKU (`pedido` = 'PEDVTASTP - 31277'), y la última de cada SKU
-- (`pedido` = ''). Las carga scripts/stp-imagenes.mjs; las usan los productos del pedido y las miniaturas del tablero.
CREATE TABLE IF NOT EXISTS stp_imagenes (
  pedido TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL,
  image_url TEXT NOT NULL,
  PRIMARY KEY (pedido, sku)
);
