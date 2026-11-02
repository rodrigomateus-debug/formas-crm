-- Productos de cada pedido (pedido de Rodrigo del 02/11/2026): los renglones del pedido de venta de Finnegans (cantidad
-- y precio) y la ficha de cada producto (nombre, descripción y foto). Se traen de Finnegans al abrir el pedido y quedan
-- guardados; se vuelven a pedir cada 6 horas (los renglones) o cada 30 días (la ficha del producto). Solo lectura.
CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  code TEXT,
  description TEXT,
  quantity REAL,
  unit_price REAL,
  discount REAL NOT NULL DEFAULT 0,
  tax_included INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  source TEXT NOT NULL DEFAULT 'finnegans',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_line_items_record ON line_items(record_id, position);

-- Cuándo se leyeron por última vez los productos de cada pedido (y si hubo un error).
CREATE TABLE IF NOT EXISTS line_item_sync (
  record_id INTEGER PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS products (
  code TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  image_url TEXT,
  checked_at TEXT NOT NULL
);
