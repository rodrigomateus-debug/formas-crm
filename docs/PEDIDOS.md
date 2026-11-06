# Pedidos: ClickUp, factura y remito

Pedido de Rodrigo del 30/10/2026: que los pedidos vengan directo de ClickUp, con estados generales que les sirvan a las
comerciales para saber dónde están sus pedidos, y que se adjunten solos la factura de Finnegans (cuando está lista) y el
remito (cuando lo cargan en ClickUp al entregar). Las vendedoras solo mueven el pedido de «Pedido confirmado» a «Listo
para producción»; lo demás lo mueve ClickUp.

**Finnegans solo se lee. De ClickUp se lee todo y se escriben solo dos cosas.** La primera (pedido de Rodrigo del 4/11/2026): cuando la
vendedora pasa el pedido de «Pedido confirmado» a «Listo para producción» (en la pantalla, en masa o desde Claude), el PDV y
sus artículos que siguen en «ingreso de pedido» pasan a «pdv» en ClickUp. Lo que ya avanzó no se toca. El pedido queda en
la cola `clickup_salida` y sale enseguida; si ClickUp falla, se reintenta cada 10 minutos (hasta 6 veces). Con token de
administrador, `GET /hooks/clickup/salida` muestra lo último que se mandó y si hubo errores. Los cambios en ClickUp
quedan a nombre del dueño del token `CLICKUP_TOKEN`. La segunda (pedido de Rodrigo del 6/11/2026): el boceto aprobado de un producto se adjunta a la subtarea de ese
artículo en el PDV (ver «Bocetos de producción»); solo se adjunta, no se cambia ningún estado.

## De dónde sale cada cosa

| Qué | Fuente | Cada cuánto | Código |
|---|---|---|---|
| El pedido y su estado | ClickUp, lista **PEC** (`901326159292`): una tarea por PDV y una subtarea por artículo | Cada 10 minutos, salvo a las :00 y las :30 (cron del Worker) | `src/worker/clickup.ts` |
| La empresa del pedido | Finnegans: `pedidoVenta/<pedido>` → `cliente/<código>` → CUIT, y se busca la empresa por CUIT; si no, por razón social | Al crear el pedido | `clickup.ts` (`companyFor`) |
| La factura | Finnegans: `reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals` (facturas del pedido, también las que pasan por un remito, como en Corporate) y `facturaVenta/<id>` (número y CAE) | A las :00 y a las :30 | `src/worker/finnegans.ts` |
| El PDF de la factura | Finnegans GO (`/BSA/Sr2`, el mismo PDF que «Previsualizar»), con sesión iniciada | Cada hora, de 8 a 19, de lunes a viernes (GitHub) | `scripts/facturas-pdf.mjs`, workflow «Facturas de pedidos (PDF)» |
| Los productos | Finnegans: los renglones de `pedidoVenta/<pedido>` (cantidad, precio, descuentos) y `producto/<código>` (nombre, descripción y foto) | Al abrir el pedido; se guardan y se vuelven a leer cada 6 horas (la ficha del producto, cada 30 días) | `src/worker/productos.ts`, tabla `line_items` y `products` |
| El remito | ClickUp: la foto del remito firmado que suben al entregar («PDV 31167.jpeg»), en la tarea del PDV o (lo más común) en la del artículo | Con el estado (si está en el PDV) o al abrir el pedido entregado (si está en el artículo) | `clickup.ts`; se abre por `GET /api/files/<id>` |

## Estados del pedido

El estado sale de los **artículos**, no del PDV (regla de Rodrigo: el del PDV no es certero).

