# Remitos y estado de entrega

Cada remito firmado (foto o PDF) queda en su pedido, Claude lo lee y el pedido sabe qué se entregó y qué falta,
producto por producto. ClickUp no se toca: los remitos se siguen trayendo de ClickUp como siempre, y además llegan
desde la ficha del pedido y desde la app del chofer. Todos van a la misma lista, así que el día que todo pase por la
app no cambia nada para nadie.

## De dónde llegan

| Origen | Cómo |
|---|---|
| ClickUp | La foto que suben a la tarea del PDV (o a un artículo) con el número del PDV como nombre, como hasta ahora (`clickup.ts`). |
| Ficha del pedido | Botón «+ Remito» en la tarjeta «Entrega». Se lee en el momento. |
| App del chofer | `https://<crm>/hooks/chofer/`, con el link personal de cada chofer (ver abajo). Se lee en el momento y el chofer ve el resultado. |

## Cómo se lee y a qué pedido va (`src/worker/remitos.ts`)

Claude (modelo `claude-opus-5-5`, con salida en formato fijo) devuelve lo que dice el remito: número, fecha, PDV (en
«Nº Pedido Web» y en «Observaciones»), cliente, CUIT, productos con código y cantidad, firma, sello de quien recibió, lo
escrito a mano, si se recibió «a controlar» y si hay otro remito en la foto. No decide a qué pedido va: eso lo decide el
CRM cruzando datos que se controlan entre sí.

- **PDV:** aparece dos veces; tienen que coincidir y llevar a un único pedido.
- **CUIT:** se valida con el dígito verificador (un error de lectura se detecta solo) y tiene que ser el del cliente del
  pedido (el de la empresa en el CRM o, si no tiene, el de Finnegans). Nunca se toma el de Formas.
- **Número de remito:** Finnegans sabe de qué pedido es cada remito que emite.
- **Productos:** tienen que ser del pedido (por código; si no hay código, por nombre).
- **Duplicados y hojas:** el mismo número de remito dos veces (una foto repetida, o el mismo remito por la app y por
  ClickUp) es un solo remito; la misma foto o la misma clave de la app tampoco duplican. Si la otra foto del mismo número
  trae productos que las demás no tienen, es otra hoja de un remito largo y suma (cada producto de un remito cuenta una
  vez). El chofer puede sacar o elegir varias fotos seguidas: cada una va por separado.

Desde la app, el remito va solo al pedido cuando el PDV lleva a un único pedido **y** el CUIT o el número de remito en
Finnegans lo confirman, sin que nada lo contradiga. Si una persona ya eligió el pedido (ficha del pedido o adjunto del
PDV en ClickUp) alcanza con que el PDV coincida (o, sin PDV, el CUIT). Todo lo demás queda **para revisar**, con los
pedidos posibles: nunca se adjunta a uno «parecido». Si la foto no deja leer los datos clave, al chofer se le pide otra
en el momento, mientras todavía está con el cliente.

**El PDV que escribe el chofer.** No se confirma en cada remito (a la larga se toca «OK» sin mirar): la app se lo pide
solo cuando hace falta (el remito no deja leerlo, no coincide en los dos lugares o no hay pedido con ese número), y
después de «Listo» tiene «¿No es este pedido? Corregilo». Lo que escribe no se toma a ciegas: se cruza con lo ya leído
(sin volver a leer la foto) y tiene que cerrar con el CUIT o el remito en Finnegans, como el leído. Si contradice un
PDV que el remito dice bien en los dos lugares, solo vale si Finnegans tiene el remito en el pedido que dice el chofer;
si no, deja de contar y lo revisa Logística con los dos pedidos posibles.

Lo que se lee de ClickUp se lee de fondo (cada 10 minutos, unos pocos por vez), solo de los últimos 60 días; los más
viejos se leen cuando alguien abre el pedido. Cada remito se intenta hasta 3 veces.

## Estado de entrega

Por producto: vendido (los renglones del pedido de Finnegans o de ClickUp) contra entregado (la suma de los remitos
leídos). El pedido queda con «Estado de entrega»:

