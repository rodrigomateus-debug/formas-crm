-- El origen del negocio se elige al crearlo (formulario de alta), como el producto y la cantidad.
UPDATE properties SET in_create_form = 1 WHERE object_type = 'deal' AND name = 'origen';
