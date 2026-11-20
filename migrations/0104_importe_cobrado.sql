-- Lo cobrado de cada pedido, sin IVA (aviso de Rodrigo del 20/11/2026: el PDV 31748 figuraba como que ya había pagado el
-- 17 %, y no había pagado nada; era el IVA). Lo calcula scripts/pedidos-totales.mjs con Finnegans: de cada factura del
-- pedido, su neto menos lo que falta cobrar de ella. Con esto el saldo dice si es total o parcial, en lugar de restarlo del
-- total del pedido.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('order', 'importe_cobrado', 'Cobrado', 'currency', '[]', 'Pedido',
    'Lo que ya se cobró del pedido, sin IVA (Finnegans, cada hora): de cada factura, lo facturado menos lo que falta cobrar de ella.', 25, 1, 1, 0, 0);
