-- Qué ve cada usuario (pedido de Rodrigo del 20/11/2026: «que se pueda elegir qué ve cada usuario: solo lo suyo, lo de
-- todos o elegir de qué usuarios; Carmen debería poder ver lo suyo, lo de Mili y lo de Sonia»). Se elige en
-- Configuración → Usuarios → Qué ve (src/worker/alcance.ts). Vale para el perfil Comercial; es solo para ver: editar sigue
-- siendo lo suyo (y lo de su equipo si es gerenta).
--   ve: 'suyo' (lo de siempre), 'equipo' (lo de quienes comparten alguno de sus equipos) o 'todos'.
--   ve_usuarios: además, lo de estas personas (JSON con sus ids).
ALTER TABLE users ADD COLUMN ve TEXT NOT NULL DEFAULT 'suyo';
ALTER TABLE users ADD COLUMN ve_usuarios TEXT NOT NULL DEFAULT '[]';
-- Carmen Donoso ve, además de lo suyo, lo de Mili Formosa y lo de Sonia Andersen.
UPDATE users SET ve_usuarios = '[494686419, 1286986496]' WHERE id = 224301829;
