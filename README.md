# Formas CRM

CRM propio de Formas Publicitarias para reemplazar HubSpot: contactos, empresas, negocios y pedidos, con su
actividad (notas, mails, llamadas, reuniones, WhatsApp y tareas), pipelines, tablero de negocios, integración con
Claude (MCP) y una API compatible con la de HubSpot para que los tableros sigan andando.

- Qué cubre y qué falta para reemplazar el 90 % de HubSpot: [docs/ALCANCE.md](docs/ALCANCE.md).
- Cómo pasar los tableros (formas-tablero, formas-shop-tablero) al CRM: [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md).
- Por qué Cloudflare, cuánto aguanta (prueba con el volumen de 5 años) y cuándo revisarlo: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).
- Remitos (ClickUp, ficha del pedido y app del chofer), lectura con Claude y qué falta entregar: [docs/REMITOS.md](docs/REMITOS.md).
- Producción (la vista de ClickUp de Ceci y Sole en el CRM, editable; arranca con Formas Shop): [docs/PRODUCCION.md](docs/PRODUCCION.md).
- Login propio con «Ingresar con Google» y el Design System de Formas, en lugar de la pantalla de Cloudflare Access, y cómo ponerlo en marcha: [docs/LOGIN.md](docs/LOGIN.md).
- Conversación de cada pedido (chat del equipo con @menciones y la actividad entremezclada): [docs/CONVERSACION.md](docs/CONVERSACION.md).
- Perfiles y qué ve cada uno (el perfil Ventas ve lo suyo): [docs/PERFILES.md](docs/PERFILES.md).

## Cómo está hecho

Un solo Worker de Cloudflare, igual que el tablero de Formas Shop:

| Pieza | Qué es |
|---|---|
| `src/worker/` | API (Hono) sobre D1 (SQLite). Modelo genérico como HubSpot: `records` con propiedades en JSON, `associations`, `activities`, `changes` (historial). |
| `web/` | Interfaz en React. Se compila a `dist/` y el Worker la sirve. Usa el Design System de Formas Shop 2026 (dirección «ledger»: tokens `ui-*` y capa semántica en `web/src/styles.css`), con tema claro, oscuro y alto contraste que cada uno elige en su usuario, abajo en el menú (`web/src/theme.ts`). Los desplegables son el `SelectField` del DS (`web/src/Select.tsx`), no la lista del navegador. |
| `web/chofer/` | App del chofer para mandar la foto del remito firmado (PWA). Se compila aparte a `dist/chofer/` y se sirve en `/hooks/chofer/`, sin el login de Access: cada chofer entra con su link. |
| `src/worker/remitos.ts` | Remitos: los lee Claude (`ANTHROPIC_API_KEY`), los cruza con el pedido y calcula qué falta entregar ([docs/REMITOS.md](docs/REMITOS.md)). |
| `/mcp` | Servidor MCP para Claude y Cowork (`src/worker/mcp.ts`). |
| `/hooks/*` | Entradas de Darwin, prospección por LinkedIn y formularios web (`src/worker/hooks.ts`). Sin Zapier. |
| `/crm/v3/*`, `/crm/v4/*`, `/oauth/*` | API compatible con HubSpot para los tableros (`src/worker/compat.ts`). |
| `/hooks/migrate` | Carga masiva desde HubSpot (`src/worker/migrate.ts` + `scripts/migrate-hubspot.mjs`), con token de administrador: `POST /hooks/migrate` carga cada lote y `GET /hooks/migrate/properties` da las propiedades que el CRM ya conoce. Va por `/hooks` (no por `/api/migrate` ni `/api/meta`) porque `/api` pide el login de Access. |
| Cron a los :05, :15… | Avisos por mail (`src/worker/avisos.ts`: resumen de tareas a la mañana y lo que te asignan), fotos de Google de los usuarios (`src/worker/fotos.ts`) y registro automático de mails de Gmail (`src/worker/gmail.ts`), en su propia corrida para no quitarle consultas a ClickUp y Finnegans (a los :00, :10…). |
| Tareas de GitHub | Compras de clientes cada mañana (`scripts/clientes.mjs`, [docs/CLIENTES.md](docs/CLIENTES.md)), PDF de facturas (`scripts/facturas-pdf.mjs`) y respaldo diario. |

