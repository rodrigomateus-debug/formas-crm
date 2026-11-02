# Pedidos: ClickUp, factura y remito

Pedido de Rodrigo del 30/10/2026: que los pedidos vengan directo de ClickUp, con estados generales que les sirvan a las
comerciales para saber dónde están sus pedidos, y que se adjunten solos la factura de Finnegans (cuando está lista) y el
remito (cuando lo cargan en ClickUp al entregar). Las vendedoras solo mueven el pedido de «Pedido confirmado» a «Listo
para producción»; lo demás lo mueve ClickUp.

**ClickUp y Finnegans solo se leen.** Nada de esto escribe en ellos.

## De dónde sale cada cosa

| Qué | Fuente | Cada cuánto | Código |
|---|---|---|---|
| El pedido y su estado | ClickUp, lista **PEC** (`901326159292`): una tarea por PDV y una subtarea por artículo | Cada 10 minutos, salvo a las :00 y las :30 (cron del Worker) | `src/worker/clickup.ts` |
| La empresa del pedido | Finnegans: `pedidoVenta/<pedido>` → `cliente/<código>` → CUIT, y se busca la empresa por CUIT; si no, por razón social | Al crear el pedido | `clickup.ts` (`companyFor`) |
| La factura | Finnegans: `reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals` (facturas del pedido, también las que pasan por un remito, como en Corporate) y `facturaVenta/<id>` (número y CAE) | A las :00 y a las :30 | `src/worker/finnegans.ts` |
| El PDF de la factura | Finnegans GO (`/BSA/Sr2`, el mismo PDF que «Previsualizar»), con sesión iniciada | Cada hora, de 8 a 19, de lunes a viernes (GitHub) | `scripts/facturas-pdf.mjs`, workflow «Facturas de pedidos (PDF)» |
| Los productos | Finnegans: los renglones de `pedidoVenta/<pedido>` (cantidad, precio, descuentos) y `producto/<código>` (nombre, descripción y foto) | Al abrir el pedido; se guardan y se vuelven a leer cada 6 horas (la ficha del producto, cada 30 días) | `src/worker/productos.ts`, tabla `line_items` y `products` |
| El remito | ClickUp: la foto del remito firmado que suben a la tarea del PDV al entregar («PDV 31167.jpeg») | Con el estado | `clickup.ts`; se abre por `GET /api/files/<id>` |

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
Configuración → Integraciones → «Revisar todo».

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
