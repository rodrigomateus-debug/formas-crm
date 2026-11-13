# Logos del cliente (en curvas)

Pedido del 13/11/2026: además del boceto, producción necesita el logo original del cliente «en curvas» (vectorial, con los
textos convertidos a trazos) en el formato que sea.

## Dónde está

- **Empresa → Logos** (`web/src/pages/Logos.tsx`, `LogosCard`): todas las versiones del cliente (color, negativo, isotipo…),
  la principal con ★. Se suben con «+ Subir» o soltándolos encima. Un clic abre el visor: nombre, estado de curvas, hacerlo
  principal, descargar, abrir en Drive, quitar (deja de ofrecerse; el archivo queda en Drive).
- **Pedido → Productos** y **Negocio → Bocetos**: cada producto tiene su fichita de logo (`LogoProducto`). Un clic abre el
  cuadro para elegir entre los logos de la empresa o «Subir uno nuevo», que lo guarda en la empresa y lo deja elegido para
  ese producto. Sin elegir, va el principal. Los logos son de la empresa del pedido o negocio: si no tiene, el cuadro pide
  asociarle una, y al asociarla (o crearla) desde la vista previa o la ficha, los logos se vuelven a pedir enseguida
  (`useLogos` con las empresas asociadas; aviso de Rodrigo del 13/11/2026: seguía diciendo «no tiene empresa» hasta cerrar
  y abrir la vista previa).
- **Descargar** (pedido de Rodrigo del 13/11/2026): al lado de la fichita del logo de cada producto (en el pedido, el
  negocio y el visor del boceto), un botón baja el archivo original de un clic, con su nombre (`BajarLogo`); en el cuadro
  para elegir, cada versión tiene «ver grande» y «descargar». Antes había que abrir el cuadro, el ojito y recién ahí
  «Descargar». Desde la empresa, en el visor del logo, como siempre.
- **Visor del boceto**: el mismo selector, para el producto del boceto.
- **Producción**: al lado del nombre del artículo, «Sin logo» (la empresa no tiene) o «Logo» en rojo (con textos sin curvas o
  no vectorial). No se muestra en los artículos ya listos, entregados o anulados.

## Archivos

Drive: `<carpeta de bocetos>/<empresa>/Logos`. Formatos: AI, EPS, CDR, SVG, PDF (vectoriales) y PNG, JPG, WebP, TIFF, PSD
(«no vectorial»). Hasta 50 MB. El formato se confirma con los primeros bytes (un `.ai` que no es AI se rechaza).

Se ven en el CRM los PDF, los AI guardados compatibles con PDF (pdf.js), los SVG y las imágenes. Los SVG se sirven con
`Content-Security-Policy: sandbox` (sin scripts); CDR, EPS y el resto siempre como descarga.

## ¿Está en curvas?

`revisar()` en `src/worker/logos.ts`:

| Formato | Cómo se revisa |
| --- | --- |
| SVG | `<text>`, `<tspan>` o `<textPath>` → textos sin curvas |
| PDF / AI compatible | `/Type /Font` sin comprimir → textos; si no, lo que vio pdf.js en el navegador (texto en las primeras 5 páginas) |
| EPS / AI PostScript | `%%DocumentFonts:` o `%%+ font …` → textos; si no, sin verificar |
| CDR | sin verificar |
| Imágenes, PSD | no vectorial |

## ClickUp

Al adjuntar el boceto aprobado a la subtarea del artículo (`clickup.ts`, `adjuntarBoceto`), también se adjunta el logo del
producto. Si el logo se elige o se sube después, va a la cola (`clickup_salida`, `adjuntar_logo`) y sale a la misma subtarea.
`logos_clickup` recuerda qué logo ya está en qué tarea, para no mandarlo dos veces.

## Datos

Migración `0050_logos.sql`: `logos` (de la empresa), `producto_logos` (el elegido por producto de un pedido o negocio; la clave
del producto es la misma que en `bocetos`) y `logos_clickup`. Un boceto del negocio usado en el pedido se lleva el logo elegido
para ese producto.

API: `GET/POST /records/:type/:id/logos`, `PUT /records/:type/:id/logos/producto`, `PATCH/DELETE /logos/:id`,
`GET /logos/:id/archivo`. Pruebas: `test/logos.test.mjs` y el final de «bocetos» en `test/pedidos.test.mjs`.
