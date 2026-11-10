-- El PDV que escribe el chofer (pedido de Rodrigo del 10/11/2026): cuando el remito no deja leerlo, no coincide en los
-- dos lugares o el chofer ve que se leyó mal. No se toma a ciegas: tiene que cerrar con el CUIT o el remito en
-- Finnegans como el leído (remitos.ts). `pide_pdv`: la app le pide al chofer que lo escriba.
ALTER TABLE remitos ADD COLUMN pdv_chofer TEXT;
ALTER TABLE remitos ADD COLUMN pide_pdv INTEGER NOT NULL DEFAULT 0;
