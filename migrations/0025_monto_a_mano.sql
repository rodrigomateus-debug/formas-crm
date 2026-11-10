-- El monto del negocio sigue al total de sus pedidos (src/worker/montos.ts, pedido de Rodrigo del 07/11/2026). Para los
-- casos raros en que no corresponde (parte del negocio se facturó por otro lado, un pedido que no es de este negocio…),
-- «Monto a mano» deja el monto como lo cargó la vendedora.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('deal', 'monto_a_mano', 'Monto a mano', 'bool', '[]', 'Información del negocio',
    'Si está marcado, el monto no se actualiza con el total de los pedidos del negocio.', 4, 1, 0, 0, 0);
