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
- **Duplicados:** el mismo número de remito dos veces (una foto repetida, o el mismo remito por la app y por ClickUp) es
  un solo remito; la misma foto o la misma clave de la app tampoco duplican.

Desde la app, el remito va solo al pedido cuando el PDV lleva a un único pedido **y** el CUIT o el número de remito en
Finnegans lo confirman, sin que nada lo contradiga. Si una persona ya eligió el pedido (ficha del pedido o adjunto del
PDV en ClickUp) alcanza con que el PDV coincida (o, sin PDV, el CUIT). Todo lo demás queda **para revisar**, con los
pedidos posibles: nunca se adjunta a uno «parecido». Si la foto no deja leer los datos clave, al chofer se le pide otra
en el momento, mientras todavía está con el cliente.

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
**Logística** y a los **administradores** (siempre: no hace falta sumarlos a la lista de avisos por mail). Si el pedido
se completa o se finaliza antes de que salga el mail, no se manda.

## La bandeja de Logística (`/remitos`)

- **Para revisar:** lo que no se pudo adjuntar solo o no se pudo leer, con la foto, lo leído y cómo se controló. Se
  confirma en el pedido sugerido, se busca otro pedido, se lee de nuevo o se descarta.
- **Choferes:** Logística y los administradores crean el link de cada chofer (se muestra una sola vez, con un botón para
  mandarlo por WhatsApp) y lo dan de baja si se pierde. El link es un token tipo «chofer» que solo sirve para la app de
  remitos: no abre el resto del CRM ni las otras entradas.

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
3. **Choferes:** crear el link de cada uno en Remitos → Choferes (con el nombre del chofer) y mandárselo por WhatsApp.
   Es la misma app para todos; el link es la llave personal de cada uno: dice quién mandó cada remito y se puede dar de
   baja sin tocar a los demás. En iPhone, si la agregan a la pantalla de inicio, la primera vez piden pegar el link otra
   vez (el iPhone no comparte lo guardado entre Safari y la app de inicio).

## Costo

Una lectura es una llamada a Claude con una foto: del orden de 5 centavos de dólar por remito.
