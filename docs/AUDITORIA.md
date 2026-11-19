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

## Rendimiento

Medido con datos inventados al volumen de 5 años (60.000 contactos, 40.000 negocios, 400.000 actividades). Pruebas:
`test/paginas.test.mjs` y la suite completa.

| Qué pasaba | Qué cambió | Dónde |
|---|---|---|
| Cada nota, mail o negocio nuevo recalculaba «Último contacto» recorriendo todos los mails de la base (SQLite elegía el índice por tipo): 1,3 s por nota y 2,5 s por negocio a 5 años, con la base sin aceptar otras escrituras. | Las consultas arrancan por los vínculos del registro (`activity_links l CROSS JOIN activities a`). 200 registros: de 2.411 ms a 6 ms. Lo mismo en el tablero de negocios, la conversación, el calendario, Claude y la migración. | `records.ts`, `api.ts` y otros |
| El contador de tareas (en cada cambio de pantalla), Inicio y el resumen diario recorrían todas las tareas. | Índice parcial de tareas abiertas: 25 usuarios, de 256 ms a 0,2 ms. El contador del menú y el de remitos, como mucho una vez por minuto. | migración 0093, `App.tsx` |
| La campanita (cada 45 s) contaba todos los avisos de cada uno. | Índice de no leídos. | migración 0093 |
| Las fotos de los remitos están en la base, en el medio de la fila: el Cronograma (cada 2 minutos) y Configuración recorrían la tabla y con ella las fotos. | Consultas por índice (`UNION` por parada y por día del chofer; conteo por estado). | `cronograma.ts`, `api.ts`, migración 0093 |
| El Cronograma volvía a pedir las direcciones (unas 155 consultas) en cada refresco de 2 minutos. | Solo si cambió algo. | `Cronograma.tsx` |
| Las listas ordenaban todo el tipo en cada página (`IS NULL` delante del orden). | Sin el `IS NULL` en columnas que nunca están vacías: la lista por defecto usa el índice. | `searchRecords` en `records.ts` |
| API de los tableros: cada página salteaba (y ordenaba) todas las anteriores, contaba todo y hacía una consulta por registro. | «after» es el último id (en actividades, fecha~id) y la página siguiente arranca ahí; las filas en una sola consulta. Un número chico sigue siendo una posición. | `compat.ts` |
| Exportar recontaba en cada tanda y se cortaba en 20.000 sin avisar. | Cuenta una vez; si quedan más, la última fila lo dice. | `api.ts` |
| Cada pedido con token escribía «último uso» (la app del chofer pregunta cada 20 s). | Como mucho una vez cada 10 minutos. | `auth.ts` |
| Gmail y Calendar pedían un acceso nuevo a Google por buzón en cada corrida. | Se guarda 50 minutos. Calendar ya no lo descuenta del tope de la corrida (Gmail sí, para no cambiar cuántos mails lee por corrida). | `google.ts` |
| No se actualizaban las estadísticas de la base. | `PRAGMA optimize` una vez por día (si D1 no lo permite, no corta nada). | `index.ts` |
| La pantalla bajaba todo el escritorio al abrir, con el mapa (Leaflet) y la lista de localidades, también en el celular; los assets se volvían a pedir en cada apertura. | Configuración, Cronograma, Analíticas y Notas de productos se bajan al abrirlas; el mapa y la lista de localidades, solo en Destinos y la Ruta del día. Producción, Entregas, Recorridos y Choferes siguen en el arranque: la versión celular las usa y quedan en el bloque compartido. Assets con caché de un año (`web/public/_headers`). Arranque: de 337 a 214 kB comprimidos en computadora y de 312 a 193 kB en el celular. | `App.tsx`, `Recorridos.tsx`, `rutaComun.ts`, `analiticasTemas.ts` |

## Pruebas locales

Las pruebas del cronograma usan días fijos (17/11/2026): con muchas corridas sobre la misma base local se acumulan
movimientos en ese día y el cálculo del recorrido más corto se vuelve lento hasta quedarse sin memoria. Para correr la
suite varias veces, empezar de una base limpia (borrar `.wrangler/state` y `npm run db:local`), como en GitHub.
