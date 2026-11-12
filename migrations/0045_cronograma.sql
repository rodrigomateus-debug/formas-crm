-- Cronograma (pedido de Rodrigo del 12/11/2026): reemplaza la planilla «Cronograma Semanal» de Logística. Los movimientos
-- (entregas, ingresos, retiros y egresos) no se cargan: salen de las fechas de cada artículo en ClickUp, que ya están en
-- la tabla `produccion`. Acá va solo lo que ClickUp no tiene (cronograma.ts, docs/CRONOGRAMA.md).

-- Lo que se marcó como hecho (se retiró, se llevó al impresor, se entregó). Al marcarlo cambia el estado del artículo en
-- ClickUp; `estado_antes` es para poder desmarcarlo.
CREATE TABLE cronograma_hechos (
  task_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrega', 'ingreso', 'retiro_proveedor', 'egreso', 'retiro_impresor')),
  estado_antes TEXT,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, tipo)
);

-- Notas sueltas de un día, que no son de un artículo («llevar el sobre a Matienzo», una muestra, un trámite).
CREATE TABLE cronograma_notas (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,                 -- AAAA-MM-DD
  texto TEXT NOT NULL,
  hecho INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  hecho_por INTEGER REFERENCES users(id),
  hecho_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX cronograma_notas_fecha ON cronograma_notas(fecha);

-- Feriados: los días que no se trabaja. Se agregan y se sacan desde el cronograma.
CREATE TABLE feriados (
  fecha TEXT PRIMARY KEY,
  nombre TEXT NOT NULL
);
INSERT OR IGNORE INTO feriados (fecha, nombre) VALUES
  ('2026-11-23', 'Día de la Soberanía Nacional'), ('2026-12-07', 'Puente turístico'), ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad'), ('2027-01-01', 'Año Nuevo'), ('2027-03-24', 'Día de la Memoria'), ('2027-04-02', 'Día del Veterano de Malvinas'),
  ('2027-05-25', 'Revolución de Mayo'), ('2027-07-09', 'Día de la Independencia'), ('2027-12-08', 'Inmaculada Concepción');

-- Dónde queda cada dirección (para el mapa de la ruta). Se busca una sola vez por dirección; `manual` = alguien corrió
-- el punto en el mapa, y no se vuelve a buscar.
CREATE TABLE geocodigos (
  clave TEXT PRIMARY KEY,              -- la dirección normalizada
  direccion TEXT NOT NULL,
  lat REAL, lng REAL,
  ok INTEGER NOT NULL DEFAULT 0,       -- 1: se encontró
  manual INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Los recorridos de cada día: uno por chofer, con el orden de las paradas.
CREATE TABLE cronograma_rutas (
  fecha TEXT NOT NULL,
  n INTEGER NOT NULL,                  -- recorrido 1, 2…
  chofer TEXT,
  base TEXT,                           -- de dónde sale (Configuración del cronograma)
  salida INTEGER NOT NULL DEFAULT 510, -- minutos desde las 0:00
  orden TEXT NOT NULL DEFAULT '[]',    -- las claves de las paradas, en orden
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (fecha, n)
);

-- La dirección de entrega del pedido contra las últimas entregas al mismo cliente (los remitos leídos): si Claude ve que
-- son lugares distintos, queda la sugerencia hasta que alguien la acepta o la descarta.
CREATE TABLE direcciones_revisadas (
  record_id INTEGER PRIMARY KEY REFERENCES records(id),
  firma TEXT NOT NULL,                 -- lo que se comparó: si cambia, se revisa de nuevo
  distinta INTEGER NOT NULL DEFAULT 0,
  sugerida TEXT,
  motivo TEXT,
  resuelta INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- La dirección de entrega que trae el pedido de venta de Finnegans: se consulta una vez por pedido (también queda anotado
-- si no trae ninguna, para no volver a preguntar).
CREATE TABLE direcciones_finnegans (
  record_id INTEGER PRIMARY KEY REFERENCES records(id),
  direccion TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required) VALUES
  ('order', 'direccion_entrega', 'Dirección de entrega', 'string', '[]', 'Entrega',
    'Dónde se entrega este pedido. Si está vacía se usa la del pedido en Finnegans.', 1001, 1, 0, 0, 0),
  ('order', 'direccion_entrega_finnegans', 'Dirección de entrega (Finnegans)', 'string', '[]', 'Entrega',
    'La que figura en el pedido de venta de Finnegans.', 1002, 1, 1, 0, 0),
  ('company', 'horario_recepcion', 'Horario de recepción', 'string', '[]', 'Información de la empresa',
    'En qué horario recibe o entrega mercadería, por ejemplo «9 a 13». El cronograma avisa si la ruta llega fuera de ese horario.', 14, 1, 0, 0, 0);

-- Lo que el chofer marcó en cada parada desde la app (cronograma.ts, web/chofer/src/Ruta.tsx): la hizo, no se pudo (con
-- el motivo) o la salteó para más tarde. Una por parada y por día: vale la última.
CREATE TABLE cronograma_visitas (
  fecha TEXT NOT NULL,
  clave TEXT NOT NULL,                 -- la parada
  resultado TEXT NOT NULL CHECK (resultado IN ('hecho', 'no_se_pudo', 'salteada')),
  motivo TEXT,                         -- nadie | cerrado | direccion | rechazo | no_listo | otro
  nota TEXT,
  chofer TEXT,
  token_id INTEGER,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (fecha, clave)
);
