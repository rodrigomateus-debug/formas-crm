-- Si cada usuario recibe los avisos por mail del CRM (resumen de tareas, asignaciones y faltantes de entrega). Apagado
-- por defecto, para todos: llegaban demasiados mails de entregas. Se prende por persona en Configuración → Usuarios.
-- Reemplaza la lista `users` de la configuración de avisos (settings 'avisos').
ALTER TABLE users ADD COLUMN avisos_mail INTEGER NOT NULL DEFAULT 0;
