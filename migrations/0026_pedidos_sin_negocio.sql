-- «Negocios asociados» también en los pedidos (pedido de Rodrigo del 07/11/2026): un pedido va en un solo negocio, y los
-- que no tienen se filtran con «Sin negocio» en la lista de pedidos, para control. Se calcula al consultar (records.ts).
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('order', 'num_associated_deals', 'Negocios asociados', 'number', '[]', 'Actividad',
    'Un pedido va en un solo negocio: 0 es un pedido sin negocio.', 1002, 1, 1, 0, 0);
