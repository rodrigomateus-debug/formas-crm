# Darwin ↔ CRM sin Pipedream ni HubSpot

Relevado el 30/10/2026 en Darwin (workspace 1986 «Formas Shop», solo lectura). Hoy hay tres workflows de Darwin
encendidos que dependen de HubSpot. Los tres se reemplazan por llamadas directas al CRM.

## 1. Alta de contacto y negocio (Darwin → CRM)

**Hoy:** «Formas Publicitarias - Hubspot» (`auto-32592435…`, disparador `session.forwarded`). Pasos: filtro de canal
«Formas Publicitarias», 6 pasos de código (origen, campaña, propietario por nombre, nombre, canal, limpieza) y 3 pasos
de HubSpot (crear o actualizar contacto, crear negocio, asociar). Problemas que tiene:

- El contacto se crea con un mail inventado (`incompleto<teléfono>@gmail.com`).
- El propietario sale de una tabla fija por *nombre* de la vendedora; si el nombre no está, queda sin propietario.
- No deduplica negocios: si la misma conversación se califica y después se escala, crea dos.
- Los campos de origen del negocio (`origen_del_prospecto`, `origen_de_la_campana`, `origen_del_negocio`) no los manda
  Darwin: los completa algo dentro de HubSpot (probablemente un workflow de HubSpot que los copia del contacto).

**Con el CRM:** el CRM hace toda esa lógica en `/hooks/darwin` (`src/worker/hooks.ts`), así que el workflow queda en:

1. El filtro de canal `solo-canal-formas` (igual que hoy).
2. Un paso `http-request`:
   - método `POST`, URL `https://<crm>/hooks/darwin`
   - headers: `Authorization: Bearer <token>` (token tipo «Darwin» de Configuración → Integraciones)
   - body `json` con un solo campo: `data` = `{{data}}` (el evento completo; un campo que es un único placeholder conserva su tipo)
3. Se borran los 6 pasos de código y los 3 de HubSpot.

El CRM, cada vez que la IA le pasa una conversación a una vendedora:

- **Contacto** con su WhatsApp (el número de la conversación, solo en canales de WhatsApp: en Instagram y el webchat el id
  del hilo no es un teléfono), su nombre y su mail (los campos inteligentes `name`, `last_name` y `email`; nunca un mail
  inventado, y sin el «nolastname» que pone Darwin cuando no sabe el apellido). Con WhatsApp o mail alcanza; si no trae
  ninguno de los dos no se crea nada y queda anotado en Configuración → Registro de entradas. Si el contacto ya existe
  (mismo mail o mismo teléfono), se completa lo que le falte.
- **Empresa**, si la IA juntó el campo `company` o el mail es corporativo: se crea (o se encuentra) con su dominio, el del
  mail, y queda asociada al contacto, al negocio y a la nota. Con un mail personal (gmail, hotmail…) y sin empresa, no se
  crea ninguna.
- **Negocio** «Nombre - Producto - Cantidad - Darwin» en Formas Shop (Inbound) / Lead calificado, asociado al contacto y a
  la empresa, con origen y campaña con la misma regla de hoy (anuncio prellenado sin utm → `META_ADS` / «Anuncio sin
  referral - …»; si no, `Orgánico` / `Directo`) y el link a la conversación. Si el contacto ya tiene un negocio abierto
  en ese pipeline, se reutiliza (calificada y después escalada: un solo negocio).
- **Propietario**: la vendedora a la que se asignó, por `forwardedToEmail` (aunque en Darwin tenga el mail de formas.ar y
  en el CRM el de formaspublicitarias.com, o al revés) y, si no, por nombre. El nombre del contacto descarta «Maru» y los
  nombres del equipo, como hoy.
- El resumen de la conversación queda como **nota** en el contacto, el negocio y la empresa.

Mientras convivan los dos workflows (el de HubSpot y el del CRM), el mismo cliente entra por los dos. La sincronización
nocturna desde HubSpot los une: el contacto por teléfono (o mail) y el negocio por el link a la conversación de Darwin, y
queda el de HubSpot con lo que había sumado el del CRM (empresa, nota, actividad). El día del corte se apaga el de HubSpot.

Si el CRM no está en Cloudflare Access para `/hooks/*` (ver README), no hace falta permitir IPs; si se quiere,
Darwin sale desde 32.192.137.35, 32.192.62.181 y 18.235.132.229.

## 2. Venta ganada (CRM → Darwin)

