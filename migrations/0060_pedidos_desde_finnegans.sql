-- Negocio ↔ pedido ↔ Finnegans (pedido de Rodrigo del 13/11/2026). El circuito: el negocio se confirma, el pedido se
-- carga desde el cotizador, queda en Finnegans y de Finnegans va a ClickUp. Hasta ahora el pedido entraba al CRM recién
-- cuando ClickUp creaba el PDV, y la relación con el negocio se hacía a mano.
--
-- 1. El N° de PDV en el negocio: se pide (opcional) al pasar a «Pasos operativos» o, en Corporate, a «Cierre ganado».
--    Con ese número el pedido queda asociado al negocio: en el momento si ya está en el CRM, o cuando llega (vinculos.ts).
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('deal', 'pdv_finnegans', 'N° de PDV', 'string', '[]', 'Información del negocio',
  'El número del pedido de venta en Finnegans (el que da el cotizador al cargar el pedido). Con él, el pedido queda asociado a este negocio.', 30, 1, 0, 0, 0);
-- stages.config.ask_props: lo que la etapa pide al entrar sin ser obligatorio (se puede seguir sin completarlo).
UPDATE stages SET config = json_set(config, '$.ask_props', json_array('pdv_finnegans'))
  WHERE (lower(label) = 'pasos operativos' OR id = '989921336') AND json_extract(config, '$.ask_props') IS NULL;

-- 2. Las facturas con CAE que avisa el informe de cada hora (scripts/pedidos-totales.mjs) y todavía no están adjuntas al
--    pedido. La sincronización lee solo esos pedidos, en vez de recorrer todos cada media hora (40 consultas a Finnegans
--    por corrida, unas 58.000 por mes; Finnegans cobra por cantidad de consultas).
CREATE TABLE IF NOT EXISTS facturas_pendientes (
  record_id INTEGER NOT NULL,
  ie TEXT NOT NULL,                       -- la identificación de la factura en Finnegans («FC PEDVTASTP-00031601 1»)
  intentos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, ie)
);

-- 3. La razón social con la que se factura cada pedido (pedido de Rodrigo del 13/11/2026). Una empresa del CRM puede
--    facturar con varias razones sociales (cada una con su CUIT); cada CUIT es de una sola empresa. El pedido guarda la
--    razón social y el CUIT que trae de Finnegans, y con eso se encuentra su empresa (razones.ts).
CREATE TABLE IF NOT EXISTS razones_sociales (
  cuit TEXT PRIMARY KEY,                  -- solo los números
  razon TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  origen TEXT,                            -- 'empresa' (su CUIT), 'negocio' (por la empresa del negocio), 'a mano', 'finnegans'
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS razones_sociales_empresa ON razones_sociales(company_id);
-- Las empresas que ya tienen su CUIT cargado: esa es su primera razón social.
INSERT OR IGNORE INTO razones_sociales (cuit, razon, company_id, origen)
SELECT replace(replace(replace(json_extract(props, '$.cuit'), '-', ''), ' ', ''), '.', ''), COALESCE(NULLIF(TRIM(json_extract(props, '$.razon_social')), ''), name), id, 'empresa'
  FROM records WHERE object_type = 'company' AND archived = 0
    AND length(replace(replace(replace(COALESCE(json_extract(props, '$.cuit'), ''), '-', ''), ' ', ''), '.', '')) = 11
  ORDER BY id;
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('order', 'razon_social', 'Razón social', 'string', '[]', 'Pedido', 'La razón social con la que se cargó el pedido en Finnegans (a quién se le factura).', 40, 1, 1, 0, 0),
       ('order', 'cuit', 'CUIT', 'string', '[]', 'Pedido', 'El CUIT de esa razón social, de Finnegans.', 41, 1, 1, 0, 0);
