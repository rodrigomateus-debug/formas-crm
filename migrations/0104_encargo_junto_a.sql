-- Juntar paradas (pedido de Rodrigo del 20/11/2026): un encargo a un lugar al que ese día ya se va (la entrega a esa
-- empresa, otro encargo) va en esa parada. El Hub lo junta solo si es la misma dirección; si la dirección está escrita
-- distinto o la libreta tiene otra, Logística lo junta a mano desde la Ruta del día o Próximos días. Y al revés: si el
-- Hub juntó algo que en realidad es otro lugar, lo separa.
--   NULL      → lo decide el Hub (la misma dirección, el mismo destino de la libreta o la misma empresa).
--   'aparte'  → su propia parada, aunque el Hub lo juntaría.
--   otra cosa → la clave de la parada con la que va ese día («p:<tarea del PDV>», «e:<empresa>», «l:<lugar>»…). Si ese
--               día ya no existe esa parada, vuelve a decidir el Hub. Se borra al pasarlo a otro día o cambiarle el destino.
ALTER TABLE encargos ADD COLUMN junto_a TEXT;
