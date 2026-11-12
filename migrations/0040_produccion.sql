-- Producción en el CRM (pedido de Rodrigo del 12/11/2026): la vista con la que trabaja producción en ClickUp («Estado PDV
-- CECI»: el PDV con sus artículos abiertos abajo), en el CRM y editable. Arranca con Formas Shop (Ceci y Sole); Corporate
-- sigue en ClickUp. ClickUp sigue siendo la fuente de verdad: lo que se edita en el CRM se escribe en ClickUp en el
-- momento, y lo que cambia en ClickUp llega con la sincronización de cada 10 minutos (produccion.ts).

-- Una fila por tarea de la lista PEC: el PDV (es_pdv = 1) y cada uno de sus artículos (sus subtareas).
CREATE TABLE produccion (
  task_id TEXT PRIMARY KEY,
  pdv_task TEXT NOT NULL,             -- la tarea del PDV (en el PDV, la misma)
  es_pdv INTEGER NOT NULL DEFAULT 0,
  record_id INTEGER,                  -- el pedido del CRM (por el link del PDV); Mercado Libre no tiene
  nombre TEXT NOT NULL DEFAULT '',
  npdv TEXT,
  estado TEXT NOT NULL DEFAULT '',    -- estado de la tarea en ClickUp («en el impresor», «listo para entergar»…)
  unidad TEXT,                        -- FORMAS SHOP | CORPORATE | NO ESTRÉS | MERCADO LIBRE
  cliente TEXT,
  vendedor TEXT,
  cantidad REAL,
  cantidad_controlada REAL,
  proveedor TEXT,                     -- id de la opción del desplegable PROVEEDOR de ClickUp
  impresor TEXT,                      -- id de la opción del desplegable IMPRESOR de ClickUp
  entrega_real TEXT,                  -- ENTREGAS (FECHA REAL), AAAA-MM-DD
  ingreso_proveedor TEXT,             -- INGRESO (PROVEEDOR): llega del proveedor
  retiro_proveedor TEXT,              -- RETIROS (PROVEEDOR): se retira del proveedor
  egreso_impresor TEXT,               -- EGRESO (IMPRESOR): va al impresor
  retiro_impresor TEXT,               -- RETIRO (IMPRESOR): se retira del impresor
  vence TEXT,                         -- fecha límite de la tarea (due_date), AAAA-MM-DD
  asignados TEXT NOT NULL DEFAULT '[]',   -- ids de ClickUp de quienes la tienen asignada (clickup_personas)
  etiquetas TEXT NOT NULL DEFAULT '[]',
  orden INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  actualizado INTEGER NOT NULL DEFAULT 0,   -- date_updated de ClickUp (ms): no se pisa con algo más viejo
  leido_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX produccion_pdv ON produccion(pdv_task);
CREATE INDEX produccion_record ON produccion(record_id);

-- Las opciones de los desplegables PROVEEDOR e IMPRESOR de ClickUp, cada una atada a su empresa del CRM (tipo de relación
-- «Proveedor»). Las repetidas («FYR SA» y «FYRSA») van a la misma empresa; las que no son empresas («STOCK», «SIN LOGO»,
-- «IMPRESOR A DEFINIR») quedan sin empresa.
CREATE TABLE produccion_opciones (
  campo TEXT NOT NULL CHECK (campo IN ('proveedor', 'impresor')),
  option_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  color TEXT,
  orden INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER,
  vinculada INTEGER NOT NULL DEFAULT 0,   -- 1: ya se buscó (o creó) su empresa
  PRIMARY KEY (campo, option_id)
);
CREATE INDEX produccion_opciones_empresa ON produccion_opciones(company_id);

-- La gente de ClickUp que aparece asignada (Ceci, Sole…), con su usuario del CRM si lo tiene (por mail o por nombre).
CREATE TABLE clickup_personas (
  clickup_id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT,
  foto TEXT,
  iniciales TEXT,
  color TEXT,
  user_id INTEGER
);

-- Qué provee cada empresa proveedora: artículos (PROVEEDOR de ClickUp), impresión (IMPRESOR) o las dos cosas.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('company', 'proveedor_de', 'Proveedor de', 'multienum',
  '[{"value": "articulos", "label": "Artículos (proveedor)"}, {"value": "impresion", "label": "Impresión (impresor)"}]',
  'Información de la empresa', 'Para los proveedores: si da artículos, impresión o las dos cosas. Lo completa la vista de Producción con los desplegables de ClickUp.', 13, 1, 0, 0, 0);
