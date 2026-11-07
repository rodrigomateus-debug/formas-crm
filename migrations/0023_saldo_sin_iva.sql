-- Saldo pendiente y por facturar, sin IVA (Rodrigo, 7/11/2026: «trabajamos con números sin IVA»).
UPDATE properties SET description = 'Lo que falta cobrar del pedido, sin IVA (Finnegans, cada hora): lo facturado que no se cobró más lo que falta facturar.'
WHERE object_type = 'order' AND name = 'saldo_pendiente_de_pago_mxn';
UPDATE properties SET description = 'Lo que falta facturar del pedido, sin IVA (Finnegans, cada hora): todo si no tiene factura, o lo que todavía no se remitió ni facturó.'
WHERE object_type = 'order' AND name = 'importe_por_facturar';
