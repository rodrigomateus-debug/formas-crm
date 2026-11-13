-- Renglones que no son productos sino cobros (pedido de Rodrigo del 13/11/2026): envío, setup de logo, servicios de arte,
-- adicionales, diferencias de precio… En Finnegans van con su propio código («Costo de Envío», «Setup Logo») o con el
-- comodín 1161 «Artículos varios». Venían como un producto más: pedían logo y boceto, contaban como artículo de producción
-- y dejaban el PDV en «Entregado parcial» o en «Ingreso de pedido» por un adicional que nadie produce ni entrega.
--
-- Cada código tiene su tipo: 'servicio' si el rubro de su ficha en Finnegans es de servicios (Servicios de Arte, de
-- Logística, Otros servicios) o si está en la lista de códigos de cobro (servicios.ts); el resto, 'producto'.
ALTER TABLE products ADD COLUMN rubro TEXT;
ALTER TABLE products ADD COLUMN tipo TEXT NOT NULL DEFAULT 'producto';

-- Los que se usaron en pedidos desde 2024 (revisión del histórico de Finnegans del 13/11/2026). La ficha se vuelve a leer.
INSERT INTO products (code, tipo, checked_at)
SELECT value, 'servicio', '2000-01-01T00:00:00.000Z' FROM json_each('["1161","1113","1170","ML_SHIPPING","3009","2008","1218","2001","ZZ_FP_LOGO_MIN","ZZ_FP_LOGO24","SA2103","SA2104","SA2105"]') WHERE true
ON CONFLICT(code) DO UPDATE SET tipo = 'servicio';

-- El tipo de un renglón en un pedido puntual, cuando un administrador lo cambia: «Artículos varios» casi siempre es un
-- adicional, pero a veces es mercadería (500 reglas escolares). Va por pedido y código, así cambiarlo en un pedido no lo
-- cambia en los demás; los renglones se borran y se vuelven a leer de Finnegans, por eso no va en line_items.
CREATE TABLE IF NOT EXISTS line_item_tipos (
  record_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('producto', 'servicio')),
  user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, code)
);
