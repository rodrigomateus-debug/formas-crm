-- Logos del cliente (pedido de Rodrigo del 13/11/2026): el logo original «en curvas» (AI, EPS, CDR, SVG, PDF…) se guarda
-- una vez en la empresa y se usa en todos sus pedidos y negocios. El archivo vive en Drive (<empresa>/Logos); acá queda su
-- nombre, el formato, si es vectorial, si los textos están pasados a curvas y cuál es el principal.
CREATE TABLE IF NOT EXISTS logos (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES records(id),
  etiqueta TEXT,                                   -- «Color», «Negativo», «Isotipo»… (si no, el nombre del archivo)
  nombre TEXT NOT NULL,                            -- el nombre del archivo
  formato TEXT NOT NULL,                           -- ai, eps, cdr, svg, pdf, psd, png, jpg, webp, tif
  mime TEXT,
  size INTEGER,
  vectorial INTEGER NOT NULL DEFAULT 1,
  vista TEXT,                                      -- cómo se muestra en el CRM: pdf (también los AI compatibles), svg, imagen o nada
  curvas TEXT NOT NULL DEFAULT 'sin_verificar' CHECK (curvas IN ('ok', 'textos', 'sin_verificar', 'no_vectorial')),
  principal INTEGER NOT NULL DEFAULT 0,
  drive_id TEXT NOT NULL,
  drive_link TEXT,
  user_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS logos_company ON logos(company_id, archived);

-- Qué logo va en cada producto de un pedido o negocio (producto: la misma clave que en bocetos). Sin fila, va el principal.
CREATE TABLE IF NOT EXISTS producto_logos (
  record_id INTEGER NOT NULL,
  producto TEXT NOT NULL,
  logo_id INTEGER NOT NULL,
  user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (record_id, producto)
);

-- A qué tareas de ClickUp ya se adjuntó cada logo (junto con el boceto aprobado), para no adjuntarlo dos veces.
CREATE TABLE IF NOT EXISTS logos_clickup (
  logo_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  adjunto TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (logo_id, task_id)
);
