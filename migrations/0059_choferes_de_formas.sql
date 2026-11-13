-- Los choferes de Formas entran a la app del chofer con su usuario del Hub, sin link (pedido de Rodrigo del 13/11/2026).
-- Los de afuera siguen entrando con su link personal.

-- El chofer de la lista (Cronograma → Chofer) que es un usuario del Hub: así la app sabe qué recorrido es suyo, aunque en
-- el Hub su nombre esté escrito distinto.
ALTER TABLE transportistas ADD COLUMN user_id INTEGER REFERENCES users(id);

-- Lo que junta los remitos y lo que marca un chofer que entra con su usuario: es como un link (un token tipo «chofer»),
-- pero no se puede copiar ni mandar. `chofer_user_id`: el usuario del Hub de ese chofer.
ALTER TABLE api_tokens ADD COLUMN chofer_user_id INTEGER REFERENCES users(id);
