-- Costo del logo de cada producto del pedido (pedido de Rodrigo del 17/11/2026): lo que se tomó para el logo en la
-- cotización del STP, por unidad, para que Producción sepa con cuánto cuenta. Sale de dos exports del STP
-- (scripts/stp-costos-logo.mjs): «cotizaciones_modo_costos» (LOGOS y SETUP que cargó la vendedora, desde septiembre de
-- 2026) y, si el producto no está ahí, «pedidos_sku_formas» (COSTO EXTRA y SETUP PRORRATEADO). Cada envío reemplaza los
-- de los pedidos que trae. Ver costoslogo.ts y docs/PRODUCCION.md.
CREATE TABLE IF NOT EXISTS stp_costos_logo (
  pedido TEXT NOT NULL,              -- el PDV de Finnegans, como «PEDVTASTP - 31277»
  pos INTEGER NOT NULL,
  sku TEXT NOT NULL,
  nombre TEXT NOT NULL DEFAULT '',
  cantidad REAL,
  logo REAL NOT NULL DEFAULT 0,      -- costo del logo por unidad
  setup REAL NOT NULL DEFAULT 0,     -- setup prorrateado por unidad
  fuente TEXT NOT NULL,              -- 'costos' (modo costos) o 'pedido' (pedidos_sku_formas)
  PRIMARY KEY (pedido, pos)
);
