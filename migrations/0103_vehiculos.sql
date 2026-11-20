-- La camioneta de cada chofer (pedido de Rodrigo del 20/11/2026), en la pantalla Choferes: el modelo, el tamaño, una foto
-- y cuántas cajas entran (de 40x30 y de 60x40, las que más se usan). Con eso la Ruta del día avisa si los bultos de un
-- recorrido no entran en la camioneta de su chofer (cajas combinadas: web/src/bultos.ts).
-- Va por el nombre del chofer, normalizado (sin mayúsculas, tildes ni espacios de más), igual que se le asignan los
-- recorridos: así sirve aunque se le cree un código nuevo.
CREATE TABLE IF NOT EXISTS cronograma_vehiculos (
  chofer TEXT PRIMARY KEY,             -- el nombre normalizado
  nombre TEXT NOT NULL,                -- como se escribe
  modelo TEXT,                         -- «Renault Kangoo»
  tamano TEXT,                         -- «Mediana», «Furgón grande»…
  cap_c40 INTEGER CHECK (cap_c40 IS NULL OR cap_c40 > 0),   -- cuántas cajas de 40x30 entran
  cap_c60 INTEGER CHECK (cap_c60 IS NULL OR cap_c60 > 0),   -- cuántas cajas de 60x40 entran
  foto BLOB,                           -- la foto, ya achicada en el navegador (hasta 900 KB)
  foto_mime TEXT,
  foto_at TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
