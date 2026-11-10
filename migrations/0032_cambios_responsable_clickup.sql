-- Quién hizo un cambio fuera del CRM (pedido de Rodrigo del 10/11/2026). Lo que mueve ClickUp en un pedido queda a
-- nombre de quien tiene asignado el PDV en ClickUp (Sole, Ceci…), no del usuario con que corre la sincronización.
-- user_id es su usuario del CRM si lo tiene (por mail o nombre); si no, queda vacío y actor dice el nombre de ClickUp.
ALTER TABLE changes ADD COLUMN actor TEXT;
