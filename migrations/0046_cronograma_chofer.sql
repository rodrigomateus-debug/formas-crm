-- Cronograma, correcciones de la revisión del 12/11/2026 (docs/CRONOGRAMA.md).

-- Qué marcó el chofer en cada parada: al deshacer se vuelve atrás solo eso, no lo que había marcado Logística.
ALTER TABLE cronograma_visitas ADD COLUMN marcados TEXT NOT NULL DEFAULT '[]';   -- [{ id, tipo }]
-- Quién lo marcó, cuando fue el chofer desde la app (user_id es de quien creó su link).
ALTER TABLE cronograma_hechos ADD COLUMN chofer TEXT;

-- Los feriados de fecha fija de 2027 que faltaban.
INSERT OR IGNORE INTO feriados (fecha, nombre) VALUES
  ('2027-05-01', 'Día del Trabajador'), ('2027-06-20', 'Día de la Bandera'), ('2027-12-25', 'Navidad');
