-- Recorridos (pedido de Rodrigo del 13/11/2026): reemplaza la planilla «Recorridos» de Logística, donde vendedoras,
-- backoffice y producción cargan lo que el chofer tiene que llevar o retirar un día (muestras, sobres, mercadería), y
-- unifica los destinos: la libreta de direcciones pasa a ser del Hub (recorridos.ts, docs/RECORRIDOS.md).

-- ---------- Destinos: la libreta es del Hub ----------
-- Hasta ahora la libreta se borraba y se volvía a copiar entera de la planilla todos los días, así que nada podía
-- apuntar a un lugar. Ahora cada lugar tiene su id para siempre: la copia de la planilla suma los nuevos y actualiza los
-- que ya estaban (por nombre y dirección, `clave_planilla`), los que se crean en el Hub quedan, y lo que se corrigió en el
-- Hub (`editado`) la planilla ya no lo pisa. Los que la planilla sacó quedan inactivos (los encargos viejos los siguen
-- nombrando).
ALTER TABLE lugares ADD COLUMN origen TEXT NOT NULL DEFAULT 'planilla';   -- 'planilla' | 'hub'
ALTER TABLE lugares ADD COLUMN clave_planilla TEXT;                       -- nombre|dirección normalizados
ALTER TABLE lugares ADD COLUMN editado INTEGER NOT NULL DEFAULT 0;        -- 1: se cambió en el Hub
ALTER TABLE lugares ADD COLUMN activo INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lugares ADD COLUMN company_id INTEGER;                        -- la empresa del CRM que es este lugar, si es una
ALTER TABLE lugares ADD COLUMN visto INTEGER;                             -- la copia de la planilla que lo trajo por última vez
ALTER TABLE lugares ADD COLUMN created_by INTEGER;
ALTER TABLE lugares ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX lugares_planilla ON lugares(clave_planilla);
CREATE INDEX lugares_empresa ON lugares(company_id);
-- La copia de antes no tenía la clave: se vuelve a copiar de cero (pasa sola la próxima vez que se usa la libreta).
DELETE FROM lugares_claves;
DELETE FROM lugares;
UPDATE settings SET value = json_set(value, '$.at', 0, '$.filas', 0) WHERE key = 'lugares';

-- ---------- Encargos: lo que alguien le pide al recorrido de un día ----------
-- Una fila de la planilla: a dónde, qué se lleva y qué se retira, para qué día y quién lo pidió. En el cronograma va
-- junto con lo de ClickUp, en la parada de ese lugar (si ese día ya se va ahí, se suma a esa parada).
CREATE TABLE encargos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,                       -- AAAA-MM-DD
  user_id INTEGER REFERENCES users(id),      -- quién lo pidió
  pedido_por TEXT,                           -- el nombre como estaba en la planilla, si no es un usuario del Hub
  lugar_id INTEGER REFERENCES lugares(id),   -- el destino, si está en la libreta
  company_id INTEGER,                        -- la empresa del CRM (cliente, proveedor o impresor), si el destino es una
  destino TEXT NOT NULL,                     -- el nombre del destino, como se eligió
  direccion TEXT,
  llevar TEXT NOT NULL DEFAULT '[]',         -- [{ cant, que, pdv }]: lo que se deja
  retirar TEXT NOT NULL DEFAULT '[]',        -- [{ cant, que, pdv }]: lo que se retira
  desde TEXT,                                -- dónde está lo que se lleva (id de un depósito de Formas)
  hacia TEXT,                                -- a dónde va lo que se retira (id de un depósito de Formas)
  horario TEXT,                              -- «luego del mediodía», «10 a 16»
  contacto TEXT,                             -- a quién preguntar, con su teléfono
  notas TEXT,
  urgente INTEGER NOT NULL DEFAULT 0,        -- tiene que ir sí o sí ese día
  record_id INTEGER,                         -- el pedido o el negocio al que corresponde, si se eligió
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'hecho', 'no_se_pudo', 'cancelado')),
  motivo TEXT,                               -- por qué no se pudo o por qué se canceló
  hecho_por INTEGER, hecho_chofer TEXT, hecho_at TEXT,
  remito INTEGER,                            -- número del remito de traslado, cuando se imprimió
  origen TEXT NOT NULL DEFAULT 'hub',        -- 'hub' | 'planilla' (historial importado)
  planilla_clave TEXT,                       -- para no importar dos veces la misma fila de la planilla
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by INTEGER
);
CREATE INDEX encargos_fecha ON encargos(fecha, estado);
CREATE INDEX encargos_usuario ON encargos(user_id, fecha);
CREATE INDEX encargos_lugar ON encargos(lugar_id, fecha);
CREATE INDEX encargos_empresa ON encargos(company_id, fecha);
CREATE UNIQUE INDEX encargos_planilla ON encargos(planilla_clave);

-- Avisos de la campanita sobre un encargo (se hizo, no se pudo, Logística lo pasó a otro día o lo canceló).
ALTER TABLE avisos ADD COLUMN encargo_id INTEGER;
ALTER TABLE avisos ADD COLUMN detalle TEXT;                 -- qué pasó, en una frase («No se pudo: estaba cerrado»)

-- El remito de traslado (el informal, con la marca de Formas): el número sigue el de la planilla.
INSERT OR IGNORE INTO settings (key, value) VALUES ('recorridos', '{"remito_pv":"0001","remito_ultimo":98575}');
