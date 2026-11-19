-- Mails adicionales de un contacto (auditoría del 19/11/2026): al combinar dos contactos con mails distintos, el del que se
-- archiva va acá (records.ts, mergeRecords). La propiedad no existía en el CRM (solo si la traía HubSpot), así que ese mail
-- se descartaba sin aviso.
INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order, system, read_only, in_create_form, required)
VALUES ('contact', 'hs_additional_emails', 'Mails adicionales', 'string', '[]', 'Información del contacto',
  'Otros mails del contacto, separados por «;». Se completa al combinar dos contactos con mails distintos.', 100, 1, 0, 0, 0);
