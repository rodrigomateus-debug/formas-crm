-- Gerencia (pedido de Rodrigo del 18/11/2026; src/worker/alcance.ts): una vendedora gerenta de un equipo ve y edita todo lo
-- de ese equipo (lo de sus vendedoras, los negocios de sus pipelines y los pedidos de su unidad). Se elige en
-- Configuración → Usuarios. Wanda Seidl es la gerenta de Corporate (Grandes Cuentas).
ALTER TABLE users ADD COLUMN gerencia_team INTEGER REFERENCES teams(id);
UPDATE users SET gerencia_team = 58079782 WHERE id = 516929443;
