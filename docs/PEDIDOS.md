# Pedidos: ClickUp, factura y remito

Pedido de Rodrigo del 30/10/2026: que los pedidos vengan directo de ClickUp, con estados generales que les sirvan a las
comerciales para saber dónde están sus pedidos, y que se adjunten solos la factura de Finnegans (cuando está lista) y el
remito (cuando lo cargan en ClickUp al entregar). Las vendedoras y el backoffice solo mueven el pedido antes de
producción (de «Pedido confirmado» a «Listo para producción», pasando si hace falta por «$ Pendiente de Anticipo» y
«Pendiente Boceto Digital»); lo demás lo mueve ClickUp.

**Finnegans solo se lee. De ClickUp se lee todo y se escriben solo dos cosas.** La primera (pedido de Rodrigo del 4/11/2026): cuando la
vendedora pasa el pedido a «Listo para producción» desde «Pedido confirmado», «$ Pendiente de Anticipo» o «Pendiente Boceto
Digital» (en la pantalla, en masa o desde Claude), el PDV y
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
| $ Pendiente de Anticipo | Falta que el cliente pague el anticipo. Solo Formas Shop y No Estrés | **La vendedora o el backoffice** |
| Pendiente Boceto Digital | Falta que el cliente apruebe el boceto digital. Formas Shop, No Estrés y Corporate | **La vendedora o el backoffice** |
| Listo para producción | La vendedora confirmó que puede arrancar | **La vendedora o el backoffice** |
| Esperando boceto o confirmación | Algún artículo en `boceto pendiente` o `en espera de confirmación` | ClickUp |
| En producción | Algún artículo en producción (`pedido al proveedor`, `en el impresor`, `articulo con logo`, `en revision`…) | ClickUp |
| Listo para entregar | Todos los artículos en `listo para entergar` | ClickUp |
| Entregado parcial | Algunos artículos entregados (`entregados` o `parcial entregado`) | ClickUp |
| Entregado | Todos los artículos entregados | ClickUp |
| Anulado | Todos los artículos (o el PDV) anulados | ClickUp |

- Mientras los artículos están en `ingreso de pedido`, `pdv` o `personales`, la producción no arrancó: queda lo que puso la vendedora.
- Las dos etapas previas (pedido de Rodrigo del 10/11/2026, migración `0030_pedidos_etapas_previas.sql`) son para que las
  vendedoras y el backoffice sigan de su lado la parte previa a la producción. ClickUp no las mueve: las cuatro etapas antes
  de producción se mueven a mano, en cualquier orden y también para atrás. «Pendiente Boceto Digital» es antes de producción;
  «Esperando boceto o confirmación» es cuando producción espera un boceto en ClickUp, y esa la sigue moviendo ClickUp.
- «$ Pendiente de Anticipo» es solo para Formas Shop y No Estrés: un pedido de Corporate rebota con un aviso (también para
  los administradores). Los pedidos sin unidad de negocio pueden ir.
- En el historial del pedido, lo que mueve ClickUp queda a nombre de quien tiene asignado el PDV en ClickUp (si el PDV no
  tiene, el primero asignado de sus artículos), no del usuario de la sincronización (pedido de Rodrigo del 10/11/2026). Si
  esa persona tiene usuario en el CRM (por mail o por nombre), con su usuario; si no, con su nombre de ClickUp. Lo que ya
  estaba a nombre de la sincronización pasa a esa persona la próxima vez que se lee el PDV (columna `changes.actor`,
  migración `0032`).
- Los administradores pueden poner cualquier estado. Las vendedoras y el backoffice solo mueven las cuatro etapas antes de producción; cualquier otro cambio a mano rebota con un aviso.
- Los estados de HubSpot se traducen (`ORDER_STAGE_ALIAS` en `seed.ts` y `0008_pedidos_clickup.sql`): «$ Pendiente de Anticipo» y «Boceto Digital» van a sus etapas (desde la 0030 conservan sus ids de HubSpot); «Producción en revisión» → En producción; «$ Pendiente de Saldo» y «Listo para retirar» → Listo para entregar; «Pedido Completo» → Entregado; «Pedido Cancelado» → Anulado.

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