| Estado | Cuándo |
|---|---|
| Completa | Todo lo vendido figura en los remitos. |
| Faltan entregas | Falta algo (sin tolerancia: 990 de 1000 es faltante). |
| Con diferencias | Un remito trae más de lo vendido o un producto que no está en el pedido. |
| Finalizada con faltante | Logística (o un administrador) cerró la entrega aceptando lo que falta, con el motivo. Se puede reabrir. |
| Falta el remito | ClickUp dice que se entregó y no hay ningún remito leído. |
| Remito por revisar | Hay remitos pero todavía ninguno leído y confirmado. |

«Falta entregar» dice qué falta. Si ClickUp dice «Entregado» y los remitos no cubren todo, la ficha lo avisa. En la
lista y el tablero de pedidos, el botón **«Faltan entregas»** filtra los que tienen faltantes, diferencias o falta el
remito. Cuando un remito nuevo deja un pedido con faltantes o diferencias, les llega un mail a los usuarios con perfil
**Logística** y a los **administradores** que tienen **«Avisos por mail»** prendido (Configuración → Usuarios; arranca
apagado). Si el pedido se completa o se finaliza antes de que salga el mail, no se manda.

### Un renglón del remito con otro nombre: asignarlo a mano

Pedido de Rodrigo del 10/11/2026 (PDV 30971: el remito decía «70 Jarro Bossa Waterdog» y el pedido, otro nombre). Si un
renglón del remito no se parece a ningún producto del pedido, queda en «En los remitos pero no en el pedido» con el botón
**«Asignar a producto»**: se elige el producto (o los productos) del pedido, entre los que todavía les falta, y cuánto va a
cada uno. Cuenta como entregado: si el remito dice 70 y el producto 100, quedan 30. La suma no puede pasar lo que dice el
remito; lo que no se asigna sigue como diferencia («sin asignar»). Lo asignado se ve en «Asignados a mano», con quién y
cuándo, y se puede cambiar o deshacer. Cualquier usuario que puede editar lo puede hacer.

Se guarda en `remito_asignaciones` (migración 0034) con la misma clave con que se cuenta el renglón (número de remito,
producto y cuál de los iguales): sigue valiendo si el remito se vuelve a leer o llega otra foto del mismo número. Si el
producto ya no está en el pedido, la asignación no vale y el renglón se vuelve a emparejar solo.
`POST /api/records/order/:id/entrega/asignar` con `{ clave, lineas: [{ i, cantidad }] }` (sin líneas, la deshace).

### Un remito de varios pedidos

Pedido del 11/11/2026 (remito R-0001-00027818, PDV 30314 y 30315): un mismo remito (un camión) puede llevar productos de
más de un pedido. En la revisión, **«Es de varios pedidos…»** arranca con el pedido donde está (o con los posibles, si el
PDV no coincide en los dos lugares), **«+ Sumar otro pedido»** agrega los demás y, para cada renglón, el desplegable ofrece
los productos de todos los pedidos agrupados por pedido (cada uno con su PDV adelante). **«Confirmar en los N pedidos»**
guarda todo. El primero es el **principal** (`remitos.record_id`); los otros van en `remito_pedidos` (migración 0036).

Cómo cuenta: cada renglón cuenta en el pedido al que se lo asignó (`remito_asignaciones`, con la misma clave de siempre); lo
que no se asignó a ninguno se empareja solo en el principal. Lo asignado a los otros pedidos se descuenta del renglón, así
nada se cuenta dos veces. En un pedido que no es el principal, lo del remito que no se le asignó aparece aparte («De un remito
de varios pedidos…», no es una diferencia de ese pedido) con «Asignar a producto», por si va ahí. El remito se ve en la
tarjeta «Entrega» de todos sus pedidos («Remito de varios pedidos: también …»). Quitar un pedido del remito lo saca de ahí y
sus renglones vuelven al principal; otra foto del mismo número que dice el PDV de otro de sus pedidos queda repetida.
`POST /api/remitos/:id/revisar` con `{ accion: 'confirmar', pedido, pedidos: [otros], productos: [{ position, pedido, i }] }`
(`pedidos` reemplaza la lista; si no se manda, queda la que había).

## La pestaña «Entregas» de Logística (`/entregas`)

