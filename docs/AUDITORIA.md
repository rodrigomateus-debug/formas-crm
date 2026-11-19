# Auditoría del 19/11/2026

Cuatro agentes (dos de Fable 5.2 y dos de Opus 5.5) revisaron el Hub en dos frentes: rendimiento (velocidad de carga,
base de datos, consumos, escalabilidad) y seguridad e integridad (lo que puede cada perfil, inconsistencias de datos).
Cada problema se reprodujo en una copia local antes de arreglarlo, y cada arreglo tiene su prueba.

## Seguridad de los perfiles

Detalle en [PERFILES.md](PERFILES.md#auditoría-del-19112026-lo-que-se-cerró). Pruebas: `test/auditoria.test.mjs`.

## Datos

Pruebas: `test/datos.test.mjs` (los 6 casos fallan con el código anterior).

| Qué pasaba | Qué cambió | Dónde |
|---|---|---|
| Dos cambios a la vez sobre el mismo registro (dos personas, o una persona y la sincronización con ClickUp o Finnegans) se pisaban: de 10 cambios simultáneos quedaban 3, y el historial decía otra cosa. | Se guarda solo si las propiedades siguen como se leyeron; si no, se vuelve a leer y se reintenta (hasta 6 veces; después, 409 «volvé a intentar»). | `updateRecord` en `records.ts` |
| Abrir la tarjeta Entrega de un pedido reescribía todas sus propiedades con una copia leída antes. | Escribe solo sus dos campos (`json_set`). | `recalcularEntrega` en `remitos.ts` |
| La fecha de cierre automática y el «mes» de Inicio salían en UTC: lo ganado después de las 21 quedaba en el día o el mes siguiente. | Hora de Buenos Aires (UTC−3, sin horario de verano). La fecha de cierre automática queda en el historial. | `hoyEnBuenosAires` en `env.ts` |
| «0.125» se guardaba como 125 y «1234.567» como 1234567; «abc» como 0. | El punto es de miles solo si arma grupos de miles («1.500», «1.234.567»); un texto sin números rebota. | `numeroEscrito` en `records.ts` |
| Combinar movía solo asociaciones, actividad y archivos: la conversación, los bocetos, los logos, los remitos, los encargos, los referidos y las consultas quedaban en el archivado. El segundo mail de un contacto se perdía. | Pasa todo lo que apunta al registro (`REFERENCIAS_A_REGISTRO`). Nueva propiedad «Mails adicionales» (migración 0092). Primero se validan las propiedades y después se combina. Un combinado no se restaura. | `mergeRecords` en `records.ts` |
| Archivar o restaurar un pedido no cambiaba el monto de su negocio. | Se recalcula (`montosDesdePedidos`). Que un negocio sin pedidos conserve su monto es a propósito (`montos.ts`). | `api.ts` |
| La sincronización con HubSpot reactivaba a los usuarios desactivados en el CRM (y sus tokens volvían a servir), devolvía registros a usuarios eliminados, y un contacto y una empresa con el mismo número de HubSpot terminaban en un solo registro. | No toca `active`; ignora a los eliminados (queda el propietario del CRM); solo pisa un registro del mismo tipo; rechaza ids desde 900000000001 (`rechazados` en la respuesta). | `migrate.ts` |
| Editar una propiedad archivada la desarchivaba. | Queda como estaba si no se manda `archived`. | `api.ts` |

## Pruebas locales

Las pruebas del cronograma usan días fijos (17/11/2026): con muchas corridas sobre la misma base local se acumulan
movimientos en ese día y el cálculo del recorrido más corto se vuelve lento hasta quedarse sin memoria. Para correr la
suite varias veces, empezar de una base limpia (borrar `.wrangler/state` y `npm run db:local`), como en GitHub.
