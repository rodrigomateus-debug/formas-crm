-- Entrega en varias direcciones (Rodrigo, 19/11/2026): cada lugar con su nombre («Central», «Sucursal Santa Fe», «Depósito
-- de stock») y su anotación propia, con quién la escribió. Las generales del cliente van en las anotaciones de logística.
ALTER TABLE entrega_direcciones ADD COLUMN nombre TEXT;
ALTER TABLE entrega_direcciones ADD COLUMN obs_user_id INTEGER;
ALTER TABLE entrega_direcciones ADD COLUMN obs_at TEXT;
