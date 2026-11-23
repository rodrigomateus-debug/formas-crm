-- Qué ve cada usuario (pedido de Rodrigo del 20/11/2026: «que se pueda elegir qué ve cada usuario: solo lo suyo, lo de
-- todos o elegir de qué usuarios; Carmen debería poder ver lo suyo, lo de Mili y lo de Sonia»). Se elige en
-- Configuración → Usuarios → Qué ve (src/worker/alcance.ts). Vale para los perfiles Comercial y Back office.
--   ve: 'suyo' (lo de siempre) o 'todos' (para ver; editar sigue siendo lo suyo).
--   ve_usuarios: además, lo de estas personas (JSON con sus ids): para ver o, con el perfil Back office, también para editar.
ALTER TABLE users ADD COLUMN ve TEXT NOT NULL DEFAULT 'suyo';
ALTER TABLE users ADD COLUMN ve_usuarios TEXT NOT NULL DEFAULT '[]';

-- Varios perfiles y el perfil Back office (misma fecha: «hacer un perfil de back office y poder tener más de un perfil: Carmen
-- tendría back office y ventas»). `perfiles` es la lista (JSON), el primero el principal; NULL: el de `profile`. `profile`
-- queda por compatibilidad y por su CHECK (no conoce Back office): el principal, con Back office como comercial. Con Back
-- office, las personas de ve_usuarios son las que atiende: lo de ellas lo ve, lo edita, se lo asigna y lo carga a su nombre.
ALTER TABLE users ADD COLUMN perfiles TEXT;

-- Carmen Donoso: Comercial y Back office de Mili Formosa y de Sonia Andersen.
UPDATE users SET ve_usuarios = '[494686419, 1286986496]', perfiles = '["comercial", "backoffice"]' WHERE id = 224301829 AND profile = 'comercial';
