-- Compras de cada cliente desde Finnegans (pedido de Rodrigo del 3/11/2026): estado del cliente según la lógica del
-- tablero, última compra, compra histórica en dólares MEP, ticket promedio, saldo y vencido. Los calcula cada noche
-- scripts/clientes.mjs (GitHub Actions) y los aplica /hooks/clientes/aplicar. Son de solo lectura.
CREATE TABLE compras_historicas (
  fecha TEXT NOT NULL,
  cuit TEXT,
  cliente TEXT NOT NULL,
  tipo TEXT NOT NULL,      -- Factura | Nota de crédito | Nota de débito | Anticipo
  neto REAL NOT NULL       -- sin IVA, en pesos
);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'estado_cliente', 'Estado del cliente', 'enum', '[{"value": "Nuevo", "label": "Nuevo"}, {"value": "Activo", "label": "Activo"}, {"value": "Recuperado", "label": "Recuperado"}, {"value": "En riesgo", "label": "En riesgo"}, {"value": "Perdido", "label": "Perdido"}, {"value": "Dormido", "label": "Dormido"}]', 'Compras', 'Se calcula solo cada noche con las compras de Finnegans (pedidos de venta, sin Mercado Libre ni MarketShell). Nuevo: primera compra en los últimos 12 meses. Recuperado: volvió a comprar después de más de 12 meses sin comprar. Activo: compró en los últimos 12 meses. En riesgo: compra seguido y lleva más de 90 días o 2,5 veces su ritmo sin comprar. Perdido: no compra hace más de 12 meses (pero sí en los 12 anteriores). Dormido: no compra hace más de 2 años.', 900, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'fecha_ultima_compra', 'Última compra', 'date', '[]', 'Compras', 'Fecha del último pedido de venta en Finnegans.', 901, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'fecha_primera_compra', 'Primera compra', 'date', '[]', 'Compras', 'Desde 2020 (facturas del libro de IVA) y pedidos de Finnegans desde 2023.', 902, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'cantidad_de_compras', 'Cantidad de compras', 'number', '[]', 'Compras', 'Pedidos de venta (y facturas antes de 2023).', 903, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'compra_historica_usd', 'Compra histórica (US$ MEP)', 'currency', '[]', 'Compras', 'Neto sin IVA, cada compra al dólar MEP de su día.', 904, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'compra_12m_usd', 'Compra últimos 12 meses (US$ MEP)', 'currency', '[]', 'Compras', 'Neto sin IVA, cada compra al dólar MEP de su día.', 905, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'ticket_promedio_usd', 'Ticket promedio (US$ MEP)', 'currency', '[]', 'Compras', 'Compra histórica dividida por la cantidad de compras.', 906, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'cada_cuanto_compra', 'Compra cada (días)', 'number', '[]', 'Compras', 'Mediana de los días entre una compra y la siguiente.', 907, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'saldo_pendiente', 'Saldo pendiente', 'currency', '[]', 'Compras', 'Lo que debe hoy en cuenta corriente, con IVA (Finnegans).', 908, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'saldo_vencido', 'Saldo vencido', 'currency', '[]', 'Compras', 'La parte del saldo que ya venció, con IVA.', 909, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'vendedora_finnegans', 'Vendedora en Finnegans', 'string', '[]', 'Compras', 'Quién le vendió más en los últimos 12 meses (o en su última compra).', 910, 1, 1, 0, 0);
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
  VALUES ('company', 'unidad_finnegans', 'Unidad de negocio', 'string', '[]', 'Compras', 'Corporate, Formas Shop o NoEstres, según sus pedidos.', 911, 1, 1, 0, 0);