## Saldo pendiente de cada pedido

Pedido de Rodrigo del 6/11/2026: el «Saldo pendiente de pago» del pedido sale de Finnegans, ya no de HubSpot ni a mano.
`scripts/pedidos-totales.mjs`, cada hora, baja el informe de composición de saldos (`COMPOSICIONSALDOSCLIENTES`, las
dos empresas; el mismo que usa el saldo de cada empresa) y manda a `POST /hooks/pedidos/saldos` una fila por comprobante
con saldo: lo que falta cobrar, que Finnegans da con IVA. Todo se muestra **sin IVA** (Rodrigo, 7/11/2026: «trabajamos con
números sin IVA»): el saldo de cada factura se divide por la proporción total/neto de su pedido (o por 1,21 si no se
sabe). El CRM cruza cada fila con su pedido (`aplicarSaldos` en `totales.ts`):

1. Por la factura que el CRM ya tiene enganchada al pedido (tabla `files`).
2. Si no, por la identificación de la factura («FC PEDVTASTP-00031277 1»).
3. Si no, por el número de PDV con que empieza la descripción («31089», «2407 / OC N°…», «PDV:36 NOESTRES»), que también
   tienen las facturas que salen de un remito («FC FPREMVTA-1979 1»).

Las notas de crédito restan en el pedido de la factura que corrigen; las cobranzas sin aplicar no son de ningún pedido.

**Lo que falta facturar también es saldo** (Rodrigo, 7/11/2026: «si están sin facturar, el 100% es saldo pendiente»;
«saber exactamente cuánto falta que nos paguen, casi al centavo»). Va en «Por facturar» (`importe_por_facturar`) y se
suma: **saldo pendiente = lo facturado que falta cobrar + lo que falta facturar**, todo sin IVA.

Por facturar es el menor de dos cálculos, porque cada uno corrige el error del otro:

1. **Lo pendiente según Finnegans.** En Formas Shop y No Estrés el pedido pasa directo a la factura: su pendiente es lo
   que falta facturar. En Corporate pasa al remito y el remito a la factura: falta lo que el pedido no remitió más lo que
   sus remitos no facturaron (análisis de remitos, `analisisDespachoVenta`, que trae solo los que tienen algo sin
   facturar; el remito dice «pdv 31089»). Los remitos de Formas Shop son de la entrega y nunca se facturan: no cuentan.
   Menos los **anticipos**: la factura de anticipo («ANTICIPO FINANCIERO», con el PDV en la descripción) no sale del
   pedido, y la factura final lo descuenta con un renglón en negativo; lo anticipado que todavía no se descontó ya está
   facturado.
2. **El neto del pedido menos todo lo que se le facturó** (análisis de facturas, `analisisFacturaVenta`): facturas,
   anticipos, la final que los descuenta y notas de crédito y débito.

El (1) no ve una factura que se hizo sin enlazarla al pedido o al remito; el (2) toma como pendiente un descuento por
nota de crédito o un precio que se ajustó al facturar. En los pedidos de los últimos 4 meses (7/11/2026) los dos
coincidían salvo en 5.

Cada factura se engancha a su pedido: por el pedido o remito del que sale (informe de facturas, `ApiFacturasDeVenta`),
por su identificación («FC PEDVTASTP-00031277 1»), por el PDV de la descripción («31089», «PDV:36 NOESTRES», «PDV N° 31512
/ OC…»), por los remitos del pedido si el remito no dice el PDV, y una nota que anula otra («NC ANULA FC 2583») va con
esa. **Lo facturado que falta cobrar** sale del informe de saldos, factura por factura, y se pasa a sin IVA con el
neto/total exacto de esa factura (cambia de 1,21 a 1,27 según las percepciones); si la factura es anterior a lo leído,
con el de su pedido, y si no, 1,21.

