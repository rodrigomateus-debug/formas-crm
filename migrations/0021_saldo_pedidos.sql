-- Saldo pendiente de cada pedido desde Finnegans (pedido de Rodrigo del 6/11/2026): lo que falta cobrar de sus facturas,
-- con IVA, del informe de composición de saldos (scripts/pedidos-totales.mjs → /hooks/pedidos/saldos). Ya no se carga a
-- mano ni viene de HubSpot.
UPDATE properties SET label = 'Saldo pendiente de pago', read_only = 1, system = 1,
  description = 'Lo que falta cobrar de las facturas del pedido, con IVA (Finnegans, cada hora). Vacío: todavía sin facturar.'
WHERE object_type = 'order' AND name = 'saldo_pendiente_de_pago_mxn';