- **Remitos para revisar:** lo que no se pudo adjuntar solo o no se pudo leer, con la foto, lo leído y cómo se controló. Se
  confirma en el pedido sugerido, se busca otro pedido, se lee de nuevo o se descarta.
  Si el pedido está identificado pero ningún producto (o alguno) del remito se reconoce, cada producto del remito tiene un
  desplegable con los productos de ese pedido (con lo que falta de cada uno) para elegir su par; al confirmar queda como
  asignación a mano con toda la cantidad del renglón (`productos: [{ position, i }]` en `POST /api/remitos/:id/revisar`).
  «Que lo busque solo» deja que el CRM lo empareje (pedido de Rodrigo del 10/11/2026, PDV 2402).
- **Revisados:** los que ya revisó una persona, el más reciente primero (`GET /api/remitos/revisados`): qué se decidió
  (confirmado en tal pedido, descartado, repetido), quién y cuándo, y a qué producto va cada renglón. Desde acá se corrige
  con los mismos botones: otro pedido, cambiar los productos, leer de nuevo o descartar.
- **Choferes:** Logística y los administradores crean el acceso de cada chofer: su **código de 8 números** y su link
  (con un botón para mandarlos por WhatsApp). Lo vuelven a ver con «Ver código» si el chofer lo pierde, y lo dan de baja
  si cambia de celular o quedó en manos de otro (se dan de baja el código y el link juntos). El link es un token tipo
  «chofer» que solo sirve para la app de remitos y del recorrido: no abre el resto del CRM ni las otras entradas; el
  código es otra forma de ese mismo link.

### La guía del expreso

