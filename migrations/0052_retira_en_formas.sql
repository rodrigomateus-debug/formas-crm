-- Retira en Formas (pedido de Rodrigo del 13/11/2026): en la tarjeta «Entrega» del pedido, en lugar de una dirección del
-- cliente, que lo retira el cliente en una de las direcciones de Formas (las bases del cronograma: el Depósito Gral. Roca o
-- la Oficina Matienzo). Es una dirección más del pedido, así también sirve repartido (parte retira, parte se envía).
-- `retira` es el id de la base (settings `cronograma`); la dirección queda copiada en `direccion`. El cronograma no la pone
-- en el recorrido del chofer: la lista aparte, en «Retiran en Formas».
ALTER TABLE entrega_direcciones ADD COLUMN retira TEXT;