Quién entra: «Ingresar con Google» con el mail de Formas y usuario activo en el CRM ([docs/LOGIN.md](docs/LOGIN.md)); hasta sacarlo, Cloudflare Access adelante (igual que el tablero). Las integraciones y Claude entran con
tokens propios (`fcrm_…`) que se crean en Configuración → Integraciones. Los ids de todo lo migrado son los de
HubSpot, así los links y los cruces con Finnegans/ClickUp/Darwin no cambian; lo nuevo arranca en 900000000001.

## Desarrollo local

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev
```

Abre en http://localhost:8787 como el usuario de `DEV_USER_EMAIL` (archivo `.dev.vars`, ver `.dev.vars.example`).
Para tener datos de prueba: `node scripts/demo-seed.mjs`. Pruebas de punta a punta (con `npm run dev` corriendo):

```bash
npm test
```

La prueba de Gmail necesita las variables de `node test/gmail-dev-vars.mjs` (y reiniciar `npm run dev`); sin eso se saltea.

## Publicar en Cloudflare (una sola vez)

1. Crear la base y copiar el `database_id` que devuelve en `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create formas-crm
   ```

2. Publicar (compila la interfaz, aplica las migraciones de la base y sube el Worker):

   ```bash
   npm run deploy
   ```

3. Cloudflare Access (Zero Trust → Access → Applications): una aplicación «Formas CRM» sobre el dominio del CRM con
   la misma política de mails que el tablero, y estas rutas **sin** Access (Bypass), porque entran con token propio:
   `/mcp*`, `/hooks/*` (también la app del chofer, `/hooks/chofer/`), `/crm/*`, `/oauth/*`, `/hubspot/*`, `/health`. El «Application Audience (AUD) Tag» va en
   `ACCESS_AUD` dentro de `wrangler.jsonc` (no es secreto), junto con `ACCESS_TEAM_DOMAIN` (el equipo de Access que usa
   Formas Studio). Si se recrea la aplicación de Access, cambia el AUD y hay que actualizarlo ahí.
4. Entrar con el mail de `ADMIN_EMAIL`: queda como administrador.

**Quién entra:** la política de Access deja pasar los mails de Formas (regla «Emails ending in»: `@formas.ar`,
`@formaspublicitarias.com`) y el CRM deja entrar solo a quien está en Configuración → Usuarios y activo. Para dar acceso
a alguien, se lo agrega ahí; para sacárselo, se lo desactiva o se lo elimina (el tachito de su fila). Al eliminarlo, sus
registros y sus tareas abiertas pasan a quien se elija (o quedan sin propietario) y queda en el historial de cada registro; se
revocan sus tokens y sale de la lista y de los desplegables, pero las notas, los mails y las tareas hechas siguen con su nombre.
Si se lo vuelve a agregar con el mismo mail, vuelve. Los equipos de cada usuario son una sola lista: el primero es el principal
(Negocios arranca en su pipeline). La migración trae a los propietarios de HubSpot con su equipo.

**Superadmin y «Ver como»:** el administrador principal (`ADMIN_EMAIL`) es superadmin siempre, y puede darle ese permiso a
otros administradores (Configuración → Usuarios, columna Permisos). Un superadmin puede mirar el CRM como lo ve otra persona
desde su misma sesión: menú del usuario (abajo a la izquierda) → «Ver como…», o el ojito en su fila de Usuarios. Ve sus
pipelines, sus tareas, sus conversaciones y lo que puede hacer, con un cartel arriba para volver a su usuario. Es solo para
mirar: mientras tanto el CRM rechaza cualquier cambio (`src/worker/auth.ts`, cabecera `x-ver-como`; nunca con un token).

## Migrar desde HubSpot

Necesita el token de la app privada de HubSpot (el mismo `HUBSPOT_TOKEN` de los tableros sirve si tiene permiso de
lectura de mails y pedidos) y un token de administrador del CRM (Configuración → Integraciones → tipo «API»).

```bash
HUBSPOT_TOKEN=pat-… CRM_URL=https://<crm> CRM_TOKEN=fcrm_… node scripts/migrate-hubspot.mjs --limit=50
```

Con `--limit=50` es una prueba corta. Después, la corrida completa (sin `--limit`, tarda alrededor de una hora por los
~40.000 mails) y, mientras se usen los dos sistemas, una sincronización diaria de lo cambiado:

```bash
HUBSPOT_TOKEN=pat-… CRM_URL=https://<crm> CRM_TOKEN=fcrm_… node scripts/migrate-hubspot.mjs --since=2026-11-01
```

Es repetible: no duplica y no pisa lo que ya se editó en el CRM. Trae propietarios (con su equipo), pipelines,
propiedades (crea las custom que falten y suma opciones nuevas), contactos, empresas, negocios, pedidos, asociaciones
con empresa principal, historia de etapas, notas, mails, llamadas, reuniones, tareas y WhatsApp.

## Conectar lo que hoy escribe en HubSpot

| Quién | Hoy | En el CRM |
|---|---|---|
| Claude / Cowork (prospección diaria, cargas) | Conector de HubSpot | Conector personalizado en claude.ai con la URL `https://<crm>/mcp/<token>` (token tipo «Claude (MCP)»). |
| Darwin (WhatsApp) | Workflow de Darwin con 3 pasos de HubSpot (vía Pipedream) | Un solo paso `http-request` del workflow → `POST https://<crm>/hooks/darwin` con el evento entero. Y al ganar un negocio el CRM le avisa a Darwin. Paso a paso en [docs/DARWIN.md](docs/DARWIN.md). |
| Prospección por LinkedIn | Zapier → HubSpot (~300 leads por mes, con perfiles duplicados) | La herramienta de LinkedIn → `POST https://<crm>/hooks/linkedin` directo, con token tipo «LinkedIn». Deduplica por URL del perfil. Zapier se da de baja. |
| Cualquier otra | — | `POST https://<crm>/hooks/bundle` con `{ contact, company, deal, note, task, owner_email }`. |
| Formularios web | Formularios de HubSpot | `POST https://<crm>/hooks/form/<nombre>`; cada formulario se configura con la clave `form:<nombre>` en `settings`. |
| Mails | Conexión de bandeja de HubSpot | Gmail: ver abajo. |
| Tableros | API de HubSpot | Ver [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md). |

## Avisos por mail

Salen por Gmail con la misma cuenta de servicio, de la casilla de quien los recibe a sí misma (o de `desde`, si se
configura). Necesitan sumar el permiso `https://www.googleapis.com/auth/gmail.send` al Client ID de la cuenta en la
delegación de todo el dominio. Los avisos:

- **Resumen de la mañana** (días hábiles, desde las 8): las tareas para hoy y las vencidas más recientes.
- **Asignaciones:** cuando alguien le asigna a otra persona un registro o una tarea desde la pantalla o desde Claude,
  le llega un mail en los 10 minutos siguientes (lo que mueven las integraciones no avisa).
- **Faltantes de entrega** (a Logística y a los administradores): ver `docs/REMITOS.md`.

Solo les llegan a los usuarios con **«Avisos por mail»** prendido (Configuración → Usuarios, columna «Avisos por mail»;
`users.avisos_mail`, migración 0038). Arranca **apagado** para todos, también para los usuarios nuevos: se prende por
persona. Con token de administrador: `GET /hooks/avisos` (configuración y estado), `PUT /hooks/avisos` (por ejemplo
`{"hora": 8}`) y `POST /hooks/avisos/enviar` (`?resumen=1` manda el resumen ya).

## Después de cada entrega

Cuando un pedido pasa a «Entregado» (ClickUp), la vendedora tiene una tarea para los 3 días de recibido: preguntar cómo
le fue, pedir un referido si le fue bien y, a los 10 días, la reseña de Google (`src/worker/postentrega.ts`, la misma regla
que «PARA HACER URGENTE» del tablero). Varios pedidos del mismo cliente en la misma semana van en una sola tarea. No va para
clientes internos ni para lo que carga la tienda con vendedor «STP».

## Unidades de negocio

Formas Shop (bolsa, verde), Corporate (maletín, azul) y NoEstres (carita, naranja), con su ícono y color en todo el CRM. El
filtro «Unidad de negocio» (varias a la vez) está en contactos, empresas, negocios y pedidos (tabla y tablero), en Tareas y
en Inicio; también en los filtros avanzados y se guarda en las vistas. De dónde sale la unidad: el negocio, del equipo de
su pipeline; el pedido, de la unidad que trae ClickUp; contactos, empresas y tareas, del equipo de su propietario (el
principal o uno de los extra, en Configuración → Usuarios). La columna «Unidad de negocio» viene en las listas.

## Datos para facturar

Cuando un negocio pasa a ganado, el CRM revisa la empresa principal (`src/worker/facturar.ts`): que tenga CUIT y que sea
válido (dígito verificador) y razón social. Si falta algo, la vendedora tiene una tarea «Completar datos para facturar»
para hoy (una por negocio). Además avisa si es cliente nuevo en Finnegans (administración lo tiene que dar de alta), si
tiene saldo vencido y si es empresa grande para ARCA (va con Factura de Crédito Electrónica). La lista de empresas grandes
es la oficial de ARCA, sin captcha, y se baja una vez por día (`POST /hooks/arca/fce` la trae ya). En la ficha del negocio,
la tarjeta «Datos para facturar» muestra lo mismo.

## Fotos de los productos

Las miniaturas de las tarjetas de pedidos y las fotos de sus productos salen de la cotización del STP (la imagen que eligió
la vendedora), de la ficha del producto en Finnegans o, si no, de la foto del SKU en otras cotizaciones del STP. El registro
de cotizaciones se baja cada hora con el workflow «Totales de pedidos»; necesita el secreto `STPO_TOKEN` en GitHub (el mismo
que usa formas-tablero). Detalle en [docs/PEDIDOS.md](docs/PEDIDOS.md#fotos-del-registro-de-cotizaciones-del-stp).

## Monto de los negocios

Al cerrar un negocio el monto es un estimado; el número final es el del pedido. Cuando cambia el total de un pedido
asociado a un negocio (el total sin IVA de Finnegans, cada hora, o editado a mano), o se le asocia, se le quita o se anula
un pedido, el negocio pasa a tener la suma de sus pedidos (`src/worker/montos.ts`), y queda en el historial del monto.
Solo hacia adelante: no reescribe de golpe los montos de negocios viejos. Casos raros: varios pedidos suman; los anulados
no cuentan; si a un pedido todavía no le llegó el total, el negocio espera; los negocios perdidos o en otra moneda no se
tocan. Un pedido va en un solo negocio (un negocio sí puede tener varios pedidos): el CRM no deja sumarlo a un segundo. Para
controlar los pedidos que no están en ningún negocio, la lista de pedidos tiene el filtro «Sin negocio» (propiedad «Negocios
asociados» = 0). Quien cambia a mano el monto de un negocio con pedidos lo deja
«Monto a mano» (y los pedidos ya no lo cambian); al desmarcarlo vuelve al total de los pedidos.

## Fotos de los usuarios

Cada usuario se ve con la foto de su cuenta de Google (la misma de Gmail) en todo el CRM: el menú de abajo, las tarjetas del
tablero, la columna Propietario de las tablas, la ficha (propietario, actividad e historial), Tareas, Inicio, los desplegables
de usuario y Configuración → Usuarios. Si no tiene foto, sus iniciales. La trae la cuenta de servicio de Gmail
(`src/worker/fotos.ts`) con el permiso `https://www.googleapis.com/auth/userinfo.profile` (solo nombre y foto) en la
delegación de todo el dominio; si ese permiso no está, usa el de Drive de los bocetos. Llega sola al agregar un usuario y se
revisa una vez por semana; el botón «Traer fotos de Google» de Configuración → Usuarios las trae ya, y ahí mismo avisa si
falta el permiso.

## Bocetos de producción

En cada producto del pedido se suben sus bocetos (PDF o fotos de referencia): versiones, técnico o referencia, aprobado.
El CRM propone a qué producto va leyendo el PDF. Al aprobarlo, se adjunta solo en ClickUp a la subtarea de ese artículo,
donde trabaja producción. También se suben en el negocio, antes del pedido, y después se usan en el pedido de la misma
empresa. Se guardan en una unidad compartida de Drive (Configuración → Integraciones → Bocetos en Drive; la cuenta de
servicio necesita el permiso de Drive en la delegación). Detalle en [docs/PEDIDOS.md](docs/PEDIDOS.md#bocetos-de-producción).

## Preparar la reunión con Claude

En la ficha de una empresa, contacto o negocio, «Preparar reunión con Claude» abre claude.ai con el pedido escrito. Claude usa
la herramienta `preparar_reunion` del conector (compras y estado del cliente, saldo, contactos, negocios, pedidos, tareas y
actividad reciente) y arma el resumen, los riesgos, los próximos pasos y un borrador de mail. Necesita el conector Formas CRM
cargado en claude.ai.

## Gmail

El CRM lee los Gmail del equipo con una cuenta de servicio de Google Workspace con delegación de dominio (puede ser
la misma de `GOOGLE_SA_JSON` de formas-tablero: `google-sheets-pic@dashboard-formas.iam.gserviceaccount.com`, Client ID
111736235755246678228, que ya tiene la Gmail API y el permiso `https://www.googleapis.com/auth/gmail.readonly` en
Seguridad → Controles de API → Delegación de todo el dominio; probado el 2 de noviembre de 2026). El JSON de la cuenta se carga como secreto `GOOGLE_SA_JSON` del repo en GitHub (la próxima publicación se lo pasa al
CRM), y en Configuración → Integraciones → «Mails (Gmail)» se prende. Cada 10 minutos guarda los mails con contactos
(recibidos de contactos existentes; enviados, creando el contacto si no existe), deduplicados entre bandejas. Si
el contacto se creó con un mail enviado a una dirección sin nombre, toma el nombre del primer mail que llega con
nombre («Julia Malan <julia@…>»). Las casillas personales del equipo (por ejemplo un Gmail propio) van en
`ignore_addresses` para que no se creen como contactos.

Prueba con la casilla de Rodrigo, 2 de noviembre de 2026, últimos 2 días: 153 mails, 48 registrados (43 enviados y 5
respuestas), 38 contactos y 21 empresas creados. Lo que no se registró: 44 automáticos o de servicios ignorados, 29
internos y 31 de remitentes que no son contactos (proveedores, newsletters y avisos).

Cada corrida lee hasta unos 40 mails en total (el tope de consultas del plan gratuito de Cloudflare), empezando por la
bandeja que hace más que no se lee; lo que falta sigue en la próxima. Con token de administrador: `GET /hooks/gmail`
(estado), `PUT /hooks/gmail` (configuración, por ejemplo `{"enabled": true, "users": ["alguien@formas.ar"]}`) y
`POST /hooks/gmail/sync` (leer ahora).