| Estado en el CRM | Cuándo | Lo mueve |
|---|---|---|
| Pedido confirmado | Al crearse desde ClickUp | — |
| Listo para producción | La vendedora confirmó que puede arrancar | **La vendedora** (el único movimiento a mano) |
| Esperando boceto o confirmación | Algún artículo en `boceto pendiente` o `en espera de confirmación` | ClickUp |
| En producción | Algún artículo en producción (`pedido al proveedor`, `en el impresor`, `articulo con logo`, `en revision`…) | ClickUp |
| Listo para entregar | Todos los artículos en `listo para entergar` | ClickUp |
| Entregado parcial | Algunos artículos entregados (`entregados` o `parcial entregado`) | ClickUp |
| Entregado | Todos los artículos entregados | ClickUp |
| Anulado | Todos los artículos (o el PDV) anulados | ClickUp |

- Mientras los artículos están en `ingreso de pedido`, `pdv` o `personales`, la producción no arrancó: queda lo que puso la vendedora.
- Los administradores pueden poner cualquier estado. Las vendedoras solo pasan de «Pedido confirmado» a «Listo para producción» y pueden volver atrás si se equivocaron; cualquier otro cambio a mano rebota con un aviso.
- Los estados de HubSpot se traducen (`ORDER_STAGE_ALIAS` en `seed.ts` y `0008_pedidos_clickup.sql`): «$ Pendiente de Anticipo» → Pedido confirmado; «Boceto Digital» → Esperando boceto; «Producción en revisión» → En producción; «$ Pendiente de Saldo» y «Listo para retirar» → Listo para entregar; «Pedido Completo» → Entregado; «Pedido Cancelado» → Anulado.

## Qué trae cada pedido

`pdv_finnegans` (el número, la llave con ClickUp y Finnegans), `pedido_finnegans` («PEDVTASTP - 31277»), unidad de negocio
(Formas Shop, Corporate o NoEstres; Mercado Libre no tiene vendedora y no crea pedidos), cliente de ClickUp, vendedora
(por el VENDEDOR de ClickUp, con los apodos de `CLICKUP_ALIAS` del tablero; la vendedora tiene que ser usuaria del CRM con el mismo nombre), tipo (evento o normal), fecha de entrega
prometida, fecha real de entrega, detalle de producción («3 en el impresor · 2 listo para entergar»), link al PDV y
número de factura. Cada cambio de estado y la factura quedan en la línea de tiempo del pedido.

Si el pedido entra antes que su empresa o su vendedora (por ejemplo, antes de migrar HubSpot o de dar de alta a la
vendedora), queda sin ellas y se completa la próxima vez que se revisa el PDV. Para completarlos todos de una vez:
Configuración → Integraciones → «Revisar todo» (o `POST /hooks/pedidos/revisar` con un token de administrador). La
vendedora se completa ya al releer la lista, en las primeras corridas; la empresa, a medida que se revisa cada PDV.

## Total sin IVA y el pie de las columnas

Pedido de Rodrigo del 4/11/2026: en el tablero de pedidos, como en el de negocios, abajo de cada columna el monto de esa
etapa, sin IVA. El «Total sin IVA» de cada pedido es el neto de su pedido de venta en Finnegans (la suma de sus renglones,
en pesos). Lo trae `scripts/pedidos-totales.mjs` (`.github/workflows/pedidos-totales.yml`, solo lectura de Finnegans) del
informe de pedidos de venta por producto: cada hora de 9 a 20, de lunes a viernes, con los pedidos de los últimos 120 días,
y a las 7 todos desde 2023. Cruza por el número interno del pedido («PEDVTASTP - 31277», con o sin ceros adelante);
primero Formas Publicitarias y, si no está, FP DEMO. No cuentan los renglones anulados ni los objetivos de venta.

El CRM lo guarda con `POST /hooks/pedidos/totales` (token de administrador; `GET` da el resumen de la última corrida): solo
los que cambiaron, en el historial de la propiedad, sin tocar la fecha de modificación del pedido (así el tablero no se
reordena). Los anulados no están en el informe y quedan sin monto; el pie de la columna dice cuántos pedidos no tienen.

## Miniaturas de los productos en la tarjeta

