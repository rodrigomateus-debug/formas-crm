# Conversación del pedido

Pedido de Rodrigo del 12/11/2026: un chat grupal en cada pedido (y negocio), como los comentarios de una tarea de ClickUp,
que queda registrado, con @menciones y la actividad del pedido entremezclada.

## Dónde se ve

- **Vista previa** (clic en una tarjeta del tablero o «Vista previa» en la tabla): la conversación se abre a la izquierda
  del panel. Se cierra con la cruz y se vuelve a abrir con «Conversación» arriba del panel (queda como la dejó cada uno).
  En pantallas angostas se abre encima.
- **Ficha** del pedido o negocio: pestañas «Conversación» y «Actividad» en el centro (los pedidos arrancan en la
  conversación; los negocios, en la actividad).
- **Menú → Conversaciones**: las que sigo, con los mensajes sin leer (el globito rojo; con «@» si me mencionaron).
- **Tarjeta del tablero de pedidos**: el globito con cuántos mensajes tiene (en rojo si hay sin leer).

## Qué se puede hacer

- Escribir (Enter manda, Shift+Enter baja de línea) y mencionar con `@` (lista de usuarios activos).
- Responder a un mensaje (queda citado; clic en la cita lleva al original), editar los propios y borrar los propios
  (un administrador borra cualquiera). Queda «(editado)» y «Mensaje borrado».
- Adjuntar archivos (hasta 10 por mensaje y 20 MB cada uno; el mensaje puede ir sin texto): con el clip, pegando con
  Ctrl+V (una captura o un archivo copiado) o arrastrándolos sobre la conversación. Imágenes, PDF, planillas, documentos,
  presentaciones, ZIP y archivos de diseño (AI, EPS, PSD, CDR, SVG…). Las imágenes se ven en el mensaje (una sola,
  grande; varias, en grilla); los demás, como tarjetas (el PDF con la miniatura de su primera página). Imágenes y PDF se
  abren a pantalla completa (el PDF con pdf.js, igual en todos los navegadores), con flechas, «Descargar» y «Abrir»; lo
  demás se descarga.
- Reaccionar con emojis (👍 ❤️ 😂 🎉 🙏 👀 ✅ 🔥): la carita al pasar el mouse por el mensaje, o el «+» al lado de las que ya
  hay. Abajo del mensaje se ve cada emoji con cuántos (en color si está el tuyo) y, al pasar el mouse, quiénes; tocar uno
  pone o saca el tuyo. Tabla `mensaje_reacciones` (migración 0049); `mensajes.reaccion_at` hace que lleguen con las
  novedades a los demás.
- «Todo» muestra los mensajes con la actividad; «Mensajes», solo el chat.
- La campanita: seguir o dejar de seguir la conversación.
- «Visto por» abajo del último mensaje y la raya de «Nuevos» desde donde había leído.

## Quién se entera

- Siguen la conversación: quien escribe, a quien mencionan (aunque la haya dejado), el propietario del registro y quienes
  lo tienen asignado en producción (Ceci, Sole…, si tienen usuario del CRM). A ellos se les cuentan los sin leer.
- A quien mencionan le llega además un mail con lo que le escribieron y el link a la conversación, con los demás avisos
  (cada 10 minutos), si tiene «Avisos por mail» prendido (Configuración → Usuarios). Si el mensaje se borra antes, no sale.

## La actividad que se ve entremezclada

Se lee de donde ya está (no se copia): cambios de etapa, propietario, monto, fecha de entrega, factura (`changes`);
cambios de estado de cada artículo en producción (`produccion_cambios`: los de ClickUp con la sincronización, a nombre
de quien tiene asignada la tarea, y los de la vista de Producción del CRM); bocetos subidos y aprobados (`bocetos`, ahora
con `aprobado_at` y `aprobado_por`); remitos subidos (`remitos`); notas, mails, llamadas, reuniones, tareas y WhatsApp
del registro (`activities`).

## Cómo está hecho

- `migrations/0041_conversacion.sql`: `mensajes`, `conversacion_participantes` (quién la sigue y hasta qué mensaje leyó),
  `produccion_cambios`, y las columnas nuevas de `bocetos` y `avisos`.
- `src/worker/conversacion.ts` y las rutas `/api/records/:type/:id/conversacion` (GET con `desde` para las novedades,
  POST para escribir, `/leido`, `/seguir`), `/api/mensajes/:id` (PATCH, DELETE) y `/api/conversaciones` (la bandeja).
- Las menciones van en el texto como `@[Nombre](id)`.
- Archivos (`mensaje_adjuntos`, migraciones 0042 y 0044): se guardan en la base, en pedazos de 1,5 MB (una fila de D1 no
  puede pasar de 2 MB: el primero en `mensaje_adjuntos.data` y el resto en `mensaje_adjunto_partes`). Las imágenes se
  achican antes en el navegador (lado mayor 2000 px). Una imagen o un PDF se reconocen por su contenido; lo demás, por la
  extensión, y se sirve como descarga. Se suben al elegirlas
  (`POST …/conversacion/adjuntos`) y quedan del mensaje al mandarlo (`adjuntos: [ids]`); se sirven en
  `/api/mensaje-adjuntos/:id`. Solo JPG, PNG, WebP o GIF (se mira el contenido del archivo). Las que se subieron y no se
  mandaron se borran al día siguiente; las de un mensaje borrado, al borrarlo.
- La pantalla (`web/src/pages/Conversacion.tsx`) pide las novedades cada 12 segundos mientras está abierta y a la vista
  (lo de los últimos 20 minutos, por índice: pocas filas), y los sin leer del menú cada 45 segundos.
- Prueba: `test/conversacion.test.mjs` (y los casos sumados en `test/produccion.test.mjs` y `test/avisos.test.mjs`).

## Lo que falta (ideas)

- Llevar los comentarios a ClickUp y traer los de ClickUp, mientras Corporate siga trabajando allá.
- Que Claude (MCP) pueda leer y escribir en la conversación.
