-- «Conectar con Claude» (pedido de Rodrigo del 12/11/2026): cada usuario conecta su Claude con el CRM como se conecta
-- HubSpot o ClickUp, con OAuth (conectar.ts). En Claude se agrega el conector con la dirección del CRM; Claude lleva al
-- CRM, la persona toca «Permitir» y queda conectado con su usuario, sin copiar ningún token.

-- Los clientes OAuth que se registran solos (Claude se registra la primera vez, RFC 7591). Solo se aceptan direcciones de
-- vuelta de Claude (claude.ai, claude.com) o de la propia computadora (Claude Desktop y Claude Code).
CREATE TABLE IF NOT EXISTS oauth_clientes (
  client_id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,           -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Los códigos de autorización (10 minutos, se usan una sola vez; con PKCE).
CREATE TABLE IF NOT EXISTS oauth_codigos (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expira TEXT NOT NULL
);

-- El acceso que recibe Claude es un token del CRM más (api_tokens, tipo «mcp»), atado al cliente, con vencimiento y con
-- su token para renovarlo. Desconectar es revocarlo.
ALTER TABLE api_tokens ADD COLUMN client_id TEXT;
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE api_tokens ADD COLUMN refresh_hash TEXT;
ALTER TABLE api_tokens ADD COLUMN refresh_expira TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_refresh ON api_tokens(refresh_hash);
