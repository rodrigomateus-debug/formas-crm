-- Equipos extra por usuario (en HubSpot un usuario puede estar en varios equipos: Lucía está en Formas Shop y en NOESTRES).
-- Junto con pipelines.config.visible_teams decide qué pipelines ve cada uno.
ALTER TABLE users ADD COLUMN extra_teams TEXT NOT NULL DEFAULT '[]';
