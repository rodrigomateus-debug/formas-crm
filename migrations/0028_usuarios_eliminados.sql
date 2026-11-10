-- Eliminar usuarios (pedido de Rodrigo del 10/11/2026): el usuario eliminado deja de entrar, sale de Configuración → Usuarios
-- y de los desplegables, y sus registros y tareas abiertas pasan a quien se elija. La fila queda (con deleted_at) para que el
-- historial, las notas y los mails viejos sigan mostrando su nombre, y para que la sincronización con HubSpot no lo vuelva a
-- crear. Si se lo agrega de nuevo con el mismo mail, vuelve.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
