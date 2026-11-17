-- Origen obligatorio al cargar un contacto nuevo (pedido de Rodrigo del 17/11/2026): el «Canal de contacto»
-- (origen_del_contacto) aparece en el formulario de alta y no se puede crear sin él. Solo para la carga a mano (pantalla y
-- Claude): Gmail, Darwin, LinkedIn, la importación y los tableros siguen creando contactos sin cortarse (records.ts).
UPDATE properties SET required = 1, in_create_form = 1,
  description = 'Por dónde llegó. Obligatorio al cargar un contacto a mano; los que entran solos (Gmail, Darwin, LinkedIn) lo traen.'
WHERE object_type = 'contact' AND name = 'origen_del_contacto';