Pedido de Rodrigo del 4/11/2026: en el tablero de pedidos, la tarjeta muestra hasta 3 fotos de los productos del pedido,
una al lado de la otra, y «+X» si tiene más productos; un clic abre la vista previa con la lista. Solo aparece si algún
producto tiene foto (la de su ficha en Finnegans). Los productos de cada pedido se leen de Finnegans (o de los artículos
del PDV de ClickUp) y quedan guardados; `scripts/pedidos-productos.mjs`, en el mismo workflow que los totales, lee de a
tandas (`POST /hooks/productos/pendientes`) los que todavía no se leyeron y, una vez por día, los de los pedidos activos.

### Factura, remito y bocetos en la tarjeta

Pedido de Rodrigo del 6/11/2026: abajo de la tarjeta de cada pedido, tres iconitos que se pintan cuando están: la
factura (de Finnegans), el remito firmado (de ClickUp) y los bocetos, con cuántos de sus productos tienen al menos uno
(«1/5»; en verde cuando están todos, en azul si faltan). Salen de las tablas `files` y `bocetos` en la misma consulta del
tablero (`adjuntosSql` en `productos.ts`).

Como el remito casi siempre lo suben al artículo y no al PDV, el CRM lo buscaba recién al abrir el pedido. Ahora
`scripts/pedidos-productos.mjs` también recorre de fondo los pedidos entregados sin remito (`POST
/hooks/pedidos/remitos/pendientes`, `remitosPendientes` en `clickup.ts`), dentro del tope de consultas a ClickUp; cada
pedido se vuelve a revisar como mucho una vez por semana. Es solo lectura: no escribe nada en ClickUp.

### Fotos del registro de cotizaciones del STP

Pedido de Rodrigo del 6/11/2026: las fotos salen también del registro de cotizaciones del STP (`registro_cotizaciones`,
todas las cotizaciones, confirmadas o no, el export que pasó Franco), que trae la imagen que eligió la vendedora para cada
producto. `scripts/stp-imagenes.mjs`, en el mismo workflow, lo baja con el secreto `STPO_TOKEN` (sin él, se saltea) y
manda a `POST /hooks/productos/imagenes` (tabla `stp_imagenes`):

- **Por pedido**: el PDV de Finnegans de la cotización y el SKU → la foto de ese pedido (la variante que se cotizó).
- **Por SKU**: la foto que más se repite en todas las cotizaciones, sin las personalizadas con el logo de un cliente
  (Zecat y Zakeke), para los pedidos que no tienen cotización en el STP.

Para cada producto del pedido manda la de su cotización; si no hay, la de su ficha en Finnegans; si tampoco, la del SKU.
En la tarjeta, después de las fotos de los productos van las otras de su cotización (sirven aunque los productos todavía no
se hayan leído o sus códigos no coincidan con los SKU). Los pedidos de NoEstres no pasan por el STP. Una fila sin foto
borra la que había; `GET /hooks/productos/imagenes` dice qué llegó la última vez.

## Bocetos de producción

Pedido de Rodrigo del 6/11/2026: los bocetos (PDF, o una foto de referencia) que producción le manda a los impresores.
Cada boceto es de un producto del pedido. En una primera etapa producción sigue trabajando en ClickUp.

- **En el pedido**, en «Productos»: cada producto muestra su estado en ClickUp (cada artículo tiene el suyo; el del PDV junta
  los de todos) y sus bocetos. «+ Boceto» sube uno para ese producto; «+ Bocetos» o soltar archivos encima del recuadro sube
  varios: el CRM lee cada PDF (el boceto de producción dice «PRODUCTO» y el nombre) y propone a qué producto va.
- **Referencia o técnico**: una foto o un boceto rápido para avanzar, o el técnico final con medidas. Cada producto puede
  tener varias versiones (v1, v2…); se marca cuál está **aprobado**.
- **Al aprobar uno en un pedido**, el CRM lo adjunta en ClickUp a la subtarea del artículo de ese producto (por código del
  producto o, si no, por nombre; si el PDV no tiene ese artículo, al PDV). Si el PDV todavía no existe, se adjunta cuando
  aparece. Corre con la cola de salida a ClickUp (`clickup_salida`, acción `adjuntar_boceto`).
