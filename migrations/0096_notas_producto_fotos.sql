-- Notas de producto con varias fotos (pedido de Rodrigo del 19/11/2026): hasta ahora cada nota tenía una sola foto en
-- producto_notas (foto_drive_id, foto_mime, foto_nombre). Ahora van en esta tabla, en el orden en que se cargaron, y se
-- pueden agregar o sacar después. Las columnas viejas quedan sin usar. Ver notasproducto.ts.
CREATE TABLE producto_nota_fotos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id INTEGER NOT NULL,          -- producto_notas.id
  drive_id TEXT NOT NULL,            -- en Drive (Notas de productos/<SKU>)
  mime TEXT,
  nombre TEXT,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  borrada_at TEXT                    -- sacada de la nota (el archivo queda en Drive)
);
CREATE INDEX producto_nota_fotos_nota ON producto_nota_fotos(nota_id);

-- La foto que ya tenía cada nota pasa a ser la primera.
INSERT INTO producto_nota_fotos (nota_id, drive_id, mime, nombre, user_id, created_at)
  SELECT id, foto_drive_id, foto_mime, foto_nombre, user_id, created_at FROM producto_notas WHERE foto_drive_id IS NOT NULL ORDER BY id;
