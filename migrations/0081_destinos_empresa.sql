-- La empresa del CRM de cada destino (pedido de Rodrigo del 18/11/2026): los destinos se relacionan con su empresa, sobre
-- todo los clientes, y la lista muestra su logo (el del dominio). `lugares.company_id` y `destino_grupos.company_id` ya
-- estaban; acá se guarda de dónde salió esa relación, para que lo que se hace a mano no lo pise nada:
--   NULL      nunca se relacionó (el Hub la busca por el nombre) o la eligió quien cargó el destino desde el CRM
--   'nombre'  se llama igual que la empresa del CRM
--   'grupo'   es una de las direcciones de una empresa (grupo) que ya está relacionada
--   'manual'  la eligió o la quitó alguien: no se vuelve a deducir
ALTER TABLE lugares ADD COLUMN empresa_origen TEXT;
ALTER TABLE destino_grupos ADD COLUMN empresa_origen TEXT;