- **En el negocio**, antes de que exista el pedido: recuadro «Bocetos» con el nombre del producto (lo propone leyendo el PDF).
  Cuando llega el pedido de la misma empresa, en sus productos aparecen «Bocetos de negocios de esta empresa» para usarlos.
- **Dónde se guardan**: en una unidad compartida de Google Drive de Formas (Configuración → Integraciones → Bocetos en Drive),
  con una carpeta por empresa y, adentro, una por pedido («PDV 31277») o negocio. Entra la cuenta de servicio como el
  usuario elegido; necesita el permiso `https://www.googleapis.com/auth/drive` en la delegación de todo el dominio. En el CRM
  se ven aunque no se tenga acceso a la unidad (el CRM los trae de Drive). Quitar un boceto lo saca del CRM; el archivo queda
  en Drive.

## Migración desde HubSpot

Si ClickUp creó un pedido antes de la migración, al migrar se combina con el de HubSpot por número de PDV: queda el de
HubSpot (por sus asociaciones) con lo que sabe ClickUp (estado, detalle, factura y remito).

## Configuración

En GitHub, repositorio `formas-crm` → Settings → Secrets and variables → Actions:

| Secreto o variable | Para qué | De dónde |
|---|---|---|
| `CLICKUP_TOKEN` (secreto) | Leer la lista PEC | El mismo del tablero de Formas Shop |
| `FINNEGANS_CLIENT_ID`, `FINNEGANS_CLIENT_SECRET` (secretos; también sirven con los nombres `FIN_CLIENT_ID` y `FIN_SECRET`) | Leer facturas y clientes | Los mismos del tablero de Formas Shop |
| `CRM_TOKEN` (secreto) | Que la tarea de los PDF suba al CRM | Un token de un administrador (Configuración → Integraciones → Tokens, tipo «API») |
| `FINNEGANS_GO_USUARIO`, `FINNEGANS_GO_PASSWORD`, `FINNEGANS_GO_ESPACIO_DE_TRABAJO` (secretos) | Bajar el PDF de Finnegans GO | El usuario de GO que ya usa la facturación |
| `CRM_URL` (variable) | Dónde está el CRM | `https://formas-crm.rodrigo-mateus.workers.dev` |

Los tres primeros los carga en el CRM el despliegue («Probar y publicar»): después de agregarlos, correrlo de nuevo
(Actions → Probar y publicar → Run workflow). El estado de cada conexión, la última corrida y los errores se ven en
Configuración → Integraciones → «Pedidos: ClickUp y Finnegans», con botones para correrlas en el momento.

## Límites conocidos

- **Tope de consultas por corrida.** En el plan gratuito de Cloudflare, cada corrida puede hacer como mucho 50 consultas a
  otros servicios; si se pasa, Cloudflare la corta («Too many subrequests»). Por eso ClickUp y Finnegans van en turnos
  distintos y cada corrida frena a las 45 consultas (`src/worker/budget.ts`): los PDV que faltan quedan anotados y siguen
  en la próxima. La primera carga (unos cientos de PDV) tarda algunas horas en completarse; después, cada corrida trae
  solo lo que cambió. Con el plan pago de Workers el tope es mucho más alto: se puede subir con la variable `SUBREQUESTS`
  en `wrangler.jsonc`. Si se activa la sincronización de Gmail, también consume de ese tope.

- Las facturas de FP DEMO (algunos pedidos de NoEstres) no tienen CAE, así que no se adjuntan.
- Los remitos se traen de ClickUp cada vez que se abren (son fotos de hasta 3 MB y ClickUp da links que vencen).
- El PDF de la factura depende de la sesión de Finnegans GO: si cambia la pantalla de inicio de sesión o la dirección de
  Teamplace, el workflow falla y avisa por mail de GitHub; la factura sigue en el pedido con su número y CAE.