**Hoy:** «Actualizar Estado de la Venta en Darwin» y «… Darwin Marketing» se disparan con «New Deal In Stage» de
HubSpot (Cierre ganado), buscan el contacto asociado y su teléfono, y en Darwin marcan el campo 13508 = `closedwon` y
registran el ingreso (fuente Marketing 16, ARS, monto y fecha de cierre, referencia = id del negocio). En octubre
fallaron 21 de 36 y 26 de 37 corridas.

**Con el CRM:** cuando un negocio pasa a una etapa ganada, el CRM avisa a la URL configurada en Configuración →
Integraciones → «Avisos a otros sistemas» (evento «Negocio ganado») con este cuerpo:

```json
{
  "event": "deal.won",
  "deal": { "id": 123, "name": "…", "amount": 900000, "currency": "ARS", "closedate": "2026-10-30",
            "whatsapp_thread": "5493511234567", "darwin_conversation_id": "15552-5493511234567", "link_a_darwin": "…" },
  "owner": { "id": 1, "name": "…", "email": "…" },
  "contacts": [{ "id": 456, "name": "…", "phone": "…", "whatsapp_thread": "549…" }],
  "company": { "id": 789, "name": "…" }
}
```

En Darwin: un workflow nuevo con disparador `inbound-webhook` (su URL va en el aviso del CRM) y los mismos dos pasos
de hoy: `set_session_field` (campo 13508 = `closedwon`, hilo = `{{trigger.body.deal.whatsapp_thread}}`) y
`record_revenue` (monto `deal.amount`, fecha `deal.closedate`, referencia `deal.id`). Después se apagan los dos
workflows que leen HubSpot. El teléfono ya viene resuelto, que es justo donde fallan hoy.

## 3. Borradores apagados que leen pedidos de HubSpot

«Outbound Pedidos» y «Outbound - Saldo Pendiente» están apagados (nunca se activaron: a la cuenta de HubSpot le
faltaban permisos). Si se retoman, se hacen con un aviso del CRM sobre pedidos en vez de leer HubSpot.

## 4. Actividad diaria: resumen del día y consultas (Darwin → CRM)

Pedido del 18/11/2026: que el CRM se entere de lo que pasa en las conversaciones **después** de que Maru las pasa a una
vendedora, con un resumen por día en el contacto y los datos duros de lo que consultó cada cliente («quién consultó por
botellas»). Código: `src/worker/darwin.ts`; pantalla: **Analíticas → «Consultas por WhatsApp»** (los números: lo más consultado, por
categoría, por semana, quién atendió y cuántos compraron después, y el buscador con el listado), **Inicio → «Esperan
respuesta»** (los clientes sin contestar, para la vendedora) y la tarjeta «Consultas por WhatsApp» en la ficha del contacto y
de la empresa (el link viejo `/consultas` lleva a Analíticas); para Claude, las herramientas `buscar_consultas` y `pendientes_de_respuesta` del MCP.

**De dónde salen los datos.** La API REST de Darwin (`api.getdarwin.ai`, spec revisada el 18/11/2026) **no tiene un
endpoint para leer mensajes ni para listar las conversaciones**: `GET /v1/sessions?id=<teléfono>` da las sesiones de un
contacto con sus campos inteligentes (sin resumen) y `GET /v1/webhook/events` devuelve eventos de ejemplo, no los reales.
Por eso es Darwin el que le avisa al CRM: el CRM se suscribe a los eventos de las conversaciones con `POST /v1/webhook`.

Para conectarlo:

1. En Darwin (Configuración → Claves API, workspace Formas Shop) hay una clave propia del Hub, «FORMAS HUB CRM». Se
   carga en el Worker: `npx wrangler secret put DARWIN_API_KEY`.
2. En el Hub, Configuración → Integraciones → «Darwin: resumen del día y consultas» → **Conectar Darwin**. Crea un token
   propio del CRM y suscribe `https://<hub>/hooks/darwin/evento?token=…` a `session.*` (abierta, pasada a una vendedora,
   analizada con resumen y campos, cambio de etapa, cerrada). «Volver a conectar» reemplaza la suscripción y revoca el token
   anterior; las otras suscripciones de Darwin (Zapier, Pipedream, etc.) no se tocan.

Darwin entrega cada evento «al menos una vez»: el CRM guarda cada uno una sola vez (clave: tipo + sesión + `forwardedAt` /
`summarizedAt` / etapa).

