-- Destinos rediseñados (pedido de Rodrigo del 18/11/2026): la libreta pasa a ser una base de destinos cuidada.
-- - Empresa y sucursales separadas: `destino_grupos` junta los destinos de una misma empresa (casa central, depósito,
--   sucursales); cada destino es una dirección.
-- - Tipo de destino (cliente, proveedor, impresor, taller, expreso, otro) y de dónde salió (`tipo_origen`: 'manual',
--   'crm', 'expreso', 'nombre', 'ia'): lo que se pone a mano no lo pisa nada.
-- - Dirección en partes (calle y altura en `direccion`, localidad, provincia, código postal) y el lugar de Google Maps.
-- - Contacto de cada destino: nombre, teléfono, WhatsApp y mail.
CREATE TABLE destino_grupos (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT,
  company_id INTEGER,
  created_by INTEGER,
  updated_at TEXT
);
ALTER TABLE lugares ADD COLUMN tipo TEXT;
ALTER TABLE lugares ADD COLUMN tipo_origen TEXT;
ALTER TABLE lugares ADD COLUMN grupo_id INTEGER;
ALTER TABLE lugares ADD COLUMN sucursal TEXT;
ALTER TABLE lugares ADD COLUMN whatsapp TEXT;
ALTER TABLE lugares ADD COLUMN email TEXT;
ALTER TABLE lugares ADD COLUMN codigo_postal TEXT;
ALTER TABLE lugares ADD COLUMN place_id TEXT;
CREATE INDEX lugares_grupo ON lugares(grupo_id);
