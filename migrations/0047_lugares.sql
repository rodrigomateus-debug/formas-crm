-- Libreta de direcciones del Cronograma (pedido de Rodrigo del 12/11/2026): los lugares a los que se va siempre
-- (proveedores, impresores, depósitos y oficinas de clientes), con su dirección, horario, contacto y observaciones. Se
-- copia de la planilla de Logística publicada como CSV y se vuelve a copiar una vez por día (cronograma.ts).
CREATE TABLE lugares (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  direccion TEXT,                      -- como está en la planilla
  localidad TEXT,
  zona TEXT,
  horario TEXT,
  telefono TEXT,
  contacto TEXT,
  observaciones TEXT,
  coordinacion TEXT,                   -- cómo se coordina la entrega (turnos, seguros): solo para quien edita
  clave_dir TEXT                       -- calle y altura normalizadas, para reconocer una dirección
);
CREATE INDEX lugares_dir ON lugares(clave_dir);

-- Los nombres con los que se reconoce cada lugar («MAD / DIMILITO» es «mad» y «dimilito»; «ZECAT (DEPOSITO)» es «zecat»).
CREATE TABLE lugares_claves (
  clave TEXT NOT NULL,
  lugar_id INTEGER NOT NULL REFERENCES lugares(id) ON DELETE CASCADE,
  PRIMARY KEY (clave, lugar_id)
);

-- De dónde se copia. Se puede cambiar desde la ruta del día (administradores).
INSERT OR IGNORE INTO settings (key, value) VALUES ('lugares',
  '{"url":"https://docs.google.com/spreadsheets/d/e/2PACX-1vSpvMrAZyO_svZ-dVQqku6aFdhu3WB-YVNzuT41hTSnEMUtWt1uiHOV1uRLNf45RY8THqc_PLZsZ71w/pub?gid=183475770&single=true&output=csv","at":0,"filas":0}');