Cada evento trae el resumen que hace Darwin de la sesión (`summary`), sus campos inteligentes (`producto`, `cantidad`,
`Categoria`, `presupuesto`, `fecha_estimada`…), a quién se asignó y cuándo respondió el equipo (`lastHumanActivityAt`). El
CRM los guarda tal cual (`darwin_eventos`) y lleva el estado de cada conversación (`darwin_conversaciones`).

**El resumen del día.** De 0 a 6 de la mañana (cron de los :05, de a 15 por corrida), por cada conversación que tuvo
movimiento el día anterior, Claude (`claude-sonnet-5-5`) lee los eventos, los resúmenes de Darwin, los campos y el resumen
que el CRM guardó la vez anterior, y devuelve:

- **El resumen**: quién habló, qué pidió el cliente, qué se le respondió y en qué quedó, y el próximo paso. Queda como
  actividad de WhatsApp («Resumen del día», con el link a la conversación) en el **contacto** (buscado por teléfono, o por
  mail), su **empresa** principal y su **negocio** (el que tiene el link a esa conversación, si no el abierto más reciente),
  a nombre de la vendedora que la tiene (o del propietario del contacto).
- **Las consultas**: un renglón por producto consultado ese día, con categoría y tipo de una **lista fija**
  (`CATALOGO` en `darwin.ts`: Drinkware → Botella, Termo, Vaso…; Textil → Remera, Gorra…), producto como lo nombró, cantidad,
  precio unitario y total, fecha en que lo necesita, ocasión (Fin de año, Día de la Madre…), personalización, si pidió
  muestra o boceto, objeción, competidor y lugar de entrega. Para sumar un tipo, se agrega a la lista.

Reglas:

- Si el contacto **no está** en el CRM, no se crea nada (queda «sin contacto» en `darwin_resumenes`): el contacto lo crea el
  aviso de siempre (§ 1) cuando Maru pasa la conversación.
- Si ese día **no hubo nada nuevo** (un cierre automático, un saludo, lo mismo que ya decía el resumen anterior), no se escribe.
- Si llega otro evento de un día ya resumido, ese día se rehace: se reemplaza el resumen y las consultas, sin duplicar.
- A Claude no se le manda el teléfono, solo los últimos 4 dígitos.
- Sin `ANTHROPIC_API_KEY` los eventos se guardan igual y se resumen cuando esté. «Resumir ahora» a mano:
  `POST /api/darwin/resumir` (administradores). Estado: `GET /api/darwin/estado`.

**Sin respuesta.** El recuadro «Esperan respuesta» del Inicio lista las conversaciones que Maru ya pasó a una vendedora donde el
cliente escribió (`session.replied`) después de la última respuesta del equipo (`lastHumanActivityAt`) y nadie le contestó en
las últimas 4, 12, 24, 48 o 72 horas. El perfil Ventas ve las suyas. **A confirmar con eventos reales**: `session.replied`
existe en los workflows de Darwin pero no figura en la lista de eventos de `POST /v1/webhook`; si con `session.*` no llega,
este recuadro queda vacío y hay que mandarlo con un workflow (disparador `darwin-event` `session.replied` → `http-request` a la
misma URL, con `eventType`, `timestamp` y `data`).

**Los mensajes uno por uno (Claude).** La API de Darwin no da los mensajes, pero el conector de Darwin en Claude sí
(`darwin_conversation__events`). Una **tarea programada de Claude**, todas las noches, busca las conversaciones del workspace
1986 con actividad el día anterior, lee sus mensajes (`types: ['message']`, `since` = el comienzo del día) y los carga en el Hub
con la herramienta `cargar_conversacion_darwin` del conector «Formas Hub» (solo administradores). Cada mensaje se guarda una
vez (`darwin_mensajes`, por su id de WhatsApp), con quién lo escribió: `human` es el cliente, `user` alguien del equipo (desde el
inbox o el WhatsApp del celular), el resto Maru. El resumen del día usa esos mensajes como fuente principal (hasta ~15.000
caracteres por conversación y día; si son más, los últimos) y el recuadro «Esperan respuesta» sale de ellos: el último mensaje del
cliente contra el último del equipo. Si la tarea no corrió, el resumen sale igual de los eventos.

**Ícono del conector.** El MCP declara el ícono del Hub (`serverInfo.icons`, `hub-192.png`) y `/favicon.ico` devuelve ese
mismo ícono, para que claude.ai lo muestre en el conector.
