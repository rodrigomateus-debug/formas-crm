-- Lo que falta facturar de cada pedido, con IVA (pedido de Rodrigo del 7/11/2026: si no está facturado, todo es saldo
-- pendiente). Lo calcula scripts/pedidos-totales.mjs con Finnegans; el saldo pendiente lo suma.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('order', 'importe_por_facturar', 'Por facturar', 'currency', '[]', 'Pedido',
    'Lo que falta facturar del pedido, con IVA (Finnegans, cada hora): todo si no tiene factura, o lo que todavía no se remitió ni facturó.', 24, 1, 1, 0, 0);
UPDATE properties SET description = 'Lo que falta cobrar del pedido, con IVA (Finnegans, cada hora): lo facturado que no se cobró más lo que falta facturar.'
WHERE object_type = 'order' AND name = 'saldo_pendiente_de_pago_mxn';
