-- Estados de despacho, etapa 3 (pedido de Logística, Rodrigo del 19/11/2026): los colgados no se olvidan.
-- Cuándo se le avisó a Logística que un colgado ya se puede reprogramar (se destrabó lo que lo colgó), y cuándo se le
-- volvió a avisar al responsable del pedido porque pasó una semana colgado. Una vez cada cosa.
ALTER TABLE cronograma_colgados ADD COLUMN listo_avisado_at TEXT;
ALTER TABLE cronograma_colgados ADD COLUMN reavisado_at TEXT;

-- Una anotación «solo esta vez» que traba la entrega (la corrección a mano del estado): falta información, no pagó o no
-- llegó. Mientras esté, la tarjeta queda en ese estado; borrarla la devuelve a lo automático.
ALTER TABLE logistica_notas ADD COLUMN traba TEXT CHECK (traba IS NULL OR traba IN ('info', 'nopago', 'nollego'));
