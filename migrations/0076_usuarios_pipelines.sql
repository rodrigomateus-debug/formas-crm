-- Pipelines de negocios que ve cada usuario, elegidos en Configuración → Usuarios (pedido de Rodrigo del 17/11/2026).
-- JSON con los ids (["default", "123"]). NULL: lo de siempre, según sus equipos (visible_teams de cada pipeline).
-- Los administradores ven todos igual.
ALTER TABLE users ADD COLUMN pipelines TEXT;