Si en la foto está la guía de un expreso (Vía Cargo, Andreani, OCA…), la lectura saca también la empresa, el número de
guía, el remito del expreso, el destinatario y la localidad (`guia_expreso`). Con guía no se le pide otra foto al chofer
aunque tape parte del remito o el remito no esté firmado. La foto llega con la parada desde la que se sacó (columna
`parada`, migración `0063_remito_parada.sql`); si no, y no se sabe de qué entrega es, la app le pregunta al chofer con sus
entregas de hoy para tocar (`POST /hooks/chofer/api/remitos/:id/pdv` con `{ "parada": "p:…" }` o `{ "pdv": "…" }`). La
guía se carga en la entrega por expreso (ver
[CRONOGRAMA.md](CRONOGRAMA.md#choferes-expresos-y-de-dónde-sale)); queda un control «Guía del expreso» en el remito
que dice dónde quedó o por qué no, y el remito la muestra con «Copiar» y, si el expreso tiene, «Ver el seguimiento».

## La app del chofer (`web/chofer/`)

Una página que se agrega a la pantalla de inicio del celular (PWA), servida por el Worker en `/hooks/chofer/` (esa ruta
no pasa por el login de Cloudflare Access). Saca la foto, la achica en el celular, la manda y muestra el resultado:
listo (con lo leído), «Llegó, lo revisa Logística» o «Sacala de nuevo» con el motivo. Sin señal, las fotos quedan
guardadas en el celular y se mandan solas cuando vuelve; reintentar nunca duplica. Se compila aparte
(`vite.chofer.config.ts`, sale a `dist/chofer/`).

## Qué hay que configurar

1. **La clave de la API de Claude:** secreto `ANTHROPIC_API_KEY` en el repo (GitHub → Settings → Secrets and variables →
   Actions). El despliegue la carga en el Worker. Sin la clave, los remitos se guardan igual y se leen cuando esté.
2. **Logística:** los usuarios de Logística, con el perfil Logística (Configuración → Usuarios). Ellos y los
   administradores reciben los faltantes y pueden finalizar entregas y crear los links de los choferes.
3. **Choferes:** crear el acceso de cada uno en Entregas → Choferes (con el nombre del chofer) y pasarle el código o el
   link. Los choferes no tienen mail de Formas, así que no entran con un usuario: abren la app (`/hooks/chofer/`),
   escriben su **código de 8 números una sola vez** y queda guardado en el celular (pedido de Rodrigo del 13/11/2026); o
   abren su link, que entra directo. Es la misma app para todos; el acceso es la llave personal de cada uno: dice quién
   mandó cada remito y se puede dar de baja sin tocar a los demás. La app misma les muestra cómo agregarla a la pantalla
   de inicio; guardada ahí, abre ya con su acceso (el manifest lo lleva, porque el iPhone no comparte lo guardado entre
   Safari y la app de inicio). Si igual abre sin él, pide el código una vez.
   - Contra quien prueba códigos al azar: hasta 10 intentos errados por conexión cada 15 minutos y 300 en total por
     hora (`POST /hooks/chofer/api/entrar`, tabla `chofer_intentos`, migración `0059_codigo_chofer.sql`). Pasado eso,
     la app dice que espere unos minutos; a los que ya entraron no les cambia nada.

## Costo

Una lectura es una llamada a Claude con una foto: del orden de 5 centavos de dólar por remito.

## Dirección de entrega (pedido de Rodrigo del 12/11/2026)

Arriba de la tarjeta «Entrega» del pedido está la dirección de entrega (`src/worker/direcciones.ts`,
`web/src/pages/Direcciones.tsx`, migración 0048):

- **Una dirección** por defecto: todo el pedido va ahí. Se elige de las sugerencias de **Google Maps** y queda
  «Validada en Google Maps», con «Ver en el mapa». Si Google la ubica sin altura (solo la calle o el barrio), avisa
  «Sin altura». Escrita a mano, sin elegirla de Google, queda «Sin validar». Lleva un detalle opcional (piso, depto,
  horario, quién recibe).
- **Retira en Formas** (pedido de Rodrigo del 13/11/2026): en lugar de enviarlo, el cliente lo retira en una de las
  direcciones de Formas: **Depósito Gral. Roca** (General Roca 4250) u **Oficina Matienzo** (Matienzo 1308), las mismas
  bases del cronograma (settings `cronograma`). En la tarjeta sin dirección, «Retira en Formas» despliega las dos y se
  guarda al elegir una; en «Cambiar», cada dirección tiene «Envío / Retira en Formas». Se ve como «Lo retira el cliente»,
  con el detalle opcional (quién retira, día y horario). Es una dirección más (columna `retira` con el id de la base,
  migración 0052): con varias, parte puede retirarla el cliente y parte enviarse. El resumen del pedido dice
  «Retira en Formas: Oficina Matienzo». La dirección la pone el servidor; solo se aceptan las bases configuradas.
- **Varias direcciones** («Entregar en varias direcciones»): una tabla con los productos del pedido y cuánto va a cada
  dirección. Lo repartido se descuenta del total de cada producto («Falta repartir»); no se puede pasar de lo que tiene
  el pedido (la pantalla no deja guardar y el servidor lo rechaza). «+ lo que falta» pasa a una dirección todo lo que queda.
- La validación la hace el servidor: la pantalla manda el lugar elegido de Google y el CRM le vuelve a pedir a Google la
  dirección, las coordenadas y la localidad. La clave de Google queda en el servidor.
- El pedido guarda el resumen en «Dirección de entrega» (`direccion_entrega`, de solo lectura): la dirección, o
  «N direcciones: …». Queda en el historial.
- **Cronograma** ([CRONOGRAMA.md](CRONOGRAMA.md)): la ruta del día usa estas direcciones (una parada por dirección, con el
  punto de Google en el mapa). Cambiar la dirección desde la parada pasa por acá (`direccionDesdeRuta`): con una sola, la
  reemplaza (sin validar); con varias, pide hacerlo en la tarjeta. Las direcciones que ya estaban cargadas en el pedido
  pasaron a la tarjeta con la migración 0048.
- Sin dirección cargada, sugiere la del pedido de venta de Finnegans y, si no hay, la de la empresa.
- Lo cargan quienes pueden editar el pedido (también la vendedora, en sus pedidos).

**Para que valide con Google Maps** hace falta la clave `GOOGLE_MAPS_API_KEY` (Google Cloud → APIs y servicios →
habilitar **Places API (New)** → Credenciales → Crear clave de API, restringida a esa API) en los secretos del repositorio
de GitHub: el despliegue la carga en el Worker. Sin la clave, las direcciones se cargan a mano y quedan «Sin validar».
Prueba: `test/direcciones.test.mjs` (Google Maps simulado).