Los anulados no tienen saldo. Facturado y cobrado queda en 0 («Cobrado» en la vista previa). Los objetivos de venta y
Mercado Libre no cuentan. Cada hora se recalculan los pedidos de los últimos 120 días; a las 7, todos desde 2023. Las
cobranzas sin aplicar (un pago que todavía no se imputó a ninguna factura) son del cliente, no de un pedido. Si un
informe falla, no se manda nada. Es solo lectura: en Finnegans no se escribe.

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

**Qué es remito y qué no** (aviso de Rodrigo del 6/11/2026: algunos «remitos» eran fotos del producto). En ClickUp, además
del remito firmado, suben fotos del producto, capturas y bocetos. El remito se sube con el número del PDV como nombre
(«PDV 31167.jpeg», «PDV 31224 - 1.jpg», «PDV NE 36.jpg», «pdv28888.PNG»; los más viejos, «28924.JPG»), así que solo se
toma como remito el adjunto cuyo nombre es el número de ese PDV (`esRemito` en `clickup.ts`). Lo demás («image.png»,
«Captura de pantalla…», «chomba.jpg», «BOCETO….pdf», los bocetos que adjunta el CRM, o el remito de otro PDV) no se
guarda. `POST /hooks/pedidos/remitos/limpiar` borra del CRM los que se habían guardado antes de esta regla.

### Fotos del registro de cotizaciones del STP

Pedido de Rodrigo del 6/11/2026: las fotos salen también del registro de cotizaciones del STP (`registro_cotizaciones`,
todas las cotizaciones, confirmadas o no, el export que pasó Franco), que trae la imagen que eligió la vendedora para cada
producto. `scripts/stp-imagenes.mjs`, en el mismo workflow, lo baja con el secreto `STPO_TOKEN` (sin él, se saltea) y
manda a `POST /hooks/productos/imagenes` (tabla `stp_imagenes`):

- **Por pedido**: el PDV de Finnegans de la cotización y el SKU → la foto de ese pedido (la variante que se cotizó).
- **Por SKU**: la foto que más se repite en todas las cotizaciones, sin las personalizadas con el logo de un cliente
  (Zecat y Zakeke), para los pedidos que no tienen cotización en el STP.
- **Los productos de la cotización de cada pedido** (`NOMBRE DEL PRODUCTO`, sus `CANTIDAD` y la foto; tabla `stp_items`).
  Aviso de Rodrigo del 7/11/2026: en la tarjeta se veían las fotos y en el panel de la derecha no, porque muchos pedidos
  se cargan en Finnegans con un código genérico («PICPS_GE_6000», con «Vasos», «Naipes»… en la descripción) que no es el
  SKU de la cotización.

Para cada producto del pedido (`fotosDeRenglones` en `productos.ts`): la de su SKU en la cotización (si el SKU es genérico,
solo si la cotización tiene un único producto con él); si no, la de su ficha en Finnegans (no para los genéricos); si no, la
del producto de la cotización con el mismo nombre (las palabras de la descripción, sin colores ni materiales, en singular);
si no, la del único producto de la cotización con su misma cantidad; si no, la del SKU en otras cotizaciones (nunca para los
genéricos, que en cada cotización son otra cosa). Cada producto de la cotización se usa una sola vez; las fotos que no
quedaron en ningún renglón se muestran abajo en el panel, como «fotos de la cotización», si a algún producto le falta foto.
La tarjeta muestra las mismas fotos que el panel (`armarFotos`, con la misma `fotosDeRenglones`): las de sus productos y,
solo si a alguno le falta foto, las de la cotización que no quedaron en ningún producto; si los productos todavía no se
leyeron, las de la cotización. Antes sumaba siempre todas las de la cotización, y en los pedidos donde se cotizaron varias
opciones (aviso de Rodrigo del 7/11/2026: un cuaderno negro y uno gris, y el cliente pidió uno) la tarjeta mostraba más
fotos que productos. Los pedidos de NoEstres no pasan por el STP. Una fila sin foto
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
