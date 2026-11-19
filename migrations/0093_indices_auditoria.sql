-- Índices de la auditoría de rendimiento del 19/11/2026 (docs/AUDITORIA.md). Medidos con los volúmenes de 5 años.

-- Tareas abiertas de cada uno (contador del menú, Inicio, Tareas, resumen diario por mail): recorrían todas las tareas de la
-- base (activities_hs por type). Parcial: SQLite la usa cuando la consulta tiene estas mismas condiciones (activities.ts,
-- listTasks). 25 usuarios: de 256 ms a 0,2 ms.
CREATE INDEX IF NOT EXISTS activities_tareas_abiertas ON activities(owner_id, due_at) WHERE type = 'task' AND archived = 0 AND status != 'COMPLETED';

-- La campanita (cada 45 s por pestaña): las no leídas de cada uno, sin recorrer todos sus avisos.
CREATE INDEX IF NOT EXISTS avisos_no_leidos ON avisos(user_id) WHERE leido_at IS NULL;

-- Remitos: la foto (BLOB) va en el medio de la fila, así que leer una columna que está después obliga a pasar por la
-- foto. Con estos índices el Cronograma (fotos del chofer de un día) y Configuración (última lectura) no recorren la tabla.
CREATE INDEX IF NOT EXISTS remitos_origen_fecha ON remitos(origen, created_at);
CREATE INDEX IF NOT EXISTS remitos_leido ON remitos(leido_at);

-- Facturas que todavía no tienen su PDF (Configuración y la tarea que los baja).
CREATE INDEX IF NOT EXISTS files_facturas_sin_pdf ON files(source) WHERE kind = 'factura' AND data IS NULL;
