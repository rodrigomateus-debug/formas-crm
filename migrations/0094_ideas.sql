-- Buzón de ideas (pedido de Rodrigo del 19/11/2026): Chispín, el personaje de abajo a la derecha del Hub, junta las propuestas de
-- mejora de todos. Cualquiera propone y vota las de los demás; las más votadas van primero; los administradores las van
-- haciendo y las marcan («en marcha», «hecha» o «no va», con una respuesta). Ver src/worker/ideas.ts y docs/IDEAS.md.
CREATE TABLE ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  texto TEXT NOT NULL,
  user_id INTEGER NOT NULL,          -- quién la propuso
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_curso', 'hecha', 'descartada')),
  respuesta TEXT,                    -- lo que contesta quien la hace («Listo, está en Pedidos → Filtros»)
  estado_at TEXT,                    -- cuándo pasó al estado actual
  estado_por INTEGER,                -- quién la pasó
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT,
  borrada_at TEXT                    -- borrada por quien la escribió (mientras está pendiente) o un administrador
);
CREATE INDEX ideas_estado ON ideas(estado) WHERE borrada_at IS NULL;

-- Un voto por persona e idea. Quien la propone la vota al crearla (puede sacarse el voto como cualquiera).
CREATE TABLE idea_votos (
  idea_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (idea_id, user_id)
);

-- Los avisos de la campanita (kind 'idea_nueva', 'idea_en_curso', 'idea_hecha', 'idea_votada_hecha', 'idea_descartada').
ALTER TABLE avisos ADD COLUMN idea_id INTEGER;
