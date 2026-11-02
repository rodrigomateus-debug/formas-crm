-- Perfiles (pedido de Rodrigo del 02/11/2026): qué área es cada usuario. Admin ve y puede todo; Comercial, Producción y
-- Logística por ahora también ven todo, y más adelante cada uno va a ver lo suyo. Los permisos (editar, borrar, solo mirar)
-- siguen en role. Un admin tiene perfil admin y viceversa (lo mantiene la API).
ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT 'comercial' CHECK (profile IN ('admin', 'comercial', 'produccion', 'logistica'));
UPDATE users SET profile = 'admin' WHERE role = 'admin';
