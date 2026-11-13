-- Desde qué pedido o negocio se subió cada logo (si se subió desde un producto): así aparece en su conversación, con la
-- miniatura (pedido de Rodrigo del 13/11/2026). Los que se suben desde la empresa no tienen.
ALTER TABLE logos ADD COLUMN record_id INTEGER;
