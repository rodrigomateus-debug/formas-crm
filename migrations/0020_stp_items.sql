-- Los productos de la cotización del STP de cada pedido, con su nombre, sus cantidades y la foto que eligió la vendedora
-- (pedido de Rodrigo del 6/11/2026). Sirven para darle foto a los renglones de Finnegans que no tienen el SKU del STP: los
-- cargados con un código genérico («PICPS_GE_6000», con el producto en la descripción) se cruzan por nombre y, si no, por
-- cantidad. Las carga scripts/stp-imagenes.mjs; cada envío reemplaza los de los pedidos que trae.
CREATE TABLE IF NOT EXISTS stp_items (
  pedido TEXT NOT NULL,
  pos INTEGER NOT NULL,
  sku TEXT NOT NULL,
  nombre TEXT NOT NULL DEFAULT '',
  cantidades TEXT NOT NULL DEFAULT '[]',   -- JSON: las cantidades cotizadas de ese producto
  image_url TEXT NOT NULL,
  PRIMARY KEY (pedido, pos)
);
