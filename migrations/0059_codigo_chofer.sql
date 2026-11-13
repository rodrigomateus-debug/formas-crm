-- La app del chofer: cada chofer entra escribiendo su código (8 números), una sola vez: después queda guardado en el
-- celular (pedido de Rodrigo del 13/11/2026). Los choferes no tienen mail de Formas para entrar con un usuario, y
-- pegar un link largo les cuesta. El código es otra forma de su link: dar de baja el link también lo da de baja.
ALTER TABLE api_tokens ADD COLUMN codigo TEXT;
CREATE UNIQUE INDEX api_tokens_codigo ON api_tokens(codigo) WHERE codigo IS NOT NULL;

-- Los intentos de entrar con un código que no existe, para frenar a quien prueba códigos al azar (se borran solos a la
-- hora).
CREATE TABLE chofer_intentos (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX chofer_intentos_ip ON chofer_intentos(ip, at);
