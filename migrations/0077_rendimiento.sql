-- Rendimiento de los choferes (pedido de Rodrigo del 17/11/2026; rendimiento.ts, docs/RENDIMIENTO.md): qué recorrido hizo
-- cada chofer cada día, en km y en tiempo, para después sacar promedios por chofer y costo por km.

-- Un recorrido de un día, medido. El plan es una foto de cómo estaba cuando el chofer salió (o al cerrar el día, si nadie
-- avisó la salida): Logística lo puede cambiar durante el día y así queda con qué comparar.
CREATE TABLE recorridos_medidos (
  fecha TEXT NOT NULL,
  n INTEGER NOT NULL,                  -- el recorrido de ese día (cronograma_rutas)
  chofer TEXT NOT NULL,
  plan TEXT,                           -- JSON: de dónde sale, dónde termina, la hora y las paradas en orden
  plan_at TEXT,
  plan_km REAL, plan_min REAL, plan_paradas INTEGER,
  -- La salida y la llegada: del GPS de la app (se alejó del punto de salida / volvió), del botón («Salgo», «Terminé»), de
  -- la marca de la última parada (si el recorrido termina ahí), estimadas con la primera y la última parada, o corregidas a
  -- mano por Logística.
  salida_at TEXT, salida_origen TEXT CHECK (salida_origen IN ('gps', 'boton', 'estimada', 'manual')),
  salida_lat REAL, salida_lng REAL,
  llegada_at TEXT, llegada_origen TEXT CHECK (llegada_origen IN ('gps', 'boton', 'marca', 'estimada', 'manual')),
  llegada_lat REAL, llegada_lng REAL,
  km REAL,                             -- por calles, pasando por las paradas que hizo en el orden en que las marcó
  min_manejo REAL,                     -- lo que tarda ese camino con la calle libre (referencia)
  hechas INTEGER, no_se_pudo INTEGER, sin_visitar INTEGER,
  estimado INTEGER NOT NULL DEFAULT 0, -- 1: algún tramo en línea recta (sin servicio de rutas) o una parada sin ubicar
  detalle TEXT,                        -- JSON: cada parada con su hora, cómo quedó y los km del tramo
  cerrado_at TEXT,                     -- el día ya pasó y se cerró
  corregido_por INTEGER REFERENCES users(id), corregido_at TEXT,
  PRIMARY KEY (fecha, n)
);
CREATE INDEX recorridos_medidos_chofer ON recorridos_medidos (chofer, fecha);

-- Los días que ya se cerraron (también los que no tuvieron ningún recorrido con chofer, para no volver a mirarlos).
CREATE TABLE rendimiento_dias (fecha TEXT PRIMARY KEY, cerrado_at TEXT NOT NULL, recorridos INTEGER NOT NULL DEFAULT 0);

-- Lo que contestó el servicio de rutas para un camino (los puntos en orden): no se vuelve a pedir.
CREATE TABLE caminos (clave TEXT PRIMARY KEY, tramos TEXT NOT NULL, at TEXT NOT NULL);

-- Dónde estaba el chofer al marcar cada parada (si dio permiso de ubicación).
ALTER TABLE cronograma_visitas ADD COLUMN lat REAL;
ALTER TABLE cronograma_visitas ADD COLUMN lng REAL;

-- El vehículo es de Formas (1) o del chofer, que es externo (0): para comparar propios contra externos.
ALTER TABLE transportistas ADD COLUMN propio INTEGER NOT NULL DEFAULT 0;
