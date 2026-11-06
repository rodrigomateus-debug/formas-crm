-- Foto de cada usuario: la de su cuenta de Google (src/worker/fotos.ts). Se guarda el link y cuándo se revisó por última vez.
ALTER TABLE users ADD COLUMN photo_url TEXT;
ALTER TABLE users ADD COLUMN photo_checked_at TEXT;
