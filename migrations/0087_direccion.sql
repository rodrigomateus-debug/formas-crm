-- Inicio de Dirección (pedido de Rodrigo del 18/11/2026; src/worker/direccion.ts): los usuarios con esta marca ven en Inicio
-- un resumen de resultados de todo el equipo (aunque su perfil sea Ventas). Se da en Configuración → Usuarios.
-- Arrancan con la marca Rodrigo Mateus, Martín Lahitou y Wanda Seidl.
ALTER TABLE users ADD COLUMN direccion INTEGER NOT NULL DEFAULT 0;
UPDATE users SET direccion = 1 WHERE id IN (1, 2, 516929443);
