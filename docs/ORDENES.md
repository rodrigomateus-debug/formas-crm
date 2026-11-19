# Órdenes de trabajo

Pedido de Rodrigo del 19/11/2026: lo que Producción trabaja de cada pedido es un objeto propio, la **Orden de trabajo**
(OT), aparte del pedido de Ventas. Funciona igual que el pedido y se relaciona solo con él y con su empresa, contactos y
negocio.

## Cómo funciona

- **Nace sola con el pedido**, en «Pedido confirmado», venga de donde venga (ClickUp, Finnegans, a mano o Claude). Una por
  pedido. Se llama como el pedido, con «OT» en lugar de «PDV»: «PDV 31167 · Cliente» → «OT 31167 · Cliente».
- **La etapa es la del pedido.** Hasta «Listo para producción» la mueven las vendedoras desde el pedido. Después la mueve
  ClickUp según el estado de los productos, que Producción cambia en la pestaña Producción. En la OT no se arrastra ni se
  cambia a mano: se mueve sola.
- **Copia del pedido** el propietario (la vendedora), la unidad de negocio, el tipo, las fechas de entrega y del pedido, el
  detalle de producción, el cliente de ClickUp, el pedido de Finnegans y el link al PDV. Nada de eso se edita en la OT.
- **Tiene las mismas relaciones que el pedido:** su pedido, la empresa (con la misma principal), los contactos y el
  negocio. Si cambian las del pedido, cambian las de la OT. A mano no se le agregan ni se le sacan.
- **Una sola conversación.** Lo que se escribe desde la OT queda en la conversación del pedido, con sus menciones, no
  leídos y avisos. Las notas y tareas cargadas en uno se ven en el otro.
- **Los productos, bocetos, logos, remitos, la entrega y los archivos son los del pedido.** La ficha de la OT los muestra y
  los edita ahí mismo, pero se guardan en el pedido.
- Si el pedido se borra, se borra su OT; si se restaura, vuelve la misma. Si se combinan dos pedidos, queda una sola OT
  (la del pedido que queda, o la del otro si ese no tenía). La OT no se crea, borra, combina ni clona a mano.
- Un pedido que entra ya entregado o anulado no crea OT. Si después vuelve a producción desde ClickUp, la crea.

## Quién la ve

| Perfil | Ve | Abre |
|---|---|---|
| Administrador | Todas | Desde Producción, Cronograma e Inicio de Producción, la OT; desde Pedidos, el pedido |
| Producción y Logística | Todas | La OT, también desde los links de un pedido (mails, notificaciones, Producción, Cronograma). «Ver pedido» abre el pedido |
| Ventas | Las de sus pedidos (como el pedido) | El pedido; la OT desde el pedido o su lista |
| Gerencia | Las de su unidad | Igual que Ventas |

En el buscador de arriba aparece según esos permisos. En el celular, el link de una OT abre la ficha de su pedido, que
tiene lo mismo.

## Pedidos que ya estaban (migración 0102)

Se creó la OT de cada pedido **activo con su PDV en ClickUp**, es decir, que no estuviera entregado ni anulado y tuviera
`url_clickup`. Quedaron afuera los entregados, los anulados y los que quedaron colgados de HubSpot sin PDV.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Tipo `work_order`. La tabla `records` se rearmó sin el CHECK del tipo, que ahora controla el Worker | `migrations/0101_ordenes_de_trabajo.sql` |
| Vínculo pedido ↔ OT, único en la base (`ot_pedido`), propiedades de la OT y alta de las de los pedidos activos | `migrations/0102_ordenes_de_trabajo_alta.sql` |
| Alta, copia de datos y relaciones, combinación y conciliación | `src/worker/ordenes.ts` |
| Ganchos en el alta, la edición, el borrado, la restauración y la combinación de pedidos | `src/worker/records.ts` |
| Ganchos en las relaciones, y el bloqueo de cambios a mano | `src/worker/associations.ts` |
| La OT lee y escribe en su pedido: conversación, bocetos, logos, archivos y razón social (`registroOPedido`). La ficha trae `pedido` y el pedido trae `ot_id` | `src/worker/api.ts` |
| Actividad compartida en la línea de tiempo y la conversación | `src/worker/activities.ts`, `src/worker/conversacion.ts` |
| Permisos | `src/worker/alcance.ts` |
| Pantallas | `web/src/pages/RecordPage.tsx`, `ObjectIndex.tsx`, `PropBoard.tsx`, `web/src/movil/Movil.tsx` |
| Prueba de punta a punta | `test/ordenes.test.mjs` |

- **Las opciones de la etapa, la unidad y el tipo** son siempre las del pedido (`Meta.properties` en `meta.ts`). Una etapa
  nueva o renombrada en Configuración vale para las dos.
- **Copia liviana:** con cada cambio del pedido que la OT copia hay una lectura y una escritura, sin historial propio. El
  historial de la etapa es el del pedido, y la ficha de la OT lo muestra.
- **Conciliación** (`conciliarOTs`, cron de cada hora, en el turno de las facturas): algunos procesos escriben el pedido
  directo en la base. Los totales de Finnegans (vendedora y fecha) ya actualizan también la OT en la misma tanda; para el
  resto, como la migración de HubSpot, está esta conciliación. Busca con SQL las OT que quedaron distintas de su pedido
  (datos, propietario, borrado o relaciones) y los pedidos activos con PDV sin OT, y los pone al día de a 15. Para correrla
  ya, con token de administrador:

  ```bash
  curl -X POST https://<crm>/hooks/ordenes/conciliar -H "authorization: Bearer fcrm_…" -H "content-type: application/json" -d '{"limite": 200}'
  ```

## Publicación (una sola vez)

La 0101 rearma `records`, la tabla más grande. Conviene publicar de noche y con respaldo.

1. **Respaldo:** correr a mano el workflow «Respaldo de la base» y anotar el punto de Time Travel:

   ```bash
   npx wrangler d1 time-travel info formas-crm
   ```

2. **Antes de migrar**, para comparar después:

   ```bash
   npx wrangler d1 execute formas-crm --remote --command "SELECT object_type, COUNT(*) FROM records GROUP BY object_type"
   ```

3. **Publicar el código tolerante antes que las migraciones.** `npm run deploy` aplica las migraciones y después sube el
   Worker. En ese rato, el Worker anterior no conoce el tipo nuevo y la ficha de un pedido con OT daría error. Por eso
   primero se publica solo el cambio de `associationsOf` (`out[r.object_type] ??= []` en `src/worker/associations.ts`,
   que no necesita migración) y después todo lo demás.
4. **Después de migrar:** los conteos tienen que dar igual que antes, más las OT nuevas. Esta consulta tiene que dar vacío:

   ```bash
   npx wrangler d1 execute formas-crm --remote --command "PRAGMA foreign_key_check"
   ```

5. **Si algo sale mal enseguida:** `wrangler d1 time-travel restore` al punto anotado. Ojo, pierde lo escrito después.
   Si se nota más tarde, conviene arreglar hacia adelante.
