-- Superadmin (pedido de Rodrigo del 12/11/2026): un administrador que además puede mirar el CRM como si fuera otro usuario
-- («Ver como», desde su misma sesión y solo para mirar) y dar o sacar este permiso a otros administradores.
-- El administrador principal (ADMIN_EMAIL) lo es siempre, sin marca; esta columna es para sumar a otros.
ALTER TABLE users ADD COLUMN superadmin INTEGER NOT NULL DEFAULT 0;
